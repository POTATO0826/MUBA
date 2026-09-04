import { useState } from "react";
import { NewsWire } from "../components/NewsWire.tsx";
import { Sparkline } from "../components/Sparkline.tsx";
import { modeTag, type ModeSpec } from "../data/modes.ts";
import type { WireItem } from "../data/news.ts";
import { meta } from "../data/universe.ts";
import { buildChartCard } from "../engine/chart.ts";
import { fmtPx, series } from "../engine/tape.ts";
import { playClip, sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { Player } from "../types.ts";

interface StudyProps {
  /** Symbols to chart: the legs the spin dealt. */
  arena: readonly string[];
  /** The terminal's feed: filed stories per ticker with the desk exchange
   *  folded in on top. Seeded off the same salt as the charts, or live. */
  wire: readonly WireItem[];
  /** Where that feed came from — the terminal draws it as its header chip. */
  wireStatus: "mock" | "live" | "partial";
  salt: number;
  /** The print the duel will settle on. The study charts are drawn to exactly
   *  that window, so what you read is the length you play. */
  settleAt: number;
  mode: ModeSpec;
  opponent: Player;
  prizeLabel: string;
  onDone: () => void;
}

/**
 * The case card, resting and filtering.
 *
 * The lit branch is `rowStyle`'s selected read in card form — the accent, the
 * same 8% wash — but drawn as a border rather than an inset bar, because a card
 * has four sides where a wire row has one. Both branches carry a 1px border and
 * the same padding, so the grid is laid out identically either way: pressing a
 * card must not shuffle the charts beside it by a pixel.
 */
const caseCardStyle = (on: boolean): string =>
  `border-radius:12px;padding:14px;cursor:pointer;` +
  (on
    ? `border:1px solid ${C.accent}99;background:rgba(200,255,0,.06);box-shadow:inset 0 0 0 1px rgba(200,255,0,.18)`
    : `border:1px solid ${C.border};background:${C.panel}`);

/** Both players read the same charts and the same wire before picking a parlay. */
export function Study({ arena, wire, wireStatus, salt, settleAt, mode, opponent, prizeLabel, onDone }: StudyProps) {
  const cols = Math.min(3, Math.max(2, arena.length));
  const firstTarget = meta(arena[0] ?? "ETH").t;

  /**
   * Which ticker the terminal is reading, or `null` for the whole board.
   *
   * One piece of state with two handles on it: the case card above and the sym
   * chip on a wire row below. Both call `toggleSym`, both read `filterSym`, and
   * neither owns it — which is the only arrangement where pressing SOL on a
   * card and pressing SOL on a row cannot disagree about what the wire is
   * showing. It lives here rather than in `NewsWire` because the cards are
   * here; the wire is handed the value and a way to flip it.
   *
   * Nothing downstream of this reaches settlement. The filter is a view over an
   * already-built feed — `data/wire.ts` is never re-run, never re-ordered, and
   * never even told a filter exists.
   */
  const [filterSym, setFilterSym] = useState<string | null>(null);

  /** Press the active ticker again and the wire comes back whole. Written as a
   *  read-then-set rather than a functional update on purpose: the sound is a
   *  side effect, and a state updater is not allowed to have one. */
  const toggleSym = (sym: string) => {
    const next = filterSym === sym ? null : sym;
    // Narrowing latches, clearing releases — the two-blip toggle the rest of
    // the app already uses for exactly this gesture.
    sfx(next ? "ui.toggle.on" : "ui.toggle.off");
    setFilterSym(next);
  };

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
      body:
        `These charts are the study window — ${mode.duration} of tape, the same length the duel runs. ` +
        "The duel draws a fresh random window on the same tickers, so read behaviour, not levels.",
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
        <span style={sx(modeTag(mode.key))}>
          {mode.label} · {mode.duration}
        </span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>POOL</span>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>{prizeLabel}</span>
      </div>

      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start")}>
        <div style={sx("display:flex;flex-direction:column;gap:18px;min-width:0")}>
          <div style={sx(`display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px`)}>
            {arena.map((sym) => {
              const card = buildChartCard(sym, salt, settleAt, 110);
              const u = meta(sym);
              const tape = series(sym, salt);
              const hi = Math.max(...tape);
              const lo = Math.min(...tape);

              const on = filterSym === sym;

              return (
                // A case card is now a switch as well as a chart: it narrows the
                // terminal below to this name's stories. `role="button"` rather
                // than a real `<button>` because the card's layout is the grid's
                // — a button element brings its own box, and the charts would
                // move the first time anyone pressed one.
                <div
                  key={sym}
                  data-case={sym}
                  role="button"
                  tabIndex={0}
                  aria-pressed={on}
                  title={on ? `The wire is showing ${sym} only — click to clear` : `Filter the wire to ${sym}`}
                  onClick={() => toggleSym(sym)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault(); // Space scrolls the study page otherwise.
                    toggleSym(sym);
                  }}
                  style={sx(caseCardStyle(on))}
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

          {/* The terminal: filed stories over a detail pane, desk chatter pinned
              on top. Presentation only — settlement never reads a headline.
              The filter travels down as a value and comes back as a call: the
              sym chips on the rows are the same switch the cards are. */}
          <NewsWire items={wire} status={wireStatus} filterSym={filterSym} onSymToggle={toggleSym} />
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
              onClick={() => {
                playClip("exo-1", "/assets/exo-kill-1.mp3");
                onDone();
              }}
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
