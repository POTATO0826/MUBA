import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { STRIP_LEN, TILE_PITCH, TILE_W } from "../src/engine/spin.ts";
import {
  HOVER_MAX_PER_WINDOW,
  HOVER_MIN_GAP_MS,
  HOVER_RESET_MS,
  HOVER_SUPPRESS_MS,
  MAX_PER_NAME,
  MAX_VOICES,
  TICK_MIN_GAP_BLITZ_MS,
  TICK_MIN_GAP_MS,
  TIER_MAX_MS,
  clampDuration,
  clampGain,
  comboPitch,
  createBudget,
  diffWon,
  tickParams,
} from "../src/lib/sound/budget.ts";
import type { Budget, PlayDecision, Tier } from "../src/lib/sound/budget.ts";
import {
  DEFAULT_VOLUME,
  __reloadPrefs,
  getPalette,
  installUnlock,
  isSoundOn,
  parsePrefs,
  prefersReducedMotion,
  setPalette,
  setSoundOn,
  startAmbience,
  startRiser,
  stopAmbience,
  stopRiser,
  subscribeSound,
} from "../src/lib/sound/engine.ts";
import { PALETTE_DECAY, PALETTE_DETUNE, SFX_MAP, recipeOf } from "../src/lib/sound/map.ts";
import type { SfxName, SfxOpts } from "../src/lib/sound/map.ts";
import { __setTestSink, audioAvailable, sfx } from "../src/lib/sound/index.ts";
import { useSoundHover } from "../src/lib/sound/react.ts";

/**
 * The sound system, tested without a sound.
 *
 * happy-dom has no `AudioContext`, so `audioAvailable` is false and the engine
 * is inert — which is exactly the property the other 84 tests depend on. What
 * is left to test is everything that decides whether a sound *may* be heard:
 * the budget's arithmetic (driven by a hand-cranked clock, never a real
 * timer), the preference store, the completeness of the event table, and the
 * pure helpers views call at the site.
 */

const KEY = "td.sound.v1";
const TIERS: readonly Tier[] = ["ambient", "ui", "action", "event", "moment"];

/** A hand-cranked millisecond clock — no real timers anywhere in this file. */
let now = 0;
function budgetAt(t = 0): Budget {
  now = t;
  return createBudget(() => now);
}

/** Ask the budget for a voice exactly the way `engine.run` does, from the map. */
function ask(b: Budget, name: SfxName): PlayDecision {
  const r = recipeOf(name);
  if (!r) throw new Error(`no recipe registered for "${name}"`);
  return b.request({
    name,
    tier: r.tier,
    cooldownMs: r.cooldownMs,
    durationMs: r.durationMs,
    bus: r.bus ?? (r.tier === "ambient" ? "ambience" : "sfx"),
  });
}

afterEach(() => {
  __setTestSink(null);
  setPalette("NORMAL");
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage is advisory; the engine survives without it and so does the test.
  }
  __reloadPrefs();
  now = 0;
});

// ── 1. Engine safety ──────────────────────────────────────────────────────

describe("engine — inert without an AudioContext", () => {
  test("sfx never plays and never throws", () => {
    expect(audioAvailable).toBe(false);
    for (const name of Object.keys(SFX_MAP) as SfxName[]) {
      expect(() => sfx(name)).not.toThrow();
      expect(sfx(name)).toBe(false);
    }
    expect(sfx("ui.hover", { pitch: 1.2, gain: 9, pan: -4, delayMs: 90, leg: 2 })).toBe(false);
  });

  test("ambience, riser and palette are inert", () => {
    expect(() => {
      startAmbience("study");
      startAmbience("study"); // R9 — a second start is a no-op
      startAmbience("duel");
      startRiser(1600);
      startRiser(1600);
      stopRiser(true);
      stopAmbience("study");
      stopAmbience("duel");
      stopRiser(); // already stopped
      stopAmbience("study"); // already stopped
    }).not.toThrow();

    // None of that left a voice behind, and sfx is still silent.
    expect(sfx("duel.riser")).toBe(false);
    expect(sfx("study.enter")).toBe(false);

    setPalette("BLITZ");
    expect(getPalette()).toBe("BLITZ");
    setPalette("NORMAL");
    expect(getPalette()).toBe("NORMAL");
  });

  test("installUnlock registers zero listeners when audio is unavailable", () => {
    const winAdd = window.addEventListener;
    const docAdd = document.addEventListener;
    let calls = 0;
    const spy = (): void => {
      calls++;
    };
    window.addEventListener = spy as unknown as typeof winAdd;
    document.addEventListener = spy as unknown as typeof docAdd;
    let teardown: (() => void) | null = null;
    try {
      teardown = installUnlock();
    } finally {
      window.addEventListener = winAdd;
      document.addEventListener = docAdd;
    }
    expect(calls).toBe(0);
    expect(typeof teardown).toBe("function");
    expect(() => teardown?.()).not.toThrow();
  });
});

// ── 2. Budget ─────────────────────────────────────────────────────────────

describe("budget — R1 per-event cooldown", () => {
  test("a repeat inside the cooldown is refused, one past it plays", () => {
    // The hover class carries the 70ms cooldown the rule is written around.
    for (const n of ["ui.hover", "card.hover", "parlay.card.hover", "ladder.rowHover"]) {
      expect(recipeOf(n)?.cooldownMs).toBe(70);
    }

    const b = budgetAt(0);
    const one = () => b.request({ name: "ui.hoverish", tier: "ui", cooldownMs: 70, durationMs: 60 });
    expect(one().verdict).toBe("play");
    now = 30;
    expect(one().verdict).toBe("cooldown");
    now = 80;
    // The refusal at 30ms did not restart the clock: 80ms since the last
    // ACCEPTED play is past the 70ms window.
    expect(one().verdict).toBe("play");
  });

  test("the cooldown is per event name, taken from the map", () => {
    const b = budgetAt(0);
    expect(ask(b, "ui.click").verdict).toBe("play");
    now = 30;
    expect(ask(b, "ui.click").verdict).toBe("cooldown");
    // A different event is untouched by that cooldown.
    expect(ask(b, "ui.click.primary").verdict).toBe("play");
    now = 80;
    expect(ask(b, "ui.click").verdict).toBe("play");
  });
});

describe("budget — R2 hover sweep", () => {
  test("a swept row thins to the 90ms floor", () => {
    expect(HOVER_MIN_GAP_MS).toBe(90);
    const b = budgetAt(0);
    const verdicts: string[] = [];
    for (let i = 0; i < 8; i++) {
      now = i * 40;
      verdicts.push(ask(b, "ui.hover").verdict);
    }
    // 40ms crossings against a 90ms floor: one in three survives.
    expect(verdicts).toEqual([
      "play",
      "sweep",
      "sweep",
      "play",
      "sweep",
      "sweep",
      "play",
      "sweep",
    ]);
    expect(verdicts.filter((v) => v === "play").length).toBeLessThanOrEqual(HOVER_MAX_PER_WINDOW);
  });

  test("five hovers in a second engage the suppression, a quiet pause clears it", () => {
    const b = budgetAt(0);
    let plays = 0;
    let last = "";
    for (let i = 0; i < 16; i++) {
      now = i * 40;
      last = ask(b, "ui.hover").verdict;
      if (last === "play") plays++;
    }
    // The window fills at 0/120/240/360/480; the crossing at 600 breaches it.
    expect(plays).toBe(HOVER_MAX_PER_WINDOW);
    expect(last).toBe("sweep");

    // Suppression is blanket across the *.hover names, not just the one that
    // breached, and it outlasts the 90ms floor.
    const mutedUntil = 600 + HOVER_SUPPRESS_MS;
    now = 700;
    expect(ask(b, "card.hover").verdict).toBe("sweep");
    now = 800; // a continuing sweep: under the 350ms reset, still suppressed
    expect(ask(b, "parlay.card.hover").verdict).toBe("sweep");

    // Per BUILD-ORDER §C-2 the sweep is blanket across every hover-shaped
    // name — R2 keys on /hover$/i, so `ladder.rowHover` is swept too.
    expect(ask(b, "ladder.rowHover").verdict).toBe("sweep");

    // A pause longer than the reset means the pointer stopped sweeping — that
    // clears the window AND lifts the suppression early, before its 600ms is
    // up. Silence is the signal, not the stopwatch.
    now = 800 + HOVER_RESET_MS + 10;
    expect(now).toBeLessThan(mutedUntil);
    expect(ask(b, "card.hover").verdict).toBe("play");
  });
});

describe("budget — R3 spin-tick rate", () => {
  test("dense crossings are decimated, sparse ones all pass", () => {
    expect(TICK_MIN_GAP_MS).toBe(55);
    const run = (spacing: number, n: number, gap?: number): number => {
      const b = budgetAt(0);
      if (gap !== undefined) b.setTickMinGap(gap);
      let accepted = 0;
      for (let i = 0; i < n; i++) {
        now = i * spacing;
        if (ask(b, "spin.tick").verdict === "play") accepted++;
      }
      return accepted;
    };
    // The reel at full speed: 100 crossings 12ms apart become 20 clacks.
    expect(run(12, 100)).toBe(20);
    // A tighter floor lets more of the same flood through (BLITZ palette).
    expect(run(12, 100, TICK_MIN_GAP_BLITZ_MS)).toBe(25);
    expect(TICK_MIN_GAP_BLITZ_MS).toBe(42);
    // 20ms crossings still thin; 60ms ones are already sparse enough.
    expect(run(20, 100)).toBe(34);
    expect(run(60, 40)).toBe(40);
    expect(run(55, 40)).toBe(40);
  });

  test("the reel's own quintic crossing sequence lands in the playable band", () => {
    // Mirrors MatchSpin.tsx: 3200ms of quintic ease-out over the strip, read
    // at 60fps, with a crossing every time the tile under the needle changes.
    const SPIN_MS = 3200;
    const FRAME_MS = 1000 / 60;
    const ease = (t: number) => 1 - Math.pow(1 - t, 5);
    const target = Math.floor(STRIP_LEN * 0.78);
    const vw = 720;
    const finalOffset = target * TILE_PITCH + TILE_W / 2 - vw / 2;

    const crossings: number[] = [];
    let under = -1;
    for (let f = 0; f * FRAME_MS <= SPIN_MS; f++) {
      const ms = f * FRAME_MS;
      const offset = ease(Math.min(1, ms / SPIN_MS)) * finalOffset;
      const idx = Math.max(0, Math.min(STRIP_LEN - 1, Math.floor((offset + vw / 2) / TILE_PITCH)));
      if (idx !== under) {
        under = idx;
        crossings.push(ms);
      }
    }
    expect(crossings.length).toBeGreaterThan(40);

    const b = budgetAt(0);
    let accepted = 0;
    for (const at of crossings) {
      now = at;
      if (ask(b, "spin.tick").verdict === "play") accepted++;
    }
    // The thinning IS the CS:GO effect — dense chatter off the line, sparse
    // weighty clacks into the landing.
    expect(accepted).toBeGreaterThanOrEqual(15);
    expect(accepted).toBeLessThanOrEqual(45);
    expect(accepted).toBeLessThan(crossings.length);
  });
});

describe("budget — R4 voice accounting", () => {
  test("twelve voices in flight refuse the thirteenth; a moment evicts to fit", () => {
    const b = budgetAt(0);
    for (let i = 0; i < MAX_VOICES; i++) {
      expect(
        b.request({ name: `ui.fill${i}`, tier: "ui", cooldownMs: 0, durationMs: 200 }).verdict,
      ).toBe("play");
    }
    expect(b.active()).toBe(MAX_VOICES);

    // R4 — chatter is simply dropped once the graph is full.
    expect(
      b.request({ name: "ui.fill99", tier: "ui", cooldownMs: 0, durationMs: 200 }).verdict,
    ).toBe("voices");

    // …but a moment outranks chatter and evicts the oldest ui voice to fit.
    const moment = ask(b, "result.win");
    expect(moment.verdict).toBe("play");
    expect(moment.evict.length).toBe(1);
    expect(b.active()).toBe(MAX_VOICES);
  });

  test("no more than three voices carry the same name", () => {
    const b = budgetAt(0);
    const verdicts: string[] = [];
    for (let i = 0; i < 4; i++) {
      now = i * 50;
      verdicts.push(ask(b, "spin.reveal").verdict);
    }
    expect(verdicts).toEqual(["play", "play", "play", "voices"]);
    expect(b.activeOf("spin.reveal")).toBe(MAX_PER_NAME);

    // A released voice frees its slot again.
    b.release(1);
    expect(b.activeOf("spin.reveal")).toBe(MAX_PER_NAME - 1);
    now = 200;
    expect(ask(b, "spin.reveal").verdict).toBe("play");
  });
});

describe("budget — R5/R6 clamps", () => {
  test("durations are clamped by tier and gains to [0, 1.5]", () => {
    expect(clampDuration("moment", 9000)).toBe(2500);
    expect(clampDuration("ui", 900)).toBe(250);
    expect(clampDuration("action", 900)).toBe(400);
    expect(clampDuration("event", 9000)).toBe(900);
    expect(clampDuration("event", 120)).toBe(120);
    // A bed has no ceiling — it is a singleton, stopped by hand.
    expect(clampDuration("ambient", 60_000)).toBe(60_000);
    expect(TIER_MAX_MS.ambient).toBe(Number.POSITIVE_INFINITY);
    // An unbounded body survives where the tier ceiling is itself unbounded:
    // `study.enter` is authored at Infinity and stays Infinity — the bed runs
    // until `stopAmbience` releases it, never pruned by the budget.
    expect(clampDuration("ambient", Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    expect(clampDuration("moment", Number.POSITIVE_INFINITY)).toBe(2500);
    // Nonsense is silence, not a throw.
    expect(clampDuration("ui", -10)).toBe(0);
    expect(clampDuration("ui", Number.NaN)).toBe(0);

    expect(clampGain(undefined)).toBe(1);
    expect(clampGain(Number.NaN)).toBe(1);
    expect(clampGain(-3)).toBe(0);
    expect(clampGain(0.5)).toBe(0.5);
    expect(clampGain(9)).toBe(1.5);
    expect(clampGain(1.5)).toBe(1.5);
  });

  test("the budget hands back the clamped duration, not the requested one", () => {
    const b = budgetAt(0);
    expect(
      b.request({ name: "over.long", tier: "moment", cooldownMs: 400, durationMs: 9000 }).durationMs,
    ).toBe(2500);
    expect(
      b.request({ name: "over.short", tier: "ui", cooldownMs: 0, durationMs: 900 }).durationMs,
    ).toBe(250);
    // A refused request still reports what the voice would have been.
    now = 10;
    const refused = b.request({ name: "over.short", tier: "ui", cooldownMs: 60, durationMs: 900 });
    expect(refused.verdict).toBe("cooldown");
    expect(refused.durationMs).toBe(250);
    expect(refused.voice).toBe(-1);
  });
});

describe("budget — R10 one moment in flight", () => {
  test("a second moment is admitted and cross-fades the first out", () => {
    const b = budgetAt(0);
    const first = ask(b, "result.win");
    expect(first.verdict).toBe("play");
    expect(first.evict).toEqual([]);
    expect(b.activeOf("result.win")).toBe(1);

    now = 500; // past result.win's 400ms cooldown, inside its 2200ms body
    const second = ask(b, "result.win");
    expect(second.verdict).toBe("play");
    expect(second.evict).toEqual([first.voice]);
    // The old voice is gone: exactly one moment is in flight.
    expect(b.activeOf("result.win")).toBe(1);
    expect(b.active()).toBe(1);

    // A moment of a different name evicts the one in flight just the same.
    now = 900;
    const third = ask(b, "spin.lock");
    expect(third.verdict).toBe("play");
    expect(third.evict).toEqual([second.voice]);
    expect(b.active()).toBe(1);
  });
});

// ── 3. Preferences ────────────────────────────────────────────────────────

describe("preferences", () => {
  test("defaults to on, and to off only under reduced motion", () => {
    expect(prefersReducedMotion()).toBe(false); // happy-dom: matchMedia {matches:false}
    expect(parsePrefs(null, false)).toEqual({ on: true, volume: DEFAULT_VOLUME });
    expect(parsePrefs(null, true)).toEqual({ on: false, volume: DEFAULT_VOLUME });

    localStorage.removeItem(KEY);
    __reloadPrefs();
    expect(isSoundOn()).toBe(true);
  });

  test("prefersReducedMotion follows matchMedia and swallows a throwing one", () => {
    const real = globalThis.matchMedia;
    try {
      globalThis.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof real;
      expect(prefersReducedMotion()).toBe(true);
      globalThis.matchMedia = (() => {
        throw new Error("no media queries here");
      }) as unknown as typeof real;
      expect(prefersReducedMotion()).toBe(false);
    } finally {
      globalThis.matchMedia = real;
    }
    expect(prefersReducedMotion()).toBe(false);
  });

  test("a stored choice beats the default in both directions", () => {
    expect(parsePrefs('{"on":false,"volume":0.5}', false).on).toBe(false);
    expect(parsePrefs('{"on":true}', true).on).toBe(true);

    localStorage.setItem(KEY, '{"on":false}');
    __reloadPrefs();
    expect(isSoundOn()).toBe(false);

    localStorage.setItem(KEY, '{"on":true}');
    __reloadPrefs();
    expect(isSoundOn()).toBe(true);
  });

  test("corrupt storage falls back to the default without throwing", () => {
    for (const raw of ["", "{", "not json", "null", "[]", "undefined", '{"on":"yes"}', '{"on":1}']) {
      expect(() => parsePrefs(raw, false)).not.toThrow();
      expect(parsePrefs(raw, false)).toEqual({ on: true, volume: DEFAULT_VOLUME });
      expect(parsePrefs(raw, true).on).toBe(false);
    }
    // Volume is clamped, never trusted.
    expect(parsePrefs('{"on":true,"volume":9}', false).volume).toBe(1);
    expect(parsePrefs('{"on":true,"volume":-3}', false).volume).toBe(0);
    expect(parsePrefs('{"on":true,"volume":"loud"}', false).volume).toBe(DEFAULT_VOLUME);

    localStorage.setItem(KEY, "{{{ not json");
    __reloadPrefs();
    expect(() => isSoundOn()).not.toThrow();
    expect(isSoundOn()).toBe(true);
  });

  test("setSoundOn writes td.sound.v1 and notifies each subscriber once", () => {
    localStorage.removeItem(KEY);
    __reloadPrefs();

    let hits = 0;
    const off = subscribeSound(() => {
      hits++;
    });

    setSoundOn(false);
    expect(hits).toBe(1);
    expect(isSoundOn()).toBe(false);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
      on: false,
      volume: DEFAULT_VOLUME,
    });

    setSoundOn(true);
    expect(hits).toBe(2);
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
      on: true,
      volume: DEFAULT_VOLUME,
    });

    off();
    setSoundOn(false);
    expect(hits).toBe(2); // unsubscribed
    setSoundOn(true);
  });
});

// ── 4. The event map ──────────────────────────────────────────────────────

/**
 * The full inventory, spelled out. The cross-plan seams — `countdown.beep`
 * (plan 1's Blitz clock), `wire.tick` (plan 2's news wire), `rank.up` /
 * `rank.xpTick` / `ladder.rowHover` (plan 4's rank moment and ladder) — are
 * asserted by literal name so a rename shows up here rather than as silence
 * three waves later.
 */
const INVENTORY = [
  // global (11)
  "ui.hover", "ui.click", "ui.click.primary", "ui.toggle.on", "ui.toggle.off", "ui.back",
  "ui.step", "ui.disabled", "nav.click", "nav.transition", "wallet.connect",
  // spin (6)
  "spin.tick", "spin.land", "spin.reveal", "spin.lock", "spin.skip", "spin.open",
  // room (7)
  "card.hover", "card.accept", "card.start", "room.ready.me", "room.ready.opp",
  "room.bothready", "lobby.publish",
  // study (4)
  "study.enter", "wire.tick", "wire.select", "wire.alert",
  // parlay (4)
  "parlay.card.hover", "parlay.card.pick", "parlay.slip.change", "parlay.lock",
  // duel (7)
  "duel.start", "duel.tape.tick", "duel.leg.hit", "duel.leg.hit.opp", "duel.leg.miss",
  "duel.riser", "duel.settle.ready",
  // result (4)
  "result.win", "result.loss", "result.count", "result.count.done",
  // countdown (3)
  "countdown.beep", "countdown.final", "countdown.expire",
  // rank (10)
  "rank.enter", "rank.reveal", "rank.xpTick", "rank.divisionUp", "rank.up", "rank.ladder",
  "rank.copyUnlock", "rank.copyPanel", "rank.done", "rank.skip",
  // ladder (5)
  "ladder.filter", "ladder.chip", "ladder.chipClear", "ladder.rowHover", "ladder.rowOpen",
] as const;

describe("the event map", () => {
  test("every registered event has a valid tier, a finite cooldown and a render", () => {
    const names = Object.keys(SFX_MAP);
    expect(names.length).toBe(61);
    for (const name of names) {
      const r = recipeOf(name);
      expect(r).toBeDefined();
      if (!r) continue;
      expect(TIERS).toContain(r.tier);
      expect(Number.isFinite(r.cooldownMs)).toBe(true);
      expect(r.cooldownMs).toBeGreaterThanOrEqual(0);
      expect(r.durationMs).toBeGreaterThan(0);
      expect(typeof r.render).toBe("function");
      if (r.tier === "ambient") {
        // Beds are singletons the engine stops by hand, so an unbounded body
        // is legal here and nowhere else.
        expect(TIER_MAX_MS.ambient).toBe(Number.POSITIVE_INFINITY);
      } else {
        expect(Number.isFinite(r.durationMs)).toBe(true);
        // R6 — no recipe may be authored longer than its own tier allows.
        expect(clampDuration(r.tier, r.durationMs)).toBe(r.durationMs);
      }
      // R1 — every moment holds the floor.
      if (r.tier === "moment") expect(r.cooldownMs).toBeGreaterThanOrEqual(400);
    }
    expect(recipeOf("nope.not.a.sound")).toBeUndefined();
  });

  test("the full 61-name inventory is registered, cross-plan seams included", () => {
    expect(new Set(INVENTORY).size).toBe(61);
    expect(Object.keys(SFX_MAP).slice().sort()).toEqual(INVENTORY.slice().sort());
    // The seams other plans wire into, by literal name.
    for (const seam of ["countdown.beep", "wire.tick", "rank.up", "rank.xpTick", "ladder.rowHover"]) {
      expect(recipeOf(seam)).toBeDefined();
    }
    // R2 keys on /hover$/i — every hover-shaped name is swept (§C-2).
    const names = Object.keys(SFX_MAP);
    expect(names.filter((n) => /hover$/i.test(n)).sort()).toEqual([
      "card.hover",
      "ladder.rowHover",
      "parlay.card.hover",
      "ui.hover",
    ]);
  });

  test("a decelerating reel drives the tick pitch upward", () => {
    const seen: { name: SfxName; opts: SfxOpts | undefined }[] = [];
    __setTestSink((name, opts) => {
      seen.push({ name, opts });
    });
    // Gaps widen as the reel slows: dark dense chatter → bright heavy clacks.
    const gaps = [12, 18, 26, 40, 60, 90, 130, 180, 240];
    for (const gap of gaps) expect(sfx("spin.tick", tickParams(gap))).toBe(true);
    __setTestSink(null);

    expect(seen.length).toBe(gaps.length);
    expect(seen.every((s) => s.name === "spin.tick")).toBe(true);
    const pitches = seen.map((s) => s.opts?.pitch ?? 0);
    const gains = seen.map((s) => s.opts?.gain ?? 0);
    for (let i = 1; i < pitches.length; i++) {
      expect(pitches[i]!).toBeGreaterThanOrEqual(pitches[i - 1]!);
      expect(gains[i]!).toBeGreaterThanOrEqual(gains[i - 1]!);
    }
    expect(pitches[0]!).toBeLessThan(pitches[pitches.length - 1]!);

    // The ends of the ramp are clamped, and nonsense reads as the floor.
    expect(tickParams(0)).toEqual({ pitch: 0.9, gain: 0.55 });
    expect(tickParams(Number.NaN)).toEqual({ pitch: 0.9, gain: 0.55 });
    expect(tickParams(9999)).toEqual({ pitch: 1.5, gain: 1.2 });
  });
});

// ── 5. Pure helpers ───────────────────────────────────────────────────────

describe("pure helpers", () => {
  test("diffWon yields each leg once, on the false→true edge only", () => {
    expect(diffWon([false, false, false], [false, true, false])).toEqual([1]);
    // Already won: the edge fired on a previous frame, never again.
    expect(diffWon([false, true, false], [false, true, false])).toEqual([]);
    // A leg that un-wins is not a hit either.
    expect(diffWon([false, true, false], [false, false, false])).toEqual([]);
    // Several at once, in leg order.
    expect(diffWon([false, false, false], [true, false, true])).toEqual([0, 2]);
    // A tape that grows mid-flight only reports the new truths.
    expect(diffWon([true], [true, true])).toEqual([1]);
    expect(diffWon([], [])).toEqual([]);
  });

  test("comboPitch walks the ladder and resets after a miss", () => {
    expect(comboPitch(0)).toBeCloseTo(1, 5);
    expect(comboPitch(1)).toBeCloseTo(1.122, 5);
    expect(comboPitch(2)).toBeCloseTo(1.26, 5);
    expect(comboPitch(3)).toBeCloseTo(1.335, 5);
    // The ladder tops out rather than running away.
    expect(comboPitch(4)).toBeCloseTo(1.335, 5);
    expect(comboPitch(40)).toBeCloseTo(1.335, 5);
    // A miss drops the streak to zero, and the pitch back to the root.
    expect(comboPitch(-1)).toBeCloseTo(1, 5);
    expect(comboPitch(Number.NaN)).toBeCloseTo(1, 5);
    // Monotonic all the way up.
    for (let s = 1; s <= 3; s++) expect(comboPitch(s)).toBeGreaterThan(comboPitch(s - 1));
  });

  test("useSoundHover is referentially stable and its handler is safe", () => {
    const seen: { onPointerEnter: () => void }[] = [];
    function Probe(_props: { n: number }) {
      seen.push(useSoundHover("card.hover"));
      return null;
    }

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(Probe, { n: 1 })));
      act(() => root.render(createElement(Probe, { n: 2 })));
      act(() => root.render(createElement(Probe, { n: 3 })));

      expect(seen.length).toBeGreaterThanOrEqual(3);
      const first = seen[0]!;
      for (const h of seen) expect(h).toBe(first);
      expect(typeof first.onPointerEnter).toBe("function");
      // Hovering with no audio context must be a silent no-op, not a throw.
      expect(() => {
        first.onPointerEnter();
        first.onPointerEnter();
      }).not.toThrow();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Wave 5 — the duel soundtrack's pure seams                           */
/* ------------------------------------------------------------------ */

describe("palette", () => {
  afterEach(() => setPalette("NORMAL"));

  test("setPalette moves the global palette and getPalette reads it back", () => {
    expect(getPalette()).toBe("NORMAL");
    setPalette("BLITZ");
    expect(getPalette()).toBe("BLITZ");
    setPalette("QUICK");
    expect(getPalette()).toBe("QUICK");
    setPalette("NORMAL");
    expect(getPalette()).toBe("NORMAL");
  });

  test("the three palettes carry the pinned detune and decay scales", () => {
    // BLITZ = +2 semitones (2^(2/12) ≈ 1.1225), decay ×0.7; QUICK = +1 (≈1.0595), ×0.85.
    expect(PALETTE_DETUNE.NORMAL).toBe(1);
    expect(PALETTE_DECAY.NORMAL).toBe(1);
    expect(PALETTE_DETUNE.BLITZ).toBeCloseTo(2 ** (2 / 12), 3);
    expect(PALETTE_DETUNE.QUICK).toBeCloseTo(2 ** (1 / 12), 3);
    expect(PALETTE_DECAY.BLITZ).toBe(0.7);
    expect(PALETTE_DECAY.QUICK).toBe(0.85);
    // Sharper mode ⇒ higher pitch, shorter tail — strictly ordered.
    expect(PALETTE_DETUNE.BLITZ).toBeGreaterThan(PALETTE_DETUNE.QUICK);
    expect(PALETTE_DECAY.BLITZ).toBeLessThan(PALETTE_DECAY.QUICK);
  });
});

describe("the riser rule (A-g)", () => {
  // Mirrors matchSound.ts's inline `Math.max(320, settleAt * RISER_MS_PER_PRINT)`
  // with RISER_MS_PER_PRINT = 6 — the wall-clock remainder of the window after
  // the 0.85 trigger, at 40ms per print. If matchSound.ts ever exports the
  // helper, point this at the export instead of the local mirror.
  const riserMs = (settleAt: number) => Math.max(320, settleAt * 6);

  test("duration scales with the window instead of overrunning it", () => {
    expect(riserMs(56)).toBe(336);   // BLITZ — plan 3's flat 1600ms would overrun 5×
    expect(riserMs(110)).toBe(660);  // QUICK
    expect(riserMs(200)).toBe(1200); // NORMAL
    expect(riserMs(10)).toBe(320);   // the floor keeps a riser audible at all
  });

  test("startRiser/stopRiser are inert singletons without audio", () => {
    expect(() => {
      startRiser(336);
      startRiser(336); // second start is a no-op, never a double bed
      stopRiser(true);
      stopRiser();     // stopping a stopped riser is safe
    }).not.toThrow();
  });
});

describe("the combo ladder over a duel", () => {
  test("diffWon narrates the won-set sequence and the streak follows 5A's semantics", () => {
    // [none] → [0] → [0,2] → [0] (leg 2 falls back) → [0,1,2]
    const frames: boolean[][] = [
      [false, false, false],
      [true, false, false],
      [true, false, true],
      [true, false, false],
      [true, true, true],
    ];
    let streak = 0;
    const rungs: number[] = [];
    for (let i = 1; i < frames.length; i++) {
      const prev = frames[i - 1]!;
      const next = frames[i]!;
      // 5A resets the streak when a previously-won leg drops back through
      // its target — a real miss — never on a merely quiet tick.
      const dropped = prev.some((won, j) => won && !next[j]);
      if (dropped) streak = 0;
      for (const _ of diffWon(prev, next)) rungs.push(streak++);
    }
    // Hits climb 0,1 · the fall-back resets · then 0,1 again.
    expect(rungs).toEqual([0, 1, 0, 1]);
    expect(diffWon(frames[2]!, frames[3]!)).toEqual([]); // a drop is not a hit
    expect(comboPitch(rungs[1]!)).toBeCloseTo(1.122, 3);
    expect(comboPitch(rungs[2]!)).toBe(1); // the ladder restarts at the root
  });
});

describe("ambience beds", () => {
  test("study and duel beds are safe singletons with no audio context", () => {
    expect(() => {
      startAmbience("study");
      startAmbience("study"); // singleton: the second start is a no-op
      startAmbience("duel");
      stopAmbience("study");
      stopAmbience("study");  // stopping twice is safe
      stopAmbience("duel");
      stopAmbience("duel");
    }).not.toThrow();
  });
});

describe("wave 5 recipes in the map", () => {
  test("the duel and count-up events carry sane tiers and cooldowns", () => {
    expect(recipeOf("duel.leg.hit")?.tier).toBe("event");
    expect(recipeOf("duel.riser")?.tier).toBe("event");
    expect(recipeOf("result.count")?.tier).toBe("ui");
    expect(recipeOf("result.count")?.cooldownMs).toBe(40);
    expect(recipeOf("result.count.done")?.tier).toBe("action");
    expect(recipeOf("duel.settle.ready")?.tier).toBe("event");
    expect(recipeOf("duel.leg.miss")?.tier).toBe("event");
  });
});
