import type { ReactNode } from "react";
import { hash } from "../lib/hash.ts";
import { sx } from "../lib/sx.ts";
// `MONO` only — a bare font-stack constant, not `tag()`/`miniTag()`. Reading it
// is what keeps this chip's type identical to every other chip in the app while
// the two chip FUNCTIONS are being rewritten elsewhere this wave.
import { MONO } from "../theme.ts";

/**
 * A lobby card's label chip, as a small piece of polished metal.
 *
 * This is the chrome material from the rejected background ornament, moved to
 * where the owner actually wanted it: "the chrome capture thing only on the
 * labeling". Same four rules the watch-clip reference taught, at a twentieth
 * the size:
 *
 *   1. **The body is nearly black.** `theme.ts`'s `tag()` fills a chip with
 *      `${color}1f` — a 12% wash of its own colour, which is what makes a chip
 *      read as a flat plastic pill. Here the fill is `rgba(3,4,7,.9)` with a
 *      single 8% breath of the colour along the top edge. It sits barely above
 *      the card ground, which is the whole point, and it BUYS contrast rather
 *      than spending it: the label is unchanged in colour and now sits on
 *      near-black instead of on a tint of itself.
 *   2. **The shape is carried by the rim, not by a fill.** A 1px border painted
 *      with a gradient — `background-clip: padding-box, border-box` on a
 *      transparent border, which is the only way to get a gradient stroke that
 *      follows a 5–6px corner radius at any chip width. The gradient is the
 *      chip's own colour at 10–30% almost everywhere, with ONE short ice-white
 *      arc across the top-left corner where the light would catch it.
 *   3. **One narrow feathered specular travels the chip.** Zero at both ends,
 *      over 0.15 alpha across only its middle fifth, peaking at 0.44, and
 *      confined to the top third the way a bevel highlight is — the label sits
 *      under the other two thirds and never loses contrast to it. It crosses
 *      in about a third of its loop and is off the chip for the rest, so it is
 *      a glint and not a strobe.
 *   4. **The specular core is ice, never the chip's colour.** `#f0f9ff` on the
 *      lime chip and on the blue one alike — a coloured highlight reads as
 *      tinted plastic, a near-white one reads as metal. The colour lives in the
 *      rim and in the body's top breath, so CRYPTO is still lime and STOCKS is
 *      still blue at a glance.
 *
 * The metrics (font, letter-spacing, padding, radius) are copied from
 * `theme.ts`'s `tag()` / `miniTag()` verbatim, so swapping a chip for this one
 * moves nothing on the card. They are copied and not imported because `tag()`
 * and `miniTag()` are used by a dozen views and are being edited elsewhere this
 * wave; duplicating two style strings is much cheaper than coordinating a
 * change to a function the whole app renders through. If the two ever need to
 * agree again, this is the file that follows.
 *
 * Only the lobby board calls this. Every other view's chips are untouched.
 */

/** Ice, in three steps — the same constants the ornament used, for the same
 *  reason: the light in the reference clip is one colour on every object. */
const ICE_CORE = "#f0f9ff";
const ICE = "#7dd3fc";
const ICE_DEEP = "#38bdf8";

/** The specular's box. `preserveAspectRatio="none"` stretches this to whatever
 *  width the label happens to be — which is fine and in fact wanted, because
 *  everything inside it is a soft horizontal gradient, so "a fifth of the chip"
 *  stays a fifth of the chip on a 40px `2L` and on a 96px `ALL STOCKS`. The rim
 *  is NOT in here: a stretched rounded corner is instantly visible, which is
 *  why the rim is a CSS gradient border instead. */
const VB_W = 100;
const VB_H = 20;
/** How much of the chip the smear covers. */
const SHEEN_W = 26;
/** It starts and ends well clear of the chip, so the visible crossing is about
 *  a third of the loop and the chip is dark metal for the other two thirds. */
const FROM = -140;
const TO = 240;
const DUR = 6.4;

type Size = "tag" | "mini";

/** `theme.ts` `tag()` and `miniTag()`, minus their border and background —
 *  those two are what this component replaces. Kept character-for-character
 *  otherwise so a chip does not move a pixel when it turns to metal. */
const METRICS: Record<Size, string> = {
  tag: `font:500 9px/1 ${MONO};letter-spacing:.12em;padding:6px 8px;border-radius:6px`,
  mini: `font:700 8.5px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:5px`,
};

/** The inner radius, one pixel in from the border box, for the clip the sheen
 *  runs inside. Hard-coded rather than `inherit`, because `border-radius:inherit`
 *  on a child of a bordered box gives the OUTER radius and bleeds the highlight
 *  over the rim at the corners. */
const INNER_R: Record<Size, string> = { tag: "5px", mini: "4px" };

/** The reduced-motion probe, in the shape the rest of the app uses. CSS cannot
 *  still SMIL, so the stylesheet's reduced-motion block is no help here: the
 *  probe decides whether the `<animateTransform>` ships at all. */
function stillMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

export function ChromeTag({
  children,
  color,
  uid,
  size = "tag",
  title,
  extra,
}: {
  children: ReactNode;
  /** The chip's identity colour: it tints the rim and the body's top breath,
   *  and it colours the label. It never touches the specular. */
  color: string;
  /** Unique and STABLE per chip on the board — `${lobby.id}-${chip.key}`. It
   *  keys the gradient ids (two chips sharing an id would share one gradient)
   *  and seeds the glint's offset. Not `useId()`: React's counter is
   *  module-global and climbs across roots, so the same card mounted twice
   *  would emit different ids and break "same lobby, same markup". */
  uid: string;
  size?: Size;
  title?: string;
  /** Appended verbatim — the board uses it for BLITZ's pulse, which is a
   *  `styles.css` keyframe this component has no business knowing about. */
  extra?: string;
}) {
  const id = `ct-${uid.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  const still = stillMotion();
  // Scattered so the five chips on a card never glint together, and stable so
  // the same lobby renders the same markup every time.
  const begin = -((hash(uid) % 640) / 100);

  return (
    <span
      title={title}
      data-chip={uid}
      style={sx(
        `${METRICS[size]};display:inline-flex;align-items:center;position:relative;flex:none;white-space:nowrap;` +
          // The gradient rim. Two backgrounds on one box: the body clipped to
          // the padding box, the rim clipped to the border box, with the border
          // itself transparent so the second gradient is all you see of it.
          `border:1px solid transparent;` +
          `background:linear-gradient(180deg,${color}14 0%,rgba(3,4,7,.90) 46%,rgba(2,3,5,.94) 100%) padding-box,` +
          `linear-gradient(146deg,${color}1f 0%,${ICE_CORE}8c 11%,${color}4d 20%,${color}1a 58%,${ICE_DEEP}1f 100%) border-box;` +
          `color:${color}` +
          (extra ?? ""),
      )}
    >
      {/* Decoration only: never in the accessibility tree, never in the way of
          the hover tooltip the sector chips carry. */}
      <span
        aria-hidden
        style={sx(
          `position:absolute;inset:0;border-radius:${INNER_R[size]};overflow:hidden;pointer-events:none`,
        )}
      >
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="none"
          style={sx("position:absolute;inset:0;width:100%;height:100%;display:block")}
        >
          <defs>
            {/* Zero at both ends, over 0.2 only across the middle fifth. The
                feather is what separates a reflection from a strip of tape —
                the same lesson the background ornament was rejected over. */}
            <linearGradient id={`${id}-sheen`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={ICE} stopOpacity="0" />
              <stop offset="30%" stopColor={ICE} stopOpacity="0.04" />
              <stop offset="44%" stopColor="#e0f2fe" stopOpacity="0.15" />
              <stop offset="50%" stopColor={ICE_CORE} stopOpacity="0.44" />
              <stop offset="56%" stopColor="#e0f2fe" stopOpacity="0.13" />
              <stop offset="70%" stopColor={ICE_DEEP} stopOpacity="0.03" />
              <stop offset="100%" stopColor={ICE_DEEP} stopOpacity="0" />
            </linearGradient>
          </defs>
          {/* Parked two thirds across when motion is off, so the still frame is
              the lit one rather than an empty chip. */}
          <g transform={still ? "translate(65 0)" : undefined}>
            {still ? null : (
              <animateTransform
                attributeName="transform"
                type="translate"
                values={`${FROM} 0;${TO} 0`}
                dur={`${DUR}s`}
                begin={`${begin.toFixed(2)}s`}
                repeatCount="indefinite"
              />
            )}
            {/* A dim full-height halo carrying the soft shoulders, and a bright
                core in the upper band where a bevel would catch the light. Two
                rects and one gradient: a two-stop blur with no filter. */}
            <rect x={-SHEEN_W} y="0" width={SHEEN_W} height={VB_H} opacity="0.28" fill={`url(#${id}-sheen)`} />
            <rect x={-SHEEN_W} y="1.2" width={SHEEN_W} height="6.4" fill={`url(#${id}-sheen)`} />
          </g>
        </svg>
      </span>
      {/* Above the shine, always. The label is the point; the metal is not. */}
      <span style={sx("position:relative")}>{children}</span>
    </span>
  );
}
