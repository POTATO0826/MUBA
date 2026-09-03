/** Domain types for the THETADUEL case prototype. */

export type Market = "STOCK" | "CRYPTO";
export type Direction = "over" | "under";

/**
 * Screens in the app.
 *
 * `cases → spin → parlay-build → study → tape → settled` is one case run.
 * `lobby` and `desk` sit outside it.
 */
export type Tab =
  | "lobby"
  | "cases"
  | "spin"
  | "parlay-build"
  | "study"
  | "tape"
  | "settled"
  | "desk";

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
  /** URL-safe key, e.g. `eth-vol-box`. */
  id: string;
  name: string;
  tag: string;
  /** Tag colour. */
  tc: string;
  /** How many legs the spin fills. */
  legCount: number;
  blurb: string;
  cost: string;
  max: string;
  /** Backdrop: `[gradient stop, radial tint, angle]`. */
  w: [string, string, number];
  /** Season tier required to open it. Absent means always available. */
  tier?: string;
  /**
   * The only tickers the reel can land on. Lives on the case, not the spin —
   * a LOW VAR case must not be able to deal PEPE. Must hold at least
   * `legCount` names, or the reel can never fill the slots without a duplicate.
   */
  eligibleAssets: readonly string[];
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
}

export interface OrderRow {
  side: "BUY" | "SELL";
  instrument: string;
  size: string;
  px: string;
  status: "FILLED" | "PARTIAL" | "OPEN" | "CANCELLED";
  time: string;
}
