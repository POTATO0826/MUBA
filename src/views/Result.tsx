import { useCallback, useState } from "react";
import { ExitRow, RankUpSequence } from "../components/RankUpSequence.tsx";
import { CHAMP_ART } from "../data/fixtures.ts";
import { modeTag, type ModeSpec } from "../data/modes.ts";
import { SEASON } from "../data/rewards.ts";
import { sectorChips } from "../data/sectors.ts";
import { legState, type MatchVerdict } from "../engine/match.ts";
import { conditionText, type ParlayLeg } from "../engine/parlay.ts";
import { sfx, useCountUp } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, avatarStyle, miniTag, tag } from "../theme.ts";
import type { Player, SectorKey } from "../types.ts";
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
  /** The print the duel settled on — the mode's window. Every leg on this
   *  screen is read at it, so a Blitz result never shows a full-tape move. */
  settleAt: number;
  mode: ModeSpec;
  sectors: readonly SectorKey[];
  prizeLabel: string;
  /** ── The rank moment (BUILD-ORDER §C-6). Every one of these is rendered
   *  ONLY inside `RankUpSequence`, behind the gate: plan 1's separate Result
   *  XP chip is absorbed by this sequence and must never be built. ── */
  xpGain: number;
  xpBefore: number;
  xpAfter: number;
  streak: number;
  posBefore: number;
  posAfter: number;
  onBackToBattles: () => void;
  onRematch: () => void;
  /** `View the full ladder →`. A no-op until wave 7 routes `/ranks`. */
  onOpenLadder: () => void;
}

/**
 * The screen runs in three phases.
 *
 *   debrief  the three existing blocks, live, plus the `Next → your rank` bar
 *   rank     the same blocks, DIMMED but still mounted, with the sequence below
 *   done     everything lit again, exits revealed
 *
 * The debrief blocks are never unmounted — dimming is a style, so every
 * assertion about the winner banner, the coach grid or the banked figure holds
 * at every phase. Only the exits are gated, which is the one thing the gate is
 * for: the XP moment gets to happen before the player can leave.
 */
type Phase = "debrief" | "rank" | "done";

/** Who took the pool, and a read of each player's slip. */
export function Result(p: ResultProps) {
  const v = p.verdict;
  const nLegs = p.myLegs.length;
  // The banked figure climbs on arrival. Silent builds (and reduced motion)
  // get the final number on the first render — see `useCountUp`.
  const banked = useCountUp(p.pointsWon, { steps: 24 });

  const [phase, setPhase] = useState<Phase>("debrief");
  const onSequenceDone = useCallback(() => setPhase("done"), []);

  const sides = [
    { who: p.you, legs: p.myLegs, mult: p.myMult, score: v.myScore, win: v.meWins, read: v.myRead },
    { who: p.opponent, legs: p.oppLegs, mult: p.oppMult, score: v.oppScore, win: !v.meWins, read: v.oppRead },
  ];

  return (
    <div style={sx("padding:28px;max-width:1100px;margin:0 auto")}>
      {/* The debrief. Dimmed while the rank moment plays, never unmounted —
          the winner banner, the coach grid, the scoreboards and the count-up
          points row all stay exactly where they were and keep reading. */}
      <div
        data-debrief=""
        style={sx(
          "transition:opacity .4s ease,filter .4s ease;" +
            (phase === "rank" ? "opacity:.34;filter:saturate(.6);pointer-events:none" : "opacity:1"),
        )}
      >
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
              <div style={sx("margin-top:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap")}>
                <span style={sx(modeTag(p.mode.key))}>
                  {p.mode.label} · {p.mode.duration}
                </span>
                {sectorChips(p.sectors).map((c) => (
                  <span key={c.key} style={sx(miniTag(c.color))}>
                    {c.label}
                  </span>
                ))}
              </div>
              <div data-testid="points-won" style={sx(`margin-top:10px;font:500 11px/1 ${MONO};color:${v.meWins ? C.green : C.dim}`)}>
                {v.meWins
                  ? `+${banked.toLocaleString("en-US")} PTS banked at ×${p.myMult.toFixed(2)} — your parlay's odds`
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
                  const st = legState(l, p.salt, p.settleAt);
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
      </div>

      {/* The gate. One press, and the XP moment owns the screen. */}
      {phase === "debrief" && (
        <div style={sx("margin-top:18px")}>
          <button
            onClick={() => {
              sfx("ui.click.primary");
              setPhase("rank");
            }}
            style={sx(
              `position:relative;overflow:hidden;display:block;width:100%;height:56px;border:none;border-radius:12px;` +
                `background:linear-gradient(100deg,${C.accent},#a8e000);color:${C.bg};` +
                `font:700 15px/1 ${SANS};letter-spacing:-.01em;cursor:pointer`,
            )}
          >
            {/* Empty by design: an accent sweep across the bar must not put a
                character into the button's textContent — the test helper
                matches labels on the trimmed text, exactly. */}
            <span
              aria-hidden="true"
              style={sx(
                "position:absolute;top:0;bottom:0;left:0;width:38%;pointer-events:none;" +
                  "background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);" +
                  "animation:vcSweep 2.2s ease-in-out infinite",
              )}
            />
            Next → your rank
          </button>
          <div
            data-next-sub=""
            style={sx(
              `margin-top:8px;text-align:center;font:700 9px/1 ${MONO};letter-spacing:.18em;color:${C.dim}`,
            )}
          >
            {SEASON.label} · +{p.xpGain} XP PENDING
          </div>
        </div>
      )}

      {phase !== "debrief" && (
        <RankUpSequence
          xpGain={p.xpGain}
          xpBefore={p.xpBefore}
          xpAfter={p.xpAfter}
          streak={p.streak}
          posBefore={p.posBefore}
          posAfter={p.posAfter}
          onDone={onSequenceDone}
          onOpenLadder={p.onOpenLadder}
        />
      )}

      {phase === "done" && (
        <ExitRow
          onBackToBattles={p.onBackToBattles}
          onRematch={p.onRematch}
          onOpenLadder={p.onOpenLadder}
        />
      )}
    </div>
  );
}
