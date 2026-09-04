import type { Mode } from "../types.ts";
import type { SfxName } from "../lib/sound/index.ts";
import { DIVISIONS, TIERS, type RankTier, tierIndex } from "../data/rewards.ts";

/**
 * Rank maths — pure, no DOM, no React, no clock.
 *
 * Everything the rank moment renders is a function of two integers: the XP
 * before the duel and the XP after it. `rankAt` places a total on the ladder,
 * `xpSegments` cuts the before→after gain at every band the player crosses,
 * and `rankTimeline` turns those segments into a beat sheet the view replays
 * against a single rAF `elapsed`. The view owns no maths; this file owns no
 * pixels.
 *
 * Naming: `RANK_TIERS` / `RankTier`, never `TIERS` / `Tier` — `engine/parlay.ts`
 * already exports both of those for parlay cards, and `Result.tsx` imports from
 * both files.
 */

/** The five season tiers, re-exported under the rank-side name. */
export const RANK_TIERS = TIERS;

/**
 * WHALE has no tier above it, so it has no natural band width. It gets a
 * synthetic 3000-wide band (the same width as ORCA's) split into the usual
 * three divisions, so the progress bar keeps moving instead of dead-ending at
 * a permanently full ring the moment a player caps out.
 */
export const WHALE_BAND = 3000;

/** A point on the ladder: a tier, a division inside it, and the bar's fill. */
export interface RankPoint {
  tier: RankTier;
  /** Index into `RANK_TIERS`, 0 = MINNOW. */
  tierIndex: number;
  /** 0 = III (entry band), 1 = II, 2 = I (top band). */
  division: 0 | 1 | 2;
  /** `"SHARK II"` — what the tier word renders. */
  label: string;
  /** XP at the bottom of this division's band. */
  floor: number;
  /** XP at the top of this division's band. */
  ceil: number;
  /** XP earned inside the band. */
  into: number;
  /** Band width, `ceil - floor`. */
  span: number;
  /** `into / span`, clamped to 0…1. */
  pct: number;
}

export type CrossKind = "division" | "tier";

/** One leg of the XP bar's fill: run to `pct1`, then snap if `cross` is set. */
export interface Segment {
  from: number;
  to: number;
  pct0: number;
  pct1: number;
  cross: CrossKind | null;
}

export type Stage = "shutter" | "badge" | "xpCount" | "flourish" | "ladder" | "copy" | "settle";

/** Stage order, used as the tie-break when two beats share a `t`. */
export const STAGE_ORDER: readonly Stage[] = [
  "shutter",
  "badge",
  "xpCount",
  "flourish",
  "ladder",
  "copy",
  "settle",
];

export interface Beat {
  /** Milliseconds from the start of the sequence. Non-decreasing across beats. */
  t: number;
  stage: Stage;
  sound: SfxName;
}

export interface Timeline {
  /** Total run time in ms; skip parks `elapsed` here. */
  total: number;
  beats: Beat[];
  segments: Segment[];
}

/** Base run time with no crossing (plan 4 section 4). */
export const TIMELINE_BASE = 3900;
/** Added to the run time for every division or tier crossing. */
export const FLOURISH_MS = 700;
/** The XP bar's own fill budget, split across the segments. */
const XP_WINDOW = 1200;
const SHUTTER_MS = 380;
const BADGE_MS = 520;
const LADDER_MS = 500;
const COPY_MS = 800;
const SETTLE_MS = 500;
const XP_TICKS = 12;
/** `rank.xpTick` cooldown in the sound map — beats closer than this are dropped. */
const TICK_GAP = 60;

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);
const atLeast0 = (xp: number): number => (Number.isFinite(xp) && xp > 0 ? xp : 0);

const tierAt = (i: number): RankTier | null => RANK_TIERS[i] ?? null;

/** The XP width of a tier's whole band; WHALE gets the synthetic one. */
function tierSpan(i: number): number {
  const cur = tierAt(i);
  const next = tierAt(i + 1);
  if (!cur) return WHALE_BAND;
  return next ? next.xp - cur.xp : WHALE_BAND;
}

/**
 * Where a total sits on the ladder. Negative XP clamps to 0; XP above WHALE's
 * synthetic band saturates at `WHALE I`, `pct === 1`.
 */
export function rankAt(xp: number): RankPoint {
  const v = atLeast0(xp);
  let idx = 0;
  for (let i = 0; i < RANK_TIERS.length; i++) {
    const t = tierAt(i);
    if (t && v >= t.xp) idx = i;
  }
  const tier = tierAt(idx) ?? RANK_TIERS[0];
  const band = tierSpan(idx) / DIVISIONS.length;
  const intoTier = v - tier.xp;
  const d = Math.min(DIVISIONS.length - 1, Math.max(0, Math.floor(intoTier / band))) as 0 | 1 | 2;
  const floor = tier.xp + d * band;
  const ceil = floor + band;
  const into = v - floor;
  return {
    tier,
    tierIndex: idx,
    division: d,
    label: `${tier.name} ${DIVISIONS[d]}`,
    floor,
    ceil,
    into,
    span: band,
    pct: clamp01(into / band),
  };
}

/** Every division floor on the ladder, ascending, tagged with what it crosses. */
function allFloors(): { xp: number; kind: CrossKind }[] {
  const out: { xp: number; kind: CrossKind }[] = [];
  for (let i = 0; i < RANK_TIERS.length; i++) {
    const t = tierAt(i);
    if (!t) continue;
    const band = tierSpan(i) / DIVISIONS.length;
    for (let d = 0; d < DIVISIONS.length; d++) {
      out.push({ xp: t.xp + d * band, kind: d === 0 ? "tier" : "division" });
    }
  }
  return out;
}

/**
 * Cuts the before→after gain at every band floor crossed, so the bar can fill,
 * snap 100 → 0, and continue — the way a real game bar behaves — instead of
 * lerping through a tier-up as if nothing happened.
 *
 * A segment that ends on a floor reports `pct1 === 1` (the bar is full at the
 * moment of the crossing) and the next one starts at `pct0 === 0`. A gain of
 * zero (or a negative one) is a single `cross: null` segment.
 */
export function xpSegments(before: number, after: number): Segment[] {
  const a = atLeast0(before);
  const b = atLeast0(after);
  if (b <= a) {
    return [{ from: a, to: b, pct0: rankAt(a).pct, pct1: rankAt(b).pct, cross: null }];
  }
  const cuts = allFloors()
    .filter((f) => f.xp > a && f.xp <= b)
    .sort((x, y) => x.xp - y.xp);

  const segs: Segment[] = [];
  let cur = a;
  for (const cut of cuts) {
    segs.push({
      from: cur,
      to: cut.xp,
      pct0: cur === a ? rankAt(a).pct : 0,
      pct1: 1,
      cross: cut.kind,
    });
    cur = cut.xp;
  }
  if (cur < b || segs.length === 0) {
    segs.push({
      from: cur,
      to: b,
      pct0: cur === a ? rankAt(a).pct : 0,
      pct1: rankAt(b).pct,
      cross: null,
    });
  }
  return segs;
}

/** Number of division/tier floors the gain crosses. */
export const crossingsIn = (segments: readonly Segment[]): number =>
  segments.filter((s) => s.cross !== null).length;

/**
 * The beat sheet for the rank moment (plan 4 section 4). Stage windows are
 * fixed — shutter 380, badge 520, fill 1200, ladder 500, copy 800, settle 500 —
 * and a crossing splices a 700ms flourish in where it lands, which is why the
 * total is `3900 + 700 * crossings` rather than a constant.
 *
 * `unlockedCopy` is the caller's before→after copy-trade transition: true only
 * when the player did not have copy-trade and now does. It picks the copy
 * stage's sound and nothing else.
 */
export function rankTimeline(before: number, after: number, unlockedCopy: boolean): Timeline {
  const segments = xpSegments(before, after);
  const crossings = crossingsIn(segments);
  const beats: Beat[] = [];

  beats.push({ t: 0, stage: "shutter", sound: "rank.enter" });
  beats.push({ t: SHUTTER_MS, stage: "badge", sound: "rank.reveal" });

  const xpStart = SHUTTER_MS + BADGE_MS;
  const gain = segments.reduce((n, s) => n + Math.max(0, s.to - s.from), 0);

  // Fill sub-intervals in timeline time: one per segment, with the flourish
  // pauses excluded, so the ticks land on the moving bar and not on the snap.
  const fills: { start: number; dur: number }[] = [];
  let t = xpStart;
  for (const seg of segments) {
    const dur =
      gain > 0 ? (XP_WINDOW * Math.max(0, seg.to - seg.from)) / gain : XP_WINDOW / segments.length;
    fills.push({ start: t, dur });
    t += dur;
    if (seg.cross) {
      beats.push({
        t,
        stage: "flourish",
        sound: seg.cross === "tier" ? "rank.up" : "rank.divisionUp",
      });
      t += FLOURISH_MS;
    }
  }

  // XP_TICKS ticks spread evenly across the fill *budget*, mapped back onto the
  // sub-intervals, then thinned to the sound map's 60ms cooldown so no tick is
  // silently swallowed.
  let lastTick = -Infinity;
  for (let k = 0; k < XP_TICKS; k++) {
    let off = (XP_WINDOW * k) / XP_TICKS;
    let at = xpStart;
    for (const f of fills) {
      if (off <= f.dur) {
        at = f.start + off;
        break;
      }
      off -= f.dur;
      at = f.start + f.dur;
    }
    if (at - lastTick < TICK_GAP) continue;
    lastTick = at;
    beats.push({ t: at, stage: "xpCount", sound: "rank.xpTick" });
  }

  const ladderAt = xpStart + XP_WINDOW + FLOURISH_MS * crossings;
  beats.push({ t: ladderAt, stage: "ladder", sound: "rank.ladder" });

  const crossedIntoCopy =
    unlockedCopy && segments.some((s) => s.cross !== null && rankAt(s.to).tier.copyUnlocked);
  beats.push({
    t: ladderAt + LADDER_MS,
    stage: "copy",
    sound: crossedIntoCopy ? "rank.copyUnlock" : "rank.copyPanel",
  });
  beats.push({ t: ladderAt + LADDER_MS + COPY_MS, stage: "settle", sound: "rank.done" });

  const rank = (s: Stage): number => STAGE_ORDER.indexOf(s);
  beats.sort((x, y) => x.t - y.t || rank(x.stage) - rank(y.stage));

  return {
    total: ladderAt + LADDER_MS + COPY_MS + SETTLE_MS,
    beats,
    segments,
  };
}

/** easeOutCubic — the XP bar's fill curve. `xpEase(0) === 0`, `xpEase(1) === 1`. */
export function xpEase(t: number): number {
  const x = clamp01(t);
  return 1 - (1 - x) * (1 - x) * (1 - x);
}

/**
 * XP paid per duel, by mode (BUILD-ORDER section C-3). The faster window pays
 * more: a Blitz duel is 2.2 seconds of wall clock, so it has to be worth
 * banking.
 */
export const XP_FOR: Record<Mode, number> = { BLITZ: 120, QUICK: 80, NORMAL: 50 };

/**
 * The one XP rule: a win pays the mode's rate, a sweep (every leg landed)
 * doubles it, a loss still pays 40% so a session always moves forward.
 * Range 20 – 240.
 */
export function xpForMatch(mode: Mode, sweep: boolean, won: boolean): number {
  return Math.round(XP_FOR[mode] * (won ? (sweep ? 2 : 1) : 0.4));
}

/** Re-exported so rank code has one import for the whole model. */
export { DIVISIONS, tierIndex };
