import { ThetanutsClient, validateRanger } from "@thetanuts-finance/thetanuts-client";
import type { PayoutType, ThetanutsLogger } from "@thetanuts-finance/thetanuts-client";
import { JsonRpcProvider } from "ethers";
import type { FillPreview, MmQuote, OrderRow, PricingRow } from "../types.ts";

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

/**
 * How many MM quotes per underlying the envelope carries.
 *
 * `getPricingArray('ETH')` returned **782** rows at capture time and BTC 925
 * (FINDINGS §1). Shipping ~1,700 quotes down a poll every 30 seconds to draw a
 * fourteen-row table is not a table, it is a download.
 */
const MM_ROWS = 14;

/** Quotes further than this from spot are cut before they cross the wire. A
 *  ±25% band keeps both wings of the front expiry and drops the tails nobody
 *  is looking at on a desk screen. */
const MM_STRIKE_BAND = 0.25;

/** The only two underlyings that have MM pricing. The other six price-feed
 *  assets return `[]` rather than throwing (FINDINGS §5.5), so asking them
 *  would cost six round trips to learn nothing. */
const MM_UNDERLYINGS = ["ETH", "BTC"] as const;

/**
 * The notional every order row is previewed at: $1.00, USDC 6dp.
 *
 * A quote line needs *a* number, and this one is deliberately not the number
 * anyone will trade: P3 owns the real fill and carries its own
 * `MAX_FILL_USDC = 2_000000n` cap plus a $0.01 target. A dollar is large enough
 * that `numContracts` rounds to something visible on a thin book and small
 * enough that it is never mistaken for an order.
 *
 * **This constant cannot spend anything.** The client this file builds has no
 * signer, and `previewFillOrder` is pure local math over an order it was handed
 * — no allowance, no transaction, no chain write exists on this path.
 */
const QUOTE_USDC = 1_000000n;

/** `numContracts` is 18dp. */
const CONTRACT_DECIMALS = 18;

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

/**
 * One row of `client.mmPricing.getPricingArray('ETH'|'BTC')`.
 *
 * The SDK's `MMVanillaPricing` has 15 fields; these are the nine this app
 * reads, so the real rows are structurally assignable and a JSON fixture is
 * too. The four omitted price fields matter by their absence:
 * `rawBidPrice`/`rawAskPrice` are the **pre-fee** numbers and are deliberately
 * not carried here, so no later edit can accidentally quote them.
 */
export interface RawMmQuote {
  ticker: string;
  /** Fee-adjusted, as shipped. See `MmQuote.bid` for why it is never redone. */
  feeAdjustedBid: number;
  feeAdjustedAsk: number;
  markPrice: number;
  strike: number;
  /** Unix seconds. */
  expiry: number;
  isCall: boolean;
  underlying: string;
  /** Spot the MM quoted against. Present on every live row; used to centre the
   *  visible strikes without a second call for a price we already have. */
  underlyingPrice?: number;
}

/** Everything `buildSnapshot` needs. One real capture of this is frozen into
 *  `test/fixtures/orders.json`. */
export interface RawMarket {
  orders: readonly RawOrderEntry[];
  /** `getMarketData().prices` — USD spot per asset. */
  prices: Record<string, number>;
  chainConfig: RawChainConfig;
  /**
   * MM two-sided quotes per underlying, ETH and BTC only — the other six
   * price-feed assets return `[]` rather than throwing (FINDINGS §5.5), so an
   * empty entry and an unsupported asset are indistinguishable here, exactly as
   * they are in the SDK. Optional: the order book is the load-bearing feed and
   * a pricing-host outage must not empty the whole snapshot.
   */
  mmPricing?: Record<string, readonly RawMmQuote[]>;
  /**
   * `previewFillOrder`, curried by the service over the quote notional and the
   * referrer — the one impure thing the builder is allowed to hold, and it is
   * held as a *parameter* so the purity rule survives: hand the builder a stub
   * and it is still a total function of its arguments.
   *
   * It is passed in rather than precomputed because previews are only wanted
   * for the `ORDER_ROWS` rows that actually ship, and which rows those are is
   * decided in here, after the slice. Previewing all 426 live orders to display
   * 40 would be forty times the work for the same screen.
   *
   * `null` means "this order could not be previewed" — the SDK throws
   * `ORDER_EXPIRED`/`INVALID_ORDER` on orders the book is still serving, and
   * one bad order must not cost the other thirty-nine their quote line.
   */
  preview?: (entry: RawOrderEntry) => FillPreview | null;
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
  /** MM quotes per underlying, front expiry, trimmed around spot. `{}` when the
   *  pricing host was unreachable — `/desk` then falls back to the book-derived
   *  table rather than showing an empty panel. */
  mmPricing: Record<string, MmQuote[]>;
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
  /**
   * `client.mmPricing`. Optional twice over: a fake client in a test may leave
   * it out, and a live client whose pricing host is down still serves a book.
   * `filterByStrikeRange` is one of the SDK's own documented helpers
   * (index.d.ts:7677) and is used rather than reimplemented.
   */
  mmPricing?: {
    getPricingArray(underlying: "ETH" | "BTC"): Promise<readonly RawMmQuote[]>;
    filterByStrikeRange?(
      pricing: RawMmQuote[],
      minStrike: number,
      maxStrike: number,
    ): readonly RawMmQuote[];
  };
  /**
   * `client.optionBook`, narrowed to the one **read** method this file calls.
   *
   * `previewFillOrder` is synchronous and local — it does no RPC, signs
   * nothing and needs no signer (FINDINGS "0.3.0 delta"). Declaring only this
   * member is the point: `fillOrder`, `ensureAllowance` and the rest of the
   * module are not reachable through this interface, so nothing the market
   * service is later asked to do can turn into a transaction by accident. P3
   * takes the real module, in the browser, next to the wallet.
   *
   * Optional, like `mmPricing`: a fake client in a test may omit it, and a row
   * with no preview simply carries no quote line.
   */
  optionBook?: {
    previewFillOrder(
      orderWithSig: RawOrderEntry,
      usdcAmount?: bigint,
      referrer?: string,
    ): { numContracts: bigint; totalCollateral: bigint };
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
 * The one map between the SDK's two structure namespaces. **RANGER branch:
 * supported** — SDK 0.3.0 ships a real `case "ranger":` in both the payout and
 * the collateral math (FINDINGS "0.3.0 delta"), so a four-strike row is quoted
 * *and* priceable rather than reading `PAYOFF UNAVAILABLE`.
 *
 * Three unions name these shapes and **no two of them share strings**:
 *
 *  - `ProductName` (index.d.ts:14681) — UPPER_SNAKE registry names, the same
 *    keys as `ImplementationAddresses`: `RANGER`, `CALL_SPREAD`, … The keys of
 *    this map.
 *  - `PayoutType` (index.d.ts:6500) — lowercase snake_case, what
 *    `utils.calculatePayout` actually accepts: `'ranger'`, `'call_spread'`, …
 *    The values of this map.
 *  - `OptionStructure` (index.d.ts:14541) — a third union that has **no
 *    ranger** and does have `straddle`/`strangle`. It is not either of the
 *    above and must never be substituted for one.
 *
 * One map, no guessing, and no string built by lowercasing a registry name:
 * `IRON_CONDOR`→`iron_condor` would survive that trick and `LINEAR_CALL`→`call`
 * would not.
 */
export const PAYOUT_TYPE: Record<string, PayoutType> = {
  LINEAR_CALL: "call",
  INVERSE_CALL: "call",
  PHYSICAL_CALL: "call",
  PUT: "put",
  PHYSICAL_PUT: "put",
  CALL_SPREAD: "call_spread",
  INVERSE_CALL_SPREAD: "call_spread",
  PUT_SPREAD: "put_spread",
  CALL_FLY: "call_fly",
  PUT_FLY: "put_fly",
  CALL_CONDOR: "call_condor",
  PUT_CONDOR: "put_condor",
  IRON_CONDOR: "iron_condor",
  RANGER: "ranger",
};

/** Our `Structure` + the call/put flag → the SDK's registry name. */
export function productNameOf(structure: Structure, isCall: boolean): string {
  switch (structure) {
    case "CALL":
      return "LINEAR_CALL";
    case "PUT":
      return "PUT";
    case "SPREAD":
      return isCall ? "CALL_SPREAD" : "PUT_SPREAD";
    case "FLY":
      return isCall ? "CALL_FLY" : "PUT_FLY";
    case "RANGER":
      return "RANGER";
    // A four-strike order that is not a ranger is quoted as a plain condor —
    // the same default the SDK's own `getPayoutTypeFromOptionType` takes
    // (index.d.ts:7002), which is the point: our answer and the SDK's agree
    // unless `classify` says RANGER, and then the caller passes `isRanger`.
    case "CONDOR":
      return isCall ? "CALL_CONDOR" : "PUT_CONDOR";
  }
}

/**
 * The `PayoutType` a row should be priced with.
 *
 * This is the field that defuses the discriminator trap: `calculateMaxPayout` /
 * `calculatePayoutAtPrice` take an *order*, which carries no payout type, so a
 * ranger read off the book **silently prices as a condor** unless the caller
 * passes `isRanger: true`. `payout === "ranger"` on a row is exactly that flag,
 * decided once here where `classify()` and `validateRanger()` are in scope,
 * rather than re-derived at each call site in P3.
 */
export function payoutTypeFor(structure: Structure, isCall: boolean): PayoutType {
  return PAYOUT_TYPE[productNameOf(structure, isCall)] ?? (isCall ? "call" : "put");
}

/**
 * The ±`MM_STRIKE_BAND` window around spot, or `null` when no row published one.
 *
 * The centre is read off the quotes themselves (`underlyingPrice` is on every
 * live row — FINDINGS §1) rather than off `getMarketData().prices`, for one
 * reason: the MM quoted against *that* number. Centring its chain on a spot
 * from a different call, taken at a different instant, would put the band a few
 * dollars off the prices in it and silently drop a wing at the edge.
 *
 * `null` is not an error — it means the rows carry no spot, and the caller then
 * keeps everything rather than inventing a centre to cut around.
 */
export function mmStrikeBand(
  rows: readonly RawMmQuote[],
): { spot: number; min: number; max: number } | null {
  const spot = rows.find((r) => Number.isFinite(r.underlyingPrice))?.underlyingPrice;
  if (typeof spot !== "number" || spot <= 0) return null;
  return { spot, min: spot * (1 - MM_STRIKE_BAND), max: spot * (1 + MM_STRIKE_BAND) };
}

/**
 * MM quotes → the fourteen rows `/desk` shows, front expiry, centred on spot.
 *
 * Pure, and pointedly boring: **every price is copied, not computed.**
 * `feeAdjustedBid`/`feeAdjustedAsk` are read straight off the row because the
 * docs and the shipped code disagree about the fee cap — `llms-full.txt` says
 * `min(0.0003, raw × 0.125)`, `dist/index.js` uses `Math.min(4e-4, …)`, and the
 * live numbers agree with the code (raw bid 0.115 → 0.1146, a 0.0004 delta;
 * FINDINGS §5.1). Recomputing here would quote a price 1bp off what the venue
 * will trade, in our favour on one side and against us on the other.
 *
 * `spread` is the one arithmetic: `ask - bid` of two numbers the SDK sent. That
 * is a difference of published quotes, not a second fee model.
 */
export function buildMmQuotes(rows: readonly RawMmQuote[]): MmQuote[] {
  const usable = rows.filter(
    (r) =>
      Number.isFinite(r.strike) &&
      Number.isFinite(r.expiry) &&
      Number.isFinite(r.feeAdjustedBid) &&
      Number.isFinite(r.feeAdjustedAsk),
  );
  if (usable.length === 0) return [];

  // Front expiry only. A desk table mixing three expiries at the same strike
  // reads as three prices for one thing.
  const front = Math.min(...usable.map((r) => r.expiry));
  const month = usable.filter((r) => r.expiry === front);

  // The ±MM_STRIKE_BAND cut, again. The service already asked the SDK's own
  // `filterByStrikeRange` to do it upstream — but the builder is a pure
  // function that must be right on its own, over a fixture, over a fake client
  // with no helper, over a pricing host that started sending wider chains. The
  // two passes agree by construction (same band, same centre), so the second
  // one is a no-op on live data rather than a second policy.
  const band = mmStrikeBand(month);
  const inBand = band ? month.filter((r) => r.strike >= band.min && r.strike <= band.max) : month;

  // Nearest-to-spot wins the cut; the survivors are then put back in strike
  // order, so the table still reads as a chain rather than as a ranking.
  const px = band?.spot;
  const centred =
    typeof px === "number"
      ? [...inBand].sort((a, b) => Math.abs(a.strike - px) - Math.abs(b.strike - px))
      : [...inBand];

  return centred
    .slice(0, MM_ROWS)
    .sort((a, b) => a.strike - b.strike || Number(b.isCall) - Number(a.isCall))
    .map((r) => ({
      ticker: r.ticker,
      type: r.isCall ? ("CALL" as const) : ("PUT" as const),
      strike: money(r.strike),
      expiry: expiryLabel(r.expiry),
      bid: r.feeAdjustedBid.toFixed(4),
      ask: r.feeAdjustedAsk.toFixed(4),
      mark: Number.isFinite(r.markPrice) ? r.markPrice.toFixed(4) : "—",
      spread: (r.feeAdjustedAsk - r.feeAdjustedBid).toFixed(4),
    }));
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
  /** The raw entry behind `rows[i]`, kept in step so the shipped slice can be
   *  previewed against the orders it was actually built from. */
  const rowEntries: RawOrderEntry[] = [];
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
    rowEntries.push(entry);
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
      // Decided here, once, where `classify()` and `validateRanger()` are both
      // in scope — and it is what makes a RANGER row *priceable* rather than
      // merely quoted. SDK 0.3.0 ships real ranger payout math, so the plan's
      // `PAYOFF UNAVAILABLE — ranger math is on-chain only` branch is the
      // unsupported one and is not taken: every classified row gets a payout
      // type, `'ranger'` included.
      payout: payoutTypeFor(structure, level.isCall),
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

  // The quote line, on the rows that ship and only those. A preview that
  // throws or returns nothing leaves the row exactly as it was — no quote line
  // is a state the view already handles, and it is the honest one.
  const shipped = rows.slice(0, ORDER_ROWS);
  if (raw.preview) {
    for (let i = 0; i < shipped.length; i++) {
      const preview = raw.preview(rowEntries[i]!);
      if (preview) shipped[i] = { ...shipped[i]!, preview };
    }
  }

  // `{}` when the pricing host was unreachable, which is a first-class
  // outcome: the signed order book is the load-bearing feed and MM quotes are
  // the second opinion beside it. `/desk` falls back to the book-derived chain
  // rather than showing an empty panel, and nothing about that path is an error.
  const mmPricing: Record<string, MmQuote[]> = {};
  for (const [underlying, quotes] of Object.entries(raw.mmPricing ?? {})) {
    const built = buildMmQuotes(quotes ?? []);
    // An underlying with no usable quotes is absent, not present-and-empty:
    // "ETH: []" on the wire would make the view render a headed table with no
    // rows under it, which reads as "the MM has stopped quoting ETH".
    if (built.length > 0) mmPricing[underlying] = built;
  }

  return {
    at,
    spot,
    pricing,
    mmPricing,
    orders: shipped,
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

/**
 * MM two-sided quotes for both tradable underlyings.
 *
 * **This never rejects.** `getPricingArray` reaches
 * `pricing.thetanuts.finance`, a different host from the indexer that serves
 * the order book, and the two fail independently. The book is the load-bearing
 * feed: a dead pricing host must cost the desk its MM panel and nothing else,
 * so every underlying is settled separately and a rejection resolves to an
 * absent key rather than to an empty snapshot.
 *
 * ETH and BTC only. The other six price-feed assets return `[]` rather than
 * throwing (FINDINGS §5.5) — asking them would be six round trips to learn
 * something the type signature already says.
 */
async function readMmPricing(
  client: MarketClient,
): Promise<Record<string, readonly RawMmQuote[]>> {
  const mm = client.mmPricing;
  if (!mm) return {};

  const settled = await Promise.allSettled(
    MM_UNDERLYINGS.map(async (underlying) => [underlying, await mm.getPricingArray(underlying)] as const),
  );

  const out: Record<string, readonly RawMmQuote[]> = {};
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const [underlying, rows] = result.value;
    if (rows.length === 0) continue;

    // ~782 ETH rows and ~925 BTC rows at capture time (FINDINGS §1). The cut
    // happens here, before the wire, and it is the SDK's own documented helper
    // (`filterByStrikeRange`, index.d.ts:7677) that makes it wherever the
    // client has one — reimplementing a filter the venue publishes is how two
    // definitions of "near the money" start disagreeing. `buildMmQuotes`
    // applies the identical band itself, so a client without the helper (a
    // test fake, an older build) lands on exactly the same fourteen rows.
    const band = mmStrikeBand(rows);
    out[underlying] =
      band && mm.filterByStrikeRange
        ? mm.filterByStrikeRange([...rows], band.min, band.max)
        : rows;
  }
  return out;
}

/**
 * `previewFillOrder`, curried over the quote notional and our referrer.
 *
 * Synchronous, local, and incapable of spending: the preview is arithmetic over
 * an order object the caller already holds (FINDINGS "0.3.0 delta"), the client
 * has no signer, and `MarketClient.optionBook` exposes no method that could
 * become a transaction. It runs on the server because the SDK is not in the
 * browser bundle and must not be — the client layer talks to one JSON route.
 *
 * The referrer rides along on every preview so the attribution string in P3's
 * fill is the same one the desk quoted against. An un-whitelisted referrer's
 * split is 0 bps; that is attribution, never revenue.
 *
 * `undefined` when the client has no `optionBook` — rows then ship with no
 * quote line at all, which the view renders as silence rather than as a zero.
 */
function previewer(client: MarketClient): RawMarket["preview"] {
  const book = client.optionBook;
  if (!book) return undefined;
  const referrer = Bun.env.THETADUEL_REFERRER || undefined;

  return (entry: RawOrderEntry): FillPreview | null => {
    try {
      const preview = book.previewFillOrder(entry, QUOTE_USDC, referrer);
      return {
        contracts: fromUnits(preview.numContracts, CONTRACT_DECIMALS).toFixed(4),
        collateral: fromUnits(preview.totalCollateral, COLLATERAL_DECIMALS).toFixed(2),
        // The book-depth guard the plan names. Depth on Base swung from 426
        // resting orders to 130 inside a day, so "this order will not absorb a
        // dollar" is an ordinary reading, not a failure.
        fillable: preview.numContracts > 0n,
      };
    } catch {
      // ORDER_EXPIRED / INVALID_ORDER on an order the indexer is still
      // serving. One unpreviewable row must not cost the other thirty-nine
      // their quote line, and it is certainly not worth failing the snapshot.
      return null;
    }
  };
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
    // One round trip each, in parallel — the book, the spot prices and the MM
    // chains are independent reads on two different hosts. `readMmPricing`
    // never rejects, so `Promise.all` here cannot be tripped by the pricing
    // host: the book is what this snapshot is for, and it either arrives or
    // the whole read fails over to the stale path below.
    const [orders, marketData, mmPricing] = await Promise.all([
      client.api.fetchOrders(),
      client.api.getMarketData(),
      readMmPricing(client),
    ]);
    return buildSnapshot(
      {
        orders,
        prices: marketData?.prices ?? {},
        chainConfig: client.chainConfig,
        mmPricing,
        preview: previewer(client),
      },
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
