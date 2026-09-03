import { CHAMP_ART } from "../data/fixtures.ts";
import { legState, type MatchVerdict } from "../engine/match.ts";
import { conditionText, type ParlayLeg } from "../engine/parlay.ts";
import { TAPE_LEN } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, avatarStyle, tag } from "../theme.ts";
import type { Player } from "../types.ts";
import { TIER_COLOR } from "./ParlayPick.tsx";

interface ResultProps {
  verdict: MatchVerdict;
  you: Player;
  opponent: Player;
  myLegs: readonly ParlayLeg[];
  oppLegs: readonly ParlayLeg[];
  myMult: number;
  oppMult: number;
  /** What you banked in points: the stake at your parlay's odds, or nothing. */
  pointsWon: number;
  salt: number;
  prizeLabel: string;
  onBackToBattles: () => void;
  onRematch: () => void;
}

/** Who took the pool, and a read of each player's slip. */
export function Result(p: ResultProps) {
  const v = p.verdict;
  const nLegs = p.myLegs.length;

  const sides = [
    { who: p.you, legs: p.myLegs, mult: p.myMult, score: v.myScore, win: v.meWins, read: v.myRead },
    { who: p.opponent, legs: p.oppLegs, mult: p.oppMult, score: v.oppScore, win: !v.meWins, read: v.oppRead },
  ];

  return (
    <div style={sx("padding:28px;max-width:1100px;margin:0 auto")}>
      <div
        style={sx(
          "position:relative;overflow:hidden;border:1px solid rgba(200,255,0,.35);border-radius:14px;" +
            "background:linear-gradient(150deg,rgba(200,255,0,.12),#0f0f11 55%);padding:28px 30px",
        )}
      >
        <div style={sx("display:flex;align-items:flex-start;gap:24px")}>
          <pre style={sx(`margin:0;font:700 10px/1.15 ${MONO};color:${C.accent};white-space:pre`)}>{CHAMP_ART}</pre>
          <div>
            <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.18em;color:${C.accent};animation:vcPulse 2.4s ease-in-out infinite`)}>
              WINNER WINNER CHICKEN DINNER
            </div>
            <h2 style={sx(`margin:14px 0 0;font:700 34px/1.05 ${SANS};letter-spacing:-.03em`)}>
              {v.winner} {v.winnerVerb} the pool
            </h2>
            <div style={sx("margin-top:12px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap")}>
              <span style={sx(`font:700 30px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
              <span style={sx(`font:500 12px/1 ${MONO};color:${C.muted}`)}>{v.scoreLine}</span>
            </div>
            <div data-testid="points-won" style={sx(`margin-top:10px;font:500 11px/1 ${MONO};color:${v.meWins ? C.green : C.dim}`)}>
              {v.meWins
                ? `+${p.pointsWon.toLocaleString("en-US")} PTS banked at ×${p.myMult.toFixed(2)} — your parlay's odds`
                : `0 PTS · ${p.opponent.name} banks the odds this time`}
            </div>
          </div>
        </div>
      </div>

      {/* Each player's choices and what the tape made of them. */}
      <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden;margin-top:18px`)}>
        <div style={sx(`display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ${C.border}`)}>
          <div
            style={sx(
              `width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,${C.indigo},${C.accent});` +
                `display:grid;place-items:center;font:700 12px/1 ${MONO};color:${C.bg}`,
            )}
          >
            AI
          </div>
          <span style={sx(`font:700 13px/1 ${SANS}`)}>Coach · match summary</span>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>WHAT EACH PLAYER CHOSE · WHAT THE TAPE DID</span>
        </div>

        <div style={sx(`display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid ${C.line}`)}>
          {sides.map((s, i) => (
            <div key={s.who.name} data-summary={s.who.name} style={sx(`padding:16px;${i === 0 ? `border-right:1px solid ${C.line}` : ""}`)}>
              <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
                <div style={sx(avatarStyle(s.who.bg, 24))}>{s.who.initial}</div>
                <span style={sx(`font:700 12.5px/1 ${SANS}`)}>{s.who.name}</span>
                <span
                  style={sx(
                    `font:700 8px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:4px;background:` +
                      (s.win ? `${C.accent};color:${C.bg}` : `${C.border};color:${C.muted}`),
                  )}
                >
                  {s.win ? "WINNER" : "RUNNER-UP"}
                </span>
              </div>
              <div style={sx("display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap")}>
                {s.legs.map((l) => (
                  <span key={l.sym} style={sx(tag(TIER_COLOR[l.tier]))}>
                    {l.sym} {l.tier}
                    {l.dir === "over" ? "↑" : "↓"}
                  </span>
                ))}
                <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>×{s.mult.toFixed(2)} · {s.read.style}</span>
              </div>
              <div style={sx(`margin-top:10px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>{s.read.read}</div>
            </div>
          ))}
        </div>

        <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:0")}>
          <div style={sx(`padding:16px;border-right:1px solid ${C.line}`)}>
            <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.accent}`)}>WHAT DECIDED IT</div>
            <div style={sx(`margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>{v.decider}</div>
          </div>
          <div style={sx("padding:16px")}>
            <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.blue}`)}>LESSON FOR NEXT DUEL</div>
            <div style={sx(`margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>{v.lesson}</div>
          </div>
        </div>
      </div>

      <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px")}>
        {sides.map((s) => (
          <div
            key={s.who.name}
            style={sx(`border-radius:12px;padding:16px;background:${C.card};border:1px solid ` + (s.win ? "rgba(200,255,0,.4)" : C.border))}
          >
            <div style={sx(`display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid ${C.border}`)}>
              <span style={sx(`font:700 13px/1 ${SANS}`)}>{s.who.name}</span>
              <span style={sx(`font:700 18px/1 ${MONO};color:${s.win ? C.accent : C.dim}`)}>
                {s.score} / {nLegs}
              </span>
            </div>
            <div style={sx("display:flex;flex-direction:column;gap:0;margin-top:6px")}>
              {s.legs.map((l) => {
                const st = legState(l, p.salt, TAPE_LEN);
                return (
                  <div
                    key={l.sym}
                    style={sx(`display:grid;grid-template-columns:16px 56px minmax(0,1fr) 72px;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid ${C.line}`)}
                  >
                    <span style={sx(`width:7px;height:7px;border-radius:99px;background:${st.won ? C.green : C.red}`)} />
                    <span style={sx(`font:700 12px/1 ${MONO}`)}>{l.sym}</span>
                    <span style={sx(`font:400 10px/1.3 ${MONO};color:${C.dim}`)}>{conditionText(l)}</span>
                    <span style={sx(`text-align:right;font:700 12px/1 ${MONO};color:${st.won ? C.green : C.red}`)}>
                      {st.pct >= 0 ? "+" : ""}
                      {st.pct.toFixed(2)}%
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div style={sx("display:flex;gap:10px;margin-top:18px")}>
        <button
          onClick={p.onBackToBattles}
          style={sx(`height:40px;padding:0 18px;border:none;border-radius:8px;background:${C.accent};color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`)}
        >
          Back to battles
        </button>
        <button
          onClick={p.onRematch}
          style={sx(`height:40px;padding:0 18px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;color:${C.text};font:500 13px/1 ${SANS};cursor:pointer`)}
        >
          Rematch · new lobby
        </button>
      </div>
    </div>
  );
}
