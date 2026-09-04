import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  buildMmQuotes,
  buildSnapshot,
  classify,
  classifyOrder,
  collateralTokens,
  feedSymbols,
  greeksOf,
  implementationInfo,
  mmStrikeBand,
  payoutTypeFor,
  productNameOf,
  resolveOptionBook,
  type MarketSnapshot,
  type RawMarket,
  type RawMmQuote,
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

/**
 * Three deployed implementations on Base 8453, verbatim from
 * `chainConfig.implementations`. They are the whole of BUG-2's fix: the same
 * four strikes mean different products behind different contracts, and only
 * these addresses tell them apart.
 */
const RANGER_IMPL = "0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc";
const CONDOR_IMPL = "0x14476CF2ea9F7C448100F061670E390f17c78817";
const PHYSICAL_PUT_IMPL = "0x6aD53DD058bea004829cCf58a282C21a7Df02DcA";

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

/**
 * BUG-2 (`docs/reviews/mcp-crosscheck.md`): a ranger and a condor are not
 * distinguishable by their strikes, so we stopped trying.
 *
 * The old heuristic called a four-strike order a RANGER when the strikes
 * ascended with equal outer widths and a gap in the middle. Every one of those
 * clauses is also true of a plain symmetric condor — the SDK's own
 * `calculate_payout` description spells the condor convention as
 * `[K1..K4] ASCENDING with K2-K1 === K4-K3` — and the `validateRanger` call
 * that looked like an independent second opinion accepts the identical set that
 * `validateCondor` does. So every symmetric condor on the book was typed
 * RANGER and given `payout: 'ranger'`.
 *
 * The replacement reads `rawApiData.implementation` against the chain's own
 * 46-entry implementation registry. These tests drive both halves: the lookup,
 * and what a row that cannot be looked up now says about itself.
 */
describe("classify: the strike-count fallback, and where counting stops working", () => {
  test("one, two and three strikes are still decidable by counting", () => {
    expect(classify([2500], true)).toBe("CALL");
    expect(classify([2500], false)).toBe("PUT");
    expect(classify([2400, 2600], true)).toBe("SPREAD");
    expect(classify([2400, 2500, 2600], true)).toBe("FLY");
  });

  test("four strikes is UNKNOWN — including the shape we used to call a RANGER", () => {
    // Ascending, equal widths (500 === 500), a gap in the middle. This is the
    // ranger convention AND the condor convention; nothing here separates them.
    expect(classify([79500, 80000, 81000, 81500], true)).toBe("UNKNOWN");
    // And so are all the shapes the old clauses used to exclude — they were
    // never excluding condors, only mis-shaped rangers.
    expect(classify([79500, 80000, 81000, 82000], true)).toBe("UNKNOWN");
    expect(classify([79500, 80500, 80500, 81500], true)).toBe("UNKNOWN");
    expect(classify([81500, 81000, 80000, 79500], true)).toBe("UNKNOWN");
    expect(classify([1, 2, 3, 4, 5], true)).toBe("UNKNOWN");
  });

  test("an UNKNOWN structure has no registry name and no payout type", () => {
    // The point of the member: nothing downstream can be handed a product name
    // or a payout mode that nothing authoritative backs.
    expect(productNameOf("UNKNOWN", true)).toBeNull();
    expect(payoutTypeFor("UNKNOWN", true)).toBeNull();
    expect(payoutTypeFor("UNKNOWN", false)).toBeNull();
  });
});

describe("classifyOrder: the implementation address decides, not the strikes", () => {
  /** A chain config carrying the two implementations that matter here. */
  const withImpls = {
    ...FIXTURE.chainConfig,
    optionImplementations: {
      [RANGER_IMPL.toLowerCase()]: { name: "RANGER", type: "RANGER", numStrikes: 4 },
      [CONDOR_IMPL.toLowerCase()]: { name: "CALL_CONDOR", type: "CONDOR", numStrikes: 4 },
      [PHYSICAL_PUT_IMPL.toLowerCase()]: { name: "PHYSICAL_PUT", type: "VANILLA", numStrikes: 1 },
    },
  };

  test("the very same strikes are a RANGER or a CONDOR depending on the contract", () => {
    // This is BUG-2 in one assertion: four identical numbers, two different
    // products, and only the implementation address tells them apart.
    const strikes = [79500, 80000, 81000, 81500];
    expect(classifyOrder(strikes, true, RANGER_IMPL, withImpls)).toEqual({
      structure: "RANGER",
      productName: "RANGER",
    });
    expect(classifyOrder(strikes, true, CONDOR_IMPL, withImpls)).toEqual({
      structure: "CONDOR",
      productName: "CALL_CONDOR",
    });
  });

  test("and they carry the payout type the SDK's math actually wants", () => {
    const strikes = [79500, 80000, 81000, 81500];
    const ranger = classifyOrder(strikes, true, RANGER_IMPL, withImpls);
    const condor = classifyOrder(strikes, true, CONDOR_IMPL, withImpls);
    expect(payoutTypeFor(ranger.structure, true, ranger.productName)).toBe("ranger");
    expect(payoutTypeFor(condor.structure, true, condor.productName)).toBe("call_condor");
  });

  test("the lookup is case-insensitive on the address", () => {
    expect(classifyOrder([1, 2, 3, 4], true, RANGER_IMPL.toUpperCase(), withImpls).productName).toBe(
      "RANGER",
    );
  });

  test("a physical put stays a physical put instead of being flattened to PUT", () => {
    // The smaller mislabel the heuristic also had: PHYSICAL_CALL, PHYSICAL_PUT
    // and INVERSE_CALL were all collapsed by the strike count.
    const read = classifyOrder([2500], false, PHYSICAL_PUT_IMPL, withImpls);
    expect(read.productName).toBe("PHYSICAL_PUT");
    expect(read.structure).toBe("PUT");
    expect(payoutTypeFor(read.structure, false, read.productName)).toBe("put");
  });

  test("an address the registry does not know falls back, and says nothing it cannot back", () => {
    const unknown = "0x00000000000000000000000000000000deadbeef";
    // Four strikes: the fallback cannot decide, so it does not.
    const four = classifyOrder([79500, 80000, 81000, 81500], true, unknown, withImpls);
    expect(four).toEqual({ structure: "UNKNOWN", productName: null });
    expect(payoutTypeFor(four.structure, true, four.productName)).toBeNull();
    // One strike: the count really is enough, so the row keeps its label.
    const one = classifyOrder([2500], true, unknown, withImpls);
    expect(one).toEqual({ structure: "CALL", productName: null });
    expect(payoutTypeFor(one.structure, true, one.productName)).toBe("call");
  });

  test("no address at all, and the zero address, are both 'unknown'", () => {
    // The SDK's own `buildContractOrder` refuses a zero implementation on the
    // grounds that the option type is not deployed on this chain.
    expect(classifyOrder([1, 2, 3, 4], true, undefined, withImpls).structure).toBe("UNKNOWN");
    expect(classifyOrder([1, 2, 3, 4], true, "", withImpls).structure).toBe("UNKNOWN");
    expect(
      classifyOrder([1, 2, 3, 4], true, `0x${"0".repeat(40)}`, withImpls).structure,
    ).toBe("UNKNOWN");
  });

  test("a config with no registry at all falls through to the SDK's copy of it", () => {
    // Which is what the frozen capture does — it predates our reading this
    // field and cannot be re-cut without a live book. Same 46-entry table,
    // same answers.
    expect(implementationInfo(RANGER_IMPL, FIXTURE.chainConfig)?.name).toBe("RANGER");
    expect(implementationInfo(CONDOR_IMPL, FIXTURE.chainConfig)?.name).toBe("CALL_CONDOR");
    expect(implementationInfo("0x00000000000000000000000000000000deadbeef", FIXTURE.chainConfig))
      .toBeNull();
  });

  test("a config that HAS a registry is the only one consulted", () => {
    // Purity: hand the builder a config with the map and it answers from the
    // map alone, so a test can model a chain we do not ship a table for.
    const onlyMine = {
      ...FIXTURE.chainConfig,
      optionImplementations: { "0xabc": { name: "IRON_CONDOR" } },
    };
    expect(implementationInfo(RANGER_IMPL, onlyMine)).toBeNull();
    expect(classifyOrder([1, 2, 3, 4], true, "0xABC", onlyMine)).toEqual({
      structure: "CONDOR",
      productName: "IRON_CONDOR",
    });
  });
});

describe("the snapshot labels its rows from the chain, not from the strikes", () => {
  test("the real book's four-strike orders are rangers, and the registry is why", () => {
    const ranger = rowsFor("BTC").find((r) => r.structure === "RANGER");
    expect(ranger).toBeDefined();
    expect(ranger!.type).toBe("RANGER");
    expect(ranger!.payout).toBe("ranger");
    // A range is printed as a span, not a single strike.
    expect(ranger!.strike).toContain("–");
    // And the reason is the address on the order, not the shape of its numbers:
    // the fixture's four-strike orders all name the ranger implementation.
    const fourStrike = FIXTURE.orders.filter((o) => (o.rawApiData?.strikes ?? []).length === 4);
    expect(fourStrike.length).toBeGreaterThan(0);
    for (const o of fourStrike) {
      expect(o.rawApiData!.implementation!.toLowerCase()).toBe(RANGER_IMPL.toLowerCase());
    }
  });

  test("a condor on the same strikes is NOT coloured or priced as a ranger", () => {
    // The regression BUG-2 describes: swap only the implementation address on
    // the fixture's own ranger orders and the row must change its mind.
    const asCondor = FIXTURE.orders.map((o) =>
      (o.rawApiData?.strikes ?? []).length === 4
        ? { ...o, rawApiData: { ...o.rawApiData, implementation: CONDOR_IMPL } }
        : o,
    );
    const built = buildSnapshot({ ...FIXTURE, orders: asCondor }, AT);
    const rows = built.pricing.BTC ?? [];
    expect(rows.some((r) => r.structure === "RANGER")).toBe(false);
    const condor = rows.find((r) => r.structure === "CONDOR");
    expect(condor).toBeDefined();
    expect(condor!.type).not.toBe("RANGER");
    expect(condor!.payout).toBe("call_condor");
  });

  test("a four-strike row with no implementation is quoted, unlabelled and unpriced", () => {
    // "Keep the row on the screen; assert nothing about it." The old code
    // asserted RANGER here, which is a claim about money.
    const stripped = FIXTURE.orders.map((o) =>
      (o.rawApiData?.strikes ?? []).length === 4
        ? { ...o, rawApiData: { ...o.rawApiData, implementation: undefined } }
        : o,
    );
    const rows = buildSnapshot({ ...FIXTURE, orders: stripped }, AT).pricing.BTC ?? [];
    const unknown = rows.find((r) => r.structure === "UNKNOWN");
    expect(unknown).toBeDefined();
    // Still a row: quoted, sized, and on screen.
    expect(unknown!.strike).toContain("–");
    expect(unknown!.size).toBeTruthy();
    // But claiming nothing.
    expect(unknown!.payout).toBeUndefined();
    expect(unknown!.type).not.toBe("RANGER");
  });

  test("two orders on one instrument naming two implementations forfeit the label", () => {
    // A contradiction is not a tie to break.
    const four = FIXTURE.orders.filter((o) => (o.rawApiData?.strikes ?? []).length === 4);
    expect(four.length).toBeGreaterThanOrEqual(2);
    const conflicted = FIXTURE.orders.map((o) =>
      o === four[1] ? { ...o, rawApiData: { ...o.rawApiData, implementation: CONDOR_IMPL } } : o,
    );
    const rows = buildSnapshot({ ...FIXTURE, orders: conflicted }, AT).pricing.BTC ?? [];
    // The two ranger orders are the same instrument in the capture, so they
    // group into one level — which now disagrees with itself.
    expect(rows.some((r) => r.structure === "UNKNOWN")).toBe(true);
    expect(rows.some((r) => r.structure === "RANGER")).toBe(false);
  });

  test("structure is finer than type — a spread keeps its call/put colour", () => {
    const spread = rowsFor("BTC").find((r) => r.structure === "SPREAD");
    expect(spread).toBeDefined();
    expect(spread!.type).toBe("CALL");
  });

  test("the capture's physical options are no longer flattened into vanillas", () => {
    // PHYSICAL_CALL and PHYSICAL_PUT are both in the fixture; the strike count
    // used to call them LINEAR_CALL and PUT.
    const impls = new Set(
      FIXTURE.orders.map((o) => String(o.rawApiData?.implementation ?? "").toLowerCase()),
    );
    expect(impls.has(PHYSICAL_PUT_IMPL.toLowerCase())).toBe(true);
    // Their payout type is unchanged by the correction — a physical put still
    // pays like a put — which is exactly why this mislabel had not bitten.
    expect(payoutTypeFor("PUT", false, "PHYSICAL_PUT")).toBe("put");
  });
});

// ─── the OptionBook ──────────────────────────────────────────────────────────

describe("resolveOptionBook", () => {
  test("on the real capture the chain config and the book agreed", () => {
    expect(snap.optionBook.agreed).toBe(true);
    expect(snap.optionBook.address).toBe(FIXTURE.chainConfig.contracts.optionBook!);
  });

  test("the CHAIN CONFIG wins a disagreement, and the disagreement means no fill", () => {
    // Reversed by `docs/reviews/mcp-crosscheck.md` §BUG-3. The order's
    // `optionBookAddress` is an indexer-supplied field, not part of the
    // signature, and the SDK's `resolveOptionBookTarget` throws INVALID_ORDER
    // when it disagrees with the chain config — "to prevent a compromised API
    // from redirecting fills to an attacker contract that drains pre-existing
    // allowances". `agreed: false` is that state, not an amber chip.
    const ref = resolveOptionBook(
      { ...FIXTURE.chainConfig, contracts: { optionBook: "0xConfigBook" } },
      [order({ optionBookAddress: "0xOrderBook" })],
    );
    expect(ref).toEqual({ address: "0xConfigBook", agreed: false });
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

// ─── the MM chain ────────────────────────────────────────────────────────────

describe("buildMmQuotes trims ~782 rows to the fourteen a desk reads", () => {
  test("prices are COPIED, never recomputed", () => {
    // The one rule this function exists to keep. `feeAdjustedBid`/`Ask` are
    // the venue's own post-fee numbers; the docs say the cap is 3e-4 and the
    // shipped code uses 4e-4, and the live capture agrees with the code
    // (FINDINGS §5.1). Re-deriving them here would quote a price 1bp off what
    // the book will trade — in our favour on one side, against us on the other.
    const [row] = buildMmQuotes([mm()]);
    expect(row).toEqual({
      ticker: "ETH-3SEP26-2100-C",
      type: "CALL",
      strike: "2,100",
      expiry: "3 SEP",
      bid: "0.1146", // feeAdjustedBid 0.11460000000000001, verbatim
      ask: "0.1194", // feeAdjustedAsk 0.11939999999999999, verbatim
      mark: "0.1166",
      spread: "0.0048",
    });
    // And the pre-fee numbers are nowhere near the output: raw bid 0.115 would
    // have rendered "0.1150".
    expect(row!.bid).not.toBe("0.1150");
  });

  test("spread is ask minus bid of the two published numbers, not a second fee model", () => {
    const [row] = buildMmQuotes([mm({ feeAdjustedBid: 0.2, feeAdjustedAsk: 0.25 })]);
    expect(row!.spread).toBe("0.0500");
  });

  test("only the front expiry survives", () => {
    // Three expiries at one strike read as three prices for one thing.
    const rows = buildMmQuotes([
      mm({ strike: 2400, expiry: 1_789_027_200 }),
      mm({ strike: 2400 }),
      mm({ strike: 2450, expiry: 1_789_027_200 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expiry).toBe("3 SEP");
  });

  test("strikes outside ±25% of the MM's own spot are cut", () => {
    // The band is centred on `underlyingPrice` — the price the MM quoted
    // against — not on a spot from another call taken at another instant.
    const rows = buildMmQuotes([
      mm({ strike: 1000 }), // below 1,781.82
      mm({ strike: 2400 }),
      mm({ strike: 3500 }), // above 2,969.70
    ]);
    expect(rows.map((r) => r.strike)).toEqual(["2,400"]);
  });

  test("mmStrikeBand reads the centre off the quotes and is null without one", () => {
    expect(mmStrikeBand([mm()])).toEqual({
      spot: 2375.76,
      min: 2375.76 * 0.75,
      max: 2375.76 * 1.25,
    });
    expect(mmStrikeBand([mm({ underlyingPrice: undefined })])).toBeNull();
    expect(mmStrikeBand([])).toBeNull();
  });

  test("with no spot at all nothing is cut — a missing centre is not a filter", () => {
    const rows = buildMmQuotes([
      mm({ strike: 1000, underlyingPrice: undefined }),
      mm({ strike: 3500, underlyingPrice: undefined }),
    ]);
    expect(rows).toHaveLength(2);
  });

  test("fourteen rows, and they are the fourteen nearest spot", () => {
    const strikes = Array.from({ length: 23 }, (_, i) => 1800 + i * 50); // all in band
    const rows = buildMmQuotes(strikes.map((strike) => mm({ strike })));
    expect(rows).toHaveLength(14);
    // Spot 2,375.76: the window closes at 2,050 below and 2,700 above.
    expect(rows[0]!.strike).toBe("2,050");
    expect(rows[13]!.strike).toBe("2,700");
  });

  test("the survivors come back in STRIKE order, not in nearest-to-spot order", () => {
    // The cut ranks by distance; the table must still read as a chain.
    const rows = buildMmQuotes([2500, 2200, 2400, 2300].map((strike) => mm({ strike })));
    expect(rows.map((r) => r.strike)).toEqual(["2,200", "2,300", "2,400", "2,500"]);
  });

  test("a call and a put on the same strike sit call-first", () => {
    const rows = buildMmQuotes([mm({ isCall: false }), mm({ isCall: true })]);
    expect(rows.map((r) => r.type)).toEqual(["CALL", "PUT"]);
  });

  test("an empty chain is an empty table, not a throw", () => {
    expect(buildMmQuotes([])).toEqual([]);
  });

  test("NaN and Infinity are dropped rather than rendered", () => {
    // An empty `getPricingArray` result has two indistinguishable causes
    // (FINDINGS §5.5) and a malformed row has none worth guessing at. Either
    // way the row is not shown — "NaN" in a bid column is a worse lie than a
    // missing row.
    const rows = buildMmQuotes([
      mm({ strike: NaN }),
      mm({ expiry: NaN }),
      mm({ feeAdjustedBid: NaN }),
      mm({ feeAdjustedAsk: Infinity }),
      mm({ strike: 2400 }),
    ]);
    expect(rows.map((r) => r.strike)).toEqual(["2,400"]);
  });

  test("an unusable markPrice degrades to a dash while the quote still prints", () => {
    const [row] = buildMmQuotes([mm({ markPrice: NaN })]);
    expect(row!.mark).toBe("—");
    expect(row!.bid).toBe("0.1146");
  });
});

// ─── the two namespaces ──────────────────────────────────────────────────────

describe("productNameOf / payoutTypeFor: one map, no string surgery", () => {
  test("our structure plus the call/put flag names the registry product", () => {
    expect(productNameOf("CALL", true)).toBe("LINEAR_CALL");
    expect(productNameOf("PUT", false)).toBe("PUT");
    expect(productNameOf("SPREAD", true)).toBe("CALL_SPREAD");
    expect(productNameOf("SPREAD", false)).toBe("PUT_SPREAD");
    expect(productNameOf("FLY", true)).toBe("CALL_FLY");
    expect(productNameOf("FLY", false)).toBe("PUT_FLY");
    expect(productNameOf("CONDOR", true)).toBe("CALL_CONDOR");
    expect(productNameOf("CONDOR", false)).toBe("PUT_CONDOR");
    expect(productNameOf("RANGER", true)).toBe("RANGER");
  });

  test("a RANGER is a ranger whichever way it was quoted", () => {
    // Four strikes and equal widths is the structure; the call/put flag on the
    // order says nothing about it.
    expect(payoutTypeFor("RANGER", true)).toBe("ranger");
    expect(payoutTypeFor("RANGER", false)).toBe("ranger");
  });

  test("the payout namespace is NOT the registry namespace lowercased", () => {
    // The trap: `IRON_CONDOR` → `iron_condor` survives a `.toLowerCase()` and
    // `LINEAR_CALL` → `call` does not, so lowercasing looks right until the one
    // case where it silently isn't. Three unions name these shapes and no two
    // share strings (FINDINGS "0.3.0 delta").
    expect(payoutTypeFor("CALL", true)).toBe("call");
    expect(productNameOf("CALL", true)!.toLowerCase()).toBe("linear_call");
    expect(payoutTypeFor("CONDOR", false)).toBe("put_condor");
  });

  test("a resolved product name overrides the coarse structure→name direction", () => {
    // `classifyOrder` hands back the registry key it actually read, and that
    // wins: an inverse call is a call, but it is not LINEAR_CALL.
    expect(payoutTypeFor("CALL", true, "INVERSE_CALL")).toBe("call");
    expect(payoutTypeFor("SPREAD", true, "INVERSE_CALL_SPREAD")).toBe("call_spread");
    expect(payoutTypeFor("CONDOR", true, "IRON_CONDOR")).toBe("iron_condor");
    // And a product with no payout entry — `CALL_LOAN` is a loan handler, not
    // a book option — resolves to nothing rather than to a vanilla guess.
    expect(payoutTypeFor("CALL", true, "CALL_LOAN")).toBeNull();
  });

  test("every decidable structure resolves to a payout type — none of them guesses", () => {
    const structures = ["CALL", "PUT", "SPREAD", "FLY", "CONDOR", "RANGER"] as const;
    const payouts = structures.flatMap((s) => [payoutTypeFor(s, true), payoutTypeFor(s, false)]);
    // The vanilla and ranger rows ignore the flag — `classify()` already put
    // the call/put decision INTO the structure for those, so a `CALL` quoted
    // with `isCall: false` is a contradiction the map resolves in favour of the
    // structure rather than inventing a third answer. Only the multi-leg
    // structures genuinely need the flag to pick a side.
    expect(payouts).toEqual([
      "call", "call",
      "put", "put",
      "call_spread", "put_spread",
      "call_fly", "put_fly",
      "call_condor", "put_condor",
      "ranger", "ranger",
    ]);
  });

  test("live rows carry it and the mock never does", () => {
    // The field is what defuses the 4-strike discriminator trap downstream: a
    // ranger fed to `calculatePayoutAtPrice` without `isRanger: true` prices as
    // a condor, silently.
    const ranger = rowsFor("BTC").find((r) => r.structure === "RANGER");
    expect(ranger!.payout).toBe("ranger");
    for (const u of snap.underlyings) for (const row of rowsFor(u)) expect(row.payout).toBeTruthy();
  });
});

// ─── mmPricing on the snapshot ───────────────────────────────────────────────

describe("buildSnapshot carries the MM chain beside the book", () => {
  test("each underlying is built independently", () => {
    const built = buildSnapshot(
      {
        ...FIXTURE,
        mmPricing: {
          ETH: [mm({ strike: 2400 }), mm({ strike: 2450 })],
          BTC: [mm({ underlying: "BTC", strike: 2400 })],
        },
      },
      AT,
    );
    expect(Object.keys(built.mmPricing).sort()).toEqual(["BTC", "ETH"]);
    expect(built.mmPricing.ETH).toHaveLength(2);
    expect(built.mmPricing.BTC).toHaveLength(1);
  });

  test("a pricing-host outage empties the MM panel and NOTHING else", () => {
    // The order book is the load-bearing feed; MM quotes are the second
    // opinion beside it. Two hosts, two failure modes, and only one of them is
    // allowed to empty this screen.
    const built = buildSnapshot(FIXTURE, AT);
    expect(built.mmPricing).toEqual({});
    expect(built.underlyings).toEqual(["BTC", "ETH"]);
    expect(built.orders.length).toBeGreaterThan(0);
  });

  test("an underlying whose rows are all unusable is ABSENT, not empty", () => {
    // `{ ETH: [] }` on the wire would draw a headed table with no rows under
    // it, which reads as "the MM stopped quoting ETH".
    const built = buildSnapshot({ ...FIXTURE, mmPricing: { ETH: [mm({ strike: NaN })] } }, AT);
    expect(built.mmPricing).toEqual({});
  });
});

// ─── the fill preview ────────────────────────────────────────────────────────

describe("the quote line", () => {
  /** Everything `previewFillOrder` gives us, as the builder consumes it. */
  const preview = () => ({ contracts: "0.0043", collateral: "1.00", fillable: true });

  test("only the rows that ship are previewed", () => {
    // Previewing all 426 live orders to draw 40 would be forty times the work
    // for the same screen.
    let calls = 0;
    const built = buildSnapshot(
      {
        ...FIXTURE,
        preview: () => {
          calls += 1;
          return preview();
        },
      },
      AT,
    );
    expect(calls).toBe(built.orders.length);
    for (const row of built.orders) expect(row.preview).toEqual(preview());
  });

  test("no previewer at all leaves every row without a quote line", () => {
    // Which is the mock's state, and a state the view renders as silence — not
    // as a zero, and not as "no fill available".
    for (const row of snap.orders) expect(row.preview).toBeUndefined();
  });

  test("a row the SDK refuses to preview keeps its place in the blotter", () => {
    // `previewFillOrder` throws ORDER_EXPIRED / INVALID_ORDER on orders the
    // indexer is still serving. One of those must not cost the others.
    const built = buildSnapshot({ ...FIXTURE, preview: () => null }, AT);
    expect(built.orders.length).toBe(snap.orders.length);
    for (const row of built.orders) expect(row.preview).toBeUndefined();
  });

  test("the preview reads the order it was built from, in order", () => {
    const seen: string[] = [];
    buildSnapshot(
      {
        ...FIXTURE,
        preview: (entry) => {
          seen.push(String(entry.rawApiData?.strikes?.[0]));
          return null;
        },
      },
      AT,
    );
    // Same orders, same sequence as the blotter rows themselves.
    const expected = FIXTURE.orders
      .filter((o) => (o.rawApiData?.strikes ?? []).length > 0)
      .map((o) => String(o.rawApiData!.strikes![0]));
    expect(seen).toEqual(expected.slice(0, seen.length));
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

/**
 * One MM quote — **the real one**, every field overridable.
 *
 * These defaults are not invented: they are the row `getPricingArray('ETH')`
 * returned in the capture written up as FINDINGS §1, field for field, floating
 * point tails included (`feeAdjustedBid: 0.11460000000000001` against a raw bid
 * of `0.115` — the 4e-4 fee cap the shipped code applies and the docs deny).
 * That is what makes the passthrough test above mean something: the numbers it
 * asserts are the venue's, not a rounding this file chose.
 *
 * It is a builder rather than a checked-in JSON file because the MM chain is
 * ~782 rows deep and every case here is about *which* rows survive — front
 * expiry, the ±25% band, the fourteen nearest spot. Those are shaped by strike
 * and expiry alone, and a fixture large enough to exercise them would be a
 * fixture nobody could read. The order book, where the interesting content is
 * in the fields, gets the frozen capture instead.
 */
function mm(over: Partial<RawMmQuote> = {}): RawMmQuote {
  return {
    ticker: "ETH-3SEP26-2100-C",
    feeAdjustedBid: 0.11460000000000001,
    feeAdjustedAsk: 0.11939999999999999,
    markPrice: 0.116552,
    strike: 2100,
    expiry: 1_788_422_400,
    isCall: true,
    underlying: "ETH",
    underlyingPrice: 2375.76,
    ...over,
  };
}
