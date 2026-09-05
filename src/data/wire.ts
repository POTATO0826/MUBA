import type { Brief } from "./briefs.ts";
import { seededRandom } from "../engine/spin.ts";
import { TAPE_LEN, fmtPx, pctAt, series } from "../engine/tape.ts";
import { meta } from "./universe.ts";

/**
 * The seeded news wire — the offline half of the study terminal.
 *
 * Four filed stories per dealt ticker, drawn from an UP or a DOWN pool by the
 * same rule `briefs.ts` uses (`pctAt(sym, salt, TAPE_LEN) >= 0`), so the wire
 * can never contradict the chart sitting beside it. Every figure in a body is
 * either read off the generated tape or drawn from the match's own seeded
 * sequence, which means two screens on the same (syms, salt) render the same
 * bytes — and a body is never empty, so the detail pane can never be blank.
 *
 * Nothing here is imported by `src/engine/**` or `src/state/match.ts`: the wire
 * is flavour, and settlement must not be able to see it.
 *
 * NOTE (build order): plan 2 lists `WireItem` as living in `src/data/news.ts`,
 * which is Wave 2's file and does not exist yet. The interface is defined here
 * so Wave 1 can ship standalone; when `news.ts` lands it should re-export it
 * (`export type { WireItem } from "./wire.ts"`) rather than redeclare it, and
 * own `WireRequest` / `WireResult` / `NewsSource` itself.
 */
export interface WireItem {
  /** Stable within a (syms, salt) render — the list's React key and selection id. */
  id: string;
  kind: "news" | "desk";
  /** `null` for market-wide rows; the terminal renders those as "MKT". */
  sym: string | null;
  /** Epoch ms. The sort key — the feed is strictly descending. */
  ts: number;
  /** "07:47:14", ET session clock. */
  time: string;
  /**
   * The ET calendar day that clock belongs to — "THU · 09-04-26".
   *
   * `time` alone cannot say "yesterday", and a live wire routinely spans a week
   * (`when:7d` on the Google News query), so a feed that is *perfectly*
   * ts-descending still reads as scrambled the moment it crosses midnight:
   * `04:08:51` sits directly above `21:23:32` and every reader calls that a
   * sort bug. The order was never wrong; the stamp was ambiguous. This is the
   * field that makes it unambiguous — `NewsWire` opens a day band whenever it
   * changes, so the descent is legible rather than merely true.
   *
   * Formatted wherever `time` is formatted and never anywhere else: here for
   * the seeded wire, and SERVER-side in America/New_York for the live one. A
   * client-side `new Date(ts).getUTCDate()` would put two players in two zones
   * on two different day boundaries, which is the exact desync the server-side
   * ET formatting exists to prevent.
   *
   * Optional because a `WireItem` also arrives as untyped JSON off `/api/news`:
   * a payload without it draws the terminal exactly as it drew before day bands
   * existed, rather than throwing or inventing a date.
   */
  day?: string;
  headline: string;
  /** "REUTERS", "COINDESK", … */
  publisher: string;
  /** Never empty. */
  body: string;
  bodyKind: "wire" | "seeded" | "desk-note";
  link: string | null;
  /** "9/1/26 09:28:00: NVDA: Nvidia Climbs 3.2% …" */
  dateline: string;
  /** "(END) REUTERS / 09-01-26 0928ET / Copyright (c) 2026 Thomson Reuters." */
  signature: string;
  /**
   * What in this row's **own words** ties it to price — see {@link priceSignal}.
   *
   * Evidence, not a score. Each entry names the thing that matched ("quotes a
   * move of 3.2%"), so the terminal can show the reader *why* a row survived
   * its price filter instead of asking them to trust a number. Absent or empty
   * means the classifier found none of the three markers, which is a statement
   * about the text and emphatically **not** a claim that the story did not move
   * the price. Nothing in this app can know that.
   *
   * Optional because a `WireItem` also arrives as untyped JSON off `/api/news`:
   * an older envelope without it leaves every row unmarked, and the terminal's
   * filter simply reports that it has nothing to go on.
   */
  signal?: readonly string[];
  /** Desk rows only: "DESK" | "COACH". */
  who?: string;
}

/** Everything a template may interpolate. Tape-derived fields are stable per
 *  ticker; the flavour figures are drawn per item from the match sequence. */
export interface WireCtx {
  sym: string;
  name: string;
  /** Raw sector, as the universe spells it. */
  sector: string;
  /** Same, lowercased — how `briefs.ts` puts a sector into prose. */
  sectorLc: string;
  /** Absolute study-window move, one decimal: "3.2". */
  move: string;
  /** Signed study-window move: "+3.2%" / "−3.2%". */
  signed: string;
  /** Last print of the window, formatted. */
  px: string;
  lo: string;
  hi: string;
  /** "112.40–121.85". */
  range: string;
  /** Realised per-step vol in percent: "3.0". */
  vol: string;
  /** The leg target this name carries: "4.0". */
  target: string;
  // ── seeded flavour figures ────────────────────────────────────────────────
  /** "$41.7 billion". */
  rev: string;
  /** "$812 million". */
  earn: string;
  /** "180". */
  bp: string;
  /** "11". */
  analysts: string;
  /** "6.4". */
  share: string;
  /** "$1.8 billion". */
  notional: string;
  /** "$940 million". */
  flow: string;
  /** "2.4 million contracts". */
  contracts: string;
  /** "$3.20 billion". */
  tvl: string;
  /** "412,000". */
  holders: string;
}

interface Template {
  head: (c: WireCtx) => string;
  body: (c: WireCtx) => string;
}

/**
 * The direction invariant, in words. Every UP headline carries at least one
 * `UP_WORDS` verb and no `DOWN_WORDS` verb; every DOWN headline the reverse.
 * `test/wire.test.ts` reads these to prove a ticker that rose can never draw a
 * bearish headline.
 */
export const UP_WORDS = ["Climbs", "Rises", "Jumps", "Rallies", "Gains", "Surges", "Advances", "Extends", "Powers"] as const;
export const DOWN_WORDS = ["Slides", "Falls", "Sinks", "Drops", "Slips", "Retreats", "Tumbles", "Skids", "Fades"] as const;

/** Filed stories per dealt ticker. Four is enough that a 4-leg case reads as a
 *  real wire without a template repeating inside any one ticker. */
export const WIRE_PER_SYM = 4;

const STOCK_UP: readonly Template[] = [
  {
    head: (c) => `${c.sym} Climbs ${c.move}% As ${c.name} Lifts Full-Year Guidance`,
    body: (c) =>
      `${c.name} guided full-year revenue to ${c.rev}, ${c.bp} basis points above the prior range, and said order coverage into the back half is running ahead of plan. ${c.sym} printed ${c.px} at the close of the study window against a ${c.range} band. Call skew has richened for a third session; realised volatility on the name runs ${c.vol}% daily.`,
  },
  {
    head: (c) => `${c.name} Rises ${c.move}% After ${c.earn} Quarter Beats the Street`,
    body: (c) =>
      `Quarterly sales of ${c.earn} came in ahead of consensus, with management crediting ${c.share}% growth in the ${c.sectorLc} book. ${c.analysts} sell-side desks lifted targets inside the hour. The tape carried ${c.sym} from ${c.lo} to ${c.hi} across the window, closing ${c.signed}.`,
  },
  {
    head: (c) => `${c.sym} Jumps ${c.move}% on ${c.notional} Buyback Authorization`,
    body: (c) =>
      `The board authorised ${c.notional} of repurchases, its largest programme to date, and left the dividend unchanged. ${c.sym} last traded ${c.px}, ${c.signed} across the study window. Desks put the authorisation at roughly ${c.share}% of shares outstanding at current prices.`,
  },
  {
    head: (c) => `${c.name} Rallies as ${c.sector} Rotation Broadens; ${c.sym} Up ${c.move}%`,
    body: (c) =>
      `Money has rotated back into ${c.sectorLc} names for a third session and ${c.name} is taking the largest share of it. ${c.sym} closed the window at ${c.px}, inside a ${c.range} range, on ${c.flow} of turnover. The put wing is being sold to fund the upside — the leg on this name clears at ${c.target}%.`,
  },
  {
    head: (c) => `${c.sym} Gains ${c.move}%; ${c.analysts} Desks Move to Buy on ${c.name}`,
    body: (c) =>
      `${c.analysts} desks moved ${c.name} to buy before the open, citing ${c.rev} of visible backlog and a margin path management has yet to guide to. ${c.sym} is ${c.signed} across the study window at ${c.px}. Realised volatility of ${c.vol}% daily leaves the front expiry looking cheap against the move.`,
  },
  {
    head: (c) => `${c.name} Surges ${c.move}% After Contract Win Worth ${c.notional}`,
    body: (c) =>
      `${c.name} said it won work valued at ${c.notional} over the life of the contract, its largest single award in the ${c.sectorLc} segment. ${c.sym} printed ${c.px}, having traded ${c.range} across the window. ${c.analysts} analysts flagged the award as incremental to the standing outlook.`,
  },
  {
    head: (c) => `${c.sym} Advances ${c.move}% as Short Interest Thins to ${c.share}% of Float`,
    body: (c) =>
      `Short interest thinned to ${c.share}% of float from a multi-quarter high, and the borrow has loosened with it. ${c.sym} is ${c.signed} on the window at ${c.px}, inside ${c.range}. Desks read the cover as mechanical rather than fundamental, and none of them are fading it yet.`,
  },
  {
    head: (c) => `${c.name} Extends Run to ${c.move}%; Options Volume Tops ${c.contracts}`,
    body: (c) =>
      `Options volume topped ${c.contracts}, better than three times the twenty-day average, with the flow concentrated in front-expiry calls. ${c.sym} closed the study window at ${c.px}, ${c.signed}, having held a ${c.range} band. Dealers are short gamma into the print, which is why the tape trends rather than chops.`,
  },
];

const STOCK_DOWN: readonly Template[] = [
  {
    head: (c) => `${c.sym} Slides ${c.move}% After ${c.name} Trims Full-Year Outlook`,
    body: (c) =>
      `${c.name} trimmed its full-year outlook by ${c.bp} basis points, citing softer ${c.sectorLc} demand and a heavier promotional calendar. ${c.sym} printed ${c.px} into the close of the study window, a ${c.range} range. Front-expiry puts are trading through their theoretical value.`,
  },
  {
    head: (c) => `${c.name} Falls ${c.move}% as ${c.earn} Quarter Misses on Margin`,
    body: (c) =>
      `Sales of ${c.earn} landed short of consensus and gross margin gave back ${c.bp} basis points year over year. ${c.sym} is ${c.signed} across the window at ${c.px}, having traded ${c.range}. Management declined to reiterate the full-year margin target on the call.`,
  },
  {
    head: (c) => `${c.sym} Sinks ${c.move}%; ${c.analysts} Desks Cut Targets on ${c.name}`,
    body: (c) =>
      `${c.analysts} desks cut targets before the open, the deepest reduction taking ${c.share}% off the prior number. ${c.sym} traded ${c.range} across the study window and last printed ${c.px}. Realised volatility of ${c.vol}% daily is running above implied — a rare gift for anyone selling the move.`,
  },
  {
    head: (c) => `${c.name} Drops ${c.move}% as ${c.sector} Rotation Turns Defensive`,
    body: (c) =>
      `Rotation out of ${c.sectorLc} accelerated for a second session and ${c.name} is wearing the worst of it. ${c.sym} closed the window ${c.signed} at ${c.px} on ${c.flow} of turnover. The put wing is where the flow is; the leg on this name still needs ${c.target}%.`,
  },
  {
    head: (c) => `${c.sym} Slips ${c.move}% on ${c.notional} Restructuring Charge`,
    body: (c) =>
      `${c.name} booked a ${c.notional} charge tied to the restructuring announced last quarter and pushed the savings target out two quarters. ${c.sym} last traded ${c.px}, inside ${c.range}. ${c.analysts} desks left estimates unchanged pending the filing.`,
  },
  {
    head: (c) => `${c.name} Retreats ${c.move}% as Guidance Cut Runs ${c.bp} Basis Points Deep`,
    body: (c) =>
      `The cut runs ${c.bp} basis points deep and lands on a name that had already given back its ${c.sectorLc} premium. ${c.sym} is ${c.signed} across the study window at ${c.px}. Dealers are long gamma at this strike, so the tape chops rather than trends.`,
  },
  {
    head: (c) => `${c.sym} Tumbles ${c.move}%; Put Volume Tops ${c.contracts}`,
    body: (c) =>
      `Put volume topped ${c.contracts} and open interest built at the round numbers below spot. ${c.sym} printed ${c.px} against a ${c.range} band. ${c.flow} traded on the day, roughly double the twenty-day average.`,
  },
  {
    head: (c) => `${c.name} Skids ${c.move}% After Regulator Opens ${c.sector} Review`,
    body: (c) =>
      `The regulator opened a review of ${c.sectorLc} practices and named ${c.name} among the parties in scope. No penalty has been proposed and the company said it is cooperating. ${c.sym} closed the window ${c.signed} at ${c.px}, with ${c.analysts} desks putting the tail risk at under ${c.share}% of market value.`,
  },
];

const CRYPTO_UP: readonly Template[] = [
  {
    head: (c) => `${c.sym} Climbs ${c.move}% as Spot Bids Absorb ${c.notional} of Supply`,
    body: (c) =>
      `Spot bids absorbed ${c.notional} of offered supply without clearing the book, and depth has rebuilt above the prior range. ${c.sym} last traded ${c.px} against a ${c.range} band across the study window. Realised volatility on the pair runs ${c.vol}% daily.`,
  },
  {
    head: (c) => `${c.name} Rises ${c.move}%; Perp Funding Turns Positive at ${c.bp} Basis Points`,
    body: (c) =>
      `Perpetual funding flipped positive and now pays ${c.bp} basis points annualised to shorts, a level last seen ahead of the previous leg higher. ${c.sym} is ${c.signed} across the window at ${c.px}. Open interest built to ${c.notional} without a matching move in basis.`,
  },
  {
    head: (c) => `${c.sym} Jumps ${c.move}% on ${c.flow} of Net Inflows`,
    body: (c) =>
      `Net inflows of ${c.flow} landed across listed products in a single session, the heaviest print of the quarter. ${c.sym} closed the study window at ${c.px}, having traded ${c.range}. Desks put the creation basket at roughly ${c.share}% of daily volume.`,
  },
  {
    head: (c) => `${c.name} Rallies ${c.move}% as On-Chain Volume Tops ${c.flow}`,
    body: (c) =>
      `On-chain volume topped ${c.flow} over twenty-four hours, with the ${c.sectorLc} venues taking the bulk of it. ${c.sym} printed ${c.px}, ${c.signed} on the window. The leg on this name clears at ${c.target}%, and realised volatility of ${c.vol}% daily makes that a live number.`,
  },
  {
    head: (c) => `${c.sym} Gains ${c.move}%; ${c.holders} New Addresses in 24 Hours`,
    body: (c) =>
      `Roughly ${c.holders} new addresses touched the network over twenty-four hours and the median transfer size fell — a retail signature rather than a desk one. ${c.sym} traded ${c.range} across the study window and last printed ${c.px}. ${c.flow} of spot volume cleared in the same period.`,
  },
  {
    head: (c) => `${c.name} Surges ${c.move}% After ${c.sector} TVL Reaches ${c.tvl}`,
    body: (c) =>
      `Total value locked across ${c.sectorLc} venues reached ${c.tvl}, recovering the level held before the last unwind. ${c.sym} is ${c.signed} on the window at ${c.px}. Fee revenue annualises to ${c.flow} at the current run rate.`,
  },
  {
    head: (c) => `${c.sym} Advances ${c.move}% as Exchange Balances Thin`,
    body: (c) =>
      `Exchange balances thinned to a multi-quarter low as coins moved to cold storage, leaving less float against the bid. ${c.sym} closed the window at ${c.px}, inside ${c.range}. Some ${c.holders} addresses now hold a balance, and the top cohort has not sold into strength.`,
  },
  {
    head: (c) => `${c.name} Powers ${c.move}% Higher; Open Interest Builds to ${c.notional}`,
    body: (c) =>
      `Open interest built to ${c.notional} while funding stayed contained, which desks read as spot-led rather than leverage-led. ${c.sym} printed ${c.px}, ${c.signed} across the study window. Realised volatility of ${c.vol}% daily is running under the front-dated implied.`,
  },
];

const CRYPTO_DOWN: readonly Template[] = [
  {
    head: (c) => `${c.sym} Slides ${c.move}% as ${c.notional} of Longs Liquidate`,
    body: (c) =>
      `Roughly ${c.notional} of long positions liquidated across venues in under an hour, and the cascade cleared the resting bids beneath spot. ${c.sym} printed ${c.px} against a ${c.range} band. Funding has yet to normalise; realised volatility runs ${c.vol}% daily.`,
  },
  {
    head: (c) => `${c.name} Falls ${c.move}%; Funding Flips Negative at ${c.bp} Basis Points`,
    body: (c) =>
      `Perpetual funding flipped negative at ${c.bp} basis points annualised, with shorts now paid to hold the position. ${c.sym} is ${c.signed} across the study window at ${c.px}. Open interest fell with the price, which points to closure rather than to fresh shorts.`,
  },
  {
    head: (c) => `${c.sym} Sinks ${c.move}% on ${c.flow} of Net Outflows`,
    body: (c) =>
      `Net outflows of ${c.flow} left listed products over the session, the largest redemption print since the last unwind. ${c.sym} closed the window at ${c.px}, having traded ${c.range}. The leg on this name needs ${c.target}%, and the tape is not offering it.`,
  },
  {
    head: (c) => `${c.name} Drops ${c.move}% as ${c.sector} TVL Bleeds to ${c.tvl}`,
    body: (c) =>
      `Total value locked across ${c.sectorLc} venues bled to ${c.tvl} as incentives rolled off and capital rotated out. ${c.sym} last traded ${c.px}, ${c.signed} on the window. Fee revenue annualises to ${c.flow}, well down on the prior quarter.`,
  },
  {
    head: (c) => `${c.sym} Slips ${c.move}%; Exchange Inflows Top ${c.flow}`,
    body: (c) =>
      `Exchange inflows topped ${c.flow} over twenty-four hours — coins moving to venues rather than away from them, which the desk reads as supply. ${c.sym} traded ${c.range} across the study window and printed ${c.px}. Roughly ${c.holders} addresses moved a balance in the same period.`,
  },
  {
    head: (c) => `${c.name} Retreats ${c.move}% After Dormant Wallet Moves ${c.holders} Tokens`,
    body: (c) =>
      `A wallet dormant since the prior cycle moved ${c.holders} tokens to a venue address, and the tape found out inside a minute. ${c.sym} is ${c.signed} on the window at ${c.px}. Nothing has been sold yet — the ${c.share}% discount is the market pricing the option that it will be.`,
  },
  {
    head: (c) => `${c.sym} Tumbles ${c.move}% as Perp Open Interest Unwinds`,
    body: (c) =>
      `Perpetual open interest unwound by ${c.notional} without a matching bid in spot, leaving the book thin on both sides. ${c.sym} closed the study window at ${c.px}, inside ${c.range}. Realised volatility of ${c.vol}% daily is running above the front-dated implied.`,
  },
  {
    head: (c) => `${c.name} Fades ${c.move}%; Desks Mark ${c.sector} Risk Lower`,
    body: (c) =>
      `Desks marked ${c.sectorLc} risk lower into the weekend, cutting gross exposure by roughly ${c.share}% and standing away from the offer. ${c.sym} printed ${c.px}, ${c.signed} across the window. ${c.flow} of spot volume cleared, most of it inside the last two hours.`,
  },
];

const STOCK_PUBS = [
  "DOW JONES NEWSWIRES",
  "REUTERS",
  "BLOOMBERG",
  "MARKETWATCH",
  "BARRON'S",
  "THE WALL STREET JOURNAL",
] as const;

const CRYPTO_PUBS = ["COINDESK", "THE BLOCK", "COINTELEGRAPH", "DECRYPT", "BLOOMBERG CRYPTO"] as const;

const DESK_PUB = "THETADUEL DESK";

/** Whose copyright line closes the item. */
const OWNER: Readonly<Record<string, string>> = {
  "DOW JONES NEWSWIRES": "Dow Jones & Company, Inc.",
  REUTERS: "Thomson Reuters",
  BLOOMBERG: "Bloomberg L.P.",
  MARKETWATCH: "MarketWatch, Inc.",
  "BARRON'S": "Dow Jones & Company, Inc.",
  "THE WALL STREET JOURNAL": "Dow Jones & Company, Inc.",
  COINDESK: "CoinDesk, Inc.",
  "THE BLOCK": "The Block Crypto, Inc.",
  COINTELEGRAPH: "Cointelegraph",
  DECRYPT: "Decrypt Media, Inc.",
  "BLOOMBERG CRYPTO": "Bloomberg L.P.",
  [DESK_PUB]: "ThetaDuel Research",
};

/**
 * Words a story uses when it is reporting a move rather than an announcement.
 *
 * Present tense and past tense both, because a wire headline writes "Solana
 * Surges" and its body writes "surged". Exported so the classifier's vocabulary
 * is inspectable from a test rather than buried in a regex literal.
 */
export const MOVE_WORDS: readonly string[] = [
  "surge", "surges", "surged", "plunge", "plunges", "plunged",
  "rally", "rallies", "rallied", "jump", "jumps", "jumped",
  "slump", "slumps", "slumped", "tumble", "tumbles", "tumbled",
  "soar", "soars", "soared", "sink", "sinks", "sank", "sunk",
  "slide", "slides", "slid", "climb", "climbs", "climbed",
  "drop", "drops", "dropped", "fall", "falls", "fell", "fallen",
  "rise", "rises", "rose", "risen", "gain", "gains", "gained",
  "spike", "spikes", "spiked", "crash", "crashes", "crashed",
  "selloff", "sell-off", "rebound", "rebounds", "rebounded",
  "breakout", "outperform", "underperform", "extend", "extends", "extended",
  "record high", "all-time high", "52-week", "bear market", "bull market",
];

/**
 * Things that are known to move a price when they happen, named literally.
 *
 * A deliberately conservative list of *nouns*, not adjectives: an item that
 * says "ETF" or "SEC" or "hack" is talking about an event with a price
 * consequence, whereas an item that says "exciting" or "major" is talking about
 * itself. Multi-word entries are matched as phrases with flexible whitespace.
 */
export const EVENT_WORDS: readonly string[] = [
  "etf", "sec", "cftc", "federal reserve", "fed", "rate cut", "rate hike",
  "interest rate", "cpi", "inflation", "halving", "hack", "hacked", "exploit",
  "outage", "listing", "delisting", "listed", "inflow", "inflows", "outflow",
  "outflows", "liquidation", "liquidations", "unlock", "upgrade", "downgrade",
  "earnings", "guidance", "buyback", "lawsuit", "settlement", "approval",
  "approved", "rejected", "short squeeze", "open interest", "funding rate",
  "treasury", "acquisition", "merger", "partnership", "mainnet", "fork",
];

/**
 * The first vocabulary entry this text uses, or `null`.
 *
 * A lookup rather than a generated alternation, and deliberately so. The word
 * lists above are *data* — a future entry could legitimately contain a dot, a
 * dollar sign or a bracket — and a regex built by escaping data is a regex one
 * missed escape away from either throwing or, far worse, silently matching the
 * wrong thing and marking half the wire. There is no escaping here to get
 * wrong.
 *
 * Bounding is structural: the haystack is padded with a space, every run of
 * characters that is not alphanumeric (or `-`, which "sell-off" and "52-week"
 * need) collapses to one space, and every needle is searched for *with its own
 * spaces around it*. So "fell" cannot match inside "fellowship", "fed" cannot
 * match inside "federated", and multi-word entries like "rate cut" and
 * "all-time high" match as phrases for free.
 *
 * Order in the list is the order of preference, which is why the plain stem is
 * listed before its inflections: " surge " does not occur in "solana surges",
 * so the walk falls through to " surges " and reports the word the story
 * actually used.
 */
function firstWord(text: string, vocabulary: readonly string[]): string | null {
  const hay = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
  for (const w of vocabulary) {
    if (hay.includes(` ${w} `)) return w;
  }
  return null;
}

/** A percentage the text states itself: "3.2%", "21%", "-4.0 %". */
const PCT_RE = /(\d+(?:\.\d+)?)\s?%/;

/** A price the text states itself — a currency figure, or a grouped thousand.
 *  Bare small integers are not levels ("3 blockchains", "5 years"), which is
 *  why this wants either a symbol or a thousands separator to fire. */
const LEVEL_RE = /(?:[$€£]\s?\d[\d,.]*|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)/;

/**
 * What, in a story's own words, ties it to a price.
 *
 * ## The problem this is answering, and the honest limit of the answer
 *
 * The owner's note: *"news should only cover major news that's affecting each
 * crypto or stock's movements or smtg."* The wire was carrying every headline a
 * per-ticker feed returned, up to and including a stadium logo announcement,
 * sitting beside a chart the player is reading for behaviour.
 *
 * **What cannot be built here is a relevance score.** Nothing in this app knows
 * whether a story caused a move. There is no attribution data, no event study,
 * no per-headline price impact — and a number invented to stand in for one,
 * printed as though it were measured, would be exactly the fabrication this
 * session removed from the chart's date label. So this measures the only thing
 * a headline and a description actually contain: **whether the item talks about
 * price at all**, in three literal ways.
 *
 *  1. **It quotes a percentage.** A story reporting a move states the move.
 *  2. **It quotes a price level.** A currency figure or a grouped thousand.
 *  3. **It uses a move word or names a market event.** {@link MOVE_WORDS} and
 *     {@link EVENT_WORDS}, both word-bounded.
 *
 * Each hit is returned as a short sentence naming what matched, so a reader can
 * see the evidence rather than a coefficient. An empty result means *the text
 * carries none of the three markers* — nothing more. A quiet, genuinely
 * market-moving story written without a number would come back empty, and a
 * puff piece that happens to mention "$5 million partnership" would not. That
 * is why the terminal's filter is opt-in and reversible, and why nothing in
 * this app is allowed to delete an unmarked row.
 *
 * ## Where it may not go
 *
 * Presentation only, like the rest of the wire. `src/engine/**` and
 * `src/state/match.ts` are forbidden from importing this module at all
 * (`test/determinism.test.ts`), so no ranking derived from it can ever reach a
 * seed, a pick or a settlement.
 */
export function priceSignal(text: string): readonly string[] {
  if (!text) return [];
  const out: string[] = [];
  const pct = PCT_RE.exec(text);
  if (pct) out.push(`quotes a move of ${pct[1]}%`);
  const level = LEVEL_RE.exec(text);
  if (level) out.push(`quotes a level of ${level[0].trim()}`);
  const move = firstWord(text, MOVE_WORDS);
  if (move) out.push(`move word “${move}”`);
  const event = firstWord(text, EVENT_WORDS);
  if (event) out.push(`names “${event.toUpperCase()}”`);
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Fisher-Yates on a copy, driven by the match sequence. */
function shuffled<T>(list: readonly T[], random: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

/** The seeded session opens between 06:00 and 10:00 on its day. Filing walks
 *  forward from there by 30–900s a row, so a full feed closes well before the
 *  day does and the band above it can never split in two. */
const SESSION_OPEN_H = 6;
const SESSION_OPEN_SPAN_H = 4;

/**
 * The calendar day the seeded wire files its session on: **today**.
 *
 * ## What this replaced
 *
 * A hash. `windowSeed()` reproduced, byte for byte, the arithmetic inside
 * `windowLabel()` in `engine/tape.ts` so that the wire's datelines would land
 * inside the invented 2017–2024 "historical window" the chart cards were
 * labelled with. Both were fabrications, and reproducing the hash here made
 * them agree with each other — a wire datelined `FEB 2019` under a chart
 * labelled `NOV 2018 · FEB 2019` looks *more* real than either does alone,
 * which is precisely what made it worth removing. `docs/reality-check.md` §5.10
 * is the version of this a reader caught on screen: an AVAX story filed
 * eighteen months before Avalanche launched.
 *
 * `windowLabel` is gone. There is no historical window to date a story inside
 * any more, and there never was one to date it inside.
 *
 * ## Why today, and what that costs
 *
 * A fixture still has to carry a dateline — `time`, `day`, `dateline` and
 * `signature` are provenance, the terminal draws all four, and a wire with no
 * clock is not a wire. So the session is declared to be **the current UTC day**
 * and the clock walks within it. That is a fixture openly dated today rather
 * than a fixture dressed as history, it can never be impossible for any asset
 * on any board, and the terminal already chips the whole feed `SEEDED` beside
 * it.
 *
 * The cost is that `mockWire` reads a clock, and the clock is therefore an
 * argument: `nowMs` defaults to `Date.now()` and tests pass a fixed value. Two
 * players derive the seeded feed independently, so they agree exactly while
 * they are on the same UTC day and would differ by one date across a midnight
 * boundary. That is a real but narrow edge and it is the *fallback* feed:
 * whenever the live source answers, both seats replay one envelope frozen
 * server-side, which is the path the shared-wire guarantee actually runs on.
 * Trading a permanent falsehood for a once-a-day off-by-one date on the offline
 * fixture is the right side of that trade.
 *
 * Built in a UTC frame and read back with UTC getters, as it always was, so the
 * clock is the same on every machine no matter its zone — the synthetic session
 * is *declared* to be ET, not converted into it.
 */
function sessionStart(nowMs: number, random: () => number): number {
  const d = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const hh = SESSION_OPEN_H + Math.floor(random() * SESSION_OPEN_SPAN_H);
  const mm = Math.floor(random() * 60);
  const ss = Math.floor(random() * 60);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mm, ss);
}

function timeOf(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

const WEEKDAY = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/**
 * "THU · 09-04-26" — the day band's label.
 *
 * Read out of the same UTC frame `timeOf` reads, for the same reason: the
 * seeded session is *declared* to be ET rather than converted into it, so the
 * band and the clock above it can never disagree about which day a row is on.
 * The weekday is carried because "MON" beside a stamp is what tells a reader at
 * a glance that a run of rows is a different session, not a different minute.
 */
function dayOf(ts: number): string {
  const d = new Date(ts);
  const date = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}-${String(d.getUTCFullYear()).slice(2)}`;
  return `${WEEKDAY[d.getUTCDay()]} · ${date}`;
}

/** "9/1/26" — the dateline's American short date. */
function shortDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${String(d.getUTCFullYear()).slice(2)}`;
}

/** "(END) REUTERS / 09-01-26 0928ET / Copyright (c) 2026 Thomson Reuters." */
function signatureOf(publisher: string, ts: number): string {
  const d = new Date(ts);
  const stamp = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}-${String(d.getUTCFullYear()).slice(2)}`;
  const hhmm = `${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}`;
  const owner = OWNER[publisher] ?? publisher;
  // Owners that already end in "Inc." keep their own full stop — never doubled.
  const tail = owner.endsWith(".") ? owner : `${owner}.`;
  return `(END) ${publisher} / ${stamp} ${hhmm}ET / Copyright (c) ${d.getUTCFullYear()} ${tail}`;
}

interface Base {
  sym: string;
  up: boolean;
  ctx: Omit<WireCtx, "rev" | "earn" | "bp" | "analysts" | "share" | "notional" | "flow" | "contracts" | "tvl" | "holders">;
}

/** Everything the tape already knows about one ticker's study window. */
function baseFor(sym: string, salt: number): Base {
  const u = meta(sym);
  const s = series(sym, salt);
  const pct = pctAt(sym, salt, TAPE_LEN);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of s) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const last = s[s.length - 1] ?? u.px;
  return {
    sym,
    up: pct >= 0,
    ctx: {
      sym,
      name: u.name,
      sector: u.sector,
      sectorLc: u.sector.toLowerCase(),
      move: Math.abs(pct).toFixed(1),
      signed: `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`,
      px: fmtPx(last),
      lo: fmtPx(lo),
      hi: fmtPx(hi),
      range: `${fmtPx(lo)}–${fmtPx(hi)}`,
      vol: (u.vol * 100).toFixed(1),
      target: u.t.toFixed(1),
    },
  };
}

/** The nine flavour figures, one draw each, in a fixed order. */
function figuresFor(base: Base, random: () => number): WireCtx {
  return {
    ...base.ctx,
    rev: `$${(2 + random() * 90).toFixed(1)} billion`,
    earn: `$${Math.round(120 + random() * 900)} million`,
    bp: String(20 + Math.round(random() * 440)),
    analysts: String(3 + Math.round(random() * 16)),
    share: (0.5 + random() * 9.4).toFixed(1),
    notional: `$${(0.2 + random() * 9.6).toFixed(1)} billion`,
    flow: `$${Math.round(80 + random() * 900)} million`,
    contracts: `${(0.4 + random() * 4.6).toFixed(1)} million contracts`,
    tvl: `$${(0.4 + random() * 9).toFixed(2)} billion`,
    holders: `${Math.round(40 + random() * 900)},000`,
  };
}

/**
 * The seeded wire for one match.
 *
 * `deskLines` takes the output of `briefsFor()` whole — only its `kind: "desk"`
 * entries are used, and they are pinned to the top of the feed as the newest
 * rows, which is also what keeps `ts` strictly descending across the array.
 *
 * Draw order is fixed and total: per ticker, a template shuffle, a publisher
 * shuffle, then nine figures per item; then the interleave; then the clock.
 * Identical (syms, salt, deskLines) therefore render deep-equal output.
 */
export function mockWire(
  syms: readonly string[],
  salt: number,
  deskLines: readonly Brief[],
  /** The day the fixture files its session on — see {@link sessionStart}.
   *  Defaults to now; tests pass a fixed value so the feed stays pinnable. */
  nowMs: number = Date.now(),
): readonly WireItem[] {
  const random = seededRandom(salt * 131 + syms.length);

  interface Draft {
    sym: string;
    headline: string;
    publisher: string;
    body: string;
  }

  const drafts: Draft[] = [];
  for (const sym of syms) {
    const base = baseFor(sym, salt);
    const crypto = meta(sym).mkt === "CRYPTO";
    const pool = crypto ? (base.up ? CRYPTO_UP : CRYPTO_DOWN) : base.up ? STOCK_UP : STOCK_DOWN;
    const picks = shuffled(pool, random).slice(0, WIRE_PER_SYM);
    const pubs = shuffled(crypto ? CRYPTO_PUBS : STOCK_PUBS, random).slice(0, WIRE_PER_SYM);
    picks.forEach((t, i) => {
      const ctx = figuresFor(base, random);
      drafts.push({ sym, headline: t.head(ctx), publisher: pubs[i % pubs.length]!, body: t.body(ctx) });
    });
  }

  // Tickers interleave so the feed reads like a wire rather than a filing cabinet.
  const news = shuffled(drafts, random);

  const desk = deskLines.filter((b) => b.kind === "desk");
  const deskBody = deskNote(syms, salt);

  // One clock for the whole feed: a seeded open, then 30–900s between filings,
  // walked forward and handed out newest-first.
  const total = desk.length + news.length;
  const start = sessionStart(nowMs, random);
  const stamps: number[] = [start];
  for (let i = 1; i < total; i++) stamps.push(stamps[i - 1]! + (30 + Math.floor(random() * 871)) * 1000);
  stamps.reverse();

  const out: WireItem[] = [];
  desk.forEach((b, i) => {
    const ts = stamps[out.length]!;
    const who = b.who ?? "DESK";
    out.push({
      id: `wd-${salt}-${i}`,
      kind: "desk",
      sym: null,
      ts,
      time: timeOf(ts),
      day: dayOf(ts),
      headline: b.text,
      publisher: DESK_PUB,
      body: `“${b.text}” — ${who}, on the desk channel. ${deskBody}`,
      bodyKind: "desk-note",
      link: null,
      dateline: `${shortDate(ts)} ${timeOf(ts)}: ${who}: ${b.text}`,
      signature: signatureOf(DESK_PUB, ts),
      signal: priceSignal(`${b.text} ${deskBody}`),
      who,
    });
  });
  news.forEach((d, i) => {
    const ts = stamps[out.length]!;
    out.push({
      id: `wn-${salt}-${i}-${d.sym}`,
      kind: "news",
      sym: d.sym,
      ts,
      time: timeOf(ts),
      day: dayOf(ts),
      headline: d.headline,
      publisher: d.publisher,
      body: d.body,
      bodyKind: "seeded",
      link: null,
      dateline: `${shortDate(ts)} ${timeOf(ts)}: ${d.sym}: ${d.headline}`,
      signature: signatureOf(d.publisher, ts),
      // Measured off the row's own words, exactly as the live path measures it
      // — one classifier, so the terminal's filter behaves the same whichever
      // feed is up.
      signal: priceSignal(`${d.headline} ${d.body}`),
    });
  });
  return out;
}

/** The board-wide sentence every desk row carries under the spoken line. */
function deskNote(syms: readonly string[], salt: number): string {
  if (syms.length === 0) return "No names are on the board yet, so the desk is talking about the tape in general.";
  const pcts = syms.map((s) => pctAt(s, salt, TAPE_LEN));
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const up = pcts.filter((p) => p >= 0).length;
  return `Across the ${syms.length} names on the board — ${syms.join(", ")} — the study window closed ${avg >= 0 ? "+" : "−"}${Math.abs(avg).toFixed(1)}% on average, ${up} of ${syms.length} higher into the settle. This is desk colour, not a filed story: nothing on this row moved on a wire.`;
}
