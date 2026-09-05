import type { Tab } from "../types.ts";

/**
 * The URL, both ways. There is no router — the app is a `Tab` switch — but a
 * match wants a shareable address, and the spin wants its seed in it so the
 * same link replays the same tickers.
 *
 *   /                 home
 *   /battles          the lobby board
 *   /create           the lobby builder
 *   /desk             the options desk
 *   /ranks            the ladder
 *   /arena            live-data PvP modes
 *   /test             Base Sepolia DuelEscrow test console
 *   /testing          Base Sepolia GameStake console — stake / winnerTakesAll
 *   /room/:id         shared live-data PvP room
 *   /match/:id/room?seed=N       the lobby room — both players ready up
 *   /match/:id?seed=N            the spin
 *   /match/:id/study?seed=N      the case study
 *   /match/:id/parlay?seed=N     the parlay cards
 *   /match/:id/duel?seed=N       the tape running
 *   /match/:id/result?seed=N     the result
 */

export interface Route {
  tab: Tab;
  lobbyId: string | null;
  seed: number | null;
}

const STAGE_TO_TAB: Record<string, Tab> = {
  "": "spin",
  room: "room",
  study: "study",
  parlay: "parlay",
  duel: "duel",
  result: "result",
};

const TAB_TO_STAGE: Partial<Record<Tab, string>> = {
  spin: "",
  room: "room",
  study: "study",
  parlay: "parlay",
  duel: "duel",
  result: "result",
};

const NONE = { lobbyId: null, seed: null } as const;

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const seedRaw = new URLSearchParams(search).get("seed");
  const seed = seedRaw && /^\d+$/.test(seedRaw) ? Number(seedRaw) : null;

  if (parts[0] === "match" && parts[1]) {
    const tab = STAGE_TO_TAB[parts[2] ?? ""];
    if (tab) return { tab, lobbyId: parts[1], seed };
  }
  if (parts[0] === "battles") return { tab: "battles", ...NONE };
  if (parts[0] === "create") return { tab: "create", ...NONE };
  if (parts[0] === "desk") return { tab: "desk", ...NONE };
  if (parts[0] === "ranks") return { tab: "ranks", ...NONE };
  if (parts[0] === "test") return { tab: "test", ...NONE };
  if (parts[0] === "testing") return { tab: "testing", ...NONE };
  if (parts[0] === "arena" || (parts[0] === "room" && parts[1])) {
    return { tab: "arena", ...NONE };
  }
  return { tab: "lobby", ...NONE };
}

export function routePath(tab: Tab, lobbyId: string | null, seed: number | null): string {
  const stage = TAB_TO_STAGE[tab];
  if (stage !== undefined && lobbyId) {
    const q = seed !== null ? `?seed=${seed}` : "";
    return stage ? `/match/${lobbyId}/${stage}${q}` : `/match/${lobbyId}${q}`;
  }
  if (tab === "battles") return "/battles";
  if (tab === "create") return "/create";
  if (tab === "desk") return "/desk";
  if (tab === "ranks") return "/ranks";
  if (tab === "test") return "/test";
  if (tab === "testing") return "/testing";
  if (tab === "arena") return "/arena";
  return "/";
}
