import { useCallback, useMemo, useState } from "react";
import {
  clampDuration,
  clampStake,
  MIN_DURATION_MINUTES,
  MIN_STAKE_USDC,
  poolOf,
  stepStake,
  usdc,
} from "../data/stake.ts";
import type { GameMode, Tab } from "../types.ts";

/**
 * Arena setup.
 *
 * This used to hold a whole draft-and-tape game: picks, bans, a seeded random
 * walk, an autopilot. Both PvP modes now run on live Thetanuts data, so none of
 * that survives. What is left is the four things a player sets before a duel.
 */
export interface BattleState {
  tab: Tab;
  /** Which of the two PvP modes this arena plays. */
  mode: GameMode;
  /** What each player stakes, in USDC. The pot is twice this. */
  stakeUsdc: number;
  /** Raw text in the stake field — kept apart from `stakeUsdc` so a half-typed
   *  "1." survives until blur. */
  stakeText: string;
  /** How long the duel runs, in whole minutes. */
  durationMinutes: number;
  lobbyName: string;
}

export const INITIAL_STATE: BattleState = {
  tab: "hub",
  mode: "parlay",
  stakeUsdc: 10,
  stakeText: "10.00",
  durationMinutes: 1,
  lobbyName: "Room #4471",
};

type Patch = Partial<BattleState> | ((s: BattleState) => Partial<BattleState>);

export function useBattle() {
  const [state, setState] = useState<BattleState>(INITIAL_STATE);

  const patch = useCallback((next: Patch) => {
    setState((s) => ({ ...s, ...(typeof next === "function" ? next(s) : next) }));
  }, []);

  const actions = useMemo(
    () => ({
      go: (tab: Tab) => () => patch({ tab }),

      /** Choose a mode, then go to the arena builder. */
      enterMode: (mode: GameMode) => patch({ mode, tab: "create" }),

      setLobbyName: (lobbyName: string) => patch({ lobbyName }),

      setDuration: (minutes: number) =>
        patch({
          durationMinutes: clampDuration(
            Number.isFinite(minutes) ? minutes : MIN_DURATION_MINUTES,
          ),
        }),

      onStakeInput: (raw: string) => {
        const cleaned = raw.replace(/[^0-9.]/g, "");
        const f = parseFloat(cleaned);
        // The clamp lands on blur, not on keystroke: clamping while typing makes
        // "1" jump to the minimum before the user reaches "12".
        patch(Number.isFinite(f) ? { stakeText: cleaned, stakeUsdc: f } : { stakeText: cleaned });
      },
      onStakeBlur: () =>
        patch((s) => {
          const v = clampStake(Number.isFinite(s.stakeUsdc) ? s.stakeUsdc : MIN_STAKE_USDC);
          return { stakeUsdc: v, stakeText: v.toFixed(2) };
        }),
      stakeUp: () =>
        patch((s) => {
          const v = stepStake(s.stakeUsdc, 1);
          return { stakeUsdc: v, stakeText: v.toFixed(2) };
        }),
      stakeDown: () =>
        patch((s) => {
          const v = stepStake(s.stakeUsdc, -1);
          return { stakeUsdc: v, stakeText: v.toFixed(2) };
        }),
    }),
    [patch],
  );

  const derived = useMemo(
    () => ({
      /** The pot the winner takes: both stakes. */
      prizeLabel: usdc(poolOf(state.stakeUsdc)),
      /** What one player risks. */
      entryLabel: usdc(state.stakeUsdc),
    }),
    [state.stakeUsdc],
  );

  return { state, derived, actions };
}

export type Battle = ReturnType<typeof useBattle>;
