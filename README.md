# THETADUEL — Battles

A 1v1 options-parlay duel. Take a seat on a lobby, let the lucky spin deal the
tickers you both play on, read the case, pick a parlay card, then duel it out on
a compressed price tape. Whoever lands more legs takes the pool.

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
battles → room → spin → study → parlay → duel → result
```

| Screen | Route | What happens |
|---|---|---|
| Battles | `/battles` | The board: every open lobby as an animated card. Hover for the match details. **Create lobby** publishes yours. |
| Room | `/match/:id/room?seed=N` | Both seats taken. Both players ready up — readying locks your entry — and only then does the spin start. Leave, and the seat goes back. |
| Spin | `/match/:id?seed=N` | The reel deals one ticker per leg from the lobby's book. |
| Study | `/match/:id/study?seed=N` | The dealt charts, a news line per ticker, the desk talking. Both players read the same thing. |
| Parlay | `/match/:id/parlay?seed=N` | Eight cards: four tiers × bullish/bearish. Pick one; the opponent's stays hidden. |
| Duel | `/match/:id/duel?seed=N` | Both slips run through a fresh window of the tape. |
| Result | `/match/:id/result?seed=N` | Who took the pool, and a read of what each player chose. |

`/` is home and `/desk` is the options desk (the worked payoff diagram).

A match is fully determined by `(lobby, seed)` — the tickers, the wire, the
opponent's card, the study window, the settlement tape — so a link replays
exactly what its sender saw. That is what makes a spin demoable, and it is the
seam a VRF or commit-reveal output slots into later: replace `newSeed()` and
nothing downstream changes.

## Lobbies

`src/data/lobbies.ts`. A lobby names its host, its book (STOCKS / CRYPTO /
MIXED), how many legs, and the prize pool. Each player puts up half.

- **Someone else's lobby** — *Accept match* is the second seat. The host is
  your opponent.
- **Yours** — *Publish lobby* puts it at the top of the board, waiting. After a
  moment a second seat fills (`MATCHMAKING_MS`), and the card offers *Start
  match · vs …*.

Both paths lead to the spin, because both mean the two seats are taken.

## The spin

`src/engine/spin.ts` decides where the reel stops before the first frame;
`src/components/MatchSpin.tsx` only draws the plan it was handed.

- **The reel is the lobby's book.** A STOCKS lobby cannot deal DOGE.
- **One spin per leg**, filling slots under the reel. Both slips run on
  exactly these tickers — the reel is the one thing in the match neither
  player chose.
- **No duplicates.** A landing on a seated ticker is rejected and re-spun.
- **One free re-roll per match**, then the button is spent. `Skip ↦` jumps
  the animation to its landing.

## The case study

`src/data/briefs.ts`. One news line per dealt ticker, shaped by which way its
study window actually went so the wire never contradicts the chart beside it,
then a short desk-and-coach exchange. Drawn by the seed, so the same link
shows the same wire to both players.

## The parlay cards

`src/engine/parlay.ts`. A card is a tier and a stance, applied to every leg:

| Tier | Implied hit | Multiplier | Line |
|---|---|---|---|
| SAFE | ~70% | ×1.2 | 0.35× the asset's base move |
| EVEN | ~50% | ×1.9 | the base move |
| SHARP | ~25% | ×3.6 | 1.8× |
| DEGEN | ~8% | ×11 | 3.2× |

Bullish sets every leg *over* its line, bearish *under*. The odds on a card are
the product of the leg multipliers; the chance is the product of the hit
rates. Higher tiers pay more and land less often.

The duel itself is decided by legs landed, tie broken on conviction — the
untouched `settle()` in `src/engine/match.ts`. The parlay decides what the
winner banks: the entry stake at their card's odds, in points. A SAFE win pays
little; a DEGEN win pays a lot. The opponent's card is drawn from the same
seed and hidden until settlement.

Settlement is untouched: `legState` still decides a leg on `{sym, dir, t}`. A
tier only changes how far `t` sits from the asset's base target.

## What is behind a hook

`src/state/ledger.ts` is the one place chain state will live: the points
balance, taking a seat, settling. It is in-memory today. Swapping it for
contract reads and writes means reimplementing `useLedger` and nothing else.

Points are the demo's unit. Entry maps onto them at 1 Ξ = 1,000 pts.

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
    route.ts          path ↔ (tab, lobby, seed)
  state/
    match.ts          the board, one match, the tape clock, matchmaking
    ledger.ts         points balance — the chain seam
  engine/
    spin.ts           seeded reel: plan, deal, reject duplicates
    parlay.ts         tiers, cards, multiplier, conditions
    match.ts          leg settlement and the two-player verdict + coach reads
    tape.ts           seeded random walk, sparkline geometry, price formatting
    chart.ts          one sparkline's view data
    payoff.ts         expiry payoff for the ETH vol box + its chart geometry
  data/
    lobbies.ts        the board, opponents, books per market
    briefs.ts         the news wire and desk chatter, by seed
    universe.ts       the 18 assets on the board
    rewards.ts        season tiers, missions, the player
    fixtures.ts       static content (payoffs, the desk slip)
    market.ts         MarketSource interface + the mock implementation
  components/         MatchSpin, DitherReveal, StarfieldButton, Sparkline, useTilt
  ui/                 Header, Footer, LobbyCards, Season
  views/              Lobby (home), Battles, CreateLobby, Study, ParlayPick,
                      Live, Result, Parlay (desk)
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
asset's reference price. Study and the duel use different salts derived from
the match seed, so the study charts and the tape you duel on are different
windows on the same tickers — read behaviour, not levels.
