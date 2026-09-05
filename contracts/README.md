# DuelEscrow — Base Sepolia only

`DuelEscrow.sol` is a native-test-ETH, two-player, winner-takes-all escrow. It
has no token address, treasury, rake, owner, upgrade hook, or mainnet mode.

## Rules

- Network: Base Sepolia only (`chainId = 84532`). The constructor reverts on
  every other chain.
- Minimum: `0.001 ETH` (`1_000_000_000_000_000` wei) per player.
- `stake(duelId)`: anyone may open an unused duel or fill its second seat. The
  second player must send exactly the first player's amount.
- `winStake(duelId, winner, deadline, sig)`: anyone may relay a valid verdict
  signed by the immutable attestor. The named player receives the complete
  two-stake pool; the loser receives zero.
- `loseStake(duelId)`: a seated player may voluntarily forfeit. The opponent
  receives the complete pool and the caller receives zero.
- `cancel(duelId)`: the opener can recover an unmatched stake.
- `refund(duelId)`: if no result arrives within six hours after both seats are
  full, each player can recover their own stake. This safety path is unavailable
  after settlement and does not refund a losing player.

The attestor signature is essential: making the relay permissionless does not
make the outcome caller-controlled.

## Build and deploy

```bash
bun contracts/build.ts
bun contracts/deploy.ts
bun contracts/deploy.ts --broadcast
```

Deployment requires `ESCROW_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, and
`ATTESTOR_ADDRESS`. The deploy script refuses any RPC whose chain id is not
84532 and defaults to preflight mode, so no transaction is broadcast unless
`--broadcast` is explicit.

After deployment, set `THETADUEL_ESCROW` to the new address. Do not reuse an
address from an older USDC escrow: the constructor and ABI are different.

The committed artifact is `contracts/out/DuelEscrow.json` and must match a
fresh compile before deployment.
