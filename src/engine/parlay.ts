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
 *    its premium is what a buyer pays, and its multiple comes from the
 *    protocol's own payout math. When nothing in the book falls in a tier's
 *    band, that card is **not dealt** — see `cardsForSlice` step 6.
 *  - **The seeded path** (`buildLeg`, `legForCard`, `summarize`) still deals a
 *    replayable tape game offline. It reads its probability out of
 *    `TIER_BANDS` and prices it at fair odds, so the two paths cannot drift:
 *    there is exactly one place in the tree that says what `SHARP` means.
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
 * The fair price of a tier: `1 / probability`.
 *
 * No house edge, no invented ladder. If a thing lands 35% of the time then even
 * money on it is ×2.857, and that is the number the seeded card prints. The old
 * table said `SHARP: ×3.6, 25%` — a 44% overround dressed as generosity, on a
 * game where nothing was ever paid.
 */
export function tierOdds(tier: Tier): number {
  return 1 / tierProb(tier);
}

/** Below this implied probability the card goes loud. */
export const LOUD_BELOW = 0.1;

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
  /** Fair odds on `prob`. Never a table lookup. */
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
  /** True when `prob` is below `LOUD_BELOW`. */
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
  return { mult, prob, potentialPoints: Math.round(stakePoints * mult), loud: prob < LOUD_BELOW };
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
  /** Payout multiple if the option finishes at the reference move.
   *  Derived on every build, never persisted — see `multipleAt`. */
  mult: number;
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

    const draft: LiveCard = {
      ...card,
      underlying: slice.underlying,
      strike: best.row.strike,
      strikeAt: fromUnits(best.strike, PRICE_DECIMALS),
      expiry: best.row.expiry,
      expiryAt: best.expiry,
      prob: Math.abs(best.delta),
      premium: best.ask,
      mult: 0,
      mark: parseNum(best.row.mark),
      row: best.row,
    };
    return { ...draft, mult: multipleAt(draft, deps.spot, movePct, deps.calculatePayout) };
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
