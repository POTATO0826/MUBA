/**
 * Expiry payoff for the worked ETH vol box on the Duel attack screen.
 *
 * ## Why this file lives in `src/desk/` and not `src/engine/`
 *
 * It used to sit in `src/engine/`, which `test/determinism.test.ts` scans: no
 * engine module may import the live news wire or the live market. That guard is
 * the reason seeded replays stay identical, and it is not negotiable. This
 * module is *presentation* — nothing in settlement has ever imported it — and
 * P2 gives its chart a live spot anchor, which would have meant either widening
 * the guard (forbidden) or lying about where the number came from. Moving the
 * file was the cheaper of the two, and the one the plan named.
 *
 * ⚠ The scan asserts `engineFiles() >= 6` so a broken glob cannot make it pass
 * vacuously. After this move `src/engine/` holds exactly 6 modules — the floor
 * budget is spent. Removing another engine file means lowering that floor and
 * arguing for it.
 *
 * `ETH_VOL_BOX` stays a frozen fixture: `test/engine.test.ts` pins its payoff
 * shape, and `buildPayoffChart()` with no arguments is byte-identical to what
 * it produced before live spot existed.
 */

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
  /** True when the spot line is a live quote rather than the reference price.
   *  The view labels the two differently — a seeded number that reads as live
   *  is exactly the lie this whole phase exists to remove. */
  spotIsLive: boolean;
  /** `SPOT 2,375.76 · LIVE` or `SPOT 4,182 · REFERENCE`. Rendered verbatim; the
   *  view no longer carries a hardcoded number of its own (C4's fifth site). */
  spotLabel: string;
  gridY: readonly { y: string; ty: string; label: string }[];
  gridX: readonly { x: string; label: string }[];
  strikeMarks: readonly { x: string; y: string; ty: string; label: string }[];
  stats: readonly { label: string; value: string; color: string }[];
}

const LO = 3200;
const HI = 5200;
/**
 * The reference spot the structure was written around.
 *
 * One of the five hardcoded-spot sites the plan's C4 correction enumerates.
 * It survives as an explicit *fallback*, not as a fact: `buildPayoffChart()`
 * with no live price still draws the chart it always drew, and says
 * `· REFERENCE` while doing it.
 */
export const SPOT_FALLBACK = 4182;
const SAMPLES = 81;

/**
 * Everything the payoff SVG needs, in its 900×300 viewBox coordinates.
 *
 * `spot` is the live USD price of the structure's underlying, or `null` when
 * there is none — `null` is the ordinary case, not an error (`MarketSource.spot`
 * returns it for every asset Thetanuts does not publish). With `null` the
 * output is byte-identical to the pre-live chart, which is what keeps
 * `test/engine.test.ts` honest about being a fixture test.
 */
export function buildPayoffChart(
  structure: Structure = ETH_VOL_BOX,
  spot: number | null = null,
): PayoffChart {
  const live = typeof spot === "number" && Number.isFinite(spot);
  const spotPrice = live ? (spot as number) : SPOT_FALLBACK;
  // Geometry only. A live ETH print sits below this chart's 3,200 floor today,
  // and a dashed line drawn off the left edge is a rendering bug, not a fact.
  // The *label* always prints the true number; only the line is clamped.
  const SPOT = Math.min(HI, Math.max(LO, spotPrice));
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
    // Nudged left near the right edge so the label never runs out of the box.
    spotLabelX: (X(SPOT) + (X(SPOT) > 700 ? -108 : 8)).toFixed(1),
    spotIsLive: live,
    spotLabel: `SPOT ${spotPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })} · ${
      live ? "LIVE" : "REFERENCE"
    }`,
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
