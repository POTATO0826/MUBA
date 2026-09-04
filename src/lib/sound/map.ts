import type { Tier } from "./budget.ts";
import { getSample } from "./samples.ts";
import { bed, blip, chord, noiseBurst, riser, sweep, thunk, type SoundHandle } from "./voices.ts";

/**
 * The event table: every sound the app can make, in one object literal.
 *
 * `SfxName` is derived from this table's keys, so adding an event is adding
 * one key — the union, the completeness test and the callers can never drift
 * apart. Names for screens that do not exist yet (`countdown.*`, `rank.*`,
 * `ladder.*`) are registered here from the start so the plans that land later
 * find their seams already open.
 *
 * A recipe is a tier (how loud, how long, what it ducks), a cooldown (R1) and
 * a `render` that builds the voice into whatever node the engine hands it.
 * Renders never decide whether they may be heard, never read a global, and
 * never scale themselves by `opts.gain` — the engine's per-voice gain does
 * that. What they do read is `pitch` (a multiplier), `leg` (which step of a
 * sequence this is) and the palette's `decay` scale.
 */

export type Palette = "NORMAL" | "QUICK" | "BLITZ";

export interface SfxOpts {
  pitch?: number;
  gain?: number;
  pan?: number;
  delayMs?: number;
  leg?: number;
  /** The tier belongs to the recipe (R5). A caller may never move a sound. */
  tier?: never;
}

/** What a render actually receives: caller options plus the live palette. */
export interface RenderOpts extends SfxOpts {
  readonly palette: Palette;
  /** Decay scale — NORMAL 1, QUICK 0.85, BLITZ 0.7. */
  readonly decay: number;
  /** Length of a sustained voice (the riser), in ms. Ignored by one-shots. */
  readonly sustainMs?: number;
}

export interface SfxRecipe {
  readonly tier: Tier;
  /** R1 — silence window after the last accepted play of this event. */
  readonly cooldownMs: number;
  /** Roughly how long the voice occupies the graph, for R4/R6 accounting. */
  readonly durationMs: number;
  /** Spin ticks get their own bus and their own ceiling (R3, R4). */
  readonly bus?: "tick";
  render(ctx: BaseAudioContext, dest: AudioNode, when: number, o: RenderOpts): SoundHandle | void;
}

/** Written as a call so every inline `render` is contextually typed. */
function fx(recipe: SfxRecipe): SfxRecipe {
  return recipe;
}

const p = (o: RenderOpts): number => {
  const v = o.pitch;
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : 1;
};

/** A few cents either way, so a repeated blip never phases against itself. */
const cents = (n: number): number => Math.random() * n * 2 - n;

// ── Shared recipes ────────────────────────────────────────────────────────
// Named once, reused by every event that is "that sound, but …". The C-2
// table's rank/ladder mappings are exactly these calls with a modifier.

type R = (ctx: BaseAudioContext, dest: AudioNode, when: number, o: RenderOpts) => void;

const rHover =
  (freq = 1180, mult = 1): R =>
  (c, d, w, o) => {
    const f = freq * p(o);
    blip(c, d, w, { freq: f, dur: 0.045 * o.decay, wave: "sine", peak: 0.9 * mult, detune: cents(25) });
    blip(c, d, w, { freq: f * 2, dur: 0.04 * o.decay, wave: "sine", peak: 0.25 * mult });
  };

const rClick =
  (mult = 1, f0 = 660, f1 = 440): R =>
  (c, d, w, o) => {
    blip(c, d, w, { freq: f0 * p(o), freqTo: f1 * p(o), dur: 0.07 * o.decay, wave: "triangle", peak: 0.8 * mult });
    noiseBurst(c, d, w, { dur: 0.006, freq: 2600, q: 2, peak: 0.4 * mult });
  };

const rClickPrimary =
  (mult = 1, f0 = 880, f1 = 587): R =>
  (c, d, w, o) => {
    blip(c, d, w, { freq: f0 * p(o), freqTo: f1 * p(o), dur: 0.09 * o.decay, wave: "triangle", peak: 0.85 * mult });
    blip(c, d, w, { freq: 165, dur: 0.12 * o.decay, wave: "sine", peak: 0.4 * mult });
    noiseBurst(c, d, w, { dur: 0.006, freq: 2600, q: 2, peak: 0.35 * mult });
  };

/** Two square blips 45ms apart — up for on, down for off. */
const rToggle =
  (on: boolean, mult = 1): R =>
  (c, d, w, o) => {
    const [a, b] = on ? [620, 930] : [930, 620];
    const pitch = p(o);
    blip(c, d, w, { freq: a * pitch, dur: 0.05 * o.decay, wave: "square", lp: 2200, peak: 0.6 * mult });
    blip(c, d, w + 0.045, { freq: b * pitch, dur: 0.05 * o.decay, wave: "square", lp: 2200, peak: 0.6 * mult });
  };

const rStep: R = (c, d, w, o) => {
  blip(c, d, w, { freq: 740 * p(o), dur: 0.035 * o.decay, wave: "triangle", lp: 4000, peak: 0.8 });
};

/** Two flat pulses: the sound of a control that will not move. */
const rDisabled =
  (mult = 1): R =>
  (c, d, w, o) => {
    for (const at of [w, w + 0.07]) {
      blip(c, d, at, { freq: 220 * p(o), dur: 0.05 * o.decay, wave: "square", lp: 900, peak: 0.7 * mult });
    }
  };

// ── Sampled voices ────────────────────────────────────────────────────────
//
// Two of the spin sounds are slices of a real CS:GO case-open recording rather
// than oscillators (see `src/assets/slice-case-open.sh` for the cuts). They are
// wired here, underneath `sfx()`, and not as `playClip` calls from the view,
// because everything the reel already gets from the recipe layer has to keep
// applying to them: R3's tick rate limit, R4's voice ceiling, the tick bus and
// its 0.85, the palette's detune, and the per-voice gain. A clip played around
// the engine would have none of it, and `MatchSpin.tsx` would have to learn
// which of its sounds are recordings — which is exactly the knowledge the map
// exists to hold.
//
// The synth stays as the fallback, not as dead code. `getSample` answers null
// for the first moments of a session, for an offline tab, and forever in a
// checkout without the operator's mp3s — the reel has to tick through all
// three.

/** Served from `src/assets` by the allowlist in the root `index.ts`. */
export const CASE_TICK_URL = "/assets/case-tick.mp3";
export const CASE_LAND_URL = "/assets/case-land.mp3";

/**
 * Both slices are mastered to -3dBFS, so ~0.71 arrives where a synth recipe's
 * peak is ~1.0 — but the recipe is a thin single voice at that number and the
 * slice is dense and broadband, so the two cannot be compared digit for digit.
 * The same reasoning already sets `CLIP_GAIN` (0.45) and `TRACK_GAIN` (0.22)
 * in `engine.ts`: a recording sits lower than the synth it replaces.
 *
 * Tick — 0.71 x 0.7 x `TIER_GAIN.ui` (0.12) x `clampGain(opts.gain)` x the
 * tick bus (0.85). Across the 0.55-1.20 gain `tickParams` actually produces
 * that is a 0.028-0.062 peak, against the synth's 0.056-0.122 through the same
 * chain: about half, which is where it has to be for the two to read as the
 * same loudness. It also leaves headroom that matters at the top of the reel,
 * where R3 lets ~18 ticks a second through and the R12 compressor would
 * otherwise be the thing deciding the level.
 */
const TICK_SAMPLE_GAIN = 0.7;

/**
 * Land — 0.71 x 0.5 x `TIER_GAIN.event` (0.38) is a ~0.135 peak, deliberately
 * under `spin.reveal`'s ~0.30 through the same tier. The two fire together on
 * every landing and they are not equals: the sting is the bed, and the reveal's
 * per-leg arpeggio — the one thing a fixed recording cannot supply, since it
 * climbs with the leg — has to sit clearly on top of it.
 */
const LAND_SAMPLE_GAIN = 0.5;

/**
 * Play `url` as a one-shot into `dest`, or report that it is not available yet
 * so the caller can voice its synth instead. Returns whether it played.
 *
 * `playbackRate` is `p(o)` and nothing else. The palette's detune is ALREADY
 * folded into `o.pitch` by the engine before a render is called (`run()` in
 * `engine.ts`: `pitch: (opts?.pitch ?? 1) * PALETTE_DETUNE[palette]`), so
 * reaching for `PALETTE_DETUNE` here would apply it twice — and on a sample
 * that is not just a retune, it is a retime.
 */
function sampled(c: BaseAudioContext, dest: AudioNode, when: number, url: string, gain: number, o: RenderOpts): boolean {
  const buf = getSample(c, url);
  if (!buf) return false;
  try {
    const g = c.createGain();
    g.gain.value = gain;
    g.connect(dest);

    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = p(o);
    src.connect(g);
    src.onended = () => {
      try {
        src.disconnect();
        g.disconnect();
      } catch {
        // Already torn down with the context.
      }
    };
    src.start(when);
    return true;
  } catch {
    // A node the browser refused. Falling back to the synth is a better answer
    // than a silent tick, and `false` is exactly how that is asked for.
    return false;
  }
}

const rTick =
  (mult = 1): R =>
  (c, d, w, o) => {
    const pitch = p(o);
    noiseBurst(c, d, w, {
      dur: 0.018 * o.decay,
      freq: 2400 * pitch,
      q: 14,
      hp: 800,
      attack: 0.0008,
      peak: 1 * mult,
    });
    blip(c, d, w, { freq: 1200 * pitch, dur: 0.012 * o.decay, wave: "triangle", peak: 0.35 * mult });
  };

/**
 * The reel's click, and the settle under it. Sampled when the slice is in
 * hand, synthesised when it is not — see the sampled-voices note above.
 * `rTick` itself is untouched and stays synth wherever else it is used: the
 * decorative tick inside `spin.open` is a different sound that happens to
 * share a recipe, not this one.
 */
const rTickSynth = rTick();

const rTickSampled: R = (c, d, w, o) => {
  if (sampled(c, d, w, CASE_TICK_URL, TICK_SAMPLE_GAIN, o)) return;
  rTickSynth(c, d, w, o);
};

const rLandSynth: R = (c, d, w, o) => {
  thunk(c, d, w, { f0: 140 * p(o), f1: 62, dur: 0.13 * o.decay, bodyPeak: 0.9, clickPeak: 0.6 });
  noiseBurst(c, d, w + 0.01, { dur: 0.02, freq: 2600, q: 6, peak: 0.3 });
};

const rLandSampled: R = (c, d, w, o) => {
  if (sampled(c, d, w, CASE_LAND_URL, LAND_SAMPLE_GAIN, o)) return;
  rLandSynth(c, d, w, o);
};

/** The reveal stings arpeggiate upward across the legs of a spin. */
const REVEAL = [523.25, 659.25, 783.99, 1046.5] as const;

const rReveal =
  (pitchMul = 1, mult = 1): R =>
  (c, d, w, o) => {
    const leg = Math.max(0, Math.min(REVEAL.length - 1, Math.floor(o.leg ?? 0)));
    const base = (REVEAL[leg] ?? REVEAL[0]) * p(o) * pitchMul;
    const dur = 0.35 * o.decay;
    blip(c, d, w, { freq: base, dur, wave: "triangle", peak: 0.8 * mult, lp: 800, lpTo: 5000 });
    blip(c, d, w, { freq: base * 1.5, dur, wave: "triangle", peak: 0.35 * mult, lp: 800, lpTo: 5000 });
  };

/** The latch: three notes up a saw, filter opening, shimmer on top. */
const rLock =
  (mult = 1): R =>
  (c, d, w, o) => {
    chord(c, d, w, {
      freqs: [523.25, 659.25, 880].map((f) => f * p(o)),
      dur: 0.09 * o.decay,
      wave: "sawtooth",
      peak: 0.7 * mult,
      lp: 600,
      lpTo: 6000,
      q: 6,
      spreadMs: 70,
    });
    noiseBurst(c, d, w + 0.14, { dur: 0.3 * o.decay, hp: 6000, freq: 7000, q: 0.7, peak: 0.18 * mult });
  };

const rSkip =
  (mult = 1): R =>
  (c, d, w, o) => {
    noiseBurst(c, d, w, { dur: 0.28 * o.decay, type: "lowpass", freq: 6000, freqTo: 400, peak: 0.45 * mult });
  };

const rOpen =
  (mult = 1): R =>
  (c, d, w, o) => {
    sweep(c, d, w, { f0: 90 * p(o), f1: 260 * p(o), dur: 0.35 * o.decay, lp0: 300, lp1: 2200, peak: 0.7 * mult });
    rTick(0.6 * mult)(c, d, w + 0.28, o);
  };

const rReady =
  (f0: number, f1: number, mult = 1): R =>
  (c, d, w, o) => {
    const pitch = p(o);
    blip(c, d, w, { freq: f0 * pitch, dur: 0.16 * o.decay, wave: "square", lp: 2400, peak: 0.7 * mult });
    blip(c, d, w + 0.09, { freq: f1 * pitch, dur: 0.16 * o.decay, wave: "square", lp: 2400, peak: 0.7 * mult });
  };

const rCount: R = (c, d, w, o) => {
  // The count-up walks 1200 → 1800Hz across its 24 steps (R6 caps the run).
  const progress = Math.max(0, Math.min(1, (o.leg ?? 0) / 24));
  blip(c, d, w, { freq: (1200 + 600 * progress) * p(o), dur: 0.01, wave: "sine", peak: 0.8, detune: cents(8) });
};

const rCountDone =
  (mult = 1): R =>
  (c, d, w, o) => {
    const pitch = p(o);
    blip(c, d, w, { freq: 1568 * pitch, dur: 0.3 * o.decay, wave: "sine", peak: 0.8 * mult });
    blip(c, d, w, { freq: 2352 * pitch, dur: 0.3 * o.decay, wave: "sine", peak: 0.24 * mult });
  };

/** The win fanfare. `pad` is the sustained triad underneath — rank.up drops it. */
const rWin =
  (pad: boolean, mult = 1): R =>
  (c, d, w, o) => {
    const pitch = p(o);
    chord(c, d, w, {
      freqs: [523.25, 659.25, 783.99, 1046.5].map((f) => f * pitch),
      dur: 0.11 * o.decay,
      wave: "sawtooth",
      peak: 0.75 * mult,
      lp: 8000,
      spreadMs: 90,
    });
    if (pad) {
      chord(c, d, w + 0.09, {
        freqs: [261.63, 329.63, 392].map((f) => f * pitch),
        dur: 1.2 * o.decay,
        wave: "triangle",
        peak: 0.35 * mult,
        attack: 0.06,
      });
      noiseBurst(c, d, w + 0.12, { dur: 1.2 * o.decay, hp: 7000, freq: 8000, q: 0.6, peak: 0.12 * mult });
    }
  };

const rSettleReady =
  (mult = 1): R =>
  (c, d, w, o) => {
    const pitch = p(o);
    sweep(c, d, w, { f0: 440 * pitch, f1: 220 * pitch, dur: 0.2 * o.decay, wave: "triangle", peak: 0.6 * mult });
    blip(c, d, w + 0.06, { freq: 1046.5 * pitch, dur: 0.5 * o.decay, wave: "sine", peak: 0.45 * mult });
  };

const rWireTick =
  (mult = 1): R =>
  (c, d, w, o) => {
    const pitch = p(o);
    noiseBurst(c, d, w, { dur: 0.012, freq: 3200 * pitch, q: 8, peak: 0.6 * mult });
    blip(c, d, w, { freq: 1568 * pitch, dur: 0.02 * o.decay, wave: "sine", peak: 0.3 * mult });
  };

const rLegHit =
  (mult = 1): R =>
  (c, d, w, o) => {
    const pitch = p(o);
    const dur = 0.22 * o.decay;
    blip(c, d, w, { freq: 880 * pitch, dur, wave: "sine", peak: 0.8 * mult });
    blip(c, d, w, { freq: 1320 * pitch, dur, wave: "sine", peak: 0.5 * mult });
    noiseBurst(c, d, w, { dur: 0.12 * o.decay, freq: 5000, q: 1.2, peak: 0.35 * mult });
  };

// ── The table ─────────────────────────────────────────────────────────────

export const SFX_MAP = {
  // global (11)
  "ui.hover": fx({ tier: "ui", cooldownMs: 70, durationMs: 60, render: rHover() }),
  "ui.click": fx({ tier: "action", cooldownMs: 40, durationMs: 90, render: rClick() }),
  "ui.click.primary": fx({ tier: "action", cooldownMs: 40, durationMs: 130, render: rClickPrimary() }),
  "ui.toggle.on": fx({ tier: "action", cooldownMs: 40, durationMs: 110, render: rToggle(true) }),
  "ui.toggle.off": fx({ tier: "action", cooldownMs: 40, durationMs: 110, render: rToggle(false) }),
  "ui.back": fx({
    tier: "action",
    cooldownMs: 40,
    durationMs: 90,
    render: (c, d, w, o) => {
      blip(c, d, w, { freq: 520 * p(o), freqTo: 390 * p(o), dur: 0.08 * o.decay, wave: "triangle", peak: 0.8 });
    },
  }),
  // The stepper walks a scale: callers pass pitch = 1 + norm * 0.35.
  "ui.step": fx({ tier: "ui", cooldownMs: 60, durationMs: 50, render: rStep }),
  "ui.disabled": fx({ tier: "ui", cooldownMs: 120, durationMs: 130, render: rDisabled() }),
  // Per-tab pitch is the caller's: Home 523 / Battles 587 / Desk 659.
  "nav.click": fx({ tier: "action", cooldownMs: 40, durationMs: 90, render: rClick(0.8) }),
  "nav.transition": fx({
    tier: "ui",
    cooldownMs: 200,
    durationMs: 140,
    render: (c, d, w, o) => {
      noiseBurst(c, d, w, { dur: 0.12 * o.decay, type: "lowpass", freq: 1200, freqTo: 400, peak: 0.3 });
    },
  }),
  "wallet.connect": fx({
    tier: "action",
    cooldownMs: 200,
    durationMs: 380,
    render: (c, d, w, o) => {
      blip(c, d, w, { freq: 587 * p(o), freqTo: 880 * p(o), dur: 0.16 * o.decay, wave: "triangle", peak: 0.8 });
      noiseBurst(c, d, w + 0.04, { dur: 0.35 * o.decay, hp: 6000, freq: 7500, q: 0.7, peak: 0.2 });
    },
  }),

  // spin (6)
  "spin.tick": fx({ tier: "ui", cooldownMs: 0, durationMs: 40, bus: "tick", render: rTickSampled }),
  // `durationMs` is R4/R6 accounting — how long the voice is reckoned to
  // occupy the graph — not a length the engine enforces, so the 1.3s slice
  // sits behind the same 200 the synth thunk always declared. Nothing about
  // the budget's view of this event changed, and nothing should: legs are
  // ~3.85s apart (SPIN_MS + SETTLE_MS), so the sting never overlaps itself.
  "spin.land": fx({ tier: "event", cooldownMs: 400, durationMs: 200, render: rLandSampled }),
  "spin.reveal": fx({ tier: "event", cooldownMs: 40, durationMs: 380, render: rReveal() }),
  "spin.lock": fx({ tier: "moment", cooldownMs: 400, durationMs: 520, render: rLock() }),
  "spin.skip": fx({ tier: "action", cooldownMs: 120, durationMs: 300, render: rSkip() }),
  "spin.open": fx({ tier: "event", cooldownMs: 400, durationMs: 380, render: rOpen() }),

  // room (7)
  "card.hover": fx({ tier: "ui", cooldownMs: 70, durationMs: 60, render: rHover(880, 0.7) }),
  "card.accept": fx({
    tier: "action",
    cooldownMs: 120,
    durationMs: 240,
    render: (c, d, w, o) => {
      rClickPrimary()(c, d, w, o);
      blip(c, d, w + 0.05, { freq: 440 * p(o), freqTo: 554 * p(o), dur: 0.14 * o.decay, wave: "triangle", peak: 0.6 });
    },
  }),
  "card.start": fx({
    tier: "action",
    cooldownMs: 120,
    durationMs: 260,
    render: (c, d, w, o) => {
      rClickPrimary()(c, d, w, o);
      blip(c, d, w + 0.05, { freq: 440 * p(o), freqTo: 554 * p(o), dur: 0.14 * o.decay, wave: "triangle", peak: 0.6 });
      blip(c, d, w + 0.05, { freq: 659.25 * p(o), dur: 0.14 * o.decay, wave: "triangle", peak: 0.4 });
    },
  }),
  "room.ready.me": fx({ tier: "event", cooldownMs: 200, durationMs: 260, render: rReady(587, 880) }),
  "room.ready.opp": fx({ tier: "event", cooldownMs: 200, durationMs: 260, render: rReady(493, 740, 0.7) }),
  "room.bothready": fx({
    tier: "moment",
    cooldownMs: 400,
    durationMs: 760,
    render: (c, d, w, o) => {
      const pitch = p(o);
      chord(c, d, w, {
        freqs: [330 * pitch, 495 * pitch],
        dur: 0.71 * o.decay,
        wave: "sine",
        peak: 0.7,
        attack: 0.06,
        lp: 2500,
      });
      blip(c, d, w + 0.12, { freq: 1318.5 * pitch, dur: 0.4 * o.decay, wave: "sine", peak: 0.45 });
    },
  }),
  "lobby.publish": fx({
    tier: "action",
    cooldownMs: 120,
    durationMs: 260,
    render: (c, d, w, o) => {
      rClickPrimary()(c, d, w, o);
      chord(c, d, w + 0.04, {
        freqs: [392, 523.25, 659.25].map((f) => f * p(o)),
        dur: 0.07 * o.decay,
        wave: "triangle",
        peak: 0.6,
        spreadMs: 60,
      });
    },
  }),

  // study (4)
  "study.enter": fx({
    tier: "ambient",
    cooldownMs: 400,
    durationMs: Number.POSITIVE_INFINITY,
    render: (c, d, w) => bed(c, d, w, { cutoff: 500, sub: 55, peak: 0.5, attack: 0.6, drift: 120 }),
  }),
  "wire.tick": fx({ tier: "ui", cooldownMs: 120, durationMs: 40, render: rWireTick(0.6) }),
  "wire.select": fx({ tier: "action", cooldownMs: 40, durationMs: 90, render: rClick(0.85, 726, 484) }),
  "wire.alert": fx({
    tier: "event",
    cooldownMs: 400,
    durationMs: 220,
    render: (c, d, w, o) => {
      rWireTick(1)(c, d, w, { ...o, pitch: p(o) * 1.4 });
      blip(c, d, w + 0.02, { freq: 880 * p(o), dur: 0.15 * o.decay, wave: "sine", peak: 0.5 });
    },
  }),

  // parlay (4)
  // Tier pitch is the caller's: SAFE 880 · EVEN 988 · SHARP 1174 · DEGEN 1396.
  "parlay.card.hover": fx({ tier: "ui", cooldownMs: 70, durationMs: 60, render: rHover(880) }),
  "parlay.card.pick": fx({
    tier: "action",
    cooldownMs: 40,
    durationMs: 300,
    render: (c, d, w, o) => {
      rClickPrimary()(c, d, w, o);
      const f = 880 * p(o);
      blip(c, d, w + 0.03, { freq: f * 2, dur: 0.24 * o.decay, wave: "sine", peak: 0.4 });
      // DEGEN rides highest of the four tiers, and earns an unstable, detuned
      // minor third. Divide the palette back out so BLITZ cannot promote SHARP.
      if (f / PALETTE_DETUNE[o.palette] > 1300) {
        blip(c, d, w + 0.03, { freq: f * 1.189, dur: 0.24 * o.decay, wave: "sine", peak: 0.3, detune: 15 });
      }
    },
  }),
  "parlay.slip.change": fx({ tier: "ui", cooldownMs: 200, durationMs: 50, render: rStep }),
  "parlay.lock": fx({
    tier: "moment",
    cooldownMs: 400,
    durationMs: 420,
    render: (c, d, w, o) => {
      const pitch = p(o);
      noiseBurst(c, d, w, { dur: 0.03, type: "lowpass", freq: 1200, peak: 0.6 });
      blip(c, d, w, { freq: 90, dur: 0.18 * o.decay, wave: "sine", peak: 0.8 });
      chord(c, d, w + 0.02, {
        freqs: [392, 523.25, 784].map((f) => f * pitch),
        dur: 0.24 * o.decay,
        wave: "triangle",
        peak: 0.6,
        spreadMs: 60,
      });
    },
  }),

  // duel (7)
  "duel.start": fx({
    tier: "event",
    cooldownMs: 400,
    durationMs: 700,
    render: (c, d, w, o) => {
      sweep(c, d, w, { f0: 60, f1: 180, dur: 0.6 * o.decay, lp0: 400, lp1: 1800, q: 4, peak: 0.7 });
      noiseBurst(c, d, w, { dur: 0.6 * o.decay, type: "lowpass", freq: 400, freqTo: 1800, peak: 0.25 });
    },
  }),
  "duel.tape.tick": fx({
    tier: "ambient",
    cooldownMs: 500,
    durationMs: 20,
    render: (c, d, w, o) => {
      blip(c, d, w, { freq: 2000 * p(o), dur: 0.006, wave: "sine", peak: 0.25 });
    },
  }),
  "duel.leg.hit": fx({ tier: "event", cooldownMs: 90, durationMs: 260, render: rLegHit() }),
  "duel.leg.hit.opp": fx({
    tier: "event",
    cooldownMs: 90,
    durationMs: 260,
    render: (c, d, w, o) => rLegHit(0.55)(c, d, w, { ...o, pitch: p(o) * 0.84 }),
  }),
  "duel.leg.miss": fx({
    tier: "event",
    cooldownMs: 90,
    durationMs: 300,
    render: (c, d, w, o) => {
      blip(c, d, w, { freq: 330 * p(o), freqTo: 220 * p(o), dur: 0.25 * o.decay, wave: "sine", lp: 900, peak: 0.65 });
      noiseBurst(c, d, w, { dur: 0.06, type: "lowpass", freq: 400, peak: 0.3 });
    },
  }),
  // Sustained: the engine owns the handle (R9) and passes the climb length.
  "duel.riser": fx({
    tier: "event",
    cooldownMs: 400,
    durationMs: 900,
    render: (c, d, w, o) =>
      riser(c, d, w, { f0: 110 * p(o), f1: 440 * p(o), dur: Math.max(0.32, (o.sustainMs ?? 1200) / 1000), peak: 0.5 }),
  }),
  "duel.settle.ready": fx({ tier: "event", cooldownMs: 400, durationMs: 600, render: rSettleReady() }),

  // result (4)
  "result.win": fx({ tier: "moment", cooldownMs: 400, durationMs: 2200, render: rWin(true) }),
  "result.loss": fx({
    tier: "moment",
    cooldownMs: 400,
    durationMs: 1100,
    render: (c, d, w, o) => {
      const pitch = p(o);
      chord(c, d, w, {
        freqs: [392, 329.63, 261.63].map((f) => f * pitch),
        dur: 0.16 * o.decay,
        wave: "triangle",
        peak: 0.75,
        lp: 1400,
        spreadMs: 130,
      });
      blip(c, d, w, { freq: 65.4, dur: 0.9 * o.decay, wave: "sine", peak: 0.3 });
    },
  }),
  "result.count": fx({ tier: "ui", cooldownMs: 40, durationMs: 20, render: rCount }),
  "result.count.done": fx({ tier: "action", cooldownMs: 120, durationMs: 340, render: rCountDone() }),

  // countdown (3) — plan 1's Blitz clock; registered now, called in wave 4.
  "countdown.beep": fx({
    tier: "action",
    cooldownMs: 200,
    durationMs: 90,
    render: (c, d, w, o) => {
      // `leg` carries the seconds remaining: the last beeps sit highest.
      const n = Math.max(0, Math.min(5, o.leg ?? 5));
      blip(c, d, w, {
        freq: 880 * (1 + (5 - n) * 0.06) * p(o),
        dur: 0.07 * o.decay,
        // BLITZ sharpens the clock to a square; the calmer modes stay triangle.
        wave: o.palette === "BLITZ" ? "square" : "triangle",
        lp: 3000,
        peak: 0.8,
      });
    },
  }),
  "countdown.final": fx({
    tier: "moment",
    cooldownMs: 400,
    durationMs: 300,
    render: (c, d, w, o) => {
      blip(c, d, w, { freq: 1318.5 * p(o), dur: 0.25 * o.decay, wave: "square", lp: 3400, peak: 0.6 });
    },
  }),
  "countdown.expire": fx({
    tier: "event",
    cooldownMs: 400,
    durationMs: 340,
    render: (c, d, w, o) => {
      rDisabled(0.6)(c, d, w, o);
      blip(c, d, w, { freq: 110, dur: 0.3 * o.decay, wave: "sine", peak: 0.5 });
    },
  }),

  // rank (10) — plan 4, wave 6. Mapping pinned by BUILD-ORDER C-2.
  "rank.enter": fx({ tier: "event", cooldownMs: 400, durationMs: 380, render: rOpen(0.8) }),
  "rank.reveal": fx({
    tier: "event",
    cooldownMs: 400,
    durationMs: 380,
    render: (c, d, w, o) => rReveal()(c, d, w, { ...o, leg: 0 }),
  }),
  "rank.xpTick": fx({ tier: "ui", cooldownMs: 60, durationMs: 20, render: rCount }),
  "rank.divisionUp": fx({ tier: "event", cooldownMs: 400, durationMs: 380, render: rReveal(1.12, 0.75) }),
  "rank.up": fx({ tier: "moment", cooldownMs: 400, durationMs: 700, render: rWin(false) }),
  "rank.ladder": fx({ tier: "action", cooldownMs: 120, durationMs: 340, render: rCountDone() }),
  "rank.copyUnlock": fx({ tier: "moment", cooldownMs: 400, durationMs: 520, render: rLock() }),
  "rank.copyPanel": fx({ tier: "action", cooldownMs: 120, durationMs: 130, render: rClickPrimary(0.9) }),
  "rank.done": fx({ tier: "event", cooldownMs: 400, durationMs: 600, render: rSettleReady(0.8) }),
  "rank.skip": fx({ tier: "action", cooldownMs: 120, durationMs: 300, render: rSkip() }),

  // ladder (5) — plan 4, wave 7.
  "ladder.filter": fx({ tier: "action", cooldownMs: 40, durationMs: 110, render: rToggle(true) }),
  "ladder.chip": fx({
    tier: "action",
    cooldownMs: 40,
    durationMs: 110,
    render: (c, d, w, o) => rToggle(true, 0.85)(c, d, w, { ...o, pitch: p(o) * 1.08 }),
  }),
  "ladder.chipClear": fx({ tier: "action", cooldownMs: 40, durationMs: 110, render: rToggle(false) }),
  "ladder.rowHover": fx({
    tier: "ui",
    cooldownMs: 70,
    durationMs: 60,
    render: (c, d, w, o) => rHover(1180, 0.7)(c, d, w, { ...o, pitch: p(o) * 0.92 }),
  }),
  "ladder.rowOpen": fx({ tier: "action", cooldownMs: 40, durationMs: 90, render: rClick() }),
} as const satisfies Record<string, SfxRecipe>;

/** The one true event union — derived, never hand-written. */
export type SfxName = keyof typeof SFX_MAP;

/** Palette decay scales: BLITZ is tighter and brighter, NORMAL is identity. */
export const PALETTE_DECAY: Record<Palette, number> = { NORMAL: 1, QUICK: 0.85, BLITZ: 0.7 };

/** Palette detune: +1 semitone for QUICK, +2 for BLITZ. */
export const PALETTE_DETUNE: Record<Palette, number> = { NORMAL: 1, QUICK: 1.0595, BLITZ: 1.1225 };

/** Lookup by loose string, for the completeness test's `Object.keys` walk. */
export function recipeOf(name: string): SfxRecipe | undefined {
  return (SFX_MAP as Record<string, SfxRecipe>)[name];
}
