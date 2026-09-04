# Plan 7 — the box builder: draw a prediction, buy a condor

**Repo:** `POTATO0826/MUBA` (THETADUEL)
**Replaces:** `src/views/SpotDiff.tsx` and `src/views/ParlayRfq.tsx` — both Live arena modes
**Depends on:** `plan6-real-parlay.md` — Phases A, C and D. Everything this file
needs from them is restated in §0, so it can be built without plan6 open.

**What this is.** The player drags a box on a price chart: a price band and an
expiry. The box is converted into a real four-strike option — a `CALL_CONDOR`,
which pays maximum when settlement lands inside the band and decays outside it.
The tighter the box, the cheaper the contract and the higher the multiple. Two
players draw against each other and the better position wins the pot.

**The one-line statement:**

> The box the player draws *is* the option. Its dimensions are the price, and the
> price comes from Thetanuts, not from us.

---

## Working agreement — read first

Two-person split. **You own plan 7. ZQ owns plan 6.** You are not blocked on him;
§0.4 gives you a stub so you can build the whole arena today against interfaces
that will not change.

### Files you own, and only these

| Yours | Theirs — do not edit |
|---|---|
| `src/views/BoxBuilder.tsx` (new) | `src/engine/parlay.ts` |
| `src/data/box.ts` (new) | `src/engine/spin.ts` |
| `src/data/condor.ts` (new) | `src/engine/score.ts` |
| `test/box.test.ts` (new) | `src/desk/fill.ts` |
| `src/views/SpotDiff.tsx` (delete) | `src/views/Parlay.tsx` |
| `src/views/ParlayRfq.tsx` (delete) | `src/data/rewards.ts` |
| `src/views/Hub.tsx` — the two `MODES` entries only | everything else in `Hub.tsx` |

If you need something in the right-hand column changed, message ZQ. Do not edit
it. Both of you editing `desk/fill.ts` is the merge conflict that costs a day.

### Things about this repo that are not obvious

- **There is no testnet.** Thetanuts is Base mainnet only (chainId 8453). Every
  rehearsal of a fill spends real money. `MAX_FILL_USDC` is $2.00 and is checked
  in code above the network, not in the UI. Never raise it to test something.
- **`test/determinism.test.ts` scans `src/engine/**`** and fails the build if any
  engine module imports live market data or the news wire. Your files live in
  `views/` and `data/`, so it does not bind you — but do not move box logic into
  `engine/` to tidy up.
- **`tnuts-test/FINDINGS.md` beats the published docs.** It records ten verified
  contradictions between the docs and the shipped SDK. Where they disagree,
  FINDINGS wins — it was measured against the live chain. Example: the docs say
  the MM fee adjustment caps at `3e-4`; the shipped code uses `4e-4` and live
  data agrees.
- **The repo pins SDK `0.3.0`.** The public `llms-full.txt` documents `0.2.5`.
  Check `node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts` before
  trusting any signature from the docs.
- **`previewFillOrder` is synchronous** and returns 10 fields. There is no
  loading state around a quote; awaiting it is theatre.
- **`ensureAllowance` returns `TransactionReceipt | null`, and `null` is the
  success case** — it means no approval was needed. Code that treats a falsy
  return as failure reports a phantom error on every fill after the first.

### Definition of done for the handoff

The arena renders, the box snaps, the quote resolves, both players lock, and a
real fill lands on Base — a `RANGER` off the book or a `CALL_CONDOR` off RFQ,
per §1. §9's checklist is the contract. You do not need plan 6
finished to get there — see §0.4.

---

## 0. What this needs from plan 6

Restated so this file stands alone. Plan 6 remains the source of truth if they
ever diverge.

**`TIER_BANDS`** (plan6 §A3) — a tier is a moneyness bracket expressed as
`|delta|`, not a constant. Used here to shade the strike axis.

```ts
export const TIER_BANDS: Record<Tier, readonly [number, number]> = {
  SAFE:  [0.65, 0.85],
  EVEN:  [0.45, 0.65],
  SHARP: [0.25, 0.45],
  DEGEN: [0.05, 0.25],
};
```

**`runParlayFill(legs, deps)`** (plan6 §D1) — previews everything first, checks
`MAX_FILL_USDC` against each leg *and* the sum, then fills sequentially. On
failure it keeps what landed and re-scores; it never unwinds. The policy is shown
to the player before the first signature. A condor bought as one instrument is a
single "leg" to this function.

**`duelScore(legs, marks)`** (plan6 §C1) — return on premium, marked to market:
`Σ (mark_now − mark_entry) × contracts ÷ Σ premium_paid`, both players scored off
one snapshot. Pure, no clock, no network.

**`spinSlice(book, qualified, seed)`** (plan6 §B2) — deals the arena, never the
odds. Here it deals **which underlying** the chart is drawn for. Ignore its
`strikeLo`/`strikeHi` fields; the box is the player's to draw.

**`qualifiedUnderlyings(snap)`** (plan6 §7.1) — which assets have a book worth
playing. See §2.1 for the extra restriction that applies here.

**Max loss is printed on every position, at every detail level, above the upside
figure, ungated** (plan6 §A7). Non-negotiable in this mode too.

### 0.1 These signatures are frozen

ZQ is writing them; you consume them. Import, never reimplement, never copy the
bodies into your files:

```ts
import { TIER_BANDS, type Tier }  from "../engine/parlay.ts";
import { duelScore }              from "../engine/score.ts";
import { spinSlice }              from "../engine/spin.ts";
import { runParlayFill }          from "../desk/fill.ts";
import { qualifiedUnderlyings }   from "../data/market.ts";
```

If one turns out to be the wrong shape for the box, that is a real finding worth
a message. The interface is negotiable; silently forking it is not.

### 0.2 What you own

```ts
/** What the player drew. Three numbers and a date. */
export interface Box {
  underlying: string;
  /** Inner zone — the band that pays maximum. Snapped to live strikes. */
  floor: string;          // = s2, 8dp decimal string
  ceiling: string;        // = s3
  /** Wing width, s2−s1 == s4−s3. Snapped. Auto-set by default (§4.2). */
  wing: string;
  /** Unix seconds. One of the live expiries — never a free-dragged value. */
  expiry: number;
}

/** The instrument the box becomes. */
export interface CondorSpec {
  product: "CALL_CONDOR";
  underlying: "ETH" | "BTC";
  /** [s1, s2, s3, s4] ascending, 8dp decimal strings. */
  strikes: readonly [string, string, string, string];
  expiry: number;
}

export function boxToCondor(b: Box): CondorSpec;
export function snapBox(raw: Box, ladder: StrikeLadder): Box;
export function isPlayable(b: Box, ladder: StrikeLadder): boolean;
```

### 0.3 The basket rule, which applies here too

A basket of long options pays the **sum** of its legs, never the product. Plan 6
splits this in two and you keep the split: `basketPayoff` is what reaches the
wallet; `degeneracyScore` is a game number that sizes the escrow stake and drives
styling, and is **never rendered next to a currency symbol**.

A condor is one instrument, so this rarely bites here — but if you ever let a
player hold two boxes, it does.

### 0.4 Build today — the stub

Do not wait on plan 6. Create `src/data/box-stub.ts` implementing the four
imports above against `test/fixtures/orders.json`, a frozen real Thetanuts
response already committed to the repo. Real strikes, real expiries, real greeks,
real asks, no network, no wallet.

```ts
// box-stub.ts — delete this file when plan 6 lands
export const TIER_BANDS = {
  SAFE: [0.65, 0.85], EVEN: [0.45, 0.65],
  SHARP: [0.25, 0.45], DEGEN: [0.05, 0.25],
} as const;

export async function runParlayFill(legs, _deps) {
  return { filled: legs.map((l, i) => ({ leg: l, status: "filled", tx: `0xstub${i}` })) };
}
```

Two rules while stubbed:

1. **Never let the stub reach a screen that claims a fill happened.** Gate it
   behind the same `features.trade` flag the real path uses
   (`THETADUEL_TRADE=on`), so a stub build renders the confirm screen and stops.
2. **Swap by deleting the file**, not by editing components. If removing
   `box-stub.ts` and changing import paths does not compile, the coupling is in
   the wrong place.

---

## 1. The instrument: `CALL_CONDOR` for RFQ, `RANGER` for the book

A four-strike zone `s1 < s2 < s3 < s4` pays maximum when settlement lands
between `s2` and `s3`, decaying linearly through the wings, zero outside `s1`/`s4`.
That is exactly the box — and it turns out to be built from **two** different
products depending which path fills it.

```
            ┌──────────────┐
           /                \
    ______/                  \______
    s1        s2        s3        s4
              └── your box ──┘
```

| Box handle | Strike |
|---|---|
| price floor | `s2` |
| price ceiling | `s3` |
| wing width | `s2 − s1` and `s4 − s3` (equal, enforced) |

**Struck: "do not use RANGER."** That was one venue too wide. The reasoning
still holds, but only for RFQ: `client.ranger` exposes only `payout`, `close`,
`split`, `transfer`, `reclaimCollateral`, `returnExcessCollateral` — **there is no
create method anywhere in the SDK**, and there is no `buildRangerRFQ` either, so a
`RANGER` cannot be minted through RFQ. **That says nothing about filling one a
maker already created.** Measured: retail fills a listed `RANGER` off the
OptionBook roughly **39 times a day**; `RANGER` is 9,766 of the OptionBook's
15,740 lifetime positions, and **zero condors have ever been listed there**
(`docs/plan7-measurements.md` §3, §5). The split is by venue, not by preference:

| path | instrument | why |
|---|---|---|
| OptionBook, listed (§3.1) | `RANGER` | the only zone product ever listed there |
| OptionFactory, RFQ (§3.2) | `CALL_CONDOR` | the only zone product that can be minted |

**The discriminator that matters more than either of those facts.**
`validateRanger` and `validateCondor` accept the identical strike arrays — a
four-strike order's shape proves nothing about which product it is. Resolve the
type from `rawApiData.implementation`, looked up in the chain-config's
implementation registry, **never from the strikes**. And carry `isRanger: true`
on every SDK payout call against a listed zone — `calculatePayoutAtPrice` and
`calculateMaxPayout` default an untyped four-strike order to a condor, and the
SDK will silently price a `RANGER` as a `CALL_CONDOR` if that flag is missing. See
`src/data/ranger.ts` for the shipped module; it is deliberately its own file
rather than a branch inside `condor.ts`, because the two must not be merge-able.

Validation helpers: `validateCondor` is a named export (not on `client.utils`),
for the RFQ/free-draw path. `validateRanger` is its listed-path counterpart, same
shape, same rule — run the matching one before every quote and every fill.

---

## 2. The chart

### 2.1 Underlyings

Two lists, and they are not the same:

- **RFQ path:** ~~`prepare_request_rfq`'s underlying enum is **`['ETH','BTC']`**.
  Nothing else can be RFQ'd.~~ **Corrected — that enum is the MCP tool's schema,
  not the SDK's.** The SDK's own `RFQUnderlying` is **eight** assets:
  `'ETH' | 'BTC' | 'SOL' | 'DOGE' | 'XRP' | 'BNB' | 'PAXG' | 'AVAX'`
  (`index.d.ts:3102`), and `buildCondorRFQ` resolves a price feed for ETH, BTC,
  SOL, XRP, BNB and AVAX — verified by construction
  (`docs/plan7-measurements.md` §5). Six assets can be RFQ'd, not two.
- **OptionBook path:** whatever `qualifiedUnderlyings` returns — but the listed
  `RANGER` ladder that actually matters for §3.1 exists on ETH and BTC only,
  measured directly rather than inferred from which Chainlink feeds exist
  (`docs/plan7-measurements.md` §3).

**Ship ETH and BTC on both paths anyway.** Not because the SDK stops you
elsewhere — it does not — but because ETH and BTC are the only two underlyings
with a listed zone ladder and MM pricing at all. Say that in the greyed-out copy
for the other RFQ-eligible assets: a liquidity choice, not an SDK restriction.
**SUI is not a Thetanuts asset — do not list it.**

### 2.2 The time axis is discrete, and short

Columns are real expiries, nothing else. From a frozen capture taken 4 Sep:

```
ETH    5 Sep · 6 Sep · 11 Sep · 18 Sep
BTC    5 Sep · 6 Sep · 11 Sep · 18 Sep · 25 Sep
```

Tomorrow, the day after, then weeklies. **There is no 2h or 4h option.** Do not
render eight evenly spaced daily columns — that promises tradeable dates which do
not exist. Draw the chart's time axis continuously if you like the look, but the
expiry selector snaps to live expiries only, and the box's right edge lands on
one of them.

### 2.3 The box has no meaningful left edge

Settlement is **terminal**. From the SDK docs on the zone-bound payoff: the buyer
gets maximum payout when *settlement lands inside the zone*. `getTWAP` and
`getTwapPeriod` exist, and the TWAP Consumer at `0xE909fb…` smooths the
settlement print against manipulation — it is **not** an average over the option's
life.

So price does **not** have to stay in the band. It has to land there at expiry.

- Say **"lands in your box at expiry"**, never "stays within your box".
- Label the box **"by Sep 12"**, never "Sep 10 – Sep 13".
- You may let the box drag horizontally for feel, but only the right edge is
  real, and the readout must say so.

### 2.4 The price axis snaps to live strikes

Strikes are not evenly spaced. Measured: ETH puts clustered at 2420/2440/2460/2480
and calls at 2550/2650/2900 — roughly $20 apart near spot, $100+ further out.
**That spacing was measured on vanilla puts and calls, not on listed zones.** A
listed `RANGER` zone's grid is far coarser — $50/$100 apart on ETH, $1,000 apart
on BTC, about three zones per (underlying, expiry) — because it is a maker's
listing, not the free strike lattice the RFQ path can pick from
(`docs/plan7-measurements.md` §3, §5).

- The box **snaps** to strikes that carry live orders. Build snapping in from the
  start; retrofitting it feels broken. On the free-draw/RFQ path that is the fine
  vanilla lattice above; on the listed path (§3.1) it is whichever `RANGER` zones
  exist for that column — usually one to three, sometimes none.
- There is a **minimum box height**, and it is tighter near spot than far from it.
  That is a real and rather elegant constraint: precision is available exactly
  where the market is liquid.
- Shade the strike axis by `TIER_BANDS` so the player can see where the market
  thinks the action is — **on the free-draw/RFQ path only.** A listed `RANGER`
  zone publishes no greeks at all (0 of 38 orders carried them, across 32 reads of
  the live book), so there is no delta to shade a listed box with. Do not attempt
  it; say so instead (§3.1).

### 2.5 The price history behind the grid

The chart shows real price history behind the strike grid, with the box drawn to
the right of it. Three things this requires.

**A "now" divider.** History sits left of it, the box sits right. The box is a
prediction about the future and must never be draggable back over data that has
already happened. Render the divider as a visible line, not an implied one.

**A price source, which the SDK does not provide.** Thetanuts gives you current
spot (`getMarketData().prices`) and a forward-only websocket
(`client.ws.subscribePrices`). **There are no candles anywhere in the SDK.** Pick
a source and note it in the PR:

| Option | Trade-off |
|---|---|
| Public exchange API (Binance, Coinbase) | Easiest, good granularity, adds a third-party dependency |
| Chainlink historical rounds on Base | Same oracle that settles the option — most defensible, more work, coarser |
| Spot polled forward from session start | No dependency, but the chart is empty on first load |

Chainlink is the honest choice if you have the time, because it is the feed that
decides whether the player won. A chart drawn from Binance while settlement reads
Chainlink can disagree at the margin, and that disagreement will eventually land
in a support message about a duel someone thinks they won.

**One shared y-axis.** The chart's price scale and the strike ladder must be the
same scale — if they are computed separately they will drift by a pixel and the
box will stop lining up with the strikes it is snapping to. Derive the ladder
first, then fit the chart to it. Not the other way around.

The history is context, not a control. It cannot be clicked, and nothing in the
position derives from it.



The box can be bought two ways. **Both are real; neither is a fallback for a
broken other one.**

| | OptionBook | RFQ (OptionFactory) |
|---|---|---|
| Speed | immediate fill | sealed-bid auction, then settle |
| Strikes | only what makers have listed | any strike, any expiry |
| Price | maker's ask | you name a max, MMs bid under it |
| Settlement | cash only | cash by default |
| SDK | `client.optionBook.fillOrder` | `client.optionFactory.requestForQuotation` |

~~The OptionBook lists vanilla, spread, butterfly, condor and iron condor, so a
condor can often be filled instantly with no auction at all.~~ **Struck — false.**
Measured across 32 reads of the live book, 20 minutes apart, plus the repo's own
frozen fixture from nine hours earlier: the OptionBook lists vanilla, spread,
butterfly and `RANGER`. It has **never** listed a condor of any kind — not one,
across its entire 15,740-position history. The four-strike zone product it
actually carries, and carries 9,766 times over, is `RANGER`
(`docs/plan7-measurements.md` §3).

### 3.1 Snap-to-listed is the default — target `RANGER`, not a listed condor

**Struck: the original claim was that a box landing on a listed condor fills
through the OptionBook, and that "the arena works on day one regardless of what
market makers do."** Measured, and confirmed rather than assumed: **zero listed
condors on Base, ever** — not one, across the OptionBook's entire
15,740-position lifetime, identical across 32 reads of the live book and the
repo's own frozen fixture from nine hours earlier. All 26 condors that exist on
Base were minted through RFQ (`docs/plan7-measurements.md` §3, §5). §3.1's
premise — a day-one fill path with no MM dependency — had nothing to snap to as
written, because the instrument it named was never listed.

**Ship this first, on the instrument that is actually listed.** When the drawn
box lands on a listed `RANGER` zone, fill it through the OptionBook. Instant, no
waiting, no MM dependency — that part of the original claim survives once the
product is corrected. `RANGER` is the book's real listed zone product: 9,766
positions, 62% of everything the OptionBook has ever traded, ~37 buyable offers
on ETH and BTC at any moment, $10,000 of depth per order, and a real quote from
`previewFillOrder` with no signer and no spend. See `src/data/ranger.ts` for the
shipped module.

**What this path can no longer promise, and the arena must say so rather than
paper over it:**

- **Two assets, not "whatever `qualifiedUnderlyings` returns."** The listed
  ladder exists on ETH and BTC only (§2.1).
- **About three zones per (asset, expiry), not "draw any box."** Ladder spacing
  is $50/$100 on ETH and $1,000 on BTC — a maker's listing, not a free lattice
  (§2.4).
- **No greeks on a listed zone.** 0 of 38 orders carried them, across every
  read. `TIER_BANDS` delta shading cannot be applied to a matched, listed box —
  there is no delta published to shade it with (§2.4).
- **Some columns have nothing to snap to at all.** On ETH's two nearest
  expiries the only listed zone does not contain spot. On the frozen capture,
  only **2 of 82 drawable bands** matched a listed zone, and **ETH matched
  none**. The UI must be able to say "nothing listed here — this box goes to
  auction" — and, per `src/data/ranger.ts`, now does. A box matching nothing
  listed is the *ordinary* outcome on most columns, not an error state.

Snap-to-listed still ships first and still has no MM dependency — both true
things about the original plan. What shrinks is its promised coverage: it is
the shallow end of the mode, not the whole mode. §3.2's free-draw/RFQ path is
what carries the rest (§10, §4 of `docs/plan7-measurements.md`).

### 3.2 Free-draw is the RFQ path

When the box does not match a listed structure, RFQ it. This is where the mode
gets genuinely special — any strike, any expiry, priced on demand.

`reservePrice` is a **limit price, per contract** — for a BUY it is the maximum
premium you will pay. So the player names their price:

- `calculateReservePrice` (named export) suggests a number from the IV surface.
- Bid low → better price, risk nobody takes it.
- Bid high → filled, worse price.

That is more control than a quote you passively receive, and it is a real
trading decision. Render it as **"Your max bid"** with a suggested default, never
as "Est. Quote".

### 3.3 RFQ gotchas that will cost you a day

- **`collateralAmount` is always 0** in RFQ params. Collateral is pulled at
  settlement, not creation. The `build*RFQ` helpers enforce it; hand-building the
  struct with a non-zero value reverts.
- **The ECDH keypair is the whole game.** `client.rfqKeys` defaults to filesystem
  storage on Node. **A browser app must pass `keyStorageProvider` explicitly** —
  plaintext localStorage is not used by default and must not be introduced. Lose
  the key and offers cannot be decrypted, ever.
- **`offerDeadlineMinutes` in the SDK example is 60 — struck, that reads as a
  minimum and it is not one.** Measured: it is also stale. Five of the SDK's own
  RFQ builders default the field to **6**, not 60; the 60 survives only in an
  older, less-used example where the field is required rather than defaulted.
  There is **no contract-enforced floor on the window at all** — the SDK
  validates only "in the future" and "before expiry", and windows as short as
  **8 seconds** have settled on chain (13 s on the deployment the SDK actually
  points at). The real floor is elsewhere: `getRevealWindow()` reads **60
  seconds** on the current factory, and `settleQuotation` waits out the offer
  deadline *and* the reveal window — so a duel calling `settleQuotation` inherits
  a ~2-minute floor no matter how short the auction is. **Plan 7 must call
  `settleQuotationEarly(quotationId, offerAmount, nonce, offeror)` instead**,
  which skips the reveal window by having the requester decrypt the sealed offer
  with their own ECDH key — the `keyStorageProvider` requirement above is what
  makes that possible, so treat it as load-bearing, not hygienic. Design number:
  a 30–60 second offer window, settled early on the first acceptable offer
  (`docs/plan7-measurements.md` §2). One more gotcha in the same arithmetic:
  `BigInt(now + minutes * 60)` throws `RangeError: Not an integer` unless
  `minutes × 60` is exactly integral (`1/60` throws; `0.7` happens not to) — derive
  the window from whole seconds, not a fraction of a minute.
- Physical multi-leg implementations are the **zero address**. Every RFQ entry
  point validates and throws `INVALID_PARAMS`. Cash settlement only.

---

## 4. The quote

### 4.1 Resolve after release, not during drag

Drag → release → quote resolves → popup → lock. One price call per box, not one
per pixel. This is also better UX: a number flickering under the cursor is
unreadable.

### 4.2 Wings

`CALL_CONDOR` needs four strikes and the wings must satisfy `s2 − s1 == s4 − s3`.
This section is the free-draw/RFQ path (§3.2); on the listed path (§3.1) the
wing is not the player's to set at all — a `RANGER` zone's wing is whatever the
maker listed, and the panel should show it as a fact, not a control.

Auto-set the wing width from the box height (a sensible default is one strike
increment, or ~25% of the zone width, snapped). **Hiding the handle is fine;
hiding the consequence is not** — wing width moves both the premium and the shape
of the decay, so it belongs in the parameters panel as a readable value even if
it is not draggable at first.

### 4.3 What the panel shows

| Field | Rule |
|---|---|
| Price band | `$2,600 – $2,750` — the inner zone |
| Expiry | **one** date, shown **once** |
| Your max bid | player-set, `calculateReservePrice` default |
| Max loss | = the premium, always. 100%. Above the upside figure. |
| Potential payout | derived, never stored — see §4.4 |

The mockup showed a box labelled Sep 10–13, an expiry chip on Sep 12, and
"Expires Sep 13". Pick one. One expiry, one number, shown once.

### 4.4 Reward from precision is real, not a rule

A tighter box is a cheaper contract, so the multiple is higher. **You do not
invent a payback rate.** Compute the payout multiple as
`max_payout ÷ premium_paid` and let it fall where the market puts it.

Difficulty shading (`SHARP`, etc.) is styling over that number, not an input to
it. Never let a difficulty label change a price.

---

## 5. Long only

Every box is a **buy**. No short legs, ever.

- A short leg means posting collateral and carrying unbounded downside. A
  beginner learning options through a naked short is a product failure, not a
  difficulty setting.
- Long-only makes **max loss = premium paid**, on every box, with no exceptions
  to check.

Note the collateral formula in the SDK — `Condor: (strike2 − strike1) × numContracts / 1e8`
— is the **seller's** obligation. It is not your player's. If you find yourself
reading it for a buy, something is wrong.

---

## 6. The duel

Same underlying, same budget, dealt by `spinSlice`. Both players draw blind on
the existing lock/reveal transport, unchanged from `SpotDiff`.

**On reveal, both boxes render on one chart** — yours outlined, theirs filled.
Overlap is visible as overlap. That is the best moment in the mode: two people
looked at the same market and drew different rectangles, and you can see exactly
where they disagreed.

Scoring is plan 6's two-clock model, unchanged: the duel resolves in minutes on Δ
mark of the filled position; the condor settles at its own expiry regardless of
who took the pot.

### 6.1 If a fill does not land

Under RFQ, a box may go unfilled — no MM bid above the reserve. Both players must
be filled for a duel to be fair. Rule: **if either side is unfilled at the window's
close, no verdict is signed.** `DuelEscrow`'s six-hour refund path then returns
both stakes, rake-free, with no signature from anyone. That mechanism already
exists; do not build a tiebreak.

---

## 7. Naming — the sentence that gets you caught

This screen replaces the **options chain and order ticket** — the strike table you
scroll and the form you fill. Say that.

Do **not** call the screen RFQ. RFQ is one of its two execution paths, not what it
is. And when the OptionBook path fills a box, no quote request is sent at all.

`src/views/Hub.tsx` currently ships the copy *"Build a multi-leg RFQ on one
asset"*, and the file being deleted is called `ParlayRfq.tsx`. Both go. Grep the
tree for `RFQ` and `rfq` before calling this done — route names and mode keys
count.

---

## 8. Order of work

| Step | Ships | Why this order |
|---|---|---|
| 1 | Chart + history + snapping box, no quote | Snapping is the hardest UI problem; find out early |
| 2 | `boxToCondor` + `validateCondor` + payoff preview | Pure, testable off the fixture |
| 3 | Snap-to-listed → `previewFillOrder` → real quote | Proves the whole path with no MM dependency |
| 4 | Lock, duel, reveal, both boxes on one chart | The mode is now playable |
| 5 | Free-draw → RFQ with player-set reserve | The special part, and the riskiest |
| 6 | Delete `SpotDiff.tsx`, `ParlayRfq.tsx`, fix `Hub.tsx` copy | Last, so nothing is orphaned mid-flight |

Steps 1–4 are a shippable mode on their own. **Do not start step 5 before §10 is
answered.**

---

## 9. Done

- [ ] `SpotDiff.tsx` and `ParlayRfq.tsx` are both deleted, not left dormant
- [ ] `edge`-based scoring has no remaining call sites
- [ ] Price history renders behind the grid, with a visible "now" divider
- [ ] The box cannot be dragged left of "now"
- [ ] Chart and strike ladder share one y-axis — ladder derived first, chart fitted to it
- [ ] The price source is named in the PR, and settlement-feed disagreement is acknowledged
- [ ] The box snaps to strikes that carry live orders — a test asserts an irregular ladder snaps irregularly
- [ ] Minimum box height is derived from the live ladder, not a constant
- [ ] Expiry is chosen from live expiries only; no free-dragged date can be submitted
- [ ] **One expiry, one number, shown once** — asserted in a UI test
- [ ] Copy says "lands in your box at expiry", never "stays within"
- [ ] `boxToCondor` output passes `validateCondor` for every reachable box that does **not** match a listed zone — property test; `zoneToRanger` output passes `validateRanger` for every box that does, with `isRanger: true` carried on every payout call against it
- [ ] Wing width is visible in the parameters panel even when not draggable
- [ ] Max loss equals the premium, shown above the upside figure, at every detail level
- [ ] Payout multiple is computed from premium — no invented rate, and a test greps for hardcoded multipliers
- [ ] Difficulty shading cannot change a price
- [ ] No code path can construct a short leg — a test asserts buy-side only
- [ ] Quote resolves on release, not during drag — one price call per box
- [ ] Prices shown come from `previewFillOrder` or a decrypted offer, never from mid
- [ ] `MAX_FILL_USDC` is checked before any signature
- [ ] `ensureAllowance` returning `null` is treated as success
- [ ] RFQ path passes `keyStorageProvider` explicitly — no plaintext localStorage anywhere
- [ ] RFQ params carry `collateralAmount = 0`
- [ ] Unfilled side ⇒ no verdict signed ⇒ escrow refund path
- [ ] Both boxes render on one chart at reveal
- [ ] The word "RFQ" appears nowhere in UI copy, `Hub.tsx` mode copy, or route names
- [ ] SUI appears nowhere
- [ ] One real `RANGER` filled on Base under $2 via the OptionBook (listed path, §3.1), Basescan link in the README
- [ ] One real `CALL_CONDOR` filled on Base under $2 via RFQ (free-draw path, §3.2), Basescan link in the README

---

## 10. Measure before step 5

**Answered — measured 2026-09-04, 18:42Z–19:00Z.** See `docs/plan7-measurements.md`
for the full method, raw numbers, and the FACT/INFERENCE split. All three
questions below are closed; **the recommendation was build step 5**, and §3.1
above has already been rewritten onto `RANGER` for the reason that document lays
out in its own §5. The three questions are kept below as originally asked,
because the reasoning that produced the answer matters as much as the answer
itself — each is followed by what closed it.

Three unknowns gate the RFQ path. All three are read-only or near-free, and none
of them block steps 1–4.

The official Thetanuts MCP server is the fastest way to answer them:

```json
{ "mcpServers": { "thetanuts": { "command": "npx", "args": ["-y", "@thetanuts-finance/mcp"] } } }
```

Add it in Claude Desktop or Claude Code (stdio servers do not work in claude.ai
web). Then:

1. **Do market makers answer RFQs, and how fast?**
   Compare `get_quotation_requested_events` against `get_quotation_settled_events`
   over recent blocks. The ratio is the response rate; timestamps give latency.
   Read-only, no wallet, no spend. **If nothing settles, the RFQ path is
   decoration — ship steps 1–4 and stop.**

   **Answered: yes.** 84.2% of 1,091 historical RFQs received an offer at a
   6-second median; on the 48 condor-family requests specifically, 89.6% at
   2–12 seconds, 26 settled. The abort condition in the previous paragraph is not
   met. The one open thread: RFQ traffic has been completely idle for 15 days —
   an absence of demand, not (as far as can be measured) of supply. Place one
   real RFQ before demoing step 5, to confirm the maker's listener is still
   armed today (`docs/plan7-measurements.md` §1, §4).

2. **What is the minimum `offerDeadlineMinutes`?**
   The SDK example uses 60. A duel needs single-digit minutes. `settleQuotationEarly`
   lets the requester accept the moment a good offer lands, so the practical wait
   is MM latency — but if the contract enforces a long floor before early settle
   is allowed, RFQ duels are not viable in their current shape.

   **Answered: there is no floor.** The SDK enforces none beyond "in the future,
   before expiry"; the shortest window ever accepted on chain is 8 seconds (13 s
   on the current factory), and `settleQuotationEarly` is in production use (20 of
   58 settlements on the current factory). The real floor sits elsewhere:
   `getRevealWindow()` reads 60 seconds, and `settleQuotation` waits out that
   window on top of the offer deadline — so plan 7 must call
   `settleQuotationEarly`, not `settleQuotation`, or every duel inherits a
   ~2-minute floor regardless of auction length (§3.3, `docs/plan7-measurements.md` §2).

3. **How many underlyings have listed condors on the OptionBook?**
   `fetch_orders` plus `filter_orders`, grouped by implementation. Decides whether
   §3.1's snap-to-listed default has enough coverage to carry the mode alone.

   **Answered: zero, on any underlying, ever.** Not one condor has been created
   through the OptionBook across its 15,740-position history, confirmed across 32
   live reads plus the repo's own frozen fixture. The listed zone product is
   `RANGER`, on ETH and BTC only, ~3 zones per (asset, expiry). §3.1's
   snap-to-listed default does not have enough coverage to carry the mode
   alone — it is rewritten onto `RANGER` above, and step 5 (RFQ) is what closes
   the gap (`docs/plan7-measurements.md` §3, §4).

Commit the output of all three next to this file. They are measurements, so they
do not go stale the way a claim does. **Done — see `docs/plan7-measurements.md`.**
