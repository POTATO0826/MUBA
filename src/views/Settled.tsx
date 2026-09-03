import { CHAMP_ART } from "../data/fixtures.ts";
import { conditionText, type CaseVerdict, type ParlayLeg, type ParlaySummary } from "../engine/parlay.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { CaseDef } from "../types.ts";

interface SettledProps {
  c: CaseDef;
  verdict: CaseVerdict;
  summary: ParlaySummary;
  legs: readonly ParlayLeg[];
  stakePoints: number;
  onBackToCases: () => void;
  onOpenAgain: () => void;
}

export function Settled(p: SettledProps) {
  const v = p.verdict;
  const nLegs = p.legs.length;
  const paid = v.allHit;
  const tone = paid ? C.accent : v.refunded ? C.amber : C.red;

  const headline = paid
    ? "The case paid in full"
    : v.refunded
      ? "One leg short — stake returned"
      : "The case expired short";

  const kicker = paid ? "EVERY LEG LANDED" : v.refunded ? "PARTIAL CREDIT" : "PARLAY MISSED";

  return (
    <div style={sx("padding:28px;max-width:1100px;margin:0 auto")}>
      <div
        style={sx(
          `position:relative;overflow:hidden;border:1px solid ${tone}59;border-radius:14px;` +
            `background:linear-gradient(150deg,${tone}1f,#0f0f11 55%);padding:28px 30px`,
        )}
      >
        <div style={sx("display:flex;align-items:flex-start;gap:24px")}>
          {paid && (
            <pre style={sx(`margin:0;font:700 10px/1.15 ${MONO};color:${C.accent};white-space:pre`)}>
              {CHAMP_ART}
            </pre>
          )}
          <div>
            <div
              style={sx(
                `font:700 10px/1 ${MONO};letter-spacing:.18em;color:${tone};` +
                  (paid ? "animation:vcPulse 2.4s ease-in-out infinite" : ""),
              )}
            >
              {kicker}
            </div>
            <h2 style={sx(`margin:14px 0 0;font:700 34px/1.05 ${SANS};letter-spacing:-.03em`)}>
              {headline}
            </h2>
            <div style={sx("margin-top:12px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap")}>
              <span data-testid="settled-points" style={sx(`font:700 30px/1 ${MONO};color:${tone}`)}>
                {v.points > 0 ? "+" : ""}
                {v.points.toLocaleString("en-US")} PTS
              </span>
              <span style={sx(`font:500 12px/1 ${MONO};color:${C.muted}`)}>
                {v.hits} of {nLegs} legs · ×{p.summary.effectiveMult.toFixed(2)} on{" "}
                {p.stakePoints.toLocaleString("en-US")} staked · {p.c.name}
              </span>
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
          <span style={sx(`font:700 13px/1 ${SANS}`)}>Coach · case summary</span>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>
            STRATEGY READ · GENERATED FROM THE POSITION
          </span>
        </div>

        <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:0")}>
          <div style={sx(`padding:16px;border-right:1px solid ${C.line}`)}>
            <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.accent}`)}>
              HOW IT SETTLED
            </div>
            <div style={sx(`margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>
              {v.read}
            </div>
          </div>
          <div style={sx("padding:16px")}>
            <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.blue}`)}>
              LESSON FOR NEXT CASE
            </div>
            <div style={sx(`margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>
              {v.lesson}
            </div>
          </div>
        </div>
      </div>

      <div
        style={sx(
          `border-radius:12px;padding:16px;background:${C.card};margin-top:18px;border:1px solid ` +
            (paid ? "rgba(200,255,0,.4)" : C.border),
        )}
      >
        <div
          style={sx(
            `display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;` +
              `border-bottom:1px solid ${C.border}`,
          )}
        >
          <span style={sx(`font:700 13px/1 ${SANS}`)}>Your legs</span>
          <span style={sx(`font:700 18px/1 ${MONO};color:${paid ? C.accent : C.dim}`)}>
            {v.hits} / {nLegs}
          </span>
        </div>
        <div style={sx("display:flex;flex-direction:column;gap:0;margin-top:6px")}>
          {p.legs.map((l, i) => {
            const st = v.outcomes[i]!;
            return (
              <div
                key={l.sym}
                style={sx(
                  `display:grid;grid-template-columns:16px 64px 70px minmax(0,1fr) 84px;align-items:center;gap:10px;` +
                    `padding:11px 0;border-bottom:1px solid ${C.line}`,
                )}
              >
                <span
                  style={sx(
                    `width:7px;height:7px;border-radius:99px;background:${st.won ? C.green : C.red}`,
                  )}
                />
                <span style={sx(`font:700 12px/1 ${MONO}`)}>{l.sym}</span>
                <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
                  {l.tier} ×{l.mult.toFixed(1)}
                </span>
                <span style={sx(`font:400 10.5px/1.3 ${MONO};color:${C.dim}`)}>{conditionText(l)}</span>
                <span style={sx(`text-align:right;font:700 12px/1 ${MONO};color:${st.won ? C.green : C.red}`)}>
                  {st.pct >= 0 ? "+" : ""}
                  {st.pct.toFixed(2)}%
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={sx("display:flex;gap:10px;margin-top:18px")}>
        <button
          onClick={p.onBackToCases}
          style={sx(
            `height:40px;padding:0 18px;border:none;border-radius:8px;background:${C.accent};` +
              `color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
          )}
        >
          Back to cases
        </button>
        <button
          onClick={p.onOpenAgain}
          style={sx(
            `height:40px;padding:0 18px;border:1px solid ${C.borderMid};border-radius:8px;` +
              `background:transparent;color:${C.text};font:500 13px/1 ${SANS};cursor:pointer`,
          )}
        >
          Open again · new spin
        </button>
      </div>
    </div>
  );
}
