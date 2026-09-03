import { describe, expect, test } from "bun:test";
import {
  clampDuration,
  clampStake,
  MAX_DURATION_MINUTES,
  MAX_STAKE_USDC,
  MIN_DURATION_MINUTES,
  MIN_STAKE_USDC,
  poolOf,
  stakeStep,
  stepStake,
  usdc,
} from "../src/data/stake.ts";

describe("clampStake", () => {
  test("holds the 0.50 floor", () => {
    expect(clampStake(0)).toBe(MIN_STAKE_USDC);
    expect(clampStake(0.4)).toBe(MIN_STAKE_USDC);
    expect(clampStake(-100)).toBe(MIN_STAKE_USDC);
  });

  test("a non-number falls to the floor instead of poisoning the room", () => {
    // `Math.max(0.5, NaN)` is NaN, so without a guard a half-typed field would
    // store NaN and every downstream label would render "NaN USDC".
    expect(clampStake(Number.NaN)).toBe(MIN_STAKE_USDC);
    expect(clampStake(Number.POSITIVE_INFINITY)).toBe(MIN_STAKE_USDC);
    expect(clampStake(Number.NEGATIVE_INFINITY)).toBe(MIN_STAKE_USDC);
  });

  test("holds the 10,000 ceiling", () => {
    expect(clampStake(10_001)).toBe(MAX_STAKE_USDC);
    expect(clampStake(1e9)).toBe(MAX_STAKE_USDC);
  });

  test("passes anything inside the band through, rounded to cents", () => {
    expect(clampStake(0.5)).toBe(0.5);
    expect(clampStake(7.3)).toBe(7.3);
    expect(clampStake(10_000)).toBe(10_000);
    // A stake is money, so a fraction of a cent is not a stake.
    expect(clampStake(1.006)).toBe(1.01);
    expect(clampStake(9.999)).toBe(10);
  });
});

describe("stakeStep", () => {
  test("scales with magnitude", () => {
    expect(stakeStep(0.5)).toBe(0.5);
    expect(stakeStep(9.99)).toBe(0.5);
    expect(stakeStep(10)).toBe(5);
    expect(stakeStep(99)).toBe(5);
    expect(stakeStep(100)).toBe(50);
    expect(stakeStep(999)).toBe(50);
    expect(stakeStep(1_000)).toBe(500);
    expect(stakeStep(10_000)).toBe(500);
  });
});

describe("stepStake", () => {
  test("the band boundary does not leave an odd stop behind it", () => {
    // A `<=` boundary put 10.50 between 10 and 15, which reads like a bug.
    expect(stepStake(10, 1)).toBe(15);
    expect(stepStake(100, 1)).toBe(150);
    expect(stepStake(1_000, 1)).toBe(1_500);
  });

  test("stepping down out of a band uses that band's smaller step", () => {
    expect(stepStake(10, -1)).toBe(9.5);
    expect(stepStake(100, -1)).toBe(95);
    expect(stepStake(1_000, -1)).toBe(950);
  });

  test("a typed value snaps to a round multiple rather than drifting", () => {
    expect(stepStake(7.3, 1)).toBe(7.5);
    expect(stepStake(7.3, -1)).toBe(7);
    expect(stepStake(23, 1)).toBe(25);
    expect(stepStake(23, -1)).toBe(20);
  });

  test("the floor and the ceiling both hold under pressure", () => {
    expect(stepStake(MIN_STAKE_USDC, -1)).toBe(MIN_STAKE_USDC);
    expect(stepStake(MAX_STAKE_USDC, 1)).toBe(MAX_STAKE_USDC);
  });

  test("the whole band is reachable in a sane number of clicks", () => {
    // The point of a proportional step: a flat one needs 19,999 clicks to
    // cross 0.50 -> 10,000, and this range has to be usable by hand.
    let v: number = MIN_STAKE_USDC;
    let clicks = 0;
    while (v < MAX_STAKE_USDC && clicks < 500) {
      v = stepStake(v, 1);
      clicks += 1;
    }
    expect(v).toBe(MAX_STAKE_USDC);
    expect(clicks).toBeLessThan(100);
  });

  test("stepping down from the top gets back to the floor", () => {
    let v: number = MAX_STAKE_USDC;
    let clicks = 0;
    while (v > MIN_STAKE_USDC && clicks < 500) {
      v = stepStake(v, -1);
      clicks += 1;
    }
    expect(v).toBe(MIN_STAKE_USDC);
  });

  test("no step ever lands outside the band", () => {
    for (const start of [0.5, 0.75, 7.3, 10, 99.99, 100, 1_000, 9_999, 10_000]) {
      for (const dir of [1, -1] as const) {
        const next = stepStake(start, dir);
        expect(next).toBeGreaterThanOrEqual(MIN_STAKE_USDC);
        expect(next).toBeLessThanOrEqual(MAX_STAKE_USDC);
      }
    }
  });
});

describe("poolOf", () => {
  test("the winner takes both stakes", () => {
    expect(poolOf(0.5)).toBe(1);
    expect(poolOf(10)).toBe(20);
    expect(poolOf(10_000)).toBe(20_000);
  });
});

describe("usdc", () => {
  test("always two decimals, because it is money", () => {
    expect(usdc(0.5)).toBe("0.50 USDC");
    expect(usdc(10)).toBe("10.00 USDC");
    expect(usdc(10_000)).toBe("10000.00 USDC");
  });
});

describe("clampDuration", () => {
  test("whole minutes inside the band", () => {
    expect(clampDuration(0)).toBe(MIN_DURATION_MINUTES);
    expect(clampDuration(1.4)).toBe(1);
    expect(clampDuration(1.6)).toBe(2);
    expect(clampDuration(9_999)).toBe(MAX_DURATION_MINUTES);
    expect(clampDuration(Number.NaN)).toBe(MIN_DURATION_MINUTES);
  });
});
