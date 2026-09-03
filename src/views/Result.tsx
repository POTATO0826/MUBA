import { CHAMP_ART } from "../data/fixtures.ts";
import { legState, type MatchVerdict } from "../engine/match.ts";
import { TAPE_LEN } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { Leg } from "../types.ts";

interface ResultProps {
  verdict: MatchVerdict;
  myLegs: readonly Leg[];
  oppLegs: readonly Leg[];
  salt: number;
  prizeLabel: string;
  p1Name: string;
  opponent: string;
  onBackToBattles: () => void;
  onRematch: () => void;
}

export function Result(p: ResultProps) {
  const v = p.verdict;
  const nLegs = p.myLegs.length;

  const cards = [
    { who: p.p1Name, legs: p.myLegs, score: v.myScore, win: v.meWins },
    { who: p.opponent, legs: p.oppLegs, score: v.oppScore, win: !v.meWins },
  ];

  const players = [v.myRead, v.oppRead];

  return (
    <div style={sx("padding:28px;max-width:1100px;margin:0 auto")}>
      <div
        style={sx(
          "position:relative;overflow:hidden;border:1px solid rgba(200,255,0,.35);border-radius:14px;" +
            "background:linear-gradient(150deg,rgba(200,255,0,.12),#0f0f11 55%);padding:28px 30px",
        )}
      >
        <div style={sx("display:flex;align-items:flex-start;gap:24px")}>
          <pre style={sx(`margin:0;font:700 10px/1.15 ${MONO};color:${C.accent};white-space:pre`)}>
            {CHAMP_ART}
          </pre>
          <div>
            <div
              style={sx(
                `font:700 10px/1 ${MONO};letter-spacing:.18em;color:${C.accent};` +
                  "animation:vcPulse 2.4s ease-in-out infinite",
              )}
            >
              WINNER WINNER CHICKEN DINNER
            </div>
            <h2
              style={sx(
                `margin:14px 0 0;font:700 34px/1.05 'Space Grotesk',${SANS};letter-spacing:-.03em`,
              )}
            >
              {v.winner} {v.winnerVerb} the pool
            </h2>
            <div style={sx("margin-top:12px;display:flex;align-items:baseline;gap:16px")}>
              <span style={sx(`font:700 30px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
              <span style={sx(`font:500 12px/1 ${MONO};color:${C.muted}`)}>{v.scoreLine}</span>
            </div>
          </div>
        </div>
      </div>

      <div
        style={sx(
          `border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden;margin-top:18px`,
        )}
      >
        <div
          style={sx(
            `display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ${C.border}`,
          )}
        >
          <div
            style={sx(
              `width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,${C.indigo},${C.accent});` +
                `display:grid;place-items:center;font:700 12px/1 ${MONO};color:${C.bg}`,
            )}
          >
            AI
          </div>
          <span style={sx(`font:700 13px/1 ${SANS}`)}>Coach · match summary</span>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>
            STRATEGY READ · GENERATED FROM BOTH SLIPS
          </span>
        </div>

        <div
          style={sx(
            `display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid ${C.line}`,
          )}
        >
          {players.map((r, i) => (
            <div
              key={r.who}
              style={sx(`padding:16px;${i === 0 ? `border-right:1px solid ${C.line}` : ""}`)}
            >
              <div style={sx("display:flex;align-items:center;gap:8px")}>
                <span
                  style={sx(
                    `font:700 8px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:4px;background:` +
                      (r.won ? `${C.accent};color:${C.bg}` : `${C.border};color:${C.muted}`),
                  )}
                >
                  {r.won ? "WINNER" : "RUNNER-UP"}
                </span>
                <span style={sx(`font:700 12.5px/1 ${SANS}`)}>{r.who}</span>
                <span style={sx(`font:400 10px/1 ${MONO};color:${C.dim}`)}>{r.style}</span>
              </div>
              <div
                style={sx(
                  `margin-top:10px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`,
                )}
              >
                {r.read}
              </div>
            </div>
          ))}
        </div>

        <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:0")}>
          <div style={sx(`padding:16px;border-right:1px solid ${C.line}`)}>
            <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.accent}`)}>
              WHAT DECIDED IT
            </div>
            <div
              style={sx(
                `margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`,
              )}
            >
              {v.decider}
            </div>
          </div>
          <div style={sx("padding:16px")}>
            <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.blue}`)}>
              LESSON FOR NEXT DUEL
            </div>
            <div
              style={sx(
                `margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`,
              )}
            >
              {v.lesson}
            </div>
          </div>
        </div>
      </div>

      <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px")}>
        {cards.map((r) => (
          <div
            key={r.who}
            style={sx(
              `border-radius:12px;padding:16px;background:${C.card};border:1px solid ` +
                (r.win ? "rgba(200,255,0,.4)" : C.border),
            )}
          >
            <div
              style={sx(
                `display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;` +
                  `border-bottom:1px solid ${C.border}`,
              )}
            >
              <span style={sx(`font:700 13px/1 ${SANS}`)}>{r.who}</span>
              <span
                style={sx(`font:700 18px/1 ${MONO};color:${r.win ? C.accent : C.dim}`)}
              >
                {r.score} / {nLegs}
              </span>
            </div>
            <div style={sx("display:flex;flex-direction:column;gap:0;margin-top:6px")}>
              {r.legs.map((l) => {
                const st = legState(l, p.salt, TAPE_LEN);
                return (
                  <div
                    key={l.sym}
                    style={sx(
                      `display:flex;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid ${C.line}`,
                    )}
                  >
                    <span
                      style={sx(
                        `width:7px;height:7px;flex:none;border-radius:99px;background:${
                          st.won ? C.green : C.red
                        }`,
                      )}
                    />
                    <span style={sx(`font:700 12px/1 ${MONO};min-width:56px`)}>{l.sym}</span>
                    <span style={sx(`font:400 10.5px/1 ${MONO};color:${C.dim};flex:1`)}>
                      {l.dir === "over" ? "over +" : "under −"}
                      {l.t.toFixed(1)}%
                    </span>
                    <span
                      style={sx(`font:700 12px/1 ${MONO};color:${st.won ? C.green : C.red}`)}
                    >
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
          style={sx(
            `height:40px;padding:0 18px;border:none;border-radius:8px;background:${C.accent};` +
              `color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
          )}
        >
          Back to battles
        </button>
        <button
          onClick={p.onRematch}
          style={sx(
            `height:40px;padding:0 18px;border:1px solid ${C.borderMid};border-radius:8px;` +
              `background:transparent;color:${C.text};font:500 13px/1 ${SANS};cursor:pointer`,
          )}
        >
          Rematch · new lobby
        </button>
      </div>
    </div>
  );
}
