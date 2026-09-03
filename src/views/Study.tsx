import { Sparkline } from "../components/Sparkline.tsx";
import type { Brief } from "../data/briefs.ts";
import { meta } from "../data/universe.ts";
import { buildChartCard } from "../engine/chart.ts";
import { TAPE_LEN, fmtPx, series } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, sectorColor } from "../theme.ts";
import type { Player } from "../types.ts";

interface StudyProps {
  /** Symbols to chart: the legs the spin dealt. */
  arena: readonly string[];
  /** The reading material, drawn by the seed. */
  briefs: readonly Brief[];
  salt: number;
  opponent: Player;
  prizeLabel: string;
  onDone: () => void;
}

/** Both players read the same charts and the same wire before picking a parlay. */
export function Study({ arena, briefs, salt, opponent, prizeLabel, onDone }: StudyProps) {
  const cols = Math.min(3, Math.max(2, arena.length));
  const firstTarget = meta(arena[0] ?? "ETH").t;

  const notes = [
    {
      tag: "READ 01",
      title: "Trend, then target",
      body:
        `A ±${firstTarget.toFixed(1)}% line on a name that trended the whole window is not the same ` +
        "position as on one that chopped. Match the tier to the behaviour.",
    },
    {
      tag: "READ 02",
      title: "The tape you duel on is new",
      body: "These charts are the study window. The duel draws a fresh random window on the same tickers, so read behaviour, not levels.",
    },
    {
      tag: "READ 03",
      title: `${opponent.name} is reading this too`,
      body: "Same charts, same wire, same book. The edge is in the parlay you pick, not the tickers — those were dealt.",
    },
  ];

  return (
    <div style={sx("padding:24px 28px;max-width:1720px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:18px")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Case study</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.blue};` +
              "border:1px solid rgba(56,189,248,.35);background:rgba(56,189,248,.12);" +
              "border-radius:6px;padding:6px 8px",
          )}
        >
          STUDY PHASE · BOTH PLAYERS READING
        </span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>POOL</span>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>{prizeLabel}</span>
      </div>

      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start")}>
        <div style={sx("display:flex;flex-direction:column;gap:18px;min-width:0")}>
          <div style={sx(`display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px`)}>
            {arena.map((sym) => {
              const card = buildChartCard(sym, salt, TAPE_LEN, 110);
              const u = meta(sym);
              const tape = series(sym, salt);
              const hi = Math.max(...tape);
              const lo = Math.min(...tape);

              return (
                <div
                  key={sym}
                  style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.panel};padding:14px`)}
                >
                  <div style={sx("display:flex;align-items:flex-start;justify-content:space-between")}>
                    <div>
                      <div style={sx(`font:700 15px/1 ${MONO}`)}>{card.sym}</div>
                      <div style={sx(`margin-top:5px;font:400 9.5px/1 ${MONO};color:${C.faint}`)}>{card.window}</div>
                    </div>
                    <div style={sx("text-align:right")}>
                      <div style={sx(`font:700 14px/1 ${MONO};color:${card.stroke}`)}>{card.pct}</div>
                      <div style={sx(`margin-top:5px;font:400 10px/1 ${MONO};color:${C.dim}`)}>{card.px}</div>
                    </div>
                  </div>

                  <Sparkline card={card} height={110} />

                  <div
                    style={sx(
                      "display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px;" +
                        `padding-top:12px;border-top:1px solid ${C.line}`,
                    )}
                  >
                    {[
                      { label: "RANGE", value: `${fmtPx(lo)}–${fmtPx(hi)}` },
                      { label: "σ DAILY", value: `${(u.vol * 100).toFixed(1)}%` },
                      { label: "SECTOR", value: u.sector },
                    ].map((s) => (
                      <div key={s.label}>
                        <div style={sx(`font:500 8px/1 ${MONO};letter-spacing:.1em;color:${C.faint}`)}>{s.label}</div>
                        <div style={sx(`margin-top:5px;font:700 11.5px/1 ${MONO}`)}>{s.value}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* The wire: one line per ticker, then the desk talking. */}
          <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`)}>
            <div style={sx(`display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
              <span style={sx(`width:6px;height:6px;border-radius:99px;background:${C.amber};animation:vcPulse 1.4s ease-in-out infinite`)} />
              <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.amber}`)}>NEWS WIRE · DESK CHATTER</span>
              <div style={sx("flex:1")} />
              <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>SAME WIRE ON BOTH SCREENS</span>
            </div>
            <div style={sx("display:flex;flex-direction:column")}>
              {briefs.map((b, i) => (
                <div
                  key={i}
                  data-brief={b.kind}
                  style={sx(
                    `display:grid;grid-template-columns:72px minmax(0,1fr);gap:12px;align-items:start;padding:11px 16px;` +
                      `border-bottom:1px solid ${C.lineSoft};background:${b.kind === "desk" ? C.panelAlt : "transparent"}`,
                  )}
                >
                  {b.kind === "news" ? (
                    <span
                      style={sx(
                        `font:700 10px/1 ${MONO};padding:5px 7px;border-radius:5px;text-align:center;` +
                          `border:1px solid ${sectorColor(meta(b.sym!).sector)}55;color:${sectorColor(meta(b.sym!).sector)}`,
                      )}
                    >
                      {b.sym}
                    </span>
                  ) : (
                    <span style={sx(`font:700 9px/1 ${MONO};letter-spacing:.12em;padding:5px 0;color:${b.who === "COACH" ? C.accent : C.blue}`)}>
                      {b.who}
                    </span>
                  )}
                  <span style={sx(`font:400 12px/1.55 ${SANS};color:${b.kind === "desk" ? C.textSoft : C.muted};text-wrap:pretty`)}>
                    {b.kind === "desk" ? `“${b.text}”` : b.text}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:16px")}>
          <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`)}>
            <div style={sx(`display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ${C.border}`)}>
              <div
                style={sx(
                  `width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,${C.indigo},${C.accent});` +
                    `display:grid;place-items:center;font:700 12px/1 ${MONO};color:${C.bg}`,
                )}
              >
                AI
              </div>
              <span style={sx(`font:700 13px/1 ${SANS}`)}>Coach reads the tape</span>
            </div>
            <div style={sx("display:flex;flex-direction:column;gap:12px;padding:16px")}>
              {notes.map((n) => (
                <div key={n.tag} style={sx(`border-left:2px solid ${C.borderMid};padding-left:12px`)}>
                  <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.accent}`)}>{n.tag}</div>
                  <div style={sx(`margin-top:7px;font:700 12px/1.35 ${SANS}`)}>{n.title}</div>
                  <div style={sx(`margin-top:5px;font:400 11.5px/1.55 ${SANS};color:${C.muted};text-wrap:pretty`)}>{n.body}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};padding:16px`)}>
            <div style={sx(`font:400 11.5px/1.6 ${SANS};color:${C.muted};text-wrap:pretty`)}>
              These are the tickers the spin dealt, on the window the engine drew. Study them, then
              pick a parlay — the tape you duel on starts where these charts end.
            </div>
            <button
              onClick={onDone}
              style={sx(
                `width:100%;height:40px;margin-top:14px;border:none;border-radius:8px;` +
                  `background:${C.accent};color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
              )}
            >
              Done studying → pick a parlay
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
