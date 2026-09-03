import { describe, expect, test } from "bun:test";
import { CASE_LIBRARY, caseById } from "../src/data/cases.ts";
import { lockedBy, nextTier, tierFor } from "../src/data/rewards.ts";
import { UNIVERSE } from "../src/data/universe.ts";
import { STRIP_LEN, planSpin, seededRandom, spinCase } from "../src/engine/spin.ts";

describe("planSpin", () => {
  test("always lands in the last quarter of the strip and inside it", () => {
    for (let i = 0; i < 200; i++) {
      const p = planSpin();
      expect(p.target).toBeGreaterThanOrEqual(Math.floor(STRIP_LEN * 0.72));
      expect(p.target).toBeLessThan(STRIP_LEN - 1);
      expect(Number.isInteger(p.target)).toBe(true);
      expect(Math.abs(p.jitter)).toBeLessThanOrEqual(0.35);
    }
  });

  test("is fully driven by the random source", () => {
    const a = planSpin(() => 0);
    const b = planSpin(() => 0.999);
    expect(a.target).toBe(Math.floor(STRIP_LEN * 0.72));
    expect(b.target).toBe(STRIP_LEN - 3);
    expect(a.jitter).toBeCloseTo(-0.35, 10);
  });
});

describe("spinCase", () => {
  const book = ["ETH", "BTC", "SOL", "ARB", "LINK", "UNI"];

  test("the same seed deals the same legs, in the same order", () => {
    const a = spinCase(book, 4, 424242);
    const b = spinCase(book, 4, 424242);
    expect(a.syms).toEqual(b.syms);
    expect(a.plans).toEqual(b.plans);
  });

  test("a seeded source is deterministic on its own", () => {
    const r1 = seededRandom(7);
    const r2 = seededRandom(7);
    for (let i = 0; i < 20; i++) expect(r1()).toBe(r2());
  });

  test("fills exactly legCount slots, never twice with the same ticker", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = spinCase(book, 4, seed);
      expect(r.syms).toHaveLength(4);
      expect(new Set(r.syms).size).toBe(4);
      expect(r.plans).toHaveLength(4);
    }
  });

  test("only deals from the book it was given", () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const s of spinCase(book, 3, seed).syms) expect(book).toContain(s);
    }
  });

  test("a rejected duplicate is counted and re-spun, not silently dropped", () => {
    // Two names, two slots: the second landing has a 50% chance of colliding,
    // so across many seeds some runs must record a rejection — and every one
    // still ends with both slots filled.
    let sawRejection = false;
    for (let seed = 1; seed <= 100; seed++) {
      const r = spinCase(["ETH", "BTC"], 2, seed);
      expect(r.syms).toHaveLength(2);
      if (r.rejected > 0) sawRejection = true;
    }
    expect(sawRejection).toBe(true);
  });

  test("different seeds deal different legs", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => spinCase(book, 4, i + 1).syms.join(",")));
    expect(seen.size).toBeGreaterThan(1);
  });

  test("refuses a book too small for the case", () => {
    expect(() => spinCase(["ETH", "BTC"], 3, 1)).toThrow(/distinct legs/);
  });
});

describe("case books", () => {
  test("every case can fill its slots from names that exist on the board", () => {
    const board = new Set(UNIVERSE.map((u) => u.sym));
    for (const c of CASE_LIBRARY) {
      expect(c.eligibleAssets.length).toBeGreaterThanOrEqual(c.legCount);
      for (const s of c.eligibleAssets) expect(board.has(s)).toBe(true);
      expect(new Set(c.eligibleAssets).size).toBe(c.eligibleAssets.length);
    }
  });

  test("the quiet case never deals a meme coin", () => {
    const grind = caseById("weekly-grind")!;
    for (let seed = 1; seed <= 500; seed++) {
      const r = spinCase(grind.eligibleAssets, grind.legCount, seed);
      expect(r.syms).not.toContain("PEPE");
      expect(r.syms).not.toContain("DOGE");
    }
  });

  test("case ids are unique and resolve", () => {
    expect(new Set(CASE_LIBRARY.map((c) => c.id)).size).toBe(CASE_LIBRARY.length);
    expect(caseById("eth-vol-box")?.name).toBe("ETH Vol Box");
    expect(caseById("nope")).toBeNull();
    expect(caseById(null)).toBeNull();
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
