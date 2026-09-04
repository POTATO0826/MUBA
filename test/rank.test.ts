/**
 * Rank maths — the pure half (plan 4 step 2).
 *
 * Everything here is a function of integers, so every assertion is exact.
 * `engine/rank.ts` must never grow a DOM, a clock or a random source; if one of
 * these tests ever needs a fake timer, the boundary has been broken.
 *
 * The second half of this file covers the generator (`data/leaderboard.ts`:
 * PERSONAS, copyEconomicsFor, LEADERBOARD, rankedBy, winsIn, positionOf,
 * buildYou) and is held to the same bar — its inputs are ids and integers, so
 * a seeded LCG is the only randomness anywhere in here.
 */

import { describe, expect, test } from "bun:test";
import {
  COPY_FEE,
  DIVISIONS,
  TIERS,
  type RankTier,
  nextTier,
  tierFor,
  tierIndex,
} from "../src/data/rewards.ts";
import {
  FLOURISH_MS,
  RANK_TIERS,
  type Segment,
  TIMELINE_BASE,
  WHALE_BAND,
  XP_FOR,
  crossingsIn,
  rankAt,
  rankTimeline,
  xpEase,
  xpForMatch,
  xpSegments,
} from "../src/engine/rank.ts";
import type { Mode } from "../src/types.ts";

/** The band width of a tier, mirroring rank.ts's rule from the source data. */
function bandOf(i: number): number {
  const cur = RANK_TIERS[i]!;
  const next = RANK_TIERS[i + 1];
  return ((next ? next.xp - cur.xp : WHALE_BAND) / DIVISIONS.length);
}

/** Every division floor on the ladder, recomputed independently of rank.ts. */
function floors(): { xp: number; tier: RankTier; d: number }[] {
  const out: { xp: number; tier: RankTier; d: number }[] = [];
  RANK_TIERS.forEach((t, i) => {
    for (let d = 0; d < DIVISIONS.length; d++) out.push({ xp: t.xp + d * bandOf(i), tier: t, d });
  });
  return out;
}

describe("rewards extension — additive, nothing broken", () => {
  test("the five names and their XP thresholds are untouched", () => {
    expect(TIERS.map((t) => t.name)).toEqual(["MINNOW", "FISH", "SHARK", "ORCA", "WHALE"]);
    expect(TIERS.map((t) => t.xp)).toEqual([0, 500, 1500, 3000, 6000]);
  });

  test("copy-trade fields: SHARK and up, copierBase 0/0/40/160/520, feeShare = COPY_FEE", () => {
    expect(COPY_FEE).toBe(0.035);
    expect(TIERS.map((t) => t.copyUnlocked)).toEqual([false, false, true, true, true]);
    expect(TIERS.map((t) => t.copierBase)).toEqual([0, 0, 40, 160, 520]);
    for (const t of TIERS) expect(t.feeShare).toBe(t.copyUnlocked ? COPY_FEE : 0);
    // A locked tier's projection is 0 by arithmetic, not by a branch.
    expect(TIERS.filter((t) => t.copierBase > 0).every((t) => t.copyUnlocked)).toBe(true);
  });

  test("DIVISIONS run low → high", () => {
    expect(DIVISIONS).toEqual(["III", "II", "I"]);
  });

  test("tierFor / nextTier / tierIndex behave exactly as before the extension", () => {
    expect(tierFor(0).name).toBe("MINNOW");
    expect(tierFor(500).name).toBe("FISH");
    expect(tierFor(2340).name).toBe("SHARK");
    expect(tierFor(6000).name).toBe("WHALE");
    expect(tierFor(99999).name).toBe("WHALE");
    expect(nextTier(0)?.name).toBe("FISH");
    expect(nextTier(2340)?.name).toBe("ORCA");
    expect(nextTier(6000)).toBeNull();
    expect(nextTier(99999)).toBeNull();
    expect(tierIndex("SHARK")).toBe(2);
    expect(tierIndex("NOPE")).toBe(-1);
  });
});

describe("rankAt", () => {
  test("every tier threshold lands on that tier's III band, one XP below on the tier under it", () => {
    for (let i = 0; i < RANK_TIERS.length; i++) {
      const t = RANK_TIERS[i]!;
      const at = rankAt(t.xp);
      expect(at.tier.name).toBe(t.name);
      expect(at.tierIndex).toBe(i);
      expect(at.division).toBe(0);
      expect(at.into).toBe(0);
      expect(at.pct).toBe(0);
      if (i > 0) {
        const below = rankAt(t.xp - 1);
        expect(below.tierIndex).toBe(i - 1);
        expect(below.division).toBe(2);
        expect(below.pct).toBeGreaterThan(0.99);
      }
    }
  });

  test("every division floor ±1 XP sits on the right side of the band", () => {
    for (const f of floors()) {
      const on = Math.ceil(f.xp);
      expect(rankAt(on).tier.name).toBe(f.tier.name);
      expect(rankAt(on).division).toBe(f.d as 0 | 1 | 2);
      if (on > 0) {
        const under = rankAt(on - 1);
        // One XP under a floor is never in the band that floor opens.
        expect(under.tier.name === f.tier.name && under.division === f.d).toBe(false);
      }
    }
    // 15 floors: five tiers × three divisions.
    expect(floors().length).toBe(15);
  });

  test("labels read TIER DIVISION, low band first", () => {
    expect(rankAt(1500).label).toBe("SHARK III");
    expect(rankAt(2340).label).toBe("SHARK II");
    expect(rankAt(2500).label).toBe("SHARK I");
    expect(rankAt(0).label).toBe("MINNOW III");
    expect(rankAt(6000).label).toBe("WHALE III");
  });

  test("floor / ceil / into / span / pct are internally consistent everywhere", () => {
    for (const xp of [0, 1, 166, 167, 499, 500, 900, 1499, 1500, 2340, 2999, 4200, 6000, 8500]) {
      const r = rankAt(xp);
      expect(r.ceil - r.floor).toBeCloseTo(r.span, 10);
      expect(r.into).toBeCloseTo(xp - r.floor, 10);
      expect(r.pct).toBeCloseTo(r.into / r.span, 10);
      expect(r.pct).toBeGreaterThanOrEqual(0);
      expect(r.pct).toBeLessThanOrEqual(1);
      expect(r.floor).toBeGreaterThanOrEqual(r.tier.xp);
    }
    // The pinned demo player: SHARK II, 340 XP into a 500-wide band.
    const p = rankAt(2340);
    expect(p.floor).toBe(2000);
    expect(p.ceil).toBe(2500);
    expect(p.span).toBe(500);
    expect(p.into).toBe(340);
    expect(p.pct).toBeCloseTo(0.68, 10);
  });

  test("WHALE gets a synthetic 3000-wide band so the bar never dead-ends", () => {
    expect(WHALE_BAND).toBe(3000);
    expect(rankAt(6000).span).toBe(1000);
    expect(rankAt(7000).label).toBe("WHALE II");
    expect(rankAt(8000).label).toBe("WHALE I");
    expect(rankAt(8500).pct).toBeCloseTo(0.5, 10);
    // Past the synthetic band it saturates rather than rolling over.
    const capped = rankAt(99999);
    expect(capped.label).toBe("WHALE I");
    expect(capped.division).toBe(2);
    expect(capped.pct).toBe(1);
  });

  test("negative XP clamps to zero", () => {
    expect(rankAt(-1).label).toBe("MINNOW III");
    expect(rankAt(-99999).pct).toBe(0);
    expect(rankAt(-1).into).toBe(0);
  });
});

/** Segments must chain end-to-end and stay inside 0…1. */
function assertChained(segs: readonly Segment[], before: number, after: number): void {
  expect(segs.length).toBeGreaterThan(0);
  expect(segs[0]!.from).toBe(before);
  expect(segs[segs.length - 1]!.to).toBe(after);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    expect(s.to).toBeGreaterThanOrEqual(s.from);
    expect(s.pct0).toBeGreaterThanOrEqual(0);
    expect(s.pct1).toBeLessThanOrEqual(1);
    if (i > 0) {
      expect(s.from).toBe(segs[i - 1]!.to);
      // Every non-first segment starts from an empty bar — the snap.
      expect(s.pct0).toBe(0);
      expect(segs[i - 1]!.pct1).toBe(1);
    }
  }
}

describe("xpSegments", () => {
  test("a gain inside one band is a single segment with no crossing", () => {
    const segs = xpSegments(2100, 2340);
    expect(segs.length).toBe(1);
    expect(crossingsIn(segs)).toBe(0);
    expect(segs[0]!.cross).toBeNull();
    expect(segs[0]!.pct0).toBeCloseTo(0.2, 10);
    expect(segs[0]!.pct1).toBeCloseTo(0.68, 10);
    assertChained(segs, 2100, 2340);
  });

  test("one division crossing splits into two segments: fill to full, then snap", () => {
    const segs = xpSegments(2340, 2580);
    expect(segs.length).toBe(2);
    expect(crossingsIn(segs)).toBe(1);
    expect(segs[0]!.cross).toBe("division");
    expect(segs[0]!.to).toBe(2500);
    expect(segs[0]!.pct1).toBe(1);
    expect(segs[1]!.cross).toBeNull();
    expect(segs[1]!.pct0).toBe(0);
    expect(segs[1]!.pct1).toBeCloseTo(0.16, 10);
    assertChained(segs, 2340, 2580);
  });

  test("a tier crossing is tagged 'tier', a division crossing 'division'", () => {
    const segs = xpSegments(1400, 1600);
    expect(segs.length).toBe(2);
    expect(segs[0]!.cross).toBe("tier");
    expect(segs[0]!.to).toBe(1500);
    expect(rankAt(segs[0]!.to).tier.name).toBe("SHARK");
    expect(segs[1]!.cross).toBeNull();
    // The same-width division floor above it is only a division.
    expect(xpSegments(1900, 2100)[0]!.cross).toBe("division");
  });

  test("a span covering a tier and its divisions reports every crossing in order", () => {
    const segs = xpSegments(1400, 2600);
    expect(segs.map((s) => s.cross)).toEqual(["tier", "division", "division", null]);
    expect(segs.map((s) => s.to)).toEqual([1500, 2000, 2500, 2600]);
    expect(crossingsIn(segs)).toBe(3);
    assertChained(segs, 1400, 2600);
  });

  test("a multi-tier run crosses every floor between the two totals, exactly once each", () => {
    const segs = xpSegments(0, 9000);
    // 15 floors on the ladder, of which MINNOW III's (0) is not above `before`.
    expect(crossingsIn(segs)).toBe(14);
    expect(segs.filter((s) => s.cross === "tier").length).toBe(4);
    expect(segs.filter((s) => s.cross === "division").length).toBe(10);
    // 9000 is WHALE I's ceiling, not a floor, so a tail segment carries the
    // last stretch — and it ends on a saturated bar.
    expect(segs.length).toBe(15);
    expect(segs[segs.length - 1]!.cross).toBeNull();
    expect(segs[segs.length - 1]!.from).toBe(8000);
    expect(segs[segs.length - 1]!.pct1).toBe(1);
    assertChained(segs, 0, 9000);
  });

  test("landing exactly on a floor fills the bar rather than resetting it", () => {
    const segs = xpSegments(1900, 2000);
    expect(segs.length).toBe(1);
    expect(segs[0]!.cross).toBe("division");
    expect(segs[0]!.pct1).toBe(1);
  });

  test("zero gain is one null segment; the bar does not move", () => {
    const segs = xpSegments(2340, 2340);
    expect(segs.length).toBe(1);
    expect(segs[0]!.cross).toBeNull();
    expect(segs[0]!.from).toBe(2340);
    expect(segs[0]!.to).toBe(2340);
    expect(segs[0]!.pct0).toBe(segs[0]!.pct1);
    expect(crossingsIn(segs)).toBe(0);
    // A negative gain (never produced by xpForMatch) is still one flat segment.
    expect(xpSegments(2340, 2000).length).toBe(1);
    expect(xpSegments(2340, 2000)[0]!.cross).toBeNull();
  });
});

describe("rankTimeline", () => {
  const stages = (before: number, after: number, unlocked = false) =>
    rankTimeline(before, after, unlocked).beats.map((b) => b.stage);

  test("beats never go backwards in time and run in stage order", () => {
    for (const [a, b] of [
      [2100, 2340],
      [2340, 2580],
      [1400, 2600],
      [0, 9000],
      [2340, 2340],
    ] as const) {
      const beats = rankTimeline(a, b, true).beats;
      for (let i = 1; i < beats.length; i++) {
        expect(beats[i]!.t).toBeGreaterThanOrEqual(beats[i - 1]!.t);
      }
      expect(beats[0]!.stage).toBe("shutter");
      expect(beats[0]!.t).toBe(0);
      expect(beats[1]!.stage).toBe("badge");
      expect(beats[1]!.t).toBe(380);
      expect(beats[beats.length - 1]!.stage).toBe("settle");
      expect(beats[beats.length - 1]!.sound).toBe("rank.done");
      expect(beats[beats.length - 1]!.t).toBeLessThanOrEqual(rankTimeline(a, b, true).total);
    }
  });

  test("total is 3900ms plus 700ms per crossing", () => {
    expect(TIMELINE_BASE).toBe(3900);
    expect(FLOURISH_MS).toBe(700);
    for (const [a, b] of [
      [2100, 2340],
      [2340, 2580],
      [1400, 1600],
      [1400, 2600],
      [0, 9000],
      [2340, 2340],
    ] as const) {
      const tl = rankTimeline(a, b, false);
      const c = crossingsIn(tl.segments);
      expect(tl.total).toBe(TIMELINE_BASE + FLOURISH_MS * c);
      // The tail stages shift with the flourishes, they do not compress.
      const at = (s: string) => tl.beats.find((x) => x.stage === s)!.t;
      expect(at("ladder")).toBe(2100 + FLOURISH_MS * c);
      expect(at("copy")).toBe(2600 + FLOURISH_MS * c);
      expect(at("settle")).toBe(3400 + FLOURISH_MS * c);
    }
  });

  test("rank.up fires only on a tier change; a division crossing gets rank.divisionUp", () => {
    const division = rankTimeline(2340, 2580, false);
    expect(division.beats.filter((b) => b.sound === "rank.up").length).toBe(0);
    expect(division.beats.filter((b) => b.sound === "rank.divisionUp").length).toBe(1);

    const tier = rankTimeline(1400, 1600, false);
    expect(tier.beats.filter((b) => b.sound === "rank.up").length).toBe(1);
    expect(tier.beats.filter((b) => b.sound === "rank.divisionUp").length).toBe(0);

    const flat = rankTimeline(2100, 2340, false);
    expect(flat.beats.some((b) => b.stage === "flourish")).toBe(false);

    // 1400 → 2600 is one tier floor and two division floors.
    const many = rankTimeline(1400, 2600, false);
    expect(many.beats.filter((b) => b.sound === "rank.up").length).toBe(1);
    expect(many.beats.filter((b) => b.sound === "rank.divisionUp").length).toBe(2);
    expect(many.beats.filter((b) => b.stage === "flourish").length).toBe(3);
  });

  test("every stage is present once (bar the flourishes and the xp ticks)", () => {
    const s = stages(2340, 2580);
    for (const stage of ["shutter", "badge", "ladder", "copy", "settle"]) {
      expect(s.filter((x) => x === stage).length).toBe(1);
    }
    expect(s.filter((x) => x === "flourish").length).toBe(1);
  });

  test("rank.xpTick is spread across the fill, never closer than its 60ms cooldown", () => {
    for (const [a, b] of [
      [2100, 2340],
      [2340, 2580],
      [1400, 2600],
      [2340, 2340],
    ] as const) {
      const ticks = rankTimeline(a, b, false).beats.filter((x) => x.sound === "rank.xpTick");
      expect(ticks.length).toBe(12);
      expect(ticks[0]!.t).toBe(900);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]!.t - ticks[i - 1]!.t).toBeGreaterThanOrEqual(60);
      }
      for (const t of ticks) expect(t.stage).toBe("xpCount");
    }
  });

  test("the copy stage says unlock only when a crossing lands in a copy-unlocked tier", () => {
    const soundOf = (a: number, b: number, u: boolean) =>
      rankTimeline(a, b, u).beats.find((x) => x.stage === "copy")!.sound;
    // MINNOW → SHARK with the transition flag set: the unlock moment.
    expect(soundOf(1400, 1600, true)).toBe("rank.copyUnlock");
    // Same crossing, but the caller says copy-trade was already unlocked.
    expect(soundOf(1400, 1600, false)).toBe("rank.copyPanel");
    // A crossing that lands in a locked tier can never be an unlock.
    expect(soundOf(100, 200, true)).toBe("rank.copyPanel");
    // No crossing at all.
    expect(soundOf(2100, 2340, true)).toBe("rank.copyPanel");
  });

  test("segments come back on the timeline so the view needs one call", () => {
    const tl = rankTimeline(2340, 2580, false);
    expect(tl.segments).toEqual(xpSegments(2340, 2580));
  });
});

describe("xpEase", () => {
  test("easeOutCubic: pinned endpoints, clamped input, monotone rise", () => {
    expect(xpEase(0)).toBe(0);
    expect(xpEase(1)).toBe(1);
    expect(xpEase(-2)).toBe(0);
    expect(xpEase(4)).toBe(1);
    expect(xpEase(0.5)).toBeCloseTo(0.875, 10);
    let prev = -1;
    for (let i = 0; i <= 20; i++) {
      const v = xpEase(i / 20);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
    // "Out" means it front-loads: half the time is well past half the fill.
    expect(xpEase(0.5)).toBeGreaterThan(0.5);
  });
});

describe("XP per match", () => {
  test("XP_FOR is pinned per mode — the shorter the window, the bigger the pay", () => {
    expect(XP_FOR).toEqual({ BLITZ: 120, QUICK: 80, NORMAL: 50 });
  });

  test("a win pays the rate, a sweep doubles it, a loss pays 40%", () => {
    const modes: readonly Mode[] = ["BLITZ", "QUICK", "NORMAL"];
    for (const m of modes) {
      expect(xpForMatch(m, false, true)).toBe(XP_FOR[m]);
      expect(xpForMatch(m, true, true)).toBe(XP_FOR[m] * 2);
      expect(xpForMatch(m, false, false)).toBe(Math.round(XP_FOR[m] * 0.4));
      // A sweep on a loss is not a thing, but it must not pay double.
      expect(xpForMatch(m, true, false)).toBe(Math.round(XP_FOR[m] * 0.4));
    }
    expect(xpForMatch("BLITZ", true, true)).toBe(240);
    expect(xpForMatch("NORMAL", false, false)).toBe(20);
  });

  test("the whole range stays inside 20 – 240, always an integer", () => {
    const modes: readonly Mode[] = ["BLITZ", "QUICK", "NORMAL"];
    for (const m of modes)
      for (const sweep of [false, true])
        for (const won of [false, true]) {
          const xp = xpForMatch(m, sweep, won);
          expect(Number.isInteger(xp)).toBe(true);
          expect(xp).toBeGreaterThanOrEqual(20);
          expect(xp).toBeLessThanOrEqual(240);
        }
  });

  test("a duel's XP moves the bar but rarely the tier — that is why divisions exist", () => {
    // 50–240 XP against SHARK's 500-wide divisions: a division-up every 2–4
    // duels, a tier-up every 3–6. Plan 4 §2's rationale, made checkable.
    const before = 2340;
    const after = before + xpForMatch("BLITZ", false, true);
    expect(crossingsIn(xpSegments(before, after))).toBe(0);
    expect(crossingsIn(xpSegments(before, before + 240))).toBe(1);
    expect(rankAt(before).tier.name).toBe(rankAt(before + 240).tier.name);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The generator half (plan 4 step 3, `src/data/leaderboard.ts`).
//
// Still pure — no DOM, no clock, no Math.random. Everything below is either an
// exact identity or a structural invariant of the single-latent-variable
// generator, so a failure here means a persona's numbers stopped agreeing with
// each other, not that a threshold drifted.
// ───────────────────────────────────────────────────────────────────────────

import {
  LADDER_FILTERS,
  LEADERBOARD,
  type LeaderPlayer,
  PERSONAS,
  type Selection,
  build,
  buildYou,
  copyEconomicsFor,
  leaderboardWith,
  positionOf,
  rankedBy,
  winsIn,
} from "../src/data/leaderboard.ts";
import { MODE_ORDER } from "../src/data/modes.ts";
import { SECTOR_ORDER } from "../src/data/sectors.ts";
import { OPPONENTS } from "../src/data/lobbies.ts";
import { SETTLED_CASES } from "../src/data/fixtures.ts";
import { PLAYER } from "../src/data/rewards.ts";

/**
 * Kendall's tau over the roster: +1 = identical ordering, 0 = unrelated,
 * −1 = reversed. Used instead of "sorted() equals sorted()" because the
 * generator carries deliberate noise — the question is whether two columns
 * tell the same story, not whether they agree on every single pair.
 */
function tau(f: (p: LeaderPlayer) => number, g: (p: LeaderPlayer) => number): number {
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < LEADERBOARD.length; i++) {
    for (let j = i + 1; j < LEADERBOARD.length; j++) {
      const a = LEADERBOARD[i]!;
      const b = LEADERBOARD[j]!;
      if ((f(a) - f(b)) * (g(a) - g(b)) > 0) concordant++;
      else discordant++;
    }
  }
  return (concordant - discordant) / (concordant + discordant);
}

const SEL_NONE: Selection = { sectors: [], modes: [] };

describe("PERSONAS — the roster is the union, not a copy of it", () => {
  test("every lobby host and every settled-case face is on the ladder, once", () => {
    const names = new Set(PERSONAS.map((p) => p.name));
    for (const o of OPPONENTS) expect(names.has(o.name)).toBe(true);
    for (const s of SETTLED_CASES) expect(names.has(s.who)).toBe(true);
    // Deduped by name: OPPONENTS' 8 plus the 5 faces only the marquee shows.
    expect(PERSONAS.length).toBe(13);
    expect(names.size).toBe(PERSONAS.length);
  });

  test("ids are unique, url-safe, and every persona carries initials + a colour", () => {
    const ids = new Set(PERSONAS.map((p) => p.id));
    expect(ids.size).toBe(PERSONAS.length);
    for (const p of PERSONAS) {
      expect(p.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(p.initials.length).toBe(2);
      expect(p.bg).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("LEADERBOARD — deterministic at module load", () => {
  test("building the roster a second time reproduces it exactly", () => {
    // The whole file's promise: the only input is an id, and the LCG draw
    // order is fixed. A rebuild that differs means a draw moved.
    expect(PERSONAS.map(build)).toEqual([...LEADERBOARD]);
  });

  test("a single persona rebuilds to the same object twice over", () => {
    const p = PERSONAS[0]!;
    expect(build(p)).toEqual(build(p));
  });

  test("the ladder spans real rungs — it is not one flat tier", () => {
    // Guards XP_SCALE. A ladder where everyone is WHALE has no ladder in it,
    // and it makes the copy-unlock invariant below vacuous.
    const tiers = new Set(LEADERBOARD.map((p) => p.rank.tier.name));
    expect(tiers.size).toBeGreaterThanOrEqual(3);
    expect(LEADERBOARD.some((p) => !p.rank.tier.copyUnlocked)).toBe(true);
    expect(LEADERBOARD.some((p) => p.rank.tier.copyUnlocked)).toBe(true);
  });

  test("the demo player lands where plan 4's hero mock says: #7 · SHARK II", () => {
    // Two independent pins on the roster's XP distribution, both taken from
    // the plan's own mock rather than read back off the generator.
    expect(rankAt(PLAYER.xp).label).toBe("SHARK II");
    expect(positionOf(PLAYER.xp)).toBe(7);
  });
});

describe("coherence — one latent variable, and it shows", () => {
  test("copiers > 0 if and only if the tier unlocks copy-trade", () => {
    let locked = 0;
    let unlocked = 0;
    for (const p of LEADERBOARD) {
      expect(p.econ.copiers > 0).toBe(p.rank.tier.copyUnlocked);
      expect(p.econ.unlocked).toBe(p.rank.tier.copyUnlocked);
      if (p.rank.tier.copyUnlocked) unlocked++;
      else locked++;
    }
    // Both branches must actually be exercised by the roster.
    expect(locked).toBeGreaterThan(0);
    expect(unlocked).toBeGreaterThan(0);
  });

  test("win rate tells the same story as skill; XP RATE leans the same way", () => {
    // winRate is skill plus a ±2% band, so its ordering IS skill's ordering
    // and only the band can invert a pair.
    expect(tau((p) => p.winRate, (p) => p.skill)).toBeGreaterThan(0.8);
    // XP per battle is the skill-driven half of the XP formula (the ×0.8–1.2
    // spread is the noise). Total XP additionally multiplies by `battles`, an
    // independent 40–300 draw, so career XP is grind-weighted by design — it
    // still leans the right way, but it is not the skill ladder. That is what
    // the WIN RATE / COPY HEAT / EARNINGS filters exist to separate out.
    expect(tau((p) => p.xp / p.battles, (p) => p.skill)).toBeGreaterThan(0.4);
    expect(tau((p) => p.xp, (p) => p.skill)).toBeGreaterThan(0);
    expect(tau((p) => p.earnings, (p) => p.skill)).toBeGreaterThan(0.5);
  });

  test("wins, win rate and battles agree, and nobody is impossible", () => {
    for (const p of LEADERBOARD) {
      expect(p.wins).toBe(Math.round(p.battles * p.winRate));
      expect(p.battles).toBeGreaterThanOrEqual(40);
      expect(p.battles).toBeLessThan(300);
      expect(p.winRate).toBeGreaterThan(0.3);
      expect(p.winRate).toBeLessThan(0.72);
      expect(p.skill).toBeGreaterThanOrEqual(0.34);
      expect(p.skill).toBeLessThanOrEqual(0.86);
    }
  });

  test("sectorShare and modeShare are distributions; the specialty is the fattest slice", () => {
    for (const p of LEADERBOARD) {
      const s = SECTOR_ORDER.reduce((a, k) => a + p.sectorShare[k], 0);
      const m = MODE_ORDER.reduce((a, k) => a + p.modeShare[k], 0);
      expect(s).toBeCloseTo(1, 10);
      expect(m).toBeCloseTo(1, 10);
      for (const k of SECTOR_ORDER) expect(p.sectorShare[k]).toBeGreaterThan(0);
      for (const k of MODE_ORDER) expect(p.modeShare[k]).toBeGreaterThan(0);
      // The SPECIALTY column is the fattest slice, not a separate draw.
      expect(p.sectorShare[p.sector]).toBe(Math.max(...SECTOR_ORDER.map((k) => p.sectorShare[k])));
      expect(p.modeShare[p.mode]).toBe(Math.max(...MODE_ORDER.map((k) => p.modeShare[k])));
    }
  });

  test("every trend line is 8 finite points inside the sparkline's band", () => {
    for (const p of LEADERBOARD) {
      expect(p.trend.length).toBe(8);
      for (const v of p.trend) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0.05);
        expect(v).toBeLessThanOrEqual(0.98);
      }
    }
  });
});

describe("copyEconomicsFor — the number Result and the ladder share", () => {
  test("the daily identity holds exactly for every persona", () => {
    for (const p of LEADERBOARD) {
      const e = p.econ;
      expect(e.feePct).toBe(COPY_FEE);
      expect(e.feePct).toBe(0.035);
      expect(e.perTx).toBe(e.avgTicket * COPY_FEE);
      expect(e.daily).toBe(e.copiers * e.txPerCopierPerDay * e.avgTicket * 0.035);
      expect(e.weekly).toBe(e.daily * 7);
      expect(e.monthly).toBe(e.daily * 30);
    }
  });

  test("a bare (id, xp) call reproduces the row's economics — the shared first draw", () => {
    // This is the seam that lets Result compute a copy panel from a ledger it
    // can read, without ever loading the ladder. If the two streams diverged,
    // the panel and the row would print different PTS/DAY figures.
    for (const p of LEADERBOARD) {
      expect(copyEconomicsFor(p.id, p.xp)).toEqual(p.econ);
    }
  });

  test("ticket size and transaction rate depend on the id alone, never on XP", () => {
    const p = LEADERBOARD[0]!;
    for (const xp of [0, 499, 1500, 2999, 6000, 40000]) {
      const e = copyEconomicsFor(p.id, xp);
      expect(e.avgTicket).toBe(p.econ.avgTicket);
      expect(e.txPerCopierPerDay).toBe(p.econ.txPerCopierPerDay);
      expect(e.avgTicket).toBeGreaterThanOrEqual(400 + Math.round(2600 * 0.34));
      expect(e.avgTicket).toBeLessThanOrEqual(400 + Math.round(2600 * 0.86));
      expect(e.txPerCopierPerDay).toBeGreaterThanOrEqual(2);
      expect(e.txPerCopierPerDay).toBeLessThanOrEqual(6);
    }
  });

  test("copiers never fall as XP rises — inside a tier and across every jump", () => {
    // The headline number must not go DOWN after a win, or the rank moment
    // lies. The sweep step is small enough to land both sides of every floor.
    for (const p of PERSONAS) {
      let prevCopiers = -1;
      let prevDaily = -1;
      for (let xp = 0; xp <= 12000; xp += 7) {
        const e = copyEconomicsFor(p.id, xp);
        expect(e.copiers).toBeGreaterThanOrEqual(prevCopiers);
        expect(e.daily).toBeGreaterThanOrEqual(prevDaily);
        prevCopiers = e.copiers;
        prevDaily = e.daily;
      }
    }
  });

  test("exact tier crossings step the copier count up, never down", () => {
    for (const p of PERSONAS) {
      for (const t of TIERS) {
        const below = copyEconomicsFor(p.id, t.xp - 1).copiers;
        const at = copyEconomicsFor(p.id, t.xp).copiers;
        expect(at).toBeGreaterThanOrEqual(below);
      }
    }
  });

  test("nextUnlock names the next tier where the count actually moves", () => {
    // MINNOW and FISH both sit at copierBase 0, so both point at SHARK — which
    // is exactly what the locked panel says.
    expect(copyEconomicsFor("kazuo-eth", 0).nextUnlock?.tier.name).toBe("SHARK");
    expect(copyEconomicsFor("kazuo-eth", 600).nextUnlock?.tier.name).toBe("SHARK");
    expect(copyEconomicsFor("kazuo-eth", 1600).nextUnlock?.tier.name).toBe("ORCA");
    expect(copyEconomicsFor("kazuo-eth", 3100).nextUnlock?.tier.name).toBe("WHALE");
    expect(copyEconomicsFor("kazuo-eth", 9000).nextUnlock).toBe(null);

    const locked = copyEconomicsFor("kazuo-eth", 1160);
    expect(locked.copiers).toBe(0);
    expect(locked.daily).toBe(0);
    expect(locked.nextUnlock?.xpAway).toBe(340); // plan 4's "340 XP TO SHARK"
    expect(locked.nextUnlock!.copiersAt).toBeGreaterThan(0);
  });
});

describe("rankedBy — the ladder re-ranks, it never invents", () => {
  test("every filter returns 1…n, consecutive and unique, over the same objects", () => {
    for (const filter of LADDER_FILTERS) {
      const rows = rankedBy(LEADERBOARD, filter, SEL_NONE);
      expect(rows.length).toBe(LEADERBOARD.length);
      expect(rows.map((r) => r.pos)).toEqual(LEADERBOARD.map((_, i) => i + 1));
      // A permutation of the SAME player objects — identity, not equality.
      const seen = new Set(rows.map((r) => r.player));
      expect(seen.size).toBe(LEADERBOARD.length);
      for (const p of LEADERBOARD) expect(seen.has(p)).toBe(true);
      // Metric is the sort key, and higher is better for all four filters.
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1]!.metric).toBeGreaterThanOrEqual(rows[i]!.metric);
      }
      for (const r of rows) {
        expect(r.label.length).toBeGreaterThan(0);
        expect(r.sub.length).toBeGreaterThan(0);
        expect(Number.isFinite(r.metric)).toBe(true);
      }
    }
  });

  test("ties break on id, so the order is total and stable across calls", () => {
    for (const filter of LADDER_FILTERS) {
      const a = rankedBy(LEADERBOARD, filter, SEL_NONE).map((r) => r.player.id);
      const b = rankedBy([...LEADERBOARD].reverse(), filter, SEL_NONE).map((r) => r.player.id);
      // Input order must not survive into output order.
      expect(a).toEqual(b);
    }
  });

  test("SECTOR × MODE with a selection is a re-ranked SUBSET of the same objects", () => {
    const sel: Selection = { sectors: ["SEMIS", "DEFI"], modes: ["BLITZ"] };
    const all = rankedBy(LEADERBOARD, "SECTOR_MODE", SEL_NONE);
    const some = rankedBy(LEADERBOARD, "SECTOR_MODE", sel);

    expect(some.length).toBeGreaterThan(0);
    expect(some.length).toBeLessThan(all.length);
    expect(some.map((r) => r.pos)).toEqual(some.map((_, i) => i + 1));

    const pool = new Set(LEADERBOARD);
    for (const r of some) {
      expect(pool.has(r.player)).toBe(true); // identical reference, no clone
      // OR within a group, AND across groups.
      expect(sel.sectors.includes(r.player.sector)).toBe(true);
      expect(sel.modes.includes(r.player.mode)).toBe(true);
    }
    // Nobody who qualified was dropped.
    const want = LEADERBOARD.filter(
      (p) => sel.sectors.includes(p.sector) && sel.modes.includes(p.mode),
    );
    expect(some.length).toBe(want.length);
  });

  test("an empty group means ALL — the filter never produces a dead screen", () => {
    const sectorsOnly = rankedBy(LEADERBOARD, "SECTOR_MODE", { sectors: ["MEME"], modes: [] });
    const modesOnly = rankedBy(LEADERBOARD, "SECTOR_MODE", { sectors: [], modes: MODE_ORDER });
    expect(sectorsOnly.every((r) => r.player.sector === "MEME")).toBe(true);
    expect(modesOnly.length).toBe(LEADERBOARD.length);
    expect(rankedBy(LEADERBOARD, "SECTOR_MODE", SEL_NONE).length).toBe(LEADERBOARD.length);
  });

  test("winsIn with nothing selected is exactly `wins` — no filter invents a number", () => {
    for (const p of LEADERBOARD) {
      expect(winsIn(p, [], [])).toBe(p.wins);
      // Any real selection is a slice of a career, never more than it.
      expect(winsIn(p, ["SEMIS"], ["BLITZ"])).toBeLessThan(p.wins);
      expect(winsIn(p, SECTOR_ORDER, MODE_ORDER)).toBeGreaterThan(0);
    }
  });
});

describe("positionOf and the YOU row", () => {
  test("more XP is never a worse position", () => {
    let prev = Number.POSITIVE_INFINITY;
    for (let xp = 0; xp <= 15000; xp += 37) {
      const pos = positionOf(xp);
      expect(pos).toBeLessThanOrEqual(prev);
      expect(pos).toBeGreaterThanOrEqual(1);
      expect(pos).toBeLessThanOrEqual(LEADERBOARD.length + 1);
      prev = pos;
    }
  });

  test("a duel's XP can only move you up the table", () => {
    for (const before of [0, 900, 2340, 4000]) {
      for (const gain of [20, 50, 120, 240]) {
        expect(positionOf(before + gain)).toBeLessThanOrEqual(positionOf(before));
      }
    }
    // Nobody outranks the top persona; everybody outranks an empty ledger.
    const top = Math.max(...LEADERBOARD.map((p) => p.xp));
    expect(positionOf(top)).toBe(1);
    expect(positionOf(0)).toBe(LEADERBOARD.length + 1);
  });

  test("an empty ledger is a MINNOW at the foot of the ladder; one duel moves the row", () => {
    const fresh = buildYou({ xp: 0, battles: 0, wins: 0 });
    expect(fresh.you).toBe(true);
    expect(fresh.rank.tier.name).toBe("MINNOW");
    expect(fresh.econ.copiers).toBe(0);
    expect(fresh.trend.length).toBe(8);
    expect(SECTOR_ORDER.reduce((a, k) => a + fresh.sectorShare[k], 0)).toBeCloseTo(1, 10);
    expect(MODE_ORDER.reduce((a, k) => a + fresh.modeShare[k], 0)).toBeCloseTo(1, 10);

    const after = buildYou({ xp: 240, battles: 1, wins: 1, sectors: ["MEME"], modes: ["BLITZ"] });
    expect(after.sector).toBe("MEME");
    expect(after.mode).toBe("BLITZ");
    expect(positionOf(after.xp)).toBeLessThanOrEqual(positionOf(fresh.xp));
  });

  test("leaderboardWith sorts you by the same rule as everyone else", () => {
    const you = buildYou({ xp: PLAYER.xp, battles: 31, wins: 18 });
    const list = leaderboardWith(you);
    expect(list.length).toBe(LEADERBOARD.length + 1);
    for (const filter of LADDER_FILTERS) {
      const rows = rankedBy(list, filter, SEL_NONE);
      const mine = rows.filter((r) => r.player.you);
      expect(mine.length).toBe(1);
      expect(rows.map((r) => r.pos)).toEqual(rows.map((_, i) => i + 1));
    }
    // The ladder page's row number and the rank moment's counter are the same
    // function of the same input, so they cannot drift apart.
    expect(positionOf(you.xp)).toBe(7);
  });
});
