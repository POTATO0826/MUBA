import { describe, expect, test } from "bun:test";
import { UNIVERSE, meta } from "../src/data/universe.ts";
import { buildPayoffChart, ETH_VOL_BOX, payoff } from "../src/engine/payoff.ts";
import { edgeOf, legState, scoreOf, settle } from "../src/engine/match.ts";
import { TAPE_LEN, fmtPx, geom, pctAt, series } from "../src/engine/tape.ts";
import type { Leg } from "../src/types.ts";

describe("tape", () => {
  test("a series is deterministic for a given symbol and salt", () => {
    expect(series("NVDA", 1)).toEqual(series("NVDA", 1));
  });

  test("different salts draw different windows on the same ticker", () => {
    expect(series("NVDA", 1)).not.toEqual(series("NVDA", 2));
  });

  test("a series opens at the asset's reference price and never goes non-positive", () => {
    const s = series("ETH", 5);
    expect(s).toHaveLength(TAPE_LEN);
    expect(s[0]).toBe(meta("ETH").px);
    expect(Math.min(...s)).toBeGreaterThan(0);
  });

  test("pctAt is zero at the open and matches the close at the end", () => {
    expect(pctAt("AAPL", 3, 1)).toBe(0);
    const s = series("AAPL", 3);
    const expected = ((s[TAPE_LEN - 1]! - s[0]!) / s[0]!) * 100;
    expect(pctAt("AAPL", 3, TAPE_LEN)).toBeCloseTo(expected, 10);
  });

  test("fmtPx keeps sub-cent assets readable", () => {
    expect(fmtPx(0.0000112)).toBe("1.12e-5");
    expect(fmtPx(0.842)).toBe("0.8420");
    expect(fmtPx(118.4)).toBe("118.40");
    expect(fmtPx(96410)).toBe("96,410");
  });

  test("geom spans the full width at any count, so the live chart fills its card", () => {
    const data = series("BTC", 7);
    for (const count of [2, 20, 120, TAPE_LEN]) {
      const g = geom(data, count, 260, 96, 8);
      expect(Number(g.headX)).toBeCloseTo(260, 5);
      expect(g.path.startsWith("M0.0,")).toBe(true);
    }
  });

  test("geom rescales the y-axis to the plotted slice, not the whole tape", () => {
    const data = series("BTC", 7);
    const early = geom(data, 20, 260, 96, 8);
    const full = geom(data, TAPE_LEN, 260, 96, 8);
    expect(early.last).toBe(data[19]!);
    expect(full.last).toBe(data[TAPE_LEN - 1]!);
    // Same print, different y — the early window has its own extremes.
    expect(early.baseY).not.toBe(full.baseY);
  });
});

describe("payoff", () => {
  test("the box loses its debit when both spreads expire worthless", () => {
    expect(payoff(ETH_VOL_BOX, 4100)).toBeCloseTo(-ETH_VOL_BOX.debit, 10);
  });

  test("the call spread caps out above the short strike", () => {
    const capped = payoff(ETH_VOL_BOX, 4700);
    expect(payoff(ETH_VOL_BOX, 5200)).toBeCloseTo(capped, 10);
    expect(capped).toBeGreaterThan(0);
  });

  test("the put spread caps out below the short strike", () => {
    const capped = payoff(ETH_VOL_BOX, 3600);
    expect(payoff(ETH_VOL_BOX, 3200)).toBeCloseTo(capped, 10);
  });

  test("chart geometry reports a breakeven inside the sampled range", () => {
    const chart = buildPayoffChart();
    const breakeven = Number(chart.stats.find((s) => s.label === "BREAKEVEN")?.value.replace(/,/g, ""));
    expect(breakeven).toBeGreaterThan(3200);
    expect(breakeven).toBeLessThan(5200);
    expect(chart.gridX).toHaveLength(6);
    expect(chart.strikeMarks).toHaveLength(4);
  });
});

describe("match", () => {
  const salt = 11;

  test("an over leg wins exactly when the move clears its target", () => {
    const sym = "NVDA";
    const pct = pctAt(sym, salt, TAPE_LEN);
    const t = meta(sym).t;
    const leg: Leg = { sym, dir: "over", t };
    expect(legState(leg, salt, TAPE_LEN).won).toBe(pct >= t);
  });

  test("an under leg is the mirror of an over leg on the same target", () => {
    const sym = "TSLA";
    const t = meta(sym).t;
    const pct = pctAt(sym, salt, TAPE_LEN);
    expect(legState({ sym, dir: "under", t }, salt, TAPE_LEN).won).toBe(pct <= -t);
  });

  test("edge only counts legs that landed", () => {
    const legs: Leg[] = UNIVERSE.slice(0, 4).map((u) => ({ sym: u.sym, dir: "over", t: u.t }));
    const won = legs.filter((l) => legState(l, salt, TAPE_LEN).won);
    const expected = won.reduce((a, l) => a + Math.abs(legState(l, salt, TAPE_LEN).pct), 0);
    expect(edgeOf(legs, salt)).toBeCloseTo(expected, 10);
    if (won.length === 0) expect(edgeOf(legs, salt)).toBe(0);
  });

  test("a tie on legs is broken by conviction, and never left undecided", () => {
    // Same tickers both sides means identical scores — the tie-break has to fire.
    const legs: Leg[] = [
      { sym: "NVDA", dir: "over", t: 4 },
      { sym: "AAPL", dir: "under", t: 2 },
    ];
    const v = settle(legs, legs, ["NVDA", "AAPL"], salt, TAPE_LEN, "You", "kazuo.eth");
    expect(v.tied).toBe(true);
    expect(v.myScore).toBe(v.oppScore);
    expect(v.meWins).toBe(true); // equal conviction resolves to P1
    expect(v.winner).toBe("You");
    expect(v.scoreLine).toContain("broken on conviction");
  });

  test("the higher leg count wins outright and the reads name both sides", () => {
    const strong: Leg[] = [{ sym: "PEPE", dir: "over", t: 0.1 }];
    const weak: Leg[] = [{ sym: "GLD", dir: "over", t: 99 }];
    const v = settle(strong, weak, ["PEPE", "GLD"], salt, TAPE_LEN, "You", "kazuo.eth");
    expect(scoreOf(weak, salt, TAPE_LEN)).toBe(0);
    expect(v.meWins).toBe(true);
    expect(v.myRead.won).toBe(true);
    expect(v.oppRead.won).toBe(false);
    expect(v.oppRead.read).toContain("kazuo.eth");
    expect(v.decider.length).toBeGreaterThan(0);
    expect(v.lesson.length).toBeGreaterThan(0);
  });

  test("an all-one-direction loss draws the diversification lesson", () => {
    const weak: Leg[] = [
      { sym: "GLD", dir: "over", t: 99 },
      { sym: "XOM", dir: "over", t: 99 },
    ];
    const strong: Leg[] = [
      { sym: "PEPE", dir: "over", t: 0.1 },
      { sym: "DOGE", dir: "over", t: 0.1 },
    ];
    const v = settle(strong, weak, ["PEPE", "DOGE"], salt, TAPE_LEN, "You", "kazuo.eth");
    expect(v.oppRead.style).toContain("All-in bull");
    expect(v.lesson).toContain("three coats");
  });
});
