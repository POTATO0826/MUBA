import type { LobbyDef, MarketFilter, Player } from "../types.ts";
import { C } from "../theme.ts";
import { UNIVERSE } from "./universe.ts";

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

/** Lobbies other players have published. Each waits for a second seat. */
export const LOBBIES: readonly LobbyDef[] = [
  { id: "kz-semis", name: "Semis sprint", host: OPPONENTS[0]!, market: "STOCK", legs: 3, prize: 4.8, status: "open", mine: false, opponent: null, createdAgo: "2m" },
  { id: "mi-majors", name: "Majors only", host: OPPONENTS[1]!, market: "CRYPTO", legs: 2, prize: 1.2, status: "open", mine: false, opponent: null, createdAgo: "5m" },
  { id: "dr-mixed", name: "Cross-asset box", host: OPPONENTS[2]!, market: "MIXED", legs: 4, prize: 8.0, status: "open", mine: false, opponent: null, createdAgo: "9m" },
  { id: "lx-degen", name: "Friday tail", host: OPPONENTS[3]!, market: "CRYPTO", legs: 3, prize: 2.5, status: "open", mine: false, opponent: null, createdAgo: "12m" },
  { id: "no-grind", name: "Weekly grind", host: OPPONENTS[4]!, market: "STOCK", legs: 2, prize: 0.6, status: "open", mine: false, opponent: null, createdAgo: "18m" },
  { id: "ar-whale", name: "Whale box", host: OPPONENTS[5]!, market: "MIXED", legs: 4, prize: 20.0, status: "open", mine: false, opponent: null, createdAgo: "31m" },
];

export const MARKET_LABEL: Record<MarketFilter, string> = {
  STOCK: "STOCKS",
  CRYPTO: "CRYPTO",
  MIXED: "MIXED",
};

export const MARKET_COLOR: Record<MarketFilter, string> = {
  STOCK: C.blue,
  CRYPTO: C.accent,
  MIXED: C.violet,
};

/** Card backdrop per market: `[gradient stop, radial tint, angle]`. */
export const MARKET_WALL: Record<MarketFilter, [string, string, number]> = {
  STOCK: ["#0c2230", "rgba(56,189,248,.2)", 130],
  CRYPTO: ["#1c2a12", "rgba(200,255,0,.22)", 145],
  MIXED: ["#221436", "rgba(167,139,250,.24)", 165],
};

/** The tickers a lobby's spin can deal, in board order. */
export function bookFor(market: MarketFilter): readonly string[] {
  return UNIVERSE.filter((u) => market === "MIXED" || u.mkt === market).map((u) => u.sym);
}

/** Whoever sits across from you in a lobby. */
export function opponentOf(lobby: LobbyDef): Player | null {
  return lobby.mine ? lobby.opponent : lobby.host;
}

/** What each player puts up, in points — the demo's unit, at 1 Ξ = 1,000. */
export const stakePointsFor = (lobby: LobbyDef): number => Math.round((lobby.prize / 2) * 1000);
