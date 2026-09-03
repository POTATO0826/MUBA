/**
 * The case-opening reel, as arithmetic. The component in
 * `components/CaseSpin.tsx` only animates what this module decides.
 */

/** Tile pitch in px: width plus gap. The strip's transform is computed from it. */
export const TILE_W = 124;
export const TILE_GAP = 8;
export const TILE_PITCH = TILE_W + TILE_GAP;
/** Tiles on the strip. Enough that the reel never runs out before it stops. */
export const STRIP_LEN = 64;

export interface SpinPlan {
  /** Index on the strip the pointer stops on. */
  target: number;
  /** Where inside that tile it stops, -0.35..0.35 of a tile — so landings
   *  don't always sit dead centre. */
  jitter: number;
}

/**
 * Decide where one spin ends before it starts. The target sits in the last
 * quarter of the strip so the reel travels far enough to read as a real spin.
 *
 * Which asset that is falls out of `target % assets.length`, since the strip
 * repeats the list — so the plan needs no knowledge of the asset count.
 */
export function planSpin(random: () => number = Math.random): SpinPlan {
  const lo = Math.floor(STRIP_LEN * 0.72);
  const hi = STRIP_LEN - 2;
  return {
    target: lo + Math.floor(random() * (hi - lo)),
    jitter: (random() - 0.5) * 0.7,
  };
}

/**
 * A small LCG, the same one the tape uses. Given a seed it produces the same
 * sequence every time, on every machine — which is what makes a spin
 * replayable from its URL and, later, swappable for a VRF or commit-reveal
 * output without touching the reel.
 */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A fresh seed. Six digits so it reads cleanly in a URL. */
export function newSeed(random: () => number = Math.random): number {
  return 100000 + Math.floor(random() * 900000);
}

export interface SpinResult {
  seed: number;
  /** One ticker per slot, in the order they landed. */
  syms: readonly string[];
  /** One plan per accepted slot — what the reel animates. */
  plans: readonly SpinPlan[];
  /** Landings thrown away because the ticker was already in a slot. */
  rejected: number;
}

/**
 * Fill every slot of a case from its own book.
 *
 * The pointer resolves once per leg. A landing on a ticker that already holds
 * a slot is rejected and the reel is spun again — the same name never fills
 * two slots. Because the random source is seeded, the rejections are part of
 * the sequence too: the same seed always deals the same legs.
 */
export function spinCase(
  eligible: readonly string[],
  legCount: number,
  seed: number,
): SpinResult {
  if (eligible.length < legCount) {
    throw new Error(
      `case needs ${legCount} distinct legs but its book only has ${eligible.length}`,
    );
  }
  const random = seededRandom(seed);
  const syms: string[] = [];
  const plans: SpinPlan[] = [];
  let rejected = 0;

  // The bound is generous: with `eligible.length >= legCount` a rejection run
  // can't be infinite, but a seeded stream could in principle cycle badly.
  for (let guard = 0; syms.length < legCount && guard < 10_000; guard++) {
    const plan = planSpin(random);
    const sym = eligible[plan.target % eligible.length]!;
    if (syms.includes(sym)) {
      rejected++;
      continue;
    }
    syms.push(sym);
    plans.push(plan);
  }

  if (syms.length < legCount) {
    throw new Error(`seed ${seed} could not fill ${legCount} slots without a duplicate`);
  }
  return { seed, syms, plans, rejected };
}
