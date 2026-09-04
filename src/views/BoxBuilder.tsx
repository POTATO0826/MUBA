import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  boxProblem,
  deriveLadder,
  isPlayable,
  ladderBounds,
  ladderIndex,
  liveExpiries,
  minBoxHeight,
  priceToStrike,
  snapBox,
  strikeUsd,
  wingLandsOnLadder,
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
  PRICE_SOURCE,
  SETTLEMENT_NOTE,
  fitToLadder,
  isFuture,
  type HistoryPoint,
  type NowBoundary,
  type PriceHistory,
} from "../data/history.ts";
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
   */
  onQuote?: (spec: CondorSpec, strikes: [number, number, number, number]) => void;
  /**
   * The confirm step's action. Reached only with `features.trade` on; absent
   * leaves the confirm screen readable and inert, which is the state a build
   * without the flag ships in.
   */
  onConfirm?: (spec: CondorSpec, strikes: [number, number, number, number]) => void;
  /**
   * Override the `/api/config` read. `undefined` asks the server once at mount;
   * `false` keeps the screen inert with no network call at all.
   */
  tradeEnabled?: boolean;
  onBack?: () => void;
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
  priceSource,
  settlementNote,
  now,
  premium = null,
  contracts = 1,
  onQuote,
  onConfirm,
  tradeEnabled,
  onBack,
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

  /**
   * A raw pair of prices → a snapped box, one quote, and nothing in between.
   *
   * The whole of §4.1 lives in this function: it is called on release and on a
   * completed pair of rung clicks, and never on a move. The order of the calls
   * is plan 7 §1's — playable, then the instrument, then the strikes the SDK
   * boundary validates.
   */
  const commit = useCallback(
    (a: number, b: number) => {
      if (!ladder || chosen === null) return;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const rawFloor = priceToStrike(lo);
      const rawCeiling = priceToStrike(hi);
      if (rawFloor === null || rawCeiling === null) return;

      const snapped = snapBox(
        {
          underlying,
          floor: rawFloor,
          ceiling: rawCeiling,
          wing: "",
          expiry: chosen,
        },
        ladder,
      );
      setBox(snapped);
      setStage("draw");

      if (!onQuote || !isPlayable(snapped, ladder)) return;
      let spec: CondorSpec;
      try {
        spec = boxToCondor(snapped);
      } catch {
        // `isPlayable` said yes and the constructor disagreed. That is a bug in
        // this file's ordering, not a player error, and it must not reach a
        // price call.
        return;
      }
      const strikes = condorStrikeNumbers(spec);
      if (!validateSpec(spec).valid) return;
      onQuote(spec, strikes);
    },
    [ladder, chosen, underlying, onQuote],
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
    [pendingFloor, commit],
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

  const econ = spec ? condorEconomics(spec, premium ?? 0, contracts) : null;
  const quoted = typeof premium === "number" && premium > 0;
  /** `max payout ÷ premium paid`, or nothing at all. Never a placeholder. */
  const multiple = quoted && econ ? econ.payoutMultiple : null;
  const listed =
    box && ladder ? wingLandsOnLadder(ladder, box.floor, box.ceiling, box.wing) : false;

  const minHere = ladder
    ? strikeUsd(minBoxHeight(ladder, box?.floor ?? pendingFloor ?? ladder.strikes[0] ?? null))
    : null;
  const minFrom = strikeUsd(box?.floor ?? pendingFloor ?? ladder?.strikes[0] ?? null);

  const dragBand =
    drag && band
      ? { lo: Math.min(drag.from, drag.to), hi: Math.max(drag.from, drag.to) }
      : null;

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

      {/* ── Assets. ETH and BTC play; everything else is greyed with why. ── */}
      <div style={sx("display:flex;gap:6px;flex-wrap:wrap;align-items:center")}>
        {assets.map((a) => {
          const playable = isCondorUnderlying(a);
          return (
            <button
              key={a}
              data-asset={a}
              disabled={!playable}
              title={playable ? undefined : `${a} has no condor market — ETH and BTC only`}
              onClick={() => {
                if (!playable) return;
                setUnderlying(a);
                setExpiry(null);
                reset();
              }}
              style={sx(CHIP(a === underlying, !playable))}
            >
              {a}
            </button>
          );
        })}
        {assets.some((a) => !isCondorUnderlying(a)) && (
          <span style={sx(NOTE)}>Greyed assets have a book, but no condor market.</span>
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
              {box && (
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
                    `left:${PAD.left}px;cursor:crosshair;touch-action:none`,
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

                {/* The box. Left edge pinned to the divider, right edge on the
                    chosen expiry column — the only edge that is real. */}
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
                          `border:1px solid ${C.accent};border-radius:3px;` +
                          `background:${C.accent}1a;box-shadow:0 0 22px ${C.accent}22;pointer-events:none`,
                      )}
                    >
                      <span
                        style={sx(
                          `position:absolute;left:6px;top:-9px;padding:2px 5px;border-radius:4px;` +
                            `white-space:nowrap;` +
                            `font:700 9px/1 ${MONO};letter-spacing:.1em;color:${C.bg};background:${C.accent}`,
                        )}
                      >
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
                  onClick={() => {
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
                econ={econ}
                quoted={quoted}
                contracts={contracts}
                trade={trade}
                canSign={Boolean(onConfirm)}
                onBack={() => setStage("draw")}
                onConfirm={() => onConfirm?.(spec, condorStrikeNumbers(spec))}
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
                  <span style={sx(NOTE)}>
                    {listed
                      ? "All four strikes are listed — this one fills straight off the book."
                      : "The outer strikes are not listed — a maker prices this one on demand."}
                  </span>
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
  econ,
  quoted,
  contracts,
  trade,
  canSign,
  onBack,
  onConfirm,
}: {
  spec: CondorSpec;
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
        <span style={sx(`font:500 11px/1 ${MONO};color:${C.muted}`)}>
          {spec.underlying} · long call condor · by {expiryLabel(spec.expiry)}
        </span>
        <span style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint}`)}>
          {strikes.map((s) => usd(s)).join(" · ")}
        </span>
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
