import { useMemo } from "react";
import {
  YOU_ID,
  buildYou,
  copyEconomicsFor,
  positionOf,
  type CopyEconomics,
  type LeaderPlayer,
} from "../data/leaderboard.ts";
import { sectorOf } from "../data/sectors.ts";
import { rankAt, type RankPoint } from "../engine/rank.ts";
import type { Mode, SectorKey } from "../types.ts";
import type { Ledger } from "./ledger.ts";

/**
 * The rank moment's whole input, derived from the ledger and nothing else.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY `xpAfter` IS JUST `ledger.xp`
 * ────────────────────────────────────────────────────────────────────────────
 * `useLedger` already folds `PLAYER.xp` in as the season's opening balance:
 * `ledger.xp === PLAYER.xp + Σ history[i].xp`. That IS the after-total. Plan 4
 * §3.2's sketch reads `xpAfter = PLAYER.xp + Σ history.xp` because it was
 * written before the ledger derived it — adding `PLAYER.xp` here a second time
 * would double-count the opening balance and put every player 2,340 XP too
 * high, which is a whole tier.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY `history[0]` IS THE MATCH YOU JUST PLAYED
 * ────────────────────────────────────────────────────────────────────────────
 * `App.tsx` calls `ledger.settle()` on the duel → result transition, so by the
 * time `Result` mounts the match is already the newest history entry. The
 * before-total is therefore the after-total minus that entry's XP, and the
 * gain the sequence counts out is that entry's XP — never a separately
 * computed number that could disagree with what the ledger banked.
 *
 * Everything below is a pure function of `(xpBefore, xpAfter, history)`. No
 * clock, no DOM: the presentation lives entirely in `RankUpSequence`.
 */
export interface RankProgress {
  /** Season XP before the match that just settled. */
  xpBefore: number;
  /** Season XP now. `ledger.xp`, unmodified. */
  xpAfter: number;
  /** What the match paid — `history[0].xp`. The figure the bar counts out. */
  gain: number;
  /** Consecutive wins ending at the newest match. */
  streak: number;
  /** Longest run this session. */
  best: number;
  before: RankPoint;
  after: RankPoint;
  /** Ladder position at `xpBefore` — the `#9` of `#9 → #7`. */
  posBefore: number;
  /** Ladder position at `xpAfter`. Never worse than `posBefore`. */
  posAfter: number;
  /** Copy-trade economics before the match: the copier count's start value. */
  econBefore: CopyEconomics;
  /** Copy-trade economics now: what the copy panel settles on. */
  econAfter: CopyEconomics;
  /** This match crossed INTO copy-trade — locked before, unlocked now. Picks
   *  the copy stage's sound (`rank.copyUnlock`) and its headline row. */
  unlockedCopy: boolean;
  /** Your row on the ladder, ready for the `/ranks` page (wave 7). */
  you: LeaderPlayer;
}

/**
 * The rank moment's state, read straight off the ledger.
 *
 * Called once in `App` and threaded into `Result` as the six scalars of
 * BUILD-ORDER §C-6. `Result` and `RankUpSequence` re-derive the rank points
 * and the copy economics from those scalars with the same pure functions used
 * here, so the two surfaces cannot disagree — and §C-6 stays exactly as
 * pinned, with no `RankProgress` object in the prop list.
 */
export function useRankProgress(ledger: Ledger): RankProgress {
  const { xp, history, streak, best } = ledger;

  return useMemo(() => {
    const xpAfter = Math.max(0, xp);
    // The match that just settled is already history[0] — App settles on the
    // duel → result transition, before Result ever mounts.
    const gain = history[0]?.xp ?? 0;
    const xpBefore = Math.max(0, xpAfter - gain);

    const before = rankAt(xpBefore);
    const after = rankAt(xpAfter);

    const econBefore = copyEconomicsFor(YOU_ID, xpBefore);
    const econAfter = copyEconomicsFor(YOU_ID, xpAfter);

    // `SettledRecord.sectors` holds RAW `Asset.sector` strings; the ladder
    // speaks in sector GROUPS, so every one goes through `sectorOf`.
    const sectors: SectorKey[] = [];
    const modes: Mode[] = [];
    let wins = 0;
    for (const r of history) {
      if (r.won) wins += 1;
      for (const raw of r.sectors) sectors.push(sectorOf(raw));
      modes.push(r.mode);
    }

    return {
      xpBefore,
      xpAfter,
      gain,
      streak,
      best,
      before,
      after,
      posBefore: positionOf(xpBefore),
      posAfter: positionOf(xpAfter),
      econBefore,
      econAfter,
      unlockedCopy: after.tier.copyUnlocked && !before.tier.copyUnlocked,
      you: buildYou({ xp: xpAfter, battles: history.length, wins, sectors, modes }),
    };
  }, [xp, history, streak, best]);
}
