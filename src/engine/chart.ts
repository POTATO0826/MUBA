import { C } from "../theme.ts";
import type { Geometry } from "../types.ts";
import { TAPE_LEN, fmtPx, geom, series, spanLabel } from "./tape.ts";

/** Chart width in the sparkline's own viewBox units. */
export const CHART_W = 260;

export interface ChartCard extends Geometry {
  sym: string;
  /** What the card is drawing, in prints: `"PRINTS 51–110 OF 200"`. */
  window: string;
  /** How many prints that is. The card prints it; a reader who wants to know
   *  whether a line is fourteen points or two hundred can see which. */
  prints: number;
  /** Signed percentage move **across the drawn slice**, formatted. */
  pct: string;
  /** Last print of the drawn slice, formatted. */
  px: string;
  up: boolean;
  stroke: string;
  fillColor: string;
}

/**
 * One sparkline's worth of view data: `count` prints of `sym`'s tape at `salt`,
 * starting at `from`, scaled into a CHART_W × `h` box.
 *
 * ## Everything on the card describes the same slice
 *
 * `from` exists so the study screen can zoom, and the rule that makes a zoom
 * honest is that the numbers travel with the picture. The percentage is
 * measured from the slice's *own* opening print, not from print 1, and
 * `window` names the prints it measured. A card that zoomed the line but kept
 * quoting the full window's move would be stating a number about data the
 * reader can no longer see — which is the bug the label above this file used to
 * have in its own way.
 *
 * ## What a zoom cannot touch
 *
 * `salt` and the tape behind it. This function reads `series(sym, salt)` and
 * slices it; the walk is generated identically no matter what any viewer is
 * looking at, so two seats at two zoom levels are reading one board. Nothing
 * downstream of a `ChartCard` reaches a pick, a seed or settlement — the card
 * is view data, and `from` is the camera. `src/views/BoxBuilder.tsx` keeps its
 * ladder viewport out of `encodeBoxPick` on exactly this argument.
 */
export function buildChartCard(
  sym: string,
  salt: number,
  count: number,
  h: number,
  from = 0,
): ChartCard {
  const s = series(sym, salt);
  const total = s.length || TAPE_LEN;
  // Clamped here rather than inside `geom`, because the label and the
  // percentage have to agree with the picture to the print. Two prints is the
  // floor: one point is not a line, and `geom` normalises its x-axis on
  // `span - 1`.
  const start = Math.max(0, Math.min(Math.max(0, total - 2), Math.floor(from)));
  const span = Math.max(2, Math.min(Math.floor(count), total - start));

  const g = geom(s, span, CHART_W, h, 8, start);
  const open = s[start]!;
  const pct = ((g.last - open) / open) * 100;
  const up = pct >= 0;

  return {
    ...g,
    sym,
    window: spanLabel(start, span, total),
    prints: span,
    pct: `${up ? "+" : ""}${pct.toFixed(2)}%`,
    // `fmtPx`, not `toFixed(2)`. The stats row beside this already formatted its
    // range that way, so a sub-dollar name printed `$0.84` here and
    // `0.7685–1.53` two lines below — and anything under a cent printed `$0.00`,
    // a price no venue has ever quoted. One formatter, one card.
    px: `$${fmtPx(g.last)}`,
    up,
    stroke: up ? C.green : C.red,
    fillColor: up ? "rgba(74,222,128,.1)" : "rgba(248,113,113,.1)",
  };
}
