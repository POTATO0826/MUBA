import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  boxProblem,
  deriveLadder,
  isPlayable,
  ladderBounds,
  ladderIndex,
  liveExpiries,
  minBoxHeight,
  parseStrike,
  priceToStrike,
  snapBox,
  strikeUsd,
  type Box,
  type LadderSnapshot,
} from "../data/box.ts";
import {
  boxToCondor,
  condorEconomics,
  condorStrikeNumbers,
  isCondorUnderlying,
  validateSpec,
  type CondorSpec,
} from "../data/condor.ts";
import {
  matchListedZone,
  zoneBox,
  zoneCoversSpot,
  zoneQuote,
  zoneToRanger,
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
import type { RoomSeat, RoomView } from "../data/room.ts";
import { poolOf, usdc } from "../data/stake.ts";
import { shortAddress } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";

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
 *  - the **y-axis is `ladderBounds()`**, derived from the ladder *first*, and
 *    the chart, the box, the history line and the drag arithmetic all read the
 *    same two functions, {@link yPct} and {@link priceAtFraction} (§2.5). A
 *    second scale computed anywhere would drift by a pixel and the box would
 *    stop lining up with the strikes it snaps to.
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
 */
export function stakeBasisLine(stakeUsdc: number, custody: DuelCustody | null): string {
  return custody
    ? `${usdc(stakeUsdc)} each · winner takes ${usdc(poolOf(stakeUsdc))}`
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
  "no test ETH is transferred or escrowed on this path until a Base Sepolia DuelEscrow is configured";

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

/** The chart's price band. Always `ladderBounds`, never anything else. */
export interface Band {
  lo: number;
  hi: number;
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

export interface BoxBuilderProps {
  /**
   * One raw `fetchOrders()` capture plus the bundled chain config — the ladder's
   * only input, and the only market data this screen reads. `test/fixtures/orders.json`
   * is exactly this shape and so is `RawMarket` from `src/server/thetanuts.ts`.
   */
  snapshot: LadderSnapshot | null;
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
   * The confirm step's action. This opens a read-only pricing/preview step even
   * when trading is off; the execution component owns the real wallet and
   * operator gates. Absent leaves the confirm screen readable and inert.
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
   * Maximum premium shown before an unlisted box opens its pricing step. This
   * is a user-editable bid ceiling, not a quote; the actual max loss replaces
   * it only after a maker answers.
   */
  unquotedMaxLoss?: number | null;
  /**
   * The execution step opened by `onConfirm`. Kept inside this component so
   * the drawn box remains mounted and is still there when the player returns.
   */
  execution?: ReactNode;
  /** Prevents navigation from destroying an active request or transaction. */
  executionBusy?: boolean;
  onCloseExecution?: () => void;
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

/** Chart geometry, in CSS pixels. The plot is what every percentage is of. */
const CHART_H = 380;
const PAD = { top: 16, right: 18, bottom: 14, left: 74 };

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────

/** A drag in progress: two prices, unsnapped, and no numbers on screen. */
interface Drag {
  from: number;
  to: number;
}

export function BoxBuilder({
  snapshot,
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
  unquotedMaxLoss = null,
  execution,
  executionBusy = false,
  onCloseExecution,
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

  const [underlying, setUnderlying] = useState<string>("ETH");
  const [expiry, setExpiry] = useState<number | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  /** The floor of a box being built one rung at a time. */
  const [pendingFloor, setPendingFloor] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [stage, setStage] = useState<"draw" | "review">("draw");
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

  // 3. The y-axis, fitted to the ladder — never the reverse (§2.5).
  const band: Band | null = useMemo(() => (ladder ? ladderBounds(ladder) : null), [ladder]);

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
   * 3b. The line, clipped to the band the **ladder** chose — `fitToLadder`, not
   * a filter written here, and never a rescale. A point moved to fit is a price
   * that was never printed, so a print outside the ladder's extent is dropped
   * and counted, and the count is said out loud below the chart.
   */
  const line = useMemo(() => {
    if (!history || !band) return { segments: [] as readonly (readonly HistoryPoint[])[], clipped: 0 };
    const { points, clipped } = fitToLadder(history, band.lo, band.hi);
    return {
      segments: segments(
        points.filter((p) => p.t >= t0),
        history.meta.granularity?.medianGapMs,
      ),
      clipped,
    };
  }, [history, band, t0]);
  const hasLine = line.segments.length > 0;

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

  /**
   * A raw pair of prices → a snapped box, one quote, and nothing in between.
   *
   * The whole of §4.1 lives in this function: it is called on release and on a
   * completed pair of rung clicks, and never on a move. The order of the calls
   * is plan 7 §1's — playable, then the instrument, then the strikes the SDK
   * boundary validates.
   */
  const commitBox = useCallback(
    (candidate: Box) => {
      if (!ladder) return;
      setBox(candidate);
      setStage("draw");

      if (!onQuote || !isPlayable(candidate, ladder)) return;
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
    [frozen, pendingFloor, commit],
  );

  const spotPrice = spot?.(underlying) ?? null;

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
  const match = useMemo(() => listedFill(box, snapshot, nowMs), [box, snapshot, nowMs]);
  const spotListed = zones.some((z) => zoneCoversSpot(z, spotPrice));
  // A listed quote belongs to the current snapshot, never to the draw event
  // that happened before a refresh. The prop remains the explicit premium seam
  // for tests and future settled RFQs; a live match always outranks it.
  const currentPremium = match ? (zoneQuote(match.zone) ?? premium) : premium;
  const econ = spec ? condorEconomics(spec, currentPremium ?? 0, contracts) : null;
  const quoted = typeof currentPremium === "number" && currentPremium > 0;
  /** `max payout ÷ premium paid`, or nothing at all. Never a placeholder. */
  const multiple = quoted && econ ? econ.payoutMultiple : null;

  const minHere = ladder
    ? strikeUsd(minBoxHeight(ladder, box?.floor ?? pendingFloor ?? ladder.strikes[0] ?? null))
    : null;
  const minFrom = strikeUsd(box?.floor ?? pendingFloor ?? ladder?.strikes[0] ?? null);

  const dragBand =
    drag && band
      ? { lo: Math.min(drag.from, drag.to), hi: Math.max(drag.from, drag.to) }
      : null;

  if (execution) {
    return (
      <div style={sx("padding:22px 28px;max-width:1240px;margin:0 auto;display:grid;gap:14px")}>
        <div style={sx("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
          {onCloseExecution && (
            <button
              className="box-action"
              onClick={onCloseExecution}
              disabled={executionBusy}
              style={sx(BTN(C.borderMid, false, executionBusy))}
            >
              {executionBusy ? "Finish or cancel this step" : "← Back to box"}
            </button>
          )}
          <h2 style={sx(`margin:0;font:700 18px/1 ${SANS};letter-spacing:-.02em`)}>
            Complete your box
          </h2>
        </div>
        {execution}
        {executionBusy && (
          <span aria-live="polite" style={sx(NOTE)}>
            Navigation is paused so the active request, its private quote key, and any transaction
            progress stay attached to this screen.
          </span>
        )}
      </div>
    );
  }

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
        <div style={sx(`${CARD};padding:26px 20px`)}>
          <span style={sx(`font:400 12px/1.6 ${SANS};color:${C.faint}`)}>
            No live expiries on {underlying} right now. The columns are the book's own expiries —
            tomorrow, the day after, then weeklies — so an empty book means there is nothing here to
            draw on, rather than a chart with nothing in it.
          </span>
        </div>
      ) : (
        <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:14px")}>
          {/* ── The chart ─────────────────────────────────────────────── */}
          <div style={sx(`${CARD};padding:14px 16px 10px;display:grid;gap:10px`)}>
            <div style={sx("display:flex;align-items:center;gap:10px;flex-wrap:wrap")}>
              <span style={sx(LABEL)}>{underlying} · LIVE STRIKES</span>
              <span style={sx(`font:500 10px/1 ${MONO};color:${C.faint}`)}>
                {ladder.strikes.length} rungs · {usd(band.lo)}–{usd(band.hi)}
              </span>
              <div style={sx("flex:1")} />
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
                onPointerDown={(e) => {
                  if (frozen) return;
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
                style={sx(
                  `position:absolute;top:${PAD.top}px;right:${PAD.right}px;bottom:${PAD.bottom}px;` +
                    `left:${PAD.left}px;cursor:${frozen ? "default" : "crosshair"};touch-action:none`,
                )}
              >
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

                {/* Grid rows — one per rung, on the one scale. */}
                {ladder.prices.map((price, i) => (
                  <div
                    key={ladder.strikes[i] ?? i}
                    style={sx(
                      `position:absolute;left:0;right:0;top:${yPct(band, price)}%;height:0;` +
                        `border-top:1px ${i === 0 || i === ladder.prices.length - 1 ? "solid" : "dashed"} ${C.line};pointer-events:none`,
                    )}
                  />
                ))}

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

                {/* The drag: an outline and no numbers at all. */}
                {dragBand && (
                  <div
                    data-role="drag"
                    style={sx(
                      `position:absolute;left:${xPct(t0, t1, dividerMs)}%;` +
                        `right:${100 - xPct(t0, t1, (chosen ?? 0) * 1000)}%;` +
                        `top:${yPct(band, dragBand.hi)}%;bottom:${100 - yPct(band, dragBand.lo)}%;` +
                        `border:1px dashed ${C.accent}99;border-radius:3px;background:${C.accent}0d;pointer-events:none`,
                    )}
                  />
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

                {/* The box. Left edge pinned to the divider, right edge on the
                    chosen expiry column — the only edge that is real. At the
                    reveal it loses its fill and keeps its outline (§6), so the
                    opponent's fill underneath stays visible through it. */}
                {box && !drag && (() => {
                  const floorUsd = strikeUsd(box.floor);
                  const ceilingUsd = strikeUsd(box.ceiling);
                  if (floorUsd === null || ceilingUsd === null) return null;
                  return (
                    <div
                      data-role="box"
                      style={sx(
                        `position:absolute;left:${xPct(t0, t1, dividerMs)}%;` +
                          `right:${100 - xPct(t0, t1, (chosen ?? 0) * 1000)}%;` +
                          `top:${yPct(band, ceilingUsd)}%;bottom:${100 - yPct(band, floorUsd)}%;` +
                          `border:${revealed ? 2 : 1}px solid ${C.accent};border-radius:3px;` +
                          `background:${revealed ? "transparent" : `${C.accent}1a`};` +
                          `box-shadow:0 0 22px ${C.accent}22;pointer-events:none`,
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
                    </div>
                  );
                })()}
              </div>

              {/* Strike axis — the rungs, as buttons. Clicking two of them
                  draws the same box a drag does, through the same snapper. */}
              <div
                data-role="ladder"
                style={sx(
                  `position:absolute;top:${PAD.top}px;bottom:${PAD.bottom}px;left:0;width:${PAD.left}px`,
                )}
              >
                {ladder.prices.map((price, i) => {
                  const strike = ladder.strikes[i] ?? "";
                  const inBox =
                    box !== null &&
                    ladderIndex(ladder, box.floor) <= i &&
                    i <= ladderIndex(ladder, box.ceiling);
                  const isFloor = pendingFloor !== null && ladderIndex(ladder, pendingFloor) === i;
                  return (
                    <button
                      key={strike || i}
                      data-rung={strike}
                      onClick={() => onRung(price)}
                      style={sx(
                        `position:absolute;right:6px;top:${yPct(band, price)}%;transform:translateY(-50%);` +
                          `padding:2px 6px;border-radius:4px;cursor:pointer;font:500 10px/1 ${MONO};` +
                          (isFloor
                            ? `background:${C.accent};color:${C.bg};border:1px solid ${C.accent}`
                            : inBox
                              ? `background:transparent;color:${C.accent};border:1px solid ${C.accent}55`
                              : `background:transparent;color:${C.dim};border:1px solid transparent`),
                      )}
                    >
                      {usd(price)}
                    </button>
                  );
                })}
              </div>

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

            {/* Provenance, and the two things about the line that are easy to
                misread: the blank right edge, and anything that ran off the
                ladder. Both are said only when there is a line to say them
                about — an absent chart makes no claims at all. */}
            <span style={sx(NOTE)}>
              {NOW_COPY}
              {hasLine ? ` History: ${priceSource ?? PRICE_SOURCE}. ` : ""}
              {hasLine ? (settlementNote ?? SETTLEMENT_NOTE) : ""}
              {hasLine && boundary.staleMs !== null && boundary.staleMs > 0
                ? ` The feed last printed ${shortAge(boundary.staleMs)} before now; the gap at the right edge is that silence, not a flat price.`
                : ""}
              {hasLine && line.clipped > 0
                ? ` ${line.clipped} print${line.clipped === 1 ? "" : "s"} ran outside the ladder and ${line.clipped === 1 ? "is" : "are"} not drawn — the line is clipped, never rescaled.`
                : ""}
            </span>
          </div>

          {/* ── The parameters panel ──────────────────────────────────── */}
          <div style={sx(`${CARD};padding:16px 18px;display:grid;gap:14px;align-content:start`)}>
            {stage === "review" && spec ? (
              <Review
                spec={spec}
                match={match}
                econ={econ}
                quoted={quoted}
                unquotedMaxLoss={unquotedMaxLoss}
                contracts={contracts}
                trade={trade}
                canSign={Boolean(onConfirm)}
                onBack={() => setStage("draw")}
                onConfirm={() => onConfirm?.(spec, condorStrikeNumbers(spec), match)}
              />
            ) : (
              <>
                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(LABEL)}>PRICE BAND</span>
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

                {/* §4.2 — the wing is the upside, so it is readable even
                    though it is not draggable yet. */}
                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(LABEL)}>WING WIDTH</span>
                  <span style={sx(VALUE)}>
                    {box ? usd(strikeUsd(box.wing) ?? 0) : "—"}
                  </span>
                  <span style={sx(NOTE)}>
                    The distance below the floor and above the ceiling. It is also the most this can
                    pay per contract, which is why it is on screen even while it is fixed.
                  </span>
                </div>

                <div style={sx(`height:1px;background:${C.line}`)} />

                {/* Max loss, above the upside figure. Always, at every detail
                    level, ungated — plan6 §A7 and plan7 §4.3. */}
                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(`${LABEL};color:${C.red}`)}>MAX LOSS</span>
                  <span data-role="max-loss" style={sx(`${VALUE};color:${C.red}`)}>
                    {quoted && econ
                      ? usd(econ.maxLoss, true)
                      : unquotedMaxLoss !== null
                        ? `Up to ${usd(unquotedMaxLoss, true)}`
                        : "Price required"}
                  </span>
                  <span style={sx(NOTE)}>
                    {quoted
                      ? MAX_LOSS_COPY
                      : unquotedMaxLoss !== null
                        ? "Starting maximum bid. You can change it before the pricing request is sent; an accepted maker price becomes the exact max loss."
                        : "No maker has priced this box yet. Open pricing to set the most you are willing to pay."}
                  </span>
                </div>

                <div style={sx("display:grid;gap:5px")}>
                  <span style={sx(LABEL)}>MAX PAYOUT</span>
                  <span data-role="max-payout" style={sx(`${VALUE};color:${C.green}`)}>
                    {econ ? `${usd(econ.maxPayout, true)}${contracts === 1 ? " per contract" : ""}` : "—"}
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
                    the market is quoting near there.
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      )}
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
  unquotedMaxLoss,
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
  unquotedMaxLoss: number | null;
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
          {quoted && econ
            ? usd(econ.maxLoss, true)
            : unquotedMaxLoss !== null
              ? `Up to ${usd(unquotedMaxLoss, true)}`
              : "Price required"}
        </span>
        <span style={sx(NOTE)}>
          {quoted
            ? MAX_LOSS_COPY
            : unquotedMaxLoss !== null
              ? "This is the starting maximum bid. You can change it before a request is sent; the accepted maker price becomes your exact max loss."
              : "No maker has priced this box yet. Open pricing to set the most you are willing to pay."}
        </span>
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
          className="box-action"
          onClick={onConfirm}
          disabled={!canSign}
          style={sx(BTN(C.accent, true, !canSign))}
        >
          {match && quoted ? "Buy this box" : "Price this box"}
        </button>
      </div>
      {!canSign && (
        <span style={sx(NOTE)}>
          This build has no execution route for the box yet.
        </span>
      )}
      {canSign && !quoted && (
        <span style={sx(NOTE)}>
          This box has no live ask. The next step sets a maximum loss and asks market makers for a
          price.
        </span>
      )}
      {canSign && !trade && (
        <span style={sx(NOTE)}>
          You can review the complete pricing flow. Transactions remain disabled until a real
          wallet is connected and the operator turns trading on.
        </span>
      )}
    </>
  );
}
