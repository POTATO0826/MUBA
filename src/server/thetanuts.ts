import { ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import { JsonRpcProvider } from "ethers";
import type { OrderRow, PricingRow } from "../types.ts";

/**
 * Live Thetanuts market data, read on the server.
 *
 * It runs here rather than in the browser because the pricing API does not send
 * CORS headers — a `fetch` to `pricing.thetanuts.finance` from the page fails
 * outright. The orders API happens to be open, but splitting reads across two
 * places to exploit that would mean two code paths and two failure modes for
 * one screen. Everything reads here; only signing happens in the browser, where
 * the wallet is.
 *
 * The client is read-only on purpose. It has no signer, so nothing in this file
 * can move funds even if it is wrong.
 */

const RPC_URL = Bun.env.RPC_URL ?? "https://mainnet.base.org";
const CHAIN_ID = 8453;

/** Reads are cached this long. The public RPC throttles, and a duel lobby
 *  polling every second would burn through it in minutes. */
const TTL_MS = 15_000;

let client: ThetanutsClient | null = null;

function getClient(): ThetanutsClient {
  if (!client) {
    client = new ThetanutsClient({
      chainId: CHAIN_ID,
      provider: new JsonRpcProvider(RPC_URL),
    });
  }
  return client;
}

/** Contract prices are 8dp; USDC collateral is 6dp. */
const PRICE_DECIMALS = 8;
const COLLATERAL_DECIMALS = 6;
/** Strikes come back as 8dp decimal strings. */
const STRIKE_DECIMALS = 8;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

function fromUnits(raw: string | bigint, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/** `1788457967` → `"4 SEP"`. */
function expiryLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

function money(n: number): string {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
}

/** `12400` → `"12.4k"`, matching the mock's size column. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toFixed(0);
}

interface Greeks {
  delta?: number;
  iv?: number;
}

interface RawOrder {
  priceFeed?: string;
  strikes?: string[];
  isCall?: boolean;
  orderExpiryTimestamp?: number;
  greeks?: Greeks;
}

/**
 * One side of one instrument, accumulated across every order quoting it.
 *
 * The book is one-sided per order — `isBuyer` says which. Grouping by
 * instrument and keeping the best of each side is what turns a list of orders
 * into a bid/ask table.
 */
interface Level {
  underlying: string;
  isCall: boolean;
  strikes: number[];
  expiry: number;
  bestBid: number | null;
  bestAsk: number | null;
  /** Summed `availableAmount`, in collateral units. */
  size: number;
  delta: number | null;
  iv: number | null;
}

/** Price-feed address → symbol, so an order can name its underlying. */
function feedSymbols(c: ThetanutsClient): Map<string, string> {
  const feeds = (c.chainConfig.priceFeeds ?? {}) as Record<string, string>;
  const byAddress = new Map<string, string>();
  for (const [symbol, address] of Object.entries(feeds)) {
    // `ETH/USD` and `ETH` are the same address; prefer the bare symbol.
    const key = String(address).toLowerCase();
    const bare = symbol.replace(/\/USD$/, "");
    if (!byAddress.has(key) || bare.length < byAddress.get(key)!.length) {
      byAddress.set(key, bare);
    }
  }
  return byAddress;
}

/** Signed distance from the group median IV, or `undefined` with no greeks. */
function edgeOf(level: Level, medianIv: Map<string, number>): number | undefined {
  if (level.iv === null) return undefined;
  const median = medianIv.get(`${level.underlying}|${level.expiry}|${level.isCall}`);
  if (!median) return undefined;
  return +((level.iv - median) / median).toFixed(4);
}

interface Snapshot {
  at: number;
  pricing: Map<string, PricingRow[]>;
  orders: OrderRow[];
  underlyings: string[];
  /** Live spot per asset, from `getMarketData().prices`. PAXG has a price feed
   *  but no market price, so it is absent rather than zero. */
  spot: Record<string, number>;
}

let snapshot: Snapshot | null = null;
let inFlight: Promise<Snapshot> | null = null;

async function build(): Promise<Snapshot> {
  const c = getClient();
  const symbolOf = feedSymbols(c);
  // One round trip each, in parallel — the book and the spot prices are
  // independent reads.
  const [orders, marketData] = await Promise.all([c.api.fetchOrders(), c.api.getMarketData()]);

  const spot: Record<string, number> = {};
  for (const [symbol, value] of Object.entries(marketData.prices ?? {})) {
    const price = typeof value === "number" ? value : Number((value as { price?: number })?.price);
    if (Number.isFinite(price)) spot[symbol.replace(/\/USD$/, "")] = price;
  }

  const levels = new Map<string, Level>();
  const rows: OrderRow[] = [];

  for (const entry of orders) {
    const raw = (entry.rawApiData ?? {}) as RawOrder;
    const underlying = symbolOf.get(String(raw.priceFeed ?? "").toLowerCase());
    if (!underlying) continue;

    const strikes = (raw.strikes ?? []).map((s) => fromUnits(s, STRIKE_DECIMALS));
    if (strikes.length === 0) continue;

    const expiry = raw.orderExpiryTimestamp ?? 0;
    const isCall = Boolean(raw.isCall);
    const price = fromUnits(entry.order.price, PRICE_DECIMALS);
    const available = fromUnits(entry.availableAmount, COLLATERAL_DECIMALS);
    const isBid = entry.order.isBuyer;

    const key = `${underlying}|${isCall}|${strikes.join("/")}|${expiry}`;
    const level = levels.get(key) ?? {
      underlying,
      isCall,
      strikes,
      expiry,
      bestBid: null,
      bestAsk: null,
      size: 0,
      delta: raw.greeks?.delta ?? null,
      iv: raw.greeks?.iv ?? null,
    };

    // Best bid is the highest someone will pay; best ask the lowest anyone
    // will take.
    if (isBid) level.bestBid = level.bestBid === null ? price : Math.max(level.bestBid, price);
    else level.bestAsk = level.bestAsk === null ? price : Math.min(level.bestAsk, price);

    level.size += available;
    if (level.delta === null) level.delta = raw.greeks?.delta ?? null;
    if (level.iv === null) level.iv = raw.greeks?.iv ?? null;
    levels.set(key, level);

    rows.push({
      side: isBid ? "BUY" : "SELL",
      instrument: `${underlying}-${expiryLabel(expiry).replace(" ", "")}-${strikes[0]!.toFixed(0)}-${isCall ? "C" : "P"}`,
      size: compact(available),
      px: price.toFixed(4),
      // Everything the API returns is a resting order; a filled one is gone.
      status: "OPEN",
      time: expiryLabel(expiry),
    });
  }

  // Median IV per (underlying, expiry, type) group. A quote's distance from
  // its own group is the only honest "mispricing" signal available here: the
  // order book gives no fair value, but a strike whose IV sits far off its
  // neighbours on the same expiry is a real outlier on the smile.
  const groupIvs = new Map<string, number[]>();
  for (const level of levels.values()) {
    if (level.iv === null) continue;
    const key = `${level.underlying}|${level.expiry}|${level.isCall}`;
    groupIvs.set(key, [...(groupIvs.get(key) ?? []), level.iv]);
  }
  const medianIv = new Map<string, number>();
  for (const [key, ivs] of groupIvs) {
    const sorted = [...ivs].sort((a, b) => a - b);
    const mid = sorted[Math.floor(sorted.length / 2)]!;
    medianIv.set(key, mid);
  }

  // `depth` is a 0-100 bar width. Scaled within each underlying: one 10M-USDC
  // BTC level would otherwise flatten every AVAX bar to zero, and the bar is
  // there to compare rows in the same chain, not across chains.
  const maxByUnderlying = new Map<string, number>();
  for (const level of levels.values()) {
    maxByUnderlying.set(
      level.underlying,
      Math.max(maxByUnderlying.get(level.underlying) ?? 1, level.size),
    );
  }

  const pricing = new Map<string, PricingRow[]>();
  const ordered = new Map<string, Level[]>();
  const rowOf = new Map<Level, PricingRow>();
  for (const level of levels.values()) {
    const list = pricing.get(level.underlying) ?? [];
    const scale = maxByUnderlying.get(level.underlying) ?? 1;
    const row: PricingRow = {
      // Four strikes is a ranger; the mock's third row type.
      type: level.strikes.length >= 4 ? "RANGER" : level.isCall ? "CALL" : "PUT",
      strike:
        level.strikes.length >= 4
          ? `${money(level.strikes[0]!)}–${money(level.strikes[level.strikes.length - 1]!)}`
          : money(level.strikes[0]!),
      expiry: expiryLabel(level.expiry),
      bid: level.bestBid === null ? "—" : level.bestBid.toFixed(4),
      ask: level.bestAsk === null ? "—" : level.bestAsk.toFixed(4),
      iv: level.iv === null ? "—" : `${(level.iv * 100).toFixed(1)}%`,
      delta: level.delta === null ? "—" : level.delta.toFixed(2),
      // A floor of 2 so a real but tiny level still draws something — a bar of
      // width 0 reads as "no liquidity", which is a different claim.
      depth: level.size > 0 ? Math.max(2, Math.round((level.size / scale) * 100)) : 0,
      size: compact(level.size),
      edge: edgeOf(level, medianIv),
      mid:
        level.bestBid !== null && level.bestAsk !== null
          ? ((level.bestBid + level.bestAsk) / 2).toFixed(4)
          : undefined,
    };
    rowOf.set(level, row);
    list.push(row);
    pricing.set(level.underlying, list);
    ordered.set(level.underlying, [...(ordered.get(level.underlying) ?? []), level]);
  }

  // Nearest expiry first, then by strike — an option chain reads that way.
  // Sorted off the numeric level, because "100,000" sorts before "9,000" as a
  // string.
  for (const [underlying, list] of pricing) {
    const order = ordered.get(underlying) ?? [];
    order.sort((a, b) => a.expiry - b.expiry || a.strikes[0]! - b.strikes[0]!);
    pricing.set(underlying, order.map((l) => rowOf.get(l)!));
    void list;
  }

  return {
    at: Date.now(),
    spot,
    pricing,
    orders: rows.slice(0, 40),
    // Only underlyings that actually have a book — the price-feed list is
    // longer than the list of assets anyone is quoting.
    underlyings: [...pricing.keys()].sort(),
  };
}

/**
 * The current snapshot, refreshed at most every `TTL_MS`.
 *
 * Concurrent callers share one in-flight request rather than each starting
 * their own — two players opening the pricing table at once should be one RPC
 * round trip, not two.
 */
export async function marketSnapshot(): Promise<Snapshot> {
  if (snapshot && Date.now() - snapshot.at < TTL_MS) return snapshot;
  if (inFlight) return inFlight;

  inFlight = build()
    .then((s) => {
      snapshot = s;
      return s;
    })
    .finally(() => {
      inFlight = null;
    });

  try {
    return await inFlight;
  } catch (error) {
    // A stale snapshot beats an empty screen when the RPC is throttling.
    if (snapshot) return snapshot;
    throw error;
  }
}
