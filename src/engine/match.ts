import type { Leg, LegOutcome } from "../types.ts";
import { meta } from "../data/universe.ts";
import { TAPE_LEN, pctAt } from "./tape.ts";

/** Whether a leg is winning as of print `pos` on the fight tape. */
export function legState(leg: Leg, salt: number, pos: number): LegOutcome {
  const pct = pctAt(leg.sym, salt, pos);
  const won = leg.dir === "over" ? pct >= leg.t : pct <= -leg.t;
  return { pct, won };
}

export function scoreOf(legs: readonly Leg[], salt: number, pos: number): number {
  return legs.filter((l) => legState(l, salt, pos).won).length;
}

/** Tie-break metric: total absolute move across the legs that actually landed,
 *  measured at print `end` — the mode's settle print, the whole tape by default.
 *  Bigger conviction takes the pool. */
export function edgeOf(legs: readonly Leg[], salt: number, end: number = TAPE_LEN): number {
  return legs.reduce((acc, l) => {
    const st = legState(l, salt, end);
    return acc + (st.won ? Math.abs(st.pct) : 0);
  }, 0);
}

/** Second tie-break: signed travel in each leg's own direction, counted whether
 *  the leg cleared its target or not. An over leg banks its move, an under leg
 *  banks the negative of it, so a book that was right about direction and short
 *  of the line still outranks one that was simply wrong.
 *
 *  Short windows make 0–0 common, and at 0–0 every `edgeOf` is 0 — without this
 *  the first tie-break hands every scoreless duel to P1. */
export function driftOf(legs: readonly Leg[], salt: number, end: number = TAPE_LEN): number {
  return legs.reduce((acc, l) => {
    const { pct } = legState(l, salt, end);
    return acc + (l.dir === "over" ? pct : -pct);
  }, 0);
}

export interface PlayerRead {
  who: string;
  /** e.g. `"Hedged book · balanced"`. */
  style: string;
  read: string;
  won: boolean;
}

/** Rule-based commentary over one slip — no model call, just the slip's own shape
 *  plus how the tape treated it. */
export function readPlayer(
  who: string,
  legs: readonly Leg[],
  salt: number,
  score: number,
  won: boolean,
  end: number = TAPE_LEN,
): PlayerRead {
  const settled = legs.map((l) => ({ ...l, st: legState(l, salt, end) }));
  const overs = legs.filter((l) => l.dir === "over").length;
  const unders = legs.length - overs;

  const sectors: string[] = [];
  for (const l of legs) {
    const s = meta(l.sym).sector;
    if (!sectors.includes(s)) sectors.push(s);
  }

  const avgT = legs.reduce((a, l) => a + l.t, 0) / Math.max(1, legs.length);
  const cryptoN = legs.filter((l) => meta(l.sym).mkt === "CRYPTO").length;

  const shape =
    overs === legs.length ? "All-in bull" : unders === legs.length ? "All-in bear" : "Hedged book";
  const risk = avgT >= 6 ? "high-variance" : avgT >= 3 ? "balanced" : "grinder";

  const biggest = [...settled].sort((a, b) => Math.abs(b.st.pct) - Math.abs(a.st.pct))[0];
  const nearMiss = [...settled]
    .filter((l) => !l.st.won)
    .sort((a, b) => Math.abs(Math.abs(a.st.pct) - a.t) - Math.abs(Math.abs(b.st.pct) - b.t))[0];

  let read =
    `${who} ran a ${risk} ${shape.toLowerCase()}: ${overs} over, ${unders} under across ` +
    `${sectors.length} ${sectors.length === 1 ? "sector" : "sectors"}` +
    (cryptoN ? ` with ${cryptoN} crypto leg${cryptoN > 1 ? "s" : ""}` : "") +
    `, average target ±${avgT.toFixed(1)}%. `;

  if (biggest) {
    read +=
      `${biggest.sym} was the biggest mover at ${biggest.st.pct >= 0 ? "+" : ""}` +
      `${biggest.st.pct.toFixed(1)}%` +
      (biggest.st.won ? ", and it paid. " : ", but it went the wrong way. ");
  }

  if (won) {
    read += `Cashed ${score} of ${legs.length} legs and took the pool.`;
  } else if (nearMiss) {
    read +=
      `${nearMiss.sym} missed by ${Math.abs(Math.abs(nearMiss.st.pct) - nearMiss.t).toFixed(1)}` +
      ` points — the leg that cost the match.`;
  }

  return { who, style: `${shape} · ${risk}`, read, won };
}

export interface MatchVerdict {
  myScore: number;
  oppScore: number;
  myEdge: number;
  oppEdge: number;
  /** Second tie-break, decided only when the edges are dead level. */
  myDrift: number;
  oppDrift: number;
  tied: boolean;
  meWins: boolean;
  winner: string;
  winnerVerb: string;
  scoreLine: string;
  myRead: PlayerRead;
  oppRead: PlayerRead;
  decider: string;
  lesson: string;
}

/** Settle the duel and generate the coach's post-match summary. */
export function settle(
  myLegs: readonly Leg[],
  oppLegs: readonly Leg[],
  arena: readonly string[],
  salt: number,
  pos: number,
  p1Name: string,
  oppName: string,
): MatchVerdict {
  const myScore = scoreOf(myLegs, salt, pos);
  const oppScore = scoreOf(oppLegs, salt, pos);
  const myEdge = edgeOf(myLegs, salt, pos);
  const oppEdge = edgeOf(oppLegs, salt, pos);
  const myDrift = driftOf(myLegs, salt, pos);
  const oppDrift = driftOf(oppLegs, salt, pos);

  const tied = myScore === oppScore;
  // Conviction first, raw travel second. The drift arm only fires when the two
  // books landed the exact same points on won legs — which at 0–0 is always.
  const meWins =
    myScore > oppScore ||
    (tied && (myEdge !== oppEdge ? myEdge > oppEdge : myDrift >= oppDrift));
  const winner = meWins ? p1Name : oppName;

  const myRead = readPlayer(p1Name, myLegs, salt, myScore, meWins, pos);
  const oppRead = readPlayer(oppName, oppLegs, salt, oppScore, !meWins, pos);
  const winRead = meWins ? myRead : oppRead;
  const loseRead = meWins ? oppRead : myRead;

  const upN = arena.filter((s) => pctAt(s, salt, pos) > 0).length;
  const tapeBias =
    upN >= arena.length - 1
      ? "a broadly bullish tape"
      : upN <= 1
        ? "a broadly bearish tape"
        : "a mixed tape";

  // Level on conviction means nobody cashed a leg, or both cashed identically.
  // Either way the sentence has to explain the axis that actually decided it.
  const tieDetail =
    myEdge !== oppEdge
      ? `${winRead.who}’s won legs moved ${(meWins ? myEdge : oppEdge).toFixed(1)} points ` +
        `combined against ${(meWins ? oppEdge : myEdge).toFixed(1)} for ${loseRead.who}.`
      : `neither book had the edge on won legs, so it fell to raw travel — ` +
        `${winRead.who}’s slip drifted ${(meWins ? myDrift : oppDrift).toFixed(1)} points ` +
        `its own way against ${(meWins ? oppDrift : myDrift).toFixed(1)} for ${loseRead.who}.`;

  const decider =
    `The window drew ${tapeBias} (${upN} of ${arena.length} assets closed up). ` +
    (tied
      ? `Both slips cashed ${myScore} leg${myScore === 1 ? "" : "s"}, so it went to conviction: ` +
        tieDetail
      : `${winRead.who}’s ${winRead.style.split(" · ")[0]!.toLowerCase()} lined up with it; ` +
        `${loseRead.who}’s ${loseRead.style.split(" · ")[0]!.toLowerCase()} needed the opposite ` +
        `drift. Final legs ${Math.max(myScore, oppScore)}–${Math.min(myScore, oppScore)}.`);

  const lesson = loseRead.style.startsWith("All-in")
    ? "Three legs the same direction is one bet in three coats. Splitting one leg the other way keeps a wrong-way tape from wiping the slip."
    : loseRead.style.includes("high-variance")
      ? "Targets above ±6% only pay on outlier windows. Bank one low-target grinder leg so a quiet tape still scores."
      : "Draft for the tape, not the ticker: ban the highest-vol name your opponent could ride, then read the study charts for drift before picking direction.";

  const tieNote = tied
    ? ` · tied ${myScore}–${oppScore}, broken on conviction (` +
      (myEdge !== oppEdge
        ? `${(meWins ? myEdge : oppEdge).toFixed(1)} vs ${(meWins ? oppEdge : myEdge).toFixed(1)} pts on won legs)`
        : `${(meWins ? myDrift : oppDrift).toFixed(1)} vs ${(meWins ? oppDrift : myDrift).toFixed(1)} pts of drift)`)
    : " · winner takes the pool";

  return {
    myScore,
    oppScore,
    myEdge,
    oppEdge,
    myDrift,
    oppDrift,
    tied,
    meWins,
    winner,
    winnerVerb: winner === "You" ? "take" : "takes",
    scoreLine: `${myScore} leg${myScore === 1 ? "" : "s"} vs ${oppScore}${tieNote}`,
    myRead,
    oppRead,
    decider,
    lesson,
  };
}
