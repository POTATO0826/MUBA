# Plan 4 — Platform ranking + copy-trade (Result rank sequence + /ranks ladder page)

Key discovery: `rewards.ts` is almost entirely dead code today (only `SEASON` is imported, by Battles.tsx) — `TIERS`, `PLAYER`, `MISSIONS`, `tierFor`, `nextTier`, `tierIndex` have zero call sites → free to extend.

## Codebase idioms & traps
Idioms: sx() CSS strings; keyframes in styles.css referenced as `animation:vcX`; determinism via seededRandom (LCG, engine/spin.ts) + FNV-1a/murmur hash (CardArt.tsx) + series cache; MatchSpin's synchronous `skipped` branch (parks final state, transition:none) is the testability pattern the rank sequence MUST copy; CardArt generative SVG = SMIL + CSS dash-offset + data-art + prefers-reduced-motion stilling.

Traps:
1. `state/match.ts:82` — initialState computes inMatch as "any tab not lobby|battles|create|desk"; a match tab with no lobby redirects to battles. **A new "ranks" tab bounces to /battles unless added to the exclusion list.**
2. Name collision: rewards.ts TIERS (season) vs engine/parlay.ts TIERS (cards); Result already imports TIER_COLOR from ParlayPick. Use RANK_TIERS / RankTier naming in rank code.
3. test/app.test.tsx:478 clicks "Back to battles" immediately after mounting result — gating breaks it (fix in §8).
4. App.tsx:79-91 calls ledger.settle() on duel→result, so when Result mounts the match is already history[0] — XP before/after derived accordingly.

## 1. File map
NEW (10): src/lib/sfx.ts (seam — export function sfx(name: string): void) · src/lib/hash.ts (FNV-1a+murmur lifted from CardArt) · src/engine/rank.ts (pure XP math, tier+division, crossings, timeline) · src/data/leaderboard.ts (seeded persona generator + filter/sort API) · src/state/rank.ts (useRankProgress(ledger)) · src/components/RankBadge.tsx (generative SVG sigil + progress ring) · src/components/RankUpSequence.tsx · src/views/Ranking.tsx · src/ui/LadderRow.tsx · test/rank.test.ts

EDIT (9+2): rewards.ts (additive: copy-trade fields, DIVISIONS, divisionFor, COPY_FEE) · types.ts (Tab gains "ranks") · lib/route.ts (/ranks) · ui/Header.tsx (NAV + {key:"ranks", label:"Ranking"}) · state/match.ts:82 (add "ranks" to non-match set) · state/ledger.ts (delta: SettledRecord.sectors) · views/Result.tsx (Next gate + sequence + gated exits) · App.tsx (Ranking route, rank props) · styles.css (~9 keyframes + reduced-motion [data-rank]/[data-ladder]) · CardArt.tsx (import hash from lib/hash) · test/app.test.tsx (2 edits + ~6 new)

## 2. Rank/tier model
Keep the five names + XP thresholds exactly (MINNOW 0 / FISH 500 / SHARK 1500 / ORCA 3000 / WHALE 6000). Add per-tier: `copyUnlocked` (SHARK+), `copierBase` (0/0/40/160/520), `feeShare` (COPY_FEE). `export const COPY_FEE = 0.035`. `export const DIVISIONS = ["III","II","I"]` (low→high).

Divisions rationale: with plan 1's XP (50–240/duel) a tier-up is 3–6 duels — too rare for a demo. Three equal divisions per tier → a division-up flourish every 2–4 duels; tier-up stays the rare loud moment. `rankAt(xp): RankPoint {tier, tierIndex, division 0|1|2, label "SHARK II", floor, ceil, into, span, pct}`. Division bands: floor = tier.xp + d·(next.xp−tier.xp)/3. WHALE uses a synthetic 3000-wide band.

### engine/rank.ts (pure, no DOM)
```ts
export type CrossKind = "division" | "tier";
export interface Segment { from; to; pct0; pct1; cross: CrossKind | null }
export interface Beat { t: number; stage: Stage; sound: string }
export interface Timeline { total: number; beats; segments }
export function xpSegments(before, after): Segment[];   // splits at every division/tier floor
export function rankTimeline(before, after, unlockedCopy): Timeline;
export function xpEase(t): number;                       // easeOutCubic
```
xpSegments makes the bar behave like a real game bar (fill→snap→continue per crossing). Skip = setElapsed(total).

### Copy-trade economics (in leaderboard.ts so Result panel and heatlist share one function)
```ts
export interface CopyEconomics { unlocked; copiers; txPerCopierPerDay; avgTicket; feePct /*0.035*/;
  perTx /*avgTicket*fee*/; daily; weekly; monthly; nextUnlock: {tier, xpAway, copiersAt} | null }
export function copyEconomicsFor(id: string, xp: number): CopyEconomics;
```
Deterministic, monotone in XP (the number always goes UP after a win): r = seededRandom(hash(id)); copiers = unlocked ? round(tier.copierBase · (0.75+0.5r) · (0.85+0.30·progressInTier)) : 0; avgTicket = 400 + round(2600·skill); txPerDay = 2+floor(r·5); daily = copiers·tx·ticket·0.035.

Panel shows: `SHARK II · COPY-TRADE ACTIVE` (or `LOCKED · 340 XP TO SHARK`); `N COPIERS` counting up before→after; `3.5% PER COPIED TRANSACTION` literal; `≈ X,XXX PTS / DAY` + 7D/30D dim lines; on tier cross `+K COPIERS UNLOCKED AT ORCA`; when locked `UNLOCK COPY-TRADE AT SHARK · 340 XP` + mini pip.

## 3. Result flow restructure
Keep the three existing blocks untouched (winner banner, coach grid, scoreboards). Only the button row (157–170) changes + a wrapper:
```
<div data-debrief style={dim}>  …existing blocks unchanged…  </div>
{phase === "debrief" && <NextBar onNext/>}
{phase !== "debrief" && <RankUpSequence … onDone/>}
{phase === "done"    && <ExitRow onBack onRematch onLadder/>}
```
dim = opacity:.34;saturate(.6);pointer-events:none while phase==="rank" (nodes stay in DOM → every debrief assertion still satisfied). NextBar: full-width 56px accent bar, vcSweep shimmer, "Next → your rank" + sub-line `SEASON 01 · +{xpGain} XP PENDING`. RankUpSequence scrollIntoView on mount. BOTH exits gated ("Back to battles", "Rematch · new lobby" render only at done) + new `View the full ladder →` (navigates /ranks).

State: `type Phase = "debrief" | "rank" | "done"`. Inside sequence: one `elapsed` from a single rAF loop vs timeline.total + `skipped` flag. Skip ↦ parks elapsed=total SYNCHRONOUSLY (no rAF, no transition), fires unfired beat sounds once (firedRef Set), calls onDone — same shape as MatchSpin skip. prefers-reduced-motion takes the same path on mount.

```ts
// src/state/rank.ts
useRankProgress(ledger): xpAfter = PLAYER.xp + Σ history.xp; lastXp = history[0]?.xp ?? 0;
xpBefore = xpAfter − lastXp; streak from plan 1's derivation (consumed);
before/after = rankAt(...); posBefore/posAfter = positionOf(...)  // ladder + Result agree by construction
```
App.tsx passes xpBefore/xpAfter/gain/streak/posBefore/posAfter into Result.

### Coordination with plan 1 — NO DOUBLE XP
Plan 1's N1 "+120 XP · streak" chip on Result must NOT ship — the XP moment is owned by this sequence behind the gate. Contract: Result receives `xpGain`/`streak` props rendered ONLY inside RankUpSequence (streak shows as `+120 XP · ×1.4 STREAK ×4` during xp-count). Plan 1 supplies values (SettledRecord.xp, streak derivation); this plan supplies presentation.

### Delta to plan 1's SettledRecord
`sectors?: readonly string[]` — dealt tickers' sectors, `arena.map(s => meta(s).sector)`, populated in App.tsx settle. Optional so plan 1's tests keep passing.

## 4. Animation choreography
Total 3900ms no crossing / 4600ms with one. Every beat skippable. Stage → window(ms) → effect → sound:
| # | Stage | Window | Effect | Sound |
|---|---|---|---|---|
| 1 | shutter | 0→380 | vcRankPanel (scaleY .62→1, opacity, origin top, cubic-bezier(.2,.8,.2,1)); accent scan-line vcRankSweep; debrief dims | rank.enter |
| 2 | badge | 380→900 | sigil vcBadgeDrop (translateY −20 scale 1.22→0/1, overshoot bezier); ring vcRingDraw (dashoffset→pct); tier word fades; 3 seeded SMIL orbit arcs backdrop | rank.reveal |
| 3 | xpCount | 900→2100 (split per segment) | XP bar fills old→new easeOutCubic on rAF (numeral+bar locked); 14px accent bloom + vcXpShimmer; numeral counts 2,340→2,580; boundary snap 100→0 | rank.xpTick ×12, ≥60ms apart |
| 4 | flourish | +700 per crossing | sigil cross-fade; vcRankBurst 12 seeded SVG shards (SMIL, seededRandom(xpAfter)); radial bloom; tier word vcRankSlam (scale 1.55→1, letter-spacing .34em→.12em, 420ms). Division = 55% amplitude, no shards | rank.up / rank.divisionUp |
| 5 | ladder | 2100→2600 | LADDER POSITION `#9 → #7` counts on rAF; arrow slides; 8-pt Sparkline draws | rank.ladder |
| 6 | copy | 2600→3400 | copy panel: 3 rows staggered 120ms vcRowIn; copier count ticks; projection counts; vcHeat pulse on left edge | rank.copyUnlock if crossed into unlock, else rank.copyPanel |
| 7 | settle | 3400→3900 | exit row fades up; debrief un-dims; ring slow vcPulse; onDone → phase done | rank.done |
Skip ↦ top-right in MatchSpin idiom (identical label). New keyframes: vcRankPanel, vcRankSweep, vcBadgeDrop, vcRingDraw, vcXpShimmer, vcRankSlam, vcRowIn, vcHeat, vcPodiumRise. Reduced-motion: `[data-art] *, [data-rank] *, [data-ladder] * { animation: none !important }`.
Sound events: rank.enter, rank.reveal, rank.xpTick, rank.divisionUp, rank.up, rank.ladder, rank.copyUnlock, rank.copyPanel, rank.done, rank.skip.

## 5. Ranking page
Route: types.ts Tab + "ranks"; route.ts parseRoute/routePath "/ranks" (update the doc-comment table); Header NAV Home/Battles/Ranking/Options desk; **state/match.ts:82 add "ranks"**; App.tsx `{tab === "ranks" && <Ranking ledger={ledger} onOpenBattles/>}`.

Layout:
```
HERO (h≈210): SEASON 01 · LIVE | "The ladder" | "Rank is income. Copiers pay 3.5% per copied transaction."
  stat strip: 18 RANKED · 412 COPIERS ACTIVE · 84.2K PTS/24H | your chip: YOU · #7 · SHARK II · +2 THIS WEEK
  [generative LadderField SVG right: 5 stacked tier bands, seeded ridge lines in tier colours, user's band highlighted, SMIL]
PODIUM top-3 for active filter (#1 taller, accent, ring; metric + sparkline each)
[COPY HEAT][SECTOR × MODE][WIN RATE][EARNINGS]                      ← row A, single-select
[SEMIS][BIG TECH][OLD WORLD][MAJORS][DEFI][MEME] | [BLITZ][QUICK][NORMAL] [clear ×]   ← row B, only in SECTOR × MODE
TABLE: # · PLAYER · TIER · SPECIALTY · <METRIC> · TREND; YOU row accent border + tag + data-you
```
No DitherReveal in hero (WebGL is home's signature; second GL context costly) — LadderField reads as hero art and says what the page is about.

Filters: row A switches metric column, re-sorts, re-numbers, re-animates (vcPodiumRise + staggered vcRowIn via animation-delay:i*22ms, keyed on filter). Sound ladder.filter. Row B: OR within group, AND across groups — `(S empty || p.sector ∈ S) && (M empty || p.mode ∈ M)`; empty = all (no dead screen). Chips carry qualifying-player counts; `clear ×` appears when any selected. Sounds ladder.chip/chipClear. Metric under SECTOR×MODE = WINS IN SELECTION = battlesIn(S,M)·winRateIn(S,M), header echoes selection (`WINS · SEMIS+DEFI · BLITZ`). Row hover ladder.rowHover (ref-throttled); row click detail drawer (nice) ladder.rowOpen.

YOU: synthetic LeaderPlayer from ledger (battles=history.length, wins, xp from useRankProgress, sectors from SettledRecord.sectors, econ from copyEconomicsFor("you", xp)), sorted with the rest. Outside visible 12 → pinned foot row with true position + nudge `▲ 3 WINS TO OVERTAKE lexa`. Empty ledger = MINNOW near bottom; one duel climbs visibly.

## 6. leaderboard.ts — one latent variable
Every stat is a function of a single seeded `skill` scalar + seeded quirks → no "WHALE with a 41% win rate", four filter lists overlap plausibly.
```ts
PERSONAS = union of OPPONENTS (lobbies.ts) + fixtures personas (~15 with initials + bg)
r = seededRandom(hash(id)); skill = 0.34 + r()·0.52; battles = 40+floor(r()·260);
winRate = 0.30 + skill·0.42 + (r()−0.5)·0.04; wins = round(battles·winRate);
xp = round(battles·(50+skill·90)·(0.8+r()·0.4)); rank = rankAt(xp); econ = copyEconomicsFor(id, xp);
earnings = round(battles·econ.avgTicket·(winRate−0.42)·3.6);  // signed
sectorShare/modeShare = dirichletish(r, keys, seeded primary);  trend = 8 seeded pts biased by skill
```
Coherence invariants (tested): copiers>0 ⟺ tier copy-unlocked; xp ordering ≈ skill ≈ winRate (±noise); winsIn(S,M) = round(battles·Σshare(s)·Σshare(m)·winRate·localBoost) — filtered list re-RANKS, never invents players; copyEarn24h = copiers·tx·ticket·0.035 = the Result panel's number (shared fn).

API: `LadderFilter = "COPY"|"SECTOR_MODE"|"WINRATE"|"EARNINGS"`; `Selection {sectors, modes}`; `Ranked {pos, player, metric, label, sub}`; `LEADERBOARD` (module-load build); `leaderboardWith(you)`; `rankedBy(list, filter, sel)`; `positionOf(xp)`; `copyEconomicsFor`; `SECTORS, MODES` (re-export plan 1's keys; TODO const fallback if not landed).
`hash` moves to src/lib/hash.ts (CardArt imports it; app.test.tsx:160-165 stability test guards the move; time-short fallback: duplicate 8 lines).

## 7. Build order (demo at every step)
1. lib/sfx.ts no-op + lib/hash.ts + CardArt swap — unchanged app, 71 green
2. rewards.ts extension + engine/rank.ts + unit tests (+~8)
3. data/leaderboard.ts + generator tests (+~6)
4. styles.css keyframes + RankBadge.tsx
5. state/rank.ts + RankUpSequence + Result gate + App wiring + 2 test edits + 3 new — **DEMO 1: rank moment end-to-end**
6. Tab/route/Header/initialState fix + Ranking.tsx hero+table COPY HEAT only — **DEMO 2: ladder navigable**
7. Podium + other 3 filters + sector×mode chips + LadderRow — **DEMO 3: full mix-and-match ladder**
8. You-row pinning + overtake nudge + `View the full ladder →` cross-link + README — **DEMO 4: loop closes**
Steps 1–4 dependency-free of plans 1/3. Step 5 needs plan 1's SettledRecord.xp (fallback `?? DEMO_XP = 120`). Step 7 needs plan 1's keys (fallback const + TODO).

## 8. Test impact
Exactly ONE existing break (+1 if both exits gated — recommended): app.test.tsx:478 "Back to battles" and :484 "Rematch · new lobby" no longer exist at debrief. Fix: `function throughRank() { click("Next → your rank"); click("Skip ↦"); }` — synchronous, no fake timers. All other result assertions survive (debrief dimmed, not unmounted). Verified safe: exact-label nav clicks (:101), clickContaining("CRYPTO") on /create, CardArt stability (:160), no NAV.length assertions.

New test/rank.test.ts (~14, pure): rankAt at every boundary ±1; xpSegments counts/kinds; rankTimeline monotone beats, rank.up only on tier change, total +700/crossing; copyEconomicsFor 0 below SHARK, monotone, daily identity, feePct 0.035; LEADERBOARD deterministic deep-equal; coherence invariants; rankedBy unique consecutive positions; SECTOR_MODE filter = permutation-subset of identical objects; positionOf monotone.
New app tests (~6): gate (exits absent, Next present; after throughRank both present); rank moment text (tier label, XP, position); copy panel ("3.5%", "COPIERS"); /ranks renders (pathname, hero copy, ≥12 [data-rank-row], one [data-you]); filters compose (SECTOR×MODE + SEMIS + BLITZ drops count, ≥1; clear restores; header echoes); ladder deterministic across remounts.

## 9. Must vs nice
MUST: rewards extension + divisions + COPY_FEE; engine/rank.ts; Next gate with both exits behind it + synchronous Skip; stages 1,2,3,4,6,7; all ten rank.* sfx calls; leaderboard.ts single-skill coherence; /ranks route+nav+match.ts:82 fix; ladder hero/table/4 filters/sector×mode chips/you-row; 2 test edits + new tests; the "plan 1 N1 absorbed" docstring note.
NICE (cut order): row drawer; podium sparklines + vcPodiumRise re-anim; stage 5 ladder counter; overtake nudge + pinned row; LadderField hero art; multi-crossing xpSegments; mock Copy button (toast); README; hash extraction (duplicate instead).

## 10. Seams
- Plan 1: import Mode/Sector/XP/streak — never redefine. Single delta: SettledRecord.sectors?. N1 chip absorbed.
- Plan 3: contract is exactly src/lib/sfx.ts → `export function sfx(name: string): void`. Called with the literal names in §4/§5. Whoever lands second wires the body. [INTEGRATION NOTE: plan 3's real module is src/lib/sound with a typed SfxName union — resolve to importing from there and adding rank.*/ladder.* to the union.]
- Chain: copyEconomicsFor/positionOf are pure (id, xp) — on-chain later = contract reads, no view changes.
