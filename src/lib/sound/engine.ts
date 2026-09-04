import {
  TICK_MIN_GAP_BLITZ_MS,
  TICK_MIN_GAP_MS,
  TIER_GAIN,
  clampGain,
  createBudget,
} from "./budget.ts";
import {
  CASE_LAND_URL,
  CASE_TICK_URL,
  PALETTE_DECAY,
  PALETTE_DETUNE,
  SFX_MAP,
  type Palette,
  type RenderOpts,
  type SfxName,
  type SfxOpts,
  type SfxRecipe,
} from "./map.ts";
import { loadBuffer } from "./samples.ts";
import { SILENT, type SoundHandle } from "./voices.ts";

/**
 * The only file that touches `globalThis.AudioContext`.
 *
 * Nothing is constructed at module scope: a context may only be created inside
 * a real user gesture (browsers refuse otherwise, and iOS additionally wants a
 * buffer played inside that same gesture), and under happy-dom there is no
 * constructor at all. `audioAvailable` is the single guard that makes the whole
 * module inert in tests — no context, no listeners, no timers, `sfx()` false.
 *
 * Graph:
 *
 *   destination ← master ← compressor ─┬ sfxBus       (ui / action / event / moment)
 *                                      ├ tickBus      (spin ticks only, 0.85)
 *                                      └ ambienceBus  (beds, ducked by R7)
 *
 * The compressor is a passive limiter: density can never become loudness (R12).
 */

type AudioCtor = new () => AudioContext;

const AC: AudioCtor | undefined = (() => {
  const g = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  return g.AudioContext ?? g.webkitAudioContext;
})();

/** False under happy-dom — every entry point short-circuits on it. */
export const audioAvailable: boolean = Boolean(AC);

// ── Preferences ───────────────────────────────────────────────────────────

const KEY = "td.sound.v1";
export const DEFAULT_VOLUME = 0.5;

export interface SoundPrefs {
  on: boolean;
  volume: number;
}

export function prefersReducedMotion(): boolean {
  try {
    const mq = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
    return mq ? mq.matches : false;
  } catch {
    return false;
  }
}

/**
 * Storage is advisory: Safari's private mode throws on read, and a half-written
 * value is worth less than the default. An explicit stored choice beats the
 * reduced-motion default — someone who unmuted meant it.
 */
export function parsePrefs(raw: string | null, reduced: boolean): SoundPrefs {
  const fallback: SoundPrefs = { on: !reduced, volume: DEFAULT_VOLUME };
  if (!raw) return fallback;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object") return fallback;
    const rec = v as { on?: unknown; volume?: unknown };
    const volume = typeof rec.volume === "number" && Number.isFinite(rec.volume) ? rec.volume : DEFAULT_VOLUME;
    return {
      on: typeof rec.on === "boolean" ? rec.on : fallback.on,
      volume: Math.min(1, Math.max(0, volume)),
    };
  } catch {
    return fallback;
  }
}

function readStore(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

function writeStore(prefs: SoundPrefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // No storage (private mode, disabled cookies). The choice still holds for
    // this session; it simply does not survive the tab.
  }
}

let prefs: SoundPrefs | null = null;
const listeners = new Set<() => void>();

function current(): SoundPrefs {
  if (!prefs) prefs = parsePrefs(readStore(), prefersReducedMotion());
  return prefs;
}

export function isSoundOn(): boolean {
  return current().on;
}

export function setSoundOn(on: boolean): void {
  const next: SoundPrefs = { ...current(), on };
  prefs = next;
  writeStore(next);
  applyVolume();
  for (const fn of listeners) fn();
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribeSound(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Test hook: drop the cached preferences so the next read hits storage. */
export function __reloadPrefs(): void {
  prefs = null;
}

// ── Graph ─────────────────────────────────────────────────────────────────

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let tickBus: GainNode | null = null;
let ambienceBus: GainNode | null = null;

let palette: Palette = "NORMAL";
let testSink: ((n: SfxName, o?: SfxOpts) => void) | null = null;

const clock = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());
const budget = createBudget(clock);

/** Live voices, keyed by budget handle, so R4/R10 evictions can fade them. */
const live = new Map<number, { stop: (when: number, fade: number) => void; endsAt: number }>();

function applyVolume(): void {
  const p = current();
  if (!ctx || !master) return;
  master.gain.setTargetAtTime(p.on ? p.volume : 0, ctx.currentTime, 0.02);
}

function fadeParam(param: AudioParam, when: number, fadeSec: number): void {
  const hold = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof hold.cancelAndHoldAtTime === "function") hold.cancelAndHoldAtTime(when);
  else param.cancelScheduledValues(when);
  param.setTargetAtTime(SILENT, when, Math.max(0.01, fadeSec) / 3);
}

/**
 * Build the graph. Called synchronously inside the first gesture so the very
 * first click is audible, and never before — a context created outside a
 * gesture starts suspended and stays that way on iOS.
 */
function ensureGraph(): boolean {
  if (ctx) return true;
  if (!AC) return false;
  try {
    const c = new AC();
    const m = c.createGain();
    const p = current();
    m.gain.value = p.on ? p.volume : 0;
    m.connect(c.destination);

    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.003;
    comp.release.value = 0.18;
    comp.connect(m);

    const mk = (gain: number): GainNode => {
      const g = c.createGain();
      g.gain.value = gain;
      g.connect(comp);
      return g;
    };

    // iOS only counts a context as unlocked once something has played.
    const prime = c.createBufferSource();
    prime.buffer = c.createBuffer(1, 1, c.sampleRate);
    prime.connect(c.destination);
    prime.start(0);

    c.onstatechange = () => {
      if (c.state === "suspended") void c.resume().catch(() => {});
    };
    void c.resume().catch(() => {});

    ctx = c;
    master = m;
    sfxBus = mk(1);
    tickBus = mk(0.85);
    ambienceBus = mk(1);
    // A view that asked for a track before the first gesture parked it; the
    // graph it was waiting for now exists.
    flushPendingTracks();
    // The button clips, on the other hand, are never queued (see `playClip`),
    // so the gesture that builds the graph is also the moment to warm them:
    // the fetch+decode runs while the player is still reading the screen and
    // the first press finds a decoded buffer.
    for (const url of CLIP_PRELOAD) preloadClip(url);
    return true;
  } catch {
    return false;
  }
}

/** The gesture handler, and the visibility watchdog that follows it. */
export function installUnlock(): () => void {
  if (!audioAvailable || typeof window === "undefined") return () => {};
  const opts = { once: true, capture: true } as const;
  const onGesture = (): void => {
    ensureGraph();
  };
  const onVisible = (): void => {
    if (typeof document !== "undefined" && document.hidden) return;
    void ctx?.resume().catch(() => {});
  };

  window.addEventListener("pointerdown", onGesture, opts);
  window.addEventListener("keydown", onGesture, opts);
  window.addEventListener("touchstart", onGesture, opts);
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisible);

  return () => {
    window.removeEventListener("pointerdown", onGesture, { capture: true });
    window.removeEventListener("keydown", onGesture, { capture: true });
    window.removeEventListener("touchstart", onGesture, { capture: true });
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisible);
  };
}

// ── Playback ──────────────────────────────────────────────────────────────

/** R7 — an event or a moment pushes the bed down and lets it back up. */
function duckAmbience(now: number): void {
  if (!ambienceBus) return;
  const g = ambienceBus.gain;
  g.cancelScheduledValues(now);
  g.setTargetAtTime(0.35, now, 0.01);
  g.setTargetAtTime(1, now + 0.29, 0.04);
}

interface Played {
  ok: boolean;
  handle: SoundHandle | null;
  voice: number;
}

const MISS: Played = { ok: false, handle: null, voice: -1 };

/**
 * The single playback path. `sustainMs` is only read by sustained recipes (the
 * riser); one-shots ignore it.
 *
 * Gate order is R8 — no context, muted, hidden, locked, budget — with the test
 * sink ahead of it. The sink has to come first or it could never observe
 * anything: under happy-dom `audioAvailable` is false, and gate 1 would eat
 * every call before the sink saw it.
 */
function run(name: SfxName, opts: SfxOpts | undefined, sustainMs?: number): Played {
  if (testSink) {
    testSink(name, opts);
    return { ok: true, handle: null, voice: -1 };
  }
  if (!audioAvailable) return MISS;
  if (!current().on) return MISS;
  if (typeof document !== "undefined" && document.hidden) return MISS;
  if (!ctx || !sfxBus || !tickBus || !ambienceBus) return MISS;

  const recipe: SfxRecipe | undefined = SFX_MAP[name];
  if (!recipe) return MISS;
  // Reduced motion keeps the discrete confirmations and drops the atmosphere.
  if (recipe.tier === "ambient" && prefersReducedMotion()) return MISS;

  const decision = budget.request({
    name,
    tier: recipe.tier,
    cooldownMs: recipe.cooldownMs,
    durationMs: recipe.durationMs,
    bus: recipe.bus ?? (recipe.tier === "ambient" ? "ambience" : "sfx"),
  });
  if (decision.verdict !== "play") return MISS;

  try {
    const now = ctx.currentTime;
    const when = now + Math.max(0, opts?.delayMs ?? 0) / 1000 + 0.005;

    for (const id of decision.evict) {
      const v = live.get(id);
      v?.stop(now, 0.08); // R10 cross-fade
      live.delete(id);
    }
    for (const [id, v] of live) if (v.endsAt <= now) live.delete(id);

    const bus = recipe.bus === "tick" ? tickBus : recipe.tier === "ambient" ? ambienceBus : sfxBus;
    const voice = ctx.createGain();
    voice.gain.value = TIER_GAIN[recipe.tier] * clampGain(opts?.gain);

    if (opts?.pan !== undefined && typeof ctx.createStereoPanner === "function") {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, opts.pan));
      voice.connect(pan);
      pan.connect(bus);
    } else {
      voice.connect(bus);
    }

    const o: RenderOpts = {
      ...opts,
      pitch: (opts?.pitch ?? 1) * PALETTE_DETUNE[palette],
      palette,
      decay: PALETTE_DECAY[palette],
      ...(sustainMs !== undefined ? { sustainMs } : {}),
    };
    const handle = recipe.render(ctx, voice, when, o) ?? null;

    live.set(decision.voice, {
      endsAt: when + decision.durationMs / 1000,
      stop: (at, fade) => {
        if (handle) handle.stop(at, fade);
        else fadeParam(voice.gain, at, fade);
      },
    });
    if (recipe.tier === "event" || recipe.tier === "moment") duckAmbience(now);
    return { ok: true, handle, voice: decision.voice };
  } catch {
    // A recipe that throws must never reach a click handler.
    return MISS;
  }
}

/** Fire and forget. Returns whether a voice started; never throws. */
export function sfx(name: SfxName, opts?: SfxOpts): boolean {
  return run(name, opts).ok;
}

// ── Singletons (R9) ───────────────────────────────────────────────────────

type AmbienceId = "study" | "duel";

const AMBIENCE: Record<AmbienceId, SfxName> = { study: "study.enter", duel: "duel.start" };
const beds = new Map<AmbienceId, Played>();

export function startAmbience(id: AmbienceId): void {
  if (beds.has(id)) return; // second start is a no-op
  const played = run(AMBIENCE[id], undefined);
  if (played.ok) beds.set(id, played);
}

export function stopAmbience(id: AmbienceId): void {
  const played = beds.get(id);
  if (!played) return;
  beds.delete(id);
  if (played.voice >= 0) budget.release(played.voice);
  live.delete(played.voice);
  if (played.handle && ctx) played.handle.stop(ctx.currentTime, 0.8);
}

let riserVoice: Played | null = null;

/** The tension climb. `durationMs` is the wall-clock remainder of the tape. */
export function startRiser(durationMs: number): void {
  if (riserVoice) return;
  if (prefersReducedMotion()) return;
  const played = run("duel.riser", undefined, Math.max(320, durationMs));
  if (played.ok) riserVoice = played;
}

export function stopRiser(resolve?: boolean): void {
  const played = riserVoice;
  if (!played) return;
  riserVoice = null;
  if (played.voice >= 0) budget.release(played.voice);
  live.delete(played.voice);
  if (played.handle && ctx) played.handle.stop(ctx.currentTime, resolve ? 0.12 : 0.25);
}

// ── Music tracks (R9, on the ambience bus) ────────────────────────────────

/**
 * The one thing in the app that is a recording rather than a recipe: a looping
 * bed of music behind a screen. It follows the ambience singleton idiom —
 * one voice per id, a second start is a no-op, a stop ramps and only then
 * disconnects — and hangs off `ambienceBus`, so R7's duck and the master mute
 * reach it for free without the track knowing either exists.
 *
 * Every asset here is OPTIONAL. A missing file, a refused decode or a context
 * that was never unlocked all end the same way: silence, no throw, no rejected
 * promise, and exactly one fetch per url for the life of the tab.
 */

type TrackId = "room";

/**
 * The ambience tier's ROLE at a level a recording can actually carry.
 * `TIER_GAIN.ambient` (0.06) is calibrated for raw oscillators, whose peak is
 * their whole signal; a mastered MP3 arrives near full scale already, so it
 * sits well below the synth beds in headroom while landing at the same
 * "behind everything else" loudness. Still background — never foreground.
 */
const TRACK_GAIN = 0.22;
const TRACK_FADE_IN_MS = 800;
const TRACK_STOP_FADE_MS = 600;

interface TrackState {
  readonly url: string;
  /** False while the track is parked waiting for the unlock gesture. */
  started: boolean;
  gain: GainNode | null;
  source: AudioBufferSourceNode | null;
}

/**
 * Decoded audio, per url, for the life of the tab — re-entering the room must
 * not refetch, and a button pressed twenty times must fetch once — lives in
 * `samples.ts`. It is not here because `map.ts` reads it too: two of the spin
 * recipes are now slices of a real recording, and `map.ts` cannot import this
 * file without closing a cycle. See that module's header.
 */
const tracks = new Map<TrackId, TrackState>();

/** Never rejects: the caller fires it with `void` and forgets it. */
async function beginTrack(id: TrackId, st: TrackState): Promise<void> {
  st.started = true;
  const c = ctx;
  if (!c) return;
  try {
    const buf = await loadBuffer(c, st.url);
    // The load takes a network round trip; the player may have readied up or
    // walked out inside it. A state no longer in the map has been stopped.
    if (!buf || !ambienceBus || tracks.get(id) !== st) return;

    const gain = c.createGain();
    const source = c.createBufferSource();
    source.buffer = buf;
    source.loop = true;
    source.connect(gain);
    gain.connect(ambienceBus);

    const now = c.currentTime;
    gain.gain.setValueAtTime(SILENT, now);
    gain.gain.exponentialRampToValueAtTime(TRACK_GAIN, now + TRACK_FADE_IN_MS / 1000);
    source.start(now);

    st.gain = gain;
    st.source = source;
  } catch {
    // A node the browser refused, or a decode that produced nothing usable.
    // Music is decoration: it fails by not being there.
  }
}

function flushPendingTracks(): void {
  for (const [id, st] of tracks) if (!st.started) void beginTrack(id, st);
}

/**
 * Start `url` looping under `id`. Idempotent per id — the second call while a
 * track is live does nothing, so a re-render can never stack two copies.
 * Called before the first gesture, it parks the request and the unlock flow
 * picks it up.
 */
export function startTrack(id: TrackId, url: string): void {
  if (!audioAvailable) return; // happy-dom: no context, and no fetch either
  if (prefersReducedMotion()) return; // same rule the ambience beds follow
  if (tracks.has(id)) return; // R9: one voice per id

  const st: TrackState = { url, started: false, gain: null, source: null };
  tracks.set(id, st);
  if (ctx) void beginTrack(id, st);
}

/**
 * Ramp `id` out and release it. The ramp is a `setTargetAtTime` toward
 * `SILENT` and the source is stopped only after the tail has run out, so the
 * loop never ends on a step — R9's no-click rule.
 */
export function stopTrack(id: TrackId, fadeMs: number = TRACK_STOP_FADE_MS): void {
  const st = tracks.get(id);
  if (!st) return;
  tracks.delete(id); // an in-flight load will now find itself orphaned

  const { gain, source } = st;
  st.gain = null;
  st.source = null;
  if (!gain || !source || !ctx) return;

  try {
    const now = ctx.currentTime;
    const fade = Math.max(0.01, fadeMs / 1000);
    fadeParam(gain.gain, now, fade);
    // `fadeParam`'s time constant is fade/3, so twice the fade puts the signal
    // ~60dB down — inaudible — before the source is cut.
    const tail = fade * 2 + 0.05;
    source.onended = () => {
      try {
        source.disconnect();
        gain.disconnect();
      } catch {
        // Already torn down with the context.
      }
    };
    source.stop(now + tail);
  } catch {
    // Nothing to unwind that the garbage collector will not take.
  }
}

// ── One-shot clips (recordings, on the sfx bus) ───────────────────────────

/**
 * A recorded one-shot behind a button — the same file discipline as the
 * tracks above, the same buffer cache, the opposite end of the mix.
 *
 * It hangs off `sfxBus`, where the synth confirmations live, and NOT off
 * `ambienceBus`: these fire because the player pressed something, so they are
 * foreground by definition. Routing one through the bed's bus would also put
 * it on the wrong side of R7 — the duck exists to get quiet things out of the
 * way of loud ones, and a clip that ducked itself would be inside out.
 *
 * The asset is optional exactly like a track: a missing file, a refused
 * decode or a context that was never unlocked all end in silence, with no
 * throw and no rejected promise.
 */

/**
 * The foreground counterpart to TRACK_GAIN, tuned the same way. `TIER_GAIN`
 * (action 0.22, event 0.38, moment 0.6) is calibrated for raw oscillators,
 * where the number IS the peak of a thin, single-voice signal; a mastered clip
 * arrives dense and near full scale, so the two scales cannot be compared
 * digit for digit. The one recorded level already tuned in this app is the
 * anchor: the room track sits at 0.22 and reads as "behind everything". A
 * button clip has to read as the loudest thing the player just caused — but a
 * moment (a win, a rank-up) still has to top it, so it stops short of that
 * tier's presence. 0.45, twice the bed, lands there: plainly foreground and
 * punchy at action/event tier, under the moment. The master compressor is the
 * backstop if a future clip is mastered hotter than these two.
 */
const CLIP_GAIN = 0.45;

/**
 * A double-click, a re-render, or a second press while the first is still
 * loading must not stack two transients on the same sample.
 */
const CLIP_COOLDOWN_MS = 150;

/**
 * Deliberately NOT `budget.request`. That machinery is keyed by `SfxName` and
 * hands back a voice id the caller owes back through `live` / `evict` /
 * `release`; a clip has no name in `SFX_MAP`, no recipe and no tier, so every
 * one of those fields would be a value invented at the call site to satisfy a
 * signature. A per-id timestamp is the entire rule a button clip needs, and
 * density downstream is still the compressor's job.
 */
const clipLastPlayedAt = new Map<string, number>();

/**
 * Warmed the moment the graph exists: the clips wired to buttons, and the two
 * spin slices, which are not clips at all — they are read by `map.ts` recipes
 * through `getSample`, whose whole contract is that it answers synchronously
 * or not at all. Warming them here is what makes it answer: the unlock gesture
 * is minutes of reading and a lobby away from the first spin, so the fetch and
 * decode are long finished by the time the reel starts and the ticks are
 * sampled from the first one rather than fading up from the synth.
 */
const CLIP_PRELOAD: readonly string[] = [
  "/assets/exo-kill-1.mp3",
  "/assets/exo-kill-2.mp3",
  "/assets/exo-kill-3.mp3",
  "/assets/exo-kill-4.mp3",
  CASE_TICK_URL,
  CASE_LAND_URL,
];

/**
 * Warm the cache for `url` without playing it, so the first press pays for a
 * `createBufferSource` and nothing else. Safe to call repeatedly: the cache
 * is the one-fetch guarantee. A no-op before the graph exists, since decoding
 * needs a context — `ensureGraph` calls it when there is one.
 */
export function preloadClip(url: string): void {
  if (!audioAvailable || !ctx) return;
  void loadBuffer(ctx, url); // never rejects
}

/**
 * Play `url` once, now, as the audible half of a press. `id` is the cooldown
 * key, not the url, so the same file behind two different buttons still gets
 * a gate each.
 *
 * Gates, in order: no context (happy-dom — nothing is fetched in tests),
 * muted, and not yet unlocked. That last one drops the clip on the floor
 * rather than parking it the way `startTrack` does: a bed that starts late is
 * still a bed, but a button sound that arrives seconds after the button reads
 * as a different, phantom event. In practice it is unreachable — the gesture
 * that presses the button is itself an unlock — and it is not gated on
 * reduced motion, which drops atmosphere and keeps discrete confirmations.
 *
 * Fire and forget: never throws, never rejects.
 */
export function playClip(id: string, url: string, opts?: { gain?: number }): void {
  if (!audioAvailable) return;
  if (!current().on) return;
  const c = ctx;
  if (!c || !sfxBus) return;

  const now = clock();
  const last = clipLastPlayedAt.get(id);
  if (last !== undefined && now - last < CLIP_COOLDOWN_MS) return;
  // Stamped before the load, not after it: the cooldown has to cover the
  // first press's fetch, or a nervous double-click would queue two plays that
  // both start when the buffer lands.
  clipLastPlayedAt.set(id, now);

  void (async (): Promise<void> => {
    try {
      const buf = await loadBuffer(c, url);
      // A 404, or a context torn down/rebuilt while the bytes were in flight.
      if (!buf || ctx !== c || !sfxBus) return;

      const gain = c.createGain();
      gain.gain.value = CLIP_GAIN * clampGain(opts?.gain);
      const source = c.createBufferSource();
      source.buffer = buf;
      source.connect(gain);
      gain.connect(sfxBus);
      source.onended = () => {
        try {
          source.disconnect();
          gain.disconnect();
        } catch {
          // Already torn down with the context.
        }
      };
      source.start(c.currentTime);
    } catch {
      // A node the browser refused, or bytes that decoded to nothing usable.
      // A clip fails the way the music does: by not being there.
    }
  })();
}

// ── Palette ───────────────────────────────────────────────────────────────

/** One call retunes every recipe: detune up, decays down, ticks tighter. */
export function setPalette(p: Palette): void {
  palette = p;
  budget.setTickMinGap(p === "BLITZ" ? TICK_MIN_GAP_BLITZ_MS : TICK_MIN_GAP_MS);
}

export function getPalette(): Palette {
  return palette;
}

/**
 * Test seam: with a sink installed every `sfx()` call is recorded and returns
 * true, so the wiring can be asserted without an audio context.
 */
export function __setTestSink(fn: ((n: SfxName, o?: SfxOpts) => void) | null): void {
  testSink = fn;
  budget.reset();
}
