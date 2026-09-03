import { describe, expect, test } from "bun:test";
import { briefsFor } from "../src/data/briefs.ts";
import { meta } from "../src/data/universe.ts";
import {
  PARLAY_CARDS,
  TIERS,
  buildLeg,
  cardById,
  conditionText,
  impliedProbability,
  legsForCard,
  parlayMultiplier,
  summarize,
} from "../src/engine/parlay.ts";

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
    expect(conditionText(buildLeg("BTC", "over", "EVEN"))).toMatch(/^BTC closes above [\d,]+ \(\+4\.0%\) by Fri expiry$/);
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

  test("the summary multiplies the stake by the product and goes loud under 10%", () => {
    const s = summarize(legs, 2400);
    expect(s.mult).toBeCloseTo(parlayMultiplier(legs), 10);
    expect(s.potentialPoints).toBe(Math.round(2400 * s.mult));
    expect(s.loud).toBe(true);
    expect(summarize([buildLeg("ETH", "over", "SAFE")], 100).loud).toBe(false);
  });
});

describe("cards", () => {
  test("eight cards: every tier, bullish and bearish, with unique ids", () => {
    expect(PARLAY_CARDS).toHaveLength(8);
    expect(new Set(PARLAY_CARDS.map((c) => c.id)).size).toBe(8);
    for (const tier of ["SAFE", "EVEN", "SHARP", "DEGEN"] as const) {
      expect(cardById(`${tier.toLowerCase()}-bull`)?.tier).toBe(tier);
      expect(cardById(`${tier.toLowerCase()}-bear`)?.stance).toBe("bear");
    }
    expect(cardById("nope")).toBeNull();
    expect(cardById(null)).toBeNull();
  });

  test("a card sets the same line and direction on every leg", () => {
    const syms = ["NVDA", "AAPL", "TSLA"];
    const bull = legsForCard(syms, cardById("sharp-bull")!);
    expect(bull.map((l) => l.sym)).toEqual(syms);
    expect(bull.every((l) => l.dir === "over" && l.tier === "SHARP")).toBe(true);
    const bear = legsForCard(syms, cardById("safe-bear")!);
    expect(bear.every((l) => l.dir === "under" && l.tier === "SAFE")).toBe(true);
    expect(parlayMultiplier(bull)).toBeCloseTo(3.6 ** 3, 10);
  });

  test("cards climb in odds and fall in probability, tier by tier", () => {
    const syms = ["NVDA", "AAPL", "TSLA"];
    const order = ["safe-bull", "even-bull", "sharp-bull", "degen-bull"].map((id) => summarize(legsForCard(syms, cardById(id)!), 100));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!.mult).toBeGreaterThan(order[i - 1]!.mult);
      expect(order[i]!.prob).toBeLessThan(order[i - 1]!.prob);
    }
  });
});

describe("briefs", () => {
  test("one news line per ticker, then a desk exchange, replayable by seed", () => {
    const syms = ["NVDA", "AAPL", "TSLA"];
    const a = briefsFor(syms, 7);
    const b = briefsFor(syms, 7);
    expect(a).toEqual(b);
    expect(a.filter((x) => x.kind === "news").map((x) => x.sym)).toEqual(syms);
    expect(a.filter((x) => x.kind === "desk")).toHaveLength(2);
    for (const n of a.filter((x) => x.kind === "news")) expect(n.text).toContain(n.sym!);
  });

  test("a different seed can draw a different wire", () => {
    const syms = ["NVDA", "AAPL", "TSLA"];
    const seen = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(briefsFor(syms, i + 1))));
    expect(seen.size).toBeGreaterThan(1);
  });
});
