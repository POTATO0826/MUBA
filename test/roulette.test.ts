import { describe, expect, test } from "bun:test";
import { STRIP_LEN, planSpin } from "../src/components/Roulette.tsx";
import { lockedBy, nextTier, tierFor } from "../src/data/rewards.ts";

describe("planSpin", () => {
  test("always lands in the last quarter of the strip and inside it", () => {
    for (let i = 0; i < 200; i++) {
      const p = planSpin(9);
      expect(p.target).toBeGreaterThanOrEqual(Math.floor(STRIP_LEN * 0.72));
      expect(p.target).toBeLessThan(STRIP_LEN - 1);
      expect(Number.isInteger(p.target)).toBe(true);
      expect(Math.abs(p.jitter)).toBeLessThanOrEqual(0.35);
    }
  });

  test("is fully driven by the random source", () => {
    const a = planSpin(9, () => 0);
    const b = planSpin(9, () => 0.999);
    expect(a.target).toBe(Math.floor(STRIP_LEN * 0.72));
    expect(b.target).toBe(STRIP_LEN - 3);
    expect(a.jitter).toBeCloseTo(-0.35, 10);
  });
});

describe("tiers", () => {
  test("tierFor picks the highest threshold at or below the XP", () => {
    expect(tierFor(0).name).toBe("MINNOW");
    expect(tierFor(499).name).toBe("MINNOW");
    expect(tierFor(500).name).toBe("FISH");
    expect(tierFor(2340).name).toBe("SHARK");
    expect(tierFor(99999).name).toBe("WHALE");
  });

  test("nextTier is null at the top", () => {
    expect(nextTier(2340)?.name).toBe("ORCA");
    expect(nextTier(6000)).toBeNull();
  });

  test("lockedBy only gates tiers above the player", () => {
    expect(lockedBy(undefined, "SHARK")).toBeNull();
    expect(lockedBy("SHARK", "SHARK")).toBeNull();
    expect(lockedBy("FISH", "SHARK")).toBeNull();
    expect(lockedBy("ORCA", "SHARK")).toBe("ORCA");
  });
});
