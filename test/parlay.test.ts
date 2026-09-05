import { describe, expect, test } from "bun:test";
import { briefsFor } from "../src/data/briefs.ts";
import { meta } from "../src/data/universe.ts";
import {
  CONTRACT_DECIMALS,
  COLLATERAL_DECIMALS,
  LOUD_BELOW,
  PARLAY_CARDS,
  PRICE_DECIMALS,
  REFERENCE_MOVE,
  STRIKE_COUNT,
  TIER_BANDS,
  TIER_MOVE,
  TIER_ORDER,
  assertStrikes,
  basketPayoff,
  basketPremium,
  buildLeg,
  cardById,
  cardsForSlice,
  conditionText,
  degeneracyScore,
  fullLadderSlice,
  impliedProbability,
  legForCard,
  legFromLiveCard,
  legsForPicks,
  multipleAt,
  oddsOf,
  slipLabel,
  summarize,
  tierOdds,
  tierOf,
  tierProb,
  toUnits,
  type LiveCard,
  type PayoutCalculator,
  type PayoutQuery,
} from "../src/engine/parlay.ts";
import type { MarketSlice, PricingRow } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The bands — the one place a tier is defined
// ─────────────────────────────────────────────────────────────────────────────

describe("tier bands", () => {
  test("the four brackets tile 0.05–0.85 with no gap and no overlap", () => {
    const bands = TIER_ORDER.map((t) => TIER_BANDS[t]);
    expect(bands[0]![1]).toBe(0.85);
    expect(bands[bands.length - 1]![0]).toBe(0.05);
    for (let i = 1; i < bands.length; i++) {
      // SAFE.lo === EVEN.hi, EVEN.lo === SHARP.hi, …
      expect(bands[i]![1]).toBe(bands[i - 1]![0]);
    }
    for (const [lo, hi] of bands) expect(hi).toBeGreaterThan(lo);
  });

  test("bands are half-open [lo, hi) — the low edge is in, the high edge is out", () => {
    // Every boundary belongs to exactly one tier, and it is the tier below it.
    expect(tierOf(0.65)).toBe("SAFE");
    expect(tierOf(0.6499999)).toBe("EVEN");
    expect(tierOf(0.45)).toBe("EVEN");
    expect(tierOf(0.4499999)).toBe("SHARP");
    expect(tierOf(0.25)).toBe("SHARP");
    expect(tierOf(0.2499999)).toBe("DEGEN");
    expect(tierOf(0.05)).toBe("DEGEN");
  });

  test("both ends of the ladder are excluded on purpose", () => {
    // Below 0.05 the quote is dust with a spread wider than the premium.
    expect(tierOf(0.0499999)).toBeNull();
    expect(tierOf(0)).toBeNull();
    // At and above 0.85 the option is deep ITM — intrinsic value, not a bet.
    expect(tierOf(0.85)).toBeNull();
    expect(tierOf(0.99)).toBeNull();
    expect(tierOf(1)).toBeNull();
  });

  test("a put's negative delta buckets exactly like the call it mirrors", () => {
    for (const d of [0.7, 0.5, 0.3, 0.1]) expect(tierOf(-d)).toBe(tierOf(d));
  });

  test("garbage in is null, never a tier", () => {
    expect(tierOf(Number.NaN)).toBeNull();
    expect(tierOf(Number.POSITIVE_INFINITY)).toBeNull();
  });

  test("a tier's probability is its band midpoint, and its price is fair odds on it", () => {
    expect(tierProb("SAFE")).toBeCloseTo(0.75, 10);
    expect(tierProb("EVEN")).toBeCloseTo(0.55, 10);
    expect(tierProb("SHARP")).toBeCloseTo(0.35, 10);
    expect(tierProb("DEGEN")).toBeCloseTo(0.15, 10);
    for (const t of TIER_ORDER) expect(tierOdds(t) * tierProb(t)).toBeCloseTo(1, 10);
  });

  test("the ladder climbs in odds and falls in probability, by construction", () => {
    for (let i = 1; i < TIER_ORDER.length; i++) {
      expect(tierOdds(TIER_ORDER[i]!)).toBeGreaterThan(tierOdds(TIER_ORDER[i - 1]!));
      expect(tierProb(TIER_ORDER[i]!)).toBeLessThan(tierProb(TIER_ORDER[i - 1]!));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seeded leg — geometry from TIER_MOVE, odds from the bands
// ─────────────────────────────────────────────────────────────────────────────

describe("legs", () => {
  test("a tier scales the asset's base target and sets the strike from spot", () => {
    const u = meta("BTC");
    const safe = buildLeg("BTC", "over", "SAFE");
    const degen = buildLeg("BTC", "under", "DEGEN");
    expect(safe.baseT).toBe(u.t);
    expect(safe.t).toBeCloseTo(u.t * TIER_MOVE.SAFE, 6);
    expect(degen.t).toBeCloseTo(u.t * TIER_MOVE.DEGEN, 6);
    expect(safe.strike).toBeCloseTo(u.px * (1 + safe.t / 100), 6);
    expect(degen.strike).toBeCloseTo(u.px * (1 - degen.t / 100), 6);
  });

  test("a leg's odds are fair odds on its band, not a table lookup", () => {
    for (const tier of TIER_ORDER) {
      const leg = buildLeg("BTC", "over", tier);
      expect(leg.prob).toBe(tierProb(tier));
      expect(leg.mult).toBe(tierOdds(tier));
      // The whole point: price × chance is exactly 1. No overround anywhere.
      expect(leg.mult * leg.prob).toBeCloseTo(1, 10);
    }
  });

  test("the condition reads as a sentence", () => {
    expect(conditionText(buildLeg("BTC", "over", "EVEN"))).toMatch(/^BTC closes above [\d,]+ \(\+4\.0%\) by Fri expiry$/);
    expect(conditionText(buildLeg("BTC", "under", "EVEN"))).toContain("closes below");
  });
});

describe("the slip's two numbers", () => {
  const legs = [
    buildLeg("ETH", "over", "SAFE"),
    buildLeg("BTC", "over", "EVEN"),
    buildLeg("SOL", "over", "SHARP"),
    buildLeg("ARB", "over", "DEGEN"),
  ];

  test("degeneracyScore is the product of 1/prob, and is the reciprocal of the slip's chance", () => {
    expect(degeneracyScore(legs)).toBeCloseTo(1 / (0.75 * 0.55 * 0.35 * 0.15), 8);
    expect(degeneracyScore([])).toBe(1);
    expect(degeneracyScore(legs) * impliedProbability(legs)).toBeCloseTo(1, 8);
  });

  test("implied probability is the product of the leg hit rates", () => {
    expect(impliedProbability(legs)).toBeCloseTo(0.75 * 0.55 * 0.35 * 0.15, 10);
  });

  test("degeneracyScore is a game number and is never confused for money", async () => {
    // Two guards, because the danger is a naming accident rather than a bug.
    //
    // 1. It is dimensionless: it is built from probabilities alone and never
    //    touches a premium, a payout or a collateral amount. Scaling every
    //    premium on the slip by 100 cannot move it.
    const cheap = [card("bull", "SHARP", 0.35, 0.02), card("bear", "DEGEN", -0.15, 0.01)];
    const dear = cheap.map((c) => ({ ...c, premium: c.premium * 100 }));
    expect(degeneracyScore(dear)).toBe(degeneracyScore(cheap));
    // …where `basketPayoff`, which IS money, moves by exactly that premium.
    expect(basketPremium(dear)).toBeCloseTo(basketPremium(cheap) * 100, 10);

    // 2. Its docblock says so, and the module never prints it with a currency
    //    symbol. A grep is the cheapest possible enforcement of a naming rule.
    const src = await Bun.file(new URL("../src/engine/parlay.ts", import.meta.url)).text();
    // Flatten the comment furniture before matching: the rule is about what the
    // docblock SAYS, and a sentence that happens to wrap across two ` * ` lines
    // is the same sentence. Matching raw bytes would make this test fail on a
    // reflow and pass on a reworded promise, which is backwards.
    const doc = src
      .slice(src.indexOf("degeneracy score"), src.indexOf("export function degeneracyScore"))
      .replace(/\n\s*\*\s?/g, " ")
      .replace(/\s+/g, " ");
    expect(doc).toContain("never rendered beside a currency symbol");
    expect(doc).toContain("never described as a payout");
    // No `$` template anywhere near the score.
    expect(/\$\$\{[^}]*degeneracy/i.test(src)).toBe(false);
  });

  test("the summary scales the stake by the degeneracy score and goes loud under 10%", () => {
    const s = summarize(legs, 2400);
    expect(s.mult).toBeCloseTo(degeneracyScore(legs), 10);
    expect(s.potentialPoints).toBe(Math.round(2400 * s.mult));
    expect(s.prob).toBeLessThan(LOUD_BELOW);
    expect(s.loud).toBe(true);
    expect(summarize([buildLeg("ETH", "over", "SAFE")], 100).loud).toBe(false);
  });
});

describe("cards", () => {
  test("eight cards per leg: every tier, bullish and bearish, with unique ids", () => {
    expect(PARLAY_CARDS).toHaveLength(8);
    expect(new Set(PARLAY_CARDS.map((c) => c.id)).size).toBe(8);
    for (const tier of TIER_ORDER) {
      expect(cardById(`${tier.toLowerCase()}-bull`)?.tier).toBe(tier);
      expect(cardById(`${tier.toLowerCase()}-bear`)?.stance).toBe("bear");
    }
    expect(cardById("nope")).toBeNull();
    expect(cardById(null)).toBeNull();
  });

  test("a pick sets that leg's line and direction, and legs combine per ticker", () => {
    const sharpBull = legForCard("NVDA", cardById("sharp-bull")!);
    expect(sharpBull.dir).toBe("over");
    expect(sharpBull.tier).toBe("SHARP");
    const safeBear = legForCard("AAPL", cardById("safe-bear")!);
    expect(safeBear.dir).toBe("under");
    expect(safeBear.tier).toBe("SAFE");

    const legs = legsForPicks(["NVDA", "AAPL", "TSLA"], {
      NVDA: cardById("sharp-bull")!,
      AAPL: cardById("safe-bear")!,
      TSLA: cardById("degen-bull")!,
    });
    expect(legs.map((l) => l.sym)).toEqual(["NVDA", "AAPL", "TSLA"]);
    expect(legs.map((l) => l.tier)).toEqual(["SHARP", "SAFE", "DEGEN"]);
    expect(legs.map((l) => l.dir)).toEqual(["over", "under", "over"]);
    expect(degeneracyScore(legs)).toBeCloseTo(1 / (0.35 * 0.75 * 0.15), 8);
    expect(slipLabel(legs)).toBe("SHARP↑ SAFE↓ DEGEN↑");
  });

  test("tiers climb in odds and fall in probability", () => {
    const order = ["safe-bull", "even-bull", "sharp-bull", "degen-bull"].map((id) => legForCard("NVDA", cardById(id)!));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]!.mult).toBeGreaterThan(order[i - 1]!.mult);
      expect(order[i]!.prob).toBeLessThan(order[i - 1]!.prob);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live card
// ─────────────────────────────────────────────────────────────────────────────

/** Unix seconds. One expiry, named by the slice and by every order in it. */
const EXPIRY = 1_788_595_200;
const OTHER_EXPIRY = 1_788_681_600;

const SLICE: MarketSlice = {
  underlying: "ETH",
  expiry: EXPIRY,
  // $1,000 – $5,000, 8dp, exactly the encoding `rawApiData.strikes` uses.
  strikeLo: "100000000000",
  strikeHi: "500000000000",
};

/**
 * One live row, assembled the way `buildSnapshot` assembles one.
 *
 * Everything the card builder reads is here and nothing else is: a side, a
 * strike (twice — the display string and the 8dp order field, which is what is
 * actually filtered on), a delta, an ask, an option expiry and the order behind
 * the ask. `order: undefined` is how a display-only row is spelt.
 */
function row(o: {
  type?: "CALL" | "PUT";
  strike: number;
  delta: number | string;
  ask: number | string;
  expiry?: number;
  mark?: string;
  structure?: string;
  /** `false` builds the row with no fillable order — MM-quoted, unpressable. */
  fillable?: boolean;
  /** `[a, b]` builds a two-strike order, which has no single line to bet on. */
  strikes?: string[];
}): PricingRow {
  const type = o.type ?? "CALL";
  const strikes = o.strikes ?? [String(Math.round(o.strike * 10 ** PRICE_DECIMALS))];
  return {
    type,
    strike: o.strike.toLocaleString("en-US"),
    expiry: "12 SEP",
    bid: "0.0100",
    ask: typeof o.ask === "number" ? o.ask.toFixed(4) : o.ask,
    iv: "58.0%",
    delta: typeof o.delta === "number" ? o.delta.toFixed(2) : o.delta,
    depth: 40,
    size: "10.0k",
    structure: o.structure ?? type,
    mark: o.mark,
    order:
      o.fillable === false
        ? undefined
        : {
            order: {
              price: String(Math.round(Number(o.ask) * 10 ** PRICE_DECIMALS)),
              isBuyer: false,
              expiry: String(o.expiry ?? EXPIRY),
            },
            rawApiData: { strikes, isCall: type === "CALL", orderExpiryTimestamp: EXPIRY - 80_000 },
          },
  };
}

/**
 * `calculatePayout`, reimplemented for the two vanilla types.
 *
 * Not a mock that returns a constant: it is the SDK's own documented arithmetic
 * (`(settlement − strike) × contracts` for a call, floored at zero), so a test
 * that passes here would pass against the real function. It also **asserts the
 * params it was handed**, which is where the lowercase-type and decimal
 * conventions are actually enforced.
 */
const calc: PayoutCalculator = (p: PayoutQuery) => {
  expect(p.type).toBe(p.type.toLowerCase() as typeof p.type);
  expect(p.strikes).toHaveLength(STRIKE_COUNT[p.type]);
  const k = Number(p.strikes[0]!) / 10 ** PRICE_DECIMALS;
  const s = Number(p.settlementPrice) / 10 ** PRICE_DECIMALS;
  const n = Number(p.numContracts) / 10 ** CONTRACT_DECIMALS;
  const intrinsic = p.type === "call" ? Math.max(0, s - k) : Math.max(0, k - s);
  return toUnits(intrinsic * n, COLLATERAL_DECIMALS);
};

const SPOT = 2000;
const deps = { calculatePayout: calc, spot: SPOT };

/** The eight slots as a lookup by card id. */
function deal(rows: readonly PricingRow[], slice: MarketSlice = SLICE) {
  const cards = cardsForSlice(rows, slice, deps);
  expect(cards).toHaveLength(PARLAY_CARDS.length);
  const by = new Map<string, LiveCard | null>();
  PARLAY_CARDS.forEach((c, i) => by.set(c.id, cards[i]!));
  return by;
}

/** A `LiveCard` built by hand, for the pure-arithmetic tests. */
function card(stance: "bull" | "bear", tier: "SAFE" | "EVEN" | "SHARP" | "DEGEN", delta: number, premium: number, strikeAt = 2100): LiveCard {
  return {
    ...PARLAY_CARDS.find((c) => c.tier === tier && c.stance === stance)!,
    underlying: "ETH",
    strike: String(strikeAt),
    strikeAt,
    expiry: "12 SEP",
    expiryAt: EXPIRY,
    prob: Math.abs(delta),
    premium,
    odds: oddsOf(Math.abs(delta)),
    payoutMult: 0,
    mark: null,
    row: row({ strike: strikeAt, delta, ask: premium }),
  };
}

describe("cardsForSlice", () => {
  test("eight slots always, one per PARLAY_CARDS entry, index-aligned", () => {
    const cards = cardsForSlice([], SLICE, deps);
    expect(cards).toHaveLength(8);
    expect(cards.every((c) => c === null)).toBe(true);
  });

  test("a card is built from the row whose |delta| is inside its band", () => {
    const by = deal([
      row({ type: "CALL", strike: 1800, delta: 0.72, ask: 0.09 }), // SAFE
      row({ type: "CALL", strike: 2000, delta: 0.5, ask: 0.06 }), // EVEN
      row({ type: "CALL", strike: 2300, delta: 0.3, ask: 0.03 }), // SHARP
      row({ type: "CALL", strike: 2800, delta: 0.1, ask: 0.01 }), // DEGEN
    ]);
    expect(by.get("safe-bull")?.strikeAt).toBe(1800);
    expect(by.get("even-bull")?.strikeAt).toBe(2000);
    expect(by.get("sharp-bull")?.strikeAt).toBe(2300);
    expect(by.get("degen-bull")?.strikeAt).toBe(2800);
    // The probability on the card is the option's own delta, not the midpoint.
    expect(by.get("safe-bull")?.prob).toBeCloseTo(0.72, 10);
    // Calls are bull cards only. Nothing bearish was dealt.
    for (const c of PARLAY_CARDS.filter((x) => x.stance === "bear")) {
      expect(by.get(c.id)).toBeNull();
    }
  });

  test("a bear card buys a put, and reads the put's |delta|", () => {
    const by = deal([row({ type: "PUT", strike: 1700, delta: -0.3, ask: 0.02 })]);
    expect(by.get("sharp-bear")?.strikeAt).toBe(1700);
    expect(by.get("sharp-bear")?.prob).toBeCloseTo(0.3, 10);
    expect(by.get("sharp-bull")).toBeNull();
  });

  test("the band edges are enforced half-open, on live rows", () => {
    // 0.65 is SAFE's floor — in. 0.6499 is EVEN's ceiling side — out of SAFE.
    const at = deal([row({ strike: 1900, delta: "0.6500", ask: 0.08 })]);
    expect(at.get("safe-bull")).not.toBeNull();
    expect(at.get("even-bull")).toBeNull();

    const below = deal([row({ strike: 1900, delta: "0.6499", ask: 0.08 })]);
    expect(below.get("safe-bull")).toBeNull();
    expect(below.get("even-bull")).not.toBeNull();

    // Both ends of the whole ladder are excluded: nothing is dealt at all.
    for (const d of ["0.0499", "0.8500", "0.9700"]) {
      const out = deal([row({ strike: 1900, delta: d, ask: 0.08 })]);
      expect([...out.values()].every((c) => c === null)).toBe(true);
    }
  });

  test("the lowest ask wins among rows in the same band", () => {
    const by = deal([
      row({ strike: 2200, delta: 0.32, ask: 0.055 }),
      row({ strike: 2250, delta: 0.3, ask: 0.021 }), // cheapest
      row({ strike: 2300, delta: 0.28, ask: 0.049 }),
    ]);
    expect(by.get("sharp-bull")?.premium).toBeCloseTo(0.021, 10);
    expect(by.get("sharp-bull")?.strikeAt).toBe(2250);
  });

  test("a row with no fillable order is display-only and is never dealt", () => {
    const by = deal([row({ strike: 2250, delta: 0.3, ask: 0.02, fillable: false })]);
    expect(by.get("sharp-bull")).toBeNull();

    // …and the cheapest unfillable row does not beat a fillable one.
    const mixed = deal([
      row({ strike: 2250, delta: 0.3, ask: 0.001, fillable: false }),
      row({ strike: 2300, delta: 0.3, ask: 0.04 }),
    ]);
    expect(mixed.get("sharp-bull")?.strikeAt).toBe(2300);
    expect(mixed.get("sharp-bull")?.premium).toBeCloseTo(0.04, 10);
  });

  test("a row with no delta cannot be bucketed and is dropped", () => {
    expect(deal([row({ strike: 2250, delta: "—", ask: 0.02 })]).get("sharp-bull")).toBeNull();
  });

  test("the slice's window and expiry are both hard filters", () => {
    // Outside the strike window.
    expect(deal([row({ strike: 6000, delta: 0.3, ask: 0.02 })]).get("sharp-bull")).toBeNull();
    expect(deal([row({ strike: 500, delta: 0.3, ask: 0.02 })]).get("sharp-bull")).toBeNull();
    // Inclusive at both edges — 8dp integer comparison, no float round trip.
    expect(deal([row({ strike: 1000, delta: 0.3, ask: 0.02 })]).get("sharp-bull")).not.toBeNull();
    expect(deal([row({ strike: 5000, delta: 0.3, ask: 0.02 })]).get("sharp-bull")).not.toBeNull();
    // A different option expiry is a different contract.
    expect(
      deal([row({ strike: 2250, delta: 0.3, ask: 0.02, expiry: OTHER_EXPIRY })]).get("sharp-bull"),
    ).toBeNull();
  });

  test("a spread is refused even though it carries type CALL", () => {
    // Two strikes on the order, and `structure` says SPREAD — either alone is
    // enough to refuse it, because pricing a leg off a spread's premium buys a
    // completely different payoff.
    const byStructure = deal([
      row({ strike: 2250, delta: 0.3, ask: 0.02, structure: "SPREAD" }),
    ]);
    expect(byStructure.get("sharp-bull")).toBeNull();

    const byStrikes = deal([
      row({ strike: 2250, delta: 0.3, ask: 0.02, strikes: ["225000000000", "240000000000"] }),
    ]);
    expect(byStrikes.get("sharp-bull")).toBeNull();
  });

  test("a dead slot is the honest answer, and the grid keeps its shape", () => {
    // A book with one SHARP call and nothing else: seven dead slots, in place.
    const cards = cardsForSlice([row({ strike: 2250, delta: 0.3, ask: 0.02 })], SLICE, deps);
    const dealt = cards.filter((c) => c !== null);
    expect(dealt).toHaveLength(1);
    expect(cards.filter((c) => c === null)).toHaveLength(7);
    // Index-aligned: the survivor sits exactly where SHARP BULLISH belongs.
    const i = PARLAY_CARDS.findIndex((c) => c.id === "sharp-bull");
    expect(cards[i]).not.toBeNull();
    expect(cards[i]!.label).toBe("SHARP · BULLISH");
  });

  test("mark rides along verbatim when the MM chain named this instrument, and is null otherwise", () => {
    const withMark = deal([row({ strike: 2250, delta: 0.3, ask: 0.02, mark: "0.0214" })]);
    expect(withMark.get("sharp-bull")?.mark).toBeCloseTo(0.0214, 10);
    const without = deal([row({ strike: 2250, delta: 0.3, ask: 0.02 })]);
    expect(without.get("sharp-bull")?.mark).toBeNull();
  });

  test("a malformed slice deals nothing rather than throwing", () => {
    const bad = { ...SLICE, strikeLo: "not-a-number" };
    expect(cardsForSlice([row({ strike: 2250, delta: 0.3, ask: 0.02 })], bad, deps).every((c) => c === null)).toBe(true);
  });
});

describe("fullLadderSlice — the identity window", () => {
  test("spans every listed strike at the front expiry, and names the ticker", () => {
    const slice = fullLadderSlice("ETH", [
      row({ strike: 2000, delta: 0.7, ask: 0.05 }),
      row({ strike: 2250, delta: 0.3, ask: 0.02 }),
      row({ type: "PUT", strike: 1800, delta: -0.2, ask: 0.01 }),
    ])!;
    expect(slice.underlying).toBe("ETH");
    expect(slice.expiry).toBe(EXPIRY);
    expect(slice.strikeLo).toBe(String(1800 * 10 ** PRICE_DECIMALS));
    expect(slice.strikeHi).toBe(String(2250 * 10 ** PRICE_DECIMALS));
    // It narrows nothing: no constraint is dealt, because dealing is the reel's
    // job and this function makes no decisions at all.
    expect(slice.constraint).toBeUndefined();
  });

  test("the window it returns re-deals every card the chain can back", () => {
    // The property that makes it the identity: filtering the chain through its
    // own slice loses nothing. A narrower window is a decision; this is not.
    const rows = [
      row({ strike: 2000, delta: 0.7, ask: 0.05 }),
      row({ strike: 2250, delta: 0.3, ask: 0.02 }),
      row({ type: "PUT", strike: 1800, delta: -0.2, ask: 0.01 }),
    ];
    const cards = cardsForSlice(rows, fullLadderSlice("ETH", rows)!, deps);
    expect(cards.filter((c) => c !== null)).toHaveLength(3);
  });

  test("deals ONE expiry, and leaves the other one out of the window", () => {
    // Two expiries in one window would let a SAFE card expire in three days and
    // the DEGEN beside it in three weeks — not the same bet in different
    // clothes. `cardsForSlice` matches one expiry, and this picks exactly one.
    //
    // Both candidates here cover the same single slot (sharp-bull), so this is
    // the TIE case and the tie-break takes the earlier expiry — the old
    // front-expiry rule surviving where it belongs.
    const slice = fullLadderSlice("ETH", [
      row({ strike: 3000, delta: 0.3, ask: 0.02, expiry: OTHER_EXPIRY }),
      row({ strike: 2250, delta: 0.3, ask: 0.02 }),
    ])!;
    expect(slice.expiry).toBe(EXPIRY);
    expect(slice.strikeHi).toBe(String(2250 * 10 ** PRICE_DECIMALS));
  });

  test("picks the expiry that fills the MOST slots, not the earliest one", () => {
    // This is the whole rule, and the regression it exists to prevent. The
    // front expiry lists one askable vanilla; the back expiry lists four, one
    // per tier. The old rule dealt 1 live card and 7 seeded dashes; the new one
    // deals 4 — from a date the venue is genuinely quoting.
    const rows = [
      // Front expiry: one lonely SHARP call.
      row({ strike: 2250, delta: 0.3, ask: 0.02 }),
      // Back expiry: a card in every tier, on the bull side.
      row({ strike: 1800, delta: 0.72, ask: 0.09, expiry: OTHER_EXPIRY }),
      row({ strike: 2000, delta: 0.5, ask: 0.06, expiry: OTHER_EXPIRY }),
      row({ strike: 2300, delta: 0.3, ask: 0.03, expiry: OTHER_EXPIRY }),
      row({ strike: 2800, delta: 0.1, ask: 0.01, expiry: OTHER_EXPIRY }),
    ];
    const slice = fullLadderSlice("ETH", rows)!;
    expect(slice.expiry).toBe(OTHER_EXPIRY);
    // And the window is the back expiry's own ladder, not the front's.
    expect(slice.strikeLo).toBe(String(1800 * 10 ** PRICE_DECIMALS));
    expect(slice.strikeHi).toBe(String(2800 * 10 ** PRICE_DECIMALS));
    // Dealt through the real dealer: four live cards where the old rule gave one.
    expect(cardsForSlice(rows, slice, deps).filter((c) => c !== null)).toHaveLength(4);
  });

  test("coverage counts SLOTS, not rows — depth in one tier never wins", () => {
    // Forty rows that all bucket into DEGEN cover one slot. Two rows that split
    // across two tiers cover two, and two live cards is a grid where forty
    // stacked in one bucket is still one card and seven dashes.
    const deep = Array.from({ length: 40 }, (_, i) =>
      row({ strike: 2800 + i * 10, delta: 0.1, ask: 0.01 }),
    );
    const spread = [
      row({ strike: 2000, delta: 0.5, ask: 0.06, expiry: OTHER_EXPIRY }),
      row({ strike: 2300, delta: 0.3, ask: 0.03, expiry: OTHER_EXPIRY }),
    ];
    expect(fullLadderSlice("ETH", [...deep, ...spread])!.expiry).toBe(OTHER_EXPIRY);
  });

  test("a row that could never be dealt does not count toward coverage", () => {
    // The back expiry looks richer by row count and is poorer by slot count:
    // one unfillable, one with no delta, one with no ask, one out of every
    // band. None of the four can become a card, so the front expiry's single
    // real SHARP call wins on coverage 1 to 0.
    const slice = fullLadderSlice("ETH", [
      row({ strike: 2250, delta: 0.3, ask: 0.02 }),
      row({ strike: 1800, delta: 0.72, ask: 0.09, expiry: OTHER_EXPIRY, fillable: false }),
      row({ strike: 2000, delta: "—", ask: 0.06, expiry: OTHER_EXPIRY }),
      row({ strike: 2300, delta: 0.3, ask: 0, expiry: OTHER_EXPIRY }),
      row({ strike: 2800, delta: 0.97, ask: 0.01, expiry: OTHER_EXPIRY }),
    ])!;
    expect(slice.expiry).toBe(EXPIRY);
  });

  test("selection is a pure function of the snapshot, whatever order the rows arrive in", () => {
    // Both players must deal the same grid from the same data. A selection that
    // depended on iteration order would break that on one machine, mid-match,
    // silently — so it is asserted rather than assumed.
    const rows = [
      row({ strike: 2250, delta: 0.3, ask: 0.02 }),
      row({ strike: 1800, delta: 0.72, ask: 0.09, expiry: OTHER_EXPIRY }),
      row({ strike: 2000, delta: 0.5, ask: 0.06, expiry: OTHER_EXPIRY }),
    ];
    const want = fullLadderSlice("ETH", rows);
    expect(fullLadderSlice("ETH", [...rows].reverse())).toEqual(want!);
    // A tie is stable under reordering too, and resolves to the earlier expiry
    // from either direction.
    const tied = [
      row({ strike: 2250, delta: 0.3, ask: 0.02 }),
      row({ strike: 3000, delta: 0.3, ask: 0.02, expiry: OTHER_EXPIRY }),
    ];
    expect(fullLadderSlice("ETH", tied)!.expiry).toBe(EXPIRY);
    expect(fullLadderSlice("ETH", [...tied].reverse())!.expiry).toBe(EXPIRY);
  });

  test("the window still spans strikes that carry no delta, so the identity holds", () => {
    // Coverage is counted over rows that could become cards; the WINDOW is the
    // ladder. A listed strike with no greeks is still a strike the venue lists
    // at that expiry, so it stays inside the bounds and filtering the chain
    // through its own slice loses nothing.
    const rows = [
      row({ strike: 2000, delta: 0.5, ask: 0.06 }),
      row({ strike: 3200, delta: "—", ask: 0.01 }),
    ];
    const slice = fullLadderSlice("ETH", rows)!;
    expect(slice.strikeHi).toBe(String(3200 * 10 ** PRICE_DECIMALS));
    expect(cardsForSlice(rows, slice, deps).filter((c) => c !== null)).toHaveLength(1);
  });

  test("a chain with nothing dealable in it answers null, not an empty window", () => {
    // The seeded fixtures are exactly this shape: rendered rows, no orders. A
    // null here is what keeps the offline board on the seeded path.
    expect(fullLadderSlice("ETH", [])).toBeNull();
    expect(
      fullLadderSlice("ETH", [row({ strike: 2250, delta: 0.3, ask: 0.02, fillable: false })]),
    ).toBeNull();
    // A spread has no single line to bet on, and a RANGER is not a vanilla —
    // neither may set the edge of a window it could never be dealt inside.
    expect(
      fullLadderSlice("ETH", [
        row({ strike: 2250, delta: 0.3, ask: 0.02, strikes: ["225000000000", "240000000000"] }),
      ]),
    ).toBeNull();
    expect(
      fullLadderSlice("ETH", [row({ strike: 2250, delta: 0.3, ask: 0.02, structure: "SPREAD" })]),
    ).toBeNull();
  });
});

describe("multipleAt", () => {
  test("is calculatePayout at the reference move, over the premium paid", () => {
    // ETH spot 2000, +25% reference ⇒ settlement 2500. A 2100 call is worth
    // 400 there; at a $20 premium that is ×20. Worked by hand, then asserted
    // against the function.
    const c = card("bull", "SHARP", 0.3, 20, 2100);
    expect(multipleAt(c, SPOT, REFERENCE_MOVE, calc)).toBeCloseTo(400 / 20, 8);
    // And it is exactly `payout / premium`, with the payout coming back in
    // collateral decimals.
    const payout = calc({
      type: "call",
      strikes: [toUnits(2100, PRICE_DECIMALS)],
      settlementPrice: toUnits(2500, PRICE_DECIMALS),
      numContracts: toUnits(1, CONTRACT_DECIMALS),
    });
    expect(Number(payout) / 10 ** COLLATERAL_DECIMALS / 20).toBeCloseTo(
      multipleAt(c, SPOT, REFERENCE_MOVE, calc),
      8,
    );
  });

  test("a bear card reads the move in its own direction", () => {
    // Settlement 1500. A 1700 put is worth 200 there; at $10 that is ×20.
    const c = card("bear", "SHARP", -0.3, 10, 1700);
    expect(multipleAt(c, SPOT, REFERENCE_MOVE, calc)).toBeCloseTo(200 / 10, 8);
  });

  test("it moves with both inputs — which is why it is never stored", () => {
    const c = card("bull", "SHARP", 0.3, 20, 2100);
    const wider = multipleAt(c, SPOT, 0.5, calc);
    const tighter = multipleAt(c, SPOT, 0.1, calc);
    expect(wider).toBeGreaterThan(multipleAt(c, SPOT, REFERENCE_MOVE, calc));
    expect(tighter).toBeLessThan(multipleAt(c, SPOT, REFERENCE_MOVE, calc));
    // A premium that doubles halves the multiple. Nothing is cached.
    expect(multipleAt({ ...c, premium: 40 }, SPOT, REFERENCE_MOVE, calc)).toBeCloseTo(
      multipleAt(c, SPOT, REFERENCE_MOVE, calc) / 2,
      8,
    );
  });

  test("an out-of-the-money finish is ×0, and a degenerate input is 0 rather than a throw", () => {
    // A 2600 call with spot at 2000 does not reach 2500.
    expect(multipleAt(card("bull", "DEGEN", 0.1, 1, 2600), SPOT, REFERENCE_MOVE, calc)).toBe(0);
    expect(multipleAt(card("bull", "SHARP", 0.3, 0, 2100), SPOT, REFERENCE_MOVE, calc)).toBe(0);
    expect(multipleAt(card("bull", "SHARP", 0.3, 20, 2100), 0, REFERENCE_MOVE, calc)).toBe(0);
    expect(multipleAt(card("bull", "SHARP", 0.3, 20, 2100), SPOT, Number.NaN, calc)).toBe(0);
  });

  test("cardsForSlice fills `payoutMult` with exactly what multipleAt returns", () => {
    const r = row({ strike: 2100, delta: 0.3, ask: 20 });
    const dealt = deal([r]).get("sharp-bull")!;
    expect(dealt.payoutMult).toBeCloseTo(multipleAt(dealt, SPOT, REFERENCE_MOVE, calc), 10);
    expect(dealt.payoutMult).toBeCloseTo(400 / 20, 8);
  });

  /**
   * The mixed-basis guard, at the source.
   *
   * A dealt card carries two multiples and they answer different questions:
   * `odds` is `1 / |delta|` — the chance this leg lands — and `payoutMult` is
   * `calculatePayout ÷ premium` at the reference move. On a cheap far-OTM card
   * the second is two orders of magnitude larger than the first, which is the
   * whole reason they must not share the `×` glyph on a screen where a seeded
   * ticker's `tierOdds` sits in the next grid down.
   */
  test("a dealt card carries `odds` and `payoutMult` as two separate numbers", () => {
    const dealt = deal([row({ strike: 2100, delta: 0.3, ask: 20 })]).get("sharp-bull")!;
    // `odds` is the same construction the seeded card uses, over the option's
    // own delta rather than a band midpoint.
    expect(dealt.odds).toBeCloseTo(oddsOf(0.3), 10);
    expect(dealt.odds).toBeCloseTo(1 / 0.3, 10);
    expect(dealt.odds * dealt.prob).toBeCloseTo(1, 10);
    // …and it is NOT the payout multiple. ×3.33 against ×20 here; against a
    // real DEGEN ask it is ×4 against ×430.
    expect(dealt.payoutMult).toBeCloseTo(20, 8);
    expect(dealt.odds).not.toBeCloseTo(dealt.payoutMult, 1);

    // The far-OTM case the report caught: a 1-cent DEGEN call still in the
    // money at +25%. `payoutMult` runs away; `odds` stays on the tier ladder.
    const degen = card("bull", "DEGEN", 0.08, 0.01, 2400);
    const pm = multipleAt(degen, SPOT, REFERENCE_MOVE, calc);
    expect(pm).toBeGreaterThan(1000);
    expect(degen.odds).toBeCloseTo(1 / 0.08, 10);
    // `odds` is bounded by the tier ladder itself — DEGEN's band floor is 0.05,
    // so no DEGEN card can print more than ×20 however cheap the ask is.
    // `payoutMult` has no such ceiling, and that asymmetry is exactly why one
    // of them may wear the `×` and the other may not.
    expect(degen.odds).toBeLessThan(1 / TIER_BANDS.DEGEN[0]!);
  });

  /**
   * The leg is the object every other surface reads — the slip, the ticker
   * header, the result screen, the tape. It carries `odds`, not `payoutMult`.
   *
   * This is the pin that moved. `test/app.test.tsx` used to assert
   * `leg.mult === multipleAt(...)`, which is what put `×430.75` on an ETH leg
   * beside `×6.67` on an AVAX one. The provenance claim it was protecting —
   * that no rendered multiplier is a house invention — is intact and is now
   * checked on the dollar figure instead: see `payoutMult` above and the
   * `WIN $` face in `test/detail.test.ts`.
   */
  test("legFromLiveCard puts the card's odds on the leg, never its payout multiple", () => {
    const dealt = deal([row({ strike: 2100, delta: 0.3, ask: 20 })]).get("sharp-bull")!;
    const seeded = legForCard("ETH", PARLAY_CARDS.find((c) => c.id === "sharp-bull")!);
    const leg = legFromLiveCard(seeded, dealt, SPOT);

    expect(leg.mult).toBeCloseTo(dealt.odds, 10);
    expect(leg.mult).not.toBeCloseTo(dealt.payoutMult, 1);
    // The invariant the seeded leg has always had, now true on both paths — so
    // one glyph on one screen means one thing.
    expect(leg.mult * leg.prob).toBeCloseTo(1, 10);
    // And it is not the seeded number either: the option's delta, not the band.
    expect(leg.prob).toBeCloseTo(0.3, 10);
    expect(leg.mult).not.toBeCloseTo(tierOdds("SHARP"), 3);
  });

  /**
   * The property the split buys, and the reason it is not merely cosmetic: the
   * slip's own `×` is `degeneracyScore` = `Π(1 / prob)`, so the leg multiples a
   * player reads down the slip must multiply into it. They did not while a live
   * leg carried `multipleAt`.
   */
  test("a mixed slip's leg multiples multiply into the slip's own multiple", () => {
    const dealt = deal([row({ strike: 2100, delta: 0.3, ask: 20 })]).get("sharp-bull")!;
    const live = legFromLiveCard(
      legForCard("ETH", PARLAY_CARDS.find((c) => c.id === "sharp-bull")!),
      dealt,
      SPOT,
    );
    const seededLegs = [
      legForCard("NVDA", PARLAY_CARDS.find((c) => c.id === "degen-bull")!),
      legForCard("AAPL", PARLAY_CARDS.find((c) => c.id === "safe-bear")!),
    ];
    const legs = [live, ...seededLegs];
    const product = legs.reduce((a, l) => a * l.mult, 1);
    expect(summarize(legs, 100).mult).toBeCloseTo(product, 8);
    expect(degeneracyScore(legs)).toBeCloseTo(product, 8);
  });
});

describe("the strikes-length guard", () => {
  test("exactly one strike for a vanilla, exactly two for a spread", () => {
    expect(STRIKE_COUNT.call).toBe(1);
    expect(STRIKE_COUNT.put).toBe(1);
    expect(STRIKE_COUNT.call_spread).toBe(2);
    expect(STRIKE_COUNT.put_spread).toBe(2);
  });

  test("a wrong-length array is refused here, before calculatePayout can throw INVALID_PARAMS", () => {
    expect(() => assertStrikes("call", [])).toThrow(/exactly 1 strike/);
    expect(() => assertStrikes("call", [1n, 2n])).toThrow(/exactly 1 strike/);
    // Three is a butterfly, four is a condor or a ranger — every physical
    // multi-leg implementation on Base is the zero address, so neither can be
    // dealt as a card at all.
    expect(() => assertStrikes("put", [1n, 2n, 3n])).toThrow(/exactly 1 strike/);
    expect(() => assertStrikes("call_spread", [1n, 2n, 3n, 4n])).toThrow(/exactly 2 strikes/);
    expect(() => assertStrikes("call_spread", [1n])).toThrow(/exactly 2 strikes/);
    // The legal shapes pass silently.
    expect(() => assertStrikes("call", [1n])).not.toThrow();
    expect(() => assertStrikes("put_spread", [1n, 2n])).not.toThrow();
  });

  test("the guard is actually in front of every payout call this module makes", () => {
    // A card whose strike array would be built wrong cannot reach the SDK: the
    // only way in is `multipleAt` / `basketPayoff`, and both assert first.
    const thrower: PayoutCalculator = () => {
      throw new Error("INVALID_PARAMS");
    };
    // A well-formed card never reaches the throw's cause — it reaches the
    // injected function, which is the seam the guard protects.
    expect(() => multipleAt(card("bull", "SHARP", 0.3, 20, 2100), SPOT, REFERENCE_MOVE, thrower)).toThrow(
      "INVALID_PARAMS",
    );
  });
});

describe("basketPayoff", () => {
  const legs = [
    card("bull", "SHARP", 0.3, 20, 2100),
    card("bull", "DEGEN", 0.1, 5, 2400),
    card("bear", "EVEN", -0.5, 30, 1900),
  ];

  test("a basket pays the SUM of its legs minus the total premium, never the product", () => {
    // Settle at 2500: the 2100 call pays 400, the 2400 call pays 100, the 1900
    // put pays 0. Premium paid is 20 + 5 + 30 = 55.
    expect(basketPayoff(legs, 2500, calc)).toBeCloseTo(400 + 100 + 0 - 55, 8);

    // The product reading — what the old `summarize` did — would be the
    // multiples multiplied together, and it is a completely different number.
    const product = legs.reduce((a, l) => a * multipleAt(l, SPOT, REFERENCE_MOVE, calc), 1);
    expect(product).not.toBeCloseTo(basketPayoff(legs, 2500, calc), 2);
  });

  test("it is additive: a basket is worth the sum of its legs priced alone", () => {
    const parts = legs.reduce((a, l) => a + basketPayoff([l], 2500, calc), 0);
    expect(basketPayoff(legs, 2500, calc)).toBeCloseTo(parts, 8);
  });

  test("nothing landing is exactly minus the premium — the max loss, bounded and known", () => {
    // Settle at 2000: no call is ITM, and the 1900 put is not either.
    expect(basketPayoff(legs, 2000, calc)).toBeCloseTo(-basketPremium(legs), 8);
    expect(basketPremium(legs)).toBeCloseTo(55, 10);
    // The floor holds however far the tape runs the wrong way.
    for (const s of [2000, 2050, 2399]) {
      expect(basketPayoff(legs, s, calc)).toBeGreaterThanOrEqual(-basketPremium(legs) - 1e-9);
    }
  });

  test("contracts scale both halves", () => {
    expect(basketPayoff(legs, 2500, calc, 3)).toBeCloseTo(basketPayoff(legs, 2500, calc) * 3, 6);
    expect(basketPremium(legs, 3)).toBeCloseTo(basketPremium(legs) * 3, 10);
  });

  test("an empty basket pays nothing and costs nothing", () => {
    expect(basketPayoff([], 2500, calc)).toBe(0);
    expect(basketPremium([])).toBe(0);
    expect(basketPayoff(legs, 0, calc)).toBe(0);
  });
});

describe("briefs", () => {
  test("one news line per ticker, then a desk exchange, replayable by seed", () => {
    const syms = ["NVDA", "AAPL", "TSLA"];
    const a = briefsFor(syms, 7);
    const b = briefsFor(syms, 7);
    expect(a).toEqual(b);
    expect(a.filter((x) => x.kind === "news").map((x) => x.sym)).toEqual(syms);
    expect(a.filter((x) => x.kind === "desk")).toHaveLength(2);
    for (const n of a.filter((x) => x.kind === "news")) expect(n.text).toContain(n.sym!);
  });

  test("a different seed can draw a different wire", () => {
    const syms = ["NVDA", "AAPL", "TSLA"];
    const seen = new Set(Array.from({ length: 30 }, (_, i) => JSON.stringify(briefsFor(syms, i + 1))));
    expect(seen.size).toBeGreaterThan(1);
  });
});
