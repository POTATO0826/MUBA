import type { FilledLeg } from "../engine/score.ts";
import type { FillableOrder, OrderRow } from "../types.ts";

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
 *
 * And one the `.d.ts` gets outright wrong, found by the MCP cross-check
 * (`docs/reviews/mcp-crosscheck.md` §BUG-1) and corrected in FINDINGS:
 *
 *  - `keyStorageProvider` is documented as "auto-detects environment:
 *    localStorage in browser, file storage in Node.js". The **shipped code
 *    throws** in a browser instead (`dist/index.js:11714`), and the client
 *    constructor builds `rfqKeys` eagerly (`:16645`), so every browser
 *    construction that omits the field throws `INVALID_KEY` before it is used.
 *    All four constructions in this file therefore pass one. See `getSigner`.
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
    /**
     * The OptionBook this order was signed for, **as the indexer reports it**.
     *
     * It does not win over the chain config, and an earlier version of this
     * comment said it did. The signature is over a book contract, but this
     * string is not the signature — it is an API field, and the SDK's
     * `resolveOptionBookTarget` treats a value that disagrees with
     * `chainConfig.contracts.optionBook` as a compromised-API signal and throws
     * `INVALID_ORDER` (mcp-crosscheck §BUG-3). So it is a thing to *check*, and
     * `FillDeps.optionBook` is the thing to trust. See step 7.
     */
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
  /**
   * The same gate, for a whole slip: **one** confirmation, for N legs.
   *
   * Optional, and when it is absent `runParlayFill` falls back to `confirm`
   * with the aggregate quote — so a `FillDeps` written for the single-leg path
   * still takes exactly one confirmation for a parlay rather than N of them.
   * What the richer shape buys is the disclosure §D2 requires: the final leg
   * list, the total debit, the total max loss and the partial-fill policy, all
   * in front of the player *before* the first signature.
   */
  confirmSlip?(slip: ParlaySlipQuote): Promise<boolean>;
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
  /**
   * The **chain-configured** OptionBook address — `chainConfig.contracts.optionBook`.
   *
   * This is the approval spender, and it is the trust anchor rather than a
   * cross-check. See step 7 and `docs/reviews/mcp-crosscheck.md` §BUG-3: the
   * SDK's `resolveOptionBookTarget` (`dist/index.js:1561-1582`) requires the
   * order's own `rawApiData.optionBookAddress` to *equal* this, and says why in
   * the words a threat model would use — "to prevent a compromised API from
   * redirecting fills to an attacker contract that drains pre-existing
   * allowances".
   *
   * Unset means the sequence has no anchor and refuses to approve anything. The
   * live adapter fills it in at step 2, from the same `chainConfig` object it
   * reads `usdc` off.
   */
  optionBook?: string;
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
/*
 * ⚠ Written WITHOUT a provider URL on purpose. `test/secrets.test.ts` scans the
 * built bundle for anything shaped like an RPC endpoint, and it cannot tell a
 * placeholder in a help string from a real key someone pasted over it — which
 * is exactly the mistake the scan exists to catch. So the hint names the
 * variable and lets `.env.example` carry the URL shape, where no bundler will
 * ever see it.
 */
export const ALCHEMY_HINT =
  "The public Base RPC is throttling. Do not retry blindly — set a private " +
  "RPC_URL (see .env.example) and reload.";

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

/** One expiry field → ms, tolerating the three encodings they arrive in. */
function toMs(raw: string | bigint | number | undefined | null): number | null {
  if (raw === undefined || raw === null) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * The **earlier** of the two clocks an order runs on.
 *
 * There are two, and they are different things: `rawApiData.orderExpiryTimestamp`
 * is when the maker's EIP-712 signature stops being valid, and `order.expiry` is
 * when the option itself settles. This used to take the first field that was
 * present rather than the smaller of the two — mcp-crosscheck OPPORTUNITY 10,
 * which points out that the SDK's own `fillOrder` checks *both* before it will
 * sign, and throws `ORDER_EXPIRED` on either. They were equal in the frozen
 * capture, so this was latent; `Math.min` is free and removes the case where the
 * option expiry is the binding one.
 *
 * `null` when neither field is usable, which the caller reads as "no expiry
 * claim to check" rather than as "expired".
 *
 * Still measured against the local wall clock rather than
 * `client.getCurrentTimestamp()`. That divergence stands on purpose: the chain
 * read is an extra RPC round trip on the public endpoint that `RATE_LIMIT`
 * exists for, and `EXPIRY_BUFFER_MS` is a whole minute of headroom — far more
 * than any plausible clock skew on a laptop that just loaded a web page.
 */
function expiryMs(order: RawFillOrder): number | null {
  const candidates = [toMs(order.rawApiData?.orderExpiryTimestamp), toMs(order.order.expiry)].filter(
    (ms): ms is number => ms !== null,
  );
  return candidates.length === 0 ? null : Math.min(...candidates);
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
 *  7. `allowance` — **exactly** that figure, to the **chain-configured**
 *                   OptionBook. Never `MaxUint256`, and never to an address the
 *                   book's API supplied and nothing validated (BUG-3).
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
  //
  // **The spender is the chain-configured OptionBook, and nothing else.**
  //
  // This file used to say the opposite — "the order's own `optionBookAddress`
  // wins … the chain config is the cross-check, not the authority" — reasoning
  // that an order is an EIP-712 signature over one book contract. That reason
  // is true and the conclusion drawn from it was wrong, because the address
  // being reasoned about arrives from the *indexer*, not from the signature.
  //
  // `docs/reviews/mcp-crosscheck.md` §BUG-3 puts the SDK's own position beside
  // ours. `resolveOptionBookTarget` (`dist/index.js:1561-1582`) accepts an
  // API-supplied `rawApiData.optionBookAddress` only when it equals the
  // chain-configured OptionBook, and documents the threat verbatim: a
  // compromised API could otherwise redirect fills "to an attacker contract
  // that drains pre-existing allowances". We approve *before* we fill, so we
  // are the half of that sequence the attacker actually wants.
  //
  // Two consequences, both handled below rather than described:
  //
  //  1. A mismatch REFUSES. Approving to the order's address and letting
  //     `fillOrder` throw `INVALID_ORDER` afterwards leaves a live allowance
  //     to an address nothing validated, with nothing legitimate to consume it.
  //  2. No configured address means no anchor, so there is nothing to validate
  //     against and the fill stops. The live adapter always has one by step 7
  //     — it is read off `chainConfig` when the client is built at step 2.
  //
  // This is also why `resolveOptionBook`'s `agreed: false`
  // (`src/server/thetanuts.ts`) is not a cosmetic amber chip: per the SDK, a
  // disagreement means every fill against those orders throws.
  const canonical = deps.optionBook ?? "";
  if (!canonical) {
    return raise("CONTRACT_REVERT", "allowance", {
      message: "The chain's OptionBook address is unknown.",
      recovery:
        "The approval spender is the OptionBook the chain config names, never an address the " +
        "book's API supplied. Without it there is nothing safe to approve, so the fill stops " +
        "here. Reconnect the wallet and press the amount again.",
      action: "retry",
    });
  }
  const named = order.rawApiData?.optionBookAddress;
  // Mirrors `resolveOptionBookTarget` exactly, including its one permissive
  // case: an order that names no book is not a mismatch, and the canonical
  // address stands.
  if (named && named.toLowerCase() !== canonical.toLowerCase()) {
    return raise("CONTRACT_REVERT", "allowance", {
      message: "That order names a different OptionBook than this chain.",
      recovery:
        "Nothing was spent and nothing was approved. The SDK refuses this fill too — an order " +
        "whose API-supplied book address does not match the chain-configured one throws " +
        "INVALID_ORDER — so approving first would leave an allowance to an unvalidated " +
        "address with nothing to consume it. Pick another row.",
      action: "refresh",
      detail: `rawApiData.optionBookAddress (${named}) ≠ configured OptionBook (${canonical})`,
    });
  }
  const spender = canonical;
  let approvalSkipped = false;
  try {
    // EXACTLY `totalCollateral`. Never `MaxUint256`, never a rounded-up
    // convenience amount, never a cached "already approved plenty".
    //
    // One honesty caveat, from mcp-crosscheck OPPORTUNITY 11: `totalCollateral`
    // is the rung we passed in, **verbatim** — `previewFillOrder` sets
    // `totalCollateral = usdcAmount ?? …` and the later clamp of `numContracts`
    // down to the maker's remaining depth does not feed back into it. So when a
    // fill is clamped, this approval (and the figure the human confirmed) can
    // exceed what the contract will actually pull, leaving a residual
    // allowance. The exact figure would be `numContracts * pricePerContract /
    // 1e8`. Left as the SDK reports it rather than recomputed: it is bounded at
    // $2 by `MAX_FILL_USDC`, and a number we derive ourselves diverging from
    // the number the venue previewed is a worse failure than a residual cent.
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
// The parlay — N independent fills, one transaction each
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## Why there is no atomic path, and why this file does not fake one
 *
 * A parlay is a basket of options. The obvious implementation is one multi-leg
 * product — a butterfly, a condor — bought in a single transaction, and it is
 * unavailable: `chainConfig.implementations` puts **seven physical multi-leg
 * implementations at the zero address** on Base (`tnuts-test/FINDINGS.md` §3:
 * `PHYSICAL_CALL_SPREAD`, `PHYSICAL_PUT_SPREAD`, both flies, both condors and
 * the iron condor). There is no contract to fill.
 *
 * So a parlay is **N independent vanilla fills, one transaction each**, and
 * everything below follows from that one fact:
 *
 *  - There is no rollback. Leg 3 failing cannot un-fill legs 1 and 2, because
 *    they are already someone else's position on chain.
 *  - There is therefore a **declared degradation policy** rather than an
 *    implied one, and it is `PARTIAL_FILL_POLICY` — shown to the player before
 *    the first signature, not written in this comment.
 *  - And there is a per-leg **status ladder**, because a sequence of N
 *    transactions with one spinner over it is a sequence nobody can audit.
 *
 * ## What this deliberately does not do: unwind
 *
 * The tempting recovery on a failed leg is to sell the landed ones back and
 * return the player to flat. Do not. Selling back means crossing the spread on
 * a book that is thin enough to have failed a leg thirty seconds ago, at
 * whatever bid is resting — which converts a *failed* leg (costing nothing but
 * gas) into a *realised* loss on the legs that worked. Keeping the position is
 * both cheaper and more honest: the player holds exactly the options they paid
 * for, each with its own bounded max loss, and the slip re-scores around what
 * landed.
 */

/**
 * The partial-fill policy, in one sentence, exported so the screen and the test
 * are quoting the same string.
 *
 * §D2: this renders on the confirm screen, above the button, **before the first
 * signature**. A player who learns it afterwards has been surprised by their
 * own position — and a policy that lives only in a docblock is a policy the
 * person it applies to never read.
 */
export const PARTIAL_FILL_POLICY =
  "Legs fill one at a time. If one fails, you keep the ones that landed and " +
  "your slip re-scores.";

/**
 * The rungs of §D3, in order: `pending → previewed → approved → filled ✓`.
 *
 * Two extra terminals, because a real sequence has them: `dropped` for a leg
 * removed **before** the first signature (so nothing was spent and nothing was
 * approved), and `failed` for a leg that was attempted and did not land.
 * Collapsing those two would tell a player their money might be somewhere it
 * provably is not.
 */
export type LegStatus = "pending" | "previewed" | "dropped" | "approved" | "filled" | "failed";

/** Why a leg never reached a signature. Every one of these is an ordinary
 *  state of a live book, not an error in the app. */
export type LegDropReason = "NO_FILL" | "EXPIRED" | "COLLATERAL" | "BOOK_MISMATCH";

/** One line per reason, for the ladder. Same rule as `FILL_COPY`: a state with
 *  no copy is a chip nobody can read. */
export const DROP_COPY: Record<LegDropReason, string> = {
  NO_FILL: "the maker's remaining collateral will not absorb this size",
  EXPIRED: "the maker's signature expires within the minute — a stale order reverts",
  COLLATERAL: "not collateralised in USDC, so the same number would mean a different amount",
  BOOK_MISMATCH: "names a different OptionBook than this chain — never approved",
};

/**
 * One leg of a slip, as the fill needs it.
 *
 * The order is **in hand**, not re-fetched by nonce the way `runFill` does it.
 * That is a deliberate difference and it costs something, so it is stated: a
 * single-leg fill can afford one round trip to the book between the press and
 * the signature, and a slip cannot afford N of them in front of a confirm
 * screen the player is reading. What replaces the re-fetch is the expiry buffer
 * (checked here, against the order's own two clocks, before any signature) plus
 * the degradation policy — an order that has left the book since the snapshot
 * fails *its own* leg with `ORDER_EXPIRED` at the fill step, and the rest of
 * the slip carries on. That is the same outcome a re-fetch would have produced,
 * one transaction later and for the price of a revert's gas.
 */
export interface ParlayFillLeg {
  /** Stable identity for the ladder — a `LiveCard.id`, or a row identity. */
  id: string;
  /** `ETH-27SEP-4400-C`. **Display copy only** — never used to match an order,
   *  and never used as a marks-map key. See `instrument`. */
  label: string;
  /**
   * The **venue's own name** for this instrument, verbatim, or `undefined`.
   *
   * This is the key `src/engine/score.ts` looks a filled leg's mark up by, and
   * it is deliberately not derivable from anything else on this object. Two
   * namespaces name the same option on Base and they do not agree: the order
   * book's instrument is `ETH-3SEP-4400-C` (no year, built by
   * `src/server/thetanuts.ts`), and the market-maker chain's `MmQuote.ticker`
   * is `ETH-3SEP26-2100-C` (with year, the SDK's own string). Only the second
   * keys into `marksFromSnapshot`, because `MmQuote` is the only shape in the
   * snapshot carrying **both** a name and a mark.
   *
   * So this field is **copied or absent, never composed**. `FilledLeg`'s own
   * docstring names a synthesised instrument name as the one failure mode that
   * pays the wrong player quietly, and a translation between the two schemes
   * would be exactly that — a near-miss guess dressed as a join.
   *
   * `undefined` is the honest and currently *usual* answer: a card is built
   * from a `PricingRow`, and a `PricingRow` carries the mark's **value**
   * (`mark`, joined on the server) but not the mark's **name**. A leg with no
   * instrument here is unmarkable, `duelScore` refuses, and the duel refunds —
   * which fails closed. See `ParlayFillResult.unmarkable`.
   */
  instrument?: string;
  /**
   * The mark price per contract at the moment of the fill, verbatim from the
   * venue (`markPrice`) — the baseline the duel clock measures from, and *not*
   * the price paid, which carries the spread and the fee.
   *
   * Same rule as `instrument`: copied or absent. Absent for every underlying
   * with no market-maker pricing, which is six of the eight price feeds.
   */
  entryMark?: number;
  /** The resting order this leg fills against. `FillableOrder` (`src/types.ts`)
   *  is assignable, which is how a `LiveCard`'s `row.order` gets here. */
  order: RawFillOrder;
  /** The notional this leg asks for, USDC 6dp. */
  usdcAmount: bigint;
}

/** One rung of the ladder, as the screen draws it. */
export interface ParlayLegState {
  id: string;
  label: string;
  status: LegStatus;
  /** `ParlayFillLeg.instrument`, carried through untouched — the duel clock's
   *  join key, or `undefined` when the venue gave us no name. */
  instrument?: string;
  /** `ParlayFillLeg.entryMark`, carried through untouched. */
  entryMark?: number;
  /** Set from `previewed` onward: what this leg costs, exactly. */
  quote?: FillQuote;
  /** Set on `filled`. */
  hash?: string;
  /** BaseScan, ready to open — a hash nobody can open is not evidence. */
  explorer?: string;
  nonce?: string | null;
  /** `true` when `ensureAllowance` returned `null`: the allowance was already
   *  sufficient and this leg was one transaction, not two. */
  approvalSkipped?: boolean;
  /** The mapped code, on `dropped` and on `failed` alike. */
  error?: FillError;
  dropped?: LegDropReason;
}

/**
 * What the player confirms — once, for the whole slip.
 *
 * Everything §D1 step 4 names is on here, so the screen cannot render a
 * confirmation that is missing one of them: the final leg list, the total
 * debit, the total max loss and the policy.
 */
export interface ParlaySlipQuote {
  /** The legs that will actually be attempted, each already `previewed`. */
  legs: readonly ParlayLegState[];
  /** The legs that will not be, and why. Shown beside the list rather than
   *  silently removed — a slip that quietly shrinks between the press and the
   *  confirm is a slip the player did not build. */
  dropped: readonly ParlayLegState[];
  /** Σ `totalCollateral` over `legs`. What leaves the wallet if every leg
   *  lands. */
  totalDebit: bigint;
  /**
   * The slip's total max loss — and it is **the same number** as `totalDebit`.
   *
   * That identity is the whole reason a bought option is survivable, so it is
   * surfaced as its own field rather than left for the reader to notice: every
   * leg is a long option, the premium is paid up front, and nothing on this
   * slip can lose more than what the confirm button says.
   */
  maxLoss: bigint;
  /** Σ `numContracts`, 18dp. */
  totalContracts: bigint;
  /** The collateral token every surviving leg agreed on. */
  collateralToken: string;
  /** `PARTIAL_FILL_POLICY`, carried so the confirm screen cannot omit it. */
  policy: string;
}

export interface ParlayFillResult {
  /**
   *  - `filled`    — every attempted leg landed.
   *  - `partial`   — some landed, some did not. The player keeps what landed.
   *  - `none`      — the slip was confirmed and nothing landed.
   *  - `cancelled` — the player declined. Nothing approved, nothing spent.
   *  - `refused`   — the slip never reached a confirmation. See `error`.
   */
  status: "filled" | "partial" | "none" | "cancelled" | "refused";
  /** The ladder, in slip order, whatever happened. */
  legs: readonly ParlayLegState[];
  /** The legs that landed — the position the player now holds. */
  filled: readonly ParlayLegState[];
  /** Attempted and did not land. Nothing beyond gas was spent on these. */
  failed: readonly ParlayLegState[];
  /** Removed before the first signature. Nothing at all was spent on these. */
  dropped: readonly ParlayLegState[];
  /** Σ `totalCollateral` over the legs the player confirmed. */
  totalDebit: bigint;
  /** The same number. See `ParlaySlipQuote.maxLoss`. */
  maxLoss: bigint;
  /** Σ `totalCollateral` over the legs that actually landed — what was really
   *  spent, which after a partial fill is not the number that was confirmed. */
  spent: bigint;
  /**
   * Landed legs the **duel clock cannot score**, by label.
   *
   * A leg reaches this list when it filled but carries no venue `instrument`
   * or no `entryMark` — so `marksFromSnapshot` has no key for it and
   * `duelScore` returns `NaN`, the attestor signs nothing and the duel refunds
   * both stakes. That is the correct direction to fail in, and it is reported
   * here rather than swallowed because it is a **product fact, not a bug**:
   * market-maker pricing exists for ETH and BTC only, so a duel fought on an
   * order-book-only underlying has no marks to be scored against today.
   *
   * Non-empty does **not** mean anything went wrong with the fill. The two
   * clocks are independent: the player holds the option either way, and it
   * settles at expiry on chain regardless of who took the escrow pot.
   */
  unmarkable: readonly string[];
  /** Set only on `refused`. */
  error?: FillError;
}

/**
 * The shape of a live card that a fill needs, named structurally so the desk
 * does not import the engine.
 *
 * `LiveCard` (`src/engine/parlay.ts`) satisfies this exactly. Declaring the
 * seam this way rather than importing follows the same rule that put
 * `FillableOrder` in `src/types.ts`: the engine and the desk share a vocabulary
 * and neither reaches into the other.
 */
export interface FillableCard {
  id: string;
  underlying: string;
  /** The listed strike, as the row prints it. */
  strike: string;
  /** The row's own expiry label — `"12 SEP"`. */
  expiry: string;
  stance: "bull" | "bear";
  /** `markPrice` as a number, or `null`/absent — `LiveCard.mark`. Carried, not
   *  recomputed; it becomes `ParlayFillLeg.entryMark`. */
  mark?: number | null;
  /**
   * The venue's own instrument name, if the caller has one.
   *
   * `LiveCard` does not carry one today, and neither does the `PricingRow`
   * underneath it — see `ParlayFillLeg.instrument`. Declared here so that the
   * day a ticker is threaded onto the row, the join closes by supplying a
   * field rather than by inventing a format.
   */
  instrument?: string;
  row: { order?: FillableOrder };
}

/**
 * `ETH-12 SEP-4400-C` — **display only**, and never a marks-map key.
 *
 * This is a composed name, in this app's own format, and it deliberately does
 * not try to look like either venue namespace. Something that almost looks like
 * a venue ticker is worse than something that plainly does not: the first
 * invites a lookup that silently misses.
 */
export function cardLabel(card: FillableCard): string {
  return `${card.underlying}-${card.expiry}-${card.strike}-${card.stance === "bull" ? "C" : "P"}`;
}

/**
 * One card → one leg, or `null` when no resting order backs it.
 *
 * `null` rather than a leg with an absent order, because a card the book cannot
 * fill is not a smaller purchase — it is not a purchase. `cardsForSlice`
 * already refuses to deal one; this is the same rule held at the fill seam, so
 * a caller that builds legs some other way cannot route around it.
 *
 * `instrument` and `entryMark` are **copied straight off the card or left
 * absent**. Nothing here derives a name from a strike and an expiry.
 */
export function legFromCard(card: FillableCard, usdcAmount: bigint): ParlayFillLeg | null {
  const order = card.row.order;
  if (!order) return null;
  return {
    id: card.id,
    label: cardLabel(card),
    instrument: card.instrument,
    entryMark: card.mark ?? undefined,
    order,
    usdcAmount,
  };
}

/**
 * The landed legs, in the shape the duel clock scores — `FilledLeg`
 * (`src/engine/score.ts`).
 *
 * Only legs that carry **both** a venue instrument name and an entry mark are
 * returned. A leg missing either is not translated, not defaulted and not
 * guessed at; it is named in `ParlayFillResult.unmarkable` instead, and the
 * consequence (no verdict, both stakes refunded) is the one plan 6 §C3 already
 * chose over a coin flip.
 *
 * The type is imported for its shape only, so the desk still names no engine
 * module at runtime.
 */
export function filledLegsFor(result: ParlayFillResult): readonly FilledLeg[] {
  const legs: FilledLeg[] = [];
  for (const leg of result.filled) {
    if (!leg.instrument || leg.entryMark === undefined || !leg.quote) continue;
    legs.push({
      // Verbatim. The whole point of this function is that this line is an
      // assignment and never a template string.
      instrument: leg.instrument,
      entryMark: leg.entryMark,
      contracts: Number(leg.quote.numContracts) / 10 ** 18,
      premium: Number(leg.quote.totalCollateral) / 10 ** 6,
    });
  }
  return legs;
}

/**
 * Buy a slip, for real: one preview pass, one confirmation, N transactions.
 *
 * **This never throws.** Every exit is a `ParlayFillResult`, for the same
 * reason `runFill` never throws — a rejected promise here is a spinner that
 * spins forever on a screen someone is presenting from, except now with real
 * positions half-open behind it.
 *
 * The sequence, in the order §D1 fixes it and the order `test/fill.test.ts`
 * asserts:
 *
 *  1. `cap`      — the **requested** notional: every leg under `MAX_FILL_USDC`
 *                  *and their sum* under it, checked **before a single dep is
 *                  touched**. A cap the sum can step over is a cap with a
 *                  staircase next to it: four legs at $1 each is $4 through a
 *                  $2 bound, and every individual check passes.
 *  2. `signer`   — the mock wallet is refused above `getSigner` entirely.
 *  3. `preview`  — every leg, synchronously (`previewFillOrder` is sync —
 *                  FINDINGS). A leg the book will not absorb, will not
 *                  collateralise in USDC, or that names a foreign OptionBook is
 *                  **dropped here**, before anything is signed.
 *  4. `expiry`   — every leg's earlier expiry clock against `EXPIRY_BUFFER_MS`.
 *                  Stale legs are dropped **before the first signature, not
 *                  after**: filling a stale order reverts `Signer Not
 *                  Authorized`, which reads as a wallet fault and is not one.
 *  5. `cap`      — again, on the **previewed** sum, after every drop, so the
 *                  number the player is about to confirm is the number that is
 *                  bounded. Reported at step `cap`.
 *  6. `confirm`  — **one** confirmation for the whole slip, carrying the final
 *                  leg list, the total debit, the total max loss and
 *                  `PARTIAL_FILL_POLICY`.
 *  7. `allowance`/`fill` — per leg, in slip order. `ensureAllowance` with that
 *                  leg's own `totalCollateral` and never `MaxUint256`; then
 *                  `fillOrder`. **A leg that fails is recorded and the loop
 *                  continues.** Nothing is unwound.
 *  8. `done`     — the ladder, with a BaseScan link on every leg that landed.
 */
export async function runParlayFill(
  legs: readonly ParlayFillLeg[],
  deps: FillDeps,
  onProgress: (ladder: readonly ParlayLegState[], step: FillStep) => void = () => {},
): Promise<ParlayFillResult> {
  const now = deps.now ?? (() => Date.now());

  /** The ladder. Mutated in place, and copied out on every transition so a
   *  React caller sees a new array rather than the same one twice. */
  const ladder: ParlayLegState[] = legs.map((leg) => ({
    id: leg.id,
    label: leg.label,
    // Carried, never derived. If the caller had no venue name for this leg,
    // neither does anything downstream — see `ParlayFillResult.unmarkable`.
    instrument: leg.instrument,
    entryMark: leg.entryMark,
    status: "pending",
  }));
  const snapshot = (): ParlayLegState[] => ladder.map((s) => ({ ...s }));
  const emit = (step: FillStep) => onProgress(snapshot(), step);

  const refuse = (
    code: FillCode,
    step: FillStep,
    over?: Partial<FillError>,
  ): ParlayFillResult => ({
    status: "refused",
    legs: snapshot(),
    filled: [],
    failed: [],
    dropped: snapshot().filter((s) => s.status === "dropped"),
    totalDebit: 0n,
    maxLoss: 0n,
    spent: 0n,
    // Nothing landed, so there is nothing the duel clock could have scored.
    unmarkable: [],
    error: { code, ...FILL_COPY[code], step, ...over },
  });

  const drop = (state: ParlayLegState, reason: LegDropReason, error?: FillError) => {
    state.status = "dropped";
    state.dropped = reason;
    state.error = error;
  };

  // ── 1. cap, on the requested notional, before any dep ──────────────────────
  // Nothing above this line touches `deps` — the same property `runFill` pins,
  // held for a slip. The difference that matters is the second check: an
  // individually-legal set of legs whose SUM is over the bound is exactly the
  // staircase, and it is refused here, with no signer asked for and no book
  // read.
  emit("cap");
  if (legs.length === 0) {
    return refuse("SIZE", "cap", {
      message: "An empty slip has nothing to fill.",
      recovery: "Add at least one card that a resting order actually backs.",
      action: "none",
    });
  }
  let requested = 0n;
  for (const leg of legs) {
    if (typeof leg.usdcAmount !== "bigint" || leg.usdcAmount <= 0n) {
      return refuse("SIZE", "cap", {
        message: "Every leg needs a positive amount.",
        action: "none",
      });
    }
    if (leg.usdcAmount > MAX_FILL_USDC) {
      return refuse("SIZE", "cap", {
        message: `No leg may ask for more than $${usdText(MAX_FILL_USDC)}.`,
        recovery:
          "MAX_FILL_USDC is a code cap, not a form validation — Thetanuts has no testnet, so " +
          "every rehearsal spends real money and the bound lives above the network call.",
        action: "none",
      });
    }
    requested += leg.usdcAmount;
  }
  if (requested > MAX_FILL_USDC) {
    return refuse("SIZE", "cap", {
      message: `This slip asks for $${usdText(requested)} across ${legs.length} legs; the cap is $${usdText(MAX_FILL_USDC)}.`,
      recovery:
        "The cap is on the SLIP, not on the leg — otherwise four legs at a dollar each would " +
        "walk a $2 bound up to $4 with every individual check passing. Drop a leg or pick a " +
        "smaller size.",
      action: "none",
    });
  }

  // ── 2. signer ──────────────────────────────────────────────────────────────
  emit("signer");
  if (deps.walletId === "mock") {
    return refuse("SIGNER_REQUIRED", "signer", {
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
    return refuse("SIGNER_REQUIRED", "signer", {
      ...classifyFillError(error, "signer"),
      code: "SIGNER_REQUIRED",
      message: "The wallet is not on Base.",
      recovery: "Switch the wallet to Base mainnet (8453) and confirm the slip again.",
      action: "switch",
    });
  }
  if (!signer) return refuse("SIGNER_REQUIRED", "signer");

  // The approval anchor, read once. No anchor means nothing safe to approve, so
  // the slip stops before it previews anything — same doctrine as `runFill`
  // step 7 (`docs/reviews/mcp-crosscheck.md` §BUG-3).
  const canonical = deps.optionBook ?? "";
  if (!canonical) {
    return refuse("CONTRACT_REVERT", "allowance", {
      message: "The chain's OptionBook address is unknown.",
      recovery:
        "The approval spender is the OptionBook the chain config names, never an address the " +
        "book's API supplied. Without it there is nothing safe to approve, so the slip stops " +
        "here. Reconnect the wallet and try again.",
      action: "retry",
    });
  }

  // ── 3. preview every leg, synchronously ────────────────────────────────────
  // One pass, no awaits: `previewFillOrder` is local arithmetic over an order we
  // already hold (FINDINGS "0.3.0 delta"), so the whole slip is priced before
  // anything else happens. Frozen first, for the reason `freezeOrder` gives —
  // an order is an EIP-712 signature over its own fields, and this one now
  // travels through a preview, a confirm screen a human reads, and N approvals.
  emit("preview");
  const orders = legs.map((leg) => freezeOrder(leg.order));
  for (let i = 0; i < legs.length; i++) {
    const state = ladder[i]!;
    const leg = legs[i]!;
    let preview: RawFillPreview;
    try {
      preview = deps.previewFillOrder(orders[i]!, leg.usdcAmount, deps.referrer);
    } catch (error) {
      // One leg's preview throwing is that leg's problem, not the slip's — the
      // indexer serves orders that `previewFillOrder` rejects, and a slip that
      // died on the first of them would be a slip the book decided for us.
      drop(state, "NO_FILL", classifyFillError(error, "preview"));
      continue;
    }
    if (preview.numContracts <= 0n) {
      drop(state, "NO_FILL");
      continue;
    }
    // The decimals guard, per leg. "$0.01" against 18-decimal WETH is not one
    // cent by twelve orders of magnitude, and on a slip the mistake compounds
    // into a total the player confirmed while reading a different number.
    if (deps.usdc && preview.collateralToken.toLowerCase() !== deps.usdc.toLowerCase()) {
      drop(state, "COLLATERAL");
      continue;
    }
    // The BUG-3 check, per leg, and it DROPS rather than refusing the slip: one
    // order carrying a foreign book address says nothing about the other three.
    // What it must never do is reach `ensureAllowance`.
    const named = orders[i]!.rawApiData?.optionBookAddress;
    if (named && named.toLowerCase() !== canonical.toLowerCase()) {
      drop(state, "BOOK_MISMATCH", {
        code: "CONTRACT_REVERT",
        ...FILL_COPY.CONTRACT_REVERT,
        message: "That order names a different OptionBook than this chain.",
        step: "preview",
        detail: `rawApiData.optionBookAddress (${named}) ≠ configured OptionBook (${canonical})`,
      });
      continue;
    }
    state.quote = {
      usdcAmount: leg.usdcAmount,
      numContracts: preview.numContracts,
      totalCollateral: preview.totalCollateral,
      collateralToken: preview.collateralToken,
    };
    state.status = "previewed";
  }
  emit("preview");

  // ── 4. expiry, before the first signature ──────────────────────────────────
  emit("expiry");
  for (let i = 0; i < legs.length; i++) {
    const state = ladder[i]!;
    if (state.status !== "previewed") continue;
    const expiresAt = expiryMs(orders[i]!);
    // `null` is "no expiry claim to check", not "expired" — a book that stops
    // sending the field must not silently make every leg unfillable.
    if (expiresAt !== null && expiresAt - now() < EXPIRY_BUFFER_MS) drop(state, "EXPIRED");
  }
  emit("expiry");

  const live = ladder.filter((s) => s.status === "previewed");
  if (live.length === 0) {
    // Every leg went before the confirm. Which code depends on why: an expired
    // book and an empty one have different recoveries, and offering "refresh"
    // for a size problem sends the player back for another round of the same.
    const anyExpired = ladder.some((s) => s.dropped === "EXPIRED");
    return refuse(anyExpired ? "ORDER_EXPIRED" : "SIZE", anyExpired ? "expiry" : "preview", {
      message: "No leg of this slip can be filled right now.",
    });
  }

  // ── 5. the cap the sum cannot step over ────────────────────────────────────
  // Re-checked on what the book actually quoted, after every drop, so the bound
  // holds over the number the player is about to see rather than over the number
  // they asked for. `previewFillOrder` sets `totalCollateral` from the amount we
  // passed in (mcp-crosscheck OPPORTUNITY 11), so on today's SDK these agree —
  // which is exactly why the check is cheap enough to keep for the day they do
  // not.
  let totalDebit = 0n;
  let totalContracts = 0n;
  for (const state of live) {
    const quote = state.quote!;
    if (quote.totalCollateral > MAX_FILL_USDC) {
      return refuse("SIZE", "cap", {
        message: `A previewed leg came back at $${usdText(quote.totalCollateral)}, over the $${usdText(MAX_FILL_USDC)} cap.`,
        action: "none",
      });
    }
    totalDebit += quote.totalCollateral;
    totalContracts += quote.numContracts;
  }
  if (totalDebit > MAX_FILL_USDC) {
    return refuse("SIZE", "cap", {
      message: `The previewed slip totals $${usdText(totalDebit)}; the cap is $${usdText(MAX_FILL_USDC)}.`,
      recovery:
        "Nothing was approved and nothing was spent. The cap is checked on the sum as well as " +
        "on each leg, so a slip cannot climb over it one legal step at a time.",
      action: "none",
    });
  }

  // ── 6. one confirmation, for the whole slip ────────────────────────────────
  emit("confirm");
  const slip: ParlaySlipQuote = {
    legs: live.map((s) => ({ ...s })),
    dropped: ladder.filter((s) => s.status === "dropped").map((s) => ({ ...s })),
    totalDebit,
    // The same number, deliberately. Every leg is a long option: the premium is
    // paid up front and it is the whole of the downside.
    maxLoss: totalDebit,
    totalContracts,
    collateralToken: live[0]!.quote!.collateralToken,
    policy: PARTIAL_FILL_POLICY,
  };
  let confirmed = false;
  try {
    confirmed = deps.confirmSlip
      ? await deps.confirmSlip(slip)
      : // The fallback still takes exactly ONE confirmation, for the aggregate.
        // N confirmations for one slip would be N chances to approve half a
        // position by accident.
        await deps.confirm({
          usdcAmount: requested,
          numContracts: totalContracts,
          totalCollateral: totalDebit,
          collateralToken: slip.collateralToken,
        });
  } catch (error) {
    return refuse("CONTRACT_REVERT", "confirm", classifyFillError(error, "confirm"));
  }
  if (!confirmed) {
    return {
      status: "cancelled",
      legs: snapshot(),
      filled: [],
      failed: [],
      dropped: snapshot().filter((s) => s.status === "dropped"),
      totalDebit,
      maxLoss: totalDebit,
      spent: 0n,
      unmarkable: [],
    };
  }

  // ── 7. fill, one transaction at a time, keeping what lands ─────────────────
  for (let i = 0; i < ladder.length; i++) {
    const state = ladder[i]!;
    if (state.status !== "previewed") continue;
    const quote = state.quote!;

    emit("allowance");
    try {
      // EXACTLY this leg's own `totalCollateral`, to the chain-configured
      // OptionBook. Never `MaxUint256` — and never one aggregate approval
      // covering the slip either, which would leave a live allowance for the
      // legs that never filled.
      const receipt = await deps.ensureAllowance(
        quote.collateralToken,
        canonical,
        quote.totalCollateral,
      );
      // `null` is the SUCCESS case (FINDINGS): no approval was needed.
      state.approvalSkipped = receipt === null || receipt === undefined;
      state.status = "approved";
    } catch (error) {
      state.status = "failed";
      state.error = classifyFillError(error, "allowance");
      emit("allowance");
      // Keep what landed. Continue. Do not unwind.
      continue;
    }
    emit("allowance");

    emit("fill");
    try {
      const receipt = await deps.fillOrder(orders[i]!, quote.usdcAmount, deps.referrer);
      const hash = receipt?.hash ?? "";
      if (!hash) {
        // It may well have landed, so the copy must not claim otherwise.
        state.status = "failed";
        state.error = {
          code: "CONTRACT_REVERT",
          ...FILL_COPY.CONTRACT_REVERT,
          message: "That leg returned no transaction hash.",
          recovery:
            "Check the wallet's activity before retrying — the transaction may have landed. " +
            "The rest of the slip carried on.",
          action: "none",
          step: "fill",
        };
      } else {
        state.status = "filled";
        state.hash = hash;
        state.explorer = `${BASESCAN_TX}${hash}`;
        state.nonce = orders[i]!.order.nonce === undefined ? null : String(orders[i]!.order.nonce);
      }
    } catch (error) {
      state.status = "failed";
      state.error = classifyFillError(error, "fill");
    }
    emit("fill");
  }

  // ── 8. done ────────────────────────────────────────────────────────────────
  emit("done");
  const final = snapshot();
  const filled = final.filter((s) => s.status === "filled");
  const failed = final.filter((s) => s.status === "failed");
  const dropped = final.filter((s) => s.status === "dropped");
  return {
    status: filled.length === 0 ? "none" : failed.length === 0 ? "filled" : "partial",
    legs: final,
    filled,
    failed,
    dropped,
    totalDebit,
    maxLoss: totalDebit,
    spent: filled.reduce((acc, s) => acc + (s.quote?.totalCollateral ?? 0n), 0n),
    // A landed leg with no venue instrument name, or no entry mark, is one the
    // duel clock cannot score. Named here so the gap is visible on the receipt
    // rather than discovered as a refund six hours later.
    unmarkable: filled
      .filter((s) => !s.instrument || s.entryMark === undefined)
      .map((s) => s.label),
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
  /** `chainConfig.contracts.optionBook` — the canonical spender. See BUG-3. */
  let optionBookAddress: string | undefined;

  return {
    walletId: wallet.id,
    referrer: options.referrer,
    // A getter, not a value: the address is read off `chainConfig`, the client
    // is not built until the signer lands at step 2, and the guard that reads it
    // runs at step 5.
    get usdc() {
      return usdcAddress;
    },
    // Same shape, same reason, read at step 7.
    get optionBook() {
      return optionBookAddress;
    },

    async getSigner() {
      const signer = await wallet.getSigner();
      if (!signer) return null;

      const { ThetanutsClient, MemoryStorageProvider } = await import(
        "@thetanuts-finance/thetanuts-client"
      );
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
        // ── The line that makes any of this run at all ──────────────────────
        //
        // `docs/reviews/mcp-crosscheck.md` §BUG-1, reproduced twice before this
        // was written: once in Node with a faked `window`, and once through
        // this very function under happy-dom, which supplies a real
        // `window.localStorage` exactly as a browser does. Both threw
        // `InvalidKeyError INVALID_KEY` from inside `new ThetanutsClient`.
        //
        // Why: 0.3.0 builds the RFQ key manager **eagerly** in the constructor
        // (`dist/index.js:16645`), and its default provider does not do what
        // the `.d.ts` says. The doc comment on `keyStorageProvider` still reads
        // "auto-detects environment: localStorage in browser, file storage in
        // Node.js"; the shipped `getDefaultStorageProvider` (`:11714`) instead
        // *throws* the moment it sees `window.localStorage`, on the grounds
        // that plaintext localStorage is not a default anyone should inherit.
        // The comment is stale, the code is not — corrected in
        // `tnuts-test/FINDINGS.md` §"0.3.0 delta".
        //
        // Without this the throw lands inside `getSigner`, and `runFill` step 2
        // reads a throw from `getSigner` as connected-but-wrong-chain — so a
        // user already on Base was told to switch to Base, every time, forever.
        //
        // The SDK's own MCP server is the witness that the field is required:
        // its per-wallet `buildClient` (`mcp/dist/prepare/sdk.js:12-19`) always
        // passes one. Memory rather than `LocalStorageProvider` because we never
        // touch `client.rfqKeys` — RFQ is deliberately out of scope — so nothing
        // needs to survive the tab, and an ECDH private key that is never
        // persisted is the plaintext-localStorage hazard closed rather than
        // opted into.
        keyStorageProvider: new MemoryStorageProvider(),
      });
      book = client.optionBook as never;
      erc20 = client.erc20 as never;
      usdcAddress = client.chainConfig?.tokens?.USDC?.address;
      // The trust anchor for the approval spender — see step 7 and BUG-3.
      // `contracts.optionBook` is the chain-configured address, which is what
      // the SDK's own `resolveOptionBookTarget` validates every fill against.
      optionBookAddress = client.chainConfig?.contracts?.optionBook ?? undefined;
      return signer;
    },

    async refetchOrder(ref) {
      // Step 2 runs before step 3, so a missing book here means the sequence was
      // driven out of order — a programming error, raised as the code whose
      // recovery ("connect a wallet") is at least not misleading.
      if (!book) throw new Error("SIGNER_REQUIRED");
      const { ThetanutsClient, MemoryStorageProvider } = await import(
        "@thetanuts-finance/thetanuts-client"
      );
      const { JsonRpcProvider } = await import("ethers");
      // A read-only client for the book read: `fetchOrders` needs no signer, and
      // asking the signing client to do it would put a wallet in the path of a
      // plain GET.
      const reader = new ThetanutsClient({
        chainId: BASE_CHAIN_ID,
        provider: new JsonRpcProvider(PUBLIC_BASE_RPC) as never,
        // Required in a browser even with no signer: `rfqKeys` is built in the
        // constructor and its default provider throws under `window`
        // (mcp-crosscheck §BUG-1; FINDINGS §"0.3.0 delta"). Read-only is not an
        // exemption — the throw happens before the client is ever used.
        keyStorageProvider: new MemoryStorageProvider(),
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
    const { ThetanutsClient, MemoryStorageProvider } = await import(
      "@thetanuts-finance/thetanuts-client"
    );
    const { JsonRpcProvider } = await import("ethers");
    const client = new ThetanutsClient({
      chainId: BASE_CHAIN_ID,
      provider: new JsonRpcProvider(PUBLIC_BASE_RPC) as never,
      // Without this the constructor throws under `window` and the `catch`
      // below swallows it, so the footer chip read `SPLIT — unread` forever
      // and looked like an RPC problem (mcp-crosscheck §BUG-1).
      keyStorageProvider: new MemoryStorageProvider(),
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
    const { ThetanutsClient, MemoryStorageProvider } = await import(
      "@thetanuts-finance/thetanuts-client"
    );
    const { JsonRpcProvider } = await import("ethers");
    const provider =
      (signer as { provider?: unknown }).provider ?? new JsonRpcProvider(PUBLIC_BASE_RPC);
    const client = new ThetanutsClient({
      chainId: BASE_CHAIN_ID,
      provider: provider as never,
      signer: signer as never,
      // Fourth and last browser construction. Same reason as the other three
      // (mcp-crosscheck §BUG-1); here the throw would have been reported as a
      // claim failure rather than as what it is.
      keyStorageProvider: new MemoryStorageProvider(),
    });
    const results = await client.optionBook.claimAllFees(referrer);
    return { ok: true, claimed: results.filter((r) => r.receipt).length };
  } catch (error) {
    return { ok: false, error: classifyFillError(error, "fill") };
  }
}
