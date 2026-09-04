import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildSnapshot,
  classify,
  collateralTokens,
  feedSymbols,
  greeksOf,
  resolveOptionBook,
  type MarketSnapshot,
  type RawMarket,
  type RawOrderEntry,
} from "../src/server/thetanuts.ts";
import type { PricingRow } from "../src/types.ts";

/**
 * The book builder, offline.
 *
 * Every test here runs the *real* transformation — feed-address dedupe, level
 * grouping, best-of-each-side, median-IV edge, collateral valuation, depth
 * scaling, structure classification, sort — over `fixtures/orders.json`: one
 * genuine `fetchOrders()` + `getMarketData()` response from Base mainnet,
 * trimmed to 30 orders and frozen. Nothing here opens a socket, and
 * `buildSnapshot` cannot: it is pure, takes its clock as an argument, and has
 * no idea a network exists.
 *
 * The fixture's own `_provenance` block says when it was captured, from what,
 * and which cases it was trimmed to cover.
 */

const AT = 1_788_500_000_000;

const FIXTURE = (await Bun.file(join(import.meta.dir, "fixtures", "orders.json")).json()) as
  RawMarket & { _provenance: { captured: string } };

const snap: MarketSnapshot = buildSnapshot(FIXTURE, AT);

const rowsFor = (u: string): PricingRow[] => snap.pricing[u] ?? [];
const find = (u: string, strike: string): PricingRow | undefined =>
  rowsFor(u).find((r) => r.strike === strike);

// ─── the fixture itself ──────────────────────────────────────────────────────

describe("the fixture is one real response and still covers what it claims", () => {
  test("it carries its own provenance", () => {
    expect(FIXTURE._provenance.captured).toBeTruthy();
    expect(FIXTURE.orders).toHaveLength(30);
  });

  test("both sides, both underlyings, and orders with no greeks are present", () => {
    expect(FIXTURE.orders.some((o) => o.order.isBuyer)).toBe(true);
    expect(FIXTURE.orders.some((o) => !o.order.isBuyer)).toBe(true);
    expect(FIXTURE.orders.some((o) => !o.rawApiData?.greeks)).toBe(true);
    expect(snap.underlyings).toEqual(["BTC", "ETH"]);
  });
});

// ─── grouping ────────────────────────────────────────────────────────────────

describe("grouping", () => {
  test("orders collapse into levels keyed by underlying, type, strikes and expiry", () => {
    // 30 orders, far fewer levels: several makers quote the same instrument.
    const levels = rowsFor("ETH").length + rowsFor("BTC").length;
    expect(levels).toBeGreaterThan(0);
    expect(levels).toBeLessThan(FIXTURE.orders.length);
  });

  test("only underlyings with a book are listed — the feed map is longer", () => {
    // 8 assets have price feeds; the fixture's orders quote two of them.
    expect(Object.keys(FIXTURE.chainConfig.priceFeeds).length).toBeGreaterThan(
      snap.underlyings.length,
    );
    for (const u of snap.underlyings) expect(rowsFor(u).length).toBeGreaterThan(0);
  });

  test("rows are sorted by expiry, then by NUMERIC strike", () => {
    // The bug this pins: "100,000" sorts before "9,000" as a string, so the
    // sort has to run off the level's number, not the formatted cell.
    for (const u of snap.underlyings) {
      const numeric = rowsFor(u).map((r) => Number(r.strike.split("–")[0]!.replaceAll(",", "")));
      expect(numeric).toEqual([...numeric].sort((a, b) => a - b));
    }
  });
});

// ─── best bid / best ask ─────────────────────────────────────────────────────

describe("best bid and best ask come off the right sides", () => {
  test("bid is the highest a maker will pay; ask is the lowest anyone will take", () => {
    const raw: RawMarket = {
      ...FIXTURE,
      orders: [
        order({ isBuyer: true, price: "100000000", strikes: ["250000000000"] }),
        order({ isBuyer: true, price: "120000000", strikes: ["250000000000"] }),
        order({ isBuyer: false, price: "180000000", strikes: ["250000000000"] }),
        order({ isBuyer: false, price: "150000000", strikes: ["250000000000"] }),
      ],
    };
    const row = buildSnapshot(raw, AT).pricing.ETH?.[0];
    expect(row?.bid).toBe("1.2000"); // the higher of the two bids
    expect(row?.ask).toBe("1.5000"); // the lower of the two asks
  });

  test("a two-sided level gets a midpoint", () => {
    const two = rowsFor("BTC").find((r) => r.bid !== "—" && r.ask !== "—");
    expect(two).toBeDefined();
    const mid = (Number(two!.bid) + Number(two!.ask)) / 2;
    expect(two!.mid).toBe(mid.toFixed(4));
  });

  test("a one-sided level renders '—' and has NO midpoint", () => {
    // The live book is one-sided per order and 206 of 215 levels on the
    // capture had only one side. A missing side is a dash, never a zero — a
    // zero bid would read as "someone will pay nothing", which is a quote.
    const oneSided = rowsFor("ETH").filter((r) => r.bid === "—" || r.ask === "—");
    expect(oneSided.length).toBeGreaterThan(0);
    for (const row of oneSided) expect(row.mid).toBeUndefined();
  });
});

// ─── formatting ──────────────────────────────────────────────────────────────

describe("decimals", () => {
  test("strikes are 8dp on the wire and read as money", () => {
    // 265000000000 / 1e8 = 2650
    expect(find("ETH", "2,650")).toBeDefined();
    const strikes = FIXTURE.orders[0]!.rawApiData?.strikes ?? [];
    expect(Number(BigInt(strikes[0]!)) / 1e8).toBe(2650);
  });

  test("prices are 8dp and render to 4", () => {
    for (const u of snap.underlyings) {
      for (const row of rowsFor(u)) {
        if (row.bid !== "—") expect(row.bid).toMatch(/^\d+\.\d{4}$/);
        if (row.ask !== "—") expect(row.ask).toMatch(/^\d+\.\d{4}$/);
      }
    }
  });

  test("collateral decimals come from the chain config, not a constant", () => {
    // The bug this pins: the transplanted builder scaled every amount by 6dp.
    // The live book is collateralised in USDC (6), aBasUSDC (6), cbBTC (8) and
    // aBasWETH (18); at a flat 6 a WETH level came out as "3962153.5M" and
    // flattened every honest bar beside it.
    const tokens = collateralTokens(FIXTURE.chainConfig, { ETH: 2522.13, BTC: 81004.04 });
    expect(tokens.get("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913")).toEqual({
      decimals: 6,
      usd: 1,
    });
    expect(tokens.get("0xd4a0e0b9149bcee3c920d2e00b5de09138fd8bb7")).toEqual({
      decimals: 18,
      usd: 2522.13, // aBasWETH → WETH → ETH spot
    });
    expect(tokens.get("0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf")).toEqual({
      decimals: 8,
      usd: 81004.04, // cbBTC → BTC spot
    });
    // And nothing on the built board is absurd any more.
    for (const u of snap.underlyings) for (const row of rowsFor(u)) expect(row.size).not.toContain("M");
  });

  test("availableAmount is a COLLATERAL BUDGET, not a contract count", () => {
    // FINDINGS §2: `availableAmount === rawApiData.maxCollateralUsable` while
    // `order.numContracts` was `0n` on the sampled order. The size column and
    // the depth bar therefore mean "how much this level will absorb". Reading
    // it as contracts would price a $10,000 level as ten thousand options.
    const usdc = FIXTURE.orders.find(
      (o) =>
        o.rawApiData?.collateral?.toLowerCase() ===
        "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    );
    expect(usdc).toBeDefined();
    const budget = (usdc!.rawApiData as { maxCollateralUsable?: string }).maxCollateralUsable;
    expect(String(usdc!.availableAmount)).toBe(String(budget));

    // One level, one order, USDC: 10_000_000_000 at 6dp is $10,000 of budget.
    const solo = buildSnapshot(
      { ...FIXTURE, orders: [order({ availableAmount: "10000000000" })] },
      AT,
    );
    expect(solo.pricing.ETH?.[0]?.size).toBe("10.0k");
  });
});

// ─── the edge signal ─────────────────────────────────────────────────────────

describe("median-IV edge", () => {
  test("it is signed distance from the median of the row's own group", () => {
    // Three ETH puts on one expiry: IVs 40%, 50%, 60% → median 50%.
    const raw: RawMarket = {
      ...FIXTURE,
      orders: [
        order({ strikes: ["240000000000"], greeks: { delta: -0.1, iv: 0.4 } }),
        order({ strikes: ["250000000000"], greeks: { delta: -0.2, iv: 0.5 } }),
        order({ strikes: ["260000000000"], greeks: { delta: -0.3, iv: 0.6 } }),
      ],
    };
    const rows = buildSnapshot(raw, AT).pricing.ETH ?? [];
    expect(rows.map((r) => r.edge)).toEqual([-0.2, 0, 0.2]);
  });

  test("both signs occur on the real book", () => {
    const edges = [...rowsFor("ETH"), ...rowsFor("BTC")]
      .map((r) => r.edge)
      .filter((e): e is number => typeof e === "number");
    expect(edges.some((e) => e > 0)).toBe(true);
    expect(edges.some((e) => e < 0)).toBe(true);
  });

  test("no greeks means edge is undefined, not zero", () => {
    // Zero would read as "fairly priced", which is a claim. `undefined` is
    // "unscoreable", and `playableRows` filters exactly on that.
    const raw: RawMarket = { ...FIXTURE, orders: [order({ greeks: undefined })] };
    const row = buildSnapshot(raw, AT).pricing.ETH?.[0];
    expect(row?.edge).toBeUndefined();
    expect(row?.iv).toBe("—");
    expect(row?.delta).toBe("—");
  });

  test("the real book has rows with no greeks and they carry no edge", () => {
    const unscoreable = [...rowsFor("ETH"), ...rowsFor("BTC")].filter((r) => r.iv === "—");
    expect(unscoreable.length).toBeGreaterThan(0);
    for (const row of unscoreable) expect(row.edge).toBeUndefined();
  });
});

// ─── greeks, defensively ─────────────────────────────────────────────────────

describe("greeksOf shape-checks an undocumented field", () => {
  test("the happy shape passes through", () => {
    expect(greeksOf({ delta: 0.5, iv: 0.62, gamma: 1, theta: 2, vega: 3 })).toEqual({
      delta: 0.5,
      iv: 0.62,
    });
  });

  test("every not-a-number is null", () => {
    expect(greeksOf(undefined)).toEqual({ delta: null, iv: null });
    expect(greeksOf(null)).toEqual({ delta: null, iv: null });
    expect(greeksOf("0.5")).toEqual({ delta: null, iv: null });
    expect(greeksOf({ delta: "0.5", iv: null })).toEqual({ delta: null, iv: null });
    expect(greeksOf({ delta: NaN, iv: Infinity })).toEqual({ delta: null, iv: null });
  });

  test("a half-populated object keeps the half that is real", () => {
    expect(greeksOf({ delta: 0.4 })).toEqual({ delta: 0.4, iv: null });
  });

  test("greeksSeen counts the orders that had any", () => {
    const withGreeks = FIXTURE.orders.filter((o) => {
      const g = greeksOf(o.rawApiData?.greeks);
      return g.delta !== null || g.iv !== null;
    });
    expect(snap.greeksSeen).toBe(withGreeks.length);
    expect(snap.greeksSeen).toBeGreaterThan(0);
    expect(snap.greeksSeen).toBeLessThan(FIXTURE.orders.length);
  });
});

// ─── the feed map ────────────────────────────────────────────────────────────

describe("price-feed aliases collapse", () => {
  test("ETH/USD and ETH are one address and must resolve to one symbol", () => {
    const feeds = FIXTURE.chainConfig.priceFeeds;
    expect(feeds.ETH).toBe(feeds["ETH/USD"]!);
    const map = feedSymbols(feeds);
    // 10 keys, 8 distinct assets (FINDINGS §3).
    expect(Object.keys(feeds)).toHaveLength(10);
    expect(map.size).toBe(8);
    expect(map.get(feeds.ETH!.toLowerCase())).toBe("ETH");
    expect(map.get(feeds.BTC!.toLowerCase())).toBe("BTC");
  });

  test("an unaliased feed keeps its own symbol", () => {
    const map = feedSymbols({ SOL: "0xabc", "SOL/USD": "0xabc", PAXG: "0xdef" });
    expect(map.get("0xabc")).toBe("SOL");
    expect(map.get("0xdef")).toBe("PAXG");
  });
});

// ─── depth ───────────────────────────────────────────────────────────────────

describe("depth scales per underlying with a floor of 2", () => {
  test("the biggest level in each underlying is 100", () => {
    for (const u of snap.underlyings) {
      expect(Math.max(...rowsFor(u).map((r) => r.depth))).toBe(100);
    }
  });

  test("a level dwarfed by its own underlying still draws a bar", () => {
    // A bar of width 0 reads as "no liquidity", which is a different claim
    // from "a little". Scaling is per underlying so one huge BTC level cannot
    // flatten the ETH column.
    const raw: RawMarket = {
      ...FIXTURE,
      orders: [
        order({ strikes: ["250000000000"], availableAmount: "10000000000" }), // $10,000
        order({ strikes: ["260000000000"], availableAmount: "1000000" }), // $1
      ],
    };
    const rows = buildSnapshot(raw, AT).pricing.ETH ?? [];
    expect(rows.map((r) => r.depth)).toEqual([100, 2]);
  });

  test("a level with no size at all is 0, not 2", () => {
    const raw: RawMarket = {
      ...FIXTURE,
      orders: [
        order({ strikes: ["250000000000"], availableAmount: "10000000000" }),
        order({ strikes: ["260000000000"], availableAmount: "0" }),
      ],
    };
    const rows = buildSnapshot(raw, AT).pricing.ETH ?? [];
    expect(rows[1]?.depth).toBe(0);
  });
});

// ─── classify ────────────────────────────────────────────────────────────────

describe("classify: ranger vs condor is the four-strike decision", () => {
  test("strike count picks everything else", () => {
    expect(classify([2500], true)).toBe("CALL");
    expect(classify([2500], false)).toBe("PUT");
    expect(classify([2400, 2600], true)).toBe("SPREAD");
    expect(classify([2400, 2500, 2600], true)).toBe("FLY");
  });

  test("equal wing widths plus a zone gap is a RANGER", () => {
    // [callLower, callUpper, putLower, putUpper], ascending, widths equal
    // (500 === 500), and callUpper (80000) < putLower (81000).
    expect(classify([79500, 80000, 81000, 81500], true)).toBe("RANGER");
  });

  test("unequal wing widths is a CONDOR, not a ranger", () => {
    // The trap this guards (FINDINGS, "the 4-strike discriminator trap"): the
    // SDK prices a 4-strike order as a condor unless told `isRanger`, so a
    // wrong RANGER here would later mis-price a real payout.
    expect(classify([79500, 80000, 81000, 82000], true)).toBe("CONDOR");
  });

  test("no zone gap is a CONDOR", () => {
    expect(classify([79500, 80500, 80500, 81500], true)).toBe("CONDOR");
  });

  test("descending strikes are a CONDOR — the SDK's own validator is not enough", () => {
    // `validateRanger` checks widths; it does not reject a descending set.
    // The ascending check is ours, and this is why.
    expect(classify([81500, 81000, 80000, 79500], true)).toBe("CONDOR");
  });

  test("more than four strikes falls back to CONDOR", () => {
    expect(classify([1, 2, 3, 4, 5], true)).toBe("CONDOR");
  });

  test("the real book's four-strike orders classify as rangers and keep type RANGER", () => {
    const ranger = rowsFor("BTC").find((r) => r.structure === "RANGER");
    expect(ranger).toBeDefined();
    expect(ranger!.type).toBe("RANGER");
    // A range is printed as a span, not a single strike.
    expect(ranger!.strike).toContain("–");
  });

  test("structure is finer than type — a spread keeps its call/put colour", () => {
    const spread = rowsFor("BTC").find((r) => r.structure === "SPREAD");
    expect(spread).toBeDefined();
    expect(spread!.type).toBe("CALL");
  });
});

// ─── the OptionBook ──────────────────────────────────────────────────────────

describe("resolveOptionBook", () => {
  test("on the real capture the chain config and the book agreed", () => {
    expect(snap.optionBook.agreed).toBe(true);
    expect(snap.optionBook.address).toBe(FIXTURE.chainConfig.contracts.optionBook!);
  });

  test("the ORDER's address wins a disagreement, and the disagreement is reported", () => {
    // An order is a signature over one book contract; a fill sent anywhere
    // else reverts, whatever the config or a docs page says.
    const ref = resolveOptionBook(
      { ...FIXTURE.chainConfig, contracts: { optionBook: "0xConfigBook" } },
      [order({ optionBookAddress: "0xOrderBook" })],
    );
    expect(ref).toEqual({ address: "0xOrderBook", agreed: false });
  });

  test("case does not make a disagreement", () => {
    const ref = resolveOptionBook({ ...FIXTURE.chainConfig, contracts: { optionBook: "0xABC" } }, [
      order({ optionBookAddress: "0xabc" }),
    ]);
    expect(ref.agreed).toBe(true);
  });

  test("no order names a book: the config stands and nothing is in dispute", () => {
    const ref = resolveOptionBook(
      { ...FIXTURE.chainConfig, contracts: { optionBook: "0xConfigBook" } },
      [order({ optionBookAddress: undefined })],
    );
    expect(ref).toEqual({ address: "0xConfigBook", agreed: true });
  });
});

// ─── the empty and the malformed ─────────────────────────────────────────────

describe("empty-book safety", () => {
  test("no orders at all builds a real, empty snapshot", () => {
    const empty = buildSnapshot({ ...FIXTURE, orders: [] }, AT);
    expect(empty.at).toBe(AT);
    expect(empty.underlyings).toEqual([]);
    expect(empty.pricing).toEqual({});
    expect(empty.orders).toEqual([]);
    expect(empty.greeksSeen).toBe(0);
    expect(empty.optionBook.address).toBe(FIXTURE.chainConfig.contracts.optionBook!);
  });

  test("an order on an unknown feed, or with no strikes, is skipped rather than fatal", () => {
    const raw: RawMarket = {
      ...FIXTURE,
      orders: [
        order({ priceFeed: "0xnot-a-feed" }),
        order({ strikes: [] }),
        order({ strikes: ["250000000000"] }),
      ],
    };
    const built = buildSnapshot(raw, AT);
    expect(built.underlyings).toEqual(["ETH"]);
    expect(built.pricing.ETH).toHaveLength(1);
  });

  test("no prices and no feeds is empty, not a throw", () => {
    const built = buildSnapshot(
      { orders: FIXTURE.orders, prices: {}, chainConfig: { priceFeeds: {}, contracts: { optionBook: null } } },
      AT,
    );
    expect(built.underlyings).toEqual([]);
    expect(built.spot).toEqual({});
    expect(built.optionBook.address).toBe(FIXTURE.orders[0]!.rawApiData!.optionBookAddress!);
  });

  test("spot strips the /USD alias and drops anything unparseable", () => {
    const built = buildSnapshot(
      { ...FIXTURE, prices: { "ETH/USD": 2522.13, BTC: 81004.04, PAXG: NaN } },
      AT,
    );
    expect(built.spot).toEqual({ ETH: 2522.13, BTC: 81004.04 });
  });

  test("`at` is whatever the caller passed — the builder owns no clock", () => {
    expect(buildSnapshot(FIXTURE, 1).at).toBe(1);
    expect(snap.at).toBe(AT);
  });
});

// ─── a synthetic order, for the cases the live book did not hand us ──────────

/**
 * One ETH put, USDC-collateralised, with greeks — every field overridable.
 *
 * Used only where the fixture cannot express a case by construction (a
 * deliberate bid/ask ladder, a $1 level, a book that disagrees with its chain
 * config). Everything a real response *does* contain is asserted against the
 * fixture instead.
 */
function order(over: {
  isBuyer?: boolean;
  price?: string;
  availableAmount?: string;
  strikes?: string[];
  isCall?: boolean;
  priceFeed?: string;
  optionBookAddress?: string | undefined;
  greeks?: unknown;
} = {}): RawOrderEntry {
  return {
    order: { price: over.price ?? "100000000", isBuyer: over.isBuyer ?? true },
    availableAmount: over.availableAmount ?? "10000000000",
    rawApiData: {
      collateral: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      priceFeed: over.priceFeed ?? FIXTURE.chainConfig.priceFeeds.ETH!,
      strikes: over.strikes ?? ["250000000000"],
      isCall: over.isCall ?? false,
      orderExpiryTimestamp: 1_788_514_414,
      optionBookAddress:
        "optionBookAddress" in over ? over.optionBookAddress : "0x1bDff855d6811728acaDC00989e79143a2bdfDed",
      greeks: "greeks" in over ? over.greeks : { delta: -0.1, iv: 0.5, gamma: 0, theta: 0, vega: 0 },
    },
  };
}
