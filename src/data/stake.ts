/**
 * Stakes and duel length.
 *
 * The unit is USDC, not ETH. A duel is settled in a stablecoin so that the
 * stake still means what it meant when the room opened — with ETH as the unit,
 * a move in ETH during the duel changes what everyone put in, which is a second
 * bet nobody agreed to. It is also the collateral Thetanuts quotes against on
 * Base (`0x8335…2913` in `tnuts-test/FINDINGS.md`).
 */

/** USDC has 6 decimals on Base. */
export const USDC_DECIMALS = 6;

/**
 * Players stake this each, and the winner takes both. The number the host sets
 * is the *stake*, not the pool — asking for a pool means the host has to halve
 * it in their head to know what they are risking.
 */
export const MIN_STAKE_USDC = 0.5;
export const MAX_STAKE_USDC = 10_000;

/**
 * The stepper moves by a fraction of where it already is.
 *
 * A flat step cannot serve a range this wide: at 5 USDC it would take nineteen
 * clicks to reach the 0.50 floor, and at 10,000 it would take two thousand to
 * cross the range. Scaling the step to the magnitude keeps every part of the
 * band about the same number of clicks away.
 */
export function stakeStep(value: number): number {
  // Strict `<` so the step changes *at* each boundary rather than one step
  // past it — otherwise stepping up from 10 lands on an awkward 10.50.
  if (value < 10) return 0.5;
  if (value < 100) return 5;
  if (value < 1_000) return 50;
  return 500;
}

/** How long the tape runs. */
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 60;

/** `10` → `"10.00 USDC"`. Two decimals, because a stake is money. */
export function usdc(amount: number): string {
  return `${amount.toFixed(2)} USDC`;
}

/** What the winner walks away with: both stakes. */
export function poolOf(stakeUsdc: number): number {
  return stakeUsdc * 2;
}

/**
 * Keep a stake inside the allowed band, rounded to cents.
 *
 * `NaN` falls to the minimum rather than propagating: `Math.max(0.5, NaN)` is
 * `NaN`, so without the guard a half-typed field could put `NaN` into a room
 * and every downstream `toFixed` would render "NaN USDC".
 */
export function clampStake(value: number): number {
  if (!Number.isFinite(value)) return MIN_STAKE_USDC;
  return +Math.min(MAX_STAKE_USDC, Math.max(MIN_STAKE_USDC, value)).toFixed(2);
}

/**
 * One step up or down, landing on a round multiple of the step rather than
 * drifting off a typed value — 7.30 stepping up gives 7.50, not 7.80.
 */
export function stepStake(value: number, direction: 1 | -1): number {
  // Stepping down out of a band should use the smaller step below it, so the
  // move down mirrors the move that got you up here.
  const step = stakeStep(direction === -1 ? value - 0.01 : value);
  const raw = direction === 1 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step;
  return clampStake(+raw.toFixed(2));
}

/**
 * Whole minutes only — a duel length of 1.5 minutes reads like a bug.
 *
 * Same `NaN` guard as `clampStake`: an empty number input reads as `NaN`, and a
 * `NaN` duration divides the tape step to `NaN` and freezes the fight.
 */
export function clampDuration(value: number): number {
  if (!Number.isFinite(value)) return MIN_DURATION_MINUTES;
  return Math.min(MAX_DURATION_MINUTES, Math.max(MIN_DURATION_MINUTES, Math.round(value)));
}
