import { Sparkline } from "../components/Sparkline.tsx";
import type { ModeSpec } from "../data/modes.ts";
import { buildChartCard } from "../engine/chart.ts";
import { legState } from "../engine/match.ts";
import type { ParlayLeg } from "../engine/parlay.ts";
import { windowLabel } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, tag } from "../theme.ts";
import type { Player } from "../types.ts";

interface LiveProps {
  lobbyName: string;
  prizeLabel: string;
  arena: readonly string[];
  myLegs: readonly ParlayLeg[];
  oppLegs: readonly ParlayLeg[];
  myCardLabel: string;
  oppCardLabel: string;
  salt: number;
  /** The print this duel settles on — the mode's window, not the whole tape. */
  settleAt: number;
  /** This lobby's mode: the badge text and the tint the duel runs in. */
  mode: ModeSpec;
  /** Print the tape has played up to. */
  pos: number;
  raceDone: boolean;
  you: Player;
  opponent: Player;
  myScore: number;
  oppScore: number;
  onSettle: () => void;
}

/** Both slips, held through a compressed window of the tape. */
export function Live(p: LiveProps) {
  const nLegs = p.myLegs.length;
  const progress = (p.pos / p.settleAt) * 100;
  const firstSym = p.arena[0];
  const cols = Math.min(3, Math.max(2, p.arena.length));

  const raceNote = p.raceDone
    ? "Tape complete. " +
      (p.myScore === p.oppScore
        ? "Tied on legs — settle to break it."
        : p.myScore > p.oppScore
          ? "You lead on legs."
          : `${p.opponent.name} leads on legs.`)
    : `Compressing the window… ${Math.round(progress)}% of the tape played.`;

  return (
    <div style={sx("padding:24px 28px;max-width:1720px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:18px")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Live duel · {p.lobbyName}</h2>
        <span style={sx(tag(p.mode.color))}>
          {p.mode.label} · {p.mode.duration} · TAPE ×{p.mode.compression}
          {firstSym ? ` · ${windowLabel(firstSym, p.salt)}` : ""}
        </span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>POOL</span>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
      </div>

      <div style={sx(`height:3px;border-radius:99px;background:${C.line};overflow:hidden;margin-bottom:18px`)}>
        <div
          style={sx(
            `height:100%;width:${progress.toFixed(1)}%;background:${p.mode.color};transition:width .1s linear` +
              // Two seconds of tape is short enough that a still bar reads as
              // stalled; the pulse is the only cue Blitz is running.
              (p.mode.key === "BLITZ" ? ";animation:vcPulse 1.2s ease-in-out infinite" : ""),
          )}
        />
      </div>

      <div style={sx("display:grid;grid-template-columns:260px minmax(0,1fr) 260px;gap:18px;align-items:start")}>
        <SlipPanel
          border="rgba(99,102,241,.4)"
          gradient="linear-gradient(180deg,rgba(99,102,241,.1),#0f0f11 40%)"
          name={p.you.name}
          card={p.myCardLabel}
          score={`${p.myScore} / ${nLegs}`}
          scoreColor={C.accent}
          legs={p.myLegs}
          salt={p.salt}
          pos={p.pos}
          raceDone={p.raceDone}
        />

        <div style={sx(`display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px`)}>
          {p.arena.map((sym) => {
            const card = buildChartCard(sym, p.salt, p.pos, 96);
            const holders = [
              ...p.myLegs.filter((l) => l.sym === sym).map((l) => ({
                label: `${p.you.initial} ${l.dir === "over" ? "↑" : "↓"}${l.t.toFixed(1)}%`,
                c: C.indigo,
              })),
              ...p.oppLegs.filter((l) => l.sym === sym).map((l) => ({
                label: `${p.opponent.initial} ${l.dir === "over" ? "↑" : "↓"}${l.t.toFixed(1)}%`,
                c: C.red,
              })),
            ];

            return (
              <div key={sym} style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.panel};padding:14px`)}>
                <div style={sx("display:flex;align-items:center;justify-content:space-between")}>
                  <div>
                    <div style={sx(`font:700 14px/1 ${MONO}`)}>{card.sym}</div>
                    <div style={sx(`margin-top:5px;font:400 9.5px/1 ${MONO};color:${C.faint}`)}>{card.window}</div>
                  </div>
                  <div style={sx("text-align:right")}>
                    <div style={sx(`font:700 14px/1 ${MONO};color:${card.stroke}`)}>{card.pct}</div>
                    <div style={sx(`margin-top:5px;font:400 10px/1 ${MONO};color:${C.dim}`)}>{card.px}</div>
                  </div>
                </div>

                <Sparkline card={card} height={96} head />

                <div style={sx("display:flex;gap:6px;margin-top:10px;flex-wrap:wrap")}>
                  {holders.map((h) => (
                    <span
                      key={h.label}
                      style={sx(
                        `font:700 8.5px/1 ${MONO};letter-spacing:.06em;padding:5px 6px;border-radius:5px;background:${h.c}26;color:${h.c}`,
                      )}
                    >
                      {h.label}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <SlipPanel
          border="rgba(248,113,113,.35)"
          gradient="linear-gradient(180deg,rgba(248,113,113,.09),#0f0f11 40%)"
          name={p.opponent.name}
          card={p.oppCardLabel}
          score={`${p.oppScore} / ${nLegs}`}
          scoreColor={C.red}
          legs={p.oppLegs}
          salt={p.salt}
          pos={p.pos}
          raceDone={p.raceDone}
        />
      </div>

      <div
        style={sx(
          "display:flex;align-items:center;gap:14px;margin-top:18px;padding:14px 18px;" +
            `border:1px solid ${C.border};border-radius:12px;background:${C.card}`,
        )}
      >
        <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>{raceNote}</span>
        <div style={sx("flex:1")} />
        {p.raceDone && (
          <button
            onClick={p.onSettle}
            style={sx(
              `height:36px;padding:0 16px;border:none;border-radius:8px;background:${C.accent};` +
                `color:${C.bg};font:700 12px/1 ${SANS};cursor:pointer;white-space:nowrap`,
            )}
          >
            Settle → result
          </button>
        )}
      </div>
    </div>
  );
}

function SlipPanel(p: {
  border: string;
  gradient: string;
  name: string;
  card: string;
  score: string;
  scoreColor: string;
  legs: readonly ParlayLeg[];
  salt: number;
  pos: number;
  raceDone: boolean;
}) {
  return (
    <div style={sx(`border:1px solid ${p.border};border-radius:12px;background:${p.gradient};padding:16px`)}>
      <div style={sx(`display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid ${C.border}`)}>
        <div>
          <div style={sx(`font:700 13px/1 ${SANS}`)}>{p.name}</div>
          <div style={sx(`margin-top:5px;font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>{p.card}</div>
        </div>
        <span style={sx(`font:700 20px/1 ${MONO};color:${p.scoreColor}`)}>{p.score}</span>
      </div>

      <div style={sx("display:flex;flex-direction:column;gap:8px;margin-top:12px")}>
        {p.legs.map((l) => {
          const st = legState(l, p.salt, p.pos);
          // Grey while a leg is still live; red only once the tape is finished.
          const stateColor = st.won ? C.green : p.raceDone ? C.red : C.dim;
          const state = st.won ? "HIT" : p.raceDone ? "MISSED" : "OPEN";

          return (
            <div
              key={l.sym}
              style={sx(`padding:11px;border-radius:9px;background:${C.raised};border:1px solid ` + (st.won ? "rgba(74,222,128,.4)" : C.border))}
            >
              <div style={sx("display:flex;align-items:center;justify-content:space-between")}>
                <span style={sx(`font:700 12px/1 ${MONO}`)}>{l.sym}</span>
                <span
                  style={sx(
                    `font:700 8px/1 ${MONO};letter-spacing:.1em;padding:4px 5px;border-radius:4px;background:${stateColor}26;color:${stateColor}`,
                  )}
                >
                  {state}
                </span>
              </div>
              <div style={sx("margin-top:7px;display:flex;align-items:baseline;justify-content:space-between")}>
                <span style={sx(`font:400 10px/1 ${MONO};color:${C.dim}`)}>
                  {l.dir === "over" ? "over +" : "under −"}
                  {l.t.toFixed(1)}%
                </span>
                <span style={sx(`font:700 12px/1 ${MONO};color:${st.pct >= 0 ? C.green : C.red}`)}>
                  {st.pct >= 0 ? "+" : ""}
                  {st.pct.toFixed(2)}%
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
