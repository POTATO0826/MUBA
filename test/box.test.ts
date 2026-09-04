/**
 * The box builder's pure half, offline.
 *
 * Every test here runs against `fixtures/orders.json` — one genuine
 * `fetchOrders()` + `getMarketData()` response from Base mainnet, captured
 * 4 Sep 2026, trimmed to 30 orders and frozen. Real strikes, real expiries,
 * real greeks, real asks. Nothing opens a socket, nothing reads a clock,
 * nothing touches a wallet: `deriveLadders` takes its clock as an argument,
 * which is the whole reason a frozen capture can drive it.
 *
 * The two ladders that carry most of the weight, straight out of the fixture:
 *
 * ```
 * ETH  5 Sep   2420 · 2440 · 2460 · 2480 · 2550 · 2650      gaps 20 20 20 70 100
 * BTC  5 Sep   78500 · 79000 · 79500 · 80000 · 81000 ·      gaps 500 500 500
 *              81500 · 85000 · 86000 · 87000                     1000 500 3500 1000 1000
 * ```
 *
 * Spot on the capture is ETH 2522.13 and BTC 81004.04. Both ladders are
 * irregular, and BTC's is the textbook case: $500 rungs around spot, a $3,500
 * jump once you are far out of the money.
 *
 * @see plan7-box-builder-arena.md §9
 * @see src/data/box.ts
 * @see src/data/condor.ts
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { validateCondor, validateRanger } from "@thetanuts-finance/thetanuts-client";
import {
  MIN_LADDER_STRIKES,
  boxProblem,
  defaultWing,
  deriveLadder,
  deriveLadders,
  formatStrike,
  isPlayable,
  ladderBounds,
  ladderIndex,
  liveExpiries,
  minBoxHeight,
  parseStrike,
  priceToStrike,
  snapBox,
  snapPrice,
  snapStrike,
  snapWing,
  strikeUsd,
  wingCandidates,
  wingLandsOnLadder,
  type Box,
  type LadderOrder,
  type LadderSnapshot,
  type StrikeLadder,
} from "../src/data/box.ts";
import {
  CONDOR_UNDERLYINGS,
  boxToCondor,
  condorEconomics,
  condorPayoff,
  condorStrikeNumbers,
  isCondorUnderlying,
  maxPayout,
  payoutMultiple,
  validateSpec,
  wingUsd,
  type CondorSpec,
} from "../src/data/condor.ts";
import {
  RANGER_PAYOUT_TYPE,
  RANGER_PRODUCT,
  isListedRanger,
  isTakerBuyable,
  listedZones,
  matchListedZone,
  matchListedZones,
  productOf,
  rangerStrikeNumbers,
  validateRangerSpec,
  zoneBox,
  zoneCoversSpot,
  zoneEconomics,
  zonePayoff,
  zoneQuote,
  zoneStrikes,
  zoneToRanger,
  zoneWingUsd,
  zonesFor,
  type ListedZone,
  type RangerSpec,
} from "../src/data/ranger.ts";
import type { FillableOrder } from "../src/types.ts";

const FIXTURE = (await Bun.file(join(import.meta.dir, "fixtures", "orders.json")).json()) as
  LadderSnapshot & { prices: Record<string, number> };

/**
 * The compile-time half of the contract: the repo's shared order vocabulary is
 * assignable to the shape the ladder reads, with no adapter. If someone
 * narrows `FillableOrder`, this line fails `tsc` before any test runs.
 */
const _VOCABULARY: LadderOrder = {} as FillableOrder;
void _VOCABULARY;

const ETH_5SEP = 1788595200; // 2026-09-05T08:00:00Z
const ETH_6SEP = 1788681600;
const ETH_11SEP = 1789113600;
const ETH_18SEP = 1789718400;
const BTC_25SEP = 1790323200;

/** A deep clone, so a mutation in one test cannot leak into another. */
const clone = (): LadderSnapshot & { prices: Record<string, number> } => structuredClone(FIXTURE);

const usd = (ladder: StrikeLadder): readonly number[] => ladder.prices;

function ladder(underlying: string, expiry: number): StrikeLadder {
  const found = deriveLadder(FIXTURE, underlying, expiry);
  if (!found) throw new Error(`no ladder for ${underlying} ${expiry}`);
  return found;
}

const ETH = () => ladder("ETH", ETH_5SEP);
const BTC = () => ladder("BTC", ETH_5SEP);

/** All ladders on the fixture that can actually hold a box. */
const playableLadders = (): readonly StrikeLadder[] =>
  deriveLadders(FIXTURE).filter(
    (l) => l.strikes.length >= MIN_LADDER_STRIKES && isCondorUnderlying(l.underlying),
  );

// ─────────────────────────────────────────────────────────────────────────────
// 1. The ladder is derived from the live book, and everything else from it
// ─────────────────────────────────────────────────────────────────────────────

describe("the ladder", () => {
  test("is the strikes that carry live orders, ascending and deduplicated", () => {
    expect(usd(ETH())).toEqual([2420, 2440, 2460, 2480, 2550, 2650]);
  });

  test("a multi-leg order contributes every strike it quotes", () => {
    // BTC 5 Sep carries a four-strike order at [79500, 80000, 81000, 81500] and
    // a three-strike at [85000, 86000, 87000]. All seven levels are places the
    // venue has a price, so all seven are rungs.
    expect(usd(BTC())).toEqual([78500, 79000, 79500, 80000, 81000, 81500, 85000, 86000, 87000]);
  });

  test("deduplicates: 79500 is quoted by a single-leg and a four-leg order", () => {
    const rungs = usd(BTC());
    expect(rungs.filter((p) => p === 79500)).toHaveLength(1);
  });

  test("prices are derived from strikes, in the same order — one y-axis", () => {
    // plan7 §2.5: derive the ladder first, then fit the chart to it. `prices`
    // is not a second computation of the scale, it is the same numbers.
    for (const l of deriveLadders(FIXTURE)) {
      expect(l.prices).toEqual(l.strikes.map((s) => strikeUsd(s) as number));
      expect(l.prices).toHaveLength(l.strikes.length);
    }
  });

  test("ladderBounds is the ladder's own extent, so the chart cannot drift", () => {
    expect(ladderBounds(ETH())).toEqual({ lo: 2420, hi: 2650 });
  });

  test("an order with no remaining size is not a rung", () => {
    const snap = clone();
    for (const o of snap.orders ?? []) {
      const strikes = o.rawApiData?.strikes ?? [];
      if (strikes.includes("265000000000")) (o as { availableAmount?: string }).availableAmount = "0";
    }
    expect(usd(deriveLadder(snap, "ETH", ETH_5SEP) as StrikeLadder)).not.toContain(2650);
  });

  test("a stale signature is not a rung, once a clock is supplied", () => {
    // Every order in the capture has `orderExpiryTimestamp` 1788514414. A clock
    // past it empties the book: filling a stale order reverts
    // `Signer Not Authorized`, so those strikes are not tradable levels.
    expect(deriveLadders(FIXTURE, 1788514415_000)).toEqual([]);
    expect(deriveLadders(FIXTURE, 1788514413_000).length).toBeGreaterThan(0);
  });

  test("garbage degrades to an empty list rather than throwing", () => {
    expect(deriveLadders(null)).toEqual([]);
    expect(deriveLadders({})).toEqual([]);
    expect(deriveLadders({ orders: null, chainConfig: { priceFeeds: {} } })).toEqual([]);
    expect(deriveLadder(undefined, "ETH", ETH_5SEP)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The time axis is discrete, short, and comes from the book
// ─────────────────────────────────────────────────────────────────────────────

describe("live expiries", () => {
  test("are the book's real expiries — tomorrow, the day after, then weeklies", () => {
    // plan7 §2.2. Not eight evenly spaced daily columns, and no 2h or 4h option.
    expect(liveExpiries(FIXTURE, "ETH")).toEqual([ETH_5SEP, ETH_6SEP, ETH_11SEP, ETH_18SEP]);
  });

  test("an expiry quoting a single strike is not offered — it cannot hold a box", () => {
    // BTC 18 Sep carries exactly one strike (74000) in the trimmed capture, so
    // it is a column with no floor-and-ceiling in it. The live book has more;
    // the fixture is 30 of 426 orders, and the rule is what is under test.
    const oneRung = deriveLadder(FIXTURE, "BTC", ETH_18SEP);
    expect(oneRung?.strikes).toHaveLength(1);
    expect(liveExpiries(FIXTURE, "BTC")).not.toContain(ETH_18SEP);
    expect(liveExpiries(FIXTURE, "BTC")).toEqual([ETH_5SEP, ETH_6SEP, ETH_11SEP, BTC_25SEP]);
  });

  test("an unlisted underlying has no expiries at all", () => {
    expect(liveExpiries(FIXTURE, "SUI")).toEqual([]);
    expect(liveExpiries(FIXTURE, "DOGE")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Snapping — irregular, because the ladder is
// ─────────────────────────────────────────────────────────────────────────────

describe("snapping", () => {
  test("an irregular ladder snaps irregularly — no constant increment anywhere", () => {
    // plan7 §9. The same $10 of drag either side of 2480 does completely
    // different things, because the rung above it is $70 away and the rung
    // below it is $20 away.
    const l = ETH();
    expect(snapPrice(l, 2470)).toBe(priceToStrike(2460)); // tie at 2460/2480 → lower
    expect(snapPrice(l, 2471)).toBe(priceToStrike(2480));
    expect(snapPrice(l, 2500)).toBe(priceToStrike(2480)); // $20 of travel
    expect(snapPrice(l, 2540)).toBe(priceToStrike(2550)); // $10 of travel
    expect(snapPrice(l, 2600)).toBe(priceToStrike(2550)); // $50 of travel, tie → lower
    expect(snapPrice(l, 2601)).toBe(priceToStrike(2650));

    // The proof it is not a constant increment: the distances travelled by a
    // single sweep of prices take more than one value.
    const travelled = new Set<number>();
    for (let p = 2420; p <= 2650; p += 10) {
      const landed = strikeUsd(snapPrice(l, p) as string) as number;
      travelled.add(Math.abs(landed - p));
    }
    expect(travelled.size).toBeGreaterThan(2);
  });

  test("BTC's $3,500 gap snaps nothing like its $500 gaps", () => {
    const l = BTC();
    expect(snapPrice(l, 80900)).toBe(priceToStrike(81000)); // $100
    expect(snapPrice(l, 83000)).toBe(priceToStrike(81500)); // $1,500
    expect(snapPrice(l, 83249)).toBe(priceToStrike(81500));
    expect(snapPrice(l, 83251)).toBe(priceToStrike(85000));
  });

  test("prices outside the ladder clamp to its ends rather than inventing a rung", () => {
    const l = ETH();
    expect(snapPrice(l, 1)).toBe(priceToStrike(2420));
    expect(snapPrice(l, 99999)).toBe(priceToStrike(2650));
  });

  test("ties resolve downward, deterministically, on every machine", () => {
    const l = ETH();
    for (let i = 0; i < 5; i++) expect(snapPrice(l, 2430)).toBe(priceToStrike(2420));
  });

  test("snapStrike rejects a non-8dp string rather than guessing its scale", () => {
    expect(snapStrike(ETH(), "2650.5")).toBeNull();
    expect(snapStrike(ETH(), "not a strike")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The minimum box height is a fact about the book
// ─────────────────────────────────────────────────────────────────────────────

describe("minimum box height", () => {
  test("is one rung of the local ladder, and therefore not a constant", () => {
    // plan7 §9: derived from the live ladder, not a constant. Three different
    // answers on one ladder at one instant.
    const l = ETH();
    const at = (p: number) => strikeUsd(minBoxHeight(l, priceToStrike(p)) as string);
    expect(at(2420)).toBe(20);
    expect(at(2460)).toBe(20);
    expect(at(2480)).toBe(70);
    expect(at(2550)).toBe(100);
  });

  test("is tighter where the market is liquid and coarse where it is not", () => {
    // BTC spot on the capture is 81004.04. The rungs around it are $500 apart;
    // out at 81500, where nobody is quoting, the next rung is $3,500 away.
    // Precision is available exactly where the market is (plan7 §2.4).
    const l = BTC();
    const at = (p: number) => strikeUsd(minBoxHeight(l, priceToStrike(p)) as string) as number;
    const spot = FIXTURE.prices.BTC as number;
    expect(spot).toBeCloseTo(81004.04, 2);
    expect(at(81000)).toBe(500);
    expect(at(81500)).toBe(3500);
    expect(at(81000)).toBeLessThan(at(81500));
  });

  test("the ladder's own heights take more than one value on every fixture ladder", () => {
    const heights = new Set<string>();
    for (const l of playableLadders()) {
      for (const s of l.strikes) {
        const h = minBoxHeight(l, s);
        if (h !== null) heights.add(h);
      }
    }
    expect(heights.size).toBeGreaterThan(1);
  });

  test("the top rung has no box above it", () => {
    expect(minBoxHeight(ETH(), priceToStrike(2650))).toBeNull();
    expect(minBoxHeight(ETH(), priceToStrike(9999))).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. snapBox — the whole drag, made real
// ─────────────────────────────────────────────────────────────────────────────

describe("snapBox", () => {
  const raw = (over: Partial<Box> = {}): Box => ({
    underlying: "ETH",
    floor: priceToStrike(2495) as string,
    ceiling: priceToStrike(2560) as string,
    wing: "",
    expiry: ETH_5SEP,
    ...over,
  });

  test("puts both edges on live strikes", () => {
    const b = snapBox(raw(), ETH());
    expect(strikeUsd(b.floor)).toBe(2480);
    expect(strikeUsd(b.ceiling)).toBe(2550);
    expect(ladderIndex(ETH(), b.floor)).toBeGreaterThanOrEqual(0);
    expect(ladderIndex(ETH(), b.ceiling)).toBeGreaterThanOrEqual(0);
  });

  test("takes the expiry from the ladder, so no free-dragged date can be submitted", () => {
    // plan7 §2.2 and §9. Not a validation that rejects a bad date — there is no
    // path from a dragged date to an expiry at all.
    const dragged = snapBox(raw({ expiry: 1788600000 }), ETH());
    expect(dragged.expiry).toBe(ETH_5SEP);
    expect(liveExpiries(FIXTURE, "ETH")).toContain(dragged.expiry);

    const other = snapBox(raw({ expiry: 0 }), ladder("ETH", ETH_11SEP));
    expect(other.expiry).toBe(ETH_11SEP);
  });

  test("takes the underlying from the ladder too", () => {
    expect(snapBox(raw({ underlying: "SUI" }), ETH()).underlying).toBe("ETH");
  });

  test("enforces the minimum height by pushing the ceiling up one rung", () => {
    const collapsed = snapBox(raw({ floor: priceToStrike(2460) as string, ceiling: priceToStrike(2461) as string }), ETH());
    expect(strikeUsd(collapsed.floor)).toBe(2460);
    expect(strikeUsd(collapsed.ceiling)).toBe(2480);
    // ...and the height it landed on is exactly the local minimum.
    expect(minBoxHeight(ETH(), collapsed.floor)).toBe(
      formatStrike((parseStrike(collapsed.ceiling) as bigint) - (parseStrike(collapsed.floor) as bigint)),
    );
  });

  test("an inverted box is righted, not rejected", () => {
    const flipped = snapBox(raw({ floor: priceToStrike(2650) as string, ceiling: priceToStrike(2420) as string }), ETH());
    expect(strikeUsd(flipped.floor)).toBeLessThan(strikeUsd(flipped.ceiling) as number);
  });

  test("a box collapsed onto the top rung is pulled down instead", () => {
    const top = snapBox(raw({ floor: priceToStrike(2650) as string, ceiling: priceToStrike(2650) as string }), ETH());
    expect(strikeUsd(top.floor)).toBe(2550);
    expect(strikeUsd(top.ceiling)).toBe(2650);
  });

  test("unparseable edges fall back to the ladder's extremes, never to a guess", () => {
    const junk = snapBox(raw({ floor: "", ceiling: "nonsense" }), ETH());
    expect(strikeUsd(junk.floor)).toBe(2420);
    expect(strikeUsd(junk.ceiling)).toBe(2650);
  });

  test("is idempotent — snapping a snapped box changes nothing", () => {
    const once = snapBox(raw(), ETH());
    expect(snapBox(once, ETH())).toEqual(once);
  });

  test("a ladder too thin for a box still corrects underlying and expiry", () => {
    const thin = deriveLadder(FIXTURE, "BTC", ETH_18SEP) as StrikeLadder;
    const b = snapBox(raw(), thin);
    expect(b.underlying).toBe("BTC");
    expect(b.expiry).toBe(ETH_18SEP);
    expect(isPlayable(b, thin)).toBe(false);
    expect(boxProblem(b, thin)).toBe("this expiry has no strike ladder");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Wings — auto-set, but never hidden
// ─────────────────────────────────────────────────────────────────────────────

describe("wings", () => {
  test("are auto-set and surfaced on the box, not swallowed", () => {
    // plan7 §4.2: hiding the handle is fine, hiding the consequence is not.
    const b = snapBox(
      { underlying: "ETH", floor: "", ceiling: "", wing: "", expiry: 0 },
      ETH(),
    );
    expect(b.wing).not.toBe("");
    expect(strikeUsd(b.wing)).toBeGreaterThan(0);
  });

  test("the default is the larger of one local increment and a quarter of the zone", () => {
    const l = ETH();
    // A $20 zone in the dense part: a quarter of it is $5, one rung is $20.
    // The rung wins, because $5 is not a width this ladder can express.
    const tight = defaultWing(l, priceToStrike(2440), priceToStrike(2460));
    expect(strikeUsd(tight as string)).toBe(20);
    // A $230 zone spanning the whole ladder: a quarter is $57.50 and there is
    // no rung outside it, so the zone width itself is the only ladder-derived
    // answer left.
    const wide = defaultWing(l, priceToStrike(2420), priceToStrike(2650));
    expect(strikeUsd(wide as string)).toBe(230);
  });

  test("candidates are real ladder distances, never a constant tick", () => {
    const l = ETH();
    const widths = wingCandidates(l, priceToStrike(2480), priceToStrike(2550)).map(
      (w) => strikeUsd(w) as number,
    );
    // Down from 2480: 60, 40, 20. Up from 2550: 100. Irregular, and derived.
    expect(widths).toEqual([20, 40, 60, 100]);
  });

  test("a requested wing snaps to the nearest candidate", () => {
    const l = ETH();
    const snapped = snapWing(l, priceToStrike(2480), priceToStrike(2550), priceToStrike(45));
    expect(strikeUsd(snapped as string)).toBe(40);
  });

  test("wingLandsOnLadder distinguishes a fully-listed condor from a free-drawn one", () => {
    const l = ETH();
    // 2460 ± ... : down 40 lands on 2420, up 40 from 2480 lands nowhere.
    expect(wingLandsOnLadder(l, priceToStrike(2460), priceToStrike(2480), priceToStrike(40))).toBe(false);
    // 2440 → 2420 down 20, and 2460 → 2480 up 20. All four on the ladder.
    expect(wingLandsOnLadder(l, priceToStrike(2440), priceToStrike(2460), priceToStrike(20))).toBe(true);
  });

  test("both wings are equal by construction, in exact integer arithmetic", () => {
    for (const l of playableLadders()) {
      for (const b of reachableBoxes(l)) {
        const spec = boxToCondor(b);
        const [s1, s2, s3, s4] = spec.strikes.map((s) => parseStrike(s) as bigint);
        expect((s2 as bigint) - (s1 as bigint)).toBe((s4 as bigint) - (s3 as bigint));
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The property test — every reachable box is a condor the chain accepts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every box a player can actually end up holding on this ladder.
 *
 * "Reachable" means *the output of `snapBox`*, because there is no other way to
 * make a box: every floor/ceiling pair on the ladder, crossed with every wing
 * the ladder can express plus the auto-set default plus a few inputs that do
 * not parse. That is the whole reachable surface, not a sample of it.
 */
function reachableBoxes(l: StrikeLadder): readonly Box[] {
  const out: Box[] = [];
  for (let fi = 0; fi < l.strikes.length; fi++) {
    for (let ci = 0; ci < l.strikes.length; ci++) {
      const floor = l.strikes[fi] as string;
      const ceiling = l.strikes[ci] as string;
      const wings = ["", "junk", ...wingCandidates(l, floor, ceiling)];
      for (const wing of wings) {
        out.push(
          snapBox(
            { underlying: "ZZZ", floor, ceiling, wing, expiry: 1 },
            l,
          ),
        );
      }
    }
  }
  return out;
}

/** A tiny deterministic LCG — a fuzz that is the same on every machine. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe("boxToCondor passes the SDK's own validateCondor", () => {
  test("for every reachable box on every fixture ladder", () => {
    // plan7 §9. `validateCondor` is a NAMED export — it is not on
    // `client.utils` — and it checks `strikes[1] - strikes[0] === strikes[3] -
    // strikes[2]` within a 1e-4 float tolerance. Our construction does not need
    // the tolerance, which is what this test is really proving.
    let checked = 0;
    for (const l of playableLadders()) {
      for (const b of reachableBoxes(l)) {
        const spec = boxToCondor(b);
        const result = validateCondor(condorStrikeNumbers(spec));
        expect(result.valid).toBe(true);
        expect(validateSpec(spec).valid).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  test("for a seeded fuzz of raw drags, snapped", () => {
    const random = lcg(0x7ec0ffee);
    for (const l of playableLadders()) {
      const bounds = ladderBounds(l);
      if (!bounds) continue;
      const span = bounds.hi - bounds.lo;
      for (let i = 0; i < 200; i++) {
        // Deliberately over-shoot the ladder on both sides, and sometimes
        // invert the box, because a drag can do both.
        const a = bounds.lo - span + random() * span * 3;
        const c = bounds.lo - span + random() * span * 3;
        const b = snapBox(
          {
            underlying: "",
            floor: priceToStrike(a) as string,
            ceiling: priceToStrike(c) as string,
            wing: random() < 0.5 ? "" : (priceToStrike(random() * span) as string),
            expiry: Math.floor(random() * 2_000_000_000),
          },
          l,
        );
        expect(isPlayable(b, l)).toBe(true);
        expect(validateCondor(condorStrikeNumbers(boxToCondor(b))).valid).toBe(true);
      }
    }
  });

  test("the four strikes are strictly ascending and positive", () => {
    for (const l of playableLadders()) {
      for (const b of reachableBoxes(l)) {
        const nums = condorStrikeNumbers(boxToCondor(b));
        expect(nums[0]).toBeGreaterThan(0);
        for (let i = 1; i < nums.length; i++) {
          expect(nums[i] as number).toBeGreaterThan(nums[i - 1] as number);
        }
      }
    }
  });

  test("the box's floor and ceiling are s2 and s3, exactly", () => {
    const b = snapBox(
      {
        underlying: "ETH",
        floor: priceToStrike(2480) as string,
        ceiling: priceToStrike(2550) as string,
        wing: priceToStrike(20) as string,
        expiry: 0,
      },
      ETH(),
    );
    const spec = boxToCondor(b);
    expect(condorStrikeNumbers(spec)).toEqual([2460, 2480, 2550, 2570]);
  });

  test("throws rather than returning a wrong instrument", () => {
    const good = snapBox(
      { underlying: "ETH", floor: "", ceiling: "", wing: "", expiry: 0 },
      ETH(),
    );
    expect(() => boxToCondor({ ...good, underlying: "SUI" })).toThrow(/no condor market/);
    expect(() => boxToCondor({ ...good, wing: "" })).toThrow(/8dp decimal strings/);
    expect(() => boxToCondor({ ...good, ceiling: good.floor })).toThrow(/above the floor/);
    expect(() => boxToCondor({ ...good, wing: priceToStrike(99999) as string })).toThrow(
      /wider than the floor/,
    );
    expect(() => boxToCondor({ ...good, expiry: 0 })).toThrow(/unix seconds/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. isPlayable — and the reason, so the UI can say why
// ─────────────────────────────────────────────────────────────────────────────

describe("isPlayable", () => {
  const good = (): Box =>
    snapBox({ underlying: "ETH", floor: "", ceiling: "", wing: "", expiry: 0 }, ETH());

  test("accepts what snapBox produced", () => {
    expect(isPlayable(good(), ETH())).toBe(true);
    expect(boxProblem(good(), ETH())).toBeNull();
  });

  test("rejects an underlying with no condor market, and says which", () => {
    // plan7 §2.1: ETH and BTC ship; other qualified assets render greyed with a
    // reason. SUI is not a Thetanuts asset and appears nowhere in the source.
    const sui: StrikeLadder = { ...ETH(), underlying: "SUI" };
    const b = { ...good(), underlying: "SUI" };
    expect(isPlayable(b, sui)).toBe(false);
    expect(boxProblem(b, sui)).toBe("SUI has no condor market — ETH and BTC only");
  });

  test("rejects an off-ladder edge", () => {
    const b = { ...good(), floor: priceToStrike(2500) as string };
    expect(boxProblem(b, ETH())).toBe("the floor is not a live strike");
  });

  test("rejects an expiry that is not this column's", () => {
    expect(boxProblem({ ...good(), expiry: ETH_6SEP }, ETH())).toBe(
      "the expiry is not this column's expiry",
    );
  });

  test("rejects a missing wing", () => {
    expect(boxProblem({ ...good(), wing: "" }, ETH())).toBe("the wing width is not set");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Long only — asserted at the type level and grepped for at the file level
// ─────────────────────────────────────────────────────────────────────────────

const SOURCES = {
  "src/data/box.ts": await Bun.file(join(import.meta.dir, "..", "src", "data", "box.ts")).text(),
  "src/data/condor.ts": await Bun.file(
    join(import.meta.dir, "..", "src", "data", "condor.ts"),
  ).text(),
  "src/data/ranger.ts": await Bun.file(
    join(import.meta.dir, "..", "src", "data", "ranger.ts"),
  ).text(),
} as const;

/** Comments stripped, so prose about a rule cannot be mistaken for the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("long only", () => {
  test("the spec's side is the literal `true`, so a short leg cannot be spelled", () => {
    const spec = boxToCondor(
      snapBox({ underlying: "ETH", floor: "", ceiling: "", wing: "", expiry: 0 }, ETH()),
    );
    expect(spec.isLong).toBe(true);
    expect(spec.product).toBe("CALL_CONDOR");

    // plan7 §5, at compile time: this line is an error, and `tsc` proves it.
    // @ts-expect-error a CondorSpec cannot be short
    const short: CondorSpec = { ...spec, isLong: false };
    void short;
  });

  test("no source line constructs a sell side", () => {
    for (const [name, src] of Object.entries(SOURCES)) {
      const body = code(src);
      expect(body, name).not.toMatch(/isLong\s*:\s*false/);
      expect(body, name).not.toMatch(/isBuyer\s*:\s*true/);
      expect(body, name).not.toMatch(/["']SELL["']/);
      expect(body, name).not.toMatch(/\bshort\b/i);
    }
  });

  test("neither file reaches for the seller's collateral formula", () => {
    // plan7 §5: `(s2 − s1) × numContracts` is the SELLER's obligation. If we
    // find ourselves reading it for a buy, something is wrong.
    for (const [name, src] of Object.entries(SOURCES)) {
      expect(code(src), name).not.toMatch(/calculateCollateral/);
    }
  });

  test("max loss is the premium, always", () => {
    const spec = boxToCondor(
      snapBox({ underlying: "ETH", floor: "", ceiling: "", wing: "", expiry: 0 }, ETH()),
    );
    for (const premium of [0.11, 1.5, 2]) {
      expect(condorEconomics(spec, premium, 1).maxLoss).toBe(premium);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. The payout multiple is computed, never invented
// ─────────────────────────────────────────────────────────────────────────────

describe("the payout multiple", () => {
  const spec = (): CondorSpec =>
    boxToCondor(
      snapBox(
        {
          underlying: "ETH",
          floor: priceToStrike(2440) as string,
          ceiling: priceToStrike(2460) as string,
          wing: priceToStrike(20) as string,
          expiry: 0,
        },
        ETH(),
      ),
    );

  test("is max payout over premium paid, and nothing else", () => {
    const s = spec();
    expect(wingUsd(s)).toBe(20);
    expect(maxPayout(s, 1)).toBe(20);
    expect(payoutMultiple(s, 2, 1)).toBe(10);
    expect(payoutMultiple(s, 5, 1)).toBe(4);
    // Same box, cheaper premium, higher multiple — because the market charged
    // less, not because anything here decided it should.
    expect(payoutMultiple(s, 1, 1)).toBeGreaterThan(payoutMultiple(s, 2, 1) as number);
  });

  test("is null before a real premium exists — no placeholder", () => {
    expect(payoutMultiple(spec(), 0, 1)).toBeNull();
    expect(payoutMultiple(spec(), Number.NaN, 1)).toBeNull();
    expect(condorEconomics(spec(), 0, 1).payoutMultiple).toBeNull();
  });

  test("difficulty shading cannot reach it — there is no tier argument to pass", () => {
    // plan7 §4.4: shading is styling over the number, never an input to it.
    expect(payoutMultiple.length).toBe(3); // spec, premiumPaid, numContracts
    for (const [name, src] of Object.entries(SOURCES)) {
      const body = code(src);
      expect(body, name).not.toMatch(/\bTIER_BANDS\b/);
      expect(body, name).not.toMatch(/\bDEGEN\b|\bSHARP\b/);
    }
  });

  test("no hardcoded rate hides in either source file", () => {
    // Comments stripped, array indices stripped, then: no payout-ish
    // identifier may sit on a line with a numeric literal of 2 or more.
    for (const [name, src] of Object.entries(SOURCES)) {
      const body = code(src).replace(/\[\s*\d+\s*\]/g, "[]");
      for (const line of body.split("\n")) {
        if (!/\b(payout|multiple|multiplier|payback|reward|rate)\b/i.test(line)) continue;
        expect(line, `${name}: ${line.trim()}`).not.toMatch(/(?<![\w.])\d+(\.\d+)?(?![\w.])/);
      }
    }
  });

  test("the multiple is a division by the premium argument", () => {
    expect(code(SOURCES["src/data/condor.ts"])).toMatch(/ceiling\s*\/\s*premiumPaid/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. The payoff shape — terminal, and flat across the box
// ─────────────────────────────────────────────────────────────────────────────

describe("condorPayoff", () => {
  const s = (): CondorSpec =>
    boxToCondor(
      snapBox(
        {
          underlying: "ETH",
          floor: priceToStrike(2480) as string,
          ceiling: priceToStrike(2550) as string,
          wing: priceToStrike(20) as string,
          expiry: 0,
        },
        ETH(),
      ),
    );

  test("is flat and maximal across the box, and the maximum is the wing", () => {
    const spec = s(); // [2460, 2480, 2550, 2570]
    expect(condorPayoff(spec, 2480)).toBe(20);
    expect(condorPayoff(spec, 2515)).toBe(20);
    expect(condorPayoff(spec, 2550)).toBe(20);
    expect(maxPayout(spec, 1)).toBe(20);
  });

  test("decays linearly through the wings and is worth nothing outside them", () => {
    const spec = s();
    expect(condorPayoff(spec, 2470)).toBeCloseTo(10, 8);
    expect(condorPayoff(spec, 2560)).toBeCloseTo(10, 8);
    expect(condorPayoff(spec, 2460)).toBe(0);
    expect(condorPayoff(spec, 2570)).toBe(0);
    expect(condorPayoff(spec, 1)).toBe(0);
    expect(condorPayoff(spec, 99999)).toBe(0);
  });

  test("never exceeds the wing anywhere on the ladder", () => {
    for (const l of playableLadders()) {
      const bounds = ladderBounds(l);
      if (!bounds) continue;
      for (const b of reachableBoxes(l)) {
        const spec = boxToCondor(b);
        const cap = wingUsd(spec);
        for (let i = 0; i <= 40; i++) {
          const p = bounds.lo + ((bounds.hi - bounds.lo) * i) / 40;
          expect(condorPayoff(spec, p)).toBeLessThanOrEqual(cap + 1e-6);
          expect(condorPayoff(spec, p)).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 12. Purity — fixture-driven, no network, no wallet, no clock
// ─────────────────────────────────────────────────────────────────────────────

describe("purity", () => {
  test("neither source reads a clock, a socket, or a wallet", () => {
    for (const [name, src] of Object.entries(SOURCES)) {
      const body = code(src);
      expect(body, name).not.toMatch(/Date\.now|new Date\b/);
      expect(body, name).not.toMatch(/Math\.random/);
      expect(body, name).not.toMatch(/\bfetch\s*\(|WebSocket|localStorage/);
      expect(body, name).not.toMatch(/thetanuts-client|ethers|getSigner/);
    }
  });

  test("the same book and the same drag give the same box, every time", () => {
    const drag: Box = {
      underlying: "",
      floor: priceToStrike(2493.7) as string,
      ceiling: priceToStrike(2588.2) as string,
      wing: "",
      expiry: 12345,
    };
    const first = snapBox(drag, ladder("ETH", ETH_5SEP));
    for (let i = 0; i < 5; i++) {
      expect(snapBox(drag, deriveLadder(clone(), "ETH", ETH_5SEP) as StrikeLadder)).toEqual(first);
    }
  });

  test("SUI is never a value in either source file", () => {
    // plan7 §9: SUI is not a Thetanuts asset and must appear nowhere. Comments
    // stripped, because the prohibition is written down in `condor.ts` and a
    // rule that names the thing it forbids is not a listing of it.
    for (const [name, src] of Object.entries(SOURCES)) {
      expect(code(src), name).not.toMatch(/\bSUI\b/);
    }
    expect(CONDOR_UNDERLYINGS).toEqual(["ETH", "BTC"]);
    expect(isCondorUnderlying("SUI")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 13. The listed zone — plan7 §3.1, with the instrument that actually exists
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chain's own implementation registry, restricted to the seven addresses
 * this fixture uses.
 *
 * **Why it is here and not in the fixture.** `chainConfig.optionImplementations`
 * is 46 lowercase-keyed entries on the live client, and the frozen capture
 * predates our reading it (`test/fixtures/orders.json` carries `priceFeeds`,
 * `contracts` and `tokens` only). The names below are the chain's, recorded in
 * `docs/plan7-measurements.md` §"Addresses this document refers to" and in
 * `tnuts-test/FINDINGS.md`: `RANGER` is `0x9980ec85…`, `CALL_CONDOR` is
 * `0x14476CF2…`.
 *
 * Keys are lowercase because that is how the SDK ships the map — `productOf`
 * lowercases what it is given, and a registry keyed the other way resolves
 * nothing.
 */
const REGISTRY = {
  "0x9980ec85bc6fe07340adb36c76fa093bb6d4fcbc": { name: "RANGER" },
  "0x051791df68223ae173fade5217c48875e36eef61": { name: "PUT" },
  "0x7355eb92dfb0503db558a70c10843618932ab290": { name: "PUT" },
  "0x8c56100cae246f7daa4bc1ec4d1477d71178c563": { name: "PHYSICAL_CALL" },
  "0x6ad53dd058bea004829ccf58a282c21a7df02dca": { name: "PHYSICAL_PUT" },
  "0xfaed63f7040e65b79cf0ae29706fdc423ee249a9": { name: "CALL_SPREAD" },
  "0xa1d5f6b16a2e7f298f8d2cdf78f7779b4a20c4c2": { name: "CALL_FLY" },
} as const;

/** `CALL_CONDOR` on Base — used only to prove the *label* decides, not the strikes. */
const CONDOR_IMPL = "0x14476CF2ea9F7C448100F061670E390f17c78817";
/** The address the two four-strike orders in the fixture actually name. */
const RANGER_IMPL = "0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc";

/** The fixture, plus the registry it was captured without. */
function booked(
  registry: Record<string, { name?: string | null }> | undefined = REGISTRY,
): LadderSnapshot {
  const snap = clone();
  return { ...snap, chainConfig: { ...snap.chainConfig, optionImplementations: registry } };
}

/** The fixture's four-strike orders — both are BTC RANGERs. */
const rangerRows = (snap: LadderSnapshot): LadderOrder[] =>
  (snap.orders ?? []).filter((o) => (o?.rawApiData?.strikes ?? []).length === 4) as LadderOrder[];

// One 08:00Z expiry, both assets — the book's own dates, named once each.
const BTC_5SEP = ETH_5SEP;
const BTC_6SEP = ETH_6SEP;

/** The box that lands exactly on the fixture's listed zone. */
const onZone = (expiry = BTC_5SEP): Box => ({
  underlying: "BTC",
  floor: priceToStrike(80_000) as string,
  ceiling: priceToStrike(81_000) as string,
  wing: priceToStrike(500) as string,
  expiry,
});

describe("resolving the product", () => {
  test("comes from the implementation address, never from the strikes", () => {
    const snap = booked();
    const [first] = rangerRows(snap);
    expect(first?.rawApiData?.implementation?.toLowerCase()).toBe(RANGER_IMPL.toLowerCase());
    expect(productOf(first?.rawApiData?.implementation, REGISTRY)).toBe(RANGER_PRODUCT);
    expect(isListedRanger(first, REGISTRY)).toBe(true);
  });

  test("the strikes cannot tell the two apart — the SDK's own checkers agree", () => {
    // This is the whole reason the registry exists. `validateCondor` and
    // `validateRanger` are both real named exports of the shipped 0.3.0, and on
    // the fixture's four strikes they return the identical answer. A heuristic
    // over these numbers is our own arithmetic read back to us
    // (`docs/reviews/mcp-crosscheck.md` §BUG-2).
    const strikes = (rangerRows(booked())[0]?.rawApiData?.strikes ?? []).map(
      (s) => strikeUsd(s) as number,
    );
    expect(strikes).toEqual([79_500, 80_000, 81_000, 81_500]);
    expect(validateRanger(strikes).valid).toBe(true);
    expect(validateCondor(strikes).valid).toBe(true);
  });

  test("relabelling the same order a condor empties the listed book", () => {
    // Byte for byte the same strikes, the same size, the same expiry. Only the
    // implementation address moves, and the listed path goes with it.
    const snap = booked();
    for (const row of rangerRows(snap)) {
      if (row.rawApiData) row.rawApiData.implementation = CONDOR_IMPL;
    }
    const relabelled = {
      ...snap,
      chainConfig: {
        ...snap.chainConfig,
        optionImplementations: {
          ...REGISTRY,
          [CONDOR_IMPL.toLowerCase()]: { name: "CALL_CONDOR" },
        },
      },
    };
    expect(listedZones(relabelled).length).toBe(0);
    expect(matchListedZone(onZone(), relabelled)).toBeNull();
  });

  test("a label alone is not enough — the ranger invariants still run", () => {
    // The three-strike CALL_FLY, relabelled `RANGER`. The registry now says the
    // right word and the order is still not a zone, because four strikes with
    // equal wings and a gap between them is what a zone *is*.
    const snap = booked({
      ...REGISTRY,
      "0xa1d5f6b16a2e7f298f8d2cdf78f7779b4a20c4c2": { name: "RANGER" },
    });
    expect(listedZones(snap).length).toBe(2); // the two real ones, and no fly
    expect(listedZones(snap).every((z) => z.strikes.length === 4)).toBe(true);
  });

  test("no registry means no listed zones — never a guess", () => {
    // The shipped fixture, exactly as captured. Every one of these orders is
    // real and two of them are genuinely RANGERs; with nothing authoritative to
    // ask, the honest answer is that we cannot tell.
    expect(FIXTURE.chainConfig?.optionImplementations).toBeUndefined();
    expect(listedZones(FIXTURE).length).toBe(0);
    expect(matchListedZone(onZone(), FIXTURE)).toBeNull();
  });

  test("the zero address and an unknown deployment both answer null", () => {
    expect(productOf("0x0000000000000000000000000000000000000000", REGISTRY)).toBeNull();
    expect(productOf("", REGISTRY)).toBeNull();
    expect(productOf(undefined, REGISTRY)).toBeNull();
    // A deployment newer than the map we were handed. This will happen.
    expect(productOf("0xdead000000000000000000000000000000000000", REGISTRY)).toBeNull();
  });
});

describe("the listed zones on the book", () => {
  test("are the two real RANGERs, read straight off the capture", () => {
    const zones = listedZones(booked());
    expect(zones.length).toBe(2);
    for (const z of zones) {
      expect(z.underlying).toBe("BTC");
      expect(strikeUsd(z.floor)).toBe(80_000);
      expect(strikeUsd(z.ceiling)).toBe(81_000);
      expect(zoneWingUsd(z)).toBe(500);
      // $10,000 of depth per order — 5,000x `MAX_FILL_USDC`. Depth is never the
      // constraint on this path; the ladder is.
      expect(z.availableAmount).toBe("10000000000");
    }
    expect(zones.map((z) => z.expiry)).toEqual([BTC_5SEP, BTC_6SEP]);
  });

  test("carry the caller's own order row, so the arena can quote and fill it", () => {
    // Identity, not a copy: `previewFillOrder` and `fillOrder` take the row.
    const snap = booked();
    const zone = listedZones(snap)[0] as ListedZone;
    expect(zone.order).toBe((snap.orders ?? [])[zone.index] as LadderOrder);
  });

  test("publish no greeks, and nothing here invents one", () => {
    // 0 of 38 listed zones on the live book carried greeks
    // (`docs/plan7-measurements.md` §3.2), so plan7 §2.4's `TIER_BANDS` delta
    // shading has nothing to read. The absence is structural: there is no field
    // on the object to hang a fabricated delta on.
    const zone = listedZones(booked())[0] as ListedZone;
    for (const key of Object.keys(zone)) {
      expect(key, key).not.toMatch(/delta|gamma|vega|theta|greek/i);
    }
    // …and no line of the module names one either.
    const body = code(SOURCES["src/data/ranger.ts"]);
    expect(body).not.toMatch(/\b(delta|gamma|vega|theta|greeks)\b/i);
    expect(body).not.toMatch(/\bTIER_BANDS\b/);
  });

  test("only the side the player can buy is offered", () => {
    // plan7 §5. `isLong === false` is the maker on the other side, so the taker
    // is the buyer — measured over 9,766 settled zone positions, never once the
    // other way (`docs/plan7-measurements.md` §3.2).
    const snap = booked();
    expect(rangerRows(snap).every((r) => isTakerBuyable(r))).toBe(true);
    for (const row of rangerRows(snap)) {
      if (row.rawApiData) row.rawApiData.isLong = true;
    }
    expect(rangerRows(snap).some((r) => isTakerBuyable(r))).toBe(false);
    expect(listedZones(snap).length).toBe(0);
  });

  test("an order with no size left is not a zone", () => {
    const snap = booked();
    for (const row of rangerRows(snap)) row.availableAmount = "0";
    expect(listedZones(snap).length).toBe(0);
  });

  test("liveness is judged by the ladder's own rule, so the two cannot disagree", () => {
    // The capture's signatures go stale at 1788514414. Past that instant the
    // ladder empties, and the listed zones must empty with it: a fill offered
    // on a column the chart is not drawing is worse than no fill at all.
    const after = 1_788_514_415_000;
    expect(deriveLadders(booked(), after).length).toBe(0);
    expect(listedZones(booked(), after).length).toBe(0);
  });

  test("zonesFor is the column the arena renders — and it is nearly always empty", () => {
    const snap = booked();
    expect(zonesFor(snap, "BTC", BTC_5SEP).length).toBe(1);
    expect(zonesFor(snap, "BTC", BTC_6SEP).length).toBe(1);
    // Every other column the fixture quotes lists nothing at all.
    expect(deriveLadders(snap).length).toBe(9);
    const covered = deriveLadders(snap).filter(
      (l) => zonesFor(snap, l.underlying, l.expiry).length > 0,
    );
    expect(covered.length).toBe(2);
    // ETH is the one that stings: the arena's default asset lists no zone at
    // all on this capture, so every ETH box has to be priced on demand.
    expect(zonesFor(snap, "ETH", ETH_5SEP).length).toBe(0);
  });
});

describe("matching a drawn box", () => {
  test("a box that lands on a listed zone finds it", () => {
    const snap = booked();
    const hit = matchListedZone(onZone(), snap);
    expect(hit).not.toBeNull();
    expect(hit?.expiry).toBe(BTC_5SEP);
    expect(hit?.order).toBe((snap.orders ?? [])[hit?.index as number] as LadderOrder);
  });

  test("a box that does not returns nothing, so the arena knows to ask a maker", () => {
    const snap = booked();
    const l = ladder("BTC", BTC_5SEP);
    // 79000–80000 is a perfectly good box: both edges are rungs of the live
    // ladder, one increment of the local grid apart. Nobody has listed it.
    const drawn = snapBox(
      {
        underlying: "BTC",
        floor: priceToStrike(79_000) as string,
        ceiling: priceToStrike(80_000) as string,
        wing: "",
        expiry: BTC_5SEP,
      },
      l,
    );
    expect(isPlayable(drawn, l)).toBe(true);
    expect(matchListedZone(drawn, snap)).toBeNull();
  });

  test("the match is exact on both edges — never nearest", () => {
    const snap = booked();
    const off = (floor: number, ceiling: number): Box => ({
      ...onZone(),
      floor: priceToStrike(floor) as string,
      ceiling: priceToStrike(ceiling) as string,
    });
    // One rung out at either end. On a $1,000 BTC grid "close enough" is a
    // thousand dollars of band, and a different instrument.
    expect(matchListedZone(off(79_500, 81_000), snap)).toBeNull();
    expect(matchListedZone(off(80_000, 81_500), snap)).toBeNull();
    expect(matchListedZone(off(80_000, 81_000), snap)).not.toBeNull();
  });

  test("the same band on another expiry or another asset is another instrument", () => {
    const snap = booked();
    expect(matchListedZone({ ...onZone(), expiry: ETH_11SEP }, snap)).toBeNull();
    expect(matchListedZone({ ...onZone(), underlying: "ETH" }, snap)).toBeNull();
    expect(matchListedZone({ ...onZone(), expiry: BTC_6SEP }, snap)?.expiry).toBe(BTC_6SEP);
  });

  test("the wing does not filter — it orders, because it is the maker's", () => {
    // The live book lists ETH 2400–2500 at two wing widths on one expiry. Here
    // the same shape: a second order on the same band, wings twice as wide.
    const snap = booked();
    const wide = structuredClone(rangerRows(snap)[0]) as LadderOrder;
    if (wide.rawApiData) {
      wide.rawApiData.strikes = [
        "7900000000000",
        "8000000000000",
        "8100000000000",
        "8200000000000",
      ];
    }
    const both = { ...snap, orders: [...(snap.orders ?? []), wide] };

    expect(matchListedZones(onZone(), both).length).toBe(2);
    // Ask with the narrow wing and the narrow zone comes first; ask with the
    // wide one and the wide zone does. A caller taking `[0]` is deterministic.
    expect(zoneWingUsd(matchListedZone(onZone(), both) as ListedZone)).toBe(500);
    const wider: Box = { ...onZone(), wing: priceToStrike(1_000) as string };
    expect(zoneWingUsd(matchListedZone(wider, both) as ListedZone)).toBe(1_000);
  });

  test("degrades to nothing rather than throwing", () => {
    expect(matchListedZone(null, booked())).toBeNull();
    expect(matchListedZone(onZone(), null)).toBeNull();
    expect(matchListedZone({ ...onZone(), floor: "junk" }, booked())).toBeNull();
    expect(listedZones(undefined).length).toBe(0);
    expect(listedZones({ orders: null, chainConfig: null }).length).toBe(0);
  });

  test("the coarse ladder, counted — most drawable boxes match nothing", () => {
    // plan7 §3.1 reads as "draw a box and it fills". On the real book it is
    // "pick one of about three", and this is that sentence as a number.
    const snap = booked();
    let bands = 0;
    let matched = 0;
    for (const l of deriveLadders(snap)) {
      for (let fi = 0; fi < l.strikes.length; fi++) {
        for (let ci = fi + 1; ci < l.strikes.length; ci++) {
          const b = snapBox(
            {
              underlying: l.underlying,
              floor: l.strikes[fi] as string,
              ceiling: l.strikes[ci] as string,
              wing: "",
              expiry: l.expiry,
            },
            l,
          );
          if (!isPlayable(b, l)) continue;
          bands++;
          if (matchListedZone(b, snap)) matched++;
        }
      }
    }
    // 82 bands are drawable across the capture's nine columns. Two of them
    // exist on the book — the same band, on two consecutive expiries.
    expect(bands).toBe(82);
    expect(matched).toBe(2);
    expect(matched / bands).toBeLessThan(0.05);
  });

  test("a listed zone is itself always drawable, and always matches", () => {
    // The chips in the arena are `zoneBox(zone)`, so this is the round trip
    // that keeps a chip from drawing a box it cannot fill.
    const snap = booked();
    for (const z of listedZones(snap)) {
      const l = deriveLadder(snap, z.underlying, z.expiry) as StrikeLadder;
      const b = zoneBox(z);
      expect(isPlayable(b, l)).toBe(true);
      expect(ladderIndex(l, b.floor)).toBeGreaterThanOrEqual(0);
      expect(ladderIndex(l, b.ceiling)).toBeGreaterThanOrEqual(0);
      // Snapping it again changes nothing: it is already the book's own shape.
      expect(snapBox(b, l)).toEqual(b);
      expect(matchListedZone(b, snap)?.index).toBe(z.index);
    }
  });
});

describe("the listed instrument", () => {
  const zone = (): ListedZone => listedZones(booked())[0] as ListedZone;

  test("is a RANGER and says so, with the flag the SDK needs", () => {
    const spec = zoneToRanger(zone());
    expect(spec.product).toBe(RANGER_PRODUCT);
    // The lowercase `PayoutType`, carried on the spec rather than re-derived at
    // the boundary. `calculatePayoutAtPrice` prices four-strike orders as a
    // condor unless it is handed `isRanger: true` (FINDINGS, "the 4-strike
    // discriminator trap"), and this is the field that stops that happening.
    expect(spec.payoutType).toBe(RANGER_PAYOUT_TYPE);
    expect(spec.payoutType).toBe("ranger");
    expect(spec.isLong).toBe(true);
    expect(spec.underlying).toBe("BTC");
  });

  test("cannot be spelled with a sell side", () => {
    const spec = zoneToRanger(zone());
    // @ts-expect-error plan7 §5, at compile time: a RangerSpec is long
    const other: RangerSpec = { ...spec, isLong: false };
    void other;
  });

  test("passes the SDK's own checker at the boundary", () => {
    const spec = zoneToRanger(zone());
    const strikes = rangerStrikeNumbers(spec);
    expect(strikes).toEqual([79_500, 80_000, 81_000, 81_500]);
    expect(validateRanger(strikes).valid).toBe(true);
    expect(validateRangerSpec(spec).valid).toBe(true);
  });

  test("the invariants are checked in integers, and reject what they should", () => {
    expect(zoneStrikes(["1", "2", "3"])).toBeNull(); // not four
    expect(zoneStrikes(["100", "200", "300", "500"])).toBeNull(); // unequal wings
    expect(zoneStrikes(["200", "100", "300", "400"])).toBeNull(); // not ascending
    expect(zoneStrikes(["0", "100", "200", "300"])).toBeNull(); // not positive
    expect(zoneStrikes(["100", "200", "300", "400"])).not.toBeNull();
  });
});

describe("a listed zone's economics", () => {
  const zone = (): ListedZone => listedZones(booked())[0] as ListedZone;

  test("the ceiling is the wing, and the risk is the premium", () => {
    const econ = zoneEconomics(zone(), 20, 1);
    expect(econ.wing).toBe(500);
    expect(econ.maxPayout).toBe(500);
    expect(econ.maxLoss).toBe(20);
    expect(econ.zone).toEqual({ floor: 80_000, ceiling: 81_000 });
  });

  test("the multiple is that division and nothing else, and is absent until quoted", () => {
    // 500 over 20 is 25. The premium must be `previewFillOrder`'s number, and
    // this is the same `economics` the condor path uses — one division in the
    // repo, and no second place for an invented rate to appear.
    expect(zoneEconomics(zone(), 20, 1).payoutMultiple).toBe(25);
    expect(zoneEconomics(zone(), 10, 1).payoutMultiple).toBe(50);
    expect(zoneEconomics(zone(), 0, 1).payoutMultiple).toBeNull();
    expect(zoneEconomics(zone(), Number.NaN, 1).payoutMultiple).toBeNull();
  });

  /** The same zone with a `previewFillOrder` answer attached, as the wire
   *  carries one: `LadderBookOrder.quote`, verbatim from the server. */
  const quoted = (quote: unknown): ListedZone => {
    const z = zone();
    return { ...z, order: { ...z.order, quote } as typeof z.order };
  };

  test("the premium is previewFillOrder's own pricePerContract", () => {
    // $333.92 is what a live BTC zone charged for one contract on 2026-09-05.
    // Read, not derived: `totalCollateral / numContracts` off the desk's
    // 4-decimal render would be 1.00 / 0.0000, which is why the arena carries a
    // shape of its own.
    expect(zoneQuote(quoted({ premium: "333.92", fillable: true }))).toBe(333.92);

    // And it is the number the multiple divides into the maker's own wing: a
    // $500 zone bought for $333.92 pays 1.50×, which is what a one-in-four
    // outcome on a $2,000-wide instrument ought to look like.
    expect(zoneEconomics(zone(), 333.92, 1).payoutMultiple).toBeCloseTo(500 / 333.92, 8);
  });

  test("every way of not having a quote is the same answer: none", () => {
    // Never a zero and never a placeholder — `zoneEconomics` then yields a null
    // multiple and the panel renders none at all (plan7 §4.4).
    expect(zoneQuote(zone())).toBeNull(); // never quoted
    expect(zoneQuote(quoted(undefined))).toBeNull();
    expect(zoneQuote(quoted(null))).toBeNull();
    // `numContracts === 0n` — the maker's collateral will not absorb the quote
    // notional. There is no size at which this box can be bought, which is an
    // ordinary reading of a thin book and not an error.
    expect(zoneQuote(quoted({ premium: "333.92", fillable: false }))).toBeNull();
    // Unparseable or non-positive.
    expect(zoneQuote(quoted({ premium: "0.00", fillable: true }))).toBeNull();
    expect(zoneQuote(quoted({ premium: "-1", fillable: true }))).toBeNull();
    expect(zoneQuote(quoted({ premium: "nope", fillable: true }))).toBeNull();
    expect(zoneQuote(quoted({ fillable: true }))).toBeNull();
  });

  test("the payoff is flat across the band and zero outside the wings", () => {
    const z = zone(); // 79500 / 80000 / 81000 / 81500
    expect(zonePayoff(z, 80_000)).toBe(500);
    expect(zonePayoff(z, 80_500)).toBe(500);
    expect(zonePayoff(z, 81_000)).toBe(500);
    expect(zonePayoff(z, 79_750)).toBeCloseTo(250, 8);
    expect(zonePayoff(z, 81_250)).toBeCloseTo(250, 8);
    expect(zonePayoff(z, 79_500)).toBe(0);
    expect(zonePayoff(z, 81_500)).toBe(0);
    expect(zonePayoff(z, 1)).toBe(0);
  });

  test("spot is a fact about the zone, and it can be outside it", () => {
    // BTC spot on the capture is 81004.04 — just above this band's ceiling. On
    // the live book, ETH's two nearest expiries are the same story, and the
    // arena has to be able to say so rather than snap somewhere absurd.
    const z = zone();
    expect(FIXTURE.prices.BTC).toBeCloseTo(81_004.04, 2);
    expect(zoneCoversSpot(z, FIXTURE.prices.BTC as number)).toBe(false);
    expect(zoneCoversSpot(z, 80_500)).toBe(true);
    expect(zoneCoversSpot(z, null)).toBe(false);
  });
});
