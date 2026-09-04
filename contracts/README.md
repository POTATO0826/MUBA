# `contracts/` — DuelEscrow

The on-chain half of THETADUEL's optional USDC side bet. One Solidity file, no
imports, no libraries, no framework. `solc` is the only build dependency; there
is no foundry and no hardhat.

| File | What it is |
|---|---|
| `DuelEscrow.sol` | The contract. ~400 lines, most of it natspec. Read it in full — it is written to be read in full. |
| `build.ts` | `bun contracts/build.ts` — compiles with the pinned solc and writes `out/DuelEscrow.json`. |
| `deploy.ts` | `bun contracts/deploy.ts` — preflight by default; `--broadcast` deploys. Prints the BaseScan verification inputs. |
| `out/DuelEscrow.json` | **Committed** artifact: `{abi, bytecode, deployedBytecode, metadata, solcVersion}`. This is the reviewed bytecode. |
| `solc.d.ts` | Ambient types for solc-js, which ships none. |

`test/escrow.test.ts` compiles the contract in-process and asserts on what came
out: the ABI surface, the money constants, the EIP-712 typehashes, and that the
committed artifact still matches the source.

## What it does

Two players lock an equal USDC stake against a duel id.

```
open(duelId, stake, invited)     A stakes. Status OPEN.
join(duelId)                     B matches the stake. Status FULL, clock starts.
settle(duelId, winner, deadline, sig)
                                 Anyone relays the attestor's EIP-712 verdict.
                                 Winner gets 96% of the pot; 4% accrues as rake.
                                 Status SETTLED.
refund(duelId)                   6h after FULL with no verdict: each player
                                 pulls their OWN stake, no rake. Status REFUNDED.
cancel(duelId)                   A withdraws from a duel nobody joined.
claimRake()                      Sweeps accrued rake to the treasury. Anyone may
                                 call it; it can only ever pay the treasury.
```

Fixed at compile time and immutable after deployment:

| | |
|---|---|
| Rake | `RAKE_BPS = 400` — 4% of the pot, on settlement only. Never on a refund or a cancel. |
| Minimum stake | `MIN_STAKE = 100_000` — $0.10 of 6-decimal USDC. Anti-grief. |
| **Maximum stake** | **None.** See the risk statement below. |
| Timeout | `TIMEOUT = 6 hours` from the moment a duel fills. |
| `usdc`, `attestor`, `treasury` | Constructor arguments, immutable. No setter exists for any of them. |

`duelId` is derived client-side as `keccak256(utf8Bytes(matchKey))` — i.e.
`ethers.id(matchKey)`. The contract never interprets it; it only enforces that
an id is used once and never recycled, so a stale verdict can never land on a
different duel.

## Trust model

**The attestor is the game server's referee key, and it decides who won.** That
is the residual trust in this design and it is not hidden anywhere:

- The attestor is the only signer whose verdict `settle` accepts. It is an
  immutable constructor argument — there is no owner, no admin, no pause, no
  upgrade path, no rotation.
- A compromised attestor key can direct the payout of any duel that is currently
  `FULL`. It cannot mint, cannot touch a duel that is `OPEN`, `SETTLED` or
  `REFUNDED`, cannot exceed one pot per duel, and cannot reach the rake.
  Operationally the attestor is a fresh unfunded EOA that signs typed data and
  never transacts, held server-side only (`ATTESTOR_PRIVATE_KEY`, read by
  `src/server/attest.ts` and nothing else), and the server re-derives the verdict
  from committed picks rather than trusting a client-supplied winner.
- **`settle` is a permissionless relay.** The signature is the authority, not the
  caller. Anyone can broadcast a valid verdict, so a winner is never blocked by
  the server being unable to pay gas.
- **The six-hour refund needs nobody.** No signature, no server, no cooperation
  from the other player. It is the reason a player who stops trusting the referee
  still gets their money back. If the server disappears mid-duel, both stakes
  come home six hours later.
- **`claimRake` can only pay the treasury**, only `rakeAccrued`, and has no
  argument. It is structurally incapable of touching a stake. That separation is
  the reason it is safe for it to be callable by anyone.

Commit–reveal (so the server cannot know a verdict before it is forced to sign
one) is named as v2 in the plan and is not implemented here.

### Balance invariant

At the end of every transaction:

```
usdc.balanceOf(escrow) >= rakeAccrued
                        + Σ stake      over OPEN duels
                        + Σ 2 × stake  over FULL duels
                        + Σ stake      over each not-yet-withdrawn player of a
                                       REFUNDED duel
```

`settle` pays `pot - rake` and accrues `rake`, and `(pot - rake) + rake == pot`
exactly, so settlement creates and loses no dust. The relation is `>=` and not
`==` because anyone may donate USDC to the address. **Donated tokens are
unrecoverable by design** — there is no sweep function, because a sweep is
precisely the function that could drain stakes.

### ⚠ Uncapped stake — the risk statement

There is a minimum stake and **deliberately no maximum**. This is the owner's
explicit decision, recorded in the plan.

**This contract is unaudited.** Uncapped plus unaudited means a bug here risks
the entire amount players choose to stake, and there is no admin able to rescue
anything if one is found. Nobody can pause it, upgrade it, or claw anything
back — including us.

The compensating controls are:

1. **Minimality.** One file, no imports, no libraries, no proxy, no owner, one
   storage struct, ~6 KB of runtime bytecode. The whole attack surface is six
   state-changing functions and it fits on a few screens.
2. **A dedicated adversarial review pass before deployment** — a fresh reviewer
   against a checklist of reentrancy, signature replay across duels and chains,
   rake rounding, refund-vs-settle races, ERC-20 return values, and `invited`
   griefing.
3. **Rake and stakes are separated in the accounting**, and the only function
   that can pay the treasury reads a counter that settlement alone increments.
4. **The unconditional six-hour refund**, reachable by each player independently.

The UI warns above $20 and enforces the $0.10 floor, but nothing on chain caps
the amount. Stake accordingly.

## Build

```
bun contracts/build.ts
```

- **solc is pinned to `0.8.26` exactly** in `package.json` (not a range), and
  `DuelEscrow.sol` carries the matching fixed pragma `pragma solidity 0.8.26;`.
- Optimizer **enabled, 200 runs**.
- `evmVersion` is **not set**, so it is the compiler default — `cancun` for
  0.8.26, which Base supports.
- Output: `out/DuelEscrow.json`, committed.

> Do not casually bump solc. Releases from 0.8.30 onward default to newer EVM
> targets whose opcodes Base may not accept. If the version is ever raised, pin
> `evmVersion` explicitly in `build.ts` and re-run the review.

The build must be warning-free; `test/escrow.test.ts` fails on any warning.

## Owner runbook — deploy and verify

Deployment is a **one-shot, irreversible** action. Nothing below is done by an
agent.

**Before you start**

1. Read `DuelEscrow.sol` in full. It is written for exactly this moment.
2. Confirm the adversarial review pass is done and its findings are closed.
3. Have three addresses settled and double-checked. `attestor` and `treasury`
   are immutable forever; a typo means redeploying.
   - a funded deployer (~$0.50 of Base ETH),
   - the attestor's **address** (never its private key),
   - the treasury address.

**Environment** (in `.env`, never committed)

```
RPC_URL=<Base mainnet JSON-RPC>          # secret
DEPLOYER_PRIVATE_KEY=<funded deploy key> # secret, this script only
ATTESTOR_ADDRESS=0x…                     # the referee key's address
TREASURY_ADDRESS=0x…                     # sole rake recipient, immutable
USDC=                                    # optional; defaults to Base native USDC
                                         # 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
```

`deploy.ts` refuses to do anything if any required variable is missing, if any
address fails checksum validation, or if `out/DuelEscrow.json` does not match a
fresh compile of the source.

**1 — Preflight (broadcasts nothing)**

```
bun contracts/build.ts
bun contracts/deploy.ts
```

Read the printed constructor arguments back against your notes. This is the last
moment they can be changed.

**2 — Deploy**

```
bun contracts/deploy.ts --broadcast
```

Prints the deployed address, the transaction hash, and a BaseScan link.

**3 — Verify the source (a release gate, not a nicety)**

BaseScan → the contract address → *Contract* → *Verify & Publish*, using the
inputs `deploy.ts` printed:

| Field | Value |
|---|---|
| Compiler Type | Solidity (Single file) |
| Compiler Version | `v0.8.26+commit.8a97fa7a` |
| License | MIT |
| Optimization | Yes |
| Runs | 200 |
| EVM Version | `cancun` |
| Source | `contracts/DuelEscrow.sol`, pasted verbatim — there is nothing to flatten |
| Constructor arguments | the ABI-encoded hex `deploy.ts` printed, **without** the leading `0x` |

**4 — Wire it up**

Set `THETADUEL_ESCROW=<address>` in `.env`. On-chain staking additionally
requires `THETADUEL_STAKE=on` and `ATTESTOR_PRIVATE_KEY`; with either unset the
app stays PTS-only and never touches the chain.

**5 — Smoke test with real money, small**

Open a $0.10 duel from one wallet, join from a second, settle, confirm the
winner received $0.192 and that `rakeAccrued()` reads 8000. Separately, open a
duel, join it, and leave it unsettled overnight to exercise `refund` past the
six-hour timeout.
