import type { Asset } from "../types.ts";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * TWO BOARDS, AND THE LINE BETWEEN THEM
 * ────────────────────────────────────────────────────────────────────────────
 *
 * This module used to hold one list and let it mean two things at once. It no
 * longer does, because those two things have different owners:
 *
 *  - {@link LIVE_BOARD} is **the board**. The assets Base actually has a
 *    Chainlink feed and a readable market price for, and the only list any
 *    player-facing surface deals from: the reel, the lobby list, the builder's
 *    sector chips, the ladder's filters. It is the *candidate* set, never the
 *    qualified set — which of these can be dealt on a given day is measured
 *    against the live book by `data/qualify.ts` and injected. A name here is a
 *    name the protocol knows, not a promise of a fill.
 *
 *  - {@link UNIVERSE} is a **replay fixture, and nothing else**. Eighteen
 *    reference prices and volatilities that `engine/tape.ts` walks so a chart
 *    still draws with no network, and that `server/news.ts` derives its symbol
 *    allowlist from. NVDA, TSLA and PEPE are on it and Thetanuts quotes none of
 *    them, which is exactly why **nothing offers it**: `data/sectors.ts` does
 *    not import this array, no group gathers a row of it, and there is no
 *    control anywhere in the product that puts one of these names in front of a
 *    player. Plan 6 §B3 said the fictional eighteen must go; they are gone from
 *    the product, and what is left here is the fixture the locks were always
 *    really about.
 *
 *    Every value on it is frozen by `test/spot.test.ts`: a shared `?seed=N`
 *    link, a stored ledger row and both players in one room all resolve through
 *    these numbers, so the rows stay byte-identical even though nothing deals
 *    them.
 *
 * The tape draws from whichever board holds the symbol — which is why the
 * live-only names carry seeded `px`/`t`/`vol` too, so an AVAX arena still
 * renders with the network unplugged.
 */

/** The replay fixture. `t` is the percentage move a leg must clear; `vol`
 *  drives the generated tape, so a high-`t` name is also the noisy one.
 *
 *  **Frozen, and offered nowhere.** These rows back the offline tape and the
 *  news ticker's symbol allowlist. No sector gathers them, no lobby deals them
 *  and no control selects them — see the module header. */
export const UNIVERSE: readonly Asset[] = [
  { sym: "NVDA", name: "Nvidia", sector: "SEMIS", mkt: "STOCK", px: 118.4, t: 4.0, vol: 0.03 },
  { sym: "AAPL", name: "Apple", sector: "TECH", mkt: "STOCK", px: 232.1, t: 2.0, vol: 0.016 },
  { sym: "TSLA", name: "Tesla", sector: "AUTO", mkt: "STOCK", px: 248.6, t: 5.0, vol: 0.034 },
  { sym: "XOM", name: "Exxon", sector: "ENERGY", mkt: "STOCK", px: 112.3, t: 1.5, vol: 0.014 },
  { sym: "JPM", name: "JPMorgan", sector: "FIN", mkt: "STOCK", px: 214.8, t: 1.5, vol: 0.013 },
  { sym: "AMD", name: "AMD", sector: "SEMIS", mkt: "STOCK", px: 158.2, t: 4.5, vol: 0.031 },
  { sym: "META", name: "Meta", sector: "TECH", mkt: "STOCK", px: 604.5, t: 2.5, vol: 0.019 },
  { sym: "GLD", name: "Gold ETF", sector: "METALS", mkt: "STOCK", px: 246.1, t: 1.0, vol: 0.009 },
  { sym: "COIN", name: "Coinbase", sector: "EQUITY-BETA", mkt: "STOCK", px: 188.7, t: 6.0, vol: 0.04 },
  { sym: "BTC", name: "Bitcoin", sector: "L1", mkt: "CRYPTO", px: 96410, t: 4.0, vol: 0.028 },
  { sym: "ETH", name: "Ethereum", sector: "L1", mkt: "CRYPTO", px: 4182.6, t: 5.0, vol: 0.036 },
  { sym: "SOL", name: "Solana", sector: "L1", mkt: "CRYPTO", px: 214.4, t: 7.0, vol: 0.052 },
  { sym: "ARB", name: "Arbitrum", sector: "L2", mkt: "CRYPTO", px: 0.842, t: 9.0, vol: 0.061 },
  { sym: "LINK", name: "Chainlink", sector: "ORACLE", mkt: "CRYPTO", px: 22.86, t: 6.5, vol: 0.048 },
  { sym: "UNI", name: "Uniswap", sector: "DEFI", mkt: "CRYPTO", px: 13.42, t: 8.0, vol: 0.055 },
  { sym: "AAVE", name: "Aave", sector: "DEFI", mkt: "CRYPTO", px: 178.3, t: 8.5, vol: 0.058 },
  { sym: "DOGE", name: "Dogecoin", sector: "MEME", mkt: "CRYPTO", px: 0.164, t: 12.0, vol: 0.074 },
  { sym: "PEPE", name: "Pepe", sector: "MEME", mkt: "CRYPTO", px: 0.0000112, t: 16.0, vol: 0.092 },
];

/** The seeded row for a symbol that is on both boards, so the two can never
 *  drift apart: ETH's reference price is written down once. */
const seeded = (sym: string): Asset => UNIVERSE.find((u) => u.sym === sym)!;

/**
 * The live board — the eight Base price-feed assets, minus PAXG, which has a
 * Chainlink feed and no readable market price (FINDINGS §3).
 *
 * **This is the candidate list, not the qualified list.** Nothing here is
 * offered to a player until `qualifiedUnderlyings()` has measured it against
 * the live book: spot readable, enough resting orders, enough of them carrying
 * a delta, and enough summed depth that a fill does not move the book it was
 * quoted from. A name on a list is not a book — that confusion is exactly the
 * bug that made AVAX the broken default asset.
 *
 * `sector` is the RAW value `data/sectors.ts` groups on, the same contract the
 * seeded board's `sector` has. `px`/`t`/`vol` exist for one reason: the offline
 * seeded tape. When a book is present, **every number a player sees comes from
 * the book**, and these are not consulted at all.
 *
 * The order is canonical: `liveBookForSectors` filters this array and never
 * iterates the sector keys, so any permutation of the same groups yields the
 * same book in the same order.
 */
export const LIVE_BOARD: readonly Asset[] = [
  { ...seeded("ETH"), sector: "MAJORS" },
  { ...seeded("BTC"), sector: "MAJORS" },
  { ...seeded("SOL"), sector: "L1S" },
  // Seeded references for the three live-only names come from this repo's own
  // frozen capture (`test/fixtures/orders.json` prices), so an offline round on
  // one of them opens on a print that was real once rather than on an invention.
  { sym: "BNB", name: "BNB", sector: "L1S", mkt: "CRYPTO", px: 718.18, t: 5.0, vol: 0.038 },
  { sym: "AVAX", name: "Avalanche", sector: "L1S", mkt: "CRYPTO", px: 7.5, t: 8.0, vol: 0.056 },
  { ...seeded("DOGE"), sector: "MEME" },
  { sym: "XRP", name: "XRP", sector: "PAYMENTS", mkt: "CRYPTO", px: 1.45, t: 6.0, vol: 0.045 },
];

/** The live board's tickers, in canonical order. */
export const LIVE_SYMS: readonly string[] = LIVE_BOARD.map((u) => u.sym);

// The seeded board wins a collision: `meta("ETH").sector` stays `"L1"`, which
// is what the seeded taxonomy and every pinned replay expect. The live rows
// only fill in names the seeded board never had.
const BY_SYM = new Map<string, Asset>([
  ...LIVE_BOARD.map((u) => [u.sym, u] as const),
  ...UNIVERSE.map((u) => [u.sym, u] as const),
]);

/** Never returns undefined — an unknown symbol falls back to the first asset,
 *  matching the design's `meta()`.
 *
 *  Resolves across BOTH boards, so a round dealt on a live-only underlying
 *  (BNB, AVAX, XRP) still has a reference price to draw a seeded tape from
 *  instead of silently rendering as Nvidia. */
export function meta(sym: string): Asset {
  return BY_SYM.get(sym) ?? UNIVERSE[0]!;
}
