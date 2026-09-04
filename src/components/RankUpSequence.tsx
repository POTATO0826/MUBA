import { useEffect, useMemo, useRef, useState } from "react";
import { copyEconomicsFor, YOU_ID } from "../data/leaderboard.ts";
import { SEASON } from "../data/rewards.ts";
import {
  FLOURISH_MS,
  rankAt,
  rankTimeline,
  xpEase,
  type CrossKind,
  type Stage,
} from "../engine/rank.ts";
import { sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import { RANK_COLOR, RankBadge, RankWord } from "./RankBadge.tsx";

/**
 * The rank moment (plan 4 §4).
 *
 * ────────────────────────────────────────────────────────────────────────────
 * ONE CLOCK, SEVEN STAGES
 * ────────────────────────────────────────────────────────────────────────────
 * `engine/rank.ts` owns every number and every instant: `rankTimeline` returns
 * a `total`, a sorted list of `beats` and the XP bar's `segments`. This file
 * owns one piece of state — `elapsed` — driven by a single rAF loop, and every
 * pixel on screen is a pure function of it. There is no per-stage timer, no
 * chained `setTimeout`, and nothing that can land out of order.
 *
 * Which means the whole sequence has an exact final state at `elapsed ===
 * total`, and skipping is just assigning it. That is the `MatchSpin` skip
 * idiom, verbatim: the button sets a flag, the effect re-runs, sees the flag,
 * parks the state SYNCHRONOUSLY and never schedules a frame. Under a test's
 * `act()` the click returns with the sequence already finished — which is what
 * makes `throughRank()` (`click("Next → your rank"); click("Skip ↦")`) a pair
 * of ordinary synchronous clicks with no fake timers anywhere.
 *
 * Reduced motion takes the same park path on mount, so a player who asked for
 * no animation gets the finished panel instead of a still frame of stage 1.
 * (Sound availability is deliberately NOT part of that test: a silent build
 * must still animate.)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THE KEYFRAMES ARE ONLY DECORATION
 * ────────────────────────────────────────────────────────────────────────────
 * `styles.css` kills every animation under `[data-rank] *` at reduced motion,
 * so nothing may depend on a keyframe for its resting state. The panel unroll,
 * the scan line, the badge drop, the shimmer, the row stagger and the tier
 * word's slam are all pure decoration on top of values this component has
 * already computed. The two things that genuinely have to move — the XP bar's
 * fill (and therefore the badge's progress ring) and every counting numeral —
 * are interpolated here, on the rAF, so they park correctly on skip.
 *
 * That is also why the progress ring is driven by `point.pct` rather than by
 * `vcRingDraw`: the keyframe would have to be attached to the ring `<circle>`
 * inside `RankBadge`, which an inline style on an ancestor cannot reach, and
 * a keyframe-driven ring could not be parked by the skip. The rAF sweeps the
 * ring across the badge window to exactly the same effect.
 */

/** One frame's worth of wall clock. The rAF loop reads the clock every
 *  callback but repaints at most this often. */
const PAINT_MS = 16;

/** Rendered figures are whole points; the ledger's are already integers. */
const fmt = (n: number): string => Math.round(n).toLocaleString("en-US");

/** The reduced-motion probe, local so no view reaches into `sound/engine.ts`
 *  (BUILD-ORDER §A-a: the sound module's only public path is its index). */
function stillMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

export interface RankUpSequenceProps {
  /** What the match paid — the figure the streak chip prints. */
  xpGain: number;
  xpBefore: number;
  xpAfter: number;
  streak: number;
  posBefore: number;
  posAfter: number;
  /** Fired once, when the sequence reaches its end (or is skipped to it). */
  onDone: () => void;
  /** `View the full ladder →`. A no-op until wave 7 routes `/ranks`. */
  onOpenLadder: () => void;
}

export function RankUpSequence(p: RankUpSequenceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [skipped, setSkipped] = useState(false);
  /** Beat indices already sounded. A beat fires at most once per mount,
   *  whether it was reached by the rAF or jumped over by the skip. */
  const firedRef = useRef<Set<number>>(new Set());
  const finishedRef = useRef(false);
  const onDoneRef = useRef(p.onDone);
  onDoneRef.current = p.onDone;

  // ── Everything the sequence draws, derived from the two XP totals ─────────

  const model = useMemo(() => {
    const before = rankAt(p.xpBefore);
    const after = rankAt(p.xpAfter);
    const econBefore = copyEconomicsFor(YOU_ID, p.xpBefore);
    const econAfter = copyEconomicsFor(YOU_ID, p.xpAfter);
    const unlockedCopy = after.tier.copyUnlocked && !before.tier.copyUnlocked;
    const timeline = rankTimeline(p.xpBefore, p.xpAfter, unlockedCopy);

    // First beat of each stage — the instant that stage becomes visible.
    const starts = new Map<Stage, number>();
    for (const b of timeline.beats) if (!starts.has(b.stage)) starts.set(b.stage, b.t);

    // Rebuild the bar's fill schedule from the timeline. `rankTimeline` cuts
    // the XP window per segment and splices a FLOURISH_MS pause after every
    // crossing; the window itself is whatever is left between the first tick
    // and the ladder beat once those pauses are taken out.
    const xpStart = starts.get("xpCount") ?? 0;
    const ladderAt = starts.get("ladder") ?? xpStart;
    const crossings = timeline.segments.filter((s) => s.cross !== null).length;
    const window = Math.max(1, ladderAt - xpStart - FLOURISH_MS * crossings);
    const gain = timeline.segments.reduce((n, s) => n + Math.max(0, s.to - s.from), 0);

    let t = xpStart;
    const fills = timeline.segments.map((seg) => {
      const dur =
        gain > 0
          ? (window * Math.max(0, seg.to - seg.from)) / gain
          : window / timeline.segments.length;
      const entry = { seg, start: t, dur, pause: seg.cross ? FLOURISH_MS : 0 };
      t += dur + entry.pause;
      return entry;
    });

    return { before, after, econBefore, econAfter, unlockedCopy, timeline, starts, xpStart, fills };
  }, [p.xpBefore, p.xpAfter]);

  const { before, after, econBefore, econAfter, unlockedCopy, timeline, starts, fills } = model;
  const total = timeline.total;

  // ── The clock ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (finishedRef.current) return;

    const fireThrough = (t: number): void => {
      const set = firedRef.current;
      timeline.beats.forEach((b, i) => {
        if (b.t <= t && !set.has(i)) {
          set.add(i);
          sfx(b.sound);
        }
      });
    };

    /** The end state, assigned rather than animated to. */
    const park = (): void => {
      setElapsed(total);
      fireThrough(total);
      finishedRef.current = true;
      onDoneRef.current();
    };

    // Skip, reduced motion, or an environment with no rAF at all: park.
    if (skipped || typeof requestAnimationFrame !== "function" || stillMotion()) {
      park();
      return;
    }

    let raf = 0;
    let painted = -PAINT_MS;
    const t0 = performance.now();
    const frame = (): void => {
      const e = performance.now() - t0;
      if (e >= total) {
        park();
        return;
      }
      // Beats are checked every frame — a sound must not drift — but the
      // re-render is throttled to one paint's worth of wall clock. A browser
      // gives us ~60 callbacks a second anyway; happy-dom's `requestAnimation-
      // Frame` is an unthrottled recursion, and without this the sequence
      // would re-render the whole panel thousands of times a second under a
      // test that lets it play instead of pressing Skip.
      fireThrough(e);
      if (e - painted >= PAINT_MS) {
        painted = e;
        setElapsed(e);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [skipped, timeline, total]);

  // The rank moment sits below the debrief; bring it into view on arrival.
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof el.scrollIntoView !== "function") return;
    try {
      el.scrollIntoView({ block: "start", behavior: stillMotion() ? "auto" : "smooth" });
    } catch {
      /* happy-dom and older engines: the panel is on screen regardless. */
    }
  }, []);

  // ── Sampling: every figure below is a pure read of `elapsed` ─────────────

  const shown = (s: Stage): boolean => elapsed >= (starts.get(s) ?? Number.POSITIVE_INFINITY);

  /** The XP bar at `elapsed`: the running total, the band fill, and whether a
   *  crossing is being celebrated right now. */
  const bar = ((): { xp: number; pct: number; bloom: number; cross: CrossKind | null } => {
    const segs = timeline.segments;
    const first = segs[0]!;
    const last = segs[segs.length - 1]!;
    if (elapsed <= model.xpStart) return { xp: first.from, pct: first.pct0, bloom: 0, cross: null };
    for (const f of fills) {
      if (elapsed < f.start + f.dur) {
        const k = xpEase(f.dur > 0 ? (elapsed - f.start) / f.dur : 1);
        return {
          xp: f.seg.from + (f.seg.to - f.seg.from) * k,
          pct: f.seg.pct0 + (f.seg.pct1 - f.seg.pct0) * k,
          bloom: 0,
          cross: null,
        };
      }
      if (f.pause > 0 && elapsed < f.start + f.dur + f.pause) {
        // Crossed. The bar has snapped 100 → 0 into the new band and the
        // flourish is playing over the top of it.
        const k = (elapsed - f.start - f.dur) / f.pause;
        return { xp: f.seg.to, pct: 0, bloom: Math.sin(Math.PI * k), cross: f.seg.cross };
      }
    }
    return { xp: last.to, pct: last.pct1, bloom: 0, cross: null };
  })();

  const live = rankAt(bar.xp);
  const color = RANK_COLOR[live.tier.name];

  // The ring sweeps 0 → the player's fill across the badge window, then hands
  // over to the bar. Same arc `vcRingDraw` would draw, but parkable.
  const badgeStart = starts.get("badge") ?? 0;
  const ringPct =
    elapsed <= badgeStart
      ? 0
      : elapsed < model.xpStart
        ? xpEase((elapsed - badgeStart) / Math.max(1, model.xpStart - badgeStart)) * bar.pct
        : bar.pct;

  const ladderStart = starts.get("ladder") ?? 0;
  const copyStart = starts.get("copy") ?? ladderStart;
  const settleStart = starts.get("settle") ?? copyStart;

  const span = (from: number, to: number): number =>
    elapsed <= from ? 0 : xpEase(Math.min(1, (elapsed - from) / Math.max(1, to - from)));

  const posK = span(ladderStart, copyStart);
  const posNow = Math.round(p.posBefore + (p.posAfter - p.posBefore) * posK);

  const copyK = span(copyStart, settleStart);
  const lerp = (a: number, b: number): number => a + (b - a) * copyK;
  const copiersNow = Math.round(lerp(econBefore.copiers, econAfter.copiers));

  const done = elapsed >= total;

  // ── The copy-trade panel's rows (plan 4 §2.3) ────────────────────────────

  const copyRows: { key: string; label: string; value: string; tone: string; sub?: string }[] = [
    {
      key: "state",
      label: after.label,
      value: econAfter.unlocked ? "COPY-TRADE ACTIVE" : "LOCKED",
      tone: econAfter.unlocked ? color : C.dim,
    },
    {
      key: "copiers",
      label: "COPIERS",
      value: fmt(copiersNow),
      tone: econAfter.unlocked ? C.text : C.dim,
      sub: `${(econAfter.feePct * 100).toFixed(1)}% PER COPIED TRANSACTION`,
    },
    {
      key: "yield",
      label: "PROJECTED YIELD",
      value: `≈ ${fmt(lerp(econBefore.daily, econAfter.daily))} PTS / DAY`,
      tone: econAfter.unlocked ? C.accent : C.dim,
      sub: `7D ${fmt(lerp(econBefore.weekly, econAfter.weekly))} · 30D ${fmt(
        lerp(econBefore.monthly, econAfter.monthly),
      )}`,
    },
  ];

  return (
    <div
      ref={rootRef}
      data-rank={after.label}
      data-rank-sequence=""
      style={sx(
        `position:relative;overflow:hidden;margin-top:18px;border:1px solid ${C.border};border-radius:14px;` +
          `background:linear-gradient(160deg,${C.panelAlt},${C.card} 62%);padding:22px 24px 20px;` +
          `transform-origin:top center;animation:vcRankPanel 380ms cubic-bezier(.2,.8,.2,1) both`,
      )}
    >
      {/* Stage 1 · the accent scan-line that runs down the opening panel. */}
      <span
        aria-hidden="true"
        style={sx(
          `position:absolute;left:0;right:0;top:0;height:2px;pointer-events:none;` +
            `background:linear-gradient(90deg,transparent,${color},transparent);` +
            `animation:vcRankSweep 900ms cubic-bezier(.2,.8,.2,1) both`,
        )}
      />

      <div style={sx("display:flex;align-items:center;gap:12px")}>
        <span style={sx(`font:700 9px/1 ${MONO};letter-spacing:.18em;color:${C.dim}`)}>
          {SEASON.label} · RANK PROGRESS
        </span>
        <div style={sx("flex:1")} />
        {!done && (
          <button
            onClick={() => {
              sfx("rank.skip");
              setSkipped(true);
            }}
            style={sx(
              `height:32px;padding:0 13px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
                `color:${C.text};font:500 12px/1 ${SANS};cursor:pointer;white-space:nowrap`,
            )}
          >
            Skip ↦
          </button>
        )}
      </div>

      {/* Stage 2 · the sigil drops, its ring sweeps to the division's fill. */}
      {shown("badge") && (
        <div style={sx("display:flex;align-items:center;gap:22px;margin-top:16px")}>
          <span
            style={sx(
              `position:relative;display:inline-grid;place-items:center;flex:none;` +
                `animation:vcBadgeDrop 520ms cubic-bezier(.2,1.3,.3,1) both`,
            )}
          >
            {/* Stage 4 · the crossing bloom, sized on the rAF so a skip clears it. */}
            <span
              aria-hidden="true"
              style={sx(
                `position:absolute;width:190px;height:190px;border-radius:99px;pointer-events:none;` +
                  `background:radial-gradient(circle,${color}44,transparent 68%);` +
                  `opacity:${(bar.bloom * (bar.cross === "tier" ? 1 : 0.55)).toFixed(3)};` +
                  `transform:scale(${(0.6 + bar.bloom * 0.5).toFixed(3)})`,
              )}
            />
            <RankBadge point={{ ...live, pct: ringPct }} size={104} />
          </span>

          <div style={sx("flex:1;min-width:0")}>
            {/* Stage 4 · the word slams on every band change — keyed on the
                label, so React remounts it and the animation replays. */}
            <span
              key={live.label}
              style={sx(
                `display:inline-block;animation:vcRankSlam ${bar.cross === "tier" ? 520 : 380}ms ` +
                  `cubic-bezier(.2,.8,.2,1) both`,
              )}
            >
              <RankWord point={live} size={26} />
            </span>

            {/* Stage 3 · the XP bar. */}
            {shown("xpCount") && (
              <>
                <div style={sx("display:flex;align-items:baseline;gap:10px;margin-top:12px;flex-wrap:wrap")}>
                  <span data-rank-xp={Math.round(bar.xp)} style={sx(`font:700 24px/1 ${MONO};color:${C.text}`)}>
                    {fmt(bar.xp)}
                  </span>
                  <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.dim}`)}>
                    XP · {fmt(live.floor)} → {fmt(live.ceil)}
                  </span>
                  <div style={sx("flex:1")} />
                  {p.streak > 1 && (
                    <span
                      style={sx(
                        `font:700 9px/1 ${MONO};letter-spacing:.12em;padding:5px 8px;border-radius:5px;` +
                          `background:rgba(200,255,0,.12);border:1px solid rgba(200,255,0,.35);color:${C.accent}`,
                      )}
                    >
                      +{p.xpGain} XP · STREAK ×{p.streak}
                    </span>
                  )}
                  {p.streak <= 1 && (
                    <span style={sx(`font:700 9px/1 ${MONO};letter-spacing:.12em;color:${C.accent}`)}>
                      +{p.xpGain} XP
                    </span>
                  )}
                </div>

                <div
                  style={sx(
                    `position:relative;height:14px;margin-top:10px;border-radius:99px;overflow:hidden;` +
                      `background:${C.line};border:1px solid ${C.border}`,
                  )}
                >
                  <span
                    data-rank-bar={bar.pct.toFixed(3)}
                    style={sx(
                      `position:absolute;inset:0 auto 0 0;width:${(bar.pct * 100).toFixed(2)}%;border-radius:99px;` +
                        `background:linear-gradient(90deg,${color}aa,${color});box-shadow:0 0 14px ${color}66`,
                    )}
                  />
                  <span
                    aria-hidden="true"
                    style={sx(
                      "position:absolute;inset:0;pointer-events:none;background-size:44% 100%;background-repeat:no-repeat;" +
                        "background-image:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);" +
                        "animation:vcXpShimmer 1100ms linear infinite",
                    )}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Stage 5 · the ladder position slides. */}
      {shown("ladder") && (
        <div
          data-rank-ladder=""
          style={sx(
            `display:flex;align-items:baseline;gap:10px;margin-top:18px;padding-top:14px;border-top:1px solid ${C.line};` +
              "animation:vcRowIn 320ms cubic-bezier(.2,.8,.2,1) both",
          )}
        >
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.dim}`)}>LADDER POSITION</span>
          <span style={sx(`font:700 16px/1 ${MONO};color:${C.muted}`)}>#{p.posBefore}</span>
          <span style={sx(`font:700 13px/1 ${MONO};color:${C.dim}`)}>→</span>
          <span style={sx(`font:700 20px/1 ${MONO};color:${color}`)}>#{posNow}</span>
        </div>
      )}

      {/* Stage 6 · the copy-trade panel. */}
      {shown("copy") && (
        <div
          data-rank-copy=""
          style={sx(
            `position:relative;margin-top:16px;border:1px solid ${C.border};border-radius:12px;` +
              `background:${C.panel};padding:14px 16px 14px 18px;overflow:hidden`,
          )}
        >
          <span
            aria-hidden="true"
            style={sx(
              `position:absolute;left:0;top:0;bottom:0;width:3px;background:${color};color:${color};` +
                "animation:vcHeat 1600ms ease-in-out infinite",
            )}
          />
          {copyRows.map((r, i) => (
            <div
              key={r.key}
              style={sx(
                `display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;` +
                  `${i > 0 ? `margin-top:10px;padding-top:10px;border-top:1px solid ${C.line};` : ""}` +
                  `animation:vcRowIn 320ms cubic-bezier(.2,.8,.2,1) ${i * 120}ms both`,
              )}
            >
              <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.dim}`)}>{r.label}</span>
              <span style={sx(`font:700 14px/1 ${MONO};color:${r.tone}`)}>{r.value}</span>
              {r.sub && (
                <>
                  <div style={sx("flex:1")} />
                  <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.faint}`)}>{r.sub}</span>
                </>
              )}
            </div>
          ))}

          {unlockedCopy && (
            <div
              style={sx(
                `margin-top:10px;padding-top:10px;border-top:1px solid ${C.line};` +
                  `font:700 10px/1 ${MONO};letter-spacing:.12em;color:${C.accent};` +
                  "animation:vcRowIn 320ms cubic-bezier(.2,.8,.2,1) 360ms both",
              )}
            >
              +{fmt(econAfter.copiers)} COPIERS UNLOCKED AT {after.tier.name}
            </div>
          )}

          {!econAfter.unlocked && econAfter.nextUnlock && (
            <div
              style={sx(
                `display:flex;align-items:center;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid ${C.line};` +
                  "animation:vcRowIn 320ms cubic-bezier(.2,.8,.2,1) 360ms both",
              )}
            >
              <span
                style={sx(
                  `width:6px;height:6px;border-radius:99px;flex:none;background:${C.amber};color:${C.amber};` +
                    "animation:vcHeat 1400ms ease-in-out infinite",
                )}
              />
              <span style={sx(`font:700 10px/1 ${MONO};letter-spacing:.12em;color:${C.amber}`)}>
                UNLOCK COPY-TRADE AT {econAfter.nextUnlock.tier.name} · {fmt(econAfter.nextUnlock.xpAway)} XP
              </span>
            </div>
          )}
        </div>
      )}

      {/* Stage 7 · the sequence has settled; `Result` reveals the exit row. */}
      {shown("settle") && (
        <div
          style={sx(
            `display:flex;align-items:center;gap:8px;margin-top:14px;` +
              "animation:vcRowIn 320ms cubic-bezier(.2,.8,.2,1) both",
          )}
        >
          <span
            style={sx(
              `width:6px;height:6px;border-radius:99px;background:${color};animation:vcPulse 1.8s ease-in-out infinite`,
            )}
          />
          <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.dim}`)}>
            {before.label === after.label
              ? `BANKED · +${fmt(p.xpGain)} XP · ${after.label} · ${fmt(
                  Math.max(0, after.ceil - p.xpAfter),
                )} XP TO THE NEXT BAND`
              : `PROMOTED · ${before.label} → ${after.label}`}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * The exits, revealed only once the sequence has settled (BUILD-ORDER §A-b's
 * `ExitRow at phase === "done"`). It lives in this file rather than in
 * `Result.tsx` because it belongs to the rank moment's tail — and because the
 * ladder link is the rank moment's own call to action.
 *
 * The three labels are exact: `test/app.test.tsx`'s `click()` matches a
 * button's trimmed `textContent` verbatim.
 */
export function ExitRow(p: {
  onBackToBattles: () => void;
  onRematch: () => void;
  onOpenLadder: () => void;
}) {
  return (
    <div
      data-rank-exits=""
      style={sx(
        "display:flex;gap:10px;margin-top:18px;flex-wrap:wrap;" +
          "animation:vcRowIn 340ms cubic-bezier(.2,.8,.2,1) both",
      )}
    >
      <button
        onClick={p.onBackToBattles}
        style={sx(
          `height:40px;padding:0 18px;border:none;border-radius:8px;background:${C.accent};color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
        )}
      >
        Back to battles
      </button>
      <button
        onClick={p.onRematch}
        style={sx(
          `height:40px;padding:0 18px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;color:${C.text};font:500 13px/1 ${SANS};cursor:pointer`,
        )}
      >
        Rematch · new lobby
      </button>
      <div style={sx("flex:1")} />
      <button
        onClick={() => {
          sfx("ui.click");
          p.onOpenLadder();
        }}
        style={sx(
          `height:40px;padding:0 18px;border:1px solid ${C.border};border-radius:8px;background:${C.card};` +
            `color:${C.muted};font:500 13px/1 ${SANS};cursor:pointer`,
        )}
      >
        View the full ladder →
      </button>
    </div>
  );
}
