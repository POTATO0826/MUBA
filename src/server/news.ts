import { LIVE_SYMS, UNIVERSE, meta } from "../data/universe.ts";
import type { WireItem } from "../data/wire.ts";
import { TAPE_LEN, fmtPx, pctAt, series } from "../engine/tape.ts";
import { hash } from "../lib/hash.ts";
import { parseRss, unwrapCdata, type RssItem } from "../lib/rss.ts";

/**
 * The live news wire — two public RSS feeds per dealt ticker, no key, no
 * dependency, one JSON envelope.
 *
 * This module is the whole server half of plan 2. It fetches, parses, cleans,
 * composes and freezes a study-phase feed for one match, and it is built to be
 * boring in exactly the places that matter:
 *
 *  - **It never throws at the route.** `handle()` always answers 200 with a
 *    typed envelope; a dead feed, a 500, a timeout, an HTML error page served
 *    with a `text/xml` header and a truncated document are all *data*, not
 *    exceptions. The client's only job is to read `ok` and fall back to the
 *    seeded wire (`data/news.ts`) when it is false.
 *  - **It is presentation only.** Nothing here is imported by `src/engine/**`
 *    or `src/state/match.ts` — `test/determinism.test.ts` enforces the reverse
 *    direction. This file reads `engine/tape.ts` to *describe* a window that
 *    the engine already computed; the engine never learns that news exists.
 *  - **It is injectable.** `createNewsService({ fetch, now })` takes both of
 *    its impure edges as parameters, so `test/news-service.test.ts` exercises
 *    the real composition path over fixture XML with the global `fetch`
 *    booby-trapped to throw.
 *
 * ## The shared-wire guarantee
 *
 * Two players sit in the same room on the same `(lobby, seed)`. They must read
 * the same headlines in the same order with the same timestamps, or the room
 * stops being one room. So the first request for a `matchKey` fetches and
 * *freezes* an envelope; every later request for that key replays it byte for
 * byte until the TTL expires. Timestamps are formatted server-side in
 * America/New_York for the same reason — a client-side `toLocaleTimeString()`
 * would desync two players in two zones.
 *
 * That covers the clock but not the calendar, and a `when:7d` query routinely
 * hands back six days of headlines. A time-only stamp cannot express
 * "yesterday", so a correctly ordered wire still reads as broken the moment it
 * crosses midnight — `04:08` above `21:23` looks like a sort bug and is not
 * one. Every row therefore also carries `day`, formatted off the same ET parts
 * bag as `time`, and the terminal opens a day band whenever it changes. The
 * order is fixed at the source, in `merge`; the *legibility* of that order is
 * this field's job, and it is frozen with everything else.
 *
 * ## Feeds are derived, never tabulated
 *
 * `feedsFor(sym)` builds its queries out of `meta(sym)` — the name and the
 * market. There is deliberately no per-ticker feed table: adding a name to
 * `universe.ts`, or a whole new sector, gives it live news for free and cannot
 * leave a stale row behind.
 *
 * ## Only the names on the board
 *
 * A battle's study phase is about the tickers that were dealt, so the wire
 * carries nothing else. Two rules enforce that, and they are separate on
 * purpose:
 *
 *  - **No market-wide feeds.** There is no CoinDesk / Cointelegraph / "stock
 *    market options volatility" query any more, and therefore no `sym: null`
 *    row on the live wire at all. Every feed this service opens is fetched *for*
 *    a ticker and every item it returns is filed under one.
 *  - **A relevance filter.** Being fetched for a ticker is not the same as
 *    being about it: Yahoo's per-symbol feed has carried Bitcoin and Robinhood
 *    stories under `NVDA`, and a Google News `OR` query drifts by construction.
 *    So an item survives only if it *mentions* its ticker — see
 *    `mentionsTicker` for the rule and for why "META" does not match
 *    "metaverse".
 *
 * The one thing that outranks both is representation: `FLOOR_FALLBACK` puts a
 * ticker's newest unfiltered rows back if the filter emptied it, because a
 * dealt name missing from the terminal is a worse bug than an off-topic
 * headline under it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/** One feed document is reusable for five minutes. Google News and Yahoo both
 *  refresh on the order of minutes, and a study phase is shorter than that. */
export const FEED_TTL_MS = 300_000;

/**
 * How long a frozen per-match snapshot stays replayable.
 *
 * **The bound is the wall-clock gap between two `/api/news` requests carrying
 * the same `matchKey`** — a StrictMode double-mount, a navigate-away-and-back
 * to `/match/:id/study?seed=N`, or a second player opening the same seed a
 * while after the first. It is NOT the simulated duration of a game mode.
 *
 * Plan 2's stated rule ("must exceed the longest study duration from plan 1's
 * modes") is wrong and must not be followed — see BUILD-ORDER §A-h. Plan 1's
 * mode minutes (15 / 60 / 1440) are *labels printed on badges* describing a
 * simulated window; study itself is untimed and `pickSeconds` bounds the parlay
 * phase, not this. Thirty minutes covers every realistic remount gap; raising
 * it to 24h chasing NORMAL's label would serve day-old headlines as "live".
 */
export const MATCH_TTL_MS = 1_800_000;

/** Per-feed abort. Yahoo answers in ~260ms and Google News in ~530–710ms, so
 *  anything past this is a feed that is not coming back inside the budget. */
const FEED_TIMEOUT_MS = 2_500;

/** Whole-request budget. The route answers within this even if a socket hangs
 *  open past its own abort — a slow feed costs its rows, never the response. */
const BUDGET_MS = 3_000;

/** Both caches are bounded and oldest-evicting; a long-lived dev server must
 *  not accumulate one entry per match it has ever served. */
const CACHE_MAX = 200;

/** Default and hard ceiling on returned rows. */
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 120;

/** Sanity bound on the request. Twelve is well past the largest legal book. */
const MAX_TICKERS = 12;

/**
 * How many *unfiltered* rows a ticker gets back when the relevance filter left
 * it with nothing at all.
 *
 * The every-dealt-ticker-appears guarantee (`test/app.test.tsx` reads it off
 * `[data-wire-sym]`) outranks purity: a quiet name whose two feeds happened to
 * answer with drift only must still show up on the board, so it keeps its two
 * newest rejected rows rather than vanishing. Two, not more, because these are
 * the rows the filter already judged off-topic.
 */
const FLOOR_FALLBACK = 2;

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** One feed the service decided to read for this request. */
export interface FeedSpec {
  url: string;
  /** Most rows any one feed may contribute, applied before the merge. */
  cap: number;
  /** The ticker this feed was fetched for. Never null: every live feed is
   *  per-ticker, which is what makes "no market-wide row" a type, not a habit. */
  sym: string;
  /** Publisher for items whose `<source>` is empty (Yahoo, CoinDesk, CT). */
  publisher: string;
  /** Yahoo has no listing for several suffixed crypto ids (`PEPE24478-USD`);
   *  a miss there is a silent skip, never a degraded response. */
  optional: boolean;
}

/** Per-feed accounting, echoed in the envelope so a partial answer is debuggable. */
export interface FeedReport {
  url: string;
  /** HTTP status, or `0` for a network error, an abort, or the budget expiring. */
  status: number;
  /** Rows this feed contributed *before* the cross-feed merge — survivors of the
   *  relevance filter, not everything the feed shipped. */
  items: number;
  /** Rows this feed shipped that the relevance filter rejected. A feed that is
   *  healthy but drifting reads as `status 200, items 0, dropped 9` rather than
   *  as an outage. */
  dropped: number;
  ms: number;
}

/** The success envelope. `source` is `"partial"` the moment one non-optional
 *  feed failed, even though the rows that did arrive are perfectly good. */
export interface NewsOk {
  ok: true;
  source: "live" | "partial";
  matchKey: string;
  fetchedAt: number;
  feeds: readonly FeedReport[];
  items: readonly WireItem[];
  /**
   * Requested tickers this service has no board row for, so no feed was opened
   * for them. Non-empty forces `source: "partial"` — the rows on screen are
   * live and a name the caller asked about is missing from them, which is
   * exactly what PARTIAL means. Bounded by {@link TICKER_SHAPE}, so echoing it
   * cannot reflect anything but uppercase alphanumerics.
   */
  skipped: readonly string[];
}

/** The failure envelope. Still served with HTTP 200 — the client reads `ok`. */
export interface NewsFail {
  ok: false;
  reason: string;
  items: readonly WireItem[];
}

export type NewsEnvelope = NewsOk | NewsFail;

/** A validated request. `handle()` parses a URL into one of these. */
export interface NewsQuery {
  matchKey: string;
  /** The **known** tickers, in request order. Never contains a name `meta()`
   *  cannot resolve, so no feed is ever built from an unrecognised string. */
  tickers: readonly string[];
  salt: number;
  limit: number;
  /** Requested-but-unknown tickers, dropped by `parse()`. Optional so a
   *  hand-built query in a test or a future caller need not carry it. */
  skipped?: readonly string[];
}

export interface NewsService {
  /** The route. Always resolves, always 200, never throws. */
  handle(url: URL): Promise<Response>;
  /** The same work without the HTTP envelope — for tests and for any future
   *  in-process caller (a prefetch on spin lock, say). */
  snapshot(q: NewsQuery): Promise<NewsEnvelope>;
  /** The derivation, exposed so it can be asserted on directly. */
  feedsFor(sym: string): readonly FeedSpec[];
}

/** The call signature this module uses. Bun's `typeof fetch` also carries a
 *  `preconnect` static, which a test double has no business providing. */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface NewsDeps {
  fetch?: typeof fetch;
  now?: () => number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feed URLs — exactly the formats probed in plan 2's "Verified facts" table
// ─────────────────────────────────────────────────────────────────────────────

const gnews = (q: string): string =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const yahoo = (s: string): string =>
  `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=US&lang=en-US`;

// ─────────────────────────────────────────────────────────────────────────────
// Time, formatted once, in New York
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Intl.DateTimeFormat` construction is the expensive part — the format call is
 * cheap — so the one formatter this module needs is built lazily and kept.
 * Every field the wire prints (clock, day band, dateline date, signature stamp)
 * is read off a single `formatToParts` call, which is also the only way to get
 * an unambiguous 24-hour value out of Intl across engines.
 */
let ET_FMT: Intl.DateTimeFormat | null = null;

function etFormatter(): Intl.DateTimeFormat {
  if (!ET_FMT) {
    ET_FMT = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      // The weekday is here so `day` can be read off the same parts bag as the
      // clock. One formatter, one call, one timezone: the band a row sits under
      // and the stamp printed on it can never land on different days.
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  }
  return ET_FMT;
}

interface EtParts {
  /** "07:47:14" */
  time: string;
  /** "THU · 09-04-26" — the day band this row is grouped under. */
  day: string;
  /** "9/1/26" — the dateline's American short date, as `data/wire.ts` writes it. */
  shortDate: string;
  /** "09-01-26" */
  stamp: string;
  /** "0947" */
  hhmm: string;
  /** "2026" */
  year: string;
}

function etParts(ts: number): EtParts {
  const bag: Record<string, string> = {};
  try {
    for (const p of etFormatter().formatToParts(ts)) bag[p.type] = p.value;
  } catch {
    // An out-of-range date is the only way here; fall through to the zeros
    // below rather than take the whole feed down over one bad pubDate.
  }
  const yyyy = bag.year ?? "1970";
  const mm = bag.month ?? "01";
  const dd = bag.day ?? "01";
  // `hour12: false` still yields "24" for midnight on some engines.
  const hRaw = bag.hour ?? "00";
  const hh = hRaw === "24" ? "00" : hRaw;
  const mi = bag.minute ?? "00";
  const ss = bag.second ?? "00";
  const yy = yyyy.slice(-2);
  // `weekday: "short"` is "Thu"; the terminal shouts, so the band does too. The
  // fallback is a dash rather than a guessed weekday — an unformattable date
  // must not be able to file a row under the wrong session.
  const wd = (bag.weekday ?? "").toUpperCase() || "———";
  return {
    time: `${hh}:${mi}:${ss}`,
    day: `${wd} · ${mm}-${dd}-${yy}`,
    shortDate: `${Number(mm)}/${Number(dd)}/${yy}`,
    stamp: `${mm}-${dd}-${yy}`,
    hhmm: `${hh}${mi}`,
    year: yyyy,
  };
}

/** Whose copyright line closes a live item. Same shape `data/wire.ts` uses for
 *  the seeded publishers; an unlisted publisher signs for itself. */
const OWNER: Readonly<Record<string, string>> = {
  REUTERS: "Thomson Reuters",
  BLOOMBERG: "Bloomberg L.P.",
  "YAHOO FINANCE": "Yahoo Inc.",
  COINDESK: "CoinDesk, Inc.",
  COINTELEGRAPH: "Cointelegraph",
  "GOOGLE NEWS": "Google LLC",
  CNBC: "CNBC LLC",
  MARKETWATCH: "MarketWatch, Inc.",
  BARRONS: "Dow Jones & Company, Inc.",
  "THE WALL STREET JOURNAL": "Dow Jones & Company, Inc.",
  "DOW JONES NEWSWIRES": "Dow Jones & Company, Inc.",
};

/** "(END) REUTERS / 09-01-26 0947ET / Copyright (c) 2026 Thomson Reuters." */
function signatureOf(publisher: string, et: EtParts): string {
  const owner = OWNER[publisher] ?? publisher;
  const tail = owner.endsWith(".") ? owner : `${owner}.`;
  return `(END) ${publisher} / ${et.stamp} ${et.hhmm}ET / Copyright (c) ${et.year} ${tail}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bounded, oldest-evicting caches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Map` iterates in insertion order, so "oldest" is simply the first key. The
 * `delete` before the `set` is what makes a refresh *move* an entry to the back
 * instead of leaving it stale at the front, where it would be evicted first
 * despite being the hottest key in the map.
 */
function put<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

interface FeedEntry {
  at: number;
  status: number;
  items: readonly RssItem[];
  ms: number;
}

interface MatchEntry {
  at: number;
  payload: NewsOk;
}

// ─────────────────────────────────────────────────────────────────────────────
// Body composition
// ─────────────────────────────────────────────────────────────────────────────

/** Normalised dedupe / comparison key: lowercase, punctuation gone, 60 chars. */
function key60(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 60);
}

/**
 * Is this description real prose, or the feed restating its own headline?
 *
 * Google News ships an `<a>`+`<font>` stub for roughly 70% of items; cleaned,
 * it reads as the headline followed by the publisher, which is long enough to
 * pass a naive length check and useless in a detail pane. Its other shape is an
 * `<ol>` of related links, which cleans to a run of headlines *including this
 * item's own*. Both are caught by asking whether the headline is contained in
 * the body — and the containment test is gated on a headline long enough that
 * the match cannot be coincidence.
 */
function isStub(description: string, headline: string): boolean {
  const d = key60(description);
  if (d.length < 40) return true;
  const h = key60(headline);
  if (h.length >= 25 && d.includes(h.slice(0, 40))) return true;
  return false;
}

/**
 * Tier 2 — the seeded desk note.
 *
 * Every figure comes off the tape the engine already generated for this study
 * window, so the note agrees with the chart card beside it and reads the same
 * on both players' screens. It fabricates nothing about the *news*: it says
 * what the window did, names the publisher that filed the line, and states
 * plainly that the desk has no tape behind the story. It always carries a
 * percentage, which is what makes it worth reading at all.
 *
 * There is no board-wide variant any more: every live row belongs to exactly
 * one dealt ticker, so every note is a per-name note.
 */
function deskNote(sym: string, salt: number, publisher: string): string {
  const u = meta(sym);
  const s = series(sym, salt);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of s) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const pct = pctAt(sym, salt, TAPE_LEN);
  const signed = `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
  return (
    `${sym} prints ${signed} across the study window, ${fmtPx(lo)}–${fmtPx(hi)}, ` +
    `on realised σ of ${(u.vol * 100).toFixed(1)}% daily; the leg on ${u.name} clears at ${u.t.toFixed(1)}%. ` +
    `The wire carries this line from ${publisher}; the desk has no tape on it beyond the window above.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Relevance — an item is about its ticker, or it is not this battle's news
// ─────────────────────────────────────────────────────────────────────────────

/** Regex-escape: a name is data (`Barron's`, a future `S&P 500`), never syntax. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The shortest symbol allowed to match as a bare token.
 *
 * Nothing in today's universe is under three characters, but a one- or
 * two-letter ticker (`F`, `V`, `AI`) would match half the English language on
 * the token rule alone, so a short symbol is name-only — it can still be
 * carried by the floor fallback, never by a coincidence.
 */
const MIN_TOKEN_LEN = 3;

const NAME_RE = new Map<string, RegExp>();
const TOKEN_RE = new Map<string, RegExp>();

/** `\bChainlink\b`, case-insensitive, whitespace-tolerant for "Gold ETF". */
function nameRe(sym: string): RegExp {
  let re = NAME_RE.get(sym);
  if (!re) {
    const body = escapeRe(meta(sym).name).replace(/\s+/g, "\\s+");
    re = new RegExp(`(^|[^A-Za-z0-9])${body}([^A-Za-z0-9]|$)`, "i");
    NAME_RE.set(sym, re);
  }
  return re;
}

/** The symbol as a bounded, **case-sensitive** token: `NVDA`, `$NVDA`, `(BTC)`. */
function tokenRe(sym: string): RegExp {
  let re = TOKEN_RE.get(sym);
  if (!re) {
    re = new RegExp(`(^|[^A-Za-z0-9])${escapeRe(sym)}([^A-Za-z0-9]|$)`);
    TOKEN_RE.set(sym, re);
  }
  return re;
}

/**
 * Does this text actually talk about `sym`?
 *
 * Two ways in, and no third:
 *
 *  1. **The company name**, matched case-insensitively but *bounded* by
 *     non-alphanumerics. The boundary is the whole point: `META`'s name is
 *     "Meta", and a bare substring test would hand it every "metaverse" story
 *     Google News has ever indexed. "Chainlink", "Uniswap", "Coinbase",
 *     "Dogecoin" all match plainly; multi-word names ("Gold ETF") match as a
 *     phrase with flexible whitespace.
 *  2. **The exact uppercase ticker token**, bounded the same way and matched
 *     *case-sensitively*.
 *
 * That second rule is precisely the answer to the dangerous symbols in this
 * universe — `COIN`, `LINK`, `UNI`. They are ordinary English only in lower or
 * title case ("coin", "Coin", "Link", "linked", "Uni", "university", and
 * "Bitcoin" for the substring-minded), and a case-sensitive token test matches
 * none of those. So those three are kept on their company name (Coinbase,
 * Chainlink, Uniswap) or on a literal ticker-style `COIN` / `LINK` / `UNI`
 * token, and on nothing else. The residual hole is an ALL-CAPS headline
 * ("... LINK TO THE FED PATH ..."), which is rare, is bounded by the dedupe and
 * by each ticker's ceiling, and is not worth a part-of-speech tagger.
 *
 * Deliberately *not* here: a per-ticker alias table ("Ether" for `ETH`, "XBT"
 * for `BTC`). This file derives everything from `universe.ts`, and a name that
 * only ever appears in an alias is exactly what `FLOOR_FALLBACK` is for.
 */
export function mentionsTicker(sym: string, text: string): boolean {
  if (!sym || !text) return false;
  if (nameRe(sym).test(text)) return true;
  return sym.length >= MIN_TOKEN_LEN && tokenRe(sym).test(text);
}

/**
 * Google News writes its titles as `"Headline - Publisher"` and hands the
 * publisher over separately in `<source>`. Strip that suffix with the value the
 * feed gave, never with a blind `lastIndexOf(" - ")` — headlines legitimately
 * contain " - " ("Nvidia - and AMD - clear the bar"), and cutting at the last
 * one silently truncates them.
 */
function stripPublisherSuffix(title: string, source: string): string {
  const src = source.trim();
  if (!src) return title;
  const suffix = ` - ${src}`;
  if (title.length > suffix.length && title.slice(-suffix.length).toLowerCase() === suffix.toLowerCase()) {
    return title.slice(0, -suffix.length).trim();
  }
  return title;
}

/**
 * An href fit to hand a browser, or nothing.
 *
 * `rss.ts` gives `link` a bare `trim()` on purpose — collapsing whitespace
 * inside a Google News base64 redirect would corrupt an identifier the feed
 * issued. That leaves this layer two jobs it cannot skip:
 *
 *  - **CDATA.** Cointelegraph wraps its `<link>`, so the raw value arrives as
 *    `<![CDATA[https://…`. Caught on the first live probe of this service; a
 *    CDATA marker is a transport wrapper, never part of the URL.
 *  - **`&amp;`.** The one XML escape that legitimately appears inside a query
 *    string. It has to come back as `&` or the link 404s. Nothing else is
 *    decoded — percent-encoding is the URL's own business.
 *
 * Then the scheme is checked, because this string ends up in an `href` and the
 * feeds are not ours. Anything that is not http(s) becomes `null`, and the
 * terminal simply renders no link.
 */
function safeLink(raw: string): string | null {
  const s = unwrapCdata(raw).replaceAll("&amp;", "&").trim();
  if (!s) return null;
  return /^https?:\/\/\S+$/i.test(s) ? s : null;
}

/**
 * Many feeds publish on the minute, which would stack a dozen rows on the same
 * `hh:mm:00` and make the terminal look fake. A pseudo-second derived from the
 * item's own id spreads them deterministically — the same article always lands
 * on the same second, on every machine, for both players.
 */
function stampOf(pubDate: string, id: string, fallback: number): number {
  const t = Date.parse(pubDate);
  if (!Number.isFinite(t)) return fallback;
  return new Date(t).getUTCSeconds() === 0 ? t + (hash(id) % 60) * 1000 : t;
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The symbol allowlist: **every name this app has a board row for**, both
 * boards, in one set.
 *
 * `meta()` falls back to the first asset for an unknown symbol, so identity —
 * not truthiness — is how a ticker is validated, and the set has to be exactly
 * the set `meta()` resolves. It was `UNIVERSE` alone, which is the frozen
 * eighteen-row replay fixture and *not the board the app deals from*: plan 6
 * replaced the dealt universe with `LIVE_BOARD` and this reference survived the
 * swap. BNB, AVAX and XRP are on the live board and on no other list — they are
 * declared inline in `universe.ts` precisely because `UNIVERSE` has never held
 * them — so every match dealt one of the three had its **entire** wire refused
 * as an unknown ticker and fell back to the seeded 2019 tape. The spin deals 3
 * of 6 qualified names, of which only ETH/BTC/SOL were on the old list, so live
 * news reached C(3,3)/C(6,3) = 1 match in 20.
 *
 * `UNIVERSE` stays in the union because the offline replay tape still deals
 * those rows and `feedsFor()` resolves them through the same `meta()`. The set
 * is still closed, still finite, still checked before a socket opens — the
 * guarantee this list exists for is "no caller steers our outbound fetches",
 * and that is a property of the set being enumerated in code, not of which of
 * the two boards it came from.
 */
const KNOWN: ReadonlySet<string> = new Set<string>([
  ...LIVE_SYMS,
  ...UNIVERSE.map((u) => u.sym),
]);

/**
 * What a ticker token may look like at all, before anyone asks whether we know
 * it.
 *
 * Two different rejections, kept apart on purpose. A token that fails *this* is
 * junk — it can never be an asset, so it kills the request and is never echoed
 * anywhere. A token that passes this and is not in {@link KNOWN} is a
 * plausible symbol we simply do not carry: it costs itself its headlines and is
 * named in the envelope's `skipped`, which is safe to echo precisely because
 * this shape has already bounded it to twelve uppercase alphanumerics.
 */
const TICKER_SHAPE = /^[A-Z0-9]{1,12}$/;

/** `THETADUEL_NEWS=off` ships a public build on the seeded wire alone. Read at
 *  call time, not at module load, so a test can set and restore it. */
function disabled(): boolean {
  try {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.THETADUEL_NEWS === "off";
  } catch {
    return false;
  }
}

export function createNewsService(deps: NewsDeps = {}): NewsService {
  const doFetch: FetchLike = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = deps.now ?? (() => Date.now());

  const feedCache = new Map<string, FeedEntry>();
  const feedInflight = new Map<string, Promise<FeedEntry>>();
  const matchCache = new Map<string, MatchEntry>();
  const matchInflight = new Map<string, Promise<NewsEnvelope>>();

  // ── feed derivation ───────────────────────────────────────────────────────

  function feedsFor(sym: string): readonly FeedSpec[] {
    const u = meta(sym);
    const crypto = u.mkt === "CRYPTO";
    return [
      {
        url: gnews(`"${u.name}" OR ${sym} ${crypto ? "crypto" : "stock"} when:7d`),
        cap: 14,
        sym,
        publisher: "GOOGLE NEWS",
        optional: false,
      },
      {
        // Yahoo's crypto ids are suffixed pairs, and several of the board's
        // small caps have no listing at all (`PEPE24478-USD`). A miss is a
        // skip: it must not colour the response "partial".
        url: yahoo(crypto ? `${sym}-USD` : sym),
        cap: 8,
        sym,
        publisher: "YAHOO FINANCE",
        optional: true,
      },
    ];
  }

  /**
   * Every feed for a request, de-duplicated by URL.
   *
   * Two feeds per dealt ticker and nothing else — there is no board-level pass
   * here any more, which is what makes a `sym: null` row impossible rather than
   * merely unlikely. The URL dedupe stays because two tickers could name the
   * same feed (they cannot today, but a future alias could) and one fetch per
   * URL is always the right answer.
   */
  function planFeeds(tickers: readonly string[]): readonly FeedSpec[] {
    const seen = new Set<string>();
    const out: FeedSpec[] = [];
    for (const t of tickers) {
      for (const f of feedsFor(t)) {
        if (seen.has(f.url)) continue;
        seen.add(f.url);
        out.push(f);
      }
    }
    return out;
  }

  // ── fetching ──────────────────────────────────────────────────────────────

  /**
   * One feed, cached, deduped, and incapable of rejecting.
   *
   * Only *successful* reads enter the cache. Caching a 500 would freeze an
   * outage for five minutes; the cost of retrying a failing feed on the next
   * request is one socket, and the benefit is that the wire heals the moment
   * the feed does.
   */
  function readFeed(spec: FeedSpec): Promise<FeedEntry> {
    const hit = feedCache.get(spec.url);
    if (hit && now() - hit.at < FEED_TTL_MS) return Promise.resolve(hit);

    const pending = feedInflight.get(spec.url);
    if (pending) return pending;

    const t0 = now();
    const job = (async (): Promise<FeedEntry> => {
      try {
        const init: RequestInit = {};
        // Guarded: `AbortSignal.timeout` is standard in Bun, but a fetch stub
        // in a stripped environment should not have to provide one.
        if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
          init.signal = AbortSignal.timeout(FEED_TIMEOUT_MS);
        }
        const res = await doFetch(spec.url, init);
        const status = typeof res?.status === "number" ? res.status : 0;
        if (!res || !res.ok) return { at: now(), status, items: [], ms: now() - t0 };
        const xml = await res.text();
        const items = parseRss(xml);
        const entry: FeedEntry = { at: now(), status, items, ms: now() - t0 };
        put(feedCache, spec.url, entry);
        return entry;
      } catch {
        // A DNS failure, an abort, a body that never arrives: status 0, no rows.
        return { at: now(), status: 0, items: [], ms: now() - t0 };
      } finally {
        feedInflight.delete(spec.url);
      }
    })();

    feedInflight.set(spec.url, job);
    return job;
  }

  /**
   * All feeds, in parallel, under one wall-clock budget.
   *
   * The outcomes array is written as each job lands, so racing the whole set
   * against a timer yields *whatever finished in time* rather than an
   * all-or-nothing result. The timer is always cleared — a stray 3-second
   * handle would keep a test runner alive after the assertions passed.
   */
  async function readAll(specs: readonly FeedSpec[]): Promise<readonly (FeedEntry | null)[]> {
    const outcomes: (FeedEntry | null)[] = specs.map(() => null);
    const jobs = specs.map((s, i) =>
      readFeed(s).then(
        (e) => {
          outcomes[i] = e;
        },
        () => {
          outcomes[i] = null;
        },
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BUDGET_MS);
    });
    try {
      await Promise.race([Promise.all(jobs), budget]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return outcomes;
  }

  // ── composition ───────────────────────────────────────────────────────────

  function compose(raw: RssItem, spec: FeedSpec, q: NewsQuery, fallbackTs: number): WireItem | null {
    const src = raw.source.trim();
    const headline = stripPublisherSuffix(raw.title, src).trim();
    if (!headline) return null;

    const publisher = (src || spec.publisher).toUpperCase();
    const id = `nl-${hash(raw.guid || raw.link || headline).toString(36)}`;
    const ts = stampOf(raw.pubDate, id, fallbackTs);
    const et = etParts(ts);

    const stub = isStub(raw.description, headline);
    const body = stub ? deskNote(spec.sym, q.salt, publisher) : raw.description;

    return {
      id,
      kind: "news",
      sym: spec.sym,
      ts,
      time: et.time,
      // Formatted here, in New York, for the same reason `time` is: the live
      // wire spans days, and two players in two zones must agree about which
      // day a row fell on, not merely about the hour printed on it.
      day: et.day,
      headline,
      publisher,
      body,
      bodyKind: stub ? "seeded" : "wire",
      // Google News links are opaque base64 redirects. They resolve in a
      // browser and nowhere else, so the path is passed through untouched —
      // `safeLink` only unwraps the transport and checks the scheme.
      link: safeLink(raw.link),
      dateline: `${et.shortDate} ${et.time}: ${spec.sym}: ${headline}`,
      signature: signatureOf(publisher, et),
    };
  }

  /**
   * The merge — a floor, a ceiling, recency in between, and one sort at the end.
   *
   * *Floor:* every dealt ticker's freshest headline is claimed before anything
   * competes, so a quiet name cannot be crowded off the board by a chatty one.
   * That is the guarantee `test/app.test.tsx` leans on — every dealt sym is
   * present in `[data-wire-sym]`.
   *
   * *Ceiling:* no ticker contributes more than `ceil(limit / tickers.length)`
   * rows. Without it, Nvidia's Google News query alone would fill a 3-leg wire.
   *
   * *Between:* one pool of everything the floor did not already claim, ranked by
   * recency, so the remaining budget goes to the freshest copy on the board
   * rather than to whichever ticker was dealt first.
   *
   * *Then the sort.* **Selection decides who is in; the sort decides the order.**
   * The three passes above are a quota walk — they visit tickers in deal order,
   * so the array they build is grouped, not chronological. Sorting the finished
   * selection by `byRecency` (and only then capping) is what makes the wire read
   * as one tape whose clock never jumps backwards and then forwards again. Any
   * future pass that adds rows must run *before* this sort, never after it.
   *
   * Dedupe runs across the whole union on the normalised headline key, because
   * a syndicated story arrives under two tickers with two different guids.
   */
  function merge(byTicker: Map<string, WireItem[]>, q: NewsQuery): WireItem[] {
    const tickers = q.tickers;
    const perTicker = tickers.length > 0 ? Math.ceil(q.limit / tickers.length) : q.limit;

    const seen = new Set<string>();
    const picked: WireItem[] = [];
    const take = (it: WireItem): boolean => {
      if (picked.length >= q.limit) return false;
      const k = key60(it.headline);
      if (!k || seen.has(k)) return false;
      seen.add(k);
      picked.push(it);
      return true;
    };

    // Pass 1 — the floor: each ticker's newest surviving row.
    const cursors = new Map<string, number>(tickers.map((t) => [t, 0]));
    for (const t of tickers) {
      if (picked.length >= q.limit) break;
      const list = byTicker.get(t) ?? [];
      let i = 0;
      // Walk past anything a sibling feed already claimed for this ticker.
      while (i < list.length && !take(list[i]!)) i++;
      cursors.set(t, i + 1);
    }

    // Pass 2 — the pool: every remaining row inside its ticker's ceiling,
    // ranked by recency.
    const pool: WireItem[] = [];
    for (const t of tickers) {
      const list = byTicker.get(t) ?? [];
      pool.push(...list.slice(cursors.get(t) ?? 0, (cursors.get(t) ?? 0) + Math.max(0, perTicker - 1)));
    }
    pool.sort(byRecency);
    for (const it of pool) {
      if (picked.length >= q.limit) break;
      take(it);
    }

    // Selection is finished; nothing below may add a row. One total order over
    // the whole selection, then the cap — never the other way round.
    picked.sort(byRecency);
    return picked.slice(0, q.limit);
  }

  /** Newest first; the id breaks the tie so two items on the same second do not
   *  swap places between two identical requests. */
  function byRecency(a: WireItem, b: WireItem): number {
    return b.ts - a.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }

  // ── the snapshot ──────────────────────────────────────────────────────────

  async function build(q: NewsQuery): Promise<NewsEnvelope> {
    const specs = planFeeds(q.tickers);
    const entries = await readAll(specs);
    const fetchedAt = now();

    const skipped = q.skipped ?? [];
    const feeds: FeedReport[] = [];
    /** Per ticker, the rows that are about it. */
    const byTicker = new Map<string, WireItem[]>();
    /** Per ticker, the rows the relevance filter rejected — the floor's reserve. */
    const spares = new Map<string, WireItem[]>();
    // A dropped ticker is a missing source, which is the same shape of harm as
    // a feed that did not answer: the wire is real and incomplete.
    let degraded = skipped.length > 0;

    const fileUnder = (map: Map<string, WireItem[]>, sym: string, rows: WireItem[]): void => {
      const list = map.get(sym);
      if (list) list.push(...rows);
      else map.set(sym, rows);
    };

    specs.forEach((spec, i) => {
      const entry = entries[i] ?? null;
      // A null outcome is the budget expiring on a feed still in flight.
      const status = entry?.status ?? 0;
      const rows = (entry?.items ?? []).slice(0, spec.cap);
      const kept: WireItem[] = [];
      const dropped: WireItem[] = [];
      let composed = 0;
      for (const raw of rows) {
        const item = compose(raw, spec, q, fetchedAt);
        if (!item) continue;
        composed++;
        // The filter reads the headline and the feed's OWN description, never
        // the composed body: a tier-2 body is a desk note that names the ticker
        // itself, so testing it would pass every row vacuously.
        if (mentionsTicker(spec.sym, `${item.headline} ${raw.description}`)) kept.push(item);
        else dropped.push(item);
      }
      kept.sort(byRecency);
      dropped.sort(byRecency);
      feeds.push({
        url: spec.url,
        status,
        items: kept.length,
        dropped: dropped.length,
        ms: entry?.ms ?? BUDGET_MS,
      });
      // Degradation is about the feed, not about the filter: a feed that
      // answered with nine drifting stories is healthy, just useless here.
      if (composed === 0 && !spec.optional) degraded = true;
      fileUnder(byTicker, spec.sym, kept);
      fileUnder(spares, spec.sym, dropped);
    });

    // A ticker read by two feeds needs its combined list back in time order
    // before the quota walks it.
    for (const list of byTicker.values()) list.sort(byRecency);
    for (const list of spares.values()) list.sort(byRecency);

    // The safety floor. Representation outranks purity: a dealt ticker that the
    // filter emptied gets its newest rejected rows back rather than going
    // missing from the terminal entirely. It is the only path by which an
    // off-topic headline can reach the wire, and it is deliberate.
    for (const t of q.tickers) {
      if ((byTicker.get(t) ?? []).length > 0) continue;
      const fallback = (spares.get(t) ?? []).slice(0, FLOOR_FALLBACK);
      if (fallback.length > 0) byTicker.set(t, fallback);
    }

    const items = merge(byTicker, q);
    if (items.length === 0) {
      return { ok: false, reason: "no items: every feed failed or returned nothing usable", items: [] };
    }
    return {
      ok: true,
      source: degraded ? "partial" : "live",
      matchKey: q.matchKey,
      fetchedAt,
      feeds,
      items,
      skipped,
    };
  }

  /**
   * The frozen snapshot, keyed on `matchKey` alone.
   *
   * Keying on the match and not on the full query is the point: a `matchKey` is
   * `"${lobbyId}:${seed}"`, the dealt tickers are a pure function of that pair,
   * and freezing on the key is what makes the second player's payload identical
   * to the first player's rather than merely similar. Only successful envelopes
   * are frozen — a transient all-feeds-down must not be replayed for 30 minutes.
   */
  function snapshot(q: NewsQuery): Promise<NewsEnvelope> {
    if (disabled()) {
      return Promise.resolve({ ok: false, reason: "disabled", items: [] });
    }
    const hit = matchCache.get(q.matchKey);
    if (hit && now() - hit.at < MATCH_TTL_MS) return Promise.resolve(hit.payload);

    const pending = matchInflight.get(q.matchKey);
    if (pending) return pending;

    const job = build(q)
      .then((env) => {
        if (env.ok) put(matchCache, q.matchKey, { at: now(), payload: env });
        return env;
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false as const, reason: `build failed: ${reason}`, items: [] };
      })
      .finally(() => {
        matchInflight.delete(q.matchKey);
      });

    matchInflight.set(q.matchKey, job);
    return job;
  }

  // ── the route ─────────────────────────────────────────────────────────────

  /**
   * Strict, because the query string is the one attacker-controlled input on
   * this surface. Every ticker is shape-checked and allowlisted *before* a
   * socket is opened, so no caller can steer the server's outbound fetches at a
   * hostname or a query of their choosing. That guarantee is unchanged; what
   * changed is its blast radius.
   *
   * ## An unknown ticker costs itself, not the wire
   *
   * This used to `return` on the first miss, so one unrecognised name refused
   * the *whole* request and the study screen fell back to the seeded tape —
   * see {@link KNOWN} for how that turned a stale allowlist into a dead wire
   * for 19 matches in 20. Three tiers now, and they are different failures:
   *
   *  1. **Malformed** (`TICKER_SHAPE`) — junk. Refuses the request. A string
   *     that cannot be a symbol is not a symbol we happen to lack, and it must
   *     not reach the envelope even as a name.
   *  2. **Well-formed, unknown** — dropped from `tickers`, named in `skipped`,
   *     and the response is coloured PARTIAL. Its headlines are gone; the other
   *     tickers' are not.
   *  3. **Nothing left** — if every ticker was dropped there is no request to
   *     make, so it is refused with the first offender named, which is the
   *     reason string this route has always returned.
   *
   * **The frozen-envelope guarantee survives this.** Two players in one room
   * derive their ticker list from the same `(lobby, seed)` pair, and both the
   * drop and the ordering here are pure functions of that list — so the two
   * requests reduce to the same `tickers`, hit the same `matchKey`, and replay
   * the same frozen envelope in the same order. A partial wire is shared
   * identically or it is not shared at all, and it is shared identically.
   */
  function parse(url: URL): { q: NewsQuery } | { reason: string } {
    const p = url.searchParams;

    const matchKey = (p.get("match") ?? "").trim();
    if (!matchKey) return { reason: "missing match" };
    if (matchKey.length > 128) return { reason: "match too long" };
    if (!/^[A-Za-z0-9_:.-]+$/.test(matchKey)) return { reason: "bad match" };

    const rawTickers = (p.get("tickers") ?? "").trim();
    if (!rawTickers) return { reason: "missing tickers" };
    const tickers = rawTickers
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    if (tickers.length === 0) return { reason: "missing tickers" };
    if (tickers.length > MAX_TICKERS) return { reason: "too many tickers" };
    for (const t of tickers) {
      if (!TICKER_SHAPE.test(t)) return { reason: "bad ticker" };
    }
    // Deduped on what was *asked for*, before anything is dropped, so a
    // repeated unknown is still a malformed request rather than a silent no-op.
    if (new Set(tickers).size !== tickers.length) return { reason: "duplicate tickers" };

    const known = tickers.filter((t) => KNOWN.has(t));
    const skipped = tickers.filter((t) => !KNOWN.has(t));
    if (known.length === 0) return { reason: `unknown ticker: ${skipped[0]}` };

    const rawSalt = p.get("salt");
    let salt = 0;
    if (rawSalt !== null && rawSalt !== "") {
      salt = Number(rawSalt);
      if (!Number.isFinite(salt) || !Number.isInteger(salt)) return { reason: "bad salt" };
      if (Math.abs(salt) > Number.MAX_SAFE_INTEGER) return { reason: "bad salt" };
    }

    const rawLimit = p.get("limit");
    let limit = DEFAULT_LIMIT;
    if (rawLimit !== null && rawLimit !== "") {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1) return { reason: "bad limit" };
      limit = Math.min(limit, MAX_LIMIT);
    }

    return { q: { matchKey, tickers: known, salt, limit, skipped } };
  }

  const json = (body: NewsEnvelope): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  async function handle(url: URL): Promise<Response> {
    try {
      if (disabled()) return json({ ok: false, reason: "disabled", items: [] });
      const parsed = parse(url);
      if ("reason" in parsed) return json({ ok: false, reason: parsed.reason, items: [] });
      return json(await snapshot(parsed.q));
    } catch (err) {
      // Belt and braces: the route answers 200 even if the impossible happens.
      const reason = err instanceof Error ? err.message : String(err);
      return json({ ok: false, reason: `error: ${reason}`, items: [] });
    }
  }

  return { handle, snapshot, feedsFor };
}
