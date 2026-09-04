import type { MmQuote, OrderRow, PricingRow } from "../types.ts";

/**
 * Everything the UI needs from a market venue, behind one interface.
 *
 * The prototype ships `mockMarketSource` — static fixtures, no network. The
 * live implementation is `src/data/thetanuts.tsx`, built over `/api/market`;
 * swapping the value passed to `<App source={…} />` is the whole wiring, and no
 * view changed to accept it.
 */

/**
 * Where a source's numbers came from and how fresh they are.
 *
 * This exists so the footer can stop guessing from `id`. Three states, and the
 * middle one is the interesting one:
 *   - `mock`  — the checked-in fixtures. Honest, and labelled as such.
 *   - `live`  — a snapshot the server built inside its TTL.
 *   - `stale` — the last good live snapshot, still on screen because the
 *     refresh failed. The numbers are real, just old; `fetchedAt` says how old.
 */
export interface MarketMeta {
  /** False when the live read failed and nothing good was ever cached. */
  ok: boolean;
  source: "mock" | "live" | "stale";
  /** When the underlying snapshot was built, ms. `0` for the mock, which has
   *  no age — a fixture is not "from 3 seconds ago". */
  fetchedAt: number;
  /** Why, when there is a why. */
  note?: string;
}

export interface MarketSource {
  readonly id: string;
  /**
   * Provenance. Read-only and per-source: a new source object is built each
   * time the book refreshes, so this never goes stale relative to the rows.
   */
  readonly meta: MarketMeta;
  /** Assets that have an options book. */
  underlyings(): readonly string[];
  pricing(underlying: string): readonly PricingRow[];
  /**
   * Market-maker two-sided quotes — `client.mmPricing.getPricingArray(u)`, a
   * genuinely different feed from `pricing()`.
   *
   * `pricing()` is derived from resting signed orders: real, fillable, and
   * one-sided on most levels. This is what the MM will quote, two-sided, at
   * strikes nobody has an order on. Empty is the ordinary answer — only ETH and
   * BTC have MM pricing at all, the mock has none, and the pricing host fails
   * independently of the indexer. `/desk` shows the chain from `pricing()`
   * whenever this is empty rather than an empty table.
   */
  mmPricing(underlying: string): readonly MmQuote[];
  orders(): readonly OrderRow[];
  /**
   * Live USD spot for an asset, or `null`.
   *
   * `null` is the normal case, not an error: Thetanuts publishes spot for 7
   * assets and the board carries 18. Callers annotate when they get a number
   * and stay silent when they do not — live sits beside seeded, never replaces
   * it.
   *
   * **Synchronous, like every other accessor here.** The network resolves
   * before a source is constructed, so no view ever awaits and no view learns
   * that the data arrived late. That is the whole point of the seam.
   */
  spot(underlying: string): number | null;
}

const PRICING: Record<string, readonly PricingRow[]> = {
  ETH: [
    { type: "CALL", strike: "4,000", expiry: "27 SEP", bid: "0.1284", ask: "0.1341", iv: "55.1%", delta: "0.61", depth: 84, size: "12.4k" },
    { type: "CALL", strike: "4,200", expiry: "27 SEP", bid: "0.0902", ask: "0.0948", iv: "56.8%", delta: "0.49", depth: 71, size: "9.8k" },
    { type: "CALL", strike: "4,400", expiry: "27 SEP", bid: "0.0662", ask: "0.0714", iv: "58.2%", delta: "0.36", depth: 58, size: "7.1k" },
    { type: "CALL", strike: "4,600", expiry: "27 SEP", bid: "0.0441", ask: "0.0489", iv: "61.0%", delta: "0.24", depth: 40, size: "4.6k" },
    { type: "PUT", strike: "4,000", expiry: "27 SEP", bid: "0.0651", ask: "0.0692", iv: "64.4%", delta: "−0.34", depth: 62, size: "8.2k" },
    { type: "PUT", strike: "3,800", expiry: "27 SEP", bid: "0.0408", ask: "0.0446", iv: "67.1%", delta: "−0.21", depth: 44, size: "5.4k" },
    { type: "PUT", strike: "3,600", expiry: "27 SEP", bid: "0.0221", ask: "0.0258", iv: "70.3%", delta: "−0.12", depth: 26, size: "3.0k" },
    { type: "RANGER", strike: "3.9–4.6k", expiry: "27 SEP", bid: "0.1310", ask: "0.1402", iv: "—", delta: "0.02", depth: 33, size: "4.0k" },
  ],
  BTC: [
    { type: "CALL", strike: "96,000", expiry: "27 SEP", bid: "0.1401", ask: "0.1466", iv: "46.2%", delta: "0.52", depth: 76, size: "18.2k" },
    { type: "CALL", strike: "100,000", expiry: "27 SEP", bid: "0.1980", ask: "0.2104", iv: "49.8%", delta: "0.38", depth: 61, size: "14.0k" },
    { type: "CALL", strike: "108,000", expiry: "27 SEP", bid: "0.0884", ask: "0.0951", iv: "53.4%", delta: "0.19", depth: 35, size: "6.8k" },
    { type: "PUT", strike: "92,000", expiry: "27 SEP", bid: "0.1120", ask: "0.1188", iv: "50.1%", delta: "−0.35", depth: 54, size: "11.4k" },
    { type: "PUT", strike: "88,000", expiry: "27 SEP", bid: "0.1471", ask: "0.1552", iv: "52.6%", delta: "−0.29", depth: 48, size: "9.2k" },
    { type: "PUT", strike: "80,000", expiry: "27 SEP", bid: "0.0612", ask: "0.0668", iv: "57.0%", delta: "−0.11", depth: 22, size: "4.1k" },
    { type: "RANGER", strike: "90–104k", expiry: "04 OCT", bid: "0.1760", ask: "0.1882", iv: "—", delta: "0.01", depth: 29, size: "5.5k" },
  ],
};

const ORDERS: readonly OrderRow[] = [
  { side: "BUY", instrument: "ETH-27SEP-4400-C", size: "12.0", px: "0.0714", status: "FILLED", time: "12:04:18" },
  { side: "SELL", instrument: "ETH-27SEP-4700-C", size: "12.0", px: "0.0311", status: "FILLED", time: "12:04:18" },
  { side: "BUY", instrument: "ETH-27SEP-3900-P", size: "6.0", px: "0.0624", status: "PARTIAL", time: "12:03:55" },
  { side: "SELL", instrument: "BTC-27SEP-88000-P", size: "0.8", px: "0.1552", status: "OPEN", time: "12:03:41" },
  { side: "BUY", instrument: "ETH-27SEP-RANGER", size: "4.0", px: "0.1402", status: "OPEN", time: "12:02:09" },
  { side: "SELL", instrument: "ETH-12SEP-4200-C", size: "20.0", px: "0.0186", status: "CANCELLED", time: "11:58:32" },
  { side: "BUY", instrument: "BTC-04OCT-RANGER", size: "1.2", px: "0.1882", status: "FILLED", time: "11:57:04" },
];

export const mockMarketSource: MarketSource = {
  id: "mock",
  // `fetchedAt: 0` because a fixture has no age. The footer prints an age chip
  // only for live snapshots, so the mock strip reads exactly as it always has.
  meta: { ok: true, source: "mock", fetchedAt: 0 },
  underlyings: () => ["ETH", "BTC"],
  pricing: (underlying) => PRICING[underlying] ?? [],
  // No seeded MM chain, deliberately. Inventing fourteen two-sided quotes
  // would put a table on screen under a heading that names a live SDK call and
  // reads as its output. Empty means the panel shows the seeded chain above,
  // which is labelled for what it is.
  mmPricing: () => [],
  orders: () => ORDERS,
  // The mock has no spot at all — inventing one here is how a seeded number
  // starts passing for a live one. Every caller already handles `null`.
  spot: () => null,
};
