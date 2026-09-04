import { useEffect, useRef } from "react";
import { PlayerMark } from "../components/PlayerMark.tsx";
import { YOU_INITIALS, YOU_NAME } from "../data/leaderboard.ts";
import { modeTag, type ModeSpec } from "../data/modes.ts";
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
import { sfx, startTrack, stopTrack } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, sectorColor, tag } from "../theme.ts";
import type { Player } from "../types.ts";

/**
 * The four tiers ride four pitches: SAFE 880 · EVEN 988 · SHARP 1174 ·
 * DEGEN 1396 Hz. `parlay.card.hover` and `parlay.card.pick` are both written
 * around 880 (map.ts), so what they take is the ratio — and DEGEN's 1396 is
 * the threshold that earns it the detuned, unstable minor third.
 */
const TIER_PITCH: Record<Tier, number> = {
  SAFE: 1,
  EVEN: 988 / 880,
  SHARP: 1174 / 880,
  DEGEN: 1396 / 880,
};

/** Tier accents. DEGEN borrows the HIGH VAR violet. */
export const TIER_COLOR: Record<Tier, string> = {
  SAFE: C.green,
  EVEN: C.accent,
  SHARP: C.amber,
  DEGEN: C.violet,
};

interface ParlayPickProps {
  lobbyName: string;
  /** This match's window. Its `oddsBoost` is already inside `summary.mult`;
   *  the slip only has to say where the premium came from. */
  mode: ModeSpec;
  opponent: Player;
  arena: readonly string[];
  /** Your pick per ticker so far. */
  picks: Readonly<Record<string, ParlayCard>>;
  allPicked: boolean;
  /** Whole seconds left on the pick clock; `null` on an untimed mode, and the
   *  chip, the beeps and the EVEN note all disappear with it. */
  secondsLeft: number | null;
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
/** The last five seconds are the loud ones. */
const HOT = 5;

/**
 * The pick phase's bed — the hero-select music.
 *
 * Served by `index.ts` from `src/assets/` when the operator has dropped a file
 * there, and 404'd cleanly when they have not, exactly like the room's
 * `room-inspect.mp3`. The whole directory is gitignored on purpose (the audio
 * is game-ripped and licensed to someone else), so a fresh clone plays this
 * screen in silence and nothing about that is an error path — see
 * `docs/HANDOFF.md`, "Local-only artifacts".
 */
const PICK_TRACK = "/assets/parlay-pick.mp3";

/** `0:18` — a clock reads as a clock, and the monospace stops it juddering. */
const clockText = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

export function ParlayPick(p: ParlayPickProps) {
  const left = p.arena.filter((s) => !p.picks[s]).length;
  const s = p.summary;
  const counting = p.secondsLeft !== null;
  const hot = p.secondsLeft !== null && p.secondsLeft <= HOT;

  /**
   * The pick music, on exactly the room's terms.
   *
   * The UNMOUNT is the general case and it covers every exit there is: the
   * clock running out, the lock button, a rematch, the back arrow, a reload.
   * The pick screen is only ever mounted by `App` for the pick phase, so
   * leaving the phase unmounts it and the cleanup fades the bed out — there is
   * no exit path that needs its own call.
   *
   * `stopTrack("room")` on the way IN is the belt to that braces. The room's
   * own cleanup already stops its bed when `App` swaps the view, and React runs
   * that cleanup before this effect; the explicit stop makes "the pick bed and
   * the room bed never sound together" a property of this file rather than a
   * property of two files and an ordering guarantee between them. Stopping a
   * track that is not playing is a no-op.
   *
   * Levels, fades and the reduced-motion opt-out are all the engine's
   * (`TRACK_GAIN` 0.22 on the ambience bus, 800ms in, 600ms out) — the same
   * numbers the room gets, because it is the same call.
   */
  useEffect(() => {
    stopTrack("room");
    startTrack("parlay", PICK_TRACK);
    return () => {
      stopTrack("parlay");
    };
  }, []);

  // One beep per distinct second of the last five. The clock re-renders far
  // more often than once a second, so the ref — not the render — is what makes
  // it fire exactly once; `countdown.final` marks the last one.
  const beeped = useRef<number | null>(null);
  useEffect(() => {
    const n = p.secondsLeft;
    if (n === null || n > HOT || n < 1) {
      if (n === null) beeped.current = null;
      return;
    }
    if (beeped.current === n) return;
    beeped.current = n;
    // `leg` is how the recipe receives the seconds remaining (map.ts).
    sfx(n === 1 ? "countdown.final" : "countdown.beep", { leg: n });
  }, [p.secondsLeft]);

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
        <span style={sx(modeTag(p.mode.key))}>
          {p.mode.label} · {p.mode.duration}
        </span>
        {p.secondsLeft !== null && (
          <span
            data-testid="pick-clock"
            style={sx(
              `font:700 13px/1 ${MONO};letter-spacing:.08em;border-radius:6px;padding:6px 9px;` +
                (hot
                  ? `color:${C.red};border:1px solid ${C.red}66;background:${C.red}1a;` +
                    "animation:vcPulse 1.6s ease-in-out infinite"
                  : `color:${C.text};border:1px solid ${C.borderMid};background:${C.raised}`),
            )}
          >
            {clockText(p.secondsLeft)}
          </span>
        )}
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
                        onPointerEnter={() => sfx("parlay.card.hover", { pitch: TIER_PITCH[card.tier] })}
                        onClick={() => {
                          sfx("parlay.card.pick", { pitch: TIER_PITCH[card.tier] });
                          p.onPick(sym, card.id);
                        }}
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
              <PlayerMark name={YOU_NAME} initials={YOU_INITIALS} bg={C.indigo} size={26} />
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

            {/* The shorter the window, the more the house pays for it. NORMAL
                is the base edition — no boost, no line. */}
            {p.mode.oddsBoost > 1 && (
              <div
                data-testid="odds-boost"
                style={sx(`display:flex;align-items:center;gap:9px;padding:10px 14px;border-top:1px solid ${C.line}`)}
              >
                <span style={sx(modeTag(p.mode.key))}>
                  {p.mode.label} +{Math.round((p.mode.oddsBoost - 1) * 100)}%
                </span>
                <span style={sx(`font:400 10px/1.4 ${MONO};color:${C.dim}`)}>window premium, already in the odds</span>
              </div>
            )}

            <div style={sx("padding:12px")}>
              <button
                onClick={() => {
                  // Eagerly, on the room's pattern: the 600ms fade is already
                  // running under the lock sound rather than starting when the
                  // duel takes the screen. The unmount cleanup is what actually
                  // guarantees it; this only decides when the fade begins.
                  stopTrack("parlay");
                  sfx("parlay.lock");
                  p.onLock();
                }}
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
              {counting && (
                <div
                  data-testid="pick-clock-note"
                  style={sx(`margin-top:8px;text-align:center;font:400 10px/1.4 ${MONO};color:${hot ? C.red : C.dim}`)}
                >
                  unpicked legs lock at EVEN ↑
                </div>
              )}
            </div>
          </div>

          <div
            style={sx(
              "border:1px solid rgba(248,113,113,.35);border-radius:12px;overflow:hidden;" +
                "background:linear-gradient(180deg,rgba(248,113,113,.08),#0f0f11 40%)",
            )}
          >
            <div style={sx(`display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
              <PlayerMark
                name={p.opponent.name}
                initials={p.opponent.initial}
                bg={p.opponent.bg}
                size={26}
              />
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
