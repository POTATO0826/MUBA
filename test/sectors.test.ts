import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LOBBIES, bookOf, canPlay } from "../src/data/lobbies.ts";
import type { Grade, QualifiedAsset } from "../src/data/qualify.ts";
import type { LobbyForm } from "../src/state/match.ts";
import { LobbyCard } from "../src/ui/LobbyCards.tsx";
import { CreateLobby } from "../src/views/CreateLobby.tsx";
import {
  MARKET_COLOR,
  NO_BOOK_REASON,
  PRESETS,
  SECTORS,
  SECTOR_ORDER,
  bookFor,
  bookForSectors,
  liveBookForSectors,
  liveSectorStatus,
  marketOf,
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

/**
 * The nine equities and the five crypto names that only ever existed on
 * `data/universe.ts`'s replay fixture. **None of these may appear in any book,
 * any group, any preset or any lobby.** That is plan 6 §B3's whole demand and
 * the owner's complaint in one list — they were on screen, and Thetanuts has
 * never had a market for one of them.
 */
const FICTION = UNIVERSE.map((u) => u.sym).filter((s) => !LIVE_SYMS.includes(s));

describe("the fiction is gone from every offered surface", () => {
  test("the eighteen-row fixture still exists, and nothing offers it", () => {
    // The rows are still there — `engine/tape.ts` walks them offline and
    // `server/news.ts` derives its symbol allowlist from them, and every price
    // lock in `test/spot.test.ts` still holds. What changed is that no group,
    // no preset and no lobby can reach one.
    expect(UNIVERSE).toHaveLength(18);
    expect(FICTION).toEqual([
      "NVDA",
      "AAPL",
      "TSLA",
      "XOM",
      "JPM",
      "AMD",
      "META",
      "GLD",
      "COIN",
      "ARB",
      "LINK",
      "UNI",
      "AAVE",
      "PEPE",
    ]);
  });

  test("no subset of the groups can deal one of them", () => {
    for (let mask = 0; mask < 1 << ALL.length; mask++) {
      const keys = ALL.filter((_, i) => mask & (1 << i));
      for (const sym of bookForSectors(keys)) expect(FICTION).not.toContain(sym);
    }
  });

  test("no market book and no preset can deal one of them", () => {
    for (const m of ["STOCK", "CRYPTO", "MIXED"] as const) {
      for (const sym of bookFor(m)) expect(FICTION).not.toContain(sym);
      for (const sym of bookForSectors(PRESETS[m])) expect(FICTION).not.toContain(sym);
    }
  });

  test("no published lobby deals one of them, and every lobby can still be played", () => {
    for (const lobby of LOBBIES) {
      for (const sym of bookOf(lobby)) expect(LIVE_SYMS).toContain(sym);
      // A lobby whose book cannot fill its legs is a card nobody can sit on.
      expect(canPlay(lobby)).toBe(true);
    }
  });

  test("there is no equity left to deal at all — the live board is entirely crypto", () => {
    for (const u of LIVE_BOARD) expect(u.mkt).toBe("CRYPTO");
    expect(bookFor("STOCK")).toEqual([]);
    expect(PRESETS.STOCK).toEqual([]);
  });
});

describe("the sector taxonomy partitions the live board", () => {
  test("the groups cover all seven live assets, each exactly once", () => {
    const counts = new Map<string, number>();
    for (const key of ALL) {
      for (const sym of symsOfSector(key)) counts.set(sym, (counts.get(sym) ?? 0) + 1);
    }
    expect(counts.size).toBe(LIVE_BOARD.length);
    for (const u of LIVE_BOARD) expect(counts.get(u.sym)).toBe(1);
  });

  test("group membership is the live board, in live-board order", () => {
    expect([...ALL]).toEqual(["MAJORS", "MEME"]);
    expect(symsOfSector("MAJORS")).toEqual(["ETH", "BTC", "SOL", "BNB", "AVAX", "XRP"]);
    expect(symsOfSector("MEME")).toEqual(["DOGE"]);
  });

  test("the retired equity groups are still SectorKeys and are offered nowhere", () => {
    // `SectorKey` lives in `src/types.ts`, which this change could not edit, so
    // SEMIS / TECH / MACRO / DEFI survive as keys. They are absent from
    // SECTOR_ORDER and hold no members, which is what makes them unreachable —
    // not a filter somewhere that could be forgotten.
    for (const dead of ["SEMIS", "TECH", "MACRO", "DEFI"] as const) {
      expect(ALL).not.toContain(dead);
      expect(SECTORS[dead].members).toEqual([]);
      expect(symsOfSector(dead)).toEqual([]);
      expect(bookForSectors([dead])).toEqual([]);
    }
  });

  test("SECTORS is keyed consistently and SECTOR_ORDER lists every offered group once", () => {
    expect(new Set(ALL).size).toBe(ALL.length);
    for (const key of Object.keys(SECTORS) as SectorKey[]) expect(SECTORS[key].key).toBe(key);
    for (const key of ALL) expect(SECTORS[key].members.length).toBeGreaterThan(0);
  });
});

describe("sectorOf", () => {
  test("is total over every raw sector on the live board", () => {
    for (const u of LIVE_BOARD) {
      const key = sectorOf(u.sector);
      expect(ALL).toContain(key);
      expect(SECTORS[key].members).toContain(u.sector);
      expect(symsOfSector(key)).toContain(u.sym);
    }
  });

  test("every declared member is a raw sector that actually exists on the board", () => {
    const raw = new Set(LIVE_BOARD.map((u) => u.sector));
    for (const key of ALL) for (const m of SECTORS[key].members) expect(raw.has(m)).toBe(true);
    expect(ALL.flatMap((k) => [...SECTORS[k].members])).toHaveLength(raw.size);
  });

  test("an unknown raw sector still resolves, so a stored ledger row can be tallied", () => {
    // `state/rank.ts` replays `SettledRecord.sectors`, which may hold a raw
    // string written before this change. A total function is what keeps those
    // tallies summing to the match count.
    expect(ALL).toContain(sectorOf("SEMIS"));
    expect(ALL).toContain(sectorOf(""));
  });
});

describe("bookForSectors", () => {
  test("is order-independent — it filters the board, never the keys", () => {
    expect(bookForSectors(["MEME", "MAJORS"])).toEqual(bookForSectors(["MAJORS", "MEME"]));
    expect(bookForSectors(["MEME", "MAJORS"])).toEqual([
      "ETH",
      "BTC",
      "SOL",
      "BNB",
      "AVAX",
      "DOGE",
      "XRP",
    ]);
  });

  test("returns the board in canonical order for every subset", () => {
    const index = new Map(LIVE_BOARD.map((u, i) => [u.sym, i]));
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
    expect(bookForSectors(["MAJORS", "MAJORS", "MEME"])).toEqual(
      bookForSectors(["MAJORS", "MEME"]),
    );
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
    expect(bookFor("STOCK")).toEqual(LIVE_BOARD.filter((u) => u.mkt === "STOCK").map((u) => u.sym));
    expect(bookFor("CRYPTO")).toEqual(LIVE_BOARD.map((u) => u.sym));
    expect(bookFor("MIXED")).toEqual(LIVE_BOARD.map((u) => u.sym));
  });

  test("the crypto preset is the whole board, and the stock preset is empty", () => {
    // Not a coincidence to be tidied away: there is no equity with a Base price
    // feed, so `STOCK` is the honest empty set rather than a group of ghosts.
    expect(PRESETS.CRYPTO).toEqual(ALL);
    expect(PRESETS.MIXED).toEqual(ALL);
    expect(PRESETS.STOCK).toEqual([]);
  });
});

describe("marketOf", () => {
  test("every non-empty selection derives CRYPTO, because every asset is crypto", () => {
    expect(marketOf(["MAJORS"])).toBe("CRYPTO");
    expect(marketOf(["MEME"])).toBe("CRYPTO");
    expect(marketOf(ALL)).toBe("CRYPTO");
  });

  test("agrees with the dealt book's own assets for every non-empty subset", () => {
    const mktOf = new Map(LIVE_BOARD.map((u) => [u.sym, u.mkt]));
    for (let mask = 1; mask < 1 << ALL.length; mask++) {
      const keys = ALL.filter((_, i) => mask & (1 << i));
      const mkts = new Set(bookForSectors(keys).map((s) => mktOf.get(s)!));
      const expected = mkts.size === 1 ? [...mkts][0]! : "MIXED";
      expect(marketOf(keys)).toBe(expected);
    }
  });

  test("is order-independent", () => {
    expect(marketOf(["MAJORS", "MEME"])).toBe(marketOf(["MEME", "MAJORS"]));
  });
});

describe("sectorChips", () => {
  test("chips come in canonical order with the group's own colour", () => {
    expect(sectorChips(["MEME", "MAJORS"])).toEqual([
      { key: "MAJORS", label: "MAJORS", color: SECTORS.MAJORS.color },
      { key: "MEME", label: "MEME", color: SECTORS.MEME.color },
    ]);
  });

  test("there is no collapsed preset chip any more", () => {
    // `ALL STOCKS` and `FULL BOARD` were labels for a board that no longer
    // exists. The full selection now spells itself out rather than hiding
    // behind a market word.
    const chips = sectorChips(PRESETS.MIXED);
    expect(chips.map((c) => c.label)).toEqual(["MAJORS", "MEME"]);
    expect(chips.some((c) => c.color === MARKET_COLOR.MIXED)).toBe(false);
  });

  test("truncates at max and appends a dim +N overflow chip", () => {
    expect(sectorChips(["MAJORS", "MEME"], 1)).toEqual([
      { key: "MAJORS", label: "MAJORS", color: SECTORS.MAJORS.color },
      { key: "+1", label: "+1", color: C.dim },
    ]);
  });

  test("no overflow chip when the selection fits", () => {
    const chips = sectorChips(["MAJORS", "MEME"], 2);
    expect(chips).toHaveLength(2);
    expect(chips.some((c) => c.label.startsWith("+"))).toBe(false);
  });

  test("a retired key contributes no chip", () => {
    expect(sectorChips(["SEMIS", "MACRO"])).toEqual([]);
  });

  test("an empty selection yields no chips", () => {
    expect(sectorChips([])).toEqual([]);
  });
});

describe("the spin only ever deals from the selected sectors", () => {
  const cases: readonly (readonly SectorKey[])[] = [["MAJORS"], ["MAJORS", "MEME"]];

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
      expect(spinCase(bookForSectors(["MEME", "MAJORS"]), 3, seed)).toEqual(
        spinCase(bookForSectors(["MAJORS", "MEME"]), 3, seed),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The board behind the taxonomy
// ─────────────────────────────────────────────────────────────────────────────

/** Today's gate output, as the caller would compute it. Written by hand here so
 *  a test can say "the day AVAX gets a book" without waiting for one. */
const ALL_LIVE = LIVE_SYMS;
const MAJORS_ONLY = ["ETH", "BTC"];

describe("the live board is the candidate list, never the qualified list", () => {
  test("it holds the seven Base assets with a readable market price — PAXG is not one", () => {
    expect([...LIVE_SYMS]).toEqual(["ETH", "BTC", "SOL", "BNB", "AVAX", "DOGE", "XRP"]);
    // PAXG has a Chainlink feed on Base and no market price, so it can never
    // clear condition 1 of the gate and has no business on a candidate list.
    expect(LIVE_SYMS).not.toContain("PAXG");
  });

  test("no ticker on it is a stock — the retired fixture does not leak across", () => {
    for (const ghost of ["NVDA", "TSLA", "AAPL", "PEPE", "GLD", "COIN"]) {
      expect(LIVE_SYMS).not.toContain(ghost);
    }
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
    // …and the fixture still wins where the two overlap, because every replay
    // lock in the tree resolves through those rows.
    expect(meta("ETH").sector).toBe("L1");
    expect(meta("ETH").px).toBe(4182.6);
    expect(meta("NVDA").sym).toBe("NVDA");
  });
});

describe("liveBookForSectors — the taxonomy, then the gate", () => {
  test("is order-independent — it filters the board, never the keys", () => {
    expect(liveBookForSectors(["MEME", "MAJORS"], ALL_LIVE)).toEqual(
      liveBookForSectors(["MAJORS", "MEME"], ALL_LIVE),
    );
    expect(liveBookForSectors(ALL, ALL_LIVE)).toEqual([...LIVE_SYMS]);
  });

  test("returns the board in canonical order for every subset", () => {
    const index = new Map(LIVE_BOARD.map((u, i) => [u.sym, i]));
    for (let mask = 0; mask < 1 << ALL.length; mask++) {
      const keys = ALL.filter((_, i) => mask & (1 << i));
      const book = liveBookForSectors(keys, ALL_LIVE);
      const positions = book.map((s) => index.get(s)!);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(new Set(book).size).toBe(book.length);
      expect(book).toHaveLength(keys.reduce((n, k) => n + symsOfSector(k).length, 0));
    }
  });

  test("a duplicated key changes nothing, and an empty selection is an empty book", () => {
    expect(liveBookForSectors(["MEME", "MEME", "MAJORS"], ALL_LIVE)).toEqual(
      liveBookForSectors(["MEME", "MAJORS"], ALL_LIVE),
    );
    expect(liveBookForSectors([], ALL_LIVE)).toEqual([]);
  });

  test("the gate decides membership, and the gate is the caller's argument", () => {
    // The whole point. Nothing in this module knows what is playable today; on a
    // day the book only holds ETH and BTC, MEME is empty — and on the day a
    // maker finally quotes AVAX, it appears with no code change and no list to
    // edit.
    expect(liveBookForSectors(["MEME"], MAJORS_ONLY)).toEqual([]);
    expect(liveBookForSectors(["MAJORS"], MAJORS_ONLY)).toEqual(["ETH", "BTC"]);
    expect(liveBookForSectors(["MAJORS"], ["AVAX"])).toEqual(["AVAX"]);
    expect(liveBookForSectors(ALL, [])).toEqual([]);
  });

  test("a qualified name that is not on the board cannot conjure itself into a group", () => {
    // The gate is a filter over the taxonomy, not a second source of assets.
    expect(liveBookForSectors(ALL, ["PAXG", "NVDA", "ETH"])).toEqual(["ETH"]);
  });
});

describe("a sector with no book is greyed with the reason, never hidden", () => {
  test("every group is always reported, in canonical order, book or no book", () => {
    for (const qualified of [ALL_LIVE, MAJORS_ONLY, []]) {
      const status = liveSectorStatus(qualified);
      expect(status.map((s) => s.key)).toEqual([...ALL]);
    }
  });

  test("on a majors-only day MEME greys out and says why", () => {
    // A host who picks MEME and gets an empty lobby learns nothing. A host who
    // sees MEME greyed, reading "no live book today", has just been told the
    // shape of the market they were about to trade in.
    const status = liveSectorStatus(MAJORS_ONLY);
    const byKey = new Map(status.map((s) => [s.key, s]));

    expect(byKey.get("MAJORS")!.open).toBe(true);
    expect(byKey.get("MAJORS")!.reason).toBeNull();
    expect([...byKey.get("MAJORS")!.playable]).toEqual(["ETH", "BTC"]);

    const meme = byKey.get("MEME")!;
    expect(meme.open).toBe(false);
    expect(meme.reason).toBe(NO_BOOK_REASON);
    expect(meme.playable).toEqual([]);
    // Greyed, not emptied: the group still names what it WOULD deal, which is
    // the difference between "not today" and "never heard of it".
    expect([...meme.members]).toEqual(["DOGE"]);
    expect(meme.label).toBe(SECTORS.MEME.label);
  });

  test("with no book at all every group greys — and none of them disappears", () => {
    const status = liveSectorStatus([]);
    expect(status).toHaveLength(ALL.length);
    for (const s of status) {
      expect(s.open).toBe(false);
      expect(s.reason).toBe(NO_BOOK_REASON);
      expect(s.members.length).toBeGreaterThan(0);
    }
  });

  test("open is exactly 'liveBookForSectors is non-empty' — one rule, stated once", () => {
    for (const qualified of [ALL_LIVE, MAJORS_ONLY, ["AVAX"], ["DOGE", "XRP"], []]) {
      for (const s of liveSectorStatus(qualified)) {
        expect(s.playable).toEqual(liveBookForSectors([s.key], qualified));
        expect(s.open).toBe(s.playable.length > 0);
        expect(s.reason === null).toBe(s.open);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// …and how the builder actually presents it
// ─────────────────────────────────────────────────────────────────────────────
//
// Rendered with `createElement` rather than JSX because this file is a `.ts`.
// It is worth the ceremony: "greyed with the reason, never hidden" and "the
// board offers only what Thetanuts trades" are claims about a screen, and
// asserting them against `liveSectorStatus` alone would only prove the data is
// right about a decision the view is free to ignore.

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
    entryLabel: "0.50 Ξ",
    prizeLabel: "1.00 Ξ",
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

/** Mount the builder, hand the caller a reader, unmount. */
function withBuilder<T>(live: readonly QualifiedAsset[] | undefined, read: (host: HTMLElement) => T): T {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(createElement(CreateLobby, createLobbyProps(live))));
  const out = read(host);
  act(() => root.unmount());
  host.remove();
  return out;
}

/** The one chip row, read off the DOM. */
function liveRow(live?: readonly QualifiedAsset[]) {
  return withBuilder(live, (host) =>
    Array.from(host.querySelectorAll<HTMLElement>("[data-live-sector]")).map((el) => ({
      key: el.dataset.liveSector,
      open: el.dataset.liveOpen,
      pressed: el.getAttribute("aria-pressed"),
      selectable: el.tagName,
      reason: el.querySelector("[data-live-reason]")?.textContent ?? null,
      text: el.textContent ?? "",
    })),
  );
}

/** The gate's answer on the day only ETH and BTC have a book — one DEEP, one
 *  THIN, so both grades are on screen at once. */
const TODAY: readonly QualifiedAsset[] = [
  { underlying: "ETH", grade: "DEEP", spot: 2522.13, orders: 16, greeked: 16, depthUsd: 159969.78 },
  { underlying: "BTC", grade: "THIN", spot: 81004.04, orders: 14, greeked: 9, depthUsd: 140000 },
];

describe("CreateLobby offers the live book and nothing else", () => {
  test("not one fictional ticker or retired group label is anywhere on the screen", () => {
    // The owner's complaint, as an assertion: "i still see stocks that are not
    // in thetanuts at my ui". This fails the moment one comes back.
    const text = withBuilder(TODAY, (host) => host.textContent ?? "");
    for (const sym of FICTION) expect(text).not.toContain(sym);
    for (const gone of ["SEMIS", "BIG TECH", "OLD WORLD", "ALL STOCKS", "FULL BOARD", "STOCKS"]) {
      expect(text).not.toContain(gone);
    }
  });

  test("there is exactly ONE chip row, and it is the selectable one", () => {
    // The screen used to carry two: six seeded chips you could publish from and
    // a read-only live row underneath. A host could pick from the first and get
    // a lobby that could never fill.
    const row = liveRow(TODAY);
    expect(row.map((c) => c.key)).toEqual([...ALL]);
    for (const chip of row) expect(chip.selectable).toBe("BUTTON");
    // …and every `[data-sector]` control on the screen is one of these.
    const sectors = withBuilder(TODAY, (host) =>
      Array.from(host.querySelectorAll<HTMLElement>("[data-sector]")).map(
        (el) => el.dataset.sector,
      ),
    );
    expect(sectors).toEqual([...ALL]);
  });

  test("the chip is pressed exactly when the form holds it", () => {
    const byKey = new Map(liveRow(TODAY).map((c) => [c.key, c]));
    expect(byKey.get("MAJORS")!.pressed).toBe("true"); // FORM.sectors is ["MAJORS"]
    expect(byKey.get("MEME")!.pressed).toBe("false");
  });

  test("a group with no qualified member is greyed AND says why — it is never hidden", () => {
    const byKey = new Map(liveRow(TODAY).map((c) => [c.key, c]));

    expect(byKey.get("MAJORS")!.open).toBe("true");
    expect(byKey.get("MAJORS")!.reason).toBeNull();

    const meme = byKey.get("MEME")!;
    expect(meme.open).toBe("false");
    expect(meme.reason).toContain(NO_BOOK_REASON);
    // Still labelled, and still naming what it would deal. A host who cannot
    // see MEME at all learns nothing about the market; a host who sees it
    // greyed has learned its shape.
    expect(meme.text).toContain(SECTORS.MEME.label);
    expect(meme.text).toContain("DOGE");
  });

  test("the DEEP/THIN grade rides beside each playable name", () => {
    const majors = liveRow(TODAY).find((c) => c.key === "MAJORS")!;
    expect(majors.text).toContain("ETH");
    expect(majors.text).toContain("DEEP");
    expect(majors.text).toContain("BTC");
    expect(majors.text).toContain("THIN");
  });

  test("with no book read at all every group greys — and the builder still works offline", () => {
    // `live` absent is "we did not read a book", and the honest render of that
    // is every group greyed. Greyed is not disabled: the chips stay pressable,
    // because a builder that refused every chip with the market route down
    // would delete the offline game rather than describe the market.
    const row = liveRow(undefined);
    expect(row).toHaveLength(ALL.length);
    for (const chip of row) {
      expect(chip.open).toBe("false");
      expect(chip.reason).toContain(NO_BOOK_REASON);
      expect(chip.selectable).toBe("BUTTON");
    }
  });

  test("the book line names what the spin would deal", () => {
    const line = withBuilder(TODAY, (host) =>
      host.querySelector<HTMLElement>("[data-book]")?.textContent ?? "",
    );
    expect(line).toContain("6 names");
    for (const sym of symsOfSector("MAJORS")) expect(line).toContain(sym);
  });
});

describe("the lobby board shows no fiction either", () => {
  function cardText(lobby = LOBBIES[1]!, grades?: Readonly<Record<string, Grade>>) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() =>
      root.render(createElement(LobbyCard, { lobby, onAccept: NOOP, onStart: NOOP, grades })),
    );
    const body = host.querySelector(".vc-lobby-body")?.textContent ?? "";
    const all = host.textContent ?? "";
    const ids = Array.from(host.querySelectorAll<SVGElement>("[data-chip] defs [id]")).map(
      (n) => n.id,
    );
    act(() => root.unmount());
    host.remove();
    return { body, all, ids };
  }

  test("every card names only live groups, and none wears a SEEDED badge", () => {
    for (const lobby of LOBBIES) {
      const { all } = cardText(lobby);
      for (const gone of [...FICTION, "SEMIS", "BIG TECH", "OLD WORLD", "ALL STOCKS", "SEEDED"]) {
        expect(all).not.toContain(gone);
      }
    }
  });

  test("no grades read ⇒ no grade rendered — absent is not the same as thin", () => {
    const { body } = cardText();
    expect(body).not.toContain("DEEP");
    expect(body).not.toContain("THIN");
  });

  test("a graded book prints the grade on the resting face", () => {
    const { body } = cardText(LOBBIES[1]!, { ETH: "DEEP", BTC: "THIN" });
    expect(body).toContain("BTC THIN");
    expect(body).toContain("ETH DEEP");
  });

  test("each grade chip still mints its own gradient — no two chips share a specular", () => {
    const { ids } = cardText(LOBBIES[1]!, { ETH: "DEEP", BTC: "THIN" });
    expect(new Set(ids).size).toBe(ids.length);
  });
});
