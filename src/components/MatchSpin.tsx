import { useEffect, useRef, useState } from "react";
import { STRIP_LEN, TILE_GAP, TILE_PITCH, TILE_W, type SpinResult } from "../engine/spin.ts";
import { fmtPx } from "../engine/tape.ts";
import { sfx, tickParams } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, sectorColor, tag } from "../theme.ts";
import type { Asset, Player } from "../types.ts";

const SPIN_MS = 3200;
/** Pause between one landing and the next spin, so each slot registers. */
const SETTLE_MS = 650;
/** How long the locked board is shown before the case study opens on its own. */
export const LOCK_MS = 1400;

/** Quintic ease-out: fast off the line, long slow settle. */
const ease = (t: number) => 1 - Math.pow(1 - t, 5);

interface MatchSpinProps {
  lobbyName: string;
  marketLabel: string;
  color: string;
  opponent: Player;
  /** The lobby's book, in the same order `spinCase` indexed it. */
  assets: readonly Asset[];
  result: SpinResult;
  /** Called on its own once every slot has landed and the board has been seen. */
  onDone: () => void;
  onClose: () => void;
}

/**
 * The lucky spin. Both seats are taken; a strip of the lobby's book flies past
 * a centre pointer, decelerates, and stops — once per leg. Each landing fills
 * a slot under the reel. Both players run their slips on exactly these
 * tickers, so the reel is the one thing in the match neither side chose.
 *
 * Everything about *where* it stops was decided before the first frame by
 * `spinCase`; this component only draws the plan it was handed. There is no
 * re-roll and nothing to press: the system spins once, for both players, holds
 * on the locked board for a beat, and the case study opens on its own.
 */
export function MatchSpin(p: MatchSpinProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  /**
   * When the reel last crossed a tile, so the tick can be voiced from the gap
   * the reel actually travelled rather than from the frame clock. Dropped
   * frames widen the gap honestly; the quintic ease does the rest.
   */
  const lastCrossAt = useRef(0);

  const n = p.result.plans.length;
  /** Which plan is on the reel. Equals `n` once every slot has landed. */
  const [step, setStep] = useState(0);
  const [spinning, setSpinning] = useState(true);
  const [under, setUnder] = useState(0);
  const [flicker, setFlicker] = useState(0);
  const [skipped, setSkipped] = useState(false);

  const done = step >= n;
  const landedCount = spinning ? step : Math.min(n, step + 1);

  const tiles = Array.from({ length: STRIP_LEN }, (_, i) => p.assets[i % p.assets.length]!);
  const plan = p.result.plans[Math.min(step, n - 1)]!;

  useEffect(() => {
    const strip = stripRef.current;
    const viewport = viewportRef.current;
    if (!strip || !viewport || done) return;

    const vw = viewport.clientWidth || 720;
    const offsetFor = (target: number, jitter: number) =>
      target * TILE_PITCH + TILE_W / 2 + jitter * TILE_W - vw / 2;

    // Skip: park the strip on the last plan and mark every slot landed.
    if (skipped) {
      const last = p.result.plans[n - 1]!;
      strip.style.transition = "none";
      strip.style.transform = `translate3d(${-offsetFor(last.target, last.jitter)}px,0,0)`;
      setUnder(last.target);
      setFlicker(0);
      setSpinning(false);
      setStep(n);
      return;
    }

    const finalOffset = offsetFor(plan.target, plan.jitter);
    const start = performance.now();
    let raf = 0;
    let lastUnder = -1;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    setSpinning(true);
    lastCrossAt.current = 0;
    const frame = () => {
      const t = Math.min(1, (performance.now() - start) / SPIN_MS);
      const offset = ease(t) * finalOffset;
      strip.style.transform = `translate3d(${-offset}px,0,0)`;

      const idx = Math.max(0, Math.min(STRIP_LEN - 1, Math.floor((offset + vw / 2) / TILE_PITCH)));
      if (idx !== lastUnder) {
        lastUnder = idx;
        setUnder(idx);
        // The CS:GO click, voiced from the measured gap between crossings —
        // dark and dense off the line, sparse and bright into the settle. It
        // lives here and not in an effect on `under`: React would batch the
        // state update and the tick would drift off the tile it belongs to.
        const now = performance.now();
        const gap = lastCrossAt.current === 0 ? 0 : now - lastCrossAt.current;
        lastCrossAt.current = now;
        sfx("spin.tick", tickParams(gap));
      }
      // Small price wobble while the reel is moving — settles to the true print.
      setFlicker(t < 1 ? (Math.random() - 0.5) * 0.006 * (1 - t) : 0);

      if (t < 1) {
        raf = requestAnimationFrame(frame);
        return;
      }
      setSpinning(false);
      sfx("spin.land");
      sfx("spin.reveal", { leg: step });
      // Hold on the landing, then either the next leg or lock.
      settleTimer = setTimeout(() => setStep((s) => s + 1), SETTLE_MS);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }, [step, skipped, done, n, plan, p.result.plans]);

  // Locked: hold so the board registers, then move on without a click.
  useEffect(() => {
    if (!done) return;
    sfx("spin.lock");
    const t = setTimeout(p.onDone, LOCK_MS);
    return () => clearTimeout(t);
  }, [done, p.onDone]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") p.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.onClose]);

  const live = tiles[under] ?? tiles[plan.target]!;
  const shown = spinning ? live : tiles[plan.target]!;
  const price = shown.px * (1 + flicker);

  const status = done
    ? "locked"
    : spinning
      ? `spinning the book… leg ${step + 1} of ${n}`
      : `leg ${step + 1} of ${n} landed`;

  return (
    <div
      role="dialog"
      aria-modal
      aria-label={`${p.lobbyName} spin`}
      onClick={() => {
        sfx("ui.back");
        p.onClose();
      }}
      style={sx(
        "position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:24px;" +
          "background:rgba(9,9,11,.82);backdrop-filter:blur(10px)",
      )}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={sx(
          `width:min(800px,100%);border:1px solid ${p.color}59;border-radius:16px;` +
            `background:linear-gradient(160deg,${p.color}14,${C.card} 45%);overflow:hidden;` +
            "box-shadow:0 30px 80px rgba(0,0,0,.6)",
        )}
      >
        <div
          style={sx(
            `display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid ${C.border}`,
          )}
        >
          <span
            style={sx(
              `width:7px;height:7px;border-radius:99px;background:${p.color};` +
                (done ? "" : "animation:vcPulse 1.4s ease-in-out infinite"),
            )}
          />
          <span style={sx(`font:700 10px/1 ${MONO};letter-spacing:.14em;color:${p.color}`)}>
            LUCKY SPIN · {p.lobbyName.toUpperCase()}
          </span>
          <span style={sx(tag(p.color))}>{p.marketLabel}</span>
          <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>you vs {p.opponent.name}</span>
          <div style={sx("flex:1")} />
          <span style={sx(`font:500 10px/1 ${MONO};color:${done ? C.accent : C.dim}`)}>{status}</span>
          <button
            onClick={() => {
              sfx("ui.back");
              p.onClose();
            }}
            aria-label="Close"
            style={sx(
              `width:28px;height:28px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
                `color:${C.muted};font:700 13px/1 ${MONO};cursor:pointer`,
            )}
          >
            ×
          </button>
        </div>

        <div style={sx("padding:20px 18px 8px;text-align:center")}>
          <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.dim}`)}>
            UNDER THE POINTER
          </div>
          <div
            style={sx(
              `margin-top:10px;font:700 34px/1 ${MONO};letter-spacing:-.03em;color:${
                spinning ? C.text : C.accent
              }`,
            )}
          >
            {shown.sym}
            <span style={sx(`margin-left:14px;font:700 22px/1 ${MONO};color:${C.muted}`)}>
              ${fmtPx(price)}
            </span>
          </div>
        </div>

        <div
          ref={viewportRef}
          style={sx(
            `position:relative;overflow:hidden;margin:12px 0 0;padding:14px 0;border-top:1px solid ${C.line};` +
              `border-bottom:1px solid ${C.line};background:${C.panel}`,
          )}
        >
          <div
            ref={stripRef}
            style={sx(`display:flex;gap:${TILE_GAP}px;width:max-content;will-change:transform`)}
          >
            {tiles.map((a, i) => {
              const color = sectorColor(a.sector);
              const hit = !spinning && i === plan.target;
              return (
                <div
                  key={i}
                  style={sx(
                    `flex:none;width:${TILE_W}px;height:96px;padding:12px;border-radius:11px;` +
                      `background:${C.raised};border:1px solid ${hit ? C.accent : C.border};` +
                      "display:flex;flex-direction:column;justify-content:space-between;position:relative;overflow:hidden" +
                      (hit ? ";box-shadow:0 0 0 3px rgba(200,255,0,.25)" : ""),
                  )}
                >
                  <div
                    style={sx(
                      `position:absolute;inset:-40%;background:radial-gradient(55% 55% at 72% 20%,${color}26,transparent 70%);pointer-events:none`,
                    )}
                  />
                  <div style={sx("position:relative")}>
                    <span style={sx(tag(color))}>{a.sector}</span>
                  </div>
                  <div style={sx("position:relative")}>
                    <div style={sx(`font:700 16px/1 ${MONO};letter-spacing:-.01em`)}>{a.sym}</div>
                    <div style={sx(`margin-top:5px;font:500 10px/1 ${MONO};color:${C.accent}`)}>
                      ${fmtPx(a.px)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            aria-hidden
            style={sx(
              `position:absolute;top:0;bottom:0;left:50%;width:2px;margin-left:-1px;background:${C.accent};` +
                "box-shadow:0 0 12px rgba(200,255,0,.6);pointer-events:none",
            )}
          />
          <div
            aria-hidden
            style={sx(
              "position:absolute;top:0;left:50%;margin-left:-7px;width:0;height:0;" +
                `border-left:7px solid transparent;border-right:7px solid transparent;border-top:8px solid ${C.accent}`,
            )}
          />
          <div
            aria-hidden
            style={sx(
              "position:absolute;bottom:0;left:50%;margin-left:-7px;width:0;height:0;" +
                `border-left:7px solid transparent;border-right:7px solid transparent;border-bottom:8px solid ${C.accent}`,
            )}
          />
          <div
            aria-hidden
            style={sx(
              `position:absolute;top:0;bottom:0;left:0;width:90px;background:linear-gradient(90deg,${C.panel},transparent);pointer-events:none`,
            )}
          />
          <div
            aria-hidden
            style={sx(
              `position:absolute;top:0;bottom:0;right:0;width:90px;background:linear-gradient(270deg,${C.panel},transparent);pointer-events:none`,
            )}
          />
        </div>

        {/* The board being built, one slot per leg. */}
        <div style={sx("display:flex;gap:8px;padding:14px 18px 4px;flex-wrap:wrap")}>
          {Array.from({ length: n }, (_, i) => {
            const sym = i < landedCount ? p.result.syms[i] : null;
            const a = sym ? p.assets.find((x) => x.sym === sym) : null;
            const color = a ? sectorColor(a.sector) : C.borderMid;
            return (
              <div
                key={i}
                data-slot={i}
                style={sx(
                  "flex:1 1 96px;min-width:96px;height:52px;padding:9px 11px;border-radius:9px;display:flex;flex-direction:column;justify-content:space-between;" +
                    (a
                      ? `border:1px solid ${color}66;background:${color}14`
                      : `border:1px dashed ${C.borderMid};background:transparent`),
                )}
              >
                <div style={sx(`font:500 8px/1 ${MONO};letter-spacing:.12em;color:${a ? color : C.faint}`)}>
                  {a ? a.sector : `SLOT ${i + 1}`}
                </div>
                <div style={sx(`font:700 13px/1 ${MONO};color:${a ? C.text : C.faint}`)}>
                  {a ? a.sym : "?"}
                </div>
              </div>
            );
          })}
        </div>

        <div style={sx("display:flex;align-items:center;gap:12px;padding:12px 18px 16px")}>
          <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted};max-width:380px`)}>
            {done
              ? `Locked · ${p.result.syms.join(" · ")}. Both slips run on these. Opening the case study…`
              : `The reel picks what you both play on — ${p.assets.length} names in this book. One spin per leg; the same ticker never fills two slots.`}
          </span>
          <div style={sx("flex:1")} />
          {!done && (
            <button
              onClick={() => {
                sfx("spin.skip");
                setSkipped(true);
              }}
              style={sx(
                `height:36px;padding:0 14px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
                  `color:${C.text};font:500 12px/1 ${SANS};cursor:pointer;white-space:nowrap`,
              )}
            >
              Skip ↦
            </button>
          )}
          {done && (
            <span style={sx(`display:inline-flex;align-items:center;gap:8px;font:700 10px/1 ${MONO};letter-spacing:.12em;color:${C.accent}`)}>
              <span style={sx(`width:6px;height:6px;border-radius:99px;background:${C.accent};animation:vcPulse 1s ease-in-out infinite`)} />
              LOCKED
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
