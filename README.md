# THETADUEL — Battles

A 1v1 options-parlay duel. Take a seat on a lobby, let the lucky spin deal the
tickers you both play on, read the case, pick a parlay card, then duel it out on
a compressed price tape. Whoever lands more legs takes the pool, and the XP that
comes with it.

Ported from the Claude Design source `THETHADUEL Battles.dc.html` to TypeScript +
React on Bun. No Vite, no webpack — Bun bundles `src/index.html` directly.

## Running

```bash
bun install
bun dev          # http://localhost:3000, hot reload
bun test         # 329 tests across 12 files
bun run typecheck
bun run build    # → dist/
```

Everything runs on mock data. No wallet is needed and nothing is written to a
chain; the connect button is a toggle. The one live edge is the news wire, and
it wants no key, no account and no `.env` — four public RSS feeds, fetched
server-side. `THETADUEL_NEWS=off` ships a build on the seeded wire alone.

## The flow

```
battles → room → spin → study → parlay → duel → result → rank
```

| Screen | Route | What happens |
|---|---|---|
| Battles | `/battles` | The board: every open lobby as an animated card. Hover for the match details. **Create lobby** publishes yours. |
| Create | `/create` | The builder: a name, the sectors the reel deals from, the mode the duel settles under, how many legs, and the pool. Publish is gated on a book big enough for the legs. |
| Room | `/match/:id/room?seed=N` | Both seats taken. Both players ready up — readying locks your entry — and only then does the spin start. Leave, and the seat goes back. |
| Spin | `/match/:id?seed=N` | The reel deals one ticker per leg from the lobby's book. |
| Study | `/match/:id/study?seed=N` | The dealt charts beside a news terminal: a headline list over the filed story, the desk pinned at the top of the feed. Both players read the same thing. |
| Parlay | `/match/:id/parlay?seed=N` | Eight cards per ticker: four tiers × bullish/bearish. One pick per ticker; the combination is the parlay. The opponent's stays hidden. A timed mode runs a clock and locks the slip itself when it expires. |
| Duel | `/match/:id/duel?seed=N` | Both slips run through a fresh window of the tape. |
| Result | `/match/:id/result?seed=N` | Who took the pool, and a read of what each player chose. **Next → your rank** drops the rank moment in over the debrief. |

`/` is home, `/desk` is the options desk (the worked payoff diagram), and
`/ranks` is the ladder. The rank moment has no route of its own — it is the
result screen's second phase, so a result link still replays both.

## Determinism

A match is fully determined by `(lobby, seed)` — the tickers, the wire, the
opponent's card, the study window, the settlement tape — so a link replays
exactly what its sender saw.

```
lobby.sectors → bookForSectors() ─┐
lobby.legs    ────────────────────┼→ spinCase(book, legs, seed) → tickers + reel plans
seed          ────────────────────┘

lobby.mode → MODE_SALT   → studySalt / fightSalt → series() → the tape
          ├→ settleAt    → the print the duel settles on
          ├→ targetScale → every leg's target
          ├→ oddsBoost   → the slip's multiplier
          └→ pickSeconds → the parlay clock
```

`bookForSectors` filters `UNIVERSE` and never iterates the sector keys, so
`["MEME","TECH"]` and `["TECH","MEME"]` are the same book in the same order —
the spin depends on both. The pick clock is the one wall clock anywhere near a
duel, and it only decides *when* a slip locks, never what it locks: an unpicked
ticker keeps the deterministic EVEN/bullish preview it was already showing.

That is what makes a spin demoable, and it is the seam a VRF or commit-reveal
output slots into later: replace `newSeed()` and nothing downstream changes.

The live wire and the sound are presentation only. Nothing under `src/engine/`
and nothing in `src/state/match.ts` may reach for `data/news`, `data/wire` or
`/api/news` — `test/determinism.test.ts` scans those sources and fails the build
if one does, and locks the seeded functions' outputs beside it. A duel settles
the same whether the network is up, down or serving yesterday's headlines, and
whether the sound is on or muted.

## Lobbies

`src/data/lobbies.ts`. A lobby names its host, its sectors — which give it both
its book and its STOCKS / CRYPTO / MIXED label — its mode, how many legs, and
the prize pool. Each player puts up half.

- **Someone else's lobby** — *Accept match* is the second seat. The host is
  your opponent.
- **Yours** — *Publish lobby* puts it at the top of the board, waiting. After a
  moment a second seat fills (`MATCHMAKING_MS`), and the card offers *Start
  match · vs …*.

Both paths lead to the spin, because both mean the two seats are taken.

## Sectors

`src/data/sectors.ts`. The 18 assets carry 12 raw sectors; the host composes a
book from six groups over them.

| Group | Label | Tickers |
|---|---|---|
| SEMIS | SEMIS | NVDA, AMD |
| TECH | BIG TECH | AAPL, META, COIN |
| MACRO | OLD WORLD | TSLA, XOM, JPM, GLD |
| MAJORS | MAJORS | BTC, ETH, SOL |
| DEFI | DEFI | ARB, LINK, UNI, AAVE |
| MEME | MEME | DOGE, PEPE |

SEMIS + TECH + MACRO are the nine stocks and MAJORS + DEFI + MEME the nine
crypto, so the builder's three presets — ALL STOCKS, ALL CRYPTO, FULL BOARD —
are only the common combinations of the same six chips. `marketOf(sectors)`
derives the card's label from the assets' own market, so a hand-rolled book
cannot mislabel itself. `COIN` sits in BIG TECH rather than MAJORS because it
is a listed stock: with the L1s it would make a MAJORS-only lobby read MIXED.

The book is the union, in board order. Pick fewer names than legs and Publish
goes dark with the reason under it — MEME alone is two names, and a three-leg
duel needs three.

## Game modes

`src/data/modes.ts`. A mode never touches `series()`; every ticker still
generates the same 200-print walk. A mode picks how much of that walk is the
duel, and a shorter walk genuinely moves less (σ√n), so the window tightens for
free — no new parameter threaded through the tape.

| Mode | Window | Settles at | Targets | Payout | Pick clock |
|---|---|---|---|---|---|
| BLITZ | 15 min | print 56 | ×0.62 | ×1.35 | 20s |
| QUICK | 1 hour | print 110 | ×0.82 | ×1.15 | 45s |
| NORMAL | 24 hours | the whole tape | ×1 | ×1 | none |

Playback is fixed at three prints per 120ms tick, so the compression badge on
the duel — `TAPE ×402`, `×818`, `×10,800` — is simulated seconds over real ones,
derived from the two numbers beside it rather than typed in. A Blitz duel is
fifteen minutes of tape in 2.2 seconds.

**NORMAL is the old game exactly**: `MODE_SALT.NORMAL` is 0, both scales are 1,
and it settles on the full `TAPE_LEN`. The other two salts are far-apart primes
added to both match salts, so the same seed in a different mode is a genuinely
different draw and not a prefix of the same one.

The clock is the part that makes fifteen minutes *feel* short. A timed parlay
locks itself when it runs out, through the same patch the lock button uses —
expired and pressed are byte for byte the same transition.

## The spin

`src/engine/spin.ts` decides where the reel stops before the first frame;
`src/components/MatchSpin.tsx` only draws the plan it was handed.

- **The reel is the lobby's book** — the union of its sectors. A stocks lobby
  cannot deal DOGE.
- **One spin per leg**, filling slots under the reel. Both slips run on
  exactly these tickers — the reel is the one thing in the match neither
  player chose.
- **No duplicates.** A landing on a seated ticker is rejected and re-spun.
- **No re-roll, nothing to press.** The system spins once, for both players,
  holds on the locked board for a beat, and the case study opens on its own.
  `Skip ↦` only jumps the animation to its landing.

## The case study

`src/data/briefs.ts` writes the desk-and-coach exchange the terminal pins to the
top of its feed, and a news line per dealt ticker, each shaped by which way that
ticker's study window actually went so nothing on screen contradicts the chart
beside it. Drawn by the seed, so the same link shows the same room to both
players. The headlines under the desk come from the wire.

## The wire

`src/server/news.ts` is the live half: two public RSS feeds — Google News and
Yahoo Finance, queried per dealt ticker only — fetched **server-side** behind
`/api/news` and composed into one typed envelope. The route always answers 200.
A dead feed, a timeout, or an HTML error page served as `text/xml` is data, not
an exception; the client reads `ok` and keeps what it has. Queries are built out
of `meta(sym)`, so a new name in `universe.ts` gets live news for free and no
stale per-ticker table can be left behind.

Two players in one room must read the same feed in the same order, so the first
request for a `matchKey` **freezes** its envelope and every later request
replays it byte for byte until the TTL expires. Timestamps are formatted once,
server-side, in New York — a client-side clock would desync two time zones.

`src/data/wire.ts` is the offline half: four filed stories per dealt ticker,
drawn from an UP or a DOWN pool by the same rule the briefs use. It is built
synchronously in the state initialiser, so the first paint already carries a
full terminal — no spinner, no empty pane — and the live source only ever swaps
in over the top. Offline, rate-limited, or `THETADUEL_NEWS=off`, the seeded feed
simply stays up and the header chip keeps reading SEEDED instead of LIVE.

## The parlay cards

`src/engine/parlay.ts`. Each dealt ticker gets its own pick — a card that is a
tier and a stance — and the parlay is the combination:

| Tier | Implied hit | Multiplier | Line |
|---|---|---|---|
| SAFE | ~70% | ×1.2 | 0.35× the asset's base move |
| EVEN | ~50% | ×1.9 | the base move |
| SHARP | ~25% | ×3.6 | 1.8× |
| DEGEN | ~8% | ×11 | 3.2× |

Bullish puts that leg *over* its line, bearish *under*. The odds on the slip
are the product of the leg multipliers, times the mode's payout boost; the
chance is the product of the hit rates. Higher tiers pay more and land less
often, and the lock waits until every ticker has a pick.

The duel itself is decided by legs landed, tie broken on conviction — the
`settle()` in `src/engine/match.ts`. The parlay decides what the winner banks:
the entry stake at their slip's odds, in points. An all-SAFE win pays little; a
slip with DEGEN legs pays a lot. The opponent's picks are drawn from the same
seed and hidden until settlement.

Settlement is still one rule: `legState` decides a leg on `{sym, dir, t}`. A
tier only changes how far `t` sits from the asset's base target, and a mode only
scales `t` and the print the read is taken at.

## Rank & the ladder

`src/engine/rank.ts`. A duel pays XP by mode — 120 BLITZ, 80 QUICK, 50 NORMAL —
doubled for a sweep and paid at 40% for a loss, so a session always moves
forward. Five tiers (MINNOW, FISH, SHARK, ORCA, WHALE) at 0 / 500 / 1,500 /
3,000 / 6,000 XP, three divisions each. The rank moment counts the gain out
across every band it crosses on a single rAF clock: the whole sequence is a
pure function of one `elapsed`, so skipping it is assigning the final state and
reduced motion takes the same path on mount.

Copy-trade unlocks at SHARK. Followers copy the slip and the trader takes
`COPY_FEE` — 3.5%, one literal shared by the Result panel and the ladder's copy
column, so the two can never print different percentages.

`/ranks` is the ladder. Row A picks the metric — COPY HEAT, SECTOR × MODE, WIN
RATE, EARNINGS — and under SECTOR × MODE a second row of sector and mode chips
picks the pool: OR inside a group, AND across them, an empty group meaning all.
Nothing on the page is authored. Every figure is a reduction over the same
roster (`src/data/leaderboard.ts`), and each persona's numbers all read from one
seeded skill scalar, so a WHALE with a 41% win rate cannot exist. Your row sorts
into the table under the same rule as everyone else's.

## Sound

`src/lib/sound/`. Sixty-one events, every one of them synthesized in Web Audio
at call time — oscillators, noise bursts and envelopes. There is no sample pack
and nothing to download. The palette follows the lobby's mode, so a Blitz reel
ticks tighter and brighter than a Normal one.

Nothing is constructed at module scope: a context may only be born inside a real
user gesture. That is also what makes the module inert in tests — under
happy-dom there is no constructor, so there are no timers, no listeners, and
`sfx()` simply returns false.

`budget.ts` is why a case-opening reel does not become noise. It owns "may this
be heard" as arithmetic — per-event cooldowns, a hover-sweep detector, a floor
on the gap between reel ticks, twelve voices global and three per name, one
moment in flight — while the engine owns only "what does this sound like". A
compressor across the master bus is the backstop: density can never become
loudness. The header carries the mute toggle, and `prefers-reduced-motion`
defaults it off.

Three optional mp3s hook in: the ready room's looping track, and two one-shots
that stand in for the synth events on the board's battle button and on *Ready
up*. Drop them into `src/assets/` (its README names them) and they are served
from an allowlist; leave them out and the server answers 404, which the engine
already treats as silence. They are gitignored, so a licensed track never leaves
the machine that owns the licence.

## What is behind a hook

`src/state/ledger.ts` is the one place chain state will live: the points
balance, taking a seat, settling, and the season XP and streak that fall out of
the same history. It is in-memory today. Swapping it for contract reads and
writes means reimplementing `useLedger` and nothing else.

Points are the demo's unit. Entry maps onto them at 1 Ξ = 1,000 pts.

## Layout

```
index.ts              Bun.serve entry — bundles src/index.html, serves /api/news
                      and the optional /assets clips
src/
  index.html          the only HTML; Bun walks its tags and bundles them
  client.tsx          createRoot, injects the MarketSource and the NewsSource
  App.tsx             shell, the screen switch, URL sync
  theme.ts            palette and the style builders (pill, tag, wall, …)
  types.ts            domain types
  styles.css          the keyframes, and the one block that turns them all off
  lib/
    sx.ts             CSS declaration string → React.CSSProperties, cached
    route.ts          path ↔ (tab, lobby, seed)
    rss.ts            RSS/Atom parsing, no dependency
    hash.ts           string → seed
    sound/            the engine (the only file that touches AudioContext), the
                      61-event map, the voices, the anti-overload budget, hooks
  server/
    news.ts           the live wire: four feeds, one frozen snapshot per match
  state/
    match.ts          the board, one match, the tape clock, matchmaking, the
                      mode's derived salts / settle print / targets / odds
    matchSound.ts     the duel's soundtrack, edge-triggered off match state
    wire.ts           the study feed: seeded first, live second
    rank.ts           the rank moment's input, derived from the ledger
    ledger.ts         points, XP, streak, history — the chain seam
  engine/
    spin.ts           seeded reel: plan, deal, reject duplicates
    parlay.ts         tiers, cards, multiplier, conditions
    match.ts          leg settlement and the two-player verdict + coach reads
    rank.ts           the ladder maths and the rank moment's timeline
    tape.ts           seeded random walk, sparkline geometry, price formatting
    chart.ts          one sparkline's view data
    payoff.ts         expiry payoff for the ETH vol box + its chart geometry
  data/
    lobbies.ts        the board, opponents, a lobby's book
    sectors.ts        the six groups, the presets, market identity
    modes.ts          BLITZ / QUICK / NORMAL and their four knobs
    briefs.ts         the news lines and desk chatter, by seed
    wire.ts           the seeded terminal feed
    news.ts           the NewsSource seam: seeded and live
    universe.ts       the 18 assets on the board
    rewards.ts        season tiers, missions, the copy fee, the player
    leaderboard.ts    the ladder's personas, one seeded skill scalar each
    fixtures.ts       static content (payoffs, the desk slip)
    market.ts         MarketSource interface + the mock implementation
  assets/             optional operator-supplied mp3s, gitignored
  components/         MatchSpin, NewsWire, RankUpSequence, RankBadge, CardArt,
                      DitherReveal, StarfieldButton, Sparkline
  ui/                 Header, Footer, SoundToggle, LobbyCards, LadderRow
  views/              Lobby (home), Battles, CreateLobby, Room, Study,
                      ParlayPick, Live, Result, Ranking, Parlay (desk)
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
asset's reference price. Study and the duel use different salts derived from the
match seed and the lobby's mode, so the study charts and the tape you duel on
are different windows on the same tickers — read behaviour, not levels.
