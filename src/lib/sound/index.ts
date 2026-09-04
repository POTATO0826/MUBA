/**
 * The sound module's whole public surface. Views import from here and nowhere
 * else — `engine.ts`, `map.ts`, `voices.ts` and `budget.ts` are internals, and
 * `SfxName` is derived from the event table so adding a sound is adding one
 * key in `map.ts`.
 */

export {
  __setTestSink,
  audioAvailable,
  isSoundOn,
  setPalette,
  setSoundOn,
  sfx,
  startAmbience,
  startRiser,
  startTrack,
  stopAmbience,
  stopRiser,
  stopTrack,
  subscribeSound,
} from "./engine.ts";

export { useCountUp, useSfxClick, useSoundEnabled, useSoundHover, useSoundUnlock } from "./react.ts";

// Pure helpers callers need at the call site: the reel's tick is parameterised
// by the measured gap between tile crossings, and the duel's combo ladder by
// the current streak. They live in `budget.ts`, which no view may import.
export { comboPitch, diffWon, tickParams } from "./budget.ts";

export type { Tier } from "./budget.ts";
export type { Palette, SfxName, SfxOpts } from "./map.ts";
