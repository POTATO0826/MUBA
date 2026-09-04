# Plan 1 — Sector selection, game modes (Blitz/Quick/Normal), gamification, card indicators

Verified codebase facts:
- `spinCase(eligible, legCount, seed)` picks via `eligible[plan.target % eligible.length]` — both the contents AND order of the book are part of the determinism. `MatchSpin` renders `assets[i % assets.length]`, so the reel's asset list must be the same list contents/order the spin was planned against.
- Salts are `studySalt = 1 + seed*3`, `fightSalt = 2 + seed*3` (`src/state/match.ts:273-274`).
- `TAPE_LEN = 200` is used two ways: length of the generated walk (`series`) and "the end of the duel" (`edgeOf`, `readPlayer`, `settle` tapeBias, `Result.tsx:136`, `briefs.ts:60`, `Live.tsx:32`, `state/match.ts:275/279/305`). Separating those two meanings is the whole trick for game modes.
- `settle(...)` already takes `pos` as its 5th parameter but ignores it for `edgeOf`/`readPlayer`/tapeBias, which hardcode `TAPE_LEN`. Callers always pass `TAPE_LEN`, so replacing those internals with `pos` is behaviour-preserving for every existing test.
- The 18 assets carry 12 raw `sector` values, several singletons.

## Decision 1 — Sector taxonomy

Six groups over the existing 12 raw sectors. **Do not touch `universe.ts`** (its order is the canonical book order; `spin.test.ts:80-82` pins `bookFor` against it).

| Key | Label | Raw sectors gathered | Tickers | n | Colour |
|---|---|---|---|---|---|
| `SEMIS` | SEMIS | `SEMIS` | NVDA, AMD | 2 | `C.green` |
| `TECH` | BIG TECH | `TECH` | AAPL, META | 2 | `C.blue` |
| `MACRO` | OLD WORLD | `AUTO`,`ENERGY`,`FIN`,`METALS` | TSLA, XOM, JPM, GLD | 4 | `C.amber` |
| `MAJORS` | MAJORS | `L1`,`EQUITY-BETA` | BTC, ETH, SOL, COIN | 4 | `C.accent` |
| `DEFI` | DEFI | `DEFI`,`ORACLE`,`L2` | ARB, LINK, UNI, AAVE | 4 | `C.violet` |
| `MEME` | MEME | `MEME` | DOGE, PEPE | 2 | `#f472b6` |

Two load-bearing properties:
1. The groups partition the universe cleanly along the STOCK/CRYPTO line — `SEMIS+TECH+MACRO` = the 8 stocks, `MAJORS+DEFI+MEME` = the 10 crypto. So `market` becomes derived: `marketOf(sectors)` → all-stock `"STOCK"`, all-crypto `"CRYPTO"`, else `"MIXED"`. Every existing consumer (`MARKET_LABEL`, `MARKET_COLOR`, `MARKET_WALL`, Battles filter, `LobbyCards`, `Room`) keeps working untouched.
2. Three groups have only 2 names, so a 4-leg lobby must combine sectors — a real composition decision, and it forces the "book too small" guard `spinCase` already throws on.

Presets `STOCKS / CRYPTO / MIXED` stay as one-click buttons that select the corresponding group sets (keeps `test/app.test.tsx:200` `clickContaining("CRYPTO")` green).

## Decision 2 — Game mode = how much of the walk is the duel window

**Rejected**: scaling `vol` inside `series` (forces a volScale param through ~8 signatures and invalidates the seriesCache key).

**Chosen**: `series` keeps generating the same 200-print walk for every mode. A mode picks **`settleAt`** — the print the duel settles on. A random walk over fewer steps genuinely moves less (σ√n), so a Blitz window is a tighter, jittier, smaller-percentage chart for free.

```ts
// src/data/modes.ts
BLITZ  minutes 15    settleAt 56    targetScale 0.62   oddsBoost 1.35   pickSeconds 20    color C.red
QUICK  minutes 60    settleAt 110   targetScale 0.82   oddsBoost 1.15   pickSeconds 45    color C.amber
NORMAL minutes 1440  settleAt 200   targetScale 1.00   oddsBoost 1.00   pickSeconds null  color C.blue
```

- **`settleAt`** — the simulated window. Playback stays `TAPE_STEP = 3` prints per 120ms tick, so wall-clock duel time: Blitz ≈2.2s, Quick ≈4.4s, Normal ≈8.0s. Print the compression ratio in the Live header where "TAPE ×64" sits: ×402 / ×818 / ×10,800.
- **`targetScale`** — multiplies every leg's target. Neutral scaling would be √(56/200)=0.53 and √(110/200)=0.74; chosen 0.62/0.82 = ~15% harder relative to the window. Blitz NVDA EVEN reads ±2.5% instead of ±4.0%.
- **`oddsBoost`** — multiplies the parlay multiplier (one line in `summarize`). Less window to be right in → the house pays a premium.
- **`MODE_SALT`** — `{ NORMAL: 0, QUICK: 1_000_003, BLITZ: 2_000_029 }` added to both salts: same seed in a different mode draws a genuinely different window. `NORMAL: 0` = today's demo byte-identical (no-regression guard).
- **`pickSeconds`** — the parlay clock; the mechanic that makes 15 minutes FEEL like 15 minutes.
- **Not scaled**: `TAPE_LEN` / `series` / `seriesCache` — untouched, engine tape tests unaffected.

## Decision 3 — Determinism invariant

A match is fully determined by (lobby, seed), where lobby now carries `sectors` and `mode`.

```
lobby.sectors → bookForSectors() ─┐
lobby.legs    ────────────────────┼→ spinCase(book, legs, seed) → tickers + reel plans
seed          ────────────────────┘
lobby.mode → MODE_SALT   → studySalt / fightSalt → series() → the tape
          └→ settleAt    → where the duel settles
          └→ targetScale → every leg's t
          └→ oddsBoost   → the slip's multiplier
```

Enforced rules (each gets a test):
1. `bookForSectors` iterates `UNIVERSE` and filters by membership — never iterates the sector keys. `["MEME","TECH"]` and `["TECH","MEME"]` produce the identical array; order is canonical book order.
2. `App.tsx` must feed `MatchSpin` the same list: `assets={bookForSectors(lobby.sectors).map(meta)}` (currently `bookFor(lobby.market)` at App.tsx:160).
3. Nothing in the pick clock touches an RNG. Auto-lock leaves unpicked tickers on the existing deterministic `buildLeg(sym,"over","EVEN")` fallback.

Pre-existing limitation: published lobbies (`mine-1`) aren't in static `LOBBIES`, so their links don't replay. Encoding `&m=BLITZ&s=TECH.MEME` in the URL fixes that — nice-to-have N6.

## Implementation steps (app demos at every step)

### MUST-HAVE

**Step 1 — Sector data (pure addition, zero behaviour change)**
- `src/types.ts` — add `export type SectorKey = "SEMIS"|"TECH"|"MACRO"|"MAJORS"|"DEFI"|"MEME"` and `export type Mode = "BLITZ"|"QUICK"|"NORMAL"`.
- NEW `src/data/sectors.ts` — `SectorDef {key,label,members,color,blurb}`; `SECTORS` (table above); `sectorOf(rawSector): SectorKey`; `symsOfSector(key)`; `bookForSectors(keys)` (filter `UNIVERSE`, never the keys); `marketOf(keys): MarketFilter`; `PRESETS: Record<MarketFilter, readonly SectorKey[]>`. Reuses `C` from theme.ts; `SEC_COLOR` in theme.ts stays for raw-sector tags on reel tiles.

**Step 2 — Lobbies carry sectors; the spin deals from them**
- `src/types.ts` — `LobbyDef` gains `sectors: readonly SectorKey[]`; `market` documented as derived-at-construction, kept for labels/colours/filters.
- `src/data/lobbies.ts` — add `sectors` to all 6 fixtures (`kz-semis: ["SEMIS","TECH"]` (=4 names for 3 legs); `mi-majors: ["MAJORS"]`; `dr-mixed: ["SEMIS","MAJORS"]`; `lx-degen: ["MEME","DEFI"]`; `no-grind: ["MACRO"]`; `ar-whale: ["MACRO","DEFI"]`). Keep every fixture's derived market equal to its current literal. Add `bookOf(lobby) = bookForSectors(lobby.sectors)` and `canPlay(lobby) = bookOf(lobby).length >= lobby.legs`. Keep `bookFor(market)` exported.
- `src/state/match.ts:250` — `spinCase(bookOf(lobby), lobby.legs, state.seed)`, guarded: `canPlay(lobby) ? spinCase(...) : null` (a bad book must not throw during render).
- `src/App.tsx:160` — `assets={bookOf(lobby).map(meta)}` ← CRITICAL (invariant rule 2).
- `src/views/Room.tsx:55` — "The book is {bookOf(lobby).length} names".

**Step 3 — Sector picker in the lobby builder**
- `src/state/match.ts` — `LobbyForm` gains `sectors` (default `PRESETS.MIXED`). New actions `setFormPreset(m)` (sets `sectors: PRESETS[m]` AND `market: m`), `toggleFormSector(k)` (recomputes `market: marketOf(next)`). `clampLegs(n, max)` where `max = Math.min(4, bookForSectors(sectors).length)`. `publishLobby` writes `sectors`.
- `src/views/CreateLobby.tsx` — keep the existing BOOK row of three preset buttons VERBATIM in position and label (keeps `clickContaining("CRYPTO")` and the `plus[1]` prize-stepper index working). Add a SECTORS row of six chips using `pill(selected)`, each showing label + member count, plus a "book: N names" line and a disabled Publish + inline note when `N < legs`. Do NOT add any button labelled exactly `"+"` and do NOT add a second `<input>` without `inputmode` — two tests select on those.

**Step 4 — Mode data and engine plumbing**
- NEW `src/data/modes.ts` — `ModeSpec`, `MODES`, `MODE_ORDER`, `MODE_SALT`, `MODE_WALL`, precomputed `compression` string per mode.
- `src/engine/tape.ts` — unchanged.
- `src/engine/match.ts` — `edgeOf(legs, salt, end = TAPE_LEN)`; `readPlayer(who, legs, salt, score, won, end = TAPE_LEN)`; inside `settle`, replace the three hardcoded `TAPE_LEN` uses (edgeOf, readPlayer, upN tapeBias) with the `pos` parameter it already receives. Behaviour-identical at `pos === TAPE_LEN`.
- `src/engine/match.ts` — ADD THE 0–0 TIE-BREAK. Shorter windows make 0–0 common; today `edgeOf` returns 0 for both and `myEdge >= oppEdge` hands every scoreless duel to P1. Add `driftOf(legs, salt, end = TAPE_LEN)` (signed travel in each leg's own direction, cleared or not) and in `settle`: `meWins = myScore > oppScore || (tied && (myEdge !== oppEdge ? myEdge > oppEdge : myDrift >= oppDrift))`. Keep the literal string `"broken on conviction"` in every tie branch of `scoreLine` (engine.test.ts:121 asserts it).
- `src/engine/parlay.ts` — `buildLeg(sym, dir, tier, targetScale = 1)` → `t = +(u.t * spec.scale * targetScale).toFixed(2)`; `legForCard(sym, card, targetScale = 1)`; `legsForPicks(syms, picks, targetScale = 1)`; `summarize(legs, stakePoints, oddsBoost = 1)` → `mult = parlayMultiplier(legs) * oddsBoost`. All defaults preserve current behaviour.
- `src/data/briefs.ts` — `briefsFor(syms, salt, end = TAPE_LEN)`; use `end` at line 60.

**Step 5 — Mode on the lobby and through state**
- `src/types.ts` — `LobbyDef.mode: Mode`; `LobbyForm.mode: Mode`.
- `src/data/lobbies.ts` — fixtures get modes. `kz-semis` and `mi-majors` MUST be `NORMAL` (pinned numbers in app.test.tsx: ×47.52, 1.4%, 8.8%). `lx-degen: "BLITZ"`, `dr-mixed: "QUICK"`, `ar-whale: "BLITZ"`, `no-grind: "QUICK"`.
- `src/state/match.ts` derived:
  ```ts
  const spec = MODES[lobby.mode];
  const studySalt = 1 + state.seed * 3 + MODE_SALT[lobby.mode];
  const fightSalt = 2 + state.seed * 3 + MODE_SALT[lobby.mode];
  const pos = Math.min(spec.settleAt, Math.max(2, state.tick * TAPE_STEP));
  // legForCard(sym, card, spec.targetScale); buildLeg(sym,"over","EVEN", spec.targetScale)
  // summarize(legs, stakePoints, spec.oddsBoost)
  // settle(myLegs, oppLegs, arena, fightSalt, spec.settleAt, ...)
  // briefsFor(arena, studySalt, spec.settleAt)
  // raceDone: pos >= spec.settleAt
  ```
  Export `mode: spec` on `derived`.
- `src/views/Live.tsx` — `settleAt` + `mode` props; `progress = pos/settleAt`; replace hardcoded `TAPE ×64` badge with `{mode.label} · {mode.duration} · TAPE ×{mode.compression}` tinted `mode.color`.
- `src/views/Result.tsx` — `settleAt` prop; `legState(l, p.salt, p.settleAt)`.
- `src/views/Study.tsx:68` — `buildChartCard(sym, salt, settleAt, 110)` via new `settleAt` prop.
- `src/App.tsx` — thread `derived.mode` / `settleAt` into Live, Result, Study.

**Step 6 — Mode picker in the lobby builder**
- `src/views/CreateLobby.tsx` — replace static "MODE / 1v1" block (lines 115-117) with three mode buttons showing label, duration, `targets ×0.62`, `payout ×1.35`. Live-preview the entry/pool line with the boost.
- `src/state/match.ts` — `setFormMode(m)`; `publishLobby` writes `mode`.

**Step 7 — Mode badges**
- `src/ui/LobbyCards.tsx` — mode chip next to `MARKET_LABEL` tag, `tag(MODES[lobby.mode].color)` text `BLITZ · 15 MIN`. Change hover-details line 3 to `` `${mode.label} · ${mode.duration} · spin deals the tickers · most legs wins` `` rather than adding a 4th line (app.test.tsx:170 asserts `details.children` length 3 and line 3 contains "most legs wins").
- Same chip in headers of `Room.tsx`, `MatchSpin.tsx`, `ParlayPick.tsx`, `Study.tsx`.
- `ParlayPick.tsx` — show boost on slip: `×8.21` with `BLITZ +35%` sub-line.

**Step 8 — Blitz pick clock**
- `src/state/match.ts` — `MatchState.deadline: number | null`. Set in `doneStudy` (and `initialState` when `route.tab === "parlay"`) from `MODES[lobby.mode].pickSeconds`; null for NORMAL. Reuse the existing 120ms interval: when `tab === "parlay" && deadline && Date.now() >= deadline`, call the same patch `lockParlay` does. Expose `derived.secondsLeft: number | null`.
- `ParlayPick.tsx` — countdown chip switching to `C.red` + `animation:vcPulse` under 5s, "unpicked legs lock at EVEN ↑" note. Unpicked tickers already fall back deterministically; auto-lock needs no new code path.
- `kz-semis` is NORMAL so every existing parlay test sees `pickSeconds === null`.

### NICE-TO-HAVE (priority order)
- **N1 — XP/streak/rank in ledger.** `SettledRecord` gains `mode` and `xp` (BLITZ 120 / QUICK 80 / NORMAL 50, ×2 on sweep). `useLedger` derives `xp` (sum), `streak` (leading win run), `best`. Display with existing `tierFor`/`nextTier` from `src/data/rewards.ts` as a chip beside BALANCE in Battles.tsx and a `+120 XP · STREAK ×3` line on Result.tsx. **[NOTE: plan 4 absorbs the Result display — ledger schema part stays, Result chip does NOT ship.]**
- **N2 — Mode filter row on Battles.tsx.** Own chip row, use `ANY` not `ALL` (avoid exact-match selector collision).
- **N3 — Mode-tinted card art.** Blend `MODE_WALL[mode]` into `MARKET_WALL` gradient or 3px mode-coloured top stripe. Keep CardArt seeded by lobby.id (test asserts purity).
- **N4 — Mode-aware `windowLabel`** (`TUE 09:15 · 09:30` for Blitz instead of a 3-month range).
- **N5 — Result flourishes.** `SWEEP` badge, `SURVIVED THE BLITZ` on a 0–0 drift win, streak-fire counter.
- **N6 — Mode/sectors in the URL** (`?seed=N&m=BLITZ&s=TECH.MEME`) in route.ts, so self-published lobby links replay.
- **N7 — Group labels on reel tiles** (replace raw `a.sector` tags with group label + colour).

## Test impact — predicted zero breakages if guards respected

| File:line | Trap | Mitigation |
|---|---|---|
| app.test.tsx:170-171 | `details.children` length 3 | fold mode into line 3, keep "most legs wins" |
| app.test.tsx:200 | `clickContaining("CRYPTO")` | keep 3 preset buttons; no sector chip contains "CRYPTO" |
| app.test.tsx:220-222 | `plus[1]` is the prize stepper | no new "+"-labelled buttons before it |
| app.test.tsx:194 | `input:not([inputmode])` = name field | no second plain input |
| app.test.tsx:435-443 | ×47.52, 1.4%, 8.8% pinned | kz-semis stays NORMAL |
| app.test.tsx:316-317 | `bookFor("CRYPTO")` ⊇ dealt syms | mi-majors ["MAJORS"] ⊂ crypto ✓ |
| engine.test.ts:116/127/146 | `settle(..., TAPE_LEN, ...)` | internals switch to pos; identical at pos===TAPE_LEN |
| engine.test.ts:119-121 | equal-conviction tie → P1 + "broken on conviction" | identical slips ⇒ equal drift ⇒ >= still true; keep phrase |
| spin.test.ts:88 | `bookFor(l.market).length >= l.legs` | still compiles; update to `bookOf(l)` |

New tests: `test/sectors.test.ts` (partition; order-independence; presets ≡ bookFor; marketOf; fixtures valid; 300-seed subset check) and `test/modes.test.ts` (NORMAL identity; monotone knobs; buildLeg/summarize math; edgeOf at 56; settle differs at 56 vs 200; 0–0 drift tie-break not always P1). Plus app tests: BLITZ card shows badge; same seed different mode ⇒ different results; countdown present/absent by mode; auto-lock past deadline; MEME+TECH publish reads MIXED, book 4 names; MEME-alone 4 legs disables Publish.

## Gotchas
1. `spinCase` THROWS when book < legs and `derived` runs on every render — the `canPlay` guard is not optional.
2. App.tsx:160 feeding MatchSpin a different list than spinCase planned = silent seed-dependent wrong-tile bug.
3. `series` cache key is `sym:salt` — mode shifts the salt only, cache stays correct. Don't add a vol param without extending the key.
4. `geom` rescales y to the plotted slice — a 56-print chart still looks dramatic; the mode difference reads in percentages and target lines. Lean on badges/numbers.
5. `pctAt` clamps pos — settleAt=56 is safe.
6. Update README.md (flow + determinism invariant) as the final must-have step.

## Addendum — sector + mode as card-level identity

### A1 · Shared helpers (Step 1 / Step 4; no screen builds its own chip markup)
- `presetOf(sectors): MarketFilter | null` — the set equals `PRESETS[m]` → that m, else null.
- `sectorChips(sectors, max = 6): { label, color, key }[]` — preset hit → ONE chip (`ALL STOCKS` / `ALL CRYPTO` / `FULL BOARD`, colour `MARKET_COLOR[m]`); otherwise sectors in canonical order, first `max`, then a `C.dim` `+N` overflow chip.
- `src/theme.ts` — `miniTag(color)`: `font:700 8.5px/1 MONO;letter-spacing:.1em;padding:4px 6px;border-radius:5px;border:1px solid ${color}4d;background:${color}1a;color:${color}`; `modeTag(mode)`: `miniTag(MODES[mode].color)` + for BLITZ only `;animation:vcPulse 1.6s ease-in-out infinite`.

### A2 · Lobby card resting state (LobbyCards.tsx, Step 7)
- Top-right badge becomes a column (`display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none`): `[ BLITZ · 15M ]` (modeTag, pulses on BLITZ) above `[ 3 LEGS ]` (unchanged markup/string — app.test.tsx:140 `"3 LEGS"` survives).
- Tag row inside `.vc-lobby-fade` becomes the book row: `tag(marketColor)` + `sectorChips(...,2)` as miniTag. DROP the `1V1` tag from the card (asserted by no test; stays in Room). Keep the market tag (colour anchor for MARKET_WALL/CardArt; keeps `toContain("STOCKS")` robust). Counts: 1 sector → 1 chip; 2 → 2; 3+ → 2 + `+N`; preset → 1 collapsed chip. Worst case 4 pills fits 264px; `flex-wrap:nowrap;overflow:hidden`.

### A3 · Hover-details — exactly 3 children preserved
| # | Now | After |
|---|---|---|
| 1 | `kazuo.eth · STOCKS · 3 legs` | `kazuo.eth · STOCKS · 3 legs · SEMIS + BIG TECH` (prefix assertion survives) |
| 2 | pool/entry line | unchanged |
| 3 | `Spin deals the tickers · most legs wins` | `BLITZ · 15 MIN window · spin deals the tickers · most legs wins` |
Line 1 gets the FULL untruncated sector list (`" + "` joined, `SECTORS[k].label`).

### A4 · Propagation matrix (19 rows)
| # | File | Change | Step |
|---|---|---|---|
| 1 | types.ts | sectors/mode on LobbyDef; unions | 1,5 |
| 2 | data/sectors.ts NEW | SECTORS, sectorOf, bookForSectors, marketOf, PRESETS, presetOf, sectorChips | 1 |
| 3 | data/modes.ts NEW | MODES, MODE_ORDER, MODE_SALT, MODE_WALL, compression | 4 |
| 4 | data/lobbies.ts | fixtures gain sectors+mode; bookOf, canPlay | 2,5 |
| 5 | theme.ts | miniTag, modeTag | A1 |
| 6 | views/CreateLobby.tsx | sector chips + live book preview strip (tickers joined " · "); mode picker; header echoes sectorChips; Publish gating | 3,6 |
| 7 | state/match.ts | form fields/actions; clampLegs(bookSize); publishLobby; derived spec/salts/settleAt/targetScale/oddsBoost/deadline/secondsLeft | 3,5,6,8 |
| 8 | views/Battles.tsx | mode filter chip row (own row, `ANY`) | N2 |
| 9 | ui/LobbyCards.tsx | A2 + A3 | 7 |
| 10 | views/Room.tsx | tag row: LOBBY · market · sectorChips(sectors,6) · mode·15 MIN · 3 LEGS · 1V1 (full untruncated); body copy "book is N names across {labels}"; STEPS gains a mode line ("DUEL — 15 min of tape in 2.2s"). Both players see sectors+mode before readying | 2,7 |
| 11 | components/MatchSpin.tsx | `sectors` prop; header gains sectorChips; assets fed from bookOf via App; footer "{n} names from {labels}"; tile tags → group label/colour | 2,7,N7 |
| 12 | views/Study.tsx | settleAt + mode props; buildChartCard(sym,salt,settleAt,110); mode badge beside STUDY PHASE chip; READ 02 mentions window length | 5,7 |
| 13 | views/ParlayPick.tsx | scaled targets arrive via derived; `BLITZ +35%` under multiplier; countdown chip; mode badge | 5,7,8 |
| 14 | views/Live.tsx | settleAt+mode props; progress=pos/settleAt; badge `{label} · {duration} · TAPE ×{compression}`; progress bar takes mode.color, pulses on BLITZ | 5,7 |
| 15 | views/Result.tsx | settleAt prop → legState(l,salt,settleAt); mode+sector line in winner header; XP handled by plan 4 | 5,7,N1 |
| 16 | state/ledger.ts | SettledRecord gains mode + xp; useLedger derives xp/streak/best; XP_FOR per mode | N1 |
| 17 | App.tsx | assets={bookOf(lobby).map(meta)} (correctness fix); threads sectors/mode/settleAt/secondsLeft; mode into ledger.settle | 2,5,N1 |
| 18 | lib/route.ts | `?seed=N&m=BLITZ&s=SEMIS.TECH`; initialState reconstructs synthetic LobbyDef when lobbyId not in LOBBIES | N6 |
| 19 | README.md | determinism diagram gains sectors→book and mode→salt/settleAt/targets/odds arms | close-out |

Replay stays exact because sectors and mode are LobbyDef properties addressed by `:id`; nothing new enters the RNG path. Rows 4 and 17 are the two silent-corruption spots (fixture without sectors ⇒ `bookOf → []` throws; stale `bookFor(lobby.market)` at App.tsx:160 ⇒ reel animates a different strip than planned).
