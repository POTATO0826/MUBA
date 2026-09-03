import { useCallback, useMemo, useState } from "react";

/**
 * Everything that will one day live on-chain, behind one hook.
 *
 * Points balance, case opens and settlements are in-memory here. Swapping this
 * for contract reads and writes means reimplementing `useLedger` against the
 * chain and nothing else — no view knows where the balance comes from.
 *
 * Non-custodial framing throughout: `open` is buying a position, `settle` is
 * that position paying out or expiring. There is no house on the other side.
 */

export interface SettledRecord {
  caseId: string;
  seed: number;
  stake: number;
  points: number;
  allHit: boolean;
}

export interface Ledger {
  /** Points on hand. */
  points: number;
  /** Buy the position: the stake leaves the balance. */
  open: (stake: number) => void;
  /** The position settled: whatever it paid comes back. */
  settle: (record: SettledRecord) => void;
  history: readonly SettledRecord[];
}

const OPENING_BALANCE = 5000;

export function useLedger(): Ledger {
  const [points, setPoints] = useState(OPENING_BALANCE);
  const [history, setHistory] = useState<readonly SettledRecord[]>([]);

  const open = useCallback((stake: number) => setPoints((p) => p - stake), []);

  const settle = useCallback((record: SettledRecord) => {
    setPoints((p) => p + record.points);
    setHistory((h) => [record, ...h]);
  }, []);

  return useMemo(() => ({ points, open, settle, history }), [points, open, settle, history]);
}
