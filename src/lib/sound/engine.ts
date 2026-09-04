import {
  TICK_MIN_GAP_BLITZ_MS,
  TICK_MIN_GAP_MS,
  TIER_GAIN,
  clampGain,
  createBudget,
} from "./budget.ts";
import {
  PALETTE_DECAY,
  PALETTE_DETUNE,
  SFX_MAP,
  type Palette,
  type RenderOpts,
  type SfxName,
  type SfxOpts,
  type SfxRecipe,
} from "./map.ts";
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
