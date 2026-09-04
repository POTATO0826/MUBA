import { useCallback, useSyncExternalStore } from "react";
import { TIERS, tierFor, type RankTier, type TierName } from "../data/rewards.ts";

/**
 * Card detail level — plan 6 §6 (Phase E).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE ARGUMENT (§E2): RANK SETS THE OPENING DEFAULT, IT NEVER GATES
 * ────────────────────────────────────────────────────────────────────────────
 * The season ladder is `MINNOW → FISH → SHARK → ORCA → WHALE`. It is a wealth
 * metaphor: it measures **size, not knowledge**. So hanging the word "delta"
 * off it gets both directions wrong at once — an options trader who arrives at
 * MINNOW is marched through a tutorial he wrote, and a lucky player who spikes
 * to SHARK is handed greeks he cannot read. Neither is a skill signal, so
 * neither is a permission.
 *
 * No venue anyone actually trades on does this. Deribit, TradingView and IBKR
 * all let the user pick display density directly, on the surface, in one press.
 * So this module offers exactly that: the tier picks the **opening** default,
 * the player may change it at any time in either direction, and the choice
 * persists and outranks the default from then on — including across a rank-up,
 * because a rank-up is not new information about what someone can read.
 *
 * Nothing here is ever locked. There is no `unlocked`, no `minTier`, no
 * `canSee`. If a future caller wants one, the answer is that §E2 is the reason
 * this file exists.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE LADDER (§E1)
 * ────────────────────────────────────────────────────────────────────────────
 * The five tier names and their XP thresholds live in `src/data/rewards.ts`
 * and are imported, never restated. `DETAIL_DEFAULTS` is keyed by `TierName`,
 * so renaming or adding a tier over there is a **compile error** here rather
 * than a silently-missing default; and no XP number appears anywhere in this
 * file, because `tierFor` already owns that arithmetic.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The level
// ─────────────────────────────────────────────────────────────────────────────

export type CardDetail = "SIMPLE" | "STANDARD" | "FULL";

/** The three levels, thinnest first. Also the toggle's left-to-right order. */
export const CARD_DETAILS = ["SIMPLE", "STANDARD", "FULL"] as const;

/** How far up the density ramp a level sits. `SIMPLE` is 0. */
export const detailRank = (level: CardDetail): number => CARD_DETAILS.indexOf(level);

/**
 * The opening default per tier (§E2).
 *
 * Keyed by `TierName` — the type derived from `TIERS` — so this record is
 * exhaustive over the real ladder by construction and cannot drift from it.
 */
export const DETAIL_DEFAULTS: Record<TierName, CardDetail> = {
  MINNOW: "SIMPLE",
  FISH: "SIMPLE",
  SHARK: "STANDARD",
  ORCA: "FULL",
  WHALE: "FULL",
};

/**
 * The level a player *starts* at, given their tier.
 *
 * This is a default and only a default. `useCardDetail` consults it only while
 * the player has never touched the toggle.
 */
export function defaultDetail(tier: RankTier): CardDetail {
  return DETAIL_DEFAULTS[tier.name];
}

/** The same, from a season XP total — `tierFor` owns the thresholds. */
export function defaultDetailForXp(xp: number): CardDetail {
  return defaultDetail(tierFor(xp));
}

// ─────────────────────────────────────────────────────────────────────────────
// The level contract (§E3) — the single source of truth for what a card shows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every quantity a parlay card may put on its face.
 *
 * These are *quantities*, not labels. §E4.1 is that a quantity has exactly one
 * word for the whole life of the app: SIMPLE's "70% chance" **is** delta,
 * STANDARD does not rename it, and FULL only reveals that it was always called
 * delta. So the phrasing varies by level and the `term` never does.
 */
export type CardQuantity =
  | "direction"
  | "maxLoss"
  | "payout"
  | "strike"
  | "delta"
  | "itmOtm"
  | "breakeven"
  | "payoffCurve"
  | "theta"
  | "iv"
  | "premium";

export interface QuantitySpec {
  /**
   * The **one** word for this quantity, forever (§E4.1). Two words is two
   * things to unlearn. Prose, tooltips, help text and voice-over all use this
   * word; nothing gets to invent a synonym at a different level.
   */
  term: string;
  /** The level at which it first reaches the face. It never leaves above that. */
  from: CardDetail;
  /**
   * Exactly how it reads on the card at each level, `null` before it appears.
   * A builder implements the face from this column and nothing else.
   */
  face: Record<CardDetail, string | null>;
}

/**
 * The vertical order of the card face, top to bottom.
 *
 * `maxLoss` sits above `payout` and that is **structural, not stylistic**
 * (§E4.2 / §A7): the downside is read before the upside at every level, and a
 * test asserts this ordering rather than trusting a comment.
 */
export const CARD_FACE_ORDER = [
  "direction",
  "maxLoss",
  "payout",
  "strike",
  "delta",
  "itmOtm",
  "breakeven",
  "payoffCurve",
  "theta",
  "iv",
  "premium",
] as const satisfies readonly CardQuantity[];

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE CONTRACT (§E3), as a table a builder can implement without re-reading
 * the plan. Cumulative: each level is the level below it, plus more.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * | quantity      | term        | SIMPLE          | STANDARD         | FULL              |
 * |---------------|-------------|-----------------|------------------|-------------------|
 * | direction     | direction   | `LONG` / `SHORT`| `LONG` / `SHORT` | `LONG` / `SHORT`  |
 * | **maxLoss**   | max loss    | `MAX LOSS $40`  | `MAX LOSS $40`   | `MAX LOSS $40`    |
 * | payout        | payout      | `WIN $160`      | `WIN $160`       | `WIN $160`        |
 * | strike        | strike      | —               | `$4,200 strike`  | `$4,200 strike`   |
 * | delta         | delta       | —               | `70% chance`     | `Δ 0.70`          |
 * | itmOtm        | ITM/OTM/ATM | —               | `OTM`            | `OTM`             |
 * | breakeven     | breakeven   | —               | —                | `B/E $4,340`      |
 * | payoffCurve   | payoff curve| —               | —                | the curve         |
 * | theta         | theta       | —               | —                | `θ −0.4`          |
 * | iv            | IV          | —               | —                | `IV 58%`          |
 * | premium       | premium     | —               | —                | `$18 premium`     |
 *
 * Notes a builder needs and the table cannot carry:
 *
 *  - **maxLoss is not a detail level.** It is on the face at SIMPLE and never
 *    leaves, at every level, above the upside figure. It is deliberately the
 *    only row that is bold in the table above.
 *  - **delta is one quantity with two renderings.** `70% chance` at STANDARD
 *    and `Δ 0.70` at FULL are the same number wearing the same name; the FULL
 *    face may print the glyph, but any words about it say "delta".
 *  - **`Δ 0.70 · θ −0.4 · IV 58%` is one line.** `delta`, `theta` and `iv` are
 *    three quantities so the contract can name them separately, but the face
 *    renders them as a single greeks strip in that order.
 *  - **Vocabulary (§E5).** `ITM` / `OTM` / `ATM`, never the textbook word for
 *    them — almost nobody says it out loud. `IV`, never spelled out: on crypto
 *    options venues the abbreviation *is* the word. `delta`, `strike`,
 *    `premium`, `breakeven`, `theta` are already what traders say — verbatim.
 *    `test/detail.test.ts` greps the card components for the two banned forms
 *    and fails on either.
 *  - **Build mode** (two cards on one asset → a spread) unlocks at FULL and
 *    stops at two legs, because `calculatePayout` stops at two legs.
 */
export const CARD_CONTRACT: Record<CardQuantity, QuantitySpec> = {
  direction: {
    term: "direction",
    from: "SIMPLE",
    face: { SIMPLE: "LONG / SHORT", STANDARD: "LONG / SHORT", FULL: "LONG / SHORT" },
  },
  maxLoss: {
    // §E4.2. Appears at SIMPLE, never leaves, always above `payout`.
    term: "max loss",
    from: "SIMPLE",
    face: { SIMPLE: "MAX LOSS $40", STANDARD: "MAX LOSS $40", FULL: "MAX LOSS $40" },
  },
  payout: {
    term: "payout",
    from: "SIMPLE",
    face: { SIMPLE: "WIN $160", STANDARD: "WIN $160", FULL: "WIN $160" },
  },
  strike: {
    term: "strike",
    from: "STANDARD",
    face: { SIMPLE: null, STANDARD: "$4,200 strike", FULL: "$4,200 strike" },
  },
  delta: {
    // §E4.1. One quantity, one term, two renderings.
    term: "delta",
    from: "STANDARD",
    face: { SIMPLE: null, STANDARD: "70% chance", FULL: "Δ 0.70" },
  },
  itmOtm: {
    // §E5. The term is the abbreviation set itself; the textbook noun is banned.
    term: "ITM/OTM/ATM",
    from: "STANDARD",
    face: { SIMPLE: null, STANDARD: "OTM", FULL: "OTM" },
  },
  breakeven: {
    term: "breakeven",
    from: "FULL",
    face: { SIMPLE: null, STANDARD: null, FULL: "B/E $4,340" },
  },
  payoffCurve: {
    term: "payoff curve",
    from: "FULL",
    // The only entry that is a drawing rather than a string. It is in the
    // contract so `quantitiesAt("FULL")` includes it and the face knows where
    // in the vertical order it goes.
    face: { SIMPLE: null, STANDARD: null, FULL: "payoff curve (drawn)" },
  },
  theta: {
    term: "theta",
    from: "FULL",
    face: { SIMPLE: null, STANDARD: null, FULL: "θ −0.4" },
  },
  iv: {
    // §E5. `IV`, never spelled out.
    term: "IV",
    from: "FULL",
    face: { SIMPLE: null, STANDARD: null, FULL: "IV 58%" },
  },
  premium: {
    term: "premium",
    from: "FULL",
    face: { SIMPLE: null, STANDARD: null, FULL: "$18 premium" },
  },
};

/**
 * What the face shows at `level`, in render order, top to bottom.
 *
 * The card work reads this rather than branching on the level itself — that is
 * what makes "max loss is above the upside figure at every level" a property of
 * the contract and not of whoever wrote the JSX.
 */
export function quantitiesAt(level: CardDetail): readonly CardQuantity[] {
  return CARD_FACE_ORDER.filter((q) => CARD_CONTRACT[q].face[level] !== null);
}

/** The one word for a quantity. Never level-dependent — that is the point. */
export const termFor = (q: CardQuantity): string => CARD_CONTRACT[q].term;

// ─────────────────────────────────────────────────────────────────────────────
// The preference, stored
// ─────────────────────────────────────────────────────────────────────────────

const KEY = "thetaduel.cardDetail";

/**
 * `null` means **never chosen** — not "SIMPLE".
 *
 * The distinction is the whole of §E2. While the store is `null` the rank
 * default applies and keeps applying as the player climbs; the first press of
 * the toggle pins a choice that then outranks the ladder in both directions,
 * forever.
 */
export type StoredDetail = CardDetail | null;

/**
 * Parse a stored value. Anything unrecognised is "never chosen", so a value
 * from a future build — or a half-written one — degrades to the rank default
 * rather than to a wrong level.
 */
export function parseDetail(raw: string | null): StoredDetail {
  if (!raw) return null;
  return (CARD_DETAILS as readonly string[]).includes(raw) ? (raw as CardDetail) : null;
}

/**
 * Storage is advisory, in both directions.
 *
 * Safari's private mode throws on `getItem`, a hardened browser can have no
 * `localStorage` at all, and a full quota throws on `setItem`. None of that is
 * an error worth surfacing: a display preference that cannot be remembered is
 * a preference that lasts the session. **The app must never fail to render
 * because a preference could not be read**, so both halves swallow and the
 * reader falls back to the rank default.
 */
function readStore(): StoredDetail {
  try {
    return parseDetail(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    return null;
  }
}

function writeStore(level: StoredDetail): void {
  try {
    if (level === null) globalThis.localStorage?.removeItem(KEY);
    else globalThis.localStorage?.setItem(KEY, level);
  } catch {
    // No storage. The choice still holds for this session; it simply does not
    // survive the tab.
  }
}

/** Memoised so a render is never a storage read. `undefined` = not yet read. */
let chosen: StoredDetail | undefined;
const listeners = new Set<() => void>();

/** The stored choice, or `null` if the toggle has never been pressed. */
export function getStoredDetail(): StoredDetail {
  if (chosen === undefined) chosen = readStore();
  return chosen;
}

/**
 * Pin a level. Passing `null` hands the player back to the rank default —
 * which is also what makes the setter genuinely two-directional.
 */
export function setStoredDetail(level: StoredDetail): void {
  chosen = level;
  writeStore(level);
  for (const fn of listeners) fn();
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribeDetail(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Drop the in-process memo so the next read hits storage again.
 *
 * Test seam, and the only honest way to simulate a reload in-process: a real
 * reload re-reads `localStorage`, and so does this.
 */
export function forgetDetailMemo(): void {
  chosen = undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// The hook
// ─────────────────────────────────────────────────────────────────────────────

export interface CardDetailState {
  /** The level in force now: the player's choice if they made one, else the
   *  tier's opening default. */
  level: CardDetail;
  /** Change it, in either direction, from any tier. Never refused. */
  setLevel: (next: CardDetail) => void;
  /** The tier's opening default, for the toggle's "back to default" affordance
   *  and for copy that wants to name it. */
  fallback: CardDetail;
  /** False until the player presses the toggle; true forever after. While it
   *  is false the level tracks the ladder as the player climbs. */
  chosen: boolean;
  /** Unpin, handing the level back to the ladder. */
  clear: () => void;
}

/**
 * The card detail preference, as a hook.
 *
 * Backed by a module-level store rather than component state — the same shape
 * `SoundToggle` uses — because the toggle and the cards it governs are not in
 * one subtree, and threading a level prop through every screen that renders a
 * card would be the kind of prop drilling that ends in two of them disagreeing.
 *
 * `tier` is the player's *current* tier, which the caller already has from
 * `useRankProgress`/`rankAt`. It is read only when nothing has been chosen.
 */
export function useCardDetail(tier: RankTier): CardDetailState {
  const stored = useSyncExternalStore(subscribeDetail, getStoredDetail, () => null);
  const fallback = defaultDetail(tier);

  const setLevel = useCallback((next: CardDetail) => setStoredDetail(next), []);
  const clear = useCallback(() => setStoredDetail(null), []);

  return {
    level: stored ?? fallback,
    setLevel,
    fallback,
    chosen: stored !== null,
    clear,
  };
}

/** The same, for a caller that holds season XP rather than a tier object. */
export function useCardDetailForXp(xp: number): CardDetailState {
  return useCardDetail(tierFor(xp));
}

/**
 * The ladder this module knows, re-exported for the test that asserts there is
 * only one. Not for rendering — a view that needs tier names reads `rewards.ts`.
 */
export const DETAIL_LADDER = TIERS.map((t) => t.name);
