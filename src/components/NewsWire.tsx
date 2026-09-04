import { useEffect, useMemo, useRef, useState } from "react";
import type { WireItem } from "../data/wire.ts";
import { meta } from "../data/universe.ts";
import { sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, sectorColor, tag } from "../theme.ts";

interface NewsWireProps {
  /** The feed, newest first. Desk rows are pinned to the top on render. */
  items: readonly WireItem[];
  /** Where the feed came from — drawn as the header chip. */
  status: "mock" | "live" | "partial";
}

/** Header chip copy and colour per source. `partial` = live, but a feed dropped. */
const STATUS: Record<NewsWireProps["status"], { label: string; color: string }> = {
  mock: { label: "SEEDED", color: C.amber },
  live: { label: "LIVE", color: C.green },
  partial: { label: "PARTIAL", color: C.blue },
};

/** Scroll height of the headline list — about nine rows, so the feed reads as
 *  a feed (there is always more below the fold) without eating the charts. */
const LIST_H = 288;

/** How many freshly-arrived news rows get a tick, and the gap between them. */
const TICK_ROWS = 6;
const TICK_GAP_MS = 90;

const rowStyle = (selected: boolean, desk: boolean): string =>
  `display:grid;grid-template-columns:76px 46px minmax(0,1fr);gap:10px;align-items:center;` +
  `padding:6px 14px;cursor:pointer;text-align:left;width:100%;border:none;` +
  `border-bottom:1px solid ${C.lineSoft};font:400 11.5px/1.45 ${MONO};` +
  (selected
    ? `background:rgba(200,255,0,.08);box-shadow:inset 2px 0 0 ${C.accent};color:${C.text}`
    : `background:${desk ? C.panelAlt : "transparent"};color:${C.textSoft}`);

/** One line, clipped rather than wrapped — a wire never reflows. */
const CLIP = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0";

/** `tag()` at terminal scale: the sym column is 46px, so the chip is tighter
 *  and centred. The overrides trail the shorthand so they win. */
const symChip = (color: string): string =>
  `${tag(color)};justify-content:center;padding:5px 4px;font-size:8px;letter-spacing:.06em;${CLIP}`;

/**
 * The study terminal's news wire: a scrolling headline list over a filed-story
 * detail pane, dressed as a Dow Jones terminal.
 *
 * The wire is flavour and nothing else — settlement never reads it — so this
 * component is handed a finished `WireItem[]` and owns only presentation and
 * the two wire sound seams. The feed swaps under it when the live source
 * resolves; selection is therefore held as an *id*, not an index, and re-found
 * on every render. The fallback to the first row means the detail pane cannot
 * be empty, which is why nothing here has an "unselected" branch to draw.
 */
export function NewsWire({ items, status }: NewsWireProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selId, setSelId] = useState<string | null>(null);

  /**
   * Desk chatter pins above the filed stories: the coach's read is the reason
   * the player is on this screen, and it should not scroll away under a live
   * feed. Both partitions keep their source order, so the news half stays
   * strictly ts-descending.
   */
  const rows = useMemo(
    () => [...items.filter((i) => i.kind === "desk"), ...items.filter((i) => i.kind === "news")],
    [items],
  );

  /** Selection survives a mock → live swap: the id is looked up again, and a
   *  miss falls through to the top row rather than blanking the pane. */
  const selected = rows.find((i) => i.id === selId) ?? rows[0];

  /**
   * The wire ticking in. Fires on mount and on every feed swap, staggered over
   * the first few news rows so the terminal sounds like it is receiving rather
   * than like one click. Keyed on the head id + length (not array identity) so
   * an unrelated re-render with an equal feed stays silent. In tests
   * `audioAvailable` is false, so this costs zero timers.
   */
  useEffect(() => {
    items
      .filter((i) => i.kind === "news")
      .slice(0, TICK_ROWS)
      .forEach((_, i) => sfx("wire.tick", { delayMs: i * TICK_GAP_MS }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items[0]?.id, items.length]);

  const open = (item: WireItem) => {
    sfx("wire.select");
    setSelId(item.id);
  };

  /** ↑/↓ walks the list. Keeps the moved-to row in view when the pane can
   *  scroll; `scrollIntoView` is optional-called because happy-dom has none. */
  const step = (delta: number) => {
    if (rows.length === 0) return;
    const at = rows.findIndex((i) => i.id === selected?.id);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))];
    if (!next || next.id === selected?.id) return;
    open(next);
    const el = listRef.current?.querySelector(`[data-wire-id="${next.id}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  };

  const chip = STATUS[status];

  return (
    <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`)}>
      {/* The bar Study has always carried, plus the source chip on the right. */}
      <div style={sx(`display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
        <span style={sx(`width:6px;height:6px;border-radius:99px;background:${C.amber};animation:vcPulse 1.4s ease-in-out infinite`)} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.amber}`)}>NEWS WIRE · DESK CHATTER</span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>SAME WIRE ON BOTH SCREENS</span>
        <span
          data-testid="wire-status"
          title={`Wire source: ${status}`}
          style={sx(
            `font:700 9px/1 ${MONO};letter-spacing:.12em;padding:5px 7px;border-radius:5px;` +
              `border:1px solid ${chip.color}55;background:${chip.color}1f;color:${chip.color}`,
          )}
        >
          {chip.label}
        </span>
      </div>

      {/* TOP PANE — the feed. */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="News wire headlines"
        aria-activedescendant={selected ? `wire-row-${selected.id}` : undefined}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          step(e.key === "ArrowDown" ? 1 : -1);
        }}
        style={sx(`height:${LIST_H}px;overflow-y:auto;background:${C.panel};outline:none`)}
      >
        {rows.map((item) => {
          const desk = item.kind === "desk";
          const on = item.id === selected?.id;
          return (
            <div
              key={item.id}
              id={`wire-row-${item.id}`}
              role="option"
              aria-selected={on}
              data-wire={item.kind}
              // Desk rows answer to the old selector as well: one standing
              // assertion counts `[data-brief="desk"]` on this screen.
              {...(desk ? { "data-brief": "desk" } : {})}
              data-wire-id={item.id}
              data-wire-sym={item.sym ?? "MKT"}
              onClick={() => open(item)}
              style={sx(rowStyle(on, desk))}
            >
              <span style={sx(`color:${on ? C.textSoft : C.faint};${CLIP}`)}>{item.time}</span>
              {desk ? (
                <span
                  style={sx(
                    `font:700 9px/1 ${MONO};letter-spacing:.1em;text-align:center;` +
                      // Study's own mapping, kept verbatim: the coach speaks in
                      // accent, the desk in blue.
                      `color:${item.who === "COACH" ? C.accent : C.blue};${CLIP}`,
                  )}
                >
                  {item.who ?? "DESK"}
                </span>
              ) : item.sym ? (
                <span style={sx(symChip(sectorColor(meta(item.sym).sector)))}>{item.sym}</span>
              ) : (
                <span style={sx(`font:500 8px/1 ${MONO};letter-spacing:.06em;text-align:center;color:${C.dim};${CLIP}`)}>
                  MKT
                </span>
              )}
              <span style={sx(CLIP)}>{desk ? `“${item.headline}”` : item.headline}</span>
            </div>
          );
        })}
      </div>

      {/* BOTTOM PANE — the filed story behind the selected line. */}
      <div
        data-testid="wire-detail"
        style={sx(`min-height:196px;padding:16px 20px;background:${C.panelAlt};border-top:1px solid ${C.border}`)}
      >
        {selected ? (
          <>
            <div
              data-testid="wire-dateline"
              style={sx(
                `font:700 12px/1.5 ${MONO};color:${C.textSoft};text-align:center;` +
                  `padding-bottom:10px;border-bottom:1px solid ${C.line};text-wrap:pretty`,
              )}
            >
              {selected.dateline}
            </div>

            <div
              style={sx(
                `max-width:74ch;margin:14px auto 0;font:400 12.5px/1.7 ${SANS};color:${C.muted};text-wrap:pretty`,
              )}
            >
              {selected.body}
            </div>

            {/* Live items carry a source link; seeded ones never do. */}
            {selected.link ? (
              <div style={sx("max-width:74ch;margin:12px auto 0")}>
                <a
                  href={selected.link}
                  target="_blank"
                  rel="noreferrer"
                  style={sx(`font:400 10px/1.5 ${MONO};color:${C.blue};text-decoration:none;word-break:break-all`)}
                >
                  READ ON {selected.publisher} ↗
                </a>
              </div>
            ) : null}

            <div
              data-testid="wire-signature"
              style={sx(
                `max-width:74ch;margin:14px auto 0;padding-top:12px;border-top:1px solid ${C.line};` +
                  `font:400 10.5px/1.6 ${MONO};color:${C.faint};text-wrap:pretty`,
              )}
            >
              {selected.signature}
            </div>
          </>
        ) : (
          // Unreachable with any real source — the seeded wire is never empty —
          // but the pane still has to draw something if one hands it nothing.
          <div style={sx(`font:400 12px/1.7 ${SANS};color:${C.faint};text-align:center`)}>
            The wire is quiet. No stories have filed on this board.
          </div>
        )}
      </div>
    </div>
  );
}
