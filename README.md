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
bun test         # full unit and UI suite
bun run typecheck
bun run build    # → dist/
```

**Out of the box nothing is written to a chain.** The seeded game — the board,
the tape, the duel, the PTS ledger — needs no wallet, no key and no `.env`, and a
mock wallet stands in for a real one. Two live edges are on by default and want
nothing from you: the news wire (four public RSS feeds, fetched server-side;
`THETADUEL_NEWS=off` for the seeded wire alone) and the Thetanuts market read
(`THETADUEL_MARKET` to opt out). **Everything that can spend money is opt-IN and
off** — `THETADUEL_TRADE=on` for the real fill, `THETADUEL_STAKE=on` plus a
deployed escrow for the side bet. See *Thetanuts — what is actually live* for
what each flag reaches and, just as importantly, what has never run.

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

## Live arena

The **Live arena** header tab keeps the newer invite-based PvP flow alongside
the seeded match flow above. It uses the same wallet and live Thetanuts market
source, but offers two shorter modes:

- **Parlay · RFQ** — choose up to four strikes on one underlying; the captured
  volatility edge decides the round.
- **Find a difference** — pick the largest hidden volatility outlier in the
  live order book.

`/arena` opens the mode hub. Creating a duel stores an in-memory room and
produces a `/room/:id` invite. The challenger claims the second seat, both
players ready up, and their picks remain hidden until both have locked. Room
state is intentionally process-local: restarting the Bun server expires every
invite. The room transport currently trusts the posted wallet address, so the
flow is suitable for a prototype but must add signed nonces before its USDC
labels become real custody.

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

`bookForSectors` filters the board and never iterates the sector keys, so
`["MEME","MAJORS"]` and `["MAJORS","MEME"]` are the same book in the same order —
the spin depends on both. The pick clock is the one wall clock anywhere near a
duel, and it only decides *when* a slip locks, never what it locks: an unpicked
ticker keeps the deterministic EVEN/bullish preview it was already showing.

That is what makes a spin demoable, and it is the seam a VRF or commit-reveal
output slots into later: replace `newSeed()` and nothing downstream changes.

The live wire and the sound are presentation only. Nothing under `src/engine/`
and nothing in `src/state/match.ts` may reach for `data/news`, `data/wire`,
`/api/news`, a live market source or `data/qualify` — `test/determinism.test.ts`
scans those sources and fails the build if one does, and locks the seeded
functions' outputs beside it. A duel settles the same whether the network is up,
down or serving yesterday's headlines, and whether the sound is on or muted.

**Plan 6 moved that seam; it did not open it.** Market data reaches the engine as
an *injected argument* and never as an import: `spinSlice(book, qualified, seed)`
takes the book and the qualified asset list from its caller, and
`cardsForSlice(rows, slice, deps)` takes the protocol's own `calculatePayout`
the same way. The engine may not decide which assets exist — that is a fact about
the book, and a reel that computes its own universe is one refactor from a reel
that computes its own prices, with no test between here and there. The property
the tests assert is the whole design in one line: **same seed + same book ⇒ same
slice; same seed + different book ⇒ same slice shape, different prices.**

Note the scanner is a raw text match with no comment stripping, so a docblock in
an engine module that *names* `src/server/thetanuts.ts` trips it exactly as an
import would. That is a false positive worth knowing about before you go hunting
for a dependency that is not there.

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

`src/data/sectors.ts`. The host composes a book from named groups over the
assets, and the book is the union of the picked groups, in board order.

> **⚠ Mid-refactor as of 2026-09-05 — this section is the one place in the file
> that is deliberately not pinned to a table.** Plan 6 §B3 retires the invented
> equity universe: nine stocks with hand-written SEMIS / BIG TECH / OLD WORLD
> sectors, on a protocol that has never had a market in any of them. **Sectors
> themselves stay** — they were the right idea over the wrong list. The target
> is four groups drawn over assets that clear the liquidity gate: `MAJORS`
> (ETH, BTC), `L1S` (SOL, BNB, AVAX), `MEME` (DOGE), `PAYMENTS` (XRP). Retired
> keys are kept as tombstones rather than deleted, so a stored lobby naming one
> resolves instead of throwing. Read `src/data/sectors.ts` for what is actually
> in `SECTOR_ORDER` today; do not trust a table here until this note is gone.

Two properties hold across the refactor and are asserted:

- `bookForSectors` **filters, never iterates the sector keys**, so `["MEME","L1S"]`
  and `["L1S","MEME"]` are the same book in the same order. The spin depends on
  both, so this is a determinism invariant and not a tidiness one.
- **A group with no qualified members is greyed with its reason — `no live book
  today` — never hidden.** A host who picks MEME and gets an empty lobby learns
  nothing; a host who sees MEME greyed learns the shape of the market they were
  about to trade in. Grades ride alongside: DEEP means market makers quote both
  sides, THIN means resting orders only — a harder round, not a broken one.

`marketOf(sectors)` derives the card's label from the assets' own market, so a
hand-rolled book cannot mislabel itself. Pick fewer names than legs and Publish
goes dark with the reason under it.

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
- **Live spot annotates, never replaces.** Where Thetanuts publishes a price
  for a dealt name, the reel tile and the pointer readout add a green
  `· live` line beside the seeded print under the `LIVE SPOT · SEEDED TAPE`
  chip (`src/data/spot.ts`). The tape still settles on the seeded numbers —
  the annotation is honesty, not input.

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

The wire filters by ticker: click a case card or any row's sym chip and only
that asset's stories remain (a `FILTER · SOL ×` chip appears in the header;
clicking the active handle again — or the × — restores the full wire). One
piece of state in `Study.tsx` drives all three handles, the filtering is
display-only, and the arrival tick still keys on the real feed, so narrowing
the view never sounds like news arriving.

## The parlay cards

`src/engine/parlay.ts`. Each dealt ticker gets its own pick — a card that is a
tier and a stance — and the parlay is the combination.

**A tier is not a constant any more.** It used to be: a `TIERS` table stated a
multiplier and a hit rate per tier, and nothing anywhere had to make either
true. `TIERS` is deleted. What replaces it is `TIER_BANDS` — four half-open
`|delta|` brackets — plus one derivation rule, `1 / probability`, so nothing
sets a payout by hand:

| Tier | Delta band | Fair odds | Line (seeded tape) |
|---|---|---|---|
| SAFE | 0.65 – 0.85 | ×1.33 | 0.35× the asset's base move |
| EVEN | 0.45 – 0.65 | ×1.82 | the base move |
| SHARP | 0.25 – 0.45 | ×2.86 | 1.8× |
| DEGEN | 0.05 – 0.25 | ×6.67 | 3.2× |

Delta is the desk's approximation of the risk-neutral chance an option finishes
in the money, so it is both the game's "chance to land" and the trader's greek —
one quantity, one word, which is why the card never needs two. The bands tile
without overlap and both ends are excluded on purpose: below 0.05 the spread is
wider than the premium, above 0.85 you are paying intrinsic value. **Fair odds
are the reciprocal of the band midpoint** — no house edge and no invented
ladder; the old table's `SHARP ×3.6 at 25%` was a 44% overround dressed as
generosity. The *lines* in the last column are tape geometry, not odds: the
seeded walk needs a distance and delta does not supply one without a volatility
model.

Bullish puts that leg *over* its line, bearish *under*. The lock waits until
every ticker has a pick.

The slip's two numbers are now separated, because the old one conflated them.
`degeneracyScore` is the product of `1 / prob` across the legs — a **game**
figure that sizes the escrow stake and drives the loud-card styling, never
rendered beside a currency symbol. `basketPayoff` is what a basket of real
options actually pays: the **sum** of the leg payoffs minus the total premium,
which is the number that reaches a wallet. Multiplying leg multipliers and
calling the product a payout is arithmetically false — three legs at ×3 is ×27
as a product and ×3 as a basket — so the parlay drama moved to where it is true.
All-or-nothing now describes who takes the escrow pot, which genuinely is.

Every card face carries **max loss** above the upside figure, unconditionally: a
bought option's downside is the premium and nothing more, and that is the single
most valuable habit this product can build. It is also the honest reason DEGEN
is survivable — it is cheap, so the bounded loss is small.

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

`/ranks` is the ladder. Row A picks the metric — COPY HEAT, GAIN 12M, SECTOR ×
MODE, WIN RATE, EARNINGS — and under SECTOR × MODE a second row of sector and
mode chips picks the pool: OR inside a group, AND across them, an empty group
meaning all. Nothing on the page is authored. Every figure is a reduction over
the same roster (`src/data/leaderboard.ts`), and each persona's numbers all
read from one seeded skill scalar, so a WHALE with a 41% win rate cannot exist.
Your row sorts into the table under the same rule as everyone else's.

The copy-trade surface speaks the vocabulary of a copy-trading app: a GAIN 12M
headline, a RISK 1–10 chip, 30-day copier deltas that agree with the sparkline
by construction, copy capital, profitable months, and a COPY button that says
out loud it moves nothing. Its dollars are the fiction's own currency, derived
fresh from the same pinned persona fields — no PTS→$ rate exists anywhere, and
XP stays XP on every rank line. Every player renders as a `PlayerMark`
(`src/components/PlayerMark.tsx`): a 5×5 mirrored pixel glyph hashed from the
name, so each trader carries a unique deterministic emblem instead of initials
on a colour chip; the Room's seat cards read the same roster into a dossier —
rank, career P/L, record, form, copiers — beside each player's mark.

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

Optional mp3s hook in — the ready room's looping track, the parlay pick
screen's bed (the hero-pick moment; `src/assets/parlay-pick.mp3`), the four
EX.O clips, and the case-open tick and landing slices the reel plays (the
landing is the recording alone; the reveal arpeggio was cut so one settle is
one transient). Drop them into `src/assets/` (its README names them) and they
are served from an allowlist; leave them out and the server answers 404, which
the engine already treats as silence. They are gitignored, so a licensed track
never leaves the machine that owns the licence.

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
  state/
    match.ts          the board, one match, the tape clock, matchmaking, the
                      mode's derived salts / settle print / targets / odds
    matchSound.ts     the duel's soundtrack, edge-triggered off match state
    wire.ts           the study feed: seeded first, live second
    rank.ts           the rank moment's input, derived from the ledger
    ledger.ts         points, XP, streak, history — the chain seam
  engine/
    spin.ts           seeded reel: plan, deal, reject duplicates; and
                      spinSlice — the market slice, off an injected book
    parlay.ts         TIER_BANDS, the seeded leg, cardsForSlice / multipleAt /
                      basketPayoff — the live cards, off an injected book
    score.ts          duelScore: Σ Δmark × contracts ÷ Σ premium. Pure
    match.ts          leg settlement and the two-player verdict + coach reads
    rank.ts           the ladder maths and the rank moment's timeline
    tape.ts           seeded random walk, sparkline geometry, price formatting
    chart.ts          one sparkline's view data
  desk/
    payoff.ts         expiry payoff for the ETH vol box + its chart geometry
    optionize.ts      a seeded card re-denominated against a real listed quote
    fill.ts           the real fillOrder: the $2 code cap, the ladder, and
                      runParlayFill — N sequential legs with declared degradation
    rfq.ts            the patient sealed-bid auction. Out of the duel loop
    escrow.ts         the DuelEscrow client: stake, lock, claim, refund
  data/
    lobbies.ts        the board, opponents, a lobby's book
    sectors.ts        the groups, the presets, market identity, the greyed reason
    qualify.ts        the asset gate: four conditions, DEEP/THIN, pure
    modes.ts          BLITZ / QUICK / NORMAL and their four knobs
    briefs.ts         the news lines and desk chatter, by seed
    wire.ts           the seeded terminal feed
    news.ts           the NewsSource seam: seeded and live
    universe.ts       the seeded board's assets (mid-retirement — see Sectors)
    spot.ts           live spot annotations + the book-delta advisory
    rewards.ts        the MINNOW→WHALE rank ladder, missions, copy fee, player
    leaderboard.ts    the ladder's personas, one seeded skill scalar each
    fixtures.ts       static content (payoffs, the desk slip)
    market.ts         MarketSource interface + the mock implementation
  server/
    news.ts           the live wire: four feeds, one frozen snapshot per match
    thetanuts.ts      /api/market: the live book, MM pricing, greeks, stale-on-fail
    attest.ts         /api/lock + /api/attest: the referee, one frozen snapshot
    seats.ts          reads a duel's seats out of the escrow's own storage
    rooms.ts          the Live arena's process-local invite rooms
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

## Thetanuts — what is actually live

Market data sits behind one interface, `MarketSource` in `src/data/market.ts`;
the app still ships `mockMarketSource` and every live feature degrades to it.

### What the product is, today

Four sentences, and each one is checkable in the tree:

1. **A parlay card is priced off the live book by delta band.** A tier is a
   `|delta|` bracket queried against resting orders, not a constant. A card
   exists only when an order backs it — `cardsForSlice` filters to rows with a
   delta *and* a fillable `order`, takes the lowest ask among survivors, and
   returns `null` when nothing in the book falls in that band. A missing DEGEN
   BULLISH is a true statement about the market.
2. **Two clocks, measuring different things.** The duel resolves in minutes on
   mark-to-market — `duelScore` is `Σ (mark_now − mark_entry) × contracts ÷
   Σ premium`, return on premium so a duel is not a size contest — and pays the
   escrow pot. The option itself settles at expiry on chain and pays whoever
   holds it, regardless of who took the pot. Neither clock simulates the other.
3. **The asset gate is a runtime probe, not a list.** `qualifiedUnderlyings`
   measures four conditions against a snapshot — readable spot, ≥6 fillable
   resting orders, ≥4 of them carrying a usable delta, ≥$50 of summed depth —
   and grades what passes DEEP (market makers quote both sides) or THIN (resting
   orders only). `bun run scripts/probe-assets.ts` runs the same gate and prints
   the table; the output is committed at `docs/asset-gate.md`, because a
   measurement anyone can re-run beats a claim.
4. **Staking and the real fill are opt-in and unproven on chain.** See the two
   warnings below.

### The surfaces, and what each one actually reaches

| Surface | State | Behind |
|---|---|---|
| `/api/market` — Base order book + MM pricing + greeks | CODE LIVE, **book route currently 404** — see the outage below. `/api/market` answers from its last good snapshot and labels itself `stale` | `THETADUEL_MARKET` opt-out |
| `/desk` book, MM chain, payoff spot label, $1 previews | LIVE, on whatever the market route last held | same |
| Board spot annotations (`seeded · live`) + book-delta advisory | LIVE where Thetanuts prices it; every other name renders exactly the seeded app | same |
| Asset gate (`src/data/qualify.ts`) + `scripts/probe-assets.ts` | PURE and fixture-tested; the committed **live** run says `BOOK UNREACHABLE` and exits 1, the committed **table** is the frozen capture. Not yet wired into the lobby — `CreateLobby` accepts a qualified list and nothing passes one | — |
| Parlay fill — N sequential vanilla fills, one tx per leg, $2 cap on the leg **and** the slip sum | CODE COMPLETE, **never executed on Base**. Preview-all-first, exact approvals, stale legs dropped before the first signature, keep-what-landed on a failure, and the policy on screen before you sign | `THETADUEL_TRADE=on` opt-IN, default off |
| Duel escrow (`contracts/DuelEscrow.sol`) | compiled + adversarially reviewed (`docs/reviews/`), **NOT deployed** | owner |
| Attest referee (`/api/lock` + `/api/attest`) | live code; the lock takes seat `a`'s EIP-191 signature **and** checks both seats against the escrow's own storage (`src/server/seats.ts`); the verdict is re-derived from committed picks and one snapshot the server reads itself, frozen onto the lock so a re-attest cannot re-roll it | `ATTESTOR_PRIVATE_KEY` |
| USDC staking UI — the side bet, its six states, the claim | BUILT (`src/state/stake.ts`, `src/desk/escrow.ts`); inert until an escrow is deployed, and never on the mock wallet | `THETADUEL_STAKE=on` opt-IN + `THETADUEL_ESCROW` |
| Card detail levels (SIMPLE / STANDARD / FULL) | LIVE on the pick screen. Rank picks the opening default and **never gates** — the toggle is a visible three-way switch, reversible in both directions, and the choice persists | — |
| The seeded board, tape, duel and PTS ledger | SEEDED, permanently and by design — settlement never reads a live number | — |

### ⚠ Not true yet — say it out loud before anyone asks

- **No fill has ever executed on Base from this repo.** Not one, not for a cent.
  Every path up to the RPC boundary is tested against injected fakes; the money
  half is unproven. There is no Basescan link in this file for the same reason:
  there is nothing to link to. The same goes for the escrow — compiled,
  reviewed, and never deployed.
- **~~The live book endpoint is 404ing.~~ RETRACTED — the book is healthy.**
  `fetchOrders()` never requests `indexerApiUrl`; it issues a relative `get("/")`
  against the axios instance built on `apiBaseUrl`, a Cloudflare Worker origin
  that has been serving ~382 greeked orders throughout. `indexerApiUrl` is a path
  *prefix* every other SDK caller appends a subpath to, so requesting it bare
  404s by design and always did. A real transport failure (local TLS
  interception, since cleared) printed the wrong field in the probe's error
  banner; someone curled that URL, got the expected 404, and two unrelated facts
  fused into "the venue moved its book". Live probe now: ETH $1.18M and BTC
  $1.41M depth (DEEP), SOL/XRP/BNB/AVAX qualified (THIN) — six underlyings. Do
  NOT ask the protocol team about this. Full teardown: `docs/book-endpoint.md`.


- **Plan 6's engine is ahead of its UI.** `cardsForSlice`, `multipleAt`,
  `spinSlice` and `qualifiedUnderlyings` are built, pure and unit-tested — and
  none of them has a production call site yet. So: the pick screen still deals
  eight seeded cards priced by `desk/optionize.ts` rather than by the protocol's
  own `calculatePayout`; **no screen renders a dead slot**, so a card always
  exists; and the DEEP/THIN grade falls back to `THIN` for every symbol because
  nothing has measured the book. Two edits close all of that, and both are
  plumbing over code that already exists. Do not read a green suite as a wired
  product. Every claim in this section is measured item by item, with a
  `file:line` for each, in [`docs/plan6-audit.md`](docs/plan6-audit.md).

The seeded game never depends on any of it: kill every flag and the app is
byte-for-byte the offline build. **Residual trust, stated plainly:** the attest
server re-derives the winner from committed picks and never signs a claimed
one, but it can see picks in the clear and holds the only verdict key — a
dishonest operator could collude. The counterparty-locks-seat-`a` attack that
X-1 named is closed: `src/server/seats.ts` reads `a` and `b` out of the
contract's `duels` getter, so a lock is compared against who actually paid a
stake rather than against who says so. Commit-reveal is the named v2; the
escrow's unconditional 6-hour refund is the escape hatch that needs no server
at all.

### Reading the chips

Four words, one colour each, everywhere in the app. They are defined once in
`FEED_STATE` (`src/theme.ts`) and no surface phrases or tints its own — the
footer, the news wire's header, `/desk`'s blotter pill and the lobby's payoff
marquee all read from that record.

| Chip | Colour | What it claims |
|---|---|---|
| `LIVE` | green | Fresh from the venue, read inside the refresh window. The only state that pulses. |
| `SEEDED` | grey | A deterministic fixture. No network was involved and none failed — this is what the offline build runs on. |
| `STALE` | amber | Was live; the refresh failed; these are the last good numbers. Always shown with the age of that read — the age is the disclosure, the word alone is not. |
| `PARTIAL` | blue | Live, but a feed dropped. Some sources answered and some did not. |

Two more chips are compounds of the same vocabulary rather than new states:
`LIVE SPOT · SEEDED TAPE` on the spin reel and the pick screen says both things
at once — the annotation beside a price is a live print, the number the duel
settles on is the seeded one — and `/desk`'s payoff label reads `SPOT 2,375.76 ·
LIVE` or `SPOT 4,182 · REFERENCE`, where `REFERENCE` is the constant the
structure was written around and is pinned by `test/engine.test.ts`.

Words that look like these and are not: `SEASON 01 · LIVE` (the season is
running), `MOCK WALLET · FAKE ADDRESS` (a wallet tier), `PARTIAL` on an order
row (the venue's own fill status), `SIDE BET · UNAVAILABLE` (a feature is off).
None of them wear one of the four colours — accent is the brand and no feed
state is accent — which is what keeps the collision harmless.

## What the tape actually does

`series(sym, salt)` in `src/engine/tape.ts` is a seeded random walk from the
asset's reference price. Study and the duel use different salts derived from the
match seed and the lobby's mode, so the study charts and the tape you duel on
are different windows on the same tickers — read behaviour, not levels.
