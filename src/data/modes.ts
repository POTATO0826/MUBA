import type { Mode } from "../types.ts";
import { C, miniTag } from "../theme.ts";
import { TAPE_LEN } from "../engine/tape.ts";

/**
 * Game modes. A mode never touches `series` — every ticker keeps generating the
 * same `TAPE_LEN`-print walk. A mode picks `settleAt`: the print the duel
 * settles on. A random walk over fewer steps genuinely moves less (σ√n), so a
 * Blitz window is a tighter, jittier, smaller-percentage chart for free, with
 * no new parameter threaded through the tape and no cache-key change.
 *
 * The four knobs move together:
 *   settleAt    — how much of the walk is the duel window
 *   targetScale — every leg's target, shrunk to match the shorter window
 *   oddsBoost   — the premium the house pays for the tighter window
 *   pickSeconds — the parlay clock, the bit that makes 15 minutes FEEL short
 */
export interface ModeSpec {
  key: Mode;
  /** Badge text: `"BLITZ"`. */
  label: string;
  /** Simulated window, in minutes of market time. */
  minutes: number;
  /** Human duration for badges: `"15 MIN"`. */
  duration: string;
  /** The print the duel settles on. `NORMAL` is the whole tape. */
  settleAt: number;
  /** Multiplies every leg's target (`buildLeg`). */
  targetScale: number;
  /** Multiplies the slip's parlay multiplier (`summarize`). */
  oddsBoost: number;
  /** Seconds on the parlay clock; `null` means untimed. */
  pickSeconds: number | null;
  color: string;
  /** Wall-clock playback length, e.g. `"2.2"` seconds. */
  wallSeconds: string;
  /** Simulated-time compression, ready to print: `"402"`, `"10,800"`. */
  compression: string;
  blurb: string;
}

/**
 * Compression = simulated seconds ÷ real playback seconds.
 *
 * Playback is fixed at `TAPE_STEP = 3` prints per 120ms tick (state/match.ts),
 * so one print costs 40ms of wall clock and a window of `settleAt` prints plays
 * in `settleAt * 40` ms:
 *
 *   BLITZ   56 × 40ms = 2_240ms →  900s ÷ 2.24s =   401.8 → ×402
 *   QUICK  110 × 40ms = 4_400ms → 3600s ÷ 4.40s =   818.2 → ×818
 *   NORMAL 200 × 40ms = 8_000ms → 86400s ÷ 8.0s = 10800.0 → ×10,800
 *
 * which reduces to `minutes * 1500 / settleAt`. Derived, not typed in, so the
 * badge can never drift from the numbers above it.
 */
const MS_PER_PRINT = 120 / 3;
const wallMs = (settleAt: number): number => settleAt * MS_PER_PRINT;
const compressionOf = (minutes: number, settleAt: number): string =>
  Math.round((minutes * 60_000) / wallMs(settleAt)).toLocaleString("en-US");

function spec(
  key: Mode,
  minutes: number,
  duration: string,
  settleAt: number,
  targetScale: number,
  oddsBoost: number,
  pickSeconds: number | null,
  color: string,
  blurb: string,
): ModeSpec {
  return {
    key,
    label: key,
    minutes,
    duration,
    settleAt,
    targetScale,
    oddsBoost,
    pickSeconds,
    color,
    wallSeconds: (wallMs(settleAt) / 1000).toFixed(1),
    compression: compressionOf(minutes, settleAt),
    blurb,
  };
}

export const MODES: Record<Mode, ModeSpec> = {
  BLITZ: spec(
    "BLITZ",
    15,
    "15 MIN",
    56,
    0.62,
    1.35,
    20,
    C.red,
    "Fifteen minutes of tape in two seconds. Tight targets, a 20-second clock, the fattest payout on the board.",
  ),
  QUICK: spec(
    "QUICK",
    60,
    "1 HOUR",
    110,
    0.82,
    1.15,
    45,
    C.amber,
    "One session hour. Enough window to trend, short enough that a quiet tape still ends 0–0.",
  ),
  NORMAL: spec(
    "NORMAL",
    1440,
    "24 HOURS",
    TAPE_LEN,
    1,
    1,
    null,
    C.blue,
    "The full day and the full tape. No clock, base targets, base odds — the house edition.",
  ),
};

/** Fastest first — the order every picker and filter row renders in. */
export const MODE_ORDER: readonly Mode[] = ["BLITZ", "QUICK", "NORMAL"];

/**
 * Added to both match salts, so the same seed in a different mode draws a
 * genuinely different window rather than a prefix of the same one.
 *
 * `NORMAL: 0` is the no-regression guard: today's demo stays byte-identical.
 * The other two are primes, far apart, so `seed * 3` can never collide them.
 */
export const MODE_SALT: Record<Mode, number> = {
  NORMAL: 0,
  QUICK: 1_000_003,
  BLITZ: 2_000_029,
};

/** Card backdrop per mode: `[gradient stop, radial tint, angle]` — the
 *  `MARKET_WALL` idiom, so the two can be blended on card art. */
export const MODE_WALL: Record<Mode, [string, string, number]> = {
  BLITZ: ["#2a0f12", "rgba(248,113,113,.22)", 150],
  QUICK: ["#2a1c08", "rgba(245,158,11,.2)", 135],
  NORMAL: ["#0c2230", "rgba(56,189,248,.18)", 130],
};

/** Mode chip style. Lives here rather than in theme.ts: theme.ts imports
 *  nothing, and this needs `MODES` — the other direction would cycle. BLITZ
 *  alone pulses, on the keyframe styles.css already ships. */
export const modeTag = (mode: Mode): string =>
  miniTag(MODES[mode].color) +
  (mode === "BLITZ" ? ";animation:vcPulse 1.6s ease-in-out infinite" : "");
