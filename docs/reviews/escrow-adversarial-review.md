# Adversarial review — `contracts/DuelEscrow.sol`

> Historical review: the reviewed bytecode predates the later on-chain $20
> maximum and Base Sepolia configuration support. It is useful background, not
> an audit of the current artifact. Re-review before any mainnet deployment.

**Reviewer:** fresh adversarial pass, pre-deploy gate (plan 5 §P5, line 85)
**Target:** `contracts/DuelEscrow.sol` @ solc 0.8.26, optimizer 200 runs, runtime 5,948 bytes
**Method:** real EVM execution (`@ethereumjs/evm`) against the **committed runtime bytecode**, 371 assertions across 8 suites, all passing.

---

## EXECUTIVE VERDICT

# SHIP WITH NOTES

No finding puts a player's principal at risk through the contract. The six mandated
checklist items were each attacked with executed exploits, not read for intent:
reentrancy nets exactly zero across every call site and both hook phases; the rake
identity `payout + rake == 2 × stake` is exact for every stake from `MIN_STAKE` to
`uint128` max; the state machine admits exactly the intended transitions and no
others; every one of the six USDC call sites checks its boolean. CEI ordering is
real, not claimed.

The notes are four LOW/INFO items below, all of them properties the contract's own
natspec either states or implies, plus one deploy-time discipline item.

> ### ⚠ SEPARATE, NON-CONTRACT BLOCKER — read finding **X-1**
> `src/server/attest.ts` (`POST /api/lock`) is unauthenticated and first-write-wins,
> and duel ids are enumerable. A joiner can pre-commit a slip that names themselves
> the winner, and the escrow will pay it — correctly, because the contract's only
> constraint is `winner ∈ {a, b}` and that constraint is satisfied.
> **The contract is not the flaw and cannot fix this.** But shipping the contract
> with this server as-is means real USDC is stealable. This is outside my mandated
> scope (I was told "attest.ts, domain equality only"), so it does not change the
> contract verdict — but the owner must resolve it before money is live.

---

## Per-checklist findings

### 1. Reentrancy — **EXECUTED**, no finding (INFO)

**Tested:** every external call site (`open`/`join` → `transferFrom`;
`settle`/`refund`/`cancel`/`claimRake` → `transfer`) with a `MockUSDC` that
re-enters the escrow mid-transfer, in **both** phases — `preHook` (before balances
move, the pessimal ordering a real callback token cannot even achieve) and
`postHook`. The re-entering party is an `Attacker` **contract that is a genuine
player** (`d.a` or `d.b`), so `msg.sender` inside the reentrant call is legitimate.
In every scenario the escrow was **pre-loaded with other duels' money** so a
reentrant payout would have had something to steal.

**How:** `.rev/a1-reentrancy.ts` — 60 assertions, all passing.

| Entry point | Reentrant payload | Result |
|---|---|---|
| `open` (pre) | `cancel(sameId)` | runs, **nets exactly 0** — cancel pays `stake` out of the pool, the outer `transferFrom` pulls `stake` back in |
| `open` (pre) | `open(sameId)` / `join(ownDuel)` | `duel exists` / `cannot join own duel` |
| `join` (pre) | `refund(sameId)` | `not expired` — `fullAt == block.timestamp` |
| `join` (pre) | `settle` with a **genuine attestor sig** | executes; attacker nets exactly `pot − rake − ownStake`, i.e. he won the duel and nothing more; escrow still covers rake + every bystander pot |
| `settle` (post) | `settle` / `refund` / `cancel` | `not full` / `not refundable` / `not open` — status is written **before** the transfer |
| `refund` (post) | `refund` / `settle` | `already refunded` / `not full` |
| `cancel` (post) | `open` / `cancel` / `refund` | `duel exists` / `not open` / `never filled` |
| `claimRake` (post, hook on **treasury**) | `claimRake` | zero-value no-op; the live duel's `2 × stake` untouched |

**Cross-duel drain:** 10 honest FULL duels (20 stakes pooled), then 12 reentrancy
attempts across every payload × both hook phases. Attacker delta: **exactly 0**.
Honest pool: **untouched**.

**Finding: INFO.** CEI is correctly implemented everywhere. `claimRake` reads and
zeroes before transferring and is structurally incapable of reaching a stake — I
verified that with a live `5 × stake` FULL duel sitting in the balance during a
double-claim. No `nonReentrant` guard is needed and none would add anything.

---

### 2. Signature replay & ECDSA — **EXECUTED**, no finding (INFO)

**Tested / how:** `.rev/a2-sigreplay.ts` — 64 assertions, all passing, against the
EVM's real `ecrecover` precompile with `chainId = 8453`.

- **Across duels:** a verdict for duel 1 replayed on duel 2 → `bad attestor signature`. `duelId` is in the struct hash.
- **Across chains:** signed for chainId 1, 10, 84532, **8452 and 8454** (the neighbours) → all `bad attestor signature`. Only 8453 verifies.
- **Across instances:** a **second escrow deployed on the same chain**, same attestor key, same token — distinct `DOMAIN_SEPARATOR`, and escrow #1's verdict is rejected by #2 while still working on #1.
- **After settle:** 3 replays → `not full`. **After refund:** a still-in-date winning verdict → `not full`; the winner can then only pull principal.
- **Cancel → re-open same id:** `duel exists`, by the opener **and** by a different address. Ids are retired forever, so no stale verdict can ever find a new duel.
- **Malleability:** the twin `(s' = n − s, v flipped)` → `malleable signature`. `v ∈ {0,1,26,29,30,31,255}` → `bad signature v`. Lengths `{0,1,64,66,96,130}` → `bad signature length`. `r = s = 0` with legal `v` → `invalid signature` (the `signer != address(0)` guard). 25 random well-formed signatures → 0 accepted. Signatures from three non-attestor keys → all rejected.
- **Calldata edges** (`.rev/a7-misc.ts` §7b): hand-built calldata ending **exactly on the 65th signature byte** (so `calldataload(sig.offset + 64)` reads 31 bytes past `calldatasize`) still recovers correctly — the assembly is safe at the boundary. A truncated array, a wild offset and an oversized length word are all rejected by the ABI decoder; trailing junk is ignored.
- **Winner must be a player:** attestor-signed payouts to `C`, `address(0)`, the attestor itself, the escrow itself, and two other EOAs → all `winner not a player`. **A compromised attestor cannot pay itself or a third party — only choose between the two players.** That matches the stated trust model exactly.
- **Deadline:** `deadline == now` accepted (`<=` is inclusive), `now − 1` and `0` rejected with `verdict expired`. Expiry is checked **before** recovery.
- **Domain equality with `src/server/attest.ts`** (transcribed, not imported, so drift in either file surfaces here): `DOMAIN_SEPARATOR()` == the server's `hashDomain` **byte for byte** (`0x89ca87…e8d5`); `VERDICT_TYPEHASH()` == `keccak(encodeType)` (`0x44a5d7…9454`); and a verdict signed exactly the way `attest.ts` signs one **settles on chain**. `uint64` truncation: ethers throws on `deadline ≥ 2^64` rather than silently truncating, so server and contract cannot disagree.

**Finding: INFO.** A `deadline` of `uint64` max is signable and never expires. That
is the attestor key's discretion, it is bound to one duel that leaves `FULL` once,
and `attest.ts` uses `now + 1800`. Not a contract flaw; worth a line in the key
runbook.

---

### 3. Rake math, rounding, overflow — **EXECUTED**, no finding

**Tested / how:** `.rev/a3-rakemath.ts` — 35 assertions, all passing.

On chain, for stakes `{MIN_STAKE, MIN+1, 100 007, 100 012, 123 457, 999 999,
1 000 001, 2 500 001, 7 000 003, 10^12+7, 10^18+13, 2^100+1, 2^127, 2^128−1}`,
each duel was opened, joined, settled and the three balances read back:

```
stake 100000  : payout 192000 + rake 8000  == pot 200000
stake 100007  : payout 192014 + rake 8000  == pot 200014      <- 8% is not an integer here
stake 999999  : payout 1919999 + rake 79999 == pot 1999998
stake 2^128-1 : payout 653342144488201849849679246268994965994
              + rake   27222589353675077077069968594541456916
              == pot   680564733841876926926749214863536422910
```

`payout + rakeΔ == 2 × stake` **exactly** in every case; the escrow's balance drop
equals the payout exactly; after all settles `balanceOf(escrow) == rakeAccrued`
exactly and `claimRake` sweeps every base unit. Stakes `0`, `3`, `12 499` →
`stake too small`.

**Overflow:** three consecutive settles at `stake = 2^128 − 1` — no Panic 0x11,
`rakeAccrued` exact at `81 667 768 061 025 231 231 209 905 783 624 370 748`, which
is `< 2^200`. `uint256(d.stake) * 2` and `pot * 400` cannot overflow for any
`uint128` stake.

**Property sweep:** 250 000 stake values through the exact Solidity expression —
0 identity failures, 0 zero-rake stakes, minimum effective rake 3.99952 %, and
the floor **always favours the winner, never the house** (`rake × 10000 ≤ pot × 400`
in every case). 48 of the 50 stakes immediately above `MIN_STAKE` produce a
remainder, so the rounding path is genuinely exercised, not vacuous.

**Finding: none.** There is no third bucket and no dust. The only "loss" is that the
house rounds its own rake down by at most 1 base unit ($0.000001) per settle.

---

### 4. Refund-vs-settle races — **EXECUTED**, one LOW

**Tested / how:** `.rev/a4-races.ts` — 53 assertions, all passing.

- **Boundary, to the second:** refund at `fullAt + T − 1` → `not expired`; at **exactly** `fullAt + T` → `not expired` (the `>` is strict); at `fullAt + T + 1` → accepted. `fullAt == block.timestamp` at join.
- **settle then refund / refund then settle / double refund / non-player refund / refund of an unjoined duel / refund of a cancelled duel:** every one correctly rejected, with the right revert string. A cancelled duel is caught by `fullAt != 0` (`never filled`), not by status — the guard that stops a cancelled opener double-dipping.
- **One-sided refund:** after A pulls, the escrow still holds exactly B's stake, and B pulls it **five simulated years later**. `aWithdrawn`/`bWithdrawn` survive the `FULL → REFUNDED` transition, so one player refusing to claim can never strand the other.
- **Partly-refunded duel:** not settleable by anyone, for either winner, at any deadline including `uint64` max.
- **Exhaustive state machine:** all 6 reachable statuses × 8 entry points, **each probe on a fresh chain** so probes cannot contaminate one another. Exactly the intended transitions succeed and nothing else:

```
[NONE]                 open
[OPEN]                 join, cancel(a)
[FULL]                 settle, refund(a), refund(b)
[SETTLED]              — nothing —
[REFUNDED(one pulled)] refund(b)
[REFUNDED(cancel)]     — nothing —
```

#### Finding 4-1 — **LOW**: after TIMEOUT the loser can force a draw

`settle` has **no timeout of its own** — it is closed only by the first `refund`.
I executed a settle **25 simulated days** past `TIMEOUT` and it succeeded, because
nobody had refunded. The dual of that is the race:

> **Exploit sketch.** A wins; the server signs `Verdict(duelId, A, deadline)`. A does
> not relay. Six hours after the duel filled, B (the loser) calls `refund(duelId)`
> first. The duel goes `REFUNDED`; A's still-in-date winning verdict now reverts
> `not full`. A pulls principal, B pulls principal. **Executed:** both end flat,
> `rakeAccrued == 0`.

**Impact:** the winner loses their expected `0.92 × stake` profit; **no principal is
at risk and no third party gains anything.** This is inherent to a pull-style escape
hatch that needs no cooperation — the alternative (letting settle beat refund
forever) would strand players when the server dies, which is strictly worse.

**Recommendation (no contract change):** the winner should relay promptly — the
window is six hours and `settle` is permissionless, so the client can relay without
the server. Worth one line of UI copy: *"claim within 6 hours or the duel voids."*

---

### 5. USDC return values — **EXECUTED**, INFO (+ one deploy-time note)

**Tested / how:** `.rev/a5-token.ts` — 47 assertions, all passing.

All **six** transfer sites are `require`-wrapped. Verified by flipping the token to
false-returning at each step and confirming the revert **plus** full state rollback:

| path | revert | escrow balance | `rakeAccrued` | duel state |
|---|---|---|---|---|
| `open` | `transferFrom failed` | unchanged | unchanged | back to `NONE` |
| `join` | `transferFrom failed` | unchanged | unchanged | still `OPEN`, `b` unset |
| `settle` | `transfer failed` | unchanged | unchanged | still `FULL` |
| `refund` | `transfer failed` | unchanged | unchanged | `FULL`, `aWithdrawn` false |
| `cancel` | `transfer failed` | unchanged | unchanged | still `OPEN` |
| `claimRake` | `transfer failed` | unchanged | **not zeroed** | `SETTLED` |

A **no-return (USDT-style)** token also reverts — solc's decoder rejects
`returndatasize < 32` — and the contract works again the moment the token behaves.

**Severity, honestly classified: INFO.** Native USDC on Base
(`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, FiatTokenV2_2) returns `true` and
**reverts** on failure. Neither mode is reachable in production. Both fail closed:
the contract becomes unusable, it never silently loses funds.

#### Finding 5-1 — **MED (deploy-time only, not a code defect)**: a fee-on-transfer or wrong token address is unrecoverable

**Executed** with a 1 % fee token: the escrow books a `2 × stake` pot but actually
receives `1 980 000`; `settle` still pays out (the payout is smaller than the
balance) and then **`claimRake` reverts — the rake it booked does not exist**. With
several duels the shortfall would be paid out of other duels' stakes.

> **Exploit sketch (misconfiguration, not attack).** `contracts/deploy.ts` takes
> `USDC` from the environment and only *defaults* to Base native USDC; the
> constructor accepts **any** non-zero address, and I confirmed it will even accept
> `usdc == attestor == treasury`. There is no owner, no sweep and no rotation, so a
> single wrong constructor argument is permanently unrecoverable.

**Recommendation:** treat the three constructor arguments as the release gate they
are. `deploy.ts` already prints `<-- NOT the default!` when `USDC` is overridden and
warns on a non-8453 chain id — **make both of those hard refusals rather than
warnings**, and confirm `attestor` and `treasury` on BaseScan before the first
stake. (Note also: a wrong chain id would silently invalidate every server
signature, since `attest.ts` hard-codes `chainId = 8453`.)

#### Finding 5-2 — **LOW**: USDC's blacklist

**Executed.** USDC on Base really can freeze an address, so this is not hypothetical:

- **Blacklisted winner:** `settle` reverts, the duel **stays `FULL`**, and after the timeout the *non-blacklisted* player recovers their stake normally. Only the blacklisted player's own stake is stuck. The escape hatch survives.
- **Blacklisted treasury:** `claimRake` reverts and `rakeAccrued` is **not** zeroed (the whole tx reverts). Rake is stranded; **no stake is affected** — I opened, joined and fully refunded a fresh duel while the rake sat stuck.

Unrecoverable in both cases (no sweep, by design), but the blast radius is
correctly confined to the frozen party.

#### Finding 5-3 — **INFO**: donated USDC is permanently lost

**Executed:** 500 USDC donated to the escrow survives a full settle + claimRake
cycle untouched; `rakeAccrued` is not inflated by it and the treasury receives only
the real rake. This is the documented consequence of having no sweep, and the
natspec is right that a sweep is exactly the function that could drain stakes.

---

### 6. Griefing via `invited`, id collisions, state escapes — **EXECUTED**, one LOW

**Tested / how:** `.rev/a6-grief.ts` — 53 assertions, all passing.

- `invited = 0` → open to all comers. `invited = self` → `invited self`, **no duel booked and no stake taken**. `invited = third party` → only they may join; the opener still cannot join their own duel.
- `invited` set to the **escrow itself**, the **attestor key**, or a **dead address**: nobody can ever join, and in all three cases the opener escapes via `cancel` with the **full stake** back. There is no way to trap an opener's money with a bad invitee.
- `cancel` by B, C, the relay, the treasury and the deployer → `not opener`. Only the opener, only while `OPEN`.
- **Id collision with a settled/refunded duel:** impossible. `open` requires `NONE`, and no path returns to `NONE`.
- **State-machine escape:** covered exhaustively in §4 above — none exists.
- **Front-running:** a third party winning the race to `join` makes the loser's tx revert `not open` with **no stake taken**; an opener cancelling out from under a joiner likewise costs the joiner only gas.
- **No admin surface:** calls to `owner()`, `transferOwnership`, `pause`, `unpause`, `withdraw`, `emergencyWithdraw`, `upgradeTo`, `0x00000000` and empty calldata **all revert** — no fallback, no receive, nothing payable.
- **Balance-invariant fuzz:** 60 random operations across 4 players and 17 duels (open/join/cancel/settle/refund/claimRake with random clock warps), checking after **every** operation that
  `balanceOf(escrow) ≥ rakeAccrued + Σ OPEN stakes + Σ 2×FULL stakes + Σ unwithdrawn REFUNDED stakes`.
  **0 violations.** Then every outstanding claim was withdrawn and the escrow ended at **exactly 0** — no trapped dust.

#### Finding 6-1 — **LOW**: id squatting is practical, not theoretical

The natspec (`open`, lines 250-256) acknowledges squatting and prescribes the
mitigation: *"derive `matchKey` from something an outsider cannot guess ahead of the
players."* **The format the app actually uses does not meet that.**
`matchKey = \`${lobbyId}:${seed}\`` with **6** board lobbies and seeds
`100 000…999 999` — a **5.4 M** key space.

> **Exploit sketch — executed.** From a `duelId` observed on chain, I recovered the
> matchKey preimage `lx-degen:418277` by brute force in **30 ms** over a 2 400-key
> slice; the full 5.4 M sweep is seconds of keccak. The griefer then opens that id
> first at `MIN_STAKE`. The real room's `open` reverts `duel exists` — **forever**,
> even after the griefer cancels and recovers their $0.10. Verified: no player money
> is ever at risk; the escrow ends at zero.

**Impact:** denial of service on a room, at a cost to the griefer of gas plus a
fully recoverable $0.10. **Never a path to anyone's money.** The contract behaves
correctly; the gap is between the natspec's prescribed off-chain mitigation and the
matchKey format actually shipped.

**Recommendation (no contract change):** add per-room entropy to `matchKey` — e.g.
`\`${lobbyId}:${seed}:${randomNonce}\`` — so ids are unpredictable ahead of the
players, which is what the natspec already asks for. This also closes half of X-1.

---

## Additional findings beyond the checklist

### Storage packing — **EXECUTED**, no finding
`.rev/a7-misc.ts` §7a. The `Duel` struct packs into 4 slots (`a` | `b` | `invited` |
`stake:128 + fullAt:64 + status:8 + aWithdrawn:8 + bWithdrawn:8` = 27 bytes),
as the natspec claims. Driven to extremes — `stake = 2^128 − 1`, clock warped to
`2^40` so `fullAt` is a large `uint64`, distinct `a`/`b`/`invited`, every flag
toggled — every field reads back correctly at every step, `aWithdrawn` and
`bWithdrawn` set independently, and two neighbouring duels keep their own
stake/invited/status/b with no bleed.

*(Theoretical: `uint64(block.timestamp)` truncates silently rather than reverting,
and `uint256(fullAt) + TIMEOUT` is widened so it cannot overflow. Irrelevant until
the year ~584 billion.)*

### Events — **EXECUTED**, no finding
All six events carry the right values: `DuelSettled.payout + .rake == 2 × stake`,
`DuelJoined.fullAt == block.timestamp`, `RakeClaimed` names the immutable treasury.
The P6 staking UI can be built on these.

### Artifact / deployment drift — **EXECUTED**, no finding
`contracts/out/DuelEscrow.json` matches a fresh compile in creation bytecode,
runtime bytecode and metadata. solc pinned `0.8.26+commit.8a97fa7a`, **zero
warnings**, runtime 5 948 bytes (EIP-170 limit 24 576). Constants read from the AST:
`RAKE_BPS=400 BPS=10000 MIN_STAKE=100000 TIMEOUT=21600`, and **no `MAX_STAKE`** —
the owner's stated decision, intact.

**The bytecode I attacked is the committed bytecode.** I diffed the code actually
installed in the EVM against `deployedBytecode`: identical length, and every
differing byte is `0x00` in the committed artifact — i.e. purely immutable
placeholders, in runs of 32 (two `DOMAIN_SEPARATOR` read sites) and ≤ 20 (address
immutables, inlined per read site). No code byte differs.

### Constructor — **EXECUTED**, see 5-1
Rejects `usdc = 0`, `attestor = 0`, `treasury = 0`. Does **not** cross-check the
three for distinctness (it will accept `usdc == attestor == treasury`).

### Treasury as a player — **EXECUTED**, no finding
If the treasury address also plays, it wins `pot − rake` as a player and separately
receives rake via `claimRake`; the two accounting paths stay separate and the escrow
still ends at zero.

---

## X-1 — ADJACENT SCOPE, **HIGH** — `src/server/attest.ts` lets the winner be chosen

*Outside my mandated scope (I was scoped to "attest.ts, domain equality only", which
is clean — see §2). Reported because it is funds-affecting and this is the gate
before real money. **Analyzed, not executed end-to-end.***

The contract's only on-chain constraint on the payee is `winner ∈ {d.a, d.b}` — which
is correct and is exactly what the spec asks for. Everything else is the server's
honesty. Three facts compose badly:

1. `POST /api/lock` has **no authentication** (`index.ts:115`) and takes `a`, `b` **and `picks`** straight from the request body (`attest.ts:593-608`). Nothing proves the caller is `a`.
2. It is **first-write-wins**, keyed by `duelId = keccak256(matchKey)` (`attest.ts:582-591`).
3. `duelId` preimages are enumerable in seconds (finding 6-1), and the outcome is a **pure, client-side** function of `(lobby, seed, picks)` — `deriveVerdict` (`attest.ts:349`) — over only **8** `PARLAY_CARDS` and 2-4 legs, i.e. **≤ 4 096** slips to search offline.

> **Exploit sketch.** B joins A's duel on chain (both addresses are public in
> `DuelOpened`/`DuelJoined`). B recovers `matchKey` from `duelId`, brute-forces the
> ≤ 4 096 slips offline against the shipped engine until `meWins === true`, then
> `POST /api/lock {matchKey, picks: <winning slip>, a: B, b: A}` **before A's client
> locks**. First-write-wins pins it. `POST /api/attest` re-derives from those
> committed picks and honestly signs `winner = B`. B relays `settle` and takes
> `1.92 × stake`. The contract does nothing wrong: B *is* a player.

**Recommended fixes (any one closes it):** require an EIP-712 signature from `a` on
the lock body; or read `a`/`b` from the chain's `DuelOpened`/`DuelJoined` rather than
the request; or require the lock to land **before** the on-chain `open` and bind
`duelId` to the committed payload; plus the per-room nonce from 6-1.

---

## Executed vs. analyzed

### Executed — real EVM, real `ecrecover`, real committed bytecode
`@ethereumjs/evm` 3.1.0 + `@ethereumjs/statemanager`, Cancun, `chainId = 8453`,
driving the runtime produced by `compileEscrow()`. **371 assertions, 371 passing.**

| script | assertions | what it executed |
|---|---|---|
| `.rev/smoke.ts` | 15 | harness sanity, constants, `DOMAIN_SEPARATOR`, full happy path |
| `.rev/a1-reentrancy.ts` | 60 | checklist 1 — all 6 call sites, both hook phases, cross-duel drain |
| `.rev/a2-sigreplay.ts` | 64 | checklist 2 — duel/chain/instance replay, malleability, deadline, attest.ts domain |
| `.rev/a3-rakemath.ts` | 35 | checklist 3 — on-chain exactness + 250k-value property sweep |
| `.rev/a4-races.ts` | 53 | checklist 4 — TIMEOUT boundary, races, exhaustive state machine |
| `.rev/a5-token.ts` | 47 | checklist 5 — false/no-return/fee/blacklist/donation modes |
| `.rev/a6-grief.ts` | 53 | checklist 6 — `invited`, squatting, admin surface, 60-op invariant fuzz |
| `.rev/a7-misc.ts` | 44 | packing, calldata edges, constructor, events, artifact drift |

Supporting: `.rev/evm.ts` (EVM wrapper + extended `MockUSDC`/`Attacker`),
`.rev/fix.ts` (fixture). Run with `bun .rev/<file>.ts` from the repo root.

### Analyzed only — NOT executed
1. **Real Base USDC semantics.** Modelled with `MockUSDC`; the real FiatTokenV2_2 was not forked. Its behaviour (returns `bool`, reverts on failure, no fee, has a blacklist) is asserted from its known implementation, and every finding that depends on it is classified accordingly.
2. **X-1**, the `/api/lock` front-run. Read from source; the server was not stood up and the slip search was not run. The ≤ 4 096 search space and the 8-card deck **were** confirmed by execution.
3. **`contracts/deploy.ts`** was read, not run. No mainnet or testnet transaction was broadcast; BaseScan verification was not exercised.
4. **Gas costs / griefing by gas** under real Base conditions. The harness runs at a 20 M limit and no path is unbounded (no loops, no arrays), so this was not pursued.
5. **solc 0.8.26 itself.** Trusted, pinned, and reproducible; its correctness is out of scope.
6. **Cryptographic soundness of secp256k1 / keccak.** Out of scope.
7. **A post-deployment Base chain split** pinning `DOMAIN_SEPARATOR` to 8453 — documented and accepted by the natspec; not simulated.

### Environment note (please read before committing)
No repo dependency changed: `package.json` and `bun.lock` are untouched.
`@ethereumjs/*` was installed **into the session scratchpad**, and `.rev/node_modules`
is a **directory junction** pointing at it. `.rev/` is currently untracked but **not
git-ignored** — add `.rev/` to `.gitignore`, or delete the junction, before any
`git add -A`. Nothing under `contracts/`, `src/`, `test/` or `index.ts` was modified,
and nothing was staged or committed.
