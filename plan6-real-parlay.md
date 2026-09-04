# Plan 6 — the parlay becomes a real position

**Repo:** `POTATO0826/MUBA` (THETADUEL)
**Goal:** the card a player presses buys a real Thetanuts option on Base. The game
layer survives intact. Nothing about the settlement fiction survives.

Hand this whole file to the implementing agent. It is written to be executed in
order; each phase is independently shippable and independently revertible.

---

## 0. The one-sentence statement of the change

> A tier is no longer a constant. It is a delta bucket, queried against the live
> book, and pressing the card fills the order that backs it.

Everything below follows from that sentence.

---

## 1. Read before writing a line

These are load-bearing and already verified in this repo. Do not re-derive them
and do not "fix" them.

| Fact | Source in repo |
|---|---|
| 7 physical multi-leg impls are the **zero address** — butterfly and condor cannot be filled | `tnuts-test/FINDINGS.md` §3 |
| `calculatePayout` accepts only `call \| put \| call_spread \| put_spread`, lowercase | FINDINGS §4, §5.4 |
| **MM pricing** (`getPricingArray`) exists for ETH and BTC only; the other six return `[]`, not an error | FINDINGS §3, §5.5 |
| The **resting order book** (`fetchOrders`) is a *separate* source and covers more assets — AVAX is already on the board, bid-only | `src/views/ParlayRfq.tsx`, `src/data/board.ts` |
| 8 price feeds (`ETH BTC SOL DOGE XRP BNB PAXG AVAX`), 7 market prices (no PAXG), 2 with MM pricing — **three different asset sets** | FINDINGS §3 |
| `rawApiData.greeks` (`delta`, `iv`, `gamma`, `theta`, `vega`) is **undocumented** — shape-check at the boundary, never trust | FINDINGS §5.7 |
| `previewFillOrder` is **synchronous**, returns 10 fields | FINDINGS §"0.3.0 delta" |
| `ensureAllowance` returns `TransactionReceipt \| null`; **`null` is success** | FINDINGS §"ensureAllowance" |
| Filling a stale order reverts `Signer Not Authorized` | `src/desk/fill.ts`, `EXPIRY_BUFFER_MS` |
| Base mainnet only. **No testnet.** Every rehearsal spends real money. | `docs/plans/plan5-thetanuts.md` |
| RFQ is a 4-phase MM-dependent protocol — stays out of the fast loop | `docs/plans/plan5-thetanuts.md` |

**Non-negotiable:** `MAX_FILL_USDC` stays a check in code, above the network,
before any dep is touched. A UI clamp is a suggestion; a check above the network
is a bound.

---

## 2. Phase A — tiers become delta buckets

**Files:** `src/engine/parlay.ts`, `src/types.ts`

### A1. Add `mark` to `PricingRow`

`PricingRow` currently carries `bid`, `ask`, `iv`, `delta`, `edge` but **not
`mark`**. Duel scoring (Phase C) needs a mid to score against. `MmQuote.mark`
already carries `markPrice` verbatim — thread it through `buildSnapshot` onto
`PricingRow` as `mark: string`. Same rule as `bid`/`ask`: verbatim from the SDK,
never recomputed.

Also thread the backing order through, so a card knows what it would fill:

```ts
export interface PricingRow {
  // … existing fields …
  /** `markPrice`, verbatim. Never recomputed. Undefined on the mock. */
  mark?: string;
  /** The resting order this row would fill against, when one exists.
   *  Rows built from MM pricing alone have no fillable order and are
   *  display-only — `cardsForSlice` must filter them out. */
  order?: RawFillOrder;
}
```

### A2. Delete `TIERS`

Delete the `TIERS` constant entirely. `TierSpec.mult`, `.prob` and `.scale` are
the fiction; removing the object is what forces every call site to be revisited.

Keep unchanged, because the UI depends on them and they are still correct:
`Tier`, `TIER_ORDER`, `Stance`, `ParlayCard`, `PARLAY_CARDS`, `cardById`,
`slipLabel`, `LOUD_BELOW`.

### A3. Add the bands

```ts
/**
 * A tier is a moneyness bracket, expressed as |delta|.
 *
 * Delta is the standard desk approximation of the risk-neutral probability that
 * an option finishes in the money. It is therefore both the game's "chance to
 * land" and the trader's greek — the same number, which is why the UI never
 * needs two words for it.
 *
 * Bands are half-open [lo, hi) and cover 0.05–0.85. Below 0.05 the quote is
 * lottery-ticket dust with a spread wider than the premium; above 0.85 the
 * option is deep ITM and the player is paying intrinsic value to express a view
 * they could express more cheaply. Both ends are excluded on purpose.
 */
export const TIER_BANDS: Record<Tier, readonly [number, number]> = {
  SAFE:  [0.65, 0.85],
  EVEN:  [0.45, 0.65],
  SHARP: [0.25, 0.45],
  DEGEN: [0.05, 0.25],
};
```

### A4. Build cards from the book

```ts
export interface LiveCard extends ParlayCard {
  underlying: string;
  strike: string;
  expiry: string;
  /** |delta|, verbatim from the order's greeks. The "chance to land". */
  prob: number;
  /** Premium paid per contract, in USDC. This is also the max loss. */
  premium: number;
  /** Payout multiple if the option finishes at the tier's reference move.
   *  Derived, never stored — see `multipleAt`. */
  mult: number;
  mark: number;
  row: PricingRow;
}
```

`cardsForSlice(rows, slice)` returns at most eight `LiveCard`s — four tiers ×
two stances — by, for each `(tier, stance)`:

1. filter `rows` to `type === (stance === "bull" ? "CALL" : "PUT")`
2. filter to rows inside the slice's strike window and expiry
3. filter to rows with a defined `delta` **and** a defined `order`
4. filter to `|delta|` inside the tier's band
5. pick the **lowest ask** among survivors
6. if nothing survives, that card is **not dealt this round** — return `null` for
   it and let the UI render a dead slot

Step 6 is a feature. A missing DEGEN BULLISH is a true statement about the book,
and a card that always exists is the tell that the odds are house-set.

### A5. Multiplier is derived, not stored

```ts
/**
 * The payout multiple if the underlying finishes `movePct` beyond spot.
 *
 * This is `calculatePayout` divided by premium paid. It is recomputed on every
 * render because both inputs move: the premium moves with the book, and the
 * reference move moves with the mode's window. A stored multiplier goes stale
 * silently, which is the exact failure the old TIERS constant had.
 */
export function multipleAt(card: LiveCard, spot: number, movePct: number): number;
```

Implement over `client.utils.calculatePayout` with `type: 'call' | 'put'`
(lowercase — FINDINGS §5.4), `strikes` as a one-element `bigint[]` at 8dp,
`settlementPrice` at 8dp, `numContracts` at 18dp.

**Guard:** `calculatePayout` throws `INVALID_PARAMS` on a wrong-length `strikes`
array. One element for call/put, exactly two for spreads. Never three or four.

### A6. `summarize` splits in two

The old `summarize` multiplied leg multipliers and called the product a payout.
On a basket of real options that is arithmetically false — a basket pays the
**sum** of its legs, not the product. Replace with two functions that are each
honest about what they measure:

```ts
/** What the basket actually pays: the sum of leg payoffs, minus total premium.
 *  This is the number that reaches the wallet. */
export function basketPayoff(legs, spotAtSettle): number;

/** The slip's degeneracy score: the product of (1 / prob) across legs.
 *  This is a GAME number. It sizes the escrow stake and drives the loud-card
 *  styling. It is NEVER rendered next to a currency symbol and never described
 *  as a payout. */
export function degeneracyScore(legs): number;
```

The parlay drama survives — it just moves to where it is true. All-or-nothing
now describes **who takes the escrow pot**, which genuinely is all-or-nothing.

### A7. Max loss, on every card, at every rank

Every card face renders, unconditionally and above the payout figure:

```
max loss  $0.42   (premium paid)
```

Not behind a tooltip, not gated on rank, not smaller than the upside figure. A
bought option's downside is bounded and known, and that is the single most
valuable habit this product can build. It is also the honest reason `DEGEN` is
survivable: it is cheap, so the bounded loss is small.

---

## 3. Phase B — the spin deals a market slice

**Files:** `src/engine/spin.ts`, `src/data/universe.ts`, `src/data/sectors.ts`

### B1. The rule

> The spin picks the arena. The player picks the position.

The reel may deal anything that is EV-neutral and seed-deterministic. It may
never deal anything that sets the odds.

| Reel may deal | Reel may never deal |
|---|---|
| underlying (`ETH` / `BTC`) | a multiplier |
| expiry | a probability |
| strike window | a payout |
| constraint (calls only, max 3 legs, budget cap) | a strike *chosen for* the player |

### B2. New shape

```ts
/** Never a hardcoded union. The qualified set is computed from the live book
 *  at deal time — see §7. A frozen literal here is how AVAX ends up excluded
 *  on the day a maker finally quotes both sides of it. */
export type Underlying = string;

export interface MarketSlice {
  underlying: Underlying;
  /** Unix seconds. One of the live expiries at deal time. */
  expiry: number;
  /** Inclusive strike window, 8dp decimal strings. */
  strikeLo: string;
  strikeHi: string;
  /** Optional constraint that makes rounds feel different without
   *  touching anyone's odds. */
  constraint?: "CALLS_ONLY" | "PUTS_ONLY" | "MAX_3_LEGS" | "BUDGET_5";
}

export function spinSlice(
  book: readonly PricingRow[],
  qualified: readonly Underlying[],
  seed: number,
): MarketSlice;
```

`spinSlice` deals only from `qualified`, which the caller computes. The engine
never decides which assets exist — that is a fact about the book, and the book
is injected.

### B3. Retire `UNIVERSE`, keep sectors

The 18 assets with invented MEME/TECH sectors are fiction and must go. **Sectors
themselves stay** — they were the right idea applied to the wrong list. Replace
the fictional universe with sectors over assets that actually clear the gate in
§7:

| Sector | Members (subject to the gate) |
|---|---|
| `MAJORS` | ETH, BTC |
| `L1S` | SOL, BNB, AVAX |
| `MEME` | DOGE |
| `PAYMENTS` | XRP |

`bookForSectors` keeps its existing contract — filter, never iterate the sector
keys, so `["MEME","L1S"]` and `["L1S","MEME"]` are the same book in the same
order. That property is already asserted and must stay asserted.

**A sector with no qualified members is not offered in `CreateLobby`.** Render it
greyed with the reason (`no live book today`), not hidden. A host who picks MEME
and gets an empty lobby learns nothing; a host who sees MEME greyed out learns
the shape of the market they are about to trade in.

### B4. Determinism seam moves, it does not open

`test/determinism.test.ts` currently bans `src/engine/**` from importing live
market sources. **Keep the ban.** Change the shape instead: market data becomes
an *injected argument*, never an import.

```ts
// allowed — the seed picks the slice, the caller supplies the book
spinSlice(book: readonly PricingRow[], seed: number): MarketSlice

// still banned — the engine reaching for the network itself
import { marketService } from "../server/thetanuts.ts";
```

A frozen fixture in `test/fixtures/orders.json` already exists. Drive every
engine test off it. The property to assert: **same seed + same book ⇒ same
slice**, and **same seed + different book ⇒ same slice shape, different prices.**
That second assertion is the whole design, encoded.

---

## 4. Phase C — two clocks

**New file:** `src/engine/score.ts`

The structural problem: options expire Friday, a duel lasts four minutes. Do not
pick one. Run both, and let them measure different things.

| | Duel clock | Expiry clock |
|---|---|---|
| Length | minutes | to expiry |
| Scored on | Δ mark price | actual settlement |
| Pays | the escrow pot | the option payout |
| Winner | better basket return % | whoever holds it |
| Authority | attestor signature | the OptionBook contract |

### C1. The score

```ts
/**
 * A player's duel score: return on premium, marked to market.
 *
 *     score = Σ (mark_now − mark_entry) × contracts  ÷  Σ premium_paid
 *
 * Return on premium rather than absolute P&L, so a player who filled $0.40 and a
 * player who filled $1.80 are compared on skill rather than size. Absolute P&L
 * would make the duel a size contest, and the fill ladder in `desk/fill.ts`
 * means size is partly an accident of book depth on the round.
 *
 * Marks come from the same snapshot for both players, read once and passed in.
 * Reading them separately per player would let a mid-scoring book refresh decide
 * a duel.
 */
export function duelScore(
  legs: readonly FilledLeg[],
  marks: ReadonlyMap<string, number>,
): number;
```

Pure. No clock, no network. Fixture-testable.

### C2. What the attestor signs

`DuelEscrow.sol` needs **no change**. It already takes a `duelId` and an
EIP-712 verdict naming a winner. The attestor's job changes from "replay the
tape" to:

1. read one market snapshot, at the duel's declared end timestamp
2. compute `duelScore` for both players off that single snapshot
3. sign the winner

The server must re-derive the verdict from committed picks and its own snapshot —
never from a client-supplied winner. That requirement is already written into the
contract's trust-model docblock; honour it.

### C3. Ties and dead books

- Equal scores to 6dp ⇒ no verdict is signed ⇒ the six-hour refund path fires and
  both players get their stake back, rake-free. This is already implemented. Do
  not add a tiebreak; the refund path is a better answer than a coin flip.
- If the snapshot is stale or a leg is unmarkable, sign nothing. Same outcome.

---

## 5. Phase D — filling a parlay

**File:** `src/desk/fill.ts`

### D1. Sequential, with declared degradation

Multi-leg physical implementations are zero addresses, so a parlay is **N
independent vanilla fills**, one transaction each. There is no atomic path.

```ts
export async function runParlayFill(
  legs: readonly LiveCard[],
  deps: FillDeps,
): Promise<ParlayFillResult>;
```

Sequence:

1. **Preview all legs first**, synchronously (`previewFillOrder` is sync). Sum
   `totalCollateral`.
2. Check the sum against `MAX_FILL_USDC` **and** each leg against it. A cap the
   sum can step over is a cap with a staircase next to it.
3. Check every leg's `orderExpiryTimestamp` against `EXPIRY_BUFFER_MS`. Drop
   stale legs **before** the first signature, not after.
4. Show the player the final leg list, total debit, and total max loss. Get one
   confirmation for the whole slip.
5. Fill sequentially. `ensureAllowance` per leg with that leg's exact
   `totalCollateral` — **never `MaxUint256`**.
6. On a leg failure: **keep what landed, re-score the slip, continue.** Do not
   unwind. Unwinding means selling back into a thin book at a loss, which turns a
   failed leg into a realised loss.

### D2. Policy must be visible before the first signature

Render the policy as a sentence on the confirm screen, not in a docblock:

> Legs fill one at a time. If one fails, you keep the ones that landed and your
> slip re-scores.

A player who learns this after signing has been surprised by their own position.

### D3. The status ladder

Per leg: `pending → previewed → approved → filled ✓` with a Basescan link on
`filled`, and the mapped error code on failure. This ladder doubles as the
strongest "this is real" artifact in a demo — a hash nobody can open is not
evidence.

---

## 6. Phase E — detail level, defaulted by rank, never locked

**Files:** `src/data/rewards.ts` (read only), card components, a new user setting

### E1. Use the ladder that exists

The season tiers are **`MINNOW → FISH → SHARK → ORCA → WHALE`** with `III/II/I`
divisions, pinned in `src/data/rewards.ts` with XP thresholds and `copyUnlocked`
flags that other code reads. Do not invent a second ladder and do not rename
these. They are already crypto-native vocabulary, which is the whole point.

### E2. Rank sets the default — it does not gate

The ladder measures **size**, not knowledge. Minnow-to-whale is a wealth
metaphor, so gating the word "delta" behind it gets both directions wrong: an
options trader arriving at MINNOW is forced through a tutorial, and a lucky
player at SHARK is handed greeks they cannot read. Neither is a skill signal.

No venue people actually use does this — Deribit, TradingView and IBKR all let
the user pick display density directly. So:

```ts
export type CardDetail = "SIMPLE" | "STANDARD" | "FULL";

/** Rank picks the opening default. The player may change it at any time, in
 *  either direction, and the choice persists. Nothing here is ever locked. */
export function defaultDetail(tier: RankTier): CardDetail;
//   MINNOW, FISH  → SIMPLE
//   SHARK         → STANDARD
//   ORCA, WHALE   → FULL
```

The control is a visible three-way toggle, not a settings-menu checkbox. Most
players never touch it, so the defaults still walk them up the ramp — but a
Thetanuts reviewer can reach FULL in one tap instead of grinding XP, which
matters more in a pitch than the ramp does.

### E3. What each level shows

| Detail | Card face | Terms introduced |
|---|---|---|
| `SIMPLE` | direction, payout, **max loss** | — |
| `STANDARD` | + strike, "70% chance", ITM/OTM | strike, ITM/OTM |
| `FULL` | + payoff curve, breakeven, `Δ 0.70 · θ −0.4 · IV 58%` | delta, theta, IV, breakeven, premium |

Build mode (two cards on one asset → a spread) unlocks at `FULL` **and** stops at
two legs, because `calculatePayout` stops at two legs and physical butterflies
are the zero address on chain.

### E4. Two rules that do not bend

1. **Never change the word for a number.** SIMPLE's "70% chance" *is* delta.
   STANDARD does not rename it; FULL only reveals it was always called delta. One
   term per quantity, forever. Two terms is two things to unlearn.
2. **Max loss is not a detail level.** It appears at SIMPLE and never leaves, at
   every level, above the upside figure. See §A7.

### E5. Say what people say

Use the words traders actually use out loud, not the textbook forms:

- **ITM / OTM / ATM** — never "moneyness". Almost nobody says it aloud.
- **IV** — never spelled out. On crypto options venues the abbreviation is the word.
- **delta, strike, premium, breakeven, theta** — already correct, keep verbatim.

---

## 7. Which assets are in — the gate

Thetanuts is an **altcoin options protocol**. The universe is not two assets, and
any spec that hardcodes `"ETH" | "BTC"` has mistaken one quote source for the
whole market.

There are three asset sets and they are not the same size:

| Set | Members | What it means |
|---|---|---|
| Price feeds (8) | ETH BTC SOL DOGE XRP BNB PAXG AVAX | Chainlink oracle exists |
| Market prices (7) | the above, minus PAXG | Spot is readable |
| MM pricing (2) | ETH BTC | Market makers stream two-sided quotes |

**MM pricing is not the gate.** It is a *quality* signal — assets that have it get
deep two-sided books at strikes nobody has a resting order on. Assets without it
still trade: the resting order book is a separate source, and AVAX is already on
the board today (bid-only, which is why it was the wrong default asset).

### 7.1 The gate is a runtime probe, not a list

Hardcoding the qualified set guarantees it goes stale — that is exactly the bug
that made AVAX the broken default. Compute it:

```ts
/**
 * An asset is playable this round if the live book can actually produce cards
 * for it. Four conditions, all necessary, checked against the snapshot:
 *
 *   1. spot is readable       — getMarketData().prices has it (excludes PAXG)
 *   2. resting orders exist   — at least MIN_ORDERS fillable orders
 *   3. greeks are present     — on at least MIN_GREEKED of them, because a row
 *                               with no delta cannot be bucketed into a tier
 *   4. depth is real          — summed availableAmount ≥ MIN_DEPTH_USDC
 *
 * Condition 4 is the one that is easy to skip and expensive to skip. A card
 * backed by $3 of resting depth previews fine, fills partially or not at all,
 * and turns a duel into a support ticket.
 */
export function qualifiedUnderlyings(snap: MarketSnapshot): readonly string[];

export const MIN_ORDERS = 6;        // enough for ≥1 card in ≥3 tiers
export const MIN_GREEKED = 4;       // below this the delta buckets are empty
export const MIN_DEPTH_USDC = 50;   // 25× MAX_FILL_USDC — a fill must not move it
```

Aliases collapse first: `ETH/USD` and `BTC/USD` are the same feed addresses as
`ETH` and `BTC` (FINDINGS §5.6). Deduplicate by address, not by key, or ETH
appears twice in the reel.

### 7.2 Grade what qualifies

Qualified assets are not equal, and the UI should say so rather than pretend:

| Grade | Test | What the player gets |
|---|---|---|
| **DEEP** | has MM pricing | all 8 cards usually dealt, tight spreads |
| **THIN** | orders + greeks, no MM pricing | 3–6 cards dealt, wider spreads, one side may be missing |

Render the grade on the lobby card and on the slice reveal. A THIN asset is a
harder round, not a broken one — that is legitimate difficulty, and it is the
kind of difficulty that teaches something true about liquidity.

### 7.3 Ship the probe as a script

```
bun run scripts/probe-assets.ts
```

Prints the table above against the live book: per asset, order count, greeked
count, summed depth, MM pricing yes/no, grade. Run it before every demo. Commit
the output alongside the README. It is the cheapest possible answer to "which
assets does this actually support" and it never goes stale, because it is a
measurement rather than a claim.

### 7.4 The card pool, once the gate is applied

```
~5–7 qualified underlyings × ~4 live expiries × ~12 strikes × {CALL, PUT}
                                    + CALL_SPREAD, PUT_SPREAD (2-leg, executable)
                                    + RANGER (deployed, 0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc)
```

Every instrument in that pool can actually be bought, which is the only property
that matters.

### 7.5 Do not add a brokerage SDK

Not moomoo/Futu, not IBKR, not Alpaca. The gate above is the correct way to widen
the universe; a brokerage is not.

- **Quotes-only**: Thetanuts has no market for NVDA or TSLA, so the card quotes a
  real price and fills nothing. Strictly worse than a mock, because it looks real.
- **Quotes-and-execution**: the product becomes a licensed brokerage frontend —
  off-chain, KYC'd, and no longer a Thetanuts integration. There is also no shared
  settlement clock or collateral, so `DuelEscrow` cannot attest a duel where one
  player holds a Base-settled option and the other holds a brokerage position.

The altcoins already in the book are the breadth. Go get them.

---

## 8. Order of work

| Phase | Ships | Reverts cleanly |
|---|---|---|
| A | cards priced off the live book | yes — `TIERS` restore |
| B | slice-based spin, `UNIVERSE` retired | yes |
| C | two-clock scoring, attestor rewrite | yes — tape path still present |
| D | multi-leg fill with degradation | yes — flag-gated |
| E | detail levels, defaulted by rank | yes — cosmetic |

A through C are the pitch. D is the proof. E is the product.

---

## 9. Definition of done

- [ ] `TIERS` no longer exists anywhere in the tree
- [ ] Every rendered multiplier traces to a live `ask` or to `calculatePayout`
- [ ] Every card face shows max loss, at every detail level, above the upside figure
- [ ] `MINNOW/FISH/SHARK/ORCA/WHALE` is the only rank ladder in the tree
- [ ] Detail level is a visible toggle, reversible in both directions, never locked
- [ ] One quantity, one term — a test greps the card components for "moneyness" and "implied volatility" and fails on either
- [ ] `test/determinism.test.ts` still passes, with market data injected not imported
- [ ] A card with no qualifying quote renders a dead slot, and a test asserts it
- [ ] `MAX_FILL_USDC` is checked against the leg sum, with a test that tries to step over it
- [ ] No `MaxUint256` approval anywhere; a test asserts it is never passed
- [ ] Partial-fill policy is on screen before the first signature
- [ ] `duelScore` is pure and driven off a frozen fixture in tests
- [ ] The attestor derives the verdict from its own snapshot, never from client input
- [ ] **No hardcoded `"ETH" | "BTC"` union survives anywhere in the tree**
- [ ] `qualifiedUnderlyings` is pure, fixture-driven, and enforces all four conditions
- [ ] Feed aliases are deduplicated by address — a test asserts ETH appears once
- [ ] `scripts/probe-assets.ts` runs against the live book and its output is committed
- [ ] A sector with no qualified members renders greyed with a reason, not hidden
- [ ] DEEP/THIN grade appears on the lobby card and the slice reveal
- [ ] One end-to-end fill on Base, under $2, with a Basescan link in the README
- [ ] **A second end-to-end fill on a non-ETH/BTC underlying**, same evidence

---

## 10. What to say in the room

The three claims that hold up under questioning from people who wrote the
contracts:

1. **The game does not set the odds.** The book does. The reel deals the arena,
   the player picks the position, and every number on a card traces to a resting
   order or to the protocol's own `calculatePayout`.
2. **Two clocks, both real.** The duel resolves in minutes on mark-to-market; the
   option settles at expiry on chain. The player keeps the position regardless of
   who took the pot. Nothing is simulated on either clock.
3. **We built for the book you have, not the book we wish you had.** Sectors are
   drawn over assets that clear a liquidity gate we can run in front of you, and
   only structures that are actually deployed on chain. Nothing is padded with a
   brokerage feed. When a sector has no book that day, the lobby says so.

The third one is the one that lands — and the probe script is what makes it a
demonstration rather than an assertion. Run
`bun run scripts/probe-assets.ts` in the room.

**Have an answer ready for the obvious follow-up.** Someone will ask why the
altcoin sectors deal fewer cards. The answer is that only ETH and BTC have MM
pricing, so everything else trades on resting orders alone — which is a fact
about their book, not a limitation of the game, and the DEEP/THIN grade already
shows it to players. If gamified flow thickens those books, that is the
integration paying for itself.
