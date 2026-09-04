import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  TTL_MS,
  createMarketService,
  type MarketClient,
  type RawMarket,
  type RawMmQuote,
} from "../src/server/thetanuts.ts";

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
    impl: (usdc?: bigint, referrer?: string) => { numContracts: bigint; totalCollateral: bigint },
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
    expect(fake.seen).toHaveLength(env.orders.length);
    // $1.00 in USDC 6dp, and our referrer on every one — the same attribution
    // string P3's fill will carry.
    for (const call of fake.seen) expect(call).toEqual({ usdc: 1_000000n, referrer: "0xReferrer" });
    expect(env.orders[0]?.preview).toEqual({
      contracts: "0.0043", // 18dp
      collateral: "1.00", //  6dp
      fillable: true,
    });
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
