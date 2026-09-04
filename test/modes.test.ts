import { describe, expect, test } from "bun:test";
import { MODES, MODE_ORDER, MODE_SALT, MODE_WALL, modeTag } from "../src/data/modes.ts";
import { briefsFor } from "../src/data/briefs.ts";
import { meta } from "../src/data/universe.ts";
import { driftOf, edgeOf, legState, settle } from "../src/engine/match.ts";
import {
  PARLAY_CARDS,
  TIER_MOVE,
  buildLeg,
  degeneracyScore,
  legForCard,
  legsForPicks,
  summarize,
} from "../src/engine/parlay.ts";
import { TAPE_LEN, pctAt } from "../src/engine/tape.ts";
import { C, miniTag } from "../src/theme.ts";
import type { Leg, Mode } from "../src/types.ts";

describe("mode table", () => {
  test("NORMAL is the identity mode — today's demo is byte-identical", () => {
    const n = MODES.NORMAL;
    expect(n.settleAt).toBe(TAPE_LEN);
    expect(n.targetScale).toBe(1);
    expect(n.oddsBoost).toBe(1);
    expect(n.pickSeconds).toBeNull();
    expect(MODE_SALT.NORMAL).toBe(0);
  });

  test("every mode settles inside the tape it is a window on", () => {
    for (const m of MODE_ORDER) {
      expect(MODES[m].settleAt).toBeGreaterThanOrEqual(2);
      expect(MODES[m].settleAt).toBeLessThanOrEqual(TAPE_LEN);
      expect(Number.isInteger(MODES[m].settleAt)).toBe(true);
    }
  });

  test("MODE_ORDER runs fastest first, and the knobs move with the window", () => {
    const specs = MODE_ORDER.map((m) => MODES[m]);
    expect(MODE_ORDER).toEqual(["BLITZ", "QUICK", "NORMAL"]);
    for (let i = 1; i < specs.length; i++) {
      const prev = specs[i - 1]!;
      const cur = specs[i]!;
      // With the window: more simulated minutes ⇒ more tape, wider targets.
      expect(cur.minutes).toBeGreaterThan(prev.minutes);
      expect(cur.settleAt).toBeGreaterThan(prev.settleAt);
      expect(cur.targetScale).toBeGreaterThan(prev.targetScale);
      // Against it: the shorter the window, the fatter the premium.
      expect(cur.oddsBoost).toBeLessThan(prev.oddsBoost);
      // The pick clock loosens with the window; NORMAL is untimed.
      const p = (s: number | null) => s ?? Infinity;
      expect(p(cur.pickSeconds)).toBeGreaterThan(p(prev.pickSeconds));
    }
  });

  test("targets are scaled harder than a neutral √n shrink", () => {
    // σ√n would give √(56/200)=0.53 and √(110/200)=0.74. The chosen 0.62/0.82
    // sit above those — deliberately ~15% harder relative to the window.
    for (const m of ["BLITZ", "QUICK"] as const) {
      const neutral = Math.sqrt(MODES[m].settleAt / TAPE_LEN);
      expect(MODES[m].targetScale).toBeGreaterThan(neutral);
      expect(MODES[m].targetScale).toBeLessThan(1);
    }
  });

  test("compression is the simulated-vs-wall-clock ratio at TAPE_STEP=3 / 120ms", () => {
    // One print costs 120/3 = 40ms, so the window plays in settleAt*40 ms and
    // the ratio reduces to minutes * 1500 / settleAt.
    const expected: Record<Mode, string> = { BLITZ: "402", QUICK: "818", NORMAL: "10,800" };
    for (const m of MODE_ORDER) {
      const spec = MODES[m];
      const wallMs = spec.settleAt * 40;
      expect(spec.compression).toBe(
        Math.round((spec.minutes * 60_000) / wallMs).toLocaleString("en-US"),
      );
      expect(spec.compression).toBe(expected[m]);
      expect(spec.wallSeconds).toBe((wallMs / 1000).toFixed(1));
    }
    expect(MODES.BLITZ.wallSeconds).toBe("2.2");
    expect(MODES.NORMAL.wallSeconds).toBe("8.0");
  });

  test("labels and durations are the badge strings the screens print", () => {
    expect(MODES.BLITZ.label).toBe("BLITZ");
    expect(MODES.BLITZ.duration).toBe("15 MIN");
    expect(MODES.QUICK.duration).toBe("1 HOUR");
    expect(MODES.NORMAL.duration).toBe("24 HOURS");
    for (const m of MODE_ORDER) expect(MODES[m].key).toBe(m);
  });

  test("the salts are distinct, so a mode change redraws the window", () => {
    const salts = MODE_ORDER.map((m) => MODE_SALT[m]);
    expect(new Set(salts).size).toBe(salts.length);
    expect(MODE_SALT.QUICK).toBe(1_000_003);
    expect(MODE_SALT.BLITZ).toBe(2_000_029);
  });

  test("MODE_WALL is complete and shaped like MARKET_WALL", () => {
    for (const m of MODE_ORDER) {
      const [stop, tint, deg] = MODE_WALL[m];
      expect(stop).toMatch(/^#[0-9a-f]{6}$/i);
      expect(tint).toMatch(/^rgba\(/);
      expect(deg).toBeGreaterThan(0);
      expect(deg).toBeLessThan(360);
    }
  });

  test("modeTag tints from the mode colour, and only BLITZ pulses", () => {
    expect(MODES.BLITZ.color).toBe(C.red);
    expect(MODES.QUICK.color).toBe(C.amber);
    expect(MODES.NORMAL.color).toBe(C.blue);
    for (const m of MODE_ORDER) {
      expect(modeTag(m).startsWith(miniTag(MODES[m].color))).toBe(true);
    }
    expect(modeTag("BLITZ")).toContain("animation:vcPulse");
    expect(modeTag("QUICK")).not.toContain("animation");
    expect(modeTag("NORMAL")).not.toContain("animation");
  });
});

describe("targetScale through the parlay", () => {
  test("buildLeg multiplies the tier line by the mode's scale", () => {
    for (const sym of ["NVDA", "BTC", "PEPE"]) {
      for (const tier of ["SAFE", "EVEN", "SHARP", "DEGEN"] as const) {
        const base = meta(sym).t * TIER_MOVE[tier];
        for (const scale of [1, 0.82, 0.62]) {
          expect(buildLeg(sym, "over", tier, scale).t).toBe(+(base * scale).toFixed(2));
        }
      }
    }
  });

  test("the default is the untouched full-tape leg", () => {
    const a = buildLeg("NVDA", "over", "EVEN");
    expect(a).toEqual(buildLeg("NVDA", "over", "EVEN", 1));
    expect(a.t).toBe(+meta("NVDA").t.toFixed(2));
    // BLITZ NVDA EVEN reads ±2.5% where NORMAL reads ±4.0%.
    expect(buildLeg("NVDA", "over", "EVEN", MODES.BLITZ.targetScale).t).toBe(2.48);
  });

  test("the strike tracks the scaled target, not the base one", () => {
    const leg = buildLeg("BTC", "under", "SHARP", 0.62);
    expect(leg.baseT).toBe(meta("BTC").t);
    expect(leg.strike).toBeCloseTo(meta("BTC").px * (1 - leg.t / 100), 10);
    expect(leg.t).toBeLessThan(buildLeg("BTC", "under", "SHARP").t);
  });

  test("legForCard and legsForPicks pass the scale through", () => {
    const card = PARLAY_CARDS.find((c) => c.id === "sharp-bear")!;
    expect(legForCard("ETH", card, 0.62)).toEqual(buildLeg("ETH", "under", "SHARP", 0.62));
    expect(legForCard("ETH", card)).toEqual(legForCard("ETH", card, 1));

    const syms = ["NVDA", "ETH"];
    const picks = { NVDA: PARLAY_CARDS[0]!, ETH: card };
    const scaled = legsForPicks(syms, picks, 0.62);
    expect(scaled.map((l) => l.t)).toEqual(syms.map((s) => legForCard(s, picks[s as "NVDA"]!, 0.62).t));
    expect(legsForPicks(syms, picks)).toEqual(legsForPicks(syms, picks, 1));
  });
});

describe("oddsBoost through the slip", () => {
  const legs = [buildLeg("NVDA", "over", "EVEN"), buildLeg("ETH", "under", "SHARP")];

  test("the boost rides on mult, so it reaches the payout", () => {
    const base = summarize(legs, 100);
    const boosted = summarize(legs, 100, 1.35);
    expect(base.mult).toBe(degeneracyScore(legs));
    expect(boosted.mult).toBeCloseTo(degeneracyScore(legs) * 1.35, 10);
    expect(boosted.potentialPoints).toBe(Math.round(100 * boosted.mult));
    expect(boosted.potentialPoints).toBeGreaterThan(base.potentialPoints);
  });

  test("the boost never moves the implied probability", () => {
    for (const m of MODE_ORDER) {
      expect(summarize(legs, 100, MODES[m].oddsBoost).prob).toBe(summarize(legs, 100).prob);
    }
  });

  test("the default is byte-identical to the un-boosted slip", () => {
    expect(summarize(legs, 250)).toEqual(summarize(legs, 250, 1));
    expect(summarize(legs, 250, MODES.NORMAL.oddsBoost)).toEqual(summarize(legs, 250));
  });
});

describe("settling on a mode's window", () => {
  const salt = 11;
  const legs: Leg[] = [
    { sym: "NVDA", dir: "over", t: 4 },
    { sym: "BTC", dir: "under", t: 3 },
  ];

  test("edgeOf reads the window it is given, and defaults to the whole tape", () => {
    const end = MODES.BLITZ.settleAt;
    const hand = legs.reduce((a, l) => {
      const st = legState(l, salt, end);
      return a + (st.won ? Math.abs(st.pct) : 0);
    }, 0);
    expect(edgeOf(legs, salt, end)).toBeCloseTo(hand, 10);
    expect(edgeOf(legs, salt)).toBe(edgeOf(legs, salt, TAPE_LEN));

    // A shorter window is a different read on the same seed.
    const differs = [3, 5, 7, 9, 11, 13].some(
      (s) => edgeOf(legs, s, end) !== edgeOf(legs, s, TAPE_LEN),
    );
    expect(differs).toBe(true);
  });

  test("driftOf is signed travel in the leg's own direction, cleared or not", () => {
    const end = MODES.BLITZ.settleAt;
    const over: Leg[] = [{ sym: "NVDA", dir: "over", t: 99 }];
    const under: Leg[] = [{ sym: "NVDA", dir: "under", t: 99 }];
    const move = pctAt("NVDA", salt, end);
    // t: 99 is unreachable, so neither leg cleared — drift still counts it.
    expect(legState(over[0]!, salt, end).won).toBe(false);
    expect(driftOf(over, salt, end)).toBeCloseTo(move, 10);
    expect(driftOf(under, salt, end)).toBeCloseTo(-move, 10);
    expect(driftOf([...over, ...under], salt, end)).toBeCloseTo(0, 10);
    expect(driftOf(over, salt)).toBe(driftOf(over, salt, TAPE_LEN));
  });

  test("settle at NORMAL's settleAt is the old full-tape settle, exactly", () => {
    const opp: Leg[] = [{ sym: "AAPL", dir: "over", t: 2 }];
    const arena = ["NVDA", "BTC", "AAPL"];
    expect(settle(legs, opp, arena, salt, MODES.NORMAL.settleAt, "You", "kazuo.eth")).toEqual(
      settle(legs, opp, arena, salt, TAPE_LEN, "You", "kazuo.eth"),
    );
  });

  test("the same slips settle differently on a Blitz window", () => {
    const opp: Leg[] = [
      { sym: "AAPL", dir: "over", t: 2 },
      { sym: "ETH", dir: "over", t: 5 },
    ];
    const arena = ["NVDA", "BTC", "AAPL", "ETH"];
    const flipped: number[] = [];
    for (let s = 1; s < 80; s++) {
      const blitz = settle(legs, opp, arena, s, MODES.BLITZ.settleAt, "You", "kazuo.eth");
      const normal = settle(legs, opp, arena, s, MODES.NORMAL.settleAt, "You", "kazuo.eth");
      if (blitz.meWins !== normal.meWins) flipped.push(s);
      if (blitz.scoreLine !== normal.scoreLine) expect(blitz.decider).not.toBe(normal.decider);
    }
    expect(flipped.length).toBeGreaterThan(0);
  });

  test("briefsFor reads the mode's window", () => {
    const syms = ["NVDA", "BTC", "AAPL"];
    expect(briefsFor(syms, salt)).toEqual(briefsFor(syms, salt, TAPE_LEN));
    const differs = [1, 2, 3, 5, 8, 13].some(
      (s) =>
        JSON.stringify(briefsFor(syms, s, MODES.BLITZ.settleAt)) !==
        JSON.stringify(briefsFor(syms, s)),
    );
    expect(differs).toBe(true);
  });
});

describe("the 0–0 tie-break", () => {
  // Unreachable targets on different symbols: nobody cashes, both edges are 0,
  // so only drift can separate them. This is the common Blitz endgame.
  const mine: Leg[] = [{ sym: "NVDA", dir: "over", t: 99 }];
  const theirs: Leg[] = [{ sym: "GLD", dir: "under", t: 99 }];
  const arena = ["NVDA", "GLD"];
  const end = MODES.BLITZ.settleAt;

  test("a scoreless duel is decided by drift, not by seat order", () => {
    let p1 = 0;
    let p2 = 0;
    for (let s = 1; s <= 80; s++) {
      const v = settle(mine, theirs, arena, s, end, "You", "kazuo.eth");
      expect(v.myScore).toBe(0);
      expect(v.oppScore).toBe(0);
      expect(v.tied).toBe(true);
      expect(v.myEdge).toBe(0);
      expect(v.oppEdge).toBe(0);
      const dMine = driftOf(mine, s, end);
      const dTheirs = driftOf(theirs, s, end);
      expect(v.myDrift).toBe(dMine);
      expect(v.oppDrift).toBe(dTheirs);
      expect(v.meWins).toBe(dMine >= dTheirs);
      expect(v.winner).toBe(dMine >= dTheirs ? "You" : "kazuo.eth");
      if (v.meWins) p1++;
      else p2++;
    }
    // The old `myEdge >= oppEdge` rule handed all 80 of these to P1.
    expect(p1).toBeGreaterThan(0);
    expect(p2).toBeGreaterThan(0);
    expect(p1 + p2).toBe(80);
  });

  test("every tie still says it was broken on conviction", () => {
    for (const s of [1, 4, 9, 16, 25]) {
      const v = settle(mine, theirs, arena, s, end, "You", "kazuo.eth");
      expect(v.scoreLine).toContain("broken on conviction");
      expect(v.decider).toContain("conviction");
    }
    // …including the equal-conviction case the engine test pins.
    const same: Leg[] = [
      { sym: "NVDA", dir: "over", t: 4 },
      { sym: "AAPL", dir: "under", t: 2 },
    ];
    const v = settle(same, same, ["NVDA", "AAPL"], 11, TAPE_LEN, "You", "kazuo.eth");
    expect(v.myDrift).toBe(v.oppDrift);
    expect(v.meWins).toBe(true);
    expect(v.scoreLine).toContain("broken on conviction");
  });

  test("conviction still outranks drift when someone actually cashed", () => {
    // One leg each, both land; the bigger absolute move takes it regardless of
    // which way the drift totals point.
    const strong: Leg[] = [{ sym: "PEPE", dir: "over", t: 0.1 }];
    const weak: Leg[] = [{ sym: "DOGE", dir: "over", t: 0.1 }];
    for (let s = 1; s <= 40; s++) {
      const v = settle(strong, weak, ["PEPE", "DOGE"], s, TAPE_LEN, "You", "kazuo.eth");
      if (!v.tied || v.myEdge === v.oppEdge) continue;
      expect(v.meWins).toBe(v.myEdge > v.oppEdge);
    }
  });
});
