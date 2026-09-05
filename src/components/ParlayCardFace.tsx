import type { ReactNode } from "react";
import { chancePct, REFERENCE_MOVE, type Stance } from "../engine/parlay.ts";
import { fmtPx } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import {
  CARD_CONTRACT,
  quantitiesAt,
  type CardDetail,
  type CardQuantity,
} from "../state/detail.ts";
import { C, MONO } from "../theme.ts";

/**
 * The face of one parlay card — plan 6 §E3, rendered.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE FACE IS THE CONTRACT, NOT A BRANCH ON THE LEVEL
 * ────────────────────────────────────────────────────────────────────────────
 * There is no `switch (level)` anywhere below and there must never be one. What
 * appears, and in what order, is `quantitiesAt(level)` — the contract's own
 * answer, filtered out of `CARD_FACE_ORDER`. This component's only job is to
 * turn each quantity the contract hands it into pixels.
 *
 * That is what makes §A7 structural rather than stylistic: `maxLoss` sits above
 * `payout` in `CARD_FACE_ORDER`, so it sits above it on screen at SIMPLE,
 * STANDARD and FULL alike, and no amount of later JSX editing can reorder them
 * without editing the contract that a test already pins. The type sizes obey the
 * same clause — `FACE_TYPE.maxLoss` is never smaller than `FACE_TYPE.payout`,
 * asserted rather than commented.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE QUANTITY, ONE TERM (§E4.1)
 * ────────────────────────────────────────────────────────────────────────────
 * Every word on this face comes from `CARD_CONTRACT`. `delta` is the case that
 * proves it: STANDARD prints `70% chance` and FULL prints `Δ 0.70`, and this
 * file decides which by asking the *contract* whether the level's face carries
 * the glyph — not by testing the level. The number is the same number and the
 * word for it is "delta" at both, which is why FULL is a reveal rather than a
 * new thing to learn.
 *
 * `faceText` is exported so a test can feed it the contract's own example
 * numbers and assert the string it produces IS `CARD_CONTRACT[q].face[level]`,
 * character for character. Two quantities cannot be checked that way and both
 * are documented at their case below: `direction` (this app's one word for it is
 * BULL/BEAR, everywhere, not the contract table's illustrative `LONG / SHORT`)
 * and `payoffCurve` (a drawing, not a string).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A DASH MEANS
 * ────────────────────────────────────────────────────────────────────────────
 * A card with no live premium behind it prints `MAX LOSS —`, not an invented
 * dollar figure. Same for breakeven, the curve, θ and IV: where the book does
 * not carry the number, the face says so. A made-up figure beside a real one is
 * worse than a dash, and the dash is also the tell that this card came off the
 * seeded tape rather than the venue.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT A `×` MEANS — one glyph, one question
 * ────────────────────────────────────────────────────────────────────────────
 * A board deals up to five tickers and only two of them have an options book,
 * so a live face and a seeded face are always on screen together. `×` on either
 * of them is `1 / prob`: fair odds that this leg lands. It is the seeded card's
 * headline (`×6.67`) and it is what the ticker header and the slip print for
 * every leg, live or not.
 *
 * The other multiple a live card knows — `calculatePayout ÷ premium` at the
 * reference move, which for a cheap far-OTM option runs into the hundreds — is
 * a different question and never wears the `×`. It appears here as
 * {@link FaceValues.winAt}, in dollars, on the line under `MAX LOSS`, with the
 * move it is read at printed beside it. Both figures keep their true magnitude;
 * only the glyph is exclusive.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Values
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the face can print, in one bag. `null` is "the book does not
 *  carry this", which is a first-class answer and renders as a dash. */
export interface FaceValues {
  stance: Stance;
  /** The line this card bets on, on the same scale as `spot`. */
  strike: number;
  /** The reference price the strike is read against. */
  spot: number;
  /** `|delta|` — the chance it lands, and the greek. One quantity. */
  prob: number;
  /**
   * **Fair odds on `prob`** — `1 / prob`, on both paths. The `×` figure, and
   * the only quantity on this face that is comparable card-to-card across a
   * board where some tickers are live and some are seeded.
   *
   * It is NOT the payout multiple. See {@link FaceValues.winAt}.
   */
  mult: number;
  /** What a buyer pays per contract. **This is also the max loss.** `null`
   *  where no live quote backs the card. */
  premium: number | null;
  /**
   * What one contract pays, in dollars, if the underlying finishes at the
   * reference move — `premium × LiveCard.payoutMult`, so the protocol's own
   * payout arithmetic is what produced it. `null` on a seeded card, where
   * nothing was bought and there is no premium to turn into anything.
   *
   * ## Why this is a field and not `premium × mult`
   *
   * It used to be exactly that, and that is what put `×430.75` on a live card
   * beside `×6.67` on the seeded card in the next ticker's grid — two answers
   * to two different questions wearing one glyph, the larger of which looked
   * sixty-five times better and was not. The two quantities are now separate
   * fields because they are separate quantities: `mult` is how likely, `winAt`
   * is how much. The face prints the second in dollars, under the max loss it
   * is measured against and beside the move it is read at, and never divides
   * one by the other in front of the player.
   *
   * `premium !== null` implies `winAt !== null`: both come off the dealt card
   * or neither does. Optional in the type for the same reason `theta` and `iv`
   * are — a caller that has nothing to say about it should not have to say
   * `null` — and a premium with no win figure behind it prints `WIN —` rather
   * than a fabricated `WIN $0`.
   */
  winAt?: number | null;
  /** `θ` per day. Nothing in the feed carries it yet — see the report. */
  theta?: number | null;
  /** IV as a fraction (`0.58`). Not on `OptionQuote` yet — see the report. */
  iv?: number | null;
}

/** The one dash, U+2014. */
export const DASH = "—";

/**
 * Type sizes, exported because §A7's second clause is about size and a clause
 * about size that lives only in a style string is a clause that erodes.
 *
 * `maxLoss` is never smaller than `payout`. They are equal here: the downside
 * gets the same weight as the upside, is read first, and neither is the fine
 * print of the other.
 */
export const FACE_TYPE = {
  maxLoss: 17,
  payout: 17,
  /** Every other quantity on the face. */
  detail: 10,
  /** The note that rides beside a figure — never a quantity of its own. */
  aside: 8.5,
} as const;

/** Half a percent either side of spot is ATM; a strike that close is not
 *  meaningfully in or out of the money and traders do not call it either. */
export const ATM_BAND = 0.005;

/** `$4,200`. The app's own price formatter, so a strike prints here exactly as
 *  it prints on the ticker header. */
const price = (n: number): string => fmtPx(n);

/** `$40`, `$0.4200`. `fmtPx` with the cents dropped when they are `.00`, so a
 *  whole-dollar premium does not wear two zeros it did not earn. */
const usd = (n: number): string => `$${fmtPx(n).replace(/\.00$/, "")}`;

/** §E5's three words, and never the textbook noun for them. */
export function itmOtmAt(stance: Stance, strike: number, spot: number): string {
  if (!(spot > 0) || !Number.isFinite(strike)) return DASH;
  const gap = (strike - spot) / spot;
  if (Math.abs(gap) < ATM_BAND) return "ATM";
  // A long call is in the money below its strike; a long put, above it.
  return (stance === "bull" ? gap < 0 : gap > 0) ? "ITM" : "OTM";
}

/** Where the position turns a profit: the strike, moved by the premium paid in
 *  the direction the buyer needs. */
export function breakevenAt(stance: Stance, strike: number, premium: number): number {
  return stance === "bull" ? strike + premium : strike - premium;
}

/** What the face prints for one quantity at one level, and the small note that
 *  rides beside it. `null` means "not a text row" — `payoffCurve` alone. */
export interface FaceLine {
  value: string;
  aside: string | null;
}

/** The glyph the contract prints for delta at its densest level. */
const DELTA_GLYPH = "Δ";

export function faceText(
  q: CardQuantity,
  level: CardDetail,
  v: FaceValues,
): FaceLine | null {
  switch (q) {
    case "direction":
      // The one quantity whose rendering is NOT the contract table's example
      // string. This app says BULL/BEAR — on the tier label (`SAFE · BULLISH`),
      // in `slipLabel`, on the result screen. Printing `LONG` here would be a
      // second word for a quantity that already has one, which is the exact
      // thing §E4.1 forbids. Every card is a bought option, so the direction of
      // the view is the only thing left to say.
      return { value: v.stance === "bull" ? "↑ BULL" : "↓ BEAR", aside: null };

    case "maxLoss":
      // §A7. Above the payout at every level, never behind a tooltip, never
      // smaller than the upside figure — see `FACE_TYPE`.
      return v.premium === null
        ? { value: `MAX LOSS ${DASH}`, aside: "no live premium" }
        : { value: `MAX LOSS ${usd(v.premium)}`, aside: "premium paid" };

    case "payout":
      // With a premium the upside is a dollar figure, which is what the max loss
      // above it is denominated in and therefore the only comparison worth
      // offering. Without one there is no dollar payout to state, and the
      // multiple is the whole of what the seeded card knows.
      //
      // The aside used to be `×430.75` — the dollar figure divided by the
      // premium — and that was the one number on this screen a player could
      // misread catastrophically: the seeded DEGEN card in the next ticker's
      // grid prints fair odds on DEGEN's band midpoint (`×13.33` on the current
      // ladder, `×6.67` on the one before the re-cut), and the two are not the
      // same kind of thing. So the live card's aside now states
      // the BASIS instead of a ratio: this is what the premium above becomes
      // if the underlying finishes the reference move away. Nothing is
      // clamped — `winAt` carries the payout multiple at full magnitude, in
      // the unit it is actually denominated in.
      if (v.premium === null) return { value: `×${v.mult.toFixed(2)}`, aside: null };
      return {
        value:
          v.winAt === null || v.winAt === undefined
            ? `WIN ${DASH}`
            : `WIN ${usd(v.winAt)}`,
        aside: `payout at ±${Math.round(REFERENCE_MOVE * 100)}%`,
      };

    case "strike":
      return { value: `$${price(v.strike)} strike`, aside: null };

    case "delta": {
      // §E4.1, and the contract — not the level — picks the rendering.
      const glyph = (CARD_CONTRACT.delta.face[level] ?? "").includes(DELTA_GLYPH);
      return {
        value: glyph ? `${DELTA_GLYPH} ${v.prob.toFixed(2)}` : `${chancePct(v.prob)} chance`,
        aside: null,
      };
    }

    case "itmOtm":
      return { value: itmOtmAt(v.stance, v.strike, v.spot), aside: null };

    case "breakeven":
      return v.premium === null
        ? { value: `B/E ${DASH}`, aside: null }
        : { value: `B/E $${price(breakevenAt(v.stance, v.strike, v.premium))}`, aside: null };

    case "payoffCurve":
      // Drawn, not written. `FaceCurve` below.
      return null;

    case "theta":
      return {
        value:
          v.theta === null || v.theta === undefined
            ? `θ ${DASH}`
            : `θ ${v.theta < 0 ? "−" : ""}${Math.abs(v.theta).toFixed(1)}`,
        aside: null,
      };

    case "iv":
      return {
        value:
          v.iv === null || v.iv === undefined ? `IV ${DASH}` : `IV ${Math.round(v.iv * 100)}%`,
        aside: null,
      };

    case "premium":
      // The same number as `maxLoss`, said the other way round — which is the
      // lesson: your max loss IS the premium, and FULL is where the card stops
      // implying it and names it.
      return {
        value: v.premium === null ? `${DASH} premium` : `${usd(v.premium)} premium`,
        aside: null,
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The rows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three quantities that share one line, in the order the contract states
 * them: `Δ 0.70 · θ −0.4 · IV 58%`.
 *
 * They are three quantities so the contract can name them separately, and one
 * strip because that is how a desk reads them. `CARD_FACE_ORDER` does not place
 * them adjacently, so the strip takes the slot of its FIRST present member —
 * delta's — and the later members leave their own slots empty. Delta therefore
 * stays exactly where the contract put it, directly under the strike, and θ/IV
 * arrive beside it rather than three lines further down.
 */
export const GREEK_STRIP: readonly CardQuantity[] = ["delta", "theta", "iv"];

/**
 * The face, as rows, top to bottom. Each row is one quantity — except the
 * greeks strip, which is up to three.
 *
 * Derived from `quantitiesAt(level)` and nothing else, which is what makes
 * "max loss above the payout" true of the rendered DOM and not merely of the
 * table it came from.
 */
export function faceRows(level: CardDetail): readonly (readonly CardQuantity[])[] {
  const shown = quantitiesAt(level);
  const strip = GREEK_STRIP.filter((q) => shown.includes(q));
  const out: (readonly CardQuantity[])[] = [];
  for (const q of shown) {
    if (!strip.includes(q)) {
      out.push([q]);
      continue;
    }
    if (q === strip[0]) out.push(strip);
  }
  return out;
}

/** The order the rendered `[data-q]` elements appear in. */
export const faceOrder = (level: CardDetail): readonly CardQuantity[] =>
  faceRows(level).flat();

// ─────────────────────────────────────────────────────────────────────────────
// The curve
// ─────────────────────────────────────────────────────────────────────────────

/** The curve is drawn over ±25% of spot — the same band the venue publishes
 *  strikes in, so nothing is extrapolated past the book's own data. */
export const CURVE_BAND = 0.25;

const payoffAt = (v: FaceValues, s: number, premium: number): number =>
  Math.max(0, v.stance === "bull" ? s - v.strike : v.strike - s) - premium;

/**
 * A long option's payoff at expiry: flat at minus the premium until the strike,
 * then a straight line away from it. Small, unlabelled, and drawn only when a
 * premium exists — without one the vertical offset would be invented, and an
 * invented curve is a curve that shows no loss region at all.
 *
 * Drawn on the true vertical scale, which on most cards means the loss band is
 * a thin sliver under a long climb — that *is* the shape of a bought option and
 * flattering it would be the lie. So the sliver is coloured instead: everything
 * below zero is red, everything above is the tier's accent, and the dashed line
 * between them is where the premium is paid back. The break is the breakeven,
 * printed as a figure two lines above.
 */
function FaceCurve({ v, accent }: { v: FaceValues; accent: string }) {
  const premium = v.premium;
  if (premium === null || !(premium > 0) || !(v.spot > 0)) return null;
  const lo = v.spot * (1 - CURVE_BAND);
  const hi = v.spot * (1 + CURVE_BAND);
  if (!(hi > lo)) return null;

  const be = breakevenAt(v.stance, v.strike, premium);
  const inside = (s: number) => s > lo && s < hi;
  const xs = [lo, ...[v.strike, be].filter(inside).sort((a, b) => a - b), hi];
  // The breakeven IS the zero crossing by construction, so it is snapped to
  // exactly zero rather than left to float error — a vertex that comes back as
  // −7e-15 belongs to neither run, and the winning half of the curve vanishes.
  const ys = xs.map((s) => (s === be ? 0 : payoffAt(v, s, premium)));
  const top = Math.max(premium, ...ys);
  const bottom = -premium;
  const span = top - bottom;

  const X = (s: number) => ((s - lo) / (hi - lo)) * 100;
  const Y = (y: number) => 27 - ((y - bottom) / span) * 24;
  const at = (i: number) => `${X(xs[i]!).toFixed(1)},${Y(ys[i]!).toFixed(1)}`;
  // The payoff crosses zero at most once, at the breakeven, so a sign filter
  // splits it into exactly two runs and the crossing vertex belongs to both.
  const below = xs.map((_, i) => i).filter((i) => ys[i]! <= 0);
  const above = xs.map((_, i) => i).filter((i) => ys[i]! >= 0);
  const zero = Y(0);

  return (
    <svg
      viewBox="0 0 100 30"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={sx("display:block;width:100%;height:30px")}
    >
      <line x1="0" y1={zero} x2="100" y2={zero} stroke={C.line} strokeWidth="1" strokeDasharray="3 3" />
      {below.length > 1 && (
        <polyline
          points={below.map(at).join(" ")}
          fill="none"
          stroke={C.red}
          strokeWidth="1.6"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {above.length > 1 && (
        <polyline
          points={above.map(at).join(" ")}
          fill="none"
          stroke={accent}
          strokeWidth="1.6"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {inside(be) && (
        <line x1={X(be)} y1="2" x2={X(be)} y2="28" stroke={C.faint} strokeWidth="1" strokeDasharray="2 3" />
      )}
    </svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The face
// ─────────────────────────────────────────────────────────────────────────────

export interface ParlayCardFaceProps {
  level: CardDetail;
  values: FaceValues;
  /** The tier's accent — the payout figure and the curve wear it. */
  accent: string;
  /** Rendered on the left of the `direction` row: the tier tag, so the card's
   *  first line still reads `SAFE   ↑ BULL` exactly as it always has. */
  lead?: ReactNode;
  /** `ETH:safe-bull` — suffixes the stable test ids this face keeps. */
  testKey: string;
}

const ROW = "display:flex;align-items:baseline;justify-content:space-between;gap:6px";

export function ParlayCardFace({ level, values, accent, lead, testKey }: ParlayCardFaceProps) {
  const rows = faceRows(level);
  return (
    <div style={sx("display:flex;flex-direction:column;gap:5px;margin-top:2px")}>
      {rows.map((row) => {
        const key = row.join("-");

        // The greeks strip: one line, the contract's order, each member still
        // its own quantity in the DOM.
        if (GREEK_STRIP.includes(row[0]!)) {
          return (
            <div key={key} style={sx(`display:flex;align-items:baseline;gap:5px;flex-wrap:wrap`)}>
              {row.map((q, i) => {
                const line = faceText(q, level, values);
                if (!line) return null;
                return (
                  <span key={q} style={sx("display:inline-flex;align-items:baseline;gap:5px")}>
                    {i > 0 && <span style={sx(`font:400 ${FACE_TYPE.detail}px/1.3 ${MONO};color:${C.faint}`)}>·</span>}
                    <span
                      data-q={q}
                      style={sx(
                        `font:400 ${FACE_TYPE.detail}px/1.3 ${MONO};color:${dim(q, values) ? C.faint : C.muted}`,
                      )}
                    >
                      {line.value}
                    </span>
                  </span>
                );
              })}
            </div>
          );
        }

        const q = row[0]!;

        if (q === "payoffCurve") {
          const drawn = values.premium !== null && values.premium > 0;
          return (
            <div key={key} data-testid={`payoff-curve-${testKey}`}>
              {drawn ? (
                <span data-q={q} style={sx("display:block")}>
                  <FaceCurve v={values} accent={accent} />
                </span>
              ) : (
                <span
                  data-q={q}
                  style={sx(`font:400 ${FACE_TYPE.detail}px/1.3 ${MONO};color:${C.faint}`)}
                >
                  payoff curve {DASH}
                </span>
              )}
            </div>
          );
        }

        const line = faceText(q, level, values)!;

        if (q === "direction") {
          return (
            <div key={key} style={sx(ROW)}>
              {lead ?? <span />}
              <span
                data-q={q}
                style={sx(
                  `font:700 9.5px/1 ${MONO};letter-spacing:.08em;` +
                    `color:${values.stance === "bull" ? C.green : C.red}`,
                )}
              >
                {line.value}
              </span>
            </div>
          );
        }

        if (q === "maxLoss" || q === "payout") {
          // The two figures §A7 is about. Same type size, downside first, and
          // the size relationship is `FACE_TYPE`'s to state, not this string's.
          const size = q === "maxLoss" ? FACE_TYPE.maxLoss : FACE_TYPE.payout;
          const color =
            q === "maxLoss" ? (values.premium === null ? C.dim : C.text) : accent;
          return (
            <div
              key={key}
              data-testid={q === "maxLoss" ? `max-loss-${testKey}` : `payout-${testKey}`}
              style={sx(ROW)}
            >
              <span
                data-q={q}
                style={sx(`font:700 ${size}px/1.1 ${MONO};letter-spacing:-.02em;color:${color}`)}
              >
                {line.value}
              </span>
              {line.aside && (
                <span style={sx(`font:400 ${FACE_TYPE.aside}px/1.2 ${MONO};color:${C.faint};text-align:right`)}>
                  {line.aside}
                </span>
              )}
            </div>
          );
        }

        return (
          <div key={key} style={sx(ROW)}>
            <span
              data-q={q}
              style={sx(
                `font:400 ${FACE_TYPE.detail}px/1.3 ${MONO};color:${dim(q, values) ? C.faint : C.muted}`,
              )}
            >
              {line.value}
            </span>
            {line.aside && (
              <span style={sx(`font:400 ${FACE_TYPE.aside}px/1.2 ${MONO};color:${C.faint}`)}>
                {line.aside}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** A quantity the book cannot supply is drawn back, so the eye reads the dash
 *  as an absence rather than as a value. */
function dim(q: CardQuantity, v: FaceValues): boolean {
  if (q === "theta") return v.theta === null || v.theta === undefined;
  if (q === "iv") return v.iv === null || v.iv === undefined;
  if (q === "breakeven" || q === "premium") return v.premium === null;
  return false;
}
