import { UNIVERSE, meta } from "../data/universe.ts";
import type { WireItem } from "../data/wire.ts";
import { TAPE_LEN, fmtPx, pctAt, series } from "../engine/tape.ts";
import { hash } from "../lib/hash.ts";
import { parseRss, unwrapCdata, type RssItem } from "../lib/rss.ts";

/**
 * The live news wire — four public RSS feeds, no key, no dependency, one JSON
 * envelope.
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
 * ## Feeds are derived, never tabulated
 *
 * `feedsFor(sym)` builds its queries out of `meta(sym)` — the name and the
 * market. There is deliberately no per-ticker feed table: adding a name to
 * `universe.ts`, or a whole new sector, gives it live news for free and cannot
 * leave a stale row behind.
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

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** One feed the service decided to read for this request. */
export interface FeedSpec {
  url: string;
  /** Most rows any one feed may contribute, applied before the merge. */
  cap: number;
  /** The ticker this feed was fetched for; `null` for the market-wide feeds. */
  sym: string | null;
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
  /** Rows this feed contributed *before* the cross-feed merge. */
  items: number;
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
  tickers: readonly string[];
  salt: number;
  limit: number;
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

/** No trailing slash: `/rss/` answers 308 and a redirect costs a round trip. */
const COINDESK_URL = "https://www.coindesk.com/arc/outboundfeeds/rss";
const COINTELEGRAPH_URL = "https://cointelegraph.com/rss";

/** The market-wide stock query. Two days, because the board-level line should
 *  read as today's tape, not last week's. */
const MARKET_STOCK_Q = "stock market options volatility when:2d";

// ─────────────────────────────────────────────────────────────────────────────
// Time, formatted once, in New York
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `Intl.DateTimeFormat` construction is the expensive part — the format call is
 * cheap — so the one formatter this module needs is built lazily and kept.
 * Every field the wire prints (clock, dateline date, signature stamp) is read
 * off a single `formatToParts` call, which is also the only way to get an
 * unambiguous 24-hour value out of Intl across engines.
 */
let ET_FMT: Intl.DateTimeFormat | null = null;

function etFormatter(): Intl.DateTimeFormat {
  if (!ET_FMT) {
    ET_FMT = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
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
  return {
    time: `${hh}:${mi}:${ss}`,
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
 */
function deskNote(sym: string | null, tickers: readonly string[], salt: number, publisher: string): string {
  if (sym) {
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
  if (tickers.length === 0) {
    return `${publisher} filed this line market-wide. No names are on the board yet, so the desk has no window to read it against.`;
  }
  const pcts = tickers.map((t) => pctAt(t, salt, TAPE_LEN));
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const up = pcts.filter((p) => p >= 0).length;
  return (
    `Board-wide line. Across ${tickers.join(", ")} the study window closed ` +
    `${avg >= 0 ? "+" : "−"}${Math.abs(avg).toFixed(1)}% on average, ${up} of ${tickers.length} higher into the settle. ` +
    `${publisher} filed this one market-wide; the desk has no per-name tape behind it.`
  );
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

/** `meta()` falls back to the first asset for an unknown symbol, so identity —
 *  not truthiness — is how a ticker is validated. */
const KNOWN = new Set(UNIVERSE.map((u) => u.sym));

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

  /** The board-level feeds, added once per request rather than once per ticker. */
  function marketFeeds(tickers: readonly string[]): readonly FeedSpec[] {
    const out: FeedSpec[] = [];
    if (tickers.some((t) => meta(t).mkt === "CRYPTO")) {
      out.push({ url: COINDESK_URL, cap: 6, sym: null, publisher: "COINDESK", optional: false });
      out.push({ url: COINTELEGRAPH_URL, cap: 6, sym: null, publisher: "COINTELEGRAPH", optional: false });
    }
    if (tickers.some((t) => meta(t).mkt === "STOCK")) {
      out.push({ url: gnews(MARKET_STOCK_Q), cap: 6, sym: null, publisher: "GOOGLE NEWS", optional: false });
    }
    return out;
  }

  /**
   * Every feed for a request, de-duplicated by URL. Two tickers can name the
   * same feed (they cannot today, but a future alias could), and the market
   * stock query is the same URL shape as a per-ticker Google News query — one
   * fetch per URL, always.
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
    for (const f of marketFeeds(tickers)) {
      if (seen.has(f.url)) continue;
      seen.add(f.url);
      out.push(f);
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
    const body = stub ? deskNote(spec.sym, q.tickers, q.salt, publisher) : raw.description;

    return {
      id,
      kind: "news",
      sym: spec.sym,
      ts,
      time: et.time,
      headline,
      publisher,
      body,
      bodyKind: stub ? "seeded" : "wire",
      // Google News links are opaque base64 redirects. They resolve in a
      // browser and nowhere else, so the path is passed through untouched —
      // `safeLink` only unwraps the transport and checks the scheme.
      link: safeLink(raw.link),
      dateline: `${et.shortDate} ${et.time}: ${spec.sym ?? "MKT"}: ${headline}`,
      signature: signatureOf(publisher, et),
    };
  }

  /**
   * The merge — a floor, a ceiling, and recency in between.
   *
   * *Floor:* every dealt ticker's freshest headline is claimed before anything
   * competes, so a quiet name cannot be crowded off the board by a chatty one.
   * That is the guarantee `test/app.test.tsx` leans on — every dealt sym is
   * present in `[data-wire-sym]`.
   *
   * *Ceiling:* no ticker contributes more than `ceil(limit / tickers.length)`
   * rows. Without it, Nvidia's Google News query alone would fill a 3-leg wire.
   *
   * *Between:* one pool, sorted newest-first, in which the market-wide rows
   * (CoinDesk, Cointelegraph, the board-level options query) compete with the
   * per-ticker rows on time alone. Handing the quota the whole budget instead
   * would silently starve those three feeds to zero rows on any normal board —
   * they would be fetched every request and never once displayed.
   *
   * Dedupe runs across the whole union on the normalised headline key, because
   * a syndicated story arrives under two tickers with two different guids.
   */
  function merge(byTicker: Map<string, WireItem[]>, wide: WireItem[], q: NewsQuery): WireItem[] {
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

    // Pass 2 — the pool: every remaining row inside its ticker's ceiling, plus
    // every market-wide row, ranked by recency.
    const pool: WireItem[] = [...wide];
    for (const t of tickers) {
      const list = byTicker.get(t) ?? [];
      pool.push(...list.slice(cursors.get(t) ?? 0, (cursors.get(t) ?? 0) + Math.max(0, perTicker - 1)));
    }
    pool.sort(byRecency);
    for (const it of pool) {
      if (picked.length >= q.limit) break;
      take(it);
    }

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

    const feeds: FeedReport[] = [];
    const byTicker = new Map<string, WireItem[]>();
    const wide: WireItem[] = [];
    let degraded = false;

    specs.forEach((spec, i) => {
      const entry = entries[i] ?? null;
      // A null outcome is the budget expiring on a feed still in flight.
      const status = entry?.status ?? 0;
      const rows = (entry?.items ?? []).slice(0, spec.cap);
      const composed: WireItem[] = [];
      for (const raw of rows) {
        const item = compose(raw, spec, q, fetchedAt);
        if (item) composed.push(item);
      }
      composed.sort(byRecency);
      feeds.push({ url: spec.url, status, items: composed.length, ms: entry?.ms ?? BUDGET_MS });
      if (composed.length === 0 && !spec.optional) degraded = true;
      if (spec.sym === null) {
        wide.push(...composed);
      } else {
        const list = byTicker.get(spec.sym);
        if (list) list.push(...composed);
        else byTicker.set(spec.sym, composed);
      }
    });

    // A ticker read by two feeds needs its combined list back in time order
    // before the quota walks it.
    for (const list of byTicker.values()) list.sort(byRecency);
    wide.sort(byRecency);

    const items = merge(byTicker, wide, q);
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
   * this surface. `tickers` is checked against the universe *before* a socket
   * is opened, so no caller can steer the server's outbound fetches at a
   * hostname or a query of their choosing.
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
      if (!KNOWN.has(t)) return { reason: `unknown ticker: ${t}` };
    }
    if (new Set(tickers).size !== tickers.length) return { reason: "duplicate tickers" };

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

    return { q: { matchKey, tickers, salt, limit } };
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
