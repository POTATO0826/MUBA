/**
 * The copy-trader profile — the eToro surface, and the dollars under it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS GUARDING
 * ────────────────────────────────────────────────────────────────────────────
 * `test/rank.test.ts` pins the GENERATOR: the seeded draws, the draw order, and
 * every number that falls out of them. Not one assertion in this file may move
 * one of those — everything here is downstream of them, derived by pure
 * functions that draw nothing. So the first test below is the load-bearing one:
 * it re-runs `build` over the whole roster and checks the pinned economics are
 * character-for-character what they were before the profile existed.
 *
 * The rest is the new surface, and it is held to three bars:
 *
 *   DETERMINISTIC   a profile is a function of the persona and nothing else, so
 *                   two builds of the same id agree to the last decimal.
 *   PLAUSIBLE       a copy leaderboard where the best trader returned 12,000%
 *                   is a leaderboard nobody believes. Sharps live in the tens
 *                   of percent, risk is an integer 1–10, AUM is money.
 *   COHERENT        every reading traces back to a field the persona already
 *                   had. The copier delta is the trend line's own front/back
 *                   read; GAIN's edge factor is `earnings`'s edge factor; risk
 *                   is the mode and sector splits the drawer draws as bars.
 *
 * The last block is the one currency assertion the whole change turns on: the
 * ladder renders dollars, and the string `PTS` does not appear on it. The desk
 * and the ledger are two quantities, never two denominations of one.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  LEADERBOARD,
  PERSONAS,
  aumFor,
  build,
  buildYou,
  copierDelta30d,
  copyEconomicsFor,
  copyProfileFor,
  gain12mFor,
  minCopyFor,
  profitableMonthsFor,
  riskScoreFor,
  usd,
  usdCompact,
  usdGain,
  usdSigned,
  rankedBy,
  type LeaderPlayer,
} from "../src/data/leaderboard.ts";
import { MODE_ORDER } from "../src/data/modes.ts";
import { SECTOR_ORDER } from "../src/data/sectors.ts";
import { Ranking } from "../src/views/Ranking.tsx";

/** The whole board the page renders: the personas plus a YOU row. */
const YOU = buildYou({ xp: 2340, battles: 31, wins: 18 });

describe("the pins survive — the profile is additive, and provably so", () => {
  test("every seeded economic value is exactly what it was", () => {
    // Character-for-character. If a draw had moved — a new `r()` slipped into
    // `build`, a reordered stream — these are the first numbers to change, and
    // they are the numbers `test/rank.test.ts` and the Result panel share.
    for (const p of LEADERBOARD) {
      expect(copyEconomicsFor(p.id, p.xp)).toEqual(p.econ);
      expect(p.econ.daily).toBe(p.econ.copiers * p.econ.txPerCopierPerDay * p.econ.avgTicket * 0.035);
      expect(p.earnings).toBe(Math.round(p.battles * p.econ.avgTicket * (p.winRate - 0.42) * 3.6));
    }
    // The two pinned hero-mock numbers, restated here so a failure in this file
    // says "the generator moved" rather than "a formatter changed".
    expect(LEADERBOARD.length).toBe(13);
    const zeph = LEADERBOARD.find((p) => p.id === "zeph")!;
    expect(zeph.econ.avgTicket).toBe(2206);
    expect(Math.round(zeph.econ.daily)).toBe(63698);
  });

  test("rebuilding the roster reproduces the profiles too", () => {
    expect(PERSONAS.map(build)).toEqual([...LEADERBOARD]);
    for (const p of LEADERBOARD) {
      expect(build(p).profile).toEqual(p.profile);
      // A profile is a function of the row — hand it back its own row and it
      // must produce itself, which is what makes it safe to cache on the row.
      const { profile: _drop, ...row } = p;
      expect(copyProfileFor(row)).toEqual(p.profile);
    }
  });
});

describe("GAIN % — a return, and a believable one", () => {
  test("the whole roster lands in the tens of percent, nobody in the thousands", () => {
    for (const p of LEADERBOARD) {
      const g = p.profile.gain12m;
      expect(Number.isFinite(g)).toBe(true);
      // Above break-even, below a figure that would read as a scam.
      expect(g).toBeGreaterThan(0);
      expect(g).toBeLessThan(1);
    }
    // …and the spread is a real spread, not thirteen traders on one number.
    const gains = LEADERBOARD.map((p) => p.profile.gain12m);
    expect(Math.max(...gains) - Math.min(...gains)).toBeGreaterThan(0.3);
  });

  test("a losing record is a negative year, and it cannot exceed the book", () => {
    // 6 wins in 40 is a 15% hit rate — deep under the 42% break-even.
    expect(buildYou({ xp: 900, battles: 40, wins: 6 }).profile.gain12m).toBeLessThan(-0.2);
    // An unplayed ledger has no year to report, and says 0 rather than a guess.
    expect(buildYou({ xp: 0, battles: 0, wins: 0 }).profile.gain12m).toBe(0);
    // You can lose the book. You cannot lose more than the book.
    expect(gain12mFor(10_000, 0)).toBe(-0.95);
    expect(gain12mFor(10_000, 1)).toBeLessThanOrEqual(2.5);
  });

  test("it is a RATE: monotone in win rate, capped in career length, blind to ticket size", () => {
    // Better hit rate is always a better year, at equal activity.
    let prev = Number.NEGATIVE_INFINITY;
    for (let wr = 0.3; wr <= 0.7; wr += 0.01) {
      const g = gain12mFor(120, wr);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
    // Break-even is exactly zero — the same 0.42 `earnings` prices.
    expect(gain12mFor(200, 0.42)).toBe(0);
    // A year holds 96 tickets however long the career is, so a 298-battle
    // grinder does not report three careers' worth of return as one year's.
    expect(gain12mFor(96, 0.6)).toBe(gain12mFor(298, 0.6));
    expect(gain12mFor(50, 0.6)).toBeLessThan(gain12mFor(96, 0.6));
  });

  test("it agrees with the career line on sign — no +70% year on a losing desk", () => {
    for (const p of [...LEADERBOARD, YOU, buildYou({ xp: 900, battles: 40, wins: 6 })]) {
      expect(p.profile.gain12m > 0).toBe(p.earnings > 0);
      expect(p.profile.career).toBe(p.earnings);
    }
  });
});

describe("RISK 1–10 — the chip", () => {
  test("every persona scores an integer inside the band, and the band is used", () => {
    const scores = new Set<number>();
    for (const p of [...LEADERBOARD, YOU]) {
      const r = p.profile.risk;
      expect(Number.isInteger(r)).toBe(true);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(10);
      scores.add(r);
    }
    // A chip that reads the same on every row is not a reading.
    expect(scores.size).toBeGreaterThanOrEqual(4);
  });

  test("the extremes pin the ends: an all-BLITZ one-sector book is hot, an all-NORMAL spread book is calm", () => {
    const flatSectors = Object.fromEntries(SECTOR_ORDER.map((k) => [k, 1 / SECTOR_ORDER.length]));
    const oneSector = Object.fromEntries(
      SECTOR_ORDER.map((k, i) => [k, i === 0 ? 1 : 0]),
    ) as Record<(typeof SECTOR_ORDER)[number], number>;
    const allBlitz = Object.fromEntries(
      MODE_ORDER.map((k) => [k, k === "BLITZ" ? 1 : 0]),
    ) as Record<(typeof MODE_ORDER)[number], number>;
    const allNormal = Object.fromEntries(
      MODE_ORDER.map((k) => [k, k === "NORMAL" ? 1 : 0]),
    ) as Record<(typeof MODE_ORDER)[number], number>;

    expect(riskScoreFor(allBlitz, oneSector)).toBe(10);
    expect(riskScoreFor(allNormal, flatSectors as typeof oneSector)).toBe(1);
    // Each half moves it on its own, in the right direction.
    expect(riskScoreFor(allBlitz, flatSectors as typeof oneSector)).toBeGreaterThan(
      riskScoreFor(allNormal, flatSectors as typeof oneSector),
    );
    expect(riskScoreFor(allNormal, oneSector)).toBeGreaterThan(
      riskScoreFor(allNormal, flatSectors as typeof oneSector),
    );
  });

  test("it is stable per persona — the same book scores the same twice", () => {
    for (const p of LEADERBOARD) {
      expect(riskScoreFor(p.modeShare, p.sectorShare)).toBe(p.profile.risk);
      expect(build(p).profile.risk).toBe(p.profile.risk);
    }
  });
});

describe("AUM, the minimum sleeve, and the copier delta", () => {
  test("AUM is the copiers' sleeves, and a locked trader has none", () => {
    for (const p of LEADERBOARD) {
      expect(p.profile.aum).toBe(
        p.econ.copiers * p.econ.txPerCopierPerDay * p.econ.avgTicket * 14,
      );
      expect(aumFor(p.econ)).toBe(p.profile.aum);
      // Zero by arithmetic, not by a branch — the same shape `daily` has.
      expect(p.profile.aum > 0).toBe(p.econ.unlocked);
    }
  });

  test("the minimum sleeve clears one ticket, rounded to a hundred, floored at $200", () => {
    for (const p of LEADERBOARD) {
      const m = p.profile.minCopy;
      expect(m % 100).toBe(0);
      expect(m).toBeGreaterThanOrEqual(p.econ.avgTicket);
      expect(m - p.econ.avgTicket).toBeLessThan(100);
    }
    expect(minCopyFor(0)).toBe(200);
    expect(minCopyFor(2206)).toBe(2300);
    expect(minCopyFor(2600)).toBe(2600);
  });

  test("the copier delta is the trend line's own front/back read — no second stream", () => {
    for (const p of LEADERBOARD) {
      // Recomputed here from the raw trend, independently of the source.
      const t = p.trend;
      const half = Math.floor(t.length / 2);
      const front = t.slice(0, half).reduce((a, b) => a + b, 0) / half;
      const back = t.slice(half).reduce((a, b) => a + b, 0) / (t.length - half);
      const want = Math.max(-0.6, Math.min(0.6, ((back - front) / front) * 0.55));

      expect(copierDelta30d(t)).toBeCloseTo(want, 12);
      // The row's sparkline draws bright when `back >= front`. The arrow beside
      // it must therefore point up on exactly those rows, and never disagree.
      if (p.econ.unlocked) {
        expect(p.profile.copierDelta).toBeCloseTo(want, 12);
        expect(p.profile.copierDelta > 0).toBe(back > front);
      } else {
        // Nobody is copying, so there is no book to have moved.
        expect(p.profile.copierDelta).toBe(0);
      }
    }
  });

  test("the delta is bounded and defined on degenerate lines", () => {
    expect(copierDelta30d([])).toBe(0);
    expect(copierDelta30d([0.4])).toBe(0);
    expect(copierDelta30d([0, 0, 1, 1])).toBe(0); // a zero front half cannot divide
    expect(copierDelta30d([0.01, 0.01, 0.98, 0.98])).toBe(0.6); // clamped
    // The floor is a guard, not a reachable state: a form line cannot fall by
    // more than 100% of itself, so the worst collapse is −55% and the −60%
    // clamp only exists so nobody has to prove that again later.
    expect(copierDelta30d([0.98, 0.98, 0.01, 0.01])).toBeCloseTo(-0.5444, 3);
    expect(copierDelta30d([0.98, 0.98, 0.01, 0.01])).toBeGreaterThanOrEqual(-0.6);
    expect(copierDelta30d([0.5, 0.5, 0.5, 0.5])).toBe(0);
  });

  test("profitable months are 0…12 and lean the way skill leans", () => {
    for (const p of [...LEADERBOARD, YOU]) {
      const m = p.profile.profitableMonths;
      expect(Number.isInteger(m)).toBe(true);
      expect(m).toBeGreaterThanOrEqual(0);
      expect(m).toBeLessThanOrEqual(12);
      expect(p.profile.profitableMonthsPct).toBeCloseTo(m / 12, 12);
      expect(profitableMonthsFor(p.winRate, p.trend)).toBe(m);
    }
    // Same form line, better hit rate → never fewer green months.
    const flat = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
    expect(profitableMonthsFor(0.66, flat)).toBeGreaterThan(profitableMonthsFor(0.34, flat));
  });
});

describe("the money vocabulary", () => {
  test("`usd` groups, signs with a real minus, and rounds", () => {
    expect(usd(2206)).toBe("$2,206");
    expect(usd(63_698)).toBe("$63,698");
    expect(usd(0)).toBe("$0");
    expect(usd(1204.4)).toBe("$1,204");
    // U+2212, not a hyphen — it has to line up under a plus in a column.
    expect(usd(-1204)).toBe("−$1,204");
  });

  test("`usdSigned` always carries a sign; `usdGain` is the percentage form", () => {
    expect(usdSigned(28_541)).toBe("+$28,541");
    expect(usdSigned(-61_897)).toBe("−$61,897");
    expect(usdSigned(0)).toBe("+$0");
    expect(usdGain(0.538)).toBe("+53.8%");
    expect(usdGain(-0.35)).toBe("−35.0%");
    expect(usdGain(0)).toBe("+0.0%");
  });

  test("`usdCompact` only compacts where the exact figure has stopped being readable", () => {
    // Under six digits it defers to `usd` — $63,698 is a number people read.
    expect(usdCompact(63_698)).toBe("$63,698");
    expect(usdCompact(99_999)).toBe("$99,999");
    expect(usdCompact(452_065)).toBe("$452.1K");
    expect(usdCompact(1_910_940)).toBe("$1.9M");
    expect(usdCompact(52_400_000)).toBe("$52.4M");
    expect(usdCompact(-1_910_940)).toBe("−$1.9M");
    expect(usdCompact(0)).toBe("$0");
  });

  test("every board figure formats to something with a dollar sign in it", () => {
    for (const p of LEADERBOARD) {
      for (const s of [
        usd(p.econ.avgTicket),
        usd(p.econ.daily),
        usdCompact(p.econ.monthly),
        usdCompact(p.profile.aum),
        usdSigned(p.earnings),
      ]) {
        expect(s).toContain("$");
        expect(s).not.toContain("PTS");
      }
    }
  });
});

describe("GAIN as a fifth RANK BY filter", () => {
  test("it ranks the same objects, descending, with the profile's own number", () => {
    const rows = rankedBy(LEADERBOARD, "GAIN");
    expect(rows.length).toBe(LEADERBOARD.length);
    expect(rows.map((r) => r.pos)).toEqual(LEADERBOARD.map((_, i) => i + 1));
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.metric).toBeGreaterThanOrEqual(rows[i]!.metric);
    }
    for (const r of rows) {
      expect(r.metric).toBe(r.player.profile.gain12m);
      expect(r.label).toBe(usdGain(r.player.profile.gain12m));
      expect(r.label).toMatch(/^[+−]\d+\.\d%$/);
      expect(r.sub).toContain("RISK");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The rendered page. The derivations above are the contract; this is the one
// thing the contract cannot state — that the view actually SPENDS them, and
// that the old unit is gone from the surfaces that used to print it.
// ───────────────────────────────────────────────────────────────────────────

/** Render the ladder alone, off a fixed YOU row, and hand back its text. */
function renderLadder(you: LeaderPlayer = YOU): { host: HTMLDivElement; root: Root } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Ranking, { you, streak: 0 }));
  });
  return { host, root };
}

function teardown(host: HTMLDivElement, root: Root): void {
  act(() => root.unmount());
  host.remove();
}

describe("the ladder renders dollars, and only dollars", () => {
  test("the page is denominated in $ and the string PTS is nowhere on it", () => {
    const { host, root } = renderLadder();
    try {
      const text = host.textContent ?? "";
      // The copy desk's money, on the strip and on the rows.
      expect(text).toContain("FEES / 24H");
      expect(text).toContain("COPY CAPITAL");
      expect(text).toMatch(/\$[\d,]+ \/ DAY/);
      // The unit that used to be here is gone — no "PTS / DAY", no "PTS" at
      // all. XP survives, because rank is measured in XP and always was.
      expect(text).not.toContain("PTS");
      expect(text).toContain("XP");
    } finally {
      teardown(host, root);
    }
  });

  test("every row wears the eToro surface: a gain, a risk chip, a copy button", () => {
    const { host, root } = renderLadder();
    try {
      const rows = host.querySelectorAll("[data-rank-row]");
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.textContent ?? "").toMatch(/[+−]\d+\.\d%/);
        expect(row.textContent ?? "").toContain("RISK ");
      }
      // The plinths are copy-trader cards, so each carries a COPY control —
      // fiction, and labelled with the minimum sleeve it would want.
      const plinths = Array.from(host.querySelectorAll<HTMLElement>("[data-podium]"));
      expect(plinths).toHaveLength(3);
      for (const p of plinths) {
        const t = p.textContent ?? "";
        expect(t).toContain("RISK ");
        expect(t).toContain("12M");
        expect(t).toMatch(/COPY|LOCKED/);
      }
      expect(host.querySelectorAll("[data-copy-trader]").length).toBeGreaterThan(0);
    } finally {
      teardown(host, root);
    }
  });

  test("the COPY button is a fiction and says so — nothing is wired to money", () => {
    const { host, root } = renderLadder();
    try {
      const btn = host.querySelector<HTMLButtonElement>("[data-copy-trader]")!;
      expect(btn.textContent).toContain("COPY");
      expect(btn.textContent).toMatch(/MIN \$[\d,]+/);
      expect(btn.getAttribute("aria-pressed")).toBe("false");

      act(() => btn.click());
      const after = host.querySelector<HTMLButtonElement>("[data-copy-trader]")!;
      expect(after.getAttribute("aria-pressed")).toBe("true");
      expect(after.textContent).toContain("COPYING");
      // The claim the fiction is obliged to make out loud.
      expect(host.textContent).toContain("DEMO ONLY · NO FUNDS MOVED");
    } finally {
      teardown(host, root);
    }
  });

  test("the drawer's copy panel is money end to end, and the unlock line is still XP", () => {
    const { host, root } = renderLadder();
    try {
      const row = host.querySelector<HTMLElement>("[data-rank-row]")!;
      act(() => row.click());
      const drawer = host.querySelector<HTMLElement>("[data-ladder-drawer]")!;
      const t = drawer.textContent ?? "";

      expect(t).toContain("COPY-TRADER PROFILE");
      expect(t).toContain("COPY ECONOMICS");
      expect(t).toContain("GAIN 12M");
      expect(t).toContain("PROFITABLE MONTHS");
      expect(t).toContain("$ / DAY");
      expect(t).toContain("$ / MONTH");
      expect(t).toContain("AVG TRADE");
      expect(t).toContain("CAREER P/L");
      // The fee the page is about, still priced per transaction.
      expect(t).toContain("3.5%");
      // And not one point anywhere in the panel.
      expect(t).not.toContain("PTS");
    } finally {
      teardown(host, root);
    }
  });

  test("a locked trader's panel quotes the unlock in XP, never in dollars", () => {
    // An empty ledger is a MINNOW: copy-trade locked, and the distance to it is
    // a RANK distance. This is the one place the ladder must NOT say $.
    const { host, root } = renderLadder(buildYou({ xp: 0, battles: 0, wins: 0 }));
    try {
      // The podium is the three hottest desks, so a locked trader is never on
      // it under COPY HEAT — the locked control lives at the foot of the table.
      const rows = Array.from(host.querySelectorAll<HTMLElement>("[data-rank-row]"));
      act(() => rows[rows.length - 1]!.click());

      const locked = host.querySelector<HTMLElement>("[data-copy-locked]");
      expect(locked).not.toBeNull();
      expect(locked?.textContent).toContain("XP TO");
      expect(locked?.textContent).not.toContain("$");
      // …and the panel around it still refuses to price the unlock in money.
      const drawer = host.querySelector<HTMLElement>("[data-ladder-drawer]")!;
      expect(drawer.textContent).toContain("LOCKED");
      expect(drawer.textContent).toContain("XP");
      expect(drawer.textContent).not.toContain("PTS");
    } finally {
      teardown(host, root);
    }
  });
});
