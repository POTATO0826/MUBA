# Plan 2 — Study phase: terminal news wire (live + seeded fallback)

## Verified facts (live-probed)
All feeds return 200 with plain server-side `fetch()`, no key, no UA header, no CORS proxy (browser would be blocked):

| Feed | URL | Items | Latency | description usable as body? |
|---|---|---|---|---|
| Google News RSS | `https://news.google.com/rss/search?q=<q>&hl=en-US&gl=US&ceid=US:en` | 100 | ~530–710ms | NO — `<a>`+`<font>` HTML stub |
| Yahoo Finance RSS | `https://feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA&region=US&lang=en-US` | 20 | ~260ms | YES — real 60–200 char summaries |
| CoinDesk | `https://www.coindesk.com/arc/outboundfeeds/rss` | ~20 | ok | YES, CDATA plain text |
| Cointelegraph | `https://cointelegraph.com/rss` | ~30 | ok | YES, CDATA HTML (needs tag strip) |

Gotchas:
- CoinDesk `/rss/` with trailing slash → 308. Use `/rss` or follow redirects.
- Google News title is `"Headline - Publisher"` with `<source url="…">Publisher</source>` per item. Strip the `" - " + publisher` suffix using the `<source>` value, NOT blind `lastIndexOf(" - ")`.
- Google News `<link>` is a base64 redirect — link out as-is, don't resolve.
- Yahoo `s=BTC-USD` works; ARB/PEPE need suffixed IDs (`PEPE24478-USD`) — treat a Yahoo miss as silent skip, never an error.
- Yahoo per-symbol relevance is loose — fine for flavor; exactly why the wire must not touch the engine.
- Google News feed `<copyright>` restricts to personal non-commercial use — fine for local demo; `THETADUEL_NEWS=off` switch exists so a public build ships on the seeded wire alone.

## Architecture & determinism boundary

```
                    ┌─ mockNewsSource  (seeded, sync, offline)   ← tests + fallback
NewsSource iface ───┤
                    └─ liveNewsSource → GET /api/news → src/server/news.ts
                                            ├─ per-match snapshot cache
                                            ├─ per-feed TTL cache
                                            └─ fetch + src/lib/rss.ts
```

Clones the existing `MarketSource` seam (data/market.ts + client.tsx injection + Footer reading source.id).

**Boundary rules:**
- Live wire data enters exactly one component tree: `Study → NewsWire`. Nothing else.
- `src/engine/**` and `src/state/match.ts` never import data/news.ts or data/wire.ts, never read /api/news. Guarded by a source-scanning test.
- `derived` gains ONE additive line — `matchKey = "${lobby.id}:${state.seed}"` — nothing else. `briefsFor` stays and keeps feeding the desk exchange.
- Settlement reads fightSalt + legState only. The (lobby, seed) invariant survives verbatim.

**Shared wire: fetch once, cache server-side per match** (key `matchKey`). First player's request fetches and freezes the payload; second player gets the byte-identical payload. Timestamps formatted server-side in America/New_York so two players in different zones can't desync.

## Types (in src/data/news.ts — kept out of types.ts)

```ts
export interface WireItem {
  id: string;            // stable hash of guid || link || headline
  kind: "news" | "desk";
  sym: string | null;    // null = market-wide, renders "MKT"
  ts: number;            // epoch ms — sort key
  time: string;          // "07:47:14" ET
  headline: string;      // publisher suffix stripped
  publisher: string;     // "REUTERS"
  body: string;          // NEVER empty — three-tier composer
  bodyKind: "wire" | "seeded" | "desk-note";
  link: string | null;
  dateline: string;      // "9/1/26 09:28:00: NVDA: …"
  signature: string;     // "(END) DOW JONES NEWSWIRES / 09-01-26 1028ET / Copyright …"
  who?: string;          // desk rows: "DESK" | "COACH"
}
export interface WireRequest { matchKey: string; tickers: readonly string[]; salt: number; limit?: number }
export interface WireResult { ok: boolean; source: "mock" | "live" | "partial"; fetchedAt: number; items: readonly WireItem[]; note?: string }
export interface NewsSource { readonly id: string; wire(req: WireRequest): Promise<WireResult> }
```

**Body composer, three tiers (detail pane never empty):**
1. Feed gave a real description (Yahoo/CoinDesk/Cointelegraph) → unwrap CDATA, strip tags, decode entities.
2. No body (Google News, ~70%) → compose a seeded desk note from the study window the engine already computed (`pctAt`, `series` hi/lo, `meta().vol`, `meta().t`): e.g. "NVDA prints −3.2% across the study window, 112.40–121.85, on realised σ of 3.0% daily. The wire carries this line from CNBC; the desk has no tape on it beyond the window above." Fabricates nothing about the news; always has figures; seed-derived so both screens match.
3. Mock wire → pre-written multi-sentence body from the template pool.

## Steps (demo works after every one)

### Step 1 — src/data/wire.ts (NEW): enriched seeded wire — MUST
`mockWire(syms, salt, deskLines): readonly WireItem[]`
- Per ticker, 4 items from an UP or DOWN pool selected by `pctAt(sym, salt, TAPE_LEN) >= 0` (same rule briefs.ts uses — wire never contradicts the chart). 3 legs → 12 headlines + 2 desk rows.
- Pool entries `{ head(ctx), body(ctx) }`, ctx = { sym, name, sector, pct, px, lo, hi, volPct, target }. Bodies interpolate seeded figures ("$X million in quarterly sales", "down N.N% in morning trading").
- 8 UP + 8 DOWN templates for stocks, 8+8 for crypto (4 legs × 4 items never visibly repeat). Publishers: stocks ["DOW JONES NEWSWIRES","REUTERS","BLOOMBERG","MARKETWATCH","BARRON'S","THE WALL STREET JOURNAL"]; crypto ["COINDESK","THE BLOCK","COINTELEGRAPH","DECRYPT","BLOOMBERG CRYPTO"].
- Synthetic session clock: seeded ET open, seeded 30–900s gaps, ts descending. Dateline date derives from the same hash `windowLabel()` uses in engine/tape.ts so wire date agrees with chart label.
- Desk lines from existing `briefsFor()` become kind:"desk" items pinned at top.
- Everything from `seededRandom(salt * 131 + syms.length)` — identical seed → deep-equal output.
- **Leave src/data/briefs.ts untouched** (test/parlay.test.ts "briefs" block keeps passing).

### Step 2 — src/components/NewsWire.tsx (NEW): two-pane terminal — MUST
```
border:1px solid C.border;border-radius:12px;background:C.card;overflow:hidden
├ header (keep existing bar verbatim: pulse dot + "NEWS WIRE · DESK CHATTER")
│   right: data-testid="wire-status" chip → LIVE (C.green) / SEEDED (C.amber)
├ TOP PANE — headline list. height:288px;overflow-y:auto;background:C.panel
│   row: grid 76px 46px minmax(0,1fr); padding:6px 14px; cursor:pointer;
│        border-bottom:1px solid C.lineSoft; font:400 11.5px/1.45 MONO; nowrap ellipsis
│     col1 "07:47:14" C.faint · col2 sym chip tag(sectorColor) 8px or "MKT" C.dim · col3 headline C.textSoft
│     selected: background:rgba(200,255,0,.08); inset 2px accent bar; C.text
│   desk rows pinned first, who badge in place of sym chip
└ BOTTOM PANE — detail (data-testid="wire-detail"). min-height:196px;padding:16px 20px;background:C.panelAlt
    dateline (data-testid="wire-dateline"): centered 700 12px MONO, bottom hairline
    body: 400 12.5px/1.7 SANS C.muted, max-width:74ch centered
    link (live items only, _blank noreferrer)
    signature (data-testid="wire-signature"): 400 10.5px MONO C.faint
```
- Selection survives mock→live swap: `selId: string | null`, `selected = items.find(i => i.id === selId) ?? items[0]`. First item auto-opens — empty pane structurally impossible.
- Test hooks: `data-wire="news"|"desk"`, `data-wire-id`, `data-wire-sym`; ALSO keep `data-brief="desk"` on desk rows (one existing assertion survives).
- role="listbox"/"option" aria-selected, tabIndex; ↑/↓ nav nice-to-have.

### Step 3 — Study.tsx rework — MUST
- Props: `briefs` → `wire: readonly WireItem[]`, `wireStatus`. Charts grid, header, 320px sidebar stay.
- Delete inline wire block; render `<NewsWire/>`.
- Coach dialogue intact in both places: sidebar READ 01/02/03 card untouched; DESK/COACH exchange pinned atop the wire list.

### Step 4 — src/data/news.ts + src/state/wire.ts (NEW) — MUST
- `mockNewsSource`: wire(req) → Promise.resolve({ok:true, source:"mock", items: mockWire(...)}).
- `useWire({source, matchKey, arena, salt, deskLines})`: useState initialized SYNCHRONOUSLY to mockWire (non-empty first paint, test-safe); useEffect calls source.wire; on ok && items.length swap live, else keep mock; ignore-flag abort.
- App.tsx: `newsSource: NewsSource = mockNewsSource` prop; pass wire/wireStatus to Study. Tests get mock by default, zero network.
- state/match.ts: one line — `matchKey`.

### Step 5 — src/lib/rss.ts (NEW): pure parser — SHOULD
`parseRss(xml): RssItem[]` — regex-based (no XML dep): split `<item>…</item>`, per-tag capture, attribute capture for `<source url>`. **Order matters: unwrapCdata → decodeEntities → stripTags → collapseWs** (reversed leaves literal markup visible). Decode named + numeric + hex entities. Malformed input → `[]`, never throws.

### Step 6 — src/server/news.ts (NEW) + /api/news route — SHOULD
`createNewsService(deps?: { fetch?, now? })` — inject fetch for offline unit tests.
`feedsFor(sym)` derives queries from `meta(sym)` (name, mkt) — NEVER a hard-coded ticker table (new sectors get feeds for free):
```
STOCK   gnews q=`"${name}" OR ${sym} stock when:7d`  cap 14; yahoo s=sym cap 8
CRYPTO  gnews q=`"${name}" OR ${sym} crypto when:7d` cap 14; yahoo s=`${sym}-USD` (miss ⇒ skip) cap 8
market-wide once if any crypto: coindesk /rss cap 6; cointelegraph /rss cap 6
market-wide once if any stock: gnews "stock market options volatility when:2d" cap 6
```
- AbortSignal.timeout(2500) per feed, Promise.allSettled, ~3s budget.
- Caches: feedCache by URL (FEED_TTL_MS 300_000); matchCache by matchKey (MATCH_TTL_MS 1_800_000 — named constant, must exceed longest study duration from plan 1's modes). Both bounded 200 entries, oldest-evicting. In-flight dedupe.
- Merge: ceil(limit/tickers.length) per ticker (every dealt ticker appears), union, dedupe on normalized headline key (lowercase, punctuation-stripped, first 60 chars), sort ts desc + id tiebreak, cap limit (default 60).
- Pseudo-seconds: `hash(id) % 60` (many pubDates land on :00) — deterministic per item.
- Always responds 200 with typed envelope: `{ok, source:"live"|"partial", matchKey, fetchedAt, feeds:[{url,status,items,ms}], items}` or `{ok:false, reason, items:[]}`.
- index.ts: `routes: { "/api/news": (req) => news.handle(new URL(req.url)), "/*": index }` — Bun matches most-specific first.
- `THETADUEL_NEWS=off` disables (ok:false immediately → client stays seeded).

### Step 7 — liveNewsSource + client.tsx — SHOULD
`liveNewsSource.wire(req)` fetches /api/news; ANY failure (throw, !ok, empty) returns `mockNewsSource.wire(req)` — fallback in exactly one place. client.tsx: `<App source={mockMarketSource} newsSource={liveNewsSource}/>`. Status chip reads SEEDED on fallback.

### Step 8 — Tests + README — SHOULD

## Test impact
Breaks exactly 2 (both in app.test.tsx "the case study"):
1. `[data-brief="news"]` length-3 → repoint `[data-wire="news"]`, assert `length >= arena.length` + every dealt sym in `[data-wire-sym]`. The `data-brief="desk"` length-2 and `>=3 svg` assertions survive. Keep header string "NEWS WIRE · DESK CHATTER" verbatim.
2. "same wire every time for a seed" queries `[data-brief]` → repoint `[data-wire]`. Green because App defaults to mockNewsSource.
parlay.test.ts "briefs" block unaffected.

New (all offline):
- test/rss.test.ts — 3 checked-in fixture strings (gnews with source url + entities; yahoo; cointelegraph CDATA). Field extraction, CDATA→entity→tag ordering, garbage → [] no throw.
- test/wire.test.ts — same (syms,salt) deep-equals; different salt differs; every item non-empty body/signature/dateline, time matches /^\d{2}:\d{2}:\d{2}$/; ts strictly descending; exactly one desk pair; ≥3 items per sym; positive-pct sym never draws a DOWN headline.
- test/news-service.test.ts — createNewsService({fetch: fakeFetch}) over fixture XML: happy path; same matchKey twice → one fakeFetch call + deep-equal payloads; different key refetches; one feed 500s → ok:true "partial"; all fail → ok:false items:[]; garbage → [] no throw. beforeAll sets globalThis.fetch to throw ("network in test") as hard guard.
- test/determinism.test.ts — read src/engine/*.ts + state/match.ts via Bun.file().text(), assert none matches /data\/news|data\/wire|\/api\/news/. Lock engine: spinCase(bookFor("STOCK"),3,424242).syms toEqual hard-coded values.
- app.test.tsx additions — row click swaps dateline/detail; detail non-empty before any click; status reads SEEDED default; stub NewsSource resolving live flips to LIVE after act(async).

## Must vs nice
MUST: Steps 1–4 (full terminal on seeded wire, zero network). SHOULD: 5–8 (live + graceful degradation + tests + README). NICE: ↑/↓ nav; rate-limited "refresh wire" button; per-ticker filter chips (pill()); prefetch /api/news when spin locks (actions.claim); Cache-Control + ETag; crawling marquee headline strip (vcStream exists).

## Collision notes with plan 1
Untouched: CreateLobby.tsx, LobbyForm, data/lobbies.ts, engine/spin.ts. Only state/match.ts edit is the additive matchKey line. App.tsx edits: one new prop + Study prop list. Hold to: feedsFor derives from universe.ts metadata; MATCH_TTL_MS named constant ≥ longest study duration.
