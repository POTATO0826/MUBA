import type { Geometry } from "../types.ts";
import { meta } from "../data/universe.ts";

/** Number of prints in one generated tape. */
export const TAPE_LEN = 200;

/** Cache keyed `sym:salt:open`. The walk is fully seeded, so a given key always
 *  produces the same tape — that is what lets the study screen and the fight
 *  screen draw *different* windows on the same ticker (different salts) while
 *  each stays stable across re-renders.
 *
 *  `open` joined the key when the opening print became an argument. It has to
 *  be there: two rooms on the same seed but different captured opens are two
 *  different tapes, and a key that could not tell them apart would serve the
 *  second room the first room's prices. The cache stays unbounded, as it always
 *  was — a client holds one room at a time and the server holds at most
 *  `MAX_ROOMS`, so the extra dimension is bounded in practice by the same
 *  things that bound the salt dimension. */
const seriesCache = new Map<string, readonly number[]>();

/**
 * Seeded random walk of `TAPE_LEN` prints, opening on `openPx`.
 *
 * ## Why the open is an argument and the walk is not
 *
 * The walk is a legitimate simulation and it stays: both seats must watch the
 * same tape, and a *forward* price path that two machines can each compute from
 * one shared integer, with no message passing and no clock, is exactly what a
 * seed buys. `test/determinism.test.ts` exists to protect that.
 *
 * The *opening print* was never part of that guarantee, and for a long time it
 * was `meta(sym).px` — an eighteen-row fixture written when ETH was $4,182.60.
 * By September 2026 that number was 70% above the live print, so the tape drew
 * a walk starting from a price no venue had quoted in two years, and the duel's
 * legs read `ETH closes above 4,392` beside a live spot of $2,453. The owner's
 * question — *"why still have so many baked in hard coded data when u can fetch
 * every 30s?"* — is about this line.
 *
 * ## Why this is safe for settlement
 *
 * The walk is **multiplicative**: `out[i] = out[i-1] * (1 + drift + shock)`,
 * and neither `drift` nor `shock` reads `out`. So the whole tape is
 * `open × Π(1 + drift + shock_i)`, and every *ratio* on it — which is all
 * {@link pctAt} returns, and `pctAt` is all `engine/match.ts` settles on — is
 * independent of `open`. Changing the opening print rescales the chart and
 * changes nothing about who wins. That is a property of the arithmetic, not a
 * promise: `test/roomopen.test.ts` asserts it to twelve decimal places against
 * real Base prints, for every board asset and three salts. The floor below is
 * the one operation that is not a multiplication, which is why it had to become
 * proportional before any of this was true — see the comment on it.
 *
 * ## The contract on `openPx`
 *
 * It is a value the caller **already read** — captured once, at room creation,
 * and frozen into the room (`RoomView.open`, `src/data/room.ts`) so both seats
 * derive from one number. This function fetches nothing and may not: the
 * determinism source scan forbids `src/engine/**` from naming a market source,
 * and it is right to. A live read *here* would give the two seats two different
 * tapes thirty seconds apart, which is the failure the shared seed exists to
 * prevent.
 *
 * Omitted, or not a finite positive number, it falls back to `meta(sym).px` —
 * the frozen reference. That default is what keeps every existing call site and
 * every value lock in `test/determinism.test.ts` byte-identical. **A caller
 * taking that fallback is showing a reference price, not a live one, and owes
 * the screen a label saying so** — `openFor()` in `src/data/room.ts` returns the
 * price and that fact together for exactly this reason.
 */
export function series(sym: string, salt: number, openPx?: number): readonly number[] {
  const u = meta(sym);
  const open =
    typeof openPx === "number" && Number.isFinite(openPx) && openPx > 0 ? openPx : u.px;
  const key = `${sym}:${salt}:${open}`;
  const hit = seriesCache.get(key);
  if (hit) return hit;

  let s = 0;
  for (let i = 0; i < sym.length; i++) s = (s * 31 + sym.charCodeAt(i)) >>> 0;
  s = (s + salt * 7919) >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };

  const drift = (rand() - 0.45) * 0.0022;
  const out: number[] = [open];
  for (let i = 1; i < TAPE_LEN; i++) {
    const shock = (rand() - 0.5) * 2 * u.vol;
    // The floor is PROPORTIONAL, and it used to be the absolute number `1`.
    //
    // That absolute floor was written for a board whose cheapest name was
    // $0.84, and it silently clamped anything cheaper: measured on `fightSalt`
    // for seed 424242, PEPE clamped 4 of 200 prints and reported a +11,817,066%
    // move, DOGE clamped 21 and reported +1,005%, ARB clamped 8 and reported
    // +75%. A leg is settled off exactly that percentage, so those were three
    // wrong answers hiding behind a guard clause — the same shape as every bug
    // in `docs/reality-check.md`: a number that meant something other than what
    // it claimed.
    //
    // It became reachable the moment the opening print became real. XRP's
    // reference is $1.45 and it clears the old floor; XRP's *live* print is
    // $1.399 and it does not, so threading a true price into a QUALIFIED asset
    // would have started clamping a tape that had never clamped before — and
    // the clamp is the one operation in this loop that is not multiplicative,
    // so it is also the one thing that could have made settlement depend on the
    // open. `test/roomopen.test.ts` catches exactly that and caught exactly it.
    //
    // Proportional restores the invariant: scaling `open` by λ scales both
    // arguments of the `max` by λ, so every ratio still cancels the open
    // exactly, for every asset at any price. The multiplier is also chosen not
    // to fire at all — `1 + drift + shock` is bounded below by about 0.9 for
    // every `vol` on either board, so 200 steps cannot travel nine orders of
    // magnitude and the walk cannot reach zero on its own. This is a guard
    // against a future `vol`, not a correction to this one.
    out.push(Math.max(open * 1e-9, out[i - 1]! * (1 + drift + shock)));
  }

  seriesCache.set(key, out);
  return out;
}

/**
 * How much of a generated tape a card is drawing, said in the only unit the
 * tape has: prints.
 *
 * ## What this replaced, and why it had to go
 *
 * Until now this file exported `windowLabel(sym, salt)`, which hashed the
 * ticker and the salt into a month and a year in 2017–2024 and printed the
 * result as `OCT 2013 · JAN 2014` under the chart. Nothing about that was true.
 * The tape is a seeded forward walk opening on a reference or live price; it is
 * not any asset's price in any period, and the label named a period anyway. The
 * owner's screenshot caught it in the most obvious possible form — `AVAX · JUN
 * 2017 · SEP 2017`, eighteen months before Avalanche existed — and
 * `docs/reality-check.md` §5.10 had already recorded the same shape on the wire
 * beside it. Its own docblock called it "a plausible three-month historical
 * window", which is the tell: plausible is what a fabrication is.
 *
 * The seeded wire fixture reproduced the identical hash to date its stories
 * inside that invented window, so the two agreed with each other and the
 * fabrication was *internally consistent*. That made it more convincing, not
 * less. Both are gone; the fixture now files its session on a real calendar day.
 *
 * (That fixture is named in prose rather than by path, and so is the live news
 * module. The source scan in `test/determinism.test.ts` greps this file for a
 * short list of live-data module paths, and it cannot tell a comment from an
 * import — a scan that could would be one refactor away from missing a real
 * one. Writing either path out here fails the guard, correctly.)
 *
 * ## What this says instead
 *
 * The literal truth and nothing past it: which prints of the generated walk are
 * on screen, out of how many the walk has. `PRINTS 51–110 OF 200`. There is no
 * date because there is no date to give, and the reader is told the resolution
 * they are looking at rather than being sold a period the data cannot support —
 * which also happens to be exactly what a zoom control needs to print.
 *
 * The mode's simulated duration ("24 HOURS") is a *separate* and genuinely true
 * statement, and it stays where it already lived: on the mode badge, and on the
 * study screen's zoom readout. It is a declared rule of the game, not a claim
 * about history, and it must not be folded in here — a card that said `6H` with
 * no other context would be one refactor away from being read as a date again.
 *
 * `from` is 0-indexed into the tape; the label prints 1-indexed prints, because
 * "print 1" is the opening print and there is no print zero on a tape.
 */
export function spanLabel(from: number, count: number, total: number = TAPE_LEN): string {
  const a = Math.max(1, Math.floor(from) + 1);
  const b = Math.max(a, Math.min(total, Math.floor(from) + Math.floor(count)));
  return `PRINTS ${a}–${b} OF ${total}`;
}

/** Price formatting that stays readable from PEPE (1.12e-5) to BTC (96,410). */
export function fmtPx(v: number): string {
  if (v < 0.001) return v.toExponential(2);
  if (v < 1) return v.toFixed(4);
  if (v < 1000) return v.toFixed(2);
  return Math.round(v).toLocaleString("en-US");
}

/**
 * Sparkline geometry for `count` prints of `data` starting at `from`, scaled
 * into a `w × h` box.
 *
 * The x-axis is normalised to `count`, so the plotted line always spans the full
 * width and the head sits at the right edge. During the live fight `count` grows
 * every tick: the chart keeps filling the card and gains resolution rather than
 * creeping in from the left. The y-axis rescales to the plotted slice only, which
 * is why an early window looks as dramatic as a finished one.
 *
 * ## `from`, and why it can only ever be a camera
 *
 * `from` is the study screen's zoom: the player asks for the last eighth of the
 * window and this draws prints 97–110 instead of 1–110. It **selects existing
 * prints and does nothing else**. It cannot resample, cannot interpolate and
 * cannot invent resolution the tape does not have — a 14-print slice stretched
 * across 260 units is fourteen real prints joined by thirteen straight
 * segments, and the card says "PRINTS 97–110 OF 200" beside it so the reader
 * knows that is what they are looking at. The moment this function grew a
 * smoothing pass it would start drawing prices nothing generated, which is the
 * same class of thing as the invented date label this file just lost.
 *
 * The dashed baseline follows the slice rather than the tape: `baseY` is the
 * *plotted* opening print. A zoomed card whose baseline stayed pinned to print 1
 * would draw a reference line outside its own y-range, or worse, inside it and
 * meaning nothing. At `from = 0` — every existing caller — the two are the same
 * number and this is a no-op.
 */
export function geom(
  data: readonly number[],
  count: number,
  w: number,
  h: number,
  pad: number,
  from = 0,
): Geometry {
  const span = Math.max(2, count);
  const start = Math.max(0, Math.min(Math.max(0, data.length - 2), Math.floor(from)));
  const pts = data.slice(start, start + span);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pts) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const range = hi - lo || 1;
  const X = (i: number) => (i / (span - 1)) * w;
  const Y = (v: number) => h - pad - ((v - lo) / range) * (h - pad * 2);

  const path = "M" + pts.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("L");
  const last = pts[pts.length - 1] ?? lo;

  return {
    path,
    fill: `${path}L${X(pts.length - 1).toFixed(1)},${h}L0,${h}Z`,
    baseY: Y(pts[0] ?? lo).toFixed(1),
    headX: X(pts.length - 1).toFixed(1),
    headY: Y(last).toFixed(1),
    last,
  };
}

/**
 * Percentage move from the tape's open to print `pos` (1-indexed).
 *
 * `openPx` is forwarded to {@link series} and has **no effect on the number
 * returned** — the walk is multiplicative, so this ratio cancels the open
 * exactly, which is the property that lets a real opening price be threaded in
 * without moving a single settlement. `test/roomopen.test.ts` asserts it to
 * twelve decimal places against live prints.
 *
 * It is still worth passing, for one reason: it decides *which cached tape this
 * reads*. Called without it while the chart beside it draws the live-open tape,
 * this builds and keeps a second, seeded-open tape with identical ratios — the
 * same answer off a different array. Passing it keeps one tape per room.
 */
export function pctAt(sym: string, salt: number, pos: number, openPx?: number): number {
  const s = series(sym, salt, openPx);
  const open = s[0]!;
  const p = s[Math.max(0, Math.min(s.length - 1, pos - 1))]!;
  return ((p - open) / open) * 100;
}
