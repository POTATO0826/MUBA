# THETADUEL — Cases

A rewards prototype for options parlays. Open a case, spin its book for your
legs, tier each leg, study the charts, then hold the position through a
compressed price tape. Every leg has to close beyond its line for the case to
pay.

Ported from the Claude Design source `THETHADUEL Battles.dc.html` to TypeScript +
React on Bun. No Vite, no webpack — Bun bundles `src/index.html` directly.

## Running

```bash
bun install
bun dev          # http://localhost:3000, hot reload
bun test
bun run typecheck
bun run build    # → dist/
```

Everything runs on mock data. No wallet is needed and nothing is written to a
chain; the connect button is a toggle.

## The flow

```
cases → spin → parlay-build → study → tape → settled
```

| Screen | Route | What happens |
|---|---|---|
| Cases | `/` | The library grid. The landing surface. |
| Spin | `/case/:id?seed=N` | The reel deals one ticker per leg from the case's own book. |
| Parlay | `/case/:id/parlay?seed=N` | Tier each leg. The multiplier is the product. |
| Study | `/case/:id/study?seed=N` | Charts on a study window; the coach reads them. |
| Tape | `/case/:id/tape?seed=N` | The position runs through a fresh window. |
| Settled | `/case/:id/settled?seed=N` | What it paid, leg by leg, and why. |

`/home` is the lobby and `/desk` is the options desk (the worked payoff
diagram). Neither is part of a run.

The seed is in the URL on purpose. A run is fully determined by `(case, seed)` —
the legs, the study window, the settlement tape — so a link replays exactly
what its sender saw. That is what makes a spin demoable, and it is the seam a
VRF or commit-reveal output slots into later: replace `newSeed()` and nothing
downstream changes.

## The spin

`src/engine/spin.ts` decides where the reel stops before the first frame;
`src/components/CaseSpin.tsx` only draws the plan it was handed.

- **The reel is the case's book, not the whole board.** Each `CaseDef` carries
  `eligibleAssets`. Weekly Grind lists the quiet end of the board and cannot
  deal PEPE. The list lives on the case, so the spin component knows nothing
  about which names are allowed.
- **One spin per leg.** A four-leg case spins four times and the slots under
  the reel fill one at a time, so the position is visibly built.
- **No duplicates.** A landing on a ticker already in a slot is rejected and
  the reel is spun again. Rejections consume the seeded stream, so they are
  replayable too.
- **One free re-roll per open**, tracked in state. After that the button is
  disabled with a tooltip. `Skip ↦` jumps the animation to its landing.

## The parlay

`src/engine/parlay.ts`. Four tiers per leg:

| Tier | Implied hit | Multiplier | Target |
|---|---|---|---|
| SAFE | ~70% | ×1.2 | 0.35× the asset's base move |
| EVEN | ~50% | ×1.9 | the base move |
| SHARP | ~25% | ×3.6 | 1.8× |
| DEGEN | ~8% | ×11 | 3.2× |

The parlay multiplier is the product of the leg multipliers and nothing else.
The implied probability is the product of the hit rates. Points awarded are
`stake × multiplier` when every leg lands, and zero otherwise.

Settlement is untouched: `legState` in `src/engine/match.ts` still decides a leg
on `{sym, dir, t}`. A tier only changes how far `t` sits from the asset's base
target, which keeps the whole tier system inside the leg shape the tape already
settles.

Two rules the builder states in words, not just numbers:

- **All legs must hit.** One miss pays zero. The bar says so.
- **The case's own ODDS is the floor.** A parlay can only raise the multiplier
  and lower the probability from the base case. Under the floor, the case pays
  its own odds.

When the implied probability drops under 10% the summary turns the HIGH VAR
violet and pulses. The risk is made loud, not hidden.

`PARTIAL_CREDIT` in `engine/parlay.ts` is the flag for N-1 refunds. Off.

## What is behind a hook

`src/state/ledger.ts` is the one place chain state will live: the points
balance, opening a position, settling it. It is in-memory today. Swapping it
for contract reads and writes means reimplementing `useLedger` and nothing
else — no view knows where the balance comes from.

Points are the demo's unit. A case's ETH open cost maps onto them at
1 Ξ = 1,000 pts, so a 0.41 Ξ case stakes 410.

## Layout

```
index.ts              Bun.serve entry — serves and bundles src/index.html
src/
  index.html          the only HTML; Bun walks its tags and bundles them
  client.tsx          createRoot, injects the MarketSource
  App.tsx             shell, the screen switch, URL sync
  theme.ts            palette and the style builders (pill, tag, wall, …)
  types.ts            domain types
  lib/
    sx.ts             CSS declaration string → React.CSSProperties, cached
    route.ts          path ↔ (tab, case, seed)
  state/
    caseRun.ts        one run: case, seed, tiers, the tape clock
    ledger.ts         points balance — the chain seam
  engine/
    spin.ts           seeded reel: plan, deal, reject duplicates
    parlay.ts         tiers, multiplier, floor, settlement, the coach read
    tape.ts           seeded random walk, sparkline geometry, price formatting
    chart.ts          one sparkline's view data
    payoff.ts         expiry payoff for the ETH vol box + its chart geometry
    match.ts          leg settlement (legState) — the primitive the tape uses
  data/
    cases.ts          the case library, each with its own book
    universe.ts       the 18 assets on the board
    rewards.ts        season tiers, missions, the player
    fixtures.ts       static content (payoffs, the desk slip)
    market.ts         MarketSource interface + the mock implementation
  components/         CaseSpin, DitherReveal, StarfieldButton, Sparkline, useTilt
  ui/                 Header, Footer, CaseCards
  views/              Cases, Lobby, ParlayBuilder, Study, Tape, Settled, Parlay (desk)
```

### Why style strings survive

The design computes its styles — a row's background depends on its index, a
leg's border on whether it won. `sx()` parses those declaration strings into
React style objects once and caches them, so the port reads next to the design
rather than forking from it. `src/lib/sx.ts` is the whole mechanism.

## Wiring Thetanuts in

Market data sits behind one interface, `MarketSource` in `src/data/market.ts`.
The app ships `mockMarketSource` (static fixtures, no network). To go live,
implement the same interface over `client.mmPricing.getPricingArray` and
`client.api.fetchOrders`, then change the one line in `src/client.tsx`. No
view changes; the footer reads `source.id`.

## What the tape actually does

`series(sym, salt)` in `src/engine/tape.ts` is a seeded random walk from the
asset's reference price. Study and settlement use different salts derived from
the run's seed, so the study charts and the tape you hold through are
different windows on the same tickers — read behaviour, not levels.
