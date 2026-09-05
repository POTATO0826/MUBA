# Deploy DuelEscrow with Remix on Base Sepolia

This is testnet-only. Base Sepolia uses chain ID `84532`, and all stakes use
native test ETH. No USDC address or treasury is required.

1. Connect Remix to an injected wallet on **Base Sepolia**.
2. Fund the deployer with Base Sepolia test ETH.
3. Compile `DuelEscrow.sol` with Solidity `0.8.26`, optimizer enabled, 200 runs,
   EVM version `cancun`.
4. Deploy with one constructor argument: the non-zero attestor address.
5. Read `BASE_SEPOLIA_CHAIN_ID()` and confirm `84532`.
6. Read `MIN_STAKE()` and confirm `1000000000000000` wei (`0.001 ETH`).
7. Set `THETADUEL_ESCROW` to this new deployment address.

The constructor itself refuses deployment on any other chain. An address from
the previous USDC version is incompatible with this ABI and must not be reused.

## Smoke test

1. Player A calls `stake(duelId)` with at least `0.001 ETH` in the transaction
   value.
2. Player B calls the same function with the same `duelId` and exact value.
3. Confirm `pool(duelId)` equals both stakes combined.
4. Obtain the attestor's signed verdict and call `winStake` from either account
   or a third-party relayer.
5. Confirm the winner receives the complete pool and the loser receives zero.

To test a voluntary loss instead, create another full duel and call `loseStake`
from either seated wallet. The other wallet must receive the complete pool.

Use only test ETH. Do not send real funds.
