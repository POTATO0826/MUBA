import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  TTL_MS,
  createMarketService,
  type MarketClient,
  type RawMarket,
  type RawMmQuote,
} from "../src/server/thetanuts.ts";
import { sourceFrom, type Wire } from "../src/data/thetanuts.tsx";
import { NO_LADDER, ladderOf, mockMarketSource } from "../src/data/market.ts";
import { deriveLadder, deriveLadders, liveExpiries } from "../src/data/box.ts";
import {
  listedZones,
  matchListedZone,
  zoneBox,
  zoneUsd,
  zoneWingUsd,
  zonesFor,
} from "../src/data/ranger.ts";

/**
 * The market service, offline.
 *
 * `createMarketService` takes both of its impure edges as parameters, so every
 * test here drives the real caching path — TTL, in-flight dedupe,
 * stale-on-failure, kill switch — over a fake client and a fake clock. No
 * socket is opened and none can be: the real SDK client is built lazily inside
 * `read()`, and `deps.client` is always supplied below.
 *
 * The contract this file pins, in one sentence: **the route always answers 200
 * with a typed envelope, one upstream read serves every concurrent caller, and
 * old real numbers beat no numbers.**
 */

const FIXTURE = (await Bun.file(join(import.meta.dir, "fixtures", "orders.json")).json()) as RawMarket;

/** A client that counts its reads and can be told to fail. */
function fakeClient() {
  let fail: Error | null = null;
  let calls = 0;
  /** Set to hold `fetchOrders` open so two callers can overlap. */
  let gate: { promise: Promise<void>; open: () => void } | null = null;

  const client: MarketClient = {
    chainConfig: FIXTURE.chainConfig,
    api: {
      async fetchOrders() {
        calls += 1;
        if (gate) await gate.promise;
        if (fail) throw fail;
        return FIXTURE.orders;
      },
      async getMarketData() {
        return { prices: FIXTURE.prices };
      },
    },
  };

  return {
    client,
    get calls() {
      return calls;
    },
    failWith(error: Error | null) {
      fail = error;
    },
    hold() {
      let open = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      gate = { promise, open };
      return () => {
        gate = null;
        open();
      };
    },
  };
}

/** A clock the test drives. */
function fakeClock(start = 1_788_500_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// ─── the envelope ────────────────────────────────────────────────────────────

describe("the envelope", () => {
  test("a good read carries the whole board", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const env = await createMarketService({ client: fake.client, now: clock.now }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.at).toBe(clock.now());
    expect(env.underlyings).toEqual(["BTC", "ETH"]);
    expect(env.spot.ETH).toBeGreaterThan(0);
    expect(Object.keys(env.pricing)).toEqual(expect.arrayContaining(["ETH", "BTC"]));
    expect(env.orders.length).toBeGreaterThan(0);
    expect(env.greeksSeen).toBeGreaterThan(0);
    expect(env.optionBook.address).toBeTruthy();
    expect(env.optionBook.agreed).toBe(true);
    expect(env.note).toBeUndefined();
    // A client with no `mmPricing` module is not an error — the key is present
    // and empty, and `/desk` falls back to the book-derived chain.
    expect(env.mmPricing).toEqual({});
  });

  test("the envelope carries the asset gate, measured against the same capture", async () => {
    // The gate has to travel on the wire because it cannot be recomputed off
    // the far side of it: `buildSnapshot` aggregates `availableAmount` into a
    // display string and resolves `rawApiData.priceFeed` to a symbol, and the
    // gate's depth and dedupe conditions need both of those raw. See
    // `QualifySnapshot`'s docblock.
    const fake = fakeClient();
    const env = await createMarketService({ client: fake.client, now: fakeClock().now }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    // Non-vacuity: the frozen capture is a real book and really does qualify
    // ETH and BTC. Without this the loop below passes on an empty array and
    // the whole test says nothing.
    expect(env.qualified.map((a) => a.underlying).sort()).toEqual(["BTC", "ETH"]);

    // Whatever qualified had to pass all four conditions, and the shape has to
    // survive `Response.json()` — a grade the lobby cannot read is worse than
    // no grade at all.
    for (const asset of env.qualified) {
      expect(typeof asset.underlying).toBe("string");
      expect(["DEEP", "THIN"]).toContain(asset.grade);
      expect(asset.spot).toBeGreaterThan(0);
      expect(asset.orders).toBeGreaterThanOrEqual(6);
      expect(asset.greeked).toBeGreaterThanOrEqual(4);
      expect(asset.depthUsd).toBeGreaterThanOrEqual(50);
    }

    // The gate is STRICTER than `underlyings`, always. "Has a two-sided table
    // to draw" and "can be dealt as a round" are different claims, and the day
    // they invert is the day a lobby offers an asset its own blotter cannot
    // fill. Not asserted as equal: the frozen capture is a real book and this
    // must keep holding when it is recaptured thinner.
    const names = env.qualified.map((a) => a.underlying);
    expect(names.length).toBeLessThanOrEqual(env.underlyings.length);
    for (const name of names) expect(env.underlyings).toContain(name);

    // ETH once, not twice. The gate deduplicates by feed ADDRESS, and this
    // fixture really does hold the same address under `ETH` and `ETH/USD`.
    expect(new Set(names).size).toBe(names.length);
  });

  test("the gate rides through the JSON route, not just the in-process envelope", async () => {
    // `handle()` is what the browser actually reads. A field that exists on the
    // typed envelope and vanishes at `Response.json()` would leave the lobby
    // greying every group forever with nothing on screen to say why.
    const res = await createMarketService({ client: fakeClient().client }).handle();
    const body = (await res.json()) as { ok: boolean; qualified?: unknown[] };
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.qualified)).toBe(true);
  });

  test("an empty gate is an ANSWER — a book with no depth qualifies nobody", async () => {
    // The 404ing indexer, a thin morning, a truncated response: all land here,
    // and none of them is an error. `ok` stays true, the board still ships, and
    // the lobby greys its live groups with a reason rather than hiding them.
    const client: MarketClient = {
      chainConfig: FIXTURE.chainConfig,
      api: {
        fetchOrders: () => Promise.resolve([]),
        getMarketData: () => Promise.resolve({ prices: FIXTURE.prices }),
      },
    };
    const env = await createMarketService({ client, now: fakeClock().now }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.qualified).toEqual([]);
    expect(env.note).toBeUndefined();
  });

  test("a stale re-serve keeps the gate that graded those exact rows", async () => {
    // The rows and the gate are one reading of one moment. Re-serving the rows
    // under a fresher-looking empty gate would grey every live group while
    // their own prices are still on screen; the `note` is what discloses age,
    // once, for all of it.
    const fake = fakeClient();
    const clock = fakeClock();
    const service = createMarketService({ client: fake.client, now: clock.now });

    const good = await service.snapshot();
    clock.advance(TTL_MS * 4);
    fake.failWith(new Error("indexer 404"));
    const stale = await service.snapshot();

    expect(good.ok && stale.ok).toBe(true);
    if (!good.ok || !stale.ok) return;
    expect(stale.qualified).toEqual(good.qualified);
    expect(stale.note).toContain("stale");
  });

  test("handle() answers 200 with that envelope, uncached", async () => {
    const fake = fakeClient();
    const res = await createMarketService({ client: fake.client }).handle();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).ok).toBe(true);
  });

  test("a dead upstream is STILL 200 — the client reads `ok`, never a status", async () => {
    const fake = fakeClient();
    fake.failWith(new Error("HTTP 429 rate limited"));
    const res = await createMarketService({ client: fake.client }).handle();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("429");
  });

  test("a thrown non-Error still produces a reason", async () => {
    const client: MarketClient = {
      chainConfig: FIXTURE.chainConfig,
      api: {
        fetchOrders: () => Promise.reject("socket hang up"),
        getMarketData: () => Promise.resolve({ prices: {} }),
      },
    };
    const env = await createMarketService({ client }).snapshot();
    expect(env).toEqual({ ok: false, reason: "socket hang up" });
  });

  test("an enormous upstream message is truncated rather than mirrored whole", async () => {
    const fake = fakeClient();
    fake.failWith(new Error("x".repeat(5_000)));
    const env = await createMarketService({ client: fake.client }).snapshot();
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.reason.length).toBeLessThanOrEqual(200);
    expect(env.reason.endsWith("…")).toBe(true);
  });
});

// ─── caching ─────────────────────────────────────────────────────────────────

describe("the 15s TTL", () => {
  test("a second call inside the window reads nothing upstream", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const service = createMarketService({ client: fake.client, now: clock.now });

    const first = await service.snapshot();
    clock.advance(TTL_MS - 1);
    const second = await service.snapshot();

    expect(fake.calls).toBe(1);
    expect(second).toEqual(first);
  });

  test("past the window it reads again and the timestamp moves", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const service = createMarketService({ client: fake.client, now: clock.now });

    const first = await service.snapshot();
    clock.advance(TTL_MS);
    const second = await service.snapshot();

    expect(fake.calls).toBe(2);
    expect(first.ok && second.ok && second.at).toBeGreaterThan((first.ok && first.at) || 0);
  });
});

describe("in-flight dedupe", () => {
  test("two concurrent callers cost ONE upstream read", async () => {
    // Two players opening the pricing table at the same second must be one RPC
    // round trip. The public Base RPC throttles; this is the guard.
    const fake = fakeClient();
    const service = createMarketService({ client: fake.client, now: fakeClock().now });

    const release = fake.hold();
    const both = Promise.all([service.snapshot(), service.snapshot()]);
    release();
    const [a, b] = await both;

    expect(fake.calls).toBe(1);
    expect(a).toEqual(b);
  });

  test("a joiner gets the same failure the leader did, not a second attempt", async () => {
    const fake = fakeClient();
    const service = createMarketService({ client: fake.client, now: fakeClock().now });
    fake.failWith(new Error("boom"));

    const release = fake.hold();
    const both = Promise.all([service.snapshot(), service.snapshot()]);
    release();
    const [a, b] = await both;

    expect(fake.calls).toBe(1);
    expect(a).toEqual({ ok: false, reason: "boom" });
    expect(b).toEqual(a);
  });

  test("the in-flight slot clears, so the next window reads again", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const service = createMarketService({ client: fake.client, now: clock.now });

    await service.snapshot();
    clock.advance(TTL_MS);
    await service.snapshot();
    clock.advance(TTL_MS);
    await service.snapshot();

    expect(fake.calls).toBe(3);
  });
});

// ─── degrading ───────────────────────────────────────────────────────────────

describe("stale beats blank", () => {
  test("a failed refresh re-serves the last good snapshot, labelled and dated", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const service = createMarketService({ client: fake.client, now: clock.now });

    const good = await service.snapshot();
    clock.advance(TTL_MS * 4);
    fake.failWith(new Error("RPC timeout"));
    const stale = await service.snapshot();

    expect(stale.ok).toBe(true);
    if (!stale.ok || !good.ok) return;
    // Same numbers, same age — the timestamp is NOT refreshed, because the
    // footer's age chip is the disclosure that these are old.
    expect(stale.at).toBe(good.at);
    expect(stale.pricing).toEqual(good.pricing);
    expect(stale.note).toContain("stale");
    expect(stale.note).toContain("RPC timeout");
  });

  test("the stale note does not stick once the book comes back", async () => {
    const fake = fakeClient();
    const clock = fakeClock();
    const service = createMarketService({ client: fake.client, now: clock.now });

    await service.snapshot();
    clock.advance(TTL_MS);
    fake.failWith(new Error("down"));
    await service.snapshot();

    clock.advance(TTL_MS);
    fake.failWith(null);
    const healed = await service.snapshot();

    expect(healed.ok).toBe(true);
    if (!healed.ok) return;
    expect(healed.note).toBeUndefined();
    expect(healed.at).toBe(clock.now());
  });

  test("a first read that never succeeded has nothing to go stale — ok:false", async () => {
    const fake = fakeClient();
    fake.failWith(new Error("cold start, no book"));
    const env = await createMarketService({ client: fake.client }).snapshot();
    expect(env.ok).toBe(false);
  });
});

// ─── the second feed ─────────────────────────────────────────────────────────

/** One MM quote, near enough spot to survive the ±25% band. */
function quote(over: Partial<RawMmQuote> = {}): RawMmQuote {
  return {
    ticker: "ETH-3SEP26-2400-C",
    feeAdjustedBid: 0.1146,
    feeAdjustedAsk: 0.1194,
    markPrice: 0.116552,
    strike: 2400,
    expiry: 1_788_422_400,
    isCall: true,
    underlying: "ETH",
    underlyingPrice: 2375.76,
    ...over,
  };
}

/** The base fake plus an `mmPricing` module that can be told to fail per
 *  underlying, and that records what it was asked for. */
function withPricing(fail: Partial<Record<string, Error>> = {}) {
  const base = fakeClient();
  const asked: string[] = [];
  const filtered: [number, number][] = [];

  const client: MarketClient = {
    ...base.client,
    mmPricing: {
      async getPricingArray(underlying) {
        asked.push(underlying);
        const boom = fail[underlying];
        if (boom) throw boom;
        return [quote({ underlying }), quote({ underlying, strike: 2450 })];
      },
      filterByStrikeRange(pricing, min, max) {
        filtered.push([min, max]);
        return pricing.filter((p) => p.strike >= min && p.strike <= max);
      },
    },
  };

  return { client, asked, filtered };
}

describe("MM pricing rides beside the book, and fails on its own", () => {
  test("both tradable underlyings are read, and only those two", () => {
    // The other six price-feed assets return `[]` rather than throwing
    // (FINDINGS §5.5), so asking them is six round trips to learn nothing.
    const fake = withPricing();
    return createMarketService({ client: fake.client })
      .snapshot()
      .then((env) => {
        expect(fake.asked).toEqual(["ETH", "BTC"]);
        expect(env.ok).toBe(true);
        if (!env.ok) return;
        expect(Object.keys(env.mmPricing).sort()).toEqual(["BTC", "ETH"]);
        expect(env.mmPricing.ETH?.[0]?.bid).toBe("0.1146");
      });
  });

  test("the SDK's own filterByStrikeRange makes the cut, at the ±25% band", () => {
    // Reimplementing a filter the venue publishes is how two definitions of
    // "near the money" start disagreeing.
    const fake = withPricing();
    return createMarketService({ client: fake.client })
      .snapshot()
      .then(() => {
        expect(fake.filtered).toHaveLength(2);
        for (const [min, max] of fake.filtered) {
          expect(min).toBeCloseTo(2375.76 * 0.75, 6);
          expect(max).toBeCloseTo(2375.76 * 1.25, 6);
        }
      });
  });

  test("ONE dead underlying costs only its own rows", async () => {
    const fake = withPricing({ BTC: new Error("pricing host 503") });
    const env = await createMarketService({ client: fake.client }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(Object.keys(env.mmPricing)).toEqual(["ETH"]);
    // And the BTC *book* — a different host entirely — is untouched.
    expect(env.pricing.BTC?.length).toBeGreaterThan(0);
  });

  test("MM pricing GRADES the gate — it never gates it", async () => {
    // The distinction plan 6 §7 exists to make. Only ETH and BTC have MM
    // pricing; the resting book covers more. So a live MM chain must move an
    // asset from THIN to DEEP and must not decide whether it is playable at
    // all — the day it does, the game silently amputates the protocol's own
    // breadth and AVAX becomes the broken default asset again.
    const withMm = await createMarketService({ client: withPricing().client, now: fakeClock().now }).snapshot();
    const noMm = await createMarketService({ client: fakeClient().client, now: fakeClock().now }).snapshot();

    expect(withMm.ok && noMm.ok).toBe(true);
    if (!withMm.ok || !noMm.ok) return;

    // Same assets qualify either way — the gate did not move.
    expect(withMm.qualified.map((a) => a.underlying)).toEqual(noMm.qualified.map((a) => a.underlying));
    // Only the grade moved.
    expect(withMm.qualified.map((a) => a.grade)).toEqual(["DEEP", "DEEP"]);
    expect(noMm.qualified.map((a) => a.grade)).toEqual(["THIN", "THIN"]);
  });

  test("a dead pricing HOST does not empty the snapshot", async () => {
    // The signed order book is the load-bearing feed. `pricing.thetanuts.
    // finance` and the indexer fail independently, and only one of them is
    // allowed to take this screen down.
    const fake = withPricing({ ETH: new Error("ENOTFOUND"), BTC: new Error("ENOTFOUND") });
    const env = await createMarketService({ client: fake.client }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.mmPricing).toEqual({});
    expect(env.underlyings).toEqual(["BTC", "ETH"]);
    expect(env.orders.length).toBeGreaterThan(0);
    // Not a stale read either — this snapshot is fresh and complete in the one
    // feed that matters.
    expect(env.note).toBeUndefined();
  });
});

// ─── the quote line ──────────────────────────────────────────────────────────

describe("previewFillOrder is called server-side, at $1.00, with the referrer", () => {
  const KEY = "THETADUEL_REFERRER";
  const before = process.env[KEY];

  afterEach(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });

  /** The base fake plus an `optionBook` whose preview the test controls. */
  function withBook(
    impl: (
      usdc?: bigint,
      referrer?: string,
    ) => { numContracts: bigint; totalCollateral: bigint; pricePerContract?: bigint },
  ) {
    const base = fakeClient();
    const seen: { usdc?: bigint; referrer?: string }[] = [];
    const client: MarketClient = {
      ...base.client,
      optionBook: {
        previewFillOrder(_order, usdc, referrer) {
          seen.push({ usdc, referrer });
          return impl(usdc, referrer);
        },
      },
    };
    return { client, seen };
  }

  test("every shipped row gets a quote at the fixed $1.00 notional", async () => {
    process.env[KEY] = "0xReferrer";
    const fake = withBook(() => ({ numContracts: 4_300_000_000_000_000n, totalCollateral: 999_999n }));
    const env = await createMarketService({ client: fake.client }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    // The blotter's rows, plus one more call per listed zone: the arena reads
    // `pricePerContract` off the same `previewFillOrder`, through its own
    // curried `zoneQuote`, and only for the orders the registry names RANGER.
    // Two of those in the frozen capture.
    expect(fake.seen).toHaveLength(env.orders.length + 2);
    // ...and this fake answers only the two fields the desk reads, so the arena
    // gets no premium from it. Absence, not a derived one: `totalCollateral /
    // numContracts` off rendered strings is the rounding trap `ZoneQuote` was
    // added to avoid.
    expect(env.ladder.orders.filter((o) => o.quote !== undefined)).toHaveLength(0);
    // $1.00 in USDC 6dp, and our referrer on every one — the same attribution
    // string P3's fill will carry.
    for (const call of fake.seen) expect(call).toEqual({ usdc: 1_000000n, referrer: "0xReferrer" });
    expect(env.orders[0]?.preview).toEqual({
      contracts: "0.0043", // 18dp
      collateral: "1.00", //  6dp
      fillable: true,
    });
  });

  test("a listed zone carries pricePerContract, verbatim, as its premium", async () => {
    // 33392222284 at 8dp is $333.92 — the price a live BTC RANGER charged for
    // one contract on 2026-09-05, and the number `zoneQuote` hands the arena as
    // its `premium` prop. The desk's own `contracts` figure for the same order
    // rounds to "0.0000" at $1.00, which is why the arena reads this field and
    // not that one.
    const fake = withBook(() => ({
      numContracts: 2994n,
      totalCollateral: 1_000000n,
      pricePerContract: 33_392222284n,
    }));
    const env = await createMarketService({ client: fake.client }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    const quoted = env.ladder.orders.filter((o) => o.quote !== undefined);
    expect(quoted).toHaveLength(2);
    for (const order of quoted) expect(order.quote).toEqual({ premium: "333.92", fillable: true });
  });

  test("no referrer configured passes undefined rather than an empty address", async () => {
    delete process.env[KEY];
    const fake = withBook(() => ({ numContracts: 1n, totalCollateral: 1n }));
    await createMarketService({ client: fake.client }).snapshot();
    expect(fake.seen[0]?.referrer).toBeUndefined();
  });

  test("numContracts === 0n is the book-depth guard, not an error", async () => {
    // Depth on Base swung from 426 resting orders to 130 inside a day. "This
    // order will not absorb a dollar" is an ordinary reading; the row greys out
    // and says so.
    const fake = withBook(() => ({ numContracts: 0n, totalCollateral: 0n }));
    const env = await createMarketService({ client: fake.client }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.orders[0]?.preview).toEqual({
      contracts: "0.0000",
      collateral: "0.00",
      fillable: false,
    });
  });

  test("a preview that throws costs one row its quote line and nothing more", async () => {
    // ORDER_EXPIRED / INVALID_ORDER on an order the indexer is still serving.
    let first = true;
    const fake = withBook(() => {
      if (first) {
        first = false;
        throw new Error("ORDER_EXPIRED");
      }
      return { numContracts: 2n, totalCollateral: 2n };
    });
    const env = await createMarketService({ client: fake.client }).snapshot();

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect(env.orders[0]?.preview).toBeUndefined();
    expect(env.orders[1]?.preview?.fillable).toBe(true);
  });

  test("a client with no optionBook ships rows with no quote line at all", async () => {
    const env = await createMarketService({ client: fakeClient().client }).snapshot();
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    for (const row of env.orders) expect(row.preview).toBeUndefined();
  });
});

// ─── the kill switch ─────────────────────────────────────────────────────────

describe("THETADUEL_MARKET=off", () => {
  const KEY = "THETADUEL_MARKET";
  const before = process.env[KEY];

  afterEach(() => {
    if (before === undefined) delete process.env[KEY];
    else process.env[KEY] = before;
  });

  test("off answers the disabled envelope and reads nothing upstream", async () => {
    const fake = fakeClient();
    const service = createMarketService({ client: fake.client });
    process.env[KEY] = "off";

    expect(await service.snapshot()).toEqual({ ok: false, reason: "disabled" });
    expect(fake.calls).toBe(0);
  });

  test("it is read per call, so flipping it needs no restart", async () => {
    const fake = fakeClient();
    const service = createMarketService({ client: fake.client, now: fakeClock().now });

    expect((await service.snapshot()).ok).toBe(true);
    process.env[KEY] = "off";
    expect((await service.snapshot()).ok).toBe(false);
    delete process.env[KEY];
    expect((await service.snapshot()).ok).toBe(true);
  });

  test("only the exact string switches it off — the flag is opt-OUT", async () => {
    const fake = fakeClient();
    const service = createMarketService({ client: fake.client, now: fakeClock().now });
    for (const value of ["", "false", "OFF", "no", "0"]) {
      process.env[KEY] = value;
      expect((await service.snapshot()).ok).toBe(true);
    }
  });

  test("the disabled envelope still answers 200", async () => {
    process.env[KEY] = "off";
    const res = await createMarketService({ client: fakeClient().client }).handle();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "disabled" });
  });
});

// ─── the ladder, all the way to a source ─────────────────────────────────────

/**
 * **Capture → envelope → `Response.json()` → source → a real strike ladder.**
 *
 * Plan 7's arena is a pure function of one thing: the strike ladder
 * `src/data/box.ts` derives from a raw `fetchOrders()` capture. Nothing in
 * `OrderRow` can rebuild one — it is a display projection and every ladder
 * input was spent making it — so the narrowed capture rides the envelope, and
 * the only test worth writing is the one that drives the whole path and then
 * checks that real rungs come out.
 *
 * It runs `handle()` rather than `snapshot()` on purpose: `Response.json()` is
 * a lossy step (it drops `undefined`, it throws on a `bigint`) and the arena is
 * downstream of it. A ladder that survives `buildSnapshot` but not
 * serialisation is a ladder the browser never sees.
 */
describe("the ladder reaches the client", () => {
  /** One frozen capture, taken the whole way to the object a view holds. */
  async function liveSource() {
    const fake = fakeClient();
    const service = createMarketService({ client: fake.client, now: fakeClock().now });
    const res = await service.handle();
    const wire = (await res.json()) as Wire;
    expect(wire.ok).toBe(true);
    return { wire, source: sourceFrom(wire, false) };
  }

  const AT = 1_788_500_000_000;

  test("a real ladder comes out the far side of the wire", async () => {
    const { source } = await liveSource();
    const book = ladderOf(source);

    // Non-vacuity first: the narrowed book actually arrived, with orders in it.
    expect(book.orders.length).toBeGreaterThan(0);
    expect(Object.keys(book.chainConfig.priceFeeds).length).toBeGreaterThan(0);

    // And it is the documented ETH 5 Sep ladder, rung for rung — three $20
    // steps and then $70 and $100. Irregular, because the book is.
    const ladder = deriveLadder(book, "ETH", 1_788_595_200, AT);
    expect(ladder?.strikes).toEqual([
      "242000000000",
      "244000000000",
      "246000000000",
      "248000000000",
      "255000000000",
      "265000000000",
    ]);
    expect(ladder?.prices).toEqual([2420, 2440, 2460, 2480, 2550, 2650]);

    // The expiry selector's whole vocabulary, which is what the arena draws
    // columns from. Real dates off the book, ascending, nothing invented.
    expect(liveExpiries(book, "ETH", AT)).toEqual([
      1_788_595_200, 1_788_681_600, 1_789_113_600, 1_789_718_400,
    ]);
    expect(liveExpiries(book, "DOGE", AT)).toEqual([]);
  });

  test("the accessor is synchronous and keeps one identity across calls", async () => {
    const { source } = await liveSource();
    // Not a promise: the arena reads the ladder through `useMemo` on every
    // pointer move, and an `await` on that path is a different component.
    expect(ladderOf(source)).not.toBeInstanceOf(Promise);
    // And the same object each time — `BoxBuilder` keys its expiry set and its
    // ladder on this identity, so a fresh object per call would re-derive the
    // whole ladder on every render of a drag.
    expect(ladderOf(source)).toBe(ladderOf(source));
  });

  test("a stale source serves the stale book, like it serves the stale gate", async () => {
    const { wire } = await liveSource();
    const stale = sourceFrom({ ...wire, note: "stale — refresh failed" }, true);
    expect(stale.meta.source).toBe("stale");
    // The rows, the gate and the ladder are one reading of one moment. Serving
    // fresh-looking emptiness beside stale prices would read as a bug rather
    // than as age; `meta.source` is what discloses it, once, for all three.
    expect(deriveLadders(ladderOf(stale), AT).length).toBeGreaterThan(0);
  });

  test("an envelope with no ladder field yields the empty book, never undefined", () => {
    // What a client gets from a server that predates the field. `ladderOf` is
    // total, so the arena renders "no columns" rather than throwing.
    const old = sourceFrom({ ok: true, at: AT, underlyings: ["ETH"] }, false);
    expect(ladderOf(old)).toBe(NO_LADDER);
    expect(deriveLadders(ladderOf(old), AT)).toEqual([]);
  });

  /**
   * **Capture → envelope → `Response.json()` → source → `ladderOf` → a listed
   * zone the arena can fill.**
   *
   * `src/data/ranger.ts` matches a drawn box to a listed `RANGER` and fills it
   * straight off the book, with no market-maker round trip. It worked against
   * the raw capture in `test/box.test.ts` and returned `[]` in the browser,
   * because the narrowing dropped exactly the three fields it reads:
   * `rawApiData.implementation`, `rawApiData.isLong` and
   * `chainConfig.optionImplementations`.
   *
   * This is the test that proves the browser can now do what the module could.
   * It runs `handle()` rather than `snapshot()` on purpose: `Response.json()`
   * drops `undefined` and throws on a `bigint`, and the arena is downstream of
   * it.
   */
  describe("and so does a listed zone", () => {
    /** The two ranger orders in the frozen capture — BTC 79,500–81,500, one on
     *  5 Sep and one on 6 Sep, both `isLong: false` so the taker is the buyer. */
    const RANGER_IMPL = "0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc";

    test("the capture really carries two of them, and only the address says so", () => {
      const rangers = FIXTURE.orders.filter(
        (o) =>
          String(o.rawApiData?.implementation ?? "").toLowerCase() === RANGER_IMPL.toLowerCase(),
      );
      expect(rangers).toHaveLength(2);
      // Four strikes each — which decides nothing on its own: `validateCondor`
      // and `validateRanger` accept identical arrays.
      for (const r of rangers) expect(r.rawApiData?.strikes).toHaveLength(4);
      // Both taker-buyable, which is the second gate (plan 7 §5).
      for (const r of rangers) expect(r.rawApiData?.isLong).toBe(false);
      // Two different contracts, not one instrument quoted twice.
      expect(rangers.map((r) => String(r.order.expiry))).toEqual(["1788595200", "1788681600"]);
    });

    test("`listedZones` finds both of them off the wire", async () => {
      const { source } = await liveSource();
      const book = ladderOf(source);

      // The registry survived the wire — without it `listedZones` answers `[]`
      // by design, because the strikes cannot decide.
      expect(book.chainConfig.optionImplementations?.[RANGER_IMPL.toLowerCase()]).toEqual({
        name: "RANGER",
      });

      const zones = listedZones(book, AT);
      expect(zones).toHaveLength(2);
      for (const zone of zones) {
        expect(zone.underlying).toBe("BTC");
        expect(zone.strikes).toEqual([
          "7950000000000",
          "8000000000000",
          "8100000000000",
          "8150000000000",
        ]);
        expect(zone.floor).toBe("8000000000000");
        expect(zone.ceiling).toBe("8100000000000");
        expect(zone.wing).toBe("50000000000");
        expect(zone.availableAmount).toBe("10000000000");
        // The row itself, so the arena can quote and fill it rather than a copy.
        expect(zone.order).toBe(book.orders[zone.index]!);
      }
      // Ascending by expiry — the two live BTC columns the arena draws.
      expect(zones.map((z) => z.expiry)).toEqual([1_788_595_200, 1_788_681_600]);
    });

    test("a box drawn on the arena's own ladder matches one of them exactly", async () => {
      const { source } = await liveSource();
      const book = ladderOf(source);

      // The band's two edges are real rungs of the ladder the arena draws for
      // this column, so the box is one a player can actually snap to.
      const ladder = deriveLadder(book, "BTC", 1_788_595_200, AT);
      expect(ladder?.strikes).toContain("8000000000000");
      expect(ladder?.strikes).toContain("8100000000000");

      const zone = zonesFor(book, "BTC", 1_788_595_200, AT)[0];
      expect(zone).toBeDefined();
      const matched = matchListedZone(zoneBox(zone!), book, AT);
      expect(matched).toBeDefined();
      expect(matched?.order).toBe(zone!.order);
      expect(zoneUsd(matched!)).toEqual({ floor: 80_000, ceiling: 81_000 });
      expect(zoneWingUsd(matched!)).toBe(500);

      // And a box the book is not quoting matches nothing, which is the ordinary
      // outcome and not a failure: the listed ladder is about three bands wide.
      expect(
        matchListedZone({ ...zoneBox(zone!), ceiling: "8150000000000" }, book, AT),
      ).toBeNull();
    });

    test("strip either field from the wire and the zone path goes dark again", async () => {
      const { wire } = await liveSource();
      const book = ladderOf(sourceFrom(wire, false));
      expect(listedZones(book, AT)).toHaveLength(2);

      // No registry: "I cannot tell", which is the honest answer and the state
      // the browser was actually in.
      const noRegistry = {
        ...book,
        chainConfig: { priceFeeds: book.chainConfig.priceFeeds },
      };
      expect(listedZones(noRegistry, AT)).toEqual([]);

      // No implementation on the orders: same answer, other end of the lookup.
      const noAddress = {
        ...book,
        orders: book.orders.map((o) => ({
          ...o,
          rawApiData: { ...o.rawApiData, implementation: undefined },
        })),
      };
      expect(listedZones(noAddress, AT)).toEqual([]);

      // No side: `isTakerBuyable` refuses anything that is not literally
      // `false`, because "we could not tell" is not a side a player may take.
      const noSide = {
        ...book,
        orders: book.orders.map((o) => ({
          ...o,
          rawApiData: { ...o.rawApiData, isLong: undefined },
        })),
      };
      expect(listedZones(noSide, AT)).toEqual([]);
    });
  });
});

// ─── the mock answers honestly ───────────────────────────────────────────────

describe("the seeded source has no book, and says so", () => {
  test("the mock answers the ladder accessor, and the answer is nothing", () => {
    // Answered rather than absent: `ladder()` being missing means "this source
    // never read a raw book", and only hand-built fakes are in that state.
    expect(mockMarketSource.ladder).toBeDefined();
    expect(ladderOf(mockMarketSource)).toBe(NO_LADDER);
  });

  test("nothing can be derived from it — no ladder, no expiry, no rung", () => {
    const book = ladderOf(mockMarketSource);
    expect(deriveLadders(book)).toEqual([]);
    expect(liveExpiries(book, "ETH")).toEqual([]);
    expect(deriveLadder(book, "ETH", 1_788_595_200)).toBeNull();
  });

  test("and that is honesty, not emptiness — the seeded source is otherwise full", () => {
    // The point of the two tests above. This source has a complete pricing
    // table for ETH and BTC; what it does not have is a *capture*. Its rows are
    // `"4,000"` and `"27 SEP"` — a rendered table, with no feed address and no
    // unix expiry — and running them backwards into rungs would draw an arena
    // that looks exactly like a live one over a ladder no venue quotes. That is
    // the single failure plans 6 and 7 both exist to delete, so the honest
    // answer is nothing and the arena draws no columns.
    expect(mockMarketSource.pricing("ETH").length).toBeGreaterThan(0);
    expect(mockMarketSource.orders().length).toBeGreaterThan(0);
    expect(mockMarketSource.underlyings()).toEqual(["ETH", "BTC"]);
  });
});
