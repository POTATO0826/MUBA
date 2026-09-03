/** Domain types for the THETHADUEL battle prototype. */

export type Market = "STOCK" | "CRYPTO";
export type MarketFilter = Market | "MIXED";
export type Direction = "over" | "under";
export type AutoMode = "demo" | "spectate";

/**
 * The two PvP modes.
 *
 * - `parlay` builds a multi-leg RFQ on one asset and sends it to market makers.
 * - `spotdiff` shows the live order book as a grid. Players pick the cell whose
 *   quote deviates most from its expiry group. The bigger the real edge, the
 *   better the pick.
 */
export type GameMode = "parlay" | "spotdiff";

/**
 * Screens in the app.
 *
 * `hub → create → room → parlay | spotdiff` is the whole flow. A player reaches
 * a game in two clicks.
 *
 * The old draft-and-tape screens (`battles`, `draft`, `study`, `pick`, `live`,
 * `result`, `cases`) are gone from the flow. Their files stay in `src/views/`
 * and `src/engine/` but nothing routes to them.
 */
export type Tab = "hub" | "create" | "parlay" | "spotdiff";

export interface Asset {
  sym: string;
  name: string;
  sector: string;
  mkt: Market;
  /** Reference spot price. */
  px: number;
  /** Target move, in percent, a leg on this asset must clear to win. */
  t: number;
  /** Per-step volatility of the generated tape. */
  vol: number;
}

export interface Leg {
  sym: string;
  dir: Direction;
  t: number;
  sector?: string;
}

export interface LegOutcome {
  /** Move from the tape's first print to `pos`, in percent. */
  pct: number;
  won: boolean;
}

/** Path geometry for one sparkline, in the SVG's own coordinate space. */
export interface Geometry {
  path: string;
  fill: string;
  baseY: string;
  headX: string;
  headY: string;
  last: number;
}

export interface CaseDef {
  name: string;
  tag: string;
  /** Tag colour. */
  tc: string;
  legs: string;
  blurb: string;
  cost: string;
  max: string;
  /** Backdrop: `[gradient stop, radial tint, angle]`. */
  w: [string, string, number];
  /** Season tier required to open it. Absent means always available. */
  tier?: string;
}

export interface PricingRow {
  type: "CALL" | "PUT" | "RANGER";
  strike: string;
  expiry: string;
  bid: string;
  ask: string;
  iv: string;
  delta: string;
  /** Depth bar width, 0–100. */
  depth: number;
  size: string;
  /**
   * How far this quote's implied volatility sits from the median of its expiry
   * group, as a signed fraction. `0.18` means 18% richer than its neighbours.
   *
   * This is the signal the "find a difference" grid scores on. Absent when the
   * order carried no greeks.
   */
  edge?: number;
  /** Mid of best bid and best ask, when both sides quote. */
  mid?: string;
}

export interface OrderRow {
  side: "BUY" | "SELL";
  instrument: string;
  size: string;
  px: string;
  status: "FILLED" | "PARTIAL" | "OPEN" | "CANCELLED";
  time: string;
}
