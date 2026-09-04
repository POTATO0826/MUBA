/**
 * The duel clock: what a basket of real option positions did, in minutes.
 *
 * Plan 6 §C ("two clocks"). An option expires on a Friday; a duel lasts four
 * minutes. The repo does not pick one of those — it runs both, and they measure
 * different things:
 *
 * | | duel clock (this file) | expiry clock |
 * |---|---|---|
 * | Length | minutes | to expiry |
 * | Scored on | Δ mark price | actual settlement |
 * | Pays | the escrow pot | the option payout |
 * | Winner | better basket return % | whoever holds it |
 * | Authority | the attestor's signature | the OptionBook contract |
 *
 * Nothing here simulates either one. This module is the *first* column and only
 * the first column: it turns two players' filled positions plus **one** set of
 * marks into a comparison. The second column is the chain's business — the
 * player keeps the position they bought regardless of who took the pot, and no
 * line below can affect that.
 *
 * ## Three decisions, and why they are what they are
 *
 * **1. Return on premium, not absolute P&L.**
 *
 *     score = Σ (mark_now − mark_entry) × contracts  ÷  Σ premium_paid
 *
 * A player who got $1.80 of fill and a player who got $0.40 of fill are
 * compared on *skill*, not on size. That is not politeness: the fill ladder in
 * `src/desk/fill.ts` walks 0.01 → 0.10 → 1.00 USDC against whatever a maker's
 * remaining collateral will absorb, so how big a fill anyone got on the round
 * is partly an accident of book depth at that second. Absolute P&L would make
 * the duel a contest in who happened to meet a fatter maker. Dividing by the
 * premium actually paid removes exactly that factor and leaves the thing the
 * player chose: which instrument, and which direction.
 *
 * **2. One set of marks, for both players, passed in.**
 *
 * `duelOutcome(aLegs, bLegs, marks)` takes a single `marks` map and both
 * slates. There is no per-player read here and there is nowhere to put one: the
 * comparison function has one marks parameter, so "read A's marks, then read
 * B's" is not a mistake this API can express. It matters because the live book
 * refreshes on a 15-second TTL — two reads straddling one refresh would let the
 * *order of the reads* decide a duel, and that is indistinguishable from a coin
 * flip with extra steps.
 *
 * **3. Unscoreable is a real answer, and it is NOT zero.**
 *
 * A leg whose instrument is not in the snapshot, a slate with no legs, a basket
 * whose premium sums to zero — none of those is "a score of 0.0". Zero is a
 * *result* (bought it, it went nowhere); unscoreable means the question could
 * not be asked. They are separated because they lead to opposite places: a zero
 * can win a duel, an unscoreable one must sign nothing and let the escrow's
 * six-hour refund return both stakes rake-free. So the score is `NaN` for the
 * second, `duelOutcome` reports it as `noVerdict`, and `scoresTie` refuses to
 * separate anything that is not finite.
 *
 * ## Purity
 *
 * No clock, no network, no import of anything that has either. Every input is
 * an argument; the same arguments always produce the same answer, which is what
 * makes the attestor's verdict reproducible by anyone holding the same
 * committed positions and the same snapshot. `test/determinism.test.ts` globs
 * this directory and forbids a live-data import here — that guard is the reason
 * the marks arrive as a parameter rather than as a fetch.
 */

/**
 * One leg of a slip that was actually filled on chain.
 *
 * Deliberately the *minimum the score needs* and not a receipt: no transaction
 * hash, no maker, no expiry, no strike, no greeks. Everything the duel clock
 * asks of a position is "what is it, how much of it, what did it cost, and what
 * was it worth when you bought it" — four fields — and a fifth field here would
 * be a fifth thing a committed slate could disagree with the chain about.
 *
 * The richer record of a fill lives where it belongs: on chain, and in
 * `src/desk/fill.ts`'s receipt.
 */
export interface FilledLeg {
  /**
   * The book's own name for the instrument, verbatim — the key the marks map is
   * looked up by.
   *
   * It is an opaque string on purpose. The Base book names an order-book
   * instrument one way and a market-maker quote another, and this module must
   * not have an opinion about which namespace a player filled in: it compares
   * the key it was given against the keys the snapshot carries, and a key that
   * is not there is unmarkable rather than guessed at. A near-miss guess is the
   * one failure mode that would pay the wrong player quietly.
   */
  instrument: string;
  /** The mark price per contract at the moment of the fill. The baseline the
   *  duel measures from; not the price paid (that is `premium`, which carries
   *  the spread and the fee). */
  entryMark: number;
  /** Contracts held. Positive — this game only ever buys. */
  contracts: number;
  /** USDC actually paid for those contracts. The denominator, and the reason a
   *  small good basket can beat a large mediocre one. */
  premium: number;
}

/**
 * How many decimals two scores must agree to before the duel is called a tie.
 *
 * Six is plan 6 §C3's number and it is a *rounding* rule rather than an epsilon
 * comparison, because rounding is the rule a human can check by hand off two
 * printed scores. Below this resolution the difference between two baskets is
 * float noise in the last bits of a division, and paying somebody on float
 * noise is worse than not paying anybody.
 */
export const SCORE_DP = 6;

const SCALE = 10 ** SCORE_DP;

/** `x` at `SCORE_DP` decimals. `Math.round` on the scaled value, so the rule is
 *  the one written on the tin and not a formatter's idea of it. */
export function roundScore(x: number): number {
  return Math.round(x * SCALE) / SCALE;
}

/**
 * A leg the score is allowed to use.
 *
 * Every bound is a refusal to invent: a non-finite number cannot be scored, a
 * zero-contract leg is not a position, and a zero-or-negative premium would
 * make the denominator a lie about what was risked. `instrument` must be a
 * non-empty string because "" would silently collide with any other "" in the
 * marks map.
 */
function usable(leg: FilledLeg | null | undefined): leg is FilledLeg {
  return (
    !!leg &&
    typeof leg.instrument === "string" &&
    leg.instrument.length > 0 &&
    Number.isFinite(leg.entryMark) &&
    leg.entryMark >= 0 &&
    Number.isFinite(leg.contracts) &&
    leg.contracts > 0 &&
    Number.isFinite(leg.premium) &&
    leg.premium > 0
  );
}

/** The score, with the working shown — what the attestor needs to say *why* it
 *  refused rather than only that it did. */
export interface ScoreDetail {
  /** `pnl / premium`, or `NaN` when the basket is unscoreable. */
  score: number;
  /** `Σ (mark_now − mark_entry) × contracts`, in the marks' own units. */
  pnl: number;
  /** `Σ premium_paid`. */
  premium: number;
  /**
   * Every leg the snapshot could not mark, or that failed `usable`, named by
   * instrument and in slate order.
   *
   * Non-empty always means `score` is `NaN`. It is reported rather than skipped
   * because a partially marked basket is not a smaller basket — it is a
   * different bet, and scoring one would quietly hand the duel to whichever
   * player's illiquid leg happened to be missing.
   */
  unmarkable: readonly string[];
}

/**
 * One player's basket, marked against `marks`.
 *
 * Exported alongside `duelScore` because a referee that must sign nothing owes
 * an explanation for it, and "reason: unmarkable leg ETH-27SEP-4400-C" is an
 * explanation a player can check against the same public book.
 */
export function scoreDetail(
  legs: readonly FilledLeg[],
  marks: ReadonlyMap<string, number>,
): ScoreDetail {
  const unmarkable: string[] = [];
  let pnl = 0;
  let premium = 0;

  for (const leg of legs ?? []) {
    // Read the name BEFORE the guard: past a failed `usable` the leg is not a
    // `FilledLeg` any more, and a leg too malformed to name still has to be
    // counted or an empty `unmarkable` would read as "all good".
    const named = typeof leg?.instrument === "string" && leg.instrument ? leg.instrument : "?";
    if (!usable(leg)) {
      unmarkable.push(named);
      continue;
    }
    const mark = marks.get(leg.instrument);
    if (mark === undefined || !Number.isFinite(mark) || mark < 0) {
      unmarkable.push(leg.instrument);
      continue;
    }
    pnl += (mark - leg.entryMark) * leg.contracts;
    premium += leg.premium;
  }

  // An empty slate lands here too (`premium === 0`), which is the intended
  // reading: a player who filled nothing has no position, and no position is
  // not a score of zero that could tie or win.
  const scoreable = unmarkable.length === 0 && premium > 0 && Number.isFinite(pnl);
  return { score: scoreable ? pnl / premium : Number.NaN, pnl, premium, unmarkable };
}

/**
 * A player's duel score: return on premium, marked to market.
 *
 *     score = Σ (mark_now − mark_entry) × contracts  ÷  Σ premium_paid
 *
 * Return on premium rather than absolute P&L, so a player who filled $0.40 and
 * a player who filled $1.80 are compared on skill rather than size. Absolute
 * P&L would make the duel a size contest, and the fill ladder in
 * `src/desk/fill.ts` means size is partly an accident of book depth on the
 * round.
 *
 * Marks come from the same snapshot for both players, read once and passed in.
 * Reading them separately per player would let a mid-scoring book refresh
 * decide a duel.
 *
 * Returns `NaN` when the basket cannot be marked — see `ScoreDetail.unmarkable`
 * and note 3 of the module docstring. Callers that move money must test with
 * `Number.isFinite`, or better, use `duelOutcome`, which cannot forget to.
 */
export function duelScore(legs: readonly FilledLeg[], marks: ReadonlyMap<string, number>): number {
  return scoreDetail(legs, marks).score;
}

/**
 * Whether two scores are level at `SCORE_DP` and must therefore not be
 * separated.
 *
 * `true` also for anything non-finite, and that direction is deliberate: the
 * function's job is to answer "may a winner be declared?", and the safe answer
 * to a question containing a `NaN` is no. A version that returned `false` for
 * `NaN` would read as "they differ, so somebody won", which is how an
 * unscoreable duel becomes a wrong payout.
 */
export function scoresTie(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return roundScore(a) === roundScore(b);
}

/** The comparison a referee signs on — or declines to. */
export interface DuelOutcome {
  aScore: number;
  bScore: number;
  aDetail: ScoreDetail;
  bDetail: ScoreDetail;
  /**
   * True when nothing may be signed: a tie to `SCORE_DP`, or either basket
   * unscoreable. Plan 6 §C3 — the escrow's unconditional six-hour refund
   * returns both stakes rake-free, and that is a better answer than a coin
   * flip. There is deliberately NO tiebreak here.
   */
  noVerdict: boolean;
  /** Meaningful only when `noVerdict` is false. */
  aWins: boolean;
}

/**
 * Score both players against ONE snapshot and say who won — or that nobody did.
 *
 * This signature is the enforcement of module note 2. There is one `marks`
 * argument for two slates, so both players are necessarily scored against the
 * same numbers; a caller cannot pass A's book and B's book because there is no
 * parameter for a second one. That is a structural guarantee rather than a
 * documented convention, which is the difference between a rule and a hope.
 *
 * The order of the arguments is the escrow's order — `a` is the seat that
 * opened the duel, `b` the seat that joined — so `aWins` maps onto a payee
 * without anybody having to remember a convention.
 */
export function duelOutcome(
  aLegs: readonly FilledLeg[],
  bLegs: readonly FilledLeg[],
  marks: ReadonlyMap<string, number>,
): DuelOutcome {
  const aDetail = scoreDetail(aLegs, marks);
  const bDetail = scoreDetail(bLegs, marks);
  const noVerdict = scoresTie(aDetail.score, bDetail.score);
  return {
    aScore: aDetail.score,
    bScore: bDetail.score,
    aDetail,
    bDetail,
    noVerdict,
    // Compared at full precision, having already established the two are not
    // level at SCORE_DP. Rounding first and comparing the rounded values would
    // be the same answer here and one more place for a rounding rule to live.
    aWins: !noVerdict && aDetail.score > bDetail.score,
  };
}
