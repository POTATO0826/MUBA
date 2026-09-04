import { describe, expect, test } from "bun:test";
import { cleanText, collapseWs, decodeEntities, parseRss, stripTags, unwrapCdata } from "../src/lib/rss.ts";

/**
 * Fixtures are the real thing, trimmed: every quirk below was observed on a
 * live probe of the four feeds the wire reads (see plan 2's "Verified facts"),
 * so the parser is tested against the formats it will actually meet, not
 * against tidy invented XML.
 *
 *  - Google News: `"Headline - Publisher"` title, `<source url="…">`, a
 *    base64 redirect `<link>`, and a description that is entity-encoded HTML.
 *  - Yahoo Finance: plain-prose description, no `<source>`.
 *  - Cointelegraph: CDATA-wrapped HTML with a trailing `<img>`.
 */

/** Exactly 100 characters — Yahoo's summaries run 60–200 and need no cleaning at all. */
const YAHOO_BODY = "Nvidia said data-center revenue rose again last quarter, as supply of top accelerators stayed tight.";

const GNEWS_ITEM = `<item><title>Nvidia Receives US Government OK to Export H100 Circuits - Reuters</title><link>https://news.google.com/rss/articles/CBMifkFVX3lxTE1hM0Rzd0hVUXpXTGZUdEZ1YkNfMHpxRTZ4?oc=5</link><guid isPermaLink="false">CBMifkFVX3lxTE1hM0Rzd0hVUXpXTGZUdEZ1YkNfMHpxRTZ4</guid><pubDate>Mon, 01 Sep 2025 11:28:00 GMT</pubDate><description>&lt;a href="https://news.google.com/rss/articles/CBMifkFVX3lxTE1hM0Rzd0hVUXpXTGZUdEZ1YkNfMHpxRTZ4?oc=5" target="_blank"&gt;Nvidia Receives US Government OK to Export H100 Circuits&lt;/a&gt;&nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;</description><source url="https://www.reuters.com">Reuters</source></item>`;

const YAHOO_ITEM = `<item><title>Nvidia Q3 revenue tops estimates as data-center demand holds</title><link>https://finance.yahoo.com/news/nvidia-q3-revenue-tops-114500123.html</link><pubDate>Mon, 01 Sep 2025 11:45:00 +0000</pubDate><description>${YAHOO_BODY}</description><guid isPermaLink="false">nvda-q3-revenue-tops-114500123</guid></item>`;

const CT_ITEM = `<item><title><![CDATA[Bitcoin holds $64K as spot ETF inflows resume]]></title><link>https://cointelegraph.com/news/bitcoin-holds-64k-spot-etf-inflows-resume</link><guid isPermaLink="true">https://cointelegraph.com/news/bitcoin-holds-64k-spot-etf-inflows-resume</guid><pubDate>Mon, 01 Sep 2025 12:02:00 +0000</pubDate><description><![CDATA[<p>Bitcoin held above $64,000 on Monday as spot ETF desks at Fidelity &amp; BlackRock logged a third straight day of inflows.</p>
<img src="https://images.cointelegraph.com/btc.jpg" alt="BTC" />]]></description></item>`;

/** The channel wrapper every one of the four feeds ships. */
const doc = (...items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Feed</title><link>https://example.com</link>${items.join("")}</channel></rss>`;

const GNEWS_DOC = doc(GNEWS_ITEM);
const YAHOO_DOC = doc(YAHOO_ITEM);
const CT_DOC = doc(CT_ITEM);
const MULTI_DOC = doc(GNEWS_ITEM, YAHOO_ITEM, CT_ITEM);

const first = (xml: string) => {
  const items = parseRss(xml);
  expect(items.length).toBeGreaterThan(0);
  return items[0]!;
};

describe("cleaning helpers", () => {
  test("unwrapCdata takes the wrapper off, one block or many", () => {
    expect(unwrapCdata("<![CDATA[plain]]>")).toBe("plain");
    expect(unwrapCdata("a<![CDATA[b]]>c<![CDATA[d]]>e")).toBe("abcde");
    expect(unwrapCdata("no wrapper here")).toBe("no wrapper here");
    expect(unwrapCdata("")).toBe("");
  });

  test("unwrapCdata survives a marker the feed never closed", () => {
    expect(unwrapCdata("<![CDATA[cut off mid-body")).toBe("cut off mid-body");
    expect(unwrapCdata("stray close]]>")).toBe("stray close");
  });

  test("decodeEntities handles the named set", () => {
    expect(decodeEntities("Fidelity &amp; BlackRock")).toBe("Fidelity & BlackRock");
    expect(decodeEntities("&lt;p&gt;")).toBe("<p>");
    expect(decodeEntities("say &quot;hi&quot;")).toBe('say "hi"');
    expect(decodeEntities("it&#39;s here")).toBe("it's here");
    expect(decodeEntities("Nvidia&nbsp;Corp")).toBe("Nvidia" + String.fromCharCode(160) + "Corp");
  });

  test("decodeEntities handles decimal and hex forms", () => {
    expect(decodeEntities("don&#8217;t")).toBe("don’t");
    expect(decodeEntities("A&#38;B")).toBe("A&B");
    expect(decodeEntities("it&#x27;s")).toBe("it's");
    expect(decodeEntities("chips &#x2014; and GPUs")).toBe("chips — and GPUs");
    expect(decodeEntities("&#x1F680; launch")).toBe("\u{1F680} launch");
  });

  test("decodeEntities leaves what it cannot decode exactly as written", () => {
    expect(decodeEntities("&bogus; &notanentity; 5 & 6")).toBe("&bogus; &notanentity; 5 & 6");
    expect(decodeEntities("&#xZZZZ; &#99999999999;")).toBe("&#xZZZZ; &#99999999999;");
  });

  test("decodeEntities resolves the double encoding feeds actually ship", () => {
    // XML-escaped HTML that itself carried entities: one pass leaves "&amp;" visible.
    expect(decodeEntities("Tom &amp;amp; Jerry")).toBe("Tom & Jerry");
    expect(decodeEntities("&amp;lt;b&amp;gt;")).toBe("<b>");
  });

  test("stripTags removes markup and joins the remains with a space", () => {
    expect(collapseWs(stripTags("<p>a</p><p>b</p>"))).toBe("a b");
    expect(collapseWs(stripTags('<a href="x" target="_blank">Head</a> <font color="#6f6f6f">Reuters</font>'))).toBe("Head Reuters");
    expect(collapseWs(stripTags('<img src="https://images.cointelegraph.com/btc.jpg" alt="BTC" />'))).toBe("");
  });

  test("stripTags drops a tag the feed cut in half, and comments and script blocks", () => {
    expect(collapseWs(stripTags('body text <img src="https://x/y.jpg'))).toBe("body text");
    expect(collapseWs(stripTags("a<!-- hidden -->b"))).toBe("a b");
    expect(collapseWs(stripTags("keep<script>var x = 1;</script>this"))).toBe("keep this");
  });

  test("stripTags leaves arithmetic prose alone", () => {
    expect(stripTags("held above 3 < 5 > 2")).toBe("held above 3 < 5 > 2");
  });

  test("collapseWs squeezes every flavour of whitespace and trims", () => {
    expect(collapseWs("a" + String.fromCharCode(160) + String.fromCharCode(160) + "b")).toBe("a b");
    expect(collapseWs("  a \n\n b\t\tc   d  ")).toBe("a b c d");
    expect(collapseWs("")).toBe("");
  });
});

describe("cleanText — the pinned order", () => {
  const DOUBLE = "<![CDATA[&lt;p&gt;X &amp;amp; Y&lt;/p&gt;]]>";

  test("CDATA -> entities -> tags -> whitespace yields plain text", () => {
    expect(cleanText(DOUBLE)).toBe("X & Y");
  });

  test("stripping tags before decoding entities would leave the markup visible", () => {
    // The swap the plan warns about: with the markup still encoded, stripTags
    // finds nothing to strip, and the decode then paints "<p>" into the pane.
    const tagsFirst = collapseWs(decodeEntities(stripTags(unwrapCdata(DOUBLE))));
    expect(tagsFirst).toBe("<p>X & Y</p>");
    expect(tagsFirst).not.toBe(cleanText(DOUBLE));
  });

  test("decoding before unwrapping leaves the CDATA marker in the text", () => {
    const cdataLast = collapseWs(stripTags(decodeEntities(DOUBLE)));
    expect(cdataLast).toContain("]]>");
    expect(cdataLast).not.toBe(cleanText(DOUBLE));
  });

  test("the Google News stub cleans down to its headline plus publisher", () => {
    const stub = '&lt;a href="https://news.google.com/rss/articles/CBMi?oc=5" target="_blank"&gt;Chips rally&lt;/a&gt;&nbsp;&lt;font color="#6f6f6f"&gt;Reuters&lt;/font&gt;';
    expect(cleanText(stub)).toBe("Chips rally Reuters");
  });

  test("plain prose passes through untouched", () => {
    expect(cleanText(YAHOO_BODY)).toBe(YAHOO_BODY);
    expect(YAHOO_BODY.length).toBe(100);
  });
});

describe("parseRss — Google News", () => {
  const item = first(GNEWS_DOC);

  test("extracts every field", () => {
    expect(item.title).toBe("Nvidia Receives US Government OK to Export H100 Circuits - Reuters");
    expect(item.link).toBe("https://news.google.com/rss/articles/CBMifkFVX3lxTE1hM0Rzd0hVUXpXTGZUdEZ1YkNfMHpxRTZ4?oc=5");
    expect(item.guid).toBe("CBMifkFVX3lxTE1hM0Rzd0hVUXpXTGZUdEZ1YkNfMHpxRTZ4");
    expect(item.pubDate).toBe("Mon, 01 Sep 2025 11:28:00 GMT");
  });

  test("reads the publisher out of <source> and its url attribute", () => {
    expect(item.source).toBe("Reuters");
    expect(item.sourceUrl).toBe("https://www.reuters.com");
  });

  test("cleans the entity-encoded HTML stub description", () => {
    expect(item.description).toBe("Nvidia Receives US Government OK to Export H100 Circuits Reuters");
    expect(item.description).not.toContain("&lt;");
    expect(item.description).not.toContain("<a");
    expect(item.description).not.toContain("href");
  });

  test("leaves the ' - Publisher' suffix on the title for the service to strip", () => {
    expect(item.title.endsWith(" - Reuters")).toBe(true);
  });
});

describe("parseRss — Yahoo Finance", () => {
  const item = first(YAHOO_DOC);

  test("keeps a plain description verbatim", () => {
    expect(item.description).toBe(YAHOO_BODY);
    expect(item.description.length).toBe(100);
  });

  test("extracts the other fields and leaves the missing <source> empty", () => {
    expect(item.title).toBe("Nvidia Q3 revenue tops estimates as data-center demand holds");
    expect(item.link).toBe("https://finance.yahoo.com/news/nvidia-q3-revenue-tops-114500123.html");
    expect(item.guid).toBe("nvda-q3-revenue-tops-114500123");
    expect(item.pubDate).toBe("Mon, 01 Sep 2025 11:45:00 +0000");
    expect(item.source).toBe("");
    expect(item.sourceUrl).toBe("");
  });
});

describe("parseRss — Cointelegraph", () => {
  const item = first(CT_DOC);

  test("unwraps a CDATA title", () => {
    expect(item.title).toBe("Bitcoin holds $64K as spot ETF inflows resume");
  });

  test("unwraps the CDATA body, strips its HTML and decodes its entities", () => {
    expect(item.description).toBe(
      "Bitcoin held above $64,000 on Monday as spot ETF desks at Fidelity & BlackRock logged a third straight day of inflows.",
    );
    expect(item.description).not.toContain("<p>");
    expect(item.description).not.toContain("<img");
    expect(item.description).not.toContain("CDATA");
    expect(item.description).not.toContain("&amp;");
  });

  test("keeps link and guid as published", () => {
    expect(item.link).toBe("https://cointelegraph.com/news/bitcoin-holds-64k-spot-etf-inflows-resume");
    expect(item.guid).toBe(item.link);
  });
});

describe("parseRss — documents", () => {
  test("reads every item of a multi-item document, in order", () => {
    const items = parseRss(MULTI_DOC);
    expect(items.length).toBe(3);
    expect(items.map((i) => i.source)).toEqual(["Reuters", "", ""]);
    expect(items[0]!.title).toContain("H100");
    expect(items[1]!.description).toBe(YAHOO_BODY);
    expect(items[2]!.title).toContain("Bitcoin");
    expect(items.every((i) => i.pubDate.startsWith("Mon, 01 Sep 2025"))).toBe(true);
  });

  test("channel-level <title> and <link> never leak in as an item", () => {
    expect(parseRss(doc()).length).toBe(0);
    expect(parseRss(MULTI_DOC).some((i) => i.title === "Feed")).toBe(false);
  });

  test("tolerates attributes, mixed case and single-quoted attribute values", () => {
    const odd = doc(
      `<Item><title type="text">Odd but legal</title><description xml:lang="en">Body</description><source url='https://www.marketwatch.com'>MarketWatch</source></Item>`,
    );
    const item = first(odd);
    expect(item.title).toBe("Odd but legal");
    expect(item.description).toBe("Body");
    expect(item.source).toBe("MarketWatch");
    expect(item.sourceUrl).toBe("https://www.marketwatch.com");
  });

  test("a <source> without a url attribute still yields the publisher", () => {
    const item = first(doc(`<item><title>T</title><source>Barron's</source></item>`));
    expect(item.source).toBe("Barron's");
    expect(item.sourceUrl).toBe("");
  });

  test("missing tags become empty strings, never undefined", () => {
    const item = first(doc("<item></item>"));
    expect(item).toEqual({ title: "", link: "", description: "", pubDate: "", source: "", sourceUrl: "", guid: "" });
  });

  test("link, guid, pubDate and sourceUrl are trimmed and nothing more", () => {
    const item = first(
      doc(
        `<item><link>\n  https://ex.com/a?x=1&amp;y=2  \n</link><guid>  raw:GUID  </guid><pubDate>  Tue, 02 Sep 2025 09:00:00 GMT </pubDate><source url="  https://www.reuters.com  ">R</source></item>`,
      ),
    );
    // The href is an opaque identifier — decoding or collapsing it would hand
    // the wire a different URL than the feed published.
    expect(item.link).toBe("https://ex.com/a?x=1&amp;y=2");
    expect(item.guid).toBe("raw:GUID");
    expect(item.pubDate).toBe("Tue, 02 Sep 2025 09:00:00 GMT");
    expect(item.sourceUrl).toBe("https://www.reuters.com");
  });
});

describe("parseRss — malformed input never throws", () => {
  test("empty and whitespace input yields []", () => {
    expect(parseRss("")).toEqual([]);
    expect(parseRss("   \n\t ")).toEqual([]);
  });

  test("garbage yields [] without throwing", () => {
    const junk = [
      "not xml at all <<< >>> &&& ]]>",
      "<html><body><h1>429 Too Many Requests</h1></body></html>",
      '{"error":"rate limited"}',
      "<rss><channel><item><title>unclosed",
      "<![CDATA[",
      "&#;&#x;&&&;",
      "<item".repeat(200),
    ];
    for (const s of junk) {
      expect(() => parseRss(s)).not.toThrow();
      expect(Array.isArray(parseRss(s))).toBe(true);
    }
    expect(parseRss("not xml at all <<< >>> &&& ]]>")).toEqual([]);
    expect(parseRss("<html><body><h1>429 Too Many Requests</h1></body></html>")).toEqual([]);
  });

  test("a document cut mid-tag drops the incomplete item", () => {
    const cut = GNEWS_DOC.slice(0, GNEWS_DOC.indexOf("<description>") + 40);
    expect(cut).toContain("<item>");
    expect(cut).not.toContain("</item>");
    expect(parseRss(cut)).toEqual([]);
  });

  test("a document cut after two items keeps those two", () => {
    const cut = MULTI_DOC.slice(0, MULTI_DOC.indexOf(CT_ITEM) + 80);
    const items = parseRss(cut);
    expect(items.length).toBe(2);
    expect(items[0]!.source).toBe("Reuters");
    expect(items[1]!.description).toBe(YAHOO_BODY);
  });

  test("an item whose CDATA was truncated still parses, minus the wrapper", () => {
    const item = first(
      doc(`<item><title>Cut short</title><description><![CDATA[<p>Bitcoin held above $64,000 as ETF de</description></item>`),
    );
    expect(item.title).toBe("Cut short");
    expect(item.description).toBe("Bitcoin held above $64,000 as ETF de");
  });
});
