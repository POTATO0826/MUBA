import type { MarketFilter, SectorKey } from "../types.ts";
import { C } from "../theme.ts";
import type { Grade } from "./qualify.ts";
import { LIVE_BOARD, UNIVERSE } from "./universe.ts";

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
 * The six groups over the SEEDED board's 12 raw sectors.
 *
 * These group `data/universe.ts`'s eighteen-row replay fixture, which is what
 * the offline game deals from. The groups over the *live* Base board are
 * {@link LIVE_SECTORS}, at the bottom of this file — different words, different
 * assets, and the only one of the two whose membership is checked against a
 * real book before it is offered.
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

// ── The LIVE sectors ────────────────────────────────────────────────────────
//
// Everything above this line groups the SEEDED board — the eighteen reference
// prices the offline tape walks. Everything below groups the LIVE board: the
// Base assets the protocol actually has a feed for.
//
// Sectors were the right idea applied to the wrong list (plan6 §B3). They are
// redrawn here over names that can clear the liquidity gate, and the membership
// below is a *taxonomy* — DOGE is a memecoin whether or not anyone is quoting
// it today. **Which members are playable is never written down here.** That is
// measured, per round, by `qualifiedUnderlyings()` against the live book and
// passed in. A frozen membership list is how AVAX ends up excluded on the day a
// maker finally quotes both sides of it.

/** The four groups over the live board. Deliberately a separate type from
 *  {@link SectorKey}: that one names the seeded taxonomy (SEMIS, OLD WORLD…),
 *  which is a different set of words about a different list of assets. */
export type LiveSectorKey = "MAJORS" | "L1S" | "MEME" | "PAYMENTS";

export interface LiveSectorDef {
  key: LiveSectorKey;
  label: string;
  /** Raw `Asset.sector` values this group gathers — same contract as
   *  {@link SectorDef}. Tickers are always derived by filtering
   *  {@link LIVE_BOARD}, which stays the single source of the live order. */
  members: readonly string[];
  color: string;
  blurb: string;
}

export const LIVE_SECTORS: Record<LiveSectorKey, LiveSectorDef> = {
  MAJORS: {
    key: "MAJORS",
    label: "MAJORS",
    members: ["MAJORS"],
    color: C.accent,
    blurb:
      "ETH and BTC — the only two underlyings market makers stream two-sided quotes on. Deepest books, tightest spreads.",
  },
  L1S: {
    key: "L1S",
    label: "L1S",
    members: ["L1S"],
    color: C.blue,
    blurb:
      "Solana, BNB and Avalanche. Resting orders only, so the book is thinner and one side may be missing — a harder round, not a broken one.",
  },
  MEME: {
    key: "MEME",
    label: "MEME",
    members: ["MEME"],
    color: "#f472b6",
    blurb: "Dogecoin. Widest strikes on the board when it is quoted at all.",
  },
  PAYMENTS: {
    key: "PAYMENTS",
    label: "PAYMENTS",
    members: ["PAYMENTS"],
    color: C.violet,
    blurb: "XRP. A price feed the protocol has had longer than it has had a book on it.",
  },
};

/** Canonical live-group order. */
export const LIVE_SECTOR_ORDER: readonly LiveSectorKey[] = ["MAJORS", "L1S", "MEME", "PAYMENTS"];

const LIVE_RAW_TO_KEY = new Map<string, LiveSectorKey>(
  LIVE_SECTOR_ORDER.flatMap((k) => LIVE_SECTORS[k].members.map((raw) => [raw, k] as const)),
);

/** The live group a raw `Asset.sector` belongs to, or `null`.
 *
 *  Unlike {@link sectorOf} there is **no catch-all**: the seeded board's raw
 *  sectors (SEMIS, AUTO, ORACLE…) are not live groups, and bucketing them into
 *  one would put Nvidia in a crypto sector rather than saying it is not there. */
export function liveSectorOf(rawSector: string): LiveSectorKey | null {
  return LIVE_RAW_TO_KEY.get(rawSector) ?? null;
}

/** Every ticker the taxonomy places in a live group, playable or not. The
 *  *candidate* members — see {@link liveBookForSectors} for the playable ones. */
export function liveSymsOfSector(key: LiveSectorKey): readonly string[] {
  return LIVE_BOARD.filter((u) => liveSectorOf(u.sector) === key).map((u) => u.sym);
}

/**
 * The tickers a set of live groups can deal today.
 *
 * Two filters, in this order: the taxonomy (is this asset in one of these
 * groups?) and the gate (did the live book qualify it this round?). `qualified`
 * comes from `qualifiedUnderlyings()` and is the caller's to compute — this
 * module never asks the network anything.
 *
 * Filters {@link LIVE_BOARD} and **never iterates `keys`**, so the result is
 * identical for any permutation of the same groups. That is the same property
 * {@link bookForSectors} holds and for the same reason: the spin indexes into
 * this array, so both its contents and its order are part of the seed contract.
 */
export function liveBookForSectors(
  keys: readonly LiveSectorKey[],
  qualified: readonly string[],
): readonly string[] {
  const want = new Set(keys);
  const playable = new Set(qualified);
  return LIVE_BOARD.filter((u) => {
    const key = liveSectorOf(u.sector);
    return key !== null && want.has(key) && playable.has(u.sym);
  }).map((u) => u.sym);
}

/** Why a live group cannot be played right now. `null` when it can. */
export const NO_BOOK_REASON = "no live book today";

/**
 * How the DEEP/THIN grade paints, wherever it is rendered — the lobby card, the
 * live-book row in the builder, the slice reveal.
 *
 * Green and amber rather than green and red, because THIN is **not** an error
 * state. It is an asset with resting orders and no market-maker stream: fewer
 * cards, wider spreads, sometimes only one side. That is a harder round and a
 * true fact about the book, and it is the kind of difficulty that teaches
 * something about liquidity rather than punishing someone for finding it.
 */
export const GRADE_COLOR: Record<Grade, string> = {
  DEEP: C.green,
  THIN: C.amber,
};

/** One line per grade, for a tooltip or a hover pane. Says what the player gets
 *  rather than what the plumbing is. */
export const GRADE_BLURB: Record<Grade, string> = {
  DEEP: "market makers quote both sides — most cards dealt, tight spreads",
  THIN: "resting orders only — fewer cards, wider spreads, one side may be missing",
};

/** One live group, measured against today's qualified set — enough for the
 *  lobby builder to render it greyed *with the reason* rather than hiding it. */
export interface LiveSectorStatus {
  key: LiveSectorKey;
  label: string;
  color: string;
  blurb: string;
  /** Every name the taxonomy places here, playable or not. */
  members: readonly string[];
  /** The subset that qualified this round, in board order. */
  playable: readonly string[];
  /** `false` when nothing in this group qualified. */
  open: boolean;
  /** `null` when {@link open}. Otherwise the sentence to render beside it. */
  reason: string | null;
}

/**
 * Every live group with today's book against it, in canonical order.
 *
 * **A group with no qualified members is greyed, never hidden.** A host who
 * picks MEME and gets an empty lobby learns nothing; a host who sees MEME
 * greyed out and reading "no live book today" learns the shape of the market
 * they are about to trade in — which is the same fact the DEEP/THIN grade
 * teaches one level down.
 *
 * With no book at all (`qualified` empty — offline, or the market route down)
 * every group comes back greyed, which is the honest render: the seeded board
 * still plays, and nothing live is on offer.
 */
export function liveSectorStatus(qualified: readonly string[]): readonly LiveSectorStatus[] {
  return LIVE_SECTOR_ORDER.map((key) => {
    const def = LIVE_SECTORS[key];
    const playable = liveBookForSectors([key], qualified);
    return {
      key,
      label: def.label,
      color: def.color,
      blurb: def.blurb,
      members: liveSymsOfSector(key),
      playable,
      open: playable.length > 0,
      reason: playable.length > 0 ? null : NO_BOOK_REASON,
    };
  });
}
