# `contracts/` — DuelEscrow

The on-chain half of THETADUEL's optional USDC side bet. One Solidity file, no
imports, no libraries, no framework. `solc` is the only build dependency; there
is no foundry and no hardhat.

| File | What it is |
|---|---|
| `DuelEscrow.sol` | The contract. Around 500 lines, the large majority of it natspec — six state-changing functions carry the rest. Read it in full; it is written to be read in full. |
| `build.ts` | `bun contracts/build.ts` — compiles with the pinned solc and writes `out/DuelEscrow.json`. |
| `deploy.ts` | `bun contracts/deploy.ts` — preflight by default; `--broadcast` deploys **to Base Sepolia**. Prints the BaseScan verification inputs. |
| `out/DuelEscrow.json` | **Committed** artifact: `{abi, bytecode, deployedBytecode, metadata, solcVersion}`. This is the reviewed bytecode. |
| `solc.d.ts` | Ambient types for solc-js, which ships none. |

`test/escrow.test.ts` compiles the contract in-process and asserts on what came
out: the ABI surface, the money constants, the EIP-712 typehashes, and that the
committed artifact still matches the source.

## Which chain — Base Sepolia, and only Base Sepolia

**This README used to assume Base mainnet was the only target, and said so in
every section. That assumption is now inverted.** The owner's instruction was:
"connecting wallet should only be on testnet not mainnet, and work on testnet
only." `src/data/wallet.ts` is the long-form statement of what that means; the
part that concerns this directory is:

| | chain id | what happens there |
|---|---|---|
| **Signing chain — Base Sepolia** | `84532` | Everything that signs, approves, sends or settles. **`DuelEscrow` belongs here.** |
| Data chain — Base mainnet | `8453` | READ ONLY, forever. The Thetanuts options book, which has no testnet. Never signed on. Not a deploy target. |

So `deploy.ts` now refuses any chain that is not `84532`, where it used to
refuse any chain that was not `8453`. It is the same refusal with the same
absence of an override flag, pointed the other way, and the inversion tightened
it rather than loosened it: the old refusal existed because a non-mainnet escrow
could not be settled by the attestor, and the new one exists for that reason
*plus* the fact that an escrow on mainnet could not be reached by this app's UI
at all — `assertSigningChain` refuses to hand a signer to anything on `8453`.

Correspondingly the token changed, because it had to. Native USDC on Base
mainnet (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) does not exist at any
address on Base Sepolia. The default is now Circle's official **test** USDC,
`0x036CbD53842c5426634e7929541eC2318f3dCF7e` — same FiatTokenV2 behaviour
(returns `true`, reverts on failure, no transfer fee), no market value. The
worthlessness is the feature: it is what makes it true that nothing signed in
this build can spend real money. `deploy.ts` still refuses every other token
address with no override, and a hand-rolled mock ERC-20 is explicitly not a
substitute — the ways a mock differs from `FiatTokenV2` are precisely the ways
the escrow's accounting breaks.

### The attestor's domain — resolved, and re-checked on every run

**Status: the chain id is now `84532` in all three places that hold it, so
`deploy.ts --broadcast` is no longer refused.** This section is kept rather than
deleted, because agreement between them is a thing one line in any one file can
silently break again, and because it is the reason `deploy.ts` performs a check
that spends a file read on every run.

The number lives in three places, deliberately un-shared (`seats.ts` cannot
import `attest.ts`'s copy — `attest.ts` imports `seats.ts`, and the cycle would
buy nothing):

| Where | Was | Is |
|---|---|---|
| `src/server/attest.ts` — `SIGNING_CHAIN_ID` (renamed from `BASE_CHAIN_ID`), folded into the EIP-712 domain the attestor signs verdicts over | `8453` | `84532` |
| `test/attest.test.ts` — the pin on that constant | `8453` | `84532` |
| `src/server/seats.ts` — its own `SIGNING_CHAIN_ID`, the expected network for the seat-reading provider | `8453` | `84532` |

(Named by symbol rather than cited by line. All three constants moved line
during this retarget, and both the rows and `deploy.ts`'s banner briefly pointed
at the old numbers — a citation that sends a reader to the wrong line is the
same defect as one naming a symbol that no longer exists. `SIGNING_CHAIN_ID` is
greppable; a line number is a claim that goes stale silently.)

For a window during the testnet retarget they disagreed with `deploy.ts`, and
the whole suite stayed green throughout. That is worth understanding rather than
forgetting: the pin in `test/attest.test.ts` asserts the transcription is **stable**,
not that it is **correct**. It cannot assert correctness, because the contract
builds its `DOMAIN_SEPARATOR` from `block.chainid` at construction time
(in `DuelEscrow.sol`'s constructor) and no source read can confirm what that
will be.

What it would have cost: an escrow constructed on `84532` separates over
`84532`, while an attestor signing over `8453` produces verdicts `settle`
recovers a stranger from and reverts on — for every duel, forever, discovered
only after both stakes are locked, with the six-hour `refund` as the only way
out. That is finding 5-1 of `docs/reviews/escrow-adversarial-review.md` landing
exactly as written, pointing the opposite way from the direction it was written
for: 5-1 assumed the hazard was *leaving* mainnet. `seats.ts` is the milder
one — a wrong value there cannot mis-sign anything, it fails reads closed, but
"closed" means every seat read refused and `/api/lock` rejecting every lock with
nothing on screen explaining why.

So `deploy.ts` reads the constant out of `src/server/attest.ts` at run time and
compares it to the chain it is about to deploy to. It deliberately does **not**
keep a fourth copy: a copy agreeing with itself is exactly the reassurance that
would have hidden this. On a disagreement it prints a `DOMAIN MISMATCH` block
and exits before broadcasting; preflight still runs, because it broadcasts
nothing. There is no flag that lifts it, and if the constant cannot be found at
all — renamed, moved — it fails closed rather than guessing. The fix, if it ever
fires again, is one line in `src/server/attest.ts` plus its pinning test, routed
to the owner and reviewed where the constant lives, not made from a deploy
script.

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
| Minimum stake | `MIN_STAKE = 1_000` — 0.001 USDC at 6 decimals. Anti-grief, and **lowered from `100_000` ($0.10) for the Sepolia retarget** — see below. |
| **Maximum stake** | **None.** See the risk statement below. |
| Timeout | `TIMEOUT = 6 hours` from the moment a duel fills. |
| `usdc`, `attestor`, `treasury` | Constructor arguments, immutable. No setter exists for any of them. |

**Why `MIN_STAKE` moved, and the one condition that made moving it legal.** The
floor was `100_000` ($0.10) while this contract was bound for Base mainnet: the
grief it prevents is opening duels nobody will join, and below some amount that
is cheap enough to be worth doing to someone. On Base Sepolia the stake token is
Circle's test USDC with no market value, so the grief costs the victim nothing
to suffer while the floor itself put the owner's requested 0.001 out of reach —
on a testnet that trade runs the wrong way round. `MIN_STAKE` is a `constant`
with no setter, fixed at deployment and immutable forever after, so the **only**
reason this value could be changed at all is that the contract has never been
deployed. On a future mainnet deployment the anti-grief argument returns in full
and `100_000` must be argued again from scratch rather than inherited from the
testnet line. Nothing else moved: not the rake, not the timeout, and above all
not the absence of a maximum — lowering a floor does not touch a ceiling that
was never there.

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
   storage struct, 5946 bytes of runtime bytecode. The whole attack surface is six
   state-changing functions and it fits on a few screens.
2. **A dedicated adversarial review pass before deployment** — a fresh reviewer
   against a checklist of reentrancy, signature replay across duels and chains,
   rake rounding, refund-vs-settle races, ERC-20 return values, and `invited`
   griefing.
3. **Rake and stakes are separated in the accounting**, and the only function
   that can pay the treasury reads a counter that settlement alone increments.
4. **The unconditional six-hour refund**, reachable by each player independently.

The UI warns above $20 and the chain enforces the 0.001 USDC floor, but nothing
on chain caps the amount. Stake accordingly. Note that the floor moving down
does not touch any of this: the risk here has always been at the top end, and
there is still no top end.

**What the move to Base Sepolia does and does not change here.** Every sentence
above is left standing word for word, because the contract is unchanged and
would behave identically the day it is pointed at mainnet — none of these are
testnet-only risks, they are properties of the bytecode. What changes is only
the size of the loss while the target is `84532`: the stakes are denominated in
Circle's test USDC, which has no market value and cannot be exchanged for
anything, and the gas is faucet ETH. So "risks the entire amount players choose
to stake" currently means an amount worth nothing, and "no admin able to rescue
anything" currently costs nobody anything.

That is a statement about the denomination, not about the code, and it is a
reason to *use* the testnet window rather than a reason to relax: the whole
value of deploying here first is that the reentrancy, the rounding, the
refund-vs-settle race and the ERC-20 return-value assumptions get exercised
against a real chain while a bug is still free. A finding that surfaces here is
a finding that does not surface later. Nothing in the compensating-controls
list is waived because the money is fake, and the adversarial review pass in
item 2 remains a gate for a mainnet deployment, not a formality this deployment
retires.

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

**These notes were written for Base mainnet and they still hold unchanged for
Base Sepolia — checked, not assumed.** Base Sepolia is the same OP-stack node
software as Base mainnet running at the same hardfork; it is Base's own test
network, not a third-party fork with its own opcode set. So `cancun` is
supported there for the same reason it is supported on mainnet, the pinned
0.8.26 needs no change, the optimizer settings are untouched, and the committed
artifact is byte-for-byte the artifact that was reviewed. Nothing in `build.ts`
was edited for this retarget, and nothing needed to be: the deploy chain is a
`deploy.ts` concern and never reaches the compiler. The 0.8.30 caution applies
to both chains identically and for the same reason.

The build must be warning-free; `test/escrow.test.ts` fails on any warning.

## Owner runbook — deploy and verify on Base Sepolia

Deployment is a **one-shot, irreversible** action. That is true on a testnet
too: there is no owner, no upgrade and no rotation on `84532` any more than on
`8453`, so a wrong constructor argument still means redeploying and reissuing
the address everywhere. What testnet changes is the price of the mistake, not
its permanence. Nothing below is done by an agent.

**Before you start**

0. **The attestor's domain chain id is `84532` and agrees with this script** —
   see the section near the top of this file. `deploy.ts` re-checks it on every
   run, so you do not have to; what you do have to do is believe the preflight
   if it ever says otherwise, and stop rather than looking for a way through.
   There isn't one, by design.
1. Read `DuelEscrow.sol` in full. It is written for exactly this moment.
2. Confirm the adversarial review pass is done and its findings are closed. The
   money being fake does not retire this — it is the same bytecode a mainnet
   deployment would use.
3. Have three addresses settled and double-checked. `attestor` and `treasury`
   are immutable forever; a typo means redeploying.
   - a deployer funded with **Base Sepolia ETH, which is free** — no purchase,
     no bridge, no "~$0.50" of anything. Faucets:
     <https://www.alchemy.com/faucets/base-sepolia>, or the Coinbase Developer
     Platform faucet at <https://portal.cdp.coinbase.com/products/faucet>. A
     single drip covers a deployment and a smoke test with room to spare; if
     the balance runs out, drip again rather than economising.
   - the attestor's **address** (never its private key),
   - the treasury address. On testnet the rake it collects is worthless, but it
     is still immutable, so pick the address you would pick for real.

You will also want **test USDC** for the smoke test in step 5. The Circle
faucet at <https://faucet.circle.com> issues USDC on Base Sepolia; some of the
faucets above dispense it too.

**Environment** (in `.env`, never committed)

```
RPC_URL=<Base Sepolia JSON-RPC>          # secret; https://sepolia.base.org works
DEPLOYER_PRIVATE_KEY=<faucet-funded key> # secret, this script only
ATTESTOR_ADDRESS=0x…                     # the referee key's address
TREASURY_ADDRESS=0x…                     # sole rake recipient, immutable
USDC=                                    # optional; defaults to Circle TEST USDC
                                         # on Base Sepolia,
                                         # 0x036CbD53842c5426634e7929541eC2318f3dCF7e
```

`RPC_URL` is the same variable the running server uses to read seats out of the
escrow, so it has to name the chain the escrow is actually on. Pointing it at
mainnet after deploying to Sepolia does not read an empty escrow — it fails
closed, which is the intended behaviour but is confusing if you have forgotten
you did it.

`deploy.ts` refuses to do anything if any required variable is missing, if any
address fails checksum validation, if `out/DuelEscrow.json` does not match a
fresh compile of the source, if `RPC_URL` is not on `84532`, or if `USDC` names
anything but the address above. None of those refusals has an override flag.

**1 — Preflight (broadcasts nothing)**

```
bun contracts/build.ts
bun contracts/deploy.ts
```

Read the printed constructor arguments back against your notes. This is the last
moment they can be changed.

Preflight also runs the attestor-domain check. It is silent when the chain ids
agree, which they do today; if it ever prints a `DOMAIN MISMATCH` block, stop —
step 2 will refuse, and it is right to.

**2 — Deploy**

```
bun contracts/deploy.ts --broadcast
```

Prints the deployed address, the transaction hash, and a
`https://sepolia.basescan.org` link.

**3 — Verify the source (a release gate, not a nicety)**

`sepolia.basescan.org` → the contract address → *Contract* → *Verify & Publish*,
using the inputs `deploy.ts` printed. It is the same Etherscan verifier as
mainnet BaseScan and wants the same seven fields — a separate deployment of the
explorer, not a different procedure. Note that it is a **separate account
system**: an API key or a login from `basescan.org` does not carry over.

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

Set `THETADUEL_ESCROW=<address>` in `.env`. **It is a Base Sepolia address**, and
`RPC_URL` must stay on Base Sepolia alongside it — setting `THETADUEL_ESCROW`
also switches on seat binding (`src/server/seats.ts`), which reads each duel's
`a` and `b` out of the contract and fails closed if the provider is on a
different chain. Set both for the same chain or neither.

On-chain staking additionally requires `THETADUEL_STAKE=on` and
`ATTESTOR_PRIVATE_KEY`; with either unset the app stays PTS-only and never
touches the chain.

The wallets that will interact with it must be on Base Sepolia too — that is
enforced, not advisory: `assertSigningChain` (`src/data/wallet.ts`) refuses to
produce a signer on any other chain, mainnet emphatically included.

**5 — Smoke test with test money, small**

Open a $0.10 duel from one wallet, join from a second, settle, confirm the
winner received $0.192 and that `rakeAccrued()` reads 8000. Separately, open a
duel, join it, and leave it unsettled overnight to exercise `refund` past the
six-hour timeout.

**Then run it again at the new floor**, because that is the number that moved
and an untested floor is an assumption. Stake `1_000` base units (0.001 USDC)
from each side: the pot is `2_000`, the rake is `2_000 × 400 / 10_000 = 80`
exactly — no rounding, no dust — and the winner receives `1_920`. Confirm those
three, and confirm `open` reverts with `stake too small` at `999`. If the rake
at the floor ever came out as `0`, the fee would be silently free at small
stakes; it does not, and this is the check that says so.

The $0.10 arithmetic is unchanged because the contract is — 6-decimal USDC, 4 %
rake, the same expressions — but the dollars are testnet dollars, so this is a
correctness check rather than a first real payment. Run it anyway, and run it
before believing the deployment: a settle that reverts is exactly what an
attestor-domain mismatch looks like from the outside, and this is where you
would catch it if that constant were ever moved to a third value.
