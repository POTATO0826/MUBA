import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LOBBIES } from "../src/data/lobbies.ts";
import type { Grade, QualifiedAsset } from "../src/data/qualify.ts";
import type { LobbyForm } from "../src/state/match.ts";
import { LobbyCard } from "../src/ui/LobbyCards.tsx";
import { CreateLobby } from "../src/views/CreateLobby.tsx";
import {
  LIVE_SECTORS,
  LIVE_SECTOR_ORDER,
  type LiveSectorKey,
  MARKET_COLOR,
  NO_BOOK_REASON,
  PRESETS,
  SECTORS,
  SECTOR_ORDER,
  bookFor,
  bookForSectors,
  liveBookForSectors,
  liveSectorOf,
  liveSectorStatus,
  liveSymsOfSector,
  marketOf,
  presetOf,
  sectorChips,
  sectorOf,
  symsOfSector,
} from "../src/data/sectors.ts";
import { LIVE_BOARD, LIVE_SYMS, UNIVERSE, meta } from "../src/data/universe.ts";
import { spinCase } from "../src/engine/spin.ts";
import { C } from "../src/theme.ts";
import type { MarketFilter, SectorKey } from "../src/types.ts";

/** Every group, once, in canonical order. */
const ALL = SECTOR_ORDER;

describe("the sector taxonomy partitions the board", () => {
  test("the six groups cover all 18 assets, each exactly once", () => {
    const counts = new Map<string, number>();
    for (const key of ALL) {
      for (const sym of symsOfSector(key)) counts.set(sym, (counts.get(sym) ?? 0) + 1);
    }
    expect(counts.size).toBe(UNIVERSE.length);
    for (const u of UNIVERSE) expect(counts.get(u.sym)).toBe(1);
  });

  test("group membership matches the corrected table", () => {
    expect(symsOfSector("SEMIS")).toEqual(["NVDA", "AMD"]);
    expect(symsOfSector("TECH")).toEqual(["AAPL", "META", "COIN"]);
    expect(symsOfSector("MACRO")).toEqual(["TSLA", "XOM", "JPM", "GLD"]);
    expect(symsOfSector("MAJORS")).toEqual(["BTC", "ETH", "SOL"]);
    expect(symsOfSector("DEFI")).toEqual(["ARB", "LINK", "UNI", "AAVE"]);
    expect(symsOfSector("MEME")).toEqual(["DOGE", "PEPE"]);
  });

  test("the split runs along the STOCK/CRYPTO line — 9 and 9", () => {
    const stockGroups: readonly SectorKey[] = ["SEMIS", "TECH", "MACRO"];
    const cryptoGroups: readonly SectorKey[] = ["MAJORS", "DEFI", "MEME"];
    expect(bookForSectors(stockGroups)).toEqual(
      UNIVERSE.filter((u) => u.mkt === "STOCK").map((u) => u.sym),
    );
    expect(bookForSectors(cryptoGroups)).toEqual(
      UNIVERSE.filter((u) => u.mkt === "CRYPTO").map((u) => u.sym),
    );
    expect(bookForSectors(stockGroups)).toHaveLength(9);
    expect(bookForSectors(cryptoGroups)).toHaveLength(9);
  });

  test("COIN is a stock, so it sits in BIG TECH and never with the MAJORS", () => {
    expect(sectorOf("EQUITY-BETA")).toBe("TECH");
    expect(symsOfSector("MAJORS")).not.toContain("COIN");
    expect(marketOf(["MAJORS"])).toBe("CRYPTO");
  });

  test("SECTORS is keyed consistently and SECTOR_ORDER lists every group once", () => {
    expect(new Set(ALL).size).toBe(ALL.length);
    expect(Object.keys(SECTORS).sort()).toEqual([...ALL].sort());
    for (const key of ALL) expect(SECTORS[key].key).toBe(key);
  });
});

describe("sectorOf", () => {
  test("is total over every raw sector on the board", () => {
    for (const u of UNIVERSE) {
      const key = sectorOf(u.sector);
      expect(ALL).toContain(key);
      expect(SECTORS[key].members).toContain(u.sector);
      expect(symsOfSector(key)).toContain(u.sym);
    }
  });

  test("every declared member is a raw sector that actually exists", () => {
    const raw = new Set(UNIVERSE.map((u) => u.sector));
    for (const key of ALL) for (const m of SECTORS[key].members) expect(raw.has(m)).toBe(true);
    expect(ALL.flatMap((k) => [...SECTORS[k].members])).toHaveLength(raw.size);
  });
});

describe("bookForSectors", () => {
  test("is order-independent — it filters the board, never the keys", () => {
    expect(bookForSectors(["MEME", "TECH"])).toEqual(bookForSectors(["TECH", "MEME"]));
    expect(bookForSectors(["MEME", "TECH"])).toEqual(["AAPL", "META", "COIN", "DOGE", "PEPE"]);
    const shuffled: readonly SectorKey[] = ["MEME", "MACRO", "DEFI", "SEMIS", "MAJORS", "TECH"];
    expect(bookForSectors(shuffled)).toEqual(bookForSectors(ALL));
  });

  test("returns the board in canonical order for every one of the 64 subsets", () => {
    const index = new Map(UNIVERSE.map((u, i) => [u.sym, i]));
    for (let mask = 0; mask < 1 << ALL.length; mask++) {
      const keys = ALL.filter((_, i) => mask & (1 << i));
      const book = bookForSectors(keys);
      const positions = book.map((s) => index.get(s)!);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(new Set(book).size).toBe(book.length);
      expect(book).toHaveLength(keys.reduce((n, k) => n + symsOfSector(k).length, 0));
    }
  });

  test("a duplicated key changes nothing", () => {
    expect(bookForSectors(["SEMIS", "SEMIS", "MEME"])).toEqual(bookForSectors(["SEMIS", "MEME"]));
  });

  test("an empty selection is an empty book", () => {
    expect(bookForSectors([])).toEqual([]);
  });
});

describe("presets are exactly the market books", () => {
  const markets: readonly MarketFilter[] = ["STOCK", "CRYPTO", "MIXED"];

  test("bookForSectors(PRESETS[m]) deep-equals bookFor(m)", () => {
    for (const m of markets) expect(bookForSectors(PRESETS[m])).toEqual([...bookFor(m)]);
  });

  test("bookFor still filters the board by market, in board order", () => {
    expect(bookFor("STOCK")).toEqual(UNIVERSE.filter((u) => u.mkt === "STOCK").map((u) => u.sym));
    expect(bookFor("CRYPTO")).toEqual(UNIVERSE.filter((u) => u.mkt === "CRYPTO").map((u) => u.sym));
    expect(bookFor("MIXED")).toEqual(UNIVERSE.map((u) => u.sym));
  });

  test("each preset derives its own market back", () => {
    for (const m of markets) expect(marketOf(PRESETS[m])).toBe(m);
  });

  test("the stock and crypto presets are disjoint and together are MIXED", () => {
    const stock = new Set(PRESETS.STOCK);
    for (const k of PRESETS.CRYPTO) expect(stock.has(k)).toBe(false);
    expect([...PRESETS.STOCK, ...PRESETS.CRYPTO].sort()).toEqual([...PRESETS.MIXED].sort());
  });
});

describe("marketOf", () => {
  test("classifies all-stock, all-crypto and mixed selections", () => {
    expect(marketOf(["SEMIS"])).toBe("STOCK");
    expect(marketOf(["SEMIS", "TECH"])).toBe("STOCK");
    expect(marketOf(["MACRO"])).toBe("STOCK");
    expect(marketOf(["MAJORS"])).toBe("CRYPTO");
    expect(marketOf(["MEME", "DEFI"])).toBe("CRYPTO");
    expect(marketOf(["SEMIS", "MAJORS"])).toBe("MIXED");
    expect(marketOf(["MACRO", "DEFI"])).toBe("MIXED");
    expect(marketOf(ALL)).toBe("MIXED");
  });

  test("agrees with the dealt book's own assets for every non-empty subset", () => {
    const mktOf = new Map(UNIVERSE.map((u) => [u.sym, u.mkt]));
    for (let mask = 1; mask < 1 << ALL.length; mask++) {
      const keys = ALL.filter((_, i) => mask & (1 << i));
      const mkts = new Set(bookForSectors(keys).map((s) => mktOf.get(s)!));
      const expected = mkts.size === 1 ? [...mkts][0]! : "MIXED";
      expect(marketOf(keys)).toBe(expected);
    }
  });

  test("is order-independent", () => {
    expect(marketOf(["MAJORS", "SEMIS"])).toBe(marketOf(["SEMIS", "MAJORS"]));
  });
});

describe("presetOf", () => {
  test("hits on a preset whatever order it was built in", () => {
    expect(presetOf(["SEMIS", "TECH", "MACRO"])).toBe("STOCK");
    expect(presetOf(["MACRO", "SEMIS", "TECH"])).toBe("STOCK");
    expect(presetOf(["MEME", "MAJORS", "DEFI"])).toBe("CRYPTO");
    expect(presetOf(ALL)).toBe("MIXED");
    expect(presetOf([...ALL].reverse())).toBe("MIXED");
  });

  test("misses on any hand-rolled combination", () => {
    expect(presetOf([])).toBeNull();
    expect(presetOf(["SEMIS"])).toBeNull();
    expect(presetOf(["SEMIS", "TECH"])).toBeNull();
    expect(presetOf(["SEMIS", "MAJORS"])).toBeNull();
    expect(presetOf(["SEMIS", "TECH", "MEME"])).toBeNull();
    expect(presetOf(["SEMIS", "TECH", "MACRO", "MEME"])).toBeNull();
  });

  test("a selection one group short of a preset is not a preset", () => {
    expect(presetOf(["MAJORS", "DEFI"])).toBeNull();
    expect(presetOf(ALL.filter((k) => k !== "MEME"))).toBeNull();
  });
});

describe("sectorChips", () => {
  test("a preset collapses to one chip in its market colour", () => {
    expect(sectorChips(PRESETS.STOCK)).toEqual([
      { key: "STOCK", label: "ALL STOCKS", color: MARKET_COLOR.STOCK },
    ]);
    expect(sectorChips(PRESETS.CRYPTO)).toEqual([
      { key: "CRYPTO", label: "ALL CRYPTO", color: MARKET_COLOR.CRYPTO },
    ]);
    expect(sectorChips(PRESETS.MIXED)).toEqual([
      { key: "MIXED", label: "FULL BOARD", color: MARKET_COLOR.MIXED },
    ]);
  });

  test("a preset stays collapsed even under a tight max", () => {
    expect(sectorChips(PRESETS.CRYPTO, 1)).toHaveLength(1);
    expect(sectorChips(PRESETS.MIXED, 2)[0]!.label).toBe("FULL BOARD");
  });

  test("otherwise chips come in canonical order with the group's own colour", () => {
    expect(sectorChips(["MEME", "SEMIS"])).toEqual([
      { key: "SEMIS", label: "SEMIS", color: SECTORS.SEMIS.color },
      { key: "MEME", label: "MEME", color: SECTORS.MEME.color },
    ]);
    expect(sectorChips(["DEFI", "TECH"]).map((c) => c.key)).toEqual(["TECH", "DEFI"]);
  });

  test("truncates at max and appends a dim +N overflow chip", () => {
    expect(sectorChips(["SEMIS", "TECH", "MACRO", "MEME"], 2)).toEqual([
      { key: "SEMIS", label: "SEMIS", color: SECTORS.SEMIS.color },
      { key: "TECH", label: "BIG TECH", color: SECTORS.TECH.color },
      { key: "+2", label: "+2", color: C.dim },
    ]);
  });

  test("no overflow chip when the selection fits", () => {
    const chips = sectorChips(["SEMIS", "TECH"], 2);
    expect(chips).toHaveLength(2);
    expect(chips.some((c) => c.label.startsWith("+"))).toBe(false);
  });

  test("the default max is 6, so nothing overflows unless asked", () => {
    const fiveOfSix = ALL.filter((k) => k !== "MEME");
    expect(sectorChips(fiveOfSix)).toHaveLength(5);
    expect(sectorChips(fiveOfSix, 6)).toEqual(sectorChips(fiveOfSix));
  });

  test("an empty selection yields no chips", () => {
    expect(sectorChips([])).toEqual([]);
  });
});

describe("the spin only ever deals from the selected sectors", () => {
  const cases: readonly (readonly SectorKey[])[] = [
    ["SEMIS", "TECH"],
    ["MAJORS"],
    ["SEMIS", "MAJORS"],
    ["MEME", "DEFI"],
    ["MACRO"],
    ["MACRO", "DEFI"],
  ];

  test("300 seeds, every selection: dealt tickers are a subset of the union", () => {
    for (const keys of cases) {
      const book = bookForSectors(keys);
      const union = new Set(keys.flatMap((k) => [...symsOfSector(k)]));
      const legs = Math.min(book.length, 3);
      for (let seed = 1; seed <= 300; seed++) {
        for (const s of spinCase(book, legs, seed).syms) expect(union.has(s)).toBe(true);
      }
    }
  });

  test("a permuted selection plans the identical case", () => {
    for (let seed = 1; seed <= 300; seed++) {
      expect(spinCase(bookForSectors(["MEME", "DEFI"]), 3, seed)).toEqual(
        spinCase(bookForSectors(["DEFI", "MEME"]), 3, seed),
      );
    }
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// The LIVE sectors â€” the same idea, applied to a list that exists
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Today's gate output, as the caller would compute it. Written by hand here so
 *  a test can say "the day AVAX gets a book" without waiting for one. */
const ALL_LIVE = LIVE_SYMS;
const MAJORS_ONLY = ["ETH", "BTC"];

describe("the live board is the candidate list, never the qualified list", () => {
  test("it holds the seven Base assets with a readable market price â€” PAXG is not one", () => {
    expect([...LIVE_SYMS]).toEqual(["ETH", "BTC", "SOL", "BNB", "AVAX", "DOGE", "XRP"]);
    // PAXG has a Chainlink feed on Base and no market price, so it can never
    // clear condition 1 of the gate and has no business on a candidate list.
    expect(LIVE_SYMS).not.toContain("PAXG");
  });

  test("no ticker on it is a stock â€” the seeded board's fiction does not leak across", () => {
    for (const u of LIVE_BOARD) expect(u.mkt).toBe("CRYPTO");
    for (const ghost of ["NVDA", "TSLA", "AAPL", "PEPE", "GLD", "COIN"]) {
      expect(LIVE_SYMS).not.toContain(ghost);
    }
  });

  test("every live group is a taxonomy fact, and every member is on the board", () => {
    for (const key of LIVE_SECTOR_ORDER) {
      const syms = liveSymsOfSector(key);
      expect(syms.length).toBeGreaterThan(0);
      for (const sym of syms) expect(LIVE_SYMS).toContain(sym);
    }
    expect([...liveSymsOfSector("MAJORS")]).toEqual(["ETH", "BTC"]);
    expect([...liveSymsOfSector("L1S")]).toEqual(["SOL", "BNB", "AVAX"]);
    expect([...liveSymsOfSector("MEME")]).toEqual(["DOGE"]);
    expect([...liveSymsOfSector("PAYMENTS")]).toEqual(["XRP"]);
  });

  test("the four groups partition the live board, each asset exactly once", () => {
    const counts = new Map<string, number>();
    for (const key of LIVE_SECTOR_ORDER) {
      for (const sym of liveSymsOfSector(key)) counts.set(sym, (counts.get(sym) ?? 0) + 1);
    }
    expect(counts.size).toBe(LIVE_BOARD.length);
    for (const u of LIVE_BOARD) expect(counts.get(u.sym)).toBe(1);
  });

  test("liveSectorOf has no catch-all â€” a seeded raw sector is not a live group", () => {
    // `sectorOf` buckets the unknown into MACRO on purpose. This one must not:
    // bucketing SEMIS into a crypto group would put Nvidia in the live book
    // rather than saying, correctly, that it is not there.
    expect(liveSectorOf("MAJORS")).toBe("MAJORS");
    expect(liveSectorOf("L1S")).toBe("L1S");
    expect(liveSectorOf("SEMIS")).toBeNull();
    expect(liveSectorOf("L1")).toBeNull();
    expect(liveSectorOf("")).toBeNull();
  });

  test("every live name resolves to a seeded reference price, so an offline round renders", () => {
    // The seeded tape needs an opening print for whatever the reel dealt. Before
    // the live board existed, `meta("AVAX")` fell back to the first asset and an
    // AVAX arena silently opened at Nvidia's $118.40.
    for (const sym of LIVE_SYMS) {
      const asset = meta(sym);
      expect(asset.sym).toBe(sym);
      expect(asset.px).toBeGreaterThan(0);
      expect(asset.t).toBeGreaterThan(0);
      expect(asset.vol).toBeGreaterThan(0);
    }
    // â€¦and the seeded board still wins where the two overlap, because every
    // replay lock in the tree resolves through those rows.
    expect(meta("ETH").sector).toBe("L1");
    expect(meta("ETH").px).toBe(4182.6);
    expect(meta("NVDA").sym).toBe("NVDA");
  });
});

describe("liveBookForSectors â€” the taxonomy, then the gate", () => {
  test("is order-independent â€” it filters the board, never the keys", () => {
    expect(liveBookForSectors(["MEME", "L1S"], ALL_LIVE)).toEqual(
      liveBookForSectors(["L1S", "MEME"], ALL_LIVE),
    );
    expect(liveBookForSectors(["MEME", "L1S"], ALL_LIVE)).toEqual(["SOL", "BNB", "AVAX", "DOGE"]);
    const shuffled: readonly LiveSectorKey[] = ["PAYMENTS", "MEME", "MAJORS", "L1S"];
    expect(liveBookForSectors(shuffled, ALL_LIVE)).toEqual(
      liveBookForSectors(LIVE_SECTOR_ORDER, ALL_LIVE),
    );
  });

  test("returns the board in canonical order for every one of the 16 subsets", () => {
    const index = new Map(LIVE_BOARD.map((u, i) => [u.sym, i]));
    for (let mask = 0; mask < 1 << LIVE_SECTOR_ORDER.length; mask++) {
      const keys = LIVE_SECTOR_ORDER.filter((_, i) => mask & (1 << i));
      const book = liveBookForSectors(keys, ALL_LIVE);
      const positions = book.map((s) => index.get(s)!);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(new Set(book).size).toBe(book.length);
      expect(book).toHaveLength(keys.reduce((n, k) => n + liveSymsOfSector(k).length, 0));
    }
  });

  test("a duplicated key changes nothing, and an empty selection is an empty book", () => {
    expect(liveBookForSectors(["L1S", "L1S", "MEME"], ALL_LIVE)).toEqual(
      liveBookForSectors(["L1S", "MEME"], ALL_LIVE),
    );
    expect(liveBookForSectors([], ALL_LIVE)).toEqual([]);
  });

  test("the gate decides membership, and the gate is the caller's argument", () => {
    // The whole point. Nothing in this module knows what is playable today; on a
    // day the book only holds ETH and BTC, L1S is empty â€” and on the day a maker
    // finally quotes AVAX, it appears with no code change and no list to edit.
    expect(liveBookForSectors(["L1S"], MAJORS_ONLY)).toEqual([]);
    expect(liveBookForSectors(["MAJORS"], MAJORS_ONLY)).toEqual(["ETH", "BTC"]);
    expect(liveBookForSectors(["L1S"], ["AVAX"])).toEqual(["AVAX"]);
    expect(liveBookForSectors(LIVE_SECTOR_ORDER, [])).toEqual([]);
  });

  test("a qualified name that is not on the board cannot conjure itself into a group", () => {
    // The gate is a filter over the taxonomy, not a second source of assets.
    expect(liveBookForSectors(LIVE_SECTOR_ORDER, ["PAXG", "NVDA", "ETH"])).toEqual(["ETH"]);
  });
});

describe("a sector with no book is greyed with the reason, never hidden", () => {
  test("every group is always reported, in canonical order, book or no book", () => {
    for (const qualified of [ALL_LIVE, MAJORS_ONLY, []]) {
      const status = liveSectorStatus(qualified);
      expect(status.map((s) => s.key)).toEqual([...LIVE_SECTOR_ORDER]);
    }
  });

  test("on a majors-only day the other three grey out and say why", () => {
    // A host who picks MEME and gets an empty lobby learns nothing. A host who
    // sees MEME greyed, reading "no live book today", has just been told the
    // shape of the market they were about to trade in.
    const status = liveSectorStatus(MAJORS_ONLY);
    const byKey = new Map(status.map((s) => [s.key, s]));

    expect(byKey.get("MAJORS")!.open).toBe(true);
    expect(byKey.get("MAJORS")!.reason).toBeNull();
    expect([...byKey.get("MAJORS")!.playable]).toEqual(["ETH", "BTC"]);

    for (const key of ["L1S", "MEME", "PAYMENTS"] as const) {
      const s = byKey.get(key)!;
      expect(s.open).toBe(false);
      expect(s.reason).toBe(NO_BOOK_REASON);
      expect(s.playable).toEqual([]);
      // Greyed, not emptied: the group still names what it WOULD deal, which is
      // the difference between "not today" and "never heard of it".
      expect(s.members.length).toBeGreaterThan(0);
      expect(s.label).toBe(LIVE_SECTORS[key].label);
    }
  });

  test("with no book at all every group greys â€” and none of them disappears", () => {
    const status = liveSectorStatus([]);
    expect(status).toHaveLength(LIVE_SECTOR_ORDER.length);
    for (const s of status) {
      expect(s.open).toBe(false);
      expect(s.reason).toBe(NO_BOOK_REASON);
    }
  });

  test("open is exactly 'liveBookForSectors is non-empty' â€” one rule, stated once", () => {
    for (const qualified of [ALL_LIVE, MAJORS_ONLY, ["AVAX"], ["DOGE", "XRP"], []]) {
      for (const s of liveSectorStatus(qualified)) {
        expect(s.playable).toEqual(liveBookForSectors([s.key], qualified));
        expect(s.open).toBe(s.playable.length > 0);
        expect(s.reason === null).toBe(s.open);
      }
    }
  });
});

describe("the two taxonomies do not bleed into each other", () => {
  test("the seeded groups are untouched by the live ones", () => {
    // Both name a group MEME and they mean different lists, which is fine as
    // long as neither function can be handed the other's key by accident â€” the
    // types are separate and so are the boards.
    expect([...symsOfSector("MEME")]).toEqual(["DOGE", "PEPE"]);
    expect([...liveSymsOfSector("MEME")]).toEqual(["DOGE"]);
    expect([...symsOfSector("MAJORS")]).toEqual(["BTC", "ETH", "SOL"]);
    expect([...liveSymsOfSector("MAJORS")]).toEqual(["ETH", "BTC"]);
  });

  test("the seeded board still deals exactly what it dealt", () => {
    expect(bookFor("STOCK")).toEqual(UNIVERSE.filter((u) => u.mkt === "STOCK").map((u) => u.sym));
    expect(bookForSectors(["SEMIS", "TECH", "MACRO"])).toEqual([...bookFor("STOCK")]);
  });
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â€¦and how the greyed sector actually presents
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Rendered with `createElement` rather than JSX because this file is a `.ts`.
// It is worth the ceremony: "greyed with the reason, never hidden" is a claim
// about a screen, and asserting it against `liveSectorStatus` alone would only
// prove the data is right about a decision the view is free to ignore.

const FORM: LobbyForm = {
  name: "Live book",
  sectors: ["MAJORS"],
  market: "CRYPTO",
  mode: "NORMAL",
  legs: 2,
  prize: 1,
  prizeText: "1.00",
};

const NOOP = () => {};

function createLobbyProps(live?: readonly QualifiedAsset[]) {
  return {
    form: FORM,
    entryLabel: "0.50 Îž",
    prizeLabel: "1.00 Îž",
    onName: NOOP,
    onMarket: NOOP,
    onToggleSector: NOOP,
    onMode: NOOP,
    onLegsUp: NOOP,
    onLegsDown: NOOP,
    onPrizeInput: NOOP,
    onPrizeBlur: NOOP,
    onPrizeUp: NOOP,
    onPrizeDown: NOOP,
    onPublish: NOOP,
    onBack: NOOP,
    live,
  };
}

/** Mount the builder, read the live row, unmount. */
function liveRow(live?: readonly QualifiedAsset[]) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(CreateLobby, createLobbyProps(live))));
  const chips = Array.from(host.querySelectorAll<HTMLElement>("[data-live-sector]"));
  const read = chips.map((el) => ({
    key: el.dataset.liveSector,
    open: el.dataset.liveOpen,
    reason: el.querySelector("[data-live-reason]")?.textContent ?? null,
    text: el.textContent ?? "",
  }));
  act(() => root.unmount());
  host.remove();
  return read;
}

/** The gate's answer on the day only ETH and BTC have a book â€” one DEEP, one
 *  THIN, so both grades are on screen at once. */
const TODAY: readonly QualifiedAsset[] = [
  { underlying: "ETH", grade: "DEEP", spot: 2522.13, orders: 16, greeked: 16, depthUsd: 159969.78 },
  { underlying: "BTC", grade: "THIN", spot: 81004.04, orders: 14, greeked: 9, depthUsd: 140000 },
];

describe("CreateLobby renders the live book, greyed sectors included", () => {
  test("all four groups are on screen, in canonical order, whatever the book says", () => {
    for (const live of [TODAY, undefined]) {
      expect(liveRow(live).map((c) => c.key)).toEqual([...LIVE_SECTOR_ORDER]);
    }
  });

  test("a group with no qualified member is greyed AND says why â€” it is never hidden", () => {
    const row = liveRow(TODAY);
    const byKey = new Map(row.map((c) => [c.key, c]));

    expect(byKey.get("MAJORS")!.open).toBe("true");
    expect(byKey.get("MAJORS")!.reason).toBeNull();

    for (const key of ["L1S", "MEME", "PAYMENTS"]) {
      const chip = byKey.get(key)!;
      expect(chip.open).toBe("false");
      expect(chip.reason).toBe(NO_BOOK_REASON);
      // Still labelled. A host who cannot see MEME at all learns nothing about
      // the market; a host who sees it greyed has learned its shape.
      expect(chip.text).toContain(LIVE_SECTORS[key as LiveSectorKey].label);
    }
  });

  test("the DEEP/THIN grade rides beside each playable name", () => {
    const majors = liveRow(TODAY).find((c) => c.key === "MAJORS")!;
    expect(majors.text).toContain("ETH");
    expect(majors.text).toContain("DEEP");
    expect(majors.text).toContain("BTC");
    expect(majors.text).toContain("THIN");
  });

  test("with no book read at all every group greys â€” the builder still works offline", () => {
    // `live` absent is "we did not read a book", and the honest render of that
    // is four greyed groups. The seeded chips above the row are untouched and
    // still publish a lobby, which is what keeps the game playable unplugged.
    const row = liveRow(undefined);
    expect(row).toHaveLength(LIVE_SECTOR_ORDER.length);
    for (const chip of row) {
      expect(chip.open).toBe("false");
      expect(chip.reason).toBe(NO_BOOK_REASON);
    }
  });
});

describe("the lobby card wears the grade, and only when there is one", () => {
  function cardText(grades?: Readonly<Record<string, Grade>>) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(
        createElement(LobbyCard, { lobby: LOBBIES[1]!, onAccept: NOOP, onStart: NOOP, grades }),
      ),
    );
    const body = host.querySelector(".vc-lobby-body")?.textContent ?? "";
    const ids = Array.from(host.querySelectorAll<SVGElement>("[data-chip] defs [id]")).map(
      (n) => n.id,
    );
    act(() => root.unmount());
    host.remove();
    return { body, ids };
  }

  test("no grades read â‡’ no grade rendered â€” absent is not the same as thin", () => {
    const { body } = cardText();
    expect(body).not.toContain("DEEP");
    expect(body).not.toContain("THIN");
  });

  test("a graded book prints the grade on the resting face", () => {
    const { body } = cardText({ ETH: "DEEP", BTC: "THIN" });
    expect(body).toContain("BTC THIN");
    expect(body).toContain("ETH DEEP");
  });

  test("each grade chip still mints its own gradient â€” no two chips share a specular", () => {
    const { ids } = cardText({ ETH: "DEEP", BTC: "THIN" });
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("the fiction is marked wherever it is still offered", () => {
  // The seeded board cannot be deleted yet â€” `test/spot.test.ts` and
  // `test/app.test.tsx` pin all eighteen rows and the six groups over them, and
  // neither file is this pass's to edit. What CAN be true today is that nobody
  // reads NVDA on this screen and thinks they could buy it, so the marking is
  // derived from the live board and never from a list.

  test("a seeded group naming nothing on chain is struck through and says why", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(createElement(CreateLobby, createLobbyProps(TODAY))));

    const chip = (k: SectorKey) =>
      host.querySelector<HTMLElement>(`[data-sector="${k}"]`)!;

    // Four groups hold no name Thetanuts has a feed for.
    for (const k of ["SEMIS", "TECH", "MACRO", "DEFI"] as const) {
      expect(chip(k).dataset.seededOnly).toBe("true");
      expect(chip(k).style.textDecoration).toContain("line-through");
      expect(chip(k).title).toContain("no market");
    }
    // â€¦and two do: MAJORS holds BTC/ETH/SOL, MEME holds DOGE.
    for (const k of ["MAJORS", "MEME"] as const) {
      expect(chip(k).dataset.seededOnly).toBe("false");
      expect(chip(k).style.textDecoration).not.toContain("line-through");
    }

    // The warning is on the screen, not in a docblock.
    const warning = host.querySelector("[data-seeded-warning]")?.textContent ?? "";
    expect(warning).toContain("seeded replay fixture");
    expect(warning).toContain("can be filled on Base");
    expect(warning).toContain("no market for the equities");

    act(() => root.unmount());
    host.remove();
  });

  test("the marking is computed from the live board, never written down", () => {
    // Every struck-through group is exactly a group with no live name in it. If
    // a maker starts quoting one of these assets and it joins LIVE_BOARD, the
    // strike-through lifts with no edit here and none in the view.
    const onChain = new Set(LIVE_SYMS);
    for (const k of SECTOR_ORDER) {
      const hasLive = symsOfSector(k).some((s) => onChain.has(s));
      expect(hasLive).toBe(k === "MAJORS" || k === "MEME");
    }
  });

  test("a lobby whose whole book is fiction wears a SEEDED badge on the board", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    // kz-semis deals SEMIS + BIG TECH + OLD WORLD â€” nine equities, none of
    // which exists on Base.
    act(() =>
      root.render(
        createElement(LobbyCard, { lobby: LOBBIES[0]!, onAccept: NOOP, onStart: NOOP }),
      ),
    );
    expect(host.querySelector(".vc-lobby-body")?.textContent ?? "").toContain("SEEDED");
    act(() => root.unmount());
    host.remove();

    // mi-majors deals BTC/ETH/SOL, which are real underlyings â€” it is a seeded
    // *price* today, not a fictional asset, so it is not branded as one.
    const host2 = document.createElement("div");
    document.body.appendChild(host2);
    const root2 = createRoot(host2);
    act(() =>
      root2.render(
        createElement(LobbyCard, { lobby: LOBBIES[1]!, onAccept: NOOP, onStart: NOOP }),
      ),
    );
    expect(host2.querySelector(".vc-lobby-body")?.textContent ?? "").not.toContain("SEEDED");
    act(() => root2.unmount());
    host2.remove();
  });
});
