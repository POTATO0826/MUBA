import { hash } from "../lib/hash.ts";
import { sx } from "../lib/sx.ts";
import { C } from "../theme.ts";
import type { MarketFilter } from "../types.ts";

/**
 * The ornament on a lobby card: one chrome instrument, lit by a cold moving
 * light, sitting far behind the card's copy.
 *
 * The first pass of this replaced the old halftone-dot art with six chrome
 * candlesticks and was rejected on sight — "way off" — for four reasons worth
 * writing down, because every number below exists to answer one of them:
 *
 *   1. **Scale.** The capsules were 26 units wide in a 300 viewBox: a third of
 *      the card tall and thumb-wide, an ornament arguing with the headline.
 *      Bars are `BAR_W` = 11 now, on a 34-unit pitch, so two thirds of the
 *      rally's footprint is empty field. Negative space is most of the effect.
 *   2. **Material.** The old bodies were milky bands taped onto tubes: plastic.
 *      Polished metal in a dark room is almost entirely dark — you read the
 *      SHAPE from two things only, a hairline where the edge catches the sky
 *      and a narrow specular smear where the source reflects. So the body here
 *      tops out at `#0d131b` (≈5% above black), the rim is a 0.7-unit stroke
 *      whose gradient is bright over one short arc and dead everywhere else,
 *      and the travelling highlight is a bright core ~13% of the bar's length
 *      with feathered ends AND a dim halo around it — never a hard band. At
 *      any instant ~85% of every object is darkness. That is the whole trick.
 *   3. **Colour.** The old metal took the market colour, so the CRYPTO cards
 *      rendered lime-washed, which is exactly how you say "plastic". The light
 *      is ice — `#f0f9ff` core, `#7dd3fc`/`#38bdf8` falloff — on every card,
 *      no exceptions. The card's own accent survives in precisely one place:
 *      the ambient pool, at 0.055 alpha, where it tints the FIELD rather than
 *      the metal. Identity without the chrome going green.
 *   4. **The fast thing.** A watch film has exactly one: the second hand. Here
 *      it is a 1.3-unit polished line with a white core and a blue bloom,
 *      sliding along the composition's own axis on a 9.2s loop, and each bar's
 *      rim brightens as it goes by (`rimPhase` below — the sync is an
 *      approximation by keyframe offset, not a real intersection test, which
 *      at this speed and alpha nobody can tell from the real thing).
 *
 * Two instruments, not one, because the owner asked the board not to draw the
 * same picture six times: CRYPTO gets the candle rally, STOCK gets the tape —
 * a slender chrome line chart with node capsules — and MIXED, being neither,
 * takes whichever bit 1 of its id's hash lands on. They are not two drawings:
 * both are a list of `Bar`s and a list of `Hair`s run through the SAME loop, so
 * the gradients, the clipping, the specular clock and the rim sync are written
 * once. A segment of the tape is a candle turned onto the segment's angle by
 * `segment()`, and a node is a candle as long as it is wide. Nothing more.
 *
 * Everything is SMIL on transforms and opacity — no rAF, no per-frame React
 * state, no filters (the "bloom" and the "pool" are gradients, which cost a
 * fraction of a blur and survive being drawn six times in a grid). No CSS
 * keyframe is referenced, so `styles.css` stays untouched and two cards can
 * never fight over an animation name.
 *
 * Ids are derived from the lobby id, NOT from `useId()`. React's client-side
 * `useId` counter is module-global and keeps climbing across roots, so the same
 * card mounted twice would emit different gradient ids — and the board's
 * contract (app.test.tsx: "same lobby, same picture") is that the markup is a
 * pure function of the id. A lobby id is already unique on the board and
 * already URL-safe, so it is the better key on both counts.
 */

/** Square, so the crop is only ever vertical: the cards are ≥264px wide and
 *  exactly 300px tall, and `slice` on a square viewBox trims whichever axis is
 *  short. Everything therefore lives inside x 78–260, y 61–198: right of the
 *  host block, above the stats rule, and inside the 18-unit bite `slice` takes
 *  off each side at the board's narrowest card. */
const VB = 300;

/** The composition's axis, from the first bar's waist to the last. The streak
 *  and its pool are drawn in a frame rotated by this, so both travel ALONG the
 *  instrument instead of merely crossing it. */
const ANGLE = -24;

/** The sweep's pivot. Not the viewBox centre: a line pivoted at 150 swings its
 *  lower-left half straight through the card's stats row, and a highlight that
 *  underlines "PRIZE POOL" every nine seconds is a bug wearing a tuxedo. At 132
 *  the visible arc — the middle 64% of the travel, which is all the opacity
 *  envelope lets you see — lands between the title and the rule. */
const AXIS_Y = 132;

/** Ice, in three steps. The specular core is white-blue whatever the market:
 *  a coloured highlight reads as tinted plastic, a near-white one reads as
 *  polished steel. See point 3 in the header. */
const ICE_CORE = "#f0f9ff";
const ICE = "#7dd3fc";
const ICE_DEEP = "#38bdf8";

/** Bar width, on a 34-unit pitch — see point 1. `HAIR_W` is the wick/stem, and
 *  is sub-pixel at card scale on purpose: it is a suggestion, not a line. */
const BAR_W = 11;
const HAIR_W = 1.1;
/** The tape's stroke, and the diameter of the capsules on its vertices. */
const SEG_W = 4.6;
const NODE_W = 9;

/** How long the travelling highlight is, as a fraction of the bar, floored so a
 *  short bar still gets a readable smear. It has to come out LONGER than the
 *  bar is wide: the first tuning pass gave a 30-unit candle a 12-unit smear
 *  4 wide, whose bright core was a 1-unit dash lying ACROSS the capsule — the
 *  plastic-tape read, back again at a tenth the size. At 0.45 the core (the
 *  gradient's 40–60% plateau below) runs about 4 units along an 11-wide bar:
 *  ~13% of the bar's length, elongated the way a reflection actually is. */
const specLen = (len: number) => Math.max(20, len * 0.45);

interface Bar {
  /** Capsule centre, in viewBox units. */
  cx: number;
  cy: number;
  /** Across the capsule, and along it. The specular always falls along `len`. */
  w: number;
  len: number;
  /** Degrees about the capsule's own centre. Absent leaves it upright. */
  rot?: number;
}

/** A wick, or a stem under a tape node: drawn dim and never lit, because the
 *  moment a hairline gets its own highlight it stops reading as a hairline. */
interface Hair {
  cx: number;
  top: number;
  bot: number;
  /** Which end fades out — away from the body it hangs off. */
  fade: "up" | "dn";
}

const candle = (cx: number, top: number, bot: number): Bar => ({
  cx,
  cy: (top + bot) / 2,
  w: BAR_W,
  len: bot - top,
});

/** The rally: left-low to right-high with a pullback at bar 3, because a line
 *  that only rises reads as a bar chart rather than as a tape. */
const CANDLE_BODIES: readonly [number, number, number][] = [
  [84, 158, 188],
  [118, 136, 176],
  [152, 146, 182],
  [186, 114, 162],
  [220, 96, 142],
  [254, 72, 126],
];

const CANDLE_BARS: readonly Bar[] = CANDLE_BODIES.map(([cx, top, bot]) => candle(cx, top, bot));

const CANDLE_HAIRS: readonly Hair[] = CANDLE_BODIES.flatMap(([cx, top, bot]) => [
  { cx, top: top - 11, bot: top + 3, fade: "up" as const },
  { cx, top: bot - 3, bot: bot + 10, fade: "dn" as const },
]);

/** The tape's vertices — same story arc as the rally, so the two instruments
 *  are the same market on two instruments rather than two different markets. */
const TAPE_PTS: readonly [number, number][] = [
  [84, 178],
  [126, 154],
  [168, 166],
  [211, 124],
  [253, 88],
];

/** A segment as a capsule: drawn upright, then turned onto the segment. `atan2`
 *  measures from +x and a capsule's long axis is +y, hence the 90°. Rounded so
 *  the emitted DOM stays short — the value is a pure function of the constants
 *  above either way, which is what "same lobby, same picture" needs. */
function segment(a: readonly [number, number], b: readonly [number, number]): Bar {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return {
    cx: (a[0] + b[0]) / 2,
    cy: (a[1] + b[1]) / 2,
    w: SEG_W,
    len: Number(Math.hypot(dx, dy).toFixed(2)),
    rot: Number(((Math.atan2(dy, dx) * 180) / Math.PI + 90).toFixed(2)),
  };
}

/** Segments first, then the vertex capsules, so a node always sits ON its
 *  joint and hides the mitre the two rounded caps would otherwise show. */
const TAPE_BARS: readonly Bar[] = [
  ...TAPE_PTS.slice(0, -1).map((p, i) => segment(p, TAPE_PTS[i + 1]!)),
  ...TAPE_PTS.map(([cx, cy]) => ({ cx, cy, w: NODE_W, len: NODE_W })),
];

/** The stems: a short drop under each vertex. They ran all the way to a shared
 *  baseline at first and the tape read as hanging off wires — a fixed 16 units
 *  says "gridline tick" and then gets out of the way. */
const TAPE_STEM = 16;
const TAPE_HAIRS: readonly Hair[] = TAPE_PTS.map(([cx, cy]) => ({
  cx,
  top: cy + NODE_W / 2 - 2,
  bot: cy + NODE_W / 2 + TAPE_STEM,
  fade: "dn" as const,
}));

/** One clock per bar: how long the specular takes to fall the bar's length, and
 *  how far into that fall it already is at t=0. Nine entries because the tape
 *  has nine capsules; coprime-ish durations and scattered offsets stop them
 *  ganging up into a single pulse. */
const LIGHT: readonly { dur: number; begin: number }[] = [
  { dur: 5.6, begin: -0.4 },
  { dur: 4.8, begin: -2.1 },
  { dur: 6.2, begin: -3.4 },
  { dur: 5.2, begin: -1.2 },
  { dur: 4.4, begin: -4.0 },
  { dur: 5.0, begin: -2.7 },
  { dur: 6.6, begin: -5.1 },
  { dur: 4.6, begin: -3.9 },
  { dur: 5.8, begin: -1.7 },
];

/** The dial markers of the reference clip: slim capsules loitering in the empty
 *  upper-left, where neither instrument reaches and the card's copy is
 *  thinnest. They breathe. They do not travel. */
const TICKS: readonly { x: number; y: number; w: number; dur: number; begin: number }[] = [
  { x: 26, y: 124, w: 12, dur: 9.4, begin: -1.1 },
  { x: 48, y: 158, w: 8, dur: 11.2, begin: -5.6 },
  { x: 34, y: 96, w: 10, dur: 8.6, begin: -3.2 },
  { x: 60, y: 74, w: 7, dur: 10.4, begin: -7.3 },
];

const STREAK_DUR = 9.2;
/** Far enough out that the loop's teleport happens well off the visible field;
 *  the opacity envelope is the belt to that pair of braces. */
const STREAK_TRAVEL = 210;

/** Where along the sweep a bar sits, 0…1. Used only to offset that bar's rim
 *  flare so the flares chase the streak left to right; it is a projection onto
 *  x, not a real intersection, and at 9.2s nobody is checking. */
const rimPhase = (cx: number) => Math.min(0.94, Math.max(0.06, (cx - 64) / 204));

/** The reduced-motion probe, local to this module in the shape `RankUpSequence`
 *  and `WalletPicker` use — no view reaches into `sound/engine.ts` for it. CSS
 *  cannot still SMIL, so the stylesheet's `[data-art] *` block does not cover
 *  this ornament; the probe decides whether the `<animate>` nodes ship at all. */
function stillMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

export function ChromeRally({
  id,
  color = C.blue,
  market = "STOCK",
}: {
  id: string;
  color?: string;
  market?: MarketFilter;
}) {
  // Unique per card, stable forever: see the header on why this is not useId().
  // The `cc-` prefix is the one thing kept from the first pass — the board's
  // test reaches for `url(#cc-<lobby>-body)` and there is no reason to churn it.
  const uid = `cc-${id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  const still = stillMotion();
  const seed = hash(id);

  // CRYPTO ships the rally, STOCK the tape. MIXED is genuinely neither, so it
  // takes the id's low bit — deterministic, so a mixed lobby keeps its picture
  // for as long as it keeps its id.
  // (Bit 1, not bit 0: `rot` below leans on the hash's low bits, and a picture
  // that changed in lockstep with the light phase would read as one variable,
  // not two.)
  const piece =
    market === "CRYPTO" || (market === "MIXED" && ((seed >>> 1) & 1) === 0) ? "candles" : "tape";
  const bars = piece === "candles" ? CANDLE_BARS : TAPE_BARS;
  const hairs = piece === "candles" ? CANDLE_HAIRS : TAPE_HAIRS;
  // The only other per-card variation: which capsule is furthest through its
  // fall. The drawing is identical on every card of a theme — the light is not.
  const rot = seed % LIGHT.length;

  return (
    <div
      data-art={id}
      data-pattern="chrome-rally"
      data-object={piece}
      aria-hidden
      style={sx("position:absolute;inset:0;overflow:hidden;pointer-events:none")}
    >
      <svg
        viewBox={`0 0 ${VB} ${VB}`}
        preserveAspectRatio="xMidYMid slice"
        style={sx("position:absolute;inset:0;width:100%;height:100%;display:block")}
      >
        <defs>
          {/* The body. A cylinder that is barely there: two faint shoulders at
              #0d131b — five percent above black — with true black between and
              at both edges. Everything you actually SEE of a bar is drawn by
              the two defs below this one. */}
          <linearGradient id={`${uid}-body`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#020305" />
            <stop offset="17%" stopColor="#0d131b" />
            <stop offset="42%" stopColor="#03050a" />
            <stop offset="74%" stopColor="#090e15" />
            <stop offset="100%" stopColor="#020305" />
          </linearGradient>

          {/* The rim: a hairline all round the capsule whose gradient is alive
              over one short arc (30–40% of the way down) and effectively dead
              elsewhere. This is what makes a black shape legible as a shape. */}
          <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ICE_DEEP} stopOpacity="0.04" />
            <stop offset="22%" stopColor={ICE} stopOpacity="0.12" />
            <stop offset="33%" stopColor={ICE_CORE} stopOpacity="0.88" />
            <stop offset="44%" stopColor={ICE} stopOpacity="0.16" />
            <stop offset="66%" stopColor={ICE_DEEP} stopOpacity="0.05" />
            <stop offset="100%" stopColor={ICE_DEEP} stopOpacity="0.03" />
          </linearGradient>

          {/* The lit edge: the sub-pixel line down ONE side of the capsule,
              bright lower than the rim's arc so the two do not stack into a
              single bright blob. */}
          <linearGradient id={`${uid}-edge`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ICE} stopOpacity="0" />
            <stop offset="38%" stopColor={ICE} stopOpacity="0.06" />
            <stop offset="56%" stopColor={ICE_CORE} stopOpacity="0.4" />
            <stop offset="70%" stopColor={ICE} stopOpacity="0.08" />
            <stop offset="100%" stopColor={ICE} stopOpacity="0" />
          </linearGradient>

          {/* The travelling specular. Zero at both ends, over 0.25 across only
              its middle fifth: a narrow core with long feathers is the
              difference between a reflection and a strip of tape. */}
          <linearGradient id={`${uid}-spec`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ICE} stopOpacity="0" />
            <stop offset="16%" stopColor={ICE} stopOpacity="0.04" />
            <stop offset="34%" stopColor="#e0f2fe" stopOpacity="0.2" />
            <stop offset="40%" stopColor={ICE_CORE} stopOpacity="0.76" />
            <stop offset="60%" stopColor={ICE_CORE} stopOpacity="0.76" />
            <stop offset="66%" stopColor="#e0f2fe" stopOpacity="0.18" />
            <stop offset="84%" stopColor={ICE_DEEP} stopOpacity="0.03" />
            <stop offset="100%" stopColor={ICE_DEEP} stopOpacity="0" />
          </linearGradient>

          {/* Hairlines fade AWAY from the body they hang off, so two of them. */}
          <linearGradient id={`${uid}-hairUp`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ICE} stopOpacity="0.01" />
            <stop offset="100%" stopColor={ICE} stopOpacity="0.13" />
          </linearGradient>
          <linearGradient id={`${uid}-hairDn`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ICE} stopOpacity="0.13" />
            <stop offset="100%" stopColor={ICE} stopOpacity="0.01" />
          </linearGradient>

          {/* The fast line, along its own length: white core, blue shoulders. */}
          <linearGradient id={`${uid}-streak`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={ICE_DEEP} stopOpacity="0" />
            <stop offset="36%" stopColor={ICE} stopOpacity="0.3" />
            <stop offset="50%" stopColor={ICE_CORE} stopOpacity="0.92" />
            <stop offset="64%" stopColor={ICE} stopOpacity="0.3" />
            <stop offset="100%" stopColor={ICE_DEEP} stopOpacity="0" />
          </linearGradient>

          {/* Its falloff. A wide, very faint sibling behind the line is what a
              1px blur would have cost us a filter for, at a hundredth the
              price and no per-card filter region to rasterise. */}
          <linearGradient id={`${uid}-bloom`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={ICE_DEEP} stopOpacity="0" />
            <stop offset="50%" stopColor={ICE_DEEP} stopOpacity="0.13" />
            <stop offset="100%" stopColor={ICE_DEEP} stopOpacity="0" />
          </linearGradient>

          {/* The pool — the ONLY place the market colour touches the picture,
              and it lights the room rather than the metal. A radial,
              deliberately: one blur filter × six cards in a grid is a real
              cost, and this is indistinguishable at this alpha. */}
          <radialGradient id={`${uid}-pool`}>
            <stop offset="0%" stopColor={color} stopOpacity="0.055" />
            <stop offset="52%" stopColor={color} stopOpacity="0.02" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </radialGradient>

          {bars.map((b, i) => (
            <clipPath key={i} id={`${uid}-clip${i}`}>
              <rect
                x={b.cx - b.w / 2}
                y={b.cy - b.len / 2}
                width={b.w}
                height={b.len}
                rx={b.w / 2}
              />
            </clipPath>
          ))}
        </defs>

        {/* 1 · the ambient pool, riding with the light, under everything. */}
        <g transform={`rotate(${ANGLE} ${VB / 2} ${AXIS_Y})`}>
          <g transform={still ? "translate(-10 0)" : undefined}>
            {still ? null : (
              <animateTransform
                attributeName="transform"
                type="translate"
                values={`${-STREAK_TRAVEL} 0;${STREAK_TRAVEL} 0`}
                dur={`${STREAK_DUR}s`}
                repeatCount="indefinite"
              />
            )}
            <circle cx={VB / 2} cy={AXIS_Y} r="74" fill={`url(#${uid}-pool)`} />
          </g>
        </g>

        {/* 2 · the markers. They only breathe. */}
        {TICKS.map((t) => (
          <rect
            key={`${t.x}-${t.y}`}
            x={t.x}
            y={t.y}
            width={t.w}
            height="2.4"
            rx="1.2"
            fill={ICE}
            fillOpacity={still ? 0.15 : 0.06}
          >
            {still ? null : (
              <animate
                attributeName="fill-opacity"
                values="0.04;0.22;0.04"
                dur={`${t.dur}s`}
                begin={`${t.begin}s`}
                repeatCount="indefinite"
                calcMode="spline"
                keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
              />
            )}
          </rect>
        ))}

        {/* 3 · the hairlines, under the metal so a capsule's foot covers the
               join rather than the hairline crossing the capsule. */}
        {hairs.map((h) => (
          <rect
            key={`${h.cx}-${h.top}`}
            x={h.cx - HAIR_W / 2}
            y={h.top}
            width={HAIR_W}
            height={Math.max(0, h.bot - h.top)}
            rx={HAIR_W / 2}
            fill={`url(#${uid}-hair${h.fade === "up" ? "Up" : "Dn"})`}
          />
        ))}

        {/* 4 · the instrument. */}
        {bars.map((b, i) => {
          const x = b.cx - b.w / 2;
          const y = b.cy - b.len / 2;
          const spec = specLen(b.len);
          // Rotating the clocks by the id is the whole per-card difference: the
          // same capsules, a different one leading the light.
          const light = LIGHT[(i + rot) % LIGHT.length]!;
          const phase = rimPhase(b.cx);
          // The lit edge only exists where there is straight side to draw it
          // on: on a round node the two caps meet and there is none.
          const edge = b.len - b.w;
          return (
            <g
              key={`${b.cx}-${b.cy}-${i}`}
              transform={b.rot ? `rotate(${b.rot} ${b.cx} ${b.cy})` : undefined}
            >
              <rect x={x} y={y} width={b.w} height={b.len} rx={b.w / 2} fill={`url(#${uid}-body)`} />
              <g clipPath={`url(#${uid}-clip${i})`}>
                {/* Two rects, one clock. The `-spec` gradient feathers the
                    highlight along the bar; nothing feathers it ACROSS one, and
                    a single 4-unit-wide rect of it renders as a bright sliver
                    with two hard vertical sides — the "tape stuck on a tube"
                    read at a tenth the size. So a wide, dim halo carries the
                    soft shoulders and a narrow, bright core sits inside it: the
                    same gradient twice at two widths and two alphas, which is
                    a two-stop blur for the price of one extra rect and no
                    filter region to rasterise.

                    Both start a full smear-length above the capsule and fall
                    past its foot, so the light ENTERS and LEAVES rather than
                    blinking on in place. Parked at the waist when motion is
                    off — the still frame has to be the lit frame. */}
                <g transform={still ? `translate(0 ${((b.len + spec) / 2).toFixed(1)})` : undefined}>
                  {still ? null : (
                    <animateTransform
                      attributeName="transform"
                      type="translate"
                      values={`0 0;0 ${(b.len + spec).toFixed(1)}`}
                      dur={`${light.dur}s`}
                      begin={`${light.begin}s`}
                      repeatCount="indefinite"
                    />
                  )}
                  <rect
                    x={x + b.w * 0.06}
                    y={y - spec}
                    width={b.w * 0.74}
                    height={spec}
                    rx={b.w * 0.37}
                    opacity="0.34"
                    fill={`url(#${uid}-spec)`}
                  />
                  <rect
                    x={x + b.w * 0.26}
                    y={y - spec * 0.88}
                    width={b.w * 0.3}
                    height={spec * 0.88}
                    rx={b.w * 0.15}
                    fill={`url(#${uid}-spec)`}
                  />
                </g>
              </g>
              {edge > 6 ? (
                <rect
                  x={x + 0.5}
                  y={y + b.w / 2}
                  width="0.7"
                  height={edge.toFixed(2)}
                  fill={`url(#${uid}-edge)`}
                />
              ) : null}
              {/* The rim last, so nothing paints over the one edge that tells
                  you the shape is there at all. Its flare is offset by the
                  bar's place along the sweep, so the flares chase the streak. */}
              <rect
                x={x}
                y={y}
                width={b.w}
                height={b.len}
                rx={b.w / 2}
                fill="none"
                stroke={`url(#${uid}-rim)`}
                strokeWidth="0.7"
                strokeOpacity={still ? 1 : 0.6}
              >
                {still ? null : (
                  <animate
                    attributeName="stroke-opacity"
                    values="1;0.6;0.6;1"
                    keyTimes="0;0.12;0.88;1"
                    dur={`${STREAK_DUR}s`}
                    begin={`${(-STREAK_DUR * (1 - phase)).toFixed(2)}s`}
                    repeatCount="indefinite"
                  />
                )}
              </rect>
            </g>
          );
        })}

        {/* 5 · the fast line, over the metal — a reflection passing in front. */}
        <g transform={`rotate(${ANGLE} ${VB / 2} ${AXIS_Y})`}>
          <g transform={still ? "translate(-10 0)" : undefined} opacity={still ? 0.9 : 0}>
            {still ? null : (
              <>
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  values={`${-STREAK_TRAVEL} 0;${STREAK_TRAVEL} 0`}
                  dur={`${STREAK_DUR}s`}
                  repeatCount="indefinite"
                />
                <animate
                  attributeName="opacity"
                  values="0;1;1;0"
                  keyTimes="0;0.18;0.82;1"
                  dur={`${STREAK_DUR}s`}
                  repeatCount="indefinite"
                />
              </>
            )}
            <rect x={VB / 2 - 82} y={AXIS_Y - 3} width="164" height="6" rx="3" fill={`url(#${uid}-bloom)`} />
            <rect
              x={VB / 2 - 82}
              y={AXIS_Y - 0.65}
              width="164"
              height="1.3"
              rx="0.65"
              fill={`url(#${uid}-streak)`}
            />
          </g>
        </g>
      </svg>
      {/* Kept from the pattern art: the top-left carries the host and badges,
          the foot carries the stats, and both must stay readable over whatever
          the light is doing underneath. */}
      <div
        style={sx(
          "position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,9,11,.6) 0%,rgba(9,9,11,.12) 40%,rgba(9,9,11,.78) 100%)",
        )}
      />
    </div>
  );
}
