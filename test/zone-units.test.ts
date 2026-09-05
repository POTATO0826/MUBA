/**
 * Two latent unit defects in the zone economics, and the refusals that close
 * them.
 *
 * Both are the repo's signature failure — a number meaning something other than
 * what it claims — and both are invisible today because every caller passes a
 * position of exactly one contract. `docs/reality-check.md` and the six money
 * bugs before them are all the same shape; the point of pinning these while
 * they are still latent is that the first line that sizes a box, or the first
 * malformed strike off the wire, would otherwise find them in production.
 *
 * The economics live in `src/data/condor.ts` and are shared with
 * `src/data/ranger.ts`; `test/box.test.ts` covers the rest of both files and
 * this file is only the units and the refusals.
 */

import { describe, expect, test } from "bun:test";
import {
  condorEconomics,
  economics,
  maxPayout,
  multipleOf,
  payoutMultiple,
  type CondorSpec,
} from "../src/data/condor.ts";
import {
  rangerPayoutOrder,
  rangerStrikeNumbers,
  zoneEconomics,
  zonePayoff,
  zoneToRanger,
  type ListedZone,
  type RangerSpec,
} from "../src/data/ranger.ts";

/** 8dp units, the encoding every strike on the wire uses. */
const at = (usd: number): string => String(Math.round(usd * 10 ** 8));

/** A $20-wing call condor: 2,460 / 2,480 / 2,550 / 2,570. */
const SPEC: CondorSpec = {
  product: "CALL_CONDOR",
  underlying: "ETH",
  strikes: [at(2_460), at(2_480), at(2_550), at(2_570)],
  expiry: 1_788_595_200,
  isLong: true,
};

/** A listed $500-wing BTC zone: 79,500 / 80,000 / 81,000 / 81,500. */
const ZONE: ListedZone = {
  underlying: "BTC",
  expiry: 1_788_595_200,
  strikes: [at(79_500), at(80_000), at(81_000), at(81_500)],
  floor: at(80_000),
  ceiling: at(81_000),
  wing: at(500),
  availableAmount: "10000000000",
  index: 0,
  order: {
    order: { expiry: "1788595200" },
    availableAmount: "10000000000",
    rawApiData: {
      priceFeed: "0xfeed",
      strikes: [at(79_500), at(80_000), at(81_000), at(81_500)],
      implementation: "0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc",
    },
  } as ListedZone["order"],
};

// ─────────────────────────────────────────────────────────────────────────────
// A total over a per-contract figure is not a multiple
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `maxPayout` is `wing × numContracts` — a position total. `maxLoss` was the
 * premium **unscaled**, so `payoutMultiple`, which is one divided by the other,
 * came back inflated by exactly `numContracts`.
 *
 * At one contract the two conventions coincide, which is why nothing caught it:
 * `contracts` defaults to `1` in `boxEconomics`, in `BoxBuilder` and in every
 * test. Three contracts is the smallest position that tells them apart.
 */
describe("the economics are all totals over one position", () => {
  const zone = { floor: 2_480, ceiling: 2_550 };

  test("at three contracts the premium scales with the ceiling", () => {
    // $20 of wing and $2 of premium, three times over.
    const econ = economics(20, zone, 2, 3);
    expect(econ.maxPayout).toBe(60);
    expect(econ.maxLoss).toBe(6); // was 2 — the premium for a single contract
    expect(econ.contracts).toBe(3);
    // $60 of upside against $6 of risk. The pre-fix answer was ×30, which is
    // the true multiple multiplied by the size of the position.
    expect(econ.payoutMultiple).toBe(10);
  });

  test("the multiple is scale-free, which is what says the units agree", () => {
    const one = economics(20, zone, 2, 1).payoutMultiple;
    for (const contracts of [1, 2, 3, 10, 250]) {
      expect(economics(20, zone, 2, contracts).payoutMultiple, `${contracts}`).toBe(one);
    }
  });

  test("one contract is unchanged, so nothing on screen today moves", () => {
    const econ = economics(20, zone, 2, 1);
    expect(econ.maxLoss).toBe(2);
    expect(econ.maxPayout).toBe(20);
    expect(econ.payoutMultiple).toBe(10);
  });

  test("the condor and the listed zone answer the same way", () => {
    expect(condorEconomics(SPEC, 2, 3).maxLoss).toBe(6);
    expect(condorEconomics(SPEC, 2, 3).payoutMultiple).toBe(10);
    // $500 of wing, $50 a contract, four contracts: $2,000 against $200.
    expect(zoneEconomics(ZONE, 50, 4).maxPayout).toBe(2_000);
    expect(zoneEconomics(ZONE, 50, 4).maxLoss).toBe(200);
    expect(zoneEconomics(ZONE, 50, 4).payoutMultiple).toBe(10);
  });

  test("payoutMultiple agrees with the panel it feeds", () => {
    expect(payoutMultiple(SPEC, 2, 3)).toBe(condorEconomics(SPEC, 2, 3).payoutMultiple);
    expect(payoutMultiple(SPEC, 2, 3)).toBe(multipleOf(maxPayout(SPEC, 3), 6));
  });

  test("a premium or a size that is not one still refuses rather than inventing", () => {
    // `null`, not a placeholder — the rule that has always held here.
    expect(economics(20, zone, 0, 3).payoutMultiple).toBeNull();
    expect(economics(20, zone, Number.NaN, 3).payoutMultiple).toBeNull();
    expect(economics(20, zone, 2, 0).payoutMultiple).toBeNull();
    expect(economics(20, zone, 2, Number.NaN).payoutMultiple).toBeNull();
    expect(economics(20, zone, 2, 0).contracts).toBe(0);
    expect(payoutMultiple(SPEC, 2, Number.NaN)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A strike we cannot read is not a strike of zero
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `parseStrike(s) ?? 0n` and `strikeUsd(a) ?? 0`, both in `src/data/ranger.ts`,
 * are the `reservePrice → 0n` shape exactly: an unreadable field became a real
 * and very wrong value rather than stopping the call.
 *
 * A zero strike is not a missing instrument, it is a different one. Handed to
 * the SDK's payout math it prices a band whose lower edge is nought; handed to
 * `validateRanger` it gets a verdict about a contract nobody is trading. Both
 * now refuse.
 */
describe("an unreadable ranger strike refuses instead of becoming zero", () => {
  const spec = (strikes: readonly [string, string, string, string]): RangerSpec => ({
    ...zoneToRanger(ZONE),
    strikes,
  });

  /** Everything `parseStrike` declines: empty, hex, exponent, decimal, words. */
  const UNREADABLE = ["", "0x1f4", "1e10", "79500.5", "eighty thousand", " 79500 x"];

  test("rangerPayoutOrder throws rather than handing the SDK a zero strike", () => {
    for (const bad of UNREADABLE) {
      const s = spec([bad, at(80_000), at(81_000), at(81_500)]);
      expect(() => rangerPayoutOrder(s), bad).toThrow(/unreadable/i);
    }
    // Every position, not only the first.
    expect(() => rangerPayoutOrder(spec([at(79_500), at(80_000), at(81_000), ""]))).toThrow();
  });

  test("rangerStrikeNumbers throws rather than moving a wing to zero", () => {
    for (const bad of UNREADABLE) {
      const s = spec([bad, at(80_000), at(81_000), at(81_500)]);
      expect(() => rangerStrikeNumbers(s), bad).toThrow(/unreadable/i);
    }
  });

  test("the refusal reaches the payoff, which used to price a band that does not exist", () => {
    // With `?? 0` the lower wing became 0 and the wing width became $80,000,
    // so this returned a plausible, large, entirely fictional number.
    const broken: ListedZone = { ...ZONE, strikes: ["", at(80_000), at(81_000), at(81_500)] };
    expect(() => zonePayoff(broken, 80_500)).toThrow(/unreadable/i);
  });

  test("a well-formed zone is untouched — the throw is a bound, not a branch", () => {
    expect(rangerStrikeNumbers(zoneToRanger(ZONE))).toEqual([79_500, 80_000, 81_000, 81_500]);
    expect(rangerPayoutOrder(zoneToRanger(ZONE)).strikes).toHaveLength(4);
    expect(rangerPayoutOrder(zoneToRanger(ZONE)).isRanger).toBe(true);
    expect(zonePayoff(ZONE, 80_500)).toBe(500);
  });
});
