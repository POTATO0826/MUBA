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

/**
 * `RAKE_BPS` / `BPS` — the escrow's house rake, 4% of the pot, taken on
 * settlement only.
 *
 * Transcribed from `contracts/DuelEscrow.sol:146` (`uint16 public constant
 * RAKE_BPS = 400`), and the same pair `src/desk/escrow.ts` holds in `bigint`
 * for the on-chain path. Two files, one contract, and the reason both exist is
 * that they answer in two different units: the escrow module works in USDC 6dp
 * integers because it is composing a transaction, and this module works in
 * dollars because it is composing a sentence.
 */
export const RAKE_BPS = 400;
export const BPS = 10_000;

/**
 * The pot: both stakes, gross. This is **not** what the winner is paid.
 *
 * Kept as its own function because it is a real figure — it is what the escrow
 * holds between `open` and `settle`, and it is what a refund splits back — but
 * it is never the number beside the words "winner takes". See
 * {@link winnerTakesUsdc} for that, and read the two names as the distinction
 * they are.
 */
export function potOf(stakeUsdc: number): number {
  return stakeUsdc * 2;
}

/**
 * What the winner is actually paid: the pot, less the escrow's 4%.
 *
 * ## The bug this closes
 *
 * This function used to be `poolOf`, it returned `stakeUsdc * 2`, and every
 * surface that says **WINNER TAKES** printed it. `DuelEscrow.settle` pays
 * `pot - rake` — `1.92 ×` the stake, not `2 ×` — and `payoutOf` in
 * `src/desk/escrow.ts` mirrors that correctly in the contract's own integer
 * arithmetic. Two implementations of one figure, and the rake-blind one was
 * the one on screen: two players staking $10 each read **WINNER TAKES $20.00**
 * against a contract that transfers **$19.20**.
 *
 * The reason it mattered more than it looked: those surfaces render **only
 * when a deployed escrow is named** (`stakeBasisLine` takes a `DuelCustody`,
 * and the lobby's WINNER TAKES is gated on `custody !== null`). Without an
 * escrow the copy correctly says *notional · nothing is held*. So the 2× claim
 * appeared in exactly the configuration where the rake is real.
 *
 * ## Why this and `payoutOf` cannot drift
 *
 * Same order of operations, same floor: `pot - (pot * RAKE_BPS) / BPS`, with
 * the rake floored so the remainder favours the winner exactly as the contract
 * does.
 *
 * The arithmetic runs on integer **micro-USDC**, the token's own six decimals,
 * and not on the dollar float: `10 * 2 * 0.04` in binary floating point is not
 * `0.8`, and a stake is not a place to discover that. Cents would have been
 * the tempting scale — the UI prints two decimals — and it is the wrong one: a
 * $0.07 stake rakes $0.0056, which rounds away entirely at cents and would put
 * this function 4% above the chain on small stakes, i.e. exactly the error it
 * exists to remove. The whole band is safely inside `Number`'s integers
 * (`10,000 × 2 × 10⁶ × 400` is under 10¹³ against a limit of 9 × 10¹⁵).
 *
 * `test/stake.test.ts` pins the result against `payoutOf`'s bigint answer
 * across the band, so the two implementations of the one figure are held equal
 * by a test rather than by a comment.
 */
export function winnerTakesUsdc(stakeUsdc: number): number {
  if (!Number.isFinite(stakeUsdc) || stakeUsdc <= 0) return 0;
  const potMicro = Math.round(stakeUsdc * 1_000_000) * 2;
  const rakeMicro = Math.floor((potMicro * RAKE_BPS) / BPS);
  return (potMicro - rakeMicro) / 1_000_000;
}

/**
 * The old name. **It is the pot, and it has no callers left.**
 *
 * It was deliberately left as `stake × 2` rather than quietly redirected to
 * {@link winnerTakesUsdc}, because its call sites did not all mean the same
 * thing and a single alias could not be right for all of them:
 *
 *  - `src/views/RoomLobby.tsx` printed it under **WINNER TAKES**, gated on a
 *    deployed escrow → now {@link winnerTakesUsdc}.
 *  - `src/views/BoxBuilder.tsx`'s `stakeBasisLine` says *"winner takes …"*, on
 *    the same gate → now {@link winnerTakesUsdc}.
 *  - `src/state/battle.ts` fed `src/views/Create.tsx`, which heads the very
 *    same figure **WINNER TAKES** with custody and **TWICE THE STAKE** without
 *    it. Two labels, two figures, one number — so that one needed *both*
 *    names, and it now has them: `potLabel` and `payoutLabel`.
 *
 * A redirect would have turned "TWICE THE STAKE" into a 4% lie while fixing the
 * other three. The split lived here until every call site had said which figure
 * it meant; they all have, so the only thing this name still does is keep a
 * test that pins the distinction (`test/stake.test.ts`) and stop the old
 * spelling coming back by accident.
 *
 * @deprecated Say which figure you mean: {@link potOf} for the gross pot,
 * {@link winnerTakesUsdc} for what the escrow actually pays out.
 */
export function poolOf(stakeUsdc: number): number {
  return potOf(stakeUsdc);
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
