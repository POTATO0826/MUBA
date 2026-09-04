import type { MarketSource } from "./market.ts";
import type { PricingRow } from "../types.ts";

/**
 * Shared board helpers for both PvP modes.
 *
 * Two rules live here because both boards got them wrong independently:
 *
 * 1. A pick names its asset. Ids used to be `TYPE|strike|expiry`, which is not
 *    unique across assets and, worse, was only ever looked up inside the asset
 *    the viewer happened to be on. An opponent who picked on another asset
 *    scored 0% — silently, with no error.
 * 2. The opening asset must have a book worth looking at. The board used to
 *    open on whatever sorted first, which is AVAX, whose every quote is
 *    bid-only. Every ask read "—" and the slip looked broken.
 *
 * Pure by construction: a `MarketSource` in, numbers and strings out, no clock
 * and no network. Live values reach `/desk` through here and stop there —
 * nothing in `src/engine/**` may import this file's source.
 */

/** `ETH|CALL|2,400|3 SEP`. Unique across the whole board. */
export function pickId(asset: string, row: PricingRow): string {
  return `${asset}|${row.type}|${row.strike}|${row.expiry}`;
}

/** Playable rows for one asset: a row with no greeks cannot be scored. */
export function playableRows(source: MarketSource, asset: string): readonly PricingRow[] {
  return source.pricing(asset).filter((r) => typeof r.edge === "number");
}

/** A quote with both sides has a real spread; one side only has no cost. */
function twoSided(row: PricingRow): boolean {
  return row.bid !== "—" && row.ask !== "—";
}

/**
 * The asset to open on: the one with the most two-sided quotes, then the most
 * quotes overall. Falls back to the first asset when nothing qualifies.
 */
export function defaultAsset(source: MarketSource): string {
  const assets = source.underlyings();
  let best = assets[0] ?? "ETH";
  let bestScore = -1;

  for (const asset of assets) {
    const rows = playableRows(source, asset);
    // Two-sided quotes dominate; total count only breaks ties.
    const score = rows.filter(twoSided).length * 1000 + rows.length;
    if (score > bestScore) {
      bestScore = score;
      best = asset;
    }
  }
  return best;
}

/**
 * Every playable quote on the board, keyed by `pickId`.
 *
 * Built across all assets on purpose. Scoring a pick against only the asset on
 * screen is what made a cross-asset opponent read as 0%.
 */
export function edgeIndex(source: MarketSource): Map<string, number> {
  const index = new Map<string, number>();
  for (const asset of source.underlyings()) {
    for (const row of playableRows(source, asset)) {
      index.set(pickId(asset, row), Math.abs(row.edge ?? 0));
    }
  }
  return index;
}

/** Total edge of a comma-separated pick, across every asset. */
export function scorePick(index: Map<string, number>, pick: string | null | undefined): number {
  if (!pick) return 0;
  return pick.split(",").reduce((sum, id) => sum + (index.get(id) ?? 0), 0);
}
