import { describe, expect, test } from "bun:test";
import {
  MAX_DURATION_MINUTES,
  MAX_STAKE_ETH,
  MIN_DURATION_MINUTES,
  MIN_STAKE_ETH,
  clampDuration,
  clampStake,
  eth,
  poolOf,
  stakeAmountText,
  stakeStep,
  stepStake,
  usdc,
} from "../src/data/stake.ts";

describe("Base Sepolia room stakes", () => {
  test("the user-facing floor is 0.001 ETH", () => {
    expect(MIN_STAKE_ETH).toBe(0.001);
    for (const value of [0, 0.0009, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampStake(value)).toBe(MIN_STAKE_ETH);
    }
    expect(clampStake(0.001)).toBe(0.001);
    expect(clampStake(0.0012345)).toBe(0.001235);
  });

  test("room storage remains bounded and steps scale from the minimum", () => {
    expect(clampStake(MAX_STAKE_ETH + 1)).toBe(MAX_STAKE_ETH);
    expect(stakeStep(0.001)).toBe(0.001);
    expect(stakeStep(0.01)).toBe(0.01);
    expect(stakeStep(0.1)).toBe(0.1);
    expect(stepStake(0.001, -1)).toBe(0.001);
    expect(stepStake(0.001, 1)).toBe(0.002);
  });

  test("winner-takes-all display doubles the stake in native ETH", () => {
    expect(poolOf(0.001)).toBe(0.002);
    expect(stakeAmountText(0.001)).toBe("0.001");
    expect(eth(0.001)).toBe("0.001 ETH");
    expect(usdc(0.001)).toBe("0.001 ETH");
  });
});

describe("clampDuration", () => {
  test("keeps whole minutes inside the duration band", () => {
    expect(clampDuration(0)).toBe(MIN_DURATION_MINUTES);
    expect(clampDuration(1.4)).toBe(1);
    expect(clampDuration(1.6)).toBe(2);
    expect(clampDuration(9_999)).toBe(MAX_DURATION_MINUTES);
    expect(clampDuration(Number.NaN)).toBe(MIN_DURATION_MINUTES);
  });
});
