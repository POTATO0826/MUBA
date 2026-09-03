/** Expiry payoff for the worked ETH vol box on the Duel attack screen. */

export interface StructureLeg {
  type: "CALL" | "PUT";
  /** Strike, in the underlying's quote currency. */
  k: number;
  /** Contracts. */
  q: number;
  /** +1 long, -1 short. */
  side: 1 | -1;
}

export interface Structure {
  legs: readonly StructureLeg[];
  /** Ξ per $1 of intrinsic per contract. */
  mult: number;
  /** Ξ paid to open. */
  debit: number;
}

/** Long 4300/4700 call spread against a long 3900/3600 put spread — the same
 *  four legs listed in the slip. Mirrors the shape of
 *  `client.utils.calculatePayout`, computed locally. */
export const ETH_VOL_BOX: Structure = {
  legs: [
    { type: "CALL", k: 4300, q: 2, side: 1 },
    { type: "CALL", k: 4700, q: 2, side: -1 },
    { type: "PUT", k: 3900, q: 1, side: 1 },
    { type: "PUT", k: 3600, q: 1, side: -1 },
  ],
  mult: 0.0023275,
  debit: 0.412,
};

/** Net Ξ at settlement price `s`, debit included. */
export function payoff(structure: Structure, s: number): number {
  let v = 0;
  for (const l of structure.legs) {
    const intrinsic = l.type === "CALL" ? Math.max(0, s - l.k) : Math.max(0, l.k - s);
    v += l.side * l.q * intrinsic * structure.mult;
  }
  return v - structure.debit;
}

export interface PayoffChart {
  path: string;
  fill: string;
  zeroY: string;
  spotX: string;
  spotLabelX: string;
  gridY: readonly { y: string; ty: string; label: string }[];
  gridX: readonly { x: string; label: string }[];
  strikeMarks: readonly { x: string; y: string; ty: string; label: string }[];
  stats: readonly { label: string; value: string; color: string }[];
}

const LO = 3200;
const HI = 5200;
const SPOT = 4182;
const SAMPLES = 81;

/** Everything the payoff SVG needs, in its 900×300 viewBox coordinates. */
export function buildPayoffChart(structure: Structure = ETH_VOL_BOX): PayoffChart {
  const xs = Array.from({ length: SAMPLES }, (_, i) => LO + ((HI - LO) * i) / (SAMPLES - 1));
  const vals = xs.map((s) => payoff(structure, s));

  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const pad = (rawMax - rawMin) * 0.12;
  const vmin = rawMin - pad;
  const vmax = rawMax + pad;

  // Lower breakeven: first upward crossing of zero, linearly interpolated.
  let breakeven: number | null = null;
  for (let i = 1; i < vals.length; i++) {
    const prev = vals[i - 1]!;
    const cur = vals[i]!;
    if (prev < 0 && cur >= 0) {
      const f = -prev / (cur - prev);
      breakeven = xs[i - 1]! + f * (xs[i]! - xs[i - 1]!);
      break;
    }
  }

  const winZone = vals.filter((v) => v > 0).length / vals.length;

  const X = (s: number) => 52 + ((s - LO) / (HI - LO)) * 828;
  const Y = (v: number) => 252 - ((v - vmin) / (vmax - vmin)) * 234;

  const path = "M" + xs.map((s, i) => `${X(s).toFixed(1)},${Y(vals[i]!).toFixed(1)}`).join("L");

  return {
    path,
    fill: `${path}L${X(HI).toFixed(1)},${Y(0).toFixed(1)}L${X(LO).toFixed(1)},${Y(0).toFixed(1)}Z`,
    zeroY: Y(0).toFixed(1),
    spotX: X(SPOT).toFixed(1),
    spotLabelX: (X(SPOT) + 8).toFixed(1),
    gridY: [vmax, vmax * 0.5, 0, vmin * 0.5, vmin].map((v) => ({
      y: Y(v).toFixed(1),
      ty: (Y(v) + 3.5).toFixed(1),
      label: (v >= 0 ? "+" : "") + v.toFixed(2),
    })),
    gridX: [3200, 3600, 4000, 4400, 4800, 5200].map((s) => ({
      x: X(s).toFixed(1),
      label: `${(s / 1000).toFixed(1)}k`,
    })),
    strikeMarks: [3600, 3900, 4300, 4700].map((k) => {
      const v = payoff(structure, k);
      return {
        x: X(k).toFixed(1),
        y: Y(v).toFixed(1),
        ty: (Y(v) - 10).toFixed(1),
        label: `${(k / 1000).toFixed(1)}k`,
      };
    }),
    stats: [
      { label: "MAX PROFIT", value: `+${rawMax.toFixed(2)} Ξ`, color: "#4ade80" },
      { label: "MAX LOSS", value: `${rawMin.toFixed(2)} Ξ`, color: "#f87171" },
      {
        label: "BREAKEVEN",
        value: breakeven ? Math.round(breakeven).toLocaleString("en-US") : "—",
        color: "#fafafa",
      },
      { label: "WIN ZONE", value: `${(winZone * 100).toFixed(1)}%`, color: "#c8ff00" },
    ],
  };
}
