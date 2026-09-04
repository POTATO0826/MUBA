import { useState, type KeyboardEvent } from "react";
import { MODES } from "../data/modes.ts";
import { SECTORS } from "../data/sectors.ts";
import { type LadderFilter, type LeaderPlayer, type Ranked } from "../data/leaderboard.ts";
import { RANK_COLOR } from "../components/RankBadge.tsx";
import { useSoundHover } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, avatarStyle, miniTag } from "../theme.ts";

/**
 * One rung of the ladder (plan 4 §5.2 table, §5.4 YOU row).
 *
 * Deliberately dumb: it takes a `Ranked` — the row object `rankedBy` already
 * produced — and the filter that produced it, and renders. It never sorts,
 * never filters, never reads `LEADERBOARD`. That is what lets the four filters
 * of step 7 land in `Ranking.tsx` alone: a row under EARNINGS is the same
 * component as a row under COPY HEAT, because `Ranked.label` / `Ranked.sub`
 * already carry whatever the active metric says.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE TIER COLUMN IS A WORD AND NOT A `RankBadge`
 * ────────────────────────────────────────────────────────────────────────────
 * The sigil is authored in a 100×100 box with the crest at r=23, so at a 24px
 * row height the crest renders about 11px across — below the size at which its
 * point count (the thing that distinguishes MINNOW from WHALE) is readable,
 * and fourteen copies would each carry three SMIL orbit animations for the
 * privilege. The colour is the part that survives the shrink, so the column is
 * the tier WORD in `RANK_COLOR` with a matching dot: same five-colour
 * vocabulary as the badge, legible at row height, one node instead of twenty.
 * The full badge stays where it has room — the rank moment, and step 7's
 * podium.
 */

/**
 * The column track, exported so the header in `Ranking.tsx` and every row use
 * literally the same string. A header that drifts from its rows is the classic
 * bug in a hand-rolled table; here it cannot happen without an edit to this
 * line.
 *
 *   #  ·  PLAYER  ·  TIER  ·  SPECIALTY  ·  <METRIC>  ·  TREND
 */
export const LADDER_GRID =
  "display:grid;grid-template-columns:46px minmax(150px,1.45fr) 104px 116px minmax(128px,1fr) 84px;" +
  "align-items:center;gap:14px";

/** Padding shared by the header strip and the rows, so the tracks line up. */
export const LADDER_ROW_PAD = "padding:10px 14px";

const TREND_W = 76;
const TREND_H = 22;

/**
 * Eight points of form as a polyline, normalised to its own min/max so a flat
 * player still shows shape. Hand-rolled rather than reaching for
 * `components/Sparkline.tsx`: that one takes a `ChartCard` (a tape series with
 * an opening print and a fill), which a 0…1 form index is not.
 *
 * Exported because step 7's podium wants the SAME line at a bigger size: a
 * plinth that drew its own sparkline would be a second idiom for one reading,
 * and the first thing to drift. `width`/`height` default to the row's, so the
 * row's call site is unchanged.
 */
export function LadderTrend({
  points,
  color,
  width = TREND_W,
  height = TREND_H,
}: {
  points: readonly number[];
  color: string;
  width?: number;
  height?: number;
}) {
  if (points.length < 2) return <span style={sx(`width:${width}px`)} />;

  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  const pad = 3;
  const at = (v: number, i: number): readonly [number, number] => [
    (i / (points.length - 1)) * width,
    pad + (1 - (v - lo) / span) * (height - pad * 2),
  ];

  const d = points.map((v, i) => at(v, i).map((n) => n.toFixed(1)).join(",")).join("L");
  const last = points[points.length - 1] ?? 0;
  const [hx, hy] = at(last, points.length - 1);
  // Up if the back half sits above the front half — the same read as the eye.
  const half = Math.floor(points.length / 2);
  const front = points.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const back = points.slice(half).reduce((a, b) => a + b, 0) / (points.length - half);

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      aria-hidden="true"
      style={sx("display:block;overflow:visible")}
    >
      <path
        d={`M${d}`}
        fill="none"
        stroke={color}
        strokeWidth={width > TREND_W ? "1.8" : "1.4"}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeOpacity={back >= front ? "0.95" : "0.55"}
      />
      <circle cx={hx.toFixed(1)} cy={hy.toFixed(1)} r={width > TREND_W ? "2.6" : "2"} fill={color} />
    </svg>
  );
}

export interface LadderRowProps {
  /** The row `rankedBy` produced: position, player, metric, label, sub. */
  row: Ranked;
  /**
   * Which filter produced `row`. The row does not re-derive anything from it —
   * it only decides presentation the `Ranked` shape cannot carry: EARNINGS is
   * the one metric that can be negative, and negative is red.
   */
  filter: LadderFilter;
  /**
   * Stagger index for `vcRowIn` (`animation-delay: index·22ms`). Defaults to
   * `row.pos - 1`; step 7 passes an explicit index when the podium takes the
   * top three out of the table and the fourth row should still start at 0.
   */
  index?: number;
  /**
   * The row drawer's toggle (§9 N1). Absent = the row is not interactive;
   * present = the row becomes a real button, keyboard included, and the panel
   * it opens is `Ranking.tsx`'s business, not this component's.
   */
  onOpen?: (player: LeaderPlayer) => void;
  /** Whether this row's drawer is the open one — drives `aria-expanded` and
   *  the held-open background, so an open row still reads as open after the
   *  pointer leaves it. */
  open?: boolean;
}

/**
 * A ladder row. `data-rank-row` is on every one of them and `data-you` on
 * exactly one, which is the contract §8's `/ranks` test reads.
 */
export function LadderRow({ row, filter, index, onOpen, open = false }: LadderRowProps) {
  const [hot, setHot] = useState(false);
  const hover = useSoundHover("ladder.rowHover");

  const p = row.player;
  const tint = RANK_COLOR[p.rank.tier.name];
  const sector = SECTORS[p.sector];
  const mode = MODES[p.mode];
  const stagger = index ?? row.pos - 1;

  // EARNINGS is signed; nothing else is. `Ranked.label` already carries the
  // sign glyph, so this is purely the colour.
  const metricTone =
    filter === "EARNINGS" ? (row.metric < 0 ? C.red : C.green) : p.you ? C.accent : C.text;

  return (
    <div
      data-rank-row={p.id}
      {...(p.you ? { "data-you": "" } : {})}
      onPointerEnter={() => {
        hover.onPointerEnter();
        setHot(true);
      }}
      onPointerLeave={() => setHot(false)}
      {...(onOpen
        ? {
            onClick: () => onOpen(p),
            role: "button",
            tabIndex: 0,
            "aria-expanded": open,
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onOpen(p);
            },
          }
        : {})}
      style={sx(
        `${LADDER_GRID};${LADDER_ROW_PAD};position:relative;border-radius:10px;` +
          `border:1px solid ${
            p.you ? "rgba(200,255,0,.42)" : hot || open ? C.border : "transparent"
          };` +
          `background:${p.you ? "rgba(200,255,0,.055)" : hot || open ? C.raised : "transparent"};` +
          `${onOpen ? "cursor:pointer;" : ""}` +
          "transition:background .16s ease,border-color .16s ease,transform .16s ease;" +
          `${hot ? "transform:translateX(2px);" : ""}` +
          `animation:vcRowIn 300ms cubic-bezier(.2,.8,.2,1) ${stagger * 22}ms both`,
      )}
    >
      {/* §5.4 — the accent edge that makes your row findable in one glance. */}
      {p.you && (
        <span
          aria-hidden="true"
          style={sx(
            `position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:99px;` +
              `background:${C.accent};color:${C.accent};animation:vcHeat 2200ms ease-in-out infinite`,
          )}
        />
      )}

      <span
        style={sx(
          `font:700 13px/1 ${MONO};font-variant-numeric:tabular-nums;letter-spacing:.02em;` +
            `color:${row.pos <= 3 ? tint : p.you ? C.accent : C.dim}`,
        )}
      >
        {row.pos}
      </span>

      <div style={sx("display:flex;align-items:center;gap:9px;min-width:0")}>
        <div style={sx(avatarStyle(p.bg, 28))}>{p.initials}</div>
        <div style={sx("min-width:0")}>
          <div
            style={sx(
              `display:flex;align-items:center;gap:6px;font:700 12.5px/1 ${SANS};` +
                "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
            )}
          >
            {p.name}
            {p.you && (
              <span
                style={sx(
                  `flex:none;font:700 8px/1 ${MONO};letter-spacing:.14em;padding:3px 5px;border-radius:4px;` +
                    `border:1px solid rgba(200,255,0,.45);background:rgba(200,255,0,.14);color:${C.accent}`,
                )}
              >
                YOU
              </span>
            )}
          </div>
          <div style={sx(`margin-top:4px;font:400 9.5px/1 ${MONO};color:${C.faint}`)}>
            {p.battles.toLocaleString("en-US")} BATTLES
          </div>
        </div>
      </div>

      <div style={sx("display:flex;align-items:center;gap:7px;min-width:0")}>
        <span style={sx(`width:6px;height:6px;border-radius:99px;flex:none;background:${tint}`)} />
        <span
          style={sx(
            `font:700 10px/1 ${MONO};letter-spacing:.1em;color:${tint};` +
              "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          )}
        >
          {p.rank.label}
        </span>
      </div>

      <div style={sx("display:flex;flex-direction:column;align-items:flex-start;gap:5px;min-width:0")}>
        <span style={sx(`${miniTag(sector.color)};white-space:nowrap`)}>{sector.label}</span>
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.faint}`)}>{mode.label}</span>
      </div>

      <div style={sx("display:flex;flex-direction:column;align-items:flex-end;gap:5px;min-width:0")}>
        <span
          style={sx(
            `font:700 13px/1 ${MONO};font-variant-numeric:tabular-nums;color:${metricTone};white-space:nowrap`,
          )}
        >
          {row.label}
        </span>
        <span
          style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.faint};white-space:nowrap`)}
        >
          {row.sub}
        </span>
      </div>

      <LadderTrend points={p.trend} color={tint} />
    </div>
  );
}
