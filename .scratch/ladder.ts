import { LEADERBOARD, rankedBy } from "../src/data/leaderboard.ts";
import { SECTOR_ORDER } from "../src/data/sectors.ts";
import { MODE_ORDER } from "../src/data/modes.ts";
for (const s of SECTOR_ORDER) {
  for (const m of MODE_ORDER) {
    console.log(s, m, rankedBy(LEADERBOARD, "SECTOR_MODE", { sectors: [s], modes: [m] }).length);
  }
  console.log(s, "ALL", rankedBy(LEADERBOARD, "SECTOR_MODE", { sectors: [s], modes: [] }).length);
}
console.log("both", rankedBy(LEADERBOARD, "SECTOR_MODE", { sectors: [...SECTOR_ORDER], modes: [] }).length);
console.log("both+BLITZ", rankedBy(LEADERBOARD, "SECTOR_MODE", { sectors: [...SECTOR_ORDER], modes: ["BLITZ"] }).length);
