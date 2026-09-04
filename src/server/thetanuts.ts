import { ThetanutsClient, validateRanger } from "@thetanuts-finance/thetanuts-client";
import type { ThetanutsLogger } from "@thetanuts-finance/thetanuts-client";
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
 * **The client is read-only on purpose. It has no signer, so nothing in this
 * file can move funds even if it is wrong.**
 *
 * ## Shape: a pure builder behind an injectable service
 *
 * The transplanted original was one `build()` closure over module state, which
 * made the interesting half — turning 130+ one-sided signed orders into a
 * two-sided pricing table — reachable only through the network. It is split in
 * two here, mirroring `createNewsService` (`src/server/news.ts`):
 *
 *  - `buildSnapshot(raw, at)` is **pure**. Raw orders + spot prices + the feed
 *    map in, a snapshot out, no clock and no socket. `test/market-builder.test.ts`
 *    drives it off a frozen capture of one real response.
 *  - `createMarketService({ client, now })` owns the impure edges: the SDK
 *    client, the 15s TTL, the in-flight dedupe and the stale-on-failure rule.
 *    `test/market-route.test.ts` hands it a fake client and a fake clock.
 *
 * Like the news service it **never throws at the route**: `handle()` always
 * answers 200 with a typed envelope, and the client reads `ok`.
 *
 * ## Presentation only
 *
 * Nothing here may be imported by `src/engine/**` or `src/state/match.ts` —
 * `test/determinism.test.ts` (`LIVE_MARKET_RE`) enforces it. One such import
 * would make what a seed deals depend on the Base book at wall-clock time.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

const RPC_URL = Bun.env.RPC_URL ?? "https://mainnet.base.org";

/** `SupportedChainId` is the literal union `8453 | 1` (index.d.ts:112), so this
 *  has to narrow rather than parse — `Number(env)` does not typecheck. */
const CHAIN_ID = 8453 as const;

/** Reads are cached this long. The public RPC throttles, and a duel lobby
 *  polling every second would burn through it in minutes. */
export const TTL_MS = 15_000;

/** Contract prices are 8dp. */
const PRICE_DECIMALS = 8;
/** Fallback only. Real collateral decimals come from `chainConfig.tokens` —
 *  see `collateralUsd`, and the bug that made that necessary. */
const COLLATERAL_DECIMALS = 6;
/** Strikes come back as 8dp decimal strings. */
const STRIKE_DECIMALS = 8;

/** How many order rows the envelope carries. The book is long and the blotter
 *  on screen is not. */
const ORDER_ROWS = 40;

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// ─────────────────────────────────────────────────────────────────────────────
// Raw inputs — the fixture's shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry of `client.api.fetchOrders()`, loosened at exactly two points so a
 * checked-in JSON fixture is assignable to it:
 *
 *  - every `bigint` widens to `string | bigint` (JSON has no bigint);
 *  - `rawApiData.greeks` is `unknown`, because it is **undocumented** — the
 *    shipped `.d.ts` types it, the docs never mention it, and a field the docs
 *    do not own can change shape without warning. See `greeksOf`.
 *
 * The SDK's own `OrderWithSignature` is structurally assignable to this, so the
 * real client needs no adapter.
 */
export interface RawOrderEntry {
  order: {
    /** Price per contract, 8dp. */
    price: string | bigint;
    /** True when the *maker* is the buyer — i.e. this order is a bid. */
    isBuyer: boolean;
  };
  /** Remaining fillable size, in collateral units (6dp for USDC). */
  availableAmount: string | bigint;
  rawApiData?: {
    /** Collateral token address. Four different ones are live on Base at three
     *  different decimal scales — see `collateralUsd`. */
    collateral?: string;
    /**
     * Chainlink feed address, which is how an order names its underlying.
     *
     * DOC CONTRADICTION #10 (tnuts-test/FINDINGS.md): the official docs
     * describe these fields under an `OrderWithSignature` heading, but the
     * shipped types put them on `rawApiData` — and `calculateMaxContracts`'s
     * own `@param` reads "Order with signature containing rawApiData". The
     * shipped `.d.ts` wins. Do not "fix" this to `entry.priceFeed`.
     */
    priceFeed?: string;
    /** Decimal strings at 8dp, not bigint — one of three encodings of the
     *  same numbers on this object. */
    strikes?: string[];
    isCall?: boolean;
    orderExpiryTimestamp?: number;
    /** The OptionBook this order was signed for. See `resolveOptionBook`. */
    optionBookAddress?: string;
    /** Undocumented. Shape-checked at the boundary, never trusted. */
    greeks?: unknown;
  };
}

/** Just enough of `client.chainConfig` to resolve feeds, tokens and the book. */
export interface RawChainConfig {
  priceFeeds: Record<string, string>;
  contracts: { optionBook: string | null };
  /** Keyed by symbol. Optional so a test's fake config can omit it; the real
   *  `ChainConfig` always has it. */
  tokens?: Record<string, { address: string; symbol: string; decimals: number }>;
}

/** Everything `buildSnapshot` needs. One real capture of this is frozen into
 *  `test/fixtures/orders.json`. */
export interface RawMarket {
  orders: readonly RawOrderEntry[];
  /** `getMarketData().prices` — USD spot per asset. */
  prices: Record<string, number>;
  chainConfig: RawChainConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which OptionBook the app should believe in.
 *
 * `agreed: false` is not an error — it is a fact the UI shows as an amber chip.
 */
export interface OptionBookRef {
  address: string;
  /** True when the chain config and the book's own orders name the same
   *  address (or when no order names one at all). */
  agreed: boolean;
}

export interface MarketSnapshot {
  /** When this snapshot was built, ms. */
  at: number;
  /** Only underlyings that actually have a book. */
  underlyings: string[];
  /** Live USD spot per asset, from `getMarketData().prices`. PAXG has a price
   *  feed but no market price, so it is absent rather than zero. */
  spot: Record<string, number>;
  pricing: Record<string, PricingRow[]>;
  orders: OrderRow[];
  optionBook: OptionBookRef;
  /** How many orders carried usable greeks. Zero means the pricing table is
   *  quoted but unscoreable — `/desk` degrades rather than inventing a delta. */
  greeksSeen: number;
  /** Set when this snapshot is being served past its TTL because the refresh
   *  failed. */
  note?: string;
}

export type MarketEnvelope =
  | ({ ok: true } & MarketSnapshot)
  | { ok: false; reason: string };

export interface MarketService {
  /** Always resolves. A dead RPC is data, not an exception. */
  snapshot(): Promise<MarketEnvelope>;
  /** Always 200. */
  handle(): Promise<Response>;
}

/** Just enough of `ThetanutsClient` to be faked in a test. The real client is
 *  structurally assignable. */
export interface MarketClient {
  chainConfig: RawChainConfig;
  api: {
    fetchOrders(): Promise<readonly RawOrderEntry[]>;
    getMarketData(): Promise<{ prices?: Record<string, number> }>;
  };
}

export interface MarketDeps {
  /** Omitted means the real read-only Base client, built lazily. */
  client?: MarketClient;
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// The read-only client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SDK errors, with a prefix, on our console.
 *
 * `ThetanutsLogger` (index.d.ts:8) is four *optional* methods, so a partial
 * logger is legal. `debug`/`info` are left off deliberately: the SDK is chatty
 * at those levels and a dev server that prints a paragraph every 15 seconds is
 * a log nobody reads. Warnings and errors are the ones that mean something.
 */
const logger: ThetanutsLogger = {
  warn: (message: string, meta?: unknown) =>
    meta === undefined ? console.warn(`[market] ${message}`) : console.warn(`[market] ${message}`, meta),
  error: (message: string, meta?: unknown) =>
    meta === undefined ? console.error(`[market] ${message}`) : console.error(`[market] ${message}`, meta),
};

let realClient: ThetanutsClient | null = null;

/**
 * The process-wide read-only client.
 *
 * `referrer` and `logger` are both native `ThetanutsClientConfig` fields
 * (index.d.ts:136) — no wrapper needed. `signer` is omitted, which is what
 * makes this client incapable of writing: every write method throws
 * `SIGNER_REQUIRED` rather than doing something expensive.
 */
function getRealClient(): MarketClient {
  if (!realClient) {
    realClient = new ThetanutsClient({
      chainId: CHAIN_ID,
      provider: new JsonRpcProvider(RPC_URL),
      // Attribution on every read path that later becomes a fill. An
      // un-whitelisted referrer's split is 0 bps — see the /desk footer copy.
      referrer: Bun.env.THETADUEL_REFERRER || undefined,
      logger,
    });
  }
  return realClient;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Price-feed address → symbol, so an order can name its underlying.
 *
 * The map is 10 keys over 8 distinct assets: `ETH/USD` and `ETH` are the same
 * address, likewise BTC (FINDINGS §3). Both aliases must collapse to one
 * symbol or the same instrument splits across two rows of the table.
 */
export function feedSymbols(feeds: Record<string, string>): Map<string, string> {
  const byAddress = new Map<string, string>();
  for (const [symbol, address] of Object.entries(feeds ?? {})) {
    // `ETH/USD` and `ETH` are the same address; prefer the bare symbol.
    const key = String(address).toLowerCase();
    const bare = symbol.replace(/\/USD$/, "");
    const held = byAddress.get(key);
    if (held === undefined || bare.length < held.length) byAddress.set(key, bare);
  }
  return byAddress;
}

/**
 * Which OptionBook address to believe.
 *
 * Two official documentation pages disagree about the Base OptionBook address
 * — the protocol's deployed-addresses page and the SDK reference's OptionBook
 * page name different contracts (recorded in the plan's "Digest corrections",
 * §"OptionBook address conflicts across two official doc pages"; the design
 * did not record the two URLs themselves, so this comment names the pages
 * rather than fabricating links). Neither is hardcoded here.
 *
 * The rule, and the reason for it: **the order's own `optionBookAddress`
 * wins.** An order is an EIP-712 signature over a specific book contract; a
 * fill submitted to any other address fails, whatever the chain config or a
 * docs page says. `client.chainConfig.contracts.optionBook` is the cross-check,
 * not the authority, and a disagreement is surfaced (`agreed: false`) rather
 * than silently resolved — if the config and the live book part ways, an
 * operator should see it before a fill does.
 *
 * When no order carries an address there is nothing to disagree with, so the
 * config stands and `agreed` is true.
 */
export function resolveOptionBook(
  chainConfig: RawChainConfig,
  orders: readonly RawOrderEntry[],
): OptionBookRef {
  const configured = chainConfig?.contracts?.optionBook ?? "";
  let fromOrders = "";
  for (const entry of orders) {
    const address = entry.rawApiData?.optionBookAddress;
    if (address) {
      fromOrders = address;
      break;
    }
  }
  if (!fromOrders) return { address: configured, agreed: true };
  return {
    address: fromOrders,
    agreed: configured.toLowerCase() === fromOrders.toLowerCase(),
  };
}

/**
 * One collateral token, as this file needs to read it.
 *
 * The `usd` factor is why this exists at all — see `collateralUsd`.
 */
interface CollateralToken {
  decimals: number;
  /** USD per whole token, or `null` when we cannot price it. */
  usd: number | null;
}

/**
 * Collateral token address → decimals and a USD rate.
 *
 * **This is the fix for a bug the first live capture exposed.** The
 * transplanted builder scaled every `availableAmount` by a hardcoded 6, because
 * USDC is the collateral the SDK's examples use. The live Base book is
 * collateralised in *four* tokens at three scales — USDC and aBasUSDC (6),
 * cbBTC and aBascbBTC (8), WETH and aBasWETH (18) — so a WETH-collateralised
 * level came out as `3962153.5M` and, because the depth bar scales within an
 * underlying, flattened every honest ETH level beside it to the floor of 2. A
 * bar chart where one wrong row squashes all the real ones is worse than no
 * bar chart.
 *
 * So: decimals come from `chainConfig.tokens`, which is authoritative, and the
 * amounts are converted to USD so that levels backed by different tokens are
 * actually comparable. They line up when you do it — the same market maker's
 * $10k of USDC, 3.96 WETH and 0.1227 cbBTC are all ~$10,000 of budget.
 *
 * Symbol → asset is a small amount of string work rather than a table: strip
 * the Aave-on-Base `aBas` wrapper, then a `cb` or `W` wrapper prefix, and look
 * the rest up in the live spot map. Anything still holding `USD` is a dollar.
 * A token we cannot price keeps `usd: null` and is counted at face value —
 * wrong units, but the same order of magnitude, which is all a bar width needs.
 */
export function collateralTokens(
  chainConfig: RawChainConfig,
  spot: Record<string, number>,
): Map<string, CollateralToken> {
  const out = new Map<string, CollateralToken>();
  for (const token of Object.values(chainConfig?.tokens ?? {})) {
    if (!token?.address) continue;
    const bare = token.symbol.replace(/^aBas/, "").replace(/^(cb|W)/, "").toUpperCase();
    const price = spot[bare];
    const usd =
      typeof price === "number" && Number.isFinite(price)
        ? price
        : token.symbol.toUpperCase().includes("USD")
          ? 1
          : null;
    out.set(token.address.toLowerCase(), { decimals: token.decimals, usd });
  }
  return out;
}

/** One order's fillable size as a USD collateral budget. */
function collateralUsd(
  amount: string | bigint,
  address: string | undefined,
  tokens: Map<string, CollateralToken>,
): number {
  const token = tokens.get(String(address ?? "").toLowerCase());
  const units = fromUnits(amount, token?.decimals ?? COLLATERAL_DECIMALS);
  return units * (token?.usd ?? 1);
}

/** What `greeksOf` could salvage from one order. */
interface Greeks {
  delta: number | null;
  iv: number | null;
}

const NO_GREEKS: Greeks = { delta: null, iv: null };

/**
 * Greeks, defensively.
 *
 * `rawApiData.greeks` is **undocumented**: the shipped `.d.ts` types it as
 * `{ delta, iv, gamma, theta, vega }`, all numbers, and the live API does send
 * that — but the docs never mention the field, so nothing obliges it to stay.
 * A `null` here is a first-class outcome: the row is quoted and simply not
 * scoreable, which `playableRows` (`src/data/board.ts`) already filters on.
 *
 * `Number.isFinite` rather than `typeof === "number"` on purpose: JSON `null`,
 * a string, `NaN` from a bad divide and `Infinity` are all things an API has
 * shipped before, and every one of them would poison a median.
 */
export function greeksOf(raw: unknown): Greeks {
  if (!raw || typeof raw !== "object") return NO_GREEKS;
  const g = raw as { delta?: unknown; iv?: unknown };
  const delta = typeof g.delta === "number" && Number.isFinite(g.delta) ? g.delta : null;
  const iv = typeof g.iv === "number" && Number.isFinite(g.iv) ? g.iv : null;
  return { delta, iv };
}

/** The structure a set of strikes describes. Finer than `PricingRow.type`,
 *  which only has three members because `/desk` colours by it. */
export type Structure = "CALL" | "PUT" | "SPREAD" | "FLY" | "CONDOR" | "RANGER";

/**
 * Strikes → structure.
 *
 * The strike count carries the product type (`Order.strikes` doc comment:
 * 1 vanilla, 2 spread, 3 butterfly, 4 condor/iron-condor/ranger), so only the
 * four-strike case needs deciding — and it is the case that matters, because
 * the SDK's payout math silently prices a ranger **as a condor** unless the
 * caller passes `isRanger: true` (FINDINGS "the 4-strike discriminator trap").
 * This function is what will set that flag in P2.
 *
 * Ranger invariants, from the `PayoutType` doc table and the real `case
 * "ranger":` in `dist/index.js:10966`:
 *   strikes are `[callLower, callUpper, putLower, putUpper]`, ASCENDING,
 *   `callUpper - callLower === putUpper - putLower` (equal widths), and
 *   `callUpper < putLower` (the zone gap).
 * An iron condor is the same arity with `[putLower, putUpper, callLower,
 * callUpper]` and no equal-width rule, so equal widths + a gap is the
 * discriminator.
 *
 * The SDK exports its own `validateRanger(strikes)` and it is consulted rather
 * than reimplemented — but only for the width rule it actually checks; the
 * ascending and zone-gap checks are ours, because a validator that accepts
 * `[100, 90, ...]` would let a descending set through.
 */
export function classify(strikes: readonly number[], isCall: boolean): Structure {
  const vanilla = isCall ? "CALL" : "PUT";
  if (strikes.length <= 1) return vanilla;
  if (strikes.length === 2) return "SPREAD";
  if (strikes.length === 3) return "FLY";
  if (strikes.length > 4) return "CONDOR";

  const [a, b, c, d] = strikes as [number, number, number, number];
  const ascending = a < b && b < c && c < d;
  const equalWidths = Math.abs(b - a - (d - c)) < 1e-9;
  const zoneGap = b < c;
  // Cross-check against the SDK's own checker. It reads the same four numbers
  // in the same order, so a disagreement means our reading of the invariant
  // drifted from theirs — treat it as "not a ranger" and quote the row as a
  // condor rather than flagging a payout mode the protocol would reject.
  const sdkAgrees = validateRanger([a, b, c, d]).valid;
  return ascending && equalWidths && zoneGap && sdkAgrees ? "RANGER" : "CONDOR";
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
  /**
   * Summed `availableAmount`, in USD. This is **collateral budget, not
   * contracts** — FINDINGS §2 observed `availableAmount ===
   * rawApiData.maxCollateralUsable` (10000000000n = 10,000 USDC at 6dp) while
   * `order.numContracts` was `0n`. The depth bar and the size column therefore
   * say "how much this level will absorb", which is the honest reading of the
   * field, and `collateralUsd` is what makes four collateral tokens summable.
   */
  size: number;
  delta: number | null;
  iv: number | null;
}

/** Signed distance from the group median IV, or `undefined` with no greeks. */
function edgeOf(level: Level, medianIv: Map<string, number>): number | undefined {
  if (level.iv === null) return undefined;
  const median = medianIv.get(`${level.underlying}|${level.expiry}|${level.isCall}`);
  if (!median) return undefined;
  return +((level.iv - median) / median).toFixed(4);
}

// ─────────────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Raw book → one snapshot. Pure: no clock, no socket, no module state.
 *
 * `at` is passed in rather than read, which is what makes the whole
 * transformation testable off a frozen capture.
 */
export function buildSnapshot(raw: RawMarket, at: number): MarketSnapshot {
  const symbolOf = feedSymbols(raw.chainConfig?.priceFeeds ?? {});
  const optionBook = resolveOptionBook(raw.chainConfig, raw.orders);

  const spot: Record<string, number> = {};
  for (const [symbol, value] of Object.entries(raw.prices ?? {})) {
    const price = typeof value === "number" ? value : Number((value as { price?: number })?.price);
    if (Number.isFinite(price)) spot[symbol.replace(/\/USD$/, "")] = price;
  }

  // Built after `spot`, because pricing a WETH-collateralised level needs the
  // ETH price that the same response carried.
  const tokens = collateralTokens(raw.chainConfig, spot);

  const levels = new Map<string, Level>();
  const rows: OrderRow[] = [];
  let greeksSeen = 0;

  for (const entry of raw.orders) {
    const api = entry.rawApiData ?? {};
    const underlying = symbolOf.get(String(api.priceFeed ?? "").toLowerCase());
    if (!underlying) continue;

    const strikes = (api.strikes ?? []).map((s) => fromUnits(s, STRIKE_DECIMALS));
    if (strikes.length === 0) continue;

    const expiry = api.orderExpiryTimestamp ?? 0;
    const isCall = Boolean(api.isCall);
    const price = fromUnits(entry.order.price, PRICE_DECIMALS);
    const available = collateralUsd(entry.availableAmount, api.collateral, tokens);
    const isBid = entry.order.isBuyer;

    const greeks = greeksOf(api.greeks);
    if (greeks.delta !== null || greeks.iv !== null) greeksSeen += 1;

    const key = `${underlying}|${isCall}|${strikes.join("/")}|${expiry}`;
    const level = levels.get(key) ?? {
      underlying,
      isCall,
      strikes,
      expiry,
      bestBid: null,
      bestAsk: null,
      size: 0,
      delta: greeks.delta,
      iv: greeks.iv,
    };

    // Best bid is the highest someone will pay; best ask the lowest anyone
    // will take.
    if (isBid) level.bestBid = level.bestBid === null ? price : Math.max(level.bestBid, price);
    else level.bestAsk = level.bestAsk === null ? price : Math.min(level.bestAsk, price);

    level.size += available;
    if (level.delta === null) level.delta = greeks.delta;
    if (level.iv === null) level.iv = greeks.iv;
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

  const pricing: Record<string, PricingRow[]> = {};
  const ordered = new Map<string, Level[]>();
  const rowOf = new Map<Level, PricingRow>();
  for (const level of levels.values()) {
    const scale = maxByUnderlying.get(level.underlying) ?? 1;
    const structure = classify(level.strikes, level.isCall);
    const row: PricingRow = {
      // `type` keeps its three-member union because `/desk` colours by it;
      // `structure` below is the truthful one. A four-strike order is only
      // called RANGER when it really is one — the improvement over the
      // transplanted heuristic, which called every 4-strike order a ranger.
      type: structure === "RANGER" ? "RANGER" : level.isCall ? "CALL" : "PUT",
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
      structure,
    };
    rowOf.set(level, row);
    pricing[level.underlying] = [...(pricing[level.underlying] ?? []), row];
    ordered.set(level.underlying, [...(ordered.get(level.underlying) ?? []), level]);
  }

  // Nearest expiry first, then by strike — an option chain reads that way.
  // Sorted off the numeric level, because "100,000" sorts before "9,000" as a
  // string.
  for (const underlying of Object.keys(pricing)) {
    const order = [...(ordered.get(underlying) ?? [])];
    order.sort((a, b) => a.expiry - b.expiry || a.strikes[0]! - b.strikes[0]!);
    pricing[underlying] = order.map((l) => rowOf.get(l)!);
  }

  return {
    at,
    spot,
    pricing,
    orders: rows.slice(0, ORDER_ROWS),
    // Only underlyings that actually have a book — the price-feed list is
    // longer than the list of assets anyone is quoting.
    underlyings: Object.keys(pricing).sort(),
    optionBook,
    greeksSeen,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

/** `THETADUEL_MARKET=off` ships a build on the mock book alone. Read at call
 *  time, not at module load, so a test can set and restore it. */
function disabled(): boolean {
  try {
    return (
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.THETADUEL_MARKET === "off"
    );
  } catch {
    return false;
  }
}

function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 197)}…` : message;
}

/**
 * The market service.
 *
 * Both impure edges are parameters. `client` defaults to the real read-only
 * Base client, built lazily so importing this module in a test costs no socket
 * and no provider.
 */
export function createMarketService(deps: MarketDeps = {}): MarketService {
  const now = deps.now ?? (() => Date.now());

  let cached: MarketSnapshot | null = null;
  let inFlight: Promise<MarketSnapshot> | null = null;

  async function read(): Promise<MarketSnapshot> {
    const client = deps.client ?? getRealClient();
    // One round trip each, in parallel — the book and the spot prices are
    // independent reads.
    const [orders, marketData] = await Promise.all([
      client.api.fetchOrders(),
      client.api.getMarketData(),
    ]);
    return buildSnapshot(
      { orders, prices: marketData?.prices ?? {}, chainConfig: client.chainConfig },
      now(),
    );
  }

  /** Begin a read and publish it as the one in-flight job. */
  function start(): Promise<MarketSnapshot> {
    const job = read()
      .then((s) => {
        cached = s;
        return s;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = job;
    return job;
  }

  /**
   * The current snapshot, refreshed at most every `TTL_MS`.
   *
   * Concurrent callers share one in-flight request rather than each starting
   * their own — two players opening the pricing table at once should be one RPC
   * round trip, not two.
   */
  async function refresh(): Promise<MarketSnapshot> {
    if (cached && now() - cached.at < TTL_MS) return cached;
    // A joiner shares the leader's promise *and* the stale fallback below —
    // handled here rather than in the `if` so both callers of a failed read
    // get the same answer.
    const job = inFlight ?? start();

    try {
      return await job;
    } catch (error) {
      // A stale snapshot beats an empty screen when the RPC is throttling. It
      // keeps its original `at`, so the footer's age chip tells the truth about
      // how old these numbers are, and carries a note saying why.
      if (cached) return { ...cached, note: `stale — refresh failed: ${reasonOf(error)}` };
      throw error;
    }
  }

  async function snapshot(): Promise<MarketEnvelope> {
    if (disabled()) return { ok: false, reason: "disabled" };
    try {
      return { ok: true, ...(await refresh()) };
    } catch (error) {
      return { ok: false, reason: reasonOf(error) };
    }
  }

  return {
    snapshot,
    async handle(): Promise<Response> {
      return Response.json(await snapshot(), { headers: { "cache-control": "no-store" } });
    },
  };
}
