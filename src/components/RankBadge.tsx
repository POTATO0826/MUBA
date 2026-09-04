import type { ReactNode } from "react";
import { DIVISIONS, type TierName } from "../data/rewards.ts";
import type { RankPoint } from "../engine/rank.ts";
import { seededRandom } from "../engine/spin.ts";
import { hash } from "../lib/hash.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO } from "../theme.ts";

/**
 * The tier sigil: a generative crest for a point on the ladder, with the
 * player's progress through their division drawn as a ring around it.
 *
 * Built in the `CardArt.tsx` idiom — a pure SVG seeded off `lib/hash`, no
 * asset and no network, SMIL for the motion that belongs to the artwork
 * itself. The difference is what the seed is: CardArt seeds off a lobby id, so
 * every lobby is a different picture. This seeds off the *tier name*, so every
 * MINNOW in the app wears the same crest and every WHALE wears the same
 * (different) one. A player learns to read the shape.
 *
 * Pure function of `(point, size)`: no state, no effects, no clock, no sound.
 * It never animates itself — the three orbit arcs turn, and that is all. The
 * rank sequence's entrance (`vcBadgeDrop`) and its ring draw (`vcRingDraw`)
 * are applied by the parent, which is why the ring publishes its geometry as
 * two custom properties (see `--vc-ring-len` below).
 *
 * `data-rank` sits on the root, so `styles.css`'s reduced-motion block stills
 * the orbits. A parent that animates the badge as a whole must carry
 * `data-rank` on its own wrapper too — the selector is `[data-rank] *`, which
 * reaches this component's subtree but not this component's root.
 */

/** Salts the sigil seed so a tier's crest is not the same draw as its art. */
const SIGIL_SALT = "#sigil-01";

/** SVG user units. Everything is authored at 100×100 and scaled by `size`. */
const VB = 100;
const CX = 50;
/** The sigil sits high in the box; the division numeral takes the foot. */
const CY = 46;
/** Sigil outer radius, comfortably inside the ring. */
const SIG_R = 23;
/** Progress-ring radius. */
const RING_R = 41;
const RING_LEN = 2 * Math.PI * RING_R;

const f1 = (n: number) => n.toFixed(1);

/**
 * Tier colours. They live here rather than in `rewards.ts` because they are
 * presentation, and `rewards.ts` is the model — but they are exported so the
 * ladder page and the rank sequence tint from the same five values.
 */
export const RANK_COLOR: Record<TierName, string> = {
  MINNOW: C.muted,
  FISH: C.blue,
  SHARK: C.green,
  ORCA: C.violet,
  WHALE: C.accent,
};

type Pt = readonly [number, number];

const polar = (cx: number, cy: number, r: number, deg: number): Pt => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
};

/** A stroked arc from `a0°` to `a1°`, clockwise, degrees measured from 12. */
function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${f1(x0)},${f1(y0)}A${f1(r)},${f1(r)} 0 ${large} 1 ${f1(x1)},${f1(y1)}`;
}

/**
 * The crest. A star polygon whose point count grows with the tier (MINNOW 5 →
 * WHALE 9) and whose every radius is a draw from the tier's own seeded
 * sequence, so the five shapes are unmistakably siblings and unmistakably not
 * each other. A seeded rotation stops them all pointing due north.
 */
function sigil(rand: () => number, tierIndex: number, color: string): ReactNode {
  const spokes = 5 + Math.max(0, Math.min(4, tierIndex));
  const spin = rand() * (360 / spokes);
  const step = 360 / spokes;

  const outer: string[] = [];
  const inner: string[] = [];
  const ticks: ReactNode[] = [];

  for (let i = 0; i < spokes; i++) {
    const at = spin + i * step;
    const ro = SIG_R * (0.74 + rand() * 0.26);
    const ri = SIG_R * (0.30 + rand() * 0.20);
    const [ox, oy] = polar(CX, CY, ro, at);
    const [ix, iy] = polar(CX, CY, ri, at + step / 2);
    const [hx, hy] = polar(CX, CY, SIG_R * 0.22, at);
    outer.push(`${f1(ox)},${f1(oy)}`);
    outer.push(`${f1(ix)},${f1(iy)}`);
    inner.push(`${f1(hx)},${f1(hy)}`);
    const [tx, ty] = polar(CX, CY, SIG_R * 1.18, at);
    ticks.push(
      <circle key={`t${i}`} cx={f1(tx)} cy={f1(ty)} r={f1(0.8 + rand() * 0.9)} fill={color} fillOpacity="0.55" />,
    );
  }

  return (
    <g>
      <path d={`M${outer.join("L")}Z`} fill={color} fillOpacity="0.14" stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      <path d={`M${inner.join("L")}Z`} fill={color} fillOpacity="0.42" stroke="none" />
      {ticks}
    </g>
  );
}

/** Three slow arcs turning behind the crest — the badge's only own motion. */
function orbits(rand: () => number, color: string): ReactNode {
  return Array.from({ length: 3 }, (_, i) => {
    const r = 30 + i * 5.5;
    const a0 = rand() * 360;
    const sweep = 90 + rand() * 130;
    const dur = 34 + i * 13 + rand() * 10;
    return (
      <path
        key={i}
        d={arcPath(CX, CY, r, a0, a0 + sweep)}
        fill="none"
        stroke={color}
        strokeWidth={f1(0.7 + i * 0.25)}
        strokeOpacity={f1(0.30 - i * 0.07)}
        strokeLinecap="round"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`0 ${CX} ${CY}`}
          to={`${i % 2 ? -360 : 360} ${CX} ${CY}`}
          dur={`${f1(dur)}s`}
          repeatCount="indefinite"
        />
      </path>
    );
  });
}

/**
 * The badge. `point.pct` is the fill of the player's *division* band, not of
 * the tier — the ring is full three times per tier, which is what makes a
 * division-up worth watching.
 *
 * The ring is drawn at its resting offset, so with animation off (reduced
 * motion, or a parent that never applies one) it is already correct. It also
 * publishes `--vc-ring-len` and `--vc-ring-off`, which is the whole contract
 * `vcRingDraw` needs: a parent adds `animation:vcRingDraw 640ms …` and the
 * ring sweeps from empty to exactly where it already sat.
 */
export function RankBadge({ point, size = 96 }: { point: RankPoint; size?: number }) {
  const color = RANK_COLOR[point.tier.name];
  const seed = hash(point.tier.name + SIGIL_SALT);
  const rand = seededRandom(seed);
  // Orbits first, then the crest: one sequence, so the crest's draws depend on
  // the orbits' and the whole badge is a single deterministic composition.
  const arcs = orbits(rand, color);
  const crest = sigil(rand, point.tierIndex, color);
  const offset = RING_LEN * (1 - Math.max(0, Math.min(1, point.pct)));
  const numeral = DIVISIONS[point.division] ?? DIVISIONS[0];

  return (
    <span
      data-rank={point.label}
      data-rank-tier={point.tier.name}
      data-rank-pct={point.pct.toFixed(3)}
      aria-label={point.label}
      style={sx(`display:inline-block;flex:none;width:${size}px;height:${size}px;line-height:0`)}
    >
      <svg viewBox={`0 0 ${VB} ${VB}`} width={size} height={size} style={sx("display:block;overflow:visible")}>
        <g aria-hidden="true">{arcs}</g>

        {/* Ring track, then the fill. Rotated so 0% starts at 12 o'clock. */}
        <circle cx={CX} cy={CY} r={RING_R} fill="none" stroke={C.line} strokeWidth="3" />
        <circle
          cx={CX}
          cy={CY}
          r={RING_R}
          fill="none"
          stroke={color}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={f1(RING_LEN)}
          strokeDashoffset={f1(offset)}
          transform={`rotate(-90 ${CX} ${CY})`}
          style={sx(`--vc-ring-len:${f1(RING_LEN)};--vc-ring-off:${f1(offset)}`)}
        />

        {crest}

        <text
          x={CX}
          y={VB - 8}
          textAnchor="middle"
          fill={color}
          fillOpacity="0.9"
          style={sx(`font:700 11px/1 ${MONO};letter-spacing:.16em`)}
        >
          {numeral}
        </text>
      </svg>
    </span>
  );
}

/**
 * The tier word, `SHARK II`, sized to sit beside the badge. Split out because
 * the flourish stage animates the word and not the sigil (`vcRankSlam` on this
 * element, `vcBadgeDrop` on the badge) — two separate animation targets, so
 * they cannot share one node.
 *
 * Carries `data-rank-word` rather than `data-rank`: a second `data-rank` in
 * the same panel would make `[data-rank]` ambiguous for the tests, and the
 * reduced-motion stilling arrives from the sequence panel's own `data-rank`
 * ancestor either way.
 */
export function RankWord({ point, size = 22 }: { point: RankPoint; size?: number }) {
  return (
    <span
      data-rank-word={point.label}
      style={sx(
        `display:inline-block;font:700 ${size}px/1 ${MONO};letter-spacing:.12em;` +
          `color:${RANK_COLOR[point.tier.name]}`,
      )}
    >
      {point.label}
    </span>
  );
}
