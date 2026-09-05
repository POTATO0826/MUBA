import { LOBBIES, bookOf } from "../src/data/lobbies.ts";
import { MODES, MODE_SALT } from "../src/data/modes.ts";
import { PARLAY_CARDS, cardById, legForCard } from "../src/engine/parlay.ts";
import { settle } from "../src/engine/match.ts";
import { spinCase, seededRandom } from "../src/engine/spin.ts";
const LOBBY = LOBBIES.find(l => l.id === "kz-semis")!;
const SEED = 424242;
const arena = spinCase(bookOf(LOBBY), LOBBY.legs, SEED).syms;
console.log("arena", arena);
function meWins(picks: Record<string,string>): boolean {
  const spec = MODES[LOBBY.mode];
  const oppRandom = seededRandom(SEED ^ 0x5bd1e995);
  const oppPicks: Record<string, any> = {};
  for (const sym of arena) oppPicks[sym] = PARLAY_CARDS[Math.floor(oppRandom() * PARLAY_CARDS.length)]!;
  const myLegs = arena.map(s => legForCard(s, cardById(picks[s]!)!, spec.targetScale));
  const oppLegs = arena.map(s => legForCard(s, oppPicks[s]!, spec.targetScale));
  const fightSalt = 2 + SEED * 3 + MODE_SALT[spec.key];
  return settle(myLegs, oppLegs, arena, fightSalt, spec.settleAt, "You", "Opponent").meWins;
}
const ids = PARLAY_CARDS.map(c => c.id);
console.log("card ids", ids);
// find a pair differing in exactly one leg
const base = ["safe-bull","safe-bear"];
for (const a0 of ids) for (const a1 of ids) for (const a2 of ids) {
  const p = { [arena[0]!]: a0, [arena[1]!]: a1, [arena[2]!]: a2 };
  if (!meWins(p)) continue;
  for (const alt of ids) {
    if (alt === a0) continue;
    const q = { ...p, [arena[0]!]: alt };
    if (!meWins(q)) { console.log("WIN", JSON.stringify(p), "LOSE", JSON.stringify(q)); process.exit(0); }
  }
}
console.log("none found");
