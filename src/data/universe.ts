import type { Asset } from "../types.ts";

/** The board. `t` is the percentage move a leg must clear; `vol` drives
 *  the generated tape, so a high-`t` name is also the noisy one. */
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

const BY_SYM = new Map(UNIVERSE.map((u) => [u.sym, u]));

/** Never returns undefined — an unknown symbol falls back to the first asset,
 *  matching the design's `meta()`. */
export function meta(sym: string): Asset {
  return BY_SYM.get(sym) ?? UNIVERSE[0]!;
}
