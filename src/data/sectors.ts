import type { MarketFilter, SectorKey } from "../types.ts";
import { C } from "../theme.ts";
import type { Grade } from "./qualify.ts";
import { LIVE_BOARD } from "./universe.ts";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE SECTORS ARE DRAWN OVER THE LIVE BOARD. THERE IS NO OTHER BOARD.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module used to group `data/universe.ts`'s eighteen invented rows — NVDA,
 * TSLA, XOM, PEPE — and hand that book to the reel, the lobby list, the builder
 * and the ladder. Thetanuts quotes none of those names, so every one of those
 * surfaces was offering a player something that could never be filled.
 *
 * Plan 6 §B3: *"the 18 assets with invented MEME/TECH sectors are fiction and
 * must go. Sectors themselves stay — they were the right idea applied to the
 * wrong list."* That is what this file now is. **Every function below filters
 * {@link LIVE_BOARD}**, the assets Base actually has a price feed for, and the
 * seeded eighteen are no longer reachable from any of them.
 *
 * `UNIVERSE` still exists in `data/universe.ts` and is still byte-identical,
 * because it is a *replay fixture* — the offline tape walks it and the news
 * ticker's symbol allowlist is derived from it. It is not offered anywhere a
 * player can act on it, and nothing in this file imports it.
 *
 * ## Why two groups and not the plan's four
 *
 * §B3's table is `MAJORS` / `L1S` / `MEME` / `PAYMENTS`. `L1S` and `PAYMENTS`
 * are not members of `SectorKey`, which lives in `src/types.ts` — a file this
 * change did not hold the grant for. Rather than smuggle the two new groups in
 * under the keys `SEMIS` and `TECH` (a lie in the data that every future reader
 * would have to un-learn), the live board is grouped with the key names that
 * already exist and are already true of it: **MAJORS**, which is every
 * underlying with a feed except the memecoin, and **MEME**, which is DOGE.
 *
 * Widening `SectorKey` to `"MAJORS" | "L1S" | "MEME" | "PAYMENTS"` is a
 * one-line change and restores §B3's table exactly; see the handoff note in
 * {@link RETIRED} for the full list of what moves with it.
 */

/** One sector group: a bucket of raw `Asset.sector` values with a label,
 *  a colour and a one-line pitch. `members` are RAW sector strings — the
 *  tickers are always derived from {@link LIVE_BOARD}, which stays the single
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
 * The four `SectorKey`s that named equity groups and no longer name anything.
 *
 * They survive as `SECTORS` entries for one reason: `SECTORS` is typed
 * `Record<SectorKey, SectorDef>` and `SectorKey` is declared in `src/types.ts`,
 * which this change could not edit. **They are absent from
 * {@link SECTOR_ORDER}**, so nothing iterates them, nothing offers them, and
 * their empty `members` makes any book they could produce empty.
 *
 * The follow-up, for whoever holds `src/types.ts` next:
 *
 * ```ts
 * export type SectorKey = "MAJORS" | "L1S" | "MEME" | "PAYMENTS";
 * ```
 *
 * then delete this constant and the four entries it names, split `MAJORS` into
 * `MAJORS` (ETH, BTC) / `L1S` (SOL, BNB, AVAX) / `PAYMENTS` (XRP) per §B3, and
 * fix the one literal that falls out: `data/leaderboard.ts`'s
 * `SECTOR_ORDER[…] ?? "SEMIS"` becomes `?? "MAJORS"`.
 */
const RETIRED = (key: SectorKey, was: string): SectorDef => ({
  key,
  label: was,
  members: [],
  color: C.dim,
  blurb:
    `Retired. ${was} grouped equities from the seeded replay fixture — ` +
    `Thetanuts has no market for any of them, so the group is offered nowhere.`,
});

/**
 * The groups over the live board.
 *
 * Membership here is a **taxonomy**, not a promise of a fill: DOGE is a
 * memecoin whether or not anyone is quoting it today. Which members are
 * playable is measured per round against the live book by
 * `qualifiedUnderlyings()` and passed in — see {@link liveSectorStatus}. A
 * frozen membership list is how AVAX ends up excluded on the day a maker
 * finally quotes both sides of it.
 */
export const SECTORS: Record<SectorKey, SectorDef> = {
  MAJORS: {
    key: "MAJORS",
    label: "MAJORS",
    members: ["MAJORS", "L1S", "PAYMENTS"],
    color: C.accent,
    blurb:
      "ETH and BTC, where market makers stream two-sided quotes, plus the alt-L1s and XRP — " +
      "resting orders only, so the book is thinner and one side may be missing.",
  },
  MEME: {
    key: "MEME",
    label: "MEME",
    members: ["MEME"],
    color: "#f472b6",
    blurb: "Dogecoin. Widest strikes on the board when it is quoted at all.",
  },
  SEMIS: RETIRED("SEMIS", "SEMIS"),
  TECH: RETIRED("TECH", "BIG TECH"),
  MACRO: RETIRED("MACRO", "OLD WORLD"),
  DEFI: RETIRED("DEFI", "DEFI"),
};

/** Canonical group order — every chip row and book derives from it, and the
 *  retired keys are deliberately not on it. */
export const SECTOR_ORDER: readonly SectorKey[] = ["MAJORS", "MEME"];

const RAW_TO_KEY = new Map<string, SectorKey>(
  SECTOR_ORDER.flatMap((k) => SECTORS[k].members.map((raw) => [raw, k] as const)),
);

/** Group for a raw `Asset.sector`. Total over the live board.
 *
 *  Anything unknown buckets into MAJORS, the catch-all. The only callers that
 *  can reach that branch are the ladder tallies in `state/rank.ts`, replaying
 *  stored history rows whose raw sector may predate this change — a total
 *  function is what keeps those tallies summing to the match count. */
export function sectorOf(rawSector: string): SectorKey {
  return RAW_TO_KEY.get(rawSector) ?? "MAJORS";
}

const SYMS_BY_KEY = new Map<SectorKey, readonly string[]>(
  SECTOR_ORDER.map((k) => [k, LIVE_BOARD.filter((u) => sectorOf(u.sector) === k).map((u) => u.sym)]),
);

/** The group's tickers, in board order. Empty for a retired key. */
export function symsOfSector(key: SectorKey): readonly string[] {
  return SYMS_BY_KEY.get(key) ?? [];
}

/** The tickers a set of groups can deal, in board order.
 *
 *  Filters {@link LIVE_BOARD} and never iterates `keys`, so the result is
 *  identical for any permutation of the same groups — the spin's determinism
 *  depends on both the contents AND the order of this array. */
export function bookForSectors(keys: readonly SectorKey[]): readonly string[] {
  const want = new Set(keys);
  return LIVE_BOARD.filter((u) => want.has(sectorOf(u.sector))).map((u) => u.sym);
}

/** A lobby's market, derived from its groups. The live board is entirely
 *  crypto, so this is `"CRYPTO"` for any non-empty selection — computed from
 *  the assets' `mkt` rather than asserted, so it stays correct on the day a
 *  tokenised equity actually gets a feed. */
export function marketOf(keys: readonly SectorKey[]): MarketFilter {
  const want = new Set(keys);
  const picked = LIVE_BOARD.filter((u) => want.has(sectorOf(u.sector)));
  const stock = picked.some((u) => u.mkt === "STOCK");
  const crypto = picked.some((u) => u.mkt === "CRYPTO");
  if (stock && !crypto) return "STOCK";
  if (crypto && !stock) return "CRYPTO";
  return "MIXED";
}

/** The one-click builder presets. Each is exactly the groups whose union is
 *  that market's book, so `bookForSectors(PRESETS[m])` ≡ `bookFor(m)`.
 *
 *  `STOCK` is empty and stays empty: there is no equity on the live board, and
 *  an empty preset is the honest statement of that. The builder no longer
 *  renders a market-preset row at all — `state/match.ts` still reads `MIXED`
 *  for the form's opening selection. */
export const PRESETS: Record<MarketFilter, readonly SectorKey[]> = {
  STOCK: [],
  CRYPTO: SECTOR_ORDER,
  MIXED: SECTOR_ORDER,
};

/** Chips for a selection: the groups in canonical order, capped at `max` with
 *  a `+N` overflow chip.
 *
 *  There is no collapsed-preset chip any more. `ALL STOCKS` and `FULL BOARD`
 *  were labels for a board that no longer exists, and with the live board's
 *  groups a chip row is never long enough to need collapsing. */
export function sectorChips(
  sectors: readonly SectorKey[],
  max = 6,
): { key: string; label: string; color: string }[] {
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
  return LIVE_BOARD.filter((u) => market === "MIXED" || u.mkt === market).map((u) => u.sym);
}

// ── The gate ────────────────────────────────────────────────────────────────
//
// Everything above is the taxonomy — which group a live asset belongs to, and
// in what order. Everything below is the second filter: which of those the
// live book qualified THIS ROUND. The two are deliberately separate. A name in
// a group is a name the protocol knows; a name past the gate is a name a maker
// is quoting deeply enough that a fill will not move the book it was quoted
// from.

/** Why a group cannot be played right now. `null` when it can. */
export const NO_BOOK_REASON = "no live book today";

/**
 * The tickers a set of groups can deal today.
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
  keys: readonly SectorKey[],
  qualified: readonly string[],
): readonly string[] {
  const want = new Set(keys);
  const playable = new Set(qualified);
  return LIVE_BOARD.filter((u) => want.has(sectorOf(u.sector)) && playable.has(u.sym)).map(
    (u) => u.sym,
  );
}

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

/** One group, measured against today's qualified set — enough for the lobby
 *  builder to render it greyed *with the reason* rather than hiding it. */
export interface LiveSectorStatus {
  key: SectorKey;
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
 * Every offered group with today's book against it, in canonical order.
 *
 * **A group with no qualified members is greyed, never hidden** (§B3). A host
 * who picks MEME and gets an empty lobby learns nothing; a host who sees MEME
 * greyed out and reading "no live book today" learns the shape of the market
 * they are about to trade in — which is the same fact the DEEP/THIN grade
 * teaches one level down.
 *
 * With no book at all (`qualified` empty — offline, or the market route down)
 * every group comes back greyed, which is the honest render: nothing is on
 * offer, and the builder says so instead of publishing a lobby that cannot
 * fill.
 */
export function liveSectorStatus(qualified: readonly string[]): readonly LiveSectorStatus[] {
  return SECTOR_ORDER.map((key) => {
    const def = SECTORS[key];
    const playable = liveBookForSectors([key], qualified);
    return {
      key,
      label: def.label,
      color: def.color,
      blurb: def.blurb,
      members: symsOfSector(key),
      playable,
      open: playable.length > 0,
      reason: playable.length > 0 ? null : NO_BOOK_REASON,
    };
  });
}
