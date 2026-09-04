import { useEffect, useRef } from "react";
import { legState } from "../engine/match.ts";
import {
  audioAvailable,
  comboPitch,
  diffWon,
  setPalette,
  sfx,
  startAmbience,
  startRiser,
  stopAmbience,
  stopRiser,
} from "../lib/sound/index.ts";
import type { Leg, Mode, Tab } from "../types.ts";

/**
 * The match's sound layer: everything the app plays because of a STATE change
 * rather than because of a press.
 *
 * A press is audible where it happens — the button knows it was clicked. But a
 * leg landing, the opponent readying up, the tape crossing 85% of its window
 * and the tab it all happens on are facts about `useMatch`'s state, seen by no
 * single view. Folding them here keeps every view free of tape bookkeeping and
 * keeps the duel's soundtrack in one readable table.
 *
 * Everything is edge-triggered off refs of the previous value, so the hook is
 * safe to run on every render: it plays a sound when a value CHANGED, never
 * because a render happened. Nothing here can affect what is dealt or how a
 * duel settles — it only reads.
 *
 * Under happy-dom `audioAvailable` is `false`. The hooks themselves are still
 * called unconditionally (rules of hooks), but every effect body returns on the
 * first line, so a test mounts zero listeners, zero timers and zero refs worth
 * updating.
 */

/** The slice of `MatchState` the sound layer reads. Declared structurally so
 *  this module never has to import `match.ts`, which imports it. */
export interface MatchSoundState {
  readonly tab: Tab;
  readonly ready: { readonly me: boolean; readonly opp: boolean };
  readonly myPicks: Readonly<Record<string, string>>;
}

/** The slice of `derived` the sound layer reads — same reasoning. */
export interface MatchSoundDerived {
  readonly bothReady: boolean;
  readonly myLegs: readonly Leg[];
  readonly oppLegs: readonly Leg[];
  readonly fightSalt: number;
  readonly mode: { readonly key: Mode };
  readonly settleAt: number;
  readonly pos: number;
  readonly raceDone: boolean;
  readonly verdict: { readonly meWins: boolean } | null;
  readonly matchKey: string;
}

/** How much of the window has to be behind us before the riser starts (A-g). */
const RISER_AT = 0.85;
/** `settleAt * 0.15 / TAPE_STEP * 120` — the exact wall-clock remainder, so the
 *  climb lands on the settle instead of being cut off by `stopRiser` (A-g). */
const RISER_MS_PER_PRINT = 6;
/** The tape is quiet: one soft print marker every fourth advance. */
const TAPE_TICK_EVERY = 4;
/** Spacing on the "these never landed" roll-call after the settle. */
const MISS_STAGGER_MS = 120;

const wonSet = (legs: readonly Leg[], salt: number, pos: number): boolean[] =>
  legs.map((l) => legState(l, salt, pos).won);

export function useMatchSound(state: MatchSoundState, derived: MatchSoundDerived): void {
  // Values an edge-triggered effect needs to READ but must not be woken by.
  // Written during render exactly as `useMatch` writes its own `stateRef`.
  const legsRef = useRef(derived);
  legsRef.current = derived;

  // Previous values, one ref per edge.
  const prevTab = useRef<Tab | null>(null);
  const prevOppReady = useRef(false);
  const prevBothReady = useRef(false);
  const prevMyWon = useRef<boolean[]>([]);
  const prevOppWon = useRef<boolean[]>([]);
  const prevPos = useRef(-1);
  const prevPicks = useRef<Readonly<Record<string, string>> | null>(null);
  const streak = useRef(0);
  const tapeTicks = useRef(0);
  const riserOn = useRef(false);
  const settled = useRef(false);

  // A new (lobby, seed) is a new duel: the combo ladder, the won-sets, the
  // riser and the settle are all per-match and must not leak across one.
  // Declared FIRST so it runs before the edge effects in the same commit.
  useEffect(() => {
    if (!audioAvailable) return;
    prevOppReady.current = false;
    prevBothReady.current = false;
    prevMyWon.current = [];
    prevOppWon.current = [];
    prevPos.current = -1;
    prevPicks.current = null;
    streak.current = 0;
    tapeTicks.current = 0;
    riserOn.current = false;
    settled.current = false;
    stopRiser();
  }, [derived.matchKey]);

  // One call retunes every recipe: BLITZ is brighter, tighter and ticks faster.
  // With no lobby on screen there is no window, and NORMAL is the identity —
  // which is exactly what `derived.mode` already falls back to.
  useEffect(() => {
    if (!audioAvailable) return;
    setPalette(derived.mode.key);
  }, [derived.mode.key]);

  // Tab transitions. The beds are singletons (R9): starting one twice is a
  // no-op, and leaving always stops the one we started.
  useEffect(() => {
    if (!audioAvailable) return;
    const from = prevTab.current;
    const to = state.tab;
    if (from === to) return;
    prevTab.current = to;

    if (from === "study") stopAmbience("study");
    if (from === "duel") stopAmbience("duel");

    if (to === "study") {
      sfx("nav.transition");
      startAmbience("study");
    } else if (to === "duel") {
      // `startAmbience("duel")` IS `duel.start` (§C-1) — calling `sfx` for it
      // as well would be refused by its own 400ms cooldown and would leave the
      // bed unregistered, so the leave edge could never stop it.
      startAmbience("duel");
    } else if (to === "result") {
      // The verdict is settled the moment the tab flips; read it off the live
      // ref rather than making it a dependency of this effect (it is rebuilt
      // on every tape tick and would re-fire nothing but churn).
      sfx(legsRef.current.verdict?.meWins ? "result.win" : "result.loss");
    }
  }, [state.tab]);

  // Leaving the match entirely — unmount — must not leave a bed or a riser
  // playing under the next screen.
  useEffect(() => {
    if (!audioAvailable) return;
    return () => {
      stopAmbience("study");
      stopAmbience("duel");
      stopRiser();
    };
  }, []);

  // The room's two edges. `room.ready.me` is fired by the button in Room.tsx —
  // a press is audible where it happens; these two are not presses.
  useEffect(() => {
    if (!audioAvailable) return;
    if (state.ready.opp && !prevOppReady.current) sfx("room.ready.opp");
    prevOppReady.current = state.ready.opp;
    if (derived.bothReady && !prevBothReady.current) sfx("room.bothready");
    prevBothReady.current = derived.bothReady;
  }, [state.ready.opp, derived.bothReady]);

  // The slip moving. `parlay.card.pick` is the press; this is the slip on the
  // right redrawing itself, and the map throttles it to one per 200ms (R1).
  useEffect(() => {
    if (!audioAvailable) return;
    const prev = prevPicks.current;
    prevPicks.current = state.myPicks;
    if (prev === null || prev === state.myPicks) return;
    if (state.tab === "parlay") sfx("parlay.slip.change");
  }, [state.myPicks, state.tab]);

  // The duel itself, once per advance of the tape. `pos` is the clock: it is
  // the only thing that moves during a duel, so keying on it makes this effect
  // run exactly as often as the tape prints.
  useEffect(() => {
    if (!audioAvailable) return;
    if (state.tab !== "duel") return;
    const d = legsRef.current;
    if (d.pos === prevPos.current) return;
    prevPos.current = d.pos;

    // The same won-state the duel screen draws: `legState` at `pos` on the
    // fight salt. Mirroring it exactly is what keeps the sound honest.
    const myWon = wonSet(d.myLegs, d.fightSalt, d.pos);
    const oppWon = wonSet(d.oppLegs, d.fightSalt, d.pos);

    // A leg that had cleared its target and fell back through it breaks the
    // run — that is the "miss" the combo ladder resets on. An uneventful tick
    // does not: legs land seconds apart, and resetting on silence would pin
    // every hit to the bottom rung and the ladder would never be heard.
    const lost = prevMyWon.current.some((was, i) => was === true && myWon[i] !== true);
    if (lost) streak.current = 0;

    const hits = diffWon(prevMyWon.current, myWon).length;
    for (let k = 0; k < hits; k++) {
      sfx("duel.leg.hit", { pitch: comboPitch(streak.current) });
      streak.current += 1;
    }
    const oppHits = diffWon(prevOppWon.current, oppWon).length;
    for (let k = 0; k < oppHits; k++) sfx("duel.leg.hit.opp");
    prevMyWon.current = myWon;
    prevOppWon.current = oppWon;

    tapeTicks.current += 1;
    if (tapeTicks.current % TAPE_TICK_EVERY === 0) sfx("duel.tape.tick");

    // The last 15% of the window, climbing for exactly as long as that 15%
    // takes to play (A-g). Once per duel — the riser is a singleton anyway,
    // but the ref keeps us from asking forty times.
    if (!riserOn.current && d.pos >= d.settleAt * RISER_AT) {
      riserOn.current = true;
      startRiser(Math.max(320, d.settleAt * RISER_MS_PER_PRINT));
    }

    if (d.raceDone && !settled.current) {
      settled.current = true;
      stopRiser(true);
      sfx("duel.settle.ready");
      // The roll-call of legs that never landed, staggered so it reads as a
      // list rather than a chord. `delayMs` is audio-clock scheduling, not a
      // timer — nothing is queued in JS.
      let n = 0;
      for (const won of myWon) {
        if (won) continue;
        sfx("duel.leg.miss", { delayMs: n * MISS_STAGGER_MS });
        n += 1;
      }
    }
  }, [state.tab, derived.pos, derived.raceDone]);
}
