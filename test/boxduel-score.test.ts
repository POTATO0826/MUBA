import { describe, expect, test } from "bun:test";
import { priceToStrike, type Box } from "../src/data/box.ts";
import { series, TAPE_LEN } from "../src/engine/tape.ts";
import {
  bandOf,
  captureOf,
  scoreBoxDuel,
  settleIndexFor,
  type DuelSeat,
} from "../src/engine/boxduel.ts";

/**
 * The arena's missing rule. These tests exist because the outcome decides who
 * receives real ETH through `GameStake.winnerTakesAll`, which has no refund —
 * so "both clients agree" and "somebody is always named" are correctness
 * properties here, not niceties.
 */

const SEED = 4242;
const AT = settleIndexFor(30);
const ETH_AT = series("ETH", SEED)[AT]!;

function box(lo: number, hi: number, wing: number, underlying = "ETH"): Box {
  return {
    underlying,
    floor: priceToStrike(lo)!,
    ceiling: priceToStrike(hi)!,
    wing: priceToStrike(wing)!,
    expiry: 1_900_000_000,
  };
}

/** Brackets the settlement print — the band the price lands in. */
const ON_TARGET = box(ETH_AT * 0.97, ETH_AT * 1.03, ETH_AT * 0.02);
/** Nowhere near it. */
const MISSED = box(ETH_AT * 1.4, ETH_AT * 1.6, ETH_AT * 0.02);

describe("settleIndexFor", () => {
  test("maps a duration onto a print inside the tape", () => {
    expect(settleIndexFor(60)).toBe(TAPE_LEN - 1);
    expect(settleIndexFor(30)).toBeLessThan(TAPE_LEN - 1);
    expect(settleIndexFor(30)).toBeGreaterThan(0);
    // A shorter room settles earlier, which is what makes it a tighter walk.
    expect(settleIndexFor(15)).toBeLessThan(settleIndexFor(45));
  });

  test("clamps rather than trusting a duration off the wire", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 10_000]) {
      const index = settleIndexFor(bad);
      expect(index).toBeGreaterThanOrEqual(1);
      expect(index).toBeLessThanOrEqual(TAPE_LEN - 1);
    }
  });
});

describe("captureOf normalises across assets and widths", () => {
  test("a band the price lands in captures its whole maximum", () => {
    expect(captureOf(ON_TARGET, ETH_AT)).toBe(1);
  });

  test("a band the price misses captures nothing", () => {
    expect(captureOf(MISSED, ETH_AT)).toBe(0);
  });

  test("width alone cannot win: a wide box and a narrow box both cap at 1", () => {
    const narrow = box(ETH_AT * 0.995, ETH_AT * 1.005, ETH_AT * 0.01);
    const wide = box(ETH_AT * 0.8, ETH_AT * 1.2, ETH_AT * 0.05);
    expect(captureOf(narrow, ETH_AT)).toBe(1);
    expect(captureOf(wide, ETH_AT)).toBe(1);
  });

  test("the score is always a fraction, never dollars", () => {
    for (const price of [ETH_AT * 0.5, ETH_AT * 0.99, ETH_AT, ETH_AT * 1.01, ETH_AT * 2]) {
      const v = captureOf(ON_TARGET, price);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("scoreBoxDuel", () => {
  const duel = (host: Box | null, guest: Box | null) =>
    scoreBoxDuel({ host, guest, seed: SEED, settleAt: AT });

  test("the box the price lands in beats the one it does not", () => {
    const out = duel(ON_TARGET, MISSED);
    expect(out.winner).toBe("host");
    expect(out.hostScore).toBe(1);
    expect(out.guestScore).toBe(0);
    expect(out.tied).toBe(false);
  });

  test("the verdict is absolute, not viewer-relative — swapping seats swaps the winner", () => {
    const a = duel(ON_TARGET, MISSED);
    const b = duel(MISSED, ON_TARGET);
    expect(a.winner).toBe("host");
    expect(b.winner).toBe("guest");
    // This is the property that stops both clients believing they won and
    // racing each other to call winnerTakesAll.
    expect(a.winner).not.toBe(b.winner);
  });

  test("identical inputs always produce an identical verdict", () => {
    expect(JSON.stringify(duel(ON_TARGET, MISSED))).toBe(JSON.stringify(duel(ON_TARGET, MISSED)));
  });

  test("a dead tie still names somebody, and always the host", () => {
    const out = duel(ON_TARGET, ON_TARGET);
    expect(out.tied).toBe(true);
    expect(out.winner).toBe("host");
    expect(out.reason).toContain("host");
    // A tie that named nobody would strand the pot: GameStake has no refund.
    expect(out.winner).not.toBeNull();
  });

  test("an unreadable pick refuses to name a winner rather than guessing", () => {
    for (const [host, guest] of [
      [ON_TARGET, null],
      [null, ON_TARGET],
      [null, null],
    ] as [Box | null, Box | null][]) {
      const out = duel(host, guest);
      expect(out.winner).toBeNull();
      expect(out.reason.length).toBeGreaterThan(0);
    }
  });

  test("a box on an underlying with no condor market cannot be settled", () => {
    const out = duel(ON_TARGET, box(1, 2, 0.1, "DOGE"));
    expect(out.winner).toBeNull();
    expect(out.reason).toContain("DOGE");
  });

  test("every scored outcome names exactly one seat", () => {
    const seats: (DuelSeat | null)[] = [];
    for (const seed of [1, 2, 3, 99, 4242, 100_000]) {
      const at = settleIndexFor(30);
      const px = series("ETH", seed)[at]!;
      const hit = box(px * 0.98, px * 1.02, px * 0.02);
      const miss = box(px * 1.5, px * 1.7, px * 0.02);
      const out = scoreBoxDuel({ host: hit, guest: miss, seed, settleAt: at });
      expect(out.winner).not.toBeNull();
      seats.push(out.winner);
    }
    expect(seats.every((s) => s === "host")).toBe(true);
  });

  test("the settle price comes off the seeded walk, not the clock", () => {
    const out = duel(ON_TARGET, MISSED);
    expect(out.settlePrice).toBe(ETH_AT);
    // Same seed, same answer, no matter when it is asked.
    expect(series("ETH", SEED)[AT]).toBe(ETH_AT);
  });
});

describe("bandOf", () => {
  test("reports the band a box covers, and never throws", () => {
    const band = bandOf(ON_TARGET);
    expect(band).not.toBeNull();
    expect(band!.lo).toBeLessThan(band!.hi);
    expect(bandOf(null)).toBeNull();
    expect(bandOf(box(1, 2, 0.1, "DOGE"))).toBeNull();
  });
});
