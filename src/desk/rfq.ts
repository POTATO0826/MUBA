import {
  ALCHEMY_HINT,
  BASESCAN_TX,
  DATA_CHAIN_ID,
  PUBLIC_BASE_RPC,
  SIGNING_CHAIN_NAME,
  WRONG_CHAIN_RECOVERY,
  assertSigningChain,
  looksThrottled,
  usdText,
  type FillAction,
} from "./fill.ts";

/**
 * The **patient** RFQ: ask the market makers for a price, and then wait.
 *
 * ## Why this is a desk tool and never part of the duel
 *
 * `fill.ts` buys a resting order: one preview, one approval, one transaction,
 * done in the time it takes to press a button. RFQ is the opposite protocol.
 * It is four phases, at least two of our transactions, and — this is the part
 * that decides everything about this file — **an unbounded wait on a
 * counterparty who owes us nothing**. There is no SLA. No market maker is
 * obliged to answer, and "nobody answered" is not a failure of the protocol,
 * it is the protocol working: a sealed-bid auction with no bidders.
 *
 * `docs/plans/plan5-thetanuts.md` scoped RFQ out of the duel loop for exactly
 * that reason (line 27, and the fit table's "RFQ = 4 phases, MM-dependent, no
 * SLA → Out of the duel loop; patient stretch panel only"). A duel resolves in
 * seconds against a seeded tape; a quote request may resolve in minutes or
 * never. Wiring one to the other would make the game hostage to a stranger's
 * quoting desk.
 *
 * So every affordance here is built for waiting rather than for finishing:
 * elapsed time instead of a spinner, a poll count instead of a progress bar,
 * and an `unanswered` **status** rather than an error code — see `RfqOutcome`.
 * Nothing in this module implies imminence, because nothing about this protocol
 * is imminent.
 *
 * ## The four phases, as implemented
 *
 * 1. **REQUEST** — `openRequest()`. We build the on-chain `QuotationParameters`,
 *    publish an ECDH public key inside them, and send `requestForQuotation`.
 *    One transaction. Collateral is **not** locked here (see below).
 * 2. **OFFER** — `awaitOffers()`. Market makers call `makeOfferForQuotation`
 *    with a bid encrypted to our public key. We do not transact; we poll the
 *    state indexer. This is the phase with no clock on it.
 * 3. **REVEAL** — also inside `awaitOffers()`. Each offer's
 *    `signedOfferForRequester` is decrypted **locally** with our ECDH private
 *    key, yielding `{offerAmount, nonce}`. This is the only phase that needs the
 *    key, and it is the reason a lost key degrades to "unreadable" rather than
 *    to anything worse.
 * 4. **SETTLE** — `acceptOffer()`. Exact approval of the premium, then
 *    `settleQuotationEarly(id, offerAmount, nonce, offeror)` — which reveals the
 *    chosen bid and settles it in the same call. The option contract is deployed
 *    and collateral is pulled here, at settlement, from both sides.
 *
 * **Why `settleQuotationEarly` and never `settleQuotation`.** This was a taste
 * call when the file was written and is now a measurement
 * (`docs/plan7-measurements.md` §2). `getRevealWindow()` reads **60 seconds** on
 * the live factory, and `settleQuotation` waits out the offer deadline *and*
 * that window — which is the whole explanation for the 112-second median settle
 * observed on 42-second auctions. Early settle skips both, because the requester
 * already decrypted the sealed bid locally and can hand `(offerAmount, nonce)`
 * straight back. It is not exotic: 20 of the 58 settlements on the current
 * factory took it, and the fastest complete request→settle round trip on record
 * is **16 seconds**. Any path through this file that waited out the reveal
 * window would inherit a two-minute floor and stop being usable inside a duel.
 *
 * ## Two shapes over the same four phases
 *
 * **The desk request** — a single strike, a ten-minute window, a 15-second poll.
 * Something a trader opens and comes back to. `RfqPanel` with no `box` prop.
 *
 * **The box auction** (plan 7 step 5) — four strikes off a drawn box, a
 * {@link BOX_OFFER_WINDOW_SEC}-second window, a {@link BOX_POLL_MS} poll, and a
 * max bid the player names. `src/desk/boxauction.ts` is the seam, and it exists
 * because RFQ is the **only** way to obtain the instrument: zero condors have
 * ever been listed on the OptionBook, so a box that matches no listed `RANGER`
 * zone can be minted here or not at all. Nothing in the four phases changes
 * between the two shapes — only the numbers, and which of them the player owns.
 *
 * `runRfq()` composes all four for the tests and for a caller that wants one
 * function; the panel drives the phases separately because a human sits between
 * phase 3 and phase 4.
 *
 * ## Three non-negotiable constraints, and the reason for each
 *
 * **1. `collateralAmount` must be `0n` at creation.** Not a style rule — the
 * protocol's own invariant, stated three times in the shipped types
 * (`index.d.ts:3117`, the `OptionFactoryModule` class doc at `:3823`, and again
 * on `encodeRequestForQuotation`): *"Collateral is NOT locked at RFQ creation
 * time - it is pulled from both parties at settlement time."* A non-zero value
 * here is a request the factory will not honour as intended. `assertZeroCollateral`
 * checks it on the **built** request — i.e. on whatever the SDK's own builder
 * produced — immediately before the transaction, so the guard cannot be bypassed
 * by a builder change or a hand-assembled tuple.
 *
 * **2. The ECDH key never touches plaintext `localStorage`.** The SDK ships a
 * `LocalStorageProvider` whose own doc comment (`index.d.ts:101`, TNU-AUDIT-0063)
 * says the keys are *"stored in PLAINTEXT and are accessible to any same-origin
 * script. A single XSS sink or compromised transitive dependency exfiltrates
 * every key the user has ever generated."* SDK 0.3.0 goes further and **refuses
 * to guess** in a browser: `getDefaultStorageProvider()` throws `INVALID_KEY`
 * rather than fall back to `localStorage` (see `docs/reviews/mcp-crosscheck.md`
 * BUG-1, which found this the hard way — it is why every browser
 * `ThetanutsClient` in this repo must pass a `keyStorageProvider`). Our answer
 * is `MemoryStorageProvider` plus an explicit keypair on every call: see
 * "What we do instead of persisting" below.
 *
 * **3. Nothing runs without the trade flag and a real wallet.** Same gate as
 * `fill.ts` and `escrow.ts`: `/api/config` must say `features.trade`, and
 * `walletId === "mock"` is refused **above** `getSigner`, before any dep is
 * touched. The mock wallet never signs and never sends.
 *
 * ## What we do instead of persisting the key, and what it costs
 *
 * The SDK expects the key to be persisted. `RFQKeyManagerModule.getOrCreateKeyPair()`
 * loads from storage or generates and stores; `encryptOffer`/`decryptOffer` fall
 * back to storage when no keypair argument is given; `removeStoredKey`'s own doc
 * warns *"This will prevent decryption of any offers encrypted with the
 * corresponding public key."* That warning is a fair description of our steady
 * state, on purpose.
 *
 * What we do:
 *
 *  - the keypair is generated into a **closure** (`createKeyring`) and lives in
 *    memory for the life of the tab. Nothing writes it anywhere;
 *  - it is passed **explicitly** as the `keyPair` argument on every
 *    `decryptOffer` call, so the SDK never consults storage for it;
 *  - the client is constructed with `MemoryStorageProvider` — required by 0.3.0
 *    in a browser, and the one provider that cannot outlive the process;
 *  - `RfqStorage` exists, and deliberately carries **only public breadcrumbs**
 *    (quotation id, the *public* key, timestamps). `rememberRequest` builds that
 *    payload from a fixed allowlist and then re-checks that the private key's own
 *    bytes appear nowhere in it before writing. `test/rfq.test.ts` drives a
 *    storage stub and asserts the private key never reaches it.
 *
 * The cost, stated plainly rather than hidden: **a reload loses the key, and any
 * offer already encrypted to it becomes permanently unreadable.** That is the
 * `KEY_LOST` code, and its copy says so. This is the correct trade — a lost key
 * costs one quote request that can be cancelled for gas; a leaked key is every
 * sealed bid ever made to this browser, readable by anything that ever ran on
 * the origin. A sealed-bid auction whose seals are kept in a drawer marked
 * "seals" is not a sealed-bid auction.
 *
 * ## What is verified, and what is not
 *
 * **No RFQ has ever been sent from this repo.** Every seam below is injectable
 * precisely so that the ordering, the invariants, the error map and the patience
 * behaviour are provable offline in `test/rfq.test.ts`. What only a live market
 * maker can confirm is listed on `RfqDeps` and repeated in the panel's own copy:
 * whether anyone answers at all, the real shape of a `StateOffer` in flight,
 * whether a long requester needs the premium approval we send, and the true
 * latency distribution of phase 2.
 *
 * Cross-checked against `docs/reviews/mcp-crosscheck.md`, which audited our
 * integration against Thetanuts' own MCP server. Finding 8 records that the MCP's
 * entire write surface is RFQ — `prepare_request_rfq`, `prepare_make_offer`,
 * `prepare_settle_rfq(_early)`, `prepare_cancel_*`, `prepare_approve` — i.e. the
 * same five verbs this file wires, in the same order. Finding 13 is their
 * keystore (scrypt + AES-256-GCM in SQLite at 0700, *"never localStorage"*),
 * which is the persistent version of the decision this file makes by not
 * persisting at all.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The bounds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The hard premium cap: $2.00, USDC 6dp. The same number as `MAX_FILL_USDC`,
 * for the same reason and deliberately not imported from it — these are two
 * independent money paths and a shared constant would make one path's cap
 * editable from the other's file.
 *
 * There is no Thetanuts testnet. Every rehearsal of this sequence spends real
 * money on Base mainnet, so the bound lives above the network call rather than
 * in a form.
 */
export const MAX_RFQ_USDC = 2_000000n;

/** What the panel asks for by default: one cent of premium. */
export const TARGET_RFQ_USDC = 10_000n;

/**
 * How long the offer window stays open, in minutes.
 *
 * Ten minutes is long enough that a desk with a human in the loop can answer and
 * short enough that an unanswered request stops costing attention. It is written
 * into `offerEndTimestamp` on chain: past it, the auction closes and only
 * `settleQuotation`/`cancelQuotation` remain.
 */
export const DEFAULT_OFFER_WINDOW_MIN = 10;

/**
 * The free-draw box auction's offer window, **in seconds**.
 *
 * Ten minutes is right for a desk tool somebody leaves open. It is wrong for a
 * box drawn inside a duel, and the measurements say by how much
 * (`docs/plan7-measurements.md` §2):
 *
 *  - there is **no contract-enforced floor** on the window. The SDK validates
 *    only "in the future" and "before expiry"; the shortest window ever accepted
 *    on chain is **8 s** (13 s on the deployment the SDK points at), and both
 *    settled;
 *  - makers answer condor requests in **2–12 s** on windows of 55 s or less, and
 *    appear to pace themselves *against* the deadline — on the three ~355 s
 *    windows the first offer took 58–66 s. Shorter costs latency, not answers;
 *  - 154 requests across the two factories used windows ≤30 s; 118 got offers.
 *
 * 45 seconds sits in the middle of the plan's 30–60 s design band, comfortably
 * above the 12 s worst measured condor latency, and short enough that an
 * unanswered box is a shrug rather than a stall.
 */
export const BOX_OFFER_WINDOW_SEC = 45;

/**
 * The offer window quantum, in seconds — and this constant is a bug fix, not a
 * preference.
 *
 * Every SDK builder computes `BigInt(now + offerDeadlineMinutes * 60)`, which
 * throws `RangeError: Not an integer` the moment `minutes × 60` is not exactly
 * integral in IEEE-754. `1/60` throws. `0.7` happens to survive. That is a
 * landmine under any code that thinks in seconds and divides by 60.
 *
 * Fifteen seconds defuses it for good: for any whole `k`, `15k / 60 = k/4` is
 * dyadic and therefore exact, and `k/4 × 60 = 15k` is exact too. Snapping the
 * requested window to a multiple of 15 s makes the `RangeError` unreachable by
 * construction rather than unlikely.
 */
export const OFFER_WINDOW_QUANTUM_SEC = 15;

/**
 * A requested window, in seconds, snapped to something the SDK's arithmetic can
 * actually express. Never throws; never silently lengthens past one quantum.
 *
 * Snapping rather than throwing is deliberate. A window is a *policy* number
 * chosen by a UI control, and the difference between 45 s and 44 s is nothing
 * anybody can perceive — whereas a `RangeError` thrown from inside the SDK's
 * builder, three frames below the code that picked 20, is a lost afternoon.
 */
export function offerWindowSeconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return BOX_OFFER_WINDOW_SEC;
  const quanta = Math.max(1, Math.round(seconds / OFFER_WINDOW_QUANTUM_SEC));
  return quanta * OFFER_WINDOW_QUANTUM_SEC;
}

/**
 * Seconds → the `offerDeadlineMinutes` the SDK's builders take.
 *
 * The division is safe because {@link offerWindowSeconds} ran first. This is
 * the only place in the repo that turns a window into that field, which is what
 * makes the guarantee checkable.
 */
export function offerWindowMinutes(seconds: number): number {
  return offerWindowSeconds(seconds) / 60;
}

/**
 * How often the box auction asks the indexer, in ms.
 *
 * 3 s rather than the desk tool's 15 s, because the thing being waited for
 * arrives at a **6-second median** and the whole auction is 45 seconds long. A
 * 15-second cadence would spend a third of the window not knowing. Fifteen polls
 * against a public read endpoint over three quarters of a minute is a rounding
 * error next to what the chart behind it already does.
 */
export const BOX_POLL_MS = 3_000;

/** Indexer lag allowance, so the wait ends when the auction does — not before. */
export const BOX_PATIENCE_PAD_MS = 15_000;

/**
 * How long to wait on a box auction before reporting `unanswered`.
 *
 * Still not a timeout, and still not an error — see {@link RFQ_PATIENCE_MS}. It
 * is the window plus indexer lag, so "nobody answered" means the auction closed
 * without bids, which is a fact about the market rather than about our clock.
 */
export function boxPatienceMs(windowSec: number = BOX_OFFER_WINDOW_SEC): number {
  return offerWindowSeconds(windowSec) * 1000 + BOX_PATIENCE_PAD_MS;
}

/**
 * How often we ask the state indexer whether anyone has bid.
 *
 * 15s, matching the market layer's server cache. Faster would be a burst against
 * a public endpoint for information that arrives on a human's timescale;
 * `RATE_LIMIT` is in the error map because that is a real failure mode here.
 */
export const RFQ_POLL_MS = 15_000;

/**
 * How long `awaitOffers` waits before reporting `unanswered`.
 *
 * **This is not a timeout in the usual sense** and the copy must never call it
 * one. Reaching it means "no market maker answered inside the offer window",
 * which is a completely ordinary outcome of a sealed-bid auction and is
 * therefore a `status`, not an error. The default is the offer window plus a
 * minute of indexer lag, so the wait ends when the auction does rather than at
 * some number this file invented.
 */
export const RFQ_PATIENCE_MS = DEFAULT_OFFER_WINDOW_MIN * 60_000 + 60_000;

/**
 * Base mainnet — where the OptionFactory is deployed, and therefore the chain
 * this file **reads** quotation state from.
 *
 * It is the DATA chain, not the signing chain, and the difference is now the
 * most important fact about this module. `requestForQuotation` and
 * `settleQuotationEarly` are transactions against a mainnet factory; a Base
 * Sepolia wallet cannot send them. So, exactly as with `fill.ts`, **an RFQ can
 * no longer be opened or settled** — the guard refuses before the client is
 * built, and that refusal is the owner's requirement working rather than a
 * regression. The read-only polling half (`awaitOffers`, `ensureReader`) is
 * untouched: it signs nothing, so it stays real.
 */
export const RFQ_CHAIN_ID = DATA_CHAIN_ID;

/** `2^256 - 1`. Named only so a test can assert we never approve it. */
export const RFQ_MAX_UINT256 = (1n << 256n) - 1n;

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ECDH keypair, as the SDK hands it over (`index.d.ts:18`).
 *
 * `privateKey` is the only field in this app that must never be written, logged,
 * or serialised. Everything that touches it is in this file, and the one place
 * it crosses a seam is the explicit `keyPair` argument to `decryptOffer`.
 */
export interface RfqKeyPair {
  /** 0x-prefixed, 32 bytes. Memory only. */
  privateKey: string;
  /** 0x-prefixed, 33 bytes. This is the one that goes on chain. */
  compressedPublicKey: string;
  /** 0x-prefixed, 65 bytes. */
  publicKey: string;
}

/**
 * The on-chain quotation tuple, loosened at the edges so a fixture is assignable.
 *
 * All 14 fields exist on the SDK's `QuotationParameters` (`index.d.ts:2837`) and
 * the ABI tuple wants every one of them. We only *read* two here —
 * `collateralAmount`, which must be `0n`, and `requester` — but the shape is
 * spelled out so `assertZeroCollateral` cannot be handed something that merely
 * looks like a params object.
 */
export interface RfqQuotationParams {
  requester: string;
  existingOptionAddress: string;
  collateral: string;
  collateralPriceFeed: string;
  implementation: string;
  strikes: readonly (string | bigint)[];
  numContracts: string | bigint;
  requesterDeposit: string | bigint;
  /** **MUST be 0 at creation.** See `assertZeroCollateral`. */
  collateralAmount: string | bigint;
  expiryTimestamp: string | bigint;
  offerEndTimestamp: string | bigint;
  isRequestingLongPosition: boolean;
  convertToLimitOrder: boolean;
  extraOptionData: string;
}

/** `RFQRequest` (`index.d.ts:2879`) — params + tracking + reserve + our pubkey. */
export interface RfqRequest {
  params: RfqQuotationParams;
  tracking: { referralId: string | bigint; eventCode: string | bigint };
  reservePrice: string | bigint;
  /** The compressed ECDH public key market makers encrypt their bids to. */
  requesterPublicKey: string;
}

/**
 * The assets an RFQ may name.
 *
 * **This is the SDK's own `RFQUnderlying`**, mirrored structurally rather than
 * imported (nothing else in this file imports an SDK type; the whole dep seam is
 * structural, so that a fixture is assignable without the package present).
 * Verify it against `node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts`
 * — `type RFQUnderlying` — after any SDK bump.
 *
 * ## Why this is eight and not two
 *
 * This field used to read `"ETH" | "BTC"`, justified as *"nothing else has a
 * Thetanuts options market"*. **That justification was wrong**, and plan 6 §7 is
 * the correction: there are three asset sets and they are three different sizes.
 * Eight assets have a Chainlink price feed on Base; seven have a readable spot;
 * only **two** — ETH and BTC — have market makers *streaming* two-sided quotes
 * through `getPricingArray` (FINDINGS §3, §5.5). The old comment collapsed the
 * third set onto the first and mistook one quote source for the whole market.
 * AVAX is on the resting board today, bid-only, and it was that same conflation
 * that once made it the broken default asset.
 *
 * So the union widens to the protocol's own eight. Narrowing our type below a
 * type the SDK accepts is us deciding what the venue sells.
 *
 * ## What the widening does NOT claim
 *
 * That an RFQ on DOGE will get a bid. It very likely will not: RFQ is a
 * sealed-bid auction, market makers owe us nothing, and the two assets they
 * stream quotes on are the two they are most likely to answer for. **But that
 * outcome is already a first-class state in this file** — `awaitOffers` returns
 * `unanswered`, not an error, precisely because "nobody bid" is the protocol
 * working (see the module docblock, phase 2). A type that refuses the request
 * ahead of time is not protecting anyone; it is pre-answering a question only
 * the makers can answer, and answering it wrong for six assets.
 *
 * Widening the type is not widening the panel: `RfqPanel.tsx` offers ETH and BTC
 * from its own `TRADABLE` list, which is a **product** decision about where the
 * demo's odds of a fill are best, and it stays a subset of this union. Nothing
 * in this module branches on the value — it is threaded to the SDK's builder and
 * written into a public breadcrumb — so no code path here has an opinion about
 * which of the eight it is holding.
 *
 * @see plan6-real-parlay.md §7 — the three asset sets, and why MM pricing grades
 *      rather than gates.
 */
export type RfqUnderlying = "ETH" | "BTC" | "SOL" | "DOGE" | "XRP" | "BNB" | "PAXG" | "AVAX";

/** What the panel asks for, in human units, before the SDK's builder runs. */
export interface RfqInput {
  /** The connected wallet. */
  requester: string;
  /** One of the protocol's eight. See {@link RfqUnderlying} for why it is eight
   *  and not the two this field used to allow. */
  underlying: RfqUnderlying;
  optionType: "CALL" | "PUT";
  /**
   * Human-readable, e.g. `4400` for $4,400.
   *
   * On the four-strike box path this carries the **inner floor** (`s2`) — the
   * bottom of the band the player drew. It is the breadcrumb's anchor and the
   * panel's label; the instrument itself comes from {@link RfqInput.strikes}.
   */
  strike: number;
  /**
   * Four human-readable strikes, ascending — present ⇒ this is a free-draw box.
   *
   * `[s1, s2, s3, s4]` straight out of `condorStrikeNumbers(boxToCondor(box))`.
   * Present, the live adapter hands them to the SDK's builder as a `strikes`
   * array, which resolves the implementation by count: four strikes and
   * `optionType: "CALL"` is `CALL_CONDOR` (`index.js`,
   * `getImplementationForStructure`, `case 4`). Absent, `strike` is used and the
   * request is a vanilla single-leg one — the desk tool's original shape.
   *
   * This field is the whole of plan 7 step 5 at the type level: **RFQ is the
   * only path that mints a condor.** Zero have ever been listed on the
   * OptionBook, across its entire 15,740-position history
   * (`docs/plan7-measurements.md` §3), so a box that matches no listed `RANGER`
   * zone can be priced here or nowhere.
   */
  strikes?: readonly [number, number, number, number];
  /** Unix **seconds**. */
  expiry: number;
  /**
   * The literal `true`, not `boolean` — plan7 §5 at the type level, the same
   * lock `CondorSpec.isLong` and `RangerSpec.isLong` already carry.
   *
   * **Every box is a buy.** A short leg is not a variation on this flow, it is a
   * different product with a different risk: the requester would be *selling*
   * the structure, posting collateral the factory pulls at settlement, and
   * carrying a loss that is not bounded by anything this app measures or shows.
   * Max loss is the premium in every screen, every economics function and every
   * piece of copy in the repo, and that sentence is only true while this is
   * `true`.
   *
   * The box specs held this line and the RFQ input did not: it was `boolean`
   * here with no runtime refusal anywhere in the four-phase flow, so the type
   * lock ended at the boundary where the money starts. It is now narrowed here
   * **and** checked twice at runtime — {@link openRequest}'s cap phase refuses a
   * short input above every dep, and {@link assertLongOnly} refuses a short
   * *built tuple* immediately before it becomes calldata, so a hand-assembled
   * request or a builder change cannot slip past the type.
   */
  isLong: true;
  /** Contracts, on-chain units (6dp against USDC collateral). */
  numContracts: string | bigint;
  /**
   * **The player's max bid**, USDC 6dp — the auction's reserve price.
   *
   * plan7 §3.2 is emphatic about what this is and is not: `reservePrice` is a
   * **limit price the player names**, not a quote they receive. Bid low for a
   * better fill and risk nobody taking it; bid high to get filled worse. The UI
   * must render it as *"Your max bid"* with a suggested default, and never as
   * "Est. Quote" — see `MAX_BID_LABEL` in `src/desk/boxauction.ts`.
   *
   * Capped at `MAX_RFQ_USDC` before any dep is touched. It is also what
   * `acceptOffer` refuses to exceed: a bid above the number the user set is not
   * a bid we accept, whatever the indexer says. And it goes **on chain** — the
   * live adapter converts it to the per-contract float the SDK's builder wants,
   * so market makers see the limit rather than guessing at it.
   */
  reserveUsdc: bigint;
  /** Minutes the offer window stays open. Ignored when `offerWindowSec` is set. */
  offerWindowMin?: number;
  /**
   * Seconds the offer window stays open — the box path's control, and the one to
   * prefer.
   *
   * Snapped through {@link offerWindowSeconds} before it becomes
   * `offerDeadlineMinutes`, which is what keeps `BigInt(now + minutes * 60)`
   * from throwing `RangeError: Not an integer` on any window that is not a whole
   * number of minutes.
   */
  offerWindowSec?: number;
}

/** One market maker's sealed bid, after we have decrypted it. */
export interface RfqOffer {
  quotationId: string;
  /** The market maker. */
  offeror: string;
  /** Their public key — the `signingKey` the decryption needs. */
  signingKey: string;
  /** USDC 6dp. `null` when the seal could not be opened (see `unreadable`). */
  offerAmount: bigint | null;
  /** The nonce from inside the seal; `settleQuotationEarly` needs it verbatim. */
  nonce: bigint | null;
  /** Unix seconds, from the indexer. */
  createdAt: number;
  status: string;
  /**
   * Set when decryption failed — a bid encrypted to a key we no longer hold, or
   * to a different key entirely. The offer is still shown (it exists, and its
   * existence is information) but it can never be accepted.
   */
  unreadable?: string;
}

/** The state indexer's view of one RFQ, narrowed to what this flow reads. */
export interface RawRfqState {
  id: string;
  /** `'active' | 'settled' | 'cancelled'`. */
  status: string;
  requester?: string;
  requesterPublicKey?: string;
  offerEndTimestamp?: number;
  currentBestPrice?: string;
  winner?: string;
  optionAddress?: string;
  /** Present from `getRfq`, absent from the list endpoints. */
  offers?: Record<string, RawRfqOffer>;
}

export interface RawRfqOffer {
  quotationId?: string;
  offeror: string;
  signingKey: string;
  /** IV + AES-GCM ciphertext, hex. The deprecated twin is `encryptedOffer`. */
  signedOfferForRequester?: string;
  encryptedOffer?: string;
  status?: string;
  createdAt?: number;
  revealedAmount?: string;
}

/**
 * The steps, in the order the sequence walks them.
 *
 * Deliberately finer-grained than the four phases: a request that stalls should
 * say *where*, and "waiting" covers four very different situations (nobody has
 * bid / a bid arrived and cannot be read / the window closed / we are between
 * polls). `RFQ_PHASE_OF` maps each step back to its phase for the panel's
 * headline.
 */
export type RfqStep =
  | "cap"
  | "key"
  | "signer"
  | "build"
  | "submit"
  | "open"
  | "poll"
  | "decrypt"
  | "choose"
  | "confirm"
  | "approve"
  | "settle"
  | "done";

export type RfqPhase = "request" | "offer" | "reveal" | "settle";

/** Which of the four phases a step belongs to. */
export const RFQ_PHASE_OF: Record<RfqStep, RfqPhase> = {
  cap: "request",
  key: "request",
  signer: "request",
  build: "request",
  submit: "request",
  open: "request",
  poll: "offer",
  decrypt: "reveal",
  choose: "reveal",
  confirm: "reveal",
  approve: "settle",
  settle: "settle",
  done: "settle",
};

/** What each phase honestly promises. Rendered by the panel, verbatim. */
export const RFQ_PHASE_COPY: Record<RfqPhase, { label: string; means: string }> = {
  request: {
    label: "1 · REQUEST",
    means: "One transaction publishes the request. No collateral is locked here.",
  },
  offer: {
    label: "2 · OFFER",
    means: "Market makers may bid, sealed. Nobody is obliged to, and there is no deadline they owe you.",
  },
  reveal: {
    label: "3 · REVEAL",
    means: "Bids are decrypted in this tab with a key that was never written to disk.",
  },
  settle: {
    label: "4 · SETTLE",
    means: "A second transaction reveals the chosen bid and mints the option. Collateral moves here.",
  },
};

/**
 * The eleven ways an RFQ ends badly — and note what is *not* in this list.
 *
 * "No market maker responded" is **not** an error code. It is
 * `RfqOutcome.status === "unanswered"`, and the difference is the whole design
 * of this panel: a sealed-bid auction with no bidders worked correctly. Coding
 * it as a failure would put an amber box and a "try again" button under an
 * outcome that is neither wrong nor retryable in any useful sense.
 */
export type RfqCode =
  | "SIGNER_REQUIRED"
  | "COLLATERAL_NOT_ZERO"
  | "SHORT_REFUSED"
  | "SIZE"
  | "KEY_LOST"
  | "OFFER_UNREADABLE"
  | "WINDOW_CLOSED"
  | "RESERVE_EXCEEDED"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_ALLOWANCE"
  | "CONTRACT_REVERT"
  | "NETWORK"
  | "RATE_LIMIT";

export interface RfqError {
  code: RfqCode;
  /** One line, plain, in the panel. */
  message: string;
  /** What to do about it. */
  recovery: string;
  /** Reuses `fill.ts`'s vocabulary so a recovery button reads identically
   *  whether the money is buying a resting order or answering a quote. */
  action: FillAction;
  detail?: string;
  throttled?: boolean;
  step: RfqStep;
}

/**
 * One sentence and one recovery per code.
 *
 * Written for someone who has been staring at a panel for four minutes, which is
 * why every line says what happened to their money (nothing, in nine of the
 * twelve cases) and whether waiting longer would have helped.
 */
export const RFQ_COPY: Record<RfqCode, { message: string; recovery: string; action: FillAction }> = {
  SIGNER_REQUIRED: {
    message: "No wallet can sign this request.",
    recovery: `Connect a wallet on ${SIGNING_CHAIN_NAME}, then open the request again.`,
    action: "connect",
  },
  COLLATERAL_NOT_ZERO: {
    message: "The built request locks collateral at creation. Refusing to send it.",
    recovery:
      "collateralAmount must be 0 in an RFQ — the factory pulls collateral at settlement, from " +
      "both parties. A non-zero value here is a malformed request, so nothing was sent.",
    action: "none",
  },
  SHORT_REFUSED: {
    message: "This build only buys. Refusing to request a short position.",
    recovery:
      "Selling the structure posts collateral and carries a loss this app neither measures nor " +
      "shows — every screen here says max loss is the premium, which is only true of a buy. " +
      "Nothing was sent.",
    action: "none",
  },
  SIZE: {
    message: "That premium is above this build's cap.",
    recovery:
      "MAX_RFQ_USDC is a code cap, not a form validation — Thetanuts has no testnet, so every " +
      "rehearsal spends real money and the bound sits above the network call.",
    action: "none",
  },
  KEY_LOST: {
    message: "This request can no longer be read.",
    recovery:
      "The key that market makers encrypt their bids to lives in this tab's memory and is never " +
      "written to storage — a reload loses it by design. Any bid already sealed to it is " +
      "unreadable. Cancel the request and open a new one; nothing was spent beyond gas.",
    action: "none",
  },
  OFFER_UNREADABLE: {
    message: "A bid arrived that this tab cannot open.",
    recovery:
      "The seal did not match our key. The bid still exists on chain and other bids are " +
      "unaffected — accept one of those, or cancel and re-request.",
    action: "none",
  },
  WINDOW_CLOSED: {
    message: "The offer window has closed.",
    recovery:
      "Past offerEndTimestamp the auction no longer takes bids. Nothing was spent — cancel the " +
      "request to close it out, or open a new one with a longer window.",
    action: "none",
  },
  RESERVE_EXCEEDED: {
    message: "The best bid is above the reserve you set.",
    recovery:
      "Nothing was approved and nothing was spent. Raise the reserve and re-request, or leave it " +
      "and let the request expire — a reserve exists so a bad quote costs nothing to refuse.",
    action: "none",
  },
  INSUFFICIENT_BALANCE: {
    message: "The wallet does not hold enough collateral to settle.",
    recovery: `Fund it with test USDC on ${SIGNING_CHAIN_NAME}. The request stays open until its window ends.`,
    action: "fund",
  },
  INSUFFICIENT_ALLOWANCE: {
    message: "The approval did not take.",
    recovery:
      "Press the premium again — the approval is re-sent for exactly that amount, never an " +
      "unlimited one.",
    action: "retry",
  },
  CONTRACT_REVERT: {
    message: "The OptionFactory rejected the call.",
    recovery: "Beyond gas, nothing was spent. The request may still be open — re-read it before retrying.",
    action: "retry",
  },
  NETWORK: {
    message: "The call never completed.",
    recovery: "Check the connection and try again. Polling resumes on its own.",
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
 * Anything thrown → one of twelve codes.
 *
 * Order matters in the same way it does in `classifyFillError`. The two subtle
 * pairs here:
 *
 *  - the SDK's `KeyNotFoundError` / `DecryptionError` (`InvalidKeyError` too) are
 *    tested **before** anything generic, because they are the only codes whose
 *    honest recovery is "this cannot be fixed by retrying" — every other code's
 *    button says try again, and offering that for a lost key is a loop;
 *  - throttling is tested before the network bucket, because ethers surfaces a
 *    throttle as `CALL_EXCEPTION` with no revert data, which is otherwise
 *    indistinguishable from a contract refusing.
 */
export function classifyRfqError(error: unknown, step: RfqStep): RfqError {
  const detail = detailOf(error);
  const code = (error as { code?: unknown })?.code;
  const name = (error as { name?: unknown })?.name;
  const text = `${String(name ?? "")} ${String(code ?? "")} ${detail}`;
  const throttled = looksThrottled(error);

  const at = (c: RfqCode, over?: Partial<RfqError>): RfqError => ({
    code: c,
    ...RFQ_COPY[c],
    detail,
    step,
    ...(throttled ? { throttled: true } : {}),
    ...over,
  });

  if (/KEY_LOST|KeyNotFound|KEY_NOT_FOUND|INVALID_KEY|InvalidKey/i.test(text)) return at("KEY_LOST");
  if (/DECRYPTION|DecryptionError|decrypt|unable to authenticate|bad decrypt/i.test(text))
    return at("OFFER_UNREADABLE");
  if (/COLLATERAL_NOT_ZERO|collateralAmount/i.test(text)) return at("COLLATERAL_NOT_ZERO");
  if (/SHORT_REFUSED|isRequestingLongPosition/i.test(text)) return at("SHORT_REFUSED");
  if (/SIGNER_REQUIRED|no signer|signer is required|unknown account/i.test(text))
    return at("SIGNER_REQUIRED");
  if (/offer\s*(period|window)|offerEnd|not\s*active|quotation\s*(closed|ended|expired)/i.test(text))
    return at("WINDOW_CLOSED");

  if (throttled && !/execution reverted/i.test(text)) return at("RATE_LIMIT");

  if (/insufficient allowance|allowance/i.test(text)) return at("INSUFFICIENT_ALLOWANCE");
  if (/insufficient (funds|balance)|exceeds balance|transfer amount exceeds/i.test(text))
    return at("INSUFFICIENT_BALANCE");
  if (/reserve/i.test(text)) return at("RESERVE_EXCEEDED");
  if (/INVALID_PARAMS|too small|dust|numContracts|amount (is )?zero|size|MAX_RFQ_VALUE/i.test(text))
    return at("SIZE");
  if (/NETWORK_ERROR|TIMEOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timeout/i.test(text))
    return at("NETWORK");

  // Everything left died against the factory. Same reasoning as `fill.ts`: an
  // unknown failure on a write path is far more likely a revert than a socket,
  // and the revert copy is the one that says "beyond gas, nothing was spent".
  return at("CONTRACT_REVERT");
}

/** A code raised by this module rather than caught from below. */
function raise(code: RfqCode, step: RfqStep, over?: Partial<RfqError>): { status: "failed"; error: RfqError } {
  return { status: "failed", error: { code, ...RFQ_COPY[code], step, ...over } };
}

// ─────────────────────────────────────────────────────────────────────────────
// The invariant: collateralAmount === 0n at creation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse any request that locks collateral at creation.
 *
 * The reason, from the SDK's own types rather than from a docs page — the class
 * doc on `OptionFactoryModule` (`index.d.ts:3823`), repeated on
 * `requestForQuotation` and again on `encodeRequestForQuotation`:
 *
 * > **IMPORTANT: collateralAmount must ALWAYS be 0 in RFQ params.**
 * > Collateral is NOT locked at RFQ creation time - it is pulled from both
 * > parties at settlement time.
 *
 * And `RFQBuilderParams` (`:3117`): *"The generated RFQ params will ALWAYS have
 * collateralAmount = 0. Collateral is pulled at settlement time, not at RFQ
 * creation."*
 *
 * Why check something the SDK's own builder guarantees: because the guarantee is
 * a property of one code path, and this file will also accept a request built by
 * hand, by a future helper, or by an MCP tool. The check is on the **built**
 * object at the last moment before it becomes calldata, so it holds regardless
 * of who built it. It is the cheapest possible assertion standing between a
 * malformed tuple and a mainnet transaction.
 *
 * Returns the frozen request on success; throws a plain `Error` whose message
 * `classifyRfqError` maps to `COLLATERAL_NOT_ZERO`.
 */
export function assertZeroCollateral<T extends RfqRequest>(request: T): Readonly<T> {
  const raw = request.params?.collateralAmount;
  let value: bigint;
  // `BigInt("")` is `0n` and `BigInt(null)` is `0n` — JavaScript's own coercion
  // would let an absent field pass a "must be zero" check, which is the exact
  // shape of bug this guard exists to catch. Demand a real number first.
  const shaped =
    typeof raw === "bigint" || (typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw));
  if (!shaped) {
    throw new Error(
      `COLLATERAL_NOT_ZERO: collateralAmount is not a number (${String(raw)}) — an RFQ must carry 0`,
    );
  }
  try {
    value = BigInt(raw);
  } catch {
    throw new Error(
      `COLLATERAL_NOT_ZERO: collateralAmount is not a number (${String(raw)}) — an RFQ must carry 0`,
    );
  }
  if (value !== 0n) {
    throw new Error(
      `COLLATERAL_NOT_ZERO: collateralAmount is ${value}, must be 0 — the factory pulls ` +
        "collateral at settlement, not at creation",
    );
  }
  return freezeRequest(request);
}

// ─────────────────────────────────────────────────────────────────────────────
// The invariant: isRequestingLongPosition === true, always
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Refuse any request that asks for the sell side. plan7 §5, on the built tuple.
 *
 * Exactly `assertZeroCollateral`'s pattern, for exactly its reason. §5 is
 * absolute — *every box is a buy, no short legs ever* — because a short means
 * posting collateral and carrying a downside nothing in this app bounds, while
 * every economics function, every panel and every line of copy states max loss
 * as the premium. `CondorSpec.isLong` and `RangerSpec.isLong` are the literal
 * `true`, and {@link RfqInput.isLong} now is too; this is the runtime half,
 * because a type lock ends at the first `any`, the first hand-assembled tuple
 * and the first builder that decides to be helpful.
 *
 * On the **built** object, at the last moment before it becomes calldata, so it
 * holds regardless of who built it — the SDK's builder, a future helper, or an
 * MCP tool. `isRequestingLongPosition` is the factory's own name for the field
 * (`QuotationParameters`, `index.d.ts:2837`), and it must be the boolean `true`:
 * a missing or truthy-but-not-true value is the same class of coercion bug
 * `assertZeroCollateral` refuses on `collateralAmount`.
 *
 * Throws a plain `Error` whose message `classifyRfqError` maps to
 * `SHORT_REFUSED`. Returns the request unchanged — freezing belongs to
 * `assertZeroCollateral`, which runs after it, so there is still exactly one
 * place a request becomes immutable.
 */
export function assertLongOnly<T extends RfqRequest>(request: T): T {
  const raw = request.params?.isRequestingLongPosition;
  if (raw !== true) {
    throw new Error(
      `SHORT_REFUSED: isRequestingLongPosition is ${String(raw)}, must be true — this build only ` +
        "buys, and a short would post collateral against an unbounded loss",
    );
  }
  return request;
}

/**
 * The request, frozen the instant it is validated.
 *
 * We do not sign this tuple — `requestForQuotation` is an ordinary contract call
 * — so this is not the EIP-712 hazard `fill.ts` freezes against. It is a
 * different one, and arguably worse: `requesterPublicKey` inside these params is
 * the key **every market maker encrypts their bid to**. Normalise it, re-case a
 * hex string, "fix" a strike, and the request that goes on chain no longer
 * matches the one this tab believes it made — bids come back sealed to something
 * else and read as `OFFER_UNREADABLE` forever, with nothing in the stack
 * pointing at the mutation. Freezing turns that into a `TypeError` at the line
 * that did it.
 */
export function freezeRequest<T extends RfqRequest>(request: T): Readonly<T> {
  if (request.params?.strikes) Object.freeze(request.params.strikes);
  if (request.params) Object.freeze(request.params);
  if (request.tracking) Object.freeze(request.tracking);
  return Object.freeze(request);
}

// ─────────────────────────────────────────────────────────────────────────────
// The keyring — memory only, by construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ECDH keypair, held in a closure and nowhere else.
 *
 * There is no getter for the private key. `take()` hands it to a callback and
 * the only callback in this file is the `decryptOffer` dep; `forget()` drops the
 * reference, after which every read is `KEY_LOST`. That is not defence against a
 * determined attacker inside the same realm — nothing in JavaScript is — it is a
 * shape that makes "write the key somewhere" an edit somebody has to make on
 * purpose rather than something a convenience call does by default.
 */
export interface RfqKeyring {
  /** Compressed, 33 bytes. Safe to publish: it goes on chain in the request. */
  readonly publicKey: string;
  /** True once `forget()` ran or the tab reloaded into a fresh keyring. */
  readonly lost: boolean;
  /** Run `fn` with the keypair. Throws a `KEY_LOST`-shaped error once forgotten. */
  take<T>(fn: (keyPair: RfqKeyPair) => T): T;
  /** Drop the key. Irreversible, and makes every sealed bid unreadable. */
  forget(): void;
}

export function createKeyring(keyPair: RfqKeyPair): RfqKeyring {
  let held: RfqKeyPair | null = keyPair;
  const publicKey = keyPair.compressedPublicKey;
  return {
    publicKey,
    get lost() {
      return held === null;
    },
    take(fn) {
      if (!held) {
        throw new Error(
          "KEY_LOST: the ECDH private key for this request is no longer in memory — it is never " +
            "persisted, so a reload or an explicit forget() ends readability",
        );
      }
      return fn(held);
    },
    forget() {
      held = null;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Breadcrumbs — public fields only
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The only storage this flow touches, and it is not for the key.
 *
 * Shaped like the two-method subset of `Storage` we need, so a caller can pass
 * `window.sessionStorage` if they want the breadcrumb to survive a soft
 * navigation — and so a test can pass a stub and prove what does and does not
 * reach it.
 */
export interface RfqStorage {
  set(key: string, value: string): void;
  get(key: string): string | null;
  remove(key: string): void;
}

/** What we are willing to write down about an open request. All of it is public. */
export interface RfqBreadcrumb {
  quotationId: string;
  /** The *public* key. It is in the on-chain params already. */
  publicKey: string;
  createdAt: number;
  underlying: string;
  strike: number;
  expiry: number;
  /**
   * Always `false` when written. It exists so a reload can render the honest
   * sentence — "request #42 is open and can no longer be read from this tab" —
   * instead of pretending the request never happened.
   */
  readable: false;
}

export const RFQ_STORAGE_PREFIX = "thetaduel_rfq_";

/**
 * Write the breadcrumb, having first proved it contains no secret.
 *
 * The allowlist is the primary defence: the payload is built field by field from
 * an explicit list, so a future field on `RfqInput` cannot ride along by
 * accident. The substring check is the second one, and it exists because
 * allowlists are maintained by people — it re-reads the serialised payload and
 * refuses to write if the private key's own bytes appear anywhere in it, under
 * any key name.
 *
 * Returns the string that was written, so a test can assert on it directly.
 */
export function rememberRequest(
  storage: RfqStorage | undefined,
  crumb: RfqBreadcrumb,
  privateKey: string,
): string | null {
  if (!storage) return null;
  const payload = JSON.stringify({
    quotationId: crumb.quotationId,
    publicKey: crumb.publicKey,
    createdAt: crumb.createdAt,
    underlying: crumb.underlying,
    strike: crumb.strike,
    expiry: crumb.expiry,
    readable: false,
  } satisfies RfqBreadcrumb);

  // Belt to the allowlist's braces. If this ever fires, the allowlist above grew
  // a field it should not have, and the correct outcome is losing a breadcrumb
  // rather than writing a key.
  if (privateKey && payload.includes(privateKey)) {
    throw new Error(
      "KEY_LOST: refused to persist an RFQ breadcrumb containing the private key — this is a bug " +
        "in rememberRequest's allowlist, not a user-facing condition",
    );
  }
  storage.set(`${RFQ_STORAGE_PREFIX}${crumb.quotationId}`, payload);
  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every impure thing the RFQ flow needs, as parameters.
 *
 * This is the whole testability story, and it matters more here than it did for
 * `fill.ts`: **no RFQ has ever been sent from this repo**, so unlike the fill
 * path there is not even a manual mainnet rehearsal behind it. Nothing below can
 * open a socket, find a wallet or reach a contract; it can only call what it was
 * handed, in the order it was written to call it, which is exactly what
 * `test/rfq.test.ts` records.
 *
 * **What only a live market maker can confirm** (say it here, not in a
 * changelog):
 *
 *  - that anyone answers at all, and how long they take. Every latency number in
 *    this file is a policy we chose, not an observation;
 *  - the in-flight shape of `StateOffer.signedOfferForRequester` — the indexer's
 *    field is typed, but no real ciphertext has ever been round-tripped here;
 *  - whether a **long** requester needs the premium approval `acceptOffer` sends.
 *    `encodeRequestForQuotation`'s doc says a BUY needs no approval because "the
 *    counterparty provides collateral", but the premium still leaves our wallet
 *    at settlement. We send an exact-amount approval for the accepted bid; if the
 *    docs are right it is redundant, if they are incomplete it is required, and
 *    an exact approval of a sum we are about to spend is safe either way;
 *  - whether `settleQuotationEarly` is callable by the requester at any point in
 *    the window, or only after some reveal condition the indexer does not expose.
 */
export interface RfqDeps {
  /** `"mock"` is refused before `getSigner` is even called. */
  walletId?: string;
  /**
   * The chain the connected wallet reports. **Required, not optional** — see
   * `FillDeps.chainId` in `./fill.ts`.
   */
  chainId: number | null;
  /** `null` = not connected; a **throw** = connected on the wrong chain. */
  getSigner(): Promise<unknown | null>;
  /** A fresh ECDH keypair. Generated into memory; never stored by us. */
  generateKeyPair(): RfqKeyPair;
  /**
   * The SDK's own builder, turning human input into the 14-field tuple.
   *
   * Injected rather than reimplemented on purpose: strike scaling, the
   * implementation address per product, and the numContracts decimal rules are
   * the SDK's business and getting any of them wrong is a wrong instrument, not
   * a wrong pixel. We validate what it produces (`assertZeroCollateral`) instead
   * of duplicating how it produces it.
   */
  buildRequest(input: RfqInput, requesterPublicKey: string): RfqRequest;
  /** Phase 1. One transaction. */
  requestForQuotation(
    request: Readonly<RfqRequest>,
  ): Promise<{ quotationId?: string | bigint; hash?: string } | null>;
  /** Phase 2. A read against the state indexer — no signer, no gas. */
  readRfq(quotationId: string): Promise<RawRfqState | null>;
  /** Phase 3. Local ECDH + AES-256-GCM. The keypair is always passed explicitly. */
  decryptOffer(
    ciphertext: string,
    offerorPublicKey: string,
    keyPair: RfqKeyPair,
  ): Promise<{ offerAmount: bigint; nonce: bigint }>;
  /**
   * The spender for the premium approval.
   *
   * **Chain-config derived, never API-supplied.** `docs/reviews/mcp-crosscheck.md`
   * BUG-3 found the fill path approving to `rawApiData.optionBookAddress`, an
   * address the SDK itself refuses to trust *"to prevent a compromised API from
   * redirecting fills to an attacker contract that drains pre-existing
   * allowances"*. The same hazard applies verbatim here, so the factory address
   * comes from `client.optionFactory.contractAddress` and from nowhere else.
   */
  factoryAddress(): Promise<string>;
  /** The collateral token the premium is denominated in. */
  collateralToken(): Promise<string>;
  /** Exact approval. `null` = already sufficient, which is SUCCESS not failure. */
  ensureAllowance(token: string, spender: string, amount: bigint): Promise<unknown | null>;
  /** Phase 4: reveals the chosen sealed bid and settles it in one call. */
  settleQuotationEarly(
    quotationId: string,
    offerAmount: bigint,
    nonce: bigint,
    offeror: string,
  ): Promise<{ hash?: string } | null>;
  /** The requester's exit when nobody bids. */
  cancelQuotation(quotationId: string): Promise<{ hash?: string } | null>;
  /**
   * The human gate, and it is a click on the **premium** — the number that
   * leaves the wallet — exactly as the fill path clicks `totalCollateral`.
   */
  confirm(offer: RfqOffer): Promise<boolean>;
  /** Public breadcrumbs only. Optional; absent means nothing is written at all. */
  storage?: RfqStorage;
  /** Attribution. `referralId` is the factory's own tracking field. */
  referralId?: bigint;
  now?(): number;
  /** Injected so the patience loop is instant in tests and 15s in a browser. */
  sleep?(ms: number): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Outcomes
// ─────────────────────────────────────────────────────────────────────────────

export interface RfqOpen {
  quotationId: string;
  hash: string;
  explorer: string;
  /** The frozen request that went on chain. */
  request: Readonly<RfqRequest>;
  /** Compressed public key — the seal every bid is encrypted to. */
  publicKey: string;
  openedAt: number;
}

export type RfqOpenOutcome =
  | ({ status: "open" } & RfqOpen)
  | { status: "failed"; error: RfqError };

export type RfqOffersOutcome =
  | { status: "offers"; offers: RfqOffer[]; elapsedMs: number; polls: number }
  /**
   * **The normal outcome, not an error.** The window ran and nobody bid.
   * `elapsedMs` and `polls` are carried so the panel can say how long it
   * actually waited instead of implying a fixed timeout.
   */
  | { status: "unanswered"; elapsedMs: number; polls: number }
  /** The RFQ left `active` under us — settled by someone, or cancelled. */
  | { status: "closed"; state: RawRfqState; elapsedMs: number; polls: number }
  | { status: "failed"; error: RfqError };

export type RfqOutcome =
  | {
      status: "settled";
      quotationId: string;
      hash: string;
      explorer: string;
      offer: RfqOffer;
      /** True when `ensureAllowance` returned `null` — allowance already
       *  sufficient, no approval transaction sent. `null` is the SUCCESS case. */
      approvalSkipped: boolean;
      elapsedMs: number;
    }
  | { status: "unanswered"; quotationId: string; elapsedMs: number; polls: number }
  | { status: "cancelled"; quotationId: string | null }
  | { status: "failed"; error: RfqError };

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — REQUEST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Publish a quote request. One transaction, no collateral locked.
 *
 * **Never throws.** Every exit is a value, because a rejected promise on a panel
 * somebody left open for six minutes is a spinner nobody can clear.
 *
 * Order, and the test pins it: cap → key → signer → build → submit.
 * The cap runs before any dep is touched at all; the keypair is generated before
 * the signer because the public key is an *input* to the request and generating
 * it costs nothing; the mock wallet is refused above `getSigner`.
 */
export async function openRequest(
  input: RfqInput,
  keyring: RfqKeyring,
  deps: RfqDeps,
  onStep: (step: RfqStep, info?: { quotationId?: string; hash?: string }) => void = () => {},
): Promise<RfqOpenOutcome> {
  const now = deps.now ?? (() => Date.now());

  // ── cap ─────────────────────────────────────────────────────────────────────
  // Nothing above this line touches `deps`. Same property `fill.ts` pins: a UI
  // clamp is a suggestion to a caller, a check above the network is a bound.
  onStep("cap");
  // plan7 §5, above every dep: the sell side is not a variation on this flow.
  // `isLong` is the literal `true` in the type, so reaching this line means a
  // caller crossed an `any` — and the type is not the thing standing between a
  // player and an unbounded loss. It is checked again on the built tuple.
  if (input.isLong !== true) return raise("SHORT_REFUSED", "cap");
  if (typeof input.reserveUsdc !== "bigint" || input.reserveUsdc <= 0n) {
    return raise("SIZE", "cap", { message: "A quote request needs a positive reserve." });
  }
  if (input.reserveUsdc > MAX_RFQ_USDC) {
    return raise("SIZE", "cap", {
      message: `This build will not request more than $${usdText(MAX_RFQ_USDC)} of premium.`,
    });
  }

  // ── key ─────────────────────────────────────────────────────────────────────
  onStep("key");
  if (keyring.lost) return raise("KEY_LOST", "key");

  // ── signer ──────────────────────────────────────────────────────────────────
  onStep("signer");

  // ── THE CHAIN GUARD ────────────────────────────────────────────────────────
  // Above `getSigner` and above the mock check, exactly as in `runFill`. An RFQ
  // is two transactions and an approval against a MAINNET factory, so this is
  // the guard that makes the whole sequence unreachable on the testnet wallet
  // this build requires — see `RFQ_CHAIN_ID`.
  try {
    assertSigningChain(deps.chainId, "a quote request");
  } catch (error) {
    return {
      status: "failed",
      error: {
        ...classifyRfqError(error, "signer"),
        code: "SIGNER_REQUIRED",
        message: `The wallet is not on ${SIGNING_CHAIN_NAME}.`,
        recovery: WRONG_CHAIN_RECOVERY,
        action: "switch",
      },
    };
  }

  // The mock wallet is inert and is refused BEFORE `getSigner` is called. Its
  // `getSigner` throws when connected, and a throw is this sequence's signal for
  // "wrong network" — left to the generic path a mock-tier demo would be told to
  // switch to Base while already on Base, forever. Same line `runFill` holds.
  if (deps.walletId === "mock") {
    return raise("SIGNER_REQUIRED", "signer", {
      message: "The mock wallet cannot sign — and must not.",
      recovery:
        "Install a browser wallet, or set WALLETCONNECT_PROJECT_ID, and reload. The mock keeps " +
        "the app playable with no wallet at all; it never touches money.",
      action: "connect",
    });
  }
  let signer: unknown | null;
  try {
    signer = await deps.getSigner();
  } catch (error) {
    return {
      status: "failed",
      error: {
        ...classifyRfqError(error, "signer"),
        code: "SIGNER_REQUIRED",
        message: `The wallet is not on ${SIGNING_CHAIN_NAME}.`,
        recovery: WRONG_CHAIN_RECOVERY,
        action: "switch",
      },
    };
  }
  if (!signer) return raise("SIGNER_REQUIRED", "signer");

  // The request names its own requester, and the factory pulls collateral from
  // that address at settlement. An empty or malformed one is a request nobody
  // can settle — it costs gas to find that out on chain, and the check costs a
  // regex here. (This is the field a panel forgets to thread through from the
  // wallet, which is exactly why it is checked in the module rather than in the
  // panel.)
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.requester ?? "")) {
    return raise("SIGNER_REQUIRED", "signer", {
      message: "This request carries no requester address.",
      recovery:
        "The factory pulls collateral from the requester named in the request, so it must be the " +
        "connected wallet. Reconnect and open the request again — nothing was sent.",
      action: "connect",
    });
  }

  // ── build, and the invariant ────────────────────────────────────────────────
  onStep("build");
  let request: Readonly<RfqRequest>;
  try {
    const built = deps.buildRequest(input, keyring.publicKey);
    // On the BUILT object, at the last moment before it becomes calldata. The
    // SDK's builder guarantees `collateralAmount === 0n` and threads `isLong`
    // straight through; both hold here whether or not the builder was the SDK's.
    // Long first, because a short request is the one that could cost money the
    // app never showed.
    request = assertZeroCollateral(assertLongOnly(built));
  } catch (error) {
    return { status: "failed", error: classifyRfqError(error, "build") };
  }

  // The seal has to be *ours*, or every bid comes back unreadable and nothing in
  // the stack says why. Cheap check, catastrophic failure mode.
  if (request.requesterPublicKey !== keyring.publicKey) {
    return raise("KEY_LOST", "build", {
      message: "The built request carries a different public key than this tab holds.",
      recovery:
        "Bids would be sealed to a key we cannot open. Nothing was sent. Reload and open a new " +
        "request.",
    });
  }

  // ── submit ──────────────────────────────────────────────────────────────────
  onStep("submit");
  let receipt: { quotationId?: string | bigint; hash?: string } | null;
  try {
    receipt = await deps.requestForQuotation(request);
  } catch (error) {
    return { status: "failed", error: classifyRfqError(error, "submit") };
  }

  const quotationId = receipt?.quotationId === undefined ? "" : String(receipt.quotationId);
  const hash = receipt?.hash ?? "";
  if (!quotationId) {
    // Without an id there is nothing to poll and nothing to cancel. The request
    // may well be on chain, so the copy must not claim otherwise.
    return raise("CONTRACT_REVERT", "submit", {
      message: "The request returned no quotation id.",
      recovery:
        "Check the wallet's activity before retrying — the request may have landed, in which case " +
        "it will expire on its own at the end of its offer window.",
      action: "none",
    });
  }

  const openedAt = now();
  // Public breadcrumbs only, and the write is itself guarded — see
  // `rememberRequest`. Losing this is losing a sentence on a reload; writing the
  // wrong thing here would be losing the auction's seal.
  try {
    keyring.take((keyPair) =>
      rememberRequest(
        deps.storage,
        {
          quotationId,
          publicKey: keyring.publicKey,
          createdAt: openedAt,
          underlying: input.underlying,
          strike: input.strike,
          expiry: input.expiry,
          readable: false,
        },
        keyPair.privateKey,
      ),
    );
  } catch {
    // A breadcrumb is a convenience. A storage quota, a private-mode window or a
    // stub that throws must not fail a request that is already on chain.
  }

  onStep("open", { quotationId, hash });
  return {
    status: "open",
    quotationId,
    hash,
    explorer: hash ? `${BASESCAN_TX}${hash}` : "",
    request,
    publicKey: keyring.publicKey,
    openedAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phases 2 + 3 — OFFER and REVEAL
// ─────────────────────────────────────────────────────────────────────────────

/** Ciphertext, tolerating the indexer's deprecated field name. */
function sealOf(offer: RawRfqOffer): string {
  return offer.signedOfferForRequester ?? offer.encryptedOffer ?? "";
}

/**
 * Decrypt one sealed bid.
 *
 * Failure is per-offer and never fatal: a bid we cannot open is still a bid that
 * exists, and hiding it would understate what happened on chain. It comes back
 * with `unreadable` set, `offerAmount: null`, and is refused by `acceptOffer`.
 */
async function reveal(
  quotationId: string,
  raw: RawRfqOffer,
  keyring: RfqKeyring,
  deps: RfqDeps,
): Promise<RfqOffer> {
  const base: RfqOffer = {
    quotationId,
    offeror: raw.offeror,
    signingKey: raw.signingKey,
    offerAmount: null,
    nonce: null,
    createdAt: raw.createdAt ?? 0,
    status: raw.status ?? "pending",
  };
  const seal = sealOf(raw);
  if (!seal) return { ...base, unreadable: "the indexer carried no ciphertext for this offer" };
  try {
    // The keypair is passed EXPLICITLY. The SDK would otherwise load one from
    // its storage provider, and the entire point of this module is that there is
    // nothing in that provider to load.
    const opened = await keyring.take((keyPair) =>
      deps.decryptOffer(seal, raw.signingKey, keyPair),
    );
    return { ...base, offerAmount: opened.offerAmount, nonce: opened.nonce };
  } catch (error) {
    return { ...base, unreadable: detailOf(error) };
  }
}

/**
 * Wait for market makers to bid. This is the patient part.
 *
 * `unanswered` is the ordinary ending and is a **status**, never an error: a
 * sealed-bid auction that nobody bid in worked exactly as specified. The caller
 * gets `elapsedMs` and `polls` so a panel can say *how long it actually waited*
 * rather than implying it hit some fixed deadline.
 *
 * Stops on the first of:
 *  - at least one offer arrived (the caller decides whether to keep waiting for
 *    a better one — this function's job is to surface the first real information);
 *  - the RFQ left `active` (settled or cancelled under us);
 *  - `patienceMs` elapsed with nothing.
 *
 * A poll that throws does **not** end the wait. The state indexer 502s, the
 * public RPC throttles, a laptop sleeps; none of those mean the auction failed,
 * and ending a six-minute wait on one bad GET would be the cruellest possible
 * reading of a transient. Errors are counted and reported through `onStep`; only
 * an unbroken run of `POLL_FAILURE_LIMIT` of them gives up.
 */
export const POLL_FAILURE_LIMIT = 4;

export async function awaitOffers(
  quotationId: string,
  keyring: RfqKeyring,
  deps: RfqDeps,
  options: { patienceMs?: number; pollMs?: number } = {},
  onStep: (
    step: RfqStep,
    info?: { elapsedMs?: number; polls?: number; offers?: RfqOffer[]; note?: string },
  ) => void = () => {},
): Promise<RfqOffersOutcome> {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const patienceMs = options.patienceMs ?? RFQ_PATIENCE_MS;
  const pollMs = options.pollMs ?? RFQ_POLL_MS;
  const startedAt = now();

  let polls = 0;
  let consecutiveFailures = 0;
  let lastError: unknown = null;

  for (;;) {
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= patienceMs) {
      // Not a failure. The window ran and nobody bid.
      return { status: "unanswered", elapsedMs, polls };
    }

    polls += 1;
    onStep("poll", { elapsedMs, polls });

    let state: RawRfqState | null = null;
    try {
      state = await deps.readRfq(quotationId);
      consecutiveFailures = 0;
    } catch (error) {
      lastError = error;
      consecutiveFailures += 1;
      onStep("poll", {
        elapsedMs: now() - startedAt,
        polls,
        note: `read failed (${consecutiveFailures}/${POLL_FAILURE_LIMIT})`,
      });
      if (consecutiveFailures >= POLL_FAILURE_LIMIT) {
        return { status: "failed", error: classifyRfqError(lastError, "poll") };
      }
      await sleep(pollMs);
      continue;
    }

    if (state) {
      const entries = Object.values(state.offers ?? {});
      if (entries.length > 0) {
        onStep("decrypt", { elapsedMs: now() - startedAt, polls });
        const offers: RfqOffer[] = [];
        for (const raw of entries) offers.push(await reveal(quotationId, raw, keyring, deps));
        // Cheapest bid first — this is a premium we pay, so lower wins. Unreadable
        // bids sort last: they are information, not candidates.
        offers.sort((a, b) => {
          if (a.offerAmount === null) return b.offerAmount === null ? 0 : 1;
          if (b.offerAmount === null) return -1;
          return a.offerAmount < b.offerAmount ? -1 : a.offerAmount > b.offerAmount ? 1 : 0;
        });
        onStep("decrypt", { elapsedMs: now() - startedAt, polls, offers });
        return { status: "offers", offers, elapsedMs: now() - startedAt, polls };
      }
      if (state.status && state.status !== "active") {
        return { status: "closed", state, elapsedMs: now() - startedAt, polls };
      }
    }

    await sleep(pollMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — SETTLE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Accept one revealed bid: exact approval, then reveal-and-settle.
 *
 * Order, and the test pins it: choose → confirm → approve → settle → done.
 *
 * The **reserve check runs before the human is asked**. A bid above the number
 * the user set is not a bid we show a confirm dialog for; the reserve exists so
 * that a bad quote costs nothing, including nothing in attention.
 *
 * The approval is `ensureAllowance(collateral, factory, offerAmount)` and
 * nothing else — the exact premium, never `MaxUint256`. `null` back means the
 * allowance was already sufficient and no transaction was sent; that is the
 * SUCCESS case (`index.d.ts:577`, FINDINGS "0.3.0 delta"), and reading it as
 * failure would report a phantom error on every settle after the first.
 */
export async function acceptOffer(
  offer: RfqOffer,
  reserveUsdc: bigint,
  deps: RfqDeps,
  onStep: (step: RfqStep, info?: { offer?: RfqOffer; hash?: string }) => void = () => {},
): Promise<RfqOutcome> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  // ── choose ──────────────────────────────────────────────────────────────────
  onStep("choose", { offer });
  if (deps.walletId === "mock") {
    return raise("SIGNER_REQUIRED", "choose", {
      message: "The mock wallet cannot settle — and must not.",
      recovery: `Connect a real wallet on ${SIGNING_CHAIN_NAME}. The mock never approves and never transacts.`,
      action: "connect",
    });
  }
  if (offer.unreadable || offer.offerAmount === null || offer.nonce === null) {
    return raise("OFFER_UNREADABLE", "choose", { detail: offer.unreadable });
  }
  if (offer.offerAmount <= 0n) {
    return raise("SIZE", "choose", { message: "That bid is for nothing at all." });
  }
  // The code cap, re-checked at the point of spending rather than trusted from
  // phase 1: an offer arrives from a counterparty, and a counterparty's number
  // has never been through our cap.
  if (offer.offerAmount > MAX_RFQ_USDC) {
    return raise("SIZE", "choose", {
      message: `That bid asks $${usdText(offer.offerAmount)}, above this build's $${usdText(MAX_RFQ_USDC)} cap.`,
    });
  }
  if (offer.offerAmount > reserveUsdc) {
    return raise("RESERVE_EXCEEDED", "choose", {
      message: `The best bid is $${usdText(offer.offerAmount)}; your reserve is $${usdText(reserveUsdc)}.`,
    });
  }

  // ── confirm, on the premium itself ──────────────────────────────────────────
  onStep("confirm", { offer });
  let confirmed = false;
  try {
    confirmed = await deps.confirm(offer);
  } catch (error) {
    return { status: "failed", error: classifyRfqError(error, "confirm") };
  }
  if (!confirmed) return { status: "cancelled", quotationId: offer.quotationId };

  // ── approve, exact ──────────────────────────────────────────────────────────
  onStep("approve");
  let approvalSkipped = false;
  try {
    // Chain-config derived, both of them. Never an address that arrived in an
    // API response — see BUG-3 in `docs/reviews/mcp-crosscheck.md`.
    const [spender, token] = await Promise.all([deps.factoryAddress(), deps.collateralToken()]);
    if (!spender) {
      return raise("CONTRACT_REVERT", "approve", {
        message: "No OptionFactory address is configured for this chain.",
        recovery: "Without a spender there is nothing safe to approve, so the settle stops here.",
        action: "none",
      });
    }
    const receipt = await deps.ensureAllowance(token, spender, offer.offerAmount);
    approvalSkipped = receipt === null || receipt === undefined;
  } catch (error) {
    return { status: "failed", error: classifyRfqError(error, "approve") };
  }

  // ── settle ──────────────────────────────────────────────────────────────────
  onStep("settle");
  let receipt: { hash?: string } | null;
  try {
    // `settleQuotationEarly(id, offerAmount, nonce, offeror)` — the nonce and the
    // amount come out of the seal we opened locally, which is why phase 3 and
    // phase 4 cannot be separated by a page reload.
    receipt = await deps.settleQuotationEarly(
      offer.quotationId,
      offer.offerAmount,
      offer.nonce,
      offer.offeror,
    );
  } catch (error) {
    return { status: "failed", error: classifyRfqError(error, "settle") };
  }

  const hash = receipt?.hash ?? "";
  if (!hash) {
    return raise("CONTRACT_REVERT", "settle", {
      message: "The settle returned no transaction hash.",
      recovery: "Check the wallet's activity before retrying — the transaction may have landed.",
      action: "none",
    });
  }

  onStep("done", { hash });
  return {
    status: "settled",
    quotationId: offer.quotationId,
    hash,
    explorer: `${BASESCAN_TX}${hash}`,
    offer,
    approvalSkipped,
    elapsedMs: now() - startedAt,
  };
}

/**
 * The requester's exit: close an unanswered request.
 *
 * Offered as the recovery for `unanswered`, and its copy is careful — cancelling
 * costs gas and returns nothing, because nothing was ever locked. Leaving the
 * request to expire is equally valid and free.
 */
export async function cancelRequest(
  quotationId: string,
  deps: RfqDeps,
): Promise<{ status: "cancelled"; quotationId: string; hash: string } | { status: "failed"; error: RfqError }> {
  if (deps.walletId === "mock") {
    return raise("SIGNER_REQUIRED", "submit", {
      message: "The mock wallet cannot cancel — and must not.",
      recovery: `Connect a real wallet on ${SIGNING_CHAIN_NAME}.`,
      action: "connect",
    });
  }
  try {
    const receipt = await deps.cancelQuotation(quotationId);
    deps.storage?.remove(`${RFQ_STORAGE_PREFIX}${quotationId}`);
    return { status: "cancelled", quotationId, hash: receipt?.hash ?? "" };
  } catch (error) {
    return { status: "failed", error: classifyRfqError(error, "submit") };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// All four phases, composed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Request → wait → reveal → settle, in one call.
 *
 * The panel does **not** use this: a human sits between phases 3 and 4, and a
 * function that runs all four is a function that has already decided how long to
 * wait on the user's behalf. It exists so `test/rfq.test.ts` can assert the
 * whole call ordering across one deps spy, and so a headless caller (a script, a
 * future MCP tool) has an honest end-to-end entry point.
 *
 * **Never throws.** `unanswered` comes back as a status with its elapsed time
 * attached, exactly as `awaitOffers` reported it.
 */
export async function runRfq(
  input: RfqInput,
  deps: RfqDeps,
  options: { patienceMs?: number; pollMs?: number } = {},
  onStep: (step: RfqStep, info?: Record<string, unknown>) => void = () => {},
): Promise<RfqOutcome> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const keyring = createKeyring(deps.generateKeyPair());

  const opened = await openRequest(input, keyring, deps, onStep);
  if (opened.status === "failed") return opened;

  const waited = await awaitOffers(opened.quotationId, keyring, deps, options, onStep);
  if (waited.status === "failed") return waited;
  if (waited.status === "unanswered") {
    return {
      status: "unanswered",
      quotationId: opened.quotationId,
      elapsedMs: waited.elapsedMs,
      polls: waited.polls,
    };
  }
  if (waited.status === "closed") {
    return raise("WINDOW_CLOSED", "poll", {
      message: `Quotation ${opened.quotationId} is ${waited.state.status}.`,
    });
  }

  const best = waited.offers[0];
  if (!best) {
    return {
      status: "unanswered",
      quotationId: opened.quotationId,
      elapsedMs: waited.elapsedMs,
      polls: waited.polls,
    };
  }

  const settled = await acceptOffer(best, input.reserveUsdc, deps, onStep);
  if (settled.status === "settled") return { ...settled, elapsedMs: now() - startedAt };
  return settled;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `"4m 12s"`, `"38s"`, `"1h 03m"`.
 *
 * The panel's replacement for a progress bar. A spinner claims something is
 * about to happen; an elapsed clock claims only that time has passed, which is
 * the sole honest claim available while waiting on a counterparty with no SLA.
 */
export function elapsedText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** How the panel names an outcome that nobody answered. Never the word "error". */
export const UNANSWERED_COPY =
  "No market maker answered. That is an ordinary outcome — RFQ is a sealed-bid " +
  "auction and nobody is obliged to bid. Nothing was spent beyond the request's gas; " +
  "the request expires on its own, or you can cancel it now.";

// ─────────────────────────────────────────────────────────────────────────────
// The live adapter — the only place the SDK is named
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The player's max bid, in the units the SDK's builder wants: **dollars per
 * contract**, human-readable.
 *
 * We hold the reserve as a total in USDC 6dp because that is the number the cap
 * bounds, the number `acceptOffer` compares an incoming bid against, and the
 * number the panel prints. `RFQBuilderParams.reservePrice` is neither of those
 * things — it is a float, per contract, which the SDK scales back up by the
 * collateral's decimals and multiplies by `numContracts`
 * (`OptionFactoryModule.calculateReservePrice`, `index.js:4702`). Round-tripping
 * through here for one contract is exact; for other sizes it is exact to the
 * cent, which is the resolution USDC has.
 *
 * `0` when the size is zero or unreadable — the SDK treats a non-positive
 * `reservePrice` as "no reserve" and writes `0n`, which is the honest outcome
 * for a request whose size we could not parse.
 */
export function reservePricePerContract(
  reserveUsdc: bigint,
  numContracts: string | bigint,
): number {
  let contracts: bigint;
  try {
    contracts = BigInt(numContracts);
  } catch {
    return 0;
  }
  if (contracts <= 0n || reserveUsdc <= 0n) return 0;
  // Both sides are USDC-scaled (6dp), so the scales cancel and what is left is
  // dollars per contract.
  return Number(reserveUsdc) / Number(contracts);
}

/**
 * `RfqInput` → the object the SDK's `buildRFQRequest` takes.
 *
 * Extracted from the live adapter and exported for one reason: it is where three
 * separate landmines are defused, and each of them is invisible in a diff unless
 * a test can hold the result in its hand.
 *
 *  1. **The strike count picks the instrument.** `getImplementationForStructure`
 *     switches on `strikes.length`: 1 vanilla, 2 spread, 3 fly, **4 condor** —
 *     and with `optionType: "CALL"`, four resolves to `CALL_CONDOR`. There is no
 *     product field to get wrong; the array length *is* the product. That makes
 *     "did four strikes actually go out?" the single assertion standing between a
 *     drawn box and a wrong instrument.
 *  2. **`offerDeadlineMinutes` is fed to `BigInt(now + minutes * 60)`,** which
 *     throws `RangeError: Not an integer` for any window that is not exactly
 *     integral in seconds. Everything on the box path arrives here as seconds and
 *     leaves snapped to a 15-second quantum, so the product is always exact.
 *  3. **`reservePrice` is the player's limit, and it is optional in the SDK** —
 *     omit it and the built request carries `reservePrice: 0n`. A zero reserve is
 *     not "no limit" to a maker reading the request; it is the absence of the one
 *     number plan7 §3.2 says the player owns. It is passed as dollars per
 *     contract because that is the unit the SDK scales from.
 *
 * Pure: no client, no signer, no network.
 */
export function rfqBuilderParams(
  input: RfqInput,
  requesterPublicKey: string,
  referralId?: bigint,
): Record<string, unknown> {
  const offerDeadlineMinutes =
    input.offerWindowSec === undefined
      ? (input.offerWindowMin ?? DEFAULT_OFFER_WINDOW_MIN)
      : offerWindowMinutes(input.offerWindowSec);

  // Four strikes ⇒ the free-draw box. `buildCondorRFQ` is *literally*
  // `buildRFQRequest` with `strikes: [s1,s2,s3,s4]` (`index.js:6104`), so
  // passing the array keeps one builder call site — and one place where a strike
  // count could ever be wrong.
  const legs = input.strikes ? { strikes: [...input.strikes] } : { strikes: input.strike };

  const reservePrice = reservePricePerContract(input.reserveUsdc, input.numContracts);

  return {
    requester: input.requester,
    underlying: input.underlying,
    optionType: input.optionType,
    ...legs,
    expiry: input.expiry,
    numContracts: input.numContracts,
    isLong: input.isLong,
    offerDeadlineMinutes,
    collateralToken: "USDC",
    requesterPublicKey,
    ...(reservePrice > 0 ? { reservePrice } : {}),
    ...(referralId === undefined ? {} : { referralId }),
  };
}

/** Just the wallet seam the RFQ needs. Structurally satisfied by `WalletSource`. */
export interface RfqWallet {
  readonly id: string;
  /** The connected wallet's chain, shaped so `WalletSource` satisfies this
   *  seam structurally — see `FillWallet.identity`. */
  readonly identity: { readonly chainId: number | null };
  getSigner(): Promise<unknown | null>;
}

/**
 * `RfqDeps` wired to the real Thetanuts client, in the browser, beside the wallet.
 *
 * Three things here that are not obvious and are not negotiable:
 *
 * 1. **`keyStorageProvider: new MemoryStorageProvider()` on every construction.**
 *    Required — SDK 0.3.0's `getDefaultStorageProvider()` *throws* `INVALID_KEY`
 *    in a browser rather than falling back to `localStorage`
 *    (`docs/reviews/mcp-crosscheck.md` BUG-1). Memory storage is also the only
 *    provider that cannot outlive the tab, which is precisely the property this
 *    module wants. **Never `LocalStorageProvider`** — its own doc comment
 *    (TNU-AUDIT-0063) explains why, and it logs a warning at construction saying
 *    so.
 * 2. **The keypair is generated by the SDK but stored by us, in memory.**
 *    `rfqKeys.generateKeyPair()` is documented as *"Does NOT automatically store"*,
 *    which is exactly what we want; `getOrCreateKeyPair()` is the one that
 *    persists and is deliberately never called.
 * 3. **The dynamic `import()`** — same reasoning as `fill.ts`: nothing in the SDK
 *    evaluates until an operator has set `THETADUEL_TRADE=on` *and* a user has
 *    opened a request. The bytes ride along in the entry chunk until the build
 *    script gains `--splitting`; the evaluation does not.
 */
interface LiveRfqClient {
  optionFactory: {
    contractAddress: string;
    buildRFQRequest(params: Record<string, unknown>): RfqRequest;
    requestForQuotation(request: unknown): Promise<{ hash?: string }>;
    settleQuotationEarly(
      id: bigint,
      amount: bigint,
      nonce: bigint,
      offeror: string,
    ): Promise<{ hash?: string }>;
    cancelQuotation(id: bigint): Promise<{ hash?: string }>;
    getQuotationCount(): Promise<bigint>;
  };
  rfqKeys: {
    generateKeyPair(): RfqKeyPair;
    decryptOffer(
      data: string,
      offerorPublicKey: string,
      keyPair?: RfqKeyPair,
    ): Promise<{ offerAmount: bigint; nonce: bigint }>;
  };
  erc20: { ensureAllowance(t: string, s: string, a: bigint): Promise<unknown | null> };
  api: { getRfq(id: string): Promise<RawRfqState> };
  chainConfig?: { tokens?: Record<string, { address?: string }> };
}

export function createLiveRfqDeps(
  wallet: RfqWallet,
  options: { storage?: RfqStorage; referralId?: bigint } = {},
): RfqDeps {
  /** Built lazily, after the signer arrives — the client takes it at construction. */
  let client: LiveRfqClient | null = null;

  /** A read-only client for the polling phase — no signer, no wallet in the path
   *  of a plain GET. Also built with memory key storage, for the same BUG-1 reason. */
  let reader: { api: { getRfq(id: string): Promise<RawRfqState> } } | null = null;

  async function sdk() {
    return import("@thetanuts-finance/thetanuts-client");
  }

  async function ensureReader() {
    if (reader) return reader;
    const { ThetanutsClient, MemoryStorageProvider } = await sdk();
    const { JsonRpcProvider } = await import("ethers");
    reader = new ThetanutsClient({
      chainId: RFQ_CHAIN_ID,
      provider: new JsonRpcProvider(PUBLIC_BASE_RPC) as never,
      keyStorageProvider: new MemoryStorageProvider(),
    }) as unknown as LiveRfqClient;
    return reader;
  }

  /** Generated once per adapter, on first use, and never written anywhere. */
  let keys: { generateKeyPair(): RfqKeyPair } | null = null;

  return {
    walletId: wallet.id,
    chainId: wallet.identity.chainId,
    storage: options.storage,
    referralId: options.referralId,

    async getSigner() {
      // The second layer, on the wallet's live answer — see
      // `createLiveFillDeps.getSigner`.
      assertSigningChain(wallet.identity.chainId, "a quote request");
      const signer = await wallet.getSigner();
      if (!signer) return null;

      const { ThetanutsClient, MemoryStorageProvider } = await sdk();
      const { JsonRpcProvider } = await import("ethers");
      const provider =
        (signer as { provider?: unknown }).provider ?? new JsonRpcProvider(PUBLIC_BASE_RPC);
      client = new ThetanutsClient({
        chainId: RFQ_CHAIN_ID,
        provider: provider as never,
        signer: signer as never,
        // Required in a browser on 0.3.0, and the only provider that dies with
        // the tab. See BUG-1 in docs/reviews/mcp-crosscheck.md.
        keyStorageProvider: new MemoryStorageProvider(),
      }) as unknown as LiveRfqClient;
      keys = client.rfqKeys;
      return signer;
    },

    generateKeyPair() {
      // Available before the signer only if something already built a client;
      // otherwise the caller must connect first. `generateKeyPair` is documented
      // as NOT storing — `getOrCreateKeyPair` is the persisting one and is never
      // called anywhere in this repo.
      if (!keys) throw new Error("SIGNER_REQUIRED: connect a wallet before opening a request");
      return keys.generateKeyPair();
    },

    buildRequest(input, requesterPublicKey) {
      if (!client) throw new Error("SIGNER_REQUIRED");
      // The SDK's own builder, over params shaped by one pure exported function
      // so a test can inspect exactly what goes in. `RFQBuilderParams` documents
      // that the generated params ALWAYS carry `collateralAmount = 0`;
      // `assertZeroCollateral` checks that claim rather than trusting it.
      return client.optionFactory.buildRFQRequest(
        rfqBuilderParams(input, requesterPublicKey, options.referralId),
      );
    },

    async requestForQuotation(request) {
      if (!client) throw new Error("SIGNER_REQUIRED");
      const before = await client.optionFactory.getQuotationCount();
      const receipt = await client.optionFactory.requestForQuotation(request);
      // `requestForQuotation` returns a bare `TransactionReceipt`, not the
      // `RequestQuotationResult` that carries `quotationId` — the same
      // return-type trap FINDINGS records for `fillOrder` vs `FillOrderResult`.
      // The count before the write is the id the write assigned; it is a read,
      // not a guess, and it is why this dep exists rather than a bare call.
      return { quotationId: String(before), hash: (receipt as { hash?: string })?.hash };
    },

    async readRfq(quotationId) {
      const r = await ensureReader();
      return r.api.getRfq(quotationId);
    },

    async decryptOffer(ciphertext, offerorPublicKey, keyPair) {
      if (!client) throw new Error("SIGNER_REQUIRED");
      // The keypair is ALWAYS passed. Omitting it makes the SDK read its storage
      // provider, which for us is empty by design.
      return client.rfqKeys.decryptOffer(ciphertext, offerorPublicKey, keyPair);
    },

    async factoryAddress() {
      if (!client) throw new Error("SIGNER_REQUIRED");
      return client.optionFactory.contractAddress;
    },

    async collateralToken() {
      if (!client) throw new Error("SIGNER_REQUIRED");
      return client.chainConfig?.tokens?.USDC?.address ?? "";
    },

    async ensureAllowance(token, spender, amount) {
      if (!client) throw new Error("SIGNER_REQUIRED");
      return client.erc20.ensureAllowance(token, spender, amount);
    },

    async settleQuotationEarly(quotationId, offerAmount, nonce, offeror) {
      if (!client) throw new Error("SIGNER_REQUIRED");
      return client.optionFactory.settleQuotationEarly(
        BigInt(quotationId),
        offerAmount,
        nonce,
        offeror,
      );
    },

    async cancelQuotation(quotationId) {
      if (!client) throw new Error("SIGNER_REQUIRED");
      return client.optionFactory.cancelQuotation(BigInt(quotationId));
    },

    // Replaced by the panel: the real gate is a click on the premium.
    async confirm() {
      return false;
    },
  };
}
