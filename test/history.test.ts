import { describe, expect, test } from "bun:test";
import { CHAIN_CONFIGS_BY_ID } from "@thetanuts-finance/thetanuts-client";
import {
  ANSWER_UPDATED_TOPIC,
  BASE_PRICE_FEEDS,
  DEFAULT_WINDOWS,
  MAX_WINDOWS,
  PRICE_SOURCE,
  ROUND_BUDGET,
  SETTLEMENT_NOTE,
  WINDOW_BLOCKS,
  createHistorySource,
  decodeAnswerUpdated,
  decodeRoundData,
  emptyHistory,
  fitToLadder,
  isFuture,
  measure,
  normalise,
  splitRoundId,
  type HistoryPoint,
  type RpcCall,
} from "../src/data/history.ts";
import * as history from "../src/data/history.ts";

/**
 * The price history behind the box builder's grid, offline.
 *
 * `createHistorySource` takes its RPC and its clock as parameters, so every
 * test here drives the real decode, fallback, clamp and cache paths over a fake
 * transport. **No test in this file opens a socket and none can**: the real
 * `jsonRpc` transport is built lazily inside the first read and `deps.rpc` is
 * always supplied below. The live probes that produced the constants asserted
 * here were run once, by hand, and their outputs are frozen into the fixtures.
 *
 * The contract this file pins, in one sentence: **the chart is drawn from the
 * feed that settles the option, it never draws the future, it never invents a
 * scale, and a dead RPC costs the screen its chart and nothing else.**
 */

// ─── Fixtures, captured live from Base 8453 on 4 Sep 2026 ────────────────────
// ETH/USD proxy 0x7104…Bb70, phase aggregator 0x05c8…7bb0, round 1599:
// `latestRoundData()` and the round's own `AnswerUpdated` log both report
// 2448.09306508 at 2026-09-04T18:01:25Z. That agreement is the whole reason the
// two decoders below are allowed to be interchangeable.

const ETH_PROXY = "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70";
const ETH_AGGREGATOR = "0x05c84a58fe042275b37db038baacd15f410c7bb0";
/** 244809306508 at 8dp. */
const REAL_PX = 2448.09306508;
/** `updatedAt` of that round — 2026-09-04T18:01:25Z, `0x6a9b0775`. */
const REAL_SEC = 1788544885;
const REAL_SEC_N = BigInt(REAL_SEC);
const REAL_T = REAL_SEC * 1000;
/** phase 3 << 64 | 1599. */
const REAL_ROUND_ID = 55340232221128656447n;

const w = (v: bigint): string => v.toString(16).padStart(64, "0");
const abi = (...words: bigint[]): string => `0x${words.map(w).join("")}`;

const REAL_LOG = {
  topics: [
    ANSWER_UPDATED_TOPIC,
    "0x00000000000000000000000000000000000000000000000000000038ffc5918c",
    "0x000000000000000000000000000000000000000000000000000000000000063f",
  ],
  data: "0x000000000000000000000000000000000000000000000000000000006a9b0775",
};

/** `(roundId, answer, startedAt, updatedAt, answeredInRound)`. */
const roundReturn = (roundId: bigint, answer: bigint, updatedAtSec: bigint): string =>
  abi(roundId, answer, updatedAtSec - 3n, updatedAtSec, roundId);

const logAt = (px: number, tSec: number, decimals = 8) => ({
  topics: [ANSWER_UPDATED_TOPIC, `0x${w(BigInt(Math.round(px * 10 ** decimals)))}`, `0x${w(1n)}`],
  data: `0x${w(BigInt(tSec))}`,
});

// ─── A fake transport ────────────────────────────────────────────────────────

interface FakeOptions {
  /** `eth_getLogs` answers, oldest window last. `null` makes that window fail. */
  windows?: (readonly unknown[] | null)[];
  /** Force `aggregator()` to revert, as some proxy revisions do. */
  noAggregator?: boolean;
  decimals?: bigint | null;
  rounds?: Map<bigint, string>;
  latestRound?: string | null;
  /** Reject everything — a dead endpoint. */
  dead?: boolean;
}

function fakeRpc(options: FakeOptions = {}) {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  let window = 0;

  const rpc: RpcCall = async (method, params) => {
    calls.push({ method, params });
    if (options.dead) throw new Error("connect ECONNREFUSED");
    if (method === "eth_blockNumber") return "0x3080000";
    if (method === "eth_getLogs") {
      const configured = options.windows;
      const answer = configured && window < configured.length ? configured[window] : [];
      window += 1;
      // `null` is a configured *failure*, and it must not collapse into "no
      // logs" — the difference between a throttled window and an empty one is
      // exactly what the note-not-failure test is about.
      if (answer === null) throw new Error("over rate limit");
      return answer ?? [];
    }
    if (method === "eth_call") {
      const [tx] = params as [{ to: string; data: string }];
      if (tx.data === "0x313ce567") {
        const decimals = options.decimals === undefined ? 8n : options.decimals;
        if (decimals === null) throw new Error("execution reverted");
        return `0x${w(decimals)}`;
      }
      if (tx.data === "0x245a7bfc") {
        if (options.noAggregator) throw new Error("execution reverted");
        return `0x${"0".repeat(24)}${ETH_AGGREGATOR.slice(2)}`;
      }
      if (tx.data === "0xfeaf968c") {
        if (options.latestRound === null) throw new Error("execution reverted");
        return options.latestRound ?? roundReturn(REAL_ROUND_ID, 244809306508n, REAL_SEC_N);
      }
      if (tx.data.startsWith("0x9a6fc8f5")) {
        const roundId = BigInt(`0x${tx.data.slice(10)}`);
        const answer = options.rounds?.get(roundId);
        if (!answer) throw new Error("No data present");
        return answer;
      }
    }
    throw new Error(`unexpected ${method}`);
  };

  return {
    rpc,
    calls,
    count: (method?: string) => (method ? calls.filter((c) => c.method === method).length : calls.length),
  };
}

/** A clock the tests move by hand. */
function clock(start = REAL_T + 60_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// ─── The feed table is the SDK's, not ours ───────────────────────────────────

describe("the price source is named, and it is the settlement oracle", () => {
  test("BASE_PRICE_FEEDS mirrors chainConfig.priceFeeds for Base 8453", () => {
    // The one assertion that keeps a mirrored table honest. The SDK may not be
    // imported by client code (it drags axios, viem and ethers into the
    // bundle), so `src/data/history.ts` carries a copy — and the day Thetanuts
    // rotates a feed, this fails instead of the chart drawing the wrong asset.
    expect(BASE_PRICE_FEEDS).toEqual(CHAIN_CONFIGS_BY_ID[8453].priceFeeds);
  });

  test("the ETH feed is the address Thetanuts settles against", () => {
    expect(BASE_PRICE_FEEDS.ETH).toBe(ETH_PROXY);
    // `ETH` and `ETH/USD` are literally the same address (FINDINGS §3).
    expect(BASE_PRICE_FEEDS["ETH/USD"]).toBe(BASE_PRICE_FEEDS.ETH);
  });

  test("the settlement-feed disagreement is stated, not implied", () => {
    expect(PRICE_SOURCE).toContain("Chainlink");
    expect(SETTLEMENT_NOTE).toContain("TWAP");
    expect(SETTLEMENT_NOTE.toLowerCase()).toContain("differ");
  });
});

// ─── Decoding, against numbers read off the live chain ───────────────────────

describe("both decoders read the same round the same way", () => {
  test("AnswerUpdated decodes to the live ETH print", () => {
    expect(decodeAnswerUpdated(REAL_LOG, 8)).toEqual({ t: REAL_T, px: REAL_PX });
  });

  test("latestRoundData decodes to the same print", () => {
    const decoded = decodeRoundData(roundReturn(REAL_ROUND_ID, 244809306508n, REAL_SEC_N), 8);
    expect(decoded?.point).toEqual({ t: REAL_T, px: REAL_PX });
    expect(decoded?.roundId).toBe(REAL_ROUND_ID);
  });

  test("a proxy round id splits into phase and aggregator round", () => {
    // The arithmetic the walk depends on: knowing this, the previous 39 ids are
    // computed rather than discovered one call at a time.
    expect(splitRoundId(REAL_ROUND_ID)).toEqual({ phase: 3n, round: 1599n });
  });

  test("decimals are honoured, not assumed", () => {
    // 18dp would render a $2,448 asset at 2.4e-7. Reading `decimals()` is what
    // stops that being silent.
    expect(decodeAnswerUpdated(REAL_LOG, 18)?.px).toBeCloseTo(2.4480930650799998e-7, 15);
  });

  test("a negative or zero answer is a miss, never a price", () => {
    // int256 two's complement — decoding this unsigned would give 1.1e77.
    const negative = { topics: [ANSWER_UPDATED_TOPIC, `0x${w((1n << 256n) - 100n)}`], data: `0x${w(1n)}` };
    expect(decodeAnswerUpdated(negative, 8)).toBeNull();
    expect(decodeRoundData(roundReturn(1n, 0n, REAL_SEC_N), 8)).toBeNull();
  });

  test("malformed input is null, not an exception", () => {
    expect(decodeAnswerUpdated({}, 8)).toBeNull();
    expect(decodeAnswerUpdated({ topics: ["0xdead"], data: "0x00" }, 8)).toBeNull();
    expect(decodeRoundData("0x", 8)).toBeNull();
    expect(decodeRoundData(undefined, 8)).toBeNull();
  });
});

// ─── The read, end to end, over a fake chain ─────────────────────────────────

describe("a chart is read from logs, and the cost is visible", () => {
  const t0 = REAL_SEC - 7200;
  const windowOf = (n: number, from: number) =>
    Array.from({ length: n }, (_, i) => logAt(2400 + i, from + i * 300));

  test("points arrive ascending, deduped, and measured", async () => {
    const fake = fakeRpc({ windows: [windowOf(4, t0 + 1200), windowOf(4, t0)] });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now, windows: 2 });

    const h = await source.history("ETH");
    expect(h.meta.ok).toBe(true);
    expect(h.meta.source).toBe("chainlink");
    expect(h.meta.transport).toBe("logs");
    expect(h.meta.feed?.proxy).toBe(ETH_PROXY);
    expect(h.meta.feed?.aggregator).toBe(ETH_AGGREGATOR);
    expect(h.meta.feed?.decimals).toBe(8);
    expect(h.points.map((p) => p.t)).toEqual([...h.points].sort((a, b) => a.t - b.t).map((p) => p.t));
    expect(h.points.length).toBe(8);
    expect(h.meta.granularity?.medianGapMs).toBe(300_000);
  });

  test("the cost per chart is 3 + windows RPC calls, and it is reported", async () => {
    // §2.5 warns that Chainlink history costs RPC calls. A cost that is not
    // counted is a cost nobody notices until an endpoint throttles in front of
    // players, so the number is in the envelope.
    const fake = fakeRpc({ windows: [windowOf(2, t0), windowOf(2, t0 - 3000)] });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now, windows: 2 });

    const h = await source.history("ETH");
    expect(fake.count()).toBe(5); // decimals, aggregator(), blockNumber, 2 windows
    expect(h.meta.rpcCalls).toBe(5);
    expect(fake.count("eth_getLogs")).toBe(2);
  });

  test("windows are capped, so no caller can ask for an outage", async () => {
    const fake = fakeRpc({ windows: Array.from({ length: 40 }, () => windowOf(1, t0)) });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now, windows: 400 });
    await source.history("ETH");
    expect(fake.count("eth_getLogs")).toBe(MAX_WINDOWS);
  });

  test("one bad window is a note, not a failure", async () => {
    const fake = fakeRpc({ windows: [windowOf(3, t0), null, windowOf(3, t0 - 9000)] });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now, windows: 3 });

    const h = await source.history("ETH");
    expect(h.meta.ok).toBe(true);
    expect(h.points.length).toBe(6);
    expect(h.meta.note).toContain("1 of 3 windows unavailable");
  });
});

describe("the round walk is the fallback, and it is bounded", () => {
  test("an unresolvable aggregator falls back to getRoundData", async () => {
    const rounds = new Map<bigint, string>();
    for (let k = 1n; k <= 6n; k += 1n) {
      rounds.set(REAL_ROUND_ID - k, roundReturn(REAL_ROUND_ID - k, 244000000000n + k, REAL_SEC_N - k * 300n));
    }
    const fake = fakeRpc({ noAggregator: true, rounds });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now });

    const h = await source.history("ETH");
    expect(h.meta.transport).toBe("rounds");
    expect(h.meta.feed?.aggregator).toBeNull();
    expect(h.meta.note).toContain("aggregator unresolved");
    // The head round plus the six that answered; the rest of the budget threw
    // `No data present`, which is a gap in the line and not an exception.
    expect(h.points.length).toBe(7);
    expect(h.points[h.points.length - 1]).toEqual({ t: REAL_T, px: REAL_PX });
  });

  test("the walk stops at the phase boundary rather than guessing", async () => {
    // Round 4 of phase 3: only ids 3, 2 and 1 exist below it, so the budget of
    // 40 must not produce a request for round 0 or for a previous phase.
    const head = (3n << 64n) | 4n;
    const rounds = new Map<bigint, string>();
    for (let k = 1n; k <= 3n; k += 1n) {
      rounds.set(head - k, roundReturn(head - k, 244000000000n, REAL_SEC_N - k * 300n));
    }
    const fake = fakeRpc({
      noAggregator: true,
      rounds,
      latestRound: roundReturn(head, 244809306508n, REAL_SEC_N),
    });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now });

    await source.history("ETH");
    const asked = fake.calls
      .filter((c) => (c.params as [{ data: string }])[0]?.data?.startsWith("0x9a6fc8f5"))
      .map((c) => splitRoundId(BigInt(`0x${(c.params as [{ data: string }])[0].data.slice(10)}`)).round);
    expect(asked.sort()).toEqual([1n, 2n, 3n]);
  });

  test("the budget is a ceiling on calls, whatever the head round is", async () => {
    const fake = fakeRpc({ noAggregator: true });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now });
    await source.history("ETH");
    const walked = fake.calls.filter((c) =>
      (c.params as [{ data: string }])[0]?.data?.startsWith("0x9a6fc8f5"),
    ).length;
    expect(walked).toBe(ROUND_BUDGET - 1);
  });
});

// ─── Degradation: the chart is the only thing that may be lost ───────────────

describe("it never throws at the boundary", () => {
  test("a dead RPC is an empty chart with a reason", async () => {
    const fake = fakeRpc({ dead: true });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now });

    const h = await source.history("ETH");
    expect(h.meta.ok).toBe(false);
    expect(h.meta.source).toBe("empty");
    expect(h.points).toEqual([]);
    expect(h.observed).toBeNull();
    expect(h.meta.note).toBeTruthy();
    expect(h.now.lastPrintAt).toBeNull();
  });

  test("an asset with no Chainlink feed costs zero RPC calls", async () => {
    // §2.1: SUI is not a Thetanuts asset. The answer is "no line", and it must
    // not be paid for with a round trip.
    const fake = fakeRpc();
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now });

    const h = await source.history("SUI");
    expect(h.meta.ok).toBe(false);
    expect(h.meta.rpcCalls).toBe(0);
    expect(fake.count()).toBe(0);
    expect(h.meta.note).toContain("SUI");
  });

  test("a feed whose decimals cannot be read draws nothing rather than guessing", async () => {
    const fake = fakeRpc({ decimals: null });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now });

    const h = await source.history("ETH");
    expect(h.meta.ok).toBe(false);
    expect(h.points).toEqual([]);
    expect(h.meta.rpcCalls).toBe(1);
  });

  test("an empty read is not cached, a missing feed is", async () => {
    const fake = fakeRpc({ dead: true });
    const c = clock();
    const source = createHistorySource({ rpc: fake.rpc, now: c.now });

    await source.history("ETH");
    const first = fake.count();
    await source.history("ETH");
    // Retried immediately: an empty chart should come back on the next poll,
    // not be pinned empty for a minute.
    expect(fake.count()).toBeGreaterThan(first);

    const beforeSui = fake.count();
    const one = await source.history("SUI");
    const two = await source.history("SUI");
    // Cached, and free: an asset with no feed cost no call to decide, and the
    // answer cannot change.
    expect(two).toBe(one);
    expect(fake.count()).toBe(beforeSui);
  });
});

// ─── The "now" divider is data ───────────────────────────────────────────────

describe("the divider is data, and the future belongs to the box", () => {
  const t0 = REAL_SEC - 7200;

  test("no point is at or after the divider, even if the chain returns one", async () => {
    const c = clock();
    const future = c.now() / 1000 + 3600;
    const fake = fakeRpc({ windows: [[logAt(2400, t0), logAt(9999, future)]] });
    const source = createHistorySource({ rpc: fake.rpc, now: c.now, windows: 1 });

    const h = await source.history("ETH");
    expect(h.points.every((p) => p.t < h.now.at)).toBe(true);
    expect(h.points.some((p) => p.px === 9999)).toBe(false);
  });

  test("the divider and the last print are different numbers", async () => {
    // A chart that runs its line flat to the divider is drawing a price nobody
    // published. The gap is reported so the UI can leave it blank.
    const c = clock();
    const lastPrint = Math.floor(c.now() / 1000) - 600;
    const fake = fakeRpc({ windows: [[logAt(2448, lastPrint)]] });
    const source = createHistorySource({ rpc: fake.rpc, now: c.now, windows: 1 });

    const h = await source.history("ETH");
    expect(h.now.at).toBe(c.now());
    expect(h.now.lastPrintAt).toBe(lastPrint * 1000);
    expect(h.now.staleMs).toBe(600_000);
  });

  test("isFuture refuses now and everything left of it", () => {
    const boundary = { at: 1_000_000, lastPrintAt: 900_000, staleMs: 100_000 };
    expect(isFuture(1_000_001, boundary)).toBe(true);
    // The box's right edge may not land on "now" — an expiry at this instant
    // has already happened, and the box is a prediction about the future.
    expect(isFuture(1_000_000, boundary)).toBe(false);
    expect(isFuture(999_999, boundary)).toBe(false);
    expect(isFuture(Number.NaN, boundary)).toBe(false);
  });

  test("normalise drops the future and dedupes by timestamp", () => {
    const points: HistoryPoint[] = [
      { t: 300, px: 3 },
      { t: 100, px: 1 },
      { t: 300, px: 3 },
      { t: 900, px: 9 },
    ];
    expect(normalise(points, 500)).toEqual([
      { t: 100, px: 1 },
      { t: 300, px: 3 },
    ]);
  });
});

// ─── One shared y-axis: the ladder decides, this module does not ─────────────

describe("the chart is fitted to the ladder, never the other way round", () => {
  const h = {
    ...emptyHistory(1_000_000),
    points: [
      { t: 1, px: 2300 },
      { t: 2, px: 2500 },
      { t: 3, px: 2900 },
    ],
  };

  test("fitToLadder clips to the caller's band and never rescales a price", () => {
    const fitted = fitToLadder(h, 2400, 2800);
    expect(fitted.points).toEqual([{ t: 2, px: 2500 }]);
    expect(fitted.clipped).toBe(2);
    // Every surviving price is byte-identical to the one that was printed.
    for (const p of fitted.points) {
      expect(h.points.some((q) => q.t === p.t && q.px === p.px)).toBe(true);
    }
  });

  test("an unusable band is passed through rather than emptying the chart", () => {
    expect(fitToLadder(h, 2800, 2400).points.length).toBe(3);
    expect(fitToLadder(h, Number.NaN, 1).points.length).toBe(3);
  });

  test("observed is descriptive — it is the data's range, not an axis", async () => {
    const fake = fakeRpc({ windows: [[logAt(2400, REAL_SEC - 600), logAt(2600, REAL_SEC - 300)]] });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now, windows: 1 });
    const read = await source.history("ETH");
    expect(read.observed).toEqual({ lo: 2400, hi: 2600 });
  });

  test("measure reports what was read, and nothing below two points", () => {
    expect(measure([])).toBeNull();
    expect(measure([{ t: 1, px: 1 }])).toBeNull();
    expect(
      measure([
        { t: 0, px: 1 },
        { t: 300_000, px: 1 },
        { t: 1_500_000, px: 1 },
      ]),
    ).toEqual({ points: 3, medianGapMs: 1_200_000, maxGapMs: 1_200_000, spanMs: 1_500_000 });
  });
});

// ─── Caching ─────────────────────────────────────────────────────────────────

describe("one read serves every caller inside the TTL", () => {
  test("a second call inside the TTL costs nothing, and past it re-reads", async () => {
    const fake = fakeRpc({ windows: Array.from({ length: 20 }, () => [logAt(2448, REAL_SEC - 600)]) });
    const c = clock();
    const source = createHistorySource({ rpc: fake.rpc, now: c.now, windows: 1, ttlMs: 60_000 });

    await source.history("ETH");
    const spent = fake.count();
    await source.history("eth "); // same asset, spelled carelessly
    expect(fake.count()).toBe(spent);

    c.advance(60_001);
    await source.history("ETH");
    expect(fake.count()).toBeGreaterThan(spent);
  });

  test("concurrent callers share one read", async () => {
    const fake = fakeRpc({ windows: Array.from({ length: 20 }, () => [logAt(2448, REAL_SEC - 600)]) });
    const source = createHistorySource({ rpc: fake.rpc, now: clock().now, windows: 1 });

    const [a, b] = await Promise.all([source.history("ETH"), source.history("ETH")]);
    expect(a).toBe(b);
    expect(fake.count()).toBe(4);
  });
});

// ─── History is context, not a control ───────────────────────────────────────

describe("nothing in a position can be derived from this line", () => {
  test("the export surface is frozen", () => {
    // §2.5: the history cannot be clicked and nothing in the position derives
    // from it. The way that stops being true is by drift — a `nearestStrike`
    // helper added here "just for the chart", then imported by the builder. If
    // this list needs a new name, that is a decision, not a diff.
    expect(Object.keys(history).sort()).toEqual(
      [
        "ANSWER_UPDATED_TOPIC",
        "BASE_PRICE_FEEDS",
        "DEFAULT_RPC_URL",
        "DEFAULT_WINDOWS",
        "HISTORY_TTL_MS",
        "MAX_WINDOWS",
        "PRICE_SOURCE",
        "ROUND_BATCH",
        "ROUND_BUDGET",
        "SETTLEMENT_NOTE",
        "WINDOW_BLOCKS",
        "createHistorySource",
        "decodeAnswerUpdated",
        "decodeRoundData",
        "emptyHistory",
        "fitToLadder",
        "isFuture",
        "jsonRpc",
        "measure",
        "normalise",
        "splitRoundId",
      ].sort(),
    );
  });

  test("the module imports nothing — no SDK, no ethers, no env read", async () => {
    // The client bundle must not carry the Thetanuts SDK (axios, viem, ethers:
    // ~1MB, `src/data/thetanuts.tsx`), and `test/secrets.test.ts` fails the
    // build if a server-only env read reaches it. Both are properties of this
    // file's text, so they are asserted on the text.
    const source = await Bun.file(new URL("../src/data/history.ts", import.meta.url)).text();
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/Bun\.env|process\.env/);
  });

  test("the constants are the measured ones", () => {
    // Base public RPC: `eth_getLogs is limited to a 10,000 range` (-32614), and
    // ~2s blocks, so a window is ~5.5h and the default six is ~33h.
    expect(WINDOW_BLOCKS).toBe(10_000);
    expect(DEFAULT_WINDOWS).toBe(6);
    expect(DEFAULT_WINDOWS).toBeLessThanOrEqual(MAX_WINDOWS);
  });
});
