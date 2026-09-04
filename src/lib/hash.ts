/**
 * A small string hash, so an id becomes a seed. FNV-1a, then murmur3's final
 * mix: FNV alone leaves its low bits weak, and on ids sharing a suffix a plain
 * `% 8` handed several lobbies the same pattern. The mix spreads every input
 * bit across the word, so the remainder is fair.
 *
 * Lifted verbatim from `components/CardArt.tsx`, which owned it first. It lives
 * here because three surfaces now seed off the same function — CardArt's
 * generative lobby art, the leaderboard's persona generator, and news item ids
 * — and all three must agree: the same string has to yield the same number in
 * every one of them, forever. Do not "improve" the algorithm; changing a bit
 * repaints every card and reshuffles every persona.
 */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
