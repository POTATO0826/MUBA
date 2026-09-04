import { useCallback, useMemo, useState } from "react";
import { PLAYER } from "../data/rewards.ts";
import { xpForMatch } from "../engine/rank.ts";
import type { Mode } from "../types.ts";

/**
 * Everything that will one day live on-chain, behind one hook.
 *
 * Points balance, entries and settlements are in-memory here. Swapping this
 * for contract reads and writes means reimplementing `useLedger` against the
 * chain and nothing else — no view knows where the balance comes from.
 *
 * Nothing is persisted: a reload starts a fresh season at `OPENING_BALANCE`
 * with an empty history. If a storage boundary is ever added, `SettledRecord`'s
 * three newer fields (`mode`, `xp`, `sectors`) must be defaulted on read
 * (`"NORMAL"` / `0` / `[]`) so rows written before them still load — they are
 * required on the type precisely so every in-process writer supplies them.
 */

export interface SettledRecord {
  lobbyId: string;
  seed: number;
  stake: number;
  points: number;
  won: boolean;
  /** The lobby's mode. Sets the XP the match was worth. */
  mode: Mode;
  /** What this match paid in season XP — `xpForMatch(mode, sweep, won)`. */
  xp: number;
  /** RAW `Asset.sector` strings of the tickers the spin actually DEALT
   *  (`arena.map(s => meta(s).sector)`) — not the lobby's sector-group config.
   *  The ladder reads these to describe how a player actually plays. */
  sectors: readonly string[];
}

/** What a caller hands `settle`. `xp` is not passed: it is derived here from
 *  `mode`/`sweep`/`won` so the XP table lives in exactly one place
 *  (`src/engine/rank.ts`) and no call site can disagree with it. */
export interface SettleInput extends Omit<SettledRecord, "xp"> {
  /** Every one of my legs cashed. Doubles the match's XP. */
  sweep: boolean;
}

export interface Ledger {
  /** Points on hand. */
  points: number;
  /** Take a seat: the entry leaves the balance. */
  enter: (stake: number) => void;
  /** The duel settled: whatever it paid comes back. */
  settle: (input: SettleInput) => void;
  history: readonly SettledRecord[];
  /** Season XP total — plan 4's `xpAfter`. Already carries `PLAYER.xp` as the
   *  opening balance, so consumers read this as-is and must NOT add `PLAYER.xp`
   *  to it a second time. */
  xp: number;
  /** Consecutive wins ending at the most recent match (`history[0]`). */
  streak: number;
  /** The longest win run in the history — the best streak of the session. */
  best: number;
}

const OPENING_BALANCE = 5000;

/** Leading run of wins, newest first, and the longest run anywhere in the list.
 *  History is append-front and never pruned, so the longest run in it is also
 *  the best streak ever reached. */
function runs(history: readonly SettledRecord[]): { streak: number; best: number } {
  let streak = 0;
  let best = 0;
  let run = 0;
  for (const r of history) {
    if (r.won) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  for (const r of history) {
    if (!r.won) break;
    streak += 1;
  }
  return { streak, best };
}

export function useLedger(): Ledger {
  const [points, setPoints] = useState(OPENING_BALANCE);
  const [history, setHistory] = useState<readonly SettledRecord[]>([]);

  const enter = useCallback((stake: number) => setPoints((p) => p - stake), []);

  const settle = useCallback(({ sweep, ...rest }: SettleInput) => {
    const record: SettledRecord = { ...rest, xp: xpForMatch(rest.mode, sweep, rest.won) };
    setPoints((p) => p + record.points);
    setHistory((h) => [record, ...h]);
  }, []);

  const { xp, streak, best } = useMemo(() => {
    const total = history.reduce<number>((a, r) => a + r.xp, PLAYER.xp);
    return { xp: total, ...runs(history) };
  }, [history]);

  return useMemo(
    () => ({ points, enter, settle, history, xp, streak, best }),
    [points, enter, settle, history, xp, streak, best],
  );
}
