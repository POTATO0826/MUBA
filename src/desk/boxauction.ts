import {
  BOX_OFFER_WINDOW_SEC,
  BOX_POLL_MS,
  MAX_RFQ_USDC,
  TARGET_RFQ_USDC,
  boxPatienceMs,
  offerWindowSeconds,
  type RfqInput,
  type RfqOffer,
} from "./rfq.ts";
import {
  condorStrikeNumbers,
  economics,
  wingUsd,
  zoneUsd,
  type CondorEconomics,
  type CondorSpec,
} from "../data/condor.ts";

/**
 * The free-draw path: a box nobody listed, priced by asking.
 *
 * ## Why this file exists at all
 *
 * `docs/plan7-measurements.md` closed §10 with one fact that decides the shape
 * of the whole mode: **no condor has ever been listed on the OptionBook.** Not
 * one, across 15,740 positions and eleven months, confirmed across 32 live reads
 * and the repo's own frozen fixture. What *is* listed is `RANGER`, on ETH and
 * BTC, about three zones per (asset, expiry) — a ladder so coarse that on the
 * frozen capture only **2 of 82 drawable bands** matched anything at all, and
 * ETH matched none (`src/data/ranger.ts`, plan7 §3.1).
 *
 * So for almost every box a player actually draws, there is nothing to fill.
 * The instrument does not exist yet. Someone has to mint it, and the only thing
 * on Base that mints a `CALL_CONDOR` is an RFQ: all 26 condors that exist were
 * created that way. That is what this file connects — `src/data/condor.ts`'s
 * pure `boxToCondor` output to `src/desk/rfq.ts`'s four-phase auction — and it
 * is deliberately the *only* connection, so the arena can price an unmatched box
 * without importing an auction protocol into a chart component.
 *
 * ## The one decision this file refuses to make for the player
 *
 * `reservePrice` is a **limit price, per contract** — for a buy, the most
 * premium the player will pay. plan7 §3.2:
 *
 * > Bid low → better price, risk nobody takes it.
 * > Bid high → filled, worse price.
 * > That is more control than a quote you passively receive, and it is a real
 * > trading decision. Render it as **"Your max bid"** with a suggested default,
 * > never as "Est. Quote".
 *
 * {@link suggestMaxBid} therefore returns a **suggestion or nothing**. It is
 * `calculateReservePrice`'s arithmetic — `numContracts × premiumPerContract`,
 * and for a USDC-collateralised condor `premiumPerContract` is `mmPrice × spot`
 * (`isBaseCollateral('CALL_CONDOR')` is false, so the coin-denominated maker
 * price is multiplied back into dollars). Given no maker price it returns
 * `null`, and the panel says so rather than inventing a number and dressing it
 * up as an estimate. A default that is secretly a guess is exactly the "Est.
 * Quote" the plan forbids, wearing a different label.
 *
 * ## What is a fact here and what is a claim
 *
 * Everything about the **payout** is computed: max loss is the premium, the
 * ceiling is the wing times the size, and the multiple is the one division in
 * `src/data/condor.ts`. Nothing in this file may originate a rate — plan7 §4.4,
 * and `test/rfq.test.ts` greps this file for one the way `test/box.test.ts`
 * greps `condor.ts`.
 *
 * Everything about **whether anyone answers** is measured elsewhere and is not
 * ours to promise: 84.2% of 1,091 historical requests received an offer at a
 * 6-second median, 89.6% of the 48 condor requests at 2–12 seconds — and RFQ
 * traffic has been completely idle for the fifteen days before this was written.
 * `unanswered` stays a first-class status all the way up (see
 * {@link BOX_UNANSWERED_COPY}).
 *
 * @see plan7-box-builder-arena.md §3.2, §3.3, §4.3, §4.4, §5
 * @see docs/plan7-measurements.md §1 (latency), §2 (the window), §3 (why RFQ)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Size
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One contract, in the on-chain units USDC collateral implies (6dp).
 *
 * The size is deliberately the smallest honest one. What bounds the money on
 * this path is the max bid, not the size — a bigger position at the same limit
 * price simply does not fill.
 */
export const BOX_CONTRACTS = 1_000000n;

/** On-chain contracts → the human count the payout arithmetic wants. */
export function contractsOf(numContracts: string | bigint): number {
  let units: bigint;
  try {
    units = BigInt(numContracts);
  } catch {
    return 0;
  }
  if (units <= 0n) return 0;
  return Number(units) / Number(BOX_CONTRACTS);
}

// ─────────────────────────────────────────────────────────────────────────────
// The max bid — suggested, never imposed
// ─────────────────────────────────────────────────────────────────────────────

/** The label, in one place, so no surface can drift back to "Est. Quote". */
export const MAX_BID_LABEL = "Your max bid";

/** What the control means, said the way a trader would say it. */
export const MAX_BID_MEANS =
  "The most premium you will pay. Bid low for a better price and risk nobody taking it; " +
  "bid high to get filled, worse. Nobody quotes you first — you name the limit and the desks " +
  "decide whether to hit it.";

/** Said when there is no maker price to derive a suggestion from. */
export const NO_SUGGESTION_COPY =
  "No maker price to suggest from, so this starts at the smallest bid this build allows. " +
  "That is a floor, not an estimate.";

/** One cent, USDC 6dp — the step the bid moves by. */
export const MAX_BID_STEP_USDC = 10_000n;

/**
 * What the SDK's `calculateReservePrice` would say, given a maker price.
 *
 * ```
 * calculateReservePrice(numContracts, mmPrice, spot, product)
 *   = numContracts × premiumPerContract(mmPrice, spot, product)
 * premiumPerContract(mmPrice, spot, product)
 *   = isBaseCollateral(product) ? mmPrice : mmPrice × spot
 * ```
 *
 * `CALL_CONDOR` is not in `BASE_COLLATERAL_PRODUCTS` (that set is
 * `INVERSE_CALL`, `INVERSE_CALL_SPREAD`, `PHYSICAL_CALL`), so the second branch
 * applies and the maker's coin-denominated price is multiplied by spot to become
 * dollars. Mirrored rather than imported for the same reason `src/data/**` never
 * imports the SDK: this must run in a browser bundle with no ethers behind it,
 * and the arithmetic is four operations long.
 *
 * Returns USDC 6dp, **unclamped**. `null` when there is no maker price — see the
 * module docblock: a suggestion that is secretly a guess is the thing plan7
 * §3.2 forbids.
 *
 * @param mmPrice The maker's price per contract in coin terms, off the MM
 * pricing surface. Nothing in this repo produces one yet, which is exactly why
 * the parameter is required and the return is nullable.
 */
export function suggestMaxBid(params: {
  numContracts: string | bigint;
  mmPrice: number | null | undefined;
  spot: number | null | undefined;
}): bigint | null {
  const contracts = contractsOf(params.numContracts);
  const { mmPrice, spot } = params;
  if (contracts <= 0) return null;
  if (mmPrice === null || mmPrice === undefined || !Number.isFinite(mmPrice) || mmPrice <= 0) {
    return null;
  }
  if (spot === null || spot === undefined || !Number.isFinite(spot) || spot <= 0) return null;
  const usd = contracts * mmPrice * spot;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return BigInt(Math.round(usd * Number(BOX_CONTRACTS)));
}

/**
 * The bid the control starts on.
 *
 * The suggestion when there is one and it fits under the cap; otherwise this
 * build's smallest rung, which is a floor rather than a forecast. Clamped, so a
 * suggestion above `MAX_RFQ_USDC` cannot arm a request the cap would refuse —
 * the panel says the suggestion was over the cap instead of quietly using it.
 */
export function defaultMaxBid(suggestion: bigint | null): bigint {
  if (suggestion === null || suggestion <= 0n) return TARGET_RFQ_USDC;
  return clampMaxBid(suggestion);
}

/** Inside `(0, MAX_RFQ_USDC]`, always. The cap is code, not a form validation. */
export function clampMaxBid(bid: bigint): bigint {
  if (bid < MAX_BID_STEP_USDC) return MAX_BID_STEP_USDC;
  if (bid > MAX_RFQ_USDC) return MAX_RFQ_USDC;
  return bid;
}

/** One step of the control, clamped. `+1` raises the bid, `-1` lowers it. */
export function stepMaxBid(bid: bigint, direction: 1 | -1): bigint {
  return clampMaxBid(bid + BigInt(direction) * MAX_BID_STEP_USDC);
}

// ─────────────────────────────────────────────────────────────────────────────
// Box → request
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the arena knows that the auction needs. */
export interface BoxAuctionInput {
  /** The connected wallet. Empty until the panel has a signer. */
  requester?: string;
  /** On-chain contracts, 6dp. Defaults to {@link BOX_CONTRACTS}. */
  numContracts?: string | bigint;
  /** The player's max bid, USDC 6dp. Clamped here too, above the network. */
  maxBidUsdc: bigint;
  /** Offer window in seconds. Snapped to the SDK-safe quantum. */
  offerWindowSec?: number;
}

/**
 * `CondorSpec` → `RfqInput`. Pure, total, and the only mapping between them.
 *
 * Three things it fixes rather than accepts, each of which is a rule somewhere
 * else in the plan:
 *
 *  - **`isLong: true`.** plan7 §5 — every box is a buy, no exceptions to check.
 *    `CondorSpec.isLong` is already the literal type `true`, so this is a
 *    restatement rather than a decision, which is the point.
 *  - **`optionType: "CALL"`.** Four ascending strikes plus CALL is what
 *    `getImplementationForStructure` resolves to `CALL_CONDOR`. A PUT with four
 *    strikes would be `PUT_CONDOR` — the same shape, a different contract, and
 *    not the instrument `src/data/condor.ts` computed the payoff for.
 *  - **`strike: s2`.** The inner floor, carried only as the breadcrumb's anchor
 *    and the panel's label. The instrument is `strikes`.
 */
export function boxRfqInput(spec: CondorSpec, input: BoxAuctionInput): RfqInput {
  const strikes = condorStrikeNumbers(spec);
  const numContracts = input.numContracts ?? BOX_CONTRACTS;
  return {
    requester: input.requester ?? "",
    underlying: spec.underlying,
    optionType: "CALL",
    strike: strikes[1],
    strikes,
    expiry: spec.expiry,
    isLong: spec.isLong,
    numContracts,
    reserveUsdc: clampMaxBid(input.maxBidUsdc),
    offerWindowSec: offerWindowSeconds(input.offerWindowSec ?? BOX_OFFER_WINDOW_SEC),
  };
}

/**
 * The wait, tuned to a 45-second auction rather than a ten-minute desk request.
 *
 * Poll fast because the answer arrives fast (6 s median, 2–12 s on condors), and
 * be patient only as long as the auction is open. Both numbers are measurements
 * turned into policy, and both live in `src/desk/rfq.ts` next to the evidence.
 */
export function boxWaitOptions(windowSec: number = BOX_OFFER_WINDOW_SEC): {
  pollMs: number;
  patienceMs: number;
} {
  return { pollMs: BOX_POLL_MS, patienceMs: boxPatienceMs(windowSec) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The money, off a real offer and nothing else
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A decrypted bid's premium, in dollars, **for the whole position**. `null` for
 * a bid we could not open.
 *
 * The nullability is load-bearing. plan7 §9: *"Prices shown come from
 * `previewFillOrder` or a decrypted offer, never from a mid."* An unreadable
 * offer has no price we are entitled to display, and the correct rendering of it
 * is the sentence that says so — not a mid, not the reserve, not a dash that
 * looks like a number.
 *
 * ## The unit, said out loud, because it is not the obvious one
 *
 * `offerAmount` is what the maker bid for the request as a whole, in USDC 6dp.
 * The division below is a **decimal conversion** — micro-USDC to dollars — and
 * `BOX_CONTRACTS` is standing in for `10⁶` because one contract in 6dp units
 * happens to be the same integer as the token's scale. Two different facts, one
 * numeral, and the coincidence held only while every request was for exactly
 * one contract.
 *
 * So this is a **position total**, never a per-contract price, and that is the
 * right shape for its callers: `RfqPanel` renders it as MAX LOSS, and the most
 * a long condor can lose is the whole premium it paid. {@link boxEconomics} is
 * where it has to become per-contract, and it says why there.
 */
export function offerPremiumUsd(offer: RfqOffer | null | undefined): number | null {
  if (!offer || offer.unreadable || offer.offerAmount === null) return null;
  if (offer.offerAmount <= 0n) return null;
  return Number(offer.offerAmount) / Number(BOX_CONTRACTS);
}

/**
 * The parameters panel's money, for a box that has a real bid on it.
 *
 * Delegates to `economics()` in `src/data/condor.ts` — the one implementation of
 * `max payout ÷ premium paid` in the repo — so this file has no arithmetic of
 * its own to get wrong and no place for a rate to hide.
 *
 * ## The division, and why it is here rather than in `offerPremiumUsd`
 *
 * `economics` takes `premiumPerContractUsd` and scales it by `numContracts`
 * itself — *"both inputs are per contract; every output is a total"*. What this
 * function is handed is the opposite: {@link offerPremiumUsd} is the maker's
 * bid for the **whole position**. Passing it straight through double-counted
 * the size, and was invisible because nothing has ever requested more than one
 * contract, where a position total and a per-contract price are the same
 * number. At two contracts it reported twice the max loss and half the
 * multiple; at ten, ten times and a tenth.
 *
 * The division belongs here and not in `offerPremiumUsd` because `RfqOffer`
 * does not carry a size. An offer is a bid on a *request*, and the request is
 * `boxRfqInput`'s, built with the very `numContracts` this function is handed —
 * so the count is knowable at this seam and nowhere upstream of it. Teaching
 * `offerPremiumUsd` to divide would mean either widening `RfqOffer`
 * (`src/desk/rfq.ts`, which reads the indexer and would then be carrying a
 * number the indexer did not send) or trusting a caller to pass the size to a
 * function whose other caller — the MAX LOSS line — wants the undivided total.
 * One conversion, at the one place that holds both halves.
 *
 * `maxLoss` therefore comes back out as the position total again — `perContract
 * × contracts` is the number that went in — so the panel's MAX LOSS and this
 * function's `maxLoss` still agree, which is the property that says the round
 * trip is a unit change and not an arithmetic one.
 *
 * @param premiumUsd The premium from a **decrypted offer**, for the whole
 * position. Not a mid, not the max bid, not an estimate.
 */
export function boxEconomics(
  spec: CondorSpec,
  premiumUsd: number | null,
  numContracts: string | bigint = BOX_CONTRACTS,
): CondorEconomics {
  const contracts = contractsOf(numContracts);
  // A count of zero is already `economics`' "no position" case and returns
  // zeros, so there is nothing to divide by and nothing worth dividing.
  const perContract = premiumUsd === null || contracts <= 0 ? 0 : premiumUsd / contracts;
  return economics(wingUsd(spec), zoneUsd(spec), perContract, contracts);
}

/**
 * What the panel may say about risk **before** any bid has arrived.
 *
 * There is no premium yet, so there is no max loss yet — but there is a bound,
 * and it is the number the player just set. Saying "at most your max bid, and
 * all of it" is true, is useful, and is not a quote. What it must never become
 * is an upside figure: a ceiling divided by a limit price is a multiple nobody
 * has offered, which is precisely the invented rate plan7 §4.4 rules out.
 */
export function preOfferMaxLossUsd(maxBidUsdc: bigint): number {
  return Number(clampMaxBid(maxBidUsdc)) / Number(BOX_CONTRACTS);
}

// ─────────────────────────────────────────────────────────────────────────────
// Copy
// ─────────────────────────────────────────────────────────────────────────────

/** `$2,600 – $2,750` — the inner zone, the one band the panel prints. */
export function bandText(spec: CondorSpec): string {
  const zone = zoneUsd(spec);
  return `$${money(zone.floor)} – $${money(zone.ceiling)}`;
}

/** One expiry, one format, one place it is written. plan7 §4.3. */
export function boxExpiryText(spec: CondorSpec): string {
  const d = new Date(spec.expiry * 1000);
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function money(value: number): string {
  return Number.isFinite(value)
    ? value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "—";
}

/** The label above the upside figure, at every detail level. plan7 §4.3, plan6 §A7. */
export const MAX_LOSS_LABEL = "Max loss";

/** Long only, so this is the whole of the risk and it is always 100% of it. */
export const MAX_LOSS_MEANS = "the premium, all of it — a box is always a buy, so nothing else can go wrong";

/**
 * The ordinary ending, said for a box rather than for a desk request.
 *
 * Never the word "error", never an amber box, never a retry button that implies
 * the first attempt was defective. The auction closed with no bids, which is a
 * sealed-bid auction working.
 */
export const BOX_UNANSWERED_COPY =
  "Nobody priced this box inside the window. That is an ordinary outcome — desks are not " +
  "obliged to answer, and a box nobody wants to make a market in is information too. Nothing " +
  "was spent beyond gas. Redraw it wider, raise the max bid, or take a listed zone instead.";

/** Said on the way in, so the wait is never a surprise. */
export const BOX_AUCTION_MEANS =
  "This box is not listed anywhere — no maker has ever created it. Asking publishes it for " +
  "a short window and lets desks bid, sealed. Historically most such requests get an answer in " +
  "seconds, and some get none at all.";
