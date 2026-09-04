import { describe, expect, test } from "bun:test";
import { UNIVERSE, meta } from "../src/data/universe.ts";
import { buildPayoffChart, ETH_VOL_BOX, payoff } from "../src/desk/payoff.ts";
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

  test("chart geometry reports every breakeven inside the sampled range", () => {
    // Was `BREAKEVEN`, singular, and read the first upward crossing only. A
    // long vol box wins on a move in EITHER direction, so it has two: the put
    // spread stops covering the debit on the way down and the call spread
    // starts covering it on the way up. Printing the upper one alone says "you
    // need ETH above 4,389" about a position that is equally long the downside
    // — and is in profit at the live 2,453 print. The label is plural because
    // the arithmetic is.
    const chart = buildPayoffChart();
    const stat = chart.stats.find((s) => s.label === "BREAKEVENS");
    expect(stat).toBeDefined();
    const bes = stat!.value.split(" / ").map((v) => Number(v.replace(/,/g, "")));
    expect(bes).toHaveLength(2);
    // Ascending, both inside the window, and each one a genuine sign change of
    // the payoff itself rather than a number this test copied out of the panel.
    expect(bes[0]).toBeLessThan(bes[1]!);
    for (const be of bes) {
      expect(be).toBeGreaterThan(3200);
      expect(be).toBeLessThan(5200);
      expect(payoff(ETH_VOL_BOX, be - 1) < 0).not.toBe(payoff(ETH_VOL_BOX, be + 1) < 0);
    }
    // The two crossings the fixture has always had, to the dollar the panel
    // rounds them to: `m·(3900 − s) = debit` and `2m·(s − 4300) = debit`.
    expect(bes[0]).toBe(3723);
    expect(bes[1]).toBe(4389);
    expect(chart.gridX).toHaveLength(6);
    expect(chart.strikeMarks).toHaveLength(4);
  });

  test("the profitable-window stat names its own denominator instead of posing as a probability", () => {
    // 66.7% is the share of the 81 samples across a HARDCODED 3,200–5,200 axis
    // that settle above zero. It was labelled `WIN ZONE` and sat beside
    // `IMPLIED ODDS 4.51×`, where it read as a win probability. It is not one:
    // widen the axis and the "probability" moves without a fact about the
    // position changing. The number is unchanged and the label now carries the
    // window it is a fraction of.
    const stat = buildPayoffChart().stats.find((s) => s.label.startsWith("IN PROFIT"));
    expect(stat).toBeDefined();
    expect(stat!.label).toBe("IN PROFIT · 3.2–5.2k");
    expect(stat!.value).toBe("66.7%");
    expect(buildPayoffChart().stats.some((s) => s.label === "WIN ZONE")).toBe(false);
  });

  test("a spot outside the plotted window is flagged off scale, not drawn on the axis", () => {
    // The clamp is correct and the drawing that used it was not: with live ETH
    // at 2,453 the dashed line sat exactly on the 3.2k gridline, reading as
    // "spot is 3,200" beside a label correctly saying 2,453. `spotOnScale` is
    // how the view knows `spotX` is a parking spot rather than a reading.
    expect(buildPayoffChart().spotOnScale).toBe(true); // 4,182 is inside 3.2–5.2k
    expect(buildPayoffChart(ETH_VOL_BOX, 4182).spotOnScale).toBe(true);
    for (const off of [2453.03, 3199.9, 5200.1, 9000]) {
      const chart = buildPayoffChart(ETH_VOL_BOX, off);
      expect(chart.spotOnScale).toBe(false);
      // The label never clamps — that half was always right.
      expect(chart.spotLabel).toContain(off.toLocaleString("en-US", { maximumFractionDigits: 2 }));
    }
    // The boundaries are on the scale, because they are on the axis.
    expect(buildPayoffChart(ETH_VOL_BOX, 3200).spotOnScale).toBe(true);
    expect(buildPayoffChart(ETH_VOL_BOX, 5200).spotOnScale).toBe(true);
  });

  test("with no live spot the chart is byte-identical to the one that predates live spot", () => {
    // `buildPayoffChart` gained a second parameter when /desk went live. The
    // whole defence of that change is that the no-argument call did not move:
    // the reference spot survives as an explicit FALLBACK, not as a fact, and
    // these are the exact coordinates it drew before the parameter existed.
    const chart = buildPayoffChart();
    expect(chart).toEqual(buildPayoffChart(ETH_VOL_BOX, null));
    expect(chart.spotIsLive).toBe(false);
    expect(chart.spotX).toBe("458.5"); // X(4182)
    expect(chart.spotLabelX).toBe("466.5");
    expect(chart.spotLabel).toBe("SPOT 4,182 · REFERENCE");
  });

  test("a live spot moves the line and flips the label", () => {
    // 2,375.76 is the real ETH print from the FINDINGS capture — below this
    // chart's 3,200 floor, which is the case the clamp exists for. The LINE is
    // clamped to the axis; the LABEL always prints the true number, because a
    // clamped label would be a wrong price rather than a drawing artefact.
    const live = buildPayoffChart(ETH_VOL_BOX, 2375.76);
    expect(live.spotIsLive).toBe(true);
    expect(live.spotLabel).toBe("SPOT 2,375.76 · LIVE");
    expect(live.spotX).toBe("52.0");
    // Everything that is not the spot line is the same drawing.
    expect(live.path).toBe(buildPayoffChart().path);
    expect(live.stats).toEqual(buildPayoffChart().stats);
  });

  test("a spot that is not a number is not a spot", () => {
    // `MarketSource.spot` answers `null` for every asset Thetanuts does not
    // publish — 11 of the board's 18 — so the miss path is the common one.
    for (const bad of [NaN, Infinity]) {
      expect(buildPayoffChart(ETH_VOL_BOX, bad).spotIsLive).toBe(false);
      expect(buildPayoffChart(ETH_VOL_BOX, bad).spotLabel).toContain("REFERENCE");
    }
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
