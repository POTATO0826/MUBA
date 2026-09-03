import {
  PARTIAL_CREDIT,
  TIERS,
  TIER_ORDER,
  conditionText,
  type ParlayLeg,
  type ParlaySummary,
  type Tier,
} from "../engine/parlay.ts";
import { fmtPx } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, sectorColor, tag } from "../theme.ts";
import type { CaseDef, Direction } from "../types.ts";

/** Tier accents. DEGEN borrows the HIGH VAR violet — the same colour the
 *  summary bar turns when the whole parlay goes below a 10% line. */
const TIER_COLOR: Record<Tier, string> = {
  SAFE: C.green,
  EVEN: C.accent,
  SHARP: C.amber,
  DEGEN: C.violet,
};

const ROW_COLS = "150px 104px minmax(240px,1fr) 76px minmax(220px,1.3fr)";
const HEAD = `font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;

interface ParlayBuilderProps {
  c: CaseDef;
  legs: readonly ParlayLeg[];
  summary: ParlaySummary;
  stakePoints: number;
  onTier: (sym: string, tier: Tier) => void;
  onDir: (sym: string, dir: Direction) => void;
  onLock: () => void;
  onBack: () => void;
}

/**
 * One row per leg, a condition per row, one number at the bottom: the
 * product. All legs must hit — the bar says so in words, not just maths.
 */
export function ParlayBuilder(p: ParlayBuilderProps) {
  const s = p.summary;
  const loudColor = s.loud ? C.violet : C.accent;
  const probPct = (s.prob * 100).toFixed(s.prob < 0.1 ? 1 : 0);

  return (
    <div style={sx("padding:24px 28px;max-width:1440px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap")}>
        <button
          onClick={p.onBack}
          style={sx(
            `height:32px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;` +
              `background:transparent;color:${C.muted};font:500 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          ← Cases
        </button>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>
          Build the parlay · {p.c.name}
        </h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.accent};` +
              "border:1px solid rgba(200,255,0,.3);background:rgba(200,255,0,.08);" +
              "border-radius:6px;padding:6px 8px",
          )}
        >
          {p.legs.length} LEGS · ALL MUST HIT
        </span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>STAKE</span>
        <span style={sx(`font:700 18px/1 ${MONO}`)}>{p.stakePoints.toLocaleString("en-US")} PTS</span>
      </div>

      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px;align-items:start")}>
        <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`)}>
          <div
            style={sx(
              `display:grid;grid-template-columns:${ROW_COLS};gap:14px;align-items:center;padding:11px 18px;` +
                `background:${C.raised};border-bottom:1px solid ${C.border};${HEAD}`,
            )}
          >
            <div>LEG</div>
            <div>SPOT</div>
            <div>TIER</div>
            <div>MULT</div>
            <div>CONDITION</div>
          </div>

          {p.legs.map((l) => {
            const color = sectorColor(l.sector ?? "");
            return (
              <div
                key={l.sym}
                data-leg={l.sym}
                style={sx(
                  `display:grid;grid-template-columns:${ROW_COLS};gap:14px;align-items:center;` +
                    `padding:14px 18px;border-bottom:1px solid ${C.lineSoft}`,
                )}
              >
                <div style={sx("display:flex;flex-direction:column;gap:7px;min-width:0")}>
                  <div style={sx("display:flex;align-items:center;gap:8px")}>
                    <span style={sx(`font:700 15px/1 ${MONO}`)}>{l.sym}</span>
                    <span style={sx(tag(color))}>{l.sector}</span>
                  </div>
                  <div style={sx("display:flex;gap:4px")}>
                    <DirBtn on={l.dir === "over"} color={C.green} onClick={() => p.onDir(l.sym, "over")}>
                      ↑ over
                    </DirBtn>
                    <DirBtn on={l.dir === "under"} color={C.red} onClick={() => p.onDir(l.sym, "under")}>
                      ↓ under
                    </DirBtn>
                  </div>
                </div>

                <div>
                  <div style={sx(`font:700 13px/1 ${MONO}`)}>${fmtPx(l.px)}</div>
                  <div style={sx(`margin-top:5px;font:400 9.5px/1 ${MONO};color:${C.faint}`)}>
                    base ±{l.baseT.toFixed(1)}%
                  </div>
                </div>

                <div style={sx("display:flex;gap:4px")}>
                  {TIER_ORDER.map((t) => {
                    const on = l.tier === t;
                    const tc = TIER_COLOR[t];
                    return (
                      <button
                        key={t}
                        onClick={() => p.onTier(l.sym, t)}
                        title={`${TIERS[t].blurb} · ~${Math.round(TIERS[t].prob * 100)}% · ×${TIERS[t].mult}`}
                        style={sx(
                          `flex:1;height:30px;border-radius:7px;cursor:pointer;font:700 9.5px/1 ${MONO};letter-spacing:.1em;` +
                            (on
                              ? `border:1px solid ${tc};background:${tc}26;color:${tc}`
                              : `border:1px solid ${C.border};background:transparent;color:${C.dim}`),
                        )}
                      >
                        {t}
                      </button>
                    );
                  })}
                </div>

                <div style={sx(`font:700 15px/1 ${MONO};color:${TIER_COLOR[l.tier]}`)}>
                  ×{l.mult.toFixed(1)}
                </div>

                <div style={sx(`font:400 11.5px/1.45 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>
                  {conditionText(l)}
                  <div style={sx(`margin-top:4px;font:400 9.5px/1 ${MONO};color:${C.faint}`)}>
                    ~{Math.round(l.prob * 100)}% implied
                  </div>
                </div>
              </div>
            );
          })}

          <div style={sx(`padding:12px 18px;font:400 11px/1.5 ${SANS};color:${C.muted};background:${C.card}`)}>
            SAFE is a wide band on the base target, DEGEN is the tail. Each step up multiplies the
            payout and divides the odds of every leg landing together.
          </div>
        </div>

        <div
          style={sx(
            `position:sticky;top:76px;border:1px solid ${loudColor}59;border-radius:12px;overflow:hidden;` +
              `background:linear-gradient(180deg,${loudColor}14,${C.card} 45%)`,
          )}
        >
          <div style={sx(`padding:16px;border-bottom:1px solid ${C.border}`)}>
            <div style={sx(HEAD)}>COMBINED MULTIPLIER</div>
            <div
              data-testid="combined-mult"
              style={sx(
                `margin-top:8px;font:700 38px/1 ${MONO};letter-spacing:-.03em;color:${loudColor}` +
                  (s.loud ? ";animation:vcPulse 1.6s ease-in-out infinite" : ""),
              )}
            >
              ×{s.effectiveMult.toFixed(2)}
            </div>
            <div style={sx(`margin-top:8px;font:400 10.5px/1.5 ${MONO};color:${C.dim}`)}>
              legs ×{s.parlayMult.toFixed(2)}
              {s.floored ? ` · on the case floor ×${s.floor.toFixed(2)}` : ` · above the ×${s.floor.toFixed(2)} floor`}
            </div>
          </div>

          <div style={sx(`display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid ${C.border}`)}>
            <div style={sx(`padding:14px 16px;border-right:1px solid ${C.line}`)}>
              <div style={sx(HEAD)}>IMPLIED WIN</div>
              <div data-testid="implied-prob" style={sx(`margin-top:7px;font:700 20px/1 ${MONO};color:${loudColor}`)}>
                {probPct}%
              </div>
            </div>
            <div style={sx("padding:14px 16px")}>
              <div style={sx(HEAD)}>POTENTIAL</div>
              <div data-testid="potential-points" style={sx(`margin-top:7px;font:700 20px/1 ${MONO};color:${C.text}`)}>
                {s.potentialPoints.toLocaleString("en-US")}
                <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}> PTS</span>
              </div>
            </div>
          </div>

          <div style={sx("padding:14px 16px;display:flex;flex-direction:column;gap:10px")}>
            <div
              style={sx(
                `padding:10px 12px;border-radius:8px;border:1px solid ${loudColor}59;background:${loudColor}12;` +
                  `font:700 11px/1.45 ${SANS};color:${C.text};text-wrap:pretty`,
              )}
            >
              All {p.legs.length} legs must hit for the case to pay. One miss pays{" "}
              {PARTIAL_CREDIT ? "the stake back" : "zero"}.
            </div>
            {s.loud && (
              <div style={sx(`font:400 11px/1.5 ${SANS};color:${C.violet};text-wrap:pretty`)}>
                Under a 10% line. This is a tail position — size it like one.
              </div>
            )}
            <div style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint}`)}>
              The case's own ×{s.floor.toFixed(2)} is the floor. Tiers only move the multiplier
              up and the odds down from there.
            </div>
            <button
              onClick={p.onLock}
              style={sx(
                `width:100%;height:40px;margin-top:4px;border:none;border-radius:8px;` +
                  `background:${C.accent};color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
              )}
            >
              Lock parlay → case study
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DirBtn({
  on,
  color,
  onClick,
  children,
}: {
  on: boolean;
  color: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={sx(
        `height:22px;padding:0 8px;border-radius:6px;cursor:pointer;font:700 9px/1 ${MONO};letter-spacing:.08em;` +
          (on
            ? `border:1px solid ${color}88;background:${color}22;color:${color}`
            : `border:1px solid ${C.border};background:transparent;color:${C.dim}`),
      )}
    >
      {children}
    </button>
  );
}
