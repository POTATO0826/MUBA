/**
 * Stakes and duel length.
 *
 * Room-level stake display, denominated in native Base Sepolia test ETH.
 * The legacy `*USDC` export names remain as wire-compatible aliases while room
 * storage is migrated; no token transfer or mainnet path uses them.
 */

export const ETH_DECIMALS = 18;
export const USDC_DECIMALS = ETH_DECIMALS;

/**
 * Players stake this each, and the winner takes both. The number the host sets
 * is the *stake*, not the pool — asking for a pool means the host has to halve
 * it in their head to know what they are risking.
 */
export const MIN_STAKE_ETH = 0.001;
export const MIN_STAKE_USDC = MIN_STAKE_ETH;
/** A room-store sanity bound; the on-chain contract's uint128 bound is much larger. */
export const MAX_STAKE_ETH = 1_000_000;
export const MAX_STAKE_USDC = MAX_STAKE_ETH;

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
  if (value < 0.01) return 0.001;
  if (value < 0.1) return 0.01;
  if (value < 1) return 0.1;
  if (value < 10) return 1;
  if (value < 100) return 10;
  if (value < 1_000) return 100;
  return 1_000;
}

/** How long the tape runs. */
export const MIN_DURATION_MINUTES = 1;
export const MAX_DURATION_MINUTES = 60;

/** Input-friendly native ETH text with up to six visible decimals. */
export function stakeAmountText(amount: number): string {
  return amount.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function eth(amount: number): string {
  return `${stakeAmountText(amount)} ETH`;
}

/** Legacy helper name retained for room data compatibility. */
export const usdc = eth;

/** What the winner walks away with: both stakes. */
export function poolOf(stakeEth: number): number {
  return stakeEth * 2;
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
  const clamped = Math.min(MAX_STAKE_ETH, Math.max(MIN_STAKE_ETH, value));
  return Math.round((clamped + Number.EPSILON) * 1_000_000) / 1_000_000;
}

/**
 * One step up or down, landing on a round multiple of the step rather than
 * drifting off a typed value — 7.30 stepping up gives 7.50, not 7.80.
 */
export function stepStake(value: number, direction: 1 | -1): number {
  // Stepping down out of a band should use the smaller step below it, so the
  // move down mirrors the move that got you up here.
  const step = stakeStep(direction === -1 ? value - 0.000001 : value);
  const raw = direction === 1 ? Math.floor(value / step) * step + step : Math.ceil(value / step) * step - step;
  return clampStake(+raw.toFixed(6));
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
