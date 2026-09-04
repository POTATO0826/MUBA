import { describe, expect, test } from "bun:test";
import { mockMarketSource, type MarketSource } from "../src/data/market.ts";
import {
  BOOK_ASSETS,
  SPOT_CHIP,
  bookDelta,
  bookDeltaNote,
  fmtSpot,
  liveTag,
  seededTag,
  spotFor,
  spotPair,
} from "../src/data/spot.ts";
import { UNIVERSE } from "../src/data/universe.ts";
import type { PricingRow } from "../src/types.ts";

/**
 * Hybrid anchoring, unit half. The DOM half lives in `app.test.tsx`.
 *
 * The single most important assertion in this file is the dullest one: for
 * fourteen of the board's eighteen names, and for every name at all when the
 * source is the mock, the answer is `null`. That is not a degraded state to be
 * handled — it is the ordinary condition of most of the board, and every
 * surface has to render it as though live data were never invented.
 */

// ─── a live source, built by hand ────────────────────────────────────────────

/**
 * The six assets that carried an actual price in the capture frozen into
 * `test/fixtures/orders.json`. Two more (DOGE, PAXG) have Chainlink feeds in
 * `chainConfig` and no market price, which is why the plan's fit table says
 * "7 spot" and a real snapshot can hand back six.
 */
const LIVE_SPOT: Record<string, number> = {
  ETH: 2522.13,
  BTC: 81004.04,
  SOL: 104.0853111,
  XRP: 1.4517,
  BNB: 718.17701211,
  AVAX: 7.498,
};

function row(type: PricingRow["type"], strike: string, delta: string): PricingRow {
  return { type, strike, expiry: "27 SEP", bid: "0.1", ask: "0.11", iv: "55.0%", delta, depth: 50, size: "1.0k" };
}

/**
 * Live ETH levels on the *live* scale — strikes in the 2,400s, not the 4,000s.
 * The gap between those two scales is the whole reason `bookDelta` matches on
 * moneyness rather than on the leg's strike.
 */
const ETH_ROWS: PricingRow[] = [
  row("CALL", "2,400", "0.62"),
  row("CALL", "2,600", "0.38"),
  row("CALL", "2,800", "0.21"),
  row("PUT", "2,400", "-0.31"),
  row("PUT", "2,200", "-0.17"),
  // A four-strike level quotes a range, and a range answers no single line.
  row("RANGER", "2,300–2,900", "0.02"),
];

const BTC_ROWS: PricingRow[] = [
  row("CALL", "82,000", "0.47"),
  row("CALL", "88,000", "0.26"),
  // Typographic minus, the shape the seeded table writes. `Number()` rejects it.
  row("PUT", "78,000", "−0.29"),
];

function liveSource(
  spot: Record<string, number> = LIVE_SPOT,
  pricing: Record<string, PricingRow[]> = { ETH: ETH_ROWS, BTC: BTC_ROWS },
): MarketSource {
  return {
    id: "thetanuts · base 8453",
    meta: { ok: true, source: "live", fetchedAt: 1_788_500_000_000 },
    underlyings: () => Object.keys(pricing),
    pricing: (u) => pricing[u] ?? [],
    mmPricing: () => [],
    orders: () => [],
    spot: (u) => {
      const px = spot[u];
      return typeof px === "number" && Number.isFinite(px) ? px : null;
    },
  };
}

// ─── null is the normal case ─────────────────────────────────────────────────

describe("spotFor: null is the answer, most of the time", () => {
  test("every one of the 18 board assets is null against the mock", () => {
    expect(UNIVERSE).toHaveLength(18);
    for (const u of UNIVERSE) {
      expect(spotFor(u.sym, mockMarketSource)).toBeNull();
    }
  });

  test("against a real snapshot exactly four board names light up", () => {
    const src = liveSource();
    const lit = UNIVERSE.filter((u) => spotFor(u.sym, src) !== null).map((u) => u.sym);
    // The other two priced assets — XRP and BNB — are not on our board, and the
    // fourteen names that are on it have no Thetanuts presence at all.
    expect(lit).toEqual(["BTC", "ETH", "SOL"]);
    expect(spotFor("ETH", src)).toBe(2522.13);
    expect(spotFor("NVDA", src)).toBeNull();
    expect(spotFor("PEPE", src)).toBeNull();
  });

  test("GLD is not PAXG: a gold ETF share and an ounce of gold are different instruments", () => {
    // PAXG has a Chainlink feed on Base. Aliasing our GLD onto it would put a
    // ~$2,600 print beside a $246.10 seeded one and call them the same asset.
    const src = liveSource({ ...LIVE_SPOT, PAXG: 2612.4 });
    expect(spotFor("GLD", src)).toBeNull();
  });
});

describe("spotFor: the alias seam", () => {
  test("a snapshot that never normalised ETH/USD still resolves", () => {
    // `buildSnapshot` strips the suffix and `feedSymbols` dedupes the two
    // addresses, so this shape should not reach us — the probe is the belt to
    // that braces (FINDINGS §3).
    const src = liveSource({ "ETH/USD": 2522.13, "BTC/USD": 81004.04 });
    expect(spotFor("ETH", src)).toBe(2522.13);
    expect(spotFor("BTC", src)).toBe(81004.04);
    expect(spotFor("SOL", src)).toBeNull();
  });

  test("the bare symbol wins when both are present", () => {
    const src = liveSource({ ETH: 2522.13, "ETH/USD": 9999 });
    expect(spotFor("ETH", src)).toBe(2522.13);
  });

  test("lowercase and stray whitespace resolve", () => {
    const src = liveSource();
    expect(spotFor(" eth ", src)).toBe(2522.13);
  });

  test("zero, NaN and negatives are misses, not facts", () => {
    const src = liveSource({ ETH: 0, BTC: Number.NaN, SOL: -1 });
    expect(spotFor("ETH", src)).toBeNull();
    expect(spotFor("BTC", src)).toBeNull();
    expect(spotFor("SOL", src)).toBeNull();
  });

  test("an empty symbol asks nothing", () => {
    expect(spotFor("", liveSource())).toBeNull();
  });
});

// ─── the annotation itself ───────────────────────────────────────────────────

describe("live sits beside seeded, never instead of it", () => {
  test("the pair is the plan's pattern, verbatim", () => {
    expect(spotPair(4182.6, 2522.13)).toBe("$4,182.60 seeded · $2,522.13 live");
  });

  test("no live print means no annotation at all — not a dash, not a placeholder", () => {
    expect(spotPair(4182.6, null)).toBeNull();
    expect(liveTag(null)).toBeNull();
  });

  test("the two halves concatenate to exactly the pair", () => {
    // The pick screen colours them separately; its textContent must still match
    // what the reel's single-span pair renders.
    expect(`${seededTag(4182.6)} · ${liveTag(2522.13)}`).toBe(spotPair(4182.6, 2522.13)!);
  });

  test("cents on both halves, and the sub-dollar branches mirror the tape", () => {
    expect(fmtSpot(96410)).toBe("96,410.00");
    expect(fmtSpot(0.842)).toBe("0.8420");
    expect(fmtSpot(0.0000112)).toBe("1.12e-5");
  });

  test("the honesty chip says which is which", () => {
    expect(SPOT_CHIP).toBe("LIVE SPOT · SEEDED TAPE");
  });
});

// ─── the second opinion ──────────────────────────────────────────────────────

describe("bookDelta: the book's read on a tier's line", () => {
  const src = liveSource();

  test("ETH and BTC, and nothing else", () => {
    expect(BOOK_ASSETS).toEqual(["ETH", "BTC"]);
    // SOL has a live spot and no book. Spot is broader than the book, so the
    // gate cannot be "has a price".
    expect(bookDelta("SOL", "bull", 1.09, src)).toBeNull();
    expect(bookDelta("NVDA", "bull", 1.09, src)).toBeNull();
  });

  test("the moneyness maps onto the live scale, not the seeded one", () => {
    // ETH SHARP bull: +9% of the seeded 4,182.60 is 4,559.03, and asking the
    // same +9% of the live 2,522.13 lands on 2,749.12 — nearest live call is
    // the 2,800.
    expect(bookDelta("ETH", "bull", 1.09, src)).toBe(0.21);
    // A line right at the money takes the 2,600 instead.
    expect(bookDelta("ETH", "bull", 1.02, src)).toBe(0.38);
  });

  test("a bear card reads the puts, and takes the magnitude", () => {
    // −7% of live is 2,345.58: nearer the 2,400 put than the 2,200.
    expect(bookDelta("ETH", "bear", 0.93, src)).toBe(0.31);
    // BTC's put carries a typographic minus and must parse anyway.
    expect(bookDelta("BTC", "bear", 0.96, src)).toBe(0.29);
  });

  test("a range level is never the nearest anything", () => {
    // The RANGER row's `2,300–2,900` midpoint would otherwise beat the 2,800 on
    // some lines; it is skipped outright because a range has no single strike.
    const only = liveSource(LIVE_SPOT, { ETH: [row("RANGER", "2,300–2,900", "0.02")] });
    expect(bookDelta("ETH", "bull", 1.09, only)).toBeNull();
  });

  test("an unscoreable book shows nothing rather than inventing a delta", () => {
    // `rawApiData.greeks` is undocumented and genuinely absent sometimes;
    // `greeksOf` reports that as null and the row renders "—".
    const noGreeks = liveSource(LIVE_SPOT, { ETH: [row("CALL", "2,800", "—")] });
    expect(bookDelta("ETH", "bull", 1.09, noGreeks)).toBeNull();
  });

  test("no live spot means no scale to map onto — which is what keeps it off the mock", () => {
    // The mock's seeded pricing table does carry deltas. It has no spot, and
    // that alone is enough.
    expect(mockMarketSource.pricing("ETH").length).toBeGreaterThan(0);
    expect(bookDelta("ETH", "bull", 1.09, mockMarketSource)).toBeNull();
    // A live book with the spot feed down, likewise.
    expect(bookDelta("ETH", "bull", 1.09, liveSource({}))).toBeNull();
  });

  test("a nonsense moneyness is refused", () => {
    expect(bookDelta("ETH", "bull", 0, src)).toBeNull();
    expect(bookDelta("ETH", "bull", Number.NaN, src)).toBeNull();
  });

  test("the note is what the card renders, and it is null when the delta is", () => {
    expect(bookDeltaNote("ETH", "bull", 1.09, src)).toBe("book Δ 0.21 (second opinion)");
    expect(bookDeltaNote("ETH", "bull", 1.09, mockMarketSource)).toBeNull();
  });
});

// ─── the locks this phase must not have moved ────────────────────────────────

describe("the seeded board is exactly where it was", () => {
  /**
   * All eighteen rows, pinned. `universe.ts` carries the four absolute price
   * locks the determinism suite settles against, so a live spot that ever
   * *replaced* a seeded one would surface here first — this is the cheapest
   * possible statement of "P4 changed no seeded number anywhere".
   */
  test("all 18 rows, symbol and price", () => {
    expect(UNIVERSE.map((u) => [u.sym, u.px])).toEqual([
      ["NVDA", 118.4],
      ["AAPL", 232.1],
      ["TSLA", 248.6],
      ["XOM", 112.3],
      ["JPM", 214.8],
      ["AMD", 158.2],
      ["META", 604.5],
      ["GLD", 246.1],
      ["COIN", 188.7],
      ["BTC", 96410],
      ["ETH", 4182.6],
      ["SOL", 214.4],
      ["ARB", 0.842],
      ["LINK", 22.86],
      ["UNI", 13.42],
      ["AAVE", 178.3],
      ["DOGE", 0.164],
      ["PEPE", 0.0000112],
    ]);
  });

  test("and their targets and vols with them", () => {
    expect(UNIVERSE.map((u) => [u.t, u.vol])).toEqual([
      [4.0, 0.03],
      [2.0, 0.016],
      [5.0, 0.034],
      [1.5, 0.014],
      [1.5, 0.013],
      [4.5, 0.031],
      [2.5, 0.019],
      [1.0, 0.009],
      [6.0, 0.04],
      [4.0, 0.028],
      [5.0, 0.036],
      [7.0, 0.052],
      [9.0, 0.061],
      [6.5, 0.048],
      [8.0, 0.055],
      [8.5, 0.058],
      [12.0, 0.074],
      [16.0, 0.092],
    ]);
  });
});
