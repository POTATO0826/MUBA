import { describe, expect, test } from "bun:test";
import {
  MARKET_COLOR,
  PRESETS,
  SECTORS,
  SECTOR_ORDER,
  bookFor,
  bookForSectors,
  marketOf,
  presetOf,
  sectorChips,
  sectorOf,
  symsOfSector,
} from "../src/data/sectors.ts";
import { UNIVERSE } from "../src/data/universe.ts";
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
