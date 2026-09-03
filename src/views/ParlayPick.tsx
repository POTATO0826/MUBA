import { meta } from "../data/universe.ts";
import {
  PARLAY_CARDS,
  TIERS,
  conditionText,
  legForCard,
  slipLabel,
  type ParlayCard,
  type ParlayLeg,
  type ParlaySummary,
  type Tier,
} from "../engine/parlay.ts";
import { fmtPx } from "../engine/tape.ts";
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
  /** Your pick per ticker so far. */
  picks: Readonly<Record<string, ParlayCard>>;
  allPicked: boolean;
  /** Your slip: real legs where picked, an EVEN-bullish preview where not. */
  myLegs: readonly ParlayLeg[];
  summary: ParlaySummary;
  stakePoints: number;
  prizeLabel: string;
  onPick: (sym: string, cardId: string) => void;
  onLock: () => void;
}

/**
 * One block per dealt ticker, eight cards in each: four tiers, bullish and
 * bearish. Pick one per ticker; the parlay is the combination. The odds on
 * the slip are the product of the legs — every leg has to land.
 */
export function ParlayPick(p: ParlayPickProps) {
  const left = p.arena.filter((s) => !p.picks[s]).length;
  const s = p.summary;

  return (
    <div style={sx("padding:24px 28px;max-width:1720px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Build your parlay · {p.lobbyName}</h2>
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
        <div style={sx("display:flex;flex-direction:column;gap:16px")}>
          {p.arena.map((sym) => {
            const u = meta(sym);
            const picked = p.picks[sym] ?? null;
            const color = sectorColor(u.sector);
            return (
              <section
                key={sym}
                data-leg-picker={sym}
                style={sx(`border:1px solid ${picked ? `${TIER_COLOR[picked.tier]}66` : C.border};border-radius:12px;background:${C.panel};overflow:hidden`)}
              >
                <div style={sx(`display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
                  <span style={sx(`font:700 16px/1 ${MONO}`)}>{sym}</span>
                  <span style={sx(tag(color))}>{u.sector}</span>
                  <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>${fmtPx(u.px)} · base ±{u.t.toFixed(1)}%</span>
                  <div style={sx("flex:1")} />
                  <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${picked ? TIER_COLOR[picked.tier] : C.faint}`)}>
                    {picked ? `${picked.label} · ×${picked && TIERS[picked.tier].mult.toFixed(1)}` : "pick one"}
                  </span>
                </div>

                <div style={sx("display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:12px 16px")}>
                  {PARLAY_CARDS.map((card) => {
                    const leg = legForCard(sym, card);
                    const tc = TIER_COLOR[card.tier];
                    const on = picked?.id === card.id;
                    const bull = card.stance === "bull";
                    return (
                      <button
                        key={card.id}
                        data-parlay={`${sym}:${card.id}`}
                        aria-pressed={on}
                        onClick={() => p.onPick(sym, card.id)}
                        style={sx(
                          `text-align:left;position:relative;padding:12px;border-radius:10px;cursor:pointer;` +
                            `background:linear-gradient(160deg,${tc}${on ? "2e" : "0f"},${C.card} 60%);` +
                            `border:1px solid ${on ? tc : `${tc}3d`};` +
                            (on ? `box-shadow:0 0 0 2px ${tc}33` : ""),
                        )}
                      >
                        <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:6px")}>
                          <span style={sx(tag(tc))}>{card.tier}</span>
                          <span style={sx(`font:700 9.5px/1 ${MONO};letter-spacing:.08em;color:${bull ? C.green : C.red}`)}>
                            {bull ? "↑ BULL" : "↓ BEAR"}
                          </span>
                        </div>
                        <div style={sx(`margin-top:10px;font:700 22px/1 ${MONO};letter-spacing:-.02em;color:${tc}`)}>
                          ×{card && TIERS[card.tier].mult.toFixed(1)}
                        </div>
                        <div style={sx(`margin-top:6px;font:400 10px/1.4 ${MONO};color:${C.dim}`)}>
                          {bull ? "above" : "below"} {fmtPx(leg.strike)} · ~{Math.round(leg.prob * 100)}%
                        </div>
                        {on && (
                          <div
                            style={sx(
                              `position:absolute;top:8px;right:8px;width:16px;height:16px;border-radius:99px;` +
                                `background:${tc};color:${C.bg};display:grid;place-items:center;font:700 10px/1 ${MONO}`,
                            )}
                          >
                            ✓
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <div style={sx(`padding:12px 16px;border:1px solid ${C.border};border-radius:12px;background:${C.card};font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
            One pick per ticker. Every leg must land for the parlay to pay. Against {p.opponent.name} the duel
            goes to whoever lands more legs; a tie goes to conviction. Higher tiers pay more — and hand the
            tie to the steadier slip.
          </div>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:16px;position:sticky;top:76px")}>
          <div style={sx(`border:1px solid ${s.loud && p.allPicked ? C.violet : C.border};border-radius:12px;background:${C.panel};overflow:hidden`)}>
            <div style={sx(`display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
              <div style={sx(avatarStyle(C.indigo, 26))}>YO</div>
              <span style={sx(`font:700 13px/1 ${SANS}`)}>Your slip</span>
              <div style={sx("flex:1")} />
              <span style={sx(`font:500 10px/1 ${MONO};color:${p.allPicked ? C.text : C.dim}`)}>
                {p.allPicked ? slipLabel(p.myLegs) : `${left} to pick`}
              </span>
            </div>

            <div style={sx("display:flex;flex-direction:column;gap:8px;padding:12px")}>
              {p.myLegs.map((l) => {
                const has = Boolean(p.picks[l.sym]);
                return (
                  <div
                    key={l.sym}
                    data-leg={l.sym}
                    style={sx(`padding:10px 11px;border-radius:9px;background:${C.raised};border:1px solid ${has ? `${TIER_COLOR[l.tier]}55` : C.border}`)}
                  >
                    <div style={sx("display:flex;align-items:center;justify-content:space-between")}>
                      <span style={sx(`font:700 12px/1 ${MONO}`)}>{l.sym}</span>
                      <span style={sx(`font:700 11px/1 ${MONO};color:${has ? TIER_COLOR[l.tier] : C.faint}`)}>
                        {has ? `${l.tier} ×${l.mult.toFixed(1)}` : "—"}
                      </span>
                    </div>
                    <div style={sx(`margin-top:7px;font:400 10px/1.4 ${MONO};color:${has ? C.textSoft : C.faint}`)}>
                      {has ? conditionText(l) : "no pick yet"}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={sx(`display:grid;grid-template-columns:1fr 1fr 1fr;border-top:1px solid ${C.border}`)}>
              <Stat label="ODDS" value={p.allPicked ? `×${s.mult.toFixed(2)}` : "—"} color={s.loud ? C.violet : C.accent} testid="combined-mult" />
              <Stat label="ALL LAND" value={p.allPicked ? `${(s.prob * 100).toFixed(s.prob < 0.1 ? 1 : 0)}%` : "—"} color={s.loud ? C.violet : C.text} testid="implied-prob" />
              <Stat label="IF IT PAYS" value={p.allPicked ? s.potentialPoints.toLocaleString("en-US") : "—"} testid="potential-points" />
            </div>

            <div style={sx("padding:12px")}>
              <button
                onClick={p.onLock}
                disabled={!p.allPicked}
                style={sx(
                  `width:100%;height:38px;border:none;border-radius:8px;font:700 12.5px/1 ${SANS};` +
                    (p.allPicked
                      ? `background:${C.accent};color:${C.bg};cursor:pointer`
                      : `background:${C.border};color:${C.dim};cursor:not-allowed`),
                )}
              >
                {p.allPicked ? "Lock parlay → duel" : `Pick ${left} more`}
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
                <div key={sym} style={sx(`display:flex;align-items:center;gap:10px;padding:10px;border:1px dashed ${C.borderMid};border-radius:9px`)}>
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

function Stat({ label, value, color, testid }: { label: string; value: string; color?: string; testid: string }) {
  return (
    <div style={sx(`padding:12px 14px;border-right:1px solid ${C.line}`)}>
      <div style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>{label}</div>
      <div data-testid={testid} style={sx(`margin-top:6px;font:700 15px/1 ${MONO}${color ? `;color:${color}` : ""}`)}>
        {value}
      </div>
    </div>
  );
}
