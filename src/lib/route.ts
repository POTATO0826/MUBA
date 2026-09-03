import type { Tab } from "../types.ts";

/**
 * The URL, both ways. There is no router — the app is a `Tab` switch — but a
 * case run wants a shareable address, and the spin wants its seed in it so
 * the same link replays the same legs.
 *
 *   /               the case library
 *   /home           the lobby
 *   /desk           the options desk
 *   /case/:id?seed=N            the spin
 *   /case/:id/parlay?seed=N     the parlay builder
 *   /case/:id/study?seed=N      the case study
 *   /case/:id/tape?seed=N       the tape running
 *   /case/:id/settled?seed=N    the result
 */

export interface Route {
  tab: Tab;
  caseId: string | null;
  seed: number | null;
}

const STAGE_TO_TAB: Record<string, Tab> = {
  "": "spin",
  parlay: "parlay-build",
  study: "study",
  tape: "tape",
  settled: "settled",
};

const TAB_TO_STAGE: Partial<Record<Tab, string>> = {
  spin: "",
  "parlay-build": "parlay",
  study: "study",
  tape: "tape",
  settled: "settled",
};

export function parseRoute(pathname: string, search: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  const seedRaw = new URLSearchParams(search).get("seed");
  const seed = seedRaw && /^\d+$/.test(seedRaw) ? Number(seedRaw) : null;

  if (parts[0] === "case" && parts[1]) {
    const tab = STAGE_TO_TAB[parts[2] ?? ""];
    if (tab) return { tab, caseId: parts[1], seed };
  }
  if (parts[0] === "home") return { tab: "lobby", caseId: null, seed: null };
  if (parts[0] === "desk") return { tab: "desk", caseId: null, seed: null };
  return { tab: "cases", caseId: null, seed: null };
}

export function routePath(tab: Tab, caseId: string | null, seed: number | null): string {
  const stage = TAB_TO_STAGE[tab];
  if (stage !== undefined && caseId) {
    const q = seed !== null ? `?seed=${seed}` : "";
    return stage ? `/case/${caseId}/${stage}${q}` : `/case/${caseId}${q}`;
  }
  if (tab === "lobby") return "/home";
  if (tab === "desk") return "/desk";
  return "/";
}
