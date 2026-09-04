import { ThetanutsClient, getOptionImplementationInfo } from "@thetanuts-finance/thetanuts-client";
import type { PayoutType, ThetanutsLogger } from "@thetanuts-finance/thetanuts-client";
import { JsonRpcProvider } from "ethers";
import type {
  FillPreview,
  LadderBook,
  LadderBookOrder,
  MmQuote,
  OrderRow,
  PricingRow,
} from "../types.ts";
import { qualifiedAssets, type QualifiedAsset } from "../data/qualify.ts";

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
    /**
     * **`true` marks the side the TAKER buys — i.e. the maker's ASK.**
     *
     * Read that twice, because the field name says the opposite and this app
     * believed the name for four commits. The SDK's own declaration is
     * `"Whether maker is buyer (true) or seller (false) from taker's
     * perspective"` (index.d.ts:773) — it is the trailing clause that governs,
     * and `normalizeOdetteOrder`'s comment `"isLong=true means maker sells"`
     * (index.js:3343, with `isBuyer = !isLong` at :3360) says the reverse. Two
     * vendor comments, one contradiction, and no way to pick between them by
     * reading.
     *
     * So it was measured, twice, against two independent feeds:
     *
     *  1. **The venue's own two-sided quotes.** 142 live single-strike orders
     *     joined to `mmPricing.getPricingArray` on (underlying, call/put,
     *     strike, option expiry), each priced in the collateral's own units:
     *
     *     | `isBuyer` | n | median price ÷ MM mark | ≥ MM ask | ≤ MM bid |
     *     |---|---|---|---|---|
     *     | `true`  | 49 | **1.58–1.66×** | 36 | **0** |
     *     | `false` | 93 | **0.69–0.72×** | **0** | 16 |
     *
     *     A resting order priced at 1.6× the market maker's own mark, never at
     *     or below its bid, is an offer to sell. The separation is total: not
     *     one `isBuyer === true` order sits at or below the bid, and not one
     *     `isBuyer === false` order sits at or above the ask.
     *
     *  2. **Settled on-chain positions** (`docs/plan7-measurements.md` §3.2):
     *     of 9,766 RANGE positions the MM is recorded as `seller` 5,635 times
     *     and as `buyer` zero times, and RANGE orders on the book carry
     *     `isLong === false`, i.e. `isBuyer === true`.
     *
     * Both readings agree: **`isBuyer === true` ⟹ the maker is short ⟹ the
     * taker buys.** `buildSnapshot` files these as **asks**, and they are the
     * orders a player can actually fill — which is what plan 6 §5 and plan 7 §5
     * mean by long-only. Filling an `isBuyer === false` order would make the
     * player the *writer*: collateral posted, downside unbounded, the precise
     * position both plans forbid by construction.
     *
     * `test/market-builder.test.ts` pins the direction against real fixture
     * orders so it cannot flip back silently.
     */
    isBuyer: boolean;
    /** The order's identity on the book. */
    nonce?: string | bigint;
    /**
     * The **option's** expiry, unix seconds.
     *
     * Not the same field as `rawApiData.orderExpiryTimestamp`, which is when
     * the *signature* goes stale — the frozen capture has 1788595200 against
     * 1788514414 on the same order. Levels are still grouped by the signature
     * expiry, as they always were, because that is what `/desk` prints; but
     * this is the one that names the contract, so it is the one a market slice
     * and an MM mark are matched on. Conflating them would join a chain
     * against a signature deadline and silently mark nothing.
     */
    expiry?: string | bigint;
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
    /**
     * The deployed option-implementation contract this order is an instance of.
     *
     * **This is the field that says what the product actually is** — see
     * `classifyOrder` and `docs/reviews/mcp-crosscheck.md` §BUG-2. The SDK
     * itself treats it as load-bearing: `buildContractOrder` refuses an order
     * whose implementation is the zero address, on the grounds that "the option
     * type is not deployed on this chain".
     */
    implementation?: string;
    /** Undocumented. Shape-checked at the boundary, never trusted. */
    greeks?: unknown;
  };
}

/** One entry of `chainConfig.optionImplementations`. `type` and `numStrikes`
 *  are widened from the SDK's literal unions so a fixture is assignable; only
 *  `name` is read. */
export interface RawImplementationInfo {
  /** UPPER_SNAKE `ProductName` — `RANGER`, `CALL_CONDOR`, `PHYSICAL_PUT`, … */
  name: string;
  type?: string;
  numStrikes?: number;
}

/** Just enough of `client.chainConfig` to resolve feeds, tokens, the book and
 *  what each order actually is. */
export interface RawChainConfig {
  priceFeeds: Record<string, string>;
  contracts: { optionBook: string | null };
  /** Keyed by symbol. Optional so a test's fake config can omit it; the real
   *  `ChainConfig` always has it. */
  tokens?: Record<string, { address: string; symbol: string; decimals: number }>;
  /**
   * Implementation address → product, **keyed by LOWERCASE address** (the
   * SDK's own doc comment on `ChainConfig.optionImplementations` says so, and
   * the 46 live keys are lowercase). This is the authoritative product registry
   * and the fix for BUG-2 — see `classifyOrder`.
   *
   * Optional because the frozen capture in `test/fixtures/orders.json` predates
   * our reading it and a test's fake config may omit it. When it is absent
   * `implementationInfo` falls through to the SDK's own copy of the same table.
   */
  optionImplementations?: Record<string, RawImplementationInfo>;
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
 * **`agreed: false` is not an amber chip. It means no fill is possible.**
 * `docs/reviews/mcp-crosscheck.md` §BUG-3: the SDK's `resolveOptionBookTarget`
 * throws `INVALID_ORDER` on every fill whose API-supplied book address differs
 * from the chain-configured one, so a disagreement is not a curiosity for an
 * operator to notice — it is the whole trade path being closed, and
 * `src/desk/fill.ts` step 7 refuses before approving anything.
 */
export interface OptionBookRef {
  /** The **chain-configured** address — the one the app should approve and
   *  submit to. See `resolveOptionBook`. */
  address: string;
  /** True when the chain config and the book's own orders name the same
   *  address (or when no order names one at all). False means fills against
   *  those orders will be refused. */
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
  /**
   * The asset gate, measured against **this** capture — `qualifiedAssets()`
   * from `src/data/qualify.ts`, run over the same raw response every other
   * field here was built from.
   *
   * It rides in the envelope rather than being recomputed in the browser for
   * two reasons, and the second is the load-bearing one:
   *
   *  1. Two of the four conditions are unanswerable after this builder runs —
   *     `availableAmount` has been aggregated into a display `size` string and
   *     `rawApiData.priceFeed` has been resolved to a symbol and discarded. The
   *     gate must read the raw capture, and the server is the only place that
   *     still holds it.
   *  2. It is measured **beside** the book it grades, at the same `at`. A
   *     second read to gate a first read's rows is two snapshots pretending to
   *     be one, which is how a lobby ends up offering an asset the blotter
   *     below it does not carry.
   *
   * `[]` is an ordinary answer, not an error: it is what a 404ing indexer, a
   * thin book, or a fixture with no depth all correctly produce. Note the
   * asymmetry with {@link underlyings} — that is "has a two-sided table to
   * draw", this is "can be dealt as a round", and the second is much stricter.
   */
  qualified: QualifiedAsset[];
  /**
   * The strike ladder's raw input, narrowed — see {@link ladderBook}.
   *
   * It rides here for the same reason {@link qualified} does, and the reason is
   * sharper in this case: the ladder's four inputs are *destroyed* by the
   * builder above. `rawApiData.strikes` is formatted into an `instrument`
   * string, `priceFeed` is resolved to a symbol and dropped, `order.expiry`
   * becomes a display label, and `availableAmount` is summed into a `size`. A
   * browser holding `OrderRow[]` has no way back to any of them, and
   * `src/data/box.ts` is pure and may not fetch.
   *
   * Unlike `qualified`, this is **not** a measurement — it is the book itself,
   * with the columns a ladder does not read taken out. Every judgement about it
   * (which expiries are still live, which strikes carry a fillable order, where
   * the rungs are) is made client-side by `deriveLadders(snap, at)`, against the
   * *browser's* clock, which is the only one that is current by the time an
   * arena is drawn.
   */
  ladder: LadderBook;
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
    /**
     * **The `"ETH" | "BTC"` here is the SDK's own signature, quoted, not our
     * gate.** It stays narrow, and this comment is why.
     *
     * ```ts
     * // node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts:7690
     * getPricingArray(underlying: 'ETH' | 'BTC'): Promise<MMVanillaPricing[]>;
     * ```
     *
     * `MarketClient` is a **structural mirror** of the real client, narrowed to
     * the members this file calls, and its job is to be a type the SDK's own
     * object satisfies. Widening this parameter would make the mirror claim the
     * vendor accepts arguments the vendor's `.d.ts` rejects — a fake client
     * would typecheck against a call the real one refuses at compile time.
     * That is a lie about someone else's API, which is worse than a narrow
     * type.
     *
     * **Contrast `src/desk/rfq.ts`, which widened for exactly the opposite
     * reason** (`docs/plan6-audit.md`, "The `rfq.ts` union"). There our field
     * was *narrower* than the SDK's `RFQUnderlying` — eight members,
     * `index.d.ts:3102` — so we were deciding what the venue sells. Here the
     * SDK decides, and it has decided two. `docs/plan6-audit.md` finding 1
     * recommends widening this to "the SDK's eight"; that recommendation
     * conflates two different declarations in the same file, and the line
     * numbers above are the check. The audit's §9 item 14 is nonetheless
     * satisfied by this comment rather than by a change: what it bans is an
     * *undocumented* union, and the ban exists because a hardcoded pair once
     * passed for a market.
     *
     * The **product** decision — that we ask only these two rather than all
     * eight price-feed assets — is `MM_UNDERLYINGS`, a value, where it can be
     * changed without misdescribing the vendor. And the gate that decides what
     * is playable is neither of them: it is `qualifiedAssets()`, which grades
     * on MM pricing and refuses to gate on it. `scripts/probe-assets.ts:256`'s
     * cast mirrors this signature and is likewise required by the SDK, not by
     * us; it stays.
     */
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
 * The rule, and the reason for it — **reversed** by
 * `docs/reviews/mcp-crosscheck.md` §BUG-3, and the old reasoning is left here
 * because it is instructive about how it went wrong. It read: "the order's own
 * `optionBookAddress` wins. An order is an EIP-712 signature over a specific
 * book contract; a fill submitted to any other address fails, whatever the
 * chain config says." Both sentences are true. The conclusion does not follow,
 * because the address in question is not part of the signature — it is a field
 * the *indexer* attached, and a compromised indexer is precisely the thing the
 * chain config is there to outrank.
 *
 * The SDK says so in its own words. `resolveOptionBookTarget`
 * (`dist/index.js:1561-1582`) accepts `rawApiData.optionBookAddress` only when
 * it equals the chain-configured OptionBook, "to prevent a compromised API from
 * redirecting fills to an attacker contract that drains pre-existing
 * allowances", and throws `INVALID_ORDER` otherwise.
 *
 * So: **the chain config is the authority** and the address returned here is
 * the one the app should approve and submit to. The book's own claim is the
 * thing being checked, and `agreed: false` means every fill against those
 * orders is refused (`src/desk/fill.ts` step 7) rather than merely noted.
 *
 * When no order carries an address there is nothing to disagree with, so
 * `agreed` is true. When the *config* carries none, the order's address is all
 * there is; it is reported so the desk can show something, and `fill.ts` still
 * refuses to approve against an address that reached it that way.
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
  if (!configured) return { address: fromOrders, agreed: false };
  return {
    address: configured,
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

/**
 * The structure a row describes. Finer than `PricingRow.type`, which only has
 * three members because `/desk` colours by it.
 *
 * `UNKNOWN` is the honest seventh member, added with the BUG-2 fix: a
 * four-strike row whose implementation address we cannot resolve is a condor
 * **or** an iron condor **or** a ranger, and nothing in the strikes decides
 * between them. Such a row is still quoted; it simply asserts nothing.
 */
export type Structure = "CALL" | "PUT" | "SPREAD" | "FLY" | "CONDOR" | "RANGER" | "UNKNOWN";

/**
 * The SDK's registry name → our structure. One direction of the same map
 * `productNameOf` walks the other way.
 *
 * Every name here is a real key of `chainConfig.optionImplementations` on Base
 * (15 distinct products over 46 addresses). A name that is *not* here — today,
 * only `CALL_LOAN`, which is a loan handler and not a book product — resolves
 * to `UNKNOWN` rather than to a guess.
 */
const PRODUCT_STRUCTURE: Record<string, Structure> = {
  LINEAR_CALL: "CALL",
  INVERSE_CALL: "CALL",
  PHYSICAL_CALL: "CALL",
  PUT: "PUT",
  PHYSICAL_PUT: "PUT",
  CALL_SPREAD: "SPREAD",
  INVERSE_CALL_SPREAD: "SPREAD",
  PUT_SPREAD: "SPREAD",
  CALL_FLY: "FLY",
  PUT_FLY: "FLY",
  CALL_CONDOR: "CONDOR",
  PUT_CONDOR: "CONDOR",
  IRON_CONDOR: "CONDOR",
  RANGER: "RANGER",
};

/**
 * Implementation address → the product it deploys, or `null`.
 *
 * Two sources, in order, and both are the same table:
 *
 *  1. `chainConfig.optionImplementations`, keyed by **lowercase** address —
 *     what the live client carries, and what the review names as the fix. It is
 *     preferred so that `buildSnapshot` stays a function of its arguments: hand
 *     it a config with the map and it answers from the map alone.
 *  2. The SDK's own `getOptionImplementationInfo(8453, address)`, which reads
 *     the identical 46-entry table out of `CHAIN_CONFIGS_BY_ID`. Consulted only
 *     when the config carries no map at all — a test fake, or the frozen
 *     capture in `test/fixtures/orders.json`, which was taken before we read
 *     this field and cannot be re-cut without a live book. A frozen constant is
 *     not a clock or a socket, so this costs the builder none of its purity.
 *
 * `null` means "no address, or an address neither table knows" — a deployment
 * newer than our installed SDK, which is a real thing that will happen, and the
 * only correct answer to it is "I do not know".
 */
export function implementationInfo(
  address: string | undefined,
  chainConfig: RawChainConfig,
): RawImplementationInfo | null {
  const key = String(address ?? "").toLowerCase();
  if (!key || /^0x0+$/.test(key)) return null;
  const fromConfig = chainConfig?.optionImplementations?.[key];
  if (fromConfig?.name) return fromConfig;
  if (chainConfig?.optionImplementations) return null;
  try {
    return getOptionImplementationInfo(CHAIN_ID, key);
  } catch {
    // `getOptionImplementationInfo` throws on an unsupported chain id. Ours is
    // a literal 8453, so this is unreachable — and a `catch` is still cheaper
    // than an unhandled throw inside a pure builder.
    return null;
  }
}

/**
 * Strikes → structure, **by counting alone**. The fallback, not the answer.
 *
 * The strike count really does carry the product for one, two and three strikes
 * (`Order.strikes` doc comment: 1 vanilla, 2 spread, 3 butterfly), and that part
 * is safe: `LINEAR_CALL`, `INVERSE_CALL` and `PHYSICAL_CALL` are all calls, and
 * all three take the same `PayoutType`, so flattening them to `CALL` mislabels
 * nothing that is spent on.
 *
 * **Four strikes is where counting stops working, and this function no longer
 * pretends otherwise.** It used to return `RANGER` for an ascending set with
 * equal outer widths and a gap in the middle, on the reasoning that an iron
 * condor has no equal-width rule. `docs/reviews/mcp-crosscheck.md` §BUG-2 shows
 * that reasoning is false of the *plain* condor: the SDK's own
 * `calculate_payout` tool description states the convention as
 * `call_condor/put_condor = [K1..K4] ASCENDING with K2-K1 === K4-K3`, which is
 * character for character the test we were using to exclude condors. And the
 * `validateRanger(...)` clause that looked like an independent cross-check was
 * not one: `validateCondor` and `validateRanger` accept the identical set
 * (`dist/index.js:16838`, `:16871`), so it restated our own arithmetic back to
 * us. Every symmetric condor on the book was being typed `RANGER`, coloured
 * `RANGER`, and given `payout: 'ranger'` — a wrong number waiting for the first
 * screen that prices off it.
 *
 * So four or more strikes now answers `UNKNOWN`. The row is still quoted; it
 * carries no structure claim and no payout type, which is what "we cannot tell
 * from here" looks like in the data. `classifyOrder` is the one that *can* tell,
 * and it does not count strikes at all.
 */
export function classify(strikes: readonly number[], isCall: boolean): Structure {
  const vanilla = isCall ? "CALL" : "PUT";
  if (strikes.length <= 1) return vanilla;
  if (strikes.length === 2) return "SPREAD";
  if (strikes.length === 3) return "FLY";
  return "UNKNOWN";
}

/** What one level's product resolved to, and whether anything authoritative
 *  said so. */
export interface StructureRead {
  structure: Structure;
  /** The SDK registry name (`RANGER`, `CALL_CONDOR`, `PHYSICAL_PUT`, …) when
   *  the implementation address decided it; `null` when it did not. */
  productName: string | null;
}

/**
 * What an order actually is — looked up, not guessed.
 *
 * `rawApiData.implementation` names a deployed contract, `optionImplementations`
 * maps that contract to a product, and the product's `name` is already the
 * UPPER_SNAKE `ProductName` key that `PAYOUT_TYPE` is keyed by. One lookup
 * replaces the whole four-clause heuristic, and it fixes more than the ranger
 * case: `PHYSICAL_CALL`, `PHYSICAL_PUT` and `INVERSE_CALL` used to be flattened
 * into `LINEAR_CALL` / `PUT` by the strike count.
 *
 * The heuristic survives as the fallback for a row whose implementation address
 * is missing or unrecognised, and its uncertainty is carried in the return
 * rather than hidden: `productName: null` and, for four strikes, `UNKNOWN`.
 */
export function classifyOrder(
  strikes: readonly number[],
  isCall: boolean,
  implementation: string | undefined,
  chainConfig: RawChainConfig,
): StructureRead {
  const info = implementationInfo(implementation, chainConfig);
  const structure = info ? PRODUCT_STRUCTURE[info.name] : undefined;
  if (info && structure) return { structure, productName: info.name };
  // Either no address, an address no table knows, or a known product that is
  // not a book option (`CALL_LOAN`). None of those is a licence to count
  // strikes and assert — but a one-, two- or three-strike row is still safely
  // decidable, so only the four-strike case actually loses its label.
  return { structure: classify(strikes, isCall), productName: null };
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

/**
 * Our `Structure` + the call/put flag → the SDK's registry name.
 *
 * `null` for `UNKNOWN`, which is the whole point of that member: there is no
 * registry name for "we could not resolve the implementation", and inventing
 * one would put the guess back where the lookup just removed it.
 *
 * This is the coarse direction. When `classifyOrder` resolved a real
 * implementation it hands back the exact `productName` and that is used
 * instead — `PHYSICAL_CALL` stays `PHYSICAL_CALL` rather than collapsing to
 * `LINEAR_CALL` on the way through here.
 */
export function productNameOf(structure: Structure, isCall: boolean): string | null {
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
    case "CONDOR":
      return isCall ? "CALL_CONDOR" : "PUT_CONDOR";
    case "UNKNOWN":
      return null;
  }
}

/**
 * The `PayoutType` a row should be priced with, or `null` when we do not know.
 *
 * This is the field that defuses the discriminator trap: `calculateMaxPayout` /
 * `calculatePayoutAtPrice` take an *order*, which carries no payout type, so a
 * ranger read off the book **silently prices as a condor** unless the caller
 * passes `isRanger: true`. `payout === "ranger"` on a row is exactly that flag,
 * decided once here rather than re-derived at each call site.
 *
 * `productName` is `classifyOrder`'s answer and wins when it has one: it is the
 * registry key straight off the chain's implementation table, so `PHYSICAL_PUT`
 * resolves to `put` without ever being flattened to `PUT`.
 *
 * **`null` is a first-class outcome and there is no longer a `?? "call"` behind
 * it.** The old fallback guessed a vanilla payout for anything the map missed;
 * after `docs/reviews/mcp-crosscheck.md` §BUG-2 that is exactly the shape of
 * mistake this file exists to stop. A row with no payout type is quoted and not
 * priced, which `src/views/Parlay.tsx` already renders (`unpriceable`).
 */
export function payoutTypeFor(
  structure: Structure,
  isCall: boolean,
  productName?: string | null,
): PayoutType | null {
  const name = productName ?? productNameOf(structure, isCall);
  return name === null ? null : (PAYOUT_TYPE[name] ?? null);
}

/**
 * THE conversion: a market-maker mark, priced in US dollars per contract.
 *
 * One function, called from the two places that need it — the desk's MM table
 * and the order-book join — so the multiplication that turns a venue price into
 * money exists exactly once in this repo. Everything downstream copies its
 * output and nothing recomputes it; `src/engine/score.ts` §Units is why that
 * matters.
 *
 * `markPrice` is quoted **in units of the underlying** (`tnuts-test/FINDINGS.md`
 * §1) and `underlyingPrice` is the spot **that same quote** was made against.
 * Multiplying the two is self-consistent by construction; multiplying by a spot
 * from `getMarketData().prices` would join two feeds read at two instants, and
 * the duel subtracts two of these numbers taken minutes apart.
 *
 * `markUsd: undefined` — never zero, never `"—"` — when either half is missing
 * or the spot is not strictly positive. A spot of zero would price every
 * contract at $0.00, which is a number and a wrong one, and a sentinel string
 * that parsed as a number is the failure the duel clock's reducer exists to
 * refuse. Absent means unmarkable means refunded, which is the safe direction.
 */
function pricedInUsd(
  markPrice: number,
  underlyingPrice: number | undefined,
): { spot: number | null; markUsd: string | undefined } {
  const spot =
    typeof underlyingPrice === "number" && underlyingPrice > 0 ? underlyingPrice : null;
  return {
    spot,
    markUsd:
      spot === null || !Number.isFinite(markPrice) ? undefined : (markPrice * spot).toFixed(4),
  };
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
    .map((r) => {
      const { spot, markUsd } = pricedInUsd(r.markPrice, r.underlyingPrice);
      return {
        ticker: r.ticker,
        type: r.isCall ? ("CALL" as const) : ("PUT" as const),
        strike: money(r.strike),
        expiry: expiryLabel(r.expiry),
        bid: r.feeAdjustedBid.toFixed(4),
        ask: r.feeAdjustedAsk.toFixed(4),
        mark: Number.isFinite(r.markPrice) ? r.markPrice.toFixed(4) : "—",
        // Carried so `markUsd` is auditable off the same row: a reader can
        // multiply the two printed numbers and get the third.
        spot: spot === null ? "—" : spot.toFixed(4),
        // The dollar price of one contract — see `MmQuote.markUsd` and
        // `pricedInUsd`, which is the only place the multiplication happens.
        markUsd,
        spread: (r.feeAdjustedAsk - r.feeAdjustedBid).toFixed(4),
      };
    });
}

/**
 * One side of one instrument, accumulated across every order quoting it.
 *
 * The book is one-sided per order — `isBuyer` says which, **inverted**: it is
 * the taker's side, so `isBuyer === true` is the maker's *ask*. See
 * `RawOrderEntry.order.isBuyer` for the measurement that settled it. Grouping
 * by instrument and keeping the best of each side is what turns a list of
 * orders into a bid/ask table.
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
  /**
   * The implementation address the orders in this level named, or `undefined`.
   *
   * A level is one instrument — same underlying, same call/put flag, same
   * strikes, same expiry — so every order in it should name the same
   * implementation. `conflicted` records the case where two did not, which is
   * not a thing that should happen and is therefore not a thing to average out:
   * a level whose own orders disagree about what product it is gets no product
   * claim at all.
   */
  implementation: string | undefined;
  conflicted: boolean;
  /**
   * The order behind `bestAsk` — the cheapest entry whose maker is *selling*.
   *
   * This is what makes a row pressable. A player buying a card fills an ask; a
   * level quoted by bids alone has a price on screen and nothing to fill, and
   * `cardsForSlice` refuses it for exactly that reason. Kept in step with
   * `bestAsk` so the order and the quoted price can never disagree.
   */
  askEntry: RawOrderEntry | undefined;
  /** The **option** expiry, unix seconds, from the first order that named one.
   *  Distinct from `expiry` above, which is the signature deadline. */
  optionExpiry: number | null;
}

/** `entry.order.expiry` as a number, or `null`. */
function optionExpiryOf(entry: RawOrderEntry): number | null {
  const raw = entry.order?.expiry;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * One market-maker quote, as the order book's own rows borrow it.
 *
 * The three fields travel together because they are one row's opinion of one
 * instrument, and splitting them is how both of plan 6's scoring defects
 * happened: a mark with no name cannot be looked up, and a mark with no spot
 * cannot be turned into money. A level joins all three or none.
 */
export interface MmMark {
  /** `ticker`, verbatim — the MM namespace, with the year. The key
   *  `src/server/attest.ts` builds its marks map on. */
  ticker: string;
  /** `markPrice`, verbatim, 4dp. In units of the underlying. */
  mark: string;
  /** `underlyingPrice`, verbatim — the spot this quote was made against. */
  spot?: string;
  /** `mark × spot`, US dollars per contract, 4dp. Absent when the quote
   *  published no spot. */
  markUsd?: string;
}

/**
 * `underlying|isCall|strike|optionExpiry` → the quote's name, mark and dollar
 * mark.
 *
 * The join that gives an order-book level a mark. Both feeds name the same
 * instrument and neither is a superset of the other: the MM chain has strikes
 * nobody is resting an order on, the resting book covers underlyings the MM
 * does not quote. Where they meet, the mark is the venue's own mid and the duel
 * clock (Phase C) can score against it; where they do not, the row carries no
 * mark and says so by absence.
 *
 * Keyed on the **option** expiry on both sides. `RawMmQuote.expiry` is an option
 * expiry, so matching it against a signature deadline would produce a map that
 * never hits — a silent, total failure that looks exactly like "the MM stopped
 * quoting".
 *
 * The strike is keyed at its 8dp integer value rather than as a float, so
 * `2650` off the chain and `2650.00000001` off a division cannot become two
 * different keys.
 *
 * It carries the quote's **name** as well as its price, and that is the fix for
 * plan 6's first scoring defect. Before it, a level got the mark's value and
 * nothing else, so a fill had no MM-namespace ticker to key the marks map by,
 * every filled leg was unmarkable and every duel refunded. The name is copied
 * off the same row as the number; nothing here composes one.
 *
 * It carries the quote's **spot** too, and that is the fix for the second. A
 * mark is in units of the underlying, a premium is USDC, and the only number
 * that can bridge them is the spot this very quote was made against — not
 * `getMarketData().prices`, which is a second feed read at a second instant and
 * would put the two sides of a subtraction on different clocks.
 */
export function markIndex(
  mmPricing: Record<string, readonly RawMmQuote[]> | undefined,
): Map<string, MmMark> {
  const out = new Map<string, MmMark>();
  for (const [underlying, rows] of Object.entries(mmPricing ?? {})) {
    for (const row of rows ?? []) {
      if (!Number.isFinite(row.strike) || !Number.isFinite(row.expiry)) continue;
      if (!Number.isFinite(row.markPrice)) continue;
      // A quote with no name is a quote nothing can be looked up by, so it is
      // not an entry at all — the same refusal `marksFromSnapshot` makes.
      if (typeof row.ticker !== "string" || !row.ticker.trim()) continue;
      const key = markKey(underlying, row.isCall, row.strike, row.expiry);
      // First writer wins: a duplicated (strike, expiry, side) row is the feed
      // contradicting itself, and averaging two marks would invent a third.
      if (out.has(key)) continue;
      // Name, mark, spot and dollar mark, all off THIS row. Written as one
      // object so a later edit cannot take three of the four from one quote and
      // the fourth from another.
      const { spot, markUsd } = pricedInUsd(row.markPrice, row.underlyingPrice);
      out.set(key, {
        ticker: row.ticker.trim(),
        mark: row.markPrice.toFixed(4),
        spot: spot === null ? undefined : spot.toFixed(4),
        markUsd,
      });
    }
  }
  return out;
}

function markKey(underlying: string, isCall: boolean, strike: number, expiry: number): string {
  return `${underlying}|${isCall}|${Math.round(strike * 10 ** PRICE_DECIMALS)}|${expiry}`;
}

/** Signed distance from the group median IV, or `undefined` with no greeks. */
function edgeOf(level: Level, medianIv: Map<string, number>): number | undefined {
  if (level.iv === null) return undefined;
  const median = medianIv.get(`${level.underlying}|${level.expiry}|${level.isCall}`);
  if (!median) return undefined;
  return +((level.iv - median) / median).toFixed(4);
}

// ─────────────────────────────────────────────────────────────────────────────
// The ladder's slice of the capture
// ─────────────────────────────────────────────────────────────────────────────

/** Total, non-throwing positive-integer read for `availableAmount`. Mirrors
 *  `hasSize` in `src/data/box.ts`, which is the reader this narrowing serves —
 *  the two must agree or the wire drops a rung the client would have kept. */
function fillable(raw: string | bigint | number | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  try {
    if (typeof raw === "bigint") return raw > 0n;
    if (typeof raw === "number") return Number.isFinite(raw) && raw > 0;
    return BigInt(String(raw).trim()) > 0n;
  } catch {
    return Number(raw) > 0;
  }
}

/**
 * The raw capture, narrowed to the strike ladder and nothing else.
 *
 * {@link LadderBook} carries the full accounting of what was dropped and what
 * it cost; this is the transformation. Two rules govern it:
 *
 *  1. **Field-for-field, no reshaping.** The result is structurally assignable
 *     to `LadderSnapshot` in `src/data/box.ts` with no adapter, so the browser
 *     calls `deriveLadder(snapshot, …)` on what came off the wire directly.
 *     Interning the repeated 42-character feed addresses would shave ~20% more
 *     and would cost exactly that property — the client would need a
 *     rehydration step, and a second shape of the same data is how the two
 *     start disagreeing.
 *  2. **Only structurally-empty orders are dropped.** No strikes, no fillable
 *     size, or a feed address `priceFeeds` does not name: none of the three can
 *     contribute a rung under any clock, so dropping them loses nothing and each
 *     is one line of `deriveLadders`' own filter, said here. Expiry is
 *     deliberately **not** judged — that needs a `now`, and the browser's is the
 *     current one.
 *
 * Pure and total, like everything else in this section: a truncated or garbage
 * capture yields fewer orders, never a throw.
 */
export function ladderBook(raw: RawMarket): LadderBook {
  const priceFeeds = raw.chainConfig?.priceFeeds ?? {};
  // By address, because that is how an order names its underlying and how
  // `feedIndex` collapses the `ETH`/`ETH/USD` alias on the far side.
  const known = new Set(
    Object.values(priceFeeds)
      .filter((a): a is string => typeof a === "string" && a !== "")
      .map((a) => a.toLowerCase()),
  );

  const orders: LadderBookOrder[] = [];
  for (const entry of raw.orders ?? []) {
    const api = entry?.rawApiData;
    if (!api) continue;
    if (!Array.isArray(api.strikes) || api.strikes.length === 0) continue;
    if (!fillable(entry.availableAmount)) continue;

    const priceFeed = typeof api.priceFeed === "string" ? api.priceFeed : "";
    if (!known.has(priceFeed.toLowerCase())) continue;

    const expiry = entry.order?.expiry;
    if (expiry === null || expiry === undefined) continue;

    const signature = api.orderExpiryTimestamp;
    orders.push({
      order: { expiry: String(expiry) },
      availableAmount: String(entry.availableAmount),
      rawApiData: {
        priceFeed,
        // Copied, not aliased: the wire object must not share an array with the
        // capture, or a later edit to one silently edits the other.
        strikes: api.strikes.map(String),
        ...(typeof signature === "number" && Number.isFinite(signature)
          ? { orderExpiryTimestamp: signature }
          : {}),
      },
    });
  }

  return { orders, chainConfig: { priceFeeds } };
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
    /**
     * **`isBuyer` is the TAKER's side, not the maker's.** See
     * `RawOrderEntry.order.isBuyer` for the measurement; the one-line version
     * is that `isBuyer === true` marks the orders a taker can *buy*, so it is
     * the maker's **ask**, and this line read `const isBid = entry.order.isBuyer`
     * until it was measured against the venue's own two-sided quotes.
     *
     * The two names below are kept apart on purpose, because they are opposite
     * by definition and collapsing them is what caused the inversion:
     *  - `takerBuys` — what the *player* would do. It labels `OrderRow.side`.
     *  - `isBid`     — what the *maker* is doing. It fills the bid/ask columns
     *                  and decides `askEntry`, the order a fill signs against.
     */
    const takerBuys = entry.order.isBuyer;
    const isBid = !takerBuys;

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
      implementation: api.implementation,
      conflicted: false,
      askEntry: undefined,
      optionExpiry: null,
    };
    if (level.optionExpiry === null) level.optionExpiry = optionExpiryOf(entry);

    // Two orders on the same instrument naming two different implementations
    // is a contradiction, not a tie to break. The level keeps the first and
    // remembers that it is no longer trustworthy.
    if (api.implementation && level.implementation === undefined) {
      level.implementation = api.implementation;
    } else if (
      api.implementation &&
      level.implementation &&
      api.implementation.toLowerCase() !== level.implementation.toLowerCase()
    ) {
      level.conflicted = true;
    }

    // Best bid is the highest someone will pay; best ask the lowest anyone
    // will take. The ask side additionally keeps the *order* behind it: that is
    // the thing a player fills, and a level that never sees an ask keeps
    // `askEntry: undefined` and is display-only for the rest of its life.
    if (isBid) level.bestBid = level.bestBid === null ? price : Math.max(level.bestBid, price);
    else if (level.bestAsk === null || price < level.bestAsk) {
      level.bestAsk = price;
      level.askEntry = entry;
    }

    level.size += available;
    if (level.delta === null) level.delta = greeks.delta;
    if (level.iv === null) level.iv = greeks.iv;
    levels.set(key, level);

    rows.push({
      // `takerBuys`, NOT `!isBid` — the blotter is written from the player's
      // seat, and this string is also half of a handshake: `orderIdentity` in
      // `src/desk/fill.ts` rebuilds it as `entry.order.isBuyer ? "BUY" : "SELL"`
      // and a fill matches only when the two agree. It was correct before the
      // line above was fixed and it is correct after, which is precisely why
      // the inversion was invisible on screen.
      side: takerBuys ? "BUY" : "SELL",
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

  // Built once, outside the level loop: the join is O(levels) against a map
  // rather than O(levels × quotes) against a list.
  const marks = markIndex(raw.mmPricing);

  const pricing: Record<string, PricingRow[]> = {};
  const ordered = new Map<string, Level[]>();
  const rowOf = new Map<Level, PricingRow>();
  for (const level of levels.values()) {
    // The MM quote this level joins, or none. Read once, so the name, the mark
    // and the dollar mark on the row below cannot come from different quotes —
    // three fields off one object is the invariant `MmMark` exists to hold.
    // A single-strike level only: a spread has no mark of its own on the MM
    // chain, and joining on its first strike would attach a vanilla's mark to
    // a two-leg product.
    const mm =
      level.strikes.length === 1 && level.optionExpiry !== null
        ? marks.get(markKey(level.underlying, level.isCall, level.strikes[0]!, level.optionExpiry))
        : undefined;
    const scale = maxByUnderlying.get(level.underlying) ?? 1;
    // Looked up from the implementation address, not inferred from the strikes
    // — `docs/reviews/mcp-crosscheck.md` §BUG-2. A conflicted level passes no
    // address at all, so it lands in the fallback like an unknown one.
    const read = classifyOrder(
      level.strikes,
      level.isCall,
      level.conflicted ? undefined : level.implementation,
      raw.chainConfig,
    );
    const structure = read.structure;
    const payout = payoutTypeFor(structure, level.isCall, read.productName);
    const row: PricingRow = {
      // `type` keeps its three-member union because `/desk` colours by it;
      // `structure` below is the truthful one. A four-strike order is called
      // RANGER only when the chain's own implementation table says the contract
      // behind it is the ranger implementation — never because four numbers
      // happened to be evenly spaced.
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
      // `"UNKNOWN"` when the implementation address was missing, unrecognised
      // or contradicted by the level's own orders. That string is the visible
      // form of "this row is quoted, and it claims nothing about its shape" —
      // `src/views/Parlay.tsx` counts rangers by `structure === "RANGER"`, so
      // an unresolved four-strike row is simply not one.
      structure,
      // Decided here, once, from the product the chain named — and it is what
      // makes a RANGER row *priceable* rather than merely quoted. SDK 0.3.0
      // ships real ranger payout math, so the plan's `PAYOFF UNAVAILABLE —
      // ranger math is on-chain only` branch is the unsupported one and is not
      // taken.
      //
      // `undefined` rather than a guessed vanilla payout when we could not
      // resolve the product: `Parlay.tsx` already reads a missing `payout` as
      // "unpriceable", and a payout type nothing authoritative backs is the
      // exact failure BUG-2 was.
      payout: payout ?? undefined,
      // `markPrice`, verbatim, where an MM quote names this exact instrument —
      // in units of the underlying, unlike the `bid`/`ask`/`mid` beside it.
      mark: mm?.mark,
      // The MM's own name for it, verbatim, and the dollar price of one
      // contract. All three from `mm`, so a row can never carry a name from one
      // quote and a price from another. Absent together when nothing joined;
      // `markUsd` additionally absent when the quote published no spot, which
      // leaves the row quotable and unscoreable — a real state, and the safe
      // one.
      markTicker: mm?.ticker,
      markUsd: mm?.markUsd,
      // The order behind the best ask — what pressing this row would fill. A
      // level with no ask carries none, and `cardsForSlice` drops it: a card
      // must be pressable or it must not be dealt.
      order: level.askEntry,
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
    // The gate reads `raw`, NOT the snapshot being returned around it — see
    // `QualifySnapshot`'s docblock for why that is the only order that works.
    // `RawMarket` is structurally assignable to `QualifySnapshot` with no
    // adapter and no cast, which `test/qualify.test.ts` pins at compile time.
    //
    // `at` is passed through so an order past its own `orderExpiryTimestamp`
    // stops counting toward depth: filling a stale order reverts `Signer Not
    // Authorized`, so an asset propped up by expired rows is not playable, and
    // this builder is the one place that knows what time the capture is from.
    // The purity rule survives — `at` is still an argument, never a clock.
    qualified: [...qualifiedAssets(raw, at)],
    // Also off `raw`, and for a stricter version of the same reason: the four
    // fields a ladder reads have all been consumed by the rows above. No `at`
    // here — this is the book, not a reading of it, and the clock that decides
    // which of it is still live belongs to the browser drawing the arena.
    ladder: ladderBook(raw),
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
