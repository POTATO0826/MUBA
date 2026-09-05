import { bookForSectors } from "../src/data/sectors.ts";
import { spinCase, planSpin, STRIP_LEN } from "../src/engine/spin.ts";
const b = bookForSectors(["MAJORS"]);
console.log("mi-majors seed1 (2 legs)", spinCase(b, 2, 1).syms);
console.log("kz seed424242 (3 legs)", spinCase(b, 3, 424242).syms);
const r = spinCase(b, 2, 1);
console.log("plans", r.plans.map(p => ({t: p.target, sym: b[p.target % b.length]})));
