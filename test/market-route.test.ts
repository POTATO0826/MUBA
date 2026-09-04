import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  TTL_MS,
  createMarketService,
  type MarketClient,
  type RawMarket,
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
