import type { Asset, Leg } from "../types.ts";
import { UNIVERSE, meta } from "../data/universe.ts";
import type { BattleState } from "./battle.ts";

/** The board a match is actually drafted from: the chosen market, minus anything
 *  the admin dropped in the lobby builder. */
export function activeUniverse(s: BattleState): readonly Asset[] {
  return UNIVERSE.filter(
    (u) => (s.market === "MIXED" || u.mkt === s.market) && !s.excluded.includes(u.sym),
  );
}

/**
 * Your slip. Real picks come first; if you have not drafted a full board yet the
 * remaining slots are back-filled from the top of the active universe, so every
 * downstream screen always has `picksMax` legs to render.
 */
export function myLegs(s: BattleState): readonly Leg[] {
  const av = activeUniverse(s);
  const picked = s.picks.slice(0, s.picksMax).filter((sym) => av.some((u) => u.sym === sym));
  const filler = av.map((u) => u.sym).filter((sym) => !picked.includes(sym));
  return [...picked, ...filler].slice(0, s.picksMax).map((sym) => {
    const u = meta(sym);
    return { sym, dir: s.legDir[sym] ?? "over", t: u.t, sector: u.sector };
  });
}

/**
 * The opponent's slip. Same back-fill idea, but it must not collide with your
 * legs or with anything either side banned — and the filler strides by 3 so a
 * default board does not read as "the opponent took the next four alphabetically".
 */
export function oppLegs(s: BattleState): readonly Leg[] {
  const mine = myLegs(s).map((l) => l.sym);
  const banned = [...s.bans, ...s.oppBans];
  const out: Leg[] = [];

  s.oppPicks.slice(0, s.picksMax).forEach((sym, i) => {
    out.push({ sym, dir: s.oppDir[sym] ?? (i % 2 === 0 ? "over" : "under"), t: meta(sym).t });
  });

  const avail = activeUniverse(s).filter(
    (u) => !mine.includes(u.sym) && !banned.includes(u.sym) && !out.some((o) => o.sym === u.sym),
  );
  for (let i = 0; i < avail.length && out.length < s.picksMax; i++) {
    const u = avail[(i * 3 + 1) % avail.length]!;
    if (out.some((o) => o.sym === u.sym)) continue;
    out.push({ sym: u.sym, dir: s.oppDir[u.sym] ?? (i % 2 === 0 ? "over" : "under"), t: u.t });
  }
  return out;
}

/** Symbols charted in the arena: every drafted leg first, then padding up to
 *  `chartCount`. */
export function arena(s: BattleState): readonly string[] {
  const out: string[] = [];
  for (const l of [...myLegs(s), ...oppLegs(s)]) {
    if (!out.includes(l.sym)) out.push(l.sym);
  }
  for (const u of activeUniverse(s)) {
    if (out.length >= s.chartCount) break;
    if (!out.includes(u.sym)) out.push(u.sym);
  }
  return out.slice(0, s.chartCount);
}

/** Study and fight draw different windows on the same tickers. */
export const studySalt = (s: BattleState): number => 1 + s.seed * 3;
export const fightSalt = (s: BattleState): number => 2 + s.seed * 3;

/** Prints per tick, so the whole tape plays in roughly 12s / 8s / 5s. */
export const tapeStep = (s: BattleState): number =>
  s.tapeSpeed === 32 ? 2 : s.tapeSpeed === 128 ? 5 : 3;
