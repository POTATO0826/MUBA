import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { LIVE_SYMS, meta } from "../src/data/universe.ts";
import { createNewsService, type NewsEnvelope, type NewsOk } from "../src/server/news.ts";

/**
 * The live wire, offline.
 *
 * Every test here runs the *real* composition path — derive the feed URLs from
 * `universe.ts`, fetch, `parseRss`, strip the publisher suffix, filter for
 * relevance, compose the body, merge, sort, cache — over fixture XML written in
 * the shapes plan 2 actually probed. The only thing replaced is the socket.
 *
 * The contract this file pins, in one sentence: **every row belongs to a dealt
 * ticker, every row is about that ticker, every dealt ticker has a row, and the
 * whole list is in time order.**
 *
 * The `beforeAll` guard below is the load-bearing part: `globalThis.fetch` is
 * replaced with a function that throws, so any code path that forgets the
 * injected `fetch` fails loudly with "network in test" instead of quietly
 * reaching the internet and making this suite depend on Google News being up.
 */

// ─── the hard guard ──────────────────────────────────────────────────────────

const REAL_FETCH = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (() => {
    throw new Error("network in test");
  }) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = REAL_FETCH;
});

// ─── fixtures, in the shapes the feeds actually ship ─────────────────────────

const doc = (...items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title><link>https://example.com</link>${items.join(
    "",
  )}</channel></rss>`;

const at = (mm: number, ss = 0) =>
  `Mon, 01 Sep 2025 11:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} GMT`;

/**
 * A Google News item: the `" - Publisher"` title suffix, the publisher hiding
 * in `<source url>`, a base64 redirect link, and the entity-encoded
 * `<a>`+`<font>` stub that stands in for a description on ~70% of items.
 */
const gnewsItem = (headline: string, pub: string, guid: string, mm: number) =>
  `<item><title>${headline} - ${pub}</title>` +
  `<link>https://news.google.com/rss/articles/${guid}?oc=5</link>` +
  `<guid isPermaLink="false">${guid}</guid>` +
  `<pubDate>${at(mm)}</pubDate>` +
  `<description>&lt;a href="https://news.google.com/rss/articles/${guid}?oc=5" target="_blank"&gt;${headline}&lt;/a&gt;&nbsp;&lt;font color="#6f6f6f"&gt;${pub}&lt;/font&gt;</description>` +
  `<source url="https://www.example.com">${pub}</source></item>`;

/** The same feed's other shape: a real prose description rather than a stub. */
const gnewsProse = (headline: string, pub: string, guid: string, mm: number, body: string) =>
  `<item><title>${headline} - ${pub}</title>` +
  `<link>https://news.google.com/rss/articles/${guid}?oc=5</link>` +
  `<guid isPermaLink="false">${guid}</guid>` +
  `<pubDate>${at(mm)}</pubDate>` +
  `<description>${body}</description>` +
  `<source url="https://www.example.com">${pub}</source></item>`;

/** A Yahoo item: plain-prose description, no `<source>`, real seconds. */
const yahooItem = (headline: string, body: string, guid: string, mm: number, ss: number) =>
  `<item><title>${headline}</title>` +
  `<link>https://finance.yahoo.com/news/${guid}.html</link>` +
  `<pubDate>Mon, 01 Sep 2025 11:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} +0000</pubDate>` +
  `<description>${body}</description>` +
  `<guid isPermaLink="false">${guid}</guid></item>`;

/**
 * The CDATA shape — a CDATA title, a CDATA-wrapped HTML body, and, as the first
 * live probe of this service turned up, a CDATA-wrapped `<link>` carrying an
 * `&amp;`, the one XML escape a URL legitimately holds. It reaches the wire
 * through a per-symbol feed now that no market-wide feed is read at all.
 */
const cdataItem = (headline: string, body: string, guid: string, mm: number) =>
  `<item><title><![CDATA[${headline}]]></title>` +
  `<link><![CDATA[https://example.com/news/${guid}?ref=rss&amp;utm=feed]]></link>` +
  `<guid isPermaLink="true">https://example.com/news/${guid}</guid>` +
  `<pubDate>Mon, 01 Sep 2025 11:${String(mm).padStart(2, "0")}:31 +0000</pubDate>` +
  `<description><![CDATA[<p>${body}</p><img src="https://example.com/x.jpg" alt="x" />]]></description></item>`;

/** Long enough, and sharing no opening with its headline — a real tier-1 body. */
const PROSE_A =
  "Analysts at three desks said supply of top accelerators stayed tight through the quarter, leaving pricing firm into the new year.";
const PROSE_B =
  "Spot desks reported a third straight session of net creations, with the largest baskets printing before the London close on Monday.";

/**
 * The drift every loose feed carries: a real story about somebody else. Yahoo's
 * NVDA feed has shipped exactly this kind of row, and the relevance filter
 * exists for it. It names no company in the universe, so it is off-topic for
 * every ticker on the board — and it is the *newest* row in the fixture, so
 * nothing but the filter can keep it off the wire.
 */
const DRIFT_HEAD = "Robinhood Rolls Out New Wallets For Retail Traders";
const DRIFT_BODY =
  "The brokerage said the rollout reaches all fifty states this quarter, with staking to follow for eligible customers later in the year.";

/**
 * The syndicated wire story every Google News query returns — the same headline
 * under two tickers, exactly the collision the merge's dedupe exists for. Its
 * guid differs per query, so nothing but the normalised headline can collapse
 * it, and its body names both companies, so it is genuinely on-topic for both.
 */
const SYNDICATED = "Fed Minutes Land With Volatility Sellers Still in Control";
const SYNDICATED_BODY =
  "Desks trading Nvidia and Apple risk said the minutes changed little, with volatility sellers still in control of the front expiry.";

function gnewsDocFor(ticker: string): string {
  return doc(
    gnewsItem(`${ticker} Receives US Government OK to Export Its Newest Circuits`, "Reuters", `g-${ticker}-1`, 40),
    gnewsItem(`${ticker} Guidance Lifted as Order Coverage Runs Ahead of Plan`, "Bloomberg", `g-${ticker}-2`, 35),
    gnewsProse(SYNDICATED, "Reuters", `g-${ticker}-syn`, 33, SYNDICATED_BODY),
    gnewsItem(`${ticker} Draws Heaviest Options Volume of the Quarter`, "CNBC", `g-${ticker}-3`, 30),
  );
}

/** Yahoo's per-symbol feed: two rows about the name, one drifting one on top. */
function yahooDocFor(ticker: string): string {
  return doc(
    yahooItem(DRIFT_HEAD, DRIFT_BODY, `y-${ticker}-drift`, 55, 3),
    yahooItem(`${ticker} quarterly revenue tops estimates as demand holds`, PROSE_A, `y-${ticker}-1`, 45, 12),
    yahooItem(`${ticker} margin path draws fresh sell-side attention`, PROSE_B, `y-${ticker}-2`, 20, 47),
  );
}

/** Routes a request URL back to the fixture the real feed would have served. */
function bodyFor(url: string): string {
  if (url.includes("feeds.finance.yahoo.com")) {
    const s = new URL(url).searchParams.get("s") ?? "";
    return yahooDocFor(s.replace(/-USD$/, ""));
  }
  if (url.includes("news.google.com")) {
    const query = new URL(url).searchParams.get("q") ?? "";
    const m = /\bOR\s+([A-Z0-9]+)\b/.exec(query);
    return gnewsDocFor(m?.[1] ?? "MKT");
  }
  return doc();
}

type Verdict = number | "throw" | "garbage" | { doc: string } | undefined;

interface FakeFetch {
  fetch: typeof fetch;
  calls: string[];
}

/** `plan(url)` decides how each feed behaves; `undefined` means "serve the
 *  fixture", and `{ doc }` serves a document written for one test. */
function makeFetch(plan: (url: string) => Verdict = () => undefined): FakeFetch {
  const calls: string[] = [];
  const fn = async (input: unknown): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const verdict = plan(url);
    if (verdict === "throw") throw new Error("connection reset");
    if (verdict === "garbage") return new Response("<<< not xml &&& <item unclosed", { status: 200 });
    if (typeof verdict === "number") return new Response("upstream error", { status: verdict });
    const xml = typeof verdict === "object" ? verdict.doc : bodyFor(url);
    return new Response(xml, { status: 200, headers: { "content-type": "application/xml" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

/** True when `url` is the Google News feed opened for `sym`. */
const gnewsOf = (url: string, sym: string): boolean =>
  url.includes("news.google.com") && url.includes(`OR%20${sym}%20`);

/** True when `url` is the Yahoo feed opened for `sym`. */
const yahooOf = (url: string, sym: string): boolean =>
  url.includes("feeds.finance.yahoo.com") && new RegExp(`[?&]s=${sym}(-USD)?&`).test(url);

// ─── driving the service ─────────────────────────────────────────────────────

const q = (match: string, tickers: string, extra = "") =>
  new URL(`http://localhost/api/news?match=${match}&tickers=${tickers}&salt=424242${extra}`);

async function ask(svc: ReturnType<typeof createNewsService>, url: URL): Promise<NewsEnvelope> {
  const res = await svc.handle(url);
  expect(res.status).toBe(200);
  return (await res.json()) as NewsEnvelope;
}

/** Narrows, and fails with the envelope's own reason when it should not have. */
function ok(env: NewsEnvelope): NewsOk {
  if (!env.ok) throw new Error(`expected ok envelope, got: ${env.reason}`);
  return env;
}

/**
 * The relevance contract, restated here independently of the implementation:
 * the company name matched case-insensitively on non-alphanumeric boundaries,
 * or the exact uppercase ticker token on the same boundaries. If this and
 * `mentionsTicker` ever disagree, one of the two is the bug.
 */
function saysItIsAbout(sym: string, text: string): boolean {
  const name = meta(sym).name.replace(/\s+/g, "\\s+");
  return (
    new RegExp(`(^|[^A-Za-z0-9])${name}([^A-Za-z0-9]|$)`, "i").test(text) ||
    new RegExp(`(^|[^A-Za-z0-9])${sym}([^A-Za-z0-9]|$)`).test(text)
  );
}

/** Newest first, the id breaking a tie — the order the final array must be in. */
function inOrder(items: NewsOk["items"]): boolean {
  for (let i = 1; i < items.length; i++) {
    const prev = items[i - 1]!;
    const cur = items[i]!;
    if (prev.ts > cur.ts) continue;
    if (prev.ts === cur.ts && prev.id < cur.id) continue;
    return false;
  }
  return true;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("createNewsService — feed derivation", () => {
  test("derives queries from universe metadata, never a ticker table", () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });

    const stock = svc.feedsFor("NVDA");
    expect(stock).toHaveLength(2);
    expect(decodeURIComponent(stock[0]!.url)).toContain('q="Nvidia" OR NVDA stock when:7d');
    expect(stock[0]!.url.startsWith("https://news.google.com/rss/search?q=")).toBe(true);
    expect(stock[0]!.cap).toBe(14);
    expect(stock[1]!.url).toBe(
      "https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA&region=US&lang=en-US",
    );
    expect(stock[1]!.cap).toBe(8);
    // A Yahoo miss must never colour the response "partial".
    expect(stock[1]!.optional).toBe(true);

    const crypto = svc.feedsFor("BTC");
    expect(decodeURIComponent(crypto[0]!.url)).toContain('q="Bitcoin" OR BTC crypto when:7d');
    expect(crypto[1]!.url).toContain("s=BTC-USD");
  });

  test("every planned feed belongs to a ticker — no market-wide feed exists", async () => {
    const derive = createNewsService({ fetch: makeFetch().fetch });
    for (const sym of ["NVDA", "BTC", "COIN", "PEPE"]) {
      for (const f of derive.feedsFor(sym)) expect(f.sym).toBe(sym);
    }

    // And a request opens nothing else: two sockets per ticker, both derived,
    // none of them a board-level query.
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    await ask(svc, q("d1:1", "NVDA,BTC"));

    expect(f.calls).toHaveLength(4);
    for (const url of f.calls) {
      expect(url.includes("news.google.com") || url.includes("feeds.finance.yahoo.com")).toBe(true);
      expect(url).not.toContain("coindesk.com");
      expect(url).not.toContain("cointelegraph.com");
      expect(decodeURIComponent(url)).not.toContain("stock market options volatility");
    }
    expect(f.calls.filter((u) => gnewsOf(u, "NVDA"))).toHaveLength(1);
    expect(f.calls.filter((u) => yahooOf(u, "BTC"))).toHaveLength(1);
  });
});

describe("createNewsService — happy path", () => {
  test("composes a live wire from the per-ticker feeds", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("kz-semis:424242", "NVDA,BTC")));

    expect(env.source).toBe("live");
    expect(env.matchKey).toBe("kz-semis:424242");
    expect(env.items.length).toBeGreaterThan(0);
    expect(typeof env.fetchedAt).toBe("number");

    // Four feeds: gnews + yahoo per ticker, and nothing board-level.
    expect(env.feeds).toHaveLength(4);
    expect(f.calls).toHaveLength(4);
    expect(env.feeds.every((r) => r.status === 200)).toBe(true);
    for (const r of env.feeds) {
      expect(typeof r.url).toBe("string");
      expect(typeof r.ms).toBe("number");
      expect(r.items).toBeGreaterThan(0);
      expect(typeof r.dropped).toBe("number");
    }
    // Each Yahoo feed shipped one drifting row and the report says so — a
    // healthy feed with a rejected row is not an outage.
    for (const r of env.feeds.filter((x) => x.url.includes("yahoo"))) {
      expect(r.dropped).toBe(1);
    }
  });

  test("strips the ' - Publisher' suffix using the <source> value", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m1:1", "NVDA,BTC")));

    const g = env.items.find((i) => i.headline.includes("Receives US Government OK"));
    expect(g).toBeDefined();
    expect(g!.headline.endsWith("Circuits")).toBe(true);
    expect(g!.headline).not.toContain(" - Reuters");
    expect(g!.publisher).toBe("REUTERS");
    // No item anywhere keeps its suffix.
    expect(env.items.some((i) => / - (Reuters|Bloomberg|CNBC|MarketWatch|Barron's)$/.test(i.headline))).toBe(false);
  });

  test("every dealt ticker is represented, and nothing else is", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const boards = [
      ["NVDA", "BTC", "AAPL", "SOL"],
      ["NVDA", "AAPL", "TSLA"],
      ["BTC", "ETH", "PEPE"],
    ];
    for (const [n, board] of boards.entries()) {
      const env = ok(await ask(svc, q(`m2-${n}:1`, board.join(","))));
      const syms = new Set(env.items.map((i) => i.sym));
      for (const t of board) expect(syms.has(t)).toBe(true);
      // Bug 1, in three lines: no row is filed market-wide any more.
      expect(env.items.every((i) => i.sym !== null)).toBe(true);
      expect(env.items.every((i) => board.includes(i.sym!))).toBe(true);
      expect(env.items.every((i) => !i.dateline.includes(": MKT: "))).toBe(true);
    }
  });

  test("every ticker still appears when the limit is barely enough", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m3:1", "NVDA,BTC,AAPL,SOL", "&limit=6")));
    expect(env.items).toHaveLength(6);
    const syms = new Set(env.items.map((i) => i.sym));
    for (const t of ["NVDA", "BTC", "AAPL", "SOL"]) expect(syms.has(t)).toBe(true);
  });

  test("no ticker exceeds its ceiling", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    // 2 tickers, limit 8 ⇒ a ceiling of 4 rows each.
    const env = ok(await ask(svc, q("m7:1", "NVDA,BTC", "&limit=8")));
    expect(env.items).toHaveLength(8);
    for (const t of ["NVDA", "BTC"]) {
      const mine = env.items.filter((i) => i.sym === t);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.length).toBeLessThanOrEqual(4);
    }
  });

  test("the final list is strictly ordered, newest first, id breaking ties", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const boards = [["NVDA", "BTC"], ["NVDA", "AAPL", "TSLA", "SOL"], ["PEPE"]];
    for (const [n, board] of boards.entries()) {
      const env = ok(await ask(svc, q(`m4-${n}:1`, board.join(","))));
      expect(env.items.length).toBeGreaterThan(1);
      // Selection decides who is in; the sort decides the order. A list left
      // grouped by ticker — every NVDA row, then every BTC row — fails this.
      expect(inOrder(env.items)).toBe(true);
      const ts = env.items.map((i) => i.ts);
      expect(ts).toEqual([...ts].sort((a, b) => b - a));
    }
  });

  test("items carry a complete WireItem", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m4:1", "NVDA,BTC")));

    for (const it of env.items) {
      expect(it.kind).toBe("news");
      expect(it.id.length).toBeGreaterThan(0);
      expect(it.headline.length).toBeGreaterThan(0);
      expect(it.body.length).toBeGreaterThan(0);
      expect(it.publisher).toBe(it.publisher.toUpperCase());
      expect(it.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(it.dateline).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2} \d{2}:\d{2}:\d{2}: /);
      expect(it.dateline).toContain(`: ${it.sym}: `);
      expect(it.signature.startsWith("(END) ")).toBe(true);
      expect(it.signature).toContain("ET / Copyright (c) ");
      expect(it.link).toBeTruthy();
    }
    // Ids are unique — they are the terminal's React keys and selection ids.
    expect(new Set(env.items.map((i) => i.id)).size).toBe(env.items.length);
  });

  test("dedupes on the normalised headline key", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    // Both tickers' Google News queries carry the same syndicated story under
    // different guids — only the headline key can collapse it.
    const env = ok(await ask(svc, q("m5:1", "NVDA,AAPL")));
    expect(env.items.filter((i) => i.headline === SYNDICATED)).toHaveLength(1);
    const keys = env.items.map((i) =>
      i.headline.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("Google News links pass through as the base64 redirect they are", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m6:1", "NVDA")));
    const g = env.items.find((i) => i.link?.includes("news.google.com"));
    expect(g).toBeDefined();
    expect(g!.link).toContain("/rss/articles/");
    expect(g!.link).toContain("?oc=5");
  });

  test("a CDATA-wrapped link is unwrapped and its &amp; decoded", async () => {
    const cdataDoc = doc(
      cdataItem("Bitcoin holds its range as spot ETF inflows resume", PROSE_B, "cd-1", 52),
      cdataItem("Ether staking queue clears its longest backlog since spring", PROSE_A, "cd-2", 22),
    );
    const svc = createNewsService({
      fetch: makeFetch((url) => (yahooOf(url, "BTC") ? { doc: cdataDoc } : undefined)).fetch,
    });
    const env = ok(await ask(svc, q("m8:1", "BTC")));
    const cd = env.items.find((i) => i.link?.includes("example.com/news/cd-"));
    expect(cd).toBeDefined();
    expect(cd!.link!.startsWith("https://example.com/news/")).toBe(true);
    expect(cd!.link).not.toContain("CDATA");
    expect(cd!.link).toContain("?ref=rss&utm=feed");
  });

  test("a link that is not http(s) becomes null rather than an href", async () => {
    const hostile = doc(
      `<item><title>BTC desk note on the tape</title><link>javascript:alert(1)</link>` +
        `<guid isPermaLink="false">x-1</guid><pubDate>${at(59)}</pubDate>` +
        `<description>${PROSE_A}</description></item>`,
    );
    const svc = createNewsService({
      fetch: makeFetch((url) => (url.includes("feeds.finance.yahoo.com") ? { doc: hostile } : undefined)).fetch,
    });
    const env = ok(await ask(svc, q("m9:1", "BTC")));
    const bad = env.items.find((i) => i.headline === "BTC desk note on the tape");
    expect(bad).toBeDefined();
    expect(bad!.link).toBeNull();
  });
});

describe("createNewsService — the relevance filter", () => {
  test("every returned row is about the ticker it is filed under", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("r1:1", "NVDA,BTC,AAPL,SOL")));
    expect(env.items.length).toBeGreaterThan(4);
    for (const it of env.items) {
      // A tier-1 row proves it on the feed's own words; a tier-2 row's body is
      // a desk note about the same name.
      expect(saysItIsAbout(it.sym!, `${it.headline} ${it.body}`)).toBe(true);
    }
  });

  test("a drifting story on a per-symbol feed is dropped", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("r2:1", "NVDA,BTC")));
    // Yahoo's NVDA feed has really shipped rows like this one, and it is the
    // newest item in the fixture — only the filter can keep it out.
    expect(env.items.some((i) => i.headline === DRIFT_HEAD)).toBe(false);
    expect(env.items.length).toBeGreaterThan(3);
  });

  test("META does not match metaverse, and Meta does match Meta", async () => {
    const metaDoc = doc(
      gnewsProse(
        "Metaverse Land Sales Cool as Buyers Step Back",
        "Reuters",
        "g-meta-verse",
        58,
        "Virtual real estate volumes fell for a fourth quarter, with the largest platforms reporting fewer than a thousand parcels sold.",
      ),
      gnewsProse(
        "Meta Platforms Lifts Full-Year Capex Guidance",
        "Bloomberg",
        "g-meta-capex",
        44,
        "The company raised its capital expenditure range, citing data-centre build-out for its ranking and recommendation models.",
      ),
      gnewsItem("META Draws Heaviest Options Volume of the Quarter", "CNBC", "g-meta-opt", 21),
    );
    const svc = createNewsService({
      fetch: makeFetch((url) =>
        gnewsOf(url, "META") ? { doc: metaDoc } : yahooOf(url, "META") ? { doc: doc() } : undefined,
      ).fetch,
    });
    const env = ok(await ask(svc, q("r3:1", "META,NVDA")));
    const heads = env.items.filter((i) => i.sym === "META").map((i) => i.headline);

    expect(heads).toContain("Meta Platforms Lifts Full-Year Capex Guidance");
    expect(heads).toContain("META Draws Heaviest Options Volume of the Quarter");
    expect(heads.some((h) => h.startsWith("Metaverse Land Sales"))).toBe(false);
  });

  test("COIN, LINK and UNI need the company name or the uppercase ticker", async () => {
    // The three symbols in this universe that are also ordinary English words.
    // Lower- and title-case usage ("Coin", "Link", "University" — and "Bitcoin"
    // for the substring-minded) must never carry a row.
    const docs: Record<string, string> = {
      COIN: doc(
        gnewsProse(
          "Bitcoin Miners Hold Coin Balances Steady Into the Quarter",
          "Reuters",
          "g-coin-bad",
          58,
          "Public miners kept their treasuries flat through August, selling roughly as much as they produced, according to filings.",
        ),
        gnewsProse(
          "Coinbase Opens Its Institutional Desk to Wider Custody",
          "Bloomberg",
          "g-coin-name",
          44,
          "The exchange said custody balances rose again, with the institutional book taking the bulk of the growth.",
        ),
        gnewsItem("COIN Draws Heaviest Options Volume of the Quarter", "CNBC", "g-coin-tok", 21),
      ),
      LINK: doc(
        gnewsProse(
          "Analysts Link Fed Path to Risk Assets Once Again",
          "Reuters",
          "g-link-bad",
          57,
          "Strategists at two banks argued the rates path explains most of the cross-asset move, with positioning doing the rest.",
        ),
        gnewsProse(
          "Chainlink Oracle Network Adds Two Reserve Feeds",
          "Bloomberg",
          "g-link-name",
          43,
          "The network said two proof-of-reserve feeds went live this week, both carrying attestations from the same auditor.",
        ),
      ),
      UNI: doc(
        gnewsProse(
          "University Endowments Trim Their Crypto Books",
          "Reuters",
          "g-uni-bad",
          56,
          "Several endowments cut digital-asset exposure over the summer, according to people familiar with the allocations.",
        ),
        gnewsProse(
          "Uniswap Fee Switch Vote Clears Governance",
          "Bloomberg",
          "g-uni-name",
          42,
          "The proposal passed with a wide margin and turns on a protocol fee for a subset of pools next month.",
        ),
      ),
    };
    const svc = createNewsService({
      fetch: makeFetch((url) => {
        for (const sym of ["COIN", "LINK", "UNI"]) {
          if (gnewsOf(url, sym)) return { doc: docs[sym]! };
          if (yahooOf(url, sym)) return { doc: doc() };
        }
        return undefined;
      }).fetch,
    });
    const env = ok(await ask(svc, q("r4:1", "COIN,LINK,UNI")));
    const heads = env.items.map((i) => i.headline);

    expect(heads).toContain("Coinbase Opens Its Institutional Desk to Wider Custody");
    expect(heads).toContain("COIN Draws Heaviest Options Volume of the Quarter");
    expect(heads).toContain("Chainlink Oracle Network Adds Two Reserve Feeds");
    expect(heads).toContain("Uniswap Fee Switch Vote Clears Governance");

    expect(heads.some((h) => h.startsWith("Bitcoin Miners Hold Coin"))).toBe(false);
    expect(heads.some((h) => h.startsWith("Analysts Link Fed Path"))).toBe(false);
    expect(heads.some((h) => h.startsWith("University Endowments"))).toBe(false);

    for (const t of ["COIN", "LINK", "UNI"]) expect(env.items.some((i) => i.sym === t)).toBe(true);
  });

  test("the floor beats the filter: an emptied ticker keeps its two newest rows", async () => {
    // Both of GLD's feeds answer with nothing about gold. The ticker must still
    // reach the terminal — a missing dealt name is a worse bug than a loose row.
    const gnewsDrift = doc(
      gnewsProse(DRIFT_HEAD, "Reuters", "g-gld-1", 55, DRIFT_BODY),
      gnewsProse("Dealers Trim Gamma Exposure Into the Long Weekend", "Bloomberg", "g-gld-2", 50, PROSE_A),
      gnewsProse("Fund Flows Turn Defensive Across Listed Products", "CNBC", "g-gld-3", 45, PROSE_B),
    );
    const yahooDrift = doc(yahooItem("Retail Brokers Report a Quiet August", PROSE_A, "y-gld-1", 40, 9));

    const svc = createNewsService({
      fetch: makeFetch((url) =>
        gnewsOf(url, "GLD") ? { doc: gnewsDrift } : yahooOf(url, "GLD") ? { doc: yahooDrift } : undefined,
      ).fetch,
    });
    const env = ok(await ask(svc, q("r5:1", "GLD,NVDA")));

    const gld = env.items.filter((i) => i.sym === "GLD");
    expect(gld.length).toBeGreaterThanOrEqual(1);
    expect(gld.length).toBeLessThanOrEqual(2);
    // The two *newest* of the rejected set, not an arbitrary two.
    expect(gld.map((i) => i.headline)).toEqual([
      DRIFT_HEAD,
      "Dealers Trim Gamma Exposure Into the Long Weekend",
    ]);
    // Those rows are knowingly off-topic; that is what the floor is for.
    expect(gld.every((i) => saysItIsAbout("GLD", `${i.headline} ${i.body}`))).toBe(false);

    // A feed whose rows were all rejected is healthy, not degraded.
    expect(env.source).toBe("live");
    const report = env.feeds.find((r) => gnewsOf(r.url, "GLD"))!;
    expect(report.status).toBe(200);
    expect(report.items).toBe(0);
    expect(report.dropped).toBe(3);

    // And the ordering guarantee survives the fallback.
    expect(inOrder(env.items)).toBe(true);
    expect(env.items.some((i) => i.sym === "NVDA")).toBe(true);
  });
});

describe("createNewsService — the body composer", () => {
  test("tier 1: a real description becomes the body verbatim", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("b1:1", "NVDA")));
    const wire = env.items.find((i) => i.bodyKind === "wire");
    expect(wire).toBeDefined();
    expect([PROSE_A, PROSE_B, SYNDICATED_BODY]).toContain(wire!.body);
  });

  test("tier 2: a Google News stub gets a seeded desk note with figures", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("b2:1", "NVDA")));

    const stub = env.items.find((i) => i.headline.includes("Receives US Government OK"));
    expect(stub).toBeDefined();
    // The cleaned Google News description is the headline plus the publisher —
    // never a body.
    expect(stub!.bodyKind).toBe("seeded");
    expect(stub!.body.length).toBeGreaterThan(80);
    expect(stub!.body).toContain("%");
    expect(stub!.body).toContain("NVDA");
    expect(stub!.body).not.toBe(stub!.headline);
  });

  test("every seeded note is a per-name note — no board-wide copy survives", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("b3:1", "NVDA,BTC")));
    const seeded = env.items.filter((i) => i.bodyKind === "seeded");
    expect(seeded.length).toBeGreaterThan(0);
    for (const it of seeded) {
      expect(it.body).toContain(it.sym!);
      expect(it.body).toContain("%");
      expect(it.body).not.toContain("Board-wide line");
      expect(it.body).not.toContain("market-wide");
    }
  });

  test("no body is ever empty", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("b4:1", "NVDA,BTC,PEPE")));
    for (const it of env.items) expect(it.body.trim().length).toBeGreaterThan(0);
  });
});

describe("createNewsService — caches", () => {
  test("the same matchKey fetches once and replays the frozen payload", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });

    const first = ok(await ask(svc, q("kz-semis:424242", "NVDA,BTC")));
    const after = f.calls.length;
    expect(after).toBe(4);

    const second = ok(await ask(svc, q("kz-semis:424242", "NVDA,BTC")));
    expect(f.calls).toHaveLength(after);
    // The shared-wire guarantee: byte-identical, not merely similar.
    expect(second).toEqual(first);
  });

  test("concurrent requests on one matchKey dedupe into a single flight", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    const [a, b] = await Promise.all([
      ask(svc, q("dup:1", "NVDA,BTC")),
      ask(svc, q("dup:1", "NVDA,BTC")),
    ]);
    expect(f.calls).toHaveLength(4);
    expect(b).toEqual(a!);
  });

  test("a different matchKey refetches", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });

    await ask(svc, q("kz-semis:424242", "NVDA"));
    const after = f.calls.length;
    expect(after).toBeGreaterThan(0);

    const other = ok(await ask(svc, q("mi-majors:999", "BTC")));
    expect(f.calls.length).toBeGreaterThan(after);
    expect(other.matchKey).toBe("mi-majors:999");
  });

  test("the per-URL feed cache spares a shared feed a second fetch", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });

    // NVDA alone: gnews + yahoo = 2.
    await ask(svc, q("f1:1", "NVDA"));
    expect(f.calls).toHaveLength(2);

    // A different match on the same board reuses both documents and opens no
    // new socket.
    await ask(svc, q("f2:1", "NVDA"));
    expect(f.calls).toHaveLength(2);
  });

  test("an expired snapshot rebuilds", async () => {
    const f = makeFetch();
    let clock = 1_700_000_000_000;
    const svc = createNewsService({ fetch: f.fetch, now: () => clock });

    await ask(svc, q("t1:1", "NVDA"));
    expect(f.calls).toHaveLength(2);

    // Past both TTLs.
    clock += 1_900_000;
    await ask(svc, q("t1:1", "NVDA"));
    expect(f.calls).toHaveLength(4);
  });
});

describe("createNewsService — degradation", () => {
  test("one feed 500s: ok, source 'partial', survivors intact", async () => {
    const f = makeFetch((url) => (gnewsOf(url, "NVDA") ? 500 : undefined));
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("p1:1", "NVDA,BTC")));

    expect(env.source).toBe("partial");
    expect(env.items.length).toBeGreaterThan(0);
    const dead = env.feeds.find((r) => gnewsOf(r.url, "NVDA"));
    expect(dead?.status).toBe(500);
    expect(dead?.items).toBe(0);
    expect(dead?.dropped).toBe(0);
    expect(env.feeds.filter((r) => r.items > 0).length).toBeGreaterThan(0);
    // The tickers still come through — NVDA on its surviving Yahoo feed.
    const syms = new Set(env.items.map((i) => i.sym));
    expect(syms.has("NVDA")).toBe(true);
    expect(syms.has("BTC")).toBe(true);
  });

  test("a feed that never answers is status 0, not an exception", async () => {
    const f = makeFetch((url) => (gnewsOf(url, "BTC") ? "throw" : undefined));
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("p2:1", "NVDA,BTC")));

    expect(env.source).toBe("partial");
    expect(env.feeds.find((r) => gnewsOf(r.url, "BTC"))?.status).toBe(0);
    expect(env.items.length).toBeGreaterThan(0);
    expect(env.items.some((i) => i.sym === "BTC")).toBe(true);
  });

  test("a Yahoo miss is a silent skip, not a degraded response", async () => {
    const f = makeFetch((url) => (url.includes("feeds.finance.yahoo.com") ? 404 : undefined));
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("p3:1", "NVDA,BTC")));

    expect(env.source).toBe("live");
    expect(env.feeds.filter((r) => r.url.includes("yahoo")).every((r) => r.status === 404)).toBe(true);
    expect(env.items.length).toBeGreaterThan(0);
  });

  test("all feeds fail: ok false, items empty, still HTTP 200", async () => {
    const f = makeFetch(() => 503);
    const svc = createNewsService({ fetch: f.fetch });
    const res = await svc.handle(q("p4:1", "NVDA,BTC"));
    expect(res.status).toBe(200);
    const env = (await res.json()) as NewsEnvelope;

    expect(env.ok).toBe(false);
    expect(env.items).toEqual([]);
    if (!env.ok) expect(env.reason.length).toBeGreaterThan(0);
  });

  test("every feed throwing is still a 200 envelope", async () => {
    const f = makeFetch(() => "throw");
    const svc = createNewsService({ fetch: f.fetch });
    const env = await ask(svc, q("p5:1", "NVDA"));
    expect(env.ok).toBe(false);
    expect(env.items).toEqual([]);
  });

  test("garbage XML does not throw", async () => {
    const f = makeFetch(() => "garbage");
    const svc = createNewsService({ fetch: f.fetch });
    const env = await ask(svc, q("p6:1", "NVDA,BTC"));
    expect(env.ok).toBe(false);
    expect(env.items).toEqual([]);
    expect(f.calls.length).toBeGreaterThan(0);
  });

  test("garbage on one feed only still yields a wire", async () => {
    const f = makeFetch((url) => (url.includes("news.google.com") ? "garbage" : undefined));
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("p7:1", "NVDA,BTC")));
    expect(env.source).toBe("partial");
    expect(env.items.length).toBeGreaterThan(0);
    expect(env.items.every((i) => i.publisher !== "REUTERS")).toBe(true);
    // Yahoo alone still satisfies both halves of the contract.
    expect(env.items.every((i) => i.sym !== null)).toBe(true);
    expect(inOrder(env.items)).toBe(true);
  });

  test("a failed snapshot is not frozen — the next request retries", async () => {
    let broken = true;
    const f = makeFetch(() => (broken ? 500 : undefined));
    const svc = createNewsService({ fetch: f.fetch });

    const bad = await ask(svc, q("h1:1", "NVDA"));
    expect(bad.ok).toBe(false);

    broken = false;
    const good = await ask(svc, q("h1:1", "NVDA"));
    expect(good.ok).toBe(true);
  });
});

describe("createNewsService — request validation", () => {
  test("an unknown ticker costs itself its headlines, never the whole wire", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    const env = await ask(svc, q("v1:1", "NVDA,HACKME"));

    // The security half is untouched: the unrecognised string never became a
    // URL. What it no longer does is take NVDA's wire down with it — that is
    // the whole-request refusal that left 19 matches in 20 on the seeded tape.
    expect(f.calls.some((u) => u.includes("HACKME"))).toBe(false);
    expect(f.calls.length).toBeGreaterThan(0);

    const live = ok(env);
    expect(live.items.length).toBeGreaterThan(0);
    expect(live.items.every((i) => i.sym === "NVDA")).toBe(true);
    // Named, and coloured: a missing source is PARTIAL, exactly like a feed
    // that did not answer.
    expect(live.skipped).toEqual(["HACKME"]);
    expect(live.source).toBe("partial");
  });

  test("a request of nothing but unknown tickers is still refused, unfetched", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    const env = await ask(svc, q("v1b:1", "HACKME,ZZZZ"));

    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.reason).toContain("HACKME");
    expect(env.items).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test("a malformed ticker is junk, and junk refuses the request", async () => {
    // The two rejections are different on purpose. `HACKME` is a plausible
    // symbol this app does not carry; `../evil?x=` is not a symbol at all, and
    // it must not reach the envelope even as a name in `skipped`.
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    for (const bad of ["NVDA,%2E%2E%2Fevil", "NVDA,A_B", "NVDA,TOOLONGTICKERNAME"]) {
      const env = await ask(svc, q("v1c:1", bad));
      expect(env.ok).toBe(false);
      if (!env.ok) expect(env.reason).toBe("bad ticker");
    }
    expect(f.calls).toHaveLength(0);
  });

  test("every live-board asset reaches the wire, including the three the old allowlist refused", async () => {
    // BNB, AVAX and XRP are on `LIVE_BOARD` and on no other list — they are
    // declared inline in `universe.ts` precisely because `UNIVERSE` has never
    // held them. The allowlist was built from `UNIVERSE`, so the board's own
    // names were rejected as unknown and every match dealt one fell back to a
    // 2019 seeded tape. The board is the allowlist now.
    const svc = createNewsService({ fetch: makeFetch().fetch });
    for (const sym of LIVE_SYMS) {
      const env = ok(await ask(svc, q(`board-${sym}:1`, sym)));
      expect(env.skipped).toEqual([]);
      expect(env.items.some((i) => i.sym === sym)).toBe(true);
    }
  });

  test("a match dealt the exact live trio that used to kill the request now answers", async () => {
    // `ETH,AVAX,XRP` — the ticker set of the observed match `kz-semis`, seed
    // 931252, which returned `ok:false, 0 items` and rendered `WED · 02-13-19`.
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("kz-semis:931252", "ETH,AVAX,XRP")));
    expect(env.source).toBe("live");
    expect(env.skipped).toEqual([]);
    expect(new Set(env.items.map((i) => i.sym))).toEqual(new Set(["ETH", "AVAX", "XRP"]));
  });

  test("a dropped ticker is dropped identically for both seats in a room", async () => {
    // The frozen-envelope guarantee is the reason a partial answer is allowed
    // at all: the drop is a pure function of the requested list, so two players
    // on one `(lobby, seed)` reduce to the same tickers and replay the same
    // rows in the same order.
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const first = ok(await ask(svc, q("shared:7", "ETH,HACKME,BTC")));
    const second = ok(await ask(svc, q("shared:7", "ETH,HACKME,BTC")));
    expect(second).toEqual(first);
    expect(first.skipped).toEqual(["HACKME"]);
  });

  test("missing or malformed params are refused, never fetched", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });

    const cases = [
      "http://localhost/api/news",
      "http://localhost/api/news?tickers=NVDA",
      "http://localhost/api/news?match=a:1",
      "http://localhost/api/news?match=a:1&tickers=",
      "http://localhost/api/news?match=a:1&tickers=NVDA,NVDA",
      "http://localhost/api/news?match=a%20b&tickers=NVDA",
      "http://localhost/api/news?match=a:1&tickers=NVDA&salt=abc",
      "http://localhost/api/news?match=a:1&tickers=NVDA&limit=0",
      "http://localhost/api/news?match=a:1&tickers=NVDA,AAPL,TSLA,XOM,JPM,AMD,META,GLD,COIN,BTC,ETH,SOL,ARB",
    ];
    for (const c of cases) {
      const env = await ask(svc, new URL(c));
      expect(env.ok).toBe(false);
      expect(env.items).toEqual([]);
    }
    expect(f.calls).toHaveLength(0);
  });

  test("the limit is honoured and capped", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("v2:1", "NVDA,BTC", "&limit=4")));
    expect(env.items).toHaveLength(4);
    // The cap runs after the sort, so a short wire is the newest four rows.
    expect(inOrder(env.items)).toBe(true);
  });

  test("lowercase tickers are accepted and normalised", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("v3:1", "nvda")));
    expect(env.items.some((i) => i.sym === "NVDA")).toBe(true);
  });
});

describe("createNewsService — the kill switch", () => {
  const PREV = process.env.THETADUEL_NEWS;
  afterEach(() => {
    if (PREV === undefined) delete process.env.THETADUEL_NEWS;
    else process.env.THETADUEL_NEWS = PREV;
  });

  test("THETADUEL_NEWS=off answers immediately, without fetching", async () => {
    process.env.THETADUEL_NEWS = "off";
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    const env = await ask(svc, q("k1:1", "NVDA,BTC"));

    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.reason).toBe("disabled");
    expect(env.items).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  test("any other value leaves the wire live", async () => {
    process.env.THETADUEL_NEWS = "on";
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = await ask(svc, q("k2:1", "NVDA"));
    expect(env.ok).toBe(true);
  });
});

/**
 * Midnight — the case the wire has always got right and never been able to say.
 *
 * The feed is newest-first and a `when:7d` query routinely spans a week, but a
 * row prints `hh:mm:ss` with no date. Cross a day boundary and the terminal
 * shows `00:37:58` sitting directly above `23:07:06`: a *correct* descent that
 * reads as a scrambled one, because a time-only stamp cannot say "yesterday".
 * The reported bug was this, and it was never a sort bug — so what these tests
 * pin is (a) the order really is right across the boundary, and (b) `day` says
 * which session each row belongs to, formatted in New York where `time` is.
 *
 * The fixture is built so the two facts cannot be confused: every item below is
 * on 2025-09-01 in UTC, and they straddle ET midnight. A `day` read off UTC
 * would file all of them under one session and prove nothing.
 */
describe("createNewsService — the wire crosses midnight", () => {
  /** A Google News item with an explicit pubDate — the fixture generators above
   *  all pin the same hour, which is exactly what a midnight test cannot use. */
  const atItem = (headline: string, guid: string, pubDate: string) =>
    `<item><title>${headline} - Reuters</title>` +
    `<link>https://news.google.com/rss/articles/${guid}?oc=5</link>` +
    `<guid isPermaLink="false">${guid}</guid>` +
    `<pubDate>${pubDate}</pubDate>` +
    `<description>Desks reading Nvidia risk into the close said the tape had not yet ` +
    `given back the session's move, with front-expiry volatility still offered.</description>` +
    `<source url="https://www.example.com">Reuters</source></item>`;

  /**
   * Five NVDA rows straddling ET midnight, newest first in real time.
   *
   * UTC             ET                       printed
   * 09-01 04:47:31  Mon 09-01 00:47:31 EDT   00:47:31
   * 09-01 04:37:58  Mon 09-01 00:37:58 EDT   00:37:58
   * 09-01 03:07:06  Sun 08-31 23:07:06 EDT   23:07:06   ← the apparent jump
   * 09-01 01:02:19  Sun 08-31 21:02:19 EDT   21:02:19
   * 08-31 22:02:19  Sun 08-31 18:02:19 EDT   18:02:19
   *
   * Seconds are non-zero throughout on purpose: `stampOf` spreads on-the-minute
   * publishers by a hash-derived second, which would make the printed clock
   * unpredictable and this table a lie.
   */
  const MIDNIGHT_DOC = doc(
    atItem("Nvidia Holds Its Gain as the Overnight Session Opens", "mn-1", "Mon, 01 Sep 2025 04:47:31 GMT"),
    atItem("Nvidia Draws Fresh Bids in Thin Overnight Trade", "mn-2", "Mon, 01 Sep 2025 04:37:58 GMT"),
    atItem("Nvidia Closes Out the Session With Volatility Offered", "mn-3", "Mon, 01 Sep 2025 03:07:06 GMT"),
    atItem("Nvidia Options Volume Runs Ahead of the Twenty-Day", "mn-4", "Mon, 01 Sep 2025 01:02:19 GMT"),
    atItem("Nvidia Guidance Still Anchoring the Semis Complex", "mn-5", "Sun, 31 Aug 2025 22:02:19 GMT"),
  );

  /** NVDA's Google News feed serves the straddling doc; Yahoo serves nothing,
   *  so the five rows above are the whole wire and the table holds exactly. */
  const midnightFetch = () =>
    makeFetch((url) => (url.includes("news.google.com") ? { doc: MIDNIGHT_DOC } : { doc: doc() }));

  test("the order is right across the boundary — the clock is what looks wrong", async () => {
    const svc = createNewsService({ fetch: midnightFetch().fetch });
    const env = ok(await ask(svc, q("mid:1", "NVDA")));

    expect(env.items).toHaveLength(5);
    // Newest-first holds, exactly as it does inside one session.
    expect(inOrder(env.items)).toBe(true);
    expect(env.items.map((i) => i.time)).toEqual([
      "00:47:31",
      "00:37:58",
      "23:07:06",
      "21:02:19",
      "18:02:19",
    ]);

    // …and here is the report, reproduced: a row whose printed clock is LARGER
    // than the row above it, while its timestamp is strictly smaller. Nothing
    // about the sort is wrong; the stamp simply cannot express the day.
    const above = env.items[1]!;
    const below = env.items[2]!;
    expect(below.ts).toBeLessThan(above.ts);
    expect(below.time > above.time).toBe(true);
  });

  test("day names the session, so the apparent jump is explained rather than hidden", async () => {
    const svc = createNewsService({ fetch: midnightFetch().fetch });
    const env = ok(await ask(svc, q("mid:2", "NVDA")));

    expect(env.items.map((i) => i.day)).toEqual([
      "MON · 09-01-25",
      "MON · 09-01-25",
      "SUN · 08-31-25",
      "SUN · 08-31-25",
      "SUN · 08-31-25",
    ]);

    // The whole list is one session or a run of them, never a day reopening —
    // that is what lets the terminal band on change alone.
    const opened: string[] = [];
    for (const it of env.items) if (opened.at(-1) !== it.day) opened.push(it.day!);
    expect(opened).toEqual(["MON · 09-01-25", "SUN · 08-31-25"]);
    expect(new Set(opened).size).toBe(opened.length);

    // And the rule the band lets a reader apply: inside one day the printed
    // clock descends; only a new day may show a larger one.
    for (let i = 1; i < env.items.length; i++) {
      const prev = env.items[i - 1]!;
      const cur = env.items[i]!;
      if (cur.day === prev.day) expect(cur.time < prev.time).toBe(true);
    }
  });

  test("the day is New York's, not UTC's — every one of these rows is 09-01 in UTC", async () => {
    const svc = createNewsService({ fetch: midnightFetch().fetch });
    const env = ok(await ask(svc, q("mid:3", "NVDA")));

    // The four newest all fall on 2025-09-01 by the clock the feed published
    // in. ET splits them across two sessions, which is the only reason the
    // bands below the fold say anything at all.
    const utcDates = env.items.slice(0, 4).map((i) => new Date(i.ts).toISOString().slice(0, 10));
    expect(new Set(utcDates)).toEqual(new Set(["2025-09-01"]));
    expect(new Set(env.items.slice(0, 4).map((i) => i.day)).size).toBe(2);

    // day, dateline and signature are three renderings of one instant; if they
    // ever disagree the wire is telling a reader two different days at once.
    for (const it of env.items) {
      const [, date] = it.day!.split(" · ");
      const [mm, dd, yy] = date!.split("-");
      expect(it.signature).toContain(`${mm}-${dd}-${yy} `);
      expect(it.dateline.startsWith(`${Number(mm)}/${Number(dd)}/${yy} `)).toBe(true);
    }
  });

  test("the frozen replay carries the same days, so both players band identically", async () => {
    const f = midnightFetch();
    const svc = createNewsService({ fetch: f.fetch });

    const first = ok(await ask(svc, q("mid:freeze", "NVDA")));
    const calls = f.calls.length;
    const second = ok(await ask(svc, q("mid:freeze", "NVDA")));

    // No second fetch, and byte-identical rows: the day band is part of the
    // frozen envelope, not something a client recomputes off its own clock.
    expect(f.calls).toHaveLength(calls);
    expect(second).toEqual(first);
    expect(second.items.map((i) => i.day)).toEqual(first.items.map((i) => i.day));
  });
});
