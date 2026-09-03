import type { Asset } from "../types.ts";

/**
 * The tradable board.
 *
 * These are exactly the 8 assets `RFQUnderlying` accepts in
 * `@thetanuts-finance/thetanuts-client` 0.3.0:
 *
 * ```ts
 * type RFQUnderlying = 'ETH' | 'BTC' | 'SOL' | 'DOGE' | 'XRP' | 'BNB' | 'PAXG' | 'AVAX';
 * ```
 *
 * The board used to hold 18 names, 9 of them equities. Equities have no option
 * book on Thetanuts, so a duel on TSLA could never settle against a real
 * contract. Every asset here can carry a real RFQ.
 *
 * `px` is a reference spot only. The live price comes from `/api/market`, which
 * reads `getMarketData().prices`. Note PAXG: it has a price feed but no entry in
 * market prices, so its live spot stays null and the screens say so.
 */
export const UNIVERSE: readonly Asset[] = [
  { sym: "ETH", name: "Ethereum", sector: "L1", mkt: "CRYPTO", px: 2375.8, t: 5.0, vol: 0.036 },
  { sym: "BTC", name: "Bitcoin", sector: "L1", mkt: "CRYPTO", px: 96410, t: 4.0, vol: 0.028 },
  { sym: "SOL", name: "Solana", sector: "L1", mkt: "CRYPTO", px: 101.4, t: 7.0, vol: 0.052 },
  { sym: "BNB", name: "BNB", sector: "L1", mkt: "CRYPTO", px: 712.0, t: 5.0, vol: 0.038 },
  { sym: "AVAX", name: "Avalanche", sector: "L1", mkt: "CRYPTO", px: 7.6, t: 8.0, vol: 0.055 },
  { sym: "XRP", name: "XRP", sector: "PAYMENTS", mkt: "CRYPTO", px: 1.94, t: 7.0, vol: 0.05 },
  { sym: "DOGE", name: "Dogecoin", sector: "MEME", mkt: "CRYPTO", px: 0.164, t: 12.0, vol: 0.074 },
  { sym: "PAXG", name: "Pax Gold", sector: "METALS", mkt: "CRYPTO", px: 2680.0, t: 1.5, vol: 0.011 },
];

/** Every symbol the RFQ builder accepts, in board order. */
export const RFQ_UNDERLYINGS: readonly string[] = UNIVERSE.map((u) => u.sym);

const BY_SYM = new Map(UNIVERSE.map((u) => [u.sym, u]));

/** Never returns undefined — an unknown symbol falls back to the first asset,
 *  matching the design's `meta()`. */
export function meta(sym: string): Asset {
  return BY_SYM.get(sym) ?? UNIVERSE[0]!;
}
