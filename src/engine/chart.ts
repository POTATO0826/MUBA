import { C } from "../theme.ts";
import type { Geometry } from "../types.ts";
import { geom, series, windowLabel } from "./tape.ts";

/** Chart width in the sparkline's own viewBox units. */
export const CHART_W = 260;

export interface ChartCard extends Geometry {
  sym: string;
  window: string;
  /** Signed percentage move, formatted. */
  pct: string;
  /** Last print, formatted as a dollar price. */
  px: string;
  up: boolean;
  stroke: string;
  fillColor: string;
}

/** One sparkline's worth of view data: `count` prints of `sym`'s tape at `salt`,
 *  scaled into a CHART_W × `h` box. */
export function buildChartCard(sym: string, salt: number, count: number, h: number): ChartCard {
  const s = series(sym, salt);
  const g = geom(s, count, CHART_W, h, 8);
  const open = s[0]!;
  const pct = ((g.last - open) / open) * 100;
  const up = pct >= 0;

  return {
    ...g,
    sym,
    window: windowLabel(sym, salt),
    pct: `${up ? "+" : ""}${pct.toFixed(2)}%`,
    px: `$${g.last.toFixed(2)}`,
    up,
    stroke: up ? C.green : C.red,
    fillColor: up ? "rgba(74,222,128,.1)" : "rgba(248,113,113,.1)",
  };
}
