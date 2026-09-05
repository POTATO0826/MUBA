import { bookFor, bookForSectors } from "../src/data/sectors.ts";
import { LOBBIES, bookOf } from "../src/data/lobbies.ts";
import { spinCase } from "../src/engine/spin.ts";
console.log("bookFor CRYPTO", bookFor("CRYPTO"));
console.log("MAJORS", bookForSectors(["MAJORS"]));
console.log("MAJORS+MEME", bookForSectors(["MAJORS","MEME"]));
for (const l of LOBBIES) {
  console.log(l.id, l.legs, JSON.stringify(spinCase(bookOf(l), l.legs, 424242).syms));
}
console.log("crypto 3 @424242", spinCase(bookFor("CRYPTO"), 3, 424242).syms);
console.log("crypto 2 @90210", spinCase(bookFor("CRYPTO"), 2, 90210).syms);
