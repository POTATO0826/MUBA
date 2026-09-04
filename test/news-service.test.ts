import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createNewsService, type NewsEnvelope, type NewsOk } from "../src/server/news.ts";

/**
 * The live wire, offline.
 *
 * Every test here runs the *real* composition path — derive the feed URLs from
 * `universe.ts`, fetch, `parseRss`, strip the publisher suffix, compose the
 * body, merge, cache — over fixture XML written in the shapes plan 2 actually
 * probed. The only thing replaced is the socket.
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

// ─── fixtures, in the four shapes the feeds actually ship ────────────────────

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

/** A Yahoo item: plain-prose description, no `<source>`, real seconds. */
const yahooItem = (headline: string, body: string, guid: string, mm: number, ss: number) =>
  `<item><title>${headline}</title>` +
  `<link>https://finance.yahoo.com/news/${guid}.html</link>` +
  `<pubDate>Mon, 01 Sep 2025 11:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} +0000</pubDate>` +
  `<description>${body}</description>` +
  `<guid isPermaLink="false">${guid}</guid></item>`;

/**
 * CoinDesk / Cointelegraph: CDATA titles, CDATA-wrapped HTML bodies, and — as
 * the first live probe of this service turned up — a CDATA-wrapped `<link>`,
 * which the parser leaves alone by design. An `&amp;` rides along in the query
 * string, the one XML escape a URL legitimately carries.
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
 * The syndicated wire story every Google News query returns — the same headline
 * under two tickers, exactly the collision the merge's dedupe exists for. Its
 * guid differs per query, so nothing but the normalised headline can collapse it.
 */
const SYNDICATED = "Fed Minutes Land With Volatility Sellers Still in Control";

function gnewsDocFor(ticker: string): string {
  return doc(
    gnewsItem(`${ticker} Receives US Government OK to Export Its Newest Circuits`, "Reuters", `g-${ticker}-1`, 40),
    gnewsItem(`${ticker} Guidance Lifted as Order Coverage Runs Ahead of Plan`, "Bloomberg", `g-${ticker}-2`, 35),
    gnewsItem(SYNDICATED, "Reuters", `g-${ticker}-syn`, 33),
    gnewsItem(`${ticker} Draws Heaviest Options Volume of the Quarter`, "CNBC", `g-${ticker}-3`, 30),
  );
}

function yahooDocFor(ticker: string): string {
  return doc(
    yahooItem(`${ticker} quarterly revenue tops estimates as demand holds`, PROSE_A, `y-${ticker}-1`, 45, 12),
    yahooItem(`${ticker} margin path draws fresh sell-side attention`, PROSE_B, `y-${ticker}-2`, 20, 47),
  );
}

const MARKET_DOC = doc(
  gnewsItem("Stock Market Volatility Cools as Options Expiry Passes Quietly", "MarketWatch", "g-mkt-1", 50),
  gnewsItem("Dealers Trim Gamma Exposure Into the Long Weekend", "Barron's", "g-mkt-2", 15),
);

const COINDESK_DOC = doc(
  cdataItem("Bitcoin holds its range as spot ETF inflows resume", PROSE_B, "cd-1", 52),
  cdataItem("Ether staking queue clears its longest backlog since spring", PROSE_A, "cd-2", 22),
);

const COINTELEGRAPH_DOC = doc(
  cdataItem("Exchange balances thin to a multi-quarter low, desks say", PROSE_A, "ct-1", 48),
  cdataItem("Perp funding turns positive across the majors", PROSE_B, "ct-2", 18),
);

/** Routes a request URL back to the fixture the real feed would have served. */
function bodyFor(url: string): string {
  if (url.includes("coindesk.com")) return COINDESK_DOC;
  if (url.includes("cointelegraph.com")) return COINTELEGRAPH_DOC;
  if (url.includes("feeds.finance.yahoo.com")) {
    const s = new URL(url).searchParams.get("s") ?? "";
    return yahooDocFor(s.replace(/-USD$/, ""));
  }
  if (url.includes("news.google.com")) {
    const q = new URL(url).searchParams.get("q") ?? "";
    if (q.includes("stock market options volatility")) return MARKET_DOC;
    const m = /\bOR\s+([A-Z0-9]+)\b/.exec(q);
    return gnewsDocFor(m?.[1] ?? "MKT");
  }
  return doc();
}

type Verdict = number | "throw" | "garbage" | undefined;

interface FakeFetch {
  fetch: typeof fetch;
  calls: string[];
}

/** `plan(url)` decides how each feed behaves; `undefined` means "serve the fixture". */
function makeFetch(plan: (url: string) => Verdict = () => undefined): FakeFetch {
  const calls: string[] = [];
  const fn = async (input: unknown): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    const verdict = plan(url);
    if (verdict === "throw") throw new Error("connection reset");
    if (verdict === "garbage") return new Response("<<< not xml &&& <item unclosed", { status: 200 });
    if (typeof verdict === "number") return new Response("upstream error", { status: verdict });
    return new Response(bodyFor(url), { status: 200, headers: { "content-type": "application/xml" } });
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

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
});

describe("createNewsService — happy path", () => {
  test("composes a live wire from all feeds", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("kz-semis:424242", "NVDA,BTC")));

    expect(env.source).toBe("live");
    expect(env.matchKey).toBe("kz-semis:424242");
    expect(env.items.length).toBeGreaterThan(0);
    expect(typeof env.fetchedAt).toBe("number");

    // Seven feeds: gnews+yahoo per ticker, coindesk + cointelegraph (crypto on
    // the board) and the market-wide stock query.
    expect(env.feeds).toHaveLength(7);
    expect(f.calls).toHaveLength(7);
    expect(env.feeds.every((r) => r.status === 200)).toBe(true);
    for (const r of env.feeds) {
      expect(typeof r.url).toBe("string");
      expect(typeof r.ms).toBe("number");
      expect(r.items).toBeGreaterThan(0);
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

  test("every dealt ticker is represented", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m2:1", "NVDA,BTC,AAPL,SOL")));
    const syms = new Set(env.items.map((i) => i.sym));
    for (const t of ["NVDA", "BTC", "AAPL", "SOL"]) expect(syms.has(t)).toBe(true);
    // Market-wide rows carry a null sym; the terminal renders those as "MKT".
    expect(env.items.some((i) => i.sym === null)).toBe(true);
  });

  test("every ticker still appears when the limit is barely enough", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m3:1", "NVDA,BTC,AAPL,SOL", "&limit=6")));
    expect(env.items).toHaveLength(6);
    const syms = new Set(env.items.map((i) => i.sym));
    for (const t of ["NVDA", "BTC", "AAPL", "SOL"]) expect(syms.has(t)).toBe(true);
  });

  test("market-wide rows survive the quota, and no ticker exceeds its ceiling", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    // 2 tickers, limit 8 ⇒ ceiling of 4 rows each. If the per-ticker quota were
    // allowed to spend the whole budget, CoinDesk / Cointelegraph / the
    // board-level query would be fetched every request and never displayed.
    const env = ok(await ask(svc, q("m7:1", "NVDA,BTC", "&limit=8")));
    expect(env.items).toHaveLength(8);

    const wide = env.items.filter((i) => i.sym === null);
    expect(wide.length).toBeGreaterThanOrEqual(2);
    for (const t of ["NVDA", "BTC"]) {
      const mine = env.items.filter((i) => i.sym === t);
      expect(mine.length).toBeGreaterThanOrEqual(1);
      expect(mine.length).toBeLessThanOrEqual(4);
    }
  });

  test("items sort newest first and carry a complete WireItem", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m4:1", "NVDA,BTC")));

    for (let i = 1; i < env.items.length; i++) {
      expect(env.items[i - 1]!.ts).toBeGreaterThanOrEqual(env.items[i]!.ts);
    }
    for (const it of env.items) {
      expect(it.kind).toBe("news");
      expect(it.id.length).toBeGreaterThan(0);
      expect(it.headline.length).toBeGreaterThan(0);
      expect(it.body.length).toBeGreaterThan(0);
      expect(it.publisher).toBe(it.publisher.toUpperCase());
      expect(it.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
      expect(it.dateline).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2} \d{2}:\d{2}:\d{2}: /);
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
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("m8:1", "BTC")));
    const cd = env.items.find((i) => i.link?.includes("example.com/news/cd-"));
    expect(cd).toBeDefined();
    expect(cd!.link!.startsWith("https://example.com/news/")).toBe(true);
    expect(cd!.link).not.toContain("CDATA");
    expect(cd!.link).toContain("?ref=rss&utm=feed");
  });

  test("a link that is not http(s) becomes null rather than an href", async () => {
    const hostile = doc(
      `<item><title>Desk note on the tape</title><link>javascript:alert(1)</link>` +
        `<guid isPermaLink="false">x-1</guid><pubDate>${at(59)}</pubDate>` +
        `<description>${PROSE_A}</description></item>`,
    );
    const f = makeFetch();
    const svc = createNewsService({
      fetch: (async (input: unknown) => {
        const url = String(input);
        return url.includes("feeds.finance.yahoo.com")
          ? new Response(hostile, { status: 200 })
          : f.fetch(url);
      }) as unknown as typeof fetch,
    });
    const env = ok(await ask(svc, q("m9:1", "NVDA")));
    const bad = env.items.find((i) => i.headline === "Desk note on the tape");
    expect(bad).toBeDefined();
    expect(bad!.link).toBeNull();
  });
});

describe("createNewsService — the body composer", () => {
  test("tier 1: a real description becomes the body verbatim", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("b1:1", "NVDA")));
    const wire = env.items.find((i) => i.bodyKind === "wire");
    expect(wire).toBeDefined();
    expect([PROSE_A, PROSE_B]).toContain(wire!.body);
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

  test("market-wide stubs compose a board-wide note", async () => {
    const svc = createNewsService({ fetch: makeFetch().fetch });
    const env = ok(await ask(svc, q("b3:1", "NVDA,BTC")));
    const wide = env.items.find((i) => i.sym === null && i.bodyKind === "seeded");
    expect(wide).toBeDefined();
    expect(wide!.body).toContain("%");
    expect(wide!.body).toContain("NVDA, BTC");
    expect(wide!.dateline).toContain(": MKT: ");
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
    expect(after).toBe(7);

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
    expect(f.calls).toHaveLength(7);
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

    // NVDA alone: gnews + yahoo + the market-wide stock query = 3.
    await ask(svc, q("f1:1", "NVDA"));
    expect(f.calls).toHaveLength(3);

    // A different match on the same board reuses all three of those documents
    // and opens no new socket.
    await ask(svc, q("f2:1", "NVDA"));
    expect(f.calls).toHaveLength(3);
  });

  test("an expired snapshot rebuilds", async () => {
    const f = makeFetch();
    let clock = 1_700_000_000_000;
    const svc = createNewsService({ fetch: f.fetch, now: () => clock });

    await ask(svc, q("t1:1", "NVDA"));
    expect(f.calls).toHaveLength(3);

    // Past both TTLs.
    clock += 1_900_000;
    await ask(svc, q("t1:1", "NVDA"));
    expect(f.calls).toHaveLength(6);
  });
});

describe("createNewsService — degradation", () => {
  test("one feed 500s: ok, source 'partial', survivors intact", async () => {
    const f = makeFetch((url) => (url.includes("coindesk.com") ? 500 : undefined));
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("p1:1", "NVDA,BTC")));

    expect(env.source).toBe("partial");
    expect(env.items.length).toBeGreaterThan(0);
    const dead = env.feeds.find((r) => r.url.includes("coindesk.com"));
    expect(dead?.status).toBe(500);
    expect(dead?.items).toBe(0);
    expect(env.feeds.filter((r) => r.items > 0).length).toBeGreaterThan(0);
    // The tickers still come through.
    const syms = new Set(env.items.map((i) => i.sym));
    expect(syms.has("NVDA")).toBe(true);
    expect(syms.has("BTC")).toBe(true);
  });

  test("a feed that never answers is status 0, not an exception", async () => {
    const f = makeFetch((url) => (url.includes("cointelegraph.com") ? "throw" : undefined));
    const svc = createNewsService({ fetch: f.fetch });
    const env = ok(await ask(svc, q("p2:1", "NVDA,BTC")));

    expect(env.source).toBe("partial");
    expect(env.feeds.find((r) => r.url.includes("cointelegraph.com"))?.status).toBe(0);
    expect(env.items.length).toBeGreaterThan(0);
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
  test("an unknown ticker is rejected before a socket is opened", async () => {
    const f = makeFetch();
    const svc = createNewsService({ fetch: f.fetch });
    const env = await ask(svc, q("v1:1", "NVDA,HACKME"));

    expect(env.ok).toBe(false);
    if (!env.ok) expect(env.reason).toContain("HACKME");
    expect(env.items).toEqual([]);
    // The important half: no attacker-controlled query reached the network.
    expect(f.calls).toHaveLength(0);
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
