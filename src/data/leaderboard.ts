import type { Mode, SectorKey } from "../types.ts";
import { C } from "../theme.ts";
import { hash } from "../lib/hash.ts";
import { seededRandom } from "../engine/spin.ts";
import { COPY_FEE, DIVISIONS, type RankTier } from "./rewards.ts";
import { RANK_TIERS, type RankPoint, WHALE_BAND, rankAt } from "../engine/rank.ts";
import { MODE_ORDER, MODES } from "./modes.ts";
import { SECTORS, SECTOR_ORDER } from "./sectors.ts";
import { OPPONENTS } from "./lobbies.ts";
import { SETTLED_CASES } from "./fixtures.ts";

/**
 * The ladder — one latent variable per player (plan 4 §6).
 *
 * Every number a persona shows is a function of a single seeded `skill` scalar
 * plus seeded quirks, so the four filter lists overlap plausibly instead of
 * contradicting each other. There is no "WHALE with a 41% win rate" here, and
 * there cannot be: XP, win rate, copiers, earnings and the trend line all read
 * from the same scalar. A filtered ladder RE-RANKS the same player objects; it
 * never invents a player and never invents a number.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DETERMINISM — THE DRAW ORDER IS THE CONTRACT
 * ────────────────────────────────────────────────────────────────────────────
 * `seededRandom` is a bare LCG: a stream, not a map. The value a draw returns
 * depends entirely on how many draws came before it. So the ORDER of the calls
 * below is load-bearing — inserting a draw anywhere reshuffles every persona
 * downstream of it, and re-orders the whole ladder. Add new draws only at the
 * END of a stream, never in the middle.
 *
 * `build(persona)` opens ONE stream, `seededRandom(hash(id))`, and draws in
 * exactly this order:
 *
 *   1  skill          the latent. 0.34 + r*0.52  →  0.34 … 0.86
 *   2  battles        40 + ⌊r*260⌋
 *   3  winRate noise  (r − 0.5) * 0.04           →  ±2%
 *   4  xp spread      0.8 + r*0.4
 *   5  primary sector index into SECTOR_ORDER
 *   6  primary mode   index into MODE_ORDER
 *   7…12  sectorShare — one draw per key, in SECTOR_ORDER
 *   13…15 modeShare   — one draw per key, in MODE_ORDER
 *   16…23 trend       — 8 points
 *
 * `copyEconomicsFor(id, xp)` opens its OWN stream from the SAME seed and draws:
 *
 *   1  skill          IDENTICAL to build()'s draw 1, by construction
 *   2  copier jitter  0.75 + r*0.5
 *   3  tx per day     2 + ⌊r*5⌋
 *
 * That shared first draw is the whole point: the Result panel calls
 * `copyEconomicsFor("lexa", xp)` knowing only an id and an XP total, and gets
 * the same `avgTicket` — and therefore the same $/DAY — that lexa's ladder
 * row prints. Two surfaces, one number, no plumbing. Never insert a draw
 * before `skill` in either stream.
 */

// ── The roster ──────────────────────────────────────────────────────────────

/** A ladder persona before any stats exist: identity only. */
export interface Persona {
  /** URL-safe key, and the ONLY seed input. Changing it re-rolls the player. */
  id: string;
  name: string;
  /** Two-letter avatar text. `Player.initial` upstream; plural here because
   *  the ladder row renders it as a word, not a single glyph. */
  initials: string;
  bg: string;
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * The union of every persona the app already shows, deduped by name:
 * `OPPONENTS` (the eight lobby hosts) plus the five extra faces that only
 * appear in the settled-cases marquee (tonoi, saph.base, vane, jpx, 0xsilo).
 * Thirteen in all.
 *
 * Built from those two arrays rather than typed out, so the ladder can never
 * drift from the rest of the app: add a host and they join the ladder with a
 * coherent stat line for free.
 */
export const PERSONAS: readonly Persona[] = (() => {
  const out: Persona[] = [];
  const seen = new Set<string>();
  const add = (name: string, initials: string, bg: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    out.push({ id: slug(name), name, initials, bg });
  };
  for (const o of OPPONENTS) add(o.name, o.initial, o.bg);
  for (const s of SETTLED_CASES) add(s.who, s.initial, s.bg);
  return out;
})();

// ── Copy-trade economics (plan 4 §2.3) ──────────────────────────────────────

/**
 * What a trader earns from the people copying them.
 *
 * Pure in `(id, xp)` so it can move on-chain later as a contract read with no
 * view change, and so the Result panel and the ladder's COPY HEAT column are
 * arithmetically incapable of disagreeing.
 */
export interface CopyEconomics {
  /** The tier allows copy-trading at all. SHARK and above. */
  unlocked: boolean;
  /** Followers. 0 while locked; never falls as XP rises. */
  copiers: number;
  txPerCopierPerDay: number;
  /** Average size of a copied transaction, in the desk's dollars — see the
   *  currency note above `CopyProfile`. Never a PTS figure, never converted
   *  from one. */
  avgTicket: number;
  /** `COPY_FEE` — 3.5%, the literal the panel prints. */
  feePct: number;
  /** Fee earned on one copied transaction. */
  perTx: number;
  /** `copiers · txPerCopierPerDay · avgTicket · feePct`. */
  daily: number;
  weekly: number;
  monthly: number;
  /** The next tier at which the copier count steps up, or null at WHALE. */
  nextUnlock: { tier: RankTier; xpAway: number; copiersAt: number } | null;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/** The XP width of a whole tier band. WHALE gets `WHALE_BAND`, the synthetic
 *  one `engine/rank.ts` already defines — never a second literal here. */
function tierSpan(i: number): number {
  const cur = RANK_TIERS[i];
  const next = RANK_TIERS[i + 1];
  if (!cur) return WHALE_BAND;
  return next ? next.xp - cur.xp : WHALE_BAND;
}

/** The first tier above `i` whose `copierBase` is actually higher — the next
 *  tier where the copier number moves. MINNOW and FISH both sit at 0, so the
 *  answer for either is SHARK, which is exactly what the locked panel says
 *  ("UNLOCK COPY-TRADE AT SHARK"). */
function nextStepUp(i: number): { tier: RankTier; index: number } | null {
  const base = RANK_TIERS[i]?.copierBase ?? 0;
  for (let k = i + 1; k < RANK_TIERS.length; k++) {
    const t = RANK_TIERS[k];
    if (t && t.copierBase > base) return { tier: t, index: k };
  }
  return null;
}

/** Copier count at a given tier, jitter and progress. Factored out so the
 *  current count and `nextUnlock.copiersAt` can never use different maths. */
const copiersAt = (base: number, jitter: number, progress: number): number =>
  Math.round(base * (0.75 + 0.5 * jitter) * (0.85 + 0.3 * progress));

/**
 * Copy-trade economics for a player at an XP total.
 *
 * MONOTONE IN XP, by construction — the headline number must never go DOWN
 * after a win, or the rank moment lies. Two cases:
 *
 *   within a tier   `progress` runs 0 → 1, so the factor runs 0.85 → 1.15.
 *   across a tier   the ceiling of the lower band is `base·1.15`, the floor of
 *                   the higher band is `nextBase·0.85`. Every step clears it:
 *                   FISH→SHARK 0 → 40·0.85, SHARK→ORCA 40·1.15=46 → 160·0.85=136,
 *                   ORCA→WHALE 160·1.15=184 → 520·0.85=442.
 *
 * The jitter cancels — it is the same draw on both sides of a crossing — so the
 * comparison above holds for every id, not just on average.
 */
export function copyEconomicsFor(id: string, xp: number): CopyEconomics {
  const r = seededRandom(hash(id));
  const skill = 0.34 + r() * 0.52; // draw 1 — MUST match build()'s draw 1
  const jitter = r(); // draw 2
  const txDraw = r(); // draw 3

  const point = rankAt(xp);
  const i = point.tierIndex;
  const tier = point.tier;
  const progress = clamp01((Math.max(0, xp) - tier.xp) / tierSpan(i));

  const unlocked = tier.copyUnlocked;
  const copiers = unlocked ? copiersAt(tier.copierBase, jitter, progress) : 0;
  const avgTicket = 400 + Math.round(2600 * skill);
  const txPerCopierPerDay = 2 + Math.floor(txDraw * 5);
  const perTx = avgTicket * COPY_FEE;
  const daily = copiers * txPerCopierPerDay * avgTicket * COPY_FEE;

  const step = nextStepUp(i);
  return {
    unlocked,
    copiers,
    txPerCopierPerDay,
    avgTicket,
    feePct: COPY_FEE,
    perTx,
    daily,
    weekly: daily * 7,
    monthly: daily * 30,
    nextUnlock: step
      ? {
          tier: step.tier,
          xpAway: Math.max(0, step.tier.xp - Math.max(0, xp)),
          // At the new tier's floor: progress 0, so the 0.85 end of the band.
          copiersAt: copiersAt(step.tier.copierBase, jitter, 0),
        }
      : null,
  };
}

// ── The generator ───────────────────────────────────────────────────────────

/** A row on the ladder. Everything here is derived; nothing is authored. */
export interface LeaderPlayer extends Persona {
  /** The latent. Every other number below is a function of it. */
  skill: number;
  battles: number;
  wins: number;
  winRate: number;
  xp: number;
  rank: RankPoint;
  econ: CopyEconomics;
  /** Signed. A sub-42% win rate bleeds points; the ladder shows losers. */
  earnings: number;
  /** Sums to 1 over `SECTOR_ORDER`. */
  sectorShare: Record<SectorKey, number>;
  /** Sums to 1 over `MODE_ORDER`. */
  modeShare: Record<Mode, number>;
  /** The fattest slice of `sectorShare` — the SPECIALTY column, and what the
   *  SECTOR × MODE chip row filters on. */
  sector: SectorKey;
  /** The fattest slice of `modeShare`. */
  mode: Mode;
  /** 8 finite points, biased by skill — the TREND sparkline. */
  trend: readonly number[];
  /** True only for the synthetic YOU row. */
  you: boolean;
  /** The copy-trader profile — GAIN %, RISK, AUM and the rest of the eToro
   *  surface. Purely derived from the fields above (see `copyProfileFor`), so
   *  it costs no seeded draw and moves no pinned number. */
  profile: CopyProfile;
}

// ── The copy-trader profile (the eToro surface) ─────────────────────────────

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE DESK'S CURRENCY IS DOLLARS, AND IT ALWAYS WAS
 * ────────────────────────────────────────────────────────────────────────────
 * `CopyEconomics` above prices a copy desk: a ticket size, a fee, a daily take.
 * Not one of those numbers comes off the PTS ledger — they are drawn fresh from
 * `hash(id)` in `copyEconomicsFor`, which is why the Result panel can compute
 * them from an id and an XP total alone. Plan 4 labelled them "PTS" because at
 * the time the app had only one unit; that label was always the wrong noun for
 * a fee-bearing book, and the display layer now calls them what they are.
 *
 * The rule that follows from that, and it is not negotiable:
 *
 *   THERE IS NO EXCHANGE RATE. The desk's dollars and the game's PTS are two
 *   separate quantities, never two denominations of one. Nothing in this file
 *   or any view multiplies a PTS figure by a rate to get a dollar, no surface
 *   prints the same quantity twice in two units, and XP stays XP everywhere —
 *   on rank lines, on unlock lines, in the nudge. `stakePointsFor` and the real
 *   ledger are untouched by every line below.
 *
 * Everything in this section is DERIVED — no new seeded draws, so the LCG draw
 * order documented at the top of the file is byte-for-byte what it was, and
 * every value `test/rank.test.ts` pins is unmoved. A profile is a pure function
 * of fields the persona already carries.
 */
export interface CopyProfile {
  /**
   * The headline: a trailing-twelve-month return, signed, as a fraction.
   * See `gain12mFor` for the derivation and why it lands in the tens of %.
   */
  gain12m: number;
  /** eToro's signature chip, 1 (calm) … 10 (hot). `riskScoreFor`. */
  risk: number;
  /** Copy capital under management, in dollars. `aumFor`. */
  aum: number;
  /** The smallest sleeve that can carry one ticket at this trader's size. */
  minCopy: number;
  /** Signed 30-day move in the copier book, as a fraction. `copierDelta30d`. */
  copierDelta: number;
  /** Months in the black out of twelve. `profitableMonthsFor`. */
  profitableMonths: number;
  /** The same reading as a fraction, for the bar. */
  profitableMonthsPct: number;
  /** `econ.avgTicket`, named in the desk's own noun. One field, one number —
   *  this is an alias, NOT a conversion. */
  avgTrade: number;
  /** `earnings`, ditto: career profit and loss on the desk, in dollars. */
  career: number;
}

/** Break-even hit rate at the demo's odds — the same 0.42 `earnings` prices. */
const BREAK_EVEN = 0.42;
/** Return on a ticket at break-even+1: the same 3.6 `earnings` prices. */
const TICKET_EDGE = 3.6;
/** A trading year. A duel every three or four days is 96 tickets; a persona
 *  with a 298-battle career did not run all of it in the last twelve months. */
const TRADES_PER_YEAR = 96;
/** The desk's sizing rule: 0.9% of the book rides on one ticket. This is the
 *  ONE tuned constant here, and it is tuned against the roster — see below. */
const RISK_PER_TRADE = 0.009;

/**
 * GAIN % — the trailing twelve months, the number a copier actually shops on.
 *
 *   gain = min(battles, 96) · 0.009 · 3.6 · (winRate − 0.42)
 *
 * Read it right to left. `3.6 · (winRate − 0.42)` is the edge ON ONE TICKET,
 * and it is not a new invention: it is character-for-character the factor
 * `earnings` already multiplies by, so a trader cannot have a positive career
 * and a negative twelve months. `0.009` is the sizing rule — 0.9% of the book
 * on a ticket, which is where a real copy desk sits. `min(battles, 96)` is how
 * many tickets that edge got applied to inside the year.
 *
 * Note what is NOT in it: `avgTicket`. A return is a RATE, and a trader who
 * runs $2,594 tickets on a $2.6M book returns exactly what one running $1,292
 * tickets on a $1.3M book does. Size lives in AUM, where size belongs.
 *
 * Against the thirteen personas this yields +3.5% (0xdrift, a 43.1% hit rate
 * grinding a small edge) through +70.0% (arlo.eth, 64.5% over a long career) —
 * tens of percent, which is the band a plausible copy leaderboard lives in, not
 * the four-figure nonsense a naive earnings/ticket ratio produces. Clamped at
 * −95% because a book can be lost but not more than lost; the ceiling is there
 * for the same reason, and neither end is reachable by a persona.
 */
export function gain12mFor(battles: number, winRate: number): number {
  const trades = Math.min(Math.max(0, battles), TRADES_PER_YEAR);
  const raw = trades * RISK_PER_TRADE * TICKET_EDGE * (winRate - BREAK_EVEN);
  const clamped = Math.max(-0.95, Math.min(2.5, raw));
  // An unplayed ledger multiplies zero trades by a negative edge and lands on
  // −0, which a signed formatter is entitled to render as a minus. There is no
  // such thing as a negative-zero year.
  return clamped === 0 ? 0 : clamped;
}

/** How much of the score the clock owns, and how much concentration owns. */
const RISK_TEMPO = 0.62;
const RISK_CONC = 0.38;
/** A perfectly spread book's Herfindahl index over six sectors. */
const FLAT_CONC = 1 / SECTOR_ORDER.length;

/**
 * RISK 1–10 — eToro's chip, and the one stat on the profile that is about HOW
 * a trader trades rather than how well.
 *
 *   tempo = modeShare.BLITZ + 0.45 · modeShare.QUICK        the clock
 *   conc  = (Σ sectorShare² − 1/6) / (1 − 1/6)              the book's spread
 *   risk  = 1 + round(9 · (0.62·tempo + 0.38·conc))
 *
 * Both halves are the app's own vocabulary. BLITZ is the shortest window and
 * the fullest weight; QUICK carries under half of it; NORMAL contributes
 * nothing, which is exactly the ordering `data/modes.ts` already asserts. The
 * concentration half is a Herfindahl index normalised so a flat six-sector book
 * scores 0 and a single-sector book scores 1 — the standard measure, and the
 * one a reader can recompute off the SECTOR SHARE bars in the drawer.
 *
 * Stable per persona because `modeShare` and `sectorShare` are, and integral
 * because a 6.4/10 risk chip would imply a precision nobody has.
 */
export function riskScoreFor(
  modeShare: Record<Mode, number>,
  sectorShare: Record<SectorKey, number>,
): number {
  const tempo = clamp01((modeShare.BLITZ ?? 0) + 0.45 * (modeShare.QUICK ?? 0));
  const herf = SECTOR_ORDER.reduce((a, k) => a + (sectorShare[k] ?? 0) ** 2, 0);
  const conc = clamp01((herf - FLAT_CONC) / (1 - FLAT_CONC));
  return 1 + Math.round(clamp01(RISK_TEMPO * tempo + RISK_CONC * conc) * 9);
}

/** A copier funds a sleeve deep enough to carry a fortnight of the trader's
 *  own flow before it needs topping up. */
const COPY_SLEEVE_DAYS = 14;

/**
 * AUM — the copy capital riding behind a trader.
 *
 *   aum = copiers · txPerCopierPerDay · avgTicket · 14
 *
 * i.e. every copier's sleeve holds two weeks of that trader's ticket flow.
 * Locked traders have no copiers, so their AUM is 0 by arithmetic rather than
 * by a branch — the same shape `daily` already has.
 */
export function aumFor(econ: CopyEconomics): number {
  return econ.copiers * econ.txPerCopierPerDay * econ.avgTicket * COPY_SLEEVE_DAYS;
}

/** The floor on a sleeve: it has to clear one ticket at this trader's size,
 *  rounded up to a round hundred, and never under the desk's $200 minimum. */
export function minCopyFor(avgTicket: number): number {
  return Math.max(200, Math.ceil(Math.max(0, avgTicket) / 100) * 100);
}

/** How hard the copier book chases form. A 20% better half-year of form pulls
 *  an 11% bigger book, which is a follow, not a stampede. */
const COPIER_CHASE = 0.55;

/**
 * The 30-day move in the copier count, ▲ or ▼.
 *
 * Read off `trend` — the eight form windows the persona already owns — and not
 * from a new seeded stream, because a second stream would be a second story
 * about the same trader and the two would eventually disagree. Specifically it
 * is the BACK HALF against the FRONT HALF, which is the identical read
 * `LadderTrend` uses to decide whether to draw the sparkline bright or dim. So
 * a row whose line reads bright shows a ▲ and one that reads dim shows a ▼,
 * always, on every surface.
 *
 * Geared by `COPIER_CHASE` and clamped to ±60%: copiers arrive and leave, they
 * do not teleport.
 */
export function copierDelta30d(trend: readonly number[]): number {
  if (trend.length < 2) return 0;
  const half = Math.floor(trend.length / 2);
  const front = trend.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const back = trend.slice(half).reduce((a, b) => a + b, 0) / (trend.length - half);
  if (front <= 0) return 0;
  const raw = ((back - front) / front) * COPIER_CHASE;
  return Math.max(-0.6, Math.min(0.6, raw));
}

/**
 * PROFITABLE MONTHS — how many of the last twelve closed in the black.
 *
 *   base = (winRate − 0.30) / 0.42            the latent, inverted back out
 *   up   = rising windows / (windows − 1)      the form line's own slope
 *   green = round(12 · clamp01(0.30 + 0.55·base + 0.20·(up − 0.5)))
 *
 * Two thirds of it is the base rate and a third is recent form, which is the
 * only honest split available: a persona has a career hit rate and an eight-
 * point form line, and nothing else that could possibly say which MONTHS went
 * well. Reported over twelve rather than over the eight windows so it reads the
 * way a copy platform reports it, and so it cannot be mistaken for a claim that
 * the app simulated twelve months of results.
 *
 * Coherent with GAIN by construction — both lean on `winRate` — so the profile
 * never shows a +70% year alongside four green months.
 */
export function profitableMonthsFor(winRate: number, trend: readonly number[]): number {
  let rising = 0;
  for (let i = 1; i < trend.length; i++) if ((trend[i] ?? 0) > (trend[i - 1] ?? 0)) rising++;
  const up = trend.length > 1 ? rising / (trend.length - 1) : 0.5;
  const base = clamp01((winRate - 0.3) / 0.42);
  return Math.round(12 * clamp01(0.3 + 0.55 * base + 0.2 * (up - 0.5)));
}

/**
 * The whole profile, from a row that has everything but the profile.
 *
 * Takes the row rather than the id so it can be a pure derivation with no
 * second seeded stream — `build` and `buildYou` each assemble their row, then
 * hand it here. Nothing below draws; nothing below can move a pinned number.
 */
export function copyProfileFor(p: Omit<LeaderPlayer, "profile">): CopyProfile {
  const months = profitableMonthsFor(p.winRate, p.trend);
  return {
    gain12m: gain12mFor(p.battles, p.winRate),
    risk: riskScoreFor(p.modeShare, p.sectorShare),
    aum: aumFor(p.econ),
    minCopy: minCopyFor(p.econ.avgTicket),
    copierDelta: p.econ.unlocked ? copierDelta30d(p.trend) : 0,
    profitableMonths: months,
    profitableMonthsPct: months / 12,
    avgTrade: p.econ.avgTicket,
    career: p.earnings,
  };
}

/**
 * XP is scaled to the tier table.
 *
 * Plan 4 §6 pins the XP formula as `battles·(50+skill·90)·(0.8+r·0.4)`. With
 * `battles` at 40–300 that yields 1,600–44,000 XP, and WHALE starts at 6,000 —
 * so TWELVE of the thirteen personas come out WHALE I, which contradicts the
 * plan's own stated goal for this file ("no WHALE with a 41% win rate": at
 * scale 1, 0xdrift is WHALE I on 43.1% and mira.base WHALE I on 44.7%).
 *
 * The plan's §5 hero mock pins the intended distribution precisely, and it is
 * how this constant was derived rather than tuned. `PLAYER.xp` is 2340 and the
 * mock reads `YOU · #7 · SHARK II`. Both of those are *checkable*: `rankAt`
 * puts 2340 in SHARK II on any scale, and `positionOf(2340)` returns 7 only if
 * the median persona sits at roughly 2340 too. At ×0.25 it returns exactly 7,
 * and the roster spreads FISH ×1 · SHARK ×6 · ORCA ×4 · WHALE ×2 — a ladder
 * with rungs, and a copy-trade column with a genuinely locked row on it.
 *
 * The formula's SHAPE is untouched; this is one multiplier applied after it.
 * `test/rank.test.ts` pins both mock numbers so the constant cannot drift.
 */
const XP_SCALE = 0.25;

/**
 * A share splitter with a fat primary slice. Not a real Dirichlet — one draw
 * per key, the primary drawn from a much higher band, then normalised — but it
 * has the properties the ladder needs: sums to exactly 1 (up to float error),
 * every key positive, and one obvious specialty per player.
 *
 * Draws once per key, in the order given. See the draw-order contract above.
 */
function dirichletish<K extends string>(
  r: () => number,
  keys: readonly K[],
  primary: K,
): Record<K, number> {
  const raw = keys.map((k) => (k === primary ? 2.4 + r() * 2.2 : 0.15 + r() * 0.85));
  const total = raw.reduce((a, b) => a + b, 0);
  const out = {} as Record<K, number>;
  keys.forEach((k, i) => {
    out[k] = (raw[i] ?? 0) / total;
  });
  return out;
}

/** The fattest slice, with the key order as the tie-break. */
function fattest<K extends string>(share: Record<K, number>, keys: readonly K[]): K {
  let best = keys[0] as K;
  for (const k of keys) if ((share[k] ?? 0) > (share[best] ?? 0)) best = k;
  return best;
}

/**
 * A persona's whole stat line, from its id and nothing else.
 *
 * The chain, in the fixed draw order documented at the top of this file:
 * skill decides how often they win, how often they win decides how much XP
 * they have banked, XP decides their tier, their tier decides whether anyone
 * can copy them, and skill decides how big the copied tickets are. Pull on any
 * thread and the rest follows.
 *
 * ONE ordering caveat, and it is deliberate. `winRate` is skill plus a ±2%
 * band, so the win-rate ladder IS the skill ladder (Kendall τ ≈ 0.92). TOTAL
 * XP is not: it multiplies the skill-driven rate by `battles`, an independent
 * 40–300 draw, so career XP is grind-weighted and a high-volume journeyman can
 * outrank a low-volume sharp (τ ≈ 0.23 against skill; τ ≈ 0.59 for XP *per
 * battle*, which is the skill-driven half). That is a game being honest about
 * what a level means — and it is exactly why WIN RATE, COPY HEAT and EARNINGS
 * are separate ladder filters rather than four sorts of the same column.
 */
export function build(persona: Persona): LeaderPlayer {
  const r = seededRandom(hash(persona.id));

  const skill = 0.34 + r() * 0.52; // 1
  const battles = 40 + Math.floor(r() * 260); // 2
  const winRate = 0.3 + skill * 0.42 + (r() - 0.5) * 0.04; // 3
  const wins = Math.round(battles * winRate);
  // Note the draw happens INSIDE the scale, not around it — `XP_SCALE` must
  // never change how many times the stream is pulled.
  const xp = Math.round(battles * (50 + skill * 90) * (0.8 + r() * 0.4) * XP_SCALE); // 4

  const primarySector = SECTOR_ORDER[Math.floor(r() * SECTOR_ORDER.length)] ?? "SEMIS"; // 5
  const primaryMode = MODE_ORDER[Math.floor(r() * MODE_ORDER.length)] ?? "NORMAL"; // 6
  const sectorShare = dirichletish(r, SECTOR_ORDER, primarySector); // 7…12
  const modeShare = dirichletish(r, MODE_ORDER, primaryMode); // 13…15

  // Form over the last 8 windows: a random walk with a skill-shaped drift, so
  // a strong player's line trends up and a weak one's sags. Kept inside
  // 0.05…0.98 so the sparkline never flatlines against an edge.
  const trend: number[] = [];
  let v = clamp01(0.5 + (skill - 0.6));
  for (let i = 0; i < 8; i++) {
    // 16…23
    v = Math.min(0.98, Math.max(0.05, v + (r() - 0.45) * 0.18 + (skill - 0.6) * 0.03));
    trend.push(Math.round(v * 1000) / 1000);
  }

  const econ = copyEconomicsFor(persona.id, xp);

  // Assembled in two steps only because the profile is a function OF the row.
  // No draw happens between them, so the stream is exactly what it was.
  const row: Omit<LeaderPlayer, "profile"> = {
    ...persona,
    skill,
    battles,
    wins,
    winRate,
    xp,
    rank: rankAt(xp),
    econ,
    // 42% is the break-even hit rate at the demo's odds: below it a player is
    // paying the house, and the EARNINGS column shows it in red.
    earnings: Math.round(battles * econ.avgTicket * (winRate - 0.42) * 3.6),
    sectorShare,
    modeShare,
    sector: fattest(sectorShare, SECTOR_ORDER),
    mode: fattest(modeShare, MODE_ORDER),
    trend,
    you: false,
  };
  return { ...row, profile: copyProfileFor(row) };
}

/**
 * The ladder, built once at module load. Deterministic: same array, same
 * numbers, every process, forever — the only inputs are the persona ids.
 *
 * Order is roster order, NOT rank order. `rankedBy` does the sorting, because
 * which player is #1 depends on which filter is selected.
 */
export const LEADERBOARD: readonly LeaderPlayer[] = PERSONAS.map(build);

// ── The YOU row ─────────────────────────────────────────────────────────────

/** What the ledger knows about you, flattened. Everything else is derived. */
export interface YouInput {
  /** Career XP — `PLAYER.xp + Σ history.xp` from `state/rank.ts`. */
  xp: number;
  /** `history.length`. */
  battles: number;
  /** `history.filter(h => h.won).length`. */
  wins: number;
  /** Every sector group you have played, WITH repeats — the counts are the
   *  share. `SettledRecord.sectors` holds RAW sector strings, so map them
   *  through `sectorOf` before handing them over. */
  sectors?: readonly SectorKey[];
  /** Every mode you have played, with repeats. */
  modes?: readonly Mode[];
}

/** Id for the synthetic row. Seeds your `avgTicket`, so it is pinned. */
export const YOU_ID = "you";

/**
 * Your display identity, pinned as constants rather than inlined into
 * `buildYou` below.
 *
 * `components/PlayerMark.tsx` seeds a player's glyph off their NAME, and the
 * parlay slip renders your mark from a screen that never sees a `LeaderPlayer`
 * — it only knows that the seat is yours. Exporting the two strings is what
 * stops that screen from hard-coding a second "You"/"YO" pair that could drift
 * from this one and hand you a different glyph on the slip than on the ladder.
 * Values unchanged; this is a name for what was already there.
 */
export const YOU_NAME = "You";
export const YOU_INITIALS = "YO";

/** Counts → shares, with a uniform prior so an empty ledger yields a flat
 *  split rather than NaN. */
function shareOf<K extends string>(keys: readonly K[], played: readonly K[]): Record<K, number> {
  const prior = 0.5;
  const counts = {} as Record<K, number>;
  for (const k of keys) counts[k] = prior;
  for (const k of played) if (k in counts) counts[k] = (counts[k] ?? 0) + 1;
  const total = keys.reduce((a, k) => a + (counts[k] ?? 0), 0);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = (counts[k] ?? 0) / total;
  return out;
}

/**
 * The YOU row (plan 4 §5.4) — a real `LeaderPlayer`, so it sorts, filters and
 * re-ranks with the personas instead of being special-cased into the table.
 *
 * Your battles, wins, XP and shares are REAL (from the ledger); only
 * `avgTicket` and the trend line come off the seeded stream, because a ticket
 * size is a fact about a trader that the ledger does not record. An empty
 * ledger lands you at MINNOW III near the bottom — and one duel visibly moves
 * the row, which is the whole point of the loop.
 *
 * Exported for 6E's `state/rank.ts`; nothing here reads React or the ledger
 * module, so this file stays pure.
 */
export function buildYou(input: YouInput): LeaderPlayer {
  const xp = Math.max(0, Math.round(input.xp));
  const battles = Math.max(0, Math.round(input.battles));
  const wins = Math.max(0, Math.min(battles, Math.round(input.wins)));
  const winRate = battles > 0 ? wins / battles : 0;

  const r = seededRandom(hash(YOU_ID));
  const seededSkill = 0.34 + r() * 0.52;
  // With a record, your latent is your record — inverted through the same
  // winRate formula the personas use, so you sit on their curve.
  const skill = battles > 0 ? clamp01((winRate - 0.3) / 0.42) : seededSkill;

  const sectorShare = shareOf(SECTOR_ORDER, input.sectors ?? []);
  const modeShare = shareOf(MODE_ORDER, input.modes ?? []);

  const trend: number[] = [];
  let v = clamp01(0.5 + (skill - 0.6));
  for (let i = 0; i < 8; i++) {
    v = Math.min(0.98, Math.max(0.05, v + (r() - 0.45) * 0.18 + (skill - 0.6) * 0.03));
    trend.push(Math.round(v * 1000) / 1000);
  }

  const econ = copyEconomicsFor(YOU_ID, xp);
  const row: Omit<LeaderPlayer, "profile"> = {
    id: YOU_ID,
    name: YOU_NAME,
    initials: YOU_INITIALS,
    bg: C.indigo,
    skill,
    battles,
    wins,
    winRate,
    xp,
    rank: rankAt(xp),
    econ,
    earnings: Math.round(battles * econ.avgTicket * (winRate - 0.42) * 3.6),
    sectorShare,
    modeShare,
    sector: fattest(sectorShare, SECTOR_ORDER),
    mode: fattest(modeShare, MODE_ORDER),
    trend,
    you: true,
  };
  // Your profile comes off the same derivation as everyone else's — an empty
  // ledger is a 0.0% year at risk 4, not a blank.
  return { ...row, profile: copyProfileFor(row) };
}

/** The ladder with your row folded in. A plain concat — `rankedBy` sorts it,
 *  so you are ranked by the same rule as everyone else. */
export function leaderboardWith(you: LeaderPlayer): readonly LeaderPlayer[] {
  return [...LEADERBOARD, you];
}

// ── Filtering and ranking ───────────────────────────────────────────────────

export type LadderFilter = "COPY" | "GAIN" | "SECTOR_MODE" | "WINRATE" | "EARNINGS";

/**
 * Row A's five options, in render order.
 *
 * GAIN sits second rather than first on purpose. It is the headline number on
 * a copy-trader's CARD — the thing you read once you have found them — but the
 * page's thesis is still "rank is income", so COPY HEAT stays the board's
 * opening question and the default. Adding the option cost nothing structural:
 * `measure` gained one arm, and `rankedBy` sorts descending by a metric it has
 * never needed to understand.
 */
export const LADDER_FILTERS: readonly LadderFilter[] = [
  "COPY",
  "GAIN",
  "SECTOR_MODE",
  "WINRATE",
  "EARNINGS",
];

export const FILTER_LABEL: Record<LadderFilter, string> = {
  COPY: "COPY HEAT",
  GAIN: "GAIN 12M",
  SECTOR_MODE: "SECTOR × MODE",
  WINRATE: "WIN RATE",
  EARNINGS: "EARNINGS",
};

/** Row B's chip state. An EMPTY group means "all" — never a dead screen. */
export interface Selection {
  sectors: readonly SectorKey[];
  modes: readonly Mode[];
}

export const NO_SELECTION: Selection = { sectors: [], modes: [] };

/** One ranked row, ready to render. `pos` is 1-based and consecutive. */
export interface Ranked {
  pos: number;
  player: LeaderPlayer;
  /** The sort key. Higher is better for every filter. */
  metric: number;
  /** The metric column's text. */
  label: string;
  /** The dim second line under it. */
  sub: string;
}

/**
 * The ladder's number vocabulary.
 *
 * Exported — additively, the implementations are untouched — because the room's
 * seat dossier (`views/Room.tsx`) prints the SAME four figures a ladder row
 * prints, and a second `toLocaleString` call site with its own rounding would
 * be the first thing to drift. `signed` in particular uses U+2212, not a
 * hyphen: the minus has to line up under the plus in a tabular column.
 */
export const pct1 = (n: number): string => `${(n * 100).toFixed(1)}%`;
export const pts = (n: number): string => Math.round(n).toLocaleString("en-US");
export const signed = (n: number): string => `${n < 0 ? "−" : "+"}${pts(Math.abs(n))}`;

/**
 * The copy desk's money, formatted the way a money app formats money.
 *
 * `usd` is the exact figure — `$2,206`, `$63,698` — and it is what a panel
 * prints when the reader might reasonably care about the last three digits.
 * `usdCompact` is the glance version, and it only kicks in where the exact
 * figure has stopped being readable: six digits become `$452.5K`, seven become
 * `$1.9M`. Below that it defers to `usd`, so there is exactly one place where
 * `$63,698` could ever come out as `$63.7K` and it is a decision made per call
 * site rather than by a threshold nobody can see.
 *
 * `usdSigned` always carries a sign, because the one figure that can be
 * negative (career P/L) sits in a tabular column where the minus must line up
 * under the plus — the same reason `signed` above uses U+2212 rather than a
 * hyphen. `usdGain` is the profile's percentage, signed for the same reason.
 *
 * These format DOLLARS. `pts` formats POINTS. No call site converts between
 * them, and nothing here knows a rate, because there is none.
 */
export const usd = (n: number): string =>
  `${n < 0 ? "−" : ""}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

export const usdSigned = (n: number): string =>
  `${n < 0 ? "−" : "+"}$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

export function usdCompact(n: number): string {
  const sign = n < 0 ? "−" : "";
  const v = Math.abs(n);
  if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 100_000) return `${sign}$${(v / 1_000).toFixed(1)}K`;
  return usd(n);
}

/** `0.538` → `+53.8%`. The GAIN column, and the copier delta. */
export const usdGain = (n: number): string =>
  `${n < 0 ? "−" : "+"}${(Math.abs(n) * 100).toFixed(1)}%`;

/**
 * The trailing run in a player's form line.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A FORM RUN AND NOT A WIN STREAK
 * ────────────────────────────────────────────────────────────────────────────
 * A `LeaderPlayer` has no notion of RECENCY. `wins` and `battles` are career
 * totals; nothing in this file records the ORDER of a persona's results, and
 * nothing could — the personas have no match history, only a latent skill and
 * the numbers that fall out of it. The one ordered sequence a persona owns is
 * `trend`: eight form windows, drawn as a skill-shaped random walk, which is
 * already what the ladder's TREND column draws.
 *
 * So this counts the consecutive rising (or falling) windows at the END of that
 * walk and says exactly that. It is a true statement about data that already
 * exists. Calling the same number "W4 STREAK" would be an invention: it would
 * read as four match results the app has never simulated. `state/ledger.ts`
 * owns the only real streak in the app — YOUR consecutive wins — and that one
 * comes from an actual history.
 *
 * Purely derived and purely additive: it draws nothing from the seeded stream,
 * so no existing value moves.
 */
export interface FormRun {
  dir: "up" | "down" | "flat";
  /** Windows in the run. 0 when the last two prints are level. */
  length: number;
}

export function formRun(trend: readonly number[]): FormRun {
  if (trend.length < 2) return { dir: "flat", length: 0 };
  const step = (i: number): number => (trend[i] ?? 0) - (trend[i - 1] ?? 0);
  const last = trend.length - 1;
  const head = step(last);
  if (head === 0) return { dir: "flat", length: 0 };

  const dir = head > 0 ? "up" : "down";
  let length = 0;
  for (let i = last; i >= 1; i--) {
    const d = step(i);
    if (dir === "up" ? d > 0 : d < 0) length++;
    else break;
  }
  return { dir, length };
}

/**
 * Wins inside a sector × mode selection (plan 4 §6, invariant 3).
 *
 *   round(battles · Σshare(s) · Σshare(m) · winRate · localBoost)
 *
 * `localBoost` is normalised so the empty selection returns EXACTLY `wins`:
 * with nothing selected the ladder is the same players with the same numbers,
 * merely sorted differently. A player whose specialty is inside the selection
 * gets a modest edge on their home turf; that is the only place the number
 * moves, and it is bounded — the filter re-ranks, it never invents.
 */
export function winsIn(
  player: LeaderPlayer,
  sectors: readonly SectorKey[],
  modes: readonly Mode[],
): number {
  const sSum = sectors.length ? sectors.reduce((a, s) => a + (player.sectorShare[s] ?? 0), 0) : 1;
  const mSum = modes.length ? modes.reduce((a, m) => a + (player.modeShare[m] ?? 0), 0) : 1;
  const hitS = sectors.length === 0 || sectors.includes(player.sector);
  const hitM = modes.length === 0 || modes.includes(player.mode);
  // Divided by the both-hit value (1.28) so the no-selection case is exactly 1.
  const localBoost = (1 + (hitS ? 0.18 : 0) + (hitM ? 0.1 : 0)) / 1.28;
  return Math.round(player.battles * sSum * mSum * player.winRate * localBoost);
}

/** Row B's rule: OR within a group, AND across groups. An empty group is all. */
export function matchesSelection(player: LeaderPlayer, sel: Selection): boolean {
  const okS = sel.sectors.length === 0 || sel.sectors.includes(player.sector);
  const okM = sel.modes.length === 0 || sel.modes.includes(player.mode);
  return okS && okM;
}

/** `SEMIS+DEFI · BLITZ`, `ALL SECTORS · ALL MODES` — the header echo. */
export function selectionLabel(sel: Selection): string {
  const s = sel.sectors.length
    ? SECTOR_ORDER.filter((k) => sel.sectors.includes(k))
        .map((k) => SECTORS[k].label)
        .join("+")
    : "ALL SECTORS";
  const m = sel.modes.length
    ? MODE_ORDER.filter((k) => sel.modes.includes(k))
        .map((k) => MODES[k].label)
        .join("+")
    : "ALL MODES";
  return `${s} · ${m}`;
}

function measure(p: LeaderPlayer, filter: LadderFilter, sel: Selection): Omit<Ranked, "pos"> {
  switch (filter) {
    case "COPY":
      return {
        player: p,
        metric: p.econ.copiers,
        label: p.econ.unlocked ? `${pts(p.econ.copiers)} COPIERS` : "LOCKED",
        // Fee revenue, in the desk's dollars. The locked arm stays in XP — the
        // unlock is a RANK fact, and rank is measured in XP on every screen.
        sub: p.econ.unlocked
          ? `≈ ${usd(p.econ.daily)} / DAY`
          : `${pts(p.econ.nextUnlock?.xpAway ?? 0)} XP TO ${p.econ.nextUnlock?.tier.name ?? "SHARK"}`,
      };
    case "GAIN":
      return {
        player: p,
        metric: p.profile.gain12m,
        label: usdGain(p.profile.gain12m),
        sub: `RISK ${p.profile.risk}/10 · ${pts(p.battles)} TRADES`,
      };
    case "SECTOR_MODE": {
      const n = winsIn(p, sel.sectors, sel.modes);
      return { player: p, metric: n, label: `${pts(n)} WINS`, sub: selectionLabel(sel) };
    }
    case "WINRATE":
      return {
        player: p,
        metric: p.winRate,
        label: pct1(p.winRate),
        sub: `${pts(p.wins)} / ${pts(p.battles)}`,
      };
    case "EARNINGS":
      return {
        player: p,
        metric: p.earnings,
        label: usdSigned(p.earnings),
        sub: `${pts(p.battles)} BATTLES`,
      };
  }
}

/**
 * The ladder, ranked.
 *
 * Filters (SECTOR × MODE only), sorts descending by the filter's metric, and
 * numbers the survivors 1…n with no gaps and no ties — a ladder with two #3s
 * and no #4 reads as a bug even when the maths is right. Ties break on `id`,
 * ascending, so the order is total and stable across renders and processes.
 *
 * The player objects are passed through BY REFERENCE. Every list this returns
 * is a permutation of a subset of the input, which is what makes "the filtered
 * list re-ranks, never invents" checkable by identity rather than by eye.
 */
export function rankedBy(
  list: readonly LeaderPlayer[],
  filter: LadderFilter,
  sel: Selection = NO_SELECTION,
): Ranked[] {
  const pool = filter === "SECTOR_MODE" ? list.filter((p) => matchesSelection(p, sel)) : list;
  return pool
    .map((p) => measure(p, filter, sel))
    .sort((a, b) => b.metric - a.metric || (a.player.id < b.player.id ? -1 : 1))
    .map((row, i) => ({ pos: i + 1, ...row }));
}

/**
 * Your position on the XP ladder — 1 + however many personas are ahead of you.
 *
 * Non-increasing in XP: gaining XP can only move you up the table or leave you
 * where you are, never down. `state/rank.ts` calls it twice (before, after) so
 * the rank moment's `#9 → #7` and the ladder page's row number are the same
 * function of the same input, and cannot drift.
 */
export function positionOf(xp: number): number {
  const v = Math.max(0, xp);
  return 1 + LEADERBOARD.filter((p) => p.xp > v).length;
}

// ── Re-exports ──────────────────────────────────────────────────────────────

/** The sector and mode vocabularies, re-exported so a ladder view has ONE
 *  import. These are plan 1's real modules — there is no fallback constant
 *  here and there must never be one. */
export { SECTORS, SECTOR_ORDER } from "./sectors.ts";
export { MODES, MODE_ORDER } from "./modes.ts";
export { COPY_FEE, DIVISIONS } from "./rewards.ts";
export type { RankPoint, RankTier };
