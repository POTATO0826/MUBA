import { briefsFor } from "./briefs.ts";
import { mockWire } from "./wire.ts";

/**
 * The news seam: one interface, two implementations, and a hard boundary.
 *
 * This clones the shape of `MarketSource` in `data/market.ts` — an id, a couple
 * of methods, injected at the root through `<App newsSource={…}/>` — for the
 * same reason: the wire has to be swappable between a seeded offline feed and a
 * live server without a single view knowing which one it got.
 *
 * The boundary matters more here than it does for the market source. Live news
 * is PRESENTATION ONLY. It enters exactly one component tree (`Study →
 * NewsWire`) and never reaches `src/engine/**` or `src/state/match.ts`, so a
 * duel settles as a pure function of `(lobby, seed)` whether the network is up,
 * down, rate-limited or serving yesterday's headlines. `test/determinism.test.ts`
 * enforces that by scanning those files for a reference to this module.
 *
 * `WireItem` itself is NOT declared here — it belongs to `data/wire.ts`, which
 * is where the seeded feed is built and where the field-by-field documentation
 * lives. It is re-exported so callers can take the whole news vocabulary from
 * one import.
 */
export type { WireItem } from "./wire.ts";

import type { WireItem } from "./wire.ts";

/** What a caller asks a source for. */
export interface WireRequest {
  /** `"${lobbyId}:${seed}"` — the server freezes one payload per match so both
   *  players read byte-identical copy. Derived in `state/match.ts`. */
  matchKey: string;
  /** The dealt tickers. Every one of them should come back represented. */
  tickers: readonly string[];
  /** The study salt. Seeded sources build their whole feed from it. */
  salt: number;
  /** Cap on returned rows. Omitted means "whatever the source considers a feed". */
  limit?: number;
}

/** What a source answers with. Never a rejection — see `liveNewsSource`. */
export interface WireResult {
  /** `false` means "nothing usable"; the caller keeps whatever it already had. */
  ok: boolean;
  /** Drives the terminal's header chip: SEEDED / LIVE / PARTIAL. `"partial"` is
   *  live copy that came back with one or more feeds missing. */
  source: "mock" | "live" | "partial";
  /** Epoch ms the payload was assembled — a live source reports the snapshot's
   *  age, not the moment of the request that hit the cache. */
  fetchedAt: number;
  items: readonly WireItem[];
  /** Human-readable reason, for a failed or degraded fetch. */
  note?: string;
}

/** The seam. One id, one call. */
export interface NewsSource {
  readonly id: string;
  wire(req: WireRequest): Promise<WireResult>;
}

/**
 * The seeded wire: no network, no clock dependence, no failure mode.
 *
 * It is three things at once — the offline experience, the fallback every live
 * failure lands on, and the fixture every test runs against — which is why it
 * is a `Promise.resolve` over a pure function rather than anything cleverer.
 *
 * The desk exchange is drawn here rather than passed in: `briefsFor` is already
 * a pure function of `(tickers, salt)`, so a source given the same request
 * always produces the same desk rows as the caller's own synchronous seeding.
 * `mockWire` takes the briefs array whole and keeps only the desk half.
 */
export const mockNewsSource: NewsSource = {
  id: "mock",
  wire: (req) => {
    const items = mockWire(req.tickers, req.salt, briefsFor(req.tickers, req.salt));
    return Promise.resolve({
      ok: true,
      source: "mock",
      fetchedAt: Date.now(),
      // A limit is a cap, not a target — the seeded feed is already bounded.
      items: req.limit === undefined ? items : items.slice(0, req.limit),
    });
  },
};

/** The route `src/server/news.ts` is mounted on, and the query-parameter names
 *  its `parse()` reads: `match`, `tickers`, `salt`, `limit`. */
const NEWS_ROUTE = "/api/news";

/** A hung server must never strand the Study screen. The wire is a decoration
 *  over an already-painted seeded feed, so a slow answer is worth less than a
 *  fast fallback: abort at four seconds and take the mock. */
const WIRE_TIMEOUT_MS = 4_000;

/** How many rows to ask for when the caller did not say. The server clamps
 *  this to its own `MAX_LIMIT` anyway. */
const DEFAULT_WIRE_LIMIT = 60;

/**
 * The envelope as this module is willing to trust it.
 *
 * Deliberately structural rather than an import of `NewsOk`/`NewsFail` from
 * `server/news.ts`: the client bundle must not pull the server's feed table,
 * its RSS parser or its cache in through a type-only edge that a bundler is
 * free to keep. The shape is small and it is checked at runtime below, because
 * `res.json()` is `any` no matter what it is annotated as.
 */
interface WireEnvelope {
  ok?: unknown;
  source?: unknown;
  fetchedAt?: unknown;
  items?: unknown;
  reason?: unknown;
}

/**
 * The live wire: one GET, one envelope, and exactly one fallback.
 *
 * Every failure mode this call has — a network throw, a non-200, a four-second
 * timeout, an `ok:false` envelope, a body that is not JSON, a success envelope
 * carrying zero rows — collapses to the same answer: `mockNewsSource.wire(req)`.
 * That is the single point where the seeded feed is substituted for the live
 * one, and it is why the whole body sits inside one `try`. Two consequences
 * worth stating:
 *
 *  - **The source never rejects.** `state/wire.ts` catches, but only as a
 *    defence against a buggy source; nothing here is allowed to reach it.
 *  - **The status chip stays honest.** A fallback result is the mock's own
 *    result, `source: "mock"` included, so the header reads SEEDED rather than
 *    claiming a LIVE feed it does not have. A degraded-but-real answer keeps
 *    the server's own `"partial"`, which reads PARTIAL.
 */
export const liveNewsSource: NewsSource = {
  id: "live",
  wire: async (req) => {
    try {
      const params = new URLSearchParams({
        match: req.matchKey,
        tickers: req.tickers.join(","),
        salt: String(req.salt),
        limit: String(req.limit ?? DEFAULT_WIRE_LIMIT),
      });

      const res = await fetch(`${NEWS_ROUTE}?${params.toString()}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(WIRE_TIMEOUT_MS),
      });
      // The route is contracted to answer 200 with a typed envelope even when
      // it has nothing; anything else is a proxy, a dev-server hiccup or a
      // deploy in flight, and none of those are worth reading a body for.
      if (!res.ok) return await mockNewsSource.wire(req);

      const body = (await res.json()) as WireEnvelope | null;
      if (!body || body.ok !== true) return await mockNewsSource.wire(req);
      if (!Array.isArray(body.items) || body.items.length === 0) {
        return await mockNewsSource.wire(req);
      }

      return {
        ok: true,
        // Only the server's two live states are honoured; an unrecognised
        // string must not be able to spell itself onto the chip.
        source: body.source === "partial" ? "partial" : "live",
        // The snapshot's age, not the moment of this request — a cache hit
        // replays the frozen envelope's own timestamp.
        fetchedAt: typeof body.fetchedAt === "number" ? body.fetchedAt : Date.now(),
        items: body.items as readonly WireItem[],
      };
    } catch {
      // Network throw, abort, malformed JSON — one landing pad for all of it.
      return await mockNewsSource.wire(req);
    }
  },
};
