// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @title WinnerTakesAll
 * @notice Two players, one pot, no clock. `stake` puts native ETH in;
 * `declareWinner` moves the whole pot to one of the two players.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  READ THIS BEFORE DEPLOYING ANYWHERE THAT HOLDS REAL MONEY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `declareWinner` HAS NO CALLER RESTRICTION. That is deliberate and requested,
 * and it is the single most important property of this contract: any address in
 * the world may settle any full match at any moment. The contract does not know
 * who won and never asks.
 *
 * The blast radius is bounded, but only partly:
 *
 *   - The pot can only ever reach `a` or `b`. A stranger cannot pay themselves,
 *     because `winner` must be one of the two seated players. That is what "the
 *     person who won the match" means, so it is a requirement, not a guard rail
 *     added on top of one.
 *   - Within that bound there is no protection at all. Either player — or a
 *     friend of theirs, or a bot watching the mempool — can call this the
 *     instant the second stake lands and take the entire pot before a single
 *     move of the actual game has been played. Losing is not enforceable here.
 *
 * That is the honest description of a refereeless winner-takes-all pot. It is a
 * perfectly good shape for a testnet harness, a demo, or a game between people
 * who trust each other. It is not a shape that survives contact with strangers
 * and real money.
 *
 * To make it survive that, the fix is one line — a settler address chosen at
 * deployment and `require(msg.sender == settler)` at the top of
 * `declareWinner`. The rest of the contract is unchanged.
 *
 * ## No clock, anywhere
 *
 * There is no deadline, no timeout, no refund and no expiry, by request. A
 * settled match pays instantly whenever `declareWinner` is called, a year later
 * if that is when it is called. The corollary is the part to weigh: **a match
 * that is never settled is never recoverable.** Two players stake, nobody
 * calls, and that ETH stays in this contract permanently. There is no
 * withdrawal path, for them or for anyone else.
 *
 * ## Chain lock
 *
 * The constructor refuses any chain but Base Sepolia, matching `DuelEscrow.sol`
 * in this same directory. Given that `declareWinner` is open to the world, this
 * keeps an accidental mainnet deployment from becoming a real-money free-for-
 * all. Delete the `require` in the constructor if you decide otherwise — it is
 * the only line standing in the way.
 */
contract WinnerTakesAll {
    /** Base Sepolia. The only chain this contract will deploy to. */
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;

    /**
     * One match.
     *
     * `pool` is the SUM of both players' stakes rather than a pair of amounts,
     * because nothing here ever pays a stake back — the only exit is the whole
     * pot to one address, so who contributed what stops mattering the moment it
     * is contributed. Unequal stakes are therefore not a special case: they are
     * the normal case, and 0.001 against 5 ETH is a legal match.
     */
    struct Duel {
        /** First wallet to stake. Seat one. */
        address a;
        /** Second distinct wallet to stake. Seat two, and until it is non-zero
         *  the match cannot be settled. */
        address b;
        /** Everything staked, by both players, across every call. */
        uint256 pool;
        /** Set once, in `declareWinner`, and never cleared. */
        bool settled;
    }

    /** Every match this contract has ever seen, by id. */
    mapping(bytes32 => Duel) public duels;

    event Staked(bytes32 indexed matchId, address indexed player, uint256 amount, uint256 pool);

    /**
     * @dev `caller` is indexed and recorded on purpose. Since anyone may settle
     * a match, the identity of whoever actually did is the only forensic trail
     * there is, and a UI that shows a payout should be able to show that too.
     */
    event Settled(
        bytes32 indexed matchId,
        address indexed winner,
        address indexed caller,
        uint256 payout
    );

    constructor() {
        require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "Base Sepolia only");
    }

    /**
     * @notice Put ETH into a match. Anyone may call this, with any amount.
     * @param matchId Any 32 bytes your app picks to name this match. Two
     * players agreeing on the same value are in the same match; that is the
     * whole coordination mechanism.
     *
     * @dev Seats fill in arrival order and there are exactly two. A third
     * address is rejected. Either seated player may call again to add more —
     * "no specific amount" taken at face value, so a top-up is just another
     * stake and it lands in the same pot.
     */
    function stake(bytes32 matchId) external payable {
        require(matchId != bytes32(0), "matchId=0");
        require(msg.value > 0, "stake something");

        Duel storage d = duels[matchId];
        require(!d.settled, "match already settled");

        if (d.a == address(0)) {
            d.a = msg.sender;
        } else if (msg.sender != d.a && d.b == address(0)) {
            d.b = msg.sender;
        } else {
            // Both seats are spoken for. Only their holders may add to the pot.
            require(msg.sender == d.a || msg.sender == d.b, "match is full");
        }

        d.pool += msg.value;
        emit Staked(matchId, msg.sender, msg.value, d.pool);
    }

    /**
     * @notice Send the entire pot to one of the two players. **Anyone may call
     * this.** There is no deadline.
     * @param matchId The match to settle.
     * @param winner Must be seat `a` or seat `b`.
     *
     * @dev State is finalised before the transfer — `settled` is set and `pool`
     * zeroed first — so a winner that is a contract cannot re-enter and be paid
     * twice; the second entry meets `match already settled`.
     *
     * `.call` rather than `.transfer` so the payout is not capped at 2300 gas
     * and a smart-contract wallet can receive it. A winner whose receive hook
     * reverts makes the whole settlement revert, which leaves the match open to
     * be settled again — the pot is never destroyed by a failed payout.
     */
    function declareWinner(bytes32 matchId, address winner) external {
        Duel storage d = duels[matchId];
        require(d.b != address(0), "match not full");
        require(!d.settled, "match already settled");
        require(winner == d.a || winner == d.b, "winner is not a player");

        d.settled = true;
        uint256 payout = d.pool;
        d.pool = 0;

        emit Settled(matchId, winner, msg.sender, payout);

        (bool ok, ) = payable(winner).call{value: payout}("");
        require(ok, "payout failed");
    }

    /** ETH sent with no match named would be unrecoverable. Refuse it. */
    receive() external payable {
        revert("use stake");
    }

    fallback() external payable {
        revert("unknown function");
    }
}
