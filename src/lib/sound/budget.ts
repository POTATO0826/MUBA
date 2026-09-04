/**
 * Anti-overload rules R1–R12, as arithmetic.
 *
 * Nothing here touches Web Audio, the DOM or a real clock: a budget is created
 * around an injected `now()` so the whole policy layer — cooldowns, the hover
 * sweep detector, the spin-tick rate limit, voice accounting and eviction —
 * can be driven a millisecond at a time from a test. The engine owns the
 * question "what does this sound like"; this file owns "may it be heard".
 *
 *   R1  per-event cooldown, measured from the last ACCEPTED play
 *   R2  hover sweep: <=1/90ms and <=5/rolling-1000ms, breach mutes hovers 600ms
 *   R3  spin ticks no closer than the palette's min gap (55ms, BLITZ 42ms)
 *   R4  <=12 voices global, <=3 per name, <=6 on the tick bus
 *   R5  caller gain clamped to [0, 1.5]; the tier is never caller-supplied
 *   R6  duration clamp per tier
 *   R10 one moment in flight — a new one evicts the old
 */

export type Tier = "ambient" | "ui" | "action" | "event" | "moment";
export type Bus = "sfx" | "tick" | "ambience";

/** R6 — the longest a voice of each tier may occupy the graph, in ms. */
export const TIER_MAX_MS: Record<Tier, number> = {
  ambient: Number.POSITIVE_INFINITY, // beds are singletons, stopped by hand
  ui: 250,
  action: 400,
  event: 900,
  moment: 2500,
};

/** Per-voice tier gains — the loudness ladder every recipe is mixed against. */
export const TIER_GAIN: Record<Tier, number> = {
  ambient: 0.06,
  ui: 0.12,
  action: 0.22,
  event: 0.38,
  moment: 0.6,
};

// R2 — sweep detection.
export const HOVER_MIN_GAP_MS = 90;
export const HOVER_WINDOW_MS = 1000;
export const HOVER_MAX_PER_WINDOW = 5;
export const HOVER_SUPPRESS_MS = 600;
/** A pause this long means the pointer stopped sweeping: the window clears. */
export const HOVER_RESET_MS = 350;

// R3 — the reel crosses ~83 tiles a second at full speed; this is the thinning.
export const TICK_MIN_GAP_MS = 55;
export const TICK_MIN_GAP_BLITZ_MS = 42;

// R4 — voice ceilings.
export const MAX_VOICES = 12;
export const MAX_PER_NAME = 3;
export const MAX_TICK_VOICES = 6;

/** R5 — a caller may push a sound to 1.5x its tier, never past it. */
export function clampGain(gain: number | undefined): number {
  if (gain === undefined || !Number.isFinite(gain)) return 1;
  return gain < 0 ? 0 : gain > 1.5 ? 1.5 : gain;
}

/** R6 — no recipe may outlive its tier, whatever the palette does to it. */
export function clampDuration(tier: Tier, ms: number): number {
  const max = TIER_MAX_MS[tier];
  if (Number.isNaN(ms) || ms < 0) return 0;
  return ms > max ? max : ms; // Infinity survives only where the tier ceiling is itself Infinity
}

/**
 * The reel's tick, parameterised by the MEASURED gap between tile crossings
 * rather than by the frame number — a dropped frame widens the gap, and a
 * wider gap is exactly what a slowing reel sounds like. Fast: dark, dense
 * chatter. Final crossings: sparse, bright, heavy clacks.
 */
export function tickParams(gapMs: number): { pitch: number; gain: number } {
  const gap = Number.isFinite(gapMs) && gapMs > 0 ? gapMs : 0;
  const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
  return {
    pitch: clamp(0.9 + gap / 220, 0.9, 1.5),
    gain: clamp(0.55 + gap / 260, 0.55, 1.2),
  };
}

/** Consecutive winning legs walk up in semitone-ish steps, then reset on a miss. */
const COMBO = [1, 1.122, 1.26, 1.335] as const;

export function comboPitch(streak: number): number {
  if (!Number.isFinite(streak) || streak <= 0) return COMBO[0];
  const i = Math.min(Math.floor(streak), COMBO.length - 1);
  return COMBO[i] ?? COMBO[COMBO.length - 1] ?? 1;
}

/**
 * Which legs flipped to won between two tape frames. Pure so the duel's sound
 * layer (`state/matchSound.ts`, wave 5) stays a fold over state rather than a
 * pile of refs.
 */
export function diffWon(prev: readonly boolean[], next: readonly boolean[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < next.length; i++) if (next[i] === true && prev[i] !== true) out.push(i);
  return out;
}

export interface PlayRequest {
  readonly name: string;
  readonly tier: Tier;
  readonly cooldownMs: number;
  /** How long the voice will occupy the graph, before the R6 clamp. */
  readonly durationMs: number;
  readonly bus?: Bus;
}

/** Only `"play"` starts a voice; the rest name the rule that refused it. */
export type Verdict = "play" | "cooldown" | "sweep" | "rate" | "voices";

export interface PlayDecision {
  readonly verdict: Verdict;
  /** Voices the caller must stop first — R10's cross-fade, R4's eviction. */
  readonly evict: readonly number[];
  /** Handle of the admitted voice, or -1 when nothing was admitted. */
  readonly voice: number;
  /** The R6-clamped duration, in ms. */
  readonly durationMs: number;
}

export interface Budget {
  /** Ask for a voice. Never throws; the verdict is the whole answer. */
  request(req: PlayRequest): PlayDecision;
  /** Hand a voice back early (a singleton stopped, a moment cross-faded out). */
  release(voice: number): void;
  /** R3 — the palette moves the tick floor (BLITZ tightens it to 42ms). */
  setTickMinGap(ms: number): void;
  /** Live voices, expired ones pruned. */
  active(): number;
  /** Live voices carrying this exact name. */
  activeOf(name: string): number;
  reset(): void;
}

interface Voice {
  id: number;
  name: string;
  tier: Tier;
  bus: Bus;
  endsAt: number;
}

const DROPPED = { evict: [] as readonly number[], voice: -1 } as const;

/**
 * `clock` is whatever monotonic millisecond source the caller trusts —
 * `performance.now` in the browser, a hand-cranked counter in tests.
 */
export function createBudget(clock: () => number): Budget {
  let voices: Voice[] = [];
  let nextId = 1;
  let tickMinGap = TICK_MIN_GAP_MS;

  const lastPlayAt = new Map<string, number>();
  let hoverWindow: number[] = [];
  let hoverSeenAt = -Infinity;
  let hoverPlayAt = -Infinity;
  let hoverMutedUntil = 0;
  let lastTickAt = -Infinity;

  const prune = (now: number) => {
    if (voices.length > 0) voices = voices.filter((v) => v.endsAt > now);
  };

  const request = (req: PlayRequest): PlayDecision => {
    const now = clock();
    const bus: Bus = req.bus ?? (req.tier === "ambient" ? "ambience" : "sfx");
    const durationMs = clampDuration(req.tier, req.durationMs);
    const drop = (verdict: Verdict): PlayDecision => ({ verdict, ...DROPPED, durationMs });

    // R2 — the hover sweep, before R1: a swept row is refused as a group.
    if (/hover$/i.test(req.name)) {
      if (now - hoverSeenAt >= HOVER_RESET_MS) {
        hoverWindow = [];
        hoverMutedUntil = 0;
      }
      hoverSeenAt = now;
      if (now < hoverMutedUntil) return drop("sweep");
      if (now - hoverPlayAt < HOVER_MIN_GAP_MS) return drop("sweep");
      hoverWindow = hoverWindow.filter((t) => now - t < HOVER_WINDOW_MS);
      if (hoverWindow.length >= HOVER_MAX_PER_WINDOW) {
        hoverMutedUntil = now + HOVER_SUPPRESS_MS;
        return drop("sweep");
      }
    }

    // R3 — the reel's tick floor.
    if (bus === "tick" && now - lastTickAt < tickMinGap) return drop("rate");

    // R1 — cooldown against the last accepted play of this exact event.
    const last = lastPlayAt.get(req.name);
    if (last !== undefined && now - last < req.cooldownMs) return drop("cooldown");

    // R4 / R10 — voice accounting. Ambient beds are singletons on their own
    // bus and never compete for the global slots.
    prune(now);
    const evict: number[] = [];
    if (req.tier !== "ambient") {
      // Beds are singletons on their own bus; they never compete for a slot.
      const counted = voices.filter((v) => v.tier !== "ambient");
      if (req.tier === "moment") {
        // R10: one moment in flight — the new one cross-fades the old out.
        for (const v of counted) if (v.tier === "moment") evict.push(v.id);
      }
      if (counted.filter((v) => v.name === req.name && !evict.includes(v.id)).length >= MAX_PER_NAME) {
        return drop("voices");
      }
      if (bus === "tick" && counted.filter((v) => v.bus === "tick").length >= MAX_TICK_VOICES) {
        return drop("voices");
      }
      if (counted.length - evict.length >= MAX_VOICES) {
        // A moment outranks chatter: it evicts the oldest ui voice to fit.
        const oldestUi = counted.find((v) => v.tier === "ui" && !evict.includes(v.id));
        if (req.tier === "moment" && oldestUi) evict.push(oldestUi.id);
        else return drop("voices");
      }
      if (evict.length > 0) voices = voices.filter((v) => !evict.includes(v.id));
    }

    const id = nextId++;
    voices.push({ id, name: req.name, tier: req.tier, bus, endsAt: now + durationMs });
    lastPlayAt.set(req.name, now);
    if (bus === "tick") lastTickAt = now;
    if (/hover$/i.test(req.name)) {
      hoverPlayAt = now;
      hoverWindow.push(now);
    }
    return { verdict: "play", evict, voice: id, durationMs };
  };

  return {
    request,
    release: (voice) => {
      if (voices.length > 0) voices = voices.filter((v) => v.id !== voice);
    },
    setTickMinGap: (ms) => {
      tickMinGap = Number.isFinite(ms) && ms >= 0 ? ms : TICK_MIN_GAP_MS;
    },
    active: () => {
      prune(clock());
      return voices.length;
    },
    activeOf: (name) => {
      prune(clock());
      return voices.filter((v) => v.name === name).length;
    },
    reset: () => {
      voices = [];
      nextId = 1;
      tickMinGap = TICK_MIN_GAP_MS;
      lastPlayAt.clear();
      hoverWindow = [];
      hoverSeenAt = -Infinity;
      hoverPlayAt = -Infinity;
      hoverMutedUntil = 0;
      lastTickAt = -Infinity;
    },
  };
}
