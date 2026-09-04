/**
 * The duel clock, on a frozen fixture.
 *
 * `src/engine/score.ts` is the half of plan 6 §C that decides who won, and it is
 * pure: legs in, one marks map in, a number out. Every arithmetic assertion
 * below is hand-computed in the comment above it, in the plan's own notation —
 *
 *     score = Σ (mark_now − mark_entry) × contracts  ÷  Σ premium_paid
 *
 * — because a test that only checks the code against itself would pass just as
 * happily on the wrong formula. The numbers are eighths and quarters on purpose:
 * every intermediate below is exactly representable as a double, so a failure is
 * a real disagreement about the formula and never a float artefact. (The one
 * place float noise is the subject — the 6dp tie rule — says so out loud.)
 *
 * Three properties carry more weight than the arithmetic:
 *
 *   1. **Return on premium, not absolute P&L.** A smaller, better basket beats a
 *      larger, worse one. That is the whole reason for the division: the fill
 *      ladder in `src/desk/fill.ts` walks 0.01 → 0.10 → 1.00 USDC against
 *      whatever collateral a maker has left, so *size* is partly an accident of
 *      book depth at that second and must not be what the duel measures.
 *
 *   2. **One snapshot serves both players, structurally.** `duelOutcome` has one
 *      `marks` parameter for two slates. "Read A's book, then read B's" is not a
 *      mistake this API can express, which matters because the live book
 *      refreshes on a 15-second TTL and two reads straddling one refresh would
 *      let the *order of the reads* decide a duel.
 *
 *   3. **Unscoreable is not zero.** A zero can win a duel; an unscoreable basket
 *      must sign nothing so the escrow's six-hour refund returns both stakes
 *      rake-free. They are different answers and the tests keep them apart.
 *
 * There is deliberately NO tiebreak anywhere in this file, and the last section
 * asserts that absence rather than assuming it.
 */

import { describe, expect, test } from "bun:test";
import {
  SCORE_DP,
  duelOutcome,
  duelScore,
  roundScore,
  scoreDetail,
  scoresTie,
  type FilledLeg,
} from "../src/engine/score.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

/** A leg, spelled out. Every test builds its legs through this so a field can
 *  never be silently omitted and defaulted into the arithmetic. */
const leg = (instrument: string, entryMark: number, contracts: number, premium: number): FilledLeg => ({
  instrument,
  entryMark,
  contracts,
  premium,
});

const marksOf = (entries: Record<string, number>): ReadonlyMap<string, number> =>
  new Map(Object.entries(entries));

/**
 * THE FIXTURE. One frozen book, four instruments, and it is the same map for
 * every player in every test below — which is the point of the module.
 *
 * Two of the four moved up, one moved down, one is flat. Nothing here is a
 * market opinion; they are the four signs the formula has to get right.
 */
const BOOK = marksOf({
  "ETH-27SEP26-4400-C": 0.5, //  up from 0.25
  "BTC-27SEP26-70000-P": 2.25, // up from 2.0
  "SOL-27SEP26-200-C": 1.5, //   down from 2.0
  "AVAX-27SEP26-30-C": 0.75, //  flat
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the formula, hand-computed", () => {
  test("one leg: (0.5 − 0.25) × 2 ÷ 0.5 = 1.0", () => {
    //   pnl     = (0.50 − 0.25) × 2 = 0.50
    //   premium = 0.50
    //   score   = 0.50 ÷ 0.50       = 1.0
    const legs = [leg("ETH-27SEP26-4400-C", 0.25, 2, 0.5)];
    expect(duelScore(legs, BOOK)).toBe(1);

    const d = scoreDetail(legs, BOOK);
    expect(d.pnl).toBe(0.5);
    expect(d.premium).toBe(0.5);
    expect(d.unmarkable).toEqual([]);
  });

  test("two legs, both up: (1.0 + 0.5) ÷ 5.0 = 0.3", () => {
    //   ETH: (0.50 − 0.25) × 4 = +1.00   premium 1.00
    //   BTC: (2.25 − 2.00) × 2 = +0.50   premium 4.00
    //   pnl 1.50 ÷ premium 5.00 = 0.30
    const legs = [
      leg("ETH-27SEP26-4400-C", 0.25, 4, 1),
      leg("BTC-27SEP26-70000-P", 2, 2, 4),
    ];
    const d = scoreDetail(legs, BOOK);
    expect(d.pnl).toBe(1.5);
    expect(d.premium).toBe(5);
    expect(d.score).toBe(0.3);
  });

  test("a losing leg is negative, and the score can be too", () => {
    //   SOL: (1.50 − 2.00) × 2 = −1.00   premium 3.00
    //   score = −1.00 ÷ 3.00 = −0.333…
    const legs = [leg("SOL-27SEP26-200-C", 2, 2, 3)];
    expect(duelScore(legs, BOOK)).toBeCloseTo(-1 / 3, 12);
    expect(duelScore(legs, BOOK)).toBeLessThan(0);
  });

  test("a mixed basket nets, it does not take the best leg", () => {
    //   ETH: (0.50 − 0.25) × 4 = +1.00   premium 1.00
    //   SOL: (1.50 − 2.00) × 2 = −1.00   premium 4.00
    //   pnl 0.00 ÷ premium 5.00 = 0.0 — a real result, not "unscoreable"
    const legs = [
      leg("ETH-27SEP26-4400-C", 0.25, 4, 1),
      leg("SOL-27SEP26-200-C", 2, 2, 4),
    ];
    const d = scoreDetail(legs, BOOK);
    expect(d.pnl).toBe(0);
    expect(d.score).toBe(0);
    expect(Number.isFinite(d.score)).toBe(true);
  });

  test("a flat leg scores exactly zero and still counts its premium", () => {
    //   AVAX: (0.75 − 0.75) × 8 = 0.00   premium 6.00 → 0 ÷ 6 = 0
    const legs = [leg("AVAX-27SEP26-30-C", 0.75, 8, 6)];
    const d = scoreDetail(legs, BOOK);
    expect(d.score).toBe(0);
    expect(d.premium).toBe(6);
  });

  test("the entry MARK is the baseline, not the premium paid", () => {
    // The two are different on purpose: `premium` carries the spread and the
    // fee, `entryMark` is what the book said the thing was worth. Scoring the
    // move from the price *paid* would charge every player the spread twice —
    // once in the numerator and again in the denominator.
    const cheap = [leg("ETH-27SEP26-4400-C", 0.25, 4, 1)];
    const same = [leg("ETH-27SEP26-4400-C", 0.25, 4, 2)];
    // Identical numerator (mark move × contracts), different denominator.
    expect(scoreDetail(cheap, BOOK).pnl).toBe(scoreDetail(same, BOOK).pnl);
    expect(duelScore(cheap, BOOK)).toBe(1);
    expect(duelScore(same, BOOK)).toBe(0.5);
  });
});

describe("return on premium, not absolute P&L", () => {
  /**
   * The plan's own example, in numbers: a $0.40-ish fill against a $1.80-ish
   * one. B makes three times A's money and loses the duel, because B risked six
   * times as much to do it.
   *
   *   A  ETH  (0.50 − 0.25) × 2 = +0.50 on premium 0.50  →  score 1.00
   *   B  BTC  (2.25 − 2.00) × 6 = +1.50 on premium 3.00  →  score 0.50
   */
  const SMALL_AND_GOOD = [leg("ETH-27SEP26-4400-C", 0.25, 2, 0.5)];
  const BIG_AND_MEDIOCRE = [leg("BTC-27SEP26-70000-P", 2, 6, 3)];

  test("the bigger basket genuinely makes more money", () => {
    // Stated first so the next assertion cannot be read as an accident: on
    // absolute P&L — the metric this module deliberately does NOT use — B wins.
    expect(scoreDetail(BIG_AND_MEDIOCRE, BOOK).pnl).toBe(1.5);
    expect(scoreDetail(SMALL_AND_GOOD, BOOK).pnl).toBe(0.5);
    expect(scoreDetail(BIG_AND_MEDIOCRE, BOOK).pnl).toBeGreaterThan(
      scoreDetail(SMALL_AND_GOOD, BOOK).pnl,
    );
  });

  test("and loses the duel anyway", () => {
    expect(duelScore(SMALL_AND_GOOD, BOOK)).toBe(1);
    expect(duelScore(BIG_AND_MEDIOCRE, BOOK)).toBe(0.5);

    const out = duelOutcome(SMALL_AND_GOOD, BIG_AND_MEDIOCRE, BOOK);
    expect(out.noVerdict).toBe(false);
    expect(out.aWins).toBe(true);
  });

  test("size is invisible: scaling a basket cannot move its score", () => {
    // This is the property the division buys. The fill ladder decides how big a
    // fill anyone got; the player decided what to buy. Doubling everything the
    // ladder controls — contracts and the premium they cost — changes nothing.
    const base = [
      leg("ETH-27SEP26-4400-C", 0.25, 4, 1),
      leg("BTC-27SEP26-70000-P", 2, 2, 4),
    ];
    for (const k of [0.5, 2, 10, 1000]) {
      const scaled = base.map((l) => leg(l.instrument, l.entryMark, l.contracts * k, l.premium * k));
      expect(roundScore(duelScore(scaled, BOOK))).toBe(roundScore(duelScore(base, BOOK)));
    }
  });

  test("a basket that got a worse price on the same view scores worse", () => {
    // Two players who bought the same instrument in the same direction, one of
    // whom paid more for it. Same P&L per contract, different return. That is
    // skill the metric is *supposed* to see, unlike size.
    const paidLess = [leg("ETH-27SEP26-4400-C", 0.25, 4, 1)];
    const paidMore = [leg("ETH-27SEP26-4400-C", 0.25, 4, 4)];
    expect(duelScore(paidLess, BOOK)).toBeGreaterThan(duelScore(paidMore, BOOK));
  });
});

describe("one snapshot, both players — the signature is the enforcement", () => {
  test("duelOutcome takes exactly three arguments, and only one of them is a book", () => {
    // Arity is the assertion. There is no fourth parameter for a second marks
    // map, so a caller cannot score A on one book and B on another even by
    // mistake — the API has nowhere to put the second read.
    expect(duelOutcome.length).toBe(3);
    expect(duelScore.length).toBe(2);
  });

  test("a mid-scoring book refresh would flip the winner — and cannot be expressed", () => {
    // The failure this design exists to prevent, made concrete. A's basket looks
    // better on the earlier book, B's on the later one. If the attestor read the
    // book once per player, whichever player was scored after the 15-second TTL
    // rolled would win — the duel would be decided by read order.
    const before = marksOf({ "X-C": 1.5, "Y-C": 1 });
    const after = marksOf({ "X-C": 1, "Y-C": 1.5 });
    const aLegs = [leg("X-C", 1, 1, 1)];
    const bLegs = [leg("Y-C", 1, 1, 1)];

    // Scored on ONE book, the answer is a fact about the book, not about order.
    expect(duelOutcome(aLegs, bLegs, before).aWins).toBe(true);
    expect(duelOutcome(aLegs, bLegs, after).aWins).toBe(false);

    // And on either single book, both slates saw the same numbers: swapping the
    // seats swaps the answer exactly, which a per-player read would not do.
    expect(duelOutcome(bLegs, aLegs, before).aWins).toBe(false);
    expect(duelOutcome(bLegs, aLegs, after).aWins).toBe(true);
  });

  test("the same map object reaches both slates — scoring reads it, never rebuilds it", () => {
    // A `Map` subclass that counts lookups: both players' legs are looked up in
    // the ONE instance the caller passed, so there is no second source that
    // could have drifted.
    const seen: string[] = [];
    class Watched extends Map<string, number> {
      override get(k: string): number | undefined {
        seen.push(k);
        return super.get(k);
      }
    }
    const watched = new Watched(BOOK);
    duelOutcome(
      [leg("ETH-27SEP26-4400-C", 0.25, 2, 0.5)],
      [leg("BTC-27SEP26-70000-P", 2, 2, 4)],
      watched,
    );
    expect(seen).toEqual(["ETH-27SEP26-4400-C", "BTC-27SEP26-70000-P"]);
  });

  test("scoring mutates neither the book nor the slates", () => {
    // Purity, asserted rather than asserted-in-prose: a scoring pass that
    // touched the marks map would make the SECOND player's read different from
    // the first, which is the same bug wearing a different hat.
    const legsA = [leg("ETH-27SEP26-4400-C", 0.25, 2, 0.5)];
    const legsB = [leg("SOL-27SEP26-200-C", 2, 2, 3)];
    const snapshotA = JSON.stringify(legsA);
    const snapshotB = JSON.stringify(legsB);
    const book = new Map(BOOK);

    const first = duelOutcome(legsA, legsB, book);
    const second = duelOutcome(legsA, legsB, book);

    expect(book).toEqual(new Map(BOOK));
    expect(JSON.stringify(legsA)).toBe(snapshotA);
    expect(JSON.stringify(legsB)).toBe(snapshotB);
    // Same inputs, same answer, every time — what makes the verdict
    // reproducible by anyone holding the commit and the snapshot.
    expect(second).toEqual(first);
  });

  test("leg order cannot change a score — the score is a sum", () => {
    const legs = [
      leg("ETH-27SEP26-4400-C", 0.25, 4, 1),
      leg("BTC-27SEP26-70000-P", 2, 2, 4),
      leg("AVAX-27SEP26-30-C", 0.75, 8, 6),
    ];
    const reversed = [...legs].reverse();
    expect(duelScore(reversed, BOOK)).toBe(duelScore(legs, BOOK));
  });
});

describe("unscoreable is a real answer, and it is not zero", () => {
  test("a leg the book cannot mark makes the whole basket NaN, and names it", () => {
    const legs = [
      leg("ETH-27SEP26-4400-C", 0.25, 4, 1),
      leg("DOGE-27SEP26-1-C", 0.1, 4, 1), // not in BOOK
    ];
    const d = scoreDetail(legs, BOOK);
    expect(d.unmarkable).toEqual(["DOGE-27SEP26-1-C"]);
    expect(Number.isNaN(d.score)).toBe(true);
    expect(Number.isNaN(duelScore(legs, BOOK))).toBe(true);
  });

  test("a partially marked basket is NOT scored on the legs that did mark", () => {
    // The tempting bug: drop the unmarkable leg and score the rest. That is a
    // different bet, and it would hand the duel to whichever player's illiquid
    // leg happened to be the missing one — here, the player whose losing leg
    // vanished.
    const withLoser = [
      leg("ETH-27SEP26-4400-C", 0.25, 4, 1), // +1.00
      leg("SOL-27SEP26-200-C", 2, 2, 4), //     −1.00
    ];
    const loserUnquoted = [
      leg("ETH-27SEP26-4400-C", 0.25, 4, 1),
      leg("SOL-99SEP26-200-C", 2, 2, 4), //     not in BOOK
    ];
    expect(duelScore(withLoser, BOOK)).toBe(0);
    expect(Number.isNaN(duelScore(loserUnquoted, BOOK))).toBe(true);
    // Not 1.0 — which is what dropping the unmarked leg would have produced.
    expect(duelScore(loserUnquoted, BOOK)).not.toBe(1);
  });

  test("an empty slate is unscoreable, not a score of zero", () => {
    // A player who filled nothing has no position. Zero would be a score that
    // can tie a flat basket, and could win a duel against a losing one.
    const d = scoreDetail([], BOOK);
    expect(Number.isNaN(d.score)).toBe(true);
    expect(d.premium).toBe(0);
    expect(d.unmarkable).toEqual([]);
    // And it is NOT the same answer as a genuinely flat basket.
    expect(duelScore([leg("AVAX-27SEP26-30-C", 0.75, 8, 6)], BOOK)).toBe(0);
  });

  test("every malformed leg is unscoreable and is named, in slate order", () => {
    const cases: ReadonlyArray<[string, FilledLeg]> = [
      ["zero contracts", leg("ETH-27SEP26-4400-C", 0.25, 0, 1)],
      ["negative contracts", leg("ETH-27SEP26-4400-C", 0.25, -2, 1)],
      ["zero premium", leg("ETH-27SEP26-4400-C", 0.25, 2, 0)],
      ["negative premium", leg("ETH-27SEP26-4400-C", 0.25, 2, -1)],
      ["negative entry mark", leg("ETH-27SEP26-4400-C", -0.25, 2, 1)],
      ["NaN entry mark", leg("ETH-27SEP26-4400-C", Number.NaN, 2, 1)],
      ["infinite contracts", leg("ETH-27SEP26-4400-C", 0.25, Number.POSITIVE_INFINITY, 1)],
      ["infinite premium", leg("ETH-27SEP26-4400-C", 0.25, 2, Number.POSITIVE_INFINITY)],
    ];
    for (const [why, bad] of cases) {
      const d = scoreDetail([bad], BOOK);
      expect(`${why}: ${d.score}`).toBe(`${why}: NaN`);
      expect(d.unmarkable).toEqual(["ETH-27SEP26-4400-C"]);
    }
  });

  test("a leg too malformed to name is still counted, under \"?\"", () => {
    // An empty `unmarkable` must always mean "all good". A leg with no usable
    // instrument that reported nothing would read as a clean basket with a
    // silently missing position.
    const nameless = { instrument: "", entryMark: 0.25, contracts: 2, premium: 1 } as FilledLeg;
    const d = scoreDetail([nameless], BOOK);
    expect(d.unmarkable).toEqual(["?"]);
    expect(Number.isNaN(d.score)).toBe(true);
  });

  test("a book entry that is not a number is a missing mark, never a guess", () => {
    const rotten = new Map<string, number>([
      ["A-C", Number.NaN],
      ["B-C", Number.POSITIVE_INFINITY],
      ["C-C", -1],
    ]);
    for (const name of ["A-C", "B-C", "C-C"]) {
      const d = scoreDetail([leg(name, 1, 1, 1)], rotten);
      expect(d.unmarkable).toEqual([name]);
      expect(Number.isNaN(d.score)).toBe(true);
    }
  });

  test("an unmarkable basket loses nothing — it refuses to be compared at all", () => {
    // Not "the unscoreable player loses". Both stakes go back.
    const good = [leg("ETH-27SEP26-4400-C", 0.25, 2, 0.5)];
    const bad = [leg("NOT-IN-BOOK", 1, 1, 1)];
    for (const out of [duelOutcome(good, bad, BOOK), duelOutcome(bad, good, BOOK)]) {
      expect(out.noVerdict).toBe(true);
      expect(out.aWins).toBe(false);
    }
    // The refusal names the leg, so a player can check it against the same
    // public book rather than being told only "no verdict".
    expect([
      ...duelOutcome(good, bad, BOOK).aDetail.unmarkable,
      ...duelOutcome(good, bad, BOOK).bDetail.unmarkable,
    ]).toEqual(["NOT-IN-BOOK"]);
  });
});

describe("ties are refused, and there is no tiebreak", () => {
  test("SCORE_DP is six, and roundScore is a rounding rule a human can check", () => {
    expect(SCORE_DP).toBe(6);
    expect(roundScore(0.123456789)).toBe(0.123457);
    expect(roundScore(-0.123456789)).toBe(-0.123457);
    expect(roundScore(1)).toBe(1);
  });

  test("identical baskets tie", () => {
    const legs = [leg("ETH-27SEP26-4400-C", 0.25, 4, 1)];
    const out = duelOutcome(legs, [...legs], BOOK);
    expect(out.aScore).toBe(out.bScore);
    expect(out.noVerdict).toBe(true);
    expect(out.aWins).toBe(false);
  });

  test("different baskets with the same return tie — the metric, not the position", () => {
    //   A  ETH: (0.50 − 0.25) × 2 = +0.50 on 1.00  → 0.5
    //   B  BTC: (2.25 − 2.00) × 4 = +1.00 on 2.00  → 0.5
    const a = [leg("ETH-27SEP26-4400-C", 0.25, 2, 1)];
    const b = [leg("BTC-27SEP26-70000-P", 2, 4, 2)];
    expect(duelScore(a, BOOK)).toBe(0.5);
    expect(duelScore(b, BOOK)).toBe(0.5);
    expect(duelOutcome(a, b, BOOK).noVerdict).toBe(true);
  });

  test("a difference below the sixth decimal is float noise, and does not pay anybody", () => {
    // The only place in this file where the numbers are deliberately not clean:
    // this is exactly the last-bits-of-a-division difference the rule exists to
    // refuse. 1e-9 apart is not a better basket.
    expect(scoresTie(0.1234561, 0.1234561 + 1e-9)).toBe(true);
    expect(scoresTie(0.5, 0.5000004)).toBe(true);
    expect(scoresTie(-0.25, -0.2500001)).toBe(true);
  });

  test("a difference AT the sixth decimal does separate them", () => {
    expect(scoresTie(0.5, 0.500001)).toBe(false);
    expect(scoresTie(0.5, 0.4999985)).toBe(false);
    expect(duelOutcome.length).toBe(3); // still no fourth argument to break it with
  });

  test("anything non-finite ties — the safe answer to a NaN is \"nobody won\"", () => {
    // A `scoresTie` that returned false for NaN would read as "they differ, so
    // somebody won", which is how an unscoreable duel becomes a wrong payout.
    for (const [a, b] of [
      [Number.NaN, 0.5],
      [0.5, Number.NaN],
      [Number.NaN, Number.NaN],
      [Number.POSITIVE_INFINITY, 0.5],
      [0.5, Number.NEGATIVE_INFINITY],
    ] as const) {
      expect(scoresTie(a, b)).toBe(true);
    }
  });

  test("a tie is never broken by size, by leg count, or by seat order", () => {
    // The three tiebreaks somebody would reach for. None of them exists: the
    // refund is the answer, and it is rake-free for both players.
    const a = [leg("ETH-27SEP26-4400-C", 0.25, 2, 1)]; // 1 leg,  premium 1
    const b = [
      leg("BTC-27SEP26-70000-P", 2, 4, 2), //             2 legs, premium 6,
      leg("AVAX-27SEP26-30-C", 0.75, 8, 4), //            and a flat leg… but
    ]; //  (0.25×4 + 0) ÷ 6 = 0.1666… — not a tie, so build the tie explicitly:
    expect(duelScore(a, BOOK)).toBe(0.5);
    expect(duelScore(b, BOOK)).not.toBe(0.5);

    const bTied = [leg("BTC-27SEP26-70000-P", 2, 8, 4), leg("AVAX-27SEP26-30-C", 0.75, 8, 0.000001)];
    // (0.25 × 8 + 0) ÷ 4.000001 ≈ 0.49999987… — inside 6dp of 0.5.
    expect(scoresTie(duelScore(a, BOOK), duelScore(bTied, BOOK))).toBe(true);
    const out = duelOutcome(a, bTied, BOOK);
    expect(out.noVerdict).toBe(true);
    expect(out.aWins).toBe(false); // not "a, because it was first"
    expect(duelOutcome(bTied, a, BOOK).aWins).toBe(false); // nor the other way
  });

  test("the module exports nothing that breaks a tie", async () => {
    // Structural, so that a later "just add a coin flip" cannot land quietly:
    // the surface is the score, the detail, the rounding rule, the tie test and
    // the outcome — and nothing that takes a seed, a clock or a random source.
    const mod = await import("../src/engine/score.ts");
    expect(Object.keys(mod).sort()).toEqual([
      "SCORE_DP",
      "duelOutcome",
      "duelScore",
      "roundScore",
      "scoreDetail",
      "scoresTie",
    ]);
  });
});

describe("duelOutcome maps a score onto a seat", () => {
  const better = [leg("ETH-27SEP26-4400-C", 0.25, 2, 0.5)]; // 1.0
  const worse = [leg("BTC-27SEP26-70000-P", 2, 6, 3)]; //      0.5

  test("aWins is true when a scored higher, false when b did", () => {
    expect(duelOutcome(better, worse, BOOK).aWins).toBe(true);
    expect(duelOutcome(worse, better, BOOK).aWins).toBe(false);
  });

  test("the detail of both seats comes back, so a refusal can be explained", () => {
    const out = duelOutcome(better, worse, BOOK);
    expect(out.aScore).toBe(out.aDetail.score);
    expect(out.bScore).toBe(out.bDetail.score);
    expect(out.aDetail.premium).toBe(0.5);
    expect(out.bDetail.premium).toBe(3);
  });

  test("aWins is false whenever noVerdict is true, whatever the scores look like", () => {
    // The one invariant a caller that moves money depends on: `aWins` is
    // meaningless unless `noVerdict` is false, and it is never left true by
    // accident on a refused duel.
    const dead = [leg("NOT-IN-BOOK", 1, 1, 1)];
    for (const out of [
      duelOutcome(better, dead, BOOK),
      duelOutcome(dead, worse, BOOK),
      duelOutcome(dead, dead, BOOK),
      duelOutcome([], [], BOOK),
      duelOutcome(better, [...better], BOOK),
    ]) {
      expect(out.noVerdict).toBe(true);
      expect(out.aWins).toBe(false);
    }
  });

  test("an empty book marks nothing, so nobody wins", () => {
    const out = duelOutcome(better, worse, new Map());
    expect(out.noVerdict).toBe(true);
    expect(out.aDetail.unmarkable).toEqual(["ETH-27SEP26-4400-C"]);
    expect(out.bDetail.unmarkable).toEqual(["BTC-27SEP26-70000-P"]);
  });
});
