/**
 * The asset gate, offline.
 *
 * Every test here runs the real gate over `fixtures/orders.json` — one genuine
 * `fetchOrders()` + `getMarketData()` response from Base mainnet, trimmed to 30
 * orders and frozen — or over a *mutation* of it built by the helpers below.
 * The mutations exist so each of the four conditions can be failed
 * independently: a live book that happens to fail condition 3 today is not a
 * test, it is a coincidence, and it would stop testing anything the day a maker
 * turned their greeks back on.
 *
 * Nothing here opens a socket. `probeAssets` is pure and takes its clock as an
 * argument, which is the whole reason a frozen capture can drive it.
 *
 * @see plan6-real-parlay.md §7
 * @see src/data/qualify.ts
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  CONDITION_REASON,
  MIN_DEPTH_USDC,
  MIN_GREEKED,
  MIN_ORDERS,
  feedIndex,
  gradeOf,
  probeAssets,
  qualifiedAssets,
  qualifiedUnderlyings,
  usableDelta,
  type QualifySnapshot,
} from "../src/data/qualify.ts";
import { feedSymbols, type RawMarket } from "../src/server/thetanuts.ts";

const FIXTURE = (await Bun.file(join(import.meta.dir, "fixtures", "orders.json")).json()) as
  RawMarket & { _provenance: { captured: string } };

/**
 * The compile-time half of the contract: the real `RawMarket` is structurally
 * assignable to `QualifySnapshot` with no import and no adapter, which is what
 * lets `buildSnapshot`'s own `raw` argument be handed straight to the gate.
 * If someone narrows `RawMarket`, this line fails `tsc` before any test runs.
 */
const AS_SNAPSHOT: QualifySnapshot = FIXTURE;

/** Feed addresses, verbatim from the frozen `chainConfig.priceFeeds`. */
const ETH_FEED = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const BTC_FEED = "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
/** Aave-on-Base WETH: 18 decimals, and worth `spot.ETH` each — the token that
 *  makes "sum the integers" wrong by fifteen orders of magnitude. */
const ABAS_WETH = "0xD4a0e0b9149BCee3C920d2E00b5dE09138fd8bb7";

type RawEntry = RawMarket["orders"][number];

/** A deep clone, so a mutation in one test cannot leak into another. */
const clone = (): RawMarket & { _provenance: { captured: string } } => structuredClone(FIXTURE);

/** Orders on one asset, by feed address. Returns the live entries, so mutating
 *  one of them mutates the clone it came from. */
const ordersOn = (snap: { orders?: readonly RawEntry[] }, feed: string): RawEntry[] =>
  (snap.orders ?? []).filter(
    (o) => String(o.rawApiData?.priceFeed ?? "").toLowerCase() === feed.toLowerCase(),
  );

/** The report for one underlying, which every test below is asserting about. */
const reportFor = (snap: QualifySnapshot, underlying: string, at?: number) =>
  probeAssets(snap, at).find((r) => r.underlying === underlying);

// ─── the fixture itself ──────────────────────────────────────────────────────

describe("the frozen capture is what these tests think it is", () => {
  test("30 orders, 10 feed keys, 6 market prices, no PAXG price", () => {
    expect(FIXTURE.orders.length).toBe(30);
    expect(Object.keys(FIXTURE.chainConfig.priceFeeds).length).toBe(10);
    expect(FIXTURE.chainConfig.priceFeeds["ETH/USD"]).toBe(FIXTURE.chainConfig.priceFeeds.ETH!);
    expect(FIXTURE.chainConfig.priceFeeds["BTC/USD"]).toBe(FIXTURE.chainConfig.priceFeeds.BTC!);
    // PAXG has a price feed and no market price — FINDINGS §5.8. That asymmetry
    // is condition 1's entire reason to exist.
    expect(FIXTURE.chainConfig.priceFeeds.PAXG).toBeTruthy();
    expect(FIXTURE.prices.PAXG).toBeUndefined();
  });

  test("the capture really does carry both tradable underlyings", () => {
    expect(ordersOn(FIXTURE, ETH_FEED).length).toBe(16);
    expect(ordersOn(FIXTURE, BTC_FEED).length).toBe(14);
  });
});

// ─── the constants ───────────────────────────────────────────────────────────

describe("thresholds are the plan's, not something that drifted", () => {
  test("6 / 4 / 50", () => {
    expect(MIN_ORDERS).toBe(6);
    expect(MIN_GREEKED).toBe(4);
    // 25 × MAX_FILL_USDC ($2). A fill must not move the book it was quoted from.
    expect(MIN_DEPTH_USDC).toBe(50);
  });

  test("every failure code has a sentence a lobby can render", () => {
    for (const code of ["SPOT", "ORDERS", "GREEKS", "DEPTH"] as const) {
      expect(CONDITION_REASON[code].length).toBeGreaterThan(0);
    }
  });
});

// ─── alias collapse, by address ──────────────────────────────────────────────

describe("aliases collapse by ADDRESS, before anything else happens", () => {
  test("ETH appears exactly once — 10 feed keys, 8 rows", () => {
    const names = probeAssets(AS_SNAPSHOT).map((r) => r.underlying);
    expect(names.filter((n) => n === "ETH").length).toBe(1);
    expect(names.filter((n) => n === "BTC").length).toBe(1);
    expect(names).not.toContain("ETH/USD");
    expect(names).not.toContain("BTC/USD");
    expect(names.length).toBe(8);
    expect(new Set(names).size).toBe(8);
  });

  test("ETH appears exactly once in the qualified set the reel deals from", () => {
    const qualified = qualifiedUnderlyings(AS_SNAPSHOT);
    expect(qualified.filter((u) => u === "ETH").length).toBe(1);
    expect(new Set(qualified).size).toBe(qualified.length);
  });

  test("the alias wins nothing even when it is listed first", () => {
    // Deduplicating by KEY would keep whichever came first and put `ETH/USD` on
    // the reel. Deduplicating by ADDRESS keeps the bare symbol either way.
    const index = feedIndex({ "ETH/USD": ETH_FEED, ETH: ETH_FEED });
    expect([...index.values()]).toEqual(["ETH"]);
  });

  test("a checksummed alias and a lowercased one are the same feed", () => {
    const index = feedIndex({ ETH: ETH_FEED, "ETH/USD": ETH_FEED.toLowerCase() });
    expect(index.size).toBe(1);
    expect(index.get(ETH_FEED.toLowerCase())).toBe("ETH");
  });

  test("an order naming the ALIAS address still tallies to ETH", () => {
    const snap = clone();
    const extra = structuredClone(ordersOn(snap, ETH_FEED)[0]!);
    // The alias address is byte-identical to the bare one in the live config,
    // so this is what an order "naming ETH/USD" actually looks like on the wire.
    extra.rawApiData!.priceFeed = snap.chainConfig.priceFeeds["ETH/USD"]!;
    snap.orders = [...snap.orders, extra];
    expect(reportFor(snap, "ETH")!.orders).toBe(17);
    expect(probeAssets(snap).map((r) => r.underlying).filter((n) => n === "ETH").length).toBe(1);
  });

  test("feedIndex agrees with the server builder's own feedSymbols", () => {
    // The two are deliberately separate implementations — this module must not
    // import a file that loads the SDK and ethers — so their agreement is
    // asserted rather than assumed.
    const mine = feedIndex(FIXTURE.chainConfig.priceFeeds);
    const theirs = feedSymbols(FIXTURE.chainConfig.priceFeeds);
    expect([...mine.entries()].sort()).toEqual([...theirs.entries()].sort());
  });
});

// ─── the base case ───────────────────────────────────────────────────────────

describe("the frozen book qualifies exactly the assets it can produce cards for", () => {
  test("ETH and BTC qualify; nothing else does", () => {
    expect(qualifiedUnderlyings(AS_SNAPSHOT)).toEqual(["ETH", "BTC"]);
  });

  test("the qualified rows carry the numbers the gate measured", () => {
    const [eth, btc] = qualifiedAssets(AS_SNAPSHOT);
    expect(eth!.underlying).toBe("ETH");
    expect(eth!.orders).toBe(16);
    expect(eth!.greeked).toBe(16);
    expect(eth!.spot).toBeCloseTo(2522.13, 6);
    // 5 of the 14 BTC orders carry `delta: null` — greeks are undocumented and
    // genuinely absent, which is exactly why condition 3 counts rather than
    // assumes.
    expect(btc!.greeked).toBe(9);
    expect(btc!.orders).toBe(14);
  });

  test("the row order is the feed map's order, so the probe table is stable", () => {
    expect(probeAssets(AS_SNAPSHOT).map((r) => r.underlying)).toEqual([
      "ETH", "BTC", "SOL", "DOGE", "XRP", "BNB", "PAXG", "AVAX",
    ]);
  });

  test("it is idempotent — the same capture measures the same twice", () => {
    expect(probeAssets(AS_SNAPSHOT)).toEqual(probeAssets(AS_SNAPSHOT));
  });

  test("qualifiedUnderlyings is a projection of qualifiedAssets", () => {
    expect(qualifiedUnderlyings(AS_SNAPSHOT)).toEqual(
      qualifiedAssets(AS_SNAPSHOT).map((a) => a.underlying),
    );
  });
});

// ─── condition 1: spot is readable ───────────────────────────────────────────

describe("condition 1 — spot is readable", () => {
  test("PAXG is rejected for having a feed and no market price", () => {
    const paxg = reportFor(AS_SNAPSHOT, "PAXG")!;
    expect(paxg.qualified).toBe(false);
    expect(paxg.spot).toBeNull();
    expect(paxg.failed).toContain("SPOT");
  });

  test("it fails independently — remove one price and only SPOT is missing", () => {
    const snap = clone();
    delete (snap.prices as Record<string, number>).ETH;
    const eth = reportFor(snap, "ETH")!;
    expect(eth.qualified).toBe(false);
    expect(eth.failed).toEqual(["SPOT"]);
    // The other three still measured fine — the book did not change.
    expect(eth.orders).toBe(16);
    expect(eth.greeked).toBe(16);
    expect(eth.depthUsd).toBeGreaterThan(MIN_DEPTH_USDC);
    expect(qualifiedUnderlyings(snap)).toEqual(["BTC"]);
  });

  test("a zero or negative price is a broken feed, not a readable one", () => {
    for (const bad of [0, -1] as const) {
      const snap = clone();
      (snap.prices as Record<string, number>).ETH = bad;
      expect(reportFor(snap, "ETH")!.failed).toContain("SPOT");
    }
  });

  test("a price posted under the alias key still reads", () => {
    const snap = clone();
    const price = snap.prices.ETH!;
    delete (snap.prices as Record<string, number>).ETH;
    (snap.prices as Record<string, number>)["ETH/USD"] = price;
    expect(reportFor(snap, "ETH")!.spot).toBeCloseTo(price, 6);
    expect(qualifiedUnderlyings(snap)).toContain("ETH");
  });
});

// ─── condition 2: resting orders exist ───────────────────────────────────────

describe("condition 2 — enough fillable resting orders", () => {
  test("it fails independently at MIN_ORDERS - 1", () => {
    const snap = clone();
    // Five USDC-collateralised ETH orders: greeked 5 (≥ 4) and $50k deep, so
    // ORDERS is the only condition left to fail.
    const kept = ordersOn(snap, ETH_FEED)
      .filter((o) => o.rawApiData?.collateral === USDC)
      .slice(0, MIN_ORDERS - 1);
    snap.orders = [...kept, ...ordersOn(snap, BTC_FEED)];
    const eth = reportFor(snap, "ETH")!;
    expect(eth.orders).toBe(5);
    expect(eth.failed).toEqual(["ORDERS"]);
    expect(qualifiedUnderlyings(snap)).toEqual(["BTC"]);
  });

  test("exactly MIN_ORDERS is enough — the threshold is inclusive", () => {
    const snap = clone();
    const kept = ordersOn(snap, ETH_FEED)
      .filter((o) => o.rawApiData?.collateral === USDC)
      .slice(0, MIN_ORDERS);
    snap.orders = kept;
    const eth = reportFor(snap, "ETH")!;
    expect(eth.orders).toBe(6);
    expect(eth.qualified).toBe(true);
  });

  test("an order with nothing left to fill is not a resting order", () => {
    const snap = clone();
    for (const o of ordersOn(snap, ETH_FEED)) o.availableAmount = "0";
    const eth = reportFor(snap, "ETH")!;
    expect(eth.orders).toBe(0);
    expect(eth.depthUsd).toBe(0);
    expect(eth.failed).toEqual(["ORDERS", "GREEKS", "DEPTH"]);
  });

  test("an order naming no strike names no instrument", () => {
    const snap = clone();
    for (const o of ordersOn(snap, ETH_FEED)) o.rawApiData!.strikes = [];
    expect(reportFor(snap, "ETH")!.orders).toBe(0);
  });

  test("an asset with no orders at all is reported, not omitted", () => {
    // SOL, XRP, BNB and AVAX are priced on this capture and have no orders in
    // the trimmed book. A missing row and a rejected row are different claims,
    // and the lobby needs the rejected one to grey a sector with a reason.
    for (const name of ["SOL", "XRP", "BNB", "AVAX"]) {
      const row = reportFor(AS_SNAPSHOT, name)!;
      expect(row.spot).toBeGreaterThan(0);
      expect(row.orders).toBe(0);
      expect(row.failed).toEqual(["ORDERS", "GREEKS", "DEPTH"]);
    }
  });
});

// ─── condition 3: usable deltas ──────────────────────────────────────────────

describe("condition 3 — enough orders carry a usable delta", () => {
  test("it fails independently when the greeks thin out", () => {
    const snap = clone();
    const eth = ordersOn(snap, ETH_FEED);
    // Leave 3 greeked out of 16: orders and depth are untouched.
    eth.slice(MIN_GREEKED - 1).forEach((o) => {
      delete (o.rawApiData as { greeks?: unknown }).greeks;
    });
    const row = reportFor(snap, "ETH")!;
    expect(row.orders).toBe(16);
    expect(row.greeked).toBe(3);
    expect(row.depthUsd).toBeGreaterThan(MIN_DEPTH_USDC);
    expect(row.failed).toEqual(["GREEKS"]);
  });

  test("exactly MIN_GREEKED is enough", () => {
    const snap = clone();
    ordersOn(snap, ETH_FEED)
      .slice(MIN_GREEKED)
      .forEach((o) => {
        delete (o.rawApiData as { greeks?: unknown }).greeks;
      });
    const row = reportFor(snap, "ETH")!;
    expect(row.greeked).toBe(4);
    expect(row.qualified).toBe(true);
  });

  test("BTC's five null deltas are counted as missing, not as zero", () => {
    expect(reportFor(AS_SNAPSHOT, "BTC")!.greeked).toBe(9);
  });

  test("usableDelta shape-checks an undocumented field", () => {
    // `rawApiData.greeks` appears nowhere in the docs (FINDINGS §5.7). Nothing
    // obliges it to keep its shape, so every one of these has to be a `null`
    // rather than a delta that silently buckets a card into a tier.
    expect(usableDelta({ delta: 0.35 })).toBe(0.35);
    expect(usableDelta({ delta: -0.35 })).toBe(-0.35);
    // Far OTM really is delta zero. That is a bucket, not a missing value.
    expect(usableDelta({ delta: 0 })).toBe(0);
    expect(usableDelta({ delta: 1 })).toBe(1);
    expect(usableDelta({ delta: 1.5 })).toBeNull();
    expect(usableDelta({ delta: -42 })).toBeNull();
    expect(usableDelta({ delta: "0.5" })).toBeNull();
    expect(usableDelta({ delta: null })).toBeNull();
    expect(usableDelta({ delta: Number.NaN })).toBeNull();
    expect(usableDelta({ delta: Number.POSITIVE_INFINITY })).toBeNull();
    expect(usableDelta({ iv: 0.68 })).toBeNull();
    expect(usableDelta(undefined)).toBeNull();
    expect(usableDelta("greeks")).toBeNull();
  });
});

// ─── condition 4: the depth is real ──────────────────────────────────────────

describe("condition 4 — the depth is real", () => {
  test("it fails independently — sixteen orders, sixteen dollars", () => {
    const snap = clone();
    // $1 of USDC each. This is the shape of the bug the condition exists for: a
    // fully quoted, fully greeked, sixteen-order book that fills nothing.
    for (const o of ordersOn(snap, ETH_FEED)) {
      o.rawApiData!.collateral = USDC;
      o.availableAmount = "1000000";
    }
    const row = reportFor(snap, "ETH")!;
    expect(row.orders).toBe(16);
    expect(row.greeked).toBe(16);
    expect(row.depthUsd).toBe(16);
    expect(row.failed).toEqual(["DEPTH"]);
    expect(qualifiedUnderlyings(snap)).toEqual(["BTC"]);
  });

  test("exactly MIN_DEPTH_USDC is enough — the threshold is inclusive", () => {
    const snap = clone();
    const eth = ordersOn(snap, ETH_FEED);
    for (const o of eth) {
      o.rawApiData!.collateral = USDC;
      o.availableAmount = "0";
    }
    // 50 USDC spread over the first six orders, so ORDERS and GREEKS still pass.
    for (const o of eth.slice(0, MIN_ORDERS)) o.availableAmount = String((50 / 6) * 1e6);
    const row = reportFor(snap, "ETH")!;
    expect(row.orders).toBe(6);
    expect(row.depthUsd).toBeCloseTo(MIN_DEPTH_USDC, 2);
    expect(row.qualified).toBe(true);
  });

  test("collateral is VALUED, not counted — 3.96 aBasWETH is not 4e18 dollars", () => {
    const snap = clone();
    const one = ordersOn(snap, ETH_FEED).find((o) => o.rawApiData?.collateral === ABAS_WETH)!;
    snap.orders = [one];
    const row = reportFor(snap, "ETH")!;
    // 3962153509675578870 wei of aBasWETH = 3.96215 ETH at $2522.13.
    expect(row.depthUsd).toBeCloseTo(3.962153509675579 * 2522.13, 1);
    expect(row.depthUsd).toBeLessThan(11_000);
  });

  test("the whole ETH book sums to a plausible number of dollars", () => {
    const row = reportFor(AS_SNAPSHOT, "ETH")!;
    // 13 × $10,000 stable-collateralised + 3 × ~3.96 aBasWETH.
    expect(row.depthUsd).toBeGreaterThan(150_000);
    expect(row.depthUsd).toBeLessThan(170_000);
  });
});

// ─── grading ─────────────────────────────────────────────────────────────────

describe("DEEP and THIN — a quality signal, never the gate", () => {
  test("no mmPricing on the capture, so both qualified assets grade THIN", () => {
    expect(qualifiedAssets(AS_SNAPSHOT).map((a) => a.grade)).toEqual(["THIN", "THIN"]);
  });

  test("MM rows grade an asset DEEP without changing who qualifies", () => {
    const snap: QualifySnapshot = { ...AS_SNAPSHOT, mmPricing: { ETH: [{ ticker: "ETH-x" }] } };
    expect(qualifiedAssets(snap).map((a) => [a.underlying, a.grade])).toEqual([
      ["ETH", "DEEP"],
      ["BTC", "THIN"],
    ]);
    expect(qualifiedUnderlyings(snap)).toEqual(qualifiedUnderlyings(AS_SNAPSHOT));
  });

  test("an EMPTY pricing array is THIN — that is what the six unsupported assets return", () => {
    // `getPricingArray` returns `[]` rather than throwing for anything but
    // ETH/BTC (FINDINGS §5.5), so emptiness is the signal and presence of the
    // key is not.
    const snap: QualifySnapshot = { ...AS_SNAPSHOT, mmPricing: { ETH: [], BTC: [] } };
    expect(qualifiedAssets(snap).map((a) => a.grade)).toEqual(["THIN", "THIN"]);
  });

  test("MM pricing does not rescue an asset that failed a condition", () => {
    const snap = clone() as QualifySnapshot;
    delete (snap.prices as Record<string, number>).ETH;
    snap.mmPricing = { ETH: [{ ticker: "ETH-x" }] };
    expect(reportFor(snap, "ETH")!.mmPricing).toBe(true);
    expect(reportFor(snap, "ETH")!.qualified).toBe(false);
    expect(qualifiedUnderlyings(snap)).toEqual(["BTC"]);
  });

  test("an alias key on the MM map grades the bare symbol", () => {
    const snap: QualifySnapshot = { ...AS_SNAPSHOT, mmPricing: { "ETH/USD": [{ ticker: "x" }] } };
    expect(gradeOf(snap, "ETH")).toBe("DEEP");
  });

  test("gradeOf is null for an asset that did not qualify", () => {
    expect(gradeOf(AS_SNAPSHOT, "PAXG")).toBeNull();
    expect(gradeOf(AS_SNAPSHOT, "NOSUCH")).toBeNull();
    expect(gradeOf(AS_SNAPSHOT, "BTC")).toBe("THIN");
  });
});

// ─── expiry ──────────────────────────────────────────────────────────────────

describe("a stale order is not a fillable order", () => {
  // Every order on the capture expires at 1788514414. Filling one past that
  // reverts `Signer Not Authorized` — the maker's signature is simply gone.
  const EXPIRY_S = 1_788_514_414;

  test("with no clock supplied the gate does not judge expiry", () => {
    // Total function, and a frozen fixture that never ages out of its own tests.
    expect(qualifiedUnderlyings(AS_SNAPSHOT)).toEqual(["ETH", "BTC"]);
  });

  test("a clock before expiry changes nothing", () => {
    expect(qualifiedUnderlyings(AS_SNAPSHOT, (EXPIRY_S - 3600) * 1000)).toEqual(["ETH", "BTC"]);
  });

  test("a clock past expiry empties the board rather than dealing dead orders", () => {
    const at = (EXPIRY_S + 1) * 1000;
    expect(qualifiedUnderlyings(AS_SNAPSHOT, at)).toEqual([]);
    const eth = reportFor(AS_SNAPSHOT, "ETH", at)!;
    expect(eth.orders).toBe(0);
    expect(eth.depthUsd).toBe(0);
    // Spot is still readable — the asset is priced and unfillable, which is a
    // precise and useful thing for the probe to be able to say.
    expect(eth.failed).toEqual(["ORDERS", "GREEKS", "DEPTH"]);
    expect(eth.spot).toBeGreaterThan(0);
  });
});

// ─── degradation ─────────────────────────────────────────────────────────────

describe("a garbage snapshot degrades to [] — it never throws", () => {
  const junk: unknown[] = [
    undefined,
    null,
    {},
    { orders: [], prices: {}, chainConfig: {} },
    { chainConfig: { priceFeeds: null } },
    { chainConfig: { priceFeeds: {} }, orders: [] },
    // Every field the wrong type, which is what a truncated or half-migrated
    // response actually looks like.
    { orders: "nope", prices: 7, chainConfig: { priceFeeds: { ETH: 42 } } },
    { orders: [null, undefined, {}, { rawApiData: null }], prices: null, chainConfig: null },
  ];

  for (const [i, bad] of junk.entries()) {
    test(`case ${i} yields [] and no throw`, () => {
      expect(() => probeAssets(bad as QualifySnapshot)).not.toThrow();
      expect(qualifiedUnderlyings(bad as QualifySnapshot)).toEqual([]);
      expect(qualifiedAssets(bad as QualifySnapshot)).toEqual([]);
    });
  }

  test("orders that are structurally broken are skipped, not fatal", () => {
    const snap = clone();
    snap.orders = [
      null,
      undefined,
      {},
      { rawApiData: {} },
      { rawApiData: { priceFeed: ETH_FEED } },
      { rawApiData: { priceFeed: ETH_FEED, strikes: ["1"] }, availableAmount: "not-a-number" },
      { rawApiData: { priceFeed: ETH_FEED, strikes: ["1"] }, availableAmount: null },
      { rawApiData: { priceFeed: "0xdeadbeef", strikes: ["1"] }, availableAmount: "10000000" },
      ...snap.orders,
    ] as unknown as RawMarket["orders"];
    // The 16 real ETH orders survive; the seven broken ones and the order on an
    // unknown feed contribute nothing.
    expect(reportFor(snap, "ETH")!.orders).toBe(16);
    expect(qualifiedUnderlyings(snap)).toEqual(["ETH", "BTC"]);
  });

  test("no price feeds at all means no candidates — the gate has nothing to name", () => {
    const snap = clone();
    snap.chainConfig = { ...snap.chainConfig, priceFeeds: {} };
    expect(probeAssets(snap)).toEqual([]);
  });

  test("missing token config falls back to 6dp rather than dividing by nothing", () => {
    const snap = clone();
    snap.chainConfig = { ...snap.chainConfig, tokens: undefined };
    const eth = reportFor(snap, "ETH")!;
    expect(eth.orders).toBe(16);
    // The three aBasWETH orders are now read as 18-digit USDC integers — a real
    // over-count, and the honest one: it is the direction that keeps a priced
    // asset playable rather than silently dropping it when config goes missing.
    expect(eth.depthUsd).toBeGreaterThan(0);
    expect(Number.isFinite(eth.depthUsd)).toBe(true);
  });
});

// ─── the probe script, offline ───────────────────────────────────────────────

/**
 * `scripts/probe-assets.ts --fixture` — the demo artefact, tested.
 *
 * The script is the plan's §7.3 deliverable and the thing that gets run in a
 * room, so "it compiles" is not the bar. `--fixture` exists precisely so it can
 * be exercised without a socket: the identical gate over the identical frozen
 * capture, printed by the identical formatter. What is asserted here is the
 * table's *shape* and its verdicts, not its prose — a table that quietly stops
 * naming which condition failed is the failure mode that matters, because the
 * verdict column is the entire reason anyone believes the gate is a measurement.
 *
 * These spawn a subprocess, which is slower than the rest of this file by two
 * orders of magnitude. That is the price of testing the artefact rather than a
 * re-implementation of it, and three runs is where it stops being worth paying.
 */
describe("scripts/probe-assets.ts --fixture", () => {
  const ROOT = join(import.meta.dir, "..");
  const SCRIPT = join(ROOT, "scripts", "probe-assets.ts");

  /** `process.execPath` is the running bun, so this needs nothing on PATH. */
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, ["run", SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
    });
    return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
  };

  const FIXTURE_RUN = run("--fixture");
  /** The ETH row, split on runs of spaces — the table is space-padded. */
  const cellsOf = (out: string, asset: string): string[] =>
    out
      .split("\n")
      .find((l) => l.startsWith(`${asset} `))!
      .trim()
      .split(/\s{2,}/);

  test("it exits 0 and never touches the network", () => {
    expect(FIXTURE_RUN.status).toBe(0);
    // The live path's failure banners must not appear on a run that read a file.
    expect(FIXTURE_RUN.err).not.toContain("BOOK UNREACHABLE");
    expect(FIXTURE_RUN.err).not.toContain("SPOT UNREACHABLE");
  });

  test("a frozen table can never be mistaken for a live one", () => {
    // The one thing that would turn this script from evidence into a lie.
    expect(FIXTURE_RUN.out).toContain("SOURCE: FROZEN FIXTURE — NOT THE LIVE BOOK");
    expect(FIXTURE_RUN.out).toContain("test/fixtures/orders.json");
  });

  test("every column the plan asks for is printed", () => {
    // §7.3: order count, greeked count, summed depth, MM pricing, grade, verdict.
    for (const head of ["ASSET", "SPOT", "ORDERS", "GREEKED", "DEPTH USD", "MM", "GRADE", "VERDICT"]) {
      expect(FIXTURE_RUN.out).toContain(head);
    }
  });

  test("one row per asset, in the gate's own order — ETH once, not twice", () => {
    const rows = FIXTURE_RUN.out
      .split("\n")
      // A table row is a symbol plus a verdict. The footer prose also starts
      // with capitals, and it is not a row.
      .filter((l) => /^[A-Z]{2,5} /.test(l) && /\b(QUALIFIED|REJECTED)\b/.test(l))
      .map((l) => l.split(" ")[0]);
    expect(rows).toEqual(["ETH", "BTC", "SOL", "DOGE", "XRP", "BNB", "PAXG", "AVAX"]);
  });

  test("the numbers on the row are the numbers the gate measured", () => {
    const eth = cellsOf(FIXTURE_RUN.out, "ETH");
    expect(eth[0]).toBe("ETH");
    expect(eth[2]).toBe("16"); // orders
    expect(eth[3]).toBe("16"); // greeked
    expect(eth[4]).toBe("$159,970"); // depth, valued not counted
    expect(eth[7]).toBe("QUALIFIED");
    expect(cellsOf(FIXTURE_RUN.out, "BTC")[3]).toBe("9");
  });

  test("a rejection names WHICH condition failed, not just that it failed", () => {
    // The whole argument of §10.3 is that the lobby can say *why* a sector is
    // greyed. A bare "REJECTED" would make the probe an assertion again.
    const paxg = FIXTURE_RUN.out.split("\n").find((l) => l.startsWith("PAXG "))!;
    expect(paxg).toContain(CONDITION_REASON.SPOT);
    expect(paxg).toContain(CONDITION_REASON.ORDERS);
    expect(paxg).toContain(CONDITION_REASON.DEPTH);
    // SOL is priced and empty — a different sentence, and the difference is the
    // point of collecting all four conditions instead of short-circuiting.
    const sol = FIXTURE_RUN.out.split("\n").find((l) => l.startsWith("SOL "))!;
    expect(sol).not.toContain(CONDITION_REASON.SPOT);
    expect(sol).toContain(CONDITION_REASON.ORDERS);
  });

  test("an unread MM feed prints '?', never 'no'", () => {
    // The capture carries no mmPricing. "no MM pricing" would be a claim about
    // a market maker; the truth is that nobody asked.
    expect(cellsOf(FIXTURE_RUN.out, "ETH")[5]).toBe("?");
    expect(cellsOf(FIXTURE_RUN.out, "ETH")[6]).toBe("?");
    expect(FIXTURE_RUN.out).toContain("MM pricing grades, it never gates");
  });

  test("the footer names the qualified set", () => {
    expect(FIXTURE_RUN.out).toContain("QUALIFIED: ETH, BTC");
  });

  test("the table is stable across runs — same capture, same table", () => {
    // Everything but the wall clock on the header line, which is the only thing
    // in the output that is allowed to move.
    const stable = (s: string) => s.replace(/^ {2}run .*$/m, "  run <clock>");
    expect(stable(run("--fixture").out)).toBe(stable(FIXTURE_RUN.out));
  });

  test("--help documents --fixture and reads no book at all", () => {
    const help = run("--help");
    expect(help.status).toBe(0);
    expect(help.out).toContain("--fixture");
    expect(help.out).not.toContain("ASSET");
  });
});
