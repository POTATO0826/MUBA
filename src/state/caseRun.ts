import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { caseById, stakePointsFor } from "../data/cases.ts";
import { PLAYER, lockedBy } from "../data/rewards.ts";
import {
  buildLeg,
  settleCase,
  summarize,
  type ParlayLeg,
  type Tier,
} from "../engine/parlay.ts";
import { newSeed, spinCase } from "../engine/spin.ts";
import { TAPE_LEN } from "../engine/tape.ts";
import type { Route } from "../lib/route.ts";
import type { Direction, Tab } from "../types.ts";

/**
 * One case run: which case, which seed, how the legs are tiered, and how far
 * the tape has played.
 *
 * The legs themselves are not state. They fall out of `spinCase(case, seed)`,
 * which is deterministic — so a `/case/:id/study?seed=N` link rebuilt from
 * nothing has the same legs the person who sent it saw.
 */
export interface CaseRunState {
  tab: Tab;
  caseId: string | null;
  seed: number;
  /** Free re-rolls left on this open. One per open; tracked here, not on-chain. */
  respinsLeft: number;
  tiers: Record<string, Tier>;
  dirs: Record<string, Direction>;
  /** Advances every 120ms while the tape is running. */
  tick: number;
  /** Underlying selected on the options desk. */
  asset: string;
}

/** Prints per tick on the tape: the whole tape plays in about eight seconds. */
export const TAPE_STEP = 3;
export const RESPINS_PER_OPEN = 1;
export const DEFAULT_TIER: Tier = "EVEN";

export function initialState(route: Route): CaseRunState {
  const c = caseById(route.caseId);
  // A locked case is not openable from a link either — the URL is just
  // another door, and it lands on the library like the card does.
  const openable = c !== null && !lockedBy(c.tier, PLAYER.tier);
  const outside = route.tab === "lobby" || route.tab === "desk";
  return {
    // A case address with no real case behind it lands on the library.
    tab: openable ? route.tab : outside ? route.tab : "cases",
    caseId: openable ? c.id : null,
    seed: route.seed ?? newSeed(),
    respinsLeft: RESPINS_PER_OPEN,
    tiers: {},
    dirs: {},
    tick: 0,
    asset: "ETH",
  };
}

type Patch = Partial<CaseRunState> | ((s: CaseRunState) => Partial<CaseRunState>);

export function useCaseRun(route: Route) {
  const [state, setState] = useState<CaseRunState>(() => initialState(route));

  // The clock runs outside React's render, so it reads the tab through a ref.
  const stateRef = useRef(state);
  stateRef.current = state;

  const patch = useCallback((p: Patch) => {
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (stateRef.current.tab === "tape") setState((s) => ({ ...s, tick: s.tick + 1 }));
    }, 120);
    return () => clearInterval(id);
  }, []);

  const actions = useMemo(
    () => ({
      go: (tab: Tab) => () => patch({ tab }),
      setAsset: (asset: string) => patch({ asset }),

      /** Open a case: a fresh seed, a full re-roll allowance, default tiers. */
      openCase: (caseId: string, seed?: number) =>
        patch({
          tab: "spin",
          caseId,
          seed: seed ?? newSeed(),
          respinsLeft: RESPINS_PER_OPEN,
          tiers: {},
          dirs: {},
          tick: 0,
        }),
      /** Abandon the spin. */
      closeSpin: () => patch({ tab: "cases", caseId: null }),
      /** The one free re-roll. A no-op once it is spent. */
      respin: () =>
        patch((s) =>
          s.respinsLeft > 0
            ? { seed: newSeed(), respinsLeft: s.respinsLeft - 1, tiers: {}, dirs: {} }
            : {},
        ),
      claim: () => patch({ tab: "parlay-build" }),

      setTier: (sym: string, tier: Tier) =>
        patch((s) => ({ tiers: { ...s.tiers, [sym]: tier } })),
      setDir: (sym: string, dir: Direction) =>
        patch((s) => ({ dirs: { ...s.dirs, [sym]: dir } })),
      lockParlay: () => patch({ tab: "study" }),

      runTape: () => patch({ tab: "tape", tick: 0 }),
      settle: () => patch({ tab: "settled" }),
      backToCases: () => patch({ tab: "cases", caseId: null, tick: 0 }),
    }),
    [patch],
  );

  const derived = useMemo(() => {
    const caseDef = caseById(state.caseId);
    const spin = caseDef ? spinCase(caseDef.eligibleAssets, caseDef.legCount, state.seed) : null;
    const legs: readonly ParlayLeg[] = spin
      ? spin.syms.map((sym) =>
          buildLeg(sym, state.dirs[sym] ?? "over", state.tiers[sym] ?? DEFAULT_TIER),
        )
      : [];
    const stakePoints = caseDef ? stakePointsFor(caseDef) : 0;
    const summary = caseDef ? summarize(legs, caseDef, stakePoints) : null;

    // Study and the tape draw different windows on the same tickers.
    const studySalt = 1 + state.seed * 3;
    const fightSalt = 2 + state.seed * 3;
    const pos = Math.min(TAPE_LEN, Math.max(2, state.tick * TAPE_STEP));

    return {
      caseDef,
      spin,
      legs,
      /** Symbols charted: exactly the legs the spin dealt. */
      arena: spin ? spin.syms : [],
      stakePoints,
      summary,
      studySalt,
      fightSalt,
      /** Print index the tape has played up to. */
      pos,
      raceDone: pos >= TAPE_LEN,
      /** The final settlement, read off the whole tape. */
      verdict: summary
        ? settleCase(legs, fightSalt, TAPE_LEN, stakePoints, summary.effectiveMult)
        : null,
    };
  }, [state.caseId, state.seed, state.dirs, state.tiers, state.tick]);

  return { state, derived, actions };
}

export type CaseRun = ReturnType<typeof useCaseRun>;
