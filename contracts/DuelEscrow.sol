// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title DuelEscrow
 * @notice Two-player, winner-takes-all duels using native Base Sepolia ETH.
 *
 * Anyone may call `stake`. The first caller opens a duel and chooses the stake;
 * the second caller matches it exactly. A signed verdict from the immutable
 * attestor names the winner, and anyone may relay that verdict with `winStake`.
 * The winner receives the entire two-player pool. The loser receives nothing.
 *
 * This contract is intentionally testnet-only. Its constructor refuses to
 * deploy on any chain other than Base Sepolia (chain id 84532).
 */
contract DuelEscrow {
    enum Status {
        NONE,
        OPEN,
        FULL,
        SETTLED,
        REFUNDED
    }

    struct Duel {
        address a;
        address b;
        // Retained in the public tuple for compatibility with the referee's
        // seat reader. Open staking always leaves it as address(0).
        address invited;
        uint128 stake;
        uint64 fullAt;
        Status status;
        bool aWithdrawn;
        bool bWithdrawn;
    }

    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    // 0.001 native test ETH, written as an integer so build-time checks can
    // verify the exact wei value without relying on unit-expression parsing.
    uint128 public constant MIN_STAKE = 1_000_000_000_000_000;
    uint64 public constant TIMEOUT = 6 hours;

    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 duelId,address winner,uint64 deadline)");

    uint256 private constant _HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    address public immutable attestor;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(bytes32 => Duel) public duels;

    uint256 private _unlocked = 1;

    event Staked(bytes32 indexed duelId, address indexed player, uint256 amount, uint8 seat);
    event DuelSettled(bytes32 indexed duelId, address indexed winner, uint256 payout);
    event DuelForfeited(
        bytes32 indexed duelId,
        address indexed loser,
        address indexed winner,
        uint256 payout
    );
    event DuelRefunded(bytes32 indexed duelId, address indexed player, uint256 amount);
    event DuelCancelled(bytes32 indexed duelId, address indexed player, uint256 amount);

    modifier nonReentrant() {
        require(_unlocked == 1, "reentrant call");
        _unlocked = 2;
        _;
        _unlocked = 1;
    }

    constructor(address attestor_) {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "Base Sepolia only");
        require(attestor_ != address(0), "attestor=0");
        attestor = attestor_;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("THETADUEL"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /**
     * @notice Open a duel or match its existing stake.
     * @dev The first stake must be at least 0.001 ETH. The second must match it
     * exactly. Everyone is eligible, but an opener cannot take both seats and a
     * full or completed duel accepts no additional stake.
     */
    function stake(bytes32 duelId) external payable {
        require(duelId != bytes32(0), "duelId=0");
        require(msg.value >= MIN_STAKE, "stake too small");
        require(msg.value <= type(uint128).max, "stake too large");

        Duel storage d = duels[duelId];
        if (d.status == Status.NONE) {
            d.a = msg.sender;
            d.stake = uint128(msg.value);
            d.status = Status.OPEN;
            emit Staked(duelId, msg.sender, msg.value, 1);
            return;
        }

        require(d.status == Status.OPEN, "duel not open");
        require(msg.sender != d.a, "cannot join own duel");
        require(msg.value == d.stake, "stake must match");

        d.b = msg.sender;
        d.fullAt = uint64(block.timestamp);
        d.status = Status.FULL;
        emit Staked(duelId, msg.sender, msg.value, 2);
    }

    /**
     * @notice Pay the complete duel pool to the signed winner.
     * @dev The caller is only a relay. Authority comes from the attestor's
     * EIP-712 signature, bound to this chain, contract, duel, winner and
     * deadline. State is finalized before ETH is sent.
     */
    function winStake(
        bytes32 duelId,
        address payable winner,
        uint64 deadline,
        bytes calldata sig
    ) external nonReentrant {
        Duel storage d = duels[duelId];
        require(d.status == Status.FULL, "duel not full");
        require(block.timestamp <= deadline, "verdict expired");
        require(winner == d.a || winner == d.b, "winner not a player");

        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                DOMAIN_SEPARATOR,
                keccak256(abi.encode(VERDICT_TYPEHASH, duelId, winner, deadline))
            )
        );
        require(_recover(digest, sig) == attestor, "bad attestor signature");

        d.status = Status.SETTLED;
        uint256 payout = uint256(d.stake) * 2;
        emit DuelSettled(duelId, winner, payout);
        _send(winner, payout);
    }

    /**
     * @notice Voluntarily lose the stake and award the complete pool to the
     * opponent. Only a seated player can forfeit; a third party cannot choose
     * a loser or redirect the payout.
     */
    function loseStake(bytes32 duelId) external nonReentrant {
        Duel storage d = duels[duelId];
        require(d.status == Status.FULL, "duel not full");

        address payable winner;
        if (msg.sender == d.a) {
            winner = payable(d.b);
        } else if (msg.sender == d.b) {
            winner = payable(d.a);
        } else {
            revert("not a player");
        }

        d.status = Status.SETTLED;
        uint256 payout = uint256(d.stake) * 2;
        emit DuelForfeited(duelId, msg.sender, winner, payout);
        _send(winner, payout);
    }

    /**
     * @notice Cancel an unmatched duel and recover its single stake.
     */
    function cancel(bytes32 duelId) external nonReentrant {
        Duel storage d = duels[duelId];
        require(d.status == Status.OPEN, "duel not open");
        require(msg.sender == d.a, "not opener");

        d.status = Status.REFUNDED;
        d.aWithdrawn = true;
        d.bWithdrawn = true;
        uint256 amount = d.stake;
        emit DuelCancelled(duelId, msg.sender, amount);
        _send(payable(msg.sender), amount);
    }

    /**
     * @notice Recover a stake if no signed result arrives within six hours.
     * @dev This is an availability escape hatch, not a losing-player refund.
     * Once `winStake` settles a duel, the loser has no claim.
     */
    function refund(bytes32 duelId) external nonReentrant {
        Duel storage d = duels[duelId];
        Status status = d.status;
        require(status == Status.FULL || status == Status.REFUNDED, "not refundable");
        require(d.fullAt != 0, "never filled");
        require(block.timestamp > uint256(d.fullAt) + TIMEOUT, "not expired");

        if (msg.sender == d.a) {
            require(!d.aWithdrawn, "already refunded");
            d.aWithdrawn = true;
        } else if (msg.sender == d.b) {
            require(!d.bWithdrawn, "already refunded");
            d.bWithdrawn = true;
        } else {
            revert("not a player");
        }

        if (status == Status.FULL) d.status = Status.REFUNDED;
        uint256 amount = d.stake;
        emit DuelRefunded(duelId, msg.sender, amount);
        _send(payable(msg.sender), amount);
    }

    function pool(bytes32 duelId) external view returns (uint256) {
        Duel storage d = duels[duelId];
        if (d.status == Status.OPEN) return d.stake;
        if (d.status == Status.FULL) return uint256(d.stake) * 2;
        if (d.status == Status.REFUNDED) {
            uint256 remaining;
            if (!d.aWithdrawn) remaining += d.stake;
            if (!d.bWithdrawn) remaining += d.stake;
            return remaining;
        }
        return 0;
    }

    receive() external payable {
        revert("use stake");
    }

    fallback() external payable {
        revert("unknown function");
    }

    function _send(address payable to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "ETH transfer failed");
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(s) > _HALF_CURVE_ORDER) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
