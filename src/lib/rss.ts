/**
 * RSS, by regex, on purpose.
 *
 * The news wire reads four feeds that agree on almost nothing: Google News
 * ships an entity-encoded `<a>`+`<font>` stub as its description and hides the
 * publisher in `<source url="…">`, Yahoo Finance ships plain prose,
 * Cointelegraph ships CDATA-wrapped HTML with a trailing `<img>`, CoinDesk
 * ships CDATA plain text. A real XML parser would be a dependency, would throw
 * on the first malformed byte, and would still leave every one of those
 * cleaning problems on the table. So: no dependency, no DOM, no network, no
 * clock. A string goes in, an array comes out, and nothing in here can throw —
 * a feed that returns half a document, an HTML error page, or a truncated
 * chunk yields the items it managed to read, or `[]`. The caller
 * (`src/server/news.ts`) treats a short list as a partial feed, never as an
 * error, which is only safe because this file never surprises it.
 *
 * **The cleaning order is load-bearing: unwrapCdata → decodeEntities →
 * stripTags → collapseWs.** Entities before tags is the half that matters
 * most: Google News writes its markup as `&lt;a href=…&gt;`, so stripping tags
 * first finds nothing to strip and the decode then paints literal `<a href=…>`
 * across the detail pane. CDATA comes first because a CDATA block is a
 * transport wrapper, not content — unwrap it and whatever it was hiding
 * (entities, raw HTML, both) becomes visible to the two steps that handle it.
 *
 * The helpers are exported one by one so each link of that chain is testable
 * on its own; `cleanText` is the only composition, and it is the composition
 * `parseRss` uses.
 */

/** One `<item>` of a feed, cleaned. Every field is a string — never null. */
export interface RssItem {
  /** Display text. Google News keeps its `" - Publisher"` suffix here; stripping it is the service's job, not the parser's. */
  title: string;
  /** Href as published. Google News links are base64 redirects — opaque, and passed through untouched. */
  link: string;
  /** Body text, markup gone. Often empty on Google News — the wire composes a fallback. */
  description: string;
  /** RFC-822 date string, unparsed. The service owns time zones and formatting. */
  pubDate: string;
  /** Publisher name from `<source>`. Empty on feeds that carry no `<source>` (Yahoo, Cointelegraph). */
  source: string;
  /** The `url` attribute of `<source>`. */
  sourceUrl: string;
  /** Feed-supplied id. May be a permalink, a hash, or empty. */
  guid: string;
}

/** Entities every feed in the set actually emits. Numeric and hex forms are handled generically. */
const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: String.fromCharCode(160), // U+00A0; collapseWs later folds it into a plain space
};

const CDATA_BLOCK = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
const CDATA_OPEN = /<!\[CDATA\[/g;
const CDATA_CLOSE = /\]\]>/g;
const ENTITY = /&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const SCRIPTY = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/**
 * A tag opens with a letter, `/`, `!` or `?`. Requiring that instead of the
 * usual `<[^>]*>` keeps prose like "held above 3 < 5 > 2" intact, which turns
 * up in headlines about price levels more often than you would think.
 */
const TAG = /<[/!?]?[a-zA-Z][^>]*>|<[/!?][^>]*>/g;
/** The same shape, unterminated at the end of the string: a feed cut mid-`<img src="`. */
const TAG_TAIL = /<[/!?]?[a-zA-Z][^>]*$/;

/** Strips `<![CDATA[ … ]]>` wrappers, including a lone marker left by a truncated feed. */
export function unwrapCdata(s: string): string {
  if (!s) return "";
  return s.replace(CDATA_BLOCK, "$1").replace(CDATA_OPEN, "").replace(CDATA_CLOSE, "");
}

function decodeOnce(s: string): string {
  return s.replace(ENTITY, (whole: string, body: string) => {
    if (body.charCodeAt(0) === 35 /* # */) {
      const hex = body[1] === "x" || body[1] === "X";
      const cp = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      // Reject NUL, lone surrogates and out-of-plane junk; an entity we cannot
      // decode is left exactly as written rather than turned into a replacement char.
      if (!Number.isFinite(cp) || cp < 1 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      try {
        return String.fromCodePoint(cp);
      } catch {
        return whole;
      }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

/**
 * Decodes named, decimal and hex entities to a fixed point (at most four
 * passes — decoding only ever shortens the string, so this terminates).
 *
 * The repeat is not decoration: feeds double-encode. A Google News description
 * is HTML that was then XML-escaped, so an ampersand in the headline arrives as
 * `&amp;amp;` — one pass leaves the literal text `&amp;` sitting in the detail
 * pane. An entity this table does not know (`&bogus;`) survives verbatim.
 */
export function decodeEntities(s: string): string {
  if (!s) return "";
  let out = s;
  for (let i = 0; i < 4 && out.includes("&"); i++) {
    const next = decodeOnce(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Removes comments, `<script>`/`<style>` blocks and every tag, substituting a
 * space so `<p>A</p><p>B</p>` reads "A B" and not "AB". `collapseWs` mops up.
 */
export function stripTags(s: string): string {
  if (!s) return "";
  return s.replace(COMMENT, " ").replace(SCRIPTY, " ").replace(TAG, " ").replace(TAG_TAIL, " ");
}

/** Runs of whitespace — `\s` covers tabs, newlines and the NBSP `&#160;` decodes to — become one space; ends trimmed. */
export function collapseWs(s: string): string {
  if (!s) return "";
  return s.replace(/\s+/g, " ").trim();
}

/**
 * The pinned chain. Do not reorder — see the file header for what each swap
 * costs. Applied to `title`, `description` and `source`; the machine-readable
 * fields (`link`, `guid`, `pubDate`, `sourceUrl`) get `trim()` and nothing
 * else, because collapsing whitespace inside a base64 redirect or "decoding" a
 * URL's `&amp;` changes an identifier the feed handed us.
 */
export function cleanText(s: string): string {
  return collapseWs(stripTags(decodeEntities(unwrapCdata(s))));
}

/** First `<tag …>…</tag>` in the block, attributes tolerated. Missing tag → "". */
function tagOf(block: string, tag: string): string {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i").exec(block);
  return m?.[1] ?? "";
}

/** An attribute off a tag's opening angle bracket — double, single or bare quoted. */
function attrOf(block: string, tag: string, attr: string): string {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, "i").exec(block);
  if (!open) return "";
  const m = new RegExp(`\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(open[1] ?? "");
  return m?.[2] ?? m?.[3] ?? m?.[4] ?? "";
}

/**
 * Every `<item>` in a feed document, in document order. An item missing a tag
 * gets an empty string for it; a document that ends mid-item drops that item
 * and keeps the ones before it; anything unrecognisable yields `[]`. This
 * function does not throw.
 */
export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  if (typeof xml !== "string" || xml.length === 0) return out;
  try {
    for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/gi)) {
      const block = m[1] ?? "";
      try {
        out.push({
          title: cleanText(tagOf(block, "title")),
          link: tagOf(block, "link").trim(),
          description: cleanText(tagOf(block, "description")),
          pubDate: tagOf(block, "pubDate").trim(),
          source: cleanText(tagOf(block, "source")),
          sourceUrl: attrOf(block, "source", "url").trim(),
          guid: tagOf(block, "guid").trim(),
        });
      } catch {
        // One unreadable item never sinks the feed — the wire would rather
        // show nine headlines than none.
      }
    }
  } catch {
    return out;
  }
  return out;
}
