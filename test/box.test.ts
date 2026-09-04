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
import { validateCondor } from "@thetanuts-finance/thetanuts-client";
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
