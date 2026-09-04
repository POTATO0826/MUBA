/**
 * The case-opening reel, as arithmetic. The component in
 * `components/CaseSpin.tsx` only animates what this module decides.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE RULE
 * ────────────────────────────────────────────────────────────────────────────
 *
 *   > The spin picks the arena. The player picks the position.
 *
 * The reel may deal anything that is EV-neutral and seed-deterministic. It may
 * never deal anything that sets the odds.
 *
 * | The reel may deal        | The reel may never deal            |
 * |--------------------------|------------------------------------|
 * | an underlying            | a multiplier                       |
 * | an expiry                | a probability                      |
 * | a strike **window**      | a payout                           |
 * | a constraint             | a strike *chosen for* the player   |
 *
 * {@link MarketSlice} is typed in `src/types.ts` and structurally cannot carry
 * any of the right-hand column — that is the guarantee, made by the type rather
 * than by a promise in a comment. What a card inside the arena is worth is read
 * off the book by `engine/parlay.ts`, and if no order backs it, no card is
 * dealt.
 *
 * ## The determinism seam moved; it did not open
 *
 * `test/determinism.test.ts` bans this directory from importing live market
 * sources, and that ban is untouched. Market data reaches {@link spinSlice} as
 * an **argument**. The engine never asks the network what exists, and it never
 * asks the asset gate in `src/data/` either: which assets are playable is a
 * fact about the book, the book is injected, and the caller does the measuring.
 * That second ban is enforced by the same source scan, so this file names the
 * gate by role and never by path.
 */

import type { MarketSlice, PricingRow } from "../types.ts";

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

// ─────────────────────────────────────────────────────────────────────────────
// The market slice — what a spin deals when there is a real book behind it
// ─────────────────────────────────────────────────────────────────────────────

/**
 * An underlying, as a bare string — **never** a hardcoded union.
 *
 * A frozen `"ETH" | "BTC"` literal here is how AVAX ends up excluded on the day
 * a maker finally quotes both sides of it. Thetanuts is an altcoin options
 * protocol; any type that pins the universe to the two assets with MM pricing
 * has mistaken one quote source for the whole market (plan6 §7).
 */
export type Underlying = string;

/**
 * The book, per underlying — exactly the shape `MarketSnapshot.pricing` already
 * has, so the caller passes what it already holds and no adapter exists to
 * drift.
 *
 * A flat `PricingRow[]` cannot answer this function's first question. A
 * `PricingRow` carries a strike, an expiry and an order but **no underlying**
 * (see `src/types.ts`), so a flat array leaves the engine unable to say which
 * rows belong to the name it just dealt — and the only way to recover that
 * would be to resolve Chainlink feed addresses in here, which is exactly the
 * network knowledge this module exists in order not to have.
 */
export type SliceBook = Readonly<Record<Underlying, readonly PricingRow[]>>;

/**
 * How much of an underlying's listed strike ladder a window spans.
 *
 * Wide on purpose. The window is the arena, and an arena narrow enough to hold
 * one tradeable strike is a strike chosen for the player wearing a window's
 * clothes. At 0.6 the player always has a ladder to walk, both stances stay
 * expressible, and the reel still makes two rounds on the same asset feel like
 * different rooms.
 */
export const STRIKE_WINDOW_FRACTION = 0.6;

/** No window is ever narrower than this many listed strikes — unless the book
 *  itself lists fewer, in which case the window is the whole ladder. */
export const MIN_WINDOW_STRIKES = 3;

/** How often a round is dealt with no constraint at all. Half: a constraint
 *  should read as an event, not as the weather. */
export const NO_CONSTRAINT_ODDS = 0.5;

/** The constraints the reel may deal. Each narrows what a player may build and
 *  none of them touches what anything is worth — the book prices whatever
 *  survives the narrowing, exactly as it priced it before. */
export const CONSTRAINTS = ["BUDGET_5", "CALLS_ONLY", "MAX_3_LEGS", "PUTS_ONLY"] as const;
export type SliceConstraint = (typeof CONSTRAINTS)[number];

/** One row reduced to the three facts a slice is built out of. */
interface Dealable {
  side: "CALL" | "PUT";
  /** 8dp strike, as the integer the order itself carries. */
  strike: bigint;
  /** The **option** expiry, unix seconds — not the signature's expiry. */
  expiry: number;
}

/**
 * A row the reel is allowed to build an arena around, or `null`.
 *
 * Mirrors `cardsForSlice`'s own filters deliberately: a slice whose window
 * contains rows that could never become cards is an arena with nothing in it,
 * and the player finds that out after the reel has already stopped.
 *
 *  - a fillable `order` — you cannot buy from a bid, and a row quoted by market
 *    makers alone has nothing a player can press
 *  - exactly one strike — two is a spread, which has no single line to bet on
 *  - a plain vanilla side — `structure` absent (the seeded table predates the
 *    field) or equal to `type`
 *  - a positive option expiry
 */
function dealableOf(row: PricingRow): Dealable | null {
  if (row.type !== "CALL" && row.type !== "PUT") return null;
  if (row.structure !== undefined && row.structure !== row.type) return null;
  const order = row.order;
  if (!order) return null;
  const strikes = order.rawApiData?.strikes;
  if (!strikes || strikes.length !== 1) return null;
  let strike: bigint;
  try {
    strike = BigInt(strikes[0]!);
  } catch {
    return null;
  }
  const raw = order.order?.expiry;
  if (raw === undefined) return null;
  const expiry = Number(raw);
  if (!Number.isFinite(expiry) || expiry <= 0) return null;
  return { side: row.type, strike, expiry };
}

/** `arr[floor(r * len)]`, with the top of the range folded back in. `random()`
 *  is documented `[0,1)`, but a source that ever returned exactly 1 would index
 *  off the end, and a reel that throws once in four billion spins is a bug
 *  nobody can reproduce. */
function pick<T>(arr: readonly T[], r: number): T {
  return arr[Math.min(arr.length - 1, Math.floor(r * arr.length))]!;
}

/** Ascending, on bigints — `Array.prototype.sort`'s default is lexicographic
 *  over strings, which orders 8dp strikes by their leading digit. */
function ascending(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Deal one arena: an underlying, an expiry, a strike window, and sometimes a
 * constraint.
 *
 * ## What it is allowed to look at
 *
 * `qualified` is the caller's answer to "which assets can be played today",
 * measured by the asset gate against the live book. This function deals ONLY
 * from that list: it never widens it, never has an opinion about what belongs
 * on it, and holds no list of its own. `book` is the same snapshot's rows. Both
 * are arguments. Nothing in this module imports a market.
 *
 * ## What the seed decides, in this order
 *
 * Four draws off `seededRandom(seed)`, always taken and always in this order,
 * so adding a fifth later cannot silently re-deal the first four:
 *
 *   1. the underlying — from `qualified`, in the caller's order, narrowed to
 *      the names this book can actually build an arena on
 *   2. the expiry — one of that underlying's live option expiries, ascending
 *   3. the window offset — where a {@link STRIKE_WINDOW_FRACTION}-wide run of
 *      listed strikes starts on the ladder
 *   4. the constraint — {@link NO_CONSTRAINT_ODDS} of the time, none
 *
 * Every one of those is EV-neutral. None of them is a price, and none of them
 * is a single strike: the window always spans the whole ladder or at least
 * {@link MIN_WINDOW_STRIKES} of it, so the player is choosing a line and the
 * reel is choosing a room.
 *
 * ## Same seed, same slice — and what "same" means across two books
 *
 * The draws are *ordinal*: the seed picks an index and the book decides what
 * sits at it. So the same seed against the same book is byte-identical, and the
 * same seed against a **different** book of the same shape deals the same arena
 * in the same position with different prices behind it. That second half is the
 * whole design, and `test/determinism.test.ts` asserts both.
 *
 * @returns `null` when no qualified underlying has a book to build an arena on
 *   — offline, a dead market route, or a day the gate rejects everything. A
 *   `null` arena is a true statement and the seeded board still plays;
 *   inventing one would be the house dealing a market that is not there.
 */
export function spinSlice(
  book: SliceBook,
  qualified: readonly Underlying[],
  seed: number,
): MarketSlice | null {
  // Index the book once, in the caller's qualified order. An underlying with no
  // dealable row is dropped here rather than dealt and then apologised for.
  const pool: { underlying: string; rows: readonly Dealable[] }[] = [];
  for (const underlying of qualified) {
    const rows = (book[underlying] ?? [])
      .map(dealableOf)
      .filter((d): d is Dealable => d !== null);
    if (rows.length > 0) pool.push({ underlying, rows });
  }
  if (pool.length === 0) return null;

  const random = seededRandom(seed);

  // 1 — the underlying.
  const dealt = pick(pool, random());

  // 2 — the expiry. Ascending, so the index the seed picks means the same thing
  //     ("the front expiry", "the one behind it") from one book to the next.
  const expiries = [...new Set(dealt.rows.map((d) => d.expiry))].sort((a, b) => a - b);
  const expiry = pick(expiries, random());

  // 3 — the window: a contiguous run across the distinct strikes listed at that
  //     expiry. Below the floor there is no run to choose and the window is the
  //     whole ladder, which is still a window and never a single line.
  const atExpiry = dealt.rows.filter((d) => d.expiry === expiry);
  const strikes = [...new Set(atExpiry.map((d) => d.strike))].sort(ascending);
  const offsetRoll = random();
  let lo = strikes[0]!;
  let hi = strikes[strikes.length - 1]!;
  if (strikes.length > MIN_WINDOW_STRIKES) {
    const span = Math.max(MIN_WINDOW_STRIKES, Math.ceil(strikes.length * STRIKE_WINDOW_FRACTION));
    const slots = strikes.length - span + 1;
    const offset = Math.min(slots - 1, Math.floor(offsetRoll * slots));
    lo = strikes[offset]!;
    hi = strikes[offset + span - 1]!;
  }

  // 4 — the constraint. A directional one is only offered when that side is
  //     actually quoted inside the window: PUTS_ONLY over a window with no put
  //     is a round with no cards in it, which is the reel deciding the outcome
  //     by omission. Both draws are always taken, whichever branch wins.
  const inWindow = atExpiry.filter((d) => d.strike >= lo && d.strike <= hi);
  const offered: SliceConstraint[] = ["BUDGET_5", "MAX_3_LEGS"];
  if (inWindow.some((d) => d.side === "CALL")) offered.push("CALLS_ONLY");
  if (inWindow.some((d) => d.side === "PUT")) offered.push("PUTS_ONLY");
  offered.sort();
  const constraintRoll = random();
  const constraintPick = pick(offered, random());
  const constraint = constraintRoll < NO_CONSTRAINT_ODDS ? undefined : constraintPick;

  const slice: MarketSlice = {
    underlying: dealt.underlying,
    expiry,
    strikeLo: lo.toString(),
    strikeHi: hi.toString(),
  };
  // Omitted rather than set to `undefined`, so a slice with no constraint is
  // deep-equal to one written out by hand — the replay tests compare whole
  // objects, and `{ constraint: undefined }` is not `{}` to `toEqual`.
  return constraint === undefined ? slice : { ...slice, constraint };
}
