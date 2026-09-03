import { describe, expect, test } from "bun:test";
import { caseById, caseOdds, stakePointsFor } from "../src/data/cases.ts";
import { meta } from "../src/data/universe.ts";
import {
  TIERS,
  buildLeg,
  conditionText,
  impliedProbability,
  parlayMultiplier,
  settleCase,
  summarize,
  type ParlayLeg,
} from "../src/engine/parlay.ts";
import { TAPE_LEN, pctAt } from "../src/engine/tape.ts";

const box = caseById("eth-vol-box")!;

describe("legs", () => {
  test("a tier scales the asset's base target and sets the strike from spot", () => {
    const u = meta("BTC");
    const safe = buildLeg("BTC", "over", "SAFE");
    const degen = buildLeg("BTC", "under", "DEGEN");
    expect(safe.baseT).toBe(u.t);
    expect(safe.t).toBeCloseTo(u.t * TIERS.SAFE.scale, 6);
    expect(degen.t).toBeCloseTo(u.t * TIERS.DEGEN.scale, 6);
    expect(safe.strike).toBeCloseTo(u.px * (1 + safe.t / 100), 6);
    expect(degen.strike).toBeCloseTo(u.px * (1 - degen.t / 100), 6);
    expect(safe.mult).toBe(1.2);
    expect(degen.prob).toBe(0.08);
  });

  test("the condition reads as a sentence", () => {
    const leg = buildLeg("BTC", "over", "EVEN");
    expect(conditionText(leg)).toMatch(/^BTC closes above [\d,]+ \(\+4\.0%\) by Fri expiry$/);
    expect(conditionText(buildLeg("BTC", "under", "EVEN"))).toContain("closes below");
  });
});

describe("multiplier", () => {
  const legs = [
    buildLeg("ETH", "over", "SAFE"),
    buildLeg("BTC", "over", "EVEN"),
    buildLeg("SOL", "over", "SHARP"),
    buildLeg("ARB", "over", "DEGEN"),
  ];

  test("is the product of the leg multipliers, nothing else", () => {
    expect(parlayMultiplier(legs)).toBeCloseTo(1.2 * 1.9 * 3.6 * 11, 10);
    expect(parlayMultiplier([])).toBe(1);
  });

  test("implied probability is the product of the leg hit rates", () => {
    expect(impliedProbability(legs)).toBeCloseTo(0.7 * 0.5 * 0.25 * 0.08, 10);
  });

  test("changing one leg changes the product", () => {
    const before = parlayMultiplier(legs);
    const after = parlayMultiplier([buildLeg("ETH", "over", "DEGEN"), ...legs.slice(1)]);
    expect(after).toBeCloseTo((before / 1.2) * 11, 10);
  });
});

describe("summary", () => {
  const stake = stakePointsFor(box);

  test("the case's odds are the floor of the multiplier and the ceiling of the probability", () => {
    const allSafe = Array.from({ length: 4 }, (_, i) =>
      buildLeg(["ETH", "BTC", "SOL", "ARB"][i]!, "over", "SAFE"),
    );
    const s = summarize(allSafe, box, stake);
    expect(s.floor).toBeCloseTo(caseOdds(box), 10);
    expect(s.parlayMult).toBeCloseTo(1.2 ** 4, 10);
    expect(s.parlayMult).toBeLessThan(s.floor);
    expect(s.effectiveMult).toBeCloseTo(s.floor, 10);
    expect(s.floored).toBe(true);
    expect(s.prob).toBeCloseTo(1 / s.floor, 10); // 0.7^4 = 0.24 would be above the case
    expect(s.loud).toBe(false);
    expect(s.potentialPoints).toBe(Math.round(stake * s.floor));
  });

  test("above the floor the parlay pays its own product and goes loud under 10%", () => {
    const legs = Array.from({ length: 4 }, (_, i) =>
      buildLeg(["ETH", "BTC", "SOL", "ARB"][i]!, "over", "DEGEN"),
    );
    const s = summarize(legs, box, stake);
    expect(s.effectiveMult).toBeCloseTo(11 ** 4, 6);
    expect(s.floored).toBe(false);
    expect(s.prob).toBeCloseTo(0.08 ** 4, 10);
    expect(s.loud).toBe(true);
  });

  test("stake points come from the open cost", () => {
    expect(stakePointsFor(box)).toBe(410);
    expect(stakePointsFor(caseById("whale-box")!)).toBe(10000);
  });
});

describe("settlement", () => {
  const salt = 11;

  /** A leg that is certain to land: tiny target in the tape's own direction. */
  const sure = (sym: string): ParlayLeg => {
    const dir = pctAt(sym, salt, TAPE_LEN) >= 0 ? "over" : "under";
    return { ...buildLeg(sym, dir, "EVEN"), t: 0.001 };
  };
  /** A leg that cannot land. */
  const doomed = (sym: string): ParlayLeg => ({ ...buildLeg(sym, "over", "EVEN"), t: 999 });

  test("every leg landing pays the stake times the multiplier", () => {
    const legs = [sure("ETH"), sure("BTC"), sure("SOL")];
    const v = settleCase(legs, salt, TAPE_LEN, 410, 6.859);
    expect(v.hits).toBe(3);
    expect(v.allHit).toBe(true);
    expect(v.refunded).toBe(false);
    expect(v.points).toBe(Math.round(410 * 6.859));
    expect(v.edge).toBeGreaterThan(0);
    expect(v.read).toContain("paid in full");
  });

  test("one miss pays zero — the whole point of a parlay", () => {
    const legs = [sure("ETH"), sure("BTC"), doomed("SOL")];
    const v = settleCase(legs, salt, TAPE_LEN, 410, 6.859);
    expect(v.hits).toBe(2);
    expect(v.allHit).toBe(false);
    expect(v.refunded).toBe(false);
    expect(v.points).toBe(0);
    expect(v.read).toContain("one leg short");
  });

  test("partial credit, when switched on, refunds the stake on N-1 hits", () => {
    const legs = [sure("ETH"), sure("BTC"), doomed("SOL")];
    const v = settleCase(legs, salt, TAPE_LEN, 410, 6.859, true);
    expect(v.refunded).toBe(true);
    expect(v.points).toBe(410);

    // Two misses is still nothing, even with the flag on.
    const two = settleCase([sure("ETH"), doomed("BTC"), doomed("SOL")], salt, TAPE_LEN, 410, 6.859, true);
    expect(two.refunded).toBe(false);
    expect(two.points).toBe(0);
  });

  test("partial credit is off by default", () => {
    const legs = [sure("ETH"), sure("BTC"), doomed("SOL")];
    expect(settleCase(legs, salt, TAPE_LEN, 410, 6.859).points).toBe(0);
  });
});
