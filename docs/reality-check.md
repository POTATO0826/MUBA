# Reality check — pass 3

**Branch** `new` · **HEAD** `8b457f2` · **Run** 2026-09-04 22:13 → 2026-09-05 00:05 UTC
**Method** live venue probes + headless Chrome driven over CDP (real clicks, real drags, real hovers), 1280 / 1600 / 1920.
**Scope** read-only on `src/` and `test/`. Nothing was fixed. No git operations.

This pass answers one question the other two cannot: *does the running app, against the live
Thetanuts book on Base, show what it claims to show?* Everything below is either something I
**observed** (marked as such) or something I **inferred** from code I read to explain an
observation. The two are kept apart on purpose.

---

## 0. Headline

Three findings dominate. All three are invisible to a passing test suite.

1. **The market-priced parlay card can never appear.** `/api/config` never emits the
   `options` feature key that the client requires. The engine deals live cards correctly
   *right now* — I proved it by injecting the flag at the network layer and watching real
   strikes and premiums render. One missing line on the server makes the app's headline
   claim unreachable. **§4.1**
2. **The live news wire is dead for ~95% of matches.** The news allowlist is the frozen
   18-symbol `UNIVERSE`; the live board deals AVAX, XRP and BNB, which are not in it. One
   unknown ticker fails the *entire* request, so the study wire silently falls back to a
   seeded 2019 wire. **§4.3**
3. **The box arena is genuinely real and genuinely good.** Real listed zones, real premiums,
   verified digit-for-digit against `/api/market`. This is the strongest surface in the app. **§4.2**

---

## 1. The live venue

### 1.1 `bun run scripts/probe-assets.ts` — verbatim

```
THETADUEL — asset gate probe
  chain     Base 8453 via https://mainnet.base.org
  run       2026-09-04T22:13:13.031Z
  gate      ≥6 fillable orders, ≥4 with a usable delta, ≥$50 depth, spot readable

  source    live Base 8453, book as of 2026-09-04T22:13:13.032Z
  read      355 resting orders, 6 market prices, 8 price-feed assets

ASSET           SPOT   ORDERS   GREEKED      DEPTH USD  MM    GRADE   VERDICT
----------------------------------------------------------------------------------------
ETH           $2,453      124        81     $1,191,292  yes   DEEP    QUALIFIED
BTC          $79,644      139        93     $1,335,943  yes   DEEP    QUALIFIED
SOL           $101.68      27        23       $250,000  no    THIN    QUALIFIED
DOGE               —        0         0              —  no    —       REJECTED — no market price; not enough resting orders; no usable deltas; not enough depth
XRP            $1.40       11        11       $110,000  no    THIN    QUALIFIED
BNB          $717.96       41        37       $390,000  no    THIN    QUALIFIED
PAXG               —        0         0              —  no    —       REJECTED — no market price; not enough resting orders; no usable deltas; not enough depth
AVAX           $7.35       13        13       $130,000  no    THIN    QUALIFIED

QUALIFIED: ETH (DEEP), BTC (DEEP), SOL (THIN), XRP (THIN), BNB (THIN), AVAX (THIN)
MM pricing grades, it never gates — the resting order book is a separate source and covers more assets.
```

Six qualify: **ETH and BTC DEEP**, **SOL / XRP / BNB / AVAX THIN**. DOGE and PAXG rejected —
no readable market price. This matches `LIVE_BOARD` minus the two rejects.

### 1.2 `/api/market`

`HTTP 200`, 473,734 bytes, 66 ms. `ok: true`. Snapshot age at read: **23 s**.

| Field | Value |
| --- | --- |
| `at` | 2026-09-04T22:13:06Z |
| `qualified` | 6 (as above) |
| pricing rows | **355** — ETH 124, BTC 139, SOL 27, XRP 11, BNB 41, AVAX 13 |
| `mmPricing` | ETH 14, BTC 14 rows (ETH/BTC only) |
| `orders` | 40, **40/40 fillable** |
| `greeksSeen` | 258 |
| `optionBook` | `0x1bDff855…dfDed`, `agreed: true` |
| `ladder.orders` | 355 |

**Quoted listed zones (condors/rangers):** ETH 20, BTC 22. None on SOL/XRP/BNB/AVAX — which
the arena discloses (§4.2).

Missing-field census (`—` is honest "the order carried no greek", not a bug):

```
ETH   n=124  dash: bid=67 ask=57 iv=43 delta=43   BTC   n=139  dash: bid=68 ask=71 iv=46 delta=46
SOL   n= 27  dash: bid=27 ask= 0 iv= 4 delta= 4   XRP   n= 11  dash: bid=11 ask=0  iv= 0 delta= 0
BNB   n= 41  dash: bid=41 ask= 0 iv= 4 delta= 4   AVAX  n= 13  dash: bid=13 ask=0  iv= 0 delta= 0
```
`mmPricing` had **zero** missing fields and zero `markUsd == 0` rows.

### 1.3 End-to-end cross-checks (the brief's "one number, end to end")

I did three, not one.

**(a) MM quote → `/desk`.** `/api/market` `mmPricing.ETH[0]`:
`ETH-5SEP26-2380-C · bid 0.0271 · ask 0.0329 · mark 0.0300 · spot 2453.35`.
The desk's MM pricing table rendered the same instrument at
`bid 0.0266 · ask 0.0329 · mark 0.0297 · spread 0.0063`. Same ticker, ask identical, bid/mark
drifted a few basis points between my `curl` and the screenshot. **Confirmed live.**

**(b) Listed zones → box arena.** ETH, expiry Sep 7. All three rangers in the book appear in
the UI's `ON THE BOOK` row and price correctly when clicked:

| `/api/market` strikes | API ask | UI band | UI wing | UI MAX LOSS |
| --- | --- | --- | --- | --- |
| 2380 / 2400 / 2500 / 2520 | 17.9926 | $2,400 – $2,500 | $20 | **$18.05** ✓ |
| 2360 / 2400 / 2500 / 2540 | 36.9298 | $2,400 – $2,500 | $40 | **$37.01** ✓ |
| 2480 / 2500 / 2600 / 2620 | 5.5715 | $2,500 – $2,600 | $20 | **$5.30** ✓ |

Header read `ETH · LIVE STRIKES · 14 rungs · $2,340–$2,620` and `ETH spot $2,452` against a
live spot of $2,453. **Confirmed live, digit for digit.**

**(c) Spot → spin reel.** The reel showed both numbers per tile, e.g.
`ETH $4,183 seeded · $2,450.40 live`, `SOL $214.40 seeded · $101.67 live`. Live halves match
`/api/market` spot. **Confirmed.**

---

## 2. Surface verdicts

Every row was opened in a real browser and every screenshot was read. "Clean" means: no console
error, no `NaN`/`undefined`/`[object Object]`, and `document.scrollWidth === window.innerWidth`
at all three widths.

| # | Surface | Route | Verdict | Note |
| --- | --- | --- | --- | --- |
| 1 | Home | `/` | **PASS** | Clean at 1280/1600/1920. Honest `SETTLED ON BASE · SEEDED` chip on the payoff strip. |
| 2 | Battles board | `/battles` | **PASS** | Clean. Six lobbies, all accept correctly. |
| 3 | Create lobby | `/create` | **PASS** | Clean. |
| 4 | Lobby room | `/match/:id/room` | **PASS** | Ready-up works; both seats pair. One odd stat — §5.6. |
| 5 | Spin | `/match/:id` | **PASS** | Reel lands, auto-advances to study. Shows `seeded · live` pairs honestly. |
| 6 | Study wire | `/match/:id/study` | **DEGRADED** | Renders well and is chipped `SEEDED` — but the *live* wire is unreachable for this and most matches. §4.3 |
| 7 | Parlay pick | `/match/:id/parlay` | **DEGRADED** | Every card `MAX LOSS —` / `no live premium`. Live path is flag-gated and the flag cannot be set. §4.1 |
| 8 | Duel | `/match/:id/duel` | **PASS** | Clean at all widths. Legs, tape, both slips. |
| 9 | Result | `/match/:id/result` | **PASS** | Clean. Coach summary coherent. |
| 10 | Options desk | `/desk` | **PASS (with caveat)** | Live MM pricing confirmed real. The payoff chart/slip is a frozen fixture ~70% away from live spot. §5.1 |
| 11 | Ranks | `/ranks` | **PASS (with caveat)** | Renders well. Labels itself `LIVE` over entirely seeded numbers. §5.2 |
| 12 | Arena hub | `/arena` | **PASS** | Clean; large empty area below the fold. §5.5 |
| 13 | Arena create | `/arena` → create | **PASS** | Mints a real invite link. |
| 14 | Arena lobby | `/room/:id` | **PASS** | Accept → ready → enter all work with two distinct seats. |
| 15 | Arena draw + zones | `/room/:id` | **PASS — best in app** | Real strikes, real expiries, real listed zones, real premiums. §4.2 |
| 16 | Arena review | `/room/:id` | **NOT REACHED** | `Review this box` did not advance the view. §5.7 |
| 17 | Wallet picker | modal | **PASS** | Reached by injecting EIP-6963 wallets. Cat mascot recolours per hovered row, exactly as documented. |

**Console errors across every surface above: zero.** No horizontal scroll anywhere at any of
the three widths.

---

## 3. The five reality questions

### Q1 — Does the parlay pick screen show real market-priced cards, or fall back to seeded?

**REFUTED — it falls back to seeded, always, in every configuration.** See §4.1 for the cause
and the proof that the rest of the chain works.

### Q2 — Does the box arena show real listed zones with real premiums?

**CONFIRMED.** Verified digit-for-digit against `/api/market` — §1.3(b). This surface is real.

### Q3 — Does the study wire show live news with correct day banding?

**Split.**
- Day banding, **when the feed answers**: **CONFIRMED correct.** `/api/news?tickers=ETH,BTC`
  returned 27 items banded `FRI · 09-04-26` (10), `THU · 09-03-26` (6), `WED · 09-02-26` (4),
  `TUE · 09-01-26` (4), `MON · 08-31-26` (1), `SUN · 08-30-26` (1), `SAT · 08-29-26` (1) —
  correct descending order, correct weekday-to-date mapping. Real wire items carry real
  publishers and real Google-News links.
- Live news reaching the study screen: **REFUTED for most matches.** §4.3.

### Q4 — Do the state chips say what is actually true?

**Mostly CONFIRMED, two exceptions.**

Tested by intercepting `/api/market` at the network layer.

| Scenario | Desk | Arena | Verdict |
| --- | --- | --- | --- |
| Normal | `LIVE · POLL 30s`, `SPOT 2,451.15 · LIVE` | `LIVE · thetanuts · base 8453 · 8s ago — read only` | correct |
| Venue returns 503 | `SEEDED`, `PARTIAL`, **`SPOT 4,182 · REFERENCE`** | `SEEDED`, `seeded fixtures — read only` | **correct — degrades honestly** |

The 503 degrade is genuinely well built: the desk stops saying LIVE, drops to `REFERENCE`
spot, and flags `PARTIAL`. Exceptions:

- **`/ranks` and the home hero print `SEASON 01 · LIVE` over 100% seeded data** (§5.2). This
  is a decorative label sitting where a data-state chip appears elsewhere.
- **`LIVE`/`STALE` keys off refresh *success*, not data *age*.** I served a well-formed 200
  whose `at` was 45 minutes old; the footer printed `LIVE · thetanuts · base 8453 · 45m ago`.
  *Inference from `src/data/thetanuts.tsx:72,93` (`sourceFrom(wire, stale)`): `stale` is set
  only after a failed poll.* By the documented definition this is correct behaviour, and in
  normal operation `at` tracks the fetch, so **this is a robustness gap, not a live defect** —
  it cannot catch a venue that serves stale-but-well-formed data.

### Q5 — Anything rendering `0.0000`, `—`, `NaN`, `undefined` or an empty state where a number belongs?

**No `NaN`, no `undefined`, no `null`, no `[object Object]`, no `0.0000`, no `Infinity`** on any
surface at any width. Every occurrence I found is a deliberate `—`:

| Surface | `—` count | Assessment |
| --- | --- | --- |
| `/desk` | 209 | Honest — un-greeked book rows. But 209 dashes on one page is visually heavy. |
| Parlay STANDARD | 32 | 24 × `MAX LOSS —` + slip. **Should be numbers** — §4.1. |
| Parlay FULL | **152** | Six dashes per card (`θ —`, `IV —`, `B/E —`, `payoff curve —`, `— premium`, `MAX LOSS —`). §5.3 |
| Study | 7 | Fine. |
| Home / battles / arena / duel | 1–3 | Fine. |

`θ —` is a known, documented data gap (`ParlayPick.tsx:766-772` — theta is on the wire but not
threaded, deliberately, pending a per-day-vs-per-year decision).

---

## 4. Broken, with locations

### 4.1 The `options` feature flag is never emitted — the live parlay card is unreachable

**Severity: highest. This is the one that will embarrass the owner in a demo.**

The client gates the entire market-priced-card path on `features.options`:

`src/state/options.ts:50`
```ts
const body = (await res.json()) as { features?: { options?: boolean } };
if (live && body.features?.options === true) setEnabled(true);
```

The server emits three keys, and `options` is not among them:

`index.ts:246-250`
```ts
features: {
  market: Bun.env.THETADUEL_MARKET !== "off",
  stake:  Bun.env.THETADUEL_STAKE  === "on",
  trade:  Bun.env.THETADUEL_TRADE  === "on",
},
```

Observed `/api/market` → `/api/config` response:
`{"features":{"market":true,"stake":false,"trade":false}}` — no `options` key.

Therefore `useOptionBook` returns `undefined`, `book` is null in `src/state/match.ts:501`,
every ticker keeps its seeded leg, and `faceValues` sets `premium: null`
(`ParlayPick.tsx:787`), which makes every face print `MAX LOSS —`
(`ParlayCardFace.tsx:158-160`). **Setting `THETADUEL_OPTIONS=on` does nothing** — no code
reads that variable.

**Proof the rest of the chain is sound.** I intercepted `/api/config` and injected
`options: true`. With no other change:

- ETH cards went live at strikes **$2,460 / $2,480 / $2,420** against live spot $2,453
  (previously $4,256 / $4,109 / $4,392 — derived from the *seeded* $4,182.60).
- Faces changed to `MAX LOSS $6.70 · premium paid` / `WIN $606.64`, with
  `ETH 2,460 CALL · Δ0.36 · exp 5 SEP · payout at ±25%`.
- A `LIVE` chip appeared on ETH; AVAX and XRP correctly kept `SEEDED`.
- A fourth chip appeared: `REAL STRIKES · SIMULATED SETTLEMENT`.
- Undealt tiers rendered as `BULLISH · NOT DEALT / no resting call in SAFE's band` — the
  documented "dead slot" design, working.
- **Zero console errors.**

Independently, calling the engine directly against the live book confirms it deals cards for
**all six** underlyings right now: ETH 4/8, BTC 3/8, SOL 4/8, XRP 3/8, BNB 5/8, AVAX 4/8.

*Note:* AVAX/XRP staying seeded even with the flag on is **correct** — `BOOK_ASSETS` is ETH and
BTC only (`src/state/options.ts:80-91`, `src/data/spot.ts`).

**Fix:** add `options: Bun.env.THETADUEL_OPTIONS === "on"` to `index.ts:246`. One line.

> **Since fixed, then defaulted on.** The key was added as `=== "on"` and the flag
> became reachable — everything above was true when it was written and the finding
> stands as the record of why the key exists. The default has since inverted: the
> line now reads `options: Bun.env.THETADUEL_OPTIONS !== "off"`, the same opt-out
> shape `market` uses, because "emitted but off unless you read the README" was
> still the demo this section describes for anyone cloning the repo. The path is
> read-only — `useOptionBook` fetches `/api/config`, `bookOf` reshapes a snapshot
> `/api/market` already served, and what crosses into the match is a frozen plain
> value; no wallet, no ethers, no approval, no transaction. `THETADUEL_TRADE` and
> `THETADUEL_STAKE` are untouched and remain opt-IN on `=== "on"` exactly.
> `test/market-route.test.ts` pins the new literal.

**Second-order issue this exposes.** With the flag on, ETH DEGEN renders **×430.75** and
**×439.94** beside AVAX DEGEN **×6.67** in the same grid. Seeded `mult` is `tierOdds(tier)`
(≈1/band midpoint, 1.33–6.67); live `mult` is `multipleAt(…, REFERENCE_MOVE, …)` — the payout
at a ±25% move over the ask. The two are computed on incompatible bases and are not
comparable, yet they sit side by side as the card's headline number. A player would read the
ETH card as 65× better than the AVAX one. **Worth settling before the flag is switched on.**

### 4.2 (not a defect) The box arena is real — recording it because it is the strongest surface

Full path walked with two distinct wallets (`?as=0x…` override, `src/wallet/mock.ts:16`):
hub → connect → `DRAW A BOX` → create + invite link → guest joins → `Accept duel` →
both `Ready up` → both `Enter duel` → draw surface.

Observed on the draw surface:
- `ETH · LIVE STRIKES · 14 rungs · $2,340–$2,620`, `ETH spot $2,452` (live: $2,453).
- Real expiry ladder `Sep 5 · Sep 6 · Sep 7 · Sep 8 · Sep 11 · Sep 18 · Sep 25 · Oct 30` —
  matches the book's own expiries.
- `ON THE BOOK` chips for the three listed ETH Sep 7 zones, priced correctly (§1.3b).
- Greyed assets carry the reason: *"Greyed assets have a book, but no condor market."*
  Correct — SOL/XRP/BNB/AVAX have zero rangers.
- Honest empty state on Sep 5: *"The book lists no zone at all on this expiry."* Correct.
- Prominent red disclosure: *"Stakes are switched off in this build… no USDC is approved,
  transferred or escrowed on this path, and DuelEscrow is written and reviewed but not
  deployed. The duel is for pride."*
- Chart honesty: *"133 prints ran outside the ladder and are not drawn — the line is clipped,
  never rescaled"* and *"The feed last printed 16 min before now; the gap at the right edge is
  that silence, not a flat price."*

**One real UX defect here:** two `ON THE BOOK` chips both read **`$2,400 – $2,500`** but are
different instruments — $20 vs $40 wings, $18.05 vs $37.01 premium. The label does not
disambiguate them. A player sees two identical buttons that charge twice as much as each other.
*Suggest appending the wing width to the chip.*

### 4.3 The news allowlist is the wrong list — the live wire dies for ~95% of matches

**Observed**, one ticker at a time against `/api/news`:

```
ETH   -> ok:true, 12 items      AVAX -> ok:false, "unknown ticker: AVAX", 0 items
BTC   -> ok:true, 27 items      XRP  -> ok:false, "unknown ticker: XRP",  0 items
SOL   -> ok:true, live          BNB  -> ok:false, "unknown ticker: BNB",  0 items

ETH,BTC     -> ok:true,  27 items
ETH,AVAX    -> ok:false, 0 items      <-- one bad ticker kills the whole request
ETH,AVAX,XRP-> ok:false, 0 items      <-- the exact ticker set my match was dealt
```

**Cause.** `src/server/news.ts:559` builds the allowlist from `UNIVERSE`:
```ts
const KNOWN = new Set(UNIVERSE.map((u) => u.sym));
```
and `:963-964` rejects the whole request on the first miss:
```ts
for (const t of tickers) {
  if (!KNOWN.has(t)) return { reason: `unknown ticker: ${t}` };
```

`UNIVERSE` (`src/data/universe.ts:46-64`) is the **frozen 18-symbol replay fixture** — NVDA,
AAPL, TSLA, XOM, JPM, AMD, META, GLD, COIN, BTC, ETH, SOL, ARB, LINK, UNI, AAVE, DOGE, PEPE.
It contains no BNB, no AVAX, no XRP. The *live* board (`LIVE_BOARD`, `:97-104`) declares those
three inline **precisely because they are absent from `UNIVERSE`** — the comment says so.

**Impact.** The spin deals 3 of the 6 qualified names. Only ETH, BTC and SOL are known to the
news server, so a match gets live news only when all three dealt names fall in that set:
C(3,3)/C(6,3) = **1 in 20 — about 5% of matches.** The other ~95% fall back silently to the
seeded wire.

**Observed consequence.** My match (`kz-semis`, seed 931252, tickers ETH/AVAX/XRP) rendered a
study wire dated **`WED · 02-13-19`** — February 2019. It is chipped `SEEDED`, so it is not a
lie; but it is a seven-year-old wire on a surface the app showcases.

**Two fixes, independent:** (a) key the allowlist off `LIVE_SYMS`, not `UNIVERSE`; (b) make an
unknown ticker *skip that ticker* rather than fail the request — a partial wire beats none.

### 4.4 Seeded-vs-live spot divergence is now large enough to look like a bug

`SPOT_FALLBACK = 4182` (`src/desk/payoff.ts:95`) and the seeded ETH reference `px: 4182.6`
(`universe.ts:57`) were written when ETH was ~$4,182. **Live ETH is $2,453 — 41% lower.**
Everywhere the two are shown together the app is honest (`$4,182.60 seeded · $2,452.95 live`),
but the *derived* numbers all come from the seeded side:

- Parlay ETH strikes: $3,513–$4,852 against a $2,453 spot; every card is marked `OTM`.
- Duel legs: *"ETH closes above 4,392 (+5.0%) by Fri expiry"*.
- Desk chart: see §5.1.

SOL is worse in ratio: seeded $214.40 vs live $101.68 (**2.1×**). AVAX ($7.50 / $7.36) and XRP
($1.45 / $1.40) are close.

Not a code defect — a stale constant. But it is the reason the app *looks* wrong to anyone who
knows the market, and it compounds §4.1: the flag being off is what leaves these seeded strikes
on screen instead of the live ones.

---

## 5. Smaller findings

### 5.1 `/desk` — the payoff chart's spot marker is pinned to the axis origin

The desk's slip and chart are the frozen `ETH_VOL_BOX` fixture: legs 4300C ×2 / 4700C ×2 /
3900P / 3600P, debit 0.412, plotted over a **fixed** 3,200–5,200 window.

With live spot 2,453 the marker maps to x ≈ **−257** on a plot whose origin is x = 52, so it is
clamped: I measured `spotX = 52.0` — exactly the axis origin. The label correctly prints
`SPOT 2,453.03 · LIVE`, but the dashed line sits at the `3.2k` gridline, which reads as
"spot is 3,200".

**This is deliberate and documented** (`payoff.ts:113-115`: *"a dashed line drawn off the left
edge is a rendering bug, not a fact. The label always prints the true number; only the line is
clamped."*). Recording it because the visual still misleads, and because two neighbouring
numbers compound it:

- **`WIN ZONE 66.7%`** is not a probability. It is
  `vals.filter(v => v > 0).length / vals.length` (`payoff.ts:138`) — the fraction of 81 samples
  *inside the fixed 3,200–5,200 window* that are profitable. That window excludes live spot
  entirely. Beside `IMPLIED ODDS 4.51×` it reads as a win probability.
- **`BREAKEVEN 4,389`** is only the *first upward* zero crossing (`payoff.ts:126-136`). This
  structure has **two** breakevens: I computed a downward crossing at **≈3,723** and the upward
  one at 4,389. At live spot the position is actually **+0.29 Ξ** — profitable — which the
  single-breakeven framing hides.

### 5.2 `/ranks` labels seeded data `LIVE`

`src/views/Ranking.tsx:1168` renders `{SEASON.label} · LIVE` — the `· LIVE` is hardcoded. Every
number beneath it is a sum over seeded profiles: `14 RANKED`, `2,110 COPIERS ACTIVE`,
`$451.0K FEES / 24H`, `$180.4M COPY CAPITAL`. Same chip on the home hero (`Lobby.tsx:89`).

This matters because the app *does* use `LIVE`/`SEEDED` as truthful data-state chips elsewhere
(the home payoff strip says `SETTLED ON BASE · SEEDED`, the footer says `LIVE … 8s ago`). Using
the same word decoratively here undercuts the ones that mean something.

### 5.3 Parlay at `FULL` detail is mostly dashes

With the options flag off (i.e. always, today), each of the 24 cards at `FULL` renders:
```
MAX LOSS —            no live premium
×1.33
$4,256 strike
Δ 0.75 · θ — · IV —
OTM
B/E —
payoff curve —
— premium
book Δ 0.18 (second opinion)
```
Six dashes per card, **152 on the page**. `FULL` currently shows strictly less information than
`STANDARD` plus five empty rows. The detail level also persists across reloads (localStorage),
so a user who tries `FULL` once keeps the emptiest view.

### 5.4 The mock-wallet banner overlaps content

`MOCK WALLET · FAKE ADDRESS` is a fixed bottom banner. At 1920 it covers the `PRIZE POOL` /
`ENTRY` row of the third and fourth lobby cards on `/`, and table rows 5–6 on `/ranks`. Cosmetic,
but it lands on numbers on two of the first screens a viewer sees.

### 5.5 Large dead zones below the fold on arena screens

At 1600×1100 the arena hub's content ends at y ≈ 580 and the create-duel screen at y ≈ 620,
leaving 400–500 px of empty black above the fixed banner. Not broken; it reads as an unfinished
page next to the dense desk and parlay screens.

### 5.6 A player with no history is shown 40 copiers

In the lobby room the "You" seat reads `CAREER P/L +$0`, `0 BATTLES`, `RECORD NO DUELS YET`,
`SEASON OPENS HERE` — all correct empty states — and directly beneath, `COPIERS 40 · ≈ $8,915 / DAY`.
Forty people paying $8,915/day to copy someone who has never played.

### 5.7 `Review this box` did not advance

After selecting a listed zone, clicking `Review this box` (verified: the click landed, the
handler returned the button's own label) left the view on `Draw your box`. The right-hand panel
still showed the selected zone. I could not reach a review screen at 1600 or 1920. **Unverified
whether this is a gate (box must be locked first) or a defect** — I did not click `Lock this
box`, since locking commits the box to a duel.

### 5.8 Latent: the spin's first RNG draw is affine in the seed

`seededRandom` (`src/engine/spin.ts:77-83`) is a bare LCG, so the *first* draw is
`(seed × 1664525 + 1013904223) mod 2³²` — a straight-line function of the seed. Measured:

- Over **consecutive** seeds, the dealt underlying changes in runs of up to **430**
  (seeds 1–250 → always BTC; 301–600 → always SOL; ~900000+ → always ETH).
- Over **realistic** seeds (`newSeed()` = 100000–999999, 4000 draws) the distribution is
  **uniform**: BNB 658, AVAX 655, XRP 681, ETH 662, SOL 681, BTC 663.

**So this is not a visible defect in normal play** — real seeds are spread across 900k. It is a
latent weakness: the outcome is a pure function of a seed that is visible in the URL *before*
the reel animates, and any two matches seeded from nearby values deal the same asset.

### 5.9 Observed but not reproducible: 404 bursts from abandoned arena rooms

A long session that created several arena rooms and left them accumulated **48** console
`404 (Not Found)` entries. A clean single-room session, watched with the Network domain for 60 s
through a full duel, produced **zero** failures — 70 × `200 /api/rooms/<id>` (polling ≈ every
1.7 s), plus 200s on config/market/news/wallet-config. *Inference: the room poller keeps
requesting rooms that have been reaped.* Low priority; noted so it is not mistaken for something
worse if it reappears.

### 5.10 Study wire anachronism

The case study draws three charts from three different eras — ETH `NOV 2018 · FEB 2019`,
AVAX `FEB 2021 · MAY 2021`, XRP `APR 2020 · JUL 2020` — but bands the single wire to one date,
`WED · 02-13-19`. So `AVAX Jumps 21.6% on $952 million of Net Inflows` is datelined February
2019, eighteen months before Avalanche launched. Clearly chipped `SEEDED`; recording it because
a viewer who knows crypto will notice.

> **Fixed — `eefa595`, 2026-09-05.** The invented "historical window" is gone rather than
> corrected. `windowLabel()` (`engine/tape.ts`) — the hash that produced `NOV 2018 · FEB 2019`
> — no longer exists; its replacement, `spanLabel()`, prints where the seeded walk's own 200
> prints are, e.g. `PRINTS 51–110 OF 200`, and dates nothing. The wire side of the same defect
> is gone with it: `src/data/wire.ts` no longer reproduces `windowLabel`'s hash to make its
> datelines agree with the chart's invented era — the seeded session now files on the current
> UTC day (`windowSeed`'s docblock names this finding by section number as the reason). There is
> no historical window left for a story to be filed inside, real or fake, so the specific
> anachronism above cannot recur — not because the date logic got smarter, but because the thing
> it was dating no longer exists. Verified: `grep -rn "windowLabel" src/` returns only doc
> comments narrating its removal, and `grep -rn "spanLabel" src/` shows the one call site
> (`engine/chart.ts:71`) feeding `PRINTS … OF …` to the study screen.

---

## 6. What I could not test

| Thing | Why |
| --- | --- |
| Real wallet connect | No `WALLETCONNECT_PROJECT_ID`; app runs on the mock wallet. I reached the picker by injecting four EIP-6963 announcements — the picker and its hover choreography are verified, but no real signer was involved. |
| Staking / trading / escrow | `features.stake` and `features.trade` are both `false`, and the arena states plainly that `DuelEscrow` is not deployed. No money path was exercised. |
| Arena review + settle | §5.7 — would have required locking a box into a duel. |
| Two seats on separate machines | Both seats were tabs in one browser, separated with `?as=0x…`. **Note:** without that override both tabs get the same `MOCK_ADDRESS` and the room sits on `Waiting for an opponent` forever — worth knowing before a demo. |

---

## 7. If one thing gets fixed before a demo

**`index.ts:246` — add `options: Bun.env.THETADUEL_OPTIONS === "on"`.**

> **Done, and then taken one step further.** The key was added; the default has
> since been inverted to `!== "off"` so the intended demo is what a clone gets
> with no `.env` at all. See the note at the end of §4.1.

The home page promises *"Options pricing streams live from Thetanuts on Base."* Today that is
true of `/desk` and of the box arena, and false of the parlay pick screen — the screen the demo
path actually walks through, where all 24 cards read `MAX LOSS —`. The engine, the book, the
card dealer and the renderer all work; I watched real strikes and real premiums appear the
moment the flag was present. One line stands between the current demo and the intended one.

Second, if there is time: **§4.3**, so the study wire stops showing a 2019 tape.
