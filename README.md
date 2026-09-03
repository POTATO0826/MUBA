# THETHADUEL — Battles

A draft-and-duel prototype for options parlays. Two players draft tickers from a
shared board, pick a direction and target move per leg, then a compressed price
tape decides who cashed more legs.

Ported from the Claude Design source `THETHADUEL Battles.dc.html` to TypeScript +
React on Bun. No Vite, no webpack — Bun bundles `src/index.html` directly.

## Running

```bash
bun install
bun dev          # http://localhost:3000, hot reload
bun test         # 28 tests
bun run typecheck
bun run build    # → dist/
```

## Layout

```
index.ts              Bun.serve entry — serves and bundles src/index.html
src/
  index.html          the only HTML; Bun walks its tags and bundles them
  client.tsx          createRoot, injects the MarketSource
  App.tsx             shell + screen switch
  theme.ts            palette and the style builders (pill, tag, wall, …)
  types.ts            domain types
  lib/sx.ts           CSS declaration string → React.CSSProperties, cached
  state/
    battle.ts         all screen state, the actions, and the autopilot
    selectors.ts      activeUniverse / myLegs / oppLegs / arena
  engine/
    tape.ts           seeded random walk, sparkline geometry, price formatting
    chart.ts          one sparkline's view data
    payoff.ts         expiry payoff for the ETH vol box + its chart geometry
    match.ts          leg settlement, tie-break, the coach's match read
  data/
    universe.ts       the 18 draftable assets
    fixtures.ts       static content (cases, wins, rooms, slip)
    market.ts         MarketSource interface + the mock implementation
  components/         DitherReveal, StarfieldButton, Sparkline, useTilt
  ui/                 Header, Footer, RoomsTable, CaseCards, AutoBanner
  views/              one file per screen
```

### Why style strings survive

The design computes its styles — a row's background depends on its index, a
leg's border on whether it won. `sx()` parses those declaration strings into
React style objects once and caches them, so the port reads next to the design
rather than forking from it. `src/lib/sx.ts` is the whole mechanism.

## Wiring Thetanuts in

Market data sits behind one interface, `MarketSource` in `src/data/market.ts`:

```ts
interface MarketSource {
  readonly id: string;
  underlyings(): readonly string[];
  pricing(underlying: string): readonly PricingRow[];
  orders(): readonly OrderRow[];
}
```

The app ships `mockMarketSource` (static fixtures, no network). To go live,
implement the same interface over `client.mmPricing.getPricingArray` and
`client.api.fetchOrders`, then change the one line in `src/client.tsx`:

```tsx
<App source={thetanutsMarketSource} />
```

No view changes. The footer reads `source.id`, so the provenance line updates
itself.

Two things the SDK forces (see `tnuts-test/FINDINGS.md`): the client needs an
ethers provider, so it has to run server-side — add routes to `index.ts` and
have the `MarketSource` fetch them. And `getPricingArray` is typed to `ETH | BTC`
only; every other asset returns `[]`, so `underlyings()` should stay explicit
rather than derived from the price feeds.

## Rewards hub

The Rewards screen is a redesign, not a port — the design had a plain grid.

- **Rank track** — season XP bar with the tier thresholds (MINNOW → WHALE)
  marked along it. Fixtures in `src/data/rewards.ts`.
- **Free crypto battles** — a case-opening reel (`components/Roulette.tsx`).
  A strip of crypto tiles flies past a centre pointer, decelerates on a quintic
  ease, and stops on one; `planSpin()` decides the landing before the animation
  starts. Claiming drafts the asset into your first slot and opens a 0.50 ETH
  draft (`actions.claimFreeBattle`).
- **Daily missions** — ASCII checkboxes, XP, streak multiplier.
- **Case library** — tag filters, odds (max ÷ cost), and tier locks. Each case
  carries an image-like ASCII picture rendered by `engine/asciiImage.ts`: a
  tiny rasterizer that supersamples shaded vector shapes (top-left light,
  sphere falloff on discs) into a `" .:-=+*#%@"` luminance ramp. The pictures
  are specs in `data/ascii.ts`, so a new case is a few shapes, not hand-typed
  art.

## What the tape actually does

Every ticker's price history is a seeded random walk keyed on
`symbol + salt` — deterministic, so the same window replays across re-renders and
the study screen and the fight screen can draw *different* windows on the *same*
tickers by using different salts. `TAPE_LEN` is 200 prints; tape speed decides
how many print per 120ms tick.

A leg wins when the move from the tape's open clears its target in the chosen
direction. Ties on leg count break on conviction — the total absolute move across
the legs that landed — and, failing that, to player one.

## Notes on the port

- `battles`, `filters`, `tips` and `results` were computed in the design's logic
  layer but bound to nothing in its template. They are not carried over.
- The design's tilt handler targets `[data-wall]` and its backdrop carries a
  transform transition, but no element was ever marked — the counter-parallax
  never fired. `src/ui/CaseCards.tsx` marks it; remove the attribute for the flat
  version.
- The lobby's room table pinned a 760px minimum width on its header row but not
  its body rows, so columns drifted apart once scrolled. `RoomsTable` applies it
  to both.
- Thetanuts is deliberately not wired up yet. `tnuts-test/` is untouched.
- The imported design source is kept in `.design/` for reference.
