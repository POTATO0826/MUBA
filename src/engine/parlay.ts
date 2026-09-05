import type { Direction, Leg, MarketSlice, PricingRow } from "../types.ts";
import { meta } from "../data/universe.ts";
import { fmtPx } from "./tape.ts";

/**
 * Parlays — and, since Phase A, the one sentence everything here follows from:
 *
 * > **A tier is no longer a constant. It is a delta bucket, queried against the
 * > live book.**
 *
 * The old `TIERS` table stated a multiplier, a hit rate and a strike scale per
 * tier. Two of those three were fiction: the game announced `SAFE pays ×1.2 and
 * lands 70% of the time` and nothing anywhere had to make that true. `TIERS` is
 * gone. What replaces it is `TIER_BANDS` — four half-open `|delta|` brackets —
 * and one derivation rule: a tier's probability is its band, and its fair price
 * is `1 / probability`. Nothing sets a payout by hand any more.
 *
 * ## Two paths, and they now share their arithmetic
 *
 *  - **The live path** (`cardsForSlice`, `multipleAt`, `basketPayoff`) builds
 *    cards from resting orders. A card exists only if an order backs it; its
 *    strike is one the venue lists, its probability is that option's own delta,
 *    its premium is what a buyer pays, and its dollar payout comes from the
 *    protocol's own payout math. When nothing in the book falls in a tier's
 *    band, that card is **not dealt** — see `cardsForSlice` step 6.
 *  - **The seeded path** (`buildLeg`, `legForCard`, `summarize`) still deals a
 *    replayable tape game offline. It reads its probability out of
 *    `TIER_BANDS` and prices it at fair odds, so the two paths cannot drift:
 *    there is exactly one place in the tree that says what `SHARP` means.
 *
 * ## `×` is odds. Dollars are dollars. (the two paths share a screen)
 *
 * A board deals up to five tickers and only ETH and BTC have a book, so a live
 * grid and a seeded grid are always on screen together. That makes the *units*
 * a correctness question rather than a styling one, and there is exactly one
 * rule: **`×` is `oddsOf(prob)` — fair odds on the chance the leg lands — on
 * both paths, everywhere.** `tierOdds` is that over a band midpoint; a live
 * card's `odds` is that over the option's own `|delta|`. What a bought option's
 * premium turns into at the reference move is a different question with a
 * different answer, it is kept (`LiveCard.payoutMult`, `multipleAt`), and it
 * reaches the screen in dollars beside the max loss it is measured against.
 * See {@link oddsOf} and {@link legFromLiveCard}.
 *
 * ## The determinism seam
 *
 * This module is scanned by `test/determinism.test.ts` and may not import a
 * live market source, an SDK or a route. It does not need to. **Market data
 * arrives as an argument** — rows, a slice, a spot, and the protocol's payout
 * function itself (`PayoutCalculator`) are all injected by the caller. Hand
 * this file a frozen fixture and every function in it is total.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The tier ladder
// ─────────────────────────────────────────────────────────────────────────────

export type Tier = "SAFE" | "EVEN" | "SHARP" | "DEGEN";

export const TIER_ORDER: readonly Tier[] = ["SAFE", "EVEN", "SHARP", "DEGEN"];

/**
 * A tier is a moneyness bracket, expressed as |delta|.
 *
 * Delta is the standard desk approximation of the risk-neutral probability that
 * an option finishes in the money. It is therefore both the game's "chance to
 * land" and the trader's greek — the same number, which is why the UI never
 * needs two words for it.
 *
 * Bands are half-open `[lo, hi)` and cover 0.05–0.85. Below 0.05 the quote is
 * lottery-ticket dust with a spread wider than the premium; above 0.85 the
 * option is deep ITM and the player is paying intrinsic value to express a view
 * they could express more cheaply. **Both ends are excluded on purpose** — an
 * option at |delta| 0.02 or 0.92 is not a harder or safer version of this game,
 * it is a different trade, and dealing it as a card would be the house quietly
 * widening the ladder to make sure a card always exists.
 *
 * Half-open also means the brackets tile without overlap: 0.65 is SAFE and not
 * EVEN, 0.45 is EVEN and not SHARP. Exactly one tier claims any given delta.
 */
export const TIER_BANDS: Record<Tier, readonly [number, number]> = {
  SAFE: [0.65, 0.85],
  EVEN: [0.45, 0.65],
  SHARP: [0.25, 0.45],
  DEGEN: [0.05, 0.25],
};

/** The tier a live delta falls in, or `null` when it falls outside every band —
 *  which is a real and ordinary answer, not a failure. `|delta|`, so a put's
 *  negative delta buckets exactly like the call it mirrors. */
export function tierOf(delta: number): Tier | null {
  if (!Number.isFinite(delta)) return null;
  const d = Math.abs(delta);
  for (const tier of TIER_ORDER) {
    const [lo, hi] = TIER_BANDS[tier];
    if (d >= lo && d < hi) return tier;
  }
  return null;
}

/**
 * The probability a tier stands for, off the book: the midpoint of its band.
 *
 * This is the **only** place a tier's chance of landing is stated, and it is
 * stated as a consequence of the band rather than beside it. The seeded game
 * reads it here; the live path never needs it, because a live card carries the
 * actual delta of the actual option and the midpoint is only ever the label.
 */
export function tierProb(tier: Tier): number {
  const [lo, hi] = TIER_BANDS[tier];
  return (lo + hi) / 2;
}

/**
 * **The one meaning of `×` on a parlay surface: fair odds on the chance a leg
 * lands.** `1 / p`, and nothing else, ever.
 *
 * This function exists because the screen had two different quantities wearing
 * the same glyph. The seeded card printed `×6.67` — fair odds on DEGEN's band
 * midpoint — and the market-priced card beside it printed `×430.75`, which is
 * `multipleAt`: what one contract's *premium* returns if the underlying happens
 * to finish 25% away. Both are true; neither is an answer to the other's
 * question; and a player reading them side by side concludes the first bet is
 * sixty-five times worse. See {@link LiveCard.payoutMult} for where that second
 * number went and why it is denominated in dollars now.
 *
 * The parlay's own arithmetic had already settled this and only the leg had not
 * caught up: {@link degeneracyScore} is `Π(1 / prob)` *specifically* so a slip's
 * `×` "cannot be inflated by a generous-looking payout table". A leg carrying
 * `multipleAt` under the same name broke the one property that made the slip
 * legible — that the leg multiples multiply into the slip multiple.
 *
 * `0` on a non-positive probability rather than `Infinity`: a `×∞` on a card is
 * a render bug wearing a number, and `degeneracyScore` already answers `0` here.
 */
export function oddsOf(prob: number): number {
  return prob > 0 ? 1 / prob : 0;
}

/**
 * The fair price of a tier: `1 / probability`.
 *
 * No house edge, no invented ladder. If a thing lands 35% of the time then even
 * money on it is ×2.857, and that is the number the seeded card prints. The old
 * table said `SHARP: ×3.6, 25%` — a 44% overround dressed as generosity, on a
 * game where nothing was ever paid.
 *
 * {@link oddsOf} over the band midpoint, so the seeded card and the live card
 * now print the same construction over two different probabilities rather than
 * two constructions over one glyph.
 */
export function tierOdds(tier: Tier): number {
  return oddsOf(tierProb(tier));
}

// ─────────────────────────────────────────────────────────────────────────────
// The loud line, and the band it is silently coupled to
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Below this implied probability the slip goes loud.
 *
 * `summarize` sets `loud = prob < LOUD_BELOW` and `prob` is
 * {@link impliedProbability} — the *product* of the legs' chances. On the seeded
 * path every one of those chances is a {@link TIER_BANDS} midpoint. So this
 * constant is not independent of the ladder, however much a bare `0.1` on its
 * own line looks like it is: **`LOUD_BELOW` and `TIER_BANDS` are two ends of one
 * decision and only one of them is written down.** That is the trap this section
 * exists to defuse.
 *
 * ## The n-th root, which is the whole relationship
 *
 * A slip of `n` legs that all sit in one tier has `prob = m × m × … × m` for `m`
 * that tier's midpoint ({@link tierProb}). It goes loud exactly when
 *
 *     mⁿ  <  LOUD_BELOW      ⟺      m  <  LOUD_BELOW ^ (1/n)
 *
 * so the midpoint at which a tier tips into the alarm state is the **n-th root
 * of `LOUD_BELOW`** — {@link loudMidpointFor}. A lobby deals 2, 3 or 4 legs
 * ({@link SLIP_LEG_COUNTS}), and at `LOUD_BELOW = 0.1` those three roots are:
 *
 *     2 legs   0.1 ^ (1/2)  =  0.316228
 *     3 legs   0.1 ^ (1/3)  =  0.464159
 *     4 legs   0.1 ^ (1/4)  =  0.562341
 *
 * Note which way that runs: **more legs is a HIGHER bar.** A four-leg slip needs
 * a midpoint above 0.5623 to stay quiet; a two-leg slip only needs 0.3162. The
 * *longest* slip trips first, which is the opposite of the intuition that a long
 * parlay is obviously the reckless one — it is, and that is precisely why an
 * all-SAFE four-legger must not be painted as one.
 *
 * ## Why this is load-bearing right now
 *
 * SAFE's midpoint is 0.75 today and clears all three roots with room, so an
 * all-SAFE slip is never loud at any legal leg count. That is not a property
 * anybody chose. It is a coincidence of where the band currently sits, and it
 * has never been asserted anywhere, so nothing would notice it ending.
 *
 * The bands are cut on `|delta|`, and the venue lists options only out to
 * `|delta|` 0.50. Re-cutting `TIER_BANDS` onto the range the book actually
 * quotes therefore pulls SAFE's midpoint **down** — toward ~0.45 on the shape
 * under discussion. At 0.45, three legs give 0.091125 and four give 0.041006,
 * both under `LOUD_BELOW`, and **every three- and four-leg all-SAFE slip flips
 * into the alarm state**: violet border, violet ODDS, violet ALL LAND
 * (`src/views/ParlayPick.tsx`). Two legs survive at 0.2025. The safest slip in
 * the game would render in the danger colour, and nothing about the band edit
 * would look like it had caused it.
 *
 * **Nothing here decides that.** Where the bands land is a measurement against
 * the book; where the loud line sits is a design call. Both are the owner's and
 * this file states neither. What it does is make the coupling impossible to trip
 * *silently*: `test/parlay.test.ts` asks {@link wouldGoLoud} for SAFE at every
 * count in {@link SLIP_LEG_COUNTS}, off the **current** bands, and fails if any
 * answer is `true`. Re-cut the ladder without revisiting this constant and that
 * test stops you, with the trade-off spelled out in the failure.
 *
 * The live path sits outside all of this on purpose: a market-priced leg carries
 * the option's own `|delta|` ({@link legFromLiveCard}), never a midpoint, so a
 * live slip's `prob` is a product of real deltas and the loud line is just a
 * threshold on it. The coupling is a property of the *seeded* ladder alone.
 */
export const LOUD_BELOW = 0.1;

/**
 * The loud test itself, in one place: is this implied probability under the
 * line?
 *
 * Extracted so {@link summarize} and {@link wouldGoLoud} share the comparison
 * rather than each writing it. That is what lets the guard test claim it is
 * checking the rule and not a model of the rule — there is one `<` in this
 * module and both callers go through it.
 */
export function isLoud(prob: number): boolean {
  return prob < LOUD_BELOW;
}

/**
 * The leg counts a slip can actually have: 2, 3 or 4.
 *
 * Not decoration on the guard — it is the domain the guard has to cover, and it
 * is enforced two modules away rather than here: `state/match.ts` clamps the
 * create form to `[2, min(4, book.length)]` (`clampLegs` over `legsMax`), the
 * form's own copy says "2 to 4" (`views/CreateLobby.tsx`), and every seeded
 * lobby in `data/lobbies.ts` carries a `legs` of 2, 3 or 4. Restated here so the
 * root table above and the guard test below are quantified over the same set
 * instead of each guessing at it.
 *
 * One leg is not in the set and would not be interesting if it were: a one-leg
 * slip is loud iff the tier's own midpoint is under `LOUD_BELOW`, which no band
 * on a ladder that stops at 0.05 can be.
 */
export const SLIP_LEG_COUNTS: readonly number[] = [2, 3, 4];

/**
 * The band midpoint at which an all-one-tier slip of `legCount` legs tips into
 * the loud state: `LOUD_BELOW ^ (1 / legCount)`.
 *
 * A tier whose midpoint is at or above this is quiet at that leg count; one
 * below it is loud. See {@link LOUD_BELOW} for the derivation, the three figures
 * it produces today, and why the bar *rises* with the leg count.
 *
 * Derived rather than tabulated, so the numbers written into that docblock
 * cannot outlive the constant they were computed from — the test checks them
 * against this function.
 */
export function loudMidpointFor(legCount: number): number {
  return LOUD_BELOW ** (1 / legCount);
}

/**
 * The implied probability of a slip whose `legCount` legs all sit in one tier.
 *
 * Folded left from `1`, one multiplication per leg — **the identical arithmetic
 * {@link impliedProbability} performs over the identical legs**, and deliberately
 * not `tierProb(tier) ** legCount`. The two agree for every midpoint the current
 * ladder produces, and float multiplication is not associative, so they are not
 * obliged to agree for the next one. A guard that answers a hair's breadth away
 * from the number `summarize` actually compares is a guard that can pass while
 * the screen goes violet.
 */
export function allOneTierProbability(tier: Tier, legCount: number): number {
  let prob = 1;
  for (let i = 0; i < legCount; i++) prob *= tierProb(tier);
  return prob;
}

/**
 * Would a slip of `legCount` legs, every one of them in `tier`, go loud?
 *
 * The same {@link isLoud} comparison `summarize` makes, over the same product
 * ({@link allOneTierProbability}) — so this is not a model of the loud rule, it
 * *is* the loud rule asked ahead of time. It reads {@link TIER_BANDS} through
 * {@link tierProb}, which is exactly what makes it move when the ladder is
 * re-cut and what makes the guard test in `test/parlay.test.ts` bite.
 */
export function wouldGoLoud(tier: Tier, legCount: number): boolean {
  return isLoud(allOneTierProbability(tier, legCount));
}

/**
 * How far a seeded leg's line sits from spot, as a multiple of the asset's own
 * base move. **Tape geometry, not odds.**
 *
 * The seeded game settles on a generated eight-second walk, and a line on that
 * walk needs a distance. Delta does not supply one without a volatility model,
 * and inventing a volatility model to place a line on a fake tape would be
 * fiction with more steps. So the distances stay, unchanged from the values the
 * replay locks were frozen against — and they are *only* distances. They set no
 * payout and no probability; `TIER_BANDS` does both, for both paths.
 */
export const TIER_MOVE: Record<Tier, number> = {
  SAFE: 0.35,
  EVEN: 1,
  SHARP: 1.8,
  DEGEN: 3.2,
};

// ─────────────────────────────────────────────────────────────────────────────
// The seeded leg
// ─────────────────────────────────────────────────────────────────────────────

export interface ParlayLeg extends Leg {
  tier: Tier;
  /** The asset's own target, before the tier scaled it. */
  baseT: number;
  /** Fair odds on `prob` — `oddsOf(prob)`, on **both** paths. Never a table
   *  lookup, never a payout ratio: see {@link oddsOf} and
   *  {@link legFromLiveCard} for why a live leg does not carry `payoutMult`
   *  here. `mult * prob === 1` is an invariant of this field. */
  mult: number;
  /** The tier's band midpoint on the seeded path; the option's own |delta|
   *  once `optionize` has re-denominated the leg against a real quote. */
  prob: number;
  /** Reference spot, for the condition string. */
  px: number;
  /** The price the leg must close beyond. */
  strike: number;
}

/** `targetScale` is the mode's shrink factor: a shorter duel window moves less,
 *  so every line moves in with it. `1` is the full-tape lobby, unchanged. */
export function buildLeg(
  sym: string,
  dir: Direction,
  tier: Tier,
  targetScale = 1,
): ParlayLeg {
  const u = meta(sym);
  const t = +(u.t * TIER_MOVE[tier] * targetScale).toFixed(2);
  const strike = u.px * (1 + (dir === "over" ? t : -t) / 100);
  return {
    sym,
    dir,
    t,
    sector: u.sector,
    tier,
    baseT: u.t,
    mult: tierOdds(tier),
    prob: tierProb(tier),
    px: u.px,
    strike,
  };
}

/**
 * "BTC closes above 100,266 (+4.0%) by Fri expiry".
 *
 * The percentage is the move **to the strike**, signed the way a reader expects:
 * `+` when the line sits above spot, `−` when it sits below. For a leg built
 * here that is `+t` for an over and `−t` for an under, exactly as it always
 * printed, because `buildLeg` only ever produces `t >= 0`.
 *
 * The signed form is written out rather than assumed because a leg's `t` is not
 * obliged to be positive. `legState` compares `pct >= t` / `pct <= -t` and is
 * perfectly happy with a negative one — which is what an already-in-the-money
 * line is: an over leg that wins unless the tape falls to meet it. The old
 * two-branch sign would have printed that as `(+-1.2%)`.
 */
export function conditionText(leg: ParlayLeg): string {
  const verb = leg.dir === "over" ? "closes above" : "closes below";
  const move = leg.dir === "over" ? leg.t : -leg.t;
  const sign = move >= 0 ? "+" : "−";
  return `${leg.sym} ${verb} ${fmtPx(leg.strike)} (${sign}${Math.abs(move).toFixed(1)}%) by Fri expiry`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The slip's two numbers, each honest about what it measures
// ─────────────────────────────────────────────────────────────────────────────

/** The product of the leg hit rates: the chance every leg lands. */
export function impliedProbability(legs: readonly { prob: number }[]): number {
  return legs.reduce((acc, l) => acc * l.prob, 1);
}

/**
 * The slip's **degeneracy score**: the product of `1 / prob` across its legs.
 *
 * This is a GAME number and it is named like one. It sizes the escrow stake and
 * it drives the loud-card styling; it is never rendered beside a currency
 * symbol and it is never described as a payout.
 *
 * It replaces the old `parlayMultiplier`, which multiplied the legs' payout
 * multipliers and called the product what a basket pays. On a basket of real
 * options that is **arithmetically false** — a basket pays the *sum* of its
 * legs, not the product; see `basketPayoff`, which is the number that reaches
 * the wallet. The parlay drama survives, it just moves to where it is true:
 * all-or-nothing now describes who takes the escrow pot, which genuinely is
 * all-or-nothing.
 *
 * `1 / prob` rather than a stored `mult` so the score cannot be inflated by a
 * generous-looking payout table. The reciprocal of the chance is the only
 * defensible reading of "how long a shot is this".
 */
export function degeneracyScore(legs: readonly { prob: number }[]): number {
  return legs.reduce((acc, l) => acc * (l.prob > 0 ? 1 / l.prob : 0), 1);
}

export interface ParlaySummary {
  /** The degeneracy score × the mode's odds boost. A **game** figure: it scales
   *  the points at stake and decides whether the slip goes loud. It is not
   *  money and nothing pays it out. */
  mult: number;
  prob: number;
  /** Points, not currency. `stakePoints × mult`. */
  potentialPoints: number;
  /**
   * True when `prob` is below {@link LOUD_BELOW} — {@link isLoud}, and nothing
   * else.
   *
   * It is the alarm state on the pick screen: violet border, violet ODDS, violet
   * ALL LAND. Which slips reach it is **not** a free choice of this constant, it
   * is that constant crossed with {@link TIER_BANDS}: see `LOUD_BELOW`'s
   * docblock for the n-th-root relationship, and {@link wouldGoLoud} for the
   * question the guard test asks of it.
   */
  loud: boolean;
}

/** `oddsBoost` is the mode's premium for the tighter window. It rides on `mult`,
 *  so it reaches `potentialPoints` too — the boost is a score, not a label. */
export function summarize(
  legs: readonly ParlayLeg[],
  stakePoints: number,
  oddsBoost = 1,
): ParlaySummary {
  const mult = degeneracyScore(legs) * oddsBoost;
  const prob = impliedProbability(legs);
  // `isLoud` and not an inline `prob < LOUD_BELOW`: the guard in
  // `test/parlay.test.ts` asks the same predicate about a slip that has not been
  // built yet, and two spellings of one comparison is how that guard would
  // quietly stop describing this line.
  return { mult, prob, potentialPoints: Math.round(stakePoints * mult), loud: isLoud(prob) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The cards
// ─────────────────────────────────────────────────────────────────────────────

export type Stance = "bull" | "bear";

/** One pick for one leg: a tier and a stance. */
export interface ParlayCard {
  id: string;
  tier: Tier;
  stance: Stance;
  label: string;
}

/** Four tiers, bullish and bearish each. Eight cards per leg. */
export const PARLAY_CARDS: readonly ParlayCard[] = TIER_ORDER.flatMap((tier) =>
  (["bull", "bear"] as const).map((stance) => ({
    id: `${tier.toLowerCase()}-${stance}`,
    tier,
    stance,
    label: `${tier} · ${stance === "bull" ? "BULLISH" : "BEARISH"}`,
  })),
);

export function cardById(id: string | null | undefined): ParlayCard | null {
  return id ? (PARLAY_CARDS.find((c) => c.id === id) ?? null) : null;
}

/** One leg from one pick. */
export function legForCard(sym: string, card: ParlayCard, targetScale = 1): ParlayLeg {
  return buildLeg(sym, card.stance === "bull" ? "over" : "under", card.tier, targetScale);
}

/** The slip a pick per ticker produces. Every ticker must have one. */
export function legsForPicks(
  syms: readonly string[],
  picks: Readonly<Record<string, ParlayCard>>,
  targetScale = 1,
): readonly ParlayLeg[] {
  return syms.map((sym) => legForCard(sym, picks[sym]!, targetScale));
}

/** "SAFE↑ EVEN↓ DEGEN↑" — the slip, one glyph per leg. */
export function slipLabel(legs: readonly ParlayLeg[]): string {
  return legs.map((l) => `${l.tier}${l.dir === "over" ? "↑" : "↓"}`).join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// The live card — built from the book, or not dealt
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The protocol's own payout math, injected.
 *
 * This is `client.utils.calculatePayout`'s signature, restated here so the
 * engine can *use* it without importing it — the determinism guard forbids this
 * module from naming the SDK, and it is right to. The caller (a view, a route,
 * a test) hands the function in; the engine stays a total function of its
 * arguments and a frozen stub drives every test.
 *
 * The narrowed `type` union is not cosmetic: seven of the SDK's ten payout types
 * name multi-leg products whose physical implementations are the zero address on
 * Base, so a card can never be one of them. Narrowing here is what makes an
 * unfillable structure a compile error rather than a runtime revert.
 */
export type PayoutSide = "call" | "put" | "call_spread" | "put_spread";

export interface PayoutQuery {
  /** **Lowercase.** The registry names the same shapes in UPPER_SNAKE and the
   *  payout math does not accept them. */
  type: PayoutSide;
  /** 8dp. Length is checked before the call — see `assertStrikes`. */
  strikes: bigint[];
  /** 8dp. */
  settlementPrice: bigint;
  /** 18dp. */
  numContracts: bigint;
  priceDecimals?: number;
  sizeDecimals?: number;
  collateralDecimals?: number;
}

export type PayoutCalculator = (params: PayoutQuery) => bigint;

/** Contract prices and strikes are 8dp. */
export const PRICE_DECIMALS = 8;
/** `numContracts` is 18dp. */
export const CONTRACT_DECIMALS = 18;
/** Payouts come back in collateral decimals; USDC is 6. */
export const COLLATERAL_DECIMALS = 6;

/**
 * How many strikes each payout type takes — **exactly**, never "at least".
 *
 * `calculatePayout` throws `INVALID_PARAMS` on a wrong-length array, and the
 * failure is silent up to the moment it is not: a two-strike array handed to
 * `'call'` does not price a spread, it kills the render. One element for
 * call/put, exactly two for the spreads, and never three or four — three is a
 * butterfly and four is a condor or a ranger, and every physical multi-leg
 * implementation on Base is the zero address, so neither can be filled and
 * neither may be quoted as a card.
 */
export const STRIKE_COUNT: Record<PayoutSide, number> = {
  call: 1,
  put: 1,
  call_spread: 2,
  put_spread: 2,
};

/**
 * The guard, in front of the SDK rather than behind it.
 *
 * Throwing our own error here rather than letting `INVALID_PARAMS` come back
 * out of the payout math is the difference between "this card was built wrong"
 * and "the venue rejected something"; only one of those is actionable.
 */
export function assertStrikes(type: PayoutSide, strikes: readonly bigint[]): void {
  const want = STRIKE_COUNT[type];
  if (strikes.length !== want) {
    throw new Error(
      `calculatePayout('${type}') takes exactly ${want} strike${want === 1 ? "" : "s"}, got ${strikes.length}`,
    );
  }
}

/** A decimal number as fixed-point units. Rounds rather than truncates, so a
 *  strike of `2599.9999999` does not silently become `2599.99999989`. */
export function toUnits(value: number, decimals: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  return BigInt(Math.round(value * 10 ** decimals));
}

/** Fixed-point units back to a number. */
export function fromUnits(value: bigint, decimals: number): number {
  return Number(value) / 10 ** decimals;
}

/**
 * The protocol's vanilla payout arithmetic, restated — the calculator every
 * caller in this tree passes to {@link multipleAt} and {@link cardsForSlice}.
 *
 * ## What it is
 *
 * `client.utils.calculatePayout` is, per `tnuts-test/FINDINGS.md` §"0.3.0
 * delta", **sync local math** — no RPC, no chain read. For a long vanilla it is
 * `max(0, settlement − strike) × contracts` (and the mirror for a put), in
 * collateral decimals. That is what is below, against the identical
 * {@link PayoutQuery} contract: lowercase type, 8dp strikes and settlement, 18dp
 * contracts, collateral out.
 *
 * ## Why it lives here, and why it is still an ARGUMENT everywhere
 *
 * It is defined in the engine because two surfaces need the same one and they
 * must not each write their own: the pick screen deals cards off the frozen
 * book, and `src/state/match.ts` prices the legs off that same book. Two
 * restatements of this function would be exactly the drift this file exists to
 * delete — one screen's ×N disagreeing with another's for the same bet.
 *
 * It changes nothing about the seam. `multipleAt`, `cardsForSlice`,
 * `cardsForTicker` and `basketPayoff` all still take a {@link PayoutCalculator}
 * as a parameter, a frozen stub drives every test, and the day the payout comes
 * off the wire beside the rows — or the SDK ships a bundle-safe subpath — this
 * constant is the one thing that changes. The determinism guard is untouched:
 * nothing here names the SDK, imports a package, or reads anything.
 *
 * The reason it is not the SDK's own function *yet*: the package ships one entry
 * point and it pulls `axios`, `ethers` and `viem` behind it. Importing it to
 * reach a pure arithmetic helper would put an HTTP client and two chain
 * libraries in the browser bundle and make the pick screen unmountable in a DOM
 * test. The SDK is confined to this app's server side for exactly that reason —
 * and this file may not so much as name that module, which is the determinism
 * guard doing its job rather than an inconvenience.
 *
 * The two spread types are refused rather than guessed. {@link assertStrikes}
 * and {@link STRIKE_COUNT} already make a spread unreachable from a card — one
 * strike or it is not dealt — and a wrong spread convention would not throw, it
 * would quietly print a wrong multiplier, which is the failure mode this whole
 * path exists to remove.
 */
export const vanillaPayout: PayoutCalculator = (q: PayoutQuery) => {
  if (q.type !== "call" && q.type !== "put") {
    throw new Error(`vanillaPayout prices 'call' and 'put' only, not '${q.type}'`);
  }
  const strike = fromUnits(q.strikes[0] ?? 0n, q.priceDecimals ?? PRICE_DECIMALS);
  const settlement = fromUnits(q.settlementPrice, q.priceDecimals ?? PRICE_DECIMALS);
  const contracts = fromUnits(q.numContracts, q.sizeDecimals ?? CONTRACT_DECIMALS);
  const intrinsic =
    q.type === "call" ? Math.max(0, settlement - strike) : Math.max(0, strike - settlement);
  const collateral = q.collateralDecimals ?? COLLATERAL_DECIMALS;
  return BigInt(Math.round(intrinsic * contracts * 10 ** collateral));
};

/**
 * How far past spot the payout multiple is read.
 *
 * A long option's payoff is unbounded, so "what does this pay" is not a number
 * without a reference terminal price. 25% is the same band the venue publishes
 * strikes in, so the multiple is read at the edge of the range the book
 * actually quotes rather than extrapolated past its own data. It is a stated
 * convention, and it is stated on the card as well as here.
 */
export const REFERENCE_MOVE = 0.25;

/** One card, backed by a real order. */
export interface LiveCard extends ParlayCard {
  underlying: string;
  /** The listed strike, as the row prints it. */
  strike: string;
  /** The same strike as a number, on the live scale. */
  strikeAt: number;
  /** The row's own expiry label — `"12 SEP"`. */
  expiry: string;
  /** The **option** expiry the slice named, unix seconds. */
  expiryAt: number;
  /** `|delta|`, verbatim from the order's greeks. The "chance to land". */
  prob: number;
  /** Premium paid per contract, in the row's collateral units. **This is also
   *  the max loss**, and A7 requires it on the card face at every detail
   *  level, above the upside figure. */
  premium: number;
  /**
   * **Fair odds on this option's own delta** — `oddsOf(prob)`, the same
   * construction `tierOdds` is over a band midpoint. This is the card's `×`,
   * and it is the only figure on it that is comparable with the seeded card in
   * the next ticker's grid.
   *
   * It is also what {@link legFromLiveCard} puts on the leg, which is what
   * makes `Π(leg.mult)` equal the slip's own `×` ({@link degeneracyScore}).
   */
  odds: number;
  /**
   * **Payout multiple on the premium, at the reference move** — `multipleAt`.
   * Not odds, and deliberately no longer called `mult`.
   *
   * A far-OTM DEGEN call costs almost nothing and pays a great deal at +25%, so
   * this is routinely in the hundreds. That is a true fact about a bought
   * option and it is not clamped, capped or hidden — but it answers "what does
   * my premium turn into at one particular terminal price", while `odds`
   * answers "how likely is this leg to land at all", and the two must never
   * share a glyph. So this number reaches the screen **denominated in dollars**
   * (`MAX LOSS $6.70` → `WIN $606.64 · payout at ±25%`, `ParlayCardFace`),
   * where its magnitude is fully visible and its basis is printed beside it,
   * and never as a bare `×430.75` next to a seeded `×6.67`.
   *
   * Derived on every build, never persisted — see {@link multipleAt}.
   */
  payoutMult: number;
  /**
   * `markPrice` as a number, or `null`.
   *
   * `null` is ordinary: MM pricing covers two underlyings and the resting book
   * covers more, so most live cards have no mark. The duel clock (Phase C)
   * scores on Δ mark and simply cannot score a card that has none — which is
   * the honest outcome, and better than scoring against a mid we made up.
   */
  mark: number | null;
  row: PricingRow;
}

/** What `cardsForSlice` needs that the book does not carry. */
export interface CardDeps {
  /** The protocol's payout math. Injected — see `PayoutCalculator`. */
  calculatePayout: PayoutCalculator;
  /** Live spot for the slice's underlying. */
  spot: number;
  /** The reference move the multiple is read at. Defaults to `REFERENCE_MOVE`. */
  movePct?: number;
}

/** `"−0.34"` → `-0.34`, `"—"` → `null`. Both minus signs on purpose: the seeded
 *  table writes U+2212 and the live builder writes `toFixed`'s ASCII hyphen, and
 *  reading one of the two silently drops every put on one side of the seam. */
function parseNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(String(s).replace("−", "-"));
  return Number.isFinite(n) ? n : null;
}

/** The single 8dp strike an order names, or `null` — a multi-strike order is a
 *  spread or worse and has no single line to bet against. */
function strikeUnitsOf(row: PricingRow): bigint | null {
  const strikes = row.order?.rawApiData?.strikes;
  if (!strikes || strikes.length !== 1) return null;
  try {
    return BigInt(strikes[0]!);
  } catch {
    return null;
  }
}

/** The option expiry the order names, unix seconds, or `null`. */
function expiryOf(row: PricingRow): number | null {
  const raw = row.order?.order?.expiry;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * How many of the eight (tier, stance) slots one expiry could fill.
 *
 * The predicate is {@link cardsForSlice}'s steps 1–5, restated over a single
 * expiry: a plain vanilla on some side, a fillable order behind it, exactly one
 * strike, a delta that buckets into a band, and an ask a buyer could pay. It
 * deliberately does **not** check the strike window, because the window
 * {@link fullLadderSlice} builds for an expiry is the min–max of that expiry's
 * own rows — every row it counts is inside it by construction.
 *
 * Counted as a set of *slots*, not a count of rows. Eleven calls all sitting in
 * DEGEN cover one slot, not eleven, and an expiry that deals one card per tier
 * on both sides beats them however thin it is. Coverage is what the grid shows;
 * depth is not.
 *
 * Returned as a `Set` of `PARLAY_CARDS` indices rather than a number so the
 * caller can tie-break, log or test on *which* slots an expiry covers.
 */
function slotsCoveredAt(rows: readonly PricingRow[], expiry: number): ReadonlySet<number> {
  const covered = new Set<number>();
  for (const row of rows) {
    if (row.type !== "CALL" && row.type !== "PUT") continue;
    if (row.structure !== undefined && row.structure !== row.type) continue;
    if (!row.order) continue;
    if (strikeUnitsOf(row) === null) continue;
    if (expiryOf(row) !== expiry) continue;
    const delta = parseNum(row.delta);
    if (delta === null) continue;
    const tier = tierOf(delta);
    if (tier === null) continue;
    const ask = parseNum(row.ask);
    if (ask === null || !(ask > 0)) continue;
    const stance: Stance = row.type === "CALL" ? "bull" : "bear";
    const i = PARLAY_CARDS.findIndex((c) => c.tier === tier && c.stance === stance);
    if (i >= 0) covered.add(i);
  }
  return covered;
}

/**
 * The widest slice a chain can support: **the expiry that fills the most slots**,
 * and the whole listed strike ladder at that expiry.
 *
 * ## Why this is not the reel dealing a window
 *
 * `spinSlice` deals arenas — an underlying, an expiry, a *narrowed* strike
 * window, sometimes a constraint — and everything it decides comes off a seed.
 * This function narrows nothing. It is the **identity window** over the expiry
 * it selects: every strike the book lists at that expiry, in, and nothing out. A
 * surface that already knows which ticker it is showing (the pick screen knows:
 * the reel dealt it) needs a `MarketSlice` to call {@link cardsForSlice} with,
 * and the honest one to hand it is "all of this ticker's book at one expiry"
 * rather than a window nobody spun.
 *
 * If a spun slice ever reaches that surface, it replaces this — narrowing is the
 * reel's job and this is the absence of narrowing, so the two compose rather
 * than compete.
 *
 * ## One expiry, and not all of them — unchanged, and still the point
 *
 * `cardsForSlice` matches one expiry: two expiries in one window would let a
 * SAFE card expire in three days and the DEGEN beside it in three weeks, which
 * are not the same bet in different clothes. **That reasoning has not changed
 * and this function still honours it.** A grid is one expiry or it is not a
 * grid; mixing was never on the table and is not on it now.
 *
 * ## What changed: *which* one expiry
 *
 * This used to take the **front** expiry — the earliest one any dealable row
 * named. That is a defensible tie-break and it was a bad selection rule, because
 * the front expiry is where the book is thinnest. Measured on a real ETH chain,
 * 95 vanillas narrowed to 20 that were single-strike-and-askable, and only 2 of
 * those sat at the front expiry while a later one carried 11. The grid dealt two
 * live cards and fell back to a seeded card — `MAX LOSS —` — in the other six
 * slots, not because the book had nothing to say but because we asked the
 * emptiest date.
 *
 * So the rule is now **coverage**: of every expiry the chain lists, take the one
 * whose rows fill the most of the eight (tier, stance) slots
 * ({@link slotsCoveredAt}). Ties break to the **earlier** expiry, which is the
 * old rule surviving exactly where it belongs — as a tie-break, not as the
 * selection.
 *
 * Two properties this must have, and does:
 *
 *  - **Pure, and total, in the snapshot.** No clock, no `Date.now()`, no
 *    ordering dependence: the answer is a function of the rows alone. Both
 *    players deal the same grid from the same data or the duel is not a duel,
 *    and a selection that drifted with wall-clock time would break that
 *    silently, on one machine, mid-match.
 *  - **Deterministic on ties.** Equal coverage resolves to the smaller unix
 *    expiry, so two machines iterating the same rows in the same order — or in
 *    any order — agree. The candidate expiries are sorted before the scan rather
 *    than trusted to arrive sorted.
 *
 * It maximises *slots covered*, not rows available: see {@link slotsCoveredAt}.
 * An expiry with one card in each of the eight slots beats an expiry with forty
 * rows that all bucket into DEGEN, because eight live cards is a grid and one
 * live card beside seven dashes is the defect this rule exists to remove.
 *
 * ## The window itself
 *
 * The strike bounds still come from the *dealable* rows at the chosen expiry —
 * vanilla, fillable, one strike, a real expiry — and not from the narrower set
 * `slotsCoveredAt` counts. A row with no delta cannot be dealt but it is still a
 * strike the venue lists at that expiry, and the window is "the ladder", so it
 * stays inside the bounds. This preserves the identity property: filtering the
 * chain through its own slice loses nothing.
 *
 * @returns `null` when no row in the chain is dealable at all. Ordinary: the
 *   seeded fixtures carry no `order` and answer `null` here, which is what keeps
 *   the offline board on the seeded path. Also `null`-adjacent by design: when
 *   *no* expiry covers a single slot, coverage is 0 everywhere, the tie-break
 *   picks the earliest, and `cardsForTicker` then answers `null` because nothing
 *   was dealt — the same honest outcome by a different route.
 */
export function fullLadderSlice(
  underlying: string,
  rows: readonly PricingRow[],
): MarketSlice | null {
  const dealable: { strike: bigint; expiry: number }[] = [];
  for (const row of rows) {
    if (row.type !== "CALL" && row.type !== "PUT") continue;
    if (row.structure !== undefined && row.structure !== row.type) continue;
    if (!row.order) continue;
    const strike = strikeUnitsOf(row);
    if (strike === null) continue;
    const expiry = expiryOf(row);
    if (expiry === null) continue;
    dealable.push({ strike, expiry });
  }
  if (dealable.length === 0) return null;

  // Sorted ascending so the scan below can keep the first best it meets and
  // have that be the earliest — the tie-break, expressed as iteration order
  // rather than as a comparison that could be got backwards.
  const expiries = [...new Set(dealable.map((d) => d.expiry))].sort((a, b) => a - b);

  let expiry = expiries[0]!;
  let bestCovered = -1;
  for (const candidate of expiries) {
    const covered = slotsCoveredAt(rows, candidate).size;
    // Strictly greater: an equal-coverage later expiry never displaces the
    // earlier one already held.
    if (covered > bestCovered) {
      bestCovered = covered;
      expiry = candidate;
    }
  }

  let lo: bigint | null = null;
  let hi: bigint | null = null;
  for (const d of dealable) {
    if (d.expiry !== expiry) continue;
    if (lo === null || d.strike < lo) lo = d.strike;
    if (hi === null || d.strike > hi) hi = d.strike;
  }
  if (lo === null || hi === null) return null;

  return { underlying, expiry, strikeLo: lo.toString(), strikeHi: hi.toString() };
}

/**
 * The eight cards a slice deals — **or fewer**.
 *
 * For each of the four tiers crossed with the two stances, in `PARLAY_CARDS`
 * order, six filters in sequence:
 *
 *  1. **side** — a bull buys a call, a bear buys a put. `type` alone is not
 *     enough: a call spread also carries `type: "CALL"` while printing only its
 *     first strike, so `structure` must be absent (the seeded table, which
 *     predates the field) or equal to the vanilla side. Everything else —
 *     SPREAD, FLY, CONDOR, RANGER, UNKNOWN — is refused rather than guessed at.
 *  2. **the slice** — the strike inside `[strikeLo, strikeHi]` inclusive, and
 *     the **option** expiry equal to the slice's. Compared as 8dp integers, so
 *     no float round trip can push a boundary strike out of its own window.
 *  3. **fillable and scoreable** — a defined delta *and* a defined `order`. A
 *     row quoted by market makers alone has nothing a player can press; a row
 *     with no greeks cannot be bucketed into a tier at all.
 *  4. **the band** — `|delta|` inside the tier's half-open bracket.
 *  5. **the price** — the lowest ask among the survivors. The cheapest way to
 *     express the same view is the one to offer.
 *  6. **or nothing** — if no row survives, that card is not dealt this round
 *     and the slot is `null`.
 *
 * **Step 6 is a feature.** A missing DEGEN BULLISH is a true statement about the
 * book, and a card that always exists is the tell that the odds are house-set.
 *
 * Returns a slot per `PARLAY_CARDS` entry, index-aligned, so the UI can render
 * a dead slot in the position the card would have occupied rather than
 * reflowing the grid around an absence.
 */
export function cardsForSlice(
  rows: readonly PricingRow[],
  slice: MarketSlice,
  deps: CardDeps,
): readonly (LiveCard | null)[] {
  let lo: bigint;
  let hi: bigint;
  try {
    lo = BigInt(slice.strikeLo);
    hi = BigInt(slice.strikeHi);
  } catch {
    return PARLAY_CARDS.map(() => null);
  }
  const movePct = deps.movePct ?? REFERENCE_MOVE;

  return PARLAY_CARDS.map((card) => {
    const want = card.stance === "bull" ? "CALL" : "PUT";
    const [bandLo, bandHi] = TIER_BANDS[card.tier];

    let best: { row: PricingRow; ask: number; strike: bigint; delta: number; expiry: number } | null =
      null;

    for (const row of rows) {
      // 1 — side, and only a plain vanilla on it.
      if (row.type !== want) continue;
      if (row.structure !== undefined && row.structure !== want) continue;

      // 3a — a fillable order. Checked before the slice work because it is the
      // cheapest rejection and the one that removes the most rows.
      if (!row.order) continue;
      const strike = strikeUnitsOf(row);
      if (strike === null) continue;
      const expiry = expiryOf(row);
      if (expiry === null) continue;

      // 2 — the slice's window and expiry.
      if (strike < lo || strike > hi) continue;
      if (expiry !== slice.expiry) continue;

      // 3b — a delta to bucket on.
      const delta = parseNum(row.delta);
      if (delta === null) continue;

      // 4 — the band, half-open.
      const d = Math.abs(delta);
      if (!(d >= bandLo && d < bandHi)) continue;

      // 5 — the lowest ask. A row with no usable ask is not a purchase.
      const ask = parseNum(row.ask);
      if (ask === null || !(ask > 0)) continue;
      if (best === null || ask < best.ask) best = { row, ask, strike, delta, expiry };
    }

    // 6 — the dead slot.
    if (best === null) return null;

    const prob = Math.abs(best.delta);
    const draft: LiveCard = {
      ...card,
      underlying: slice.underlying,
      strike: best.row.strike,
      strikeAt: fromUnits(best.strike, PRICE_DECIMALS),
      expiry: best.row.expiry,
      expiryAt: best.expiry,
      prob,
      premium: best.ask,
      odds: oddsOf(prob),
      payoutMult: 0,
      mark: parseNum(best.row.mark),
      row: best.row,
    };
    return {
      ...draft,
      payoutMult: multipleAt(draft, deps.spot, movePct, deps.calculatePayout),
    };
  });
}

/**
 * The payout multiple if the underlying finishes `movePct` beyond spot, in the
 * card's own direction.
 *
 * This is `calculatePayout` divided by premium paid. It is recomputed on every
 * render because both inputs move: the premium moves with the book, and the
 * reference move moves with the mode's window. A stored multiplier goes stale
 * silently, which is the exact failure the old `TIERS` constant had.
 *
 * **It is not odds and it is not a `×` on any screen.** It lands on the card as
 * {@link LiveCard.payoutMult} and reaches the player multiplied back into
 * dollars (`premium × payoutMult` = `WIN $606.64`), directly under the premium
 * it is measured against. `oddsOf` is what wears the `×`. See the module
 * docblock's "`×` is odds" section.
 *
 * ## Units, and the one assumption
 *
 * The numerator is `calculatePayout`'s answer for **one contract**, which comes
 * back in collateral decimals. The denominator is the order's ask, which is a
 * price per contract in the order's collateral token. Those are the same unit
 * whenever the collateral is USDC, which is what the great majority of the Base
 * book is collateralised in — and where it is not (WETH, cbBTC), this ratio is
 * off by that token's price and the number is approximate. It is stated here
 * rather than papered over; Phase D's fill is the path that must be exact, and
 * it reads `totalCollateral` off the preview rather than deriving anything.
 *
 * Returns `0` rather than throwing on a degenerate premium: a pure function
 * called inside a render is the wrong place to throw, and a `×0` card is
 * visibly wrong in a way an exception is not.
 */
export function multipleAt(
  card: LiveCard,
  spot: number,
  movePct: number,
  calculatePayout: PayoutCalculator,
): number {
  if (!(spot > 0) || !(card.premium > 0) || !Number.isFinite(movePct)) return 0;
  const type: PayoutSide = card.stance === "bull" ? "call" : "put";
  const settlement = card.stance === "bull" ? spot * (1 + movePct) : spot * (1 - movePct);
  if (!(settlement > 0)) return 0;

  const strikes = [toUnits(card.strikeAt, PRICE_DECIMALS)];
  // The guard, before the call. `calculatePayout` throws INVALID_PARAMS on a
  // wrong length, and one card must not be able to kill a render.
  assertStrikes(type, strikes);

  const payout = calculatePayout({
    type,
    strikes,
    settlementPrice: toUnits(settlement, PRICE_DECIMALS),
    numContracts: toUnits(1, CONTRACT_DECIMALS),
    priceDecimals: PRICE_DECIMALS,
    sizeDecimals: CONTRACT_DECIMALS,
    collateralDecimals: COLLATERAL_DECIMALS,
  });

  const paid = fromUnits(payout, COLLATERAL_DECIMALS);
  const raw = paid / card.premium;
  return Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Every card one ticker's own book deals, or `null` when it deals none.
 *
 * The whole live path for a single underlying, in one call — the identity
 * window off {@link fullLadderSlice}, then {@link cardsForSlice} over it. It
 * exists so the two surfaces that need those cards run the *same* function
 * rather than two copies of the same four lines: `src/state/match.ts` prices a
 * match's legs with it at deal time, and `src/views/ParlayPick.tsx` draws the
 * grid with it. A card and the leg it produced cannot then disagree, because
 * they are the same object read twice.
 *
 * `null` — and not eight dead slots — for every degenerate case: no rows, no
 * live spot, no dealable row in the chain, or a chain whose every delta falls
 * outside all four bands. That ticker is **seeded**, exactly as it was before
 * options existed, and both callers treat `null` that way. Eight dead slots
 * would delete a playable ticker from a duel that still has to settle, and a
 * dead slot only carries information beside a live sibling.
 *
 * Pure, and market data arrives as arguments: rows, a spot, and the payout
 * function. The determinism guard is untouched.
 */
export function cardsForTicker(
  sym: string,
  rows: readonly PricingRow[],
  spot: number,
  calculatePayout: PayoutCalculator,
  movePct: number = REFERENCE_MOVE,
): readonly (LiveCard | null)[] | null {
  if (rows.length === 0 || !(spot > 0)) return null;
  const slice = fullLadderSlice(sym, rows);
  if (slice === null) return null;
  const dealt = cardsForSlice(rows, slice, { calculatePayout, spot, movePct });
  return dealt.some((c) => c !== null) ? dealt : null;
}

/**
 * The dealt slot for one tier on one side, or `null`.
 *
 * {@link cardsForSlice} returns a slot per {@link PARLAY_CARDS} entry,
 * index-aligned, so the (tier, stance) lookup is a position lookup. `null` is
 * two ordinary things at once — this ticker dealt nothing, or no resting order
 * backs this tier on this side — and every caller wants the same answer for
 * both: fall back to the seeded card.
 */
export function slotFor(
  slots: readonly (LiveCard | null)[] | null | undefined,
  tier: Tier,
  stance: Stance,
): LiveCard | null {
  if (!slots) return null;
  const i = PARLAY_CARDS.findIndex((c) => c.tier === tier && c.stance === stance);
  return i < 0 ? null : (slots[i] ?? null);
}

/**
 * One seeded leg, re-denominated against the card the book actually dealt.
 *
 * **This is where a market-priced leg gets its numbers, and it is the only
 * place.** Five fields move and five stay. The probability is the option's own
 * `|delta|`; the strike is one the venue lists; the reference price is the live
 * spot the strike is quoted against.
 *
 * ## The multiple, and the one thing about it that changed
 *
 * `mult` is the dealt card's {@link LiveCard.odds} — `oddsOf(|delta|)` — and
 * **not** its {@link LiveCard.payoutMult}. It used to be the latter, and that
 * was the defect: a leg then carried "what my premium returns at +25%" under
 * the same name a seeded leg carries "fair odds that this lands", and the two
 * were rendered side by side, in one glyph, on the ticker header, on the slip
 * and on the card face. With the options flag on, ETH DEGEN read `×430.75`
 * beside AVAX DEGEN `×6.67` and nothing on screen said they were answers to
 * different questions.
 *
 * The fix is not a clamp — plan 6 retired a clamped ratio for exactly that
 * reason, and a `Math.min` here would only have hidden the disagreement. It is
 * that `×` now means one thing on both paths, and the payout multiple keeps its
 * full magnitude in the unit it is actually denominated in: dollars, on the
 * card face, as `WIN $606.64` under `MAX LOSS $6.70`, with `payout at ±25%`
 * printed beside it. Nothing is capped and nothing is dropped.
 *
 * Two properties follow, neither of which held before:
 *
 *  - `leg.mult * leg.prob === 1` on **both** paths — the invariant
 *    `test/parlay.test.ts` already pinned for the seeded leg.
 *  - `Π(leg.mult)` is the slip's own `×` ({@link degeneracyScore}, times the
 *    mode's boost). A slip whose legs read `×4.00 ×6.67 ×2.86` and whose ODDS
 *    read `×76.3` is now arithmetic a player can check.
 *
 * `multipleAt` and `calculatePayout` have not left the screen: `WIN $` is
 * `premium × payoutMult`, so the protocol's payout arithmetic is still the
 * provenance of a rendered figure (plan 6 §9 item 2). What moved is which
 * figure carries it — from a bare ratio that had no comparable neighbour to a
 * dollar amount that sits directly under the max loss it is measured against.
 *
 * `t` is the hinge, and it is the same arithmetic `desk/optionize.thresholdFor`
 * has always done: the strike written as the percentage move `legState` already
 * understands, **in the leg's own direction**, so a market-priced leg needs no
 * new settlement path. A call struck below spot yields `t < 0`, and `pct >= t`
 * then reads "wins unless the tape falls that far" — which is what an ITM option
 * is. What crosses the seam is the *ratio* and never the price: the seeded tape
 * opens somewhere else entirely.
 *
 * What does not move: `sym`, `dir`, `sector`, `tier`, `baseT`. It is the same
 * bet on the same ticker in the same direction, dealt by the same seed, so
 * `summarize`, `legState`, `scoreOf`, `edgeOf`, `conditionText` and the tape are
 * untouched and unaware.
 *
 * The mode's `targetScale` is deliberately not re-applied. It shrinks a
 * *seeded* target so a shorter window has a reachable line; a listed strike is
 * not ours to shrink, and scaling one would put a number on the card that no
 * venue quotes.
 *
 * Total: a non-positive spot hands the leg straight back, because a leg with a
 * fabricated reference price is worse than a seeded one.
 */
export function legFromLiveCard(leg: ParlayLeg, card: LiveCard, spot: number): ParlayLeg {
  if (!(spot > 0) || !(card.strikeAt > 0)) return leg;
  const move = leg.dir === "over" ? (card.strikeAt - spot) / spot : (spot - card.strikeAt) / spot;
  return {
    ...leg,
    // 2dp, matching `buildLeg`'s own `+(...).toFixed(2)`, so a market-derived
    // `t` and a seeded one are the same kind of number.
    t: +(move * 100).toFixed(2),
    mult: card.odds,
    prob: card.prob,
    px: spot,
    strike: card.strikeAt,
  };
}

/**
 * What the basket actually pays: the **sum** of the leg payoffs, minus the total
 * premium. This is the number that reaches the wallet.
 *
 * The old `summarize` multiplied leg multipliers and called the product a
 * payout. On a basket of real options that is arithmetically false, and the
 * falsehood is not small: three legs at ×3 is ×27 as a product and ×3 as a
 * basket. Options in a basket do not compound each other — each one pays what it
 * pays, and the premium for all of them was paid up front whether they land or
 * not.
 *
 * The premium is subtracted, so a basket where nothing finishes ITM returns
 * exactly `−Σ premium`: the max loss, which is bounded and known before the
 * first signature. That is the whole reason a bought option is a survivable bet
 * and it should be readable straight off this function's output.
 */
export function basketPayoff(
  legs: readonly LiveCard[],
  spotAtSettle: number,
  calculatePayout: PayoutCalculator,
  contractsPerLeg = 1,
): number {
  if (!(spotAtSettle > 0) || !(contractsPerLeg > 0)) return 0;
  const numContracts = toUnits(contractsPerLeg, CONTRACT_DECIMALS);
  const settlementPrice = toUnits(spotAtSettle, PRICE_DECIMALS);

  let gross = 0;
  let premium = 0;
  for (const leg of legs) {
    const type: PayoutSide = leg.stance === "bull" ? "call" : "put";
    const strikes = [toUnits(leg.strikeAt, PRICE_DECIMALS)];
    assertStrikes(type, strikes);
    gross += fromUnits(
      calculatePayout({
        type,
        strikes,
        settlementPrice,
        numContracts,
        priceDecimals: PRICE_DECIMALS,
        sizeDecimals: CONTRACT_DECIMALS,
        collateralDecimals: COLLATERAL_DECIMALS,
      }),
      COLLATERAL_DECIMALS,
    );
    premium += leg.premium * contractsPerLeg;
  }
  return gross - premium;
}

/** The slip's max loss: the premium paid for every leg, and not a cent more.
 *  Bounded and known before the first signature — A7's number. */
export function basketPremium(legs: readonly LiveCard[], contractsPerLeg = 1): number {
  return legs.reduce((acc, l) => acc + l.premium * contractsPerLeg, 0);
}
