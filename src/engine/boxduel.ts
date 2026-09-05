import type { Box } from "../data/box.ts";
import { boxToCondor, condorPayoff, condorStrikeNumbers, wingUsd } from "../data/condor.ts";
import { series, TAPE_LEN } from "./tape.ts";

/**
 * Who won a box duel, and why.
 *
 * The arena had no answer to this. Two players locked two boxes, the reveal drew
 * them on one chart, and the duel ended there — which was fine while nothing was
 * staked and impossible once something is: `winnerTakesAll` takes an address,
 * and there was no rule that produced one.
 *
 * ## The rule
 *
 * Settle both boxes on the room's own tape, at the print the room's duration
 * ends on, and score each as **the fraction of its own maximum it captured**.
 *
 * The normalisation is the part worth arguing for. `condorPayoff` returns
 * dollars, and dollars are not comparable between two boxes: a BTC box's wing
 * is worth thousands where an ETH box's is worth tens, and a wide box out-earns
 * a narrow one on width alone. Dividing by the box's own maximum asks the only
 * question a box duel should ask — *did the price land in the band you drew?* —
 * and answers it on a 0…1 scale that is identical across assets and widths.
 *
 * ## Determinism
 *
 * Both clients must reach the same winner with no message between them, because
 * either of them may be the one that calls `winnerTakesAll`. Everything here is
 * a pure function of the room's `seed`, the two decoded boxes, and `settleAt` —
 * `series()` is a seeded walk cached by `sym:salt`, so both sides read the same
 * prints. Nothing consults the wall clock, the network, or the viewer.
 *
 * The result is stated in ABSOLUTE seats — `"host"` or `"guest"` — never as
 * "you won". A viewer-relative verdict is how both clients end up believing
 * they won the same duel, and with an open `winnerTakesAll` that is a race for
 * the pot rather than a disagreement.
 */

export type DuelSeat = "host" | "guest";

export interface BoxDuelOutcome {
  /** The print both boxes were settled on. */
  settlePrice: number;
  /** Fraction of its own maximum each box captured, 0…1. */
  hostScore: number;
  guestScore: number;
  /**
   * The seat that takes the pot, or `null` when the duel cannot be scored at
   * all — a pick that did not decode, or a box on an underlying with no condor
   * market. `null` must never be turned into a payout: paying the wrong player
   * is worse than not paying, and `GameStake` has no refund to undo it with.
   */
  winner: DuelSeat | null;
  /** True when the two scores were exactly equal and the tiebreak decided it. */
  tied: boolean;
  /** One line, for the screen. Always populated, including for `null`. */
  reason: string;
}

/** Why a single box could not be scored, or `null` if it can. */
function unscoreable(box: Box | null, seat: DuelSeat): string | null {
  if (!box) return `The ${seat}'s pick did not decode as a box, so it cannot be scored.`;
  try {
    boxToCondor(box);
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `The ${seat}'s box cannot be settled: ${detail}`;
  }
}

/**
 * The print a duel of `durationMinutes` settles on.
 *
 * `src/data/modes.ts` owns this mapping for the seeded flow through
 * `ModeSpec.settleAt`; the arena carries raw minutes instead, so the same idea
 * is expressed directly: the whole tape is the longest duel, and a shorter one
 * settles proportionally earlier. A random walk over fewer steps genuinely
 * moves less, which is the property that makes a short room tighter without any
 * new parameter reaching `series`.
 *
 * Clamped into the tape rather than trusted: `durationMinutes` arrives from a
 * request body, and an out-of-range index would read `undefined` as a price.
 */
export function settleIndexFor(durationMinutes: number, longestMinutes = 60): number {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return TAPE_LEN - 1;
  const share = Math.min(1, durationMinutes / longestMinutes);
  const index = Math.round(share * (TAPE_LEN - 1));
  return Math.max(1, Math.min(TAPE_LEN - 1, index));
}

/** What fraction of its own maximum this box captured at `price`. */
export function captureOf(box: Box, price: number): number {
  const spec = boxToCondor(box);
  const max = wingUsd(spec);
  if (!Number.isFinite(max) || max <= 0) return 0;
  const paid = condorPayoff(spec, price);
  if (!Number.isFinite(paid) || paid <= 0) return 0;
  return Math.min(1, paid / max);
}

/**
 * Settle a box duel.
 *
 * Both boxes are scored on the tape of the box's OWN underlying at the same
 * seed and the same print. Normally they are the same ticker — the room deals
 * one asset off its seed — but the reveal already handles the case where they
 * differ, and scoring each on its own tape is the only reading that is fair
 * when they do: each player is judged against the market they drew on.
 */
export function scoreBoxDuel(input: {
  host: Box | null;
  guest: Box | null;
  seed: number;
  /** Index into the 200-print tape. Use {@link settleIndexFor}. */
  settleAt: number;
}): BoxDuelOutcome {
  const { host, guest, seed, settleAt } = input;

  const blocked = unscoreable(host, "host") ?? unscoreable(guest, "guest");
  if (blocked || !host || !guest) {
    return {
      settlePrice: 0,
      hostScore: 0,
      guestScore: 0,
      winner: null,
      tied: false,
      reason: blocked ?? "Both picks are needed before the duel can be scored.",
    };
  }

  const index = Math.max(0, Math.min(TAPE_LEN - 1, Math.trunc(settleAt)));
  const priceOf = (box: Box): number => series(box.underlying, seed)[index] ?? 0;

  const hostPrice = priceOf(host);
  const guestPrice = priceOf(guest);
  const hostScore = captureOf(host, hostPrice);
  const guestScore = captureOf(guest, guestPrice);

  const tied = hostScore === guestScore;
  // The tiebreak is the host, and it is deliberate rather than incidental.
  // `GameStake` has no refund: a duel that names nobody is a pot that nobody can
  // ever take out. A fixed, stated rule that both clients compute identically is
  // worth more here than an elegant one that can deadlock.
  const winner: DuelSeat = tied ? "host" : hostScore > guestScore ? "host" : "guest";

  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const reason = tied
    ? `Both boxes captured ${pct(hostScore)} of their maximum. A dead tie goes to the host.`
    : `${winner === "host" ? "Host" : "Guest"} captured ${pct(Math.max(hostScore, guestScore))} of their box against ${pct(Math.min(hostScore, guestScore))}.`;

  return {
    settlePrice: winner === "host" ? hostPrice : guestPrice,
    hostScore,
    guestScore,
    winner,
    tied,
    reason,
  };
}

/** The band a box covers, for the screen. Never throws. */
export function bandOf(box: Box | null): { lo: number; hi: number } | null {
  if (!box) return null;
  try {
    const [, s2, s3] = condorStrikeNumbers(boxToCondor(box));
    return { lo: s2, hi: s3 };
  } catch {
    return null;
  }
}
