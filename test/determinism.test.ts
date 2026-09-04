/**
 * The determinism boundary, enforced two ways.
 *
 * 1. A *source scan*: nothing under `src/engine/` and nothing in
 *    `src/state/match.ts` may reach for the live news wire. Live news is
 *    PRESENTATION ONLY — it enters exactly one component tree
 *    (`Study → NewsWire`) and never informs what is dealt or how a duel
 *    settles. Settlement must stay a pure function of `(lobby, seed)`, so that
 *    `/match/:id/parlay?seed=N` replays identically on two mounts, on two
 *    machines, and for both players in the same room. A single `import` of
 *    `data/news.ts` into the engine would make settlement depend on wall-clock
 *    network state and silently destroy that guarantee — with no other test
 *    catching it.
 *
 * 2. *Value locks*: hard-coded outputs of the seeded functions. If one of these
 *    fails, a change broke seed-replay compatibility. Do not "fix" the test by
 *    updating the expected values — fix the change, or the demo's shareable
 *    URLs and every stored ledger row stop meaning what they meant.
 *
 * 3. *The injected seam* (plan6 §B4): `spinSlice` deals a real market slice off
 *    a real book, and the book arrives as an **argument**. The ban in (1) is
 *    unchanged and must stay unchanged — the seam moved, it did not open. The
 *    two properties asserted at the bottom of this file are the whole design:
 *    same seed + same book ⇒ the same slice, and same seed + a *different* book
 *    ⇒ the same slice **shape** with different prices behind it. The first says
 *    a shared URL still replays; the second says the game did not memorise an
 *    outcome, because everything priced moved and nothing dealt did.
 */

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { bookFor } from "../src/data/lobbies.ts";
import { type SliceBook, spinCase, spinSlice } from "../src/engine/spin.ts";
import { TAPE_LEN, pctAt, series } from "../src/engine/tape.ts";
import type { PricingRow } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const ENGINE_DIR = join(ROOT, "src", "engine");
const MATCH_STATE = join(ROOT, "src", "state", "match.ts");

/**
 * The forbidden references.
 *
 * This regex is DELIBERATELY NARROW — see BUILD-ORDER §A-k k12. It names the
 * three live-news reach-throughs and nothing else:
 *   - `data/news`  — the NewsSource module
 *   - `data/wire`  — the seeded wire fixture
 *   - `/api/news`  — the server route
 *
 * It must NOT be broadened. In particular, Wave 5 legitimately adds
 * `import { useMatchSound } from "./matchSound.ts"` to `src/state/match.ts`;
 * that import is sound-only, carries no data into settlement, and must keep
 * passing this guard. Widening the pattern to something like /news|wire|match/
 * would fail that legitimate import and would be a gate failure, not a fix.
 */
const LIVE_NEWS_RE = /data\/news|data\/wire|\/api\/news/;

/**
 * The forbidden references, part two: the live *market*.
 *
 * The Thetanuts integration makes the app HYBRID — live Base-chain option
 * prices, greeks and spot anchor everything *visible*, while the duel itself
 * stays the seeded, replayable sim. Live market data is therefore
 * DISPLAY ONLY, exactly as live news is: it may reach `/desk`, the footer, a
 * spot annotation beside a seeded number — and it may never reach the engine
 * or `src/state/match.ts`. One `import` of `data/thetanuts.tsx` into
 * `src/engine/` would make what a seed deals — or what a duel pays — depend on
 * the Base book at wall-clock time, and `/match/:id/parlay?seed=N` would stop
 * replaying identically. No other test catches that.
 *
 * Like LIVE_NEWS_RE this regex is DELIBERATELY NARROW. It names the live
 * market reach-throughs and nothing else:
 *   - `data/thetanuts`   — the client market source / LiveMarket provider
 *   - `server/thetanuts` — the server-side market service
 *   - `/api/market`      — the market route
 *   - `/api/attest`      — the settlement-signature route
 *   - `/api/lock`        — the pick-commit route
 *   - `thetanuts-client` — the SDK package itself
 *
 * It must NOT be broadened. In particular the engine and the match state may
 * keep referring to seeded market *concepts* — `data/universe.ts`, a
 * `MARKET_LABEL` constant, a comment mentioning an SDK helper — because none of
 * those carries a live value. Widening this to /thetanuts|market/ would fail
 * those legitimate references and would be a gate failure, not a fix.
 */
const LIVE_MARKET_RE =
  /data\/thetanuts|server\/thetanuts|server\/seats|\/api\/market|\/api\/attest|\/api\/lock|thetanuts-client/;

/**
 * The forbidden reference, part three: the asset gate itself.
 *
 * `data/qualify.ts` is pure and holds no live value, so `LIVE_MARKET_RE` has no
 * quarrel with it and neither does replay. It is banned from the engine for a
 * different reason, and the reason is the design rather than determinism:
 * **the engine never decides which assets exist.** That is a fact about the
 * book, the book is injected, and `spinSlice(book, qualified, seed)` takes the
 * answer as an argument. An engine module that could call
 * `qualifiedUnderlyings` itself would be a reel that computes its own universe
 * — one refactor away from a reel that computes its own prices, and there would
 * be no test between here and there.
 *
 * Deliberately narrow, like the two above: it names the gate module and nothing
 * else. The engine may keep naming `MarketSlice` and `PricingRow` (they are
 * shapes, declared in `src/types.ts`, and carry no value), and it may keep
 * importing `data/universe.ts`, which is the seeded board.
 */
const ASSET_GATE_RE = /data\/qualify/;

/** Every engine module, globbed at runtime so a NEW engine file is covered the
 *  moment it lands — no test edit required. */
function engineFiles(): readonly string[] {
  return [...new Bun.Glob("*.ts").scanSync({ cwd: ENGINE_DIR, absolute: true })].sort();
}

/** The full guarded set: `src/engine/*.ts` plus `src/state/match.ts`. */
function guardedFiles(): readonly string[] {
  return [...engineFiles(), MATCH_STATE];
}

const rel = (p: string) => relative(ROOT, p).replaceAll("\\", "/");

describe("determinism boundary — live news and live market never reach settlement", () => {
  test("the guard actually covers the engine and the match state", () => {
    const files = engineFiles().map(rel);
    // A broken glob returning [] would make the scan below pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files).toContain("src/engine/spin.ts");
    expect(files).toContain("src/engine/tape.ts");
    expect(files).toContain("src/engine/match.ts");
    expect(files).toContain("src/engine/parlay.ts");
  });

  test("no engine module and no state/match.ts touches the live news wire or the live market", async () => {
    const offenders: string[] = [];
    for (const path of guardedFiles()) {
      const text = await Bun.file(path).text();
      const hit = text.match(LIVE_NEWS_RE) ?? text.match(LIVE_MARKET_RE);
      if (hit) offenders.push(`${rel(path)} → ${hit[0]}`);
    }
    // Presentation-only rule: live news informs the Study wire and live market
    // data informs /desk and the spot annotations — never the deal and never
    // the settle. `(lobby, seed)` is the whole input to settlement.
    expect(offenders).toEqual([]);
  });

  test("no engine module computes its own universe — the gate is injected, never imported", async () => {
    const offenders: string[] = [];
    for (const path of guardedFiles()) {
      const text = await Bun.file(path).text();
      const hit = text.match(ASSET_GATE_RE);
      if (hit) offenders.push(`${rel(path)} → ${hit[0]}`);
    }
    expect(offenders).toEqual([]);

    // The shapes stay importable: they are types, and a type carries no value.
    expect(ASSET_GATE_RE.test(`import type { MarketSlice, PricingRow } from "../types.ts";`)).toBe(
      false,
    );
    expect(ASSET_GATE_RE.test(`import { UNIVERSE } from "../data/universe.ts";`)).toBe(false);
    expect(ASSET_GATE_RE.test(`import { qualifiedUnderlyings } from "../data/qualify.ts";`)).toBe(
      true,
    );
  });

  test("the guard regex stays narrow — it must not swallow legitimate imports", () => {
    // BUILD-ORDER §A-k k12: broadening this pattern is forbidden. These are the
    // three references it exists to catch…
    expect(LIVE_NEWS_RE.test(`import { mockNewsSource } from "../data/news.ts";`)).toBe(true);
    expect(LIVE_NEWS_RE.test(`import { mockWire } from "../data/wire.ts";`)).toBe(true);
    expect(LIVE_NEWS_RE.test(`await fetch("/api/news", { method: "POST" });`)).toBe(true);

    // …and these are references that are legitimate and must keep passing.
    // The first is Wave 5's sound hook landing in src/state/match.ts.
    expect(LIVE_NEWS_RE.test(`import { useMatchSound } from "./matchSound.ts";`)).toBe(false);
    expect(LIVE_NEWS_RE.test(`import { briefsFor } from "../data/briefs.ts";`)).toBe(false);
    expect(LIVE_NEWS_RE.test(`// the wire never contradicts the chart`)).toBe(false);
    expect(LIVE_NEWS_RE.test(`const newsy = "news";`)).toBe(false);
  });

  test("the live-market regex stays narrow — it must not swallow legitimate references", () => {
    // The seven live-market reach-throughs it exists to catch…
    expect(LIVE_MARKET_RE.test(`import { useLiveMarket } from "../data/thetanuts.tsx";`)).toBe(true);
    expect(LIVE_MARKET_RE.test(`import { createMarketService } from "../server/thetanuts.ts";`)).toBe(true);
    // The chain reader behind the escrow's seats: settlement derives the winner
    // from `(lobby, seed)` and committed picks alone, so an engine module that
    // could ask the chain who is playing would be reading the one input the
    // replay cannot reproduce.
    expect(LIVE_MARKET_RE.test(`import { createSeatReader } from "../server/seats.ts";`)).toBe(true);
    expect(LIVE_MARKET_RE.test(`await fetch("/api/market");`)).toBe(true);
    expect(LIVE_MARKET_RE.test(`await fetch("/api/attest", { method: "POST" });`)).toBe(true);
    expect(LIVE_MARKET_RE.test(`await fetch("/api/lock", { method: "POST" });`)).toBe(true);
    expect(
      LIVE_MARKET_RE.test(`import { ThetanutsClient } from "@thetanuts-finance/thetanuts-client";`),
    ).toBe(true);

    // …and these are references that are legitimate and must keep passing.
    // A comment naming an SDK helper carries no live value into settlement.
    expect(LIVE_MARKET_RE.test(`// mirrors client.utils.calculatePayout for the seeded tape`)).toBe(
      false,
    );
    // The seeded universe is the engine's own data and stays importable.
    expect(LIVE_MARKET_RE.test(`import { UNIVERSE } from "../data/universe.ts";`)).toBe(false);
    expect(LIVE_MARKET_RE.test(`const label = MARKET_LABEL[sector];`)).toBe(false);
    expect(LIVE_MARKET_RE.test(`const marketish = "market";`)).toBe(false);
  });
});

describe("engine lock — the seed-replay contract", () => {
  // THESE VALUES ARE THE DETERMINISM CONTRACT. They were read off the running
  // code and frozen. If a test in this block fails, a change broke seed-replay
  // compatibility: the same URL now deals different legs than it did before.
  // Every shared `?seed=N` link, every recorded ledger row and both players in
  // a shared room depend on these staying byte-identical.

  test("the books themselves are pinned (order matters — spinCase indexes into them)", () => {
    // A-k3 moves bookFor from data/lobbies.ts into data/sectors.ts and
    // re-exports it verbatim; its behaviour must not change. The syms locks
    // below are meaningless without this.
    expect(bookFor("STOCK")).toEqual(["NVDA", "AAPL", "TSLA", "XOM", "JPM", "AMD", "META", "GLD", "COIN"]);
    expect(bookFor("CRYPTO")).toEqual(["BTC", "ETH", "SOL", "ARB", "LINK", "UNI", "AAVE", "DOGE", "PEPE"]);
  });

  test("spinCase(bookFor('STOCK'), 3, 424242) deals TSLA / AMD / META", () => {
    const r = spinCase(bookFor("STOCK"), 3, 424242);
    expect(r.syms).toEqual(["TSLA", "AMD", "META"]);
    expect(r.seed).toBe(424242);
    expect(r.rejected).toBe(0);
    expect(r.plans.length).toBe(3);
  });

  test("spinCase(bookFor('CRYPTO'), 3, 424242) deals SOL / UNI / AAVE", () => {
    // Same seed, different book — the book is part of the contract, not just
    // the seed, which is why the sector work in Wave 3 must not perturb it.
    const r = spinCase(bookFor("CRYPTO"), 3, 424242);
    expect(r.syms).toEqual(["SOL", "UNI", "AAVE"]);
    expect(r.rejected).toBe(0);
  });

  test("spinCase(bookFor('CRYPTO'), 2, 90210) deals LINK / AAVE", () => {
    expect(spinCase(bookFor("CRYPTO"), 2, 90210).syms).toEqual(["LINK", "AAVE"]);
  });

  test("replay is idempotent — a second call on the same inputs is deep-equal", () => {
    expect(spinCase(bookFor("STOCK"), 3, 424242)).toEqual(spinCase(bookFor("STOCK"), 3, 424242));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The injected seam — market data as an ARGUMENT, and the property that proves
// the game did not memorise an outcome
// ─────────────────────────────────────────────────────────────────────────────

/** One hand-written row. Everything the reel reads is on it, and nothing else
 *  is, so a book below can be read at a glance and altered one axis at a time. */
function row(
  side: "CALL" | "PUT",
  strike: bigint,
  expiry: number,
  ask: string,
  delta: string,
): PricingRow {
  return {
    type: side,
    strike: (Number(strike) / 1e8).toFixed(2),
    expiry: String(expiry),
    bid: "0.00",
    ask,
    iv: "0.60",
    delta,
    depth: 50,
    size: "1",
    order: {
      order: { price: "0", isBuyer: false, expiry: String(expiry) },
      availableAmount: "10000000000",
      rawApiData: { strikes: [strike.toString()], isCall: side === "CALL" },
    },
  };
}

const E1 = 1788595200;
const E2 = 1789113600;
const D8 = 100000000n;

/** The reference book: two underlyings, two expiries, a five-rung ETH ladder. */
function bookA(): SliceBook {
  return {
    ETH: [
      row("CALL", 2000n * D8, E1, "1.20", "0.72"),
      row("CALL", 2200n * D8, E1, "0.90", "0.58"),
      row("CALL", 2400n * D8, E1, "0.61", "0.41"),
      row("CALL", 2600n * D8, E1, "0.38", "0.27"),
      row("CALL", 2800n * D8, E1, "0.19", "0.14"),
      row("PUT", 2100n * D8, E2, "0.44", "-0.31"),
      row("PUT", 2300n * D8, E2, "0.72", "-0.49"),
      row("PUT", 2500n * D8, E2, "1.05", "-0.66"),
    ],
    BTC: [
      row("CALL", 80000n * D8, E1, "820.00", "0.63"),
      row("CALL", 82000n * D8, E1, "540.00", "0.44"),
      row("PUT", 78000n * D8, E1, "310.00", "-0.22"),
      row("PUT", 84000n * D8, E1, "980.00", "-0.71"),
    ],
  };
}

/** Same instruments, **different prices**. The book moved; nothing the reel
 *  deals moved with it. */
function bookRepriced(): SliceBook {
  const out: Record<string, PricingRow[]> = {};
  for (const [sym, rows] of Object.entries(bookA())) {
    out[sym] = rows.map((r) => ({
      ...r,
      ask: (Number(r.ask) * 1.37 + 0.05).toFixed(2),
      delta: (Number(r.delta) * 0.9).toFixed(2),
    }));
  }
  return out;
}

/** Same **shape** — same underlyings in the same order, the same rung counts,
 *  the same sides — over a different set of listed instruments: every strike a
 *  thousand dollars higher, every expiry a week later. This is the book on a
 *  different day. */
function bookShifted(): SliceBook {
  const out: Record<string, PricingRow[]> = {};
  const WEEK = 7 * 24 * 3600;
  for (const [sym, rows] of Object.entries(bookA())) {
    out[sym] = rows.map((r) => {
      const raw = r.order!.rawApiData!.strikes![0]!;
      const strike = BigInt(raw) + 1000n * D8;
      const expiry = Number(r.order!.order.expiry) + WEEK;
      return row(r.type as "CALL" | "PUT", strike, expiry, r.ask, r.delta);
    });
  }
  return out;
}

/** Where a slice's window sits on its own ladder, as ordinals — the part of a
 *  slice that is the *seed's* decision rather than the book's. */
function shapeOf(book: SliceBook, slice: NonNullable<ReturnType<typeof spinSlice>>) {
  const rows = (book[slice.underlying] ?? []).filter(
    (r) => Number(r.order!.order.expiry) === slice.expiry,
  );
  const expiries = [
    ...new Set((book[slice.underlying] ?? []).map((r) => Number(r.order!.order.expiry))),
  ].sort((a, b) => a - b);
  const ladder = [
    ...new Set(rows.map((r) => BigInt(r.order!.rawApiData!.strikes![0]!))),
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    underlying: slice.underlying,
    constraint: slice.constraint,
    expiryIndex: expiries.indexOf(slice.expiry),
    loIndex: ladder.indexOf(BigInt(slice.strikeLo)),
    hiIndex: ladder.indexOf(BigInt(slice.strikeHi)),
    rungs: ladder.length,
  };
}

/** Every ask the slice's window actually exposes — "the prices", as a player
 *  would meet them. */
function pricesIn(book: SliceBook, slice: NonNullable<ReturnType<typeof spinSlice>>): string[] {
  const lo = BigInt(slice.strikeLo);
  const hi = BigInt(slice.strikeHi);
  return (book[slice.underlying] ?? [])
    .filter((r) => {
      const k = BigInt(r.order!.rawApiData!.strikes![0]!);
      return Number(r.order!.order.expiry) === slice.expiry && k >= lo && k <= hi;
    })
    .map((r) => r.ask);
}

describe("the injected seam — same seed, same slice; same seed, different book", () => {
  const SEEDS = Array.from({ length: 240 }, (_, i) => i + 1);

  test("the guard is still the guard: spin.ts names market SHAPES, never a market SOURCE", async () => {
    // The seam moved into the signature, not through the wall. If this file ever
    // has to be told about `data/thetanuts` to keep passing, the design failed.
    const src = await Bun.file(join(ENGINE_DIR, "spin.ts")).text();
    expect(src).toContain(`import type { MarketSlice, PricingRow } from "../types.ts";`);
    expect(LIVE_MARKET_RE.test(src)).toBe(false);
    expect(ASSET_GATE_RE.test(src)).toBe(false);
  });

  test("same seed + same book ⇒ the same slice, every time", () => {
    for (const seed of SEEDS) {
      const first = spinSlice(bookA(), ["ETH", "BTC"], seed);
      const second = spinSlice(bookA(), ["ETH", "BTC"], seed);
      expect(first).not.toBeNull();
      expect(first).toEqual(second);
    }
  });

  test("same seed + a repriced book ⇒ the IDENTICAL slice, and different prices inside it", () => {
    // The book moved and the arena did not. This is the half of the design that
    // says a shared `?seed=N` link still means what it meant — the reel deals a
    // room, and the room does not know what anything in it costs.
    let sawADifference = false;
    for (const seed of SEEDS) {
      const a = spinSlice(bookA(), ["ETH", "BTC"], seed)!;
      const b = spinSlice(bookRepriced(), ["ETH", "BTC"], seed)!;
      expect(b).toEqual(a);

      const asksA = pricesIn(bookA(), a);
      const asksB = pricesIn(bookRepriced(), b);
      expect(asksA.length).toBe(asksB.length);
      if (asksA.join() !== asksB.join()) sawADifference = true;
    }
    expect(sawADifference).toBe(true);
  });

  test("same seed + a shifted book ⇒ the same slice SHAPE, at different strikes and expiries", () => {
    // The book on another day: same instruments' shape, none of the same lines.
    // The seed's decisions — which name, which expiry *in order*, where on the
    // ladder the window sits, which constraint — survive verbatim. The values
    // are all the book's, and all of them move.
    let sawMovedStrikes = 0;
    for (const seed of SEEDS) {
      const a = spinSlice(bookA(), ["ETH", "BTC"], seed)!;
      const c = spinSlice(bookShifted(), ["ETH", "BTC"], seed)!;

      expect(shapeOf(bookShifted(), c)).toEqual(shapeOf(bookA(), a));

      expect(c.expiry).not.toBe(a.expiry);
      expect(c.strikeLo).not.toBe(a.strikeLo);
      expect(c.strikeHi).not.toBe(a.strikeHi);
      expect(BigInt(c.strikeLo) - BigInt(a.strikeLo)).toBe(1000n * D8);
      sawMovedStrikes++;
    }
    expect(sawMovedStrikes).toBe(SEEDS.length);
  });

  test("with no book at all the reel deals nothing — the seeded board still plays", () => {
    // Offline, or a dead /api/market. A null arena is a true statement; an
    // invented one would be the house dealing a market that is not there. The
    // seeded path is untouched by any of this and keeps its own locks above.
    for (const seed of SEEDS) {
      expect(spinSlice({}, ["ETH", "BTC"], seed)).toBeNull();
      expect(spinSlice(bookA(), [], seed)).toBeNull();
    }
    expect(spinCase(bookFor("STOCK"), 3, 424242).syms).toEqual(["TSLA", "AMD", "META"]);
  });
});

describe("salt shape — the tape the match salts feed", () => {
  // `studySalt` / `fightSalt` are computed inside the `derived` useMemo of
  // src/state/match.ts (`1 + seed * 3` and `2 + seed * 3`) and are NOT exported
  // — there is no reachable symbol to assert against. So we lock the thing they
  // actually control instead: the seeded tape at those exact salt values for
  // seed 424242. Same rationale as the spin locks above — if these drift, the
  // charts and the settlement for a replayed URL have moved.
  //
  // MODE_SALT.NORMAL === 0 is a standing invariant (BUILD-ORDER §C-4 / §D), so
  // Wave 4's mode-salt rewrite keeps these two numbers valid for NORMAL.
  const SEED = 424242;
  const STUDY_SALT = 1 + SEED * 3; // 1272727
  const FIGHT_SALT = 2 + SEED * 3; // 1272728

  test("the salt formulas are still un-exported (if they are ever exported, assert them directly)", async () => {
    const src = await Bun.file(MATCH_STATE).text();
    const exported = /export\s+(?:const|function|let)\s+(?:studySalt|fightSalt)\b/.test(src);
    if (exported) {
      const mod = (await import("../src/state/match.ts")) as unknown as Record<string, unknown>;
      for (const [name, expected] of [
        ["studySalt", STUDY_SALT],
        ["fightSalt", FIGHT_SALT],
      ] as const) {
        const v = mod[name];
        if (typeof v === "function") expect((v as (s: number) => number)(SEED)).toBe(expected);
      }
    } else {
      // Not exported — the tape locks below carry the contract. Still make sure
      // the two salts have not simply been renamed out of existence.
      expect(src).toContain("studySalt");
      expect(src).toContain("fightSalt");
    }
    expect(STUDY_SALT).toBe(1272727);
    expect(FIGHT_SALT).toBe(1272728);
  });

  test("series('NVDA', studySalt) opens and closes on locked prints", () => {
    const s = series("NVDA", STUDY_SALT);
    expect(s.length).toBe(TAPE_LEN);
    expect(s[0]!).toBeCloseTo(118.4, 10);
    expect(s[s.length - 1]!).toBeCloseTo(87.97287043594694, 10);
    expect(pctAt("NVDA", STUDY_SALT, TAPE_LEN)).toBeCloseTo(-25.6985891588286, 10);
  });

  test("series('NVDA', fightSalt) draws a different, equally locked window", () => {
    const s = series("NVDA", FIGHT_SALT);
    expect(s.length).toBe(TAPE_LEN);
    expect(s[0]!).toBeCloseTo(118.4, 10);
    expect(s[s.length - 1]!).toBeCloseTo(82.09000565698891, 10);
    expect(pctAt("NVDA", FIGHT_SALT, TAPE_LEN)).toBeCloseTo(-30.667224951867478, 10);
    // Study and fight windows share an open but must diverge — that is the
    // whole point of the two salts.
    expect(s[s.length - 1]!).not.toBeCloseTo(series("NVDA", STUDY_SALT)[TAPE_LEN - 1]!, 6);
  });
});
