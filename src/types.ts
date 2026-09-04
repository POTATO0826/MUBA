/** Domain types for the THETADUEL prototype. */

export type Market = "STOCK" | "CRYPTO";
export type MarketFilter = Market | "MIXED";
export type Direction = "over" | "under";

/** The six sector groups the 12 raw `Asset.sector` values roll up into.
 *  Defined in `src/data/sectors.ts`; the groups partition the board. */
export type SectorKey = "SEMIS" | "TECH" | "MACRO" | "MAJORS" | "DEFI" | "MEME";

/** How much of the 200-print walk a duel actually runs for.
 *  Specs live in `src/data/modes.ts`. */
export type Mode = "BLITZ" | "QUICK" | "NORMAL";

/**
 * Screens in the app.
 *
 * `battles → room → spin → study → parlay → duel → result` is one match;
 * `create` feeds it a lobby. `lobby` (home) and `desk` sit outside it.
 */
export type Tab =
  | "lobby"
  | "battles"
  | "create"
  | "room"
  | "spin"
  | "study"
  | "parlay"
  | "duel"
  | "result"
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

export interface Player {
  name: string;
  initial: string;
  /** Avatar colour. */
  bg: string;
}

/** A lobby a player has published and is waiting to fill. */
export interface LobbyDef {
  /** URL-safe key. */
  id: string;
  name: string;
  host: Player;
  /** The sector groups the spin deals from. THE source of the book:
   *  `bookOf(lobby)` = `bookForSectors(sectors)`, in canonical board order. */
  sectors: readonly SectorKey[];
  /** How much of the walk this lobby's duel runs for, and with it the salts,
   *  the leg targets, the odds boost and the pick clock. Spec in
   *  `MODES[mode]` (`src/data/modes.ts`). */
  mode: Mode;
  /** Derived at construction from `sectors` (`marketOf(sectors)`) and kept on
   *  the lobby for presentation only — labels, colours, card art and the
   *  Battles filter. Never read it to build a book; read `sectors`. */
  market: MarketFilter;
  /** How many legs the spin fills — both slips run on the same tickers. */
  legs: number;
  /** Prize pool in ETH. Each player puts up half. */
  prize: number;
  status: "open" | "matched";
  /** Published from this browser. */
  mine: boolean;
  /** The second player, once the lobby is matched. On someone else's lobby
   *  the host is the opponent; on yours, this is. */
  opponent: Player | null;
  createdAgo: string;
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
