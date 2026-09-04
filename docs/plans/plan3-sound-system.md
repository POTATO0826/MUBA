# Plan 3 — Premium sound system (100% Web Audio synthesis)

## Verified ground truth
- happy-dom: `AudioContext`/`webkitAudioContext` undefined; `localStorage` object; `matchMedia` returns {matches:false}; rAF/performance.now present. → a single `audioAvailable` guard makes the engine a no-op in tests; preference logic testable with zero audio.
- `src/components/MatchSpin.tsx:92-96`: the `if (idx !== lastUnder)` branch IS the tile-crossing moment, already computed inside the rAF loop with the quintic ease. The CS:GO tick needs one line there. No canned loop; perfect sync.

## Decision: 100% Web Audio synthesis. No assets. No CC0 packs.
Zero licensing risk, ~7-9 KB TS vs MB of binaries, parametric ticks that follow the reel's measured deceleration, per-tier/per-mode palettes as number changes, sub-ms scheduling.

## Engine architecture

### Files
```
src/lib/sound/
  budget.ts    PURE. Cooldowns, hover sweep detection, tick rate limit, voice accounting,
               duration clamps. No Web Audio import. ← new tests target this
  voices.ts    Synth primitives: blip / noiseBurst / sweep / thunk / chord.
               Take (ctx, dest, when, params). Never touch globals.
  map.ts       Event table: SfxName → { tier, cooldownMs, maxVoices, render(ctx,dest,when,opts) }
  engine.ts    AudioContext lifecycle, bus graph, unlock, mute persistence, ducking,
               sfx() entry. ONLY file touching globalThis.AudioContext.
  react.ts     Hooks: useSoundUnlock, useSoundHover, useSoundEnabled, useSfxClick.
  index.ts     Public surface re-export.
src/ui/SoundToggle.tsx    Header speaker button (self-contained, no new Header props)
src/state/matchSound.ts   useMatchSound(state, derived) — state-driven layer
```
Views import only from src/lib/sound/index.ts and call `sfx("spin.tick", {pitch})`.

### Public API
```ts
export type SfxName = "ui.hover" | "spin.tick" | ... ;  // string-literal union
export type Tier = "ambient" | "ui" | "action" | "event" | "moment";
export function sfx(name: SfxName, opts?: SfxOpts): boolean;  // true if a voice started; never throws
export interface SfxOpts { pitch?: number; gain?: number; pan?: number; delayMs?: number; leg?: number; tier?: never }
export function startAmbience(id: "study" | "duel"): void;  export function stopAmbience(id): void;  // singletons
export function startRiser(durationMs: number): void;  export function stopRiser(resolve?: boolean): void;
export function setPalette(p: "NORMAL" | "QUICK" | "BLITZ"): void;
export function isSoundOn(): boolean;  export function setSoundOn(on: boolean): void;
export function subscribeSound(fn: () => void): () => void;  // useSyncExternalStore
export const audioAvailable: boolean;
export function __setTestSink(fn: ((n, o) => void) | null): void;
```

### No-op path (keeps 71 tests green)
Never construct a context at module scope:
```ts
const AC = globalThis.AudioContext ?? (globalThis as any).webkitAudioContext;  // typed casts, not lib.dom
export const audioAvailable = Boolean(AC);
```
sfx() gate order (R8): 1 !audioAvailable → false (test path) · 2 testSink → sink+true · 3 !prefs.on → false · 4 document.hidden → false · 5 not unlocked → false · 6 budget !== "play" → false · 7 render.
Typecheck traps: webkitAudioContext cast, `import type` (verbatimModuleSyntax), undefined branches on map lookups (noUncheckedIndexedAccess).

### Bus graph
```
ctx.destination ← masterGain (prefs.on ? volume : 0, default 0.5)
  ← DynamicsCompressor (threshold -18, knee 12, ratio 6, attack .003, release .18)  ← passive anti-overload
    ├ sfxBus 1.0 (ui/action/event/moment)
    ├ tickBus 0.85 (spin ticks only)
    └ ambienceBus 1.0 (ducked per R7)
```
Tier gains per-voice: ambient .06 · ui .12 · action .22 · event .38 · moment .60. Effective = master × tierGain × clamp(opts.gain,0,1.5) × recipeGain.

### Unlock flow
useSoundUnlock() mounted once at top of App: pointerdown/keydown/touchstart on window `{once:true, capture:true}` — capture phase runs BEFORE React's onClick so the very first click is audible. Synchronously inside the gesture: new AC(), build graph, play 1-sample silent buffer (primes iOS), `ctx.resume().catch(()=>{})`. onstatechange + visibilitychange re-resume. All resumes .catch(()=>{}) — no console errors ever. Entire hook body behind `if (!audioAvailable) return`.

### Mute persistence
Key `td.sound.v1` → `{on: boolean, volume: number}`. try/catch reads (Safari private throws). Default: `on = !prefersReducedMotion()`, volume 0.5. Corrupt JSON → default. Explicit user choice beats reduced-motion default. 20-line external store + useSyncExternalStore. Reduced-motion nuance: even when unmuted, drop ambient-tier + refuse startRiser under prefers-reduced-motion; discrete confirmations still play.

### SoundToggle
src/ui/SoundToggle.tsx rendered in Header.tsx flex row (line 56) left of StarfieldButton. Self-contained (no HeaderProps change). 28×28 button, glyph-only text (♪ / ♪⃠), aria-labels. Glyph collides with no exact-textContent test matcher or the "+" filter (app.test.tsx:45, :219).

## Synthesis recipes
Primitives in voices.ts; one shared 2s white-noise AudioBuffer.
```
blip(f, dur, wave, {attack=0.002, peak, detuneCents, lp, hp}) — osc → [filter] → gain env;
  env exponential ramps, ALWAYS end at 0.0001 (ramping to 0 throws; stepping clicks)
noiseBurst(dur, {type, freq, Q, peak}) — noise buffer random offset → biquad → gain env
sweep(f0, f1, dur, wave, {lp0, lp1, Q, peak}) — freq exp-ramp + optional filter sweep
thunk(f0, f1, dur, {bodyPeak, clickPeak}) = sweep + noiseBurst layered
chord(freqs[], dur, wave, opts) = N blips at one onset
```

### Sound map (event → recipe → tier)
GLOBAL: ui.hover (sine 1180Hz 0.045s + 2360 @0.25×, ±25c random detune | ui) · ui.click (tri 660→440 0.07s + 6ms noise transient bp2600 | action) · ui.click.primary (tri 880→587 0.09s + sub 165Hz 0.12s @0.4× + transient | action) · ui.toggle.on/.off (two square blips lp2200, 0.05s, 45ms apart: 620→930 / 930→620 | action) · ui.back (tri 520→390 0.08s | action) · ui.step (tri 740·pitch 0.035s lp4000; pitch = 1 + norm·0.35 — stepper walks a scale | ui) · ui.disabled (square 220 0.05s lp900 ×2 pulses 70ms | ui) · nav.click (ui.click @0.8×, per-tab pitch Home 523 / Battles 587 / Desk 659 | action) · nav.transition (noise 0.12s lp 1200→400 @0.3 | ui) · wallet.connect (blip 587→880 + shimmer noise hp6000 0.35s | action)

SPIN: **spin.tick** (noiseBurst 0.018s bandpass 2400·pitch Q14 (rings like a metal pin) peak 1.0 + tri 1200·pitch 0.012s @0.35×; hp800; attack 0.0008 decay 0.022 | ui→tickBus) · spin.land (3 layers: sine 140→62Hz 0.13s body; noise 0.05s lp900 impact @0.6×; noise 0.02s bp2600 Q6 latch @0.3× | event) · spin.reveal (tri [523.25,659.25,783.99,1046.5][leg] + fifth @0.35×, 0.35s, lp env 800→5000 — stings ARPEGGIATE upward across legs | event) · spin.lock (3-note arp 523/659/880 saw → lp sweep 600→6000 Q6, 0.09s spaced 70ms + shimmer | moment) · spin.skip (noise 0.28s lp 6000→400 | action) · spin.open (saw sweep 90→260 0.35s + lp 300→2200, then spin.tick @0.6× pre-roll | event)

Tick pitch/gain from MEASURED gap between crossings (robust to frame drops):
```ts
const gap = now - lastTickAt;
const pitch = clamp(0.90 + gap/220, 0.90, 1.50);  // wider gap = slower = brighter
const gain  = clamp(0.55 + gap/260, 0.55, 1.20);  // and heavier
```
Fast reel: gaps ~12ms → dark dense chatter. Final crossings: ~180ms → sparse bright weighty clacks.

ROOM: card.hover (ui.hover @880Hz 0.7× | ui) · card.accept (ui.click.primary + rising third 440→554 tri 0.14s | action) · card.start (card.accept + fifth 659 @0.4× | action) · room.ready.me (square→lp2400 587→880 0.16s two-note | event) · room.ready.opp (same 493→740 @0.7× | event) · **room.bothready** (held perfect fifth sines 330+495, attack .06 hold .25 release .40 lp2500 + bell 1318Hz 0.4s | moment) · lobby.publish (ui.click.primary + ascending 392/523/659 tri 0.07s 60ms apart | action)

STUDY: study.enter (ambience bed: filtered noise lp500 Q0.5 + sine 55Hz @0.15×, LFO 0.08Hz on cutoff ±120Hz, attack 0.6s, singleton, 0.8s release on leave | ambient) · **wire.tick** (noise 0.012s bp3200 Q8 + sine 1568 0.02s @0.3×, very quiet ui×0.6 — SEAM for plan 2) · **wire.select** (ui.click @0.85 pitch 1.1 — SEAM) · wire.alert (wire.tick pitch 1.4 + 0.15s sine 880 tail | event)

PARLAY: parlay.card.hover (ui.hover pitched by tier: SAFE 880 · EVEN 988 · SHARP 1174 · DEGEN 1396 | ui) · parlay.card.pick (ui.click.primary at tier freq + bell 2×; DEGEN adds detuned minor third +15c @0.3× — sounds unstable | action) · parlay.slip.change (ui.step @0.5× throttled 200ms | ui) · parlay.lock (latch: noise 0.03s lp1200 clunk + sine 90Hz 0.18s thump + rising 392/523/784 0.24s | moment)

DUEL: duel.start (saw 60→180 0.6s lp 400→1800 + noise swell | event) · duel.tape.tick (sine 2000 0.006s peak 0.25, ≤2/s | ambient) · duel.leg.hit (sine 880+1320 fifth 0.22s + sparkle noise bp5000 @0.35×; COMBO LADDER: consecutive hits ×1, 1.122, 1.26, 1.335 semitone steps | event) · duel.leg.hit.opp (same @0.55× pan+0.35 pitch 0.84 | event) · duel.leg.miss (sine 330→220 0.25s lp900 + dull noise 0.06s lp400 | event@0.8×) · **duel.riser** (saw 110Hz exp→440 over durationMs; lp 300→3500 Q8; noise swell; gain 0→tier×0.5; SINGLETON; 0.12s fade on stop | event) · duel.settle.ready (0.2s down-sweep 440→220 + bell 1046 0.5s | event)

RESULT: result.win (4-note arp 523/659/784/1046 saw→lp8000, 0.11s spaced 90ms + sustained major triad pad 261/329/392 @0.35× + shimmer hp7000 1.2s; total ≤2.2s | moment) · result.loss (descending 392/329/261 tri→lp1400 0.16s spaced 130ms + sine 65Hz 0.9s @0.3× | moment@0.75×) · result.count (sine 0.010s, freq 1200+600·progress, +8c jitter, cooldown 40ms, HARD CAP 24 ticks | ui) · result.count.done (bell 1568 0.3s + fifth @0.3× | action)

SEAMS (registered now for parallel plans): countdown.beep {n} (square 880·(1+(5−n)·0.06)→lp3000 0.07s) · countdown.final (1318Hz 0.25s, moment×0.6) · countdown.expire (ui.disabled @0.6× + 110Hz 0.3s) · wire.* above.
**Plan 4's events must also be registered: rank.enter, rank.reveal, rank.xpTick, rank.divisionUp, rank.up, rank.ladder, rank.copyUnlock, rank.copyPanel, rank.done, rank.skip, ladder.filter, ladder.chip, ladder.chipClear, ladder.rowHover, ladder.rowOpen.** (Map to nearest recipes: rank.xpTick≈result.count, rank.up≈result.win variant, rank.divisionUp≈spin.reveal variant, ladder.rowHover≈ui.hover, etc.)

setPalette("BLITZ"): detune +2 semitones (×1.1225), decays ×0.7, tick min-gap 55→42ms, countdown.beep triangle→square. "QUICK": +1 semitone, decay ×0.85. "NORMAL": identity. One call, no per-mode authoring.

## Anti-overload rules (budget.ts, pure, injectable clock)
| # | Rule | Numbers |
|---|---|---|
| R1 | Per-event cooldown vs last ACCEPTED play | hover 70 · click 40 · step 60 · leg.hit 90 · wire.tick 120 · all moment ≥400 |
| R2 | Hover budget: ≤1/90ms AND ≤5/rolling-1000ms; breach → 600ms sweep suppression on all *.hover; 350ms silence resets | 6-card sweep = 3-4 blips then silence |
| R3 | spin.tick only if now−lastTickAt ≥ 55ms (BLITZ 42ms) | reel peaks ~83 crossings/s → capped ~18/s; ~53 crossings → ~35 ticks; the thinning IS the CS:GO effect |
| R4 | ≤12 voices global; ≤3 per name; ≤6 tickBus; over → drop, unless moment evicts oldest ui voice | |
| R5 | Tier not caller-overridable (tier?: never); opts.gain clamped [0,1.5] within tier | |
| R6 | Duration clamp by engine: ui ≤0.25 · action ≤0.4 · event ≤0.9 · moment ≤2.5s | |
| R7 | event/moment play ducks ambienceBus to 0.35× over 30ms, hold 260ms, return 120ms (setTargetAtTime) | |
| R8 | Hard gate order: no AC → muted → hidden → locked → budget | |
| R9 | Singletons (riser, ambience): second start no-op; stop always ramps 0.12-0.80s | |
| R10 | One moment in flight; new moment cross-fades previous over 0.08s | |
| R11 | Deliberate silences: home marquee, stat tickers, chart redraws, text keystrokes, non-interactive hovers — NO sound | |
| R12 | Compressor = passive limiter; density can never become loudness | |
StrictMode (client.tsx:9) doubles dev effects — cooldowns ≥120ms on one-shots absorb it; prefer event handlers over effects.

## Wiring in demo order
Step 0 — engine files + SoundToggle + useSoundUnlock at top of App (App.tsx:45), toggle in Header.tsx:56.
Step 1 — THE SPIN: MatchSpin.tsx:93-96 inside `if (idx !== lastUnder)` → sfx("spin.tick",{pitch,gain}) — MUST be in the rAF loop, NOT a useEffect([under]) (React batching destroys timing). :104 setSpinning(false) → spin.land + spin.reveal{leg}. :116-120 done effect → spin.lock. :322 skip → spin.skip. :145/:177 close → ui.back. Room.tsx:126 onBegin → spin.open.
Step 2 — global UI: useSoundHover() returns stable {onPointerEnter} from useMemo. Header nav 44-51 → nav.click+hover; logo :30. StarfieldButton.tsx:482 onPointerEnter → ui.hover; :480 onClick → wallet.connect. LobbyCards.tsx:46-52 .vc-lobby div → card.hover (do NOT wrap the card in a new element — app.test.tsx:65 card.querySelector("button"), :97/:138 count [data-lobby]). :142-151 → card.accept/card.start. Battles.tsx:81 pills → ui.toggle.on; :65 create → ui.click.primary. Lobby.tsx:85-96 CTAs, :30-38.
Step 3 — Room: Room.tsx:74-83 onReady → room.ready.me. Opp readying: state/match.ts:138-142 setTimeout flips ready.opp — emit room.ready.opp from useMatchSound on the false→true edge. derived.bothReady false→true → room.bothready. :116 leave → ui.back.
Step 4 — Parlay: ParlayPick.tsx:97-107 card buttons hover/pick with tier; myPicks change → parlay.slip.change throttled (useMatchSound); :187-198 lock → parlay.lock.
Step 5 — Duel + src/state/matchSound.ts: one hook called inside useMatch (state/match.ts after derived ~line 312, before return 314). Watches: state.tab changes → nav.transition/study.enter/duel.start/result.win|loss; state.tick every 4th → duel.tape.tick; won-set diff via pure diffWon(prev,next) → duel.leg.hit (combo ladder) / .opp; derived.pos ≥ TAPE_LEN·0.85 (NOTE plan 1: use settleAt·0.85) → startRiser(1600); derived.raceDone → stopRiser + duel.settle.ready + staggered duel.leg.miss; ready edges; myPicks identity. Body short-circuits on !audioAvailable (zero timers in tests).
Step 6 — Result count-up: Result.tsx:57-61 useCountUp(target,{steps:24}) → result.count per step + done. MUST return final value immediately when !audioAvailable || reducedMotion (app.test.tsx:476 asserts /PTS/ synchronously).
Step 7 — Study ambience + wire seams: tab→study starts bed, leave stops 0.8s. Stagger wire.tick per headline at 90ms delayMs, cap 6 (NOTE: plan 2's NewsWire owns this after it lands). "Done studying" → ui.click.primary.
Step 8 — CreateLobby: :71 pills → ui.toggle.on; :83/:85 + :93/:104 steppers → ui.step{pitch walks a scale}; :97 input → ui.step throttled 250ms; :119 publish → lobby.publish; :40 back → ui.back. No keystroke sounds (R11).
Step 9 — polish: setPalette plumbing, countdown recipes, reduced-motion suppression, visibilitychange, optional volume slider.

## Tests
Existing 71: zero change. Rests on: audioAvailable false in happy-dom; no module-scope construction; no new DOM inside queried containers (SoundToggle is a Header sibling, glyph text); useCountUp synchronous in tests.
New test/sound.test.ts (~19, audio-free): engine no-op safety (3); budget R1/R2/R3 (simulated quintic crossing sequence → 25-45 accepted)/R4/R6/R10 (6); prefs defaults/reduced-motion/persistence-beats-default/corrupt-JSON/subscriber (5); map completeness — EVERY SfxName member has an entry with valid tier + finite cooldown + render (protects parallel plans' event names); testSink decel sequence → monotonically non-decreasing pitch; diffWon pure; combo ladder resets on miss; useSoundHover stable + safe (5).

## Must vs nice
MUST: engine 4 files + no-op guard + unlock + persistence + toggle + reduced-motion default; R1-R6, R8, R10, R11; spin tick/land/reveal/lock/skip; ui.hover/click/click.primary/back/nav.click; room ready.me/.opp/bothready; parlay pick/lock; duel leg.hit/miss/riser; result win/loss; countdown.* + wire.* + rank.* + ladder.* seams registered; ~19 new tests, 71 green.
NICE: ambience beds + R7; count-up; combo ladder; tiered parlay pitches + DEGEN third; setPalette; tape.tick; wire.alert; card.hover distinct; stereo panning; volume slider; first-visit nudge.

## Risks
1. Tick flood quantified: ~83 crossings/s at t=0 — R3 is not optional.
2. Tick must live in the rAF loop, not useEffect([under]).
3. StrictMode double effects — cooldowns ≥120ms.
4. iOS needs webkitAudioContext + silent-buffer play inside the gesture.
5. exponentialRamp cannot target 0 — end at 0.0001.
6. Every resume().catch(()=>{}).
7. sfx() adds no renders — fire-and-forget.
