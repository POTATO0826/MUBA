import type { LobbyDef, Player } from "../types.ts";
import { C } from "../theme.ts";
import { bookForSectors } from "./sectors.ts";

/** The player on this browser. */
export const YOU: Player = { name: "You", initial: "YO", bg: C.indigo };

/** Everyone who might be on the other side of the table. */
export const OPPONENTS: readonly Player[] = [
  { name: "kazuo.eth", initial: "KZ", bg: C.red },
  { name: "mira.base", initial: "MI", bg: C.green },
  { name: "0xdrift", initial: "DR", bg: C.accent },
  { name: "lexa", initial: "LX", bg: C.violet },
  { name: "noor", initial: "NO", bg: "#2dd4bf" },
  { name: "arlo.eth", initial: "AR", bg: C.indigo },
  { name: "qbit", initial: "QB", bg: "#fbbf24" },
  { name: "zeph", initial: "ZE", bg: C.accent },
];

export function randomOpponent(random: () => number = Math.random): Player {
  return OPPONENTS[Math.floor(random() * OPPONENTS.length)]!;
}

/**
 * Lobbies other players have published. Each waits for a second seat.
 *
 * `sectors` is the real input — `market` is `marketOf(sectors)`, written out
 * literally so the fixtures stay readable and so the invariant is checkable
 * (`test/spin.test.ts` asserts it for every row).
 *
 * `kz-semis` carries the FULL stock preset rather than a narrower
 * SEMIS-themed book on purpose: `test/app.test.tsx` and
 * `test/determinism.test.ts` pin the tickers it deals at seed 424242 against
 * `bookFor("STOCK")`, and `spinCase` indexes into the book, so any narrowing
 * would silently re-deal that match. The other five carry themed books.
 *
 * `kz-semis` and `mi-majors` MUST stay `NORMAL` for the same reason: `MODE_SALT`
 * rides on both match salts and `settleAt` shortens the window, and `NORMAL` is
 * the identity of both (salt 0, the whole tape, ×1 targets and odds). The
 * multipliers and percentages those two matches are pinned at in
 * `test/app.test.tsx` only survive on the identity mode.
 */
export const LOBBIES: readonly LobbyDef[] = [
  { id: "kz-semis", name: "Semis sprint", host: OPPONENTS[0]!, sectors: ["SEMIS", "TECH", "MACRO"], market: "STOCK", mode: "NORMAL", legs: 3, prize: 4.8, status: "open", mine: false, opponent: null, createdAgo: "2m" },
  { id: "mi-majors", name: "Majors only", host: OPPONENTS[1]!, sectors: ["MAJORS"], market: "CRYPTO", mode: "NORMAL", legs: 2, prize: 1.2, status: "open", mine: false, opponent: null, createdAgo: "5m" },
  { id: "dr-mixed", name: "Cross-asset box", host: OPPONENTS[2]!, sectors: ["SEMIS", "MAJORS"], market: "MIXED", mode: "QUICK", legs: 4, prize: 8.0, status: "open", mine: false, opponent: null, createdAgo: "9m" },
  { id: "lx-degen", name: "Friday tail", host: OPPONENTS[3]!, sectors: ["DEFI", "MEME"], market: "CRYPTO", mode: "BLITZ", legs: 3, prize: 2.5, status: "open", mine: false, opponent: null, createdAgo: "12m" },
  { id: "no-grind", name: "Weekly grind", host: OPPONENTS[4]!, sectors: ["MACRO"], market: "STOCK", mode: "QUICK", legs: 2, prize: 0.6, status: "open", mine: false, opponent: null, createdAgo: "18m" },
  { id: "ar-whale", name: "Whale box", host: OPPONENTS[5]!, sectors: ["MACRO", "DEFI"], market: "MIXED", mode: "BLITZ", legs: 4, prize: 20.0, status: "open", mine: false, opponent: null, createdAgo: "31m" },
];

/** Market identity and the market book live in ./sectors.ts (A-k3) so that
 *  `sectorChips` can reach MARKET_COLOR without a lobbies ↔ sectors cycle.
 *  Re-exported here verbatim — every existing import path stays valid. */
export { MARKET_LABEL, MARKET_COLOR, MARKET_WALL, bookFor } from "./sectors.ts";

/** The tickers this lobby's spin deals from, in canonical board order.
 *
 *  The single source of the book. `spinCase` indexes into this array, and
 *  `MatchSpin` must be handed the SAME contents in the SAME order — feeding
 *  the reel a different list is a silent, seed-dependent wrong-tile bug. */
export function bookOf(lobby: LobbyDef): readonly string[] {
  return bookForSectors(lobby.sectors);
}

/** Whether the book can fill the legs. `spinCase` THROWS on a book that is
 *  too small, and `derived` runs on every render, so every call site guards
 *  on this rather than catching. */
export function canPlay(lobby: LobbyDef): boolean {
  return bookOf(lobby).length >= lobby.legs;
}

/** Whoever sits across from you in a lobby. */
export function opponentOf(lobby: LobbyDef): Player | null {
  return lobby.mine ? lobby.opponent : lobby.host;
}

/** What each player puts up, in points — the demo's unit, at 1 Ξ = 1,000. */
export const stakePointsFor = (lobby: LobbyDef): number => Math.round((lobby.prize / 2) * 1000);
