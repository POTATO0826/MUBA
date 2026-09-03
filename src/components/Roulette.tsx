import { useEffect, useRef, useState } from "react";
import { fmtPx } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, sectorColor, tag } from "../theme.ts";
import type { Asset } from "../types.ts";

/** Tile pitch in px: width plus gap. The strip's transform is computed from it. */
export const TILE_W = 124;
export const TILE_GAP = 8;
export const TILE_PITCH = TILE_W + TILE_GAP;
/** Tiles on the strip. Enough that the reel never runs out before it stops. */
export const STRIP_LEN = 64;
const SPIN_MS = 4200;

export interface SpinPlan {
  /** Index on the strip the pointer stops on. */
  target: number;
  /** Where inside that tile it stops, -0.35..0.35 of a tile — so landings
   *  don't always sit dead centre. */
  jitter: number;
}

/**
 * Decide where a spin ends before it starts. The target sits in the last
 * quarter of the strip so the reel travels far enough to read as a real spin,
 * and lands on a whole asset — the jitter is cosmetic.
 */
export function planSpin(assetCount: number, random: () => number = Math.random): SpinPlan {
  const lo = Math.floor(STRIP_LEN * 0.72);
  const hi = STRIP_LEN - 2;
  const target = lo + Math.floor(random() * (hi - lo));
  const jitter = (random() - 0.5) * 0.7;
  return { target: target - (target % 1), jitter };
}

/** Quintic ease-out: fast off the line, long slow settle. */
const ease = (t: number) => 1 - Math.pow(1 - t, 5);

interface RouletteProps {
  assets: readonly Asset[];
  onClose: () => void;
  onClaim: (sym: string) => void;
}

/**
 * Case-opening reel. A strip of asset tiles flies past a centre pointer,
 * decelerates, and stops on one. Prices on the tiles flicker while the strip is
 * moving and freeze on the landed asset.
 */
export function Roulette({ assets, onClose, onClaim }: RouletteProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const [plan, setPlan] = useState<SpinPlan>(() => planSpin(assets.length));
  const [spinning, setSpinning] = useState(true);
  const [under, setUnder] = useState(0);
  const [flicker, setFlicker] = useState(0);

  const tiles = Array.from({ length: STRIP_LEN }, (_, i) => assets[i % assets.length]!);
  const landed = tiles[plan.target]!;

  useEffect(() => {
    const strip = stripRef.current;
    const viewport = viewportRef.current;
    if (!strip || !viewport) return;

    const vw = viewport.clientWidth || 720;
    const finalOffset = plan.target * TILE_PITCH + TILE_W / 2 + plan.jitter * TILE_W - vw / 2;

    const start = performance.now();
    let raf = 0;
    let lastUnder = -1;

    const frame = () => {
      const t = Math.min(1, (performance.now() - start) / SPIN_MS);
      const offset = ease(t) * finalOffset;
      strip.style.transform = `translate3d(${-offset}px,0,0)`;

      const idx = Math.max(0, Math.min(STRIP_LEN - 1, Math.floor((offset + vw / 2) / TILE_PITCH)));
      if (idx !== lastUnder) {
        lastUnder = idx;
        setUnder(idx);
      }
      // Small price wobble while the reel is moving — settles to the true print.
      setFlicker(t < 1 ? (Math.random() - 0.5) * 0.006 * (1 - t) : 0);

      if (t < 1) raf = requestAnimationFrame(frame);
      else setSpinning(false);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [plan]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const live = tiles[under] ?? landed;
  const shown = spinning ? live : landed;
  const price = shown.px * (1 + flicker);

  return (
    <div
      role="dialog"
      aria-modal
      aria-label="Free crypto battle roulette"
      onClick={onClose}
      style={sx(
        "position:fixed;inset:0;z-index:60;display:grid;place-items:center;padding:24px;" +
          "background:rgba(9,9,11,.82);backdrop-filter:blur(10px)",
      )}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={sx(
          `width:min(760px,100%);border:1px solid rgba(200,255,0,.35);border-radius:16px;` +
            `background:linear-gradient(160deg,rgba(200,255,0,.08),${C.card} 45%);overflow:hidden;` +
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
              `width:7px;height:7px;border-radius:99px;background:${C.accent};animation:vcPulse 1.4s ease-in-out infinite`,
            )}
          />
          <span style={sx(`font:700 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent}`)}>
            FREE CRYPTO BATTLE · SPIN
          </span>
          <div style={sx("flex:1")} />
          <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>
            {spinning ? "spinning the book…" : "landed"}
          </span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={sx(
              `width:28px;height:28px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
                `color:${C.muted};font:700 13px/1 ${MONO};cursor:pointer`,
            )}
          >
            ×
          </button>
        </div>

        <div style={sx("padding:22px 18px 10px;text-align:center")}>
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

        <div style={sx("display:flex;align-items:center;gap:14px;padding:16px 18px")}>
          {spinning ? (
            <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
              One free 1v1 entry on whatever the pointer stops on. The prize pool is covered by
              the house; the opponent is a random open room.
            </span>
          ) : (
            <>
              <div>
                <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.accent}`)}>
                  YOU WON
                </div>
                <div style={sx(`margin-top:6px;font:700 15px/1.2 ${SANS}`)}>
                  Free 1v1 on {landed.name} · 0.50 ETH pool covered
                </div>
                <div style={sx(`margin-top:5px;font:400 10.5px/1.4 ${MONO};color:${C.dim}`)}>
                  {landed.sym} drafted into your first slot · target ±{landed.t.toFixed(1)}%
                </div>
              </div>
            </>
          )}
          <div style={sx("flex:1")} />
          <button
            disabled={spinning}
            onClick={() => setPlan(planSpin(assets.length))}
            style={sx(
              `height:36px;padding:0 14px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
                `color:${spinning ? C.faint : C.text};font:500 12px/1 ${SANS};cursor:${
                  spinning ? "default" : "pointer"
                };white-space:nowrap`,
            )}
          >
            Spin again
          </button>
          <button
            disabled={spinning}
            onClick={() => onClaim(landed.sym)}
            style={sx(
              `height:36px;padding:0 16px;border:none;border-radius:8px;font:700 12px/1 ${SANS};white-space:nowrap;` +
                (spinning
                  ? `background:${C.border};color:${C.dim};cursor:default`
                  : `background:${C.accent};color:${C.bg};cursor:pointer`),
            )}
          >
            Claim → draft
          </button>
        </div>
      </div>
    </div>
  );
}
