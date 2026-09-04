/** Domain types for the THETADUEL prototype. */

export type Market = "STOCK" | "CRYPTO";
export type MarketFilter = Market | "MIXED";
export type Direction = "over" | "under";

/** Live-data duel modes introduced by the invite-room flow. */
export type GameMode = "parlay" | "spotdiff";

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
 * `create` feeds it a lobby. `lobby` (home), `desk` and `ranks` (the ladder)
 * sit outside it — they carry no lobby and no seed.
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
  | "desk"
  | "ranks"
  | "arena";

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
  /** The colour/label bucket `/desk` renders. Three members on purpose — the
   *  finer reading lives in `structure`. */
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
   * Signed distance from the median IV of this row's (underlying, expiry,
   * call/put) group — `+0.08` is 8% rich to its own smile.
   *
   * Live rows only, and only when the order carried greeks: the order book
   * publishes no fair value, so a quote's distance from its neighbours is the
   * only honest mispricing signal available. `undefined` means "unscoreable",
   * which is a real state (`rawApiData.greeks` is undocumented and may be
   * absent) and is what `playableRows` filters on. Never set on the mock.
   */
  edge?: number;
  /** `(bid + ask) / 2`, 4dp, only when both sides are quoted. A one-sided
   *  level has no midpoint, so this is `undefined` rather than a guess. */
  mid?: string;
  /**
   * What the strikes actually describe: `CALL | PUT | SPREAD | FLY | CONDOR |
   * RANGER`. Set by `classify()` in `src/server/thetanuts.ts`.
   *
   * Separate from `type` because a four-strike order is a condor *or* a ranger
   * and the SDK's payout math prices it as a condor unless told otherwise —
   * this is the field that will carry that decision to `isRanger`.
   */
  structure?: string;
  /**
   * The `PayoutType` string the SDK's payout math wants for this row —
   * `'call' | 'put' | 'call_spread' | ... | 'ranger'`, lowercase snake_case.
   *
   * Three namespaces name these shapes and none of them share strings
   * (FINDINGS "0.3.0 delta"): `PayoutType` here, the UPPER_SNAKE `ProductName`
   * registry (`RANGER`), and `OptionStructure`, which has no ranger at all.
   * This field carries the *payout* one and only that, resolved once on the
   * server by `payoutTypeFor()` so no client has to guess which namespace it is
   * holding. Live rows only; never set on the mock.
   */
  payout?: string;
}

/**
 * One market-maker quote, as `/desk` renders it.
 *
 * This is `client.mmPricing.getPricingArray('ETH'|'BTC')` — a different feed
 * from the signed order book that fills `PricingRow`, and the reason the desk
 * can show two-sided prices at strikes nobody has a resting order on.
 *
 * Strings, like `PricingRow`, because formatting a live number is a decision
 * (how many decimals is an honest ask?) and it is made once, on the server,
 * next to the field documentation rather than in a view.
 */
export interface MmQuote {
  /** `ETH-3SEP26-2100-C`, the MM's own instrument name. */
  ticker: string;
  type: "CALL" | "PUT";
  strike: string;
  expiry: string;
  /** `feeAdjustedBid`, verbatim. **Never** recomputed from `rawBidPrice` — the
   *  docs and the shipped code disagree about the fee cap (4e-4 in
   *  `dist/index.js`, 3e-4 in `llms-full.txt`; FINDINGS §5.1) and the shipped
   *  number is the one the book will actually trade at. */
  bid: string;
  /** `feeAdjustedAsk`, verbatim. Same rule as `bid`. */
  ask: string;
  /** `markPrice`, verbatim. */
  mark: string;
  /** `ask - bid` of the two published fee-adjusted numbers. A subtraction of
   *  what the SDK sent, not a re-derivation of the fee adjustment. */
  spread: string;
}

/**
 * What a $1 fill of one resting order would actually buy.
 *
 * `client.optionBook.previewFillOrder(order, usdcAmount, referrer)` answers this
 * — and it is **synchronous** (FINDINGS "0.3.0 delta": the docs' two-field
 * description is wrong twice over; the shipped `.d.ts` returns a plain
 * ten-field object, not a Promise). It is computed on the server, at snapshot
 * build time, for one small fixed notional, because the SDK is not in the client
 * bundle and never will be — a browser that could preview a fill would be a
 * browser carrying axios, viem and ethers to draw a blotter.
 *
 * Preview is not a promise of a fill. Book depth on Base swung from 426 resting
 * orders to 130 inside one day, and this snapshot is up to 15 seconds old; P3
 * re-previews against a freshly fetched order immediately before it signs.
 */
export interface FillPreview {
  /** `numContracts`, 18dp, rendered to 4. */
  contracts: string;
  /** `totalCollateral` — the USDC (6dp) actually spent, rendered to 2. This is
   *  the number P3 approves *exactly*, never `MaxUint256`. */
  collateral: string;
  /**
   * The book-depth guard, and the only field the view branches on.
   *
   * `false` is `numContracts === 0n`: the maker's remaining collateral will not
   * absorb even the quote notional, so the row greys out and reads "no fill
   * available". That is a normal state on a thin book, not an error — the demo
   * never assumes a fill exists.
   */
  fillable: boolean;
}

export interface OrderRow {
  side: "BUY" | "SELL";
  instrument: string;
  size: string;
  px: string;
  status: "FILLED" | "PARTIAL" | "OPEN" | "CANCELLED";
  time: string;
  /** Live rows only, and only when the client exposed `optionBook`. Absent
   *  means "not previewed", which is different from "cannot fill" — the mock
   *  never carries it and its rows are never greyed. */
  preview?: FillPreview;
}
