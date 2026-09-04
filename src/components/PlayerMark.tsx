import { hash } from "../lib/hash.ts";
import { sx } from "../lib/sx.ts";
import { C } from "../theme.ts";

/**
 * The player mark — a procedural pixel glyph, seeded off the player's name.
 *
 * What it replaces: two initials centred on a flat rounded colour square
 * (`theme.avatarStyle`, now deleted). That square carried exactly one bit of
 * identity — the colour — and the letters on it were the same two letters
 * already printed beside it, in a bigger and more legible font. Thirteen
 * personas share five accent colours, so at a glance the ladder was a column of
 * near-identical chips. This gives every name its own shape.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A 5×5 MIRRORED GRID, AND NOT SOMETHING RICHER
 * ────────────────────────────────────────────────────────────────────────────
 * The mark has to survive 24px. At that size the tile is a 3.6px-per-cell
 * pixel grid, and anything with a curve, a gradient or a stroke turns to mush —
 * so the whole vocabulary is filled squares on the device pixel grid, which is
 * the one thing that stays sharp all the way down. `shape-rendering:crispEdges`
 * on the glyph snaps every edge to a whole device pixel, so the mark is never
 * blurred by a fractional scale factor; the tile itself keeps normal rendering
 * so its rounded corners stay smooth.
 *
 * The VERTICAL MIRROR is what makes the output read as a *mark* rather than as
 * noise. A free 25-bit grid produces mostly lopsided static — the eye files it
 * under "texture", not under "logo", and cannot recall it. Reflecting the left
 * two columns onto the right two leaves 15 free bits (32,768 distinct glyphs,
 * against a roster of thirteen) but every draw comes out balanced about its own
 * axis, which is the property shared by every emblem, crest and rune a person
 * has ever been asked to recognise. Fewer possible marks, far more memorable
 * ones — the right trade at this roster size.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE DENSITY RE-ROLL
 * ────────────────────────────────────────────────────────────────────────────
 * 15 fair bits average out at ~12 of 25 cells lit, but the tails are real: a
 * near-empty draw renders as an all-but-blank tile and a near-full one as a
 * solid colour block. Both are indistinguishable from a rendering bug, and both
 * lose the one thing this component exists to provide. So a draw outside
 * `[MIN_LIT, MAX_LIT]` is rejected and the seed is re-hashed with an attempt
 * suffix — a deterministic re-roll, not a random one, so the same name still
 * yields the same glyph on every machine and forever. `REROLLS` bounds the loop
 * and `FALLBACK` catches the (unreachable in practice) case where every attempt
 * is rejected, because the function must be total.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE *NAME* IS THE SEED
 * ────────────────────────────────────────────────────────────────────────────
 * `Player` (types.ts) carries name/initial/bg and nothing else — no id — while
 * `Persona` (data/leaderboard.ts) carries a slug id. The name is the only key
 * both sides hold, so seeding off it is what lets one component serve the
 * lobby cards, the ladder, the room seats, the parlay slip and the result rows
 * with the same glyph for the same player on all five. `MARK_SALT` keeps this
 * stream clear of `CardArt`'s and the persona generator's, which hash bare ids.
 *
 * The initials do not render — they are the `title` and the `aria-label`, so a
 * hover and a screen reader still name the player. Every surface that shows a
 * mark already prints the name in text beside it, so nothing is lost visually.
 */

/** The mark is 5×5. Not exported as a knob — the geometry below assumes it. */
const GRID = 5;
/** Independent columns: 0,1,2. Columns 3 and 4 are 1 and 0 reflected. */
const HALF = 3;
/** Free bits per mark. 15 → 32,768 glyphs, before the density filter. */
const CELLS = GRID * HALF;

/** Density bounds, in lit cells out of 25. Below the floor the tile reads as
 *  empty; above the ceiling it reads as a solid block. Both look broken. */
export const MIN_LIT = 4;
export const MAX_LIT = 21;

/** Separates this stream from `CardArt`'s and the persona generator's. Changing
 *  it repaints every mark in the app — which is allowed, but do it knowingly. */
const MARK_SALT = "#mark-01";

/** Attempt cap for the density re-roll. At ~1 rejection in 10^4 draws a single
 *  re-roll is already generous; twelve is here to make the loop provably
 *  terminating, not because any name is expected to need them. */
const REROLLS = 12;

/** Half-grid used when every re-roll is rejected. Expands to 14 lit cells, so
 *  it satisfies the bounds it exists to guarantee. */
const FALLBACK_HALF: readonly boolean[] = [
  true, false, true,
  false, true, false,
  true, true, false,
  false, true, false,
  true, false, true,
];

/** Left half + centre column → the full mirrored row. */
function expand(bits: readonly boolean[]): boolean[][] {
  const rows: boolean[][] = [];
  for (let y = 0; y < GRID; y++) {
    const a = bits[y * HALF] ?? false;
    const b = bits[y * HALF + 1] ?? false;
    const c = bits[y * HALF + 2] ?? false;
    rows.push([a, b, c, b, a]);
  }
  return rows;
}

/** 15 bits off one hashed word. `hash` is murmur-finalised, so the low bits are
 *  as well mixed as the high ones and a plain shift-and-mask is fair. */
function bitsOf(seed: string): boolean[] {
  const h = hash(seed);
  const out: boolean[] = [];
  for (let i = 0; i < CELLS; i++) out.push(((h >>> i) & 1) === 1);
  return out;
}

const litCount = (rows: readonly (readonly boolean[])[]): number =>
  rows.reduce((n, row) => n + row.reduce((m, on) => m + (on ? 1 : 0), 0), 0);

/**
 * The glyph for a name: 5 rows of 5, mirrored about the centre column, with a
 * lit-cell count inside `[MIN_LIT, MAX_LIT]`.
 *
 * Pure and total. Exported so the test can pin it without rendering, and so a
 * future surface (a favicon, an OG image, an on-chain SVG) can draw the same
 * mark without importing React.
 */
export function markGrid(name: string): readonly (readonly boolean[])[] {
  for (let attempt = 0; attempt <= REROLLS; attempt++) {
    const seed = attempt === 0 ? name + MARK_SALT : `${name}${MARK_SALT}#${attempt}`;
    const rows = expand(bitsOf(seed));
    const lit = litCount(rows);
    if (lit >= MIN_LIT && lit <= MAX_LIT) return rows;
  }
  return expand(FALLBACK_HALF);
}

/** Cell edge as a fraction of the tile — the glyph occupies the middle 75%,
 *  leaving a quiet border the 1px rule can sit inside without crowding. */
const CELL_RATIO = 0.15;

/** Trim float noise so the `d` attribute is short and snapshot-stable. */
const n2 = (n: number): number => Number(n.toFixed(2));

/** One axis-aligned subpath per lit cell, in one `<path>`. A single node rather
 *  than up to 25 rects, and the shared interior edges of adjacent cells cancel
 *  in the fill, so a run of pixels has no seams in it. */
function pathOf(rows: readonly (readonly boolean[])[], off: number, cell: number): string {
  const parts: string[] = [];
  rows.forEach((row, y) => {
    row.forEach((on, x) => {
      if (!on) return;
      parts.push(
        `M${n2(off + x * cell)} ${n2(off + y * cell)}h${n2(cell)}v${n2(cell)}h${n2(-cell)}z`,
      );
    });
  });
  return parts.join("");
}

export interface PlayerMarkProps {
  /** The seed. Same name → same glyph, on every surface and every machine. */
  name: string;
  /** Not rendered — the accessible name and the hover tooltip. */
  initials: string;
  /** The player's accent (`Player.bg` / `Persona.bg`). Tints the pixels and
   *  the tile's rule; the tile itself stays near-black on every player. */
  bg: string;
  /** Tile edge in px. Used at 24, 26, 28, 30 and 44 across the app. */
  size?: number;
}

/**
 * The mark, as inline SVG. No assets, no dependencies, no state, no clock —
 * a pure function of `(name, bg, size)`, in the `Sparkline` / `RankBadge`
 * idiom.
 */
export function PlayerMark({ name, initials, bg, size = 26 }: PlayerMarkProps) {
  const rows = markGrid(name);
  const cell = size * CELL_RATIO;
  const off = (size - cell * GRID) / 2;
  // 2–4px: enough to soften the corner, far too little to read as a pill. The
  // mark should look milled, not bubbled.
  const radius = Math.max(2, Math.min(4, Math.round(size * 0.1)));
  const label = `${initials} · ${name}`;

  return (
    <span
      data-player-mark={name}
      title={label}
      aria-label={label}
      style={sx(`display:inline-block;flex:none;width:${size}px;height:${size}px;line-height:0`)}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        style={sx("display:block")}
      >
        {/* Inset by half a unit so the 1px rule lands ON the pixel grid rather
            than straddling it — the same reason the glyph uses crispEdges. */}
        <rect
          x="0.5"
          y="0.5"
          width={size - 1}
          height={size - 1}
          rx={radius}
          fill={C.panelAlt}
          stroke={`${bg}4d`}
          strokeWidth="1"
        />
        <path d={pathOf(rows, off, cell)} fill={bg} shapeRendering="crispEdges" />
      </svg>
    </span>
  );
}
