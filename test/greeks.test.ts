/**
 * The option maths, tested hard.
 *
 * Four kinds of test live here, and the order is the order of trust:
 *
 *  1. **Ground truth that needs no network and no fixture** — published
 *     reference values for N(x), put–call parity, the analytic identities
 *     between a call's greeks and a put's, and the limits at the edges of the
 *     domain. These are the tests that would still be right if every capture in
 *     this repo were wrong.
 *  2. **The venue's own arithmetic, transcribed** — `calculatePayout` out of
 *     `@thetanuts-finance/thetanuts-client`'s `dist/index.js`, checked against
 *     the replicating portfolios in `src/data/greeks.ts` across the whole price
 *     line. A sign error in that table is silent, type-safe and catastrophic;
 *     this is the only thing that catches it.
 *  3. **The frozen book** — every greeked vanilla in `test/fixtures/orders.json`
 *     repriced and compared to the venue's published delta, gamma, theta and
 *     vega. This is the validation the brief asked for, at the size the fixture
 *     can carry.
 *  4. **The wiring** — that `buildSnapshot` puts the right numbers on the right
 *     rows with the right provenance, and that a spread's composed delta can
 *     never reach a card.
 *
 * The network is not reachable from this machine (local DNS resolves the
 * venue's worker to an OpenDNS block page; `docs/asset-gate.md` and
 * `docs/plan6-audit.md` pin the correction for the session that misread that as
 * an outage), so nothing here touches it and nothing here needs to.
 */

import { describe, expect, test } from "bun:test";
import {
  BISECTION_MAX_ITER,
  DAYS_PER_YEAR,
  DEFAULT_RATE,
  SECONDS_PER_YEAR,
  VALIDATION,
  VOL_CEILING,
  VOL_FLOOR,
  blackScholes,
  bsPrice,
  composeGreeks,
  d1d2,
  decayOver,
  impliedVol,
  intrinsic,
  legsPayoff,
  modelGreeks,
  normCdf,
  normPdf,
  replicatingLegs,
  structureGreeks,
  yearsBetweenMs,
  yearsBetweenSeconds,
  type OptionRight,
} from "../src/data/greeks.ts";
import { buildSnapshot, levelGreeks, nearestIv, venueGreeksOf } from "../src/server/thetanuts.ts";
import { DUEL_WINDOW, duelDecay, optionizeTier } from "../src/desk/optionize.ts";
import type { PricingRow } from "../src/types.ts";

import FIXTURE from "./fixtures/orders.json" with { type: "json" };

// ─────────────────────────────────────────────────────────────────────────────
// 1. The normal distribution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An independent high-precision N(x), used only in this file.
 *
 * Two algorithms, neither of them the one under test: the erf Taylor series
 * (which converges quickly and accurately for small arguments and loses
 * precision to cancellation above |x| ≈ 3) and a 1200-level tail continued
 * fraction (which is exact for large arguments and divergent for small ones).
 * Each is used only where it is good, and they agree with each other to 1e-16
 * in the overlap — which is what makes the pair a reference rather than a
 * second opinion.
 */
function referenceCdf(x: number): number {
  if (Math.abs(x) <= 2) {
    const z = x / Math.SQRT2;
    let sum = 0;
    let term = z;
    for (let n = 0; n < 400; n += 1) {
      sum += term / (2 * n + 1);
      term *= (-z * z) / (n + 1);
    }
    return 0.5 * (1 + (2 / Math.sqrt(Math.PI)) * sum);
  }
  const a = Math.abs(x);
  let cf = a + 1200 / a;
  for (let n = 1199; n >= 1; n -= 1) cf = a + n / cf;
  const tail = Math.exp(-0.5 * a * a) / Math.sqrt(2 * Math.PI) / cf;
  return x > 0 ? 1 - tail : tail;
}

describe("normCdf is accurate enough to trust", () => {
  test("published reference values to the last bit", () => {
    // Standard 16-digit values. If these ever fail the algorithm changed.
    const table: Array<[number, number]> = [
      [0, 0.5],
      [1, 0.841344746068543],
      [-1, 0.15865525393145707],
      [1.96, 0.9750021048517795],
      [2, 0.9772498680518208],
      [3, 0.9986501019683699],
      [-3, 0.0013498980316300933],
    ];
    for (const [x, want] of table) {
      expect(Math.abs(normCdf(x) - want)).toBeLessThan(2e-16);
    }
  });

  test("maximum absolute error over the whole domain is under 1e-15", () => {
    let worst = 0;
    for (let x = -37; x <= 37; x += 0.01) {
      worst = Math.max(worst, Math.abs(normCdf(x) - referenceCdf(x)));
    }
    // Measured 3.4e-16 — about 1.5 ulp of 1.0. The headline claim in the
    // module's docstring, asserted rather than asserted-in-prose.
    expect(worst).toBeLessThan(1e-15);
  });

  test("relative error stays tiny where the value is tiny", () => {
    // The continued-fraction branch. Worst measured relative error is 8.9e-9
    // around |x| = 7.8, where N(x) itself is ~1e-14 and the absolute error is
    // ~1e-22 — which is why the absolute bound above is the one that matters.
    let worstRel = 0;
    for (let x = 2; x <= 20; x += 0.01) {
      const got = normCdf(-x);
      const want = referenceCdf(-x);
      worstRel = Math.max(worstRel, Math.abs(got - want) / want);
    }
    expect(worstRel).toBeLessThan(1e-8);
  });

  test("symmetry, monotonicity and the limits", () => {
    for (let x = 0; x <= 8; x += 0.13) {
      expect(normCdf(x) + normCdf(-x)).toBeCloseTo(1, 15);
    }
    let prev = -1;
    for (let x = -6; x <= 6; x += 0.05) {
      const v = normCdf(x);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(normCdf(-40)).toBe(0);
    expect(normCdf(40)).toBe(1);
    expect(normCdf(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normCdf(Number.NEGATIVE_INFINITY)).toBe(0);
  });

  test("the density integrates to one and peaks where it should", () => {
    expect(normPdf(0)).toBeCloseTo(0.3989422804014327, 15);
    expect(normPdf(1)).toBeCloseTo(normPdf(-1), 16);
    // Trapezoid over [-10, 10] at 1e-4 spacing. Not a precision test — a
    // "this is a probability density" test.
    let area = 0;
    const h = 1e-4;
    for (let x = -10; x < 10; x += h) area += 0.5 * h * (normPdf(x) + normPdf(x + h));
    expect(area).toBeCloseTo(1, 9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Black–Scholes: identities that must hold whatever the numbers are
// ─────────────────────────────────────────────────────────────────────────────

/** A spread of ordinary, and a few deliberately awkward, option specs. */
const GRID: Array<{ spot: number; strike: number; vol: number; years: number }> = [];
for (const spot of [100, 2522.13, 81004.04]) {
  for (const moneyness of [0.6, 0.85, 0.98, 1, 1.02, 1.15, 1.6]) {
    for (const years of [1 / 365, 7 / 365, 30 / 365, 0.5, 2]) {
      for (const vol of [0.12, 0.35, 0.688, 1.4]) {
        GRID.push({ spot, strike: spot * moneyness, vol, years });
      }
    }
  }
}

describe("Black-Scholes obeys its own identities", () => {
  test("put-call parity: C - P = S - K·e^(-rT)", () => {
    for (const rate of [0, 0.05]) {
      for (const g of GRID) {
        const c = bsPrice({ ...g, right: "CALL", rate })!;
        const p = bsPrice({ ...g, right: "PUT", rate })!;
        const parity = g.spot - g.strike * Math.exp(-rate * g.years);
        // Relative to the spot, because a $81,004 underlying carries $81,004
        // worth of rounding and an absolute tolerance would be a spot test.
        expect(Math.abs(c - p - parity) / g.spot).toBeLessThan(1e-13);
      }
    }
  });

  test("parity differentiated: delta_call - delta_put === 1", () => {
    for (const g of GRID) {
      const c = blackScholes({ ...g, right: "CALL" })!;
      const p = blackScholes({ ...g, right: "PUT" })!;
      expect(c.delta - p.delta).toBeCloseTo(1, 14);
    }
  });

  test("gamma and vega are identical for a call and a put at one strike", () => {
    // Parity's difference `S - K·e^(-rT)` is linear in S and free of sigma, so
    // it vanishes under the second S-derivative and under the sigma-derivative.
    // Two separate code paths produce these; this is what stops them drifting.
    for (const g of GRID) {
      const c = blackScholes({ ...g, right: "CALL" })!;
      const p = blackScholes({ ...g, right: "PUT" })!;
      expect(c.gamma).toBe(p.gamma);
      expect(c.vegaPerPoint).toBe(p.vegaPerPoint);
      expect(c.vegaPerUnitVol).toBe(p.vegaPerUnitVol);
      // At r = 0 the carry term is zero, so the thetas coincide too.
      expect(c.thetaPerYear).toBeCloseTo(p.thetaPerYear, 12);
    }
  });

  test("delta is bounded: 0..1 for calls, -1..0 for puts", () => {
    // Inclusive, and that is not a weakening. A 1-day 12%-vol call struck 60%
    // above spot has d1 near -30, where `e^(-d1^2/2)` underflows a double: its
    // delta really is the floating-point number 0 and its put's really is -1.
    // The bound is what is being tested, and the bound holds.
    for (const g of GRID) {
      const c = blackScholes({ ...g, right: "CALL" })!;
      const p = blackScholes({ ...g, right: "PUT" })!;
      expect(c.delta).toBeGreaterThanOrEqual(0);
      expect(c.delta).toBeLessThanOrEqual(1);
      expect(p.delta).toBeGreaterThanOrEqual(-1);
      expect(p.delta).toBeLessThanOrEqual(0);
    }
  });

  /**
   * The grid points that still have measurable optionality in double
   * precision — i.e. a strictly positive gamma. The strict-sign invariants
   * below are asserted here rather than over the whole grid, because on the
   * far wings the correct answer really is an exact zero and demanding
   * strictness there would be testing the float format, not the maths.
   */
  const LIVE = GRID.filter((g) => blackScholes({ ...g, right: "CALL" })!.gamma > 0);

  test("the live subset is most of the grid", () => {
    // A guard on the guard: if a refactor made everything underflow, the
    // strict tests below would pass vacuously.
    expect(LIVE.length).toBeGreaterThan(GRID.length * 0.8);
  });

  test("gamma and vega are strictly positive wherever there is optionality", () => {
    for (const g of LIVE) {
      const c = blackScholes({ ...g, right: "CALL" })!;
      expect(c.gamma).toBeGreaterThan(0);
      expect(c.vegaPerPoint).toBeGreaterThan(0);
      expect(c.vegaPerUnitVol).toBeGreaterThan(0);
    }
  });

  test("theta is negative for every long option at r = 0", () => {
    // A long option is a wasting asset. There is no strike, no maturity and no
    // volatility with any optionality left where holding one overnight is free.
    for (const g of LIVE) {
      for (const right of ["CALL", "PUT"] as const) {
        const v = blackScholes({ ...g, right })!;
        expect(v.thetaPerYear).toBeLessThan(0);
        expect(v.thetaPerDay).toBeLessThan(0);
      }
    }
    // And it is never positive anywhere, underflow included.
    for (const g of GRID) {
      expect(blackScholes({ ...g, right: "PUT" })!.thetaPerYear).toBeLessThanOrEqual(0);
    }
  });

  test("theta's two names are the same number, scaled by 365", () => {
    for (const g of GRID) {
      const v = blackScholes({ ...g, right: "CALL" })!;
      expect(v.thetaPerDay * DAYS_PER_YEAR).toBeCloseTo(v.thetaPerYear, 9);
    }
  });

  test("vega's two names are the same number, scaled by 100", () => {
    for (const g of GRID) {
      const v = blackScholes({ ...g, right: "PUT" })!;
      expect(v.vegaPerPoint * 100).toBeCloseTo(v.vegaPerUnitVol, 9);
    }
  });

  test("a bumped vol moves the price by vega, to first order", () => {
    // The only finite-difference test in the file, and it is here to check that
    // the *analytic* derivative is the derivative of the *analytic* price —
    // i.e. that nobody typed the formula in from a different textbook.
    for (const g of GRID.slice(0, 40)) {
      const base = blackScholes({ ...g, right: "CALL" })!;
      const h = 1e-6;
      const up = bsPrice({ ...g, vol: g.vol + h, right: "CALL" })!;
      const down = bsPrice({ ...g, vol: g.vol - h, right: "CALL" })!;
      expect((up - down) / (2 * h)).toBeCloseTo(base.vegaPerUnitVol, 4);
    }
  });

  test("a bumped spot moves the price by delta and delta by gamma", () => {
    for (const g of GRID.slice(0, 40)) {
      const base = blackScholes({ ...g, right: "PUT" })!;
      const h = g.spot * 1e-6;
      const up = blackScholes({ ...g, spot: g.spot + h, right: "PUT" })!;
      const down = blackScholes({ ...g, spot: g.spot - h, right: "PUT" })!;
      expect((up.price - down.price) / (2 * h)).toBeCloseTo(base.delta, 6);
      expect((up.delta - down.delta) / (2 * h)).toBeCloseTo(base.gamma, 8);
    }
  });

  test("rho carries the right sign and is zero-effect at r = 0", () => {
    for (const g of LIVE.slice(0, 40)) {
      const c = blackScholes({ ...g, right: "CALL" })!;
      const p = blackScholes({ ...g, right: "PUT" })!;
      expect(c.rhoPerPoint).toBeGreaterThanOrEqual(0);
      expect(p.rhoPerPoint).toBeLessThanOrEqual(0);
      // The default really is zero, so nothing downstream is quietly assuming
      // a rate it was never told about.
      expect(DEFAULT_RATE).toBe(0);
    }
  });
});

describe("Black-Scholes at the edges of the domain", () => {
  test("deep in the money: delta goes to +/-1 and the option is worth its intrinsic", () => {
    const deepCall = blackScholes({
      spot: 1000,
      strike: 100,
      vol: 0.3,
      years: 0.1,
      right: "CALL",
    })!;
    expect(deepCall.delta).toBeCloseTo(1, 12);
    expect(deepCall.price).toBeCloseTo(900, 8);
    expect(deepCall.gamma).toBeCloseTo(0, 12);

    const deepPut = blackScholes({ spot: 100, strike: 1000, vol: 0.3, years: 0.1, right: "PUT" })!;
    expect(deepPut.delta).toBeCloseTo(-1, 12);
    expect(deepPut.price).toBeCloseTo(900, 8);
  });

  test("deep out of the money: everything decays to zero", () => {
    const far = blackScholes({ spot: 100, strike: 10000, vol: 0.3, years: 0.02, right: "CALL" })!;
    expect(far.delta).toBeCloseTo(0, 12);
    expect(far.gamma).toBeCloseTo(0, 12);
    expect(far.price).toBeCloseTo(0, 12);
    expect(far.thetaPerDay).toBeCloseTo(0, 10);
  });

  test("at expiry and past it: null, never a step function", () => {
    // The degenerate case. At T = 0 delta is 0 or 1 with nothing between,
    // gamma is an infinite spike, and theta does not exist. Any of those
    // rendered on a card would be worse than a dash.
    for (const years of [0, -1e-9, -1]) {
      expect(blackScholes({ spot: 100, strike: 100, vol: 0.5, years, right: "CALL" })).toBeNull();
      expect(bsPrice({ spot: 100, strike: 100, vol: 0.5, years, right: "PUT" })).toBeNull();
      expect(d1d2(100, 100, 0.5, years)).toBeNull();
    }
  });

  test("a non-positive or unreadable input is null, not a zero", () => {
    const base = { strike: 100, vol: 0.5, years: 0.25, right: "CALL" as const };
    expect(blackScholes({ ...base, spot: 0 })).toBeNull();
    expect(blackScholes({ ...base, spot: -1 })).toBeNull();
    expect(blackScholes({ ...base, spot: Number.NaN })).toBeNull();
    expect(blackScholes({ ...base, spot: 100, vol: 0 })).toBeNull();
    expect(blackScholes({ ...base, spot: 100, vol: -0.1 })).toBeNull();
    expect(blackScholes({ ...base, spot: 100, strike: 0 })).toBeNull();
    expect(blackScholes({ ...base, spot: 100, rate: Number.NaN })).toBeNull();
  });

  test("zero-vol is refused rather than collapsed to intrinsic", () => {
    // A zero IV is a zero-filled field, not a market view. `parseIv` in
    // optionize.ts refuses one for the same reason.
    expect(blackScholes({ spot: 100, strike: 90, vol: 0, years: 1, right: "CALL" })).toBeNull();
  });
});

describe("time is measured in the units its function names", () => {
  test("seconds and milliseconds do not silently swap", () => {
    const expiry = 1_788_595_200;
    const nowSec = 1_788_508_800;
    expect(yearsBetweenSeconds(nowSec, expiry)).toBeCloseTo(1 / DAYS_PER_YEAR, 12);
    expect(yearsBetweenMs(nowSec * 1000, expiry)).toBeCloseTo(1 / DAYS_PER_YEAR, 12);
    // The trap, made visible: a ms `now` fed to the seconds function reads as
    // an expiry ~56,000 years in the past.
    expect(yearsBetweenSeconds(nowSec * 1000, expiry)).toBeLessThan(-50_000);
  });

  test("an expired contract reports a negative year fraction rather than clamping", () => {
    expect(yearsBetweenSeconds(1_788_600_000, 1_788_595_200)).toBeLessThan(0);
  });

  test("decayOver scales theta to the window it is handed", () => {
    const g = blackScholes({ spot: 81004, strike: 79500, vol: 0.3422, years: 1 / 365, right: "PUT" })!;
    // A day's window is the per-day theta, by definition and not by luck.
    expect(decayOver(g, SECONDS_PER_YEAR / DAYS_PER_YEAR)).toBeCloseTo(g.thetaPerDay, 10);
    // A year's window is the per-year theta.
    expect(decayOver(g, SECONDS_PER_YEAR)).toBeCloseTo(g.thetaPerYear, 8);
    // And the duel's window is four orders of magnitude smaller. This is the
    // whole two-clock point: the same contract, the same instant, two numbers.
    const perDuel = decayOver(g, 8);
    expect(Math.abs(perDuel)).toBeLessThan(Math.abs(g.thetaPerDay) / 1000);
    expect(perDuel).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The implied-volatility solver
// ─────────────────────────────────────────────────────────────────────────────

describe("impliedVol recovers the volatility it was priced with", () => {
  test("round trip over a wide grid, to the vol tolerance", () => {
    let worst = 0;
    let solved = 0;
    for (const g of GRID) {
      for (const right of ["CALL", "PUT"] as const) {
        const priced = blackScholes({ ...g, right })!;
        // Only where there is a time value to recover. A premium equal to
        // intrinsic to the last bit of a double carries no information about
        // sigma, and no solver can invent it — see the docstring.
        if (priced.price - intrinsic(right, g.spot, g.strike) <= 1e-8 * g.spot) continue;
        const iv = impliedVol({ ...g, right, price: priced.price });
        expect(iv).not.toBeNull();
        solved += 1;
        worst = Math.max(worst, Math.abs(iv! - g.vol));
      }
    }
    expect(solved).toBeGreaterThan(300);
    expect(worst).toBeLessThan(1e-8);
  });

  test("it converges on sigma, not on the premium", () => {
    // The regression. A far wing quotes 0.0012 against a spot of 2,522, so an
    // absolute price tolerance of 1e-8 is met by every vol from 1% to 40% and
    // the solver returns whatever it was seeded with. The first draft of the
    // module had exactly that bug.
    const spot = 2522.13;
    const strike = 4500;
    const years = 7 / 365;
    const truth = 0.9;
    const price = bsPrice({ spot, strike, vol: truth, years, right: "CALL" })!;
    // The premium is a fraction of a cent on a $2,522 underlying. An absolute
    // price tolerance of 1e-8 is satisfied here by a vast range of sigma.
    expect(price).toBeLessThan(0.005);
    expect(impliedVol({ spot, strike, years, right: "CALL", price })).toBeCloseTo(truth, 7);
  });

  test("a price outside the no-arbitrage box has no implied vol at all", () => {
    const base = { spot: 100, strike: 90, years: 0.5 };
    // Above the call's ceiling, which is the spot.
    expect(impliedVol({ ...base, right: "CALL", price: 100.01 })).toBeNull();
    expect(impliedVol({ ...base, right: "CALL", price: 500 })).toBeNull();
    // At or below the call's floor, which is the forward intrinsic.
    expect(impliedVol({ ...base, right: "CALL", price: 10 })).toBeNull();
    expect(impliedVol({ ...base, right: "CALL", price: 9.99 })).toBeNull();
    // The put's ceiling is its strike (discounted).
    expect(impliedVol({ spot: 100, strike: 90, years: 0.5, right: "PUT", price: 90 })).toBeNull();
    expect(impliedVol({ spot: 100, strike: 90, years: 0.5, right: "PUT", price: 91 })).toBeNull();
    // A zero or negative premium is not a quote.
    expect(impliedVol({ ...base, right: "CALL", price: 0 })).toBeNull();
    expect(impliedVol({ ...base, right: "CALL", price: -1 })).toBeNull();
  });

  test("a non-positive time to expiry has no implied vol", () => {
    expect(impliedVol({ spot: 100, strike: 100, years: 0, right: "CALL", price: 5 })).toBeNull();
    expect(impliedVol({ spot: 100, strike: 100, years: -1, right: "CALL", price: 5 })).toBeNull();
  });

  test("a degenerate spot or strike has no implied vol", () => {
    expect(impliedVol({ spot: 0, strike: 100, years: 1, right: "CALL", price: 5 })).toBeNull();
    expect(impliedVol({ spot: 100, strike: 0, years: 1, right: "CALL", price: 5 })).toBeNull();
    expect(impliedVol({ spot: Number.NaN, strike: 1, years: 1, right: "PUT", price: 1 })).toBeNull();
  });

  test("a root outside the search bracket is refused rather than clamped", () => {
    // Priced at 2000% vol, which is past VOL_CEILING. The honest answer is
    // "not in the range I search", not "10.0".
    const price = bsPrice({ spot: 100, strike: 100, vol: 20, years: 1, right: "CALL" })!;
    const iv = impliedVol({ spot: 100, strike: 100, years: 1, right: "CALL", price });
    expect(iv === null || iv < VOL_CEILING).toBe(true);
    if (iv !== null) expect(iv).not.toBe(VOL_CEILING);
  });

  test("the caps are real caps", () => {
    // Not a behavioural test — a "nobody removed the bound" test. An
    // uncapped bisection on a pathological input is an infinite loop in a
    // render.
    expect(BISECTION_MAX_ITER).toBeGreaterThan(0);
    expect(BISECTION_MAX_ITER).toBeLessThanOrEqual(1024);
    expect(VOL_FLOOR).toBeGreaterThan(0);
    expect(VOL_CEILING).toBeGreaterThan(VOL_FLOOR);
  });

  test("the venue's own published IVs reprice its own quotes", () => {
    // Not the same claim as the fixture validation below: this one takes the
    // *model price* at the published IV and asks the solver to give the IV
    // back. It closes the loop between the two directions.
    for (const row of greekedVanillas()) {
      const price = bsPrice({
        spot: row.spot,
        strike: row.strike,
        vol: row.iv,
        years: row.years,
        right: row.right,
      })!;
      const back = impliedVol({
        spot: row.spot,
        strike: row.strike,
        years: row.years,
        right: row.right,
        price,
      });
      expect(back).not.toBeNull();
      expect(back!).toBeCloseTo(row.iv, 7);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Multi-leg structures, against the venue's own payout code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ThetanutsUtils.calculatePayout`'s intrinsic-value switch, transcribed from
 * `node_modules/@thetanuts-finance/thetanuts-client/dist/index.js:10840`.
 *
 * Kept as a literal transcription rather than a tidy-up: its job is to be
 * *the venue's function*, so the closer it reads to the shipped source the more
 * a diff against a future SDK version is worth. The `put_fly` branch really
 * does destructure descending in the original; the sort here reproduces that
 * without depending on the caller's argument order.
 */
function sdkPayout(type: string, K: readonly number[], settlement: number): number {
  const mx = (v: number) => Math.max(0, v);
  const S = settlement;
  switch (type) {
    case "call":
      return mx(S - K[0]!);
    case "put":
      return mx(K[0]! - S);
    case "call_spread": {
      const [lower, upper] = K as unknown as [number, number];
      return S > lower ? (S > upper ? upper : S) - lower : 0;
    }
    case "put_spread": {
      const [lower, upper] = K as unknown as [number, number];
      return S < upper ? upper - (S < lower ? lower : S) : 0;
    }
    case "call_fly": {
      const [k1, k2, k3] = K as unknown as [number, number, number];
      return mx(S - k1) - 2 * mx(S - k2) + mx(S - k3);
    }
    case "put_fly": {
      const [k3, k2, k1] = [...K].sort((a, b) => b - a) as [number, number, number];
      return mx(k3 - S) - 2 * mx(k2 - S) + mx(k1 - S);
    }
    case "call_condor": {
      const [k1, k2, k3, k4] = K as unknown as [number, number, number, number];
      return mx(S - k1) - mx(S - k2) - mx(S - k3) + mx(S - k4);
    }
    case "put_condor": {
      const [k1, k2, k3, k4] = K as unknown as [number, number, number, number];
      return mx(k4 - S) - mx(k3 - S) - mx(k2 - S) + mx(k1 - S);
    }
    case "iron_condor": {
      const [k1, k2, k3, k4] = K as unknown as [number, number, number, number];
      return mx(k2 - S) - mx(k1 - S) + (mx(S - k3) - mx(S - k4));
    }
    case "ranger": {
      const [cL, cU, pL, pU] = K as unknown as [number, number, number, number];
      if (S <= cL || S >= pU) return 0;
      if (S < cU) return S - cL;
      if (S <= pL) return cU - cL;
      return pU - S;
    }
    default:
      throw new Error(`unknown ${type}`);
  }
}

const STRUCTURES: Array<[string, number[]]> = [
  ["call", [2500]],
  ["put", [2500]],
  ["call_spread", [2400, 2600]],
  ["put_spread", [2400, 2600]],
  ["call_fly", [2400, 2500, 2600]],
  ["put_fly", [2400, 2500, 2600]],
  ["call_condor", [2300, 2400, 2600, 2700]],
  ["put_condor", [2300, 2400, 2600, 2700]],
  ["iron_condor", [2300, 2400, 2600, 2700]],
  ["ranger", [79500, 80000, 81000, 81500]],
];

describe("the replicating portfolios ARE the venue's payoffs", () => {
  test("every structure matches calculatePayout across the whole price line", () => {
    for (const [payout, strikes] of STRUCTURES) {
      const legs = replicatingLegs(payout, strikes);
      expect(legs).not.toBeNull();
      const lo = Math.min(...strikes) * 0.5;
      const hi = Math.max(...strikes) * 1.5;
      let worst = 0;
      for (let s = lo; s <= hi; s += (hi - lo) / 3000) {
        worst = Math.max(worst, Math.abs(legsPayoff(legs!, s) - sdkPayout(payout, strikes, s)));
      }
      // Exact, not close: both sides are sums of the same `max(0, ·)` terms.
      expect(worst).toBeLessThan(1e-9);
    }
  });

  test("a ranger is a call condor at its four strikes", () => {
    // The one row of the decomposition table that is a derivation rather than a
    // transcription — the SDK writes the ranger as five piecewise branches and
    // never as a portfolio. It is exact *because* of the zone invariant
    // `callUpper - callLower === putUpper - putLower`.
    const K = [79500, 80000, 81000, 81500];
    const asRanger = replicatingLegs("ranger", K)!;
    const asCondor = replicatingLegs("call_condor", K)!;
    expect(asRanger).toEqual(asCondor);
  });

  test("the flat top of a ranger is ONE wing, whatever the collateral says", () => {
    // `calculateCollateralRequired` returns 2 x (callUpper - callLower) for a
    // RANGER. That is the seller's posted collateral, not the buyer's maximum
    // payout, and reading one as the other is the mistake src/data/condor.ts
    // documents. The payoff function is authoritative: the top is 500, not
    // 1,000.
    const legs = replicatingLegs("ranger", [79500, 80000, 81000, 81500])!;
    expect(legsPayoff(legs, 80500)).toBeCloseTo(500, 9);
    expect(legsPayoff(legs, 79000)).toBeCloseTo(0, 9);
    expect(legsPayoff(legs, 82000)).toBeCloseTo(0, 9);
  });

  test("strikes that break the venue's invariants get no legs", () => {
    // A ranger with no zone gap.
    expect(replicatingLegs("ranger", [100, 200, 150, 250])).toBeNull();
    // A ranger with unequal wings.
    expect(replicatingLegs("ranger", [100, 200, 300, 450])).toBeNull();
    // A fly that is not equidistant.
    expect(replicatingLegs("call_fly", [100, 150, 300])).toBeNull();
    // A condor with unequal wings.
    expect(replicatingLegs("call_condor", [100, 200, 300, 450])).toBeNull();
    // Wrong strike counts.
    expect(replicatingLegs("call_spread", [100])).toBeNull();
    expect(replicatingLegs("call", [100, 200])).toBeNull();
    // A product no table knows.
    expect(replicatingLegs("call_loan", [100])).toBeNull();
    expect(replicatingLegs("UNKNOWN", [100, 200, 300, 400])).toBeNull();
    expect(replicatingLegs("straddle", [100])).toBeNull();
    // Unreadable strikes.
    expect(replicatingLegs("call", [Number.NaN])).toBeNull();
    expect(replicatingLegs("call", [0])).toBeNull();
    expect(replicatingLegs("call", [-100])).toBeNull();
  });

  test("an UPPER_SNAKE product name is not a payout name", () => {
    // Three namespaces name these shapes and no two share strings. Passing
    // `RANGER` where `ranger` belongs must fail loudly, not silently.
    expect(replicatingLegs("RANGER", [79500, 80000, 81000, 81500])).toBeNull();
    expect(replicatingLegs("CALL_SPREAD", [100, 200])).toBeNull();
  });
});

describe("composed greeks", () => {
  const spot = 81004.04;
  const years = 7 / 365;
  const flat = () => 0.34;

  test("a call spread's delta is the difference of its legs' deltas", () => {
    const lower = blackScholes({ spot, strike: 80000, vol: 0.34, years, right: "CALL" })!;
    const upper = blackScholes({ spot, strike: 82000, vol: 0.34, years, right: "CALL" })!;
    const spread = structureGreeks({
      payout: "call_spread",
      strikes: [80000, 82000],
      spot,
      years,
      volFor: flat,
    })!;
    expect(spread.delta).toBeCloseTo(lower.delta - upper.delta, 12);
    expect(spread.gamma).toBeCloseTo(lower.gamma - upper.gamma, 14);
    expect(spread.thetaPerDay).toBeCloseTo(lower.thetaPerDay - upper.thetaPerDay, 10);
    expect(spread.source).toBe("model-composed");
  });

  test("a long call spread is delta-positive and bounded below one", () => {
    const spread = structureGreeks({
      payout: "call_spread",
      strikes: [80000, 82000],
      spot,
      years,
      volFor: flat,
    })!;
    expect(spread.delta).toBeGreaterThan(0);
    expect(spread.delta).toBeLessThan(1);
    // And it is nothing like a vanilla's: the lower leg alone is much more.
    const vanilla = blackScholes({ spot, strike: 80000, vol: 0.34, years, right: "CALL" })!;
    expect(spread.delta).toBeLessThan(vanilla.delta);
  });

  test("a zone at its peak is short gamma, short vega and LONG theta", () => {
    // The sign flip that proves this is real maths and not a sum of magnitudes.
    // Sitting on the flat top of a condor, more movement is bad, more vol is
    // bad, and the passage of time is your friend — so gamma and vega are
    // negative and theta is positive. A long *vanilla* can never do this.
    const zone = structureGreeks({
      payout: "ranger",
      strikes: [79500, 80000, 81000, 81500],
      spot: 80500,
      years,
      volFor: flat,
    })!;
    expect(zone.gamma).toBeLessThan(0);
    expect(zone.vegaPerPoint).toBeLessThan(0);
    expect(zone.thetaPerDay).toBeGreaterThan(0);
    // And on a far wing the signs come back.
    const wing = structureGreeks({
      payout: "ranger",
      strikes: [79500, 80000, 81000, 81500],
      spot: 76000,
      years,
      volFor: flat,
    })!;
    expect(wing.gamma).toBeGreaterThan(0);
    expect(wing.thetaPerDay).toBeLessThan(0);
  });

  test("a composed price converges on the payoff as time runs out", () => {
    // The only end-to-end check that the whole composition means anything: at
    // a very short maturity a structure is worth its terminal payoff.
    for (const [payout, strikes] of STRUCTURES) {
      for (const s of [0.9, 0.99, 1.01, 1.1]) {
        const px = strikes[Math.floor(strikes.length / 2)]! * s;
        const g = structureGreeks({
          payout,
          strikes,
          spot: px,
          years: 1e-7,
          volFor: () => 0.3,
        });
        if (g === null) continue;
        expect(Math.abs(g.price - sdkPayout(payout, strikes, px))).toBeLessThan(1e-3 * px);
      }
    }
  });

  test("one missing leg vol kills the whole structure", () => {
    // Not three-quarters honest. A condor priced off three real IVs and one
    // invented one is a fabricated number wearing a real number's clothes.
    const g = structureGreeks({
      payout: "call_condor",
      strikes: [79000, 80000, 81000, 82000],
      spot,
      years,
      volFor: (strike) => (strike === 82000 ? null : 0.34),
    });
    expect(g).toBeNull();
  });

  test("a non-positive leg vol is treated as absence", () => {
    expect(
      structureGreeks({
        payout: "call_spread",
        strikes: [80000, 82000],
        spot,
        years,
        volFor: () => 0,
      }),
    ).toBeNull();
    expect(
      structureGreeks({
        payout: "call_spread",
        strikes: [80000, 82000],
        spot,
        years,
        volFor: () => Number.NaN,
      }),
    ).toBeNull();
  });

  test("an empty portfolio composes to null, not to zero", () => {
    expect(composeGreeks([], spot, years)).toBeNull();
  });

  test("a single-leg structure is tagged model, not model-composed", () => {
    const g = structureGreeks({ payout: "call", strikes: [82000], spot, years, volFor: flat })!;
    expect(g.source).toBe("model");
    expect(modelGreeks({ spot, strike: 82000, vol: 0.34, years, right: "CALL" })!.source).toBe(
      "model",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The frozen book — validating against the venue's published greeks
// ─────────────────────────────────────────────────────────────────────────────

interface FixtureRow {
  spot: number;
  strike: number;
  right: OptionRight;
  years: number;
  iv: number;
  delta: number;
  gamma: number;
  thetaPerDay: number;
  vegaPerPoint: number;
}

/**
 * Every single-strike order in the frozen capture that published both a delta
 * and an IV — 25 of the 30 hand-picked orders.
 *
 * `now` is the capture's own `_provenance.captured`, which is recorded to the
 * **minute**. That is the dominant source of residual in everything below: T is
 * uncertain by roughly ±30 s, which on a 0.94-day contract is ±0.04% of the
 * remaining life.
 */
function greekedVanillas(): FixtureRow[] {
  const now = Date.parse(FIXTURE._provenance.captured) / 1000;
  const rows: FixtureRow[] = [];
  for (const entry of FIXTURE.orders) {
    const api = entry.rawApiData as
      | { greeks?: Record<string, number>; strikes?: string[]; isCall?: boolean }
      | undefined;
    const greeks = api?.greeks;
    if (!greeks || (api?.strikes ?? []).length !== 1) continue;
    const strike = Number(api!.strikes![0]) / 1e8;
    // The capture carries exactly two underlyings and their strikes do not
    // overlap by three orders of magnitude, which is why this crude split is
    // safe *here* and is not a pattern to copy.
    const spot = strike > 10000 ? FIXTURE.prices.BTC : FIXTURE.prices.ETH;
    rows.push({
      spot,
      strike,
      right: api!.isCall ? "CALL" : "PUT",
      years: yearsBetweenSeconds(now, Number(entry.order.expiry)),
      iv: greeks.iv!,
      delta: greeks.delta!,
      gamma: greeks.gamma!,
      thetaPerDay: greeks.theta!,
      vegaPerPoint: greeks.vega!,
    });
  }
  return rows;
}

function stats(errors: number[]): { mean: number; p95: number; max: number } {
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    mean: errors.reduce((a, b) => a + b, 0) / errors.length,
    p95: sorted[Math.floor(0.95 * (sorted.length - 1))]!,
    max: sorted[sorted.length - 1]!,
  };
}

describe("validated against the venue's own published greeks", () => {
  const rows = greekedVanillas();

  test("the fixture carries the sample this validation claims", () => {
    expect(rows.length).toBe(VALIDATION.rows);
    // And the five-number greeks object really is what ships, so the reader
    // above is not decoding a shape that no longer exists.
    const first = FIXTURE.orders[0]!.rawApiData!.greeks as Record<string, number>;
    expect(Object.keys(first).sort()).toEqual(["delta", "gamma", "iv", "theta", "vega"]);
  });

  test("delta: the error distribution", () => {
    const errors = rows.map((r) => {
      const g = blackScholes({ ...r, vol: r.iv })!;
      return Math.abs(g.delta - r.delta);
    });
    const s = stats(errors);
    expect(s.mean).toBeLessThan(VALIDATION.deltaMeanAbsMax);
    expect(s.p95).toBeLessThan(VALIDATION.deltaP95Max);
    expect(s.max).toBeLessThan(VALIDATION.deltaMaxAbsMax);
    // Measured: mean 0.00104, p95 0.00264, max 0.00329 against a field the
    // venue publishes to four decimals.
  });

  test("gamma, theta-per-day and vega-per-point: the same model, the same units", () => {
    // The units claim, asserted. If theta were per-year or vega per-1.00 these
    // would miss by 365x and 100x respectively rather than by 1%.
    const gammaErr: number[] = [];
    const thetaErr: number[] = [];
    const vegaErr: number[] = [];
    for (const r of rows) {
      const g = blackScholes({ ...r, vol: r.iv })!;
      gammaErr.push(Math.abs(g.gamma - r.gamma));
      thetaErr.push(Math.abs(g.thetaPerDay - r.thetaPerDay));
      vegaErr.push(Math.abs(g.vegaPerPoint - r.vegaPerPoint));
    }
    expect(stats(gammaErr).mean).toBeLessThan(VALIDATION.gammaMeanAbsMax);
    expect(stats(thetaErr).mean).toBeLessThan(VALIDATION.thetaPerDayMeanAbsMax);
    expect(stats(vegaErr).mean).toBeLessThan(VALIDATION.vegaPerPointMeanAbsMax);
  });

  test("relative error stays inside 4% on every single row", () => {
    // The per-row check the aggregate cannot make. A single blown row hiding
    // behind 24 good ones is exactly what a mean does not show.
    for (const r of rows) {
      const g = blackScholes({ ...r, vol: r.iv })!;
      expect(Math.abs(g.delta - r.delta) / Math.abs(r.delta)).toBeLessThan(0.04);
      expect(Math.abs(g.thetaPerDay - r.thetaPerDay) / Math.abs(r.thetaPerDay)).toBeLessThan(0.04);
      expect(Math.abs(g.vegaPerPoint - r.vegaPerPoint) / Math.abs(r.vegaPerPoint)).toBeLessThan(
        0.04,
      );
    }
  });

  test("a 252-day year would be visibly wrong, and a per-year theta absurdly so", () => {
    // The conventions are not free parameters. Swapping either one breaks the
    // agreement by orders of magnitude, which is the evidence that the ones we
    // chose are the venue's.
    const r = rows[0]!;
    const wrongBasis = blackScholes({ ...r, vol: r.iv, years: (r.years * 365) / 252 })!;
    expect(Math.abs(wrongBasis.delta - r.delta)).toBeGreaterThan(
      VALIDATION.deltaMaxAbsMax * 3,
    );
    const right = blackScholes({ ...r, vol: r.iv })!;
    expect(Math.abs(right.thetaPerYear - r.thetaPerDay)).toBeGreaterThan(
      Math.abs(r.thetaPerDay) * 100,
    );
    expect(Math.abs(right.vegaPerUnitVol - r.vegaPerPoint)).toBeGreaterThan(
      Math.abs(r.vegaPerPoint) * 50,
    );
  });

  test("the venue lists only out-of-the-money wings", () => {
    // Requirement 8's factual half, pinned. No solver changes it: |delta| never
    // exceeds 0.50 on this book, so nothing here may be used to claim a
    // high-delta instrument is listed.
    for (const r of rows) expect(Math.abs(r.delta)).toBeLessThanOrEqual(0.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The wiring
// ─────────────────────────────────────────────────────────────────────────────

describe("venueGreeksOf keeps everything the field ships", () => {
  test("all five numbers, renamed to their measured units", () => {
    expect(venueGreeksOf({ delta: 0.5, iv: 0.62, gamma: 0.001, theta: -7, vega: 0.19 })).toEqual({
      delta: 0.5,
      iv: 0.62,
      gamma: 0.001,
      thetaPerDay: -7,
      vegaPerPoint: 0.19,
    });
  });

  test("every not-a-number is null, on every field", () => {
    expect(venueGreeksOf(undefined)).toEqual({
      delta: null,
      iv: null,
      gamma: null,
      thetaPerDay: null,
      vegaPerPoint: null,
    });
    expect(venueGreeksOf({ delta: "0.5", iv: Number.NaN, gamma: null, theta: Infinity })).toEqual({
      delta: null,
      iv: null,
      gamma: null,
      thetaPerDay: null,
      vegaPerPoint: null,
    });
  });

  test("a half-populated object keeps the half that is real", () => {
    const g = venueGreeksOf({ delta: 0.4, theta: -2 });
    expect(g.delta).toBe(0.4);
    expect(g.thetaPerDay).toBe(-2);
    expect(g.iv).toBeNull();
    expect(g.vegaPerPoint).toBeNull();
  });
});

describe("nearestIv borrows honestly", () => {
  const smile = [
    { strike: 100, iv: 0.5 },
    { strike: 200, iv: 0.4 },
    { strike: 300, iv: 0.45 },
  ];
  test("picks the closest listed strike", () => {
    expect(nearestIv(smile, 105)).toBe(0.5);
    expect(nearestIv(smile, 199)).toBe(0.4);
    expect(nearestIv(smile, 10000)).toBe(0.45);
  });
  test("ties break low, deterministically", () => {
    expect(nearestIv(smile, 150)).toBe(0.5);
  });
  test("an empty or absent smile is null", () => {
    expect(nearestIv([], 100)).toBeNull();
    expect(nearestIv(undefined, 100)).toBeNull();
    expect(nearestIv(smile, 0)).toBeNull();
  });
});

describe("levelGreeks refuses what it cannot stand behind", () => {
  const smiles = new Map([["ETH|1788595200", [{ strike: 2500, iv: 0.5 }]]]);
  const level = {
    underlying: "ETH",
    strikes: [2500],
    expiry: 1788595200,
    iv: 0.5,
    isCall: true,
  };
  const at = 1788508800 * 1000;

  test("the happy path is tagged model/own", () => {
    const g = levelGreeks(level, "call", 2522.13, at, smiles)!;
    expect(g.source).toBe("model");
    expect(g.volSource).toBe("own");
    expect(g.vol).toBe(0.5);
    expect(g.delta).toBeGreaterThan(0);
    expect(g.thetaPerDay).toBeLessThan(0);
    // The two theta names really are the same number scaled.
    expect(g.thetaPerYear / DAYS_PER_YEAR).toBeCloseTo(g.thetaPerDay, 10);
  });

  test("an unresolved product gets nothing", () => {
    expect(levelGreeks(level, null, 2522.13, at, smiles)).toBeNull();
  });

  test("no spot, no expiry, no time left, all null", () => {
    expect(levelGreeks(level, "call", undefined, at, smiles)).toBeNull();
    expect(levelGreeks(level, "call", 0, at, smiles)).toBeNull();
    expect(levelGreeks({ ...level, expiry: 0 }, "call", 2522.13, at, smiles)).toBeNull();
    // `at` past the expiry.
    expect(levelGreeks(level, "call", 2522.13, 1788600000 * 1000, smiles)).toBeNull();
  });

  test("no smile and no own IV means no greeks", () => {
    expect(levelGreeks({ ...level, iv: null }, "call", 2522.13, at, new Map())).toBeNull();
  });

  test("a vanilla with no IV of its own borrows, and says so", () => {
    const g = levelGreeks({ ...level, iv: null, strikes: [2600] }, "call", 2522.13, at, smiles)!;
    expect(g.volSource).toBe("smile");
    expect(g.vol).toBe(0.5);
  });
});

describe("buildSnapshot puts computed greeks on the rows", () => {
  const at = Date.parse(FIXTURE._provenance.captured);
  const snap = buildSnapshot(
    {
      orders: FIXTURE.orders,
      prices: FIXTURE.prices,
      chainConfig: FIXTURE.chainConfig,
    } as never,
    at,
  );
  const rows: PricingRow[] = [...(snap.pricing.ETH ?? []), ...(snap.pricing.BTC ?? [])];

  test("the venue's own strings are untouched", () => {
    // The whole provenance rule in one assertion: adding a computed field must
    // not have rewritten a published one.
    for (const row of rows) {
      expect(typeof row.delta).toBe("string");
      expect(typeof row.iv).toBe("string");
    }
    const vanilla = rows.find((r) => r.structure === "PUT" && r.delta !== "—")!;
    expect(vanilla.iv.endsWith("%")).toBe(true);
  });

  test("no computed set is ever labelled as the venue's", () => {
    for (const row of rows) {
      if (!row.greeks) continue;
      expect(row.greeks.source === "model" || row.greeks.source === "model-composed").toBe(true);
      expect(row.greeks.source).not.toBe("venue");
    }
  });

  test("a vanilla's computed delta agrees with the venue's published one", () => {
    let checked = 0;
    for (const row of rows) {
      if (row.structure !== "CALL" && row.structure !== "PUT") continue;
      if (row.delta === "—" || !row.greeks) continue;
      checked += 1;
      expect(row.greeks.source).toBe("model");
      expect(row.greeks.volSource).toBe("own");
      // `PricingRow.delta` is `toFixed(2)`, so 0.005 is the display format's
      // own rounding and not a disagreement. This is the reason the earlier
      // scratch run measured 0.0030 against this field where the raw field
      // gives 0.0010.
      // Budget: up to 0.005 from `toFixed(2)` itself, plus the ~0.003 worst
      // model-vs-venue gap measured above. Anything past 0.01 would be a real
      // disagreement rather than a display artefact.
      expect(Math.abs(row.greeks.delta - Number(row.delta.replace("−", "-")))).toBeLessThan(
        0.01,
      );
    }
    expect(checked).toBeGreaterThan(15);
  });

  test("the multi-leg rows that never had greeks now have composed ones", () => {
    const multi = rows.filter(
      (r) => r.structure === "SPREAD" || r.structure === "FLY" || r.structure === "RANGER",
    );
    expect(multi.length).toBeGreaterThan(0);
    // Every one of these publishes no venue delta at all.
    for (const row of multi) expect(row.delta).toBe("—");
    const composed = multi.filter((r) => r.greeks);
    expect(composed.length).toBeGreaterThan(0);
    for (const row of composed) {
      expect(row.greeks!.source).toBe("model-composed");
      expect(row.greeks!.volSource).toBe("smile");
      expect(Number.isFinite(row.greeks!.delta)).toBe(true);
    }
  });

  test("a row on an expiry with no published smile gets no greeks", () => {
    // The ordinary absence. There is one in the capture: a 20-day BTC call
    // spread on an expiry where no vanilla published an IV.
    const orphan = rows.find((r) => r.structure === "SPREAD" && !r.greeks);
    expect(orphan).toBeDefined();
  });

  test("the snapshot is still a pure function of its arguments", () => {
    const again = buildSnapshot(
      {
        orders: FIXTURE.orders,
        prices: FIXTURE.prices,
        chainConfig: FIXTURE.chainConfig,
      } as never,
      at,
    );
    expect(again.pricing).toEqual(snap.pricing);
  });
});

describe("a composed delta can never reach a card", () => {
  /** A minimal chain: one real vanilla and one spread wearing `type: "CALL"`. */
  const chain: PricingRow[] = [
    {
      type: "CALL",
      structure: "SPREAD",
      payout: "call_spread",
      strike: "2,500",
      expiry: "12 SEP",
      bid: "1.0000",
      ask: "2.0000",
      iv: "—",
      delta: "—",
      depth: 50,
      size: "$10k",
      greeks: {
        source: "model-composed",
        delta: 0.75,
        gamma: 0.001,
        thetaPerDay: -1,
        thetaPerYear: -365,
        vegaPerPoint: 0.1,
        rhoPerPoint: 0,
        modelPrice: 1.5,
        vol: 0.5,
        volSource: "smile",
        years: 0.02,
      },
    },
    {
      type: "CALL",
      structure: "CALL",
      payout: "call",
      strike: "2,600",
      expiry: "12 SEP",
      bid: "3.0000",
      ask: "4.0000",
      iv: "50.0%",
      delta: "0.35",
      depth: 50,
      size: "$10k",
      greeks: {
        source: "model",
        delta: 0.351,
        gamma: 0.002,
        thetaPerDay: -2,
        thetaPerYear: -730,
        vegaPerPoint: 0.2,
        rhoPerPoint: 0,
        modelPrice: 3.5,
        vol: 0.5,
        volSource: "own",
        years: 0.02,
      },
    },
  ];

  test("the spread is not a candidate, so its 0.75 never becomes odds", () => {
    // The 88%-card bug, made unspellable. `type` says CALL on both rows; only
    // `structure` tells them apart, and `candidate` filters on `structure`.
    const q = optionizeTier("SHARP", "bull", chain, 2522.13, "ETH")!;
    expect(q.strike).toBe(2600);
    expect(q.impliedProb).toBeCloseTo(0.35, 10);
    expect(q.greeks!.source).toBe("model");
  });

  test("a vanilla whose vol was borrowed carries no card greeks", () => {
    const borrowed = chain.map((r) =>
      r.structure === "CALL" ? { ...r, greeks: { ...r.greeks!, volSource: "smile" as const } } : r,
    );
    const q = optionizeTier("SHARP", "bull", borrowed, 2522.13, "ETH")!;
    // Still quotable — the strike, the published delta and the premium are all
    // real. Just nothing to draw in the risk line.
    expect(q.strike).toBe(2600);
    expect(q.greeks).toBeUndefined();
  });

  test("the card's probability is the VENUE's delta, not the model's", () => {
    const q = optionizeTier("SHARP", "bull", chain, 2522.13, "ETH")!;
    // 0.35 published vs 0.351 computed. The card shows the published one.
    expect(q.delta).toBe(0.35);
    expect(q.impliedProb).toBe(0.35);
    expect(q.greeks!.delta).toBe(0.351);
  });

  test("duelDecay scales the expiry clock down to the duel clock", () => {
    const q = optionizeTier("SHARP", "bull", chain, 2522.13, "ETH")!;
    // A day's window IS thetaPerDay, by construction.
    expect(duelDecay(q, DUEL_WINDOW.day)).toBeCloseTo(q.greeks!.thetaPerDay, 10);
    // Eight seconds is 1/10,800th of that, and the sign survives.
    const perTape = duelDecay(q, DUEL_WINDOW.tape);
    expect(perTape).toBeCloseTo(q.greeks!.thetaPerDay / 10800, 12);
    expect(perTape).toBeLessThan(0);
    expect(Math.abs(perTape)).toBeLessThan(Math.abs(q.greeks!.thetaPerDay));
  });

  test("a quote with no greeks decays by nothing rather than by NaN", () => {
    const bare = chain.map((r) => ({ ...r, greeks: undefined }));
    const q = optionizeTier("SHARP", "bull", bare, 2522.13, "ETH")!;
    expect(q.greeks).toBeUndefined();
    expect(duelDecay(q, DUEL_WINDOW.tape)).toBe(0);
    expect(duelDecay(q, Number.NaN)).toBe(0);
  });
});
