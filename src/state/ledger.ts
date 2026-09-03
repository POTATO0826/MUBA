import { useCallback, useMemo, useState } from "react";

/**
 * Everything that will one day live on-chain, behind one hook.
 *
 * Points balance, entries and settlements are in-memory here. Swapping this
 * for contract reads and writes means reimplementing `useLedger` against the
 * chain and nothing else — no view knows where the balance comes from.
 */

export interface SettledRecord {
  lobbyId: string;
  seed: number;
  stake: number;
  points: number;
  won: boolean;
}

export interface Ledger {
  /** Points on hand. */
  points: number;
  /** Take a seat: the entry leaves the balance. */
  enter: (stake: number) => void;
  /** The duel settled: whatever it paid comes back. */
  settle: (record: SettledRecord) => void;
  history: readonly SettledRecord[];
}

const OPENING_BALANCE = 5000;

export function useLedger(): Ledger {
  const [points, setPoints] = useState(OPENING_BALANCE);
  const [history, setHistory] = useState<readonly SettledRecord[]>([]);

  const enter = useCallback((stake: number) => setPoints((p) => p - stake), []);

  const settle = useCallback((record: SettledRecord) => {
    setPoints((p) => p + record.points);
    setHistory((h) => [record, ...h]);
  }, []);

  return useMemo(() => ({ points, enter, settle, history }), [points, enter, settle, history]);
}
