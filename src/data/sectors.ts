import type { MarketFilter, SectorKey } from "../types.ts";
import { C } from "../theme.ts";
import { UNIVERSE } from "./universe.ts";

/** One sector group: a bucket of raw `Asset.sector` values with a label,
 *  a colour and a one-line pitch. `members` are RAW sector strings — the
 *  tickers are always derived from `UNIVERSE`, which stays the single
 *  source of truth for the board and its order. */
export interface SectorDef {
  key: SectorKey;
  label: string;
  /** Raw `Asset.sector` values this group gathers. */
  members: readonly string[];
  color: string;
  blurb: string;
}

/**
 * The six groups over the board's 12 raw sectors.
 *
 * The split is clean along the STOCK/CRYPTO line: SEMIS+TECH+MACRO are the
 * 9 stocks, MAJORS+DEFI+MEME the 9 crypto. `COIN` is `EQUITY-BETA` but
 * `mkt: "STOCK"`, so it belongs to TECH, not MAJORS — putting it with the
 * L1s would make `marketOf(["MAJORS"])` return `"MIXED"`.
 */
export const SECTORS: Record<SectorKey, SectorDef> = {
  SEMIS: {
    key: "SEMIS",
    label: "SEMIS",
    members: ["SEMIS"],
    color: C.green,
    blurb: "The silicon cycle. Two names, both high beta.",
  },
  TECH: {
    key: "TECH",
    label: "BIG TECH",
    members: ["TECH", "EQUITY-BETA"],
    color: C.blue,
    blurb: "Mega-cap platforms plus the listed crypto proxy.",
  },
  MACRO: {
    key: "MACRO",
    label: "OLD WORLD",
    members: ["AUTO", "ENERGY", "FIN", "METALS"],
    color: C.amber,
    blurb: "Autos, energy, banks and gold — the pre-crypto economy. Slow money, tight targets.",
  },
  MAJORS: {
    key: "MAJORS",
    label: "MAJORS",
    members: ["L1"],
    color: C.accent,
    blurb: "Bitcoin, Ethereum, Solana — the layer ones everybody already owns. Crypto's blue chips.",
  },
  DEFI: {
    key: "DEFI",
    label: "DEFI",
    members: ["DEFI", "ORACLE", "L2"],
    color: C.violet,
    blurb: "On-chain money legos, oracles and rollups.",
  },
  MEME: {
    key: "MEME",
    label: "MEME",
    members: ["MEME"],
    color: "#f472b6",
    blurb: "Pure sentiment. Widest targets, wildest tape.",
  },
};

/** Canonical group order — every chip row and book derives from it. */
export const SECTOR_ORDER: readonly SectorKey[] = ["SEMIS", "TECH", "MACRO", "MAJORS", "DEFI", "MEME"];

const RAW_TO_KEY = new Map<string, SectorKey>(
  SECTOR_ORDER.flatMap((k) => SECTORS[k].members.map((raw) => [raw, k] as const)),
);

/** Group for a raw `Asset.sector`. Total over the board; anything unknown
 *  buckets into MACRO, the catch-all group (mirrors `meta()`'s fallback). */
export function sectorOf(rawSector: string): SectorKey {
  return RAW_TO_KEY.get(rawSector) ?? "MACRO";
}

const SYMS_BY_KEY = new Map<SectorKey, readonly string[]>(
  SECTOR_ORDER.map((k) => [k, UNIVERSE.filter((u) => sectorOf(u.sector) === k).map((u) => u.sym)]),
);

/** The group's tickers, in board order. */
export function symsOfSector(key: SectorKey): readonly string[] {
  return SYMS_BY_KEY.get(key) ?? [];
}

/** The tickers a set of groups can deal, in board order.
 *
 *  Filters `UNIVERSE` and never iterates `keys`, so the result is identical
 *  for any permutation of the same groups — the spin's determinism depends
 *  on both the contents AND the order of this array. */
export function bookForSectors(keys: readonly SectorKey[]): readonly string[] {
  const want = new Set(keys);
  return UNIVERSE.filter((u) => want.has(sectorOf(u.sector))).map((u) => u.sym);
}

/** A lobby's market, derived from its groups: all-stock, all-crypto, or mixed.
 *  Computed from the assets' `mkt`, never from the group names. */
export function marketOf(keys: readonly SectorKey[]): MarketFilter {
  const want = new Set(keys);
  const picked = UNIVERSE.filter((u) => want.has(sectorOf(u.sector)));
  const stock = picked.some((u) => u.mkt === "STOCK");
  const crypto = picked.some((u) => u.mkt === "CRYPTO");
  if (stock && !crypto) return "STOCK";
  if (crypto && !stock) return "CRYPTO";
  return "MIXED";
}

/** The one-click builder presets. Each is exactly the groups whose union is
 *  that market's book, so `bookForSectors(PRESETS[m])` ≡ `bookFor(m)`. */
export const PRESETS: Record<MarketFilter, readonly SectorKey[]> = {
  STOCK: ["SEMIS", "TECH", "MACRO"],
  CRYPTO: ["MAJORS", "DEFI", "MEME"],
  MIXED: SECTOR_ORDER,
};

/** The preset a selection exactly equals, as a set. Null when it is a
 *  hand-rolled combination. */
export function presetOf(sectors: readonly SectorKey[]): MarketFilter | null {
  const picked = new Set(sectors);
  for (const m of ["STOCK", "CRYPTO", "MIXED"] as const) {
    const preset = PRESETS[m];
    if (picked.size === preset.length && preset.every((k) => picked.has(k))) return m;
  }
  return null;
}

/** Label for the collapsed preset chip. */
const PRESET_LABEL: Record<MarketFilter, string> = {
  STOCK: "ALL STOCKS",
  CRYPTO: "ALL CRYPTO",
  MIXED: "FULL BOARD",
};

/** Chips for a selection: one collapsed chip when it is a preset, otherwise
 *  the groups in canonical order, capped at `max` with a `+N` overflow chip. */
export function sectorChips(
  sectors: readonly SectorKey[],
  max = 6,
): { key: string; label: string; color: string }[] {
  const preset = presetOf(sectors);
  if (preset) {
    return [{ key: preset, label: PRESET_LABEL[preset], color: MARKET_COLOR[preset] }];
  }
  const picked = new Set(sectors);
  const ordered = SECTOR_ORDER.filter((k) => picked.has(k));
  const chips = ordered
    .slice(0, max)
    .map((k) => ({ key: k as string, label: SECTORS[k].label, color: SECTORS[k].color }));
  const rest = ordered.length - chips.length;
  if (rest > 0) chips.push({ key: `+${rest}`, label: `+${rest}`, color: C.dim });
  return chips;
}

// ── Market identity ─────────────────────────────────────────────────────────
// Moved here from data/lobbies.ts so `sectorChips` can reach MARKET_COLOR
// without a data/sectors ↔ data/lobbies cycle. data/lobbies.ts re-exports all
// four verbatim, so every existing import site keeps working.

export const MARKET_LABEL: Record<MarketFilter, string> = {
  STOCK: "STOCKS",
  CRYPTO: "CRYPTO",
  MIXED: "MIXED",
};

export const MARKET_COLOR: Record<MarketFilter, string> = {
  STOCK: C.blue,
  CRYPTO: C.accent,
  MIXED: C.violet,
};

/** Card backdrop per market: `[gradient stop, radial tint, angle]`. */
export const MARKET_WALL: Record<MarketFilter, [string, string, number]> = {
  STOCK: ["#0c2230", "rgba(56,189,248,.2)", 130],
  CRYPTO: ["#1c2a12", "rgba(200,255,0,.22)", 145],
  MIXED: ["#221436", "rgba(167,139,250,.24)", 165],
};

/** The tickers a lobby's spin can deal, in board order. */
export function bookFor(market: MarketFilter): readonly string[] {
  return UNIVERSE.filter((u) => market === "MIXED" || u.mkt === market).map((u) => u.sym);
}
