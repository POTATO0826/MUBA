import { Fragment, useMemo, useState } from "react";
import { RANK_COLOR, RankBadge } from "../components/RankBadge.tsx";
import { COPY_FEE, SEASON } from "../data/rewards.ts";
import {
  FILTER_LABEL,
  LADDER_FILTERS,
  MODES,
  MODE_ORDER,
  NO_SELECTION,
  SECTORS,
  SECTOR_ORDER,
  leaderboardWith,
  matchesSelection,
  positionOf,
  rankedBy,
  selectionLabel,
  usd,
  usdCompact,
  usdGain,
  usdSigned,
  type LadderFilter,
  type LeaderPlayer,
  type Ranked,
  type Selection,
} from "../data/leaderboard.ts";
import { RANK_TIERS } from "../engine/rank.ts";
import { seededRandom } from "../engine/spin.ts";
import { hash } from "../lib/hash.ts";
import { sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill } from "../theme.ts";
import type { Mode, SectorKey } from "../types.ts";
import {
  GainText,
  LADDER_GRID,
  LADDER_ROW_PAD,
  LadderRow,
  LadderTrend,
  RiskChip,
} from "../ui/LadderRow.tsx";

/**
 * `/ranks` — the ladder (plan 4 §5).
 *
 * The page's whole thesis is one line: rank is income. Everything below the
 * headline is that sentence with numbers attached — a stat strip counted off
 * the real roster, a table sorted by whichever filter is live, and your own
 * row sitting in it under the same rule as everyone else rather than pinned
 * beside it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOTHING ON THIS PAGE IS AUTHORED
 * ────────────────────────────────────────────────────────────────────────────
 * Every figure is a reduction over `leaderboardWith(you)`: the ranked count is
 * the array length, COPIERS ACTIVE is Σ `econ.copiers`, FEES/24H is Σ
 * `econ.daily` and COPY CAPITAL is Σ `profile.aum`. Add a lobby host and the
 * ladder gains a rung and the strip moves, with no edit here. There is no
 * constant in this file that a reader could not recompute from
 * `data/leaderboard.ts`.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE TWO FILTER ROWS (§5.3)
 * ────────────────────────────────────────────────────────────────────────────
 * Row A is single-select over `LADDER_FILTERS` and decides the METRIC. Row B
 * exists only under SECTOR × MODE and decides the POOL: two multi-select chip
 * groups, OR within a group and AND across them, with an empty group meaning
 * "all" — so the default board is the whole ladder and no combination of
 * clicks can produce a screen with nothing on it that does not also offer the
 * way back out (`clear ×`, plus an explicit empty state when a legal pair like
 * SEMIS × BLITZ genuinely has no player in it).
 *
 * Both rows write into state that `rankedBy` already consumes; neither of them
 * knows how a metric is computed. `runKey` below is what makes the change
 * VISIBLE: it keys the podium and every row, so a re-rank remounts them and
 * `vcPodiumRise` / `vcRowIn` play again instead of the numbers silently
 * swapping in place (§5.3, "re-animates").
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TWO POSITION NUMBERS, AND THEY ARE BOTH RIGHT
 * ────────────────────────────────────────────────────────────────────────────
 * `seasonPos` in the hero chip is your standing by career XP — the number the
 * rank moment counts out. `row.pos` in the table is your standing UNDER THE
 * ACTIVE FILTER. They disagree on purpose and must never be unified.
 *
 * The pinned foot bar quotes the SECOND of the two, because it sits at the
 * foot of the table and a bar that answered a different question than the
 * column it is bolted to would be the worst of both.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE PIN AND THE NUDGE (§5.4)
 * ────────────────────────────────────────────────────────────────────────────
 * `YouPin` and `nudgeText` below carry the rules; the short version is that
 * the bar appears whenever your row is NOT on the podium, that it is a summary
 * rather than a relocation (your row stays in the table), and that the nudge
 * is always the gap to the player DIRECTLY ABOVE YOU in the active metric's
 * own units — never a converted, blended or invented figure.
 */

const PAGE = "padding:28px;max-width:1720px;margin:0 auto;display:flex;flex-direction:column;gap:22px";

const num = (n: number): string => Math.round(n).toLocaleString("en-US");

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/**
 * The reduced-motion probe, local so no view reaches into `sound/engine.ts`
 * (BUILD-ORDER §A-a) — the same helper `RankUpSequence` keeps for the same
 * reason.
 *
 * `styles.css`'s `[data-ladder] *` block already kills every ANIMATION on this
 * page, which covers `vcPodiumRise` and `vcRowIn`. Row B's reveal is a
 * TRANSITION on `grid-template-rows`, which that block cannot reach, so this
 * is how the one motion CSS cannot still gets stilled: the duration drops to
 * zero and the chip row simply is or is not there.
 */
function stillMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

/* The strip's compacting now goes through `usdCompact` in `leaderboard.ts` —
   the figures it shows are money, and money has one formatter in this app. */

// ── LadderField ─────────────────────────────────────────────────────────────

const FIELD_W = 340;
const FIELD_H = 178;
const BAND_H = FIELD_H / RANK_TIERS.length;

/**
 * One tier band as a ridge line, in the Joy Division manner `CardArt.tsx`
 * already speaks: a horizon with a seeded crest, filled below in the page
 * ground so the band under it occludes the band above.
 *
 * `rand` is drawn from ONCE PER POINT, so two calls with two streams over the
 * same geometry return paths with identical point counts — which is exactly
 * what SMIL's `<animate attributeName="d">` requires to interpolate between
 * them.
 */
function ridge(rand: () => number, y0: number, crest: number, lift: number): string {
  const pts: string[] = [];
  for (let x = 0; x <= FIELD_W; x += 10) {
    const env = Math.exp(-(((x - crest) / (FIELD_W * 0.24)) ** 2));
    const bump = env * BAND_H * lift * (0.55 + rand() * 0.55) + (rand() - 0.5) * 2.4;
    pts.push(`${x},${(y0 - bump).toFixed(1)}`);
  }
  return `M${pts.join("L")}L${FIELD_W},${FIELD_H}L0,${FIELD_H}Z`;
}

/**
 * The hero's artwork: the five tiers stacked as ridge lines, WHALE on the
 * skyline and MINNOW in the foreground, each in its `RANK_COLOR`, with the
 * band you are standing in lit and named. Seeded off the tier name, so the
 * picture is the same picture every session — the same rule `RankBadge` uses
 * for the crest, and for the same reason: a player should learn to read it.
 *
 * SVG + SMIL only. `§5` rules out `DitherReveal` here — the home page owns the
 * WebGL signature and a second GL context is not worth a decoration — and the
 * page's `data-ladder` root stills the CSS half under reduced motion, while
 * the SMIL morph below is slow enough (18–26s) to read as weather.
 */
function LadderField({ tierIndex }: { tierIndex: number }) {
  const bands = useMemo(
    () =>
      RANK_TIERS.map((tier, i) => {
        const r = seededRandom(hash(`${tier.name}#ladder-field`));
        const crest = FIELD_W * (0.26 + r() * 0.48);
        const lift = 0.9 + r() * 0.7;
        // Top of the picture is the top of the ladder.
        const depth = RANK_TIERS.length - 1 - i;
        const y0 = (depth + 1) * BAND_H + 8;
        const a = seededRandom(hash(`${tier.name}#a`));
        const b = seededRandom(hash(`${tier.name}#b`));
        return {
          name: tier.name,
          index: i,
          depth,
          y0,
          color: RANK_COLOR[tier.name],
          dA: ridge(a, y0, crest, lift),
          dB: ridge(b, y0, crest, lift),
          dur: 18 + depth * 2.4 + r() * 6,
        };
      }),
    [],
  );

  return (
    <svg
      data-ladder-field={RANK_TIERS[tierIndex]?.name ?? ""}
      viewBox={`0 0 ${FIELD_W} ${FIELD_H}`}
      width={FIELD_W}
      height={FIELD_H}
      aria-hidden="true"
      style={sx("display:block;overflow:hidden;border-radius:12px;flex:none;max-width:100%")}
    >
      <rect width={FIELD_W} height={FIELD_H} fill={C.panel} />

      {/* Painted skyline-first so each nearer band occludes the one behind. */}
      {bands
        .slice()
        .sort((x, y) => x.depth - y.depth)
        .map((band) => {
          const on = band.index === tierIndex;
          return (
            <g key={band.name}>
              <path
                d={band.dA}
                fill={on ? `${band.color}14` : C.panel}
                stroke={band.color}
                strokeWidth={on ? "1.7" : "1"}
                strokeOpacity={on ? 0.95 : 0.3}
                strokeLinejoin="round"
              >
                <animate
                  attributeName="d"
                  values={`${band.dA};${band.dB};${band.dA}`}
                  dur={`${band.dur.toFixed(1)}s`}
                  repeatCount="indefinite"
                  calcMode="spline"
                  keyTimes="0;0.5;1"
                  keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
                />
              </path>
              <text
                x="10"
                y={(band.y0 - 4).toFixed(1)}
                fill={band.color}
                fillOpacity={on ? "0.95" : "0.34"}
                style={sx(`font:700 8px/1 ${MONO};letter-spacing:.18em`)}
              >
                {band.name}
              </text>
              {on && (
                <circle cx={FIELD_W - 12} cy={(band.y0 - 8).toFixed(1)} r="3" fill={band.color}>
                  <animate
                    attributeName="r"
                    values="2.2;4;2.2"
                    dur="2.6s"
                    repeatCount="indefinite"
                    calcMode="spline"
                    keyTimes="0;0.5;1"
                    keySplines="0.4 0 0.6 1;0.4 0 0.6 1"
                  />
                </circle>
              )}
            </g>
          );
        })}
    </svg>
  );
}

// ── Row B — the sector × mode chips (§5.3) ──────────────────────────────────

/**
 * A chip in the row-B groups.
 *
 * Not `theme.ts`'s `pill()`: that one is accent-or-nothing, and these chips
 * carry the sector/mode COLOUR vocabulary the SPECIALTY column and the lobby
 * cards already speak. A DEFI chip that lit up lime would be the fourth place
 * in the app where DEFI is violet and the first where it is not.
 *
 * The dim number is the qualifying count — see `chipCounts` below for exactly
 * what it counts and why it does not move when other chips are pressed.
 */
function Chip({
  label,
  count,
  color,
  on,
  reachable,
  onClick,
}: {
  label: string;
  count: number;
  color: string;
  on: boolean;
  /** Focusable only while row B is actually revealed. */
  reachable: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={on}
      tabIndex={reachable ? 0 : -1}
      onClick={onClick}
      style={sx(
        "display:inline-flex;align-items:center;gap:7px;height:26px;padding:0 10px;border-radius:99px;" +
          `cursor:pointer;font:500 11px/1 ${MONO};letter-spacing:.04em;` +
          "transition:background .16s ease,border-color .16s ease,color .16s ease;" +
          (on
            ? `border:1px solid ${color}8c;background:${color}1f;color:${color}`
            : `border:1px solid ${C.border};background:transparent;color:${C.muted}`),
      )}
    >
      {label}
      <span
        style={sx(
          `font:500 9.5px/1 ${MONO};font-variant-numeric:tabular-nums;` +
            `color:${on ? color : C.faint};opacity:.8`,
        )}
      >
        {count}
      </span>
    </button>
  );
}

// ── The copy-trader surface ─────────────────────────────────────────────────

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE DOLLARS ARE THE DESK'S, AND THERE IS NO RATE
 * ────────────────────────────────────────────────────────────────────────────
 * Every `$` on this page comes out of `data/leaderboard.ts` already denominated
 * — `econ.avgTicket`, `econ.daily`, `earnings`, `profile.aum` — and every one of
 * them is drawn fresh from `hash(id)` rather than lifted off the PTS ledger.
 * This view multiplies nothing by anything: it picks a formatter (`usd`,
 * `usdCompact`, `usdSigned`) and prints. So there is no conversion rate on the
 * page and no quantity that appears in two units.
 *
 * XP is the exception that proves it. The unlock lines, the nudge and the hero
 * chip stay in XP, because rank is measured in XP everywhere in this app and a
 * dollar figure there would be exactly the kind of blend this note forbids.
 */

/** The copier count with its 30-day move — eToro's "N copiers ▲ 5.8%". The
 *  delta comes off `profile.copierDelta`, which is read from the same trend
 *  line the sparkline beside it draws, so an up-arrow here and a bright line
 *  there are the same statement. */
function CopierDelta({ delta }: { delta: number }) {
  // Under a tenth of a percent the arrow would be pointing at rounding noise.
  if (Math.abs(delta) < 0.001) return <span style={sx(`font:500 9px/1 ${MONO};color:${C.faint}`)}>— 30D</span>;
  const up = delta > 0;
  return (
    <span
      style={sx(
        `font:700 9px/1 ${MONO};font-variant-numeric:tabular-nums;white-space:nowrap;` +
          `color:${up ? C.green : C.red}`,
      )}
    >
      {up ? "▲" : "▼"} {usdGain(delta).slice(1)} 30D
    </span>
  );
}

/**
 * The COPY button — fiction, and it says so.
 *
 * The whole copy-trade layer of this app is a fiction: the copiers are seeded,
 * the fee revenue is seeded, and no wallet anywhere is party to any of it. So
 * this control does what the fiction can honestly do — it acknowledges the
 * click, names the minimum sleeve the desk would want, and then states plainly
 * that nothing moved. It is deliberately NOT wired to the ledger, to a wallet,
 * or to `stakePointsFor`; there is no code path from here to money, real or
 * in-game, and there must never be one.
 *
 * `MIN COPY` is `profile.minCopy` — one ticket at this trader's own size,
 * rounded up to a round hundred — so the number on the button is a fact about
 * the trader rather than a marketing round figure.
 *
 * A locked trader gets the unlock line instead, in XP, because that is what
 * stands between the reader and the button.
 */
function CopyButton({ player, compact: small = false }: { player: LeaderPlayer; compact?: boolean }) {
  const [armed, setArmed] = useState(false);
  const e = player.econ;
  const f = player.profile;

  if (!e.unlocked) {
    return (
      <span
        data-copy-locked={player.id}
        style={sx(
          `display:inline-flex;align-items:center;justify-content:center;gap:6px;width:100%;` +
            `padding:${small ? "7px 9px" : "9px 11px"};border-radius:8px;` +
            `border:1px dashed ${C.border};background:transparent;color:${C.dim};` +
            `font:700 ${small ? 9 : 9.5}px/1 ${MONO};letter-spacing:.12em;text-align:center`,
        )}
      >
        LOCKED · {num(e.nextUnlock?.xpAway ?? 0)} XP TO {e.nextUnlock?.tier.name ?? "SHARK"}
      </span>
    );
  }

  return (
    <div style={sx("display:flex;flex-direction:column;gap:5px;width:100%;min-width:0")}>
      <button
        data-copy-trader={player.id}
        aria-pressed={armed}
        onClick={(ev) => {
          ev.stopPropagation();
          sfx("rank.copyPanel");
          setArmed((v) => !v);
        }}
        style={sx(
          `display:inline-flex;align-items:center;justify-content:center;gap:7px;width:100%;` +
            `padding:${small ? "7px 9px" : "9px 11px"};border-radius:8px;cursor:pointer;` +
            `font:700 ${small ? 9 : 10}px/1 ${MONO};letter-spacing:.12em;` +
            "transition:background .16s ease,border-color .16s ease,color .16s ease;" +
            (armed
              ? `border:1px solid rgba(200,255,0,.6);background:rgba(200,255,0,.18);color:${C.accent}`
              : `border:1px solid rgba(200,255,0,.42);background:rgba(200,255,0,.07);color:${C.accent}`),
        )}
      >
        {armed ? "COPYING ✓" : "COPY"}
        <span style={sx(`font:500 ${small ? 8 : 8.5}px/1 ${MONO};opacity:.72`)}>
          MIN {usd(f.minCopy)}
        </span>
      </button>
      <span
        style={sx(
          `font:500 8px/1.3 ${MONO};letter-spacing:.1em;color:${C.faint};text-align:center`,
        )}
      >
        {armed ? "DEMO ONLY · NO FUNDS MOVED" : `${usdCompact(f.aum)} COPY CAPITAL`}
      </span>
    </div>
  );
}

/**
 * The compact profile strip: GAIN, RISK, and the copier book's 30-day move.
 *
 * Three readings, because three is what fits on a plinth without the card
 * becoming a table — and because they are the three a copier actually decides
 * on. Everything else lives one click down, in the drawer.
 */
function ProfileStrip({ player }: { player: LeaderPlayer }) {
  const f = player.profile;
  return (
    <div
      data-copy-strip={player.id}
      style={sx(
        "display:flex;align-items:center;justify-content:center;gap:8px;flex-wrap:wrap;width:100%;" +
          `padding-top:9px;border-top:1px solid ${C.line}`,
      )}
    >
      <span style={sx("display:inline-flex;align-items:baseline;gap:5px")}>
        <span style={sx(`font:500 8px/1 ${MONO};letter-spacing:.12em;color:${C.faint}`)}>12M</span>
        <GainText gain={f.gain12m} size={12} />
      </span>
      <RiskChip risk={f.risk} />
      {player.econ.unlocked && <CopierDelta delta={f.copierDelta} />}
    </div>
  );
}

// ── The podium (§5.2) ───────────────────────────────────────────────────────

const PODIUM_TREND_W = 118;
const PODIUM_TREND_H = 34;

/**
 * One plinth. #1 is centre, taller, ringed and wears a bigger badge; #2 and #3
 * flank it at the smaller size.
 *
 * THIS is where the full `RankBadge` earns its keep. `LadderRow` deliberately
 * renders the tier as a coloured WORD because at row height the sigil's point
 * count — the thing that separates MINNOW from WHALE — is not readable. At
 * 74px it is, and there are three of them rather than fourteen, so the three
 * SMIL orbits per badge cost nothing worth counting.
 */
function Plinth({ row, filter, delayMs }: { row: Ranked; filter: LadderFilter; delayMs: number }) {
  const p = row.player;
  const tint = RANK_COLOR[p.rank.tier.name];
  const first = row.pos === 1;
  // §5.2: #1 is accented — and so is YOU, wherever on the podium you land.
  const lit = first || p.you;
  const badge = first ? 74 : 54;

  const metricTone =
    filter === "EARNINGS" || filter === "GAIN"
      ? row.metric < 0
        ? C.red
        : C.green
      : p.you
        ? C.accent
        : C.text;

  return (
    <div
      data-podium={row.pos}
      {...(p.you ? { "data-you": "" } : {})}
      style={sx(
        "flex:1 1 210px;max-width:300px;min-width:0;display:flex;flex-direction:column;" +
          "align-items:center;gap:10px;text-align:center;border-radius:14px;" +
          `padding:${first ? "22px 16px 20px" : "16px 14px 14px"};` +
          `border:1px solid ${lit ? "rgba(200,255,0,.42)" : C.border};` +
          `background:${lit ? "rgba(200,255,0,.05)" : C.card};` +
          (lit ? "box-shadow:0 0 0 1px rgba(200,255,0,.24),0 0 34px -12px rgba(200,255,0,.85);" : "") +
          `animation:vcPodiumRise 420ms cubic-bezier(.2,.8,.2,1) ${delayMs}ms both`,
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:8px")}>
        <span
          style={sx(
            `font:700 ${first ? 15 : 12}px/1 ${MONO};font-variant-numeric:tabular-nums;` +
              `letter-spacing:.06em;color:${first ? C.accent : C.dim}`,
          )}
        >
          #{row.pos}
        </span>
        {p.you && (
          <span
            style={sx(
              `font:700 8px/1 ${MONO};letter-spacing:.14em;padding:3px 5px;border-radius:4px;` +
                `border:1px solid rgba(200,255,0,.45);background:rgba(200,255,0,.14);color:${C.accent}`,
            )}
          >
            YOU
          </span>
        )}
      </div>

      <RankBadge point={p.rank} size={badge} />

      <div style={sx("display:flex;flex-direction:column;gap:5px;min-width:0;width:100%")}>
        <span
          style={sx(
            `font:700 ${first ? 15 : 13}px/1.15 ${SANS};color:${C.text};` +
              "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          )}
        >
          {p.name}
        </span>
        <span style={sx(`font:700 9.5px/1 ${MONO};letter-spacing:.12em;color:${tint}`)}>
          {p.rank.label}
        </span>
      </div>

      <div style={sx("display:flex;flex-direction:column;gap:5px;min-width:0;width:100%")}>
        <span
          style={sx(
            `font:700 ${first ? 20 : 16}px/1 ${MONO};font-variant-numeric:tabular-nums;` +
              `color:${metricTone};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`,
          )}
        >
          {row.label}
        </span>
        <span
          style={sx(
            `font:500 9px/1.3 ${MONO};letter-spacing:.1em;color:${C.faint};` +
              "overflow:hidden;text-overflow:ellipsis",
          )}
        >
          {row.sub}
        </span>
      </div>

      {/* The same line the row draws, at podium size — one sparkline idiom. */}
      <LadderTrend
        points={p.trend}
        color={tint}
        width={first ? PODIUM_TREND_W : PODIUM_TREND_W - 22}
        height={first ? PODIUM_TREND_H : PODIUM_TREND_H - 6}
      />

      {/* The plinth IS a copy-trader card, so it carries the card's two
          controls: the three-reading profile strip, and the button. */}
      <ProfileStrip player={p} />
      <CopyButton player={p} compact={!first} />
    </div>
  );
}

// ── The row drawer (§9 N1) ──────────────────────────────────────────────────

/** One labelled figure inside the drawer. */
function Cell({ label, value, tone = C.text }: { label: string; value: string; tone?: string }) {
  return (
    <div style={sx("display:flex;align-items:baseline;justify-content:space-between;gap:12px")}>
      <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.faint}`)}>{label}</span>
      <span
        style={sx(
          `font:700 11.5px/1 ${MONO};font-variant-numeric:tabular-nums;color:${tone};white-space:nowrap`,
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** A share split as bars. `sectorShare` / `modeShare` sum to 1 over their keys,
 *  so the bars ARE the distribution — nothing is renormalised for display. */
function ShareBars({
  title,
  rows,
}: {
  title: string;
  rows: readonly { key: string; label: string; color: string; share: number }[];
}) {
  return (
    <div style={sx("display:flex;flex-direction:column;gap:8px;min-width:0")}>
      <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.16em;color:${C.faint}`)}>{title}</span>
      {rows.map((r) => (
        <div key={r.key} style={sx("display:flex;align-items:center;gap:9px;min-width:0")}>
          <span
            style={sx(
              `flex:none;width:64px;font:500 9px/1 ${MONO};letter-spacing:.08em;color:${C.muted};` +
                "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
            )}
          >
            {r.label}
          </span>
          <span
            style={sx(
              `flex:1;height:5px;border-radius:99px;background:${C.line};overflow:hidden;min-width:0`,
            )}
          >
            <span
              style={sx(
                `display:block;height:100%;border-radius:99px;background:${r.color};` +
                  `width:${(r.share * 100).toFixed(1)}%`,
              )}
            />
          </span>
          <span
            style={sx(
              `flex:none;width:30px;text-align:right;font:500 9px/1 ${MONO};` +
                `font-variant-numeric:tabular-nums;color:${C.faint}`,
            )}
          >
            {pct(r.share)}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * What a row is hiding: the two share splits the SPECIALTY column only had
 * room to name the winner of, the copy-trader profile the row could only show
 * two readings of, and the copy economics the COPY HEAT column only had room
 * for the headline of.
 *
 * Every figure is read straight off the player object — `sectorShare`,
 * `modeShare`, `econ` and `profile` are already there. The drawer computes
 * nothing, which is why it is this cheap and why it cannot disagree with the
 * row above it: the `+53.8%` in this panel and the `+53.8%` under the name in
 * the row are literally the same field, formatted by the same component.
 */
function RowDrawer({ player }: { player: LeaderPlayer }) {
  const e = player.econ;
  const f = player.profile;
  return (
    <div
      data-ladder-drawer={player.id}
      style={sx(
        "display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:20px;" +
          `margin:2px 0 4px;padding:14px 16px;border:1px solid ${C.border};border-radius:10px;` +
          `background:${C.panelAlt};` +
          "animation:vcRowIn 240ms cubic-bezier(.2,.8,.2,1) both",
      )}
    >
      <ShareBars
        title="SECTOR SHARE"
        rows={SECTOR_ORDER.map((k) => ({
          key: k,
          label: SECTORS[k].label,
          color: SECTORS[k].color,
          share: player.sectorShare[k] ?? 0,
        }))}
      />
      <ShareBars
        title="MODE SHARE"
        rows={MODE_ORDER.map((k) => ({
          key: k,
          label: MODES[k].label,
          color: MODES[k].color,
          share: player.modeShare[k] ?? 0,
        }))}
      />
      {/* The copy-trader card, expanded. GAIN leads because it is the number a
          copier shops on; RISK sits beside it because a return with no risk
          beside it is half a sentence. Both are `profile` fields, derived — the
          drawer still computes nothing. */}
      <div style={sx("display:flex;flex-direction:column;gap:8px;min-width:0")}>
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.16em;color:${C.faint}`)}>
          COPY-TRADER PROFILE
        </span>
        <div style={sx("display:flex;align-items:baseline;justify-content:space-between;gap:12px")}>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.faint}`)}>
            GAIN 12M
          </span>
          <GainText gain={f.gain12m} size={19} />
        </div>
        <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:12px")}>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.faint}`)}>RISK</span>
          <RiskChip risk={f.risk} size={10} />
        </div>
        <Cell
          label="PROFITABLE MONTHS"
          value={`${f.profitableMonths} / 12 · ${pct(f.profitableMonthsPct)}`}
        />
        <Cell label="WIN RATIO" value={`${pct(player.winRate)} · ${num(player.wins)} / ${num(player.battles)}`} />
        <Cell label="AVG TRADE" value={usd(f.avgTrade)} />
        <Cell
          label="CAREER P/L"
          value={usdSigned(f.career)}
          tone={f.career < 0 ? C.red : C.green}
        />
        <div style={sx("margin-top:4px")}>
          <CopyButton player={player} />
        </div>
      </div>

      <div style={sx("display:flex;flex-direction:column;gap:8px;min-width:0")}>
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.16em;color:${C.faint}`)}>
          COPY ECONOMICS
        </span>
        {e.unlocked ? (
          <>
            <div
              style={sx("display:flex;align-items:baseline;justify-content:space-between;gap:12px")}
            >
              <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.faint}`)}>
                COPIERS
              </span>
              <span style={sx("display:inline-flex;align-items:baseline;gap:7px")}>
                <span
                  style={sx(
                    `font:700 11.5px/1 ${MONO};font-variant-numeric:tabular-nums;color:${C.text}`,
                  )}
                >
                  {num(e.copiers)}
                </span>
                <CopierDelta delta={f.copierDelta} />
              </span>
            </div>
            <Cell label="COPY CAPITAL" value={usdCompact(f.aum)} />
            <Cell label="TRADES / COPIER / DAY" value={num(e.txPerCopierPerDay)} />
            <Cell label="AVG TRADE" value={usd(e.avgTicket)} />
            <Cell label={`FEE @ ${(e.feePct * 100).toFixed(1)}%`} value={usd(e.perTx)} />
            <Cell label="$ / DAY" value={usd(e.daily)} tone={C.accent} />
            <Cell label="$ / MONTH" value={usdCompact(e.monthly)} tone={C.accent} />
          </>
        ) : (
          <>
            <Cell label="COPY-TRADE" value="LOCKED" tone={C.dim} />
            {/* The distance to the unlock is a RANK distance, so it is quoted
                in XP. This is the one line in the panel that is not money, and
                it must stay that way — see the currency note above. */}
            <Cell
              label={`TO ${e.nextUnlock?.tier.name ?? "SHARK"}`}
              value={`${num(e.nextUnlock?.xpAway ?? 0)} XP`}
            />
            <Cell
              label="COPIERS THERE"
              value={`≈ ${num(e.nextUnlock?.copiersAt ?? 0)}`}
              tone={C.dim}
            />
            <Cell label="AVG TRADE" value={usd(e.avgTicket)} tone={C.dim} />
          </>
        )}
        <Cell label="RECORD" value={`${num(player.wins)} / ${num(player.battles)}`} />
      </div>
    </div>
  );
}

// ── The pin and the nudge (§5.4) ────────────────────────────────────────────

/**
 * The overtake nudge: what the player DIRECTLY ABOVE YOU is worth, in the
 * units of the active metric.
 *
 * It reads `rows[idx - 1]` — the neighbour in the list that is already on
 * screen — rather than re-deriving anything, so the gap it prints is exactly
 * the difference between the two numbers the reader can see. Under every
 * filter the sort is descending, so the gap is never negative.
 *
 * Three cases are NOT "N units behind", and each of them is a case where the
 * subtraction would produce a true number that says something false:
 *
 *   • No one above you (`pos === 1`). Reachable from the pin because the
 *     podium only exists at three survivors or more: a sector × mode pair
 *     with one or two players in it puts YOU at #1 with no plinth above.
 *   • COPY HEAT while your copy-trade is still locked. Your copiers are 0 and
 *     so are the copiers of everyone else below the SHARK line, so the gap is
 *     0 and "0 COPIERS TO OVERTAKE" is nonsense. The real distance is the
 *     unlock, and `econ.nextUnlock` already knows it.
 *   • A gap that rounds to zero. Ties break on id, so being level is not
 *     being ahead — and "▲ 0 WINS TO OVERTAKE" would tell you to do nothing.
 */
function nudgeText(rows: readonly Ranked[], idx: number, filter: LadderFilter): string {
  const you = rows[idx] as Ranked;
  const above = idx > 0 ? rows[idx - 1] : null;
  if (!above) return "TOP OF THE LADDER";

  const name = above.player.name;
  const level = `LEVEL WITH ${name} · TAKE THE LEAD`;

  if (filter === "COPY" && !you.player.econ.unlocked) {
    const next = you.player.econ.nextUnlock;
    return `▲ ${num(next?.xpAway ?? 0)} XP TO ${next?.tier.name ?? "SHARK"} · UNLOCKS COPY-TRADE`;
  }

  const gap = above.metric - you.metric;

  // The two percentage metrics. GAIN is a return, so the gap is in percentage
  // points of return — never in dollars, which would be a different quantity
  // dressed as the same one.
  if (filter === "WINRATE" || filter === "GAIN") {
    const shown = (gap * 100).toFixed(1);
    return shown === "0.0" ? level : `▲ ${shown}% TO OVERTAKE ${name}`;
  }

  // EARNINGS is the desk's dollars, so the gap is quoted in them.
  if (filter === "EARNINGS") {
    const n = Math.round(gap);
    return n <= 0 ? level : `▲ ${usd(n)} TO OVERTAKE ${name}`;
  }

  const n = Math.round(gap);
  if (n <= 0) return level;
  const unit =
    filter === "COPY" ? (n === 1 ? "COPIER" : "COPIERS")
    : n === 1 ? "WIN"
    : "WINS";
  return `▲ ${num(n)} ${unit} TO OVERTAKE ${name}`;
}

/**
 * The pinned foot row.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHEN IT APPEARS — AND WHY NOT "OUTSIDE THE VISIBLE 12"
 * ────────────────────────────────────────────────────────────────────────────
 * §5.4 words the trigger as "outside the visible 12", which was written for a
 * board that scrolls. This one does not: fourteen rows all render, so by that
 * literal rule the pin would never appear and the loop it closes would never
 * be seen. The honest version of the same intent is the rule below — YOUR ROW
 * IS NOT ON THE PODIUM — because the podium is the only part of this page that
 * is guaranteed to be in view, and it is the only place a player's own
 * standing is already unmissable. Land on it and the pin would be repeating
 * the plinth two inches above it; land anywhere else and the pin is the
 * fastest answer to "where am I, and what closes the gap".
 *
 * The YOU row stays in the table underneath. That is deliberate: this bar is a
 * SUMMARY, not a relocation — your row sorts under the same rule as everyone
 * else's (the header note above) and moving it out would break that. Which is
 * why the key on this element sits outside the `${runKey}:${id}` scheme the
 * table rows use: two elements for one player, two key spaces, no collision.
 *
 * `LADDER_GRID` and `LADDER_ROW_PAD` are the table's own tracks, so #, PLAYER,
 * TIER and the metric land in the same columns as the rows above — the bar
 * reads as the table's foot rather than as a card that happens to sit under
 * it. The nudge takes a second line spanning from the PLAYER column out.
 */
function YouPin({
  row,
  player,
  nudge,
  filter,
}: {
  /** Your ranked row, or `null` when the active selection excludes you — a
   *  legal state under SECTOR × MODE, where a pool you do not specialise in
   *  has no position to report. */
  row: Ranked | null;
  player: LeaderPlayer;
  nudge: string;
  filter: LadderFilter;
}) {
  const tint = RANK_COLOR[player.rank.tier.name];
  const metricTone =
    row && (filter === "EARNINGS" || filter === "GAIN")
      ? row.metric < 0
        ? C.red
        : C.green
      : C.accent;

  return (
    <div
      data-you-pin=""
      style={sx(
        `${LADDER_GRID};${LADDER_ROW_PAD};row-gap:7px;position:relative;margin-top:10px;` +
          `border:1px solid rgba(200,255,0,.38);border-radius:10px;` +
          "background:rgba(200,255,0,.07);" +
          // Lifted off the rows above it — the look of a bar that stays put,
          // without the layout cost of actually being position:sticky.
          "box-shadow:0 -12px 26px -22px rgba(200,255,0,.9);" +
          "animation:vcRowIn 300ms cubic-bezier(.2,.8,.2,1) both",
      )}
    >
      {/* The same breathing accent edge the YOU row wears, so the two read as
          the same player at a glance. */}
      <span
        aria-hidden="true"
        style={sx(
          "position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:99px;" +
            `background:${C.accent};color:${C.accent};animation:vcHeat 2200ms ease-in-out infinite`,
        )}
      />

      <span
        style={sx(
          `font:700 13px/1 ${MONO};font-variant-numeric:tabular-nums;letter-spacing:.02em;` +
            `color:${row ? C.accent : C.dim}`,
        )}
      >
        {row ? row.pos : "—"}
      </span>

      <div style={sx("display:flex;align-items:center;gap:7px;min-width:0")}>
        <span
          style={sx(
            `flex:none;font:700 8px/1 ${MONO};letter-spacing:.14em;padding:3px 5px;border-radius:4px;` +
              `border:1px solid rgba(200,255,0,.45);background:rgba(200,255,0,.14);color:${C.accent}`,
          )}
        >
          YOU
        </span>
        <span
          style={sx(
            `font:700 12.5px/1 ${SANS};color:${C.text};` +
              "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          )}
        >
          {player.name}
        </span>
      </div>

      <div style={sx("display:flex;align-items:center;gap:7px;min-width:0")}>
        <span style={sx(`width:6px;height:6px;border-radius:99px;flex:none;background:${tint}`)} />
        <span
          style={sx(
            `font:700 10px/1 ${MONO};letter-spacing:.1em;color:${tint};` +
              "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          )}
        >
          {player.rank.label}
        </span>
      </div>

      {/* SPECIALTY's track, left empty: the row below already says it, and a
          summary that repeats every column is not a summary. */}
      <span />

      <span
        style={sx(
          `text-align:right;font:700 13px/1 ${MONO};font-variant-numeric:tabular-nums;` +
            `color:${metricTone};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`,
        )}
      >
        {row ? row.label : "OUT OF SELECTION"}
      </span>

      {/* TREND's track, left empty so the metric column lines up with the rows
          above rather than drifting to the edge of the bar. */}
      <span />

      <span
        data-you-nudge=""
        style={sx(
          "grid-column:2/-1;font:700 10px/1.3 " +
            `${MONO};letter-spacing:.14em;color:${C.accent};` +
            "overflow:hidden;text-overflow:ellipsis",
        )}
      >
        {nudge}
      </span>
    </div>
  );
}

// ── The page ────────────────────────────────────────────────────────────────

/** One figure in the hero strip. */
function Stat({ value, label, tone = C.text }: { value: string; label: string; tone?: string }) {
  return (
    <div style={sx("display:flex;flex-direction:column;gap:6px")}>
      <span style={sx(`font:700 18px/1 ${MONO};font-variant-numeric:tabular-nums;color:${tone}`)}>
        {value}
      </span>
      <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.faint}`)}>{label}</span>
    </div>
  );
}

export interface RankingProps {
  /**
   * Your row, built from the ledger by `useRankProgress`. Passed in rather
   * than rebuilt here so the ladder, the rank moment and the Result panel are
   * looking at one object — a `LeaderPlayer` like any other, which is what
   * lets it sort into the table instead of beside it.
   */
  you: LeaderPlayer;
  /**
   * Consecutive wins ending at your newest match — `ledger.streak`, the same
   * scalar the rank moment counts out, threaded through `useRankProgress`.
   *
   * The hero chip's only movement reading. It is here rather than derived
   * because `LeaderPlayer` has no notion of RECENCY: it carries totals, and a
   * streak is a fact about the order of the history behind them.
   */
  streak: number;
}

export function Ranking({ you, streak }: RankingProps) {
  const [filter, setFilter] = useState<LadderFilter>("COPY");
  // Row B's pool. EMPTY MEANS ALL — the default board is the whole ladder, and
  // `rankedBy` honours that without a special case here.
  const [sel, setSel] = useState<Selection>(NO_SELECTION);
  // Which row's drawer is open, by player id. One at a time: two open drawers
  // push the table around more than they explain.
  const [openId, setOpenId] = useState<string | null>(null);

  const board = useMemo(() => leaderboardWith(you), [you]);
  const rows = useMemo(() => rankedBy(board, filter, sel), [board, filter, sel]);

  const still = stillMotion();
  const showChips = filter === "SECTOR_MODE";
  const anySel = sel.sectors.length > 0 || sel.modes.length > 0;

  /**
   * The dim number on each chip: HOW MANY PLAYERS THAT CHIP ALONE WOULD KEEP.
   *
   * Computed through `matchesSelection` with a hypothetical single-chip
   * selection — literally the predicate the board is filtered by — so the
   * count and the filter can never mean two different things. Because
   * `matchesSelection` tests the player's PRIMARY sector/mode (the fattest
   * slice, the same one the SPECIALTY column prints), the sector counts sum to
   * the roster and so do the mode counts.
   *
   * Deliberately NOT conditioned on the other group's live selection. A count
   * that re-rendered on every click would make the chips a moving target and
   * would quietly answer a different question per click ("…given BLITZ"); a
   * fixed count answers one question always, and the composed result is the
   * board itself, which is right there underneath. It is a fact about the
   * roster, so it only depends on `board`.
   */
  const chipCounts = useMemo(() => {
    const count = (s: Selection): number => board.filter((p) => matchesSelection(p, s)).length;
    const sectors = {} as Record<SectorKey, number>;
    for (const k of SECTOR_ORDER) sectors[k] = count({ sectors: [k], modes: [] });
    const modes = {} as Record<Mode, number>;
    for (const k of MODE_ORDER) modes[k] = count({ sectors: [], modes: [k] });
    return { sectors, modes };
  }, [board]);

  /**
   * The remount key. Changing it throws the podium and every row away, so
   * `vcPodiumRise` and the staggered `vcRowIn` replay and a re-rank READS as a
   * re-rank. It has to include the selection as well as the filter: under
   * SECTOR × MODE the filter name is constant while the board is not.
   */
  const runKey = showChips
    ? `SECTOR_MODE:${sel.sectors.join("+")}|${sel.modes.join("+")}`
    : filter;

  /** The metric column's header — `FILTER_LABEL`, or the echoed selection
   *  under SECTOR × MODE: `WINS · SEMIS+DEFI · BLITZ` (§5.3). */
  const metricHead = showChips ? `WINS · ${selectionLabel(sel)}` : FILTER_LABEL[filter];

  // The podium takes the top three; the table starts at #4. Below three
  // survivors there is no podium to speak of, so the table keeps everyone.
  const podium = rows.length >= 3 ? rows.slice(0, 3) : [];
  const tableRows = podium.length > 0 ? rows.slice(3) : rows;
  // Centre, then flanks: #2 · #1 · #3 in DOM order matches the eye's order.
  const plinths: readonly (readonly [Ranked, number])[] =
    podium.length === 3
      ? ([
          [podium[1] as Ranked, 70],
          [podium[0] as Ranked, 0],
          [podium[2] as Ranked, 120],
        ] as const)
      : [];

  /**
   * The pin (§5.4). `youIdx` is an index into the FULL ranked list, podium
   * included, so `nudgeText` can reach the player above you even when that
   * player is standing on a plinth.
   *
   * Under SECTOR × MODE the selection can exclude you outright — you are one
   * of the players `matchesSelection` drops — and then there is no position to
   * report. The pin still renders, saying so: your row vanishing from the
   * board with no explanation is the more confusing of the two states.
   */
  const youIdx = rows.findIndex((r) => r.player.you);
  const youRow = youIdx >= 0 ? (rows[youIdx] as Ranked) : null;
  // 7C's note: check the podium BEFORE pinning, or a top-three YOU is drawn
  // twice — once on a plinth and once in a bar that exists to find it.
  const showPin = !podium.some((r) => r.player.you);
  const nudge = youRow
    ? nudgeText(rows, youIdx, filter)
    : `YOU SPECIALISE IN ${SECTORS[you.sector].label} · ${MODES[you.mode].label}`;

  const pickFilter = (f: LadderFilter): void => {
    if (f === filter) return;
    sfx("ladder.filter");
    setOpenId(null);
    setFilter(f);
  };

  const toggleSector = (k: SectorKey): void => {
    sfx("ladder.chip");
    setOpenId(null);
    setSel((s) => ({
      ...s,
      sectors: s.sectors.includes(k) ? s.sectors.filter((x) => x !== k) : [...s.sectors, k],
    }));
  };

  const toggleMode = (k: Mode): void => {
    sfx("ladder.chip");
    setOpenId(null);
    setSel((s) => ({
      ...s,
      modes: s.modes.includes(k) ? s.modes.filter((x) => x !== k) : [...s.modes, k],
    }));
  };

  const clearSel = (): void => {
    sfx("ladder.chipClear");
    setOpenId(null);
    setSel(NO_SELECTION);
  };

  const openRow = (p: LeaderPlayer): void => {
    sfx("ladder.rowOpen");
    setOpenId((cur) => (cur === p.id ? null : p.id));
  };

  const copiers = board.reduce((a, p) => a + p.econ.copiers, 0);
  const daily = board.reduce((a, p) => a + p.econ.daily, 0);
  // The board's total copy capital — Σ `profile.aum`, which is itself Σ over
  // each trader's copiers. Another reduction over the roster, so it moves when
  // the roster does and there is still no constant on this page.
  const aum = board.reduce((a, p) => a + p.profile.aum, 0);
  // The SEASON ladder position — your standing by career XP, which is what the
  // rank moment counts out (`#9 → #7`). Not the same number as your row in the
  // table below, and it should not be: that one is your standing under the
  // ACTIVE FILTER. A MINNOW with no copiers is last by copy heat and still
  // mid-table by XP, and saying both is the honest version.
  const seasonPos = positionOf(you.xp);

  return (
    <div data-ladder="" style={sx(PAGE)}>
      {/* ── Hero ──────────────────────────────────────────────────────── */}
      <section
        style={sx(
          `display:flex;align-items:stretch;justify-content:space-between;gap:26px;flex-wrap:wrap;` +
            `border:1px solid ${C.border};border-radius:16px;background:${C.card};` +
            "padding:22px 24px;overflow:hidden",
        )}
      >
        <div style={sx("flex:1 1 420px;min-width:0;display:flex;flex-direction:column;gap:14px")}>
          <span
            style={sx(
              `display:inline-flex;align-items:center;gap:7px;align-self:flex-start;` +
                `font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent};` +
                "border:1px solid rgba(200,255,0,.3);background:rgba(200,255,0,.08);border-radius:6px;padding:6px 9px",
            )}
          >
            <span
              style={sx(
                `width:6px;height:6px;border-radius:99px;background:${C.accent};` +
                  "animation:vcPulse 1.8s ease-in-out infinite",
              )}
            />
            {SEASON.label} · LIVE
          </span>

          <h1 style={sx(`margin:0;font:700 34px/1.04 ${SANS};letter-spacing:-.03em`)}>The ladder</h1>

          <p style={sx(`margin:0;max-width:52ch;font:400 13.5px/1.55 ${SANS};color:${C.muted}`)}>
            Rank is income. Copy a trader, or be copied: {(COPY_FEE * 100).toFixed(1)}% of every
            copied transaction is paid to the trader who called it.
          </p>

          <div
            style={sx(
              `display:flex;align-items:flex-end;gap:26px;flex-wrap:wrap;margin-top:4px;` +
                `padding-top:16px;border-top:1px solid ${C.line}`,
            )}
          >
            <Stat value={num(rows.length)} label="RANKED" />
            <Stat value={num(copiers)} label="COPIERS ACTIVE" />
            <Stat value={usdCompact(daily)} label="FEES / 24H" tone={C.accent} />
            <Stat value={usdCompact(aum)} label="COPY CAPITAL" tone={C.accent} />
          </div>

          {/* Your chip. The last slot is the only MOVEMENT reading on the page,
              and the only movement this app actually samples is the win run:
              week-over-week would need a second, older snapshot of the ladder,
              which nothing stores. So a live streak says so, and everything
              else keeps the em dash — "no reading yet" rather than a made-up
              +0. `streak > 1` because a single win is not a run. */}
          <div
            style={sx(
              `display:inline-flex;align-self:flex-start;align-items:center;gap:10px;flex-wrap:wrap;` +
                `border:1px solid rgba(200,255,0,.42);background:rgba(200,255,0,.06);border-radius:10px;` +
                "padding:9px 12px",
            )}
          >
            <span style={sx(`font:700 9px/1 ${MONO};letter-spacing:.16em;color:${C.accent}`)}>YOU</span>
            <span style={sx(`width:1px;height:12px;background:${C.border}`)} />
            <span
              style={sx(
                `font:700 14px/1 ${MONO};font-variant-numeric:tabular-nums;color:${C.text}`,
              )}
            >
              #{seasonPos}
            </span>
            <span
              style={sx(
                `font:700 10px/1 ${MONO};letter-spacing:.12em;color:${RANK_COLOR[you.rank.tier.name]}`,
              )}
            >
              {you.rank.label}
            </span>
            {streak > 1 ? (
              <span
                data-you-streak={streak}
                style={sx(
                  `font:700 9px/1 ${MONO};letter-spacing:.12em;color:${C.green}`,
                )}
              >
                ↑ W{streak} STREAK
              </span>
            ) : (
              <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.faint}`)}>
                — THIS WEEK
              </span>
            )}
          </div>
        </div>

        <LadderField tierIndex={you.rank.tierIndex} />
      </section>

      {/* ── Podium ────────────────────────────────────────────────────── */}
      {plinths.length === 3 && (
        <section
          data-ladder-podium=""
          style={sx("display:flex;align-items:flex-end;justify-content:center;gap:14px;flex-wrap:wrap")}
        >
          {plinths.map(([row, delay]) => (
            // Keyed on `runKey` too, so a re-rank rebuilds the podium and
            // vcPodiumRise plays again rather than the names cross-fading.
            <Plinth key={`${runKey}:${row.player.id}`} row={row} filter={filter} delayMs={delay} />
          ))}
        </section>
      )}

      {/* ── Filters ───────────────────────────────────────────────────── */}
      <section style={sx("display:flex;flex-direction:column")}>
        {/* Row A — single-select, decides the METRIC. */}
        <div style={sx("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.16em;color:${C.faint}`)}>
            RANK BY
          </span>
          <div data-ladder-filters="" style={sx("display:flex;gap:6px;flex-wrap:wrap")}>
            {LADDER_FILTERS.map((f) => (
              <button
                key={f}
                aria-pressed={filter === f}
                onClick={() => pickFilter(f)}
                style={sx(pill(filter === f))}
              >
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>
          <div style={sx("flex:1")} />
          <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>
            {num(rows.length)} ranked · {FILTER_LABEL[filter]}
          </span>
        </div>

        {/* Row B — multi-select, decides the POOL. Present in the DOM at all
            times and revealed by a 0fr→1fr grid row, which is the one height
            transition that needs no measured pixel value; `still` drops it to
            0ms under reduced motion. Chips are taken out of the tab order
            while it is closed, so a keyboard never lands on a hidden control. */}
        <div
          {...(showChips ? { "data-ladder-selection": "" } : {})}
          aria-hidden={!showChips}
          style={sx(
            "display:grid;min-height:0;" +
              `grid-template-rows:${showChips ? "1fr" : "0fr"};opacity:${showChips ? 1 : 0};` +
              `transition:grid-template-rows ${still ? 0 : 260}ms cubic-bezier(.2,.8,.2,1),` +
              `opacity ${still ? 0 : 200}ms ease`,
          )}
        >
          <div style={sx("overflow:hidden;min-height:0")}>
            <div
              style={sx(
                "display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:12px;" +
                  `padding:10px 12px;border:1px solid ${C.line};border-radius:12px;` +
                  `background:${C.panel}`,
              )}
            >
              {SECTOR_ORDER.map((k) => (
                <Chip
                  key={k}
                  label={SECTORS[k].label}
                  count={chipCounts.sectors[k]}
                  color={SECTORS[k].color}
                  on={sel.sectors.includes(k)}
                  reachable={showChips}
                  onClick={() => toggleSector(k)}
                />
              ))}

              {/* The AND across the two groups, drawn. */}
              <span
                aria-hidden="true"
                style={sx(`width:1px;height:20px;margin:0 4px;background:${C.border};flex:none`)}
              />

              {MODE_ORDER.map((k) => (
                <Chip
                  key={k}
                  label={MODES[k].label}
                  count={chipCounts.modes[k]}
                  color={MODES[k].color}
                  on={sel.modes.includes(k)}
                  reachable={showChips}
                  onClick={() => toggleMode(k)}
                />
              ))}

              {anySel && (
                <button
                  data-ladder-clear=""
                  tabIndex={showChips ? 0 : -1}
                  onClick={clearSel}
                  style={sx(`${pill(false)};color:${C.dim};margin-left:auto`)}
                >
                  clear ×
                </button>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ── The table ─────────────────────────────────────────────────── */}
      <section
        style={sx(
          `border:1px solid ${C.border};border-radius:14px;background:${C.panel};padding:8px;overflow:hidden`,
        )}
      >
        <div
          style={sx(
            `${LADDER_GRID};${LADDER_ROW_PAD};border-bottom:1px solid ${C.line};` +
              `font:500 9px/1 ${MONO};letter-spacing:.16em;color:${C.faint}`,
          )}
        >
          <span>#</span>
          <span>PLAYER</span>
          <span>TIER</span>
          <span>SPECIALTY</span>
          {/* The metric header IS the active filter — and under SECTOR × MODE
              it spells the selection out, so the column and the chips above it
              can never be read as answering different questions. */}
          <span
            // Named as well as titled: `title` is the untruncated text for a
            // reader, but it is no longer the ONLY title on the page (the risk
            // chips carry one too), so the header identifies itself.
            data-metric-head=""
            title={metricHead}
            style={sx("text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap")}
          >
            {metricHead}
          </span>
          <span>TREND</span>
        </div>

        {rows.length === 0 ? (
          // Reachable only under SECTOR × MODE, and only for a pair no player
          // specialises in (the chips' counts are per-chip, so a legal pair can
          // still be empty). An empty ladder with no way out would be the dead
          // screen §5.3 forbids, so the way out is in the message.
          <div
            data-ladder-empty=""
            style={sx(
              "display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;" +
                `padding:34px 16px;font:500 11px/1.5 ${MONO};color:${C.dim};text-align:center`,
            )}
          >
            NO PLAYER SPECIALISES IN {selectionLabel(sel)}
            {anySel && (
              <button onClick={clearSel} style={sx(pill(false))}>
                clear ×
              </button>
            )}
          </div>
        ) : (
          <div style={sx("display:flex;flex-direction:column;gap:2px;margin-top:6px")}>
            {tableRows.map((row, i) => (
              // Keyed on the run as well as the player so a re-sort remounts
              // the rows and the staggered vcRowIn plays again (§5,
              // "re-animates"). `index` is the position IN THIS LIST, not
              // `row.pos - 1`: the podium took #1–#3, and the stagger should
              // still start at 0 on the first row the reader sees.
              <Fragment key={`${runKey}:${row.player.id}`}>
                <LadderRow
                  row={row}
                  filter={filter}
                  index={i}
                  open={openId === row.player.id}
                  onOpen={openRow}
                />
                {openId === row.player.id && <RowDrawer player={row.player} />}
              </Fragment>
            ))}
          </div>
        )}

        {/* The foot bar. Keyed on the run and NOT on a player id, so it sits
            outside the table's `${runKey}:${id}` key space (one player, two
            elements) while still remounting on a re-rank — the nudge is a
            different sentence under every filter and it should arrive rather
            than morph. */}
        {showPin && (
          <YouPin
            key={`you-pin:${runKey}`}
            row={youRow}
            player={you}
            nudge={nudge}
            filter={filter}
          />
        )}
      </section>
    </div>
  );
}
