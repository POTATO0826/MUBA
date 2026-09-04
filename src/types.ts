/** Domain types for the THETADUEL prototype. */

export type Market = "STOCK" | "CRYPTO";
export type MarketFilter = Market | "MIXED";
export type Direction = "over" | "under";

/**
 * Live-data duel modes introduced by the invite-room flow.
 *
 * One member, deliberately. The two it replaced — `"parlay"` and `"spotdiff"`
 * — were the options chain and the order ticket wearing different hats, and
 * plan 7 §8 step 6 retires both in favour of the box arena. The name is what
 * the screen *is*: a box drawn on a price chart. It is **not** `"rfq"` — plan 7
 * §7 — because RFQ is one of the two execution paths a drawn box can take, and
 * the other one (a listed zone off the OptionBook) sends no quote request at
 * all.
 */
export type GameMode = "box";

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

/**
 * One resting signed order, as every layer of this app reads it.
 *
 * Declared here — the domain-type module nothing imports — rather than in
 * `src/desk/fill.ts`, because a `PricingRow` now carries the order it would
 * fill against and `src/engine/**` must be able to name that shape without
 * reaching into the desk. `RawFillOrder` (desk) and `RawOrderEntry` (the market
 * builder) are both structurally assignable to this; it is deliberately the
 * *loosest* of the three, so it can be the shared vocabulary rather than a
 * fourth opinion.
 *
 * Every `bigint` is widened to `string | bigint` for the same reason it is
 * there: JSON has no bigint, and a checked-in fixture must be assignable.
 */
export interface FillableOrder {
  order: {
    /** Price per contract, 8dp. */
    price: string | bigint;
    /**
     * **`true` marks the side the TAKER buys — i.e. the maker's ASK, and the
     * rows a player can fill.** The field name says the opposite; it was
     * measured against the venue's own two-sided quotes and against settled
     * on-chain positions, and the full evidence is on
     * `RawOrderEntry.order.isBuyer` in `src/server/thetanuts.ts`.
     *
     * This docstring previously read "this order is a bid … only `false` rows
     * are fillable by a player", which is exactly backwards. A `false` row is
     * the maker bidding; filling it makes the player the *writer* — collateral
     * posted, downside unbounded — which is the one position plan 6 §5 and plan
     * 7 §5 forbid by construction.
     */
    isBuyer: boolean;
    /** The order's identity on the book. */
    nonce?: string | bigint;
    /**
     * The **option's** expiry, unix seconds.
     *
     * Distinct from `rawApiData.orderExpiryTimestamp`, which is when the
     * *signature* goes stale. The two differ by hours on live data (the
     * frozen capture has 1788595200 against 1788514414), and only this one
     * names the contract a card is a claim on — so it is the one a market
     * slice's expiry is matched against, and the one an MM mark is joined on.
     */
    expiry?: string | bigint;
  };
  /** Remaining fillable size, in collateral units. */
  availableAmount?: string | bigint;
  signature?: string;
  makerAddress?: string;
  rawApiData?: {
    /** The order signature's expiry, seconds — the one that turns a fill into
     *  `Signer Not Authorized` when it passes. */
    orderExpiryTimestamp?: number;
    /** 8dp decimal strings. */
    strikes?: string[];
    isCall?: boolean;
    optionBookAddress?: string;
    collateral?: string;
    priceFeed?: string;
    implementation?: string;
    /** Undocumented upstream. Shape-checked at the boundary, never trusted. */
    greeks?: unknown;
  };
}

/**
 * One resting order, narrowed to **exactly** what a strike ladder reads.
 *
 * The five fields below are the whole of what `deriveLadders` in
 * `src/data/box.ts` touches, and the omissions are the point — see
 * {@link LadderBook} for the accounting.
 *
 * Shapes here are the *wire's* shapes, not the reader's: `LadderOrder` in
 * `src/data/box.ts` widens every one of these (`string | bigint | number |
 * null`) because it must also accept a checked-in fixture and a truncated
 * response. This is what the server actually emits, so it is exact. The two are
 * asserted assignable — `LadderBook` → `LadderSnapshot`, no adapter and no cast
 * — at compile time in `test/market-builder.test.ts`.
 */
export interface LadderBookOrder {
  order: {
    /**
     * The **option's** expiry, unix seconds — the column of the time axis.
     *
     * A string, like the capture's own encoding, and not a number: this is one
     * of the two expiries on a raw order and the *other* one
     * (`orderExpiryTimestamp`) is a number upstream. Keeping the encodings
     * distinct is a small standing reminder that they are different fields.
     */
    expiry: string;
  };
  /** Remaining fillable size. Carried as the fillability flag `deriveLadders`
   *  reads it as — an order with none is not quoting a rung. */
  availableAmount: string;
  rawApiData: {
    /** Chainlink feed address — how an order names its underlying. Resolved
     *  through {@link LadderBook.chainConfig}'s `priceFeeds`, never here. */
    priceFeed: string;
    /** 8dp decimal strings. A multi-leg order contributes all of them. */
    strikes: string[];
    /** The *signature's* expiry. Absent when the capture carried none, which is
     *  a real state: `deriveLadders` then judges the option expiry alone. */
    orderExpiryTimestamp?: number;
    /**
     * The deployed option-implementation contract this order is an instance of.
     *
     * The ladder does not read it — an axis does not care what product quoted a
     * rung — but `listedZones` in `src/data/ranger.ts` cannot answer without it,
     * and it is the **only** field that can: `validateCondor` and
     * `validateRanger` accept the identical strike arrays (`dist/index.js:16838`,
     * `:16871`), so a four-strike order's shape decides nothing. Resolved
     * through {@link LadderBook.chainConfig}'s `optionImplementations`, never
     * here, and never against a hard-coded address.
     *
     * Absent when the capture carried none, which is a real state and an honest
     * one: `productOf` answers `null` and the order is simply not a listed zone.
     */
    implementation?: string;
    /**
     * Which side the **maker** is on, as the API ships it.
     *
     * `false` means the taker is the buyer — the one side plan 7 §5 permits a
     * player to take, and the gate `isTakerBuyable` in `src/data/ranger.ts`
     * applies before it will offer a zone to fill.
     *
     * **This is not the side filter `deriveLadders` refuses.** That refusal is
     * about where the *axis* has rungs, and it stands: 23 of the 30 orders in
     * the frozen capture are maker bids and dropping them empties the ETH 5 Sep
     * ladder entirely. This field is read by the *fill* path, which is the place
     * `deriveLadders`' own docblock says the question belongs — and `order.
     * isBuyer`, the field that would let someone filter the ladder by side, is
     * still not carried.
     */
    isLong?: boolean;
  };
  /**
   * What one contract of this zone costs — carried **only** for orders the
   * implementation registry names `RANGER`, which are the only ones the arena
   * can fill straight off the book (plan7 §3.1, `src/data/ranger.ts`).
   *
   * ## Why it travels rather than being computed in the browser
   *
   * `previewFillOrder` reads `order.price`, `order.maker`, `rawApiData.collateral`,
   * `rawApiData.isCall` and `rawApiData.maxCollateralUsable`
   * (`dist/index.js:1713`). **The narrowing above carries none of them**, and
   * they are not carried on purpose — they are the fill path's fields, and the
   * signature that would make them useful is the single largest thing this type
   * exists to drop. So the browser cannot preview a zone, and the arena's
   * premium is either this number or nothing at all.
   *
   * Absent is ordinary and means "not quoted": the mock has no book, a
   * non-`RANGER` order is never asked, and the SDK throws `ORDER_EXPIRED` on
   * orders the indexer is still serving. The arena then renders no multiple at
   * all, which is plan7 §4.4's rule — never a placeholder, never an estimate.
   */
  quote?: ZoneQuote;
}

/**
 * What one contract of a listed zone costs, off `previewFillOrder`.
 *
 * ## Why this is not {@link FillPreview}
 *
 * The desk asks "what does a dollar buy"; the arena asks "what does one
 * contract cost", because plan7 §4.4's payout multiple is `max payout ÷
 * premium` and the max payout is per contract. `FillPreview` answers the first
 * question and cannot be run backwards into the second at the precision the
 * arena needs: its `contracts` is rendered to four decimals, and on a live BTC
 * `RANGER` at $333.92 a contract, one dollar buys 0.002994 — which prints
 * `"0.0000"`, and a premium derived from that is a division by zero.
 *
 * So this carries `pricePerContract`, **verbatim**, which is one of
 * `previewFillOrder`'s own ten fields and is exactly `order.price`. It is not a
 * mid, not a mark, and not a re-derivation: the same call answers both shapes,
 * and each surface is handed the field it actually renders.
 */
export interface ZoneQuote {
  /**
   * `pricePerContract`, US dollars, from 8dp. The premium a player pays for one
   * contract and — plan7 §4.3 — the whole of what they can lose.
   */
  premium: string;
  /**
   * `numContracts > 0n` at the quote notional — the book-depth guard, the same
   * one {@link FillPreview.fillable} is.
   *
   * `false` means the maker's remaining collateral will not absorb even the
   * notional we asked about, so there is no size at which this zone can be
   * bought right now. An ordinary reading of a thin book, not an error, and the
   * arena shows no premium for it rather than a price nobody can trade.
   */
  fillable: boolean;
}

/**
 * The strike ladder's own slice of a raw `fetchOrders()` capture — the whole of
 * what plan 7's arena needs from the book, and nothing else.
 *
 * ## Why this type exists at all
 *
 * `OrderRow` is a *display* projection: side, instrument, size, px, status,
 * time. Every ladder input has been spent building it — `rawApiData.strikes`
 * became a formatted `instrument` string, `priceFeed` was resolved to a symbol
 * and discarded, `order.expiry` became a label. So the browser cannot rebuild a
 * ladder from `/api/market` as it stood, and `src/data/box.ts` is pure and
 * cannot fetch one. The raw capture has to travel, and this is the narrowest
 * form of it that still answers.
 *
 * ## What was dropped, and why
 *
 * A live capture is ~426 orders and ~325KB; the frozen 30-order fixture is
 * 39,478 bytes and narrows to **9,523** (a 76% cut, ~300 bytes an order).
 * Everything below went, per order:
 *
 *  - `signature` — 132 hex characters, the single largest field on the object,
 *    and only the fill path signs anything.
 *  - `order.maker`/`taker`/`option`/`collateralToken`/`underlyingToken`/
 *    `nonce`/`deadline`/`optionType`/`numContracts`/`strikePrice`/`price`/
 *    `isBuyer`, and `makerAddress` — identity, counterparty and price. A ladder
 *    is an *axis*: it says where the venue quotes, not at what, to whom, or on
 *    which side. `deriveLadders`' docblock is explicit that filtering by side
 *    here would be wrong (it empties the most interesting ETH ladder), so the
 *    field that would let someone do it is not carried. **`order.isBuyer` is
 *    still not carried after the zone fields below were added**, and the
 *    distinction is exact: `rawApiData.isLong` reaches the *fill* path, which
 *    is where `deriveLadders` says the side question belongs, and it does not
 *    reach the ladder.
 *  - `rawApiData.greeks`/`isCall`/`collateral`/`optionBookAddress`/
 *    `extraOptionData`/`maxCollateralUsable` — the desk's inputs. `/desk` is
 *    served by `pricing`, already built, on the same envelope. (A listed zone
 *    publishes **no greeks at all** — 0 of 38 orders over 32 reads of the live
 *    book — so the arena loses nothing by their absence, and `src/data/
 *    ranger.ts` has no field to hang an invented delta on.)
 *  - the capture's `prices` and the rest of `chainConfig` (`tokens`,
 *    `contracts`). Spot has its own envelope field.
 *
 * ## What was added back, and what it cost
 *
 * Three fields, for one feature: `listedZones` in `src/data/ranger.ts` matches a
 * drawn box against a **listed RANGER** and fills it straight off the book with
 * no market-maker round trip. It worked in tests and returned `[]` in the
 * browser, because the narrowing above dropped exactly what it reads.
 *
 * Measured on the frozen capture, `6,732 → 9,523` bytes:
 *
 *  - `rawApiData.implementation` — 2,301 bytes across 30 orders, with `isLong`
 *    below. The registry key, and the **only** field that can say what a
 *    four-strike order is: `validateCondor` and `validateRanger` accept the
 *    identical arrays, so the strikes decide nothing (`docs/reviews/
 *    mcp-crosscheck.md` §BUG-2).
 *  - `rawApiData.isLong` — the taker-buyable gate, plan 7 §5. A zone the player
 *    would be *writing* must never be offered, and this is the field that says.
 *  - `chainConfig.optionImplementations` — **490 bytes**, seven entries, cut to
 *    the addresses the shipped orders actually name. The chain's own table is
 *    46 entries (~3.9KB) and shipping it whole would be paying six times over
 *    for a question about seven addresses.
 *
 * Nothing else was widened. The rule the addition was made under is that a
 * field crosses when a feature cannot work without it, at the size that feature
 * needs, and the accounting is written down here so the next one has to be
 * argued for the same way.
 *
 * Orders that could never contribute a rung under **any** clock are dropped
 * whole. Nothing is dropped for being *expired*: that is a judgement against a
 * clock, `deriveLadders(snap, at)` is where it belongs, and a server that made
 * it here would hand the browser a book already filtered by a staler `now`.
 *
 * No deduplication. Collapsing orders that narrow to the same tuple was
 * measured on the frozen capture and saves nothing — all 30 are distinct, since
 * each carries its own `orderExpiryTimestamp` — so the pass would be complexity
 * bought with a risk that a later reader of `availableAmount` finds the depth
 * silently halved.
 */
export interface LadderBook {
  orders: LadderBookOrder[];
  chainConfig: {
    /**
     * `chainConfig.priceFeeds`, verbatim — 10 keys over 8 assets, ~522 bytes.
     *
     * Carried whole rather than pre-resolved because the collapse it feeds is
     * *by address*: `ETH/USD` and `ETH` hold the identical address, and
     * deduplicating by key instead would put ETH on the ladder twice.
     * `feedIndex` in `src/data/qualify.ts` is the one place that collapse
     * happens, and it wants the map.
     */
    priceFeeds: Record<string, string>;
    /**
     * Implementation address → product name, keyed by **lowercase** address —
     * and cut to the addresses the orders above actually name.
     *
     * The chain's own table is 46 entries over 15 products, ~3.9KB. Seven
     * addresses appear in the frozen capture, so seven travel; a capture naming
     * none carries no field at all. That is the whole of the concession: the
     * registry rides because a feature needs it, at the size the book being
     * shipped requires, and never at the size the chain happens to have.
     *
     * `{ name }` and nothing else — the SDK's entries also carry `type` and
     * `numStrikes`, and no reader on either side of the wire reads either.
     *
     * Absent means *"this capture named no implementation we could resolve"*,
     * and `listedZones` reads a falsy registry as no listed zones — the honest
     * answer, since the strikes cannot decide.
     */
    optionImplementations?: Record<string, { name: string }>;
  };
}

/**
 * The arena one round is played in — what the spin deals.
 *
 * The reel picks the arena; the player picks the position. Nothing on this
 * object can set anyone's odds: it names an underlying, an expiry and a strike
 * window, and the book decides what those are worth. A multiplier, a
 * probability or a payout on here would be the house setting the price again.
 *
 * Defined in this module rather than in `src/engine/spin.ts` because both the
 * engine (which deals it) and the card builder (which filters the book with it)
 * need the shape, and neither may import the other's module.
 */
export interface MarketSlice {
  underlying: string;
  /** Unix seconds. One of the live **option** expiries at deal time. */
  expiry: number;
  /** Inclusive strike window, 8dp decimal strings — the same encoding
   *  `rawApiData.strikes` uses, so the comparison is exact integer work and
   *  never a float round trip. */
  strikeLo: string;
  strikeHi: string;
  /** Optional constraint that makes rounds feel different without touching
   *  anyone's odds. */
  constraint?: "CALLS_ONLY" | "PUTS_ONLY" | "MAX_3_LEGS" | "BUDGET_5";
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
   * absent). Never set on the mock.
   *
   * **Nothing reads it today.** `src/data/board.ts`'s `playableRows` filtered on
   * it for the two edge-scored arena modes, and plan 7 §8 step 6 retired the
   * screens and the module together — §9's "`edge`-based scoring has no
   * remaining call sites". It is still computed and still asserted by
   * `test/market-builder.test.ts` because it is a measurement of the live book
   * rather than a fixture, and the arena's own scoring is not built yet; the
   * honest state of the field is "published, unread", and it says so here
   * rather than reading as load-bearing.
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
  /**
   * `markPrice`, verbatim from the market-maker chain. **Never recomputed** —
   * same rule as `bid`/`ask`, and for the same reason: the venue's own number
   * is the one it will trade against.
   *
   * Present only where an MM quote joined this level on (underlying, call/put,
   * strike, **option** expiry). MM pricing exists for two underlyings, so most
   * live rows carry no mark and every mock row carries none. Absent is a
   * first-class state: a row with no mark cannot be marked to market, which is
   * a fact about the feed rather than a reason to invent a mid.
   */
  mark?: string;
  /**
   * The **market maker's own name** for the instrument whose mark joined this
   * row — `ETH-3SEP26-2100-C`, with the year.
   *
   * Set together with `mark` and by the same join, off the same `RawMmQuote`,
   * or absent together with it. That atomicity is the field's whole job: two
   * namespaces name the same option on Base and they do not agree, because the
   * order book's `OrderRow.instrument` is built here as `ETH-3SEP-4400-C`
   * (no year, composed from an expiry label) while the MM chain ships the SDK's
   * own string. `src/server/attest.ts` keys its marks map by the second, so a
   * fill that wants to be scoreable has to carry the second — and the only
   * honest way to get it is to COPY it off the row the mark came from.
   *
   * Never translate one namespace into the other. `FilledLeg.instrument`'s
   * docstring names a synthesised instrument name as the one failure mode that
   * pays the wrong player quietly; a near-miss key is worse than no key,
   * because no key refunds and a near miss silently marks the wrong thing.
   */
  markTicker?: string;
  /**
   * `mark`, converted to **US dollars per contract** — `markPrice ×
   * underlyingPrice`, both read off the SAME market-maker row.
   *
   * This is the only mark-shaped number on this row the duel clock may score
   * on, and it exists because `mark` is NOT in dollars: the venue quotes in
   * units of the underlying (`tnuts-test/FINDINGS.md` §1), so an ETH call
   * marked `0.1155` is 0.1155 ETH, ~$276 at the spot it was quoted against.
   * A fill pays USDC, so scoring the unconverted number against the premium is
   * wrong by a factor of spot. See `src/engine/score.ts` §Units.
   *
   * Note the row's own asymmetry while you are here: `bid`, `ask` and `mid` come
   * off the signed order book and are already USDC per contract, `mark` comes
   * off the market maker and is not. They sit in the same row and they are not
   * comparable. That is the venue's design, not this app's, and the way to
   * survive it is to never treat one of these fields as a substitute for
   * another.
   *
   * Derived, not verbatim — so it is a *new* field beside `mark` rather than a
   * rewrite of it. The rule that the venue's own traded number is never
   * recomputed still holds: `mark` is untouched and is what `/desk` prints.
   *
   * Absent when the quote carried no `underlyingPrice`. A row with a mark and
   * no spot is a row the duel cannot score, and it says so by absence rather
   * than by reaching for a price out of `MarketSnapshot.spot`, which is a
   * different feed read at a different instant.
   */
  markUsd?: string;
  /**
   * The resting order this row would fill against — the **best ask**, i.e. the
   * cheapest order whose maker is selling.
   *
   * Rows built from bids alone, or from MM pricing alone, have no fillable
   * order: you cannot buy from a bid. Those rows are **display-only** and
   * `cardsForSlice` filters them out, because a card that quotes a number it
   * cannot fill is the exact failure this shape exists to delete.
   */
  order?: FillableOrder;
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
  /** `markPrice`, verbatim — and **in units of the underlying**, not dollars.
   *  An ETH call at `0.1155` is 0.1155 ETH (FINDINGS §1). `markUsd` is the
   *  dollar figure; this one is what the venue published and what `/desk`
   *  prints. */
  mark: string;
  /** `underlyingPrice`, verbatim — the spot THIS quote was made against, which
   *  is why it is carried on the row rather than looked up in
   *  `MarketSnapshot.spot`. `"—"` when the quote published none, in which case
   *  `markUsd` is absent too. */
  spot: string;
  /**
   * `mark × spot`, **US dollars per contract** — the only mark on this row the
   * duel clock may score against, for the reason `PricingRow.markUsd` gives at
   * length. Absent when the quote carried no `underlyingPrice`: no spot, no
   * dollar price, no score, and the duel refunds rather than guessing.
   *
   * Derived, and therefore a field of its own: `mark` stays verbatim.
   */
  markUsd?: string;
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
