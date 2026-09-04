import type { OrderRow } from "../types.ts";

/**
 * The real fill: one resting Thetanuts order, bought with real USDC, on Base
 * mainnet.
 *
 * Everything else in this app is either seeded or read-only. This module is the
 * one place that spends money, so it is written the way a thing that spends
 * money should be written: the whole sequence is one function over an
 * **injected** `FillDeps`, so `test/fill.test.ts` drives every branch — the cap,
 * the ladder, the expiry buffer, the exact approval, all nine error codes —
 * without a chain, a wallet, or a network socket anywhere in reach.
 *
 * ## Three rules, and why each exists
 *
 * 1. **Opt-IN.** Nothing here runs unless `/api/config` says `features.trade`,
 *    which is `THETADUEL_TRADE=on` exactly (`index.ts`). Flag off, the desk
 *    renders the same DOM it rendered before this file existed — asserted, not
 *    asserted-by-hope, in `test/fill.test.ts`.
 * 2. **The cap is in the code, not only in the UI.** `MAX_FILL_USDC` is checked
 *    here, first, before a single dep is touched. A UI clamp is a suggestion; a
 *    check above the network is a bound. There is no testnet for Thetanuts
 *    (Base mainnet only), so the bound is the whole safety story for a demo.
 * 3. **Exact approvals, never `MaxUint256`.** `ensureAllowance` is called with
 *    the preview's own `totalCollateral` and nothing else. An infinite approval
 *    to a contract we did not write, from a wallet the owner uses, is a
 *    permanent liability in exchange for saving one transaction.
 *
 * ## The SDK is behind a dynamic import — and what that does and does not buy
 *
 * `@thetanuts-finance/thetanuts-client` pulls axios, viem and ethers. This file
 * names it in exactly three places, all inside the live adapter at the bottom,
 * all behind `await import()`. `runFill` itself imports nothing: it is
 * arithmetic, ordering and error mapping over functions it was handed, which is
 * why the test suite can drive every branch of it with no chain in reach.
 *
 * What the dynamic import buys, measured: **nothing executes** until an
 * operator has set `THETADUEL_TRADE=on` *and* a user has pressed a fill. No
 * client is constructed, no provider is opened, no RPC is called, and the whole
 * module is inert in `bun test`.
 *
 * What it does **not** currently buy, stated plainly rather than assumed:
 * `bun run build` is `bun build ./src/index.html` with no `--splitting`, and
 * Bun's HTML bundler inlines dynamic imports into the entry chunk when
 * splitting is off. Measured on this tree: 5.64 MB without the SDK, 6.50 MB
 * with it — so ~0.86 MB rides along beside AppKit's already-large bundle
 * instead of being fetched on demand. It is downloaded, never run. Adding
 * `--splitting` to the build script would make the deferral physical as well as
 * logical; that is a one-line change to `package.json`, which is outside this
 * phase's file set and is recorded for the gate rather than smuggled in here.
 *
 * ## Where the facts come from
 *
 * Every SDK claim below is read out of the installed `.d.ts` and recorded in
 * `tnuts-test/FINDINGS.md` §"0.3.0 delta", because the published docs contradict
 * the shipped code in ten verified places. The three that shape this sequence:
 *
 *  - `previewFillOrder(order, usdcAmount?, referrer?)` is **synchronous** and
 *    returns ten fields, not a Promise of two (`index.d.ts:1991`). So there is
 *    no loading state around the quote, and `await`ing it would be theatre.
 *  - `ensureAllowance(token, spender, amount)` returns
 *    `TransactionReceipt | null`, and **`null` is the success case** — "no
 *    approval was needed" (`index.d.ts:577`). Code that reads a falsy return as
 *    failure reports a phantom error on every fill after the first.
 *  - `fillOrder(order, usdcAmount?, referrer?)` returns a raw ethers
 *    `TransactionReceipt`, *not* the exported `FillOrderResult` type
 *    (`index.d.ts:2025`).
 */

// ─────────────────────────────────────────────────────────────────────────────
// The bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The hard notional cap: $2.00, USDC 6dp.
 *
 * Owner's number, and it is a *code* cap rather than a UI cap on purpose. There
 * is no Thetanuts testnet — the protocol is deployed on Base mainnet and an
 * Ethereum vaults-only deployment, nothing else — so every rehearsal of this
 * path spends real money. Two dollars is the most any bug in this file can cost
 * per press.
 */
export const MAX_FILL_USDC = 2_000000n;

/**
 * What a fill actually asks for: one cent.
 *
 * Partial fills by USDC amount are supported and no minimum is documented, so
 * the honest demo is the smallest amount that proves the path is real. The
 * receipt is the artifact; the size is deliberately not.
 */
export const TARGET_FILL_USDC = 10_000n;

/**
 * $0.01 → $0.10 → $1.00, tried in order.
 *
 * Book depth on Base swung from 426 resting orders to 130 inside one day, and a
 * maker whose remaining collateral cannot absorb a cent is an ordinary state,
 * not an error: `previewFillOrder` answers `numContracts === 0n` and no
 * transaction is attempted. Rather than failing the demo on dust, the fill
 * climbs one rung and re-previews. Every rung is under `MAX_FILL_USDC`, which is
 * re-checked per rung anyway — a ladder that could step over its own cap would
 * be a cap with a staircase next to it.
 */
export const FILL_LADDER: readonly bigint[] = [10_000n, 100_000n, 1_000_000n];

/**
 * How much life an order must have left before we will sign against it.
 *
 * The troubleshooting docs are explicit that filling a stale order reverts with
 * **"Signer Not Authorized"** — the maker's EIP-712 signature is no longer
 * valid, and the revert names the signer rather than the order, which is why it
 * reads as a wallet problem and is not one. A minute of headroom covers the
 * round trip from preview through approval to inclusion; anything tighter is a
 * race we would lose in public.
 */
export const EXPIRY_BUFFER_MS = 60_000;

/** Receipts get a link, because a hash nobody can open is not evidence. */
export const BASESCAN_TX = "https://basescan.org/tx/";

/** Base mainnet. The book is deployed here and nowhere the app can reach. */
export const BASE_CHAIN_ID = 8453 as const;

/** Public fallback. `RPC_URL` is server-only and secret; the browser gets the
 *  public endpoint, which throttles — hence `RATE_LIMIT` in the error map. */
export const PUBLIC_BASE_RPC = "https://mainnet.base.org";

/** `2^256 - 1`. Named only so a test can assert we never pass it. */
export const MAX_UINT256 = (1n << 256n) - 1n;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One resting signed order, loosened at the edges so a test fixture is
 * assignable and a JSON round trip survives (`bigint` widens to
 * `string | bigint`).
 *
 * `rawApiData` is real and load-bearing — DOC CONTRADICTION #10 in
 * `tnuts-test/FINDINGS.md`: the official docs describe these fields under an
 * `OrderWithSignature` heading, but the shipped types put them on `rawApiData`,
 * and `calculateMaxContracts`'s own `@param` says "Order with signature
 * containing rawApiData". Do not "fix" these reads to `entry.priceFeed`.
 */
export interface RawFillOrder {
  order: {
    price: string | bigint;
    /** True when the maker is the buyer — i.e. this order is a bid. */
    isBuyer: boolean;
    /** The order's identity on the book. */
    nonce?: string | bigint;
    /** The *option's* expiry, in seconds. Distinct from the order's own. */
    expiry?: string | bigint;
  };
  availableAmount?: string | bigint;
  signature?: string;
  makerAddress?: string;
  rawApiData?: {
    /** The **order** signature's expiry, seconds. This is the one that turns a
     *  fill into "Signer Not Authorized" when it passes. */
    orderExpiryTimestamp?: number;
    /** 8dp decimal strings. */
    strikes?: string[];
    isCall?: boolean;
    /** The OptionBook this order was signed for — the address that wins over
     *  any chain config or docs page, because the signature is over it. */
    optionBookAddress?: string;
    collateral?: string;
  };
}

/** `previewFillOrder`'s return, narrowed to the four fields this flow reads.
 *  It has ten; the other six are not decisions this file makes. */
export interface RawFillPreview {
  numContracts: bigint;
  totalCollateral: bigint;
  collateralToken: string;
  pricePerContract?: bigint;
}

/**
 * Which book row the user pressed.
 *
 * The plan says "re-fetch the order **by nonce**", and that is exactly what the
 * live adapter does *when it has one* — but the browser never receives a nonce.
 * `/api/market` ships `OrderRow`, which is display strings, because the SDK is
 * not in the client bundle and the envelope is drawn for a screen rather than
 * for a signer. So the reference the UI can actually hand over is the row's own
 * printed identity, and the fresh order's nonce is read back off the book and
 * reported on the receipt. The distinction matters in one direction only: an
 * ambiguous or missing match refuses to fill, which is the safe half.
 */
export interface OrderRef {
  /** Present when a caller genuinely holds one (the live adapter re-fetches by
   *  it in preference to everything else). */
  nonce?: string;
  /** `${side}|${DDMON}|${strike}|${C|P}|${px}` — see `rowIdentity`. */
  identity: string;
  /** Only for copy: `ETH-27SEP-4400-C`. Never used to match. */
  label: string;
}

/** What the user is asked to confirm, by clicking the number itself. */
export interface FillQuote {
  /** The rung of the ladder this quote is for, USDC 6dp. */
  usdcAmount: bigint;
  /** 18dp. */
  numContracts: bigint;
  /** 6dp for USDC — the **exact** amount approved, and the number clicked. */
  totalCollateral: bigint;
  /** The token the OptionBook will actually pull. Not always USDC: the live
   *  Base book is collateralised in four tokens at three decimal scales. */
  collateralToken: string;
}

export type FillStep =
  | "cap"
  | "signer"
  | "refetch"
  | "expiry"
  | "preview"
  | "confirm"
  | "allowance"
  | "fill"
  | "done";

/**
 * The nine ways a fill ends badly.
 *
 * Nine, and no tenth: a code the UI has no copy for is a spinner that never
 * resolves. `classifyFillError` maps every thrown thing onto one of these, and
 * `FILL_COPY` gives each a sentence and a recovery.
 */
export type FillCode =
  | "SIGNER_REQUIRED"
  | "ORDER_EXPIRED"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_ALLOWANCE"
  | "SIZE"
  | "SLIPPAGE"
  | "CONTRACT_REVERT"
  | "NETWORK"
  | "RATE_LIMIT";

/** What the panel offers the user next. One verb each; `none` draws no button. */
export type FillAction = "connect" | "switch" | "retry" | "refresh" | "fund" | "none";

export interface FillError {
  code: FillCode;
  /** One line, plain, in the panel. */
  message: string;
  /** What to do about it. */
  recovery: string;
  action: FillAction;
  /** The underlying message, trimmed — for the operator, not the player. */
  detail?: string;
  /** Set when the shape says a public RPC is throttling rather than a contract
   *  refusing. Carries `ALCHEMY_HINT` into the panel. */
  throttled?: boolean;
  /** Which step it died on. */
  step: FillStep;
}

export type FillOutcome =
  | {
      status: "filled";
      hash: string;
      /** BaseScan, ready to open. */
      explorer: string;
      quote: FillQuote;
      /** The nonce of the order that actually filled, when the book named one. */
      nonce: string | null;
      /** True when `ensureAllowance` returned `null` — i.e. the allowance was
       *  already sufficient and no approval transaction was sent. `null` is the
       *  SUCCESS case (FINDINGS "0.3.0 delta"); this field exists so the receipt
       *  can say "1 tx" or "2 tx" honestly. */
      approvalSkipped: boolean;
    }
  | { status: "cancelled" }
  | { status: "failed"; error: FillError };

/**
 * Every impure thing the fill needs, as parameters.
 *
 * This is the whole testability story. `runFill` cannot open a socket, cannot
 * find a wallet and cannot reach a contract; it can only call what it was
 * given, in the order it was written to call them, which is precisely what
 * `test/fill.test.ts` records and asserts.
 */
export interface FillDeps {
  /**
   * Which wallet tier is behind the signer. `"mock"` is refused before
   * `getSigner` is even called — see `runFill`.
   */
  walletId?: string;
  /**
   * The first-ever call site of `WalletSource.getSigner()` (`src/data/wallet.ts`
   * built it in wave 7 with zero callers).
   *
   * Its contract, which this sequence depends on: `null` means *not connected*,
   * a **throw** means connected-but-on-the-wrong-chain. Returning `null` for
   * the wrong chain would make the two indistinguishable here, and the recovery
   * differs — connect versus switch network.
   */
  getSigner(): Promise<unknown | null>;
  /** The book, re-read now. `null` means the order is gone. */
  refetchOrder(ref: OrderRef): Promise<RawFillOrder | null>;
  /** SYNCHRONOUS, and local: no RPC, no signer, no state (FINDINGS). */
  previewFillOrder(order: RawFillOrder, usdcAmount: bigint, referrer?: string): RawFillPreview;
  /** `null` return = SUCCESS ("no approval needed"), not failure. */
  ensureAllowance(token: string, spender: string, amount: bigint): Promise<unknown | null>;
  fillOrder(
    order: RawFillOrder,
    usdcAmount: bigint,
    referrer?: string,
  ): Promise<{ hash?: string } | null>;
  /**
   * The confirm-on-the-number gate.
   *
   * Resolving `true` means a human clicked the `totalCollateral` figure itself,
   * not a button beside it. That is the design's one deliberate friction: the
   * thing you press is the amount you spend.
   */
  confirm(quote: FillQuote): Promise<boolean>;
  /** Attribution on every fill. An un-whitelisted referrer's split is 0 bps —
   *  which is why this is threaded for attribution and never called revenue. */
  referrer?: string;
  /**
   * The chain's USDC address, when the caller knows it.
   *
   * A guard, not a config: the ladder is denominated in USDC 6dp, and the live
   * Base book also carries WETH- (18dp) and cbBTC-collateralised (8dp) orders.
   * "$0.01" against an 18-decimal collateral is not one cent, it is dust by a
   * factor of a trillion — or, with the decimal error the other way, not dust at
   * all. When this is set and the preview names a different token, the fill
   * refuses rather than guessing what the number meant.
   */
  usdc?: string;
  now?(): number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Throttling — ported from `tnuts-test/test.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The hint the probe script printed, kept verbatim in spirit.
 *
 * The public Base RPC throttles bursts, and retrying into a throttle is how a
 * demo turns one slow call into a minute of silence.
 */
export const ALCHEMY_HINT =
  "Public RPC https://mainnet.base.org is throttling. Do not retry blindly — " +
  "configure a private Base RPC endpoint on the server and reload.";

/**
 * Does this error look like the public RPC throttling rather than a contract
 * refusing?
 *
 * Ported from `tnuts-test/test.ts:39` and `tnuts-test/server.ts:31`, unchanged
 * in substance because the shape it detects is unchanged: ethers surfaces a
 * throttle as `CALL_EXCEPTION` **with no revert data**, which is otherwise
 * indistinguishable from a real revert. The cause chain is walked two deep
 * because the SDK wraps ethers and ethers wraps the transport.
 */
export function looksThrottled(error: unknown): boolean {
  const seen: unknown[] = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 3 && cursor; depth++) {
    seen.push(cursor);
    cursor = (cursor as { cause?: unknown })?.cause;
  }
  return seen.some((e) => {
    const code = (e as { code?: unknown })?.code;
    if (code === "CALL_EXCEPTION" || code === "RATE_LIMIT" || code === "SERVER_ERROR") return true;
    const message = String((e as { message?: unknown })?.message ?? "");
    return /missing revert data|could not coalesce|429|rate ?limit|too many requests/i.test(message);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The error map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One sentence and one recovery per code.
 *
 * Written for a player standing in front of a projector, which is why none of
 * it says "an error occurred": every line names what happened to *their money*
 * (nothing, in eight of the nine cases) and what to press next.
 */
export const FILL_COPY: Record<FillCode, { message: string; recovery: string; action: FillAction }> = {
  SIGNER_REQUIRED: {
    message: "No wallet can sign this.",
    recovery: "Connect a wallet on Base, then press the amount again.",
    action: "connect",
  },
  ORDER_EXPIRED: {
    message: "That order is no longer on the book.",
    recovery:
      "Nothing was spent. The book re-reads every 30s — pick a row that is still quoting. " +
      'A stale order reverts as "Signer Not Authorized", which is the maker\'s signature ' +
      "aging out, not a problem with your wallet.",
    action: "refresh",
  },
  INSUFFICIENT_BALANCE: {
    message: "The wallet does not hold enough collateral.",
    recovery: "Fund it with a few dollars of USDC on Base and try again. Nothing was spent.",
    action: "fund",
  },
  INSUFFICIENT_ALLOWANCE: {
    message: "The approval did not take.",
    recovery:
      "Press the amount again — the approval is re-sent for the exact collateral, never an " +
      "unlimited one.",
    action: "retry",
  },
  SIZE: {
    message: "The book will not absorb this notional.",
    recovery:
      "The ladder already tried $0.01, $0.10 and $1.00 against this maker's remaining " +
      "collateral. Pick a deeper row; the greyed ones will not fill at any size.",
    action: "refresh",
  },
  SLIPPAGE: {
    message: "The price moved before the fill landed.",
    recovery: "Re-preview and confirm again. Nothing was spent.",
    action: "retry",
  },
  CONTRACT_REVERT: {
    message: "The OptionBook rejected the fill.",
    recovery: "Beyond gas, nothing was spent. Try another row.",
    action: "refresh",
  },
  NETWORK: {
    message: "The call never completed.",
    recovery: "Check the connection and press the amount again.",
    action: "retry",
  },
  RATE_LIMIT: {
    message: "The Base RPC is throttling.",
    recovery: ALCHEMY_HINT,
    action: "retry",
  },
};

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

/**
 * Anything thrown → one of nine codes.
 *
 * **Order matters, and the first two tests are the subtle ones.** The contract's
 * stale-order revert is the string `"Signer Not Authorized"`, and the SDK's
 * "you built me without a signer" error is the code `SIGNER_REQUIRED`. They read
 * almost identically and mean opposite things: the first is an order that aged
 * out (reconnecting the wallet will never fix it), the second is a wallet that
 * is not there (refreshing the book will never fix it). Testing the contract
 * string first is what keeps the recovery copy pointed at the right problem.
 */
export function classifyFillError(error: unknown, step: FillStep): FillError {
  const detail = detailOf(error);
  const code = (error as { code?: unknown })?.code;
  const text = `${String(code ?? "")} ${detail}`;
  const throttled = looksThrottled(error);

  const at = (c: FillCode, over?: Partial<FillError>): FillError => ({
    code: c,
    ...FILL_COPY[c],
    detail,
    step,
    ...(throttled ? { throttled: true } : {}),
    ...over,
  });

  // The stale-order revert, first, before anything matches on "signer".
  if (/signer\s+not\s+authorized|invalid\s+signature|order\s+(is\s+)?(expired|filled|cancelled)/i.test(text))
    return at("ORDER_EXPIRED");
  if (/SIGNER_REQUIRED|no signer|signer is required|unknown account/i.test(text))
    return at("SIGNER_REQUIRED");
  if (/ORDER_EXPIRED|INVALID_ORDER|expired/i.test(text)) return at("ORDER_EXPIRED");

  // Throttling before the generic network bucket: `CALL_EXCEPTION` with no
  // revert data would otherwise be read as a contract revert, and the recovery
  // for those two is completely different.
  if (throttled && !/execution reverted/i.test(text)) return at("RATE_LIMIT");

  if (/insufficient allowance|allowance/i.test(text)) return at("INSUFFICIENT_ALLOWANCE");
  if (/insufficient (funds|balance)|exceeds balance|transfer amount exceeds/i.test(text))
    return at("INSUFFICIENT_BALANCE");
  if (/slippage|price moved|INSUFFICIENT_OUTPUT|min(imum)? (amount|out)/i.test(text))
    return at("SLIPPAGE");
  if (/INVALID_PARAMS|too small|dust|numContracts|amount (is )?zero|size/i.test(text))
    return at("SIZE");
  if (/NETWORK_ERROR|TIMEOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timeout/i.test(text))
    return at("NETWORK");

  // Everything left died against the chain. Defaulting here rather than to
  // NETWORK is deliberate: an unknown failure at the fill step is far more
  // likely a revert we have not seen than a socket, and the revert copy is the
  // one that says "nothing was spent beyond gas".
  return at("CONTRACT_REVERT");
}

/** A code raised by this module rather than caught from below. */
function raise(code: FillCode, step: FillStep, over?: Partial<FillError>): FillOutcome {
  return { status: "failed", error: { code, ...FILL_COPY[code], step, ...over } };
}

// ─────────────────────────────────────────────────────────────────────────────
// Row ↔ order identity
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** `1788457967` → `"4SEP"`, matching the middle segment of an instrument name. */
function stamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${d.getUTCDate()}${MONTHS[d.getUTCMonth()]}`;
}

function units(raw: string | bigint, decimals: number): number {
  return Number(BigInt(raw)) / 10 ** decimals;
}

/**
 * A book row's identity, parsed back out of what the server printed.
 *
 * `src/server/thetanuts.ts` builds `instrument` as
 * `${underlying}-${DDMON}-${strike0}-${C|P}` and `px` as the 8dp price at 4
 * decimals. Those five facts — side, date, first strike, call/put, price — are
 * enough to name one order on a book of a few hundred, and every one of them is
 * derivable from a raw order without a price-feed symbol map (which the browser
 * does not have and should not fetch a megabyte of SDK to obtain).
 *
 * `null` for anything that does not parse, which is the correct answer for the
 * mock's rows (`ETH-27SEP-RANGER` has three segments, not four): **the seeded
 * book is not fillable, by construction**, and that falls out of the parser
 * rather than out of a flag someone has to remember to set.
 *
 * If this derivation and the server's formatter ever drift, every fill fails
 * closed with `ORDER_EXPIRED` — no order matches, so nothing is signed. That is
 * the one direction a mismatch is allowed to fail in.
 */
export function rowIdentity(row: OrderRow): string | null {
  const parts = row.instrument.split("-");
  if (parts.length !== 4) return null;
  const [, date, strike, cp] = parts as [string, string, string, string];
  if (cp !== "C" && cp !== "P") return null;
  if (!/^\d+$/.test(strike)) return null;
  return `${row.side}|${date}|${strike}|${cp}|${row.px}`;
}

/** The same identity, computed from a raw order off the live book. */
export function orderIdentity(entry: RawFillOrder): string | null {
  const api = entry.rawApiData ?? {};
  const strikes = api.strikes ?? [];
  const first = strikes[0];
  const expiry = api.orderExpiryTimestamp;
  if (first === undefined || expiry === undefined) return null;
  const side = entry.order.isBuyer ? "BUY" : "SELL";
  return [
    side,
    stamp(expiry),
    units(first, 8).toFixed(0),
    api.isCall ? "C" : "P",
    units(entry.order.price, 8).toFixed(4),
  ].join("|");
}

/** The reference a UI hands to `runFill` for one row, or `null` if the row is
 *  not a live book row at all. */
export function refFor(row: OrderRow): OrderRef | null {
  const identity = rowIdentity(row);
  return identity === null ? null : { identity, label: row.instrument };
}

// ─────────────────────────────────────────────────────────────────────────────
// Freezing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The order, frozen the instant it arrives.
 *
 * An order is an **EIP-712 signature over its own fields**. Change one — round
 * a price, normalise an address, sort the strikes "helpfully" — and the
 * signature no longer recovers to the maker, the OptionBook rejects the fill,
 * and the revert says `Signer Not Authorized`, which points the operator at
 * their wallet instead of at the mutation. Freezing turns that silent,
 * misdirecting failure into a `TypeError` at the line that did it.
 *
 * Frozen three levels deep because that is how deep the mutable parts go: the
 * envelope, `order`, `rawApiData`, and the `strikes` array inside it.
 */
export function freezeOrder<T extends RawFillOrder>(order: T): Readonly<T> {
  if (order.rawApiData?.strikes) Object.freeze(order.rawApiData.strikes);
  if (order.rawApiData) Object.freeze(order.rawApiData);
  Object.freeze(order.order);
  return Object.freeze(order);
}

// ─────────────────────────────────────────────────────────────────────────────
// The sequence
// ─────────────────────────────────────────────────────────────────────────────

/** Seconds → ms, tolerating the three encodings an expiry arrives in. */
function expiryMs(order: RawFillOrder): number | null {
  const raw = order.rawApiData?.orderExpiryTimestamp ?? order.order.expiry;
  if (raw === undefined || raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/** The rungs at or above `from`, capped. */
function ladderFrom(from: bigint): bigint[] {
  const rungs = FILL_LADDER.filter((r) => r > from && r <= MAX_FILL_USDC);
  return [from, ...rungs];
}

/**
 * Buy one option, for real.
 *
 * **This never throws.** Every exit is a `FillOutcome`, because a rejected
 * promise on this path is a spinner that spins forever on a screen someone is
 * presenting from.
 *
 * The sequence, in the order the plan fixes it and the order the test asserts:
 *
 *  1. `cap`       — the notional is sane and under `MAX_FILL_USDC`. **Before any
 *                   dep is touched**, so an over-cap amount cannot even reach a
 *                   network call, let alone a signature.
 *  2. `signer`    — `getSigner()`. `null` → connect; a throw → wrong chain.
 *                   The mock wallet is refused above this line entirely.
 *  3. `refetch`   — the order, read again from the book right now. The snapshot
 *                   on screen is up to 15s old and the book moves; signing
 *                   against the stale copy is the "Signer Not Authorized" path.
 *  4. `expiry`    — at least `EXPIRY_BUFFER_MS` of signature life left.
 *  5. `preview`   — synchronous, local, and climbs the dust ladder until the
 *                   maker's remaining collateral will absorb something.
 *  6. `confirm`   — a human clicks the `totalCollateral` figure.
 *  7. `allowance` — **exactly** that figure. Never `MaxUint256`.
 *  8. `fill`      — `fillOrder(frozen order, amount, referrer)`.
 *  9. `done`      — receipt + BaseScan.
 */
export async function runFill(
  ref: OrderRef,
  usdcAmount: bigint,
  deps: FillDeps,
  onStep: (step: FillStep, info?: { quote?: FillQuote; hash?: string }) => void = () => {},
): Promise<FillOutcome> {
  const now = deps.now ?? (() => Date.now());

  // ── 1. cap ────────────────────────────────────────────────────────────────
  // Nothing above this line touches `deps`. That is the property the test
  // "cap-before-network" pins, and it is the reason the cap is here rather than
  // in the panel: a UI clamp is a suggestion to a caller, this is a bound.
  onStep("cap");
  if (typeof usdcAmount !== "bigint" || usdcAmount <= 0n) {
    return raise("SIZE", "cap", { message: "A fill needs a positive amount." });
  }
  if (usdcAmount > MAX_FILL_USDC) {
    return raise("SIZE", "cap", {
      message: `This build will not fill more than $${usdText(MAX_FILL_USDC)}.`,
      recovery:
        "MAX_FILL_USDC is a code cap, not a form validation — Thetanuts has no testnet, so " +
        "every rehearsal spends real money and the bound lives above the network call.",
      action: "none",
    });
  }

  // ── 2. signer ─────────────────────────────────────────────────────────────
  onStep("signer");

  // The mock wallet is inert, and is refused BEFORE `getSigner` is called.
  // Its `getSigner` throws when connected (`src/wallet/mock.ts`) — deliberately,
  // because handing back something signable that reverts is the worse failure —
  // and a throw is this sequence's signal for "wrong network". Left to the
  // generic path, a demo on the mock tier would be told to switch to Base while
  // already on Base, forever. P6 holds the same line for staking: the mock never
  // approves and never fills.
  if (deps.walletId === "mock") {
    return raise("SIGNER_REQUIRED", "signer", {
      message: "The mock wallet cannot sign — and must not.",
      recovery:
        "Install a browser wallet, or set WALLETCONNECT_PROJECT_ID, and reload. The mock is " +
        "the fallback that keeps the app playable with no wallet at all; it never touches money.",
      action: "connect",
    });
  }

  let signer: unknown | null;
  try {
    signer = await deps.getSigner();
  } catch (error) {
    // Connected, wrong chain. `WalletSource.getSigner` throws rather than
    // returning `null` for exactly this case, so the two recoveries stay
    // distinguishable (`src/data/wallet.ts`).
    return {
      status: "failed",
      error: {
        ...classifyFillError(error, "signer"),
        code: "SIGNER_REQUIRED",
        message: "The wallet is not on Base.",
        recovery: "Switch the wallet to Base mainnet (8453) and press the amount again.",
        action: "switch",
      },
    };
  }
  if (!signer) return raise("SIGNER_REQUIRED", "signer");

  // ── 3. refetch ────────────────────────────────────────────────────────────
  onStep("refetch");
  let fresh: RawFillOrder | null;
  try {
    fresh = await deps.refetchOrder(ref);
  } catch (error) {
    return { status: "failed", error: classifyFillError(error, "refetch") };
  }
  if (!fresh) return raise("ORDER_EXPIRED", "refetch");

  // Frozen on arrival, not at the call site: between here and `fillOrder` the
  // object passes through a preview, a confirm the user can sit on for a minute
  // and an approval transaction, and any of those is a place a later edit could
  // "normalise" a field and invalidate the maker's signature.
  const order = freezeOrder(fresh);

  // ── 4. expiry ─────────────────────────────────────────────────────────────
  onStep("expiry");
  const expiresAt = expiryMs(order);
  if (expiresAt !== null && expiresAt - now() < EXPIRY_BUFFER_MS) {
    return raise("ORDER_EXPIRED", "expiry", {
      message: "That order expires within the minute.",
    });
  }

  // ── 5. preview + the dust ladder ──────────────────────────────────────────
  onStep("preview");
  let quote: FillQuote | null = null;
  let lastPreviewError: unknown = null;
  for (const rung of ladderFrom(usdcAmount)) {
    if (rung > MAX_FILL_USDC) break;
    try {
      // Synchronous. No await, no loading state: it is arithmetic over an order
      // we already hold (FINDINGS "0.3.0 delta" — the docs' two-field, async
      // description is wrong twice over).
      const preview = deps.previewFillOrder(order, rung, deps.referrer);
      if (preview.numContracts > 0n) {
        quote = {
          usdcAmount: rung,
          numContracts: preview.numContracts,
          totalCollateral: preview.totalCollateral,
          collateralToken: preview.collateralToken,
        };
        break;
      }
    } catch (error) {
      // One rung throwing is not the end of the ladder — `ORDER_EXPIRED` /
      // `INVALID_ORDER` come back from orders the indexer is still serving.
      lastPreviewError = error;
    }
  }
  if (!quote) {
    if (lastPreviewError) {
      return { status: "failed", error: classifyFillError(lastPreviewError, "preview") };
    }
    return raise("SIZE", "preview");
  }

  // The decimals guard. The ladder is USDC 6dp; this book is collateralised in
  // four tokens at three scales, and "$0.01" against 18-decimal WETH is not a
  // cent by twelve orders of magnitude. Refuse rather than guess.
  if (deps.usdc && quote.collateralToken.toLowerCase() !== deps.usdc.toLowerCase()) {
    return raise("SIZE", "preview", {
      message: "That order is not collateralised in USDC.",
      recovery:
        "The $0.01 → $1.00 ladder is USDC-denominated (6 decimals). This maker wants a " +
        "different token at a different decimal scale, so the same number would mean a " +
        "different amount. Pick a USDC row.",
      action: "refresh",
    });
  }

  // ── 6. confirm, on the number itself ──────────────────────────────────────
  onStep("confirm", { quote });
  let confirmed = false;
  try {
    confirmed = await deps.confirm(quote);
  } catch (error) {
    return { status: "failed", error: classifyFillError(error, "confirm") };
  }
  if (!confirmed) return { status: "cancelled" };

  // ── 7. allowance, exact ───────────────────────────────────────────────────
  onStep("allowance");
  // The spender is the book **the order was signed for**, read off the order
  // itself. Two official doc pages disagree about the Base OptionBook address
  // and the chain config is only a cross-check: a fill submitted to any other
  // address fails whatever a docs page says.
  const spender = order.rawApiData?.optionBookAddress ?? "";
  if (!spender) {
    return raise("CONTRACT_REVERT", "allowance", {
      message: "That order does not name an OptionBook.",
      recovery:
        "An order is a signature over one book contract. Without the address there is nothing " +
        "safe to approve, so the fill stops here.",
      action: "refresh",
    });
  }
  let approvalSkipped = false;
  try {
    // EXACTLY `totalCollateral`. Never `MaxUint256`, never a rounded-up
    // convenience amount, never a cached "already approved plenty".
    const receipt = await deps.ensureAllowance(
      quote.collateralToken,
      spender,
      quote.totalCollateral,
    );
    // `null` is the SUCCESS case: the allowance was already sufficient and no
    // approval transaction was needed (`index.d.ts:577`, FINDINGS). Reading a
    // falsy return as failure would report a phantom error on every fill after
    // the first — which is the second fill of the demo.
    approvalSkipped = receipt === null || receipt === undefined;
  } catch (error) {
    return { status: "failed", error: classifyFillError(error, "allowance") };
  }

  // ── 8. fill ───────────────────────────────────────────────────────────────
  onStep("fill");
  let receipt: { hash?: string } | null;
  try {
    receipt = await deps.fillOrder(order, quote.usdcAmount, deps.referrer);
  } catch (error) {
    return { status: "failed", error: classifyFillError(error, "fill") };
  }

  const hash = receipt?.hash ?? "";
  if (!hash) {
    // A fill with no hash is a fill we cannot evidence. It may well have landed,
    // so the copy must not claim otherwise.
    return raise("CONTRACT_REVERT", "fill", {
      message: "The fill returned no transaction hash.",
      recovery: "Check the wallet's activity before retrying — the transaction may have landed.",
      action: "none",
    });
  }

  // ── 9. done ───────────────────────────────────────────────────────────────
  onStep("done", { hash });
  return {
    status: "filled",
    hash,
    explorer: `${BASESCAN_TX}${hash}`,
    quote,
    nonce: order.order.nonce === undefined ? null : String(order.order.nonce),
    approvalSkipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting (shared by the panel so the number confirmed is the number shown)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * USDC 6dp → `"0.01"`, `"0.00995"`, `"2.00"`.
 *
 * Integer arithmetic, not `Number`: this renders the figure the user clicks and
 * the figure that is then approved *exactly*, so the two must be the same
 * number. `(9_950n / 1e6).toFixed(4)` is `"0.0100"` — a hundredth of a dollar
 * displayed for something that is not one. At least two decimals so a whole
 * amount still reads as money; more only when there is more to say.
 */
export function usdText(amount: bigint): string {
  const sign = amount < 0n ? "-" : "";
  const abs = amount < 0n ? -amount : amount;
  const whole = abs / 1_000000n;
  const frac = (abs % 1_000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}.${frac.length <= 2 ? frac.padEnd(2, "0") : frac}`;
}

/** 18dp contracts → `"0.0123"`. */
export function contracts(amount: bigint): string {
  return units(amount, 18).toFixed(4);
}

/** `SPLIT 0 bps — not yet whitelisted`. Attribution, never revenue. */
export function splitLabel(bps: bigint | null): string {
  if (bps === null) return "SPLIT — unread";
  return bps === 0n ? "SPLIT 0 bps — not yet whitelisted" : `SPLIT ${bps} bps`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The live adapter — the only place the SDK is named in client code
// ─────────────────────────────────────────────────────────────────────────────

/** Just the wallet seam the fill needs, so this module does not import the
 *  whole `WalletSource` surface (and so a test can pass two functions). */
export interface FillWallet {
  readonly id: string;
  getSigner(): Promise<unknown | null>;
}

/**
 * `FillDeps` wired to the real Thetanuts client, in the browser, next to the
 * wallet.
 *
 * **The dynamic `import()` is the point** — for evaluation, not for bytes. A
 * static import would construct the SDK's module graph on first paint of a page
 * that mostly draws a blotter; this way nothing in it runs until an operator has
 * set `THETADUEL_TRADE=on` *and* someone has pressed a fill. The bytes are a
 * separate question and the module header answers it honestly: without
 * `--splitting` in the build script they are in the entry chunk regardless.
 *
 * The client is built **lazily, after the signer arrives**, because
 * `ThetanutsClient` takes the signer at construction and the signer is step 2 of
 * the sequence. Hence the closure state: `getSigner` is what materialises the
 * client that the later steps use.
 */
export function createLiveFillDeps(
  wallet: FillWallet,
  options: { referrer?: string } = {},
): FillDeps {
  /** Set by `getSigner`; every later dep reads it. */
  let book: {
    previewFillOrder(o: unknown, a?: bigint, r?: string): RawFillPreview;
    fillOrder(o: unknown, a?: bigint, r?: string): Promise<{ hash?: string }>;
  } | null = null;
  let erc20: {
    ensureAllowance(t: string, s: string, a: bigint): Promise<unknown | null>;
  } | null = null;
  let usdcAddress: string | undefined;

  return {
    walletId: wallet.id,
    referrer: options.referrer,
    // A getter, not a value: the address is read off `chainConfig`, the client
    // is not built until the signer lands at step 2, and the guard that reads it
    // runs at step 5.
    get usdc() {
      return usdcAddress;
    },

    async getSigner() {
      const signer = await wallet.getSigner();
      if (!signer) return null;

      const { ThetanutsClient } = await import("@thetanuts-finance/thetanuts-client");
      const { JsonRpcProvider } = await import("ethers");
      // A signer from a browser wallet carries its own provider; the public
      // endpoint is the fallback and is the reason `RATE_LIMIT` exists in the
      // error map at all.
      const provider =
        (signer as { provider?: unknown }).provider ?? new JsonRpcProvider(PUBLIC_BASE_RPC);
      const client = new ThetanutsClient({
        chainId: BASE_CHAIN_ID,
        // The SDK's ethers types and ours are the same package at the same
        // major; the cast is here because `signer` crosses the wallet seam as
        // `unknown` on purpose — `src/data/wallet.ts` must not drag ethers into
        // every view that touches a wallet.
        provider: provider as never,
        signer: signer as never,
        referrer: options.referrer,
      });
      book = client.optionBook as never;
      erc20 = client.erc20 as never;
      usdcAddress = client.chainConfig?.tokens?.USDC?.address;
      return signer;
    },

    async refetchOrder(ref) {
      // Step 2 runs before step 3, so a missing book here means the sequence was
      // driven out of order — a programming error, raised as the code whose
      // recovery ("connect a wallet") is at least not misleading.
      if (!book) throw new Error("SIGNER_REQUIRED");
      const { ThetanutsClient } = await import("@thetanuts-finance/thetanuts-client");
      const { JsonRpcProvider } = await import("ethers");
      // A read-only client for the book read: `fetchOrders` needs no signer, and
      // asking the signing client to do it would put a wallet in the path of a
      // plain GET.
      const reader = new ThetanutsClient({
        chainId: BASE_CHAIN_ID,
        provider: new JsonRpcProvider(PUBLIC_BASE_RPC) as never,
      });
      const orders = (await reader.api.fetchOrders()) as unknown as readonly RawFillOrder[];

      // By nonce when we have one — that is the plan's rule and the book's own
      // identity field. Otherwise by the row's printed identity, which is all
      // the display envelope carries (see `OrderRef`).
      if (ref.nonce) {
        const byNonce = orders.filter((o) => String(o.order.nonce ?? "") === ref.nonce);
        return byNonce.length === 1 ? (byNonce[0] as RawFillOrder) : null;
      }
      const matches = orders.filter((o) => orderIdentity(o) === ref.identity);
      // Exactly one, or none. Two orders that print identically are two orders,
      // and picking one of them for the user is a decision this code has no
      // basis to make.
      return matches.length === 1 ? (matches[0] as RawFillOrder) : null;
    },

    previewFillOrder(order, usdcAmount, referrer) {
      if (!book) throw new Error("SIGNER_REQUIRED");
      return book.previewFillOrder(order, usdcAmount, referrer);
    },

    async ensureAllowance(token, spender, amount) {
      if (!erc20) throw new Error("SIGNER_REQUIRED");
      return erc20.ensureAllowance(token, spender, amount);
    },

    async fillOrder(order, usdcAmount, referrer) {
      if (!book) throw new Error("SIGNER_REQUIRED");
      return book.fillOrder(order, usdcAmount, referrer);
    },

    // Replaced by the panel: the real gate is a click on the number.
    async confirm() {
      return false;
    },
  };
}

/**
 * The referrer's fee split, in basis points.
 *
 * Read-only and signer-free, so the desk footer can state the truth without a
 * wallet: `0n` is the expected answer until Thetanuts whitelists the address,
 * and `splitLabel` renders that as `SPLIT 0 bps — not yet whitelisted`. It is
 * **attribution, not revenue** — every fill is provably ours, and none of it
 * pays us anything yet.
 *
 * `null` on any failure. A footer chip is not worth an error state.
 */
export async function readReferrerSplit(referrer: string): Promise<bigint | null> {
  if (!referrer) return null;
  try {
    const { ThetanutsClient } = await import("@thetanuts-finance/thetanuts-client");
    const { JsonRpcProvider } = await import("ethers");
    const client = new ThetanutsClient({
      chainId: BASE_CHAIN_ID,
      provider: new JsonRpcProvider(PUBLIC_BASE_RPC) as never,
    });
    return await client.optionBook.getReferrerFeeSplit(referrer);
  } catch {
    return null;
  }
}

/**
 * Claim whatever the referrer address has accrued, across every collateral
 * token.
 *
 * `claimAllFees(address?)` defaults to the **signer's** address, and our
 * referrer is not necessarily the connected wallet — so it is always passed
 * explicitly (FINDINGS). It claims sequentially, one write per token, and
 * partial failure is normal: `ClaimFeeResult` carries `receipt` *and* `error`
 * per token and the caller is expected to read both. At a 0 bps split there is
 * nothing to claim and the array comes back empty, which is the honest outcome
 * to show.
 */
export async function claimReferrerFees(
  wallet: FillWallet,
  referrer: string,
): Promise<{ ok: true; claimed: number } | { ok: false; error: FillError }> {
  try {
    if (wallet.id === "mock") {
      return {
        ok: false,
        error: { code: "SIGNER_REQUIRED", ...FILL_COPY.SIGNER_REQUIRED, step: "signer" },
      };
    }
    const signer = await wallet.getSigner();
    if (!signer) {
      return {
        ok: false,
        error: { code: "SIGNER_REQUIRED", ...FILL_COPY.SIGNER_REQUIRED, step: "signer" },
      };
    }
    const { ThetanutsClient } = await import("@thetanuts-finance/thetanuts-client");
    const { JsonRpcProvider } = await import("ethers");
    const provider =
      (signer as { provider?: unknown }).provider ?? new JsonRpcProvider(PUBLIC_BASE_RPC);
    const client = new ThetanutsClient({
      chainId: BASE_CHAIN_ID,
      provider: provider as never,
      signer: signer as never,
    });
    const results = await client.optionBook.claimAllFees(referrer);
    return { ok: true, claimed: results.filter((r) => r.receipt).length };
  } catch (error) {
    return { ok: false, error: classifyFillError(error, "fill") };
  }
}
