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
 * shape, and `buildPayoffChart()` with no arguments draws byte-identically to
 * what it drew before live spot existed — same `path`, same `fill`, same grid,
 * same strike marks, same `spotX` of 458.5 and the same `SPOT 4,182 ·
 * REFERENCE`. Not one number in the fixture or the geometry has moved.
 *
 * The **stats strip** did move, and only there: it printed one breakeven for a
 * structure that has two, and printed a fraction of this chart's own x-axis
 * under a label (`WIN ZONE`) that reads as a probability. Both are described at
 * their call sites below. The rule the move respects is the one that matters —
 * the fixture was not adjusted to make a label true; the labels were made to
 * match what the fixture has always said.
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
  /**
   * Whether `spotX` is a real position on this axis or the clamp.
   *
   * `spotX` is clamped to `[LO, HI]` because a dashed line drawn off the left
   * edge is a rendering bug. But a clamped line is still a *drawing* — parked
   * on the `3.2k` gridline it reads as "spot is 3,200", which live ETH at 2,453
   * is not. The label was doing the whole job of disclosure on its own and the
   * picture was quietly contradicting it.
   *
   * So the geometry says which it is and the view decides how to draw it: on
   * scale, a dashed line at `spotX`; off scale, an edge marker that points out
   * of the frame instead. Nothing here rescales — the window is fixed and the
   * fixture is frozen; what changes is whether a line is claimed where there is
   * no line.
   */
  spotOnScale: boolean;
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
 * geometry is byte-identical to the pre-live chart, which is what keeps
 * `test/engine.test.ts` honest about being a fixture test.
 *
 * `spot` moves exactly two outputs — `spotX`/`spotLabelX` (clamped) and
 * `spotOnScale`/`spotIsLive`/`spotLabel` (not clamped). It moves no stat: the
 * payoff of a fixed structure at expiry is a function of the settlement price
 * alone, and today's spot is not the settlement price. A stat that changed with
 * the live print would be claiming a forecast this file cannot make.
 */
export function buildPayoffChart(
  structure: Structure = ETH_VOL_BOX,
  spot: number | null = null,
): PayoffChart {
  const live = typeof spot === "number" && Number.isFinite(spot);
  const spotPrice = live ? (spot as number) : SPOT_FALLBACK;
  // Geometry only. A live ETH print sits below this chart's 3,200 floor today,
  // and a dashed line drawn off the left edge is a rendering bug, not a fact.
  // The *label* always prints the true number; only the line is clamped — and
  // `spotOnScale` tells the view that the clamped value is a parking spot and
  // not a reading, so it can draw an off-scale marker rather than a line
  // sitting on the 3.2k gridline pretending to be spot.
  const SPOT = Math.min(HI, Math.max(LO, spotPrice));
  const xs = Array.from({ length: SAMPLES }, (_, i) => LO + ((HI - LO) * i) / (SAMPLES - 1));
  const vals = xs.map((s) => payoff(structure, s));

  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const pad = (rawMax - rawMin) * 0.12;
  const vmin = rawMin - pad;
  const vmax = rawMax + pad;

  /**
   * **Every** zero crossing in the window, not the first upward one.
   *
   * This structure is a long vol box: it pays on a big move in either
   * direction and loses in the middle, so it has two breakevens — a downward
   * crossing where the put spread stops covering the debit (≈3,723) and an
   * upward one where the call spread starts to (≈4,389). The panel printed
   * `BREAKEVEN 4,389` alone, which is the upper one, and a player reading a
   * single breakeven reads a single-sided position: it says "you need ETH
   * above 4,389", when below 3,723 the box is just as profitable and at the
   * live print of 2,453 it is already up +0.29 Ξ. Half the truth, stated as
   * the whole of it.
   *
   * `prev >= 0 && cur < 0` and `prev < 0 && cur >= 0` are both crossings and
   * both are collected, in ascending price order, interpolated the same way.
   */
  const breakevens: number[] = [];
  for (let i = 1; i < vals.length; i++) {
    const prev = vals[i - 1]!;
    const cur = vals[i]!;
    if (prev < 0 === cur < 0) continue;
    const f = -prev / (cur - prev);
    breakevens.push(xs[i - 1]! + f * (xs[i]! - xs[i - 1]!));
  }

  /**
   * The share of the *plotted window* that settles above zero — and nothing
   * more than that.
   *
   * It was labelled `WIN ZONE 66.7%` beside `IMPLIED ODDS 4.51×`, where it read
   * as a win probability. It is not one and cannot become one here: a
   * probability needs a distribution over settlement prices, and the only
   * inputs this module has are four strikes, a debit and a hardcoded 3,200–5,200
   * axis chosen to frame the strikes. Sample the same box over 2,000–8,000 and
   * the "probability" changes without a single fact about the position
   * changing — which is the proof that it was never one.
   *
   * Two honest options: compute something that deserves the name, or say what
   * the number is. The first needs an IV surface and a term this file has no
   * access to and `src/engine/**` may not import a market to get. So the label
   * names its own denominator — `IN PROFIT · 66.7% OF 3.2–5.2k` — and the
   * reader can see it is a fraction of an axis rather than a claim about the
   * world. The breakevens beside it are the part that is actually about the
   * position.
   */
  const winZone = vals.filter((v) => v > 0).length / vals.length;
  const windowLabel = `${(LO / 1000).toFixed(1)}–${(HI / 1000).toFixed(1)}k`;
  const money = (n: number): string => Math.round(n).toLocaleString("en-US");

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
    spotOnScale: spotPrice >= LO && spotPrice <= HI,
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
        // Plural, because there are two, and the label has to change with the
        // arithmetic or it becomes the next thing that reads wrong.
        label: breakevens.length === 1 ? "BREAKEVEN" : "BREAKEVENS",
        value: breakevens.length > 0 ? breakevens.map(money).join(" / ") : "—",
        color: "#fafafa",
      },
      {
        // The denominator lives in the label, where it costs nothing and can
        // never be read as part of the number. `IN PROFIT · 3.2–5.2k` over
        // `66.7%` cannot be mistaken for a probability; `WIN ZONE` over `66.7%`
        // was read as one by the first person who looked at it.
        label: `IN PROFIT · ${windowLabel}`,
        value: `${(winZone * 100).toFixed(1)}%`,
        color: "#c8ff00",
      },
    ],
  };
}
