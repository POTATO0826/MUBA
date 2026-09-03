import type { Geometry } from "../types.ts";
import { meta } from "../data/universe.ts";

/** Number of prints in one generated tape. */
export const TAPE_LEN = 200;

/** Cache keyed `sym:salt`. The walk is fully seeded, so a given key always
 *  produces the same tape — that is what lets the study screen and the fight
 *  screen draw *different* windows on the same ticker (different salts) while
 *  each stays stable across re-renders. */
const seriesCache = new Map<string, readonly number[]>();

/** Seeded random walk of `TAPE_LEN` prints, starting at the asset's spot. */
export function series(sym: string, salt: number): readonly number[] {
  const key = `${sym}:${salt}`;
  const hit = seriesCache.get(key);
  if (hit) return hit;

  const u = meta(sym);
  let s = 0;
  for (let i = 0; i < sym.length; i++) s = (s * 31 + sym.charCodeAt(i)) >>> 0;
  s = (s + salt * 7919) >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const drift = (rand() - 0.45) * 0.0022;
  const out: number[] = [u.px];
  for (let i = 1; i < TAPE_LEN; i++) {
    const shock = (rand() - 0.5) * 2 * u.vol;
    out.push(Math.max(1, out[i - 1]! * (1 + drift + shock)));
  }

  seriesCache.set(key, out);
  return out;
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** A plausible three-month historical window, derived from the same seed as the
 *  tape so the label and the data agree. */
export function windowLabel(sym: string, salt: number): string {
  let s = salt;
  for (let i = 0; i < sym.length; i++) s = (s * 33 + sym.charCodeAt(i)) >>> 0;
  const m = s % 12;
  const y = 2017 + ((s >> 4) % 8);
  const end = m + 3 > 11 ? `${MONTHS[(m + 3) % 12]} ${y + 1}` : `${MONTHS[m + 3]} ${y}`;
  return `${MONTHS[m]} ${y} · ${end}`;
}

/** Price formatting that stays readable from PEPE (1.12e-5) to BTC (96,410). */
export function fmtPx(v: number): string {
  if (v < 0.001) return v.toExponential(2);
  if (v < 1) return v.toFixed(4);
  if (v < 1000) return v.toFixed(2);
  return Math.round(v).toLocaleString("en-US");
}

/**
 * Sparkline geometry for the first `count` prints of `data`, scaled into a
 * `w × h` box.
 *
 * The x-axis is normalised to `count`, so the plotted line always spans the full
 * width and the head sits at the right edge. During the live fight `count` grows
 * every tick: the chart keeps filling the card and gains resolution rather than
 * creeping in from the left. The y-axis rescales to the plotted slice only, which
 * is why an early window looks as dramatic as a finished one.
 */
export function geom(
  data: readonly number[],
  count: number,
  w: number,
  h: number,
  pad: number,
): Geometry {
  const span = Math.max(2, count);
  const pts = data.slice(0, span);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pts) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1;
  const X = (i: number) => (i / (span - 1)) * w;
  const Y = (v: number) => h - pad - ((v - lo) / range) * (h - pad * 2);

  const path = "M" + pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("L");
  const last = pts[pts.length - 1] ?? lo;

  return {
    path,
    fill: `${path}L${X(pts.length - 1).toFixed(1)},${h}L0,${h}Z`,
    baseY: Y(data[0] ?? lo).toFixed(1),
    headX: X(pts.length - 1).toFixed(1),
    headY: Y(last).toFixed(1),
    last,
  };
}

/** Percentage move from the tape's open to print `pos` (1-indexed). */
export function pctAt(sym: string, salt: number, pos: number): number {
  const s = series(sym, salt);
  const open = s[0]!;
  const p = s[Math.max(0, Math.min(s.length - 1, pos - 1))]!;
  return ((p - open) / open) * 100;
}
