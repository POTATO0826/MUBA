import { hash } from "../lib/hash.ts";
import { sx } from "../lib/sx.ts";
import { C } from "../theme.ts";

/**
 * The ornament on a lobby card: an ascending rally of chrome candlesticks.
 *
 * It replaces the generative dot/line patterns `CardArt.tsx` drew here — those
 * were graphic, flat and busy, six different ideas competing on one board. This
 * is one idea, drawn the way a luxury-watch film shoots a movement: a pure
 * near-black field, objects whose SHAPE is legible only through a cold specular
 * rim and a sheen travelling down them, and exactly one fast thing on screen.
 * Nothing here is a flat fill and nothing is an outline — every edge you can
 * see is a reflection, which is the whole trick of reading metal on a screen.
 *
 * Four layers, back to front:
 *
 *   1. the ambient pool — one soft radial that rides with the light, so the
 *      field brightens where the streak currently is and nowhere else;
 *   2. the ticks — three dim capsules loitering in the empty upper-left, the
 *      minute markers of the reference; they breathe, they do not travel;
 *   3. the candles — six capsule bodies climbing left-low to right-high (with
 *      one pullback at bar 3, because a rally that only rises reads as a bar
 *      chart, not as a tape), each with a hairline wick above and below. The
 *      body is a horizontal cylinder gradient; a clipped sheen band glides
 *      down its length on its own 4.4–6.0s clock, staggered so the light
 *      crosses the composition rather than flashing it;
 *   4. the trend line — one slender polished streak at the rally's own angle,
 *      sliding through the bars on an 8.4s loop. It takes the second hand's
 *      job: the only element moving fast enough to catch the eye.
 *
 * Everything is SMIL on gradients and transforms — no rAF, no per-frame React
 * state, no filters (the "glow" is a radial gradient, which costs a fraction of
 * a blur and survives being drawn six times in a grid). The one CSS dependency
 * is none at all: no keyframe is referenced, so `styles.css` stays untouched
 * and two cards can never fight over an animation name.
 *
 * Ids are derived from the lobby id, NOT from `useId()`. React's client-side
 * `useId` counter is module-global and keeps climbing across roots, so the same
 * card mounted twice would emit different gradient ids — and the board's
 * contract (app.test.tsx: "same lobby, same picture") is that the markup is a
 * pure function of the id. A lobby id is already unique on the board and
 * already URL-safe, so it is the better key on both counts.
 *
 * `color` is the market colour, as it was for the pattern art, so a card's
 * identity survives the swap: STOCKS stay blue, CRYPTO lime, MIXED violet. It
 * tints the rim, the wicks and the pool only — the specular core stays ice
 * white (#f0f9ff) whatever the market, because a coloured highlight reads as
 * plastic and a white one reads as polished metal.
 */

/** Square, so the crop is only ever vertical: the cards are ≥300px wide and
 *  exactly 300px tall, and `slice` on a square viewBox in a landscape box
 *  trims top and bottom. Everything therefore lives in the y 48–252 band. */
const VB = 300;

/** The rally's own angle, from bar 1's waist to bar 6's. The streak and its
 *  pool are drawn in a frame rotated by this, so both travel ALONG the rally
 *  instead of merely crossing it. */
const ANGLE = -28;

const BAR_W = 26;
const WICK_W = 1.6;
/** How tall the travelling highlight band is. Roughly a bar's own height, so
 *  the short bars are lit whole and the tall ones are lit in passes. */
const SHEEN = 54;

interface Candle {
  /** Body centre line. */
  cx: number;
  /** Body top / bottom edge. */
  top: number;
  bot: number;
  /** Where the hairline wicks end. */
  wickTop: number;
  wickBot: number;
}

const CANDLES: readonly Candle[] = [
  { cx: 42, top: 198, bot: 240, wickTop: 184, wickBot: 252 },
  { cx: 86, top: 172, bot: 226, wickTop: 156, wickBot: 238 },
  { cx: 130, top: 180, bot: 216, wickTop: 164, wickBot: 228 },
  { cx: 174, top: 138, bot: 198, wickTop: 120, wickBot: 210 },
  { cx: 218, top: 104, bot: 166, wickTop: 86, wickBot: 178 },
  { cx: 262, top: 66, bot: 138, wickTop: 50, wickBot: 150 },
];

/** One clock per bar: length of the sheen's fall, and how far into that fall it
 *  already is at t=0. Coprime-ish durations and scattered offsets keep the six
 *  from ever ganging up into a single pulse. */
const LIGHT: readonly { dur: number; begin: number }[] = [
  { dur: 5.6, begin: -0.4 },
  { dur: 4.8, begin: -2.1 },
  { dur: 6.0, begin: -3.4 },
  { dur: 5.2, begin: -1.2 },
  { dur: 4.4, begin: -4.0 },
  { dur: 5.0, begin: -2.7 },
];

/** The floating markers: {x, y, width}. Parked upper-left, where the rally has
 *  not arrived yet and the card's own copy is thinnest. */
const TICKS: readonly { x: number; y: number; w: number; dur: number; begin: number }[] = [
  { x: 22, y: 74, w: 15, dur: 9.4, begin: -1.1 },
  { x: 48, y: 108, w: 10, dur: 11.2, begin: -5.6 },
  { x: 96, y: 62, w: 12, dur: 8.6, begin: -3.2 },
];

const STREAK_DUR = 8.4;
/** Far enough out that the loop's teleport happens well off the visible field;
 *  the opacity envelope is the belt to that pair of braces. */
const STREAK_TRAVEL = 250;

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

export function ChromeCandles({ id, color = C.blue }: { id: string; color?: string }) {
  // Unique per card, stable forever: see the header on why this is not useId().
  const uid = `cc-${id.replace(/[^a-zA-Z0-9_-]+/g, "-")}`;
  const still = stillMotion();
  // The only per-card variation: which bar is furthest through its fall. The
  // drawing is identical on every card — the light is not.
  const rot = hash(id) % LIGHT.length;

  return (
    <div
      data-art={id}
      data-pattern="chrome-candles"
      aria-hidden
      style={sx("position:absolute;inset:0;overflow:hidden;pointer-events:none")}
    >
      <svg
        viewBox={`0 0 ${VB} ${VB}`}
        preserveAspectRatio="xMidYMid slice"
        style={sx("position:absolute;inset:0;width:100%;height:100%;display:block")}
      >
        <defs>
          {/* The cylinder: dark at both edges, one shoulder of light on the
              left and a second, brighter band at 78% — the read that says
              "round and polished" rather than "rectangle". */}
          <linearGradient id={`${uid}-body`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#0a0e14" />
            <stop offset="12%" stopColor="#1b2430" />
            <stop offset="34%" stopColor="#05070a" />
            <stop offset="62%" stopColor="#0b1119" />
            <stop offset="79%" stopColor="#202b3a" />
            <stop offset="100%" stopColor="#06080c" />
          </linearGradient>

          {/* The rim: bright where the sky would be, market-tinted below. */}
          <linearGradient id={`${uid}-rim`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#e0f2fe" stopOpacity="0.5" />
            <stop offset="45%" stopColor={color} stopOpacity="0.26" />
            <stop offset="100%" stopColor={color} stopOpacity="0.07" />
          </linearGradient>

          {/* The travelling highlight. Hard core, long soft shoulders: a narrow
              core is what makes it read as a reflection of a light source
              rather than as a painted stripe. */}
          <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f0f9ff" stopOpacity="0" />
            <stop offset="40%" stopColor="#bae6fd" stopOpacity="0.1" />
            <stop offset="50%" stopColor="#f0f9ff" stopOpacity="0.55" />
            <stop offset="58%" stopColor={color} stopOpacity="0.28" />
            <stop offset="74%" stopColor="#7dd3fc" stopOpacity="0.06" />
            <stop offset="100%" stopColor="#7dd3fc" stopOpacity="0" />
          </linearGradient>

          {/* Wicks fade AWAY from the body, so two gradients, not one. */}
          <linearGradient id={`${uid}-wickUp`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.04" />
            <stop offset="100%" stopColor={color} stopOpacity="0.32" />
          </linearGradient>
          <linearGradient id={`${uid}-wickDn`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.32" />
            <stop offset="100%" stopColor={color} stopOpacity="0.04" />
          </linearGradient>

          {/* The trend line, along its own length. */}
          <linearGradient id={`${uid}-streak`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity="0" />
            <stop offset="34%" stopColor={color} stopOpacity="0.45" />
            <stop offset="50%" stopColor="#f0f9ff" stopOpacity="0.95" />
            <stop offset="66%" stopColor={color} stopOpacity="0.45" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>

          {/* The pool. A radial, deliberately: one blur filter × six cards in a
              grid is a real cost, and this is indistinguishable at this alpha. */}
          <radialGradient id={`${uid}-pool`}>
            <stop offset="0%" stopColor={color} stopOpacity="0.17" />
            <stop offset="55%" stopColor={color} stopOpacity="0.06" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </radialGradient>

          {CANDLES.map((c, i) => (
            <clipPath key={i} id={`${uid}-clip${i}`}>
              <rect
                x={c.cx - BAR_W / 2}
                y={c.top}
                width={BAR_W}
                height={c.bot - c.top}
                rx={BAR_W / 2}
              />
            </clipPath>
          ))}
        </defs>

        {/* 1 · the ambient pool, riding with the light, under everything. */}
        <g transform={`rotate(${ANGLE} ${VB / 2} ${VB / 2})`}>
          <g transform={still ? "translate(-16 0)" : undefined}>
            {still ? null : (
              <animateTransform
                attributeName="transform"
                type="translate"
                values={`${-STREAK_TRAVEL} 0;${STREAK_TRAVEL} 0`}
                dur={`${STREAK_DUR}s`}
                repeatCount="indefinite"
              />
            )}
            <circle cx={VB / 2} cy={VB / 2} r="62" fill={`url(#${uid}-pool)`} />
          </g>
        </g>

        {/* 2 · the markers. They only breathe. */}
        {TICKS.map((t) => (
          <rect
            key={`${t.x}-${t.y}`}
            x={t.x}
            y={t.y}
            width={t.w}
            height="3"
            rx="1.5"
            fill={color}
            fillOpacity={still ? 0.2 : 0.1}
          >
            {still ? null : (
              <animate
                attributeName="fill-opacity"
                values="0.08;0.34;0.08"
                dur={`${t.dur}s`}
                begin={`${t.begin}s`}
                repeatCount="indefinite"
                calcMode="spline"
                keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
              />
            )}
          </rect>
        ))}

        {/* 3 · the rally. */}
        {CANDLES.map((c, i) => {
          const h = c.bot - c.top;
          const x = c.cx - BAR_W / 2;
          const wx = c.cx - WICK_W / 2;
          // Rotating the clocks by the id is the whole per-card difference: the
          // same six bars, a different bar leading the light.
          const light = LIGHT[(i + rot) % LIGHT.length]!;
          return (
            <g key={c.cx}>
              <rect
                x={wx}
                y={c.wickTop}
                width={WICK_W}
                height={c.top - c.wickTop + 6}
                rx={WICK_W / 2}
                fill={`url(#${uid}-wickUp)`}
              />
              <rect
                x={wx}
                y={c.bot - 6}
                width={WICK_W}
                height={c.wickBot - c.bot + 6}
                rx={WICK_W / 2}
                fill={`url(#${uid}-wickDn)`}
              />
              <rect x={x} y={c.top} width={BAR_W} height={h} rx={BAR_W / 2} fill={`url(#${uid}-body)`} />
              <g clipPath={`url(#${uid}-clip${i})`}>
                {/* Starts one band-height above the body and falls past its
                    foot, so the light enters and leaves rather than blinking.
                    Parked at the waist when motion is off. */}
                <rect
                  x={x}
                  y={c.top - SHEEN}
                  width={BAR_W}
                  height={SHEEN}
                  fill={`url(#${uid}-sheen)`}
                  transform={still ? `translate(0 ${((h + SHEEN) / 2).toFixed(1)})` : undefined}
                >
                  {still ? null : (
                    <animateTransform
                      attributeName="transform"
                      type="translate"
                      values={`0 0;0 ${h + SHEEN}`}
                      dur={`${light.dur}s`}
                      begin={`${light.begin}s`}
                      repeatCount="indefinite"
                    />
                  )}
                </rect>
              </g>
              {/* The rim last, so nothing paints over the one edge that tells
                  you the shape is there at all. */}
              <rect
                x={x}
                y={c.top}
                width={BAR_W}
                height={h}
                rx={BAR_W / 2}
                fill="none"
                stroke={`url(#${uid}-rim)`}
                strokeWidth="0.9"
              />
            </g>
          );
        })}

        {/* 4 · the trend line, over the bars — a reflection passing in front. */}
        <g transform={`rotate(${ANGLE} ${VB / 2} ${VB / 2})`}>
          <g transform={still ? "translate(-16 0)" : undefined} opacity={still ? 0.85 : 0}>
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
                  keyTimes="0;0.14;0.86;1"
                  dur={`${STREAK_DUR}s`}
                  repeatCount="indefinite"
                />
              </>
            )}
            <rect
              x={VB / 2 - 84}
              y={VB / 2 - 0.85}
              width="168"
              height="1.7"
              rx="0.85"
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
