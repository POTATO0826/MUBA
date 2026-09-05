import {
  SECONDS_PER_YEAR,
  decayOver,
  structureGreeks,
  yearsBetweenMs,
  type Greeks,
  type SourcedGreeks,
} from "../data/greeks.ts";
import {
  chancePct,
  REFERENCE_MOVE,
  TIER_BANDS,
  type LiveCard,
  type ParlayLeg,
  type Stance,
  type Tier,
} from "../engine/parlay.ts";
import type { RowGreeks } from "../types.ts";
import { DUEL_WINDOW, SETTLEMENT_NOTE } from "./optionize.ts";

/**
 * The trade ticket — one parlay card, written the way the option it *is* would
 * be written on a broker's chain.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ────────────────────────────────────────────────────────────────────────────
 * The card face (`src/components/ParlayCardFace.tsx`) is a *game* surface: six
 * quantities, progressively disclosed, sized so the downside is read first. It
 * is deliberately small. What it cannot do — and what the owner asked for — is
 * make a player understand that the tile under their cursor **is a real option
 * position**: a named contract, at a listed strike, expiring on a date, whose
 * premium is the whole of their risk and whose delta is the number the tier was
 * named after.
 *
 * So this module builds the ticket, and it is written in the instrument's own
 * language rather than the game's. The contract first, named the way the venue
 * names it (`ETH-12SEP26-2460-C`). Then the money: premium **as** the max loss,
 * breakeven, the payoff's shape and its ceiling. Then the greeks, as trading
 * information — delta as "how much of the move, and roughly how likely", theta
 * as what a day of waiting costs *and* what the duel's eight seconds cost. Each
 * carries one clause of explanation and never a paragraph: the ticket has to be
 * scannable by someone who already trades and followable by someone who does
 * not, and a wall of text fails both.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TIER IS THE DELTA BAND — SAID OUT LOUD
 * ────────────────────────────────────────────────────────────────────────────
 * `TIER_BANDS` is the whole of what SAFE / EVEN / SHARP / DEGEN mean: four
 * half-open `|delta|` brackets. On a live card the "chance" printed on the face
 * IS the listed option's own delta, which is why it falls in the band. The
 * ticket prints the band beside the delta so that connection is visible rather
 * than inferred — it is the single link that turns a coloured tile into an
 * option.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS MODULE REFUSES TO DO
 * ────────────────────────────────────────────────────────────────────────────
 * **A seeded card has no contract.** No premium, no listed strike, no expiry,
 * and its "40% chance" is `tierProb(SAFE)` — the midpoint of a band — not any
 * option's delta. Dressing that in trade-ticket clothing is the exact failure
 * this shape invites, so {@link seededTicket} is a different ticket rather than
 * the same one with dashes in it: it opens by saying there is nothing to buy,
 * and every dashed row says what the missing figure would have done to your
 * money if it existed.
 *
 * **Every greek is labelled with where it came from** (`docs/greeks.md` §7).
 * The strike, the premium, the delta and the IV are the venue's, read off a
 * resting order. Gamma, theta and vega are ours, Black–Scholes on that same
 * published IV. They are never presented as each other.
 *
 * **Theta always names its window.** There is no field called `theta`; there is
 * `thetaPerDay`, and there is `decayOver(g, DUEL_WINDOW.tape)`. The ticket
 * prints both, labelled, because a BTC put's `−165.13` is −$165 a *day* and
 * −$0.0153 over an eight-second duel, and the two differ by 10,800×.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SECOND TICKET ON THIS PANEL: A BOX
 * ────────────────────────────────────────────────────────────────────────────
 * `src/views/BoxBuilder.tsx` builds its own ticket for a drawn box and a listed
 * zone, and it renders through the same {@link Ticket} and the same panel. Two
 * things it needs live here rather than there, because they are claims about
 * what may honestly be said rather than about a screen: {@link boxGreeks},
 * which composes a four-leg structure's risk off the venue's published smile
 * and refuses to extrapolate one, and {@link boxGreekRows}, which writes those
 * five figures with their windows, their provenance and one clause each.
 *
 * They do **not** go through {@link ticketGreeks}: that guard refuses a composed
 * set and a borrowed vol, and a box is both by construction, so applying it
 * would delete every box's greeks rather than check them. The guard is
 * re-derived instead, clause by clause, on {@link boxGreeks}.
 *
 * The module is pure — no clock, no DOM, no network. `now` is an argument.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who is speaking for one figure. Rendered as a small tag beside the value, and
 * never optional on a row that carries a number: the whole reason this object
 * exists is that a computed greek and a published one must not be readable as
 * each other.
 *
 *  - `venue` — read off the resting order, unchanged. The strike, the expiry,
 *    the ask, the published delta, the published IV.
 *  - `model` — computed here by `src/data/greeks.ts`, from a published IV on
 *    **this exact strike**. Gamma, theta, vega.
 *  - `derived` — arithmetic on venue numbers only, no model: breakeven is
 *    strike ± premium, and the payout at the reference move is the protocol's
 *    own payout function over the ask.
 *  - `game` — this build's own fixture. A seeded strike, a tier's band
 *    midpoint. Never a price anyone quoted.
 */
export type TicketSource = "venue" | "model" | "derived" | "game";

/** One line of the ticket: a label, a figure, and one clause about what the
 *  figure does to your money. `value` is {@link DASH} where nothing backs it,
 *  and then `note` says *why* rather than leaving a blank. */
export interface TicketRow {
  /** Stable key — also the `data-ticket-row` attribute, so a test can name a
   *  row without matching on its prose. */
  key: string;
  label: string;
  value: string;
  /** One clause. Not a paragraph, not a lesson. */
  note: string;
  /** `null` only on a row whose value is a dash — there is no provenance for
   *  a number that does not exist. */
  source: TicketSource | null;
}

/**
 * The state the whole ticket is in. Drives the banner and the accent.
 *
 * `note` is the odd one out and deliberately so: the first three are claims
 * about a *position* — there is a contract, there is no contract, the book
 * refused to deal one — and `note` is a claim about nothing at all. It is a
 * definition of a figure, timeless, true before the box is drawn and still true
 * after it is torn up. It wears its own neutral accent for that reason: a
 * definition that borrowed LIVE's green would be asserting a market state it
 * knows nothing about.
 */
export type TicketState = "live" | "seeded" | "not-dealt" | "note";

export interface Ticket {
  /** `ETH:sharp-bull` — matches the card's own `data-parlay`. */
  id: string;
  state: TicketState;
  /** The contract, named the way the venue names it —
   *  `ETH-12SEP26-2460-C` — or the game's line where there is no contract. */
  title: string;
  /** `SHARP · |Δ| 0.25–0.45 · Thetanuts on Base` */
  subtitle: string;
  /** The sentence that must be read before any number below it. */
  banner: string;
  /**
   * Further paragraphs of the same prose, below the banner and above the rows.
   *
   * Only {@link fieldNote} fills it. A trade ticket says its piece in the
   * banner and then gets on with the figures; a field note has no figures, so
   * the paragraph *is* the panel and one bordered block would have to hold the
   * lot. Absent on every other ticket, and the panel renders nothing for it.
   */
  body?: readonly string[];
  rows: readonly TicketRow[];
  /** Closing sentences: provenance, then settlement. */
  footer: readonly string[];
}

/** Why a slot carries no live card. Read only when there is none. */
export type SeededReason =
  /** No live book reached the screen at all — every ticker on it is seeded. */
  | "no-book"
  /** A book reached the screen, but it carries no chain for this underlying. */
  | "no-chain"
  /** The chain exists and backs nothing in this tier's band on this side. */
  | "not-dealt";

export interface CardTicketInput {
  sym: string;
  tier: Tier;
  stance: Stance;
  /** `ETH:sharp-bull`. */
  id: string;
  /** The card the frozen book dealt, or `null`. */
  card: LiveCard | null;
  /** The seeded leg this slot would build. Always present — it is what the
   *  game plays when the book deals nothing. */
  leg: ParlayLeg;
  /** Live spot for this underlying, or `0` when the book carries none. */
  spot: number;
  /** Wall clock, ms. An argument, so this module holds no clock. */
  now: number;
  /** Only read when `card` is `null`. */
  reason: SeededReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting
// ─────────────────────────────────────────────────────────────────────────────

/** The one dash, U+2014 — the same glyph the card face uses for an absence. */
export const DASH = "—";

/** The typographic minus, so a negative theta does not wear a hyphen beside a
 *  monospace column of dollar figures. */
const MINUS = "−";

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A figure at the precision it deserves, with no scientific notation.
 *
 * `fmtPx` (`src/engine/tape.ts`) is the tape's formatter and drops to
 * `toExponential` below 0.001 — correct for a scrolling price, wrong here,
 * because the duel-window theta of a cheap wing is `0.000039` and
 * `3.90e-5 dollars` is not a number anyone reads off a ticket. Gamma is in the
 * same territory (1e-4 on BTC). So the scale ladder runs all the way down and
 * only gives up past a millionth, where the honest answer is "under a
 * millionth" rather than a digit string.
 */
export function fine(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  const a = Math.abs(n);
  // Grouped above a thousand, and the cents survive: a breakeven of $2,466.70
  // rounded to `$2,467` is seventy cents of the one figure on this panel that
  // is a decision boundary. A round number keeps no decimals it did not earn.
  if (a >= 1000) {
    return n.toLocaleString("en-US", {
      minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
      maximumFractionDigits: 2,
    });
  }
  if (a >= 1) return n.toFixed(2);
  if (a >= 0.01) return n.toFixed(4);
  // Six places of room, trailing zeros trimmed — `0.0012` rather than
  // `0.001200`, and `0.000039` rather than `3.9e-5`.
  if (a >= 0.000001) return String(+n.toFixed(6));
  if (a === 0) return "0.00";
  return n.toExponential(1);
}

/** `$6.70`, `$2,460`, `−$0.000039`. The sign leads the `$`, which is how a
 *  ledger writes it and how a debit reads. */
export function money(n: number): string {
  if (!Number.isFinite(n)) return DASH;
  return `${n < 0 ? MINUS : ""}$${fine(Math.abs(n))}`;
}

/** `0.3%`, `12.4%`. Two significant places under 10, one above — a strike 41%
 *  away does not need a decimal and one 0.3% away is nothing without it. */
export function pct(fraction: number): string {
  if (!Number.isFinite(fraction)) return DASH;
  const p = fraction * 100;
  const a = Math.abs(p);
  // One decimal down to 1%, two below it. An implied vol of 58.2% rounded to
  // 58% throws away the digit the venue actually published, and a strike 0.29%
  // away rounded to 0% reads as "on top of spot".
  return `${a >= 100 ? p.toFixed(0) : a >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
}

/**
 * `6d 21h`, `18h 40m`, `42m`, `expired`.
 *
 * Two units, never three: the third is noise against an expiry the venue prints
 * to the hour, and a ticket that reads `6d 21h 14m 03s` invites a player to
 * believe the last unit means something.
 */
export function timeLeft(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "expired";
  const mins = Math.floor(ms / 60000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** `Fri 12 Sep 2026 · 08:00 UTC`. UTC everywhere and stated — the venue lists
 *  its expiries at 08:00 UTC and a local-time render would move the date for
 *  half the world. */
export function expiryStamp(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return DASH;
  const d = new Date(unixSeconds * 1000);
  const mon = MONTHS[d.getUTCMonth()] ?? "";
  const name = `${mon.charAt(0)}${mon.slice(1).toLowerCase()}`;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${name} ${d.getUTCFullYear()} · ${hh}:${mm} UTC`;
}

/**
 * `ETH-12SEP26-2460-C` — the venue's own instrument name, rebuilt.
 *
 * Not decoration. `MmQuote.ticker` on the market-maker feed is literally
 * `ETH-5SEP26-2380-C`, so this is the string a player would see if they went to
 * the book itself, and putting it at the head of the ticket is what teaches
 * them to read one. `PricingRow` carries no ticker of its own (the resting
 * order book names instruments by their contract address), so it is composed
 * from the four things that identify the contract and nothing is invented.
 */
export function instrumentName(
  underlying: string,
  expirySeconds: number,
  strike: number,
  side: "C" | "P",
): string {
  const d = new Date(expirySeconds * 1000);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const k = Number.isInteger(strike) ? String(strike) : String(+strike.toFixed(4));
  return `${underlying}-${d.getUTCDate()}${MONTHS[d.getUTCMonth()] ?? ""}${yy}-${k}-${side}`;
}

/** `|Δ| 0.25–0.45` — the tier, said as the thing it actually is. */
export function bandLabel(tier: Tier): string {
  const [lo, hi] = TIER_BANDS[tier];
  return `|Δ| ${lo.toFixed(2)}–${hi.toFixed(2)}`;
}

/** `ITM` / `ATM` / `OTM`, on the card face's own half-percent band so the two
 *  surfaces cannot disagree about one strike. */
const ATM_BAND = 0.005;

function moneyness(stance: Stance, strike: number, spot: number): string {
  if (!(spot > 0) || !Number.isFinite(strike)) return DASH;
  const gap = (strike - spot) / spot;
  if (Math.abs(gap) < ATM_BAND) return "ATM";
  return (stance === "bull" ? gap < 0 : gap > 0) ? "ITM" : "OTM";
}

// ─────────────────────────────────────────────────────────────────────────────
// The greeks, read off a row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The row's greeks, **only** when they belong to a vanilla priced off its own
 * published IV — `docs/greeks.md` §7, and the same two-clause guard
 * `vanillaGreeks` applies in `src/desk/optionize.ts`.
 *
 * `source !== "model"` refuses anything composed from legs: a spread's delta is
 * a *net* of two vanillas and this ticket renders delta as odds, which is the
 * mistake that nearly shipped once (§5 of the same doc).
 *
 * `volSource !== "own"` refuses a vanilla whose vol was borrowed from the
 * nearest listed strike. Those numbers are real and honestly flagged, but this
 * ticket puts them on the same panel as the venue's *published* delta, and one
 * strike's published delta beside another strike's borrowed vol is a provenance
 * muddle no tag makes readable.
 *
 * `null` renders three dashed rows with the reason, which is the correct
 * rendering of a strike the venue quoted no volatility for.
 */
export function ticketGreeks(g: RowGreeks | undefined): RowGreeks | null {
  if (!g) return null;
  if (g.source !== "model") return null;
  if (g.volSource !== "own") return null;
  return g;
}

/**
 * A {@link RowGreeks} widened to the engine's own {@link Greeks}, so
 * `decayOver` can be handed the set that actually reached the screen.
 *
 * The two shapes differ by exactly two fields and neither is a new claim:
 * `price` is the model's own value (`modelPrice`) and `vegaPerUnitVol` is
 * `vegaPerPoint × 100` **by definition** (`docs/greeks.md` §2). `duelDecay` in
 * `src/desk/optionize.ts` performs the identical widening for the same reason.
 */
export function asGreeks(g: RowGreeks): Greeks {
  return {
    price: g.modelPrice,
    delta: g.delta,
    gamma: g.gamma,
    vegaPerPoint: g.vegaPerPoint,
    vegaPerUnitVol: g.vegaPerPoint * 100,
    thetaPerYear: g.thetaPerYear,
    thetaPerDay: g.thetaPerDay,
    rhoPerPoint: g.rhoPerPoint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A box's greeks — composed, because a box IS a composition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One published point of a (underlying, expiry) volatility smile: a strike the
 * venue listed a vanilla at, and the implied vol it printed there.
 *
 * Calls and puts share one curve, for the reason `docs/greeks.md` §5 gives at
 * length: under put–call parity a call and a put at the same strike and expiry
 * have the same implied vol, so one curve instead of two loses nothing and
 * roughly doubles the coverage — which is exactly what a four-strike box needs.
 */
export interface SmilePoint {
  readonly strike: number;
  readonly iv: number;
}

/** What {@link boxGreeks} needs. `now` is milliseconds and `expiry` is unix
 *  seconds, matching every other clock argument in this module. */
export interface BoxGreeksInput {
  /** The four strikes, ascending, in dollars. */
  strikes: readonly [number, number, number, number];
  /**
   * The venue's own payout name for the instrument that will actually fill —
   * `ranger` for a listed zone, `call_condor` for a box nobody has listed.
   * Never guessed from the strike shape: `validateCondor` and `validateRanger`
   * accept the identical arrays, so the strikes decide nothing
   * (`docs/greeks.md` §5).
   */
  payout: "ranger" | "call_condor";
  spot: number | null;
  expiry: number;
  now: number;
  /** The published smile on **this** (underlying, expiry). Empty is an ordinary
   *  reading and is answered with a reason, never with a neighbour's curve. */
  smile: readonly SmilePoint[];
  /** Only ever used in the sentence explaining a refusal. */
  underlying: string;
}

/**
 * Either a composed set, or the sentence that says why there is none.
 *
 * A discriminated union rather than `null`, because *every* refusal on this
 * panel has to render as a dash **with its reason** — `docs/reality-check.md`:
 * the absence is the disclosure, and a blank is not one.
 */
export type BoxGreeksResult =
  | {
      readonly ok: true;
      readonly g: SourcedGreeks;
      /** Mean of the four legs' vols. Named as a mean wherever it is printed. */
      readonly vol: number;
      /** The smile's own extent, `[lowest listed strike, highest]`. */
      readonly span: readonly [number, number];
      /** How many of the four legs found a vol the venue published at that very
       *  strike. `4` would mean nothing was borrowed; on this book it is
       *  usually `0`, and the IV row says the borrowing out loud. */
      readonly exact: number;
      readonly years: number;
    }
  | { readonly ok: false; readonly why: string };

/**
 * A drawn box's greeks, composed from its four legs off the published smile.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY {@link ticketGreeks}'S GUARD IS NOT APPLIED HERE, DELIBERATELY
 * ────────────────────────────────────────────────────────────────────────────
 * `ticketGreeks` refuses anything whose `source` is not `model` and anything
 * whose vol was borrowed from a neighbouring strike. Applied to a box it would
 * refuse **every box there will ever be**: a box is `model-composed` by
 * construction, and the venue publishes no IV for a structure at all — 0 of 38
 * listed zones carried one over 32 reads of the live book (`src/data/ranger.ts`).
 * A guard that always fires is not a guard, it is a deletion, and the row it
 * leaves behind is the dash this whole change exists to remove.
 *
 * So the guard is not inherited; it is *re-derived*, because each of its two
 * clauses exists for a reason that is about the parlay ticket rather than about
 * composition:
 *
 *  1. **`source !== "model"`** is there because the parlay ticket renders delta
 *     **as odds** — *"roughly 25% odds of finishing in the money"*. A composed
 *     delta is the net of four vanilla deltas and is not a probability of
 *     anything; rendering one as a percentage is the 88%-on-a-10-delta card
 *     (`docs/greeks.md` §5). **This ticket never renders delta as odds.**
 *     {@link boxGreekRows} prints no percentage, no "chance" and no "odds" on
 *     the delta row, by construction and under test — so the failure that
 *     clause guards against is not spellable on this panel.
 *  2. **`volSource !== "own"`** is there because the parlay ticket puts a
 *     computed greek on the same panel as the venue's **published** delta and
 *     IV, and one strike's published delta beside another strike's borrowed vol
 *     is a provenance muddle no tag makes readable. **This panel carries no
 *     venue-published greek at all** — there is nothing here for a borrowed vol
 *     to be confused with — and the borrowing is stated in words on the IV row
 *     rather than left to a flag a reader never sees.
 *
 * What replaces it is the guard a box actually needs, and it is *stricter* than
 * the smile lookup `src/server/thetanuts.ts` performs on a chain row:
 *
 * **Every leg strike must sit inside the smile's own extent.** Nearest-neighbour
 * *between* two listed strikes is the weakest claim that still produces a
 * number — "this is the closest thing the venue actually said". Nearest
 * neighbour *beyond* the last listed strike is a different animal: it is a flat
 * extrapolation of a curve the venue stopped drawing. The gap is real rather
 * than theoretical — the frozen capture's BTC 5 Sep smile ends at $79,500 while
 * the one listed zone on that column reaches $81,500 — so a box that runs off
 * the end of the smile gets a dash and the sentence naming which strike ran off
 * which end, and never a number.
 *
 * The rest is `src/data/greeks.ts`'s, unchanged: `structureGreeks` returns
 * `null` unless all four legs price, and a `null` set is an absence rather than
 * a partial.
 */
export function boxGreeks(input: BoxGreeksInput): BoxGreeksResult {
  const { strikes, payout, spot, expiry, now, smile, underlying } = input;

  if (spot === null || !(spot > 0)) {
    return {
      ok: false,
      why: `The venue publishes no spot for ${underlying} right now, and every one of these is a rate of change against it.`,
    };
  }

  const years = yearsBetweenMs(now, expiry);
  if (!(years > 0)) {
    return {
      ok: false,
      why: "This expiry has no time left on it. At the last instant a box's risk is a step and a spike rather than four numbers, so none is printed.",
    };
  }

  // Ascending, and only points that are actually points: a zero or negative IV
  // is a zero-filled field rather than a quote, and it would poison a mean.
  const points = [...smile]
    .filter((p) => Number.isFinite(p.strike) && p.strike > 0 && Number.isFinite(p.iv) && p.iv > 0)
    .sort((a, b) => a.strike - b.strike);
  if (points.length === 0) {
    return {
      ok: false,
      why: `The venue published no implied volatility anywhere on this ${underlying} expiry, and a vol is the one input all four of them need.`,
    };
  }

  const lo = points[0]!.strike;
  const hi = points[points.length - 1]!.strike;
  const outside = strikes.find((k) => !(k >= lo && k <= hi));
  if (outside !== undefined) {
    return {
      ok: false,
      why: `The venue's published vol on this expiry runs ${money(lo)}–${money(hi)} and this box has a leg at ${money(outside)}. Reading the smile past its last quote would be our guess rather than the venue's, so nothing here is priced off it.`,
    };
  }

  let exact = 0;
  const vols: number[] = [];
  /** Nearest listed strike, ties to the lower one — the same rule and the same
   *  tie-break as `nearestIv` in `src/server/thetanuts.ts`, so the arena and
   *  the chain cannot disagree about one strike's vol. */
  const volFor = (strike: number): number | null => {
    let best = points[0]!;
    for (const p of points) {
      if (Math.abs(p.strike - strike) < Math.abs(best.strike - strike)) best = p;
    }
    if (best.strike === strike) exact += 1;
    vols.push(best.iv);
    return best.iv;
  };

  const g = structureGreeks({ payout, strikes, spot, years, volFor });
  if (g === null || vols.length === 0) {
    return {
      ok: false,
      why: "These four strikes do not satisfy the venue's own invariants for this product, so the model refuses to decompose them.",
    };
  }

  const vol = vols.reduce((a, b) => a + b, 0) / vols.length;
  if (!(vol > 0)) {
    return {
      ok: false,
      why: "The vols the smile returned are not usable, so nothing was computed from them.",
    };
  }

  return { ok: true, g, vol, span: [lo, hi], exact, years };
}

/**
 * The five rows a box's risk gets — delta, gamma, theta, vega, implied vol, in
 * the order a trader reads them.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT EACH CLAUSE IS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * One clause per row, never a paragraph, and two of the five are *chosen*
 * rather than recited because they are the two things about this instrument
 * that a beginner's intuition gets backwards:
 *
 *  - **A long box sitting inside its band is short gamma, short vega and LONG
 *    theta.** Time passing *helps* you while the price sits in your box, which
 *    is the opposite of the "an option is a wasting asset" rule everybody
 *    learns first. It is also not a claim this file makes — it is the sign the
 *    model returned, so each clause branches on that sign and therefore still
 *    says the true thing about a box drawn nowhere near spot.
 *  - **Delta near zero inside the band** means the position barely cares about
 *    small moves. It cares about where the price *ends up*, which is the whole
 *    of "lands in your box at expiry" and the whole point of drawing a box.
 *
 * **No row here says "odds" or "chance", and none prints a percentage against
 * delta.** A composed delta is a net of four vanilla deltas and is not a
 * probability; see the guard note on {@link boxGreeks}.
 *
 * A refusal collapses to **one** dashed row rather than five, for the reason
 * `liveTicket` collapses its three: five identical dashes carrying one
 * identical sentence is four rows of noise on a panel the owner has already
 * said runs off the bottom of the screen.
 */
export function boxGreekRows(
  res: BoxGreeksResult,
  ctx: {
    underlying: string;
    spot: number | null;
    /** The band that pays in full — `strikes[1]` and `strikes[2]`. */
    floor: number;
    ceiling: number;
  },
): TicketRow[] {
  if (!res.ok) {
    return [
      {
        key: "greeks",
        label: "DELTA · GAMMA · THETA · VEGA · IV",
        value: DASH,
        note: res.why,
        source: null,
      },
    ];
  }

  const { g, vol, span } = res;
  const { underlying, spot, floor, ceiling } = ctx;
  const inside = spot !== null && spot >= floor && spot <= ceiling;
  const perTape = decayOver(g, DUEL_WINDOW.tape);
  const sign = (n: number) => (n < 0 ? MINUS : "");

  return [
    {
      key: "delta",
      label: "DELTA",
      value: `Δ ${sign(g.delta)}${fine(Math.abs(g.delta))} per $1`,
      note: inside
        ? "Near zero inside your box — what matters is where it lands."
        : `About ${money(Math.abs(g.delta))} per $1 ${underlying} moves, net of four legs.`,
      source: "model",
    },
    {
      key: "gamma",
      label: "GAMMA",
      value: `Γ ${sign(g.gamma)}${fine(Math.abs(g.gamma))} per $1`,
      note:
        g.gamma < 0
          ? "Negative inside your box: movement hurts you, stillness helps."
          : `How fast the delta moves — $1 shifts it by ${fine(g.gamma)}.`,
      source: "model",
    },
    {
      // The window is in the label, not left to the note, because this is the
      // number `docs/greeks.md` §1 calls the most dangerous on the screen: the
      // duel clock and the expiry clock differ by 10,800×.
      key: "theta",
      label: "THETA · PER CALENDAR DAY",
      value: money(g.thetaPerDay),
      note:
        g.thetaPerDay > 0
          ? `Positive — waiting pays you while the price sits in your box. Over the duel's ${DUEL_WINDOW.tape}s tape, ${money(perTape)}.`
          : `Waiting costs you: ${money(perTape)} over the duel's ${DUEL_WINDOW.tape}s tape.`,
      source: "model",
    },
    {
      key: "vega",
      label: "VEGA · PER IV POINT",
      value: money(g.vegaPerPoint),
      note:
        g.vegaPerPoint < 0
          ? "Negative: more expected movement makes your box worth less."
          : "What one point of implied volatility is worth, either way.",
      source: "model",
    },
    {
      key: "iv",
      label: "IMPLIED VOL",
      value: `${pct(vol)} · 4-leg mean`,
      note: `The venue's smile here runs ${money(span[0])}–${money(span[1])}; each leg took its nearest listed strike. It is the input the four above need.`,
      source: "derived",
    },
  ];
}

/** `"58.2%"` → `0.582`; anything not written in percent → `null`. The `%` is
 *  required for the reason `parseIv` states in `src/desk/optionize.ts`: a bare
 *  `"0.58"` and a bare `"58"` are indistinguishable, and guessing wrong prints
 *  `IV 0%` or `IV 5800%` beside a real strike. */
function ivOf(raw: string | undefined): number | null {
  const t = String(raw ?? "").trim();
  if (!t.endsWith("%")) return null;
  const n = Number(t.slice(0, -1).replace(/,/g, "").replace(MINUS, "-"));
  return Number.isFinite(n) && n > 0 ? n / 100 : null;
}

/** The venue's signed delta, or `null`. Both minus signs, for the reason
 *  `parseDelta` states: the seeded table writes U+2212 and the live builder
 *  writes `toFixed`'s hyphen. */
function signedDelta(raw: string | undefined): number | null {
  const n = Number(String(raw ?? "").replace(MINUS, "-"));
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The live ticket
// ─────────────────────────────────────────────────────────────────────────────

/** The banner over a market-priced card. It is the one claim the whole panel
 *  rests on, and it is deliberately the narrower half of `OPTIONS_CHIP`. */
export const LIVE_BANNER =
  "A listed contract on the Thetanuts book. Every figure below is the venue's own or is derived from it.";

/** The banner over a card the game wrote. First line of the panel, before any
 *  number, because the failure this whole shape invites is a game figure read
 *  as a quote. */
export const SEEDED_BANNER =
  "Not a quote. No listed option backs this card, so there is nothing here to buy and no premium to pay.";

/** The banner over a slot the book refused to deal. */
export const NOT_DEALT_BANNER =
  "Not dealt. The book carries a chain here but nothing resting in this tier's band, so no contract stands behind this slot.";

/*
 * There used to be a `SAFE_UNFILLABLE` constant here, appended to the footer of
 * every SAFE ticket that had no card — which was every SAFE ticket there was.
 * It read: *"SAFE can never fill: the venue lists only out-of-the-money wings —
 * the largest |delta| on the whole book is 0.50 — and SAFE's band starts at
 * 0.65, so no resting order can reach it."*
 *
 * Every clause of that was true, and it is retired rather than corrected
 * because the condition it described is gone. The venue still lists only OTM
 * wings and the largest listed `|delta|` is still under 0.50 — what changed is
 * the ladder: `TIER_BANDS.SAFE` is `[0.30, 0.50)` now, cut onto the range the
 * book actually quotes, and SAFE fills off live orders like any other tier.
 *
 * It is written down instead of deleted because the sentence was RIGHT, and a
 * future reader who finds an empty SAFE tier should be able to tell this
 * diagnosis apart from a regression. A SAFE slot with no card today means the
 * same thing a DEGEN slot with no card means — nothing rested in that band at
 * that expiry on that side — and {@link NOT_DEALT_BANNER} says exactly that,
 * for all four tiers, with no special case.
 */

/**
 * The trade ticket for a card the book actually dealt.
 *
 * Reads, in order: what the contract is, when it settles, where it sits against
 * spot, what it costs, where it turns a profit, what it can pay, and then the
 * four risk numbers with their windows and their provenance. That order is a
 * broker's, not a teacher's — the money is above the greeks because a player
 * decides on the money.
 */
export function liveTicket(input: CardTicketInput & { card: LiveCard }): Ticket {
  const { card, sym, tier, stance, spot, now } = input;
  const side = stance === "bull" ? "CALL" : "PUT";
  const abbr = stance === "bull" ? "C" : "P";
  const g = ticketGreeks(card.row.greeks);
  const iv = ivOf(card.row.iv);
  const delta = signedDelta(card.row.delta) ?? (stance === "bull" ? card.prob : -card.prob);
  const breakeven =
    stance === "bull" ? card.strikeAt + card.premium : card.strikeAt - card.premium;
  const winAt = card.premium * card.payoutMult;
  const msLeft = card.expiryAt * 1000 - now;
  const gap = spot > 0 ? (card.strikeAt - spot) / spot : Number.NaN;

  const rows: TicketRow[] = [
    {
      key: "contract",
      label: "CONTRACT",
      value: `${sym} ${money(card.strikeAt)} ${side} · 1 contract`,
      note:
        stance === "bull"
          ? `A long call: it pays whatever ${sym} is worth above ${money(card.strikeAt)} at expiry, quoted per one ${sym} of exposure.`
          : `A long put: it pays whatever ${sym} is worth below ${money(card.strikeAt)} at expiry, quoted per one ${sym} of exposure.`,
      source: "venue",
    },
    {
      key: "expiry",
      label: "EXPIRY",
      value: `${expiryStamp(card.expiryAt)} · ${timeLeft(msLeft)} left`,
      note: "European and cash-settled — only the price at that moment decides it, and it settles in cash, not coins.",
      source: "venue",
    },
    {
      key: "moneyness",
      label: "SPOT · MONEYNESS",
      value:
        spot > 0
          ? `${money(spot)} · ${moneyness(stance, card.strikeAt, spot)} · ${pct(Math.abs(gap))} to the strike`
          : DASH,
      note:
        spot > 0
          ? `${sym} sits ${pct(Math.abs(gap))} ${gap > 0 ? "below" : "above"} the strike right now.`
          : "The book carried no spot for this underlying, so the distance to the strike cannot be stated.",
      source: spot > 0 ? "venue" : null,
    },
    {
      key: "maxLoss",
      label: "PREMIUM · MAX LOSS",
      value: `${money(card.premium)} per contract`,
      note: "The ask you pay, and the whole of what you can lose — nothing beyond it is at risk.",
      source: "venue",
    },
    {
      key: "breakeven",
      label: "BREAKEVEN",
      value: money(breakeven),
      note:
        stance === "bull"
          ? "Strike plus premium: below this at expiry the contract returns less than it cost."
          : "Strike minus premium: above this at expiry the contract returns less than it cost.",
      source: "derived",
    },
    {
      key: "maxPayout",
      label: "MAX PAYOUT",
      value: stance === "bull" ? "uncapped" : `${money(card.strikeAt - card.premium)} per contract`,
      note:
        stance === "bull"
          ? `A long call has no ceiling — every dollar ${sym} finishes above the strike is a dollar to you.`
          : `A long put's ceiling is its own strike, reached only if ${sym} went to zero.`,
      source: "derived",
    },
    {
      key: "reference",
      label: `PAYOUT AT ±${Math.round(REFERENCE_MOVE * 100)}%`,
      value: `${money(winAt)} per contract`,
      note: `What one contract returns if ${sym} finishes ${Math.round(REFERENCE_MOVE * 100)}% away — this build's stated reference move, not a forecast.`,
      source: "derived",
    },
    {
      key: "delta",
      label: "DELTA",
      // Printed at the precision the row actually carries, trailing zeros
      // trimmed. `PricingRow.delta` is `toFixed(2)` (`docs/greeks.md` §6), so
      // rendering four decimals on it would claim two digits the venue's
      // display string never had.
      value: `Δ ${delta < 0 ? MINUS : ""}${+Math.abs(delta).toFixed(4)}`,
      note: `Roughly ${Math.round(card.prob * 100)}% odds of finishing in the money, and about ${money(Math.abs(delta))} of every dollar ${sym} moves — ${tier} is the band ${bandLabel(tier)}, which is why this card is in it.`,
      source: "venue",
    },
  ];

  if (g) {
    const perTape = decayOver(asGreeks(g), DUEL_WINDOW.tape);
    rows.push(
      {
        key: "gamma",
        label: "GAMMA",
        value: `Γ ${fine(g.gamma)} per $1`,
        note: `How fast the delta itself moves: one dollar on ${sym} shifts it by ${fine(g.gamma)}.`,
        source: "model",
      },
      {
        key: "theta",
        label: "THETA",
        value: `${money(g.thetaPerDay)} per calendar day`,
        note: `What waiting costs with everything else still — over the duel's ${DUEL_WINDOW.tape}-second tape the same rate is ${money(perTape)}.`,
        source: "model",
      },
      {
        key: "vega",
        label: "VEGA",
        value: `${money(g.vegaPerPoint)} per IV point`,
        note: "What one point of implied volatility is worth to you, in either direction, with no view on price.",
        source: "model",
      },
    );
  } else {
    rows.push({
      key: "greeks",
      label: "GAMMA · THETA · VEGA",
      value: DASH,
      note: "The venue published no implied volatility at this exact strike, so nothing was priced off it — a neighbour's vol would be a guess wearing a decimal point.",
      source: null,
    });
  }

  rows.push({
    key: "iv",
    label: "IMPLIED VOL",
    value: iv === null ? DASH : pct(iv),
    note:
      iv === null
        ? "None published for this strike. It is the input every computed figure needs, which is why their absence follows its own."
        : "The annualised movement the market is pricing in, and the input the three figures above were computed from.",
    source: iv === null ? null : "venue",
  });

  return {
    id: input.id,
    state: "live",
    title: instrumentName(sym, card.expiryAt, card.strikeAt, abbr),
    subtitle: `${tier} · ${bandLabel(tier)} · resting order on Thetanuts, Base 8453`,
    banner: LIVE_BANNER,
    rows,
    footer: [
      g
        ? "Strike, expiry, ask, delta and implied vol are the venue's, read off the resting order. Gamma, theta and vega are computed here — Black–Scholes on that same published vol, at this exact strike."
        : "Strike, expiry, ask, delta and implied vol are the venue's, read off the resting order. Nothing on this row was modelled.",
      SETTLEMENT_NOTE,
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The seeded ticket
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ticket for a slot with no contract behind it — the seeded card, and the
 * dealt-but-empty slot.
 *
 * **It is a different ticket, not the live one with dashes in it.** Every row
 * whose figure is missing says what that figure *does* when it exists, which is
 * the teaching the owner asked for, and none of them prints a number that could
 * be mistaken for a quote. The one figure the seeded card really does carry —
 * the tier's band midpoint — is labelled as exactly that, on the row where a
 * live card would print a delta, because that substitution is the single most
 * misreadable thing on this screen.
 */
export function seededTicket(input: CardTicketInput): Ticket {
  const { sym, tier, stance, leg, spot, reason } = input;
  const dealt = reason === "not-dealt";
  const [lo, hi] = TIER_BANDS[tier];
  const side = stance === "bull" ? "call" : "put";

  const rows: TicketRow[] = [
    {
      key: "contract",
      label: "CONTRACT",
      value: DASH,
      note: `A real ticket names one listed strike, one expiry and one side — a ${sym} ${side}. Nothing on the book stands behind this slot, so there is none to name.`,
      source: null,
    },
    {
      key: "line",
      label: "THE GAME'S LINE",
      value: `${sym} ${stance === "bull" ? "above" : "below"} ${money(leg.strike)}`,
      note:
        spot > 0
          ? `Struck off this build's seeded ${money(leg.px)} reference, not off the live ${money(spot)} — it is a line, not a strike.`
          : `Struck off this build's seeded ${money(leg.px)} reference — it is a line, not a strike.`,
      source: "game",
    },
    {
      key: "expiry",
      label: "EXPIRY",
      value: DASH,
      note: "Nothing was bought, so nothing expires. The duel settles on the seeded eight-second tape instead.",
      source: null,
    },
    {
      key: "maxLoss",
      label: "PREMIUM · MAX LOSS",
      value: DASH,
      note: "On a real card this is the ask you pay and the whole of your risk. Nothing priced this one, so there is no figure to print.",
      source: null,
    },
    {
      key: "breakeven",
      label: "BREAKEVEN",
      value: DASH,
      note: "The strike moved by the premium paid — without a premium there is nothing to move it by.",
      source: null,
    },
    {
      key: "maxPayout",
      label: "MAX PAYOUT",
      value: DASH,
      note: "A long call is uncapped above its breakeven and a long put's ceiling is its strike. Neither can be stated without a contract.",
      source: null,
    },
    {
      key: "delta",
      label: "CHANCE ON THE FACE",
      value: `${chancePct(leg.prob)} · band midpoint`,
      note: `${tier} is the |delta| band ${lo.toFixed(2)}–${hi.toFixed(2)} and this is its midpoint — the game's label for the tier, and not any option's delta.`,
      source: "game",
    },
    {
      key: "greeks",
      label: "GAMMA · THETA · VEGA",
      value: DASH,
      note: "Delta, gamma, theta and vega are properties of a listed contract. There is no contract here to have them.",
      source: null,
    },
    {
      key: "iv",
      label: "IMPLIED VOL",
      value: DASH,
      note: "Published per listed strike. Nothing was published for a line the venue does not quote.",
      source: null,
    },
  ];

  const why =
    reason === "no-book"
      ? "No live Thetanuts book reached this screen, so every ticker on it is seeded."
      : reason === "no-chain"
        ? `The book reached this screen but carries no option chain for ${sym}, so its cards are the game's.`
        : `The book carries a chain for ${sym}, but no resting ${side} falls in ${tier}'s band at this expiry — so this slot was not dealt. A card that always exists is the tell that the odds are house-set.`;

  // No per-tier special case. SAFE used to get an extra sentence here saying it
  // could never fill; see the note under `NOT_DEALT_BANNER` for why that is no
  // longer true and why the sentence is quoted there rather than deleted.
  const footer = [why];
  footer.push(
    "Seeded strike, seeded odds, simulated settlement. You are not holding a position and nothing here is spent.",
  );

  return {
    id: input.id,
    state: dealt ? "not-dealt" : "seeded",
    title: `${sym} · ${tier} · ${stance === "bull" ? "BULLISH" : "BEARISH"}`,
    subtitle: `${tier} · ${bandLabel(tier)} · no contract behind this slot`,
    banner: dealt ? NOT_DEALT_BANNER : SEEDED_BANNER,
    rows,
    footer,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The field note — one figure's definition, on the ticket's own panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What one figure *means*, shaped as a {@link Ticket} so it rides the panel and
 * the interaction that already exist.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY A TICKET AND NOT A NEW TOOLTIP
 * ────────────────────────────────────────────────────────────────────────────
 * The owner asked for the arena panel's prose to move behind a per-figure `ⓘ`.
 * The temptation is a small second tooltip — a `title` attribute, or forty
 * lines of `onMouseEnter` — and it would be the third hover mechanism in this
 * app and the only one without a settle delay, a keyboard path, a touch path,
 * an Escape, a viewport flip or `role="tooltip"`. `useTradeTicket` has all six.
 * So a field note is not a new kind of thing: it is a `Ticket` with no rows, no
 * footer and one paragraph, and `TradeTicketPanel` renders it unchanged.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT MAY GO IN ONE, AND WHAT MAY NOT
 * ────────────────────────────────────────────────────────────────────────────
 * **Teaching only.** A field note holds definitions — what a premium is, what a
 * wing pays, what "size" scales. It is timeless: nothing in it may depend on
 * what this build priced, what the book listed, what this screen is capped at,
 * or why a figure is a dash. Those are *disclosures*, they are the reason a
 * player would act differently, and `docs/reality-check.md` does not let them
 * sit behind a gesture a player may never perform. They stay on the panel.
 *
 * The line is easy to state and easy to get wrong, so the test for it is: would
 * this sentence still be true on a different venue, on a different day, with a
 * different box? If yes it is teaching. If it names a price, a cap, a build or
 * an absence, it is disclosure and it stays visible.
 *
 * There is no `source` tag anywhere on a field note, because there is no figure
 * on it to have a provenance. That is not an omission — a definition is nobody's
 * quote.
 */
export interface FieldNoteInput {
  /** `box:maxLoss`. Becomes the panel's `id` and the trigger's
   *  `aria-describedby`, so it has to be unique on the screen. */
  id: string;
  /** The figure's own heading, verbatim — `MAX LOSS`. The note is titled with
   *  it so an opened panel names the thing it is about rather than floating
   *  free beside a column of similar figures. */
  label: string;
  /** One paragraph per entry. The first is the banner; the rest follow it. */
  lines: readonly string[];
}

export function fieldNote(input: FieldNoteInput): Ticket {
  const [first, ...rest] = input.lines;
  return {
    id: input.id,
    state: "note",
    title: input.label,
    // Said out loud, because the same panel shape carries live quotes three
    // rows away on the parlay screen and a reader has learned to read it as
    // one. This one is not a quote and is not about this box.
    subtitle: "WHAT THIS FIGURE MEANS",
    banner: first ?? "",
    body: rest,
    rows: [],
    footer: [],
  };
}

/** The one entry point a view needs: the card's ticket, whichever path dealt
 *  it. Kept as a single function so a caller cannot pick the wrong ticket for
 *  the state it is in — the choice is made here, once, off `card`. */
export function cardTicket(input: CardTicketInput): Ticket {
  return input.card === null
    ? seededTicket(input)
    : liveTicket({ ...input, card: input.card });
}

/** Exported for the tests that assert the duel window is never the day window.
 *  `DUEL_WINDOW.day` is `SECONDS_PER_YEAR / 365` by construction. */
export const CLOCK_RATIO = DUEL_WINDOW.day / DUEL_WINDOW.tape;
export { SECONDS_PER_YEAR };
