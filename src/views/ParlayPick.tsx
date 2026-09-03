import {
  PARLAY_CARDS,
  TIERS,
  conditionText,
  legsForCard,
  summarize,
  type ParlayCard,
  type ParlayLeg,
  type Tier,
} from "../engine/parlay.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, avatarStyle, sectorColor, tag } from "../theme.ts";
import type { Player } from "../types.ts";

/** Tier accents. DEGEN borrows the HIGH VAR violet. */
export const TIER_COLOR: Record<Tier, string> = {
  SAFE: C.green,
  EVEN: C.accent,
  SHARP: C.amber,
  DEGEN: C.violet,
};

interface ParlayPickProps {
  lobbyName: string;
  opponent: Player;
  arena: readonly string[];
  selected: ParlayCard | null;
  /** Your slip for the selected card, or the EVEN-bullish preview before one is picked. */
  myLegs: readonly ParlayLeg[];
  stakePoints: number;
  prizeLabel: string;
  onPick: (id: string) => void;
  onLock: () => void;
}

/**
 * Eight parlays on the table, sportsbook-style: four risk tiers, bullish and
 * bearish each. A card sets every leg's line and direction at once. The odds
 * on the card are the product of the legs; the higher the tier, the bigger
 * the payout and the smaller the chance every leg lands together.
 */
export function ParlayPick(p: ParlayPickProps) {
  const n = p.arena.length;

  return (
    <div style={sx("padding:24px 28px;max-width:1720px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Pick your parlay · {p.lobbyName}</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.accent};` +
              "border:1px solid rgba(200,255,0,.3);background:rgba(200,255,0,.08);border-radius:6px;padding:6px 8px",
          )}
        >
          BLIND · OPPONENT SLIP HIDDEN
        </span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>POOL</span>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
      </div>

      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start")}>
        <div>
          <div style={sx("display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px")}>
            {PARLAY_CARDS.map((card) => {
              const legs = legsForCard(p.arena, card);
              const s = summarize(legs, p.stakePoints);
              const color = TIER_COLOR[card.tier];
              const on = p.selected?.id === card.id;
              const bull = card.stance === "bull";
              const line = TIERS[card.tier].scale;

              return (
                <button
                  key={card.id}
                  data-parlay={card.id}
                  aria-pressed={on}
                  onClick={() => p.onPick(card.id)}
                  style={sx(
                    `text-align:left;position:relative;overflow:hidden;padding:16px;border-radius:14px;cursor:pointer;` +
                      `background:linear-gradient(160deg,${color}${on ? "2e" : "12"},${C.card} 55%);` +
                      `border:1px solid ${on ? color : `${color}44`};` +
                      (on ? `box-shadow:0 0 0 3px ${color}33,0 18px 40px rgba(0,0,0,.45)` : "") +
                      (s.loud && !on ? ";animation:vcPulse 2.4s ease-in-out infinite" : ""),
                  )}
                >
                  <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:8px")}>
                    <span style={sx(tag(color))}>{card.tier}</span>
                    <span style={sx(`font:700 10px/1 ${MONO};letter-spacing:.1em;color:${bull ? C.green : C.red}`)}>
                      {bull ? "↑ BULLISH" : "↓ BEARISH"}
                    </span>
                  </div>

                  <div style={sx(`margin-top:14px;font:700 34px/1 ${MONO};letter-spacing:-.03em;color:${color}`)}>
                    ×{s.mult.toFixed(2)}
                  </div>
                  <div style={sx(`margin-top:6px;font:500 10px/1 ${MONO};color:${C.dim}`)}>
                    ~{(s.prob * 100).toFixed(s.prob < 0.1 ? 1 : 0)}% all {n} land · {TIERS[card.tier].risk}
                  </div>

                  <div style={sx(`margin-top:12px;padding-top:10px;border-top:1px solid ${C.line};font:400 11px/1.5 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>
                    All {n} legs close {bull ? "above" : "below"} their {card.tier} lines
                    <span style={sx(`color:${C.dim}`)}> — {line === 1 ? "the base move" : `${line}× the base move`}.</span>
                  </div>

                  <div style={sx("display:flex;align-items:baseline;justify-content:space-between;margin-top:10px")}>
                    <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>IF IT PAYS</span>
                    <span style={sx(`font:700 13px/1 ${MONO};color:${C.text}`)}>
                      {s.potentialPoints.toLocaleString("en-US")} <span style={sx(`font:500 9px/1 ${MONO};color:${C.dim}`)}>PTS</span>
                    </span>
                  </div>

                  {on && (
                    <div
                      style={sx(
                        `position:absolute;top:12px;right:12px;width:18px;height:18px;border-radius:99px;` +
                          `background:${color};color:${C.bg};display:grid;place-items:center;font:700 11px/1 ${MONO}`,
                      )}
                    >
                      ✓
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div style={sx(`margin-top:14px;padding:12px 16px;border:1px solid ${C.border};border-radius:12px;background:${C.card};font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
            Every leg must land for the parlay to pay. Against {p.opponent.name} the duel goes to whoever
            lands more legs; a tie goes to conviction. Higher tiers pay more — and hand the tie to the
            steadier slip.
          </div>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:16px;position:sticky;top:76px")}>
          <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`)}>
            <div style={sx(`display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
              <div style={sx(avatarStyle(C.indigo, 26))}>YO</div>
              <span style={sx(`font:700 13px/1 ${SANS}`)}>Your slip</span>
              <div style={sx("flex:1")} />
              <span style={sx(`font:500 10px/1 ${MONO};color:${p.selected ? TIER_COLOR[p.selected.tier] : C.dim}`)}>
                {p.selected ? p.selected.label : "pick a card"}
              </span>
            </div>
            <div style={sx("display:flex;flex-direction:column;gap:8px;padding:12px")}>
              {p.myLegs.map((l) => (
                <div
                  key={l.sym}
                  data-leg={l.sym}
                  style={sx(`padding:10px 11px;border-radius:9px;background:${C.raised};border:1px solid ${C.border}`)}
                >
                  <div style={sx("display:flex;align-items:center;justify-content:space-between")}>
                    <span style={sx(`font:700 12px/1 ${MONO}`)}>{l.sym}</span>
                    <span style={sx(tag(sectorColor(l.sector ?? "")))}>{l.sector}</span>
                  </div>
                  <div style={sx(`margin-top:7px;font:400 10px/1.4 ${MONO};color:${p.selected ? C.textSoft : C.faint}`)}>
                    {p.selected ? conditionText(l) : "line set by the card you pick"}
                  </div>
                </div>
              ))}
            </div>
            <div style={sx(`padding:0 12px 12px`)}>
              <button
                onClick={p.onLock}
                disabled={!p.selected}
                style={sx(
                  `width:100%;height:38px;border:none;border-radius:8px;font:700 12.5px/1 ${SANS};` +
                    (p.selected
                      ? `background:${C.accent};color:${C.bg};cursor:pointer`
                      : `background:${C.border};color:${C.dim};cursor:not-allowed`),
                )}
              >
                Lock parlay → duel
              </button>
            </div>
          </div>

          <div
            style={sx(
              "border:1px solid rgba(248,113,113,.35);border-radius:12px;overflow:hidden;" +
                "background:linear-gradient(180deg,rgba(248,113,113,.08),#0f0f11 40%)",
            )}
          >
            <div style={sx(`display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
              <div style={sx(avatarStyle(p.opponent.bg, 26))}>{p.opponent.initial}</div>
              <div>
                <div style={sx(`font:700 13px/1 ${SANS}`)}>{p.opponent.name}</div>
                <div style={sx(`margin-top:4px;font:400 10px/1 ${MONO};color:${C.red}`)}>picking…</div>
              </div>
            </div>
            <div style={sx("display:flex;flex-direction:column;gap:8px;padding:12px")}>
              {p.arena.map((sym) => (
                <div
                  key={sym}
                  style={sx(`display:flex;align-items:center;gap:10px;padding:10px;border:1px dashed ${C.borderMid};border-radius:9px`)}
                >
                  <span style={sx(`font:700 12px/1 ${MONO};min-width:48px`)}>{sym}</span>
                  <span style={sx(`font:700 13px/1 ${MONO};letter-spacing:.24em;color:${C.borderMid}`)}>•••••</span>
                </div>
              ))}
              <div style={sx(`margin-top:4px;font:400 10.5px/1.5 ${MONO};color:${C.faint};text-align:center`)}>
                Revealed when both slips lock.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
