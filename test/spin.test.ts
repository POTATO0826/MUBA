import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LOBBIES, bookFor, bookOf, canPlay, opponentOf, stakePointsFor } from "../src/data/lobbies.ts";
import { marketOf } from "../src/data/sectors.ts";
import { nextTier, tierFor } from "../src/data/rewards.ts";
import { LIVE_BOARD } from "../src/data/universe.ts";
import {
  CONSTRAINTS,
  MIN_WINDOW_STRIKES,
  NO_CONSTRAINT_ODDS,
  STRIKE_WINDOW_FRACTION,
  STRIP_LEN,
  type SliceBook,
  planSpin,
  seededRandom,
  spinCase,
  spinSlice,
} from "../src/engine/spin.ts";
import type { FillableOrder, PricingRow } from "../src/types.ts";

describe("planSpin", () => {
  test("always lands in the last quarter of the strip and inside it", () => {
    for (let i = 0; i < 200; i++) {
      const p = planSpin();
      expect(p.target).toBeGreaterThanOrEqual(Math.floor(STRIP_LEN * 0.72));
      expect(p.target).toBeLessThan(STRIP_LEN - 1);
      expect(Number.isInteger(p.target)).toBe(true);
      expect(Math.abs(p.jitter)).toBeLessThanOrEqual(0.35);
    }
  });

  test("is fully driven by the random source", () => {
    const a = planSpin(() => 0);
    const b = planSpin(() => 0.999);
    expect(a.target).toBe(Math.floor(STRIP_LEN * 0.72));
    expect(b.target).toBe(STRIP_LEN - 3);
    expect(a.jitter).toBeCloseTo(-0.35, 10);
  });
});

describe("spinCase", () => {
  const book = bookFor("CRYPTO");

  test("the same seed deals the same tickers, in the same order", () => {
    const a = spinCase(book, 4, 424242);
    const b = spinCase(book, 4, 424242);
    expect(a.syms).toEqual(b.syms);
    expect(a.plans).toEqual(b.plans);
  });

  test("a seeded source is deterministic on its own", () => {
    const r1 = seededRandom(7);
    const r2 = seededRandom(7);
    for (let i = 0; i < 20; i++) expect(r1()).toBe(r2());
  });

  test("fills exactly the leg count, never twice with the same ticker", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = spinCase(book, 4, seed);
      expect(r.syms).toHaveLength(4);
      expect(new Set(r.syms).size).toBe(4);
      expect(r.plans).toHaveLength(4);
    }
  });

  test("only deals from the book it was given", () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const s of spinCase(book, 3, seed).syms) expect(book).toContain(s);
    }
  });

  test("a rejected duplicate is counted and re-spun, not silently dropped", () => {
    let sawRejection = false;
    for (let seed = 1; seed <= 100; seed++) {
      const r = spinCase(["ETH", "BTC"], 2, seed);
      expect(r.syms).toHaveLength(2);
      if (r.rejected > 0) sawRejection = true;
    }
    expect(sawRejection).toBe(true);
  });

  test("different seeds deal different tickers", () => {
    const seen = new Set(Array.from({ length: 50 }, (_, i) => spinCase(book, 4, i + 1).syms.join(",")));
    expect(seen.size).toBeGreaterThan(1);
  });

  test("refuses a book too small for the legs", () => {
    expect(() => spinCase(["ETH", "BTC"], 3, 1)).toThrow(/distinct legs/);
  });
});

describe("lobbies and their books", () => {
  test("each book is the LIVE board filtered by market", () => {
    // The board these filter is `LIVE_BOARD` now, not `UNIVERSE` — plan 6 §B3.
    // There is no equity with a Base price feed, so the STOCK book is empty and
    // the CRYPTO book is the whole board.
    expect(bookFor("STOCK")).toEqual([]);
    expect(bookFor("CRYPTO")).toEqual(LIVE_BOARD.map((u) => u.sym));
    expect(bookFor("MIXED")).toHaveLength(LIVE_BOARD.length);
    expect(bookFor("MIXED")).not.toContain("NVDA");
  });

  test("every lobby can fill its legs from its own sector book, and its id is unique", () => {
    expect(new Set(LOBBIES.map((l) => l.id)).size).toBe(LOBBIES.length);
    for (const l of LOBBIES) {
      // The book is the SECTORS' book now, not the market's — a themed lobby
      // deals from a narrower list than its market label suggests.
      expect(bookOf(l).length).toBeGreaterThanOrEqual(l.legs);
      expect(canPlay(l)).toBe(true);
      expect(l.sectors.length).toBeGreaterThan(0);
      expect(l.legs).toBeGreaterThanOrEqual(2);
      expect(l.legs).toBeLessThanOrEqual(4);
      expect(l.status).toBe("open");
      expect(l.mine).toBe(false);
    }
  });

  test("every lobby's market literal is exactly what its sectors derive", () => {
    // `market` is presentation only (labels, colours, card art, the Battles
    // filter) and is written out on the fixture — this is the guard that it
    // never drifts from the sectors that actually build the book.
    for (const l of LOBBIES) expect(marketOf(l.sectors)).toBe(l.market);
  });

  test("the spin only ever deals names from the lobby's own book", () => {
    for (const l of LOBBIES) {
      const book = bookOf(l);
      for (let seed = 1; seed <= 50; seed++) {
        const dealt = spinCase(book, l.legs, seed).syms;
        expect(dealt).toHaveLength(l.legs);
        for (const sym of dealt) expect(book).toContain(sym);
      }
    }
  });

  test("kz-semis deals the MAJORS book — its dealt tickers are pinned", () => {
    // RE-PINNED at plan 6 §B3. This lock used to read
    // `bookOf(kz) === bookFor("STOCK")` and `["TSLA","AMD","META"]`, which was
    // a true statement about a book that no longer exists: the nine equities
    // were fiction and are offered nowhere. The lock's PURPOSE survives intact
    // — `spinCase` indexes into the book, so narrowing this fixture would still
    // silently re-deal every seeded assertion downstream — and it is restated
    // against the book the lobby actually has.
    const kz = LOBBIES.find((l) => l.id === "kz-semis")!;
    expect(bookOf(kz)).toEqual(["ETH", "BTC", "SOL", "BNB", "AVAX", "XRP"]);
    expect(spinCase(bookOf(kz), kz.legs, 424242).syms).toEqual(["SOL", "XRP", "BNB"]);
  });

  test("on someone else's lobby the host is the opponent; on yours the joiner is", () => {
    const theirs = LOBBIES[0]!;
    expect(opponentOf(theirs)).toBe(theirs.host);
    const mine = { ...theirs, mine: true, opponent: LOBBIES[1]!.host };
    expect(opponentOf(mine)).toBe(LOBBIES[1]!.host);
    expect(opponentOf({ ...mine, opponent: null })).toBeNull();
  });

  test("the entry is half the pool, in points at 1 Ξ = 1,000", () => {
    expect(stakePointsFor(LOBBIES[0]!)).toBe(2400); // 4.80 pool
    expect(stakePointsFor(LOBBIES[5]!)).toBe(10000); // 20.00 pool
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// spinSlice — the reel picks the arena, and provably nothing else
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The frozen capture, as a per-underlying book.
 *
 * Every row here traces to one real resting order in
 * `test/fixtures/orders.json`; nothing is invented and no price is written by
 * hand. Two deliberate simplifications, because this file tests the reel and
 * not the market builder:
 *
 *  - one row per order, where `buildSnapshot` aggregates orders into levels and
 *    attaches only the **best ask** to each. `spinSlice` reads a row's side,
 *    strike, expiry and the presence of an order, so the aggregation upstream
 *    changes how many rows arrive and not what the reel does with them — and
 *    keeping every order gives four expiries with six-deep strike ladders,
 *    which is what exercises the window.
 *  - the feed→symbol map is inlined. `data/qualify.ts` owns the real alias
 *    collapse; duplicating the whole thing here would be testing that instead.
 */
const FIXTURE = (await Bun.file(join(import.meta.dir, "fixtures", "orders.json")).json()) as {
  orders: readonly FillableOrder[];
};

const FEED_SYM: Record<string, string> = {
  "0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70": "ETH",
  "0x64c911996d3c6ac71f9b455b1e8e7266bcbd848f": "BTC",
};

function fixtureBook(): Record<string, PricingRow[]> {
  const out: Record<string, PricingRow[]> = {};
  for (const entry of FIXTURE.orders) {
    const sym = FEED_SYM[String(entry.rawApiData?.priceFeed ?? "").toLowerCase()];
    const strikes = entry.rawApiData?.strikes;
    if (!sym || !strikes || strikes.length !== 1) continue;
    const delta = (entry.rawApiData?.greeks as { delta?: number } | undefined)?.delta;
    (out[sym] ??= []).push({
      type: entry.rawApiData?.isCall ? "CALL" : "PUT",
      strike: (Number(strikes[0]!) / 1e8).toFixed(2),
      expiry: String(entry.order.expiry),
      bid: "0.00",
      ask: (Number(entry.order.price) / 1e8).toFixed(2),
      iv: "0.00",
      delta: delta === undefined ? "—" : delta.toFixed(4),
      depth: 50,
      size: "1",
      order: entry,
    });
  }
  return out;
}

const BOOK: SliceBook = fixtureBook();
/** Only ETH and BTC clear the gate against this capture — see
 *  `test/qualify.test.ts`. The reel is handed exactly that. */
const QUALIFIED: readonly string[] = ["ETH", "BTC"];

/** Every (side, strike, expiry) the book actually lists for an underlying. */
function listed(underlying: string) {
  return (BOOK[underlying] ?? [])
    .filter((r) => r.order?.rawApiData?.strikes?.length === 1)
    .map((r) => ({
      side: r.type,
      strike: BigInt(r.order!.rawApiData!.strikes![0]!),
      expiry: Number(r.order!.order.expiry),
    }));
}

describe("spinSlice — what the reel is allowed to decide", () => {
  test("it deals only from the qualified list its caller passed", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const slice = spinSlice(BOOK, QUALIFIED, seed);
      expect(slice).not.toBeNull();
      expect(QUALIFIED).toContain(slice!.underlying);
    }
  });

  test("an underlying the caller did not qualify is never dealt, even with a book", () => {
    // The engine holds no list of its own. BTC has 14 orders in this capture and
    // is dealt all day — until the caller stops qualifying it, at which point it
    // does not exist as far as the reel is concerned.
    for (let seed = 1; seed <= 200; seed++) {
      expect(spinSlice(BOOK, ["ETH"], seed)!.underlying).toBe("ETH");
    }
  });

  test("a qualified name with no book is skipped rather than dealt and apologised for", () => {
    // SOL qualifies on some days and has zero orders in this capture. Dealing it
    // would be an arena with nothing in it.
    for (let seed = 1; seed <= 200; seed++) {
      expect(spinSlice(BOOK, ["SOL", "ETH"], seed)!.underlying).toBe("ETH");
    }
    expect(spinSlice(BOOK, ["SOL"], 1)).toBeNull();
  });

  test("no qualified name, no book, or no fillable order ⇒ null, never an invented arena", () => {
    expect(spinSlice(BOOK, [], 424242)).toBeNull();
    expect(spinSlice({}, QUALIFIED, 424242)).toBeNull();
    // Rows quoted by market makers alone carry no `order` — nothing to press.
    const displayOnly: SliceBook = {
      ETH: (BOOK.ETH ?? []).map(({ order: _order, ...rest }) => rest),
    };
    expect(spinSlice(displayOnly, ["ETH"], 424242)).toBeNull();
  });

  test("the same seed and the same book deal the identical slice", () => {
    for (let seed = 1; seed <= 400; seed++) {
      expect(spinSlice(BOOK, QUALIFIED, seed)).toEqual(spinSlice(BOOK, QUALIFIED, seed));
    }
  });

  test("it deals a multiplier, a probability, a payout and a chosen strike — never", () => {
    // The structural half of "the game does not set the odds". A slice may only
    // ever carry these five keys; anything that could price a card for a player
    // would have to appear here first, and this fails the moment one does.
    const allowed = new Set(["underlying", "expiry", "strikeLo", "strikeHi", "constraint"]);
    for (let seed = 1; seed <= 400; seed++) {
      for (const key of Object.keys(spinSlice(BOOK, QUALIFIED, seed)!)) {
        expect(allowed).toContain(key);
      }
    }
  });

  test("a window is a range of listed strikes, never one strike chosen for the player", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const s = spinSlice(BOOK, QUALIFIED, seed)!;
      const rows = listed(s.underlying).filter((r) => r.expiry === s.expiry);
      const ladder = [...new Set(rows.map((r) => r.strike))];
      const lo = BigInt(s.strikeLo);
      const hi = BigInt(s.strikeHi);

      // Both edges are strikes the book actually lists, and lo never crosses hi.
      expect(ladder).toContain(lo);
      expect(ladder).toContain(hi);
      expect(lo <= hi).toBe(true);

      // A ladder with more than one rung always yields a window with more than
      // one rung in it. A single-strike window would be the reel picking the
      // player's line, which is the one thing on the "may never" list that a
      // window could smuggle in.
      const inside = ladder.filter((k) => k >= lo && k <= hi);
      if (ladder.length > 1) expect(inside.length).toBeGreaterThan(1);
      if (ladder.length > MIN_WINDOW_STRIKES) {
        expect(inside.length).toBeGreaterThanOrEqual(
          Math.ceil(ladder.length * STRIKE_WINDOW_FRACTION),
        );
      } else {
        expect(inside.length).toBe(ladder.length);
      }
    }
  });

  test("the expiry is one the book lists for the underlying it dealt", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const s = spinSlice(BOOK, QUALIFIED, seed)!;
      expect([...new Set(listed(s.underlying).map((r) => r.expiry))]).toContain(s.expiry);
    }
  });

  test("a directional constraint is only dealt when that side is quoted inside the window", () => {
    // PUTS_ONLY over a window holding no put is a round with no cards in it —
    // the reel deciding the outcome by omission rather than by pricing.
    let sawCalls = 0;
    let sawPuts = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const s = spinSlice(BOOK, QUALIFIED, seed)!;
      if (s.constraint === undefined) continue;
      expect(CONSTRAINTS).toContain(s.constraint);
      const inWindow = listed(s.underlying).filter(
        (r) => r.expiry === s.expiry && r.strike >= BigInt(s.strikeLo) && r.strike <= BigInt(s.strikeHi),
      );
      if (s.constraint === "CALLS_ONLY") {
        sawCalls++;
        expect(inWindow.some((r) => r.side === "CALL")).toBe(true);
      }
      if (s.constraint === "PUTS_ONLY") {
        sawPuts++;
        expect(inWindow.some((r) => r.side === "PUT")).toBe(true);
      }
    }
    expect(sawCalls).toBeGreaterThan(0);
    expect(sawPuts).toBeGreaterThan(0);
  });

  test("most rounds carry no constraint — it reads as an event, not as the weather", () => {
    const n = 2000;
    let plain = 0;
    for (let seed = 1; seed <= n; seed++) {
      if (spinSlice(BOOK, QUALIFIED, seed)!.constraint === undefined) plain++;
    }
    // Loose bounds around NO_CONSTRAINT_ODDS: this guards the branch, not the LCG.
    expect(plain / n).toBeGreaterThan(NO_CONSTRAINT_ODDS - 0.08);
    expect(plain / n).toBeLessThan(NO_CONSTRAINT_ODDS + 0.08);
  });

  test("different seeds deal different arenas", () => {
    const seen = new Set(
      Array.from({ length: 200 }, (_, i) => JSON.stringify(spinSlice(BOOK, QUALIFIED, i + 1))),
    );
    expect(seen.size).toBeGreaterThan(4);
  });

  test("it mutates neither the book nor the qualified list", () => {
    const before = JSON.stringify(BOOK, (_k, v) => (typeof v === "bigint" ? String(v) : v));
    const list = [...QUALIFIED];
    spinSlice(BOOK, list, 424242);
    expect(list).toEqual([...QUALIFIED]);
    expect(JSON.stringify(BOOK, (_k, v) => (typeof v === "bigint" ? String(v) : v))).toBe(before);
  });
});

describe("tiers", () => {
  test("tierFor picks the highest threshold at or below the XP", () => {
    expect(tierFor(0).name).toBe("MINNOW");
    expect(tierFor(499).name).toBe("MINNOW");
    expect(tierFor(500).name).toBe("FISH");
    expect(tierFor(2340).name).toBe("SHARK");
    expect(tierFor(99999).name).toBe("WHALE");
  });

  test("nextTier is null at the top", () => {
    expect(nextTier(2340)?.name).toBe("ORCA");
    expect(nextTier(6000)).toBeNull();
  });
});
