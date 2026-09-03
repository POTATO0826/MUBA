import { seededRandom } from "../engine/spin.ts";
import { TAPE_LEN, pctAt } from "../engine/tape.ts";
import { meta } from "./universe.ts";

/**
 * The case study's reading material: a news line per ticker and a short
 * exchange from the desk. Picked from a pool by the match seed, so the same
 * link shows the same brief — and shaped by which way the study window
 * actually went, so the news never contradicts the chart beside it.
 */

export interface Brief {
  kind: "news" | "desk";
  /** News lines carry the ticker they are about. */
  sym?: string;
  /** Desk lines carry who said them. */
  who?: string;
  text: string;
}

type Line = (sym: string, sector: string) => string;

const UP: readonly Line[] = [
  (s, sec) => `${s} gaps higher as the ${sec} bid returns. Dealers are short gamma into the print.`,
  (s) => `${s}: guidance raised, street chases. Call skew is the richest it has been this quarter.`,
  (s, sec) => `Rotation into ${sec} lifts ${s} for a third session. The put wing is being sold to fund it.`,
  (s) => `${s} breaks the range to the upside on volume. Rangers on the old band are underwater.`,
];

const DOWN: readonly Line[] = [
  (s, sec) => `${s} slips on ${sec} rotation. The put wing is where the flow is.`,
  (s) => `${s}: downgrade cycle starts. Front-expiry puts trade through their theoretical.`,
  (s, sec) => `${s} bleeds with the rest of ${sec}. Realised vol is running above implied — a rare gift.`,
  (s) => `${s} loses the level everyone was watching. Dealers long gamma here, so the tape chops.`,
];

const DESK: readonly (readonly { who: string; text: string }[])[] = [
  [
    { who: "DESK", text: "Vol is bid across the board, but only the front expiry." },
    { who: "COACH", text: "Then the tape is pricing an event. Don't fade it with a SAFE line." },
  ],
  [
    { who: "DESK", text: "Skew is flat on the majors and steep on everything else." },
    { who: "COACH", text: "Flat skew means the market has no view. That is where an EVEN parlay earns its odds." },
  ],
  [
    { who: "DESK", text: "Three of these names trended the whole window. One chopped." },
    { who: "COACH", text: "A trending name at a SHARP line is a fair trade. A chopping one at a SHARP line is a donation." },
  ],
  [
    { who: "DESK", text: "Open interest is stacked at the round numbers." },
    { who: "COACH", text: "Pinning risk. Wide lines survive a pin; tight ones die on it." },
  ],
];

/** One news line per ticker, then a desk exchange. */
export function briefsFor(syms: readonly string[], salt: number): readonly Brief[] {
  const random = seededRandom(salt * 131 + syms.length);
  const news: Brief[] = syms.map((sym) => {
    const up = pctAt(sym, salt, TAPE_LEN) >= 0;
    const pool = up ? UP : DOWN;
    const line = pool[Math.floor(random() * pool.length)]!;
    return { kind: "news", sym, text: line(sym, meta(sym).sector.toLowerCase()) };
  });
  const exchange = DESK[Math.floor(random() * DESK.length)]!;
  return [...news, ...exchange.map((d) => ({ kind: "desk" as const, who: d.who, text: d.text }))];
}
