import { describe, expect, test } from "bun:test";
import { LOBBIES, bookFor, bookOf, canPlay, opponentOf, stakePointsFor } from "../src/data/lobbies.ts";
import { marketOf } from "../src/data/sectors.ts";
import { nextTier, tierFor } from "../src/data/rewards.ts";
import { UNIVERSE } from "../src/data/universe.ts";
import { STRIP_LEN, planSpin, seededRandom, spinCase } from "../src/engine/spin.ts";

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
  test("each book is the board filtered by market", () => {
    expect(bookFor("STOCK")).toEqual(UNIVERSE.filter((u) => u.mkt === "STOCK").map((u) => u.sym));
    expect(bookFor("CRYPTO")).toEqual(UNIVERSE.filter((u) => u.mkt === "CRYPTO").map((u) => u.sym));
    expect(bookFor("MIXED")).toHaveLength(UNIVERSE.length);
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

  test("kz-semis keeps the full stock book — its dealt tickers are pinned", () => {
    // test/app.test.tsx and test/determinism.test.ts derive kz-semis' expected
    // tickers from `bookFor("STOCK")` at seed 424242, and `spinCase` indexes
    // into the book, so narrowing this fixture would silently re-deal them.
    const kz = LOBBIES.find((l) => l.id === "kz-semis")!;
    expect(bookOf(kz)).toEqual([...bookFor("STOCK")]);
    expect(spinCase(bookOf(kz), kz.legs, 424242).syms).toEqual(["TSLA", "AMD", "META"]);
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
