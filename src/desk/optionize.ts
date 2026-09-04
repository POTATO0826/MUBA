import { TIERS, type ParlayLeg, type Stance, type Tier } from "../engine/parlay.ts";
import type { PricingRow } from "../types.ts";

/**
 * The duel, denominated in real options.
 *
 * ## The insight
 *
 * The game already has the shape of an option chain and did not know it. A
 * parlay card is a tier (`SAFE ~70% / EVEN ~50% / SHARP ~25% / DEGEN ~8%`)
 * crossed with a stance, and it renders as `above 252.95 · ~70%`. That number
 * *is* a strike and that percentage *is* a probability of finishing in the
 * money. What was fake was only their provenance: both came out of the fixed
 * `TIERS` table multiplied against an asset's seeded base move.
 *
 * This module reads them off the live book instead:
 *
 *  - the **strike** is a strike the venue actually lists;
 *  - the **probability** is the option's own delta, which is to a very good
 *    first approximation the market's probability that it finishes ITM;
 *  - the **multiplier** is derived from the real premium and the option's real
 *    payoff profile (`multiplierFor` below), never from `TIERS`.
 *
 * And then nothing else changes. `thresholdFor` expresses the listed strike as
 * the percentage move from spot that `legState` has always understood, so a
 * market-priced leg is a `ParlayLeg` like any other and settles through the
 * identical code path. **The tape still decides; the strike just stops being
 * invented.**
 *
 * ## What this module is not
 *
 * Pure. It fetches nothing, holds no state, renders nothing and touches no
 * chain. Rows arrive as arguments — `PricingRow[]` off a `MarketSource` — which
 * is what lets `src/state/match.ts` freeze a book at deal time and thread the
 * frozen data in without ever naming a live-market module (the source scan in
 * `test/determinism.test.ts` stays green by construction).
 *
 * It also never signs, approves, previews or fills. A market-priced leg is a
 * *quote read off a book*, not a position. `SETTLEMENT_NOTE` is the sentence the
 * player is shown so that distinction is never left to be inferred.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every constant here is a stated convention, not a market datum
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How far past the strike the payoff is read, as a fraction of the strike.
 *
 * A long call's payoff is unbounded, so "max payout over premium" needs a
 * reference terminal price or it is not a number. 25% is not arbitrary: it is
 * the same ±25% band the venue itself publishes strikes in (`MM_STRIKE_BAND`,
 * server side), so reading the payoff one band beyond the strike is reading it
 * at the edge of the range the book actually quotes rather than extrapolating
 * past its own data.
 */
export const PAYOFF_REFERENCE_MOVE = 0.25;

/**
 * The band a derived multiplier is clamped into.
 *
 * The floor exists because a leg that pays less than about even money is not a
 * bet anyone is offered on this screen. The ceiling exists because the book is
 * thin and intermittent: one stub ask of `0.0001` on a far wing would otherwise
 * print `×2,700` off a quote nobody would trade, and a clamp is the difference
 * between a market-derived number and a market-derived accident.
 */
export const MULT_MIN = 1.05;
export const MULT_MAX = 25;

/**
 * How far the nearest listed delta may sit from the tier's implied probability
 * before the card says so out loud.
 *
 * The book lists the strikes it lists. On a thin chain the nearest thing to
 * SHARP's `~25%` can genuinely be a `0.41` delta, and a card that printed
 * `~25%` over a `0.41` option would be the exact lie this whole module exists
 * to remove. The card always prints the *real* delta; `offTarget` is what makes
 * it additionally say that the tier's target was missed.
 */
export const PROB_TOLERANCE = 0.08;

/** The surface chip. Rendered wherever market-priced cards are on screen. */
export const OPTIONS_CHIP = "REAL STRIKES · SIMULATED SETTLEMENT";

/**
 * The sentence a player must see, verbatim.
 *
 * Everything above is real: a listed strike, a published delta, a published
 * premium. The settlement is not. The duel resolves on the seeded eight-second
 * tape at the mode's settle print — not at the option's expiry, not against the
 * venue, and not against anyone's balance. Nobody holds a position, nothing is
 * approved and nothing is spent.
 */
export const SETTLEMENT_NOTE =
  "Real strike, real market odds, simulated settlement. These lines are read off the " +
  "live Thetanuts book on Base; the duel still resolves on the seeded tape, not at the " +
  "option's expiry. You are not holding a position and nothing here is spent.";

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

export type OptionSide = "CALL" | "PUT";

/** One listed option, picked to stand for one tier on one ticker. */
export interface OptionQuote {
  /** Board symbol the chain was read for — `"ETH"`, `"BTC"`. */
  ticker: string;
  side: OptionSide;
  /** The listed strike, on the live scale. */
  strike: number;
  /** Delta as the book published it — negative for a put. */
  delta: number;
  /** `|delta|`: the market's probability this finishes in the money. */
  impliedProb: number;
  /** What a buyer pays, per contract, as the venue quotes it. */
  premium: number;
  /** Derived — see `multiplierFor`. Never `TIERS`. */
  multiplier: number;
  /** `"12 SEP"`, as the row carries it. */
  expiry: string;
  /** The tier this quote was chosen to stand for. */
  tier: Tier;
  /** True when `impliedProb` misses the tier's target by more than
   *  `PROB_TOLERANCE` — a thin book, said out loud rather than papered over. */
  offTarget: boolean;
  /** The live spot the chain was read against. `thresholdFor` needs exactly
   *  this number, so it travels with the quote rather than beside it. */
  spot: number;
  /** `"ETH 2600 CALL · Δ0.28 · exp 12 SEP"` — the provenance line, rendered
   *  verbatim beside the tier name. */
  label: string;
}

/**
 * One frozen moment of the book: what a match is dealt against.
 *
 * Plain data, deliberately — no accessors, no source object, nothing that could
 * reach a network. `src/state/match.ts` captures one of these when a match is
 * dealt and holds it for the life of the match, so the numbers on the cards
 * cannot move under a player mid-pick. A quote is a moment, which is also how
 * real trading works.
 */
export interface OptionBook {
  /** When the snapshot behind this was built, ms. */
  at: number;
  source: "live" | "stale";
  /** Live USD spot, per underlying that has a chain. */
  spot: Readonly<Record<string, number>>;
  /** The chain, per underlying. Only ETH and BTC ever have one. */
  chain: Readonly<Record<string, readonly PricingRow[]>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `"4,000"` → `4000`. `null` for a range (`"2,100–2,600"`), which is what a
 * multi-strike level prints and which has no single line to bet against.
 */
function parseStrike(s: string): number | null {
  if (s.includes("–") || s.includes("-") || /k$/i.test(s.trim())) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * `"−0.34"` → `-0.34`, `"—"` → `null`.
 *
 * Both minus signs, on purpose: the seeded table writes a typographic minus
 * (U+2212) and the live builder writes `toFixed(2)`'s ASCII hyphen. Reading one
 * of the two would silently drop every put on one side of the seam — the same
 * trap `parseDelta` in `src/data/spot.ts` documents.
 */
function parseDelta(s: string): number | null {
  const n = Number(String(s).replace("−", "-"));
  return Number.isFinite(n) ? n : null;
}

function parsePrice(s: string | undefined): number | null {
  if (s === undefined) return null;
  const n = Number(String(s).replace("−", "-"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One eligible row, decoded. `null` means "this row cannot stand for a leg". */
interface Candidate {
  strike: number;
  delta: number;
  premium: number;
  expiry: string;
}

/**
 * A row, if it is a plain vanilla on the wanted side.
 *
 * Two filters, and the second is the one that matters. `type` is the coarse
 * three-member bucket `/desk` colours by, and a two- or three-strike level also
 * carries `type: "CALL"` while printing only its *first* strike — so type alone
 * would let a call spread through as if it were a call, and price a leg off a
 * premium that buys a completely different payoff.
 *
 * `structure` closes that, and it is consulted only where it is reliable.
 * `docs/reviews/mcp-crosscheck.md` §BUG-2 established that the four-strike names
 * (`CONDOR` / `RANGER`) cannot be told apart by counting — so this function
 * never relies on them. It requires `structure` to be *absent* (the seeded
 * table, which predates the field) or to equal the vanilla side, which is the
 * one/two/three-strike part of the classification the SDK's own `Order.strikes`
 * doc comment makes safe. Everything else — SPREAD, FLY, CONDOR, RANGER,
 * UNKNOWN — is refused rather than guessed at.
 */
function candidate(row: PricingRow, want: OptionSide): Candidate | null {
  if (row.type !== want) return null;
  if (row.structure !== undefined && row.structure !== want) return null;

  const strike = parseStrike(row.strike);
  if (strike === null) return null;

  const delta = parseDelta(row.delta);
  // A delta of exactly 0 or ±1 carries no probability worth quoting, and an
  // unscoreable row (`rawApiData.greeks` is undocumented and genuinely absent
  // sometimes) is simply not a candidate.
  if (delta === null || Math.abs(delta) <= 0 || Math.abs(delta) >= 1) return null;

  // What a buyer pays. The ask is the honest cost of the position; `mid` and
  // `bid` are the fallbacks for a one-sided level, in that order, and a level
  // with no usable price at all is not quotable.
  const premium = parsePrice(row.ask) ?? parsePrice(row.mid) ?? parsePrice(row.bid);
  if (premium === null) return null;

  return { strike, delta, premium, expiry: row.expiry };
}

// ─────────────────────────────────────────────────────────────────────────────
// The multiplier — derived, bounded, and stated
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The payout multiplier this option implies, from its own premium and payoff.
 *
 * ## The formula
 *
 *     reference terminal price   R = K × (1 ± PAYOFF_REFERENCE_MOVE)
 *     payoff at R, in units of one unit of the underlying at today's spot:
 *                                P = |R − K| / S = PAYOFF_REFERENCE_MOVE × K / S
 *     multiplier                 M = clamp(P / premium, MULT_MIN, MULT_MAX)
 *
 * In words: *what this option pays if the underlying travels one published band
 * beyond your strike, divided by what the market charges you for it.* Both
 * halves are expressed the same way — as a fraction of one unit of the
 * underlying — which is the convention the venue quotes premia in (an ETH call
 * at `0.0489` costs 0.0489 ETH per contract), so the ratio is dimensionless.
 *
 * ## Assumptions, all of them
 *
 *  - **Fees, funding, slippage and the exit spread are ignored.** The ask is
 *    taken as the cost and nothing is added to it or removed from it. A real
 *    round trip would cost more than this number implies.
 *  - **The horizon is not the duel's.** This is the payoff profile *at the
 *    option's expiry*, used as the shape of the bet. The duel settles on an
 *    eight-second seeded tape. That mismatch is not hidden — it is the whole of
 *    `SETTLEMENT_NOTE`.
 *  - **`PAYOFF_REFERENCE_MOVE` is a convention**, not something the market said.
 *    Change it and every multiplier scales; it is stated here and on the card
 *    rather than buried.
 *  - **Contract multiplier is assumed 1.** If the venue ever quoted per a
 *    different notional, this ratio would be off by that constant factor —
 *    which is one of the two reasons the result is clamped.
 *  - **The clamp is load-bearing.** Book depth on Base has swung several-fold
 *    inside a day; a stale stub ask on a far wing is an ordinary reading, and
 *    `MULT_MAX` is what stops one printing an absurd payout.
 */
export function multiplierFor(strike: number, premium: number, spot: number): number {
  if (!(spot > 0) || !(premium > 0) || !(strike > 0)) return MULT_MIN;
  const payoff = PAYOFF_REFERENCE_MOVE * (strike / spot);
  const raw = payoff / premium;
  if (!Number.isFinite(raw)) return MULT_MIN;
  return +Math.min(MULT_MAX, Math.max(MULT_MIN, raw)).toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// Picking the strike
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The listed option that stands for one tier on one ticker, or `null`.
 *
 * **`null` is the ordinary case.** Fourteen of the eighteen board assets have no
 * Thetanuts presence at all and never will; of the four that do, only ETH and
 * BTC have an options book. A ticker with no book keeps its seeded card,
 * labelled seeded, and nothing about that path is an error.
 *
 * The pick is *nearest listed delta to the tier's implied probability*, on the
 * side the stance asks for — a call for a bull, a put for a bear. The tier's
 * target is read straight out of `TIERS[tier].prob`, so this file states no
 * probability of its own and cannot drift from the game's ladder.
 *
 * Ties break to **chain order**, which the live builder sorts nearest-expiry
 * first and then by strike: two strikes equidistant from the target resolve to
 * the nearer expiry, then the lower strike, deterministically, on every machine.
 */
export function optionizeTier(
  tier: Tier,
  stance: Stance,
  chain: readonly PricingRow[],
  spot: number,
  ticker = "",
): OptionQuote | null {
  if (!Number.isFinite(spot) || spot <= 0) return null;

  const target = TIERS[tier].prob;
  const side: OptionSide = stance === "bull" ? "CALL" : "PUT";

  let best: Candidate | null = null;
  let bestGap = Infinity;
  for (const row of chain) {
    const c = candidate(row, side);
    if (c === null) continue;
    const gap = Math.abs(Math.abs(c.delta) - target);
    // Strictly less than: the first row of a tie wins, and chain order is the
    // tie-break rather than whichever row the loop happened to reach last.
    if (gap < bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  if (best === null) return null;

  const impliedProb = Math.abs(best.delta);
  const multiplier = multiplierFor(best.strike, best.premium, spot);
  const label =
    `${ticker || side} ${fmtStrike(best.strike)} ${side} · Δ${impliedProb.toFixed(2)} · ` +
    `exp ${best.expiry}`;

  return {
    ticker,
    side,
    strike: best.strike,
    delta: best.delta,
    impliedProb,
    premium: best.premium,
    multiplier,
    expiry: best.expiry,
    tier,
    offTarget: bestGap > PROB_TOLERANCE,
    spot,
    label,
  };
}

/** `2600` → `"2,600"`, `1.45` → `"1.45"`. The label's own formatting, kept
 *  local so the engine's `fmtPx` (which rounds hard above 1,000) is not asked
 *  to do a job it was written for a scrolling tape. */
function fmtStrike(v: number): string {
  if (v < 1) return v.toFixed(4);
  if (v < 1000) return v.toFixed(2);
  return Math.round(v).toLocaleString("en-US");
}

/**
 * The quote for one card of one ticker, off a frozen book, or `null`.
 *
 * The single accessor the views and the match state use, so "does this ticker
 * have a book" is decided in one place: no book at all, no live spot for this
 * symbol, no chain for this symbol, or no eligible row on the wanted side all
 * answer the same `null`.
 */
export function quoteFor(
  book: OptionBook | null | undefined,
  sym: string,
  tier: Tier,
  stance: Stance,
): OptionQuote | null {
  if (!book) return null;
  const u = sym.trim().toUpperCase();
  const spot = book.spot[u];
  const chain = book.chain[u];
  if (typeof spot !== "number" || !Number.isFinite(spot) || spot <= 0) return null;
  if (!chain || chain.length === 0) return null;
  return optionizeTier(tier, stance, chain, spot, u);
}

/** Whether a ticker has a book on this snapshot at all — what the LIVE/SEEDED
 *  chip on a ticker header reads. Deliberately independent of whether any
 *  particular tier found a strike: a chain with rows is a live chain even if
 *  one wing of it is unquotable. */
export function hasBook(book: OptionBook | null | undefined, sym: string): boolean {
  if (!book) return false;
  const u = sym.trim().toUpperCase();
  const spot = book.spot[u];
  return (
    typeof spot === "number" &&
    Number.isFinite(spot) &&
    spot > 0 &&
    (book.chain[u]?.length ?? 0) > 0
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The hinge: a strike, expressed in the units the tape already settles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The listed strike as the percentage move `legState` understands.
 *
 * **This is the whole design in one function.** `legState` decides a leg on
 * `{sym, dir, t}` and nothing else: an `over` leg wins when the tape's move from
 * its open is `>= t`, an `under` leg when it is `<= -t`. So a market-priced leg
 * does not need a new settlement path, a new outcome type or a branch anywhere
 * in the engine — it needs its strike written as a `t`, and then it is a leg.
 *
 * The number returned is the move **in the leg's own direction** required to
 * reach the strike, which is why it is signed:
 *
 *  - a call struck above spot gives `t > 0` — the tape must rise to it;
 *  - a call struck *below* spot (an ITM call, which is exactly what a `~0.70`
 *    delta SAFE tier picks) gives `t < 0`, and `pct >= t` then reads "wins
 *    unless the tape falls further than that". Which is what an in-the-money
 *    option is.
 *
 * Both fall out of the comparison already in `legState`; neither needed a line
 * of engine code.
 *
 * `spot` must be the live spot the chain was quoted against — the strike is on
 * the live scale and the seeded tape opens somewhere else entirely, so what
 * crosses the seam is the *ratio*, never the price. (Same reasoning as
 * `bookDelta`'s moneyness argument in `src/data/spot.ts`.) The quote carries
 * that spot for exactly this reason, and `optionize` below passes `quote.spot`.
 *
 * Rounded to 2dp, matching `buildLeg`'s own `+(...).toFixed(2)`, so a
 * market-derived `t` and a seeded one are the same kind of number.
 */
export function thresholdFor(quote: OptionQuote, spot: number): number {
  // Unreachable through `optionizeTier`, which refuses a non-positive spot
  // before it ever builds a quote. `0` rather than a throw: a leg with a zero
  // threshold is a coin flip on the tape's sign, which is a survivable answer,
  // and a pure function inside a render is the wrong place to throw.
  if (!Number.isFinite(spot) || spot <= 0) return 0;
  const move = quote.side === "CALL" ? (quote.strike - spot) / spot : (spot - quote.strike) / spot;
  return +(move * 100).toFixed(2);
}

/**
 * One leg, re-denominated in the option that stands for it.
 *
 * A total function, and that is the point: with no book, no chain, or no
 * eligible strike it returns the leg it was handed, **by identity**. Flag off is
 * therefore not a branch anyone has to remember to write — it is the absence of
 * an argument, and today's app falls out of it byte for byte.
 *
 * What changes when a quote is found: `t` (the strike, in the tape's units),
 * `mult` (derived from the premium), `prob` (the book's delta), `px` (the live
 * spot the strike is on) and `strike` itself. What does not: `sym`, `dir`,
 * `sector`, `tier`, `baseT` — the leg is the same bet on the same ticker in the
 * same direction, dealt by the same seed. `summarize`, `legState`, `scoreOf`,
 * `edgeOf`, `conditionText` and the tape are untouched and unaware.
 */
export function optionize(leg: ParlayLeg, book: OptionBook | null | undefined): ParlayLeg {
  const quote = quoteFor(book, leg.sym, leg.tier, leg.dir === "over" ? "bull" : "bear");
  if (quote === null) return leg;
  return {
    ...leg,
    t: thresholdFor(quote, quote.spot),
    mult: quote.multiplier,
    prob: quote.impliedProb,
    px: quote.spot,
    strike: quote.strike,
  };
}
