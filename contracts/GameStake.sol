// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title GameStake
 * @notice Two players stake any amount into a match. The winner takes the
 * whole pool. No time limit, ever.
 *
 * Two functions:
 *   stake(matchId)                  — put ETH in. Anyone, any amount.
 *   winnerTakesAll(matchId, winner) — pay the whole pool out. Anyone, anytime.
 *
 * `winnerTakesAll` has no caller restriction, by request. The contract does not
 * know who won, so it cannot check. The only thing it enforces is that the pool
 * goes to one of the two players who actually staked — a stranger can pick the
 * winner, but cannot pay themselves.
 */
contract GameStake {
    struct Match {
        address player1;
        address player2;
        uint256 pool;
        bool paid;
    }

    /// Every match, by whatever id your app chooses.
    mapping(bytes32 => Match) public matches;

    event Staked(bytes32 indexed matchId, address indexed player, uint256 amount, uint256 pool);
    event WinnerPaid(bytes32 indexed matchId, address indexed winner, uint256 amount);

    /**
     * @notice Stake into a match. Any amount, no minimum.
     * @param matchId Any 32 bytes naming this match. Both players use the same
     * value to end up in the same match.
     *
     * The first two distinct wallets take the seats. Either may call again to
     * add more; a third wallet is rejected.
     */
    function stake(bytes32 matchId) external payable {
        require(msg.value > 0, "no stake");

        Match storage m = matches[matchId];
        require(!m.paid, "match finished");

        if (m.player1 == address(0)) {
            m.player1 = msg.sender;
        } else if (m.player2 == address(0) && msg.sender != m.player1) {
            m.player2 = msg.sender;
        } else {
            require(msg.sender == m.player1 || msg.sender == m.player2, "match full");
        }

        m.pool += msg.value;
        emit Staked(matchId, msg.sender, msg.value, m.pool);
    }

    /**
     * @notice Send the entire pool to the winner. No deadline.
     * @param winner Must be one of the two players in this match.
     *
     * `paid` is set and `pool` zeroed before the transfer, so a winner that is
     * a contract cannot re-enter and be paid twice.
     */
    function winnerTakesAll(bytes32 matchId, address winner) external {
        Match storage m = matches[matchId];
        require(m.player2 != address(0), "need 2 players");
        require(!m.paid, "already paid");
        require(winner == m.player1 || winner == m.player2, "not a player");

        m.paid = true;
        uint256 amount = m.pool;
        m.pool = 0;

        emit WinnerPaid(matchId, winner, amount);

        (bool sent, ) = payable(winner).call{value: amount}("");
        require(sent, "transfer failed");
    }
}
