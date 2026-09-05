import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_ZOOM_STEPS,
  MIN_ZOOM_STEPS,
  boxProblem,
  chartWindow,
  deriveLadder,
  deriveLadders,
  isPlayable,
  ladderBounds,
  ladderIndex,
  ladderStep,
  liveExpiries,
  maxZoomSteps,
  minBoxHeight,
  parseStrike,
  priceToStrike,
  snapBox,
  snapPrice,
  strikeUsd,
  wingCandidates,
  type Box,
  type LadderSnapshot,
  type PriceWindow,
  type StrikeLadder,
} from "../data/box.ts";
import {
  boxToCondor,
  condorEconomics,
  condorStrikeNumbers,
  isCondorUnderlying,
  validateSpec,
  type CondorEconomics,
  type CondorSpec,
} from "../data/condor.ts";
import {
  matchListedZone,
  zoneBox,
  zoneCoversSpot,
  rangerStrikeNumbers,
  zoneEconomics,
  zoneToRanger,
  zoneWingUsd,
  zonesFor,
  type ListedZone,
  type RangerSpec,
} from "../data/ranger.ts";
import {
  PRICE_SOURCE,
  SETTLEMENT_NOTE,
  fitToLadder,
  isFuture,
  type HistoryPoint,
  type NowBoundary,
  type PriceHistory,
} from "../data/history.ts";
import {
  PRACTICE_TAPE_CHIP,
  PRACTICE_TAPE_NOTE,
  liveOpenChip,
  openFor,
  type RoomSeat,
  type RoomView,
} from "../data/room.ts";
import { MAX_FILL_USDC } from "../desk/fill.ts";
import { usdc, winnerTakesUsdc } from "../data/stake.ts";
import { shortAddress } from "../data/wallet.ts";
import { expiryStamp, timeLeft, type Ticket, type TicketRow } from "../desk/ticket.ts";
import { sx } from "../lib/sx.ts";
import { C, FEED_STATE, MONO, SANS, meansOf, stateAge, type FeedState } from "../theme.ts";
import { TicketToggle, useTradeTicket } from "../ui/TradeTicket.tsx";

/**
 * The arena — draw a box, and the box is the option.
 *
 * > The box the player draws *is* the option. Its dimensions are the price, and
 * > the price comes from Thetanuts, not from us.
 *
 * This is plan 7 steps 1–2 as a screen: the live strike ladder, the real expiry
 * columns, a box that snaps to strikes the venue is quoting, and a parameters
 * panel that says what the position costs before it says what it pays. It
 * replaces the two screens a player would otherwise have used — the options
 * chain you scroll and the order ticket you fill — and the copy says so out
 * loud, because a screen that hides which two things it replaced is a screen
 * nobody can check.
 *
 * ## Nothing on this screen invents a number
 *
 * Every quantity here is either read off `src/data/box.ts` (the ladder) or
 * `src/data/condor.ts` (the instrument), or it is not rendered:
 *
 *  - the **expiry columns** are `liveExpiries()` and nothing else. There is no
 *    2h or 4h option and there are no evenly spaced daily columns, because the
 *    book quotes tomorrow, the day after, then weeklies (§2.2). A date that is
 *    not in that array cannot be clicked, dragged to, or submitted.
 *  - the **y-axis is `chartWindow()`**, derived from the ladder *first*, and
 *    the cell grid, the strike labels, the box, the history line and the drag
 *    arithmetic all read the same two functions, {@link yPct} and
 *    {@link priceAtFraction} (§2.5). A second scale computed anywhere would
 *    drift by a pixel and the box would stop lining up with the strikes it
 *    snaps to.
 *
 *    This was `ladderBounds()` — the ladder's whole extent — until the arena
 *    was looked at rather than tested. Measured live on 2026-09-05, the entire
 *    33-hour Chainlink window is **4.3% wide** on both ETH and BTC, while ETH's
 *    11 Sep column quotes `2200 · 2650 · 2900` and is 28% wide, so a day and a
 *    half of real price movement rendered as **15% of the plot height**. The
 *    band is now a window over the ladder, sized in the ladder's own median
 *    rung gap; `chartWindow`'s docblock in `src/data/box.ts` carries the
 *    measurements and the reason the default is 3 gaps rather than 2. The
 *    invariant is untouched: still one band, still computed in one place, still
 *    read by everyone — only its input changed.
 *
 *  - the **viewport is a view concern and never a pick concern.** The player
 *    drives it with the wheel, the keyboard and the zoom controls, and none of
 *    that reaches the board: {@link BoxViewport} is component state, it is not
 *    a field of `Box`, and {@link encodeBoxPick} has no viewport term in it.
 *    Two seats at different zoom levels draw on the same rungs and post
 *    byte-identical picks, which is the property that has to hold — not that
 *    they happen to be looking at the same rectangle of it.
 *  - the **minimum box height** is `minBoxHeight()` — one rung of the local
 *    ladder, which is $20 on the dense part of the ETH ladder and $3,500 on the
 *    sparse part of BTC's, at the same instant. It is a fact about the book,
 *    not a difficulty setting, and there is no constant here to import.
 *  - the **payout multiple** is `max payout ÷ premium paid` and is rendered
 *    only once a real premium exists. Before that it is not a placeholder, a
 *    dash or an estimate — it is absent (§4.4).
 *
 * ## One quote per box, never per pixel
 *
 * A drag paints an outline and no numbers at all. On release the raw drag goes
 * through `snapBox`, and exactly one {@link BoxBuilderProps.onQuote} fires for
 * the box that came out (§4.1). A number flickering under the cursor is
 * unreadable, and it is one price call per pixel of travel.
 *
 * The pipeline before that call is the one plan 7 §1 and §5 ask for, in order:
 * `isPlayable` → `boxToCondor` → `condorStrikeNumbers` → validation. The last
 * step is split: {@link validateSpec} runs here, in exact integer arithmetic
 * with no SDK import, and the SDK's own `validateCondor` runs at the execution
 * boundary over the `strikes` array this component hands it — the SDK pulls
 * axios, viem and ethers and must never enter the client bundle
 * (`src/data/thetanuts.tsx`).
 *
 * ## Settlement is terminal, and the copy is load-bearing
 *
 * The buyer is paid the maximum when settlement **lands** inside the zone. The
 * TWAP consumer smooths that one print against manipulation; it is not an
 * average over the option's life (§2.3). So price does not have to *stay* in
 * the band, and this file says "lands in your box at expiry" everywhere and
 * "stays within" nowhere. The box's left edge is pinned to the "now" divider
 * and is not a handle: only the right edge is real.
 *
 * ## Two seams that are props rather than imports
 *
 *  - **Price history** arrives as {@link BoxBuilderProps.history}. Absent is
 *    the ordinary state, not an error: the grid and the box render with nothing
 *    behind them. It is context and never a control — it cannot be clicked and
 *    no number in the position is derived from a point on it. The clip to the
 *    ladder's band is `fitToLadder`, the divider is `history.now.at` and the
 *    future test is `isFuture`; none of the three is reimplemented here,
 *    because a second copy of the shared-axis contract is the drift the
 *    contract exists to prevent.
 *  - **Execution** is plan 6's. This screen builds up to the confirm step and
 *    stops. Anything that would sign is behind `features.trade`, so a build
 *    without the flag renders the confirm screen and goes no further.
 *
 * @see plan7-box-builder-arena.md §2.2, §2.3, §2.4, §2.5, §4, §5, §7, §9
 * @see src/data/box.ts, src/data/condor.ts — the entire data layer
 */

// ─────────────────────────────────────────────────────────────────────────────
// Copy that is checked rather than chosen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §7 — name the two screens this replaces.
 *
 * The failure mode it guards against is a mode that reads as a novelty when it
 * is in fact the chain and the ticket, redrawn. If a player cannot tell what
 * they are no longer using, they cannot tell whether this is better.
 */
export const REPLACES_COPY =
  "This is the options chain and the order ticket, redrawn: draw a box, and the box is the option.";

/**
 * §2.3 — terminal settlement, in the words a player reads.
 *
 * "Lands in", never "stays within". The difference is the whole instrument: a
 * player who believes the price must stay inside the band for a week will draw
 * a box far too wide and pay for range they did not need.
 */
export const SETTLEMENT_COPY = "Pays the most if the price lands in your box at expiry.";

/** §2.3 — why the left edge is not a handle, said where the divider is drawn. */
export const NOW_COPY =
  "Only the right edge is real. The box is a prediction about the future, so it starts at now and ends on an expiry the book quotes.";

/** §4.3 and plan6 §A7 — the sentence that sits above every upside figure. */
export const MAX_LOSS_COPY = "The premium you pay, all of it. There is nothing else at risk.";

// ── Size: the half of a ticket that was missing ─────────────────────────────
//
// `contracts` was a prop with a default of 1 and the only caller forwarded its
// own default, so there was no way to say how much to buy. An option ticket
// without a quantity is not a ticket: the premium, the max loss, the max payout
// and the multiple are all *position* figures and every one of them was frozen
// at one contract. `economics` already scales both sides by the count
// (`src/data/condor.ts`) — nothing was reading it.

/**
 * The panel's own ceiling on the stepper, and it is **the panel's** rather than
 * the venue's.
 *
 * The maker's real remaining depth is `ListedZone.availableAmount`, published
 * in the collateral token's own units at that token's own decimals — 6dp for
 * USDC, 18dp for aBasWETH, 8dp for cbBTC — and this screen holds no collateral
 * map to convert it with (`src/data/qualify.ts` needs the spot index and the
 * `rawApiData.collateral` address to do it, and both are stripped before the
 * ladder reaches here). So the depth cap is **not claimed**: inventing one from
 * a number in unknown units is exactly the class of mistake this repo keeps a
 * file of. What is claimed is this bound, which is ours, and the fill cap
 * below, which is checked in code above the network.
 */
export const MAX_PANEL_CONTRACTS = 100;

/** `MAX_FILL_USDC` in dollars — the build's own spend cap per press, checked in
 *  `runFill` before a single dependency is touched, not merely in a view. */
export const FILL_CAP_USD = Number(MAX_FILL_USDC) / 1_000_000;

export const SIZE_COPY =
  "How many contracts this position is. Max loss, max payout and the multiple below are all for the whole position, not for one contract.";

/**
 * What a fill this build will actually sign looks like, in dollars.
 *
 * Not a discouragement and not a disclaimer — a real bound the player is
 * entitled to know before they size a position, because it is checked in
 * `runFill` above the network and a UI that hid it would be promising a press
 * that cannot happen.
 */
export function fillCapCopy(premiumPerContractUsd: number | null): string {
  const base =
    `Buying is capped at ${usd(FILL_CAP_USD, true)} a press in this build — the check is in ` +
    "the fill path, not in this panel, so it holds however the position is sized.";
  if (premiumPerContractUsd === null || !(premiumPerContractUsd > 0)) return base;
  const affordable = Math.floor(FILL_CAP_USD / premiumPerContractUsd);
  return affordable >= 1
    ? `${base} At ${usd(premiumPerContractUsd, true)} a contract that is ${affordable} contract${affordable === 1 ? "" : "s"}.`
    : `${base} At ${usd(premiumPerContractUsd, true)} a contract that is none at all: this box is priced and readable here, and not buyable from this build.`;
}

// ── Precision: what is genuinely discrete, and what is simply missing ───────

/**
 * The answer to *"is this how option trading works — I cannot size the box to
 * the cent?"*, and it is honest in both directions.
 *
 * **Strikes really are discrete.** The venue lists ETH at $20/$50/$100 spacing
 * and BTC at $500/$1,000; there is no $2,455.37 strike anywhere on this book or
 * any other, so snapping is the instrument behaving correctly rather than a
 * limitation this screen invented. What was missing is that nothing said so —
 * the box just moved under the pointer and the reason was invisible.
 */
export const DISCRETE_STRIKES_COPY =
  "Strikes are discrete. A box lands on prices the venue is quoting and on nothing between them — there is no $2,455.37 strike to buy, here or anywhere. The grid behind the chart is that list, drawn before you drag rather than after.";

/**
 * The other half, and the reason the first half is not the whole answer.
 *
 * `docs/plan7-measurements.md` records that a custom `CALL_CONDOR` **can** be
 * minted at arbitrary strikes through a request for quote, with an 8-second
 * minimum offer window and 30–60 s viable. So precision exists — on the other
 * execution path, at the cost of waiting for a maker. `src/ui/RfqPanel.tsx` is
 * written and is not mounted anywhere, so this build offers the listed path
 * only, and says which rather than letting the snap read as the whole market.
 */
export const RFQ_PRECISION_COPY =
  "A box the book does not list can be quoted on request at any strikes — a maker prices it on demand instead of it filling instantly. That path is built and is not wired into this screen in this build, so what is here is the venue's own strikes.";

/** The gap to the next rung, said in the book's own numbers. */
export function rungGapCopy(ladder: StrikeLadder | null): string | null {
  if (!ladder || ladder.prices.length < 2) return null;
  const step = ladderStep(ladder);
  if (!(step > 0)) return null;
  return `This column quotes ${ladder.prices.length} strikes, ${usd(step)} apart at the median. That spacing is the finest a box can be drawn.`;
}

// ── The listed path, said honestly ──────────────────────────────────────────
//
// plan7 §3.1 wanted snap-to-listed to be the day-one default. It is, but not
// with the instrument the plan named: the OptionBook has never listed a single
// condor, and the zone product it *does* list — 62% of every position it has
// ever traded — is `RANGER` (`docs/plan7-measurements.md` §3). These five lines
// are the three ways that instrument differs from the one §3.1 imagined,
// surfaced rather than smoothed over.

/** A box that landed on something a maker has already created. */
export const LISTED_COPY =
  "This lands on a zone the market maker has already listed, so it fills straight off the book — no waiting on anyone.";

/** §4.2 — the wing is the upside, and on a listed zone it is not the player's. */
export const LISTED_WING_COPY =
  "Its wings are the maker's, not yours. A listed zone comes as it is: you pick one, you do not size it.";

/**
 * §2.4 asks for the strike axis to be shaded by `TIER_BANDS`, which is a delta
 * bracket. Not one of the 38 listed zones on the live book published a delta,
 * so there is nothing to shade a listed zone with — and inventing one to fill
 * the gap would be a number this repo made up about a real position.
 */
export const LISTED_NO_GREEKS_COPY =
  "The book publishes no greeks for a listed zone, so this box is not shaded by delta. That figure is not hidden — it does not exist for this instrument.";

/** The common case, and not a failure. */
export const UNLISTED_COPY =
  "No listed zone matches this box, so a maker would have to price it on demand.";

/** The coarse ladder, said as a count rather than implied by an empty list. */
export const NO_ZONES_COPY = "The book lists no zone at all on this expiry.";

/**
 * On the live book, ETH's two nearest expiries each list exactly one zone and
 * spot is outside it. A player drawing around today's price for tomorrow has
 * nothing to land on, and being told that is better than being snapped
 * somewhere absurd.
 */
export const SPOT_OUTSIDE_COPY =
  "None of the listed zones on this expiry contains the current price.";

// ── The duel, said honestly ─────────────────────────────────────────────────
//
// plan7 §6 and §6.1. These four sentences are the whole of what step 4 claims,
// and each one is checkable: the lock is not a purchase, the wire is blind, the
// reveal is one chart, and nothing signs a verdict.

/**
 * §6 — what "lock" does, said on the button's own card.
 *
 * The distinction is load-bearing and it is why this is not `onConfirm`'s
 * button: `onConfirm` reads "Buy this box" and is the execution path (plan 6's,
 * behind `features.trade`). Locking commits the *drawing* to the duel and
 * touches no chain at all. One label for both would be the mislabelled action
 * the step-6 agent refused to ship.
 */
export const LOCK_COPY =
  "Locking commits this box to the duel. It does not buy anything — nothing here signs, spends or asks a market maker for a price.";

/**
 * §6 — blind means blind, said where a player would otherwise wonder.
 *
 * The claim is about the *server*, not about this screen: `view()` in
 * `src/server/rooms.ts` returns `[null, null]` for `picks` until both seats
 * have submitted, so there is no wire response a client could read the other
 * box out of. `test/rooms.test.ts` asserts that, and `test/boxduel.test.ts`
 * asserts it again over an encoded box specifically.
 */
export const BLIND_COPY =
  "Locked. Neither box is readable until both are in — the server returns nothing for either seat before that, so there is no answer to copy.";

/** §6 — the moment the mode is for. */
export const REVEAL_COPY =
  "Both boxes, one chart: yours outlined, theirs filled. Where they overlap, you agreed.";

// ─────────────────────────────────────────────────────────────────────────────
// Custody — who, if anyone, is actually holding the stake
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Proof that a duel's stake is held by something, or `null` when nothing holds
 * it.
 *
 * ## Why this is a prop and not a boolean, and why it carries an address
 *
 * The arena's stake is a **number the room carries**: `room.stakeUsdc` is set on
 * the create screen, clamped by `createRoom` in `src/server/rooms.ts`, and kept
 * in that process's `Map`. No USDC is approved, transferred, or escrowed
 * anywhere on the arena path — `useDuelStake` (`src/state/stake.ts`) is wired to
 * the seeded match flow only, and `DuelEscrow` is compiled and adversarially
 * reviewed but **not deployed** (`README.md`,
 * `docs/reviews/escrow-adversarial-review.md`).
 *
 * The screen used to say otherwise. It printed "winner takes $20.00" on every
 * duel and, at the reveal, named a mechanism, a window and a rake — "DuelEscrow's
 * six-hour refund returns both stakes, rake-free" — for a refund of stakes that
 * were never taken, from a contract that is not on chain. That is the one class
 * of untruth this screen must not commit, because it is about custody of money.
 *
 * So custody has to be *shown*, not assumed. `escrow` is here rather than a bare
 * `held: true` precisely so the claim cannot be switched on by optimism: a
 * caller that wants this screen to promise a refund has to name the deployed
 * contract that would pay it, which is the same interlock
 * `stakingAvailable()` enforces in `src/desk/escrow.ts` — a flag on its own is
 * not allowed to move money, and it is not allowed to make a promise about money
 * either.
 *
 * `null` — the only value `App` passes today — is the honest state, and it is
 * the default, so a future caller who forgets this prop degrades to the truth
 * rather than to the promise.
 */
export interface DuelCustody {
  /** The deployed `DuelEscrow` holding both stakes, checksummed or lowercase. */
  escrow: string;
  /** Hours after which that escrow refunds unconditionally — `TIMEOUT` on the
   *  contract, `REFUND_TIMEOUT_HOURS` in `src/desk/escrow.ts`. */
  refundHours: number;
}

/**
 * The stake line in the duel strip.
 *
 * With custody it is what the winner takes. Without, the amount is still shown —
 * it is a real setting, both seats agreed to it, and hiding it would make the
 * create screen's field look like it did nothing — but it is labelled for what
 * it is: notional, held by nobody.
 *
 * The custody branch says **winner takes** and therefore prints
 * `winnerTakesUsdc` — the pot less `DuelEscrow.RAKE_BPS` (4%), i.e. 1.92× the
 * stake — and not `poolOf`, which is the gross pot the escrow *holds*. It used
 * to print the pot: on a $10 stake this line promised $20.00 against a contract
 * that transfers $19.20. The branch is gated on a deployed escrow being named,
 * so it appeared in exactly the configuration where the rake is real.
 */
export function stakeBasisLine(stakeUsdc: number, custody: DuelCustody | null): string {
  return custody
    ? `${usdc(stakeUsdc)} each · winner takes ${usdc(winnerTakesUsdc(stakeUsdc))}`
    : `${usdc(stakeUsdc)} each, notional · nothing is held`;
}

/**
 * The load-bearing clause, held once so it cannot drift between screens.
 *
 * Four surfaces have to say this — the duel strip here, the hub, the create
 * screen and the room lobby — and they need it in two shapes: one that points at
 * an amount rendered directly above it, and one that stands alone where there is
 * no amount to point at. Two *sentences* would be two vocabularies for the same
 * fact, and the one that got read less would rot. Two framings of one clause is
 * a single fact with a single place to correct it.
 *
 * Everything checkable lives in here: the approval, the transfer, the escrow,
 * and the deployment status of the contract that would do all three.
 */
const STAKES_OFF_CLAUSE =
  "no USDC is approved, transferred or escrowed on this path, and DuelEscrow is written and reviewed but not deployed";

/**
 * Said in the duel strip, in the same register as the Review panel's "Buying is
 * switched off in this build".
 *
 * The house voice for a switched-off capability is: name the thing that is off,
 * say what *is* real, and say exactly what would have to change. This does all
 * three.
 *
 * "The amount above" is a deictic and it is load-bearing, so this form is only
 * correct where an amount really is rendered above it — the duel strip, the
 * create screen's pot panel. Where there is none, use {@link STAKES_OFF_COPY},
 * which is the same clause without the pointer.
 */
export const NOTIONAL_STAKE_COPY =
  "Stakes are switched off in this build. The amount above is a number this room carries, " +
  `not money anyone took — ${STAKES_OFF_CLAUSE}. The duel is for pride.`;

/**
 * The same fact where no amount is on screen to point at — the hub's line before
 * a wallet is connected, and the room lobby's settlement panel.
 *
 * The hub's version of this sentence used to be "The arena stakes real USDC on
 * Base. Connect a wallet to enter." That is the worst placement the untruth had:
 * a flat, unhedged claim about custody, read by a player who has not yet
 * committed to anything and is deciding whether to.
 */
export const STAKES_OFF_COPY =
  `Stakes are switched off in this build: ${STAKES_OFF_CLAUSE}. ` +
  "A duel's stake is a number its room carries, not money anyone took. The duel is for pride.";

/**
 * §6.1, stated as the fact it currently is rather than as a rule for later.
 *
 * A duel is scored on Δ mark of the **filled** position (plan 6 §C, the duel
 * clock in `src/engine/score.ts`). Nothing in this build fills a box — the
 * listed path quotes but does not sign without `features.trade`, and the RFQ
 * path is plan 7 §5 and is not built — so every duel that reaches this screen
 * ends with both sides unfilled, which is exactly the case §6.1 legislates for.
 * There is no tiebreak to write: `duelOutcome` reports `noVerdict` for an
 * unfilled slate, and it does so for reasons that have nothing to do with money.
 *
 * That last part is why this constant lost a sentence rather than gaining a
 * caveat. **No verdict** and **no tiebreak** are true, proven by
 * `duelOutcome` and asserted in `test/boxduel.test.tsx`; they stay exactly as
 * they were. What was never true is the refund that followed them — see
 * {@link DuelCustody}. With nothing staked there is nothing to return, and that
 * is the honest end of the sentence.
 */
export const NO_FILL_COPY =
  "Neither box was filled, so there is nothing to mark and no verdict is signed. There is no tiebreak. Nothing was staked on this duel, so there is nothing to return.";

/**
 * The same rule when a deployed escrow really is holding both stakes — the
 * sentence the screen used to print unconditionally, printed only when the thing
 * it describes exists.
 *
 * Unreachable today by construction, and deliberately so: `App` passes `null`,
 * and the only way here is a caller that can name a deployed contract. That is
 * the seam route (b) fills in, kept in one place so wiring the escrow is a
 * change to what `App` passes rather than a rewrite of the reveal.
 */
export function noFillCopy(custody: DuelCustody | null): string {
  if (!custody) return NO_FILL_COPY;
  return (
    "Neither box was filled, so there is nothing to mark and no verdict is signed. There is " +
    `no tiebreak. DuelEscrow's ${custody.refundHours}-hour refund returns both stakes, ` +
    "rake-free, with no signature from anyone."
  );
}

/**
 * §6 — plan 6's two clocks, said once, where the duel is.
 *
 * "regardless of who took the pot" was the old tail. It is a small claim next to
 * the refund sentence, but it is the same claim — it presumes a pot someone
 * takes — so it goes for the same reason. The rule itself is untouched: two
 * clocks, one for the duel and one for the option.
 */
export const TWO_CLOCK_COPY =
  "A duel resolves in minutes, on the change in mark of the filled position. The option itself settles at its own expiry regardless of how the duel ended.";

// ─────────────────────────────────────────────────────────────────────────────
// A box, on the wire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The pick encoding's version tag.
 *
 * Versioned because the transport is an opaque string the room store never
 * looks inside (`pick: string`, 1–400 chars, write-once), which means a client
 * on an older tab can post a shape a newer client would misread. A leading
 * `b1|` makes that a decode failure — "their box could not be read" — rather
 * than a box drawn at the wrong strikes.
 */
export const PICK_VERSION = "b1";

/**
 * A box → the string that goes on the room's existing lock/reveal transport.
 *
 * Pipe-separated rather than JSON for one reason worth writing down: strikes
 * are 8dp **decimal strings** (`"265000000000"` is $2,650) and a JSON round
 * trip through a number would quietly turn them into floats. Every field here
 * stays text, and the only number is a unix second.
 *
 * Length is bounded well under the store's 400-character limit: three strike
 * strings on the widest live ladder are 12 characters each, so a BTC box is
 * about 60. That is asserted rather than assumed in `test/boxduel.test.ts`.
 */
export function encodeBoxPick(box: Box): string {
  return [PICK_VERSION, box.underlying, box.floor, box.ceiling, box.wing, String(box.expiry)].join(
    "|",
  );
}

/**
 * The wire string → a box, or `null`.
 *
 * `null` for anything that is not exactly this encoding, including a pick from
 * a different mode entirely — the room store is mode-agnostic and a stale tab
 * can still post one. A screen that guessed at a malformed pick would draw an
 * opponent's box at strikes they never chose, which is worse than drawing
 * nothing and saying so.
 */
export function decodeBoxPick(raw: string | null | undefined): Box | null {
  if (typeof raw !== "string") return null;
  const parts = raw.split("|");
  if (parts.length !== 6) return null;
  const [version, underlying, floor, ceiling, wing, expiry] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== PICK_VERSION) return null;
  if (!/^[A-Za-z0-9]{1,12}$/.test(underlying)) return null;
  // Exact integer parses, the same ones the ladder uses. A strike that does not
  // parse is not rounded into one.
  if (parseStrike(floor) === null || parseStrike(ceiling) === null) return null;
  if (parseStrike(wing) === null) return null;
  const at = Number(expiry);
  if (!Number.isInteger(at) || at <= 0) return null;
  return { underlying, floor, ceiling, wing, expiry: at };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * `1789113600` → `"Sep 11"`, in UTC because the book's expiries are 08:00 UTC
 * and a local-time render would show two different dates to two players in one
 * duel.
 *
 * plan7 §4.3's *"one expiry, one number, shown once"* is a rule about the
 * screen rather than about this function: the picker **offers** dates and the
 * panel **states** one, as `by Sep 11`, and the two never both claim to be the
 * position's expiry. `test/boxbuilder.test.tsx` asserts `by ` appears once.
 */
export function expiryLabel(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  return `${MONTHS[d.getUTCMonth()] ?? "?"} ${d.getUTCDate()}`;
}

/** `90_000` → `"2 min"`, `45_000` → `"45s"`. For the stale gap, and only that. */
export function shortAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 90 ? `${seconds}s` : `${Math.round(seconds / 60)} min`;
}

/** `2650` → `"$2,650"`. Whole dollars for an axis, cents for money. */
export function usd(value: number, cents = false): string {
  if (!Number.isFinite(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  })}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The one scale
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chart's price band. Always `chartWindow`, never anything else.
 *
 * The rule this replaces read *"always `ladderBounds`, never anything else"*,
 * and it is worth saying what survived and what did not, because the sentence
 * is nearly the same and the code is not.
 *
 * **What did not survive: the ladder's full extent as the scale.** It made the
 * price line unreadable on exactly the columns where the book is coarsest — 15%
 * of the plot height on a three-rung ETH column, against a live 33-hour range of
 * 4.3%. See `chartWindow` in `src/data/box.ts` for the measurements.
 *
 * **What survived, unchanged: there is one band.** It is produced by one
 * function, in one `useMemo`, and every consumer reads that one value — the cell
 * grid, the rung labels, the spot pill, the box, the opponent's box, the
 * history clip, and `priceAtClientY`'s drag arithmetic. §2.5 forbids *two*
 * scales drifting apart, and two scales are still impossible here. A band that
 * the player can zoom is still a single band; it is recomputed for every
 * consumer together, in the same render, from the same window.
 *
 * `Band` stays two numbers rather than becoming `PriceWindow` because `yPct`
 * and `priceAtFraction` need nothing else, and a `PriceWindow` is assignable to
 * it. The extra `below`/`above` counts are for the screen to *talk* about the
 * rungs it is not showing, never for the arithmetic.
 */
export interface Band {
  lo: number;
  hi: number;
}

/**
 * Where the player has the board scrolled to. **View state, and only that.**
 *
 * `steps` is the window's half-height counted in the ladder's own median rung
 * gap, and `centre` is the price in the middle of the window — `null` meaning
 * "wherever the market is", which is the default both seats open on.
 *
 * Kept deliberately outside `Box`. The whole safety argument for letting the
 * player zoom is that the viewport cannot reach the position: `snapBox` takes
 * its strikes from the ladder, `encodeBoxPick` serialises four ladder-derived
 * fields, and neither has any idea this type exists. A player zoomed to a $60
 * window and a player looking at the whole $700 ladder click the same rung and
 * post the same string.
 */
export interface BoxViewport {
  steps: number;
  centre: number | null;
}

/**
 * Price → vertical position, as a percentage of the plot, top-down.
 *
 * The single y-axis (§2.5). The grid rows, the strike labels, the box, the
 * history line and the drag arithmetic all call this; nothing computes a second
 * one. A degenerate band (one rung, or a ladder that lost its extremes) puts
 * everything on the middle line rather than dividing by zero.
 */
export function yPct(band: Band, price: number): number {
  const span = band.hi - band.lo;
  if (!Number.isFinite(price) || !Number.isFinite(span) || span <= 0) return 50;
  return (1 - (price - band.lo) / span) * 100;
}

/** {@link yPct} inverted: a 0–1 fraction down the plot → a price. */
export function priceAtFraction(band: Band, fraction: number): number {
  const span = band.hi - band.lo;
  if (!Number.isFinite(fraction) || !Number.isFinite(span) || span <= 0) return band.lo;
  return band.lo + (1 - fraction) * span;
}

/** The time axis, as a percentage across the plot. Continuous, unlike the
 *  expiry columns drawn on it, which are the book's real dates and only those. */
export function xPct(t0: number, t1: number, t: number): number {
  const span = t1 - t0;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.max(0, Math.min(100, ((t - t0) / span) * 100));
}

/**
 * How many median gaps the line may be drawn across before it is cut.
 *
 * Chainlink updates on a deviation threshold under a heartbeat ceiling, so the
 * gaps are irregular by construction — the history module measured a 270s
 * median against a 1,232s maximum for ETH. A single polyline through the long
 * one draws twenty minutes of straight line at prices the oracle never
 * published, which is the same lie as running the line flat to the divider,
 * only in the middle of the chart where it is harder to notice.
 */
export const GAP_FACTOR = 4;

/**
 * Split the line wherever the feed went quiet for longer than
 * {@link GAP_FACTOR} × the median gap **this read actually measured**.
 *
 * The threshold is the data's own, from `meta.granularity`, not a constant: a
 * quiet asset has a wide median and should not be chopped into confetti, and a
 * busy one should not have a ten-minute hole papered over. A run of one point
 * is dropped — a polyline of one point draws nothing anyway, and drawing a lone
 * dot would imply a reading the chart cannot place in time.
 */
export function segments(
  points: readonly HistoryPoint[],
  medianGapMs: number | null | undefined,
): readonly (readonly HistoryPoint[])[] {
  const limit =
    typeof medianGapMs === "number" && medianGapMs > 0 ? medianGapMs * GAP_FACTOR : Infinity;
  const out: HistoryPoint[][] = [];
  let run: HistoryPoint[] = [];
  for (const p of points) {
    const prev = run[run.length - 1];
    if (prev && p.t - prev.t > limit) {
      if (run.length > 1) out.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 1) out.push(run);
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A box that landed on a zone the book already carries — plan7 §3.1's
 * day-one path, with the instrument that actually exists there.
 *
 * Both halves are carried because both are needed and neither implies the
 * other: `zone.order` is the row `previewFillOrder` and `fillOrder` take, and
 * `spec` is what the position *is*. `spec.payoutType` is `"ranger"`, and the
 * SDK's own payout helpers price a four-strike order as a **condor** unless
 * they are told otherwise — so the flag travels with the fill rather than
 * being re-derived at the boundary.
 */
export interface ListedFill {
  zone: ListedZone;
  spec: RangerSpec;
}

/**
 * Which of §3's two execution paths one box takes.
 *
 * Exported so a caller can ask the same question the screen asks, and get the
 * same answer, without re-deriving the match: a second implementation of "does
 * this box exist on the book" would eventually answer differently from the
 * sentence the player just read.
 *
 * `null` is ordinary. The listed ladder is about three zones per expiry on two
 * assets, so most boxes a player can draw match nothing — see
 * `docs/plan7-measurements.md` §3.3.
 */
export function listedFill(
  box: Box | null | undefined,
  snapshot: LadderSnapshot | null | undefined,
  at: number,
): ListedFill | null {
  const zone = matchListedZone(box, snapshot, at);
  return zone === null ? null : { zone, spec: zoneToRanger(zone) };
}

/**
 * The money figures for **the instrument that will actually fill** — the eighth
 * money bug, closed.
 *
 * ## The bug
 *
 * `matchListedZone` matches a drawn box to a listed zone on underlying, expiry,
 * floor and ceiling. It does **not** match on the wing, and that is deliberate
 * and correct: a listed zone's wings are the maker's, the player picks a band
 * and takes the wings that come with it, and `LISTED_WING_COPY` says exactly
 * that on screen. The wing appears in `matchListedZones` only as a sort key.
 *
 * The panel then computed `condorEconomics(boxToCondor(box), premium, …)` while
 * `App.quoteBox` set `premium` from `zoneQuote(match.zone)` — the maker's real
 * `previewFillOrder` price for **that order**. So the numerator (max payout,
 * taken from the drawn box's wing) and the denominator (the premium, taken from
 * the listed order) came from two different contracts, and the multiple between
 * them was a ratio of two instruments.
 *
 * Reproduced against `test/fixtures/orders.json`: a box drawn on a listed band
 * carrying a $4,000 wing, matched to a zone whose wing is $500 and whose
 * previewed premium is $120 —
 *
 * ```
 *   screen said:  MAX LOSS $120 · MAX PAYOUT $4,000 · 33.33×
 *   order pays:   MAX LOSS $120 · MAX PAYOUT   $500 ·  4.17×
 * ```
 *
 * Reachable, not theoretical: `wingEditable` blocks the stepper only *while* a
 * match exists, and `endEdit` carries `current.base.wing` across a band drag —
 * so widen the wing on an unlisted band, drag onto a listed one, and the panel
 * is quoting one contract and paying out another. On today's live book
 * `defaultWing` happens to equal the listed wing, which made it correct by
 * coincidence rather than by construction.
 *
 * ## The fix
 *
 * One instrument answers all the money questions. With a match, that is the
 * zone: `zoneEconomics` takes the wing off `match.zone` — the same order the
 * premium was previewed against — so the numerator and the denominator are two
 * facts about one contract and the ratio between them means something. Without
 * a match the box is the condor the player drew and nothing changes.
 *
 * Exported so a test can drive the exact state the UI can reach — a `snapBox`
 * with a widened wing on a listed band — without having to synthesise a drag.
 */
export function positionEconomics(
  spec: CondorSpec | null,
  match: ListedFill | null,
  premiumPerContractUsd: number,
  contracts: number,
): CondorEconomics | null {
  if (match) return zoneEconomics(match.zone, premiumPerContractUsd, contracts);
  return spec ? condorEconomics(spec, premiumPerContractUsd, contracts) : null;
}

/**
 * The wing the position actually has, in dollars — the maker's on a matched
 * box, the player's on an unmatched one.
 *
 * The same correction as {@link positionEconomics}, applied to the figure the
 * WING WIDTH row prints. That row already says *"Fixed here: this box fills a
 * zone the maker already listed, and its wings came with it"* whenever there is
 * a match; printing the drawn box's wing under that sentence made the sentence
 * false about the number directly above it.
 */
export function positionWingUsd(box: Box | null, match: ListedFill | null): number | null {
  if (match) return zoneWingUsd(match.zone);
  if (!box) return null;
  return strikeUsd(box.wing);
}

/**
 * The arena's trade ticket — a zone or a drawn box, written as the position it
 * is rather than as a rectangle.
 *
 * The cells on this board are deliberately price-free (§4.4: pricing several
 * hundred structures nobody has quoted is either an invented model or an
 * invented number), and that stays true — this is only ever built for a box the
 * player has actually drawn or a zone the maker has actually listed, both of
 * which are one real instrument each.
 *
 * ## What it may and may not say
 *
 *  - **The strikes, the band, the wing and the expiry** are the order's own, or
 *    the drawing's, and are always available.
 *  - **The money** is available only once something has priced it. A listed
 *    zone is priced by `previewFillOrder` when it is picked; an unlisted box is
 *    not priced at all until a maker answers an RFQ, which this build does not
 *    ask. So max loss, the breakevens and the multiple render as dashes with
 *    the reason rather than as estimates.
 *  - **The greeks are not available, and the reason is real.** Not one of the
 *    38 listed zones on the live book published a set (`src/data/ranger.ts`),
 *    and `src/data/greeks.ts` can only compose one from four per-leg
 *    volatilities, which the ladder this screen reads does not carry. So the
 *    row says what `LISTED_NO_GREEKS_COPY` says: the figure is not hidden, it
 *    does not exist for this instrument.
 *
 * Terminal settlement is stated in the app's own words — *lands in your box at
 * expiry*, never "stays within". The instrument is European and the price has
 * to be there at one instant, not throughout.
 */
export function zoneTicket(input: {
  id: string;
  underlying: string;
  /** The four strikes in dollars, ascending. */
  strikes: readonly [number, number, number, number];
  expiry: number;
  /** Premium per contract in dollars, or `null` when nothing has priced it. */
  premium: number | null;
  contracts: number;
  econ: CondorEconomics | null;
  /** The listed order this fills, when it fills one. */
  match: ListedFill | null;
  /** Live spot, or `null`. */
  spot: number | null;
  now: number;
}): Ticket {
  const { underlying, strikes, expiry, premium, contracts, econ, match, spot, now } = input;
  const [a, floor, ceiling, d] = strikes;
  const wing = floor - a;
  const priced = premium !== null && premium > 0;
  const rows: TicketRow[] = [
    {
      key: "instrument",
      label: "INSTRUMENT",
      value: `${underlying} · ${match ? "listed zone (RANGER)" : "long call condor"}`,
      note: match
        ? "A zone a maker has already created and signed. You buy it as it is."
        : "Four legs at four strikes, held long. Nobody has created this one — a maker would have to price it on demand.",
      source: match ? "venue" : "derived",
    },
    {
      key: "strikes",
      label: "STRIKES",
      value: strikes.map((k) => usd(k)).join(" · "),
      note: "The four lines the payoff turns on: it climbs from the first, is flat between the middle two, and falls to the fourth.",
      source: match ? "venue" : "derived",
    },
    {
      key: "band",
      label: "BAND",
      value: `${usd(floor)} – ${usd(ceiling)}`,
      note: SETTLEMENT_COPY,
      source: match ? "venue" : "derived",
    },
    {
      key: "wing",
      label: "WING",
      value: usd(wing),
      note: match
        ? "The maker's, not yours — and it is the most this can pay per contract."
        : "The distance beyond each edge, and the most this can pay per contract.",
      source: match ? "venue" : "derived",
    },
    {
      key: "expiry",
      label: "EXPIRY",
      value: `${expiryStamp(expiry)} · ${timeLeft(expiry * 1000 - now)} left`,
      note: "European and cash-settled: the price has to land in the band at that instant, not stay there.",
      source: "venue",
    },
    {
      key: "spot",
      label: "SPOT",
      value:
        spot === null
          ? "—"
          : `${usd(spot, true)} · ${spot >= floor && spot <= ceiling ? "inside the band" : spot < floor ? `${usd(floor - spot)} below the floor` : `${usd(spot - ceiling)} above the ceiling`}`,
      note:
        spot === null
          ? "The venue publishes no spot for this underlying right now."
          : "Where the price is today. It has to be in the band on the expiry date, and nowhere in particular before it.",
      source: spot === null ? null : "venue",
    },
    {
      key: "size",
      label: "SIZE",
      value: `${contracts} ${contracts === 1 ? "contract" : "contracts"}`,
      note: "Both dollar figures below are for the whole position; the multiple between them is not affected by size.",
      source: "derived",
    },
    {
      key: "maxLoss",
      label: "PREMIUM · MAX LOSS",
      value: priced && econ ? usd(econ.maxLoss, true) : "—",
      note: priced
        ? MAX_LOSS_COPY
        : match
          ? "Pick this zone to have it priced against the maker's own order — nothing here estimates it."
          : "Nothing has priced this box, and this build asks no maker for a quote, so there is no premium to state.",
      source: priced ? "venue" : null,
    },
    {
      key: "maxPayout",
      label: "MAX PAYOUT",
      value: econ ? usd(econ.maxPayout, true) : "—",
      note: "Paid in full anywhere inside the band at expiry, and tapering to nothing across each wing.",
      source: match ? "venue" : "derived",
    },
    {
      key: "breakeven",
      label: "BREAKEVEN",
      value:
        priced && premium !== null ? `${usd(a + premium)} – ${usd(d - premium)}` : "—",
      note:
        priced && premium !== null
          ? "Between these two the position is ahead at expiry; outside them the premium is not recovered."
          : "The outer strikes moved in by the premium paid. Without a premium there is nothing to move them by.",
      source: priced ? "derived" : null,
    },
    {
      key: "multiple",
      label: "PAYOUT MULTIPLE",
      value: econ && econ.payoutMultiple !== null ? `${econ.payoutMultiple.toFixed(2)}×` : "—",
      note:
        econ && econ.payoutMultiple !== null
          ? "The ceiling divided by the premium — what the position returns if the price lands in your box at expiry."
          : "The ceiling divided by the premium. It is absent rather than placeheld until a real premium exists.",
      source: econ && econ.payoutMultiple !== null ? "derived" : null,
    },
    {
      key: "greeks",
      label: "DELTA · GAMMA · THETA · VEGA",
      value: "—",
      note: LISTED_NO_GREEKS_COPY,
      source: null,
    },
  ];

  return {
    id: input.id,
    state: match ? "live" : "not-dealt",
    title: `${underlying} ${usd(floor)}–${usd(ceiling)} · by ${expiryLabel(expiry)}`,
    subtitle: match
      ? `RANGER · resting on the OptionBook · ${usd(wing)} wings`
      : `CALL_CONDOR · not listed · ${usd(wing)} wings`,
    banner: match ? LISTED_COPY : UNLISTED_COPY,
    footer: [
      match ? LISTED_WING_COPY : RFQ_PRECISION_COPY,
      fillCapCopy(priced ? premium : null),
    ],
    rows,
  };
}

/**
 * Where the ladder on screen came from, and when it was read.
 *
 * The heading over the chart asserted `LIVE STRIKES` unconditionally on the
 * populated path, and `src/data/thetanuts.tsx` deliberately keeps serving the
 * last good ladder when a refresh fails (*"stale beats blank"*). So a board of
 * real-but-old strikes wore a LIVE label while the footer said otherwise, with
 * no age anywhere on the panel — and `theme.ts` is explicit that for STALE
 * *"the age is the disclosure; the word alone is not"*.
 *
 * This is the same three-state seam `ParlayPick` grew for the option book: the
 * source's own word, plus the timestamp of the read, so the screen can say
 * which of the three it is instead of guessing. It is metadata about the
 * snapshot rather than market data, so it does not break this view's rule that
 * {@link BoxBuilderProps.snapshot} is the only book it reads.
 *
 * Omitted or `null` means the caller did not say. The heading then makes **no**
 * provenance claim at all — it reads `ETH · STRIKES` — because the failure this
 * closes is a claim nothing backed.
 */
export interface LadderFeed {
  /** `theme.ts`'s vocabulary, not a private one. `feedState()` translates a
   *  `MarketMeta.source` into it. */
  state: FeedState;
  /** `MarketMeta.fetchedAt`, ms. `0` means the snapshot carried no timestamp,
   *  and `stateAge` reads that as "no age at all" rather than inventing one. */
  at: number;
}

export interface BoxBuilderProps {
  /**
   * One raw `fetchOrders()` capture plus the bundled chain config — the ladder's
   * only input, and the only market data this screen reads. `test/fixtures/orders.json`
   * is exactly this shape and so is `RawMarket` from `src/server/thetanuts.ts`.
   */
  snapshot: LadderSnapshot | null;
  /**
   * Where {@link BoxBuilderProps.snapshot} came from and when it was read.
   *
   * See {@link LadderFeed}. Optional, and omitting it makes the chart heading
   * assert nothing rather than assert LIVE — a caller that has not thought
   * about provenance degrades to silence, never to a claim.
   */
  feed?: LadderFeed | null;
  /** Live USD spot, for the marker line. `null` is ordinary and draws nothing. */
  spot?: (underlying: string) => number | null;
  /**
   * Everything the venue has a book for, so assets that cannot be drawn on
   * still appear — greyed, with the reason, rather than silently missing (§2.1).
   * Only ETH and BTC can carry a condor.
   */
  qualified?: readonly string[];
  /**
   * One `createHistorySource().history(underlying)` answer.
   *
   * A **prop** rather than an import of the source itself: this view opens no
   * socket, spends no RPC call and holds no opinion about which feed the line
   * came from. `null` or omitted is the ordinary state and not an error — the
   * grid, the ladder, the box and the quote are all independent of it, and a
   * chart that could not be drawn costs the screen its chart and nothing else.
   *
   * The module's own type rather than a structural echo of it, because three
   * things here are read off the answer and not off the points:
   * `now.at` is the divider, `now.staleMs` is how much of the right edge is
   * legitimately blank, and `meta.granularity.medianGapMs` sets where
   * {@link segments} cuts the line.
   */
  history?: PriceHistory | null;
  /**
   * The asset chip changed. Fired **only** on a real change, never at mount.
   *
   * The asset is this screen's own state — it is chosen by clicking a chip
   * here, and nothing above needs to control it. But {@link BoxBuilderProps.history}
   * is one asset's price line, fetched by the caller, and a caller that cannot
   * hear the switch would keep drawing ETH's prints behind BTC's ladder. They
   * would all clip out (`fitToLadder` filters, it never rescales) and the panel
   * would read "33 prints ran outside the ladder" instead of showing BTC, which
   * is an honest sentence about a chart nobody asked for.
   *
   * So: a notification, not a controlled value. The screen still owns the
   * selection, and a caller that omits this simply gets one asset's history.
   */
  onUnderlying?: (underlying: string) => void;
  /** Names the feed the line came from. Defaults to the history module's own
   *  `PRICE_SOURCE`; rendered only when there is a line to attribute. */
  priceSource?: string;
  /** The settlement-feed caveat, defaulting to the history module's own
   *  `SETTLEMENT_NOTE` — §9 requires the disagreement said out loud, and it is
   *  said in one place so no surface invents its own wording. */
  settlementNote?: string;
  /** Wall clock in ms. Fixed at mount when omitted, so a render is stable. */
  now?: number;
  /**
   * The **actual** premium for the box on screen, per contract, in dollars —
   * `previewFillOrder`'s number or a decrypted offer's. Never a mid, never an
   * estimate (§9). `null` means not quoted yet, and the panel then renders no
   * multiple at all rather than a placeholder.
   */
  premium?: number | null;
  /** Contracts the quote was for. One is the default and the honest unit here. */
  contracts?: number;
  /**
   * Fired **once per released box**, never during a drag (§4.1). `strikes` is
   * `condorStrikeNumbers(spec)` — the human-readable array the SDK's
   * `validateCondor` and `buildCondorRFQ` both take, handed over so the SDK
   * check runs at the execution boundary where the SDK actually lives.
   *
   * The third argument is **which of plan7 §3's two execution paths this box
   * takes**, and it is the whole of the listed path's interface:
   *
   *  - a {@link ListedFill} means the box landed on a zone resting on the
   *    OptionBook. Quote it with `previewFillOrder(match.zone.order, …)` and
   *    fill it with `fillOrder` — instant, and with no maker round trip at all.
   *    The instrument is `match.spec`, a `RANGER`, and it is **not** the
   *    `CondorSpec` in the first argument.
   *  - `null` means nothing on the book matches, which is the ordinary case on
   *    a ladder this coarse. That box is the condor in the first argument, and
   *    it has to be priced on demand.
   */
  onQuote?: (
    spec: CondorSpec,
    strikes: [number, number, number, number],
    match: ListedFill | null,
  ) => void;
  /**
   * The confirm step's action. Reached only with `features.trade` on; absent
   * leaves the confirm screen readable and inert, which is the state a build
   * without the flag ships in.
   *
   * Same third argument, and for the same reason: the thing that gets signed is
   * a fill against `match.zone.order` when there is a match, and a request for
   * a price when there is not.
   */
  onConfirm?: (
    spec: CondorSpec,
    strikes: [number, number, number, number],
    match: ListedFill | null,
  ) => void;
  /**
   * Override the `/api/config` read. `undefined` asks the server once at mount;
   * `false` keeps the screen inert with no network call at all.
   */
  tradeEnabled?: boolean;
  onBack?: () => void;

  // ── plan7 §6 — the duel ───────────────────────────────────────────────────
  //
  // Four props, and they are the same four `SpotDiff` took off the same
  // transport before it was deleted (`git show 9d8f704^:src/views/SpotDiff.tsx`).
  // Deliberately additive: with none of them this screen is exactly the solo
  // builder it was, which is what "extend the contract" has to mean if the
  // contract was working.

  /**
   * The duel this box is being drawn for, or `null` when the arena was opened
   * on its own.
   *
   * The room's `picks` are the whole of the lock/reveal transport, and their
   * blindness is the **server's** property rather than this screen's: `view()`
   * in `src/server/rooms.ts` returns `[null, null]` until both seats have
   * submitted, so a client that wanted to cheat has nothing to read. This view
   * therefore does not have to hide anything — there is nothing here to hide.
   */
  room?: RoomView | null;
  /** Which side of the table you are on. `null` is a bystander who opened the
   *  link: they see the duel and cannot lock, and the server would refuse them
   *  with `NOT_A_PLAYER` if they tried. */
  seat?: RoomSeat | null;
  /** The room transport is mid-flight, so the lock button must not fire twice. */
  locking?: boolean;
  /**
   * Lock this seat's box into the room — `useRoom().pick`, with the box already
   * encoded by {@link encodeBoxPick}.
   *
   * Write-once at the server. It is **not** {@link BoxBuilderProps.onConfirm}:
   * that one buys, this one commits a drawing, and they have separate buttons
   * with separate labels for exactly that reason.
   */
  onLock?: (pick: string) => void;
  /**
   * The underlying the room's seed dealt — §6's *"same underlying, same budget,
   * dealt by `spinSlice`"*.
   *
   * A name, not a market: `spinSlice` runs in `App`, over the book it already
   * holds and the room's own seed, so both seats deal the same asset from the
   * same number. Passing the *name* rather than the slice keeps this screen's
   * rule intact — the only market data it reads is
   * {@link BoxBuilderProps.snapshot}.
   *
   * Honoured only when the dealt asset can actually carry the instrument and
   * has live expiries on this snapshot; otherwise it is ignored and the player
   * picks, because a duel pinned to an asset with no ladder is a duel with no
   * screen. `null` (no room, or nothing dealt) leaves the chips as they were.
   */
  dealt?: string | null;
  /**
   * What is actually holding this duel's stake — `null`, the default, when
   * nothing is.
   *
   * See {@link DuelCustody}. It defaults to `null` rather than being required so
   * that forgetting it degrades to the truth: a caller who does not think about
   * custody gets a screen that promises none.
   */
  custody?: DuelCustody | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The trade flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask the server whether real trading is switched on.
 *
 * Same shape as the hook in `src/ui/RfqPanel.tsx` and the one in
 * `src/views/Parlay.tsx`: read at mount, `no-store`, fail closed on anything
 * that went wrong. Duplicated rather than imported because both of those are
 * private to files other agents own; the discipline is what matters and it is
 * identical.
 */
function useTradeFlag(override: boolean | undefined): boolean {
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (override !== undefined) return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        const body = (await res.json()) as { features?: { trade?: boolean } };
        if (live) setOn(body.features?.trade === true);
      } catch {
        // Fail closed, silently. A static build has no server to ask and is not
        // misconfigured.
      }
    })();
    return () => {
      live = false;
    };
  }, [override]);

  return override ?? on;
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

const CARD =
  "border:1px solid #27272a;border-radius:14px;background:linear-gradient(180deg,#101012,#0c0c0e)";
const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const VALUE = `font:700 15px/1 ${MONO};color:${C.text}`;
const NOTE = `font:400 11px/1.55 ${SANS};color:${C.faint}`;

const BTN = (tone: string, filled: boolean, off = false): string =>
  `height:38px;padding:0 18px;border-radius:10px;cursor:pointer;font:700 12px/1 ${SANS};` +
  (filled
    ? `background:${tone};color:${C.bg};border:1px solid ${tone}`
    : `background:transparent;color:${C.text};border:1px solid ${C.borderMid}`) +
  (off ? ";opacity:.45;cursor:not-allowed" : "");

const CHIP = (active: boolean, off = false): string =>
  `height:30px;padding:0 12px;border-radius:8px;font:700 11px/1 ${MONO};` +
  (off
    ? `background:transparent;color:${C.faint};border:1px dashed ${C.border};cursor:not-allowed`
    : active
      ? `background:${C.accent};color:${C.bg};border:1px solid ${C.accent};cursor:pointer`
      : `background:transparent;color:${C.muted};border:1px solid ${C.border};cursor:pointer`);

/**
 * Chart geometry, in CSS pixels. The plot is what every percentage is of.
 *
 * The price axis moved from the left gutter to the right one, which is where a
 * trading chart puts it and where the owner's reference has it: the newest
 * price is at the right edge, so the scale that reads it belongs beside it
 * rather than a chart's width away. `bottom` grew to hold two lines of
 * wall-clock label under each expiry column.
 */
const CHART_H = 400;
const PAD = { top: 18, right: 122, bottom: 42, left: 14 };

/** Where an in-window price label sits in the right gutter, and where a rung the
 *  zoom has parked sits instead — far enough apart that a pinned label never
 *  lands on top of a real one. */
const AXIS_LABEL_X = 4;
const AXIS_PARKED_X = 62;

/** Percentages that address the plot must stay on it — a rung belonging to a
 *  neighbouring column can sit outside the window, and a cell drawn at -8% would
 *  escape the rounded corner it is supposed to live inside. */
const clampPct = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);

/**
 * `1788595200000` → `"08:00 UTC"`.
 *
 * UTC for the same reason {@link expiryLabel} is: the book's expiries are
 * 08:00Z and a local-time axis would print two different clocks to the two
 * players in one duel.
 */
export function utcClock(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC`;
}

/**
 * The bottom axis's caption, held here because it is the sentence that stops
 * the time axis from being read as a resolution it does not have.
 *
 * The owner's reference chart columns 10 seconds apart. This venue's columns are
 * whole days, and drawing anything finer would be inventing dates nobody can
 * trade (§2.2). Saying so is cheaper than being asked.
 */
export const TIME_AXIS_COPY =
  "Columns are the book's own expiries, daily at 08:00 UTC. There is no intraday expiry in this product, so there is no finer column to draw.";

/** The legend under the board, in one place so the three states cannot drift
 *  from the three fills that render them. */
export const CELL_LEGEND_COPY =
  "Each cell is a band you can draw, by that date. Filled cells are zones a maker has already listed — those fill straight off the book. The rest would have to be priced on demand.";

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────

/** A drag in progress: two prices, unsnapped, and no numbers on screen. */
interface Drag {
  from: number;
  to: number;
}

/**
 * Which handle of a committed box is being dragged.
 *
 * The set is deliberately short, and the two that are missing are the design
 * decision rather than an omission:
 *
 *  - **there is no left handle.** The box starts at now because it is a
 *    prediction, and a left edge dragged back over prints that have already
 *    happened is not a position anyone can hold (§2.3). It is pinned, and the
 *    copy says so.
 *  - **there is no free horizontal resize.** `expiry` and the two corners step
 *    the right edge between *live expiry columns* and nothing in between,
 *    because the only dates that exist are the ones the book quotes (§2.2).
 *    Dragging to a Tuesday that is not listed would be a date the player cannot
 *    buy, drawn as though they could.
 */
type EditKind = "move" | "floor" | "ceiling" | "expiry" | "corner-floor" | "corner-ceiling";

/**
 * A box being edited: where the grab started, what the box was, and the live
 * preview.
 *
 * `base` is frozen at grab time so every frame is computed from the original
 * rather than from the previous frame — an edit that accumulated its own
 * rounding would walk the box a rung at a time while the pointer stood still.
 * The preview is in **rung indices**, not prices, which is what makes the box
 * land on the ladder by construction rather than by a snap at the end.
 */
interface BoxEdit {
  kind: EditKind;
  /** The price under the pointer when the handle was grabbed. */
  fromPrice: number;
  /** The box as it stood at grab time. */
  base: Box;
  /** Live preview, as indices into the ladder that was current at grab time. */
  floorIndex: number;
  ceilingIndex: number;
  /** Live preview of the right edge — always one of `columns`. */
  expiry: number;
  /** True once the pointer has actually moved, so a click that happens to land
   *  on a handle does not count as an edit and re-fire a quote. */
  moved: boolean;
}

export function BoxBuilder({
  snapshot,
  feed = null,
  spot,
  qualified,
  history,
  onUnderlying,
  priceSource,
  settlementNote,
  now,
  premium = null,
  contracts = 1,
  onQuote,
  onConfirm,
  tradeEnabled,
  onBack,
  room = null,
  seat = null,
  locking = false,
  onLock,
  dealt = null,
  custody = null,
}: BoxBuilderProps) {
  // Fixed at mount when the caller does not supply one, so every derived
  // expiry set and every "now" divider in one session agree with each other.
  const [mountedAt] = useState(() => now ?? Date.now());
  const nowMs = now ?? mountedAt;

  /**
   * How old the ladder is — rendered for STALE and only for STALE.
   *
   * `theme.ts`'s rule, followed rather than re-argued: a STALE chip always
   * appears beside the age of the read it is showing, because real numbers
   * wearing the wrong timestamp are the one genuinely dangerous state and the
   * word alone does not disclose it. A LIVE ladder was read inside the refresh
   * window by definition, so an age beside it would be noise; a SEEDED one has
   * no read to be old.
   *
   * Measured against this screen's own clock rather than a fresh `Date.now()`,
   * so the age agrees with the divider, the expiry set and the ladder that were
   * all derived from the same instant.
   */
  const ladderAge = feed && feed.state === "stale" ? stateAge(feed.at, nowMs) : null;

  const [underlying, setUnderlying] = useState<string>("ETH");
  const [expiry, setExpiry] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  /** The floor of a box being built one rung at a time. */
  const [pendingFloor, setPendingFloor] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [edit, setEdit] = useState<BoxEdit | null>(null);
  const [stage, setStage] = useState<"draw" | "review">("draw");
  /**
   * The viewport. Opens at the default window and is reset whenever the board
   * underneath it changes — a pan that survived a switch from ETH to BTC would
   * be a centre in the wrong currency.
   */
  const [view, setView] = useState<BoxViewport>({ steps: DEFAULT_ZOOM_STEPS, centre: null });

  /**
   * How many contracts the position is — **the half of the ticket that did not
   * exist.**
   *
   * `contracts` stays a prop so a caller (and every existing test) can pin the
   * opening size, and this is the player's override of it. One state, clamped
   * once, and every money figure on the panel reads `size` rather than the prop
   * — `condorEconomics`/`zoneEconomics` already scale the premium and the
   * ceiling together, so the multiple between them is size-free by construction
   * and the two dollar figures move.
   *
   * `null` means "the player has not said", which is the prop's value, so a
   * mount that never touches the stepper behaves exactly as it did.
   */
  const [sizeInput, setSizeInput] = useState<number | null>(null);
  const size = Math.max(
    1,
    Math.min(MAX_PANEL_CONTRACTS, Math.floor(sizeInput ?? contracts) || 1),
  );
  const plotRef = useRef<HTMLDivElement | null>(null);

  const trade = useTradeFlag(tradeEnabled);

  // 1. The expiry columns. Nothing else on this screen may produce an expiry.
  const expiries = useMemo(
    () => liveExpiries(snapshot, underlying, nowMs),
    [snapshot, underlying, nowMs],
  );

  /**
   * The divider, and the only "now" on this screen.
   *
   * When there is history it is the history module's own boundary, because the
   * points were normalised against exactly that number — taking the wall clock
   * instead would let the newest print land a few hundred milliseconds right of
   * the line that says the future starts here.
   */
  // Memoised so it keeps one identity across renders — it is a dependency of
  // the column filter, and a fresh object every frame would rerun it forever.
  const boundary: NowBoundary = useMemo(
    () => history?.now ?? { at: nowMs, lastPrintAt: null, staleMs: null },
    [history, nowMs],
  );
  const dividerMs = boundary.at;

  /**
   * The columns actually drawn: live expiries that are still in the future of
   * the divider (`isFuture`, §2.3). `liveExpiries` already drops what the book
   * has finished with; this is the second half of the same rule, said against
   * the line the player can see, so the divider and the columns can never
   * disagree about which side of "now" a date is on.
   */
  const columns = useMemo(
    () => expiries.filter((e) => isFuture(e * 1000, boundary)),
    [expiries, boundary],
  );

  // The selection follows the book: an expiry that stopped being quoted stops
  // being selected, rather than leaving a dead column highlighted.
  const chosen = expiry !== null && columns.includes(expiry) ? expiry : (columns[0] ?? null);

  // 2. The ladder. Everything below is a pure function of it.
  const ladder = useMemo(
    () => (chosen === null ? null : deriveLadder(snapshot, underlying, chosen, nowMs)),
    [snapshot, underlying, chosen, nowMs],
  );

  const spotPrice = spot?.(underlying) ?? null;

  /**
   * Where the board opens: **spot, snapped to a rung**.
   *
   * The snap is not cosmetic. Spot ticks every few seconds, and an anchor that
   * followed it exactly would slide the whole axis under the player's cursor
   * between renders and give the two seats of a duel two subtly different
   * boards. Snapped, the window moves only when spot crosses a rung midpoint —
   * $20 to $100 of travel on ETH — and until then the board is a pure function
   * of the ladder. `null` spot is ordinary: `chartWindow` falls back to the
   * ladder's own dense core, so the board still opens where the market is even
   * with no price feed at all.
   */
  const anchorPrice = useMemo(() => {
    if (!ladder || spotPrice === null) return null;
    return strikeUsd(snapPrice(ladder, spotPrice));
  }, [ladder, spotPrice]);

  /**
   * 3. The y-axis — **the one scale** (§2.5).
   *
   * A window over the ladder rather than the whole of it, and the player's
   * `view` is the only thing here that is not derived from the book. Everything
   * downstream reads this one value; see {@link Band} for what that invariant
   * did and did not survive.
   */
  const band: PriceWindow | null = useMemo(
    () => (ladder ? chartWindow(ladder, anchorPrice, view.steps, view.centre) : null),
    [ladder, anchorPrice, view.steps, view.centre],
  );

  /** The ladder's full extent — no longer the axis, but still the limit on how
   *  far the axis may be zoomed out, and the band the history is *clipped* to
   *  before the window hides any more of it. */
  const extent = useMemo(() => (ladder ? ladderBounds(ladder) : null), [ladder]);

  // A new board means a new default viewport: a centre carried over from ETH's
  // ladder is a price BTC has never traded at.
  const boardKey = `${underlying}|${chosen ?? ""}`;
  const boardRef = useRef(boardKey);
  useEffect(() => {
    if (boardRef.current === boardKey) return;
    boardRef.current = boardKey;
    setView({ steps: DEFAULT_ZOOM_STEPS, centre: null });
  }, [boardKey]);

  /**
   * The time axis: history on the left, and the future out to **the chosen
   * expiry** on the right — not to the furthest one the book has.
   *
   * Scaling to the furthest was the first thing that looked wrong on screen and
   * it was wrong for a reason worth writing down: ETH quotes Sep 5 through
   * Sep 18, so an axis that always reached Sep 18 drew a one-day box as a 3%
   * sliver and squeezed thirty-three hours of Chainlink prints into a vertical
   * smear. The box would then be unreadable *because of dates the player did
   * not pick*. The expiries beyond the choice are still offered — in the picker
   * below the chart — they simply do not get to set the scale.
   *
   * The 8% tail past the expiry is so the box's right edge reads as an edge
   * rather than as the plot running out of room.
   */
  const target = (chosen ?? Math.floor(dividerMs / 1000)) * 1000;
  const forward = Math.max(target - dividerMs, 60_000);
  const t1 = target + forward * 0.08;
  // The past gets exactly as much of the plot as there is history to put in it.
  // With none, a token sliver: an empty half-chart labelled NOW is width spent
  // on nothing, and the future is where the box goes.
  const firstPoint = history?.points[0]?.t;
  const t0 = Math.min(firstPoint ?? dividerMs - forward * 0.12, dividerMs);

  /** The columns actually on this scale — every offered expiry up to the one
   *  the box is drawn against. A later date is not on the axis, so it cannot be
   *  drawn as a line that would sit off the plot. */
  const drawn = columns.filter((e) => e * 1000 <= target);

  /**
   * 3b. The line, clipped **twice**, and the two clips mean different things.
   *
   * `fitToLadder` drops points rather than moving them — a point moved to fit is
   * a price that was never printed — so anything it removes has to be counted
   * and said out loud. Since the axis became a window there are two separate
   * reasons a print is not on screen, and collapsing them into one number would
   * make an honest sentence into a misleading one:
   *
   *  - **`clipped`** — outside the *ladder's whole extent*. The venue quotes no
   *    strike anywhere near it, so no zoom setting will ever show it. This is
   *    the count the screen has always reported, and it means what it always
   *    meant.
   *  - **`hidden`** — inside the ladder but outside the *current window*. That
   *    is the player's own zoom, it is completely recoverable, and it is
   *    reported separately with the control that recovers it.
   *
   * Reporting only the first would hide the cost of zooming; reporting only the
   * total would blame the venue for the player's viewport.
   */
  const line = useMemo(() => {
    const none = { segments: [] as readonly (readonly HistoryPoint[])[], clipped: 0, hidden: 0 };
    if (!history || !band || !extent) return none;
    const inLadder = fitToLadder(history, extent.lo, extent.hi);

    // The line is cut wherever a print left the window, not merely filtered.
    // Filtering alone joins the last print before an excursion to the first one
    // after it, which draws a straight chord across a path the price did not
    // take in a straight line — the same lie {@link segments} refuses to tell
    // about a gap in time, told about a gap in space instead. Cut, the line
    // simply stops at the edge and resumes, and the count below the chart says
    // how much is off the board.
    const runs: HistoryPoint[][] = [];
    let run: HistoryPoint[] = [];
    let hidden = 0;
    for (const p of inLadder.points) {
      if (p.px < band.lo || p.px > band.hi) {
        hidden += 1;
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }
      run.push(p);
    }
    if (run.length > 0) runs.push(run);

    const drawnSegments: (readonly HistoryPoint[])[] = [];
    for (const r of runs) {
      for (const s of segments(
        r.filter((p) => p.t >= t0),
        history.meta.granularity?.medianGapMs,
      )) {
        drawnSegments.push(s);
      }
    }
    return { segments: drawnSegments, clipped: inLadder.clipped, hidden };
  }, [history, band, extent, t0]);
  const hasLine = line.segments.length > 0;

  /**
   * The sentence for a chart that is blank **despite** having history — or
   * `null`, which is every other case.
   *
   * Three states have to be told apart and only one of them is a blank chart
   * that needs explaining:
   *
   *  - no history at all → `null`. Nothing arrived, nothing to say, and the
   *    screen already says nothing.
   *  - history arrived and some of it is on the board → `null`. `hasLine` is
   *    true and the two clip clauses above cover the rest.
   *  - history arrived and **none** of it is drawable → this string.
   *
   * Within the third, the cause matters and is not the same fact:
   * `line.clipped` is outside the ladder's whole extent and no zoom recovers
   * it, `line.hidden` is inside the ladder but outside the player's own window
   * and one button does. Reporting them together would blame the book for a
   * viewport, which is the mistake `docs/asset-gate.md` records this repo
   * making once already in the other direction.
   *
   * The extent is named because it is the answer: the column's ladder is the
   * band the venue quotes on that date, and the price simply has not been in
   * it.
   */
  const emptyLine = useMemo(() => {
    if (hasLine) return null;
    const total = line.clipped + line.hidden;
    if (total === 0) return null;
    const are = total === 1 ? "print is" : "prints are";
    if (line.hidden > 0 && line.clipped === 0) {
      return (
        `All ${total} ${are} inside the ladder but outside this zoom, so the plot is ` +
        `empty — Fit ladder brings the line back.`
      );
    }
    const where =
      extent && chosen !== null
        ? ` The book quotes ${underlying} at ${usd(extent.lo)}–${usd(extent.hi)} for ${expiryLabel(chosen)}, and the price has not been in that band.`
        : "";
    const rest =
      line.hidden > 0
        ? ` ${line.clipped} of them ${line.clipped === 1 ? "is" : "are"} outside the ladder entirely and no zoom recovers ${line.clipped === 1 ? "it" : "them"}; the other ${line.hidden} ${line.hidden === 1 ? "is" : "are"} inside it but outside this window.`
        : "";
    return (
      `All ${total} ${are} outside this expiry's ladder, so there is no line to draw.` +
      where +
      rest +
      " The chart is empty because of the book, not the chart — a print moved to fit would be a price that was never made."
    );
  }, [hasLine, line.clipped, line.hidden, extent, chosen, underlying]);

  const assets = useMemo(() => {
    const seen = new Set<string>(["ETH", "BTC"]);
    for (const a of qualified ?? []) seen.add(a);
    return [...seen];
  }, [qualified]);

  const reset = useCallback(() => {
    setBox(null);
    setPendingFloor(null);
    setDrag(null);
    setStage("draw");
  }, []);

  // ── The duel (§6) ─────────────────────────────────────────────────────────

  /** `null` for a bystander who opened the link — they have no side of the
   *  table, so neither pick is "theirs" and neither is "mine". */
  const seatIndex: 0 | 1 | null = seat === "host" ? 0 : seat === "guest" ? 1 : null;
  const revealed = room?.revealed ?? false;
  /** The opponent's raw pick. `null` — always — until the server reveals. */
  const theirPick = seatIndex === null ? null : (room?.picks[seatIndex === 0 ? 1 : 0] ?? null);
  /** Mine, off the wire. Also `null` until the reveal: the store is blind in
   *  both directions, so the client remembers its own submission below. */
  const myPick = seatIndex === null ? null : (room?.picks[seatIndex] ?? null);

  /**
   * What this browser posted, remembered locally.
   *
   * The wire cannot answer "have I locked?" before the reveal, because the
   * server hides *both* picks and hiding only the opponent's would need the
   * reader's address on a GET that does not carry one. Rather than widen the
   * transport for a fact the client already knows, the client keeps it. The
   * cost is one honest failure: a refresh between locking and revealing forgets
   * it, the button comes back, and the second submission is refused with
   * "You already locked a pick for this duel." — the store's write-once rule
   * doing exactly its job, in words a player can act on.
   */
  const [locked, setLocked] = useState<string | null>(null);
  const roomId = room?.id ?? null;
  useEffect(() => setLocked(null), [roomId]);

  /** Locked or revealed, the drawing is finished — the box on screen must stop
   *  being editable, or it would stop being the box that was committed. */
  const frozen = locked !== null || revealed;

  /** Their box, drawn on this chart. `null` before the reveal by construction:
   *  `theirPick` is null, so there is nothing to decode. */
  const theirBox = useMemo(() => decodeBoxPick(theirPick), [theirPick]);

  /**
   * §6 — the asset the room's seed dealt, honoured only when it is drawable.
   *
   * Both halves of the guard are refusals to strand a player: an asset with no
   * condor market has no instrument, and an asset with no live expiry has no
   * chart. Either way the duel falls back to the chips, which is a worse duel
   * than §6 wants and a better one than a blank screen.
   */
  const dealtUnderlying = useMemo(() => {
    if (!dealt || !isCondorUnderlying(dealt)) return null;
    return liveExpiries(snapshot, dealt, nowMs).length > 0 ? dealt : null;
  }, [dealt, snapshot, nowMs]);

  useEffect(() => {
    if (!dealtUnderlying || dealtUnderlying === underlying) return;
    setUnderlying(dealtUnderlying);
    setExpiry(null);
    reset();
    onUnderlying?.(dealtUnderlying);
  }, [dealtUnderlying, underlying, onUnderlying, reset]);

  /**
   * At the reveal, the chart becomes the duel's chart.
   *
   * Both picks are on the wire now, so the authoritative version of *my* box is
   * the one the server is holding rather than whatever is in local state — and
   * after a refresh local state is empty while the wire is complete. Restoring
   * from `myPick` makes both seats, and a reloaded tab, render the same two
   * rectangles on the same axis, which is the entire claim of §6.
   *
   * Guarded by a ref rather than by comparing state, so it runs once per reveal
   * and never fights the player for the selection afterwards.
   */
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!revealed) {
      restoredRef.current = false;
      return;
    }
    if (restoredRef.current) return;
    const mine = decodeBoxPick(myPick);
    if (!mine) return;
    restoredRef.current = true;
    if (mine.underlying !== underlying) {
      setUnderlying(mine.underlying);
      onUnderlying?.(mine.underlying);
    }
    setExpiry(mine.expiry);
    setPendingFloor(null);
    setDrag(null);
    setStage("draw");
    setBox(mine);
    // `underlying` is read, not depended on: this effect fires on the reveal and
    // must not re-fire when the value it just set lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealed, myPick, onUnderlying]);

  // ── The viewport ──────────────────────────────────────────────────────────
  //
  // Everything in this block moves the camera and nothing in it touches the
  // board. That separation is the whole safety argument for letting the player
  // zoom at all, and it is structural rather than a convention: none of these
  // functions can reach `setBox`, and `chartWindow` cannot reach a strike.

  const windowFor = useCallback(
    (steps: number, centre: number | null): PriceWindow | null =>
      ladder ? chartWindow(ladder, anchorPrice, steps, centre) : null,
    [ladder, anchorPrice],
  );

  /**
   * Move the camera, and report whether it actually moved.
   *
   * The boolean is what keeps the wheel from trapping the page. A gesture that
   * would change nothing — zooming out at the ladder's own extent, panning past
   * the top rung — returns `false`, the handler declines to `preventDefault`,
   * and the browser scrolls the page as it normally would. The player is never
   * stuck inside the chart.
   */
  const applyView = useCallback(
    (steps: number, centre: number | null): boolean => {
      const next = windowFor(steps, centre);
      if (!next || !band) return false;
      if (Math.abs(next.lo - band.lo) < 1e-9 && Math.abs(next.hi - band.hi) < 1e-9) return false;
      setView({ steps, centre });
      return true;
    },
    [windowFor, band],
  );

  const zoomLimits = useMemo(
    () => ({ min: MIN_ZOOM_STEPS, max: ladder ? maxZoomSteps(ladder) : MIN_ZOOM_STEPS }),
    [ladder],
  );

  /**
   * Zoom, keeping one price pinned under the cursor.
   *
   * The map convention, and the right one here: the rung you are pointing at is
   * the rung you care about, so it should not slide away while you look at it.
   * `focus` of `null` (the buttons, the keyboard) zooms about the middle
   * instead.
   *
   * Two `chartWindow` calls rather than one, because the new window's height is
   * not known until the min-rungs floor and the ladder clamp have both been
   * applied — the first call measures, the second places.
   */
  const zoomTo = useCallback(
    (steps: number, focus: number | null): boolean => {
      const next = Math.max(zoomLimits.min, Math.min(zoomLimits.max, steps));
      if (focus === null || !band) return applyView(next, view.centre);
      const span = band.hi - band.lo;
      const fromTop = span > 0 ? (band.hi - focus) / span : 0.5;
      const probe = windowFor(next, focus);
      if (!probe) return false;
      const height = probe.hi - probe.lo;
      const wantLo = focus - (1 - fromTop) * height;
      return applyView(next, wantLo + height / 2);
    },
    [zoomLimits, band, applyView, view.centre, windowFor],
  );

  /** Pan by a fraction of the window's own height, so one notch feels the same
   *  at every zoom level. */
  const panBy = useCallback(
    (fraction: number): boolean => {
      if (!band) return false;
      const span = band.hi - band.lo;
      if (span <= 0) return false;
      return applyView(view.steps, (band.lo + band.hi) / 2 + span * fraction);
    },
    [band, applyView, view.steps],
  );

  const fitLadder = useCallback(
    () => applyView(zoomLimits.max, null),
    [applyView, zoomLimits.max],
  );

  /** True when the window is already the whole ladder — the zoom-out control's
   *  disabled state, and the reason the "hidden by zoom" line disappears. */
  const fitted = band !== null && band.below === 0 && band.above === 0;

  /**
   * Would one press of a zoom control actually move the camera?
   *
   * This is the fix for *"zoom buttons not working"*, and the button was not
   * broken — it was **enabled while doing nothing**, which from the outside is
   * indistinguishable. `zoomTo` clamps to the ladder's own rungs, so on a coarse
   * column (BTC 11 Sep quotes three strikes $450 apart, `maxZoomSteps` = 1)
   * pressing `+` at the default 3 steps clamps to 1, produces the identical
   * window, and `applyView` correctly returns `false`. Silently.
   *
   * So the predicate is `applyView`'s own test, run ahead of the press: probe
   * the window the button would produce and compare it with the one on screen.
   * A control that cannot move is disabled, and the readout beside it says why
   * in the book's own numbers rather than leaving the player pressing a dead
   * key.
   */
  const zoomProbe = useCallback(
    (steps: number): boolean => {
      const next = Math.max(zoomLimits.min, Math.min(zoomLimits.max, steps));
      const w = windowFor(next, view.centre);
      if (!w || !band) return false;
      return Math.abs(w.lo - band.lo) > 1e-9 || Math.abs(w.hi - band.hi) > 1e-9;
    },
    [zoomLimits, windowFor, view.centre, band],
  );
  const canZoomIn = zoomProbe(view.steps / 1.6);
  const canZoomOut = zoomProbe(view.steps * 1.6);
  /** `showing 12 of 14 rungs` — the state the controls are in, which is the
   *  other half of "it did nothing": without it there is no way to tell a
   *  window that is already the whole ladder from one that refused to move. */
  const zoomState =
    band === null || !ladder
      ? null
      : `showing ${ladder.prices.length - band.below - band.above} of ${ladder.prices.length} rungs`;

  /**
   * The wheel, attached by hand because React's `onWheel` is passive and a
   * passive listener cannot call `preventDefault`.
   *
   * Three rules, each of them a hazard avoided rather than a preference:
   *
   *  - **inert while a gesture is in flight.** A drag captured its start price
   *    against the band that was current when it began; re-scaling the axis
   *    underneath it would leave the box anchored to a price the player never
   *    pointed at.
   *  - **`preventDefault` only when the view moved.** See {@link applyView} —
   *    this is the escape hatch out of the chart.
   *  - **shift pans, plain wheel zooms.** Trackpad pinch arrives as
   *    `ctrlKey` + wheel in every current browser, so that zooms too, which is
   *    what a pinch should do.
   */
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (frozen || drag || edit || !band) return;
      const rect = el.getBoundingClientRect();
      if (!rect.height) return;
      const moved = e.shiftKey
        ? panBy(Math.sign(e.deltaY) * 0.12)
        : zoomTo(
            view.steps * Math.exp(e.deltaY * 0.0016),
            priceAtFraction(band, Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))),
          );
      if (moved) e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [frozen, drag, edit, band, panBy, zoomTo, view.steps]);

  /**
   * A raw pair of prices → a snapped box, one quote, and nothing in between.
   *
   * The whole of §4.1 lives in this function: it is called on release, on a
   * completed pair of rung clicks and at the end of an edit, and never on a
   * move. The order of the calls is plan 7 §1's — playable, then the
   * instrument, then the strikes the SDK boundary validates.
   *
   * `against` exists for one caller: an edit that moved the box's right edge to
   * a different expiry column has to be judged by *that* column's ladder, and
   * `ladder` in this closure is still the old one for the render in which the
   * edit lands. Everything else passes nothing and gets the current board.
   */
  const commitBox = useCallback(
    (candidate: Box, against?: StrikeLadder | null) => {
      const ladderHere = against ?? ladder;
      if (!ladderHere) return;
      setBox(candidate);
      setStage("draw");

      if (!onQuote || !isPlayable(candidate, ladderHere)) return;
      let spec: CondorSpec;
      try {
        spec = boxToCondor(candidate);
      } catch {
        // `isPlayable` said yes and the constructor disagreed. That is a bug in
        // this file's ordering, not a player error, and it must not reach a
        // price call.
        return;
      }
      const strikes = condorStrikeNumbers(spec);
      if (!validateSpec(spec).valid) return;
      onQuote(spec, strikes, listedFill(candidate, snapshot, nowMs));
    },
    [ladder, onQuote, snapshot, nowMs],
  );

  const commit = useCallback(
    (a: number, b: number) => {
      if (!ladder || chosen === null) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const rawFloor = priceToStrike(lo);
      const rawCeiling = priceToStrike(hi);
      if (rawFloor === null || rawCeiling === null) return;

      commitBox(
        snapBox(
          {
            underlying,
            floor: rawFloor,
            ceiling: rawCeiling,
            wing: "",
            expiry: chosen,
          },
          ladder,
        ),
      );
    },
    [ladder, chosen, underlying, commitBox],
  );

  /** Pointer y → a price on the one scale. */
  const priceAtClientY = useCallback(
    (clientY: number): number | null => {
      const el = plotRef.current;
      if (!el || !band) return null;
      const rect = el.getBoundingClientRect();
      if (!rect.height) return null;
      const fraction = (clientY - rect.top) / rect.height;
      return priceAtFraction(band, Math.max(0, Math.min(1, fraction)));
    },
    [band],
  );

  // A rung click is the drag's accessible twin: first click sets the floor,
  // second completes the box. It goes through the same `commit`, so it snaps,
  // validates and quotes on exactly the same path.
  const onRung = useCallback(
    (price: number) => {
      // A rung the zoom has pushed off the board is still a strike the venue
      // quotes, so clicking its label brings the board back to it rather than
      // refusing. Panning first and then acting normally is what makes "every
      // rung stays reachable" true rather than aspirational.
      if (band && (price > band.hi || price < band.lo)) {
        const span = band.hi - band.lo;
        applyView(view.steps, price + (price > band.hi ? -span / 3 : span / 3));
      }
      // A committed box is not a draft. Once it is on the wire the drawing
      // surface stops accepting input, or the rectangle on screen would stop
      // being the rectangle the opponent is playing against.
      if (frozen) return;
      if (pendingFloor === null) {
        const raw = priceToStrike(price);
        setPendingFloor(raw);
        setBox(null);
        setStage("draw");
        return;
      }
      const floorUsd = strikeUsd(pendingFloor);
      setPendingFloor(null);
      if (floorUsd === null) return;
      commit(floorUsd, price);
    },
    [frozen, pendingFloor, commit, band, applyView, view.steps],
  );

  // ── Editing a committed box ───────────────────────────────────────────────

  /** Nearest rung to a price, as an index into `ladder`. The one place a
   *  pointer position becomes a rung, so every handle lands on the ladder by
   *  construction rather than by a snap bolted on at the end. */
  const rungIndexAt = useCallback(
    (price: number): number => (ladder ? ladderIndex(ladder, snapPrice(ladder, price)) : -1),
    [ladder],
  );

  /** Pointer x → the nearest **live expiry column**. Never an instant between
   *  two of them: the only dates that exist are the ones the book quotes. */
  const expiryAtClientX = useCallback(
    (clientX: number): number | null => {
      const el = plotRef.current;
      if (!el || columns.length === 0) return null;
      const rect = el.getBoundingClientRect();
      if (!rect.width) return null;
      const at = t0 + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (t1 - t0);
      let best = columns[0] as number;
      for (const e of columns) {
        if (Math.abs(e * 1000 - at) < Math.abs(best * 1000 - at)) best = e;
      }
      return best;
    },
    [columns, t0, t1],
  );

  const startEdit = useCallback(
    (kind: EditKind, e: React.PointerEvent) => {
      if (frozen || !box || !ladder || chosen === null) return;
      const price = priceAtClientY(e.clientY);
      if (price === null) return;
      const fi = ladderIndex(ladder, box.floor);
      const ci = ladderIndex(ladder, box.ceiling);
      if (fi < 0 || ci < 0) return;
      e.stopPropagation();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      setDrag(null);
      setPendingFloor(null);
      setEdit({
        kind,
        fromPrice: price,
        base: box,
        floorIndex: fi,
        ceilingIndex: ci,
        expiry: box.expiry,
        moved: false,
      });
    },
    [frozen, box, ladder, chosen, priceAtClientY],
  );

  /**
   * One frame of an edit, in rung indices.
   *
   * The clamps here **are** the "up to a point" the owner asked for, and each
   * one is the ladder's rule rather than ours:
   *
   *  - a floor may not reach its own ceiling, and a ceiling may not reach its
   *    own floor — one rung apart is the minimum box, which `snapBox` enforces
   *    again on the way out and `minBoxHeight` states in dollars on screen;
   *  - a move keeps the box's height in *rungs* and slides until an end hits
   *    the ladder, so the box cannot be walked off the board or silently
   *    resized by dragging it;
   *  - both ends stay inside the ladder, because outside it the venue quotes
   *    nothing.
   */
  const moveEdit = useCallback(
    (current: BoxEdit, clientX: number, clientY: number): BoxEdit | null => {
      if (!ladder) return null;
      const top = ladder.prices.length - 1;
      const baseFloor = ladderIndex(ladder, current.base.floor);
      const baseCeiling = ladderIndex(ladder, current.base.ceiling);
      if (baseFloor < 0 || baseCeiling < 0) return null;

      let floorIndex = current.floorIndex;
      let ceilingIndex = current.ceilingIndex;
      let expiry = current.expiry;

      const price = priceAtClientY(clientY);
      if (price !== null) {
        const pointed = rungIndexAt(price);
        if (current.kind === "move") {
          // Translate by the pointer's travel, in price, then land on a rung.
          // The height is preserved in *rungs*, so a move across an irregular
          // ladder keeps the same number of cells rather than the same dollars.
          const height = baseCeiling - baseFloor;
          const from = strikeUsd(current.base.floor);
          const wanted =
            from === null ? baseFloor : rungIndexAt(from + (price - current.fromPrice));
          floorIndex = Math.max(0, Math.min(top - height, wanted < 0 ? baseFloor : wanted));
          ceilingIndex = floorIndex + height;
        } else if (pointed >= 0 && (current.kind === "floor" || current.kind === "corner-floor")) {
          floorIndex = Math.max(0, Math.min(baseCeiling - 1, pointed));
          ceilingIndex = baseCeiling;
        } else if (
          pointed >= 0 &&
          (current.kind === "ceiling" || current.kind === "corner-ceiling")
        ) {
          ceilingIndex = Math.min(top, Math.max(baseFloor + 1, pointed));
          floorIndex = baseFloor;
        }
      }

      if (
        current.kind === "expiry" ||
        current.kind === "corner-floor" ||
        current.kind === "corner-ceiling"
      ) {
        expiry = expiryAtClientX(clientX) ?? current.expiry;
      }

      const moved =
        current.moved ||
        floorIndex !== current.floorIndex ||
        ceilingIndex !== current.ceilingIndex ||
        expiry !== current.expiry;
      return { ...current, floorIndex, ceilingIndex, expiry, moved };
    },
    [ladder, priceAtClientY, rungIndexAt, expiryAtClientX],
  );

  /**
   * The end of an edit: one `snapBox`, one quote, exactly as a fresh drag gets.
   *
   * There is no second way to build a `Box` in this file, which is what keeps
   * editing from desynchronising the wire format. `encodeBoxPick` serialises
   * whatever `snapBox` returned, and an edited box and a drawn box come out of
   * the same function with the same guarantees.
   */
  const endEdit = useCallback(
    (current: BoxEdit) => {
      setEdit(null);
      if (!ladder || !current.moved) return;
      const target =
        current.expiry === chosen
          ? ladder
          : deriveLadder(snapshot, underlying, current.expiry, nowMs);
      if (!target) return;
      const floor = ladder.strikes[current.floorIndex];
      const ceiling = ladder.strikes[current.ceilingIndex];
      if (floor === undefined || ceiling === undefined) return;
      if (current.expiry !== chosen) setExpiry(current.expiry);
      commitBox(
        snapBox(
          { underlying, floor, ceiling, wing: current.base.wing, expiry: current.expiry },
          target,
        ),
        target,
      );
    },
    [ladder, chosen, snapshot, underlying, nowMs, commitBox],
  );

  // 5 + 6. The instrument, and then the economics — only ever in this order,
  // and only for a box the ladder accepts.
  const problem = box && ladder ? boxProblem(box, ladder) : null;
  const spec = useMemo(() => {
    if (!box || !ladder || !isPlayable(box, ladder)) return null;
    try {
      const built = boxToCondor(box);
      return validateSpec(built).valid ? built : null;
    } catch {
      return null;
    }
  }, [box, ladder]);

  /**
   * Which instrument this box actually is — asked BEFORE the economics, and
   * that ordering is the fix rather than a tidy-up.
   *
   * `matchListedZone` matches on underlying, expiry, floor and ceiling. **It
   * deliberately does not match on the wing**, because a listed zone's wings
   * are the maker's and the player does not choose them (`LISTED_WING_COPY`,
   * and the docblock on `matchListedZones`). That is correct — and it is why
   * the economics may not be computed from the drawn box once a zone is
   * matched. See {@link positionEconomics}.
   */
  const match = useMemo(() => listedFill(box, snapshot, nowMs), [box, snapshot, nowMs]);

  const econ = positionEconomics(spec, match, premium ?? 0, size);
  const quoted = typeof premium === "number" && premium > 0;
  /** `max payout ÷ premium paid`, or nothing at all. Never a placeholder. */
  const multiple = quoted && econ ? econ.payoutMultiple : null;

  /**
   * 7. The listed path (§3.1) — the zones this column actually carries, and
   * whether the drawn box lands on one.
   *
   * This replaces a claim that was wrong and quiet: the panel used to say "all
   * four strikes are listed — this one fills straight off the book" whenever
   * `wingLandsOnLadder` was true. Four listed *strikes* are not a listed
   * *structure*. The book has never carried a single condor, and a box whose
   * corners each sit on a rung is still an instrument nobody has created.
   * Nothing but a resting order can answer this, so a resting order is what is
   * asked — resolved by implementation address, never by strike shape.
   */
  const zones = useMemo(
    () => (chosen === null ? [] : zonesFor(snapshot, underlying, chosen, nowMs)),
    [snapshot, underlying, chosen, nowMs],
  );
  const spotListed = zones.some((z) => zoneCoversSpot(z, spotPrice));

  /**
   * 7b. The board, column by column — **each expiry drawn against its own
   * ladder**.
   *
   * This is the thing that stops the cell grid from being decoration. The book
   * does not quote the same strikes on every date: the frozen capture's ETH
   * quotes six rungs $20 apart on 5 Sep and three rungs $450 apart on 11 Sep,
   * and BTC's 18 Sep column carries a single strike and so cannot hold a box at
   * all. A grid that ruled one set of rows across every column would be drawing
   * cells that do not exist on four dates out of five.
   *
   * So every column gets its own rows, and the board visibly coarsens to the
   * right. That is not a rendering artefact — it is what the venue looks like.
   */
  const columnLadders = useMemo(() => {
    const byExpiry = new Map<number, StrikeLadder>();
    for (const l of deriveLadders(snapshot, nowMs)) {
      if (l.underlying === underlying) byExpiry.set(l.expiry, l);
    }
    return byExpiry;
  }, [snapshot, underlying, nowMs]);

  /** The listed zones on every drawn column, not just the chosen one — the
   *  handful of cells that fill straight off the book, wherever they are. */
  const columnZones = useMemo(() => {
    const byExpiry = new Map<number, readonly ListedZone[]>();
    for (const e of drawn) byExpiry.set(e, zonesFor(snapshot, underlying, e, nowMs));
    return byExpiry;
  }, [drawn, snapshot, underlying, nowMs]);

  /**
   * The wing widths this box may take — and this is a **narrow** list on
   * purpose.
   *
   * A wing is a distance the ladder can express, never a number a player types:
   * `wingCandidates` returns `floor − rung` for every rung below and
   * `rung − ceiling` for every rung above, and nothing else is a width somebody
   * is quoting. The `< floor` filter is the same one `snapWing` applies and the
   * same one `boxProblem` rejects on — a wing wider than the floor puts the
   * lowest strike at or below zero.
   *
   * It matters more than a stepper usually would because **the wing is the
   * maximum payout**: a long call condor pays exactly the wing width between
   * its inner strikes, and plan 7 measured the same of a listed `RANGER` (§3.2,
   * where max payout is 20/40/50 on ETH and 500/1000 on BTC — the wing, every
   * time). Stepping this control is stepping the upside, which is why the panel
   * prints the consequence beside it.
   */
  const wings = useMemo(() => {
    if (!ladder || !box) return [] as readonly string[];
    const floorUnits = parseStrike(box.floor);
    if (floorUnits === null) return [] as readonly string[];
    return wingCandidates(ladder, box.floor, box.ceiling).filter((w) => {
      const u = parseStrike(w);
      return u !== null && u > 0n && u < floorUnits;
    });
  }, [ladder, box]);
  const wingAt = box ? wings.indexOf(box.wing) : -1;

  /**
   * Whether the wing is the player's to set.
   *
   * It is not, on a listed zone. That box fills against an order a maker has
   * already created and whose wings are part of it — changing the width would
   * quietly turn a fill that exists into one that does not, which is exactly
   * what `LISTED_WING_COPY` tells the player and what this disables to match.
   */
  const wingEditable = !frozen && match === null && wings.length > 1 && wingAt >= 0;

  const stepWing = useCallback(
    (delta: number) => {
      if (!wingEditable || !box || !ladder) return;
      const next = wings[wingAt + delta];
      if (next === undefined) return;
      commitBox(snapBox({ ...box, wing: next }, ladder), ladder);
    },
    [wingEditable, box, ladder, wings, wingAt, commitBox],
  );

  const minHere = ladder
    ? strikeUsd(minBoxHeight(ladder, box?.floor ?? pendingFloor ?? ladder.strikes[0] ?? null))
    : null;
  const minFrom = strikeUsd(box?.floor ?? pendingFloor ?? ladder?.strikes[0] ?? null);

  const dragBand =
    drag && band
      ? { lo: Math.min(drag.from, drag.to), hi: Math.max(drag.from, drag.to) }
      : null;

  /**
   * The rectangle under the pointer, described in the ladder's own numbers —
   * `$2,440 – $2,480 · $40 · 1.6%`.
   *
   * Run through `snapBox` rather than off the raw pointer prices, so what it
   * reports is where the edges will actually land. A readout that tracked the
   * cursor would show a band the venue does not quote and then move the box on
   * release, which is the confusing half of snapping said twice.
   *
   * The per-cent is of the band's own floor, because that is the question a
   * player is asking while dragging: how much room is in this box. Nothing here
   * is a price and nothing here asks for one — §4.1's *one quote per released
   * box* is untouched.
   */
  const dragPreview = useMemo(() => {
    if (!drag || !ladder || chosen === null) return null;
    const lo = Math.min(drag.from, drag.to);
    const hi = Math.max(drag.from, drag.to);
    const floor = priceToStrike(lo);
    const ceiling = priceToStrike(hi);
    if (floor === null || ceiling === null) return null;
    let snapped: Box;
    try {
      snapped = snapBox({ underlying, floor, ceiling, wing: floor, expiry: chosen }, ladder);
    } catch {
      return null;
    }
    const f = strikeUsd(snapped.floor);
    const c = strikeUsd(snapped.ceiling);
    if (f === null || c === null || !(c > f)) return null;
    return `${usd(f)} – ${usd(c)} · ${usd(c - f)} tall · ${(((c - f) / f) * 100).toFixed(2)}%`;
  }, [drag, ladder, chosen, underlying]);

  /**
   * The box as it is right now, edit included — what gets *drawn*, as opposed
   * to what is committed.
   *
   * Separate from `box` so a half-finished drag never reaches the quote, the
   * encoder or the panel. The rectangle follows the pointer; the position does
   * not move until the pointer is released and `snapBox` has had its say.
   */
  const shownBox = useMemo(() => {
    if (!box) return null;
    if (!edit || !ladder) return { box, expiry: box.expiry };
    const floor = ladder.strikes[edit.floorIndex];
    const ceiling = ladder.strikes[edit.ceilingIndex];
    if (floor === undefined || ceiling === undefined) return { box, expiry: box.expiry };
    return { box: { ...box, floor, ceiling }, expiry: edit.expiry };
  }, [box, edit, ladder]);

  /**
   * The three pointer handlers every handle shares.
   *
   * They live on the handle rather than on the plot because the handle is what
   * captured the pointer, and `stopPropagation` on each is what stops a grab
   * from also being read as "start drawing a new box" by the surface
   * underneath.
   */
  const editHandlers = useCallback(
    (kind: EditKind) => ({
      onPointerDown: (e: React.PointerEvent) => startEdit(kind, e),
      onPointerMove: (e: React.PointerEvent) => {
        if (!edit) return;
        e.stopPropagation();
        const next = moveEdit(edit, e.clientX, e.clientY);
        if (next) setEdit(next);
      },
      onPointerUp: (e: React.PointerEvent) => {
        if (!edit) return;
        e.stopPropagation();
        endEdit(edit);
      },
      onPointerCancel: () => setEdit(null),
    }),
    [startEdit, edit, moveEdit, endEdit],
  );

  /**
   * This room's opening print for the asset on screen, and whether it is real.
   *
   * Read through `openFor` and never off `room.open.px` directly — that is the
   * seam's whole design: the function cannot return a bare number, so a screen
   * has to destructure `live` before it can render `px`, and a practice-tape
   * open cannot be drawn as a market one by omission. `live: false` is an
   * ordinary answer (no venue answered at creation, or this asset has no feed),
   * not a failure, and the strip says which rather than staying quiet.
   */
  const roomOpen = openFor(room?.open ?? null, underlying);

  /**
   * The trade ticket host — one panel, opened from a listed-zone chip, from the
   * drawn box itself, or from the control beside the PRICE BAND row.
   *
   * The board's cells stay price-free (§4.4). A ticket is only ever built for
   * an instrument that actually exists: a zone a maker has listed, or the one
   * box the player has drawn.
   */
  const ticket = useTradeTicket();

  /** The drawn box's ticket, or `null` when nothing is drawn. */
  const boxTicket = useMemo(() => {
    if (!spec) return null;
    const strikes = match
      ? rangerStrikeNumbers(match.spec)
      : condorStrikeNumbers(spec);
    return zoneTicket({
      id: "box",
      underlying,
      strikes,
      expiry: match ? match.zone.expiry : spec.expiry,
      premium: quoted ? premium : null,
      contracts: size,
      econ,
      match,
      spot: spotPrice,
      now: nowMs,
    });
  }, [spec, match, underlying, quoted, premium, size, econ, spotPrice, nowMs]);

  /**
   * One listed zone's ticket, built on demand from the chip's own order.
   *
   * The premium is `zoneQuote`'s only when this zone is the box on screen —
   * i.e. only when the caller has already previewed a fill against this exact
   * order. Every other chip is unpriced and says so, because a chip is an offer
   * to draw a box, not a quote for one.
   */
  const chipTicket = useCallback(
    (z: ListedZone): Ticket => {
      const mine = match !== null && match.zone.index === z.index;
      const zSpec = zoneToRanger(z);
      return zoneTicket({
        id: `zone-${z.floor}-${z.ceiling}-${z.wing}`,
        underlying: z.underlying,
        strikes: rangerStrikeNumbers(zSpec),
        expiry: z.expiry,
        premium: mine && quoted ? premium : null,
        contracts: mine ? size : 1,
        econ: mine ? econ : zoneEconomics(z, 0, 1),
        match: { zone: z, spec: zSpec },
        spot: spotPrice,
        now: nowMs,
      });
    },
    [match, quoted, premium, size, econ, spotPrice, nowMs],
  );

  return (
    <div style={sx("padding:22px 28px;max-width:1240px;margin:0 auto;display:grid;gap:14px")}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div style={sx("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
        {onBack && (
          <button onClick={onBack} style={sx(BTN(C.borderMid, false))}>
            ← Arena
          </button>
        )}
        <h2 style={sx(`margin:0;font:700 18px/1 ${SANS};letter-spacing:-.02em`)}>Draw your box</h2>
        <span style={sx(`${NOTE};max-width:60ch`)}>{REPLACES_COPY}</span>
      </div>

      {/*
        ── The duel (§6) ────────────────────────────────────────────────────

        Absent entirely without a room, which is the solo builder steps 1–3
        shipped. With one, this strip is the whole of the lock/reveal surface:
        one button that commits the drawing, one line that says what state the
        duel is in, and — at the reveal — the sentences §6.1 requires about a
        verdict nobody may sign.
      */}
      {room && (
        <div
          data-role="duel"
          style={sx(`${CARD};padding:14px 16px;display:grid;gap:10px`)}
        >
          <div style={sx("display:flex;align-items:center;gap:12px;flex-wrap:wrap")}>
            <span style={sx(LABEL)}>DUEL · {room.lobbyName.toUpperCase()}</span>
            <span style={sx(`font:700 12px/1 ${MONO};color:${C.text}`)}>
              {shortAddress(room.host)} vs {room.guest ? shortAddress(room.guest) : "—"}
            </span>
            <span data-role="stake-basis" style={sx(`font:500 10.5px/1 ${MONO};color:${C.dim}`)}>
              {stakeBasisLine(room.stakeUsdc, custody)} · {room.durationMinutes} min
            </span>
            {/* Where this duel's tape opens, and whether that open is real.

                `openFor` exists so no caller can render a reference price where
                a live one is implied — it refuses to hand back a bare number
                and returns the flag alongside it. That was the whole point of
                the shape, and until now nothing in this file destructured it:
                a duel opened on a stored reference looked identical to one
                opened on a Chainlink print. So both states get a chip, in the
                vocabulary `src/data/room.ts` already holds, and the practice
                case gets the sentence underneath as well — a chip a player has
                to already understand is not a disclosure. */}
            {roomOpen.live && room.open ? (
              <span
                data-role="room-open"
                data-open-live="true"
                style={sx(`font:500 10.5px/1 ${MONO};color:${C.green}`)}
              >
                {liveOpenChip(room.open)} · {underlying} {usd(roomOpen.px, true)}
                {roomOpen.at === null ? "" : ` · ${stateAge(roomOpen.at, nowMs) ?? ""}`}
              </span>
            ) : (
              <span
                data-role="room-open"
                data-open-live="false"
                style={sx(`font:500 10.5px/1 ${MONO};color:${C.amber}`)}
              >
                {PRACTICE_TAPE_CHIP}
              </span>
            )}
            <div style={sx("flex:1")} />
            {seatIndex === null ? (
              <span style={sx(`font:500 11.5px/1 ${MONO};color:${C.muted}`)}>
                Watching, not playing
              </span>
            ) : revealed ? (
              <span
                data-role="duel-state"
                style={sx(`font:700 11px/1 ${MONO};letter-spacing:.12em;color:${C.violet}`)}
              >
                BOTH BOXES IN
              </span>
            ) : locked !== null ? (
              <span
                data-role="duel-state"
                style={sx(`font:700 11px/1 ${MONO};letter-spacing:.12em;color:${C.green}`)}
              >
                LOCKED · WAITING
              </span>
            ) : (
              <button
                data-role="lock"
                onClick={() => {
                  if (!spec || !box || locked !== null || locking) return;
                  // The `Box` is what travels, not the `CondorSpec`: the spec is
                  // derived from the box by `boxToCondor` and re-derived on the
                  // other side from the same four fields, so sending it too
                  // would be sending a second copy of one fact that could
                  // disagree with the first.
                  const pick = encodeBoxPick(box);
                  setLocked(pick);
                  onLock?.(pick);
                }}
                disabled={!spec || locking || !onLock}
                style={sx(BTN(C.accent, true, !spec || locking || !onLock))}
              >
                {locking ? "Locking…" : spec ? "Lock this box" : "Draw a box to lock"}
              </button>
            )}
          </div>

          {/* Said in every state of the duel, not only at the reveal, and said
              to bystanders too — the amount above is on screen from the moment
              the strip renders, so the sentence that qualifies it has to be
              there at the same moment. Absent when a real escrow is named,
              because then there is nothing to qualify. */}
          {custody === null && (
            <span data-role="notional-stake" style={sx(`${NOTE};color:${C.amber}`)}>
              {NOTIONAL_STAKE_COPY}
            </span>
          )}

          {/* The other half of the practice-tape disclosure. The chip names the
              state; this says what it costs the player to know — the duel is
              still fair, and the prices on it are still not live. */}
          {!roomOpen.live && (
            <span data-role="practice-tape" style={sx(`${NOTE};color:${C.amber}`)}>
              {PRACTICE_TAPE_NOTE}
            </span>
          )}

          {seatIndex !== null && !revealed && (
            <span style={sx(NOTE)}>{locked !== null ? BLIND_COPY : LOCK_COPY}</span>
          )}

          {seatIndex !== null && revealed && (
            <div data-role="reveal" style={sx("display:grid;gap:6px")}>
              <span style={sx(`font:500 12px/1.5 ${SANS};color:${C.textSoft}`)}>{REVEAL_COPY}</span>

              {/* Every way the two boxes can fail to be comparable on one
                  chart, said rather than drawn wrong. */}
              {theirBox === null && (
                <span style={sx(`font:500 11px/1.5 ${SANS};color:${C.amber}`)}>
                  Their pick did not decode as a box, so there is nothing to draw for them. It is
                  shown as nothing rather than as a guess.
                </span>
              )}
              {theirBox !== null && theirBox.underlying !== underlying && (
                <span style={sx(`font:500 11px/1.5 ${SANS};color:${C.amber}`)}>
                  They drew on {theirBox.underlying} and this chart is {underlying}, so their box is
                  not on it — the y-axis is {underlying}'s ladder and a box from another asset would
                  sit at prices nobody drew.
                </span>
              )}
              {theirBox !== null &&
                theirBox.underlying === underlying &&
                box !== null &&
                theirBox.expiry !== box.expiry && (
                  <span style={sx(`font:500 11px/1.5 ${SANS};color:${C.amber}`)}>
                    They drew to {expiryLabel(theirBox.expiry)}; you drew to{" "}
                    {expiryLabel(box.expiry)}. Both boxes start at now, so the right edges differ.
                  </span>
                )}

              <span data-role="no-verdict" style={sx(NOTE)}>
                {noFillCopy(custody)}
              </span>
              <span style={sx(NOTE)}>{TWO_CLOCK_COPY}</span>
            </div>
          )}
        </div>
      )}

      {/* ── Assets. ETH and BTC play; everything else is greyed with why. ── */}
      <div style={sx("display:flex;gap:6px;flex-wrap:wrap;align-items:center")}>
        {assets.map((a) => {
          // Three separate reasons a chip can be dead, and each says its own:
          // no condor market on that asset, the duel dealt a different one
          // (§6), or the box is already committed.
          const playable =
            isCondorUnderlying(a) &&
            (dealtUnderlying === null || a === dealtUnderlying) &&
            !frozen;
          return (
            <button
              key={a}
              data-asset={a}
              disabled={!playable}
              title={
                !isCondorUnderlying(a)
                  ? `${a} has no condor market — ETH and BTC only`
                  : dealtUnderlying !== null && a !== dealtUnderlying
                    ? `This duel deals ${dealtUnderlying} — both seats draw on the same asset`
                    : frozen
                      ? "Your box is locked"
                      : undefined
              }
              onClick={() => {
                if (!playable || a === underlying) return;
                setUnderlying(a);
                setExpiry(null);
                reset();
                onUnderlying?.(a);
              }}
              style={sx(CHIP(a === underlying, !playable))}
            >
              {a}
            </button>
          );
        })}
        {dealtUnderlying !== null ? (
          <span data-role="dealt" style={sx(NOTE)}>
            The duel dealt {dealtUnderlying} from the room's own seed, so both seats draw on the same
            asset and the same book.
          </span>
        ) : (
          assets.some((a) => !isCondorUnderlying(a)) && (
            <span style={sx(NOTE)}>Greyed assets have a book, but no condor market.</span>
          )
        )}
        <div style={sx("flex:1")} />
        {spotPrice !== null && (
          <span style={sx(`font:500 11px/1 ${MONO};color:${C.muted}`)}>
            {underlying} spot {usd(spotPrice)}
          </span>
        )}
      </div>

      {columns.length === 0 || !ladder || !band ? (
        /*
          The board with no book behind it.

          This is a state the owner is looking at right now, so it is built
          rather than left as a fallen-through branch: the empty board is drawn
          at the same size the real one occupies, with the same framing, so the
          screen reads as *a board waiting for a book* instead of a card where a
          chart should be. The hatch is the same one a column with no strikes
          gets — one visual vocabulary for "nothing to draw here", whether the
          cause is one dead expiry or an empty snapshot.

          It claims nothing about *why*. A screen that guessed at the cause
          would eventually guess wrong in the direction that blames the venue,
          which this repo has done once already
          (`docs/asset-gate.md`, `docs/plan6-audit.md`).
        */
        <div
          data-role="no-board"
          style={sx(
            `${CARD};height:${CHART_H}px;display:grid;place-items:center;padding:26px 20px;` +
              `background:${C.panel} repeating-linear-gradient(135deg,${C.lineSoft} 0 3px,transparent 3px 9px)`,
          )}
        >
          <div style={sx("display:grid;gap:8px;justify-items:center;max-width:56ch")}>
            <span
              style={sx(
                `font:700 10px/1 ${MONO};letter-spacing:.14em;color:${C.muted}`,
              )}
            >
              {underlying} · NO BOARD
            </span>
            <span
              style={sx(`font:400 13px/1.65 ${SANS};color:${C.textSoft};text-align:center`)}
            >
              No live expiries on {underlying} right now. The columns are the book's own expiries —
              tomorrow, the day after, then weeklies — so an empty book means there is nothing here
              to draw on, rather than a chart with nothing in it.
            </span>
            <span
              style={sx(`font:400 11.5px/1.65 ${SANS};color:${C.dim};text-align:center`)}
            >
              Every rung, every column and every price on this screen comes from resting orders. With
              none to read there is no ladder, and a board drawn without one would be cells nobody
              can buy.
            </span>
          </div>
        </div>
      ) : (
        <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px")}>
          {/* ── The chart ─────────────────────────────────────────────── */}
          <div style={sx(`${CARD};padding:14px 16px 10px;display:grid;gap:10px`)}>
            <div style={sx("display:flex;align-items:center;gap:10px;flex-wrap:wrap")}>
              {/* The ladder's provenance, asserted only as far as the caller
                  said it — never `LIVE` by default.

                  This heading used to read `LIVE STRIKES` unconditionally, on a
                  path `src/data/thetanuts.tsx` reaches with a **stale** ladder
                  by design (*"stale beats blank"* — a failed refresh keeps the
                  last good rows and re-labels the source, it does not empty the
                  board). So a board of real-but-old strikes wore a LIVE label
                  while the footer said STALE, and there was no age anywhere on
                  the panel to settle it. `theme.ts` is explicit: for STALE *"the
                  age is the disclosure; the word alone is not"* — so the age
                  rides with the word, exactly as `ParlayPick`'s options chip
                  does, and it is the same three-state vocabulary rather than a
                  second one invented here. */}
              <span style={sx(LABEL)}>
                {underlying} · {feed ? `${FEED_STATE[feed.state].label} ` : ""}STRIKES
              </span>
              {feed && ladderAge && (
                <span
                  data-role="ladder-age"
                  title={meansOf(feed.state)}
                  style={sx(`font:500 10px/1 ${MONO};color:${FEED_STATE[feed.state].color}`)}
                >
                  {ladderAge}
                </span>
              )}
              {/* The ladder's own size first, then the part of it on screen.
                  Two numbers rather than one because they are two facts: how
                  much the venue is quoting, and how much the player is looking
                  at. Collapsing them was what let a 28%-wide axis pass for a
                  chart. */}
              <span data-role="ladder-extent" style={sx(`font:500 10px/1 ${MONO};color:${C.faint}`)}>
                {ladder.strikes.length} rungs · {usd(extent?.lo ?? band.lo)}–
                {usd(extent?.hi ?? band.hi)}
              </span>
              {!fitted && (
                <span data-role="window" style={sx(`font:700 10px/1 ${MONO};color:${C.accent}`)}>
                  showing {usd(band.lo)}–{usd(band.hi)}
                </span>
              )}
              <div style={sx("flex:1")} />

              {/* ── The zoom controls ────────────────────────────────────
                  The wheel is the fast path and these are the discoverable
                  one — and the only one on a touch screen, where there is no
                  wheel and the plot has already claimed the drag for drawing
                  a box. */}
              <div
                data-role="zoom"
                style={sx("display:flex;align-items:center;gap:4px")}
              >
                <button
                  data-role="zoom-out"
                  aria-label="Zoom out"
                  disabled={!canZoomOut}
                  onClick={() => zoomTo(view.steps * 1.6, null)}
                  style={sx(`${CHIP(false, !canZoomOut)};height:26px;padding:0 10px`)}
                >
                  −
                </button>
                <button
                  data-role="zoom-in"
                  aria-label="Zoom in"
                  disabled={!canZoomIn}
                  onClick={() => zoomTo(view.steps / 1.6, null)}
                  style={sx(`${CHIP(false, !canZoomIn)};height:26px;padding:0 10px`)}
                >
                  +
                </button>
                <button
                  data-role="fit-ladder"
                  disabled={fitted}
                  onClick={fitLadder}
                  style={sx(`${CHIP(false, fitted)};height:26px`)}
                >
                  Fit ladder
                </button>
              </div>

              {/* What the zoom is doing, and — when it can do nothing — why.
                  A control that is enabled and inert is the same experience as
                  a broken one, so neither state is left to be inferred. */}
              {zoomState && (
                <span
                  data-role="zoom-state"
                  style={sx(`font:500 10px/1 ${MONO};color:${C.faint}`)}
                >
                  {zoomState}
                  {!canZoomIn && !canZoomOut && ladder
                    ? ` · the whole ladder is on screen and its ${ladder.prices.length} rungs are the resolution — there is nothing to zoom into`
                    : ""}
                </span>
              )}

              {box && !frozen && (
                <button onClick={reset} style={sx(`${CHIP(false)};height:26px`)}>
                  Clear box
                </button>
              )}
            </div>

            <div
              style={sx(
                `position:relative;height:${CHART_H}px;border-radius:10px;background:${C.panel};` +
                  `border:1px solid ${C.lineSoft};overflow:hidden`,
              )}
            >
              <div
                ref={plotRef}
                data-role="plot"
                tabIndex={0}
                aria-label={`${underlying} strike board. Arrow keys pan, plus and minus zoom, 0 fits the ladder.`}
                onPointerDown={(e) => {
                  if (frozen || edit) return;
                  const price = priceAtClientY(e.clientY);
                  if (price === null) return;
                  e.currentTarget.setPointerCapture(e.pointerId);
                  setPendingFloor(null);
                  setDrag({ from: price, to: price });
                }}
                onPointerMove={(e) => {
                  if (!drag) return;
                  const price = priceAtClientY(e.clientY);
                  // No readout, no quote, no state beyond the outline: §4.1.
                  if (price !== null) setDrag({ from: drag.from, to: price });
                }}
                onPointerUp={(e) => {
                  if (!drag) return;
                  const price = priceAtClientY(e.clientY) ?? drag.to;
                  setDrag(null);
                  commit(drag.from, price);
                }}
                onPointerCancel={() => setDrag(null)}
                /* The keyboard twin of the wheel. It is not an afterthought:
                   the plot claims `touch-action:none` so it can own the drag
                   that draws a box, which means a touch device has no pinch to
                   give — the zoom buttons and these keys are the whole of the
                   non-wheel path, so they have to actually work. */
                onKeyDown={(e) => {
                  const step = () => {
                    if (e.key === "+" || e.key === "=") return zoomTo(view.steps / 1.6, null);
                    if (e.key === "-" || e.key === "_") return zoomTo(view.steps * 1.6, null);
                    if (e.key === "0") return fitLadder();
                    if (e.key === "ArrowUp") return panBy(0.12);
                    if (e.key === "ArrowDown") return panBy(-0.12);
                    return false;
                  };
                  if (step()) e.preventDefault();
                }}
                style={sx(
                  `position:absolute;top:${PAD.top}px;right:${PAD.right}px;bottom:${PAD.bottom}px;` +
                    `left:${PAD.left}px;cursor:${frozen ? "default" : "crosshair"};touch-action:none;` +
                    `outline:none`,
                )}
              >
                {/*
                  ── The board ────────────────────────────────────────────────

                  One cell per (rung band × expiry column), drawn from **that
                  column's own ladder** — see `columnLadders`. This is the
                  surface the owner asked to be able to read at a glance, and
                  the three states it can be in are the three states the venue
                  has:

                   - **listed** (filled green): a maker has an order resting on
                     exactly this band and date. It fills off the book, now, at
                     a price `previewFillOrder` will quote with no signer. There
                     are one to three of these per column and that is not a
                     rendering limit — it is the whole of what is listed
                     (`docs/plan7-measurements.md` §3.2).
                   - **drawable** (hairline): a band the ladder can express, so
                     it is a box you may draw, and a maker would have to price
                     it on demand. Most of the board.
                   - **not drawable** (hatched): the part of the window this
                     column has no strike in. The book does not quote the same
                     range on every date — the frozen capture's BTC lists
                     $78,500–$87,000 on 5 Sep and only $74,000–$79,000 on
                     11 Sep — so a band that is drawable on one column is
                     nothing at all on the next. The board visibly narrows to
                     the right, and that is the venue rather than the chart.
                     A column the book quotes fewer than two strikes on is
                     hatched end to end, for the same reason: there is no floor
                     and ceiling to be had, so no box exists there at any price.

                  What is deliberately *absent* from every cell is a number.
                  The reference this was drawn from prints odds in each cell;
                  doing that here would mean pricing several hundred structures
                  nobody has quoted, which is either an invented model or an
                  invented number. A premium appears for the box the player
                  actually drew, from a real quote, and nowhere else (§4.4).
                */}
                <div
                  data-role="cells"
                  aria-hidden="true"
                  style={sx("position:absolute;inset:0;pointer-events:none")}
                >
                  {drawn.map((e, ci) => {
                    const colLadder = columnLadders.get(e);
                    const leftMs = ci === 0 ? dividerMs : ((drawn[ci - 1] as number) * 1000);
                    const left = xPct(t0, t1, leftMs);
                    const right = xPct(t0, t1, e * 1000);
                    const width = Math.max(0, right - left);
                    const zonesHere = columnZones.get(e) ?? [];
                    const playable = (colLadder?.prices.length ?? 0) >= 2;

                    if (!playable) {
                      return (
                        <div
                          key={`col-${e}`}
                          data-column={e}
                          data-buyable="none"
                          title={`The book quotes one strike or fewer on ${expiryLabel(e)}, so no box can be drawn there.`}
                          style={sx(
                            `position:absolute;top:0;bottom:0;left:${left}%;width:${width}%;` +
                              `background:repeating-linear-gradient(135deg,${C.line} 0 3px,transparent 3px 8px);` +
                              `opacity:.5`,
                          )}
                        />
                      );
                    }

                    const rows = colLadder?.prices ?? [];
                    const colLo = rows[0] as number;
                    const colHi = rows[rows.length - 1] as number;
                    return (
                      <div key={`col-${e}`} data-column={e}>
                        {/* The parts of the window this column quotes nothing
                            in. Hatched rather than left blank, because blank
                            reads as "drawable, just empty" and it is not: there
                            is no strike here on this date, so there is no box.
                            Two of them at most — above the column's top rung
                            and below its bottom one. */}
                        {colHi < band.hi && (
                          <div
                            key={`none-hi-${e}`}
                            data-buyable="none"
                            title={`The book quotes no strike above ${usd(colHi)} on ${expiryLabel(e)}, so no box reaches up here on that date.`}
                            style={sx(
                              `position:absolute;left:${left}%;width:${width}%;top:0;` +
                                `bottom:${clampPct(100 - yPct(band, colHi))}%;` +
                                `background:repeating-linear-gradient(135deg,${C.line} 0 3px,transparent 3px 8px);` +
                                `opacity:.45`,
                            )}
                          />
                        )}
                        {colLo > band.lo && (
                          <div
                            key={`none-lo-${e}`}
                            data-buyable="none"
                            title={`The book quotes no strike below ${usd(colLo)} on ${expiryLabel(e)}, so no box reaches down here on that date.`}
                            style={sx(
                              `position:absolute;left:${left}%;width:${width}%;bottom:0;` +
                                `top:${clampPct(yPct(band, colLo))}%;` +
                                `background:repeating-linear-gradient(135deg,${C.line} 0 3px,transparent 3px 8px);` +
                                `opacity:.45`,
                            )}
                          />
                        )}
                        {rows.slice(0, -1).map((lo, ri) => {
                          const hi = rows[ri + 1];
                          if (hi === undefined) return null;
                          // A neighbouring column's rungs can sit outside this
                          // window; draw the part that is on the board and let
                          // the rest be off it.
                          if (hi < band.lo || lo > band.hi) return null;
                          const top = clampPct(yPct(band, hi));
                          const bottom = clampPct(100 - yPct(band, lo));
                          return (
                            <div
                              key={`${e}-${lo}`}
                              data-cell={`${e}-${lo}`}
                              data-buyable="draw"
                              style={sx(
                                `position:absolute;left:${left}%;width:${width}%;` +
                                  `top:${top}%;bottom:${bottom}%;` +
                                  `border-top:1px solid ${C.border};` +
                                  `border-right:1px solid ${C.border};` +
                                  // Alternating rows, so a tall cell can be
                                  // told from two short ones at a glance —
                                  // which is the whole reason to draw cells
                                  // rather than gridlines.
                                  `background:${
                                    e === chosen
                                      ? ri % 2 === 0
                                        ? C.cardAlt
                                        : C.card
                                      : ri % 2 === 0
                                        ? C.panelAlt
                                        : C.panel
                                  }`,
                              )}
                            />
                          );
                        })}
                        {/* The listed zones, drawn at their own edges rather
                            than snapped to the rows — a maker's zone is often
                            two or three rungs tall, and drawing it as one cell
                            would misstate the band that actually fills. */}
                        {zonesHere.map((z) => {
                          const zLo = strikeUsd(z.floor);
                          const zHi = strikeUsd(z.ceiling);
                          if (zLo === null || zHi === null) return null;
                          if (zHi < band.lo || zLo > band.hi) return null;
                          return (
                            <div
                              key={`z-${e}-${z.floor}-${z.ceiling}-${z.wing}`}
                              data-listed-cell={`${e}-${z.floor}-${z.ceiling}`}
                              data-buyable="book"
                              style={sx(
                                `position:absolute;left:${left}%;width:${width}%;` +
                                  `top:${clampPct(yPct(band, zHi))}%;` +
                                  `bottom:${clampPct(100 - yPct(band, zLo))}%;` +
                                  `background:${C.green}26;border:1px solid ${C.green}aa;` +
                                  `box-shadow:inset 0 0 18px ${C.green}1a`,
                              )}
                            />
                          );
                        })}
                      </div>
                    );
                  })}
                </div>

                {/* The history line, behind everything, clipped to the ladder's
                    band by `fitToLadder` rather than rescaled — a moved point is
                    a price that was never printed — and cut wherever the oracle
                    went quiet, for the same reason. It stops at the last print
                    and does not run on to the divider. */}
                {hasLine && (
                  <svg
                    data-role="history"
                    aria-hidden="true"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    style={sx("position:absolute;inset:0;width:100%;height:100%;pointer-events:none")}
                  >
                    {line.segments.map((seg) => (
                      <polyline
                        key={seg[0]?.t ?? 0}
                        fill="none"
                        stroke={C.borderMid}
                        strokeWidth="1.25"
                        vectorEffect="non-scaling-stroke"
                        points={seg
                          .map((p) => `${xPct(t0, t1, p.t)},${yPct(band, p.px)}`)
                          .join(" ")}
                      />
                    ))}
                  </svg>
                )}

                {/* Grid rows — one per rung of the *chosen* column, on the one
                    scale, and unlike the cells they run the full width so the
                    history behind them can be read against a strike. Rungs the
                    window has scrolled past are skipped rather than clamped: a
                    line drawn at the edge would claim a strike sits there.

                    Each carries its price, in the plot, **before** anything is
                    dragged. That is the whole of this change: the snap targets
                    were only ever discoverable by drawing a box and seeing where
                    it landed, which reads as the app moving your rectangle for
                    reasons of its own. Drawn, the lattice says what it is — the
                    strikes the venue is quoting, and the only places an edge can
                    go. `DISCRETE_STRIKES_COPY` is the sentence under the panel
                    that names it.

                    Labels thin out rather than overlap: past twenty rungs in the
                    window every other one is labelled, and the lines all stay.
                    A number that collides with its neighbour is less readable
                    than no number, and the line is the load-bearing part. */}
                {ladder.prices.map((price, i) => {
                  if (price < band.lo || price > band.hi) return null;
                  const edge = i === 0 || i === ladder.prices.length - 1;
                  const shown = ladder.prices.filter((q) => q >= band.lo && q <= band.hi).length;
                  const label = shown <= 20 || i % 2 === 0;
                  return (
                    <div
                      key={ladder.strikes[i] ?? i}
                      data-gridline={ladder.strikes[i] ?? ""}
                      style={sx(
                        `position:absolute;left:0;right:0;top:${clampPct(yPct(band, price))}%;height:0;` +
                          `border-top:1px ${edge ? "solid" : "dashed"} ${C.line};pointer-events:none`,
                      )}
                    >
                      {label && (
                        <span
                          style={sx(
                            `position:absolute;left:5px;top:-11px;` +
                              `font:500 8.5px/1 ${MONO};color:${C.faint};pointer-events:none`,
                          )}
                        >
                          {usd(price)}
                        </span>
                      )}
                    </div>
                  );
                })}

                {/* Spot, when the venue publishes one. */}
                {spotPrice !== null && spotPrice >= band.lo && spotPrice <= band.hi && (
                  <div
                    style={sx(
                      `position:absolute;left:0;right:0;top:${yPct(band, spotPrice)}%;height:0;` +
                        `border-top:1px solid ${C.blue}66;pointer-events:none`,
                    )}
                  />
                )}

                {/* The "now" divider — a real line, not an implied one (§2.3),
                    at `history.now.at` whenever there is history, so the line
                    and the points were normalised against the same instant. */}
                <div
                  data-role="now-divider"
                  style={sx(
                    `position:absolute;top:0;bottom:0;left:${xPct(t0, t1, dividerMs)}%;width:0;` +
                      `border-left:1px solid ${C.muted};pointer-events:none`,
                  )}
                />
                <span
                  style={sx(
                    `position:absolute;top:2px;left:calc(${xPct(t0, t1, dividerMs)}% + 5px);` +
                      `font:700 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.muted};pointer-events:none`,
                  )}
                >
                  NOW
                </span>

                {/* Where the oracle last spoke. The space between this tick and
                    the divider is `now.staleMs` and is left blank on purpose:
                    running the line flat across it would draw a price nobody
                    published. */}
                {hasLine && boundary.lastPrintAt !== null && (
                  <div
                    data-role="last-print"
                    style={sx(
                      `position:absolute;top:0;bottom:0;left:${xPct(t0, t1, boundary.lastPrintAt)}%;` +
                        `width:0;border-left:1px dotted ${C.faint};pointer-events:none`,
                    )}
                  />
                )}

                {/* Expiry columns — `liveExpiries`, filtered by `isFuture`, and
                    nothing else. No date reaches this screen any other way. */}
                {drawn.map((e) => (
                  <div
                    key={e}
                    style={sx(
                      `position:absolute;top:0;bottom:0;left:${xPct(t0, t1, e * 1000)}%;width:0;` +
                        `border-left:1px ${e === chosen ? "solid" : "dashed"} ${e === chosen ? `${C.accent}88` : C.line};pointer-events:none`,
                    )}
                  />
                ))}

                {/* The drag — an outline, and now the dimensions of it.

                    §4.1's rule is *one quote per released box*, and it stands:
                    nothing here asks for a price, `onQuote` still fires once, on
                    release, and no premium is drawn until it has. What this adds
                    is the part that was never a quote — how tall the rectangle
                    under the pointer is, and where it will land once `snapBox`
                    has had its say. A player was finding both out only after
                    committing, which is what "no guideline on how much the box
                    is drawn" describes.

                    The snapped preview is the honest half: the numbers say the
                    rungs the edges will move to, not the raw pointer prices, so
                    the readout cannot promise a band the ladder does not
                    express. */}
                {dragBand && (
                  <div
                    data-role="drag"
                    style={sx(
                      `position:absolute;left:${xPct(t0, t1, dividerMs)}%;` +
                        `right:${100 - xPct(t0, t1, (chosen ?? 0) * 1000)}%;` +
                        `top:${yPct(band, dragBand.hi)}%;bottom:${100 - yPct(band, dragBand.lo)}%;` +
                        `border:1px dashed ${C.accent}99;border-radius:3px;background:${C.accent}0d;pointer-events:none`,
                    )}
                  >
                    {dragPreview && (
                      <span
                        data-role="drag-readout"
                        style={sx(
                          `position:absolute;left:6px;top:-10px;padding:2px 6px;border-radius:4px;` +
                            `white-space:nowrap;font:700 9px/1 ${MONO};letter-spacing:.06em;` +
                            `color:${C.bg};background:${C.accent}`,
                        )}
                      >
                        {dragPreview}
                      </span>
                    )}
                  </div>
                )}

                {/*
                  §6 — the opponent's box, on this chart.

                  Drawn BEFORE mine so mine's outline paints over its fill and
                  the overlap reads as overlap rather than as one rectangle
                  hiding another. Filled where mine is outlined, which is the
                  whole visual grammar: two people looked at the same market and
                  drew different rectangles.

                  Only when it is the same underlying. The y-axis is *this*
                  asset's ladder, so a BTC box on an ETH scale would be a
                  rectangle at prices nobody drew — the same lie `fitToLadder`
                  refuses to tell about a history point. The mismatch is said in
                  words under the duel strip instead.

                  The right edge is at *their* expiry, not the chosen one. If
                  they drew further out than the axis reaches, `xPct` clamps to
                  the plot edge and the strip says the two dates differ.
                */}
                {revealed &&
                  theirBox &&
                  theirBox.underlying === underlying &&
                  (() => {
                    const floorUsd = strikeUsd(theirBox.floor);
                    const ceilingUsd = strikeUsd(theirBox.ceiling);
                    if (floorUsd === null || ceilingUsd === null) return null;
                    return (
                      <div
                        data-role="opponent-box"
                        style={sx(
                          `position:absolute;left:${xPct(t0, t1, dividerMs)}%;` +
                            `right:${100 - xPct(t0, t1, theirBox.expiry * 1000)}%;` +
                            `top:${yPct(band, ceilingUsd)}%;bottom:${100 - yPct(band, floorUsd)}%;` +
                            `border:1px solid ${C.violet};border-radius:3px;` +
                            `background:${C.violet}3d;pointer-events:none`,
                        )}
                      >
                        <span
                          style={sx(
                            `position:absolute;right:6px;bottom:-9px;padding:2px 5px;border-radius:4px;` +
                              `white-space:nowrap;` +
                              `font:700 9px/1 ${MONO};letter-spacing:.1em;color:${C.bg};background:${C.violet}`,
                          )}
                        >
                          THEM {usd(floorUsd)} – {usd(ceilingUsd)}
                        </span>
                      </div>
                    );
                  })()}

                {/*
                  The box. Left edge pinned to the divider, right edge on an
                  expiry column — the only edge that is real. At the reveal it
                  loses its fill and keeps its outline (§6), so the opponent's
                  fill underneath stays visible through it.

                  ── Editing, and where it stops ──────────────────────────────

                  Five handles, and the shape of the set is the answer to the
                  owner's "editable up to a point":

                   - **the body** moves the box, keeping its height in *rungs*;
                   - **top and bottom edges** resize it, each stopping one rung
                     short of the other, which is the minimum box the ladder
                     allows;
                   - **the right edge** steps between live expiry columns, and
                     only between them;
                   - **the two right corners** do both at once.

                  There is no left handle and no free horizontal drag, because
                  the left edge is now and the right edge is an expiry — not a
                  date, an *expiry*, and the book quotes seven of them. Every
                  handle is inert once the box is locked or revealed: a
                  rectangle the opponent is already playing against is not a
                  draft any more.

                  Nothing here writes a `Box`. The handles move indices; the
                  release runs `snapBox`, exactly as a fresh drag does, so an
                  edited box and a drawn box are the same object built by the
                  same function — which is why editing cannot desynchronise
                  `encodeBoxPick`.
                */}
                {shownBox && !drag && (() => {
                  const floorUsd = strikeUsd(shownBox.box.floor);
                  const ceilingUsd = strikeUsd(shownBox.box.ceiling);
                  if (floorUsd === null || ceilingUsd === null) return null;
                  const editable = !frozen;
                  const live = edit !== null;
                  const grip =
                    `position:absolute;background:${C.accent};border-radius:2px;` +
                    `pointer-events:auto;touch-action:none`;
                  return (
                    <div
                      data-role="box"
                      data-editing={live ? "true" : "false"}
                      style={sx(
                        `position:absolute;left:${xPct(t0, t1, dividerMs)}%;` +
                          `right:${100 - xPct(t0, t1, shownBox.expiry * 1000)}%;` +
                          `top:${clampPct(yPct(band, ceilingUsd))}%;` +
                          `bottom:${clampPct(100 - yPct(band, floorUsd))}%;` +
                          `border:${revealed ? 2 : 1}px solid ${C.accent};border-radius:3px;` +
                          `background:${revealed ? "transparent" : `${C.accent}1a`};` +
                          `box-shadow:0 0 22px ${C.accent}${live ? "44" : "22"};` +
                          `pointer-events:none`,
                      )}
                    >
                      <span
                        style={sx(
                          `position:absolute;left:6px;top:-9px;padding:2px 5px;border-radius:4px;` +
                            `white-space:nowrap;` +
                            `font:700 9px/1 ${MONO};letter-spacing:.1em;color:${C.bg};background:${C.accent}`,
                        )}
                      >
                        {revealed ? "YOU " : ""}
                        {usd(floorUsd)} – {usd(ceilingUsd)}
                      </span>

                      {editable && (
                        <>
                          {/* Body — move. Sits inside the edges so the edge
                              handles win the pointer where they overlap. */}
                          <div
                            data-handle="move"
                            title="Drag to move. The box keeps its height in rungs and stops at the ends of the ladder."
                            {...(boxTicket ? ticket.bind(boxTicket) : {})}
                            {...editHandlers("move")}
                            style={sx(
                              `position:absolute;inset:7px 9px;cursor:${live ? "grabbing" : "grab"};` +
                                `pointer-events:auto;touch-action:none`,
                            )}
                          />
                          <div
                            data-handle="ceiling"
                            title="Drag to move the ceiling. It stops one rung above the floor."
                            {...editHandlers("ceiling")}
                            style={sx(
                              `position:absolute;left:14px;right:14px;top:-4px;height:9px;` +
                                `cursor:ns-resize;pointer-events:auto;touch-action:none`,
                            )}
                          />
                          <div
                            data-handle="floor"
                            title="Drag to move the floor. It stops one rung below the ceiling."
                            {...editHandlers("floor")}
                            style={sx(
                              `position:absolute;left:14px;right:14px;bottom:-4px;height:9px;` +
                                `cursor:ns-resize;pointer-events:auto;touch-action:none`,
                            )}
                          />
                          <div
                            data-handle="expiry"
                            title="Drag to change the expiry. It snaps to dates the book quotes, and to nothing in between."
                            {...editHandlers("expiry")}
                            style={sx(
                              `position:absolute;top:12px;bottom:12px;right:-4px;width:9px;` +
                                `cursor:ew-resize;pointer-events:auto;touch-action:none`,
                            )}
                          />
                          <div
                            data-handle="corner-ceiling"
                            title="Ceiling and expiry together."
                            {...editHandlers("corner-ceiling")}
                            style={sx(
                              `${grip};right:-3px;top:-3px;width:7px;height:7px;cursor:nesw-resize`,
                            )}
                          />
                          <div
                            data-handle="corner-floor"
                            title="Floor and expiry together."
                            {...editHandlers("corner-floor")}
                            style={sx(
                              `${grip};right:-3px;bottom:-3px;width:7px;height:7px;cursor:nwse-resize`,
                            )}
                          />
                        </>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/*
                ── The price axis, down the right ───────────────────────────

                On the right because that is the edge the newest price arrives
                at, so the scale that reads it sits beside it rather than a
                chart's width away — the convention every trading chart uses,
                and the one the owner's reference has.

                The rungs are buttons, and clicking two of them draws the same
                box a drag does, through the same snapper. **Every rung of the
                ladder is here, at every zoom level**, which is the promise that
                makes zooming safe: a strike that has left the window is pinned
                to the edge it left by, dimmed, with an arrow — never removed.
                Clicking one brings the window back to it and then behaves
                exactly as it would have on screen, so a zoom can never put a
                strike out of reach.
              */}
              <div
                data-role="ladder"
                style={sx(
                  `position:absolute;top:${PAD.top}px;bottom:${PAD.bottom}px;right:0;` +
                    `width:${PAD.right}px`,
                )}
              >
                {ladder.prices.map((price, i) => {
                  const strike = ladder.strikes[i] ?? "";
                  const inBox =
                    box !== null &&
                    ladderIndex(ladder, box.floor) <= i &&
                    i <= ladderIndex(ladder, box.ceiling);
                  const isFloor = pendingFloor !== null && ladderIndex(ladder, pendingFloor) === i;
                  const above = price > band.hi;
                  const below = price < band.lo;
                  const off = above || below;
                  // Off-window rungs stack outwards from the edge they left by,
                  // so a deep zoom shows a legible pile of "these are up there"
                  // rather than a dozen labels on one line.
                  const rank = above
                    ? ladder.prices.filter((p) => p > band.hi && p < price).length
                    : below
                      ? ladder.prices.filter((p) => p < band.lo && p > price).length
                      : 0;
                  // Parked rungs stack inward from the edge they left by, in
                  // pixels, and sit in the outer half of the gutter — so they
                  // read as a pile of strikes set aside rather than landing on
                  // top of the prices that are actually on the board.
                  const place = off
                    ? above
                      ? `top:0;transform:translateY(${rank * 15}px)`
                      : `bottom:0;transform:translateY(${-rank * 15}px)`
                    : `top:${clampPct(yPct(band, price))}%;transform:translateY(-50%)`;
                  return (
                    <button
                      key={strike || i}
                      data-rung={strike}
                      data-offscreen={off ? (above ? "above" : "below") : undefined}
                      title={
                        off
                          ? `${usd(price)} is outside the current zoom — click to bring it back on screen`
                          : undefined
                      }
                      onClick={() => onRung(price)}
                      style={sx(
                        `position:absolute;left:${off ? AXIS_PARKED_X : AXIS_LABEL_X}px;${place};` +
                          `padding:2px 5px;border-radius:4px;cursor:pointer;white-space:nowrap;` +
                          `font:${off ? "500" : "600"} ${off ? 9 : 10}px/1 ${MONO};` +
                          (isFloor
                            ? `background:${C.accent};color:${C.bg};border:1px solid ${C.accent}`
                            : off
                              ? `background:${C.card};color:${C.faint};border:1px dashed ${C.border}`
                              : inBox
                                ? `background:${C.accent}14;color:${C.accent};border:1px solid ${C.accent}66`
                                : `background:transparent;color:${C.muted};border:1px solid transparent`),
                      )}
                    >
                      {off ? (above ? "↑" : "↓") : ""}
                      {usd(price)}
                    </button>
                  );
                })}

                {/*
                  The live price, as a filled pill on the axis.

                  It is the one number on this axis that is not a strike, so it
                  is the one that gets the fill — a player looking for "where is
                  it now" finds it without reading. Cents, because spot is a
                  price rather than an axis tick.

                  Outside the window it pins to the edge with an arrow instead
                  of being drawn at a height it is not at. The same rule as
                  `fitToLadder`: never move a price to make it fit.
                */}
                {spotPrice !== null && (
                  <span
                    data-role="spot-pill"
                    data-offscreen={
                      spotPrice > band.hi ? "above" : spotPrice < band.lo ? "below" : undefined
                    }
                    title={
                      spotPrice > band.hi || spotPrice < band.lo
                        ? `${underlying} spot ${usd(spotPrice, true)} is outside the current zoom`
                        : `${underlying} spot ${usd(spotPrice, true)}`
                    }
                    style={sx(
                      `position:absolute;left:2px;transform:translateY(-50%);` +
                        `top:${spotPrice > band.hi ? 1 : spotPrice < band.lo ? 99 : clampPct(yPct(band, spotPrice))}%;` +
                        `padding:3px 6px;border-radius:5px;white-space:nowrap;` +
                        `font:700 10px/1 ${MONO};color:${C.bg};background:${C.blue};` +
                        `box-shadow:0 0 12px ${C.blue}55`,
                    )}
                  >
                    {spotPrice > band.hi ? "↑ " : spotPrice < band.lo ? "↓ " : ""}
                    {usd(spotPrice, true)}
                  </span>
                )}
              </div>

              {/*
                ── The time axis, along the bottom ─────────────────────────

                Wall clock, and every label is a date the book actually quotes.
                The owner's reference runs ten-second columns; this venue has
                none — its expiries are daily at 08:00Z — so the columns here
                are those dates and the caption under the chart says so rather
                than letting the spacing imply a cadence.

                `NOW` carries the real clock time, which is what makes the rest
                of the axis legible as a countdown: the gap between it and the
                first column is how long the player has.
              */}
              <div
                data-role="time-axis"
                aria-hidden="true"
                style={sx(
                  `position:absolute;left:${PAD.left}px;right:${PAD.right}px;bottom:0;` +
                    `height:${PAD.bottom}px`,
                )}
              >
                <div
                  style={sx(
                    `position:absolute;left:0;right:0;top:0;height:0;border-top:1px solid ${C.line}`,
                  )}
                />
                <span
                  style={sx(
                    `position:absolute;left:${clampPct(xPct(t0, t1, dividerMs))}%;top:5px;` +
                      `transform:translateX(-50%);white-space:nowrap;text-align:center;` +
                      `font:700 8.5px/1.5 ${MONO};letter-spacing:.08em;color:${C.muted}`,
                  )}
                >
                  NOW
                  <br />
                  <span style={sx(`font:500 8.5px/1.5 ${MONO};color:${C.faint}`)}>
                    {utcClock(dividerMs)}
                  </span>
                </span>
                {drawn.map((e) => (
                  <span
                    key={e}
                    data-axis-expiry={e}
                    style={sx(
                      `position:absolute;left:${clampPct(xPct(t0, t1, e * 1000))}%;top:5px;` +
                        `transform:translateX(-50%);white-space:nowrap;text-align:center;` +
                        `font:${e === chosen ? "700" : "500"} 8.5px/1.5 ${MONO};` +
                        `color:${e === chosen ? C.accent : C.dim}`,
                    )}
                  >
                    {expiryLabel(e)}
                    <br />
                    <span style={sx(`font:500 8.5px/1.5 ${MONO};color:${C.faint}`)}>
                      {utcClock(e * 1000)}
                    </span>
                  </span>
                ))}
              </div>
            </div>

            {/* The three states a cell can be in, named where they are drawn.
                A legend is the cheapest possible way to keep "filled means a
                maker has listed it" from being something a player has to infer
                from a colour. */}
            <div
              data-role="cell-legend"
              style={sx("display:flex;align-items:center;gap:12px;flex-wrap:wrap")}
            >
              {(
                [
                  [`${C.green}26`, `1px solid ${C.green}aa`, "on the book — fills now"],
                  [C.cardAlt, `1px solid ${C.border}`, "drawable — priced on demand"],
                  [
                    `repeating-linear-gradient(135deg,${C.line} 0 3px,transparent 3px 8px)`,
                    `1px solid ${C.line}`,
                    "no strikes — nothing to draw",
                  ],
                ] as const
              ).map(([fill, edge, label]) => (
                <span
                  key={label}
                  style={sx("display:inline-flex;align-items:center;gap:6px")}
                >
                  <span
                    style={sx(
                      `width:16px;height:10px;border-radius:2px;background:${fill};border:${edge}`,
                    )}
                  />
                  <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>{label}</span>
                </span>
              ))}
              <span style={sx(`${NOTE};flex:1;min-width:24ch`)}>{CELL_LEGEND_COPY}</span>
            </div>

            {/*
              The expiry picker — every date the book quotes, offered as a chip.

              It sits **under** the chart rather than at its date on the axis,
              because the axis now ends at the chosen expiry (§ the time axis
              above): a chip for Sep 18 has nowhere to stand while the box is
              drawn against Sep 5. The chips are offers; the panel's EXPIRY row
              is the one place a date is stated as a fact about the position.
            */}
            <div
              data-role="expiry-picker"
              style={sx("display:flex;align-items:center;gap:6px;flex-wrap:wrap")}
            >
              <span style={sx(LABEL)}>EXPIRIES</span>
              {columns.map((e) => (
                <button
                  key={e}
                  data-expiry={e}
                  aria-pressed={e === chosen}
                  disabled={frozen}
                  onClick={() => {
                    if (frozen) return;
                    setExpiry(e);
                    reset();
                  }}
                  style={sx(
                    `padding:4px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;` +
                      `font:${e === chosen ? "700" : "500"} 10.5px/1 ${MONO};` +
                      (e === chosen
                        ? `color:${C.bg};background:${C.accent};border:1px solid ${C.accent}`
                        : `color:${C.dim};background:transparent;border:1px solid ${C.border}`),
                  )}
                >
                  {expiryLabel(e)}
                </button>
              ))}
              <span style={sx(`font:400 10px/1 ${MONO};color:${C.faint}`)}>
                the book's own dates — tomorrow, the day after, then weeklies
              </span>
            </div>

            {/*
              The listed zones on this column — §3.1's day-one path, drawn as
              what it is.

              This strip is deliberately short, and its shortness is the honest
              part. The book carries one to three zones per (asset, expiry) and
              nothing else can be filled without a maker, so a player who wants
              an instant fill is choosing from *these*, not from anywhere on the
              chart. Rendering them as a list rather than as an invisible
              snapping rule is what stops "snap to listed" from reading like
              "draw anything".

              Each chip is `zoneBox(zone)` — the same four numbers the order
              carries — so the box a chip draws and the order it fills cannot
              drift apart.
            */}
            {zones.length > 0 && (
              <div
                data-role="listed-zones"
                style={sx("display:flex;align-items:center;gap:6px;flex-wrap:wrap")}
              >
                <span style={sx(LABEL)}>ON THE BOOK</span>
                {zones.map((z) => {
                  const zBox = zoneBox(z);
                  const lo = strikeUsd(z.floor) ?? 0;
                  const hi = strikeUsd(z.ceiling) ?? 0;
                  const on =
                    box !== null && box.floor === z.floor && box.ceiling === z.ceiling;
                  return (
                    <button
                      key={`${z.floor}-${z.ceiling}-${z.wing}`}
                      data-zone={`${z.floor}-${z.ceiling}`}
                      aria-pressed={on}
                      disabled={frozen}
                      {...ticket.bind(chipTicket(z))}
                      onClick={() => {
                        if (frozen) return;
                        setPendingFloor(null);
                        setDrag(null);
                        commitBox(zBox);
                      }}
                      style={sx(
                        `padding:4px 9px;border-radius:6px;cursor:pointer;white-space:nowrap;` +
                          `font:${on ? "700" : "500"} 10.5px/1 ${MONO};` +
                          (on
                            ? `color:${C.bg};background:${C.green};border:1px solid ${C.green}`
                            : `color:${C.dim};background:transparent;border:1px solid ${C.border}`),
                      )}
                    >
                      {usd(lo)} – {usd(hi)}
                    </button>
                  );
                })}
                <span style={sx(`font:400 10px/1 ${MONO};color:${C.faint}`)}>
                  {zones.length === 1
                    ? "the one zone a maker has listed here — anything else is priced on demand"
                    : `the ${zones.length} zones a maker has listed here — anything else is priced on demand`}
                </span>
                {spotPrice !== null && !spotListed && (
                  <span style={sx(`font:400 10px/1 ${MONO};color:${C.amber}`)}>
                    {SPOT_OUTSIDE_COPY}
                  </span>
                )}
              </div>
            )}

            {/* Provenance, and the three things about the line that are easy
                to misread: the blank right edge, anything that ran off the
                ladder, and anything the player's own zoom is covering. All are
                said only when there is a line to say them about — an absent
                chart makes no claims at all.

                The last two are deliberately separate sentences. "Outside the
                ladder" is the venue's doing and no zoom recovers it; "hidden by
                the zoom" is the player's own and one button recovers it.
                Adding them together would have blamed the book for the
                viewport. */}
            <span style={sx(NOTE)}>
              {NOW_COPY} {TIME_AXIS_COPY}
              {hasLine ? ` History: ${priceSource ?? PRICE_SOURCE}. ` : ""}
              {hasLine ? (settlementNote ?? SETTLEMENT_NOTE) : ""}
              {hasLine && boundary.staleMs !== null && boundary.staleMs > 0
                ? ` The feed last printed ${shortAge(boundary.staleMs)} before now; the gap at the right edge is that silence, not a flat price.`
                : ""}
              {hasLine && line.clipped > 0
                ? ` ${line.clipped} print${line.clipped === 1 ? "" : "s"} ran outside the ladder and ${line.clipped === 1 ? "is" : "are"} not drawn — the line is clipped, never rescaled.`
                : ""}
              {/* What the clip LOOKS like, which the count above does not say.
                  A line that begins in the middle of the plot reads as a
                  rendering defect; it is the price entering the board, and the
                  prints before it are the ones just counted. */}
              {hasLine && line.clipped + line.hidden > 0
                ? " The drawn line therefore begins where the price entered the board, not where the history does."
                : ""}
              {hasLine && line.hidden > 0
                ? ` A further ${line.hidden} ${line.hidden === 1 ? "print is" : "prints are"} inside the ladder but outside this zoom — Fit ladder brings ${line.hidden === 1 ? "it" : "them"} back.`
                : ""}
            </span>

            {/*
              ── The empty line, explained ─────────────────────────────────

              The clause above only fires when there IS a line, because "an
              absent chart makes no claims at all". That rule is right about a
              chart with no history behind it and wrong about this case: the
              history arrived, and **every print of it is off this column's
              ladder**, so the plot is blank and the sentence that would have
              said why is gated off by the very fact it is describing.

              It is a real reading of a real book, not a chart defect. The venue
              does not quote the same band on every date: BTC's 25 Sep ladder
              sits at $85k–$86k, which contains 0% of the last thirty-three
              hours of price, and its 11 Sep column contains 3%. No zoom setting
              recovers a print that is outside the ladder's whole extent —
              `fitToLadder` drops it rather than moving it, because a point
              moved to fit is a price that was never printed.

              **Deliberately not a fourth cell state.** The three the cells carry
              — listed, drawable, not drawable — all answer "can a box be bought
              here", which is a fact about resting orders. Coverage answers "has
              the price been here", which is a fact about the history feed and
              changes nothing about what is buyable: every rung of this column is
              still drawable and still fillable. Hatching it would say the
              opposite. So it is a sentence, in the same place as the other two
              clip disclosures, and it names the column's band and date so the
              reader knows which column it is about.

              The two causes are separated for the same reason the clipped/hidden
              pair is: one is the venue's and no zoom recovers it, the other is
              the player's own viewport and one button does.
            */}
            {!hasLine && emptyLine !== null && (
              <span data-role="no-coverage" style={sx(`${NOTE};color:${C.amber}`)}>
                {emptyLine}
              </span>
            )}

            {/* How the axis is divided, because the division is the reason the
                history sometimes reads as a jagged burst against a long empty
                stretch. Both halves are on one linear scale: the left is
                whatever history arrived, the right runs to the expiry the box
                is drawn against. Pick a date a week out and thirty-three hours
                of prints get a fifth of the width; pick tomorrow and they get
                half. Nothing is compressed non-linearly and no point is moved —
                the axis simply has to hold both, and saying the proportion is
                cheaper than leaving it to look broken. */}
            {hasLine && (
              <span data-role="axis-scale" style={sx(NOTE)}>
                The axis holds {shortAge(Math.max(0, dividerMs - t0))} of history on the left and{" "}
                {shortAge(Math.max(0, t1 - dividerMs))} to expiry on the right, on one linear scale
                — a further-out expiry gives the past less of the width, and the prints stay where
                they were made.
              </span>
            )}

            {/* The rungs the zoom is covering, said as a count with the way
                back. A strike that has left the board silently is a strike the
                player can no longer draw on and was never told about; this and
                the pinned labels on the axis are the two places that cannot
                happen. */}
            {!fitted && (band.below > 0 || band.above > 0) && (
              <span data-role="offscreen-rungs" style={sx(`${NOTE};color:${C.amber}`)}>
                {band.above > 0
                  ? `${band.above} rung${band.above === 1 ? "" : "s"} above`
                  : ""}
                {band.above > 0 && band.below > 0 ? " and " : ""}
                {band.below > 0
                  ? `${band.below} rung${band.below === 1 ? "" : "s"} below`
                  : ""}{" "}
                {band.above + band.below === 1 ? "is" : "are"} outside this zoom. They are still on
                the axis, pinned to the edge — click one to bring the board back to it, or Fit
                ladder for all of them.
              </span>
            )}
          </div>

          {/* ── The parameters panel ──────────────────────────────────── */}
          <div style={sx(`${CARD};padding:16px 18px;display:grid;gap:14px;align-content:start`)}>
            {stage === "review" && spec ? (
              <Review
                spec={spec}
                match={match}
                econ={econ}
                quoted={quoted}
                contracts={size}
                trade={trade}
                canSign={Boolean(onConfirm)}
                onBack={() => setStage("draw")}
                onConfirm={() => onConfirm?.(spec, condorStrikeNumbers(spec), match)}
              />
            ) : (
              <>
                <div style={sx("display:grid;gap:5px")}>
                  <div style={sx("display:flex;align-items:center;gap:8px")}>
                    <span style={sx(LABEL)}>PRICE BAND</span>
                    <div style={sx("flex:1")} />
                    {/* The keyboard and touch way into the ticket. Hovering the
                        rectangle on the chart is the pointer's way in; this is
                        the one that does not need a pointer, and it pins rather
                        than hovers so a tap can read it. */}
                    {boxTicket && (
                      <TicketToggle
                        id={boxTicket.id}
                        open={ticket.openId === boxTicket.id}
                        onToggle={(el) => ticket.pin(boxTicket, el)}
                      />
                    )}
                  </div>
                  <span style={sx(VALUE)}>
                    {econ
                      ? `${usd(econ.zone.floor)} – ${usd(econ.zone.ceiling)}`
                      : pendingFloor !== null
                        ? `${usd(strikeUsd(pendingFloor) ?? 0)} – …`
                        : "—"}
                  </span>
                </div>

                {/* One expiry, one number, shown once: this row is the only
                    place the chosen date is stated as a fact about the
                    position. The picker above offers dates; it does not
                    restate this one. */}
                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(LABEL)}>EXPIRY</span>
                  <span data-role="expiry-value" style={sx(VALUE)}>
                    {chosen === null ? "—" : `by ${expiryLabel(chosen)}`}
                  </span>
                </div>

                {/* §4.2 — the wing is the upside, so it is readable whether or
                    not it is the player's to set, and it is now steppable on a
                    drawn box. The steps are `wingCandidates` and nothing else:
                    every value is a distance the ladder can express, which is
                    what "snapped" means for a width on an irregular ladder. */}
                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(LABEL)}>WING WIDTH</span>
                  <div style={sx("display:flex;align-items:center;gap:8px")}>
                    {/* The maker's wing on a matched box, the player's on an
                        unmatched one — `positionWingUsd`, the same instrument
                        the max payout below is taken from. Printing the drawn
                        box's wing here while the panel filled a listed zone put
                        a number under the sentence that contradicts it. */}
                    <span data-role="wing-value" style={sx(VALUE)}>
                      {positionWingUsd(box, match) === null
                        ? "—"
                        : usd(positionWingUsd(box, match) as number)}
                    </span>
                    <div style={sx("flex:1")} />
                    <button
                      data-role="wing-down"
                      aria-label="Narrower wing"
                      disabled={!wingEditable || wingAt <= 0}
                      onClick={() => stepWing(-1)}
                      style={sx(
                        `${CHIP(false, !wingEditable || wingAt <= 0)};height:24px;padding:0 9px`,
                      )}
                    >
                      −
                    </button>
                    <button
                      data-role="wing-up"
                      aria-label="Wider wing"
                      disabled={!wingEditable || wingAt < 0 || wingAt >= wings.length - 1}
                      onClick={() => stepWing(1)}
                      style={sx(
                        `${CHIP(false, !wingEditable || wingAt < 0 || wingAt >= wings.length - 1)};` +
                          `height:24px;padding:0 9px`,
                      )}
                    >
                      +
                    </button>
                  </div>
                  <span style={sx(NOTE)}>
                    The distance below the floor and above the ceiling. It is also the most this can
                    pay per contract, which is why stepping it steps the upside.
                    {match
                      ? " Fixed here: this box fills a zone the maker already listed, and its wings came with it."
                      : wings.length > 1
                        ? ` The ladder offers ${wings.length} widths at this band — every one of them a gap the book is quoting, and nothing in between.`
                        : " The ladder offers one width at this band, so there is nothing to step to."}
                  </span>
                </div>

                {/* ── SIZE ──────────────────────────────────────────────
                    The quantity. An option ticket without one is not a ticket,
                    and until now this screen had none: `contracts` was a prop
                    defaulting to 1 that only ever received its own default, so
                    every dollar figure below was frozen at one contract.

                    Typed as well as stepped, because the complaint was about
                    precision and a stepper alone is a slower way of saying no.
                    The clamp is on read (`size`), not on the input, so a
                    half-typed value does not fight the keyboard. */}
                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(LABEL)}>SIZE</span>
                  <div style={sx("display:flex;align-items:center;gap:8px")}>
                    <input
                      data-role="size-input"
                      aria-label="Contracts"
                      inputMode="numeric"
                      value={String(size)}
                      onChange={(e) => {
                        const n = Number(e.target.value.replace(/[^0-9]/g, ""));
                        setSizeInput(Number.isFinite(n) && n > 0 ? n : 1);
                      }}
                      style={sx(
                        `width:74px;height:26px;padding:0 8px;border:1px solid ${C.borderMid};` +
                          `border-radius:6px;background:${C.raised};color:${C.text};` +
                          `font:700 14px/1 ${MONO};text-align:right;outline:none`,
                      )}
                    />
                    <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>
                      {size === 1 ? "contract" : "contracts"}
                    </span>
                    <div style={sx("flex:1")} />
                    <button
                      data-role="size-down"
                      aria-label="Fewer contracts"
                      disabled={size <= 1}
                      onClick={() => setSizeInput(size - 1)}
                      style={sx(`${CHIP(false, size <= 1)};height:24px;padding:0 9px`)}
                    >
                      −
                    </button>
                    <button
                      data-role="size-up"
                      aria-label="More contracts"
                      disabled={size >= MAX_PANEL_CONTRACTS}
                      onClick={() => setSizeInput(size + 1)}
                      style={sx(
                        `${CHIP(false, size >= MAX_PANEL_CONTRACTS)};height:24px;padding:0 9px`,
                      )}
                    >
                      +
                    </button>
                  </div>
                  <span style={sx(NOTE)}>
                    {SIZE_COPY}
                    {quoted && premium !== null
                      ? ` At ${usd(premium, true)} a contract, ${size} ${size === 1 ? "costs" : "cost"} ${usd(premium * size, true)}.`
                      : " Nothing has priced this box yet, so there is no cost to scale."}
                  </span>
                  {/* The bound that is real, named where it bites — and the one
                      that is NOT claimed, said too. The maker's remaining depth
                      is published in the collateral token's own decimals and
                      this screen holds no map to convert it, so it is not
                      converted; a limit invented from a number in unknown units
                      is how this repo's money bugs start. */}
                  <span data-role="fill-cap" style={sx(NOTE)}>
                    {fillCapCopy(quoted ? premium : null)}
                  </span>
                  <span style={sx(NOTE)}>
                    The maker's remaining size is published in the collateral token's own units, and
                    this screen does not convert it — so no depth limit is claimed here. The cap
                    above is this build's own and is checked before anything signs.
                  </span>
                </div>

                <div style={sx(`height:1px;background:${C.line}`)} />

                {/* Max loss, above the upside figure. Always, at every detail
                    level, ungated — plan6 §A7 and plan7 §4.3. */}
                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(`${LABEL};color:${C.red}`)}>MAX LOSS</span>
                  <span data-role="max-loss" style={sx(`${VALUE};color:${C.red}`)}>
                    {quoted && econ ? usd(econ.maxLoss, true) : "—"}
                  </span>
                  <span style={sx(NOTE)}>
                    {MAX_LOSS_COPY}
                    {quoted ? "" : " Nothing has priced this box yet, so there is no figure to print."}
                  </span>
                </div>

                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(LABEL)}>MAX PAYOUT</span>
                  <span data-role="max-payout" style={sx(`${VALUE};color:${C.green}`)}>
                    {econ ? `${usd(econ.maxPayout, true)}${size === 1 ? " per contract" : ""}` : "—"}
                  </span>
                  {/* §4.4 — computed, or absent. Never a dash, never an
                      estimate, and never a rate from a table in this repo. */}
                  {multiple !== null && (
                    <span
                      data-role="payout-multiple"
                      style={sx(`font:700 12px/1 ${MONO};color:${C.accent}`)}
                    >
                      {multiple.toFixed(2)}× the premium
                    </span>
                  )}
                  <span style={sx(NOTE)}>{SETTLEMENT_COPY}</span>
                </div>

                <div style={sx(`height:1px;background:${C.line}`)} />

                {/* The ladder's own constraint, said in dollars. */}
                {minHere !== null && minFrom !== null && (
                  <span style={sx(NOTE)}>
                    Smallest box from {usd(minFrom)} here is {usd(minHere)} tall — that is the next
                    rung the book quotes, not a rule of ours.
                  </span>
                )}

                {box && problem && (
                  <span style={sx(`font:500 11px/1.5 ${SANS};color:${C.amber}`)}>
                    Cannot be played — {problem}.
                  </span>
                )}

                {box && !problem && (
                  <div data-role="listed" style={sx("display:grid;gap:5px")}>
                    <span style={sx(NOTE)}>{match ? LISTED_COPY : UNLISTED_COPY}</span>
                    {match && <span style={sx(NOTE)}>{LISTED_WING_COPY}</span>}
                    {/* §2.4's delta shading cannot reach a listed zone, and the
                        reason is worth one sentence rather than a blank space
                        where a figure would be. */}
                    {match && <span style={sx(NOTE)}>{LISTED_NO_GREEKS_COPY}</span>}
                    {!match && zones.length === 0 && (
                      <span style={sx(NOTE)}>{NO_ZONES_COPY}</span>
                    )}
                  </div>
                )}

                <button
                  onClick={() => spec && setStage("review")}
                  disabled={!spec}
                  style={sx(BTN(C.accent, true, !spec))}
                >
                  {spec ? "Review this box" : "Draw a box to continue"}
                </button>

                {!box && (
                  <span style={sx(NOTE)}>
                    Drag on the chart, or click a floor strike and then a ceiling strike. The box
                    snaps to strikes the book is quoting, so the tighter you can draw it, the more
                    the market is quoting near there. Scroll to zoom the board, shift-scroll to pan;
                    the arrow keys and 0 do the same from the keyboard.
                  </span>
                )}

                {/* What can still be changed, said once the box exists — the
                    handles are small and a player should not have to find them
                    by hovering. The last clause is the limit, and it is the
                    ladder's rather than ours. */}
                {/* The answer to "I cannot size the box to the cent", said
                    where the snapping happens rather than left to be inferred
                    from a rectangle that moves on release. Both halves: the
                    instrument really is discrete, and the precise path really
                    does exist and is not wired here. */}
                <div data-role="precision" style={sx("display:grid;gap:5px")}>
                  <span style={sx(NOTE)}>{DISCRETE_STRIKES_COPY}</span>
                  {rungGapCopy(ladder) && <span style={sx(NOTE)}>{rungGapCopy(ladder)}</span>}
                  <span style={sx(NOTE)}>{RFQ_PRECISION_COPY}</span>
                </div>

                {box && !frozen && !problem && (
                  <span data-role="edit-hint" style={sx(NOTE)}>
                    Drag the box to move it, its top or bottom edge to resize it, and its right edge
                    to change the expiry. Edges land on strikes the book quotes and the expiry lands
                    on a date it lists — there is nothing in between to land on.
                  </span>
                )}
                {box && frozen && (
                  <span data-role="edit-hint" style={sx(NOTE)}>
                    This box is committed to the duel, so it can no longer be moved or resized — the
                    rectangle on screen is the one the opponent is playing against.
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}
      {/* One panel, at the root and `position:fixed`, so it escapes the chart's
          `overflow:hidden` and the two-column grid rather than being clipped by
          either. */}
      {ticket.panel}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The confirm step — readable, and inert without the flag
// ─────────────────────────────────────────────────────────────────────────────

function Review({
  spec,
  match,
  econ,
  quoted,
  contracts,
  trade,
  canSign,
  onBack,
  onConfirm,
}: {
  spec: CondorSpec;
  /** The listed zone this box fills, when it fills one. */
  match: ListedFill | null;
  econ: ReturnType<typeof condorEconomics> | null;
  quoted: boolean;
  contracts: number;
  trade: boolean;
  canSign: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const strikes = condorStrikeNumbers(spec);
  return (
    <>
      <span style={sx(LABEL)}>CONFIRM</span>
      <div style={sx("display:grid;gap:5px")}>
        <span style={sx(VALUE)}>
          {econ ? `${usd(econ.zone.floor)} – ${usd(econ.zone.ceiling)}` : "—"}
        </span>
        {/*
          What the player is about to hold, named correctly.

          A matched box is filled as the maker's `RANGER`, not as the
          `CALL_CONDOR` this screen builds for the other path. The two carry the
          same four strikes and the same payoff shape, which is precisely why
          the label has to come from the match and not from the shape: the SDK
          itself prices a four-strike order as a condor unless it is told
          otherwise, and a screen that made the same slip would be the last
          place anyone looked.
        */}
        <span data-role="instrument" style={sx(`font:500 11px/1 ${MONO};color:${C.muted}`)}>
          {spec.underlying} · {match ? "listed zone" : "long call condor"} · by{" "}
          {expiryLabel(spec.expiry)}
        </span>
        <span style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint}`)}>
          {strikes.map((s) => usd(s)).join(" · ")}
        </span>
        {match && <span style={sx(NOTE)}>{LISTED_COPY}</span>}
      </div>

      <div style={sx(`height:1px;background:${C.line}`)} />

      <div style={sx("display:grid;gap:5px")}>
        <span style={sx(`${LABEL};color:${C.red}`)}>MAX LOSS</span>
        <span data-role="max-loss" style={sx(`${VALUE};color:${C.red}`)}>
          {quoted && econ ? usd(econ.maxLoss, true) : "—"}
        </span>
        <span style={sx(NOTE)}>{MAX_LOSS_COPY}</span>
      </div>

      <div style={sx("display:grid;gap:5px")}>
        <span style={sx(LABEL)}>MAX PAYOUT</span>
        <span data-role="max-payout" style={sx(`${VALUE};color:${C.green}`)}>
          {econ ? `${usd(econ.maxPayout, true)}${contracts === 1 ? " per contract" : ""}` : "—"}
        </span>
        {quoted && econ && econ.payoutMultiple !== null && (
          <span
            data-role="payout-multiple"
            style={sx(`font:700 12px/1 ${MONO};color:${C.accent}`)}
          >
            {econ.payoutMultiple.toFixed(2)}× the premium
          </span>
        )}
        <span style={sx(NOTE)}>{SETTLEMENT_COPY}</span>
      </div>

      <div style={sx("display:flex;gap:8px")}>
        <button onClick={onBack} style={sx(BTN(C.borderMid, false))}>
          Back
        </button>
        <button
          onClick={onConfirm}
          disabled={!trade || !canSign || !quoted}
          style={sx(BTN(C.accent, true, !trade || !canSign || !quoted))}
        >
          Buy this box
        </button>
      </div>
      {(!trade || !canSign) && (
        <span style={sx(NOTE)}>
          Buying is switched off in this build. The position above is real and priced; nothing here
          can sign until an operator turns trading on.
        </span>
      )}
      {trade && canSign && !quoted && (
        <span style={sx(NOTE)}>Waiting on a price for this box.</span>
      )}
    </>
  );
}
