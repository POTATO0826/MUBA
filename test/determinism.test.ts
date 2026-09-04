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
 */

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { bookFor } from "../src/data/lobbies.ts";
import { spinCase } from "../src/engine/spin.ts";
import { TAPE_LEN, pctAt, series } from "../src/engine/tape.ts";

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
const LIVE_MARKET_RE = /data\/thetanuts|server\/thetanuts|\/api\/market|\/api\/attest|\/api\/lock|thetanuts-client/;

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
    // The six live-market reach-throughs it exists to catch…
    expect(LIVE_MARKET_RE.test(`import { useLiveMarket } from "../data/thetanuts.tsx";`)).toBe(true);
    expect(LIVE_MARKET_RE.test(`import { createMarketService } from "../server/thetanuts.ts";`)).toBe(true);
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
