# BUILD-ORDER — the authoritative schedule for plans 1–4

Instructions for builder agents. Follow verbatim. Do not re-decide anything in §A.

Baseline verified on branch `main` @ `786d6d7`: `bun test` = 71 pass / 0 fail, `bun run typecheck` clean, `docs/` untracked.

---

## A. Conflict resolutions

### A-a. SFX module — ONE path, typed union, derived from the map

- **Build `src/lib/sound/`. `src/lib/sfx.ts` is FORBIDDEN — never create it.** Plan 4 §10's `src/lib/sfx.ts` seam is void; plan 4 lands after the sound engine and imports the real module.
- Every caller imports from `src/lib/sound/index.ts` only. No view imports `engine.ts`, `map.ts`, `voices.ts` or `budget.ts` directly.
- **Union growth mechanism.** `map.ts` declares the event table as one object literal and derives the union from it:
  ```ts
  export const SFX_MAP = { "ui.hover": {...}, /* … */ } as const satisfies Record<string, SfxRecipe>;
  export type SfxName = keyof typeof SFX_MAP;
  ```
  `index.ts` re-exports `SfxName`. Adding an event = adding one key. The completeness test iterates `Object.keys(SFX_MAP)` so it can never drift from the union.
- **Register all 61 names in wave 1**, including plan 4's `rank.*` / `ladder.*` and plan 1's `countdown.*`, even though their call sites land later. Recipe mapping for the late events is pinned in §C-2.
- Plan 1 introduces **no new event names**. Its needs are covered by `ui.toggle.on/.off` (sector chips, mode buttons, Battles filters), `ui.step` (steppers), `ui.disabled` (gated Publish), `countdown.*` (Blitz clock) and `setPalette(mode)`.

### A-b. Result.tsx — three plans, one order

Edit order is **plan 1 → plan 3 → plan 4**. Never reorder.

1. **W4 (plan 1):** add `settleAt`, `mode`, `sectors` props; `legState(l, p.salt, p.settleAt)` replaces `legState(l, p.salt, TAPE_LEN)` at the current line 136; drop the `TAPE_LEN` import; add the mode+sector line to the winner header.
2. **W5 (plan 3):** wrap the `data-testid="points-won"` figure in `useCountUp(target, { steps: 24 })`. Nothing else in Result.
3. **W6 (plan 4):** wrap the three existing blocks in `<div data-debrief>`, add the `Phase` gate, `NextBar`, `RankUpSequence`, `ExitRow`. The three blocks stay in the DOM (dimmed) — never unmount them.

**Plan 1's N1 Result XP chip is DEAD. Do not build it.** XP is presented only inside `RankUpSequence`.

Final composition, top to bottom: `<div data-debrief>`(winner banner → coach grid → scoreboards)`</div>` · `NextBar` at `phase==="debrief"` · `RankUpSequence` at `phase!=="debrief"` · `ExitRow` at `phase==="done"`.

The count-up runs on mount, at debrief phase, un-gated — it is the banked-PTS figure, part of the debrief, not part of the XP moment.

### A-c. Study.tsx — NewsWire first, stagger inside it

Edit order **plan 2 → plan 1 → plan 3**.

1. **W2 (plan 2):** delete the inline wire block (current lines 114–152) and render `<NewsWire/>`. Props `briefs` → `wire` + `wireStatus`.
2. **W4 (plan 1):** add `settleAt` and `mode` props; `buildChartCard(sym, salt, settleAt, 110)`; mode badge beside the STUDY PHASE chip; READ 02 mentions the window length.
3. **W5 (plan 3):** `startAmbience("study")` / `stopAmbience("study")` on tab enter/leave, driven from `useMatchSound` — **not** from Study.tsx. `ui.click.primary` on "Done studying".

**Plan 3 step 7's "stagger wire.tick per headline over the briefs map" is DELETED.** That line does not exist after W2. The stagger lives **inside `NewsWire.tsx`**, built there at creation in W2 (the sound module already exists from W1): a `useEffect` keyed on `items[0]?.id + items.length` firing `sfx("wire.tick", { delayMs: i * 90 })` for the first 6 news rows, and `sfx("wire.select")` in the row `onClick`. NewsWire owns both wire seams from birth — zero rework.

### A-d. state/match.ts — one edit sequence

| Order | Wave | Change |
|---|---|---|
| 1 | W2 | plan 2: ONE additive line in `derived` — `matchKey` (§C-5). Nothing else. |
| 2 | W3 | plan 1: `LobbyForm.sectors`; `setFormPreset` / `toggleFormSector`; `clampLegs(n, max)`; `publishLobby` writes `sectors`; `spinCase(bookOf(lobby), …)` behind the `canPlay` guard. |
| 3 | W4 | plan 1: derived rewrite (`spec`, `MODE_SALT` salts, `pos` vs `settleAt`, `targetScale`, `oddsBoost`, `raceDone`, export `mode`); `LobbyForm.mode` + `setFormMode`; `MatchState.deadline` + `derived.secondsLeft` + auto-lock in the 120ms interval. |
| 4 | W5 | plan 3: `useMatchSound(state, derived)` called after the `derived` useMemo, before `return`. |
| 5 | W7 | plan 4: add `"ranks"` to the `inMatch` exclusion set in `initialState` (currently line 82). **Address it by content, not line number — the line has moved by then.** |

### A-e. App.tsx — one edit sequence

| Order | Wave | Change |
|---|---|---|
| 1 | W1 | `useSoundUnlock()` as the first hook call in `App`. |
| 2 | W2 | `newsSource: NewsSource = mockNewsSource` prop; `wire` + `wireStatus` to Study. |
| 3 | W3 | **`assets={bookOf(lobby).map(meta)}`** at line 160 (silent-corruption fix); `sectors` prop to MatchSpin. |
| 4 | W4 | thread `derived.mode` + `derived.settleAt` into Live / Result / Study; `derived.secondsLeft` into ParlayPick; `sectors` into Result. |
| 5 | W6 | `ledger.settle` gains `mode`, `xp`, `sectors`; rank props into Result. |
| 6 | W7 | `{tab === "ranks" && <Ranking …/>}`; `onOpenLadder` into Result. **Do NOT add `"ranks"` to `MATCH_STAGES`** — it carries no lobby or seed. |

### A-f. test/app.test.tsx — one edit sequence, and the rank gate

| Wave | Change |
|---|---|
| W2 | Repoint the 2 "case study" tests: `[data-brief="news"]` → `[data-wire="news"]` (assert `length >= arena.length`, every dealt sym present in `[data-wire-sym]`); `[data-brief]` → `[data-wire]`. Keep the `[data-brief="desk"]` length-2 assertion — NewsWire desk rows carry BOTH `data-brief="desk"` and `data-wire="desk"`. Add: detail pane non-empty before any click; row click swaps dateline + detail; status chip reads SEEDED. |
| W3 | Add sector tests. Publish MEME+TECH ⇒ card reads MIXED, book 4 names; MEME-alone at 4 legs disables Publish. |
| W4 | Add mode tests. BLITZ card shows its badge; countdown chip present on BLITZ / absent on NORMAL; auto-lock past the deadline. |
| W6 | Add `throughRank()`; edit the 2 result tests; add gate / rank-text / copy-panel tests. |
| W7 | Add `/ranks` tests. |

**Gate rule, binding from W6 onward:**
```ts
function throughRank() { click("Next → your rank"); click("Skip ↦"); }
```
- A test that asserts on an **exit button** (`"Back to battles"`, `"Rematch · new lobby"`, `"View the full ladder →"`) or on **rank/copy content** MUST call `throughRank()` first.
- A test that asserts only **debrief content** (winner banner, `4.80 ETH`, `Coach · match summary`, `[data-summary=…]`, `WHAT DECIDED IT`, `/PTS/`) MUST NOT call it — those nodes are dimmed, never unmounted.
- **Plan 1's "same seed, different mode ⇒ different settled percentages" test is written against the DUEL tab** (`/match/:id/duel?seed=N`), not the result tab. It never touches the gate. This is mandatory, not a preference.
- **Plan 3's `useCountUp` must return the target synchronously** when `!audioAvailable || prefersReducedMotion()`. In happy-dom `audioAvailable` is `false`, so `/PTS/` at line 476 resolves on the same synchronous mount, at debrief phase, before the gate. Do not make the count-up async-only.
- `RankUpSequence` must `cancelAnimationFrame` on unmount and take the synchronous park path when `matchMedia("(prefers-reduced-motion: reduce)").matches` or `requestAnimationFrame` is missing. In tests `matches` is `false`, so the rAF loop does start — `throughRank()`'s synchronous skip is what parks it.

### A-g. Riser trigger — `settleAt`, and a scaled duration

Plan 3's `TAPE_LEN * 0.85` is wrong once modes land. Replace with:
```ts
if (derived.pos >= derived.settleAt * 0.85) startRiser(Math.max(320, derived.settleAt * 6));
```
`settleAt * 6` is the exact wall-clock remainder: `settleAt * 0.15 / TAPE_STEP * 120`. NORMAL 1200ms · QUICK 660ms · BLITZ 336ms. Plan 3's flat `1600` overruns every mode and would be cut off by `stopRiser` — do not use it.

### A-h. MATCH_TTL_MS — 1_800_000 is correct; plan 2's stated rule is wrong

Plan 2 says the TTL "must exceed the longest study duration from plan 1's modes". **That reasoning is wrong and must not be followed.** Plan 1's mode minutes (15 / 60 / **1440**) are *simulated window* labels printed on badges; they are not wall-clock. Study is untimed; `pickSeconds` (20 / 45 / null) bounds the parlay phase, not study.

The bound that actually matters is the **wall-clock gap between the first and last `/api/news` request for the same `matchKey`** (StrictMode remount, a navigate-away-and-back to `/match/:id/study?seed=N`, a second player on the same seed). **Keep `MATCH_TTL_MS = 1_800_000` (30 min).** Do NOT raise it to 24h chasing NORMAL's label. Record the corrected rationale in the constant's doc comment.

### A-i. Ledger schema — N1's ledger half is PROMOTED to must-have

Plan 1 N1's `SettledRecord` extension ships as a **must-have in W6**, alongside plan 4's consumers. Plan 1 N1's Result XP chip does **not** ship (see A-b). Plan 4's `sectors?:` optionality is dropped — all three fields are **required**; `App.tsx`'s `settle()` is the only writer. Final schema in §C-3.

### A-j. LobbyCards.tsx — sound first, structure second

1. **W1 (plan 3):** `card.hover` as one `onPointerEnter` on the existing outer `.vc-lobby` div (line 46); `card.accept` / `card.start` on the CTA (line 142). **Do not wrap the card in a new element** — `app.test.tsx:65` does `card.querySelector("button")`, `:97`/`:138` count `[data-lobby]`.
2. **W3 (plan 1 A2/A3):** restructure the top-right badge into a column and the tag row into the book row. **Must not remove or relocate the outer div's `onPointerEnter`.** Keep `details.children.length === 3` and the `"3 LEGS"` / `"most legs wins"` strings.

### A-k. Everything else found

**k1 — plan 1's sector table is WRONG and breaks its own test.** `COIN` (`sector: "EQUITY-BETA"`, line 14 of universe.ts) is `mkt: "STOCK"`, but plan 1 puts `EQUITY-BETA` in `MAJORS` and then claims "MAJORS+DEFI+MEME = the 10 crypto". The universe is **9 stocks + 9 crypto**, not 8 + 10. As written: `marketOf(["MAJORS"])` returns `"MIXED"`, not `"CRYPTO"`; the `mi-majors` fixture's derived market stops matching its literal; the planned "presets ≡ bookFor" test FAILS; and `app.test.tsx:316` (`bookFor("CRYPTO")` ⊇ mi-majors' dealt syms) BREAKS.

**Corrected taxonomy — build this table, not plan 1's:**

| Key | Label | Raw sectors | Tickers | n | Colour |
|---|---|---|---|---|---|
| `SEMIS` | SEMIS | `SEMIS` | NVDA, AMD | 2 | `C.green` |
| `TECH` | BIG TECH | `TECH`, **`EQUITY-BETA`** | AAPL, META, **COIN** | 3 | `C.blue` |
| `MACRO` | OLD WORLD | `AUTO`,`ENERGY`,`FIN`,`METALS` | TSLA, XOM, JPM, GLD | 4 | `C.amber` |
| `MAJORS` | MAJORS | **`L1` only** | BTC, ETH, SOL | 3 | `C.accent` |
| `DEFI` | DEFI | `DEFI`,`ORACLE`,`L2` | ARB, LINK, UNI, AAVE | 4 | `C.violet` |
| `MEME` | MEME | `MEME` | DOGE, PEPE | 2 | `#f472b6` |

SEMIS+TECH+MACRO = the 9 stocks; MAJORS+DEFI+MEME = the 9 crypto. The partition is clean. All six fixtures stay valid: `kz-semis ["SEMIS","TECH"]` 5 names ≥ 3 legs, derives STOCK ✓ · `mi-majors ["MAJORS"]` 3 ≥ 2, CRYPTO ✓ · `dr-mixed ["SEMIS","MAJORS"]` 5 ≥ 4, MIXED ✓ · `lx-degen ["MEME","DEFI"]` 6 ≥ 3, CRYPTO ✓ · `no-grind ["MACRO"]` 4 ≥ 2, STOCK ✓ · `ar-whale ["MACRO","DEFI"]` 8 ≥ 4, MIXED ✓.

`app.test.tsx:435-443` (×47.52 / 1.4% / 8.8%) is safe: those are card-multiplier products, independent of which tickers are dealt, and `kz-semis` stays NORMAL so `oddsBoost === 1`.

**k2 — `modeTag` must NOT live in theme.ts (circular import).** `theme.ts` imports nothing today; `data/modes.ts` imports `C` from it. Putting `modeTag(mode)` in theme.ts creates `theme → data/modes → theme`. **Put `miniTag(color)` in `theme.ts` (pure) and `modeTag(mode)` in `src/data/modes.ts`.**

**k3 — `sectorChips` would also cycle.** It needs `MARKET_COLOR`, which lives in `data/lobbies.ts`, which must import `bookForSectors` from `data/sectors.ts`. **Fix in W3-A: move `MARKET_LABEL`, `MARKET_COLOR`, `MARKET_WALL` and `bookFor` out of `data/lobbies.ts` into `data/sectors.ts`, then re-export all four verbatim from `data/lobbies.ts`** (`export { MARKET_LABEL, MARKET_COLOR, MARKET_WALL, bookFor } from "./sectors.ts";`). Every existing import path stays green, including `test/spin.test.ts` and `test/app.test.tsx`. `bookFor`'s behaviour must not change — plan 2's determinism test hard-codes `spinCase(bookFor("STOCK"), 3, 424242).syms`.

**k4 — styles.css: single owner, additive only.** Only plan 4 touches it (W6-D): ~9 new keyframes. **Extend** the existing reduced-motion block (line 120) to `[data-art] *, [data-rank] *, [data-ladder] * { animation: none !important }` — do not replace it. Plan 3 needs no new keyframes (reuses `vcPulse`). Plan 1's `modeTag` BLITZ pulse reuses `vcPulse`.

**k5 — README.md: ONE pass, in W7.** Plans 1, 2 and 4 all want README edits. Forbid README edits before W7; W7-D writes all three (determinism diagram gains the sectors→book and mode→salt/settleAt/targets/odds arms; the news-wire architecture + `THETADUEL_NEWS=off`; the rank/ladder loop).

**k6 — route.ts: `/ranks` before URL params.** W7-A adds the `"ranks"` branch to `parseRoute`/`routePath` and the doc-comment table. Plan 1 N6 (`?seed=N&m=BLITZ&s=SEMIS.TECH` + synthetic-LobbyDef reconstruction) is W8, and by then must reconstruct `sectors` AND `mode` AND a synthetic id — it is the largest nice-to-have; cut it first.

**k7 — types.ts: three sequential touches, one owner per wave.** W3 `SectorKey` + `Mode` unions + `LobbyDef.sectors` · W4 `LobbyDef.mode` · W7 `Tab | "ranks"`. Never parallel.

**k8 — Header.tsx: two touches.** W1 adds `SoundToggle` (sibling of `StarfieldButton` in the flex row) + `nav.click`/`ui.hover` on nav buttons. W7 adds `{ key: "ranks", label: "Ranking" }` to `NAV`. **`"ranks"` must NOT be added to `MATCH_FLOW`** or it lights the Battles tab. `SoundToggle` is glyph-only (`♪` / `♪⃠`) — it collides with no exact-label matcher and is not `"+"`.

**k9 — CreateLobby.tsx: plan 1 rewrites it, so plan 3's sounds land AFTER.** Plan 3 step 8 is deferred from W1 into W3-C and executed by the same agent that does plan 1's sector picker + mode picker, in one file pass. Keep the three BOOK preset buttons verbatim in position and label (`clickContaining("CRYPTO")`), add **no** button labelled exactly `"+"` before the prize stepper (`plus[1]`), and add **no** second `<input>` without `inputmode` (`input:not([inputmode])`).

**k10 — MatchSpin / Room / ParlayPick: sounds before structure.** W1 wires plan 3's handlers; W3/W4 add plan 1's `sectors`/mode props and header chips. Same file, later wave, must preserve the handlers.

**k11 — Footer.tsx is untouched.** Plan 2's status surface is the `data-testid="wire-status"` chip in NewsWire's header, not the Footer. Do not add a `newsSource` read to Footer.

**k12 — plan 2's determinism guard must not be weakened.** `test/determinism.test.ts` asserts `src/engine/*.ts` and `src/state/match.ts` contain no `/data\/news|data\/wire|\/api\/news/`. W5 adds `import … from "./matchSound.ts"` to `state/match.ts` — that does not match, and the regex must not be broadened to catch it.

**k13 — `spin.test.ts:88` update.** `expect(bookFor(l.market).length)` → `expect(bookOf(l).length)` in W3-B, and add `expect(marketOf(l.sectors)).toBe(l.market)` for every fixture.

**k14 — `engine/match.ts:128` tapeBias.** `pctAt(s, salt, TAPE_LEN)` must become `pctAt(s, salt, pos)` in W4-A alongside `edgeOf` and `readPlayer`. Plan 1 says "the three hardcoded TAPE_LEN uses" — they are lines 20, 42 and 128. Behaviour is identical at `pos === TAPE_LEN`, so `engine.test.ts` stays green.

---

## B. Wave schedule

7 build waves + 1 optional. Every wave ends with `bun run typecheck` clean, `bun test` fully green, and ONE git commit (§D).

Parallel-group ids are wave-local. Items sharing a `P<n>` may run as concurrent subagents — their file sets are fully disjoint. `SERIAL` items run in listed order after their group completes. **`state/match.ts`, `App.tsx`, `types.ts`, `theme.ts`, `styles.css`, `Result.tsx`, `Study.tsx` and `test/app.test.tsx` never appear in a parallel group.**

### Wave 1 — "Everything is audible; the reel clicks"
Demo: click anything and hear it; the spin ticks like CS:GO and lands with a latch.

| Item | Plan | Steps | Files touched | Depends on | Group |
|---|---|---|---|---|---|
| 1A | 3 | step 0 (engine) | NEW `src/lib/sound/{budget,voices,map,engine,react,index}.ts` | — | **P1** |
| 1B | 4 | step 1 (partial) | NEW `src/lib/hash.ts`; `src/components/CardArt.tsx` (import swap only) | — | **P1** |
| 1C | 2 | step 1 | NEW `src/data/wire.ts`, NEW `test/wire.test.ts` | — | **P1** |
| 1D | 3 | step 0, step 2 (header) | NEW `src/ui/SoundToggle.tsx`; `src/ui/Header.tsx`; `src/App.tsx` | 1A | SERIAL |
| 1E | 3 | step 1, step 2 (room/board) | `src/components/MatchSpin.tsx`, `src/views/Room.tsx` (onBegin only), `src/ui/LobbyCards.tsx`, `src/components/StarfieldButton.tsx`, `src/views/Battles.tsx`, `src/views/Lobby.tsx` | 1A | **P2** |
| 1F | 3 | tests | NEW `test/sound.test.ts` (~19) | 1A | **P2** |

Plan 3 step 8 (CreateLobby sounds) is NOT in this wave — see A-k9; it moves into 3C.

### Wave 2 — "The news terminal"
Demo: Study is a two-pane terminal wire; SEEDED offline, LIVE with the server up.

| Item | Plan | Steps | Files touched | Depends on | Group |
|---|---|---|---|---|---|
| 2A | 2 (+3) | step 2 + wire seams | NEW `src/components/NewsWire.tsx` | 1A, 1C | SERIAL |
| 2B | 2 | steps 3, 4 | NEW `src/data/news.ts`, NEW `src/state/wire.ts`; `src/views/Study.tsx`, `src/App.tsx`, `src/state/match.ts` (matchKey line ONLY), `test/app.test.tsx` | 2A | SERIAL |
| 2C | 2 | step 5 | NEW `src/lib/rss.ts`, NEW `test/rss.test.ts` | — | **P1** |
| 2D | 2 | guard | NEW `test/determinism.test.ts` | — | **P1** |
| 2E | 2 | step 6 | NEW `src/server/news.ts`, NEW `test/news-service.test.ts`; `index.ts` (routes) | 2C | SERIAL |
| 2F | 2 | step 7 | `src/data/news.ts` (liveNewsSource), `src/client.tsx` | 2B, 2E | SERIAL |

### Wave 3 — "Sectors"
Demo: pick MEME+TECH in the builder, publish, the card shows sector chips, the reel deals from exactly that book.

| Item | Plan | Steps | Files touched | Depends on | Group |
|---|---|---|---|---|---|
| 3A | 1 | step 1 + A1 | `src/types.ts` (unions), NEW `src/data/sectors.ts`, `src/theme.ts` (`miniTag` only), `src/data/lobbies.ts` (move + re-export, A-k3), NEW `test/sectors.test.ts` | — | SERIAL |
| 3B | 1 | step 2 | `src/types.ts` (`LobbyDef.sectors`), `src/data/lobbies.ts` (fixtures, `bookOf`, `canPlay`), `src/state/match.ts`, `src/App.tsx` (line 160), `src/views/Room.tsx`, `src/components/MatchSpin.tsx`, `test/spin.test.ts` | 3A | SERIAL |
| 3C | 1 + 3 | step 3 + plan 3 step 8 | `src/views/CreateLobby.tsx`, `src/state/match.ts` (form) | 3B | SERIAL |
| 3D | 1 | step 7 (A2/A3) | `src/ui/LobbyCards.tsx` | 3B | SERIAL |
| 3E | 1 | tests | `test/app.test.tsx` (sector tests) | 3C, 3D | SERIAL |

### Wave 4 — "Game modes"
Demo: a BLITZ lobby settles in 2.2s on a 20-second pick clock and pays ×1.35.

| Item | Plan | Steps | Files touched | Depends on | Group |
|---|---|---|---|---|---|
| 4A | 1 | step 4 | NEW `src/data/modes.ts` (incl. `modeTag`, A-k2), `src/engine/match.ts` (pos + `driftOf` tie-break), `src/engine/parlay.ts`, `src/data/briefs.ts`, NEW `test/modes.test.ts` | 3A | SERIAL |
| 4B | 1 | step 5 | `src/types.ts` (`LobbyDef.mode`), `src/data/lobbies.ts` (modes), `src/state/match.ts` (derived), `src/App.tsx`, `src/views/Live.tsx`, `src/views/Result.tsx`, `src/views/Study.tsx` | 4A | SERIAL |
| 4C | 1 | step 6 | `src/views/CreateLobby.tsx`, `src/state/match.ts` (`setFormMode`, `publishLobby`) | 4B | SERIAL |
| 4D | 1 | step 7 | `src/ui/LobbyCards.tsx`, `src/views/Room.tsx`, `src/components/MatchSpin.tsx`, `src/views/ParlayPick.tsx` | 4B | SERIAL |
| 4E | 1 | step 8 | `src/state/match.ts` (`deadline`, `secondsLeft`, auto-lock), `src/views/ParlayPick.tsx`, `src/App.tsx` | 4C, 4D | SERIAL |
| 4F | 1 | tests | `test/app.test.tsx` (mode tests — duel tab only, A-f) | 4E | SERIAL |

### Wave 5 — "The duel has a soundtrack"
Demo: a full match — study bed, parlay latch, leg hits with the combo ladder, the riser into the settle, the win sting.

| Item | Plan | Steps | Files touched | Depends on | Group |
|---|---|---|---|---|---|
| 5A | 3 | steps 3, 4, 5, 9 | NEW `src/state/matchSound.ts`; `src/state/match.ts` (hook call), `src/views/Room.tsx`, `src/views/ParlayPick.tsx`, `src/views/Study.tsx` (`ui.click.primary` only) | W4 | SERIAL |
| 5B | 3 | step 6 | `src/views/Result.tsx` (`useCountUp` only), `src/lib/sound/react.ts` | 5A | SERIAL |
| 5C | 3 | tests | `test/sound.test.ts` (`diffWon`, combo ladder, palette) | 5A | SERIAL |

`setPalette(lobby.mode)` is wired inside `useMatchSound`, on mode change. Riser per A-g.

### Wave 6 — "The rank moment"
Demo: settle a duel, press "Next → your rank", the sigil drops, the XP bar fills through a division crossing, the copy-trade panel counts up.

| Item | Plan | Steps | Files touched | Depends on | Group |
|---|---|---|---|---|---|
| 6A | 4 | step 2 | `src/data/rewards.ts` (additive), NEW `src/engine/rank.ts`, NEW `test/rank.test.ts` | — | **P1** |
| 6B | 1 + 4 | N1 ledger half (promoted) + §3 delta | `src/state/ledger.ts` (§C-3) | — | **P1** |
| 6C | 4 | step 4 | `src/styles.css` (additive keyframes, A-k4), NEW `src/components/RankBadge.tsx` | 6A | SERIAL |
| 6D | 4 | step 3 | NEW `src/data/leaderboard.ts` (+ generator tests in `test/rank.test.ts`) | 6A, 1B | SERIAL |
| 6E | 4 | step 5 | NEW `src/state/rank.ts`, NEW `src/components/RankUpSequence.tsx`; `src/views/Result.tsx`, `src/App.tsx` | 6B, 6C, 6D | SERIAL |
| 6F | 4 | step 8 tests | `test/app.test.tsx` (`throughRank()` + 2 edits + gate/rank/copy tests) | 6E | SERIAL |

### Wave 7 — "The ladder"
Demo: /ranks is navigable, filters compose, your row climbs after a duel, Result links straight to it.

| Item | Plan | Steps | Files touched | Depends on | Group |
|---|---|---|---|---|---|
| 7A | 4 | step 6 (routing) | `src/types.ts` (`Tab`), `src/lib/route.ts`, `src/ui/Header.tsx`, `src/state/match.ts` (A-d row 5), `src/App.tsx` | W6 | SERIAL |
| 7B | 4 | step 6 (page) | NEW `src/views/Ranking.tsx`, NEW `src/ui/LadderRow.tsx` | 7A | SERIAL |
| 7C | 4 | step 7 | `src/views/Ranking.tsx`, `src/ui/LadderRow.tsx` (podium, 4 filters, sector×mode chips, `ladder.*`) | 7B | SERIAL |
| 7D | 4 | step 8 | `src/views/Ranking.tsx` (you-row pin + nudge), `src/views/Result.tsx` (`View the full ladder →`), `src/App.tsx` | 7C | SERIAL |
| 7E | 1+2+4 | close-out | `README.md` (ONE pass, A-k5) | 7D | SERIAL |
| 7F | 4 | tests | `test/app.test.tsx` (`/ranks` tests) | 7D | SERIAL |

### Wave 8 — OPTIONAL nice-to-haves

Ship top-down; stop wherever time runs out. Each still ends with the full gate + one commit.

| # | Item | Plan | Files | Group |
|---|---|---|---|---|
| 1 | Mode filter chip row on Battles (`ANY`, own row) + XP/streak chip beside BALANCE | 1 N2 / N1-display | `src/views/Battles.tsx` | **P1** |
| 2 | NewsWire ↑/↓ nav, per-ticker filter chips, rate-limited refresh | 2 nice | `src/components/NewsWire.tsx` | **P1** |
| 3 | Mode-aware `windowLabel` (`TUE 09:15 · 09:30` for Blitz) | 1 N4 | `src/engine/tape.ts` | **P1** |
| 4 | Group labels on reel tiles (raw sector → group label + colour) | 1 N7 | `src/components/MatchSpin.tsx` | **P1** |
| 5 | Volume slider, first-visit sound nudge, stereo panning | 3 nice | `src/ui/SoundToggle.tsx`, `src/lib/sound/*` | **P1** |
| 6 | Result flourishes: SWEEP badge, `SURVIVED THE BLITZ` on a 0–0 drift win | 1 N5 | `src/views/Result.tsx` | SERIAL |
| 7 | Ladder row drawer, podium sparklines, stage-5 ladder counter, `LadderField` hero | 4 nice | `src/views/Ranking.tsx`, `src/ui/LadderRow.tsx` | SERIAL |
| 8 | Mode-tinted card art (`MODE_WALL` blend / 3px mode stripe) | 1 N3 | `src/ui/LobbyCards.tsx`, `src/data/modes.ts` | SERIAL |
| 9 | Mode/sectors in the URL + synthetic LobbyDef reconstruction | 1 N6 | `src/lib/route.ts`, `src/state/match.ts` | SERIAL |

**Cut order is bottom-up: #9 goes first.** It is the only nice-to-have that can break replay determinism — it must reconstruct `sectors`, `mode` AND a synthetic lobby id.

---

## C. Contracts — pinned cross-plan interfaces

These are binding signatures. Do not vary them.

### C-1. Sound module

Path: `src/lib/sound/` · public surface `src/lib/sound/index.ts` · **`src/lib/sfx.ts` must not exist.**

```ts
export type Tier = "ambient" | "ui" | "action" | "event" | "moment";
export type SfxName = keyof typeof SFX_MAP;           // derived from map.ts, never hand-written
export interface SfxOpts { pitch?: number; gain?: number; pan?: number; delayMs?: number; leg?: number; tier?: never }
export function sfx(name: SfxName, opts?: SfxOpts): boolean;
export function startAmbience(id: "study" | "duel"): void;
export function stopAmbience(id: "study" | "duel"): void;
export function startRiser(durationMs: number): void;
export function stopRiser(resolve?: boolean): void;
export function setPalette(p: Mode): void;             // Mode from src/types.ts once W3 lands; "NORMAL" until then
export function isSoundOn(): boolean;
export function setSoundOn(on: boolean): void;
export function subscribeSound(fn: () => void): () => void;
export const audioAvailable: boolean;
export function __setTestSink(fn: ((n: SfxName, o?: SfxOpts) => void) | null): void;
```

`startAmbience("study")` renders the `study.enter` bed; `startAmbience("duel")` renders `duel.start`. Never call `sfx("study.enter")` directly.

### C-2. Final `SfxName` list — 61 names, all registered in W1

**global (11)** `ui.hover` · `ui.click` · `ui.click.primary` · `ui.toggle.on` · `ui.toggle.off` · `ui.back` · `ui.step` · `ui.disabled` · `nav.click` · `nav.transition` · `wallet.connect`

**spin (6)** `spin.tick` · `spin.land` · `spin.reveal` · `spin.lock` · `spin.skip` · `spin.open`

**room (7)** `card.hover` · `card.accept` · `card.start` · `room.ready.me` · `room.ready.opp` · `room.bothready` · `lobby.publish`

**study (4)** `study.enter` · `wire.tick` · `wire.select` · `wire.alert`

**parlay (4)** `parlay.card.hover` · `parlay.card.pick` · `parlay.slip.change` · `parlay.lock`

**duel (7)** `duel.start` · `duel.tape.tick` · `duel.leg.hit` · `duel.leg.hit.opp` · `duel.leg.miss` · `duel.riser` · `duel.settle.ready`

**result (4)** `result.win` · `result.loss` · `result.count` · `result.count.done`

**countdown (3)** `countdown.beep` · `countdown.final` · `countdown.expire`

**rank (10)** `rank.enter` · `rank.reveal` · `rank.xpTick` · `rank.divisionUp` · `rank.up` · `rank.ladder` · `rank.copyUnlock` · `rank.copyPanel` · `rank.done` · `rank.skip`

**ladder (5)** `ladder.filter` · `ladder.chip` · `ladder.chipClear` · `ladder.rowHover` · `ladder.rowOpen`

**Recipe mapping for the rank/ladder events** (build these in W1 by reusing the named recipe with the stated modifier — no new synthesis work):

| Name | Recipe | Tier | Cooldown |
|---|---|---|---|
| `rank.enter` | `spin.open` @ gain 0.8 | event | 400 |
| `rank.reveal` | `spin.reveal` with `leg: 0` | event | 400 |
| `rank.xpTick` | `result.count` | ui | **60** |
| `rank.divisionUp` | `spin.reveal` @ pitch 1.12, gain 0.75 | event | 400 |
| `rank.up` | `result.win` without the pad tail | moment | 400 |
| `rank.ladder` | `result.count.done` | action | 120 |
| `rank.copyUnlock` | `spin.lock` | moment | 400 |
| `rank.copyPanel` | `ui.click.primary` @ gain 0.9 | action | 120 |
| `rank.done` | `duel.settle.ready` @ gain 0.8 | event | 400 |
| `rank.skip` | `spin.skip` | action | 120 |
| `ladder.filter` | `ui.toggle.on` | action | 40 |
| `ladder.chip` | `ui.toggle.on` @ pitch 1.08, gain 0.85 | action | 40 |
| `ladder.chipClear` | `ui.toggle.off` | action | 40 |
| `ladder.rowHover` | `ui.hover` @ pitch 0.92, gain 0.7 | ui | 70 |
| `ladder.rowOpen` | `ui.click` | action | 40 |

R2's hover budget keys on names ending in `.hover`, so `ladder.rowHover`, `card.hover` and `parlay.card.hover` are all swept by it automatically.

### C-3. `SettledRecord` — final schema

```ts
// src/state/ledger.ts
export interface SettledRecord {
  lobbyId: string;
  seed: number;
  stake: number;
  points: number;
  won: boolean;
  mode: Mode;                        // required — App.tsx is the only writer
  xp: number;                        // required
  sectors: readonly string[];        // required — arena.map(s => meta(s).sector), RAW sector strings
}

export const XP_FOR: Record<Mode, number> = { BLITZ: 120, QUICK: 80, NORMAL: 50 };
```

XP is computed in `App.tsx`'s `settle()`, nowhere else:
```ts
const sweep = v.meWins && v.myScore === derived.myLegs.length;
const xp = Math.round(XP_FOR[lobby.mode] * (v.meWins ? (sweep ? 2 : 1) : 0.4));
```
Range 20–240. `useLedger` additionally derives and returns:
```ts
xp: number       // Σ history[i].xp
streak: number   // count of leading history entries with won === true (history[0] is newest)
best: number     // max streak ever seen
```

### C-4. Sector / mode helper signatures

```ts
// src/data/sectors.ts — imports only ./universe.ts and ../theme.ts. NEVER imports ./lobbies.ts.
export interface SectorDef { key: SectorKey; label: string; members: readonly string[]; color: string; blurb: string }
export const SECTORS: Record<SectorKey, SectorDef>;
export const SECTOR_ORDER: readonly SectorKey[];              // SEMIS, TECH, MACRO, MAJORS, DEFI, MEME
export function sectorOf(rawSector: string): SectorKey;
export function symsOfSector(key: SectorKey): readonly string[];
export function bookForSectors(keys: readonly SectorKey[]): readonly string[];   // filters UNIVERSE, never the keys
export function marketOf(keys: readonly SectorKey[]): MarketFilter;
export const PRESETS: Record<MarketFilter, readonly SectorKey[]>;
export function presetOf(sectors: readonly SectorKey[]): MarketFilter | null;
export function sectorChips(sectors: readonly SectorKey[], max?: number): { key: string; label: string; color: string }[]; // default max 6
// MOVED HERE from data/lobbies.ts, then re-exported from there verbatim (A-k3):
export const MARKET_LABEL: Record<MarketFilter, string>;
export const MARKET_COLOR: Record<MarketFilter, string>;
export const MARKET_WALL: Record<MarketFilter, [string, string, number]>;
export function bookFor(market: MarketFilter): readonly string[];   // behaviour MUST NOT change

// src/data/lobbies.ts
export { MARKET_LABEL, MARKET_COLOR, MARKET_WALL, bookFor } from "./sectors.ts";
export function bookOf(lobby: LobbyDef): readonly string[];         // = bookForSectors(lobby.sectors)
export function canPlay(lobby: LobbyDef): boolean;                  // = bookOf(lobby).length >= lobby.legs

// src/theme.ts — pure, imports nothing
export const miniTag = (color: string): string;

// src/data/modes.ts — imports ../theme.ts (C). modeTag lives HERE, not in theme.ts (A-k2).
export const modeTag = (mode: Mode): string;   // miniTag(MODES[mode].color) + vcPulse for BLITZ only
export const MODES: Record<Mode, ModeSpec>;
export const MODE_ORDER: readonly Mode[];      // BLITZ, QUICK, NORMAL
export const MODE_SALT: Record<Mode, number>;  // NORMAL 0, QUICK 1_000_003, BLITZ 2_000_029
export const MODE_WALL: Record<Mode, [string, string, number]>;
```

`sectorChips` returns exactly one collapsed chip (`ALL STOCKS` / `ALL CRYPTO` / `FULL BOARD`, coloured `MARKET_COLOR[m]`) when `presetOf` hits; otherwise sectors in `SECTOR_ORDER`, first `max`, then a `C.dim` `+N` overflow chip.

### C-5. The `matchKey` line

One additive line inside the `derived` useMemo in `src/state/match.ts`, exported on `derived`:
```ts
const matchKey = `${state.lobbyId ?? "none"}:${state.seed}`;
```
Null-safe — `lobby` can be null during render. Nothing else from plan 2 enters `state/match.ts` or `src/engine/**`; `test/determinism.test.ts` enforces it.

### C-6. `Result` — final prop list

```ts
interface ResultProps {
  verdict: MatchVerdict;
  you: Player;
  opponent: Player;
  myLegs: readonly ParlayLeg[];
  oppLegs: readonly ParlayLeg[];
  myMult: number;
  oppMult: number;
  pointsWon: number;
  salt: number;
  settleAt: number;                       // W4 — replaces TAPE_LEN in legState
  mode: ModeSpec;                         // W4 — winner-header mode line
  sectors: readonly SectorKey[];          // W4 — winner-header sector line
  prizeLabel: string;
  xpGain: number;                         // W6 — rendered ONLY inside RankUpSequence
  xpBefore: number;                       // W6
  xpAfter: number;                        // W6
  streak: number;                         // W6
  posBefore: number;                      // W6
  posAfter: number;                       // W6
  onBackToBattles: () => void;
  onRematch: () => void;
  onOpenLadder: () => void;               // W7
}
```

### C-7. `Study` — final prop list

```ts
interface StudyProps {
  arena: readonly string[];
  wire: readonly WireItem[];              // W2 — replaces `briefs`; desk lines are folded in by useWire
  wireStatus: "mock" | "live" | "partial"; // W2
  salt: number;
  settleAt: number;                       // W4 — buildChartCard(sym, salt, settleAt, 110)
  mode: ModeSpec;                         // W4 — badge beside the STUDY PHASE chip
  opponent: Player;
  prizeLabel: string;
  onDone: () => void;
}
```
The `briefs` prop is removed in W2. `Brief`/`briefsFor` survive and feed the desk exchange through `useWire`.

### C-8. `App` — final prop threading

```tsx
export function App({ source, newsSource = mockNewsSource, route }: {
  source: MarketSource; newsSource?: NewsSource; route?: Route;
})
```

| Component | Props App threads (final) |
|---|---|
| `MatchSpin` | `assets={bookOf(lobby).map(meta)}` ← **the correctness fix**; `sectors={lobby.sectors}`; `mode={derived.mode}`; existing props unchanged |
| `Study` | `arena` · `wire` · `wireStatus` · `salt={derived.studySalt}` · `settleAt={derived.settleAt}` · `mode={derived.mode}` · `opponent` · `prizeLabel` · `onDone` |
| `ParlayPick` | existing props · `mode={derived.mode}` · `secondsLeft={derived.secondsLeft}` |
| `Live` | existing props · `settleAt={derived.settleAt}` · `mode={derived.mode}` |
| `Result` | full list per §C-6 |
| `Ranking` | `ledger` · `onOpenBattles` |

`useSoundUnlock()` is the first hook call in `App`. `"ranks"` is added to neither `MATCH_STAGES` nor `Header`'s `MATCH_FLOW`.

### C-9. Where the `wire.tick` stagger lives

**Inside `src/components/NewsWire.tsx`**, written there in W2 at creation. Not in Study.tsx, not in useMatchSound, never on the old briefs map.

```ts
useEffect(() => {
  items.filter(i => i.kind === "news").slice(0, 6)
       .forEach((_, i) => sfx("wire.tick", { delayMs: i * 90 }));
}, [items[0]?.id, items.length]);
```
Plus `sfx("wire.select")` in the row `onClick`. Both are no-ops in tests (`audioAvailable === false`), so they cost zero timers.

---

## D. Verification gate — every wave must pass all nine

Run in order. A wave is not done until all nine pass. Do not open the next wave with a red gate.

1. **`bun run typecheck`** — clean, zero output.
2. **`bun test`** — fully green, **zero failures**, and the pass count is `71 + (new tests added so far)`. Never let the count drop.
3. **No test deleted or weakened.** Repointing a selector (`data-brief` → `data-wire`) is allowed only where §A-f authorises it. Loosening an assertion to make it pass is a gate failure.
4. **Manual demo.** Walk the wave's stated demo line end to end in the browser (`bun dev`) — the wave is judged on the demo, not the diff.
5. **Determinism intact.** `/match/kz-semis/parlay?seed=424242` deals the same tickers on two mounts; from W2 on, `test/determinism.test.ts` is green and `src/engine/**` + `src/state/match.ts` still contain no `data/news`, `data/wire` or `/api/news`.
6. **Sound is silent in tests.** No `AudioContext` constructed at module scope; `audioAvailable === false` under happy-dom; no new timers or rAF loops left running after a test unmounts.
7. **Contracts unchanged.** Nothing in §C was altered. If a builder believes a contract is wrong, they stop and escalate — they do not edit it.
8. **One commit**, message `Feat: <wave title>` (or `Fix:` where the wave is corrective), covering only that wave's files.
9. **File ownership respected.** Every file the wave touched appears in that wave's row of §B. A file touched outside its listed wave is a gate failure — re-open §B instead of improvising.

### Standing invariants — check at every gate from the wave they land

- `bookOf(lobby)` and the list handed to `MatchSpin` are the **same array contents in the same order** (App.tsx line 160). A mismatch is a silent, seed-dependent wrong-tile bug that no test catches.
- Every `LobbyDef` fixture has non-empty `sectors` with `bookOf(l).length >= l.legs`, and `marketOf(l.sectors) === l.market`.
- `kz-semis` and `mi-majors` stay `NORMAL` (pins ×47.52 / 1.4% / 8.8%).
- `MODE_SALT.NORMAL === 0` — today's demo stays byte-identical in NORMAL.
- `derived` never throws: `spinCase` is always behind the `canPlay` guard.
- `details.children.length === 3` on lobby cards; the `"3 LEGS"`, `"most legs wins"`, `"STOCKS"` and `"NEWS WIRE · DESK CHATTER"` strings survive verbatim.
- No button labelled exactly `"+"` is added before the prize stepper; no second `<input>` without `inputmode`.
- `[data-brief="desk"]` still selects exactly 2 rows on the study screen.
