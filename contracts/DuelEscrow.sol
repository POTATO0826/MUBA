// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @notice The minimal ERC-20 subset this escrow uses.
 * @dev    Native USDC on Base (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) is a
 *         well-behaved ERC-20: both calls return a `bool`. Every call site here
 *         `require`s that bool, so a token that returned nothing would make this
 *         contract unusable rather than silently lose funds. That is the
 *         intended trade: this escrow is for USDC and nothing else.
 */
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title  DuelEscrow - two-player USDC side bets for THETADUEL
 * @author THETADUEL
 * @notice Two players lock an equal USDC stake against a duel id. The game
 *         server's referee key (the "attestor") signs an EIP-712 verdict naming
 *         the winner; anyone may relay that signature on-chain and the winner is
 *         paid the pot minus a fixed 4% rake. If no verdict arrives within six
 *         hours of the duel filling, each player pulls their own stake back,
 *         unilaterally and without a rake.
 *
 * @dev    TRUST MODEL - read this before sending money.
 *
 *         1. `attestor` is the game server's referee key. It is the ONLY party
 *            that can decide who won. It is an immutable constructor argument:
 *            there is no owner, no admin, no pause, no upgrade path and no
 *            rotation. A compromised attestor key can direct the payout of any
 *            duel that is currently FULL (it cannot mint, cannot touch a duel
 *            that is OPEN, SETTLED or REFUNDED, and cannot take more than the
 *            one pot). The mitigation is operational: the attestor is a fresh,
 *            unfunded EOA that only ever signs typed data, held server-side, and
 *            the server re-derives the verdict from committed picks rather than
 *            trusting a client-supplied winner. Players who do not trust the
 *            referee should not stake; the six-hour timeout is the escape hatch,
 *            and it works even if the server disappears entirely.
 *
 *         2. `settle` is a PERMISSIONLESS RELAY. The signature - not the caller
 *            - is the authority. Anybody may broadcast a valid verdict, so the
 *            winner is never dependent on the server also being able to pay gas.
 *            A verdict is bound to (this chain id, this contract, this duel id,
 *            this winner, this deadline) by the EIP-712 domain and struct hash,
 *            and a duel leaves FULL exactly once, so a verdict cannot be
 *            replayed onto another duel, another chain, another deployment, or
 *            the same duel twice.
 *
 *         3. `treasury` is the only address that can ever receive rake, and
 *            `claimRake` is the only function that pays it. `claimRake` reads
 *            and zeroes `rakeAccrued` and sends exactly that; it takes no
 *            argument and has no path to a duel's stake. It is callable by
 *            anyone precisely because it can only ever move money to one
 *            hard-wired destination.
 *
 * @dev    UNCAPPED STAKE - THE OWNER'S EXPLICIT DECISION, AND ITS RISK.
 *         There is a MINIMUM stake ($0.10, anti-grief) and deliberately NO
 *         MAXIMUM. This contract is unaudited. Uncapped plus unaudited means a
 *         bug here risks the entire amount players choose to stake, and there is
 *         no admin able to rescue anything if one is found. The compensating
 *         controls are: minimality (no imports, no libraries, no proxies, no
 *         owner, one storage struct); a dedicated adversarial review pass before
 *         deployment; the accounting separation in note 3 above; and the
 *         unconditional six-hour refund, which is reachable by each player
 *         independently and requires no cooperation from the server, the other
 *         player, or anyone else. Stake accordingly.
 *
 * @dev    BALANCE INVARIANT. At the end of every transaction:
 *
 *             usdc.balanceOf(address(this))
 *                 >= rakeAccrued
 *                  + sum of stake      over duels with status OPEN
 *                  + sum of 2 * stake  over duels with status FULL
 *                  + sum of stake      over each not-yet-withdrawn player of a
 *                                      REFUNDED duel
 *
 *         Every function preserves it: `open` and `join` add exactly the stake
 *         they book; `settle` pays `pot - rake` and moves `rake` into
 *         `rakeAccrued`, and `(pot - rake) + rake == pot` exactly, so no dust is
 *         created or lost; `cancel` and `refund` each pay out exactly one stake
 *         and retire the claim that authorised it; `claimRake` pays only
 *         `rakeAccrued`. The relation is `>=` rather than `==` because anyone
 *         may donate USDC to this address. Donated tokens are unrecoverable by
 *         design - there is no sweep, because a sweep is exactly the function
 *         that could drain stakes.
 *
 * @dev    DUEL IDS. The client derives `duelId` as
 *         `keccak256(utf8Bytes(matchKey))` - the same rule ethers.js exposes as
 *         `ethers.id(matchKey)`. The contract treats the id as an opaque key and
 *         never interprets it; it only enforces that a given id is used once.
 */
contract DuelEscrow {
    // ---------------------------------------------------------------- types --

    /**
     * @notice Lifecycle of one duel.
     * @dev NONE     - the id has never been used (the zero value).
     *      OPEN     - `a` has staked and is waiting for an opponent.
     *      FULL     - both stakes are held; settleable until the timeout.
     *      SETTLED  - a verdict was relayed and the winner has been paid.
     *      REFUNDED - terminal, no verdict will ever be accepted. Reached by
     *                 `cancel` (opener exits an unjoined duel) or by the FIRST
     *                 `refund` pull after the timeout. In the refund case one
     *                 side's stake may still be sitting here waiting to be
     *                 pulled; `aWithdrawn` / `bWithdrawn` say who has taken
     *                 theirs.
     */
    enum Status {
        NONE,
        OPEN,
        FULL,
        SETTLED,
        REFUNDED
    }

    /**
     * @notice One duel's full state. Packs into four storage slots.
     * @param a           Opener. Always set once the duel leaves NONE.
     * @param b           Joiner. Zero until the duel is FULL.
     * @param invited     If non-zero, only this address may `join`. Zero means
     *                    the duel is open to the first comer.
     * @param stake       Per-player stake in USDC base units (6 decimals). The
     *                    pot is exactly `2 * stake`.
     * @param fullAt      Block timestamp at which the duel became FULL. Zero
     *                    while OPEN, and the base for the refund timeout.
     * @param status      See {Status}.
     * @param aWithdrawn  `a` has taken their stake back (`cancel` or `refund`).
     * @param bWithdrawn  `b` has taken their stake back (`refund`).
     */
    struct Duel {
        address a;
        address b;
        address invited;
        uint128 stake;
        uint64 fullAt;
        Status status;
        bool aWithdrawn;
        bool bWithdrawn;
    }

    // ------------------------------------------------------------ constants --

    /// @notice House rake on a settled pot, in basis points. Fixed at 4%.
    uint16 public constant RAKE_BPS = 400;

    /// @notice Basis-point denominator.
    uint16 public constant BPS = 10_000;

    /// @notice Minimum per-player stake: 100000 base units = $0.10 of USDC.
    /// @dev Anti-grief only. There is deliberately NO maximum - see the risk
    ///      note in the contract-level documentation.
    uint128 public constant MIN_STAKE = 100_000;

    /// @notice How long after a duel fills before either player may
    ///         unilaterally refund. Six hours.
    uint64 public constant TIMEOUT = 6 hours;

    /// @notice EIP-712 struct hash of the verdict the attestor signs.
    bytes32 public constant VERDICT_TYPEHASH =
        keccak256("Verdict(bytes32 duelId,address winner,uint64 deadline)");

    /// @dev Upper half of the secp256k1 curve order. A signature whose `s` is
    ///      above this is the malleable twin of a valid one and is rejected.
    uint256 private constant _HALF_CURVE_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    // ----------------------------------------------------------- immutables --

    /// @notice The stake token. USDC on Base, 6 decimals.
    IERC20 public immutable usdc;

    /// @notice The game server's referee key; the sole signer of verdicts.
    address public immutable attestor;

    /// @notice The only address `claimRake` can ever pay.
    address public immutable treasury;

    /// @notice EIP-712 domain separator, bound to this chain and this address.
    /// @dev Computed once at construction. A post-deployment chain split would
    ///      leave this pinned to the original chain id; that is accepted here
    ///      because the alternative (recomputing on every call) costs gas on
    ///      every settlement and Base is not expected to fork.
    bytes32 public immutable DOMAIN_SEPARATOR;

    // -------------------------------------------------------------- storage --

    /// @notice duelId => duel state. A `NONE` status means the id is unused.
    mapping(bytes32 => Duel) public duels;

    /// @notice Rake collected from settled duels and not yet swept to treasury.
    /// @dev The only pool of money in this contract that is not a player stake.
    uint256 public rakeAccrued;

    // --------------------------------------------------------------- events --

    /// @notice A duel was opened and `a`'s stake is held.
    event DuelOpened(bytes32 indexed duelId, address indexed a, address indexed invited, uint128 stake);

    /// @notice `b` matched the stake; the duel is settleable until `fullAt + TIMEOUT`.
    event DuelJoined(bytes32 indexed duelId, address indexed b, uint64 fullAt);

    /// @notice A verdict was relayed: `payout` went to `winner`, `rake` accrued.
    event DuelSettled(bytes32 indexed duelId, address indexed winner, uint256 payout, uint256 rake);

    /// @notice One player pulled their own stake back after the timeout.
    event DuelRefunded(bytes32 indexed duelId, address indexed player, uint128 stake);

    /// @notice The opener withdrew from a duel nobody had joined.
    event DuelCancelled(bytes32 indexed duelId, address indexed a, uint128 stake);

    /// @notice Accrued rake was swept to the treasury.
    event RakeClaimed(address indexed treasury, uint256 amount);

    // ---------------------------------------------------------- constructor --

    /**
     * @notice Deploys the escrow. Every parameter is immutable afterwards.
     * @param usdc_     The stake token (USDC on Base).
     * @param attestor_ The referee key that signs verdicts. See the trust model.
     * @param treasury_ The sole recipient of rake.
     */
    constructor(IERC20 usdc_, address attestor_, address treasury_) {
        require(address(usdc_) != address(0), "usdc=0");
        require(attestor_ != address(0), "attestor=0");
        require(treasury_ != address(0), "treasury=0");
        usdc = usdc_;
        attestor = attestor_;
        treasury = treasury_;
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

    // ------------------------------------------------------------- external --

    /**
     * @notice Open a duel and lock your stake.
     * @dev Caller must have approved at least `stake` to this contract. The duel
     *      id must be unused: ids are never recycled, not even after `cancel`,
     *      so a verdict signed for an id can never apply to a different duel.
     *
     *      Known, accepted griefing vector: because ids are first-come and never
     *      recycled, anyone who can PREDICT a duel id can squat it by opening it
     *      first at the minimum stake, permanently denying that id to the real
     *      room. The cost to the griefer is gas plus a locked $0.10 (recoverable
     *      via `cancel`), and the defence is off-chain: derive `matchKey` from
     *      something an outsider cannot guess ahead of the players. A squatted
     *      id is a denial of service on one room, never a path to anyone's money.
     * @param duelId  Opaque id, `keccak256(utf8Bytes(matchKey))` by convention.
     * @param stake   Per-player stake in USDC base units; must be >= MIN_STAKE.
     *                There is no maximum - see the contract-level risk note.
     * @param invited If non-zero, only this address may join. Zero = open to all.
     */
    function open(bytes32 duelId, uint128 stake, address invited) external {
        Duel storage d = duels[duelId];
        require(d.status == Status.NONE, "duel exists");
        require(stake >= MIN_STAKE, "stake too small");
        require(invited != msg.sender, "invited self");

        d.a = msg.sender;
        d.invited = invited;
        d.stake = stake;
        d.status = Status.OPEN;

        emit DuelOpened(duelId, msg.sender, invited, stake);

        require(usdc.transferFrom(msg.sender, address(this), stake), "transferFrom failed");
    }

    /**
     * @notice Match an open duel's stake and start the settlement window.
     * @dev Caller must have approved at least the duel's `stake`. The opener may
     *      not join their own duel. If the duel named an invitee, only that
     *      address may join.
     * @param duelId The duel to join.
     */
    function join(bytes32 duelId) external {
        Duel storage d = duels[duelId];
        require(d.status == Status.OPEN, "not open");
        require(msg.sender != d.a, "cannot join own duel");
        address invited = d.invited;
        require(invited == address(0) || invited == msg.sender, "not invited");

        uint128 stake = d.stake;
        uint64 fullAt = uint64(block.timestamp);
        d.b = msg.sender;
        d.fullAt = fullAt;
        d.status = Status.FULL;

        emit DuelJoined(duelId, msg.sender, fullAt);

        require(usdc.transferFrom(msg.sender, address(this), stake), "transferFrom failed");
    }

    /**
     * @notice Relay the attestor's verdict and pay the winner.
     * @dev Permissionless: anyone may call this with a valid signature, so the
     *      winner never depends on the server being able to pay gas. The duel
     *      moves out of FULL before the transfer (checks-effects-interactions),
     *      which is also what makes a signature single-use.
     *
     *      The signed digest is
     *      `keccak256(0x1901 || DOMAIN_SEPARATOR || keccak256(abi.encode(
     *      VERDICT_TYPEHASH, duelId, winner, deadline)))`, so a verdict is
     *      inseparable from this chain, this deployment, this duel, this winner
     *      and this expiry.
     * @param duelId   The duel being settled; must be FULL.
     * @param winner   Must be one of the two players.
     * @param deadline Unix seconds after which the signature is worthless.
     * @param sig      65-byte `r || s || v` signature from `attestor`.
     */
    function settle(bytes32 duelId, address winner, uint64 deadline, bytes calldata sig) external {
        Duel storage d = duels[duelId];
        require(d.status == Status.FULL, "not full");
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

        uint256 pot = uint256(d.stake) * 2;
        uint256 rake = (pot * RAKE_BPS) / BPS;
        uint256 payout = pot - rake;
        rakeAccrued += rake;

        emit DuelSettled(duelId, winner, payout, rake);

        require(usdc.transfer(winner, payout), "transfer failed");
    }

    /**
     * @notice Sweep accrued rake to the treasury.
     * @dev Callable by anyone, because it can only ever move money to the one
     *      immutable `treasury` address and only ever the `rakeAccrued` amount.
     *      It reads and zeroes the counter before transferring, so it is
     *      re-entrancy-inert and can never reach a player's stake. A call with
     *      nothing accrued is a no-op transfer of zero.
     */
    function claimRake() external {
        uint256 r = rakeAccrued;
        rakeAccrued = 0;

        emit RakeClaimed(treasury, r);

        require(usdc.transfer(treasury, r), "transfer failed");
    }

    /**
     * @notice After the timeout, pull your own stake out of an unsettled duel.
     * @dev The escape hatch that makes the trust model survivable: it needs no
     *      signature, no server, and no cooperation from the other player. Each
     *      player withdraws their own stake exactly once and no rake is taken.
     *
     *      The FIRST pull moves the duel to REFUNDED, which permanently closes
     *      the settlement path (`settle` requires FULL) - a duel can never be
     *      both partly refunded and settled. The second player's claim survives
     *      that transition via `aWithdrawn` / `bWithdrawn`, so one player
     *      refusing to claim can never strand the other.
     * @param duelId The duel to refund; must be FULL or already partly refunded,
     *               and past `fullAt + TIMEOUT`.
     */
    function refund(bytes32 duelId) external {
        Duel storage d = duels[duelId];
        Status status = d.status;
        require(status == Status.FULL || status == Status.REFUNDED, "not refundable");
        uint64 fullAt = d.fullAt;
        // A zero `fullAt` means the duel was cancelled, never joined: it has no
        // timeout and no second stake to release.
        require(fullAt != 0, "never filled");
        require(block.timestamp > uint256(fullAt) + TIMEOUT, "not expired");

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

        uint128 stake = d.stake;

        emit DuelRefunded(duelId, msg.sender, stake);

        require(usdc.transfer(msg.sender, stake), "transfer failed");
    }

    /**
     * @notice Withdraw from a duel nobody joined.
     * @dev Only the opener, only while OPEN. The duel goes to REFUNDED rather
     *      than back to NONE so the id is retired forever: recycling an id would
     *      let a stale verdict signed for the old duel apply to a new one.
     * @param duelId The duel to cancel.
     */
    function cancel(bytes32 duelId) external {
        Duel storage d = duels[duelId];
        require(d.status == Status.OPEN, "not open");
        require(msg.sender == d.a, "not opener");

        d.status = Status.REFUNDED;
        d.aWithdrawn = true;

        uint128 stake = d.stake;

        emit DuelCancelled(duelId, msg.sender, stake);

        require(usdc.transfer(msg.sender, stake), "transfer failed");
    }

    // -------------------------------------------------------------- private --

    /**
     * @notice Recover the signer of `digest` from a 65-byte signature.
     * @dev Vendored rather than imported so this file has zero dependencies.
     *      Rejects: any length but 65; an `s` in the upper half of the curve
     *      order (which would let a third party mint a second, different-looking
     *      signature for the same verdict); a `v` outside {27, 28}; and the zero
     *      address, which is what `ecrecover` returns on failure and which must
     *      never be allowed to compare equal to a zeroed `attestor` - the
     *      constructor also forbids that address outright.
     * @param digest The EIP-712 digest that was signed.
     * @param sig    `r || s || v`, 65 bytes.
     * @return signer The recovered address.
     */
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        require(sig.length == 65, "bad signature length");

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }

        require(uint256(s) <= _HALF_CURVE_ORDER, "malleable signature");
        require(v == 27 || v == 28, "bad signature v");

        signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "invalid signature");
    }
}
