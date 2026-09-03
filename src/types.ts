/** Domain types for the THETHADUEL battle prototype. */

export type Market = "STOCK" | "CRYPTO";
export type MarketFilter = Market | "MIXED";
export type Direction = "over" | "under";
export type AutoMode = "demo" | "spectate";

/** Screens in the app. `battles → create → draft → study → pick → live → result`
 *  is the match flow; `lobby`, `parlay` and `cases` sit outside it. */
export type Tab =
  | "lobby"
  | "battles"
  | "create"
  | "draft"
  | "study"
  | "pick"
  | "live"
  | "result"
  | "parlay"
  | "cases";

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
}

export interface OrderRow {
  side: "BUY" | "SELL";
  instrument: string;
  size: string;
  px: string;
  status: "FILLED" | "PARTIAL" | "OPEN" | "CANCELLED";
  time: string;
}
