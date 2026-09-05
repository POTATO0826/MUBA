import { beforeEach, describe, expect, test } from "bun:test";
import {
  PRACTICE_TAPE_CHIP,
  type RoomOpen,
  liveOpenChip,
  openFor,
} from "../src/data/room.ts";
import { meta } from "../src/data/universe.ts";
import { TAPE_LEN, pctAt, series } from "../src/engine/tape.ts";
import {
  BOOK_LABEL,
  CHAINLINK_LABEL,
  LANES,
  MAX_BATCH,
  _resetOpenSpot,
  captureOpen,
  chainlinkSpot,
  jsonRpcBatch,
} from "../src/server/openspot.ts";
import { _resetRooms, createRoom, joinRoom, pickRoom, readyRoom } from "../src/server/rooms.ts";

/**
 * The opening print, end to end.
 *
 * ## What broke, and what this file pins so it cannot break again
 *
 * `engine/tape.ts` opened every duel's walk on `meta(sym).px`, a fixture row
 * written when ETH was $4,182.60. Measured against Base on 2026-09-05 the live
 * prints were ETH $2,450.76, BTC $79,561.30 — the fixture was 70% and 21% out,
 * and the duel's legs read `ETH closes above 4,392` beside a live spot of
 * $2,453 on the same screen.
 *
 * The fix is not "make the tape live" — a live tape is two tapes, one per
 * client, and the duel stops meaning anything. It is: capture a real spot
 * ONCE, server-side, at room creation, freeze it beside the seed, and let the
 * same seeded walk run from there. Three properties have to hold for that to be
 * safe, and each has a block below:
 *
 *  1. **Settlement does not move.** The walk is multiplicative, so every ratio
 *     on it — which is all `pctAt` returns and all `engine/match.ts` settles on
 *     — is independent of the open. Asserted directly, not argued.
 *  2. **Both seats get one open.** It is written once at `createRoom` and no
 *     later transition may touch it.
 *  3. **A number that is not live says so.** `openFor` cannot return a bare
 *     price, and `null` is never quietly the old fixture.
 */

const HOST = "0x71cB05fD1eA1B3d4a7C9e8F2b6D0a3C85e9d4Af2";
const GUEST = "0xAaaA000000000000000000000000000000000001";

/** Live prints read off `mainnet.base.org` on 2026-09-05 — real numbers, so a
 *  reader can see what the fixture was actually 70% wrong about. */
const LIVE = { ETH: 2450.7561, BTC: 79561.3042, XRP: 1.399, BNB: 724.2087 } as const;

function open(o: RoomOpen | null = null) {
  const r = createRoom(
    { address: HOST, stakeUsdc: 10, durationMinutes: 1, lobbyName: "T", mode: "box" },
    o,
  );
  if (!r.ok) throw new Error(`createRoom refused: ${r.code}`);
  return r.room;
}

const chainlinkOpen: RoomOpen = {
  px: { ...LIVE },
  source: "chainlink",
  at: 1_757_049_389_000,
  label: CHAINLINK_LABEL,
};

// ── 1. Settlement does not move ─────────────────────────────────────────────

describe("the opening print rescales the tape and settles nothing differently", () => {
  test("pctAt is identical on a live open and on the seeded reference", () => {
    // This is the whole safety argument for the change, and it is arithmetic
    // rather than a promise: out[i] = out[i-1] * (1 + drift + shock), so the
    // tape is `open × Π(1 + …)` and every ratio cancels the open exactly.
    for (const [sym, px] of Object.entries(LIVE)) {
      for (const salt of [1272727, 1272728, 424242]) {
        expect(pctAt(sym, salt, TAPE_LEN, px)).toBeCloseTo(pctAt(sym, salt, TAPE_LEN), 12);
        expect(pctAt(sym, salt, 37, px)).toBeCloseTo(pctAt(sym, salt, 37), 12);
      }
    }
  });

  test("every print scales by exactly the ratio of the two opens", () => {
    const seeded = series("ETH", 1272728);
    const live = series("ETH", 1272728, LIVE.ETH);
    const k = LIVE.ETH / meta("ETH").px;
    expect(live).toHaveLength(TAPE_LEN);
    for (let i = 0; i < TAPE_LEN; i++) {
      expect(live[i]! / seeded[i]!).toBeCloseTo(k, 10);
    }
  });

  test("scale invariance holds for the cheap names too, at any open", () => {
    // The regression that made the floor proportional. It used to be the
    // absolute number `1`, written for a board whose cheapest name was $0.84.
    // XRP's reference is $1.45 and clears it; XRP's live print is $1.399 and
    // does not — so threading a true price into a QUALIFIED asset started
    // clamping a tape that had never clamped, and a clamp is the one operation
    // in the walk that is not multiplicative. This asserts the whole board,
    // including the names the old floor silently mangled.
    for (const sym of ["XRP", "DOGE", "ARB", "PEPE", "AVAX", "SOL", "ETH", "BTC"]) {
      const base = meta(sym).px;
      for (const k of [0.5, 0.964, 1.37, 1000]) {
        expect(pctAt(sym, 424242, TAPE_LEN, base * k)).toBeCloseTo(
          pctAt(sym, 424242, TAPE_LEN),
          10,
        );
      }
    }
  });

  test("no print is ever clamped, so no percentage is a guard clause's opinion", () => {
    // Measured before the fix, on this salt: PEPE clamped 4 of 200 prints and
    // reported +11,817,066%, DOGE clamped 21 and reported +1,005%, ARB clamped
    // 8 and reported +75%. Those were settled percentages.
    for (const sym of ["PEPE", "DOGE", "ARB", "XRP", "ETH"]) {
      const tape = series(sym, 1272728);
      const floor = meta(sym).px * 1e-9;
      expect(Math.min(...tape)).toBeGreaterThan(floor * 1e6);
    }
  });

  test("the same (sym, salt, open) is the same tape, so two seats agree", () => {
    // Both seats compute locally from `(seed, open)` with no message between
    // them. If this were ever false the duel would be unreplayable, which is
    // the one thing `test/determinism.test.ts` exists to prevent.
    expect(series("BTC", 991, LIVE.BTC)).toEqual(series("BTC", 991, LIVE.BTC));
    expect(series("BTC", 991, LIVE.BTC)).not.toEqual(series("BTC", 991, LIVE.BTC * 1.01));
    expect(series("BTC", 991, LIVE.BTC)).not.toEqual(series("BTC", 992, LIVE.BTC));
  });

  test("the cache tells two opens apart instead of serving the first one twice", () => {
    // The cache key gained the open for exactly this reason. A key of
    // `sym:salt` alone would hand the second room the first room's prices.
    const a = series("SOL", 55, 101.87);
    const b = series("SOL", 55, 214.4);
    expect(a[0]).toBe(101.87);
    expect(b[0]).toBe(214.4);
    expect(series("SOL", 55, 101.87)).toBe(a);
  });
});

describe("the seeded reference is still the fallback, and only through the front door", () => {
  test("an omitted open opens on meta(sym).px, byte for byte as before", () => {
    // The compatibility clause. Every existing call site omits the argument,
    // and `test/determinism.test.ts` locks NVDA's two windows to ten decimal
    // places — those locks read this path.
    for (const sym of ["NVDA", "ETH", "BTC", "AAPL"]) {
      expect(series(sym, 1272727)[0]).toBe(meta(sym).px);
      expect(series(sym, 1272727, undefined)).toEqual(series(sym, 1272727));
    }
  });

  test("a junk open is refused rather than drawn", () => {
    // A NaN would poison every print after it; a zero or a negative would draw
    // a flat tape on the floor and read as "the market did nothing".
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, -0.0001]) {
      expect(series("ETH", 7, bad)[0]).toBe(meta("ETH").px);
    }
  });
});

// ── 3. A number that is not live says so ────────────────────────────────────

describe("openFor is the honesty seam", () => {
  test("a captured symbol comes back live, with its provenance", () => {
    const got = openFor(chainlinkOpen, "ETH");
    expect(got).toEqual({
      px: LIVE.ETH,
      live: true,
      source: "chainlink",
      at: chainlinkOpen.at,
    });
  });

  test("no capture at all is the reference price, marked not live", () => {
    const got = openFor(null, "ETH");
    expect(got.px).toBe(meta("ETH").px);
    expect(got.live).toBe(false);
    expect(got.source).toBeNull();
    expect(got.at).toBeNull();
  });

  test("a symbol missing from a live capture is not live either", () => {
    // NVDA has no Chainlink aggregator on Base and never will; SOL can be
    // rate-limited out of an otherwise-good capture. Both are `live: false`,
    // and neither costs ETH its real open.
    for (const sym of ["NVDA", "SOL", "DOGE"]) {
      expect(openFor(chainlinkOpen, sym).live).toBe(false);
      expect(openFor(chainlinkOpen, sym).px).toBe(meta(sym).px);
    }
    expect(openFor(chainlinkOpen, "BTC").live).toBe(true);
  });

  test("a zero or negative captured price is not treated as a price", () => {
    const bad: RoomOpen = { ...chainlinkOpen, px: { ETH: 0, BTC: -1, XRP: Number.NaN } };
    for (const sym of ["ETH", "BTC", "XRP"]) expect(openFor(bad, sym).live).toBe(false);
  });

  test("the two chips say different things and neither is decorative", () => {
    expect(liveOpenChip(chainlinkOpen)).toBe(`LIVE OPEN · ${CHAINLINK_LABEL}`);
    expect(PRACTICE_TAPE_CHIP).toContain("NO LIVE OPEN");
    expect(liveOpenChip(chainlinkOpen)).not.toBe(PRACTICE_TAPE_CHIP);
  });
});

// ── 2. Both seats get one open ──────────────────────────────────────────────

describe("the room freezes the open at creation and never moves it", () => {
  beforeEach(_resetRooms);

  test("no capture supplied is an honest null, not a silent fixture", () => {
    // The default, and every caller that predates this change. It must not
    // quietly become `meta(sym).px` — swapping one silent fixture for another
    // would be no improvement at all.
    expect(open().open).toBeNull();
  });

  test("a supplied capture rides on the view both seats read", () => {
    const room = open(chainlinkOpen);
    expect(room.open).toEqual(chainlinkOpen);
  });

  test("joining, readying and picking all leave the open exactly where it was", () => {
    // A guest arriving four minutes after the host joins the HOST's tape. If
    // any transition re-anchored the open, the two seats would be watching the
    // same seed at two different price levels — the precise failure the shared
    // seed exists to prevent.
    const room = open(chainlinkOpen);
    const after = [
      joinRoom(room.id, GUEST),
      readyRoom(room.id, HOST),
      readyRoom(room.id, GUEST),
      pickRoom(room.id, HOST, "a"),
      pickRoom(room.id, GUEST, "b"),
    ];
    for (const r of after) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.room.open).toEqual(chainlinkOpen);
    }
  });

  test("two rooms created from two captures do not share one", () => {
    const a = open(chainlinkOpen);
    const b = open({ ...chainlinkOpen, px: { ETH: 9 }, source: "book", label: BOOK_LABEL });
    expect(a.open?.px.ETH).toBe(LIVE.ETH);
    expect(b.open?.px.ETH).toBe(9);
  });
});

// ── The capture itself ──────────────────────────────────────────────────────

/** Five 32-byte words: (roundId, answer, startedAt, updatedAt, answeredInRound). */
function roundTuple(answer: bigint, updatedAtSec: number): string {
  const w = (v: bigint) => v.toString(16).padStart(64, "0");
  return `0x${w(1n)}${w(answer)}${w(0n)}${w(BigInt(updatedAtSec))}${w(1n)}`;
}

const DECIMALS_8 = `0x${(8n).toString(16).padStart(64, "0")}`;

/** A fake Base endpoint. `answers` is USD per aggregator address (lowercased);
 *  a symbol absent from it throws, which is what a rate limit looks like. */
function fakeRpc(answers: Readonly<Record<string, number>>, log: string[] = []) {
  return async (method: string, params: readonly unknown[]) => {
    const p = params[0] as { to: string; data: string };
    const to = p.to.toLowerCase();
    log.push(`${method}:${p.data}:${to}`);
    if (p.data === "0x313ce567") return DECIMALS_8;
    const usd = answers[to];
    if (usd === undefined) throw new Error("-32016 over rate limit");
    return roundTuple(BigInt(Math.round(usd * 1e8)), 1_757_049_389);
  };
}

const FEEDS = { ETH: "0xEeE1", BTC: "0xBbB2", SOL: "0xSss3", "ETH/USD": "0xEeE1" };

describe("chainlinkSpot", () => {
  beforeEach(_resetOpenSpot);

  test("decodes a real round tuple into USD", async () => {
    const px = await chainlinkSpot({
      rpc: fakeRpc({ "0xeee1": LIVE.ETH, "0xbbb2": LIVE.BTC, "0xsss3": 101.87 }),
      feeds: FEEDS,
      syms: ["ETH", "BTC", "SOL"],
    });
    expect(px.ETH).toBeCloseTo(LIVE.ETH, 6);
    expect(px.BTC).toBeCloseTo(LIVE.BTC, 6);
    expect(px.SOL).toBeCloseTo(101.87, 6);
  });

  test("a rate-limited feed is absent, and the others still answer", async () => {
    // Measured for real: seven feeds read flat-out came back with three
    // `-32016 over rate limit` refusals. One throttled SOL must not cost ETH
    // its real open, and it must not become a zero either.
    const px = await chainlinkSpot({
      rpc: fakeRpc({ "0xeee1": LIVE.ETH }),
      feeds: FEEDS,
      syms: ["ETH", "BTC", "SOL"],
      retryMs: 0,
    });
    expect(Object.keys(px)).toEqual(["ETH"]);
    expect(px.BTC).toBeUndefined();
  });

  test("an aggregator shared by two spellings is read once", async () => {
    // `BASE_PRICE_FEEDS` carries both `ETH` and `ETH/USD` at one address.
    const log: string[] = [];
    await chainlinkSpot({
      rpc: fakeRpc({ "0xeee1": LIVE.ETH }, log),
      feeds: FEEDS,
      syms: ["ETH", "ETH/USD"],
    });
    expect(log.filter((l) => l.startsWith("eth_call:0xfeaf968c"))).toHaveLength(1);
  });

  test("decimals() is read once per aggregator, not once per capture", async () => {
    // The public endpoint is the binding constraint; halving the call count is
    // the difference between a warm capture that answers and one that is
    // throttled.
    const log: string[] = [];
    const deps = { rpc: fakeRpc({ "0xeee1": LIVE.ETH }, log), feeds: FEEDS, syms: ["ETH"] };
    await chainlinkSpot(deps);
    await chainlinkSpot(deps);
    expect(log.filter((l) => l.startsWith("eth_call:0x313ce567"))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("eth_call:0xfeaf968c"))).toHaveLength(2);
  });

  test("no symbol has a feed, so nothing is invented", async () => {
    const px = await chainlinkSpot({
      rpc: fakeRpc({}),
      feeds: FEEDS,
      syms: ["NVDA", "AAPL"],
      retryMs: 0,
    });
    expect(px).toEqual({});
  });

  test("at most LANES calls are in flight at once", async () => {
    let live = 0;
    let peak = 0;
    const rpc = async (_m: string, params: readonly unknown[]) => {
      live += 1;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live -= 1;
      const p = params[0] as { data: string };
      return p.data === "0x313ce567" ? DECIMALS_8 : roundTuple(100_00000000n, 1);
    };
    const feeds = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`S${i}`, `0x${i}`]),
    );
    await chainlinkSpot({ rpc, feeds, syms: Object.keys(feeds) });
    expect(peak).toBeLessThanOrEqual(LANES);
  });
});

describe("the batch transport, which is why a room gets more than one live price", () => {
  beforeEach(_resetOpenSpot);

  test("a refused entry is undefined, and its neighbours still answer", async () => {
    // The whole contract of `BatchCall`: per-entry results, never a rejection,
    // so a rate-limited SOL is an absent symbol rather than a dead capture.
    const px = await chainlinkSpot({
      batch: async (reqs) =>
        reqs.map((r) => {
          const to = ((r.params[0] as { to: string }).to || "").toLowerCase();
          if ((r.params[0] as { data: string }).data === "0x313ce567") return DECIMALS_8;
          return to === "0xeee1" ? roundTuple(BigInt(Math.round(LIVE.ETH * 1e8)), 1) : undefined;
        }),
      feeds: FEEDS,
      syms: ["ETH", "BTC", "SOL"],
      retryMs: 0,
    });
    expect(Object.keys(px)).toEqual(["ETH"]);
  });

  test("what a batch refuses is retried, and retried in reverse", async () => {
    // Measured: the endpoint refuses the TAIL of a batch. A retry in the same
    // order would make the same names lose twice, so AVAX and BNB would carry a
    // seeded open forever while ETH always went live.
    //
    // Also pins the interleave: each feed's `decimals()` and `latestRoundData()`
    // are ADJACENT in one batch, so a partial answer is complete pairs at the
    // head rather than a batch of scale reads and no prices.
    const passes: string[][] = [];
    let n = 0;
    const px = await chainlinkSpot({
      batch: async (reqs) => {
        n += 1;
        passes.push(reqs.map((r) => (r.params[0] as { to: string }).to.toLowerCase()));
        return reqs.map((r, i) => {
          const isDecimals = (r.params[0] as { data: string }).data === "0x313ce567";
          // Pass 1 answers only the first feed's pair (entries 0 and 1).
          if (n === 1 && i > 1) return undefined;
          return isDecimals ? DECIMALS_8 : roundTuple(BigInt(Math.round(LIVE.ETH * 1e8)), 1);
        });
      },
      feeds: FEEDS,
      syms: ["ETH", "BTC", "SOL"],
      retryMs: 0,
    });

    expect(Object.keys(px).sort()).toEqual(["BTC", "ETH", "SOL"]);
    expect(passes).toHaveLength(2);
    // Interleaved: decimals and round for one aggregator sit side by side.
    expect(passes[0]).toEqual([
      "0xeee1",
      "0xeee1",
      "0xbbb2",
      "0xbbb2",
      "0xsss3",
      "0xsss3",
    ]);
    // The retry reads the two misses back to front — SOL before BTC.
    expect(passes[1]![0]).toBe("0xsss3");
    expect(passes[1]!.at(-1)).toBe("0xbbb2");
  });

  test("a fully dead endpoint is an empty capture, not a rejection", async () => {
    const px = await chainlinkSpot({
      batch: async (reqs) => reqs.map(() => undefined),
      feeds: FEEDS,
      syms: ["ETH", "BTC"],
      retryMs: 0,
    });
    expect(px).toEqual({});
  });

  test("jsonRpcBatch matches answers by id, not by arrival order", async () => {
    // Driven over a fake `fetch` rather than a socket. The server answers
    // id 1 first and refuses id 0, which is exactly the shape Base returns when
    // it throttles part of a batch.
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { id: number }[];
      expect(sent.map((r) => r.id)).toEqual([0, 1]);
      return new Response(
        JSON.stringify([
          { jsonrpc: "2.0", id: 1, result: "0xsecond" },
          { jsonrpc: "2.0", id: 0, error: { code: -32016, message: "over rate limit" } },
        ]),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const got = await jsonRpcBatch("http://base.test")([
        { method: "eth_call", params: [] },
        { method: "eth_call", params: [] },
      ]);
      expect(got).toEqual([undefined, "0xsecond"]);
    } finally {
      globalThis.fetch = real;
    }
  });

  test("jsonRpcBatch splits past Base's ten-entry cap and never rejects", async () => {
    const real = globalThis.fetch;
    const sizes: number[] = [];
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      const sent = JSON.parse(init.body) as { id: number }[];
      sizes.push(sent.length);
      // The second request dies at the transport, which must cost only its own
      // entries.
      if (sizes.length === 2) throw new Error("ECONNRESET");
      return new Response(
        JSON.stringify(sent.map((r) => ({ jsonrpc: "2.0", id: r.id, result: `r${r.id}` }))),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      const got = await jsonRpcBatch("http://base.test")(
        Array.from({ length: 13 }, () => ({ method: "eth_call", params: [] })),
      );
      expect(sizes).toEqual([MAX_BATCH, 3]);
      expect(got[0]).toBe("r0");
      expect(got[9]).toBe("r9");
      expect(got[10]).toBeUndefined();
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("captureOpen — book first, oracle second, null third", () => {
  beforeEach(_resetOpenSpot);

  const oracle = {
    rpc: fakeRpc({ "0xeee1": LIVE.ETH }),
    feeds: FEEDS,
    syms: ["ETH", "BTC"],
    retryMs: 0,
  };

  test("a live book wins: its spot prices the strikes the same room deals", async () => {
    const got = await captureOpen({
      ...oracle,
      snapshot: async () => ({ ok: true, at: 111, spot: { ETH: 2400, BTC: 79000 } }),
    });
    expect(got).toEqual({
      px: { ETH: 2400, BTC: 79000 },
      source: "book",
      at: 111,
      label: BOOK_LABEL,
    });
  });

  test("the book's zero-priced assets are dropped, not opened on", () => {
    // PAXG has a price feed and no market price, and a snapshot spells that
    // `0`. A zero open would draw a flat tape on the tape's floor.
    return captureOpen({
      ...oracle,
      snapshot: async () => ({ ok: true, at: 1, spot: { ETH: 2400, PAXG: 0 } }),
    }).then((got) => expect(got?.px).toEqual({ ETH: 2400 }));
  });

  test("an unreachable book falls through to the oracle that settles the option", async () => {
    // This is the live configuration as of 2026-09-05: the pricing host does
    // not resolve from this machine and `mainnet.base.org` does. A room opened
    // today therefore gets a real Chainlink open, not a practice tape.
    const got = await captureOpen({
      ...oracle,
      snapshot: async () => ({ ok: false }),
      now: () => 222,
    });
    expect(got?.source).toBe("chainlink");
    expect(got?.label).toBe(CHAINLINK_LABEL);
    expect(got?.at).toBe(222);
    expect(got?.px.ETH).toBeCloseTo(LIVE.ETH, 6);
  });

  test("a book that throws is a fall-through, not a failed room", async () => {
    const got = await captureOpen({
      ...oracle,
      snapshot: async () => {
        throw new Error("HTTP request failed");
      },
    });
    expect(got?.source).toBe("chainlink");
  });

  test("an ok book with nothing in it falls through rather than freezing {}", async () => {
    const got = await captureOpen({ ...oracle, snapshot: async () => ({ ok: true, spot: {} }) });
    expect(got?.source).toBe("chainlink");
  });

  test("both venues down is null — never the 2024 reference price", async () => {
    // The whole point. `null` reaches the screen as PRACTICE TAPE; it does not
    // reach the tape as $4,182.60 wearing a live chip.
    const got = await captureOpen({
      snapshot: async () => ({ ok: false }),
      rpc: fakeRpc({}),
      feeds: FEEDS,
      syms: ["ETH", "BTC"],
      retryMs: 0,
    });
    expect(got).toBeNull();
    expect(openFor(got, "ETH").live).toBe(false);
    expect(openFor(got, "ETH").px).toBe(meta("ETH").px);
  });

  test("a good capture is reused inside its TTL, so a burst of rooms is one read", async () => {
    const log: string[] = [];
    const deps = {
      rpc: fakeRpc({ "0xeee1": LIVE.ETH }, log),
      feeds: FEEDS,
      syms: ["ETH"],
      now: () => 1000,
    };
    const a = await captureOpen(deps);
    const b = await captureOpen(deps);
    expect(a).toEqual(b!);
    expect(log.filter((l) => l.startsWith("eth_call:0xfeaf968c"))).toHaveLength(1);
  });

  test("a FAILED capture is not cached — the next room retries the venue", async () => {
    let up = false;
    const deps = {
      rpc: async (_m: string, params: readonly unknown[]) => {
        const p = params[0] as { data: string };
        if (p.data === "0x313ce567") return DECIMALS_8;
        if (!up) throw new Error("-32016 over rate limit");
        return roundTuple(BigInt(Math.round(LIVE.ETH * 1e8)), 1);
      },
      feeds: FEEDS,
      syms: ["ETH"],
      retryMs: 0,
    };
    expect(await captureOpen(deps)).toBeNull();
    up = true;
    expect((await captureOpen(deps))?.source).toBe("chainlink");
  });

  test("concurrent room creations share one read", async () => {
    const log: string[] = [];
    const deps = { rpc: fakeRpc({ "0xeee1": LIVE.ETH }, log), feeds: FEEDS, syms: ["ETH"] };
    const [a, b, c] = await Promise.all([
      captureOpen(deps),
      captureOpen(deps),
      captureOpen(deps),
    ]);
    expect(a).toEqual(b!);
    expect(b).toEqual(c!);
    expect(log.filter((l) => l.startsWith("eth_call:0xfeaf968c"))).toHaveLength(1);
  });

  test("captureOpen never rejects, whatever the transport does", async () => {
    expect(
      await captureOpen({
        snapshot: async () => {
          throw new Error("dns");
        },
        rpc: async () => {
          throw new Error("socket");
        },
        feeds: FEEDS,
        syms: ["ETH"],
        retryMs: 0,
      }),
    ).toBeNull();
  });
});

describe("a room opened off a real capture walks from a real price", () => {
  beforeEach(() => {
    _resetRooms();
    _resetOpenSpot();
  });

  test("end to end: capture → room → both seats' tape opens on the live print", async () => {
    const captured = await captureOpen({
      snapshot: async () => ({ ok: false }),
      rpc: fakeRpc({ "0xeee1": LIVE.ETH }),
      feeds: FEEDS,
      syms: ["ETH"],
    });
    const host = open(captured);
    const guest = joinRoom(host.id, GUEST);
    expect(guest.ok).toBe(true);
    if (!guest.ok) return;

    const salt = 1 + host.seed * 3;
    const hostTape = series("ETH", salt, openFor(host.open, "ETH").px);
    const guestTape = series("ETH", salt, openFor(guest.room.open, "ETH").px);

    expect(hostTape).toEqual(guestTape);
    expect(hostTape[0]).toBeCloseTo(LIVE.ETH, 6);
    // And the number it is NOT: the fixture the tape used to open on.
    expect(hostTape[0]).not.toBeCloseTo(4182.6, 1);
    expect(openFor(host.open, "ETH").live).toBe(true);
  });

  test("end to end with both venues down: same tape, and it admits it", async () => {
    const captured = await captureOpen({
      snapshot: async () => ({ ok: false }),
      rpc: fakeRpc({}),
      feeds: FEEDS,
      syms: ["ETH"],
      retryMs: 0,
    });
    expect(captured).toBeNull();

    const host = open(captured);
    const guest = joinRoom(host.id, GUEST);
    if (!guest.ok) throw new Error("join refused");

    const salt = 1 + host.seed * 3;
    const hostTape = series("ETH", salt, openFor(host.open, "ETH").px);
    const guestTape = series("ETH", salt, openFor(guest.room.open, "ETH").px);

    // Still one tape — the duel is playable and fair.
    expect(hostTape).toEqual(guestTape);
    // But it is the reference price, and the seam says so out loud. A screen
    // reading this must show PRACTICE_TAPE_CHIP; it may not print the number
    // beside a LIVE badge.
    expect(hostTape[0]).toBe(meta("ETH").px);
    expect(openFor(host.open, "ETH").live).toBe(false);
  });
});
