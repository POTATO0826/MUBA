import { useEffect, useRef, type RefObject } from "react";
import { C, MONO } from "../theme.ts";

/**
 * CursorField — a tape-reader's cursor trail.
 *
 * Glyphs from the duel's own vocabulary (ticks, deltas, digits) print onto a
 * coarse character grid wherever the pointer passes, hold for a beat and decay.
 * Adapted from cursor.com's ASCII trail, but pulled toward THETADUEL: the grid
 * reads as a terminal ledger rather than a particle field, the alphabet is
 * market notation, and the palette is the app's own — dim slate most of the
 * time, the acid accent on a rare print, the way a fill flashes on a tape.
 *
 * It is a passive overlay: `pointer-events:none`, no React state, no re-render
 * per move. Everything lives in refs and the canvas.
 *
 * `excludeRef` names a region the trail must never touch — on the hero that is
 * the dither hand art, which the owner wants visually pristine. Cells whose
 * centre falls inside that rect (padded) are dropped at spawn.
 */

/** Character cell, in CSS pixels. Coarse enough to read as a grid. */
const CELL = 16;
/** Glyph type size. */
const FONT_PX = 11;
/** Spawn disc around the pointer, in cells. */
const SPAWN_R = 3;
/** Hard ceiling on live glyphs; the oldest is evicted past it. */
const MAX_GLYPHS = 120;
/** Shortest / longest life of a glyph, ms. */
const LIFE_MIN = 600;
const LIFE_MAX = 900;
/** No pointer movement for this long (and nothing left to draw) parks the loop. */
const IDLE_MS = 1500;
/** Minimum gap between spawn bursts, ms. */
const SPAWN_MS = 24;
/**
 * Padding around the excluded region. The hand art drifts and scales under
 * `vcDrift` (±14px of translate, plus a 1.04→1.07 scale), so the layout box
 * alone understates where it actually paints; this covers the whole excursion
 * without re-measuring a transformed element every frame.
 */
const EXCLUDE_PAD = 28;

/**
 * The market alphabet, already weighted: quiet marks repeat, so a random pick
 * lands on a dot or a digit far more often than on a direction arrow.
 */
const ALPHABET = [
  "·", "·", "·", "·", "·", "·", "·", "·",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "0", "1", "3", "5", "7", "9",
  "+", "+", "−", "−", "%", ">", "·", "·",
  "$", "%", ">", "−", "+",
  "↑", "↓",
] as const;

/** One printed cell. */
interface Glyph {
  /** Draw position, CSS px, already snapped to the cell centre. */
  x: number;
  y: number;
  /** Grid key, so the same cell is not double-printed while it is alive. */
  key: number;
  ch: string;
  color: string;
  born: number;
  life: number;
  /** Peak alpha: closer to the pointer at spawn means brighter. */
  peak: number;
  /** Sub-pixel drift along pointer velocity, total px over the glyph's life. */
  dx: number;
  dy: number;
  /** Flicker phase; only the accent prints use it. */
  flicker: number;
}

export interface CursorFieldProps {
  /** Region the trail must never enter (the dither hand art on the hero). */
  excludeRef?: RefObject<HTMLElement | null>;
}

export function CursorField({ excludeRef }: CursorFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    // Reduced motion: never start. Nothing renders, nothing listens.
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    // happy-dom and any canvas-less host: `getContext` is stubbed to null.
    if (typeof canvas.getContext !== "function") return;
    const c2d = canvas.getContext("2d");
    if (!c2d) return;
    const ctx: CanvasRenderingContext2D = c2d;
    if (typeof requestAnimationFrame !== "function") return;

    const glyphs: Glyph[] = [];
    const taken = new Set<number>();

    let width = 0;
    let height = 0;
    let dpr = 1;

    /** The forbidden rect, in canvas-local (padding-box) coordinates. */
    let block: { x0: number; y0: number; x1: number; y1: number } | null = null;

    const measure = () => {
      width = host.clientWidth;
      height = host.clientHeight;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));

      // `offsetLeft/Top` are measured from the host's padding edge, which is
      // exactly the box an `inset:0` absolute child spans — so the numbers drop
      // straight into canvas coordinates, and unlike getBoundingClientRect they
      // ignore the running transform.
      const ex = excludeRef?.current;
      block = ex
        ? {
            x0: ex.offsetLeft - EXCLUDE_PAD,
            y0: ex.offsetTop - EXCLUDE_PAD,
            x1: ex.offsetLeft + ex.offsetWidth + EXCLUDE_PAD,
            y1: ex.offsetTop + ex.offsetHeight + EXCLUDE_PAD,
          }
        : null;
    };
    measure();

    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(host);

    let onScreen = true;
    const io =
      typeof IntersectionObserver === "function"
        ? new IntersectionObserver(([entry]) => {
            onScreen = entry?.isIntersecting ?? true;
            if (onScreen) wake();
            else park();
          }, { threshold: 0.01 })
        : null;
    io?.observe(host);

    let px = 0;
    let py = 0;
    let vx = 0;
    let vy = 0;
    let seeded = false;
    let lastMove = 0;
    let lastSpawn = 0;

    const inBlock = (x: number, y: number) =>
      block !== null && x >= block.x0 && x <= block.x1 && y >= block.y0 && y <= block.y1;

    const pick = <T,>(list: readonly T[]): T => list[(Math.random() * list.length) | 0] as T;

    function spawn(now: number) {
      const speed = Math.hypot(vx, vy);
      // A fast pointer lays down a slightly denser trail.
      const count = 1 + (speed > 5 ? 1 : 0) + (Math.random() < 0.22 ? 1 : 0);

      for (let i = 0; i < count; i++) {
        // Bias the disc a little ahead of the pointer, along its travel.
        const bx = px + Math.max(-14, Math.min(14, vx)) * 0.7;
        const by = py + Math.max(-14, Math.min(14, vy)) * 0.7;

        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * SPAWN_R;
        const col = Math.floor((bx + Math.cos(a) * r * CELL) / CELL);
        const row = Math.floor((by + Math.sin(a) * r * CELL) / CELL);

        const cx = col * CELL + CELL / 2;
        const cy = row * CELL + CELL / 2;
        if (cx < 0 || cy < 0 || cx > width || cy > height) continue;
        if (inBlock(cx, cy)) continue;

        const key = col * 1024 + row;
        if (taken.has(key)) continue;

        if (glyphs.length >= MAX_GLYPHS) {
          const dead = glyphs.shift();
          if (dead) taken.delete(dead.key);
        }

        // Rare acid print — roughly one in twelve — reads as a fill on the tape.
        const roll = Math.random();
        const color = roll < 1 / 12 ? C.accent : roll < 0.34 ? C.green : C.faint;

        const near = Math.hypot(cx - px, cy - py) / (SPAWN_R * CELL);
        taken.add(key);
        glyphs.push({
          x: cx,
          y: cy,
          key,
          ch: pick(ALPHABET),
          color,
          born: now,
          life: LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN),
          peak: 0.45 + 0.55 * Math.max(0, 1 - near),
          dx: Math.max(-9, Math.min(9, vx)) * 0.28,
          dy: Math.max(-9, Math.min(9, vy)) * 0.28,
          flicker: Math.random() * Math.PI * 2,
        });
      }
    }

    const onMove = (e: PointerEvent) => {
      if (e.pointerType === "touch") return; // desktop pointers only
      const rect = host.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (seeded) {
        vx += (x - px - vx) * 0.35;
        vy += (y - py - vy) * 0.35;
      } else {
        seeded = true;
      }
      px = x;
      py = y;

      const now = performance.now();
      lastMove = now;
      if (now - lastSpawn >= SPAWN_MS) {
        lastSpawn = now;
        spawn(now);
      }
      wake();
    };

    const onLeave = () => {
      seeded = false;
      vx = 0;
      vy = 0;
    };

    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerleave", onLeave);

    /** Alpha envelope: snap in, hold, then a long tail out. */
    const envelope = (t: number) => {
      if (t < 0.1) return t / 0.1;
      if (t < 0.3) return 1;
      const u = (t - 0.3) / 0.7;
      return (1 - u) * (1 - u) * (1 - u * 0.4);
    };

    let raf = 0;
    let running = false;

    const frame = () => {
      const now = performance.now();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.font = `${FONT_PX}px ${MONO}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      let write = 0;
      for (let i = 0; i < glyphs.length; i++) {
        const g = glyphs[i] as Glyph;
        const t = (now - g.born) / g.life;
        if (t >= 1) {
          taken.delete(g.key);
          continue;
        }
        let alpha = envelope(t) * g.peak * 0.4;
        if (g.color === C.accent) alpha *= 0.78 + 0.22 * Math.sin(now * 0.018 + g.flicker);

        ctx.globalAlpha = alpha;
        ctx.fillStyle = g.color;
        ctx.fillText(g.ch, g.x + g.dx * t, g.y + g.dy * t);

        glyphs[write++] = g;
      }
      glyphs.length = write;
      ctx.globalAlpha = 1;

      if (!onScreen || (glyphs.length === 0 && now - lastMove > IDLE_MS)) {
        park();
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    function wake() {
      if (running || !onScreen) return;
      running = true;
      raf = requestAnimationFrame(frame);
    }

    function park() {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      raf = 0;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
    }

    return () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerleave", onLeave);
      ro?.disconnect();
      io?.disconnect();
      glyphs.length = 0;
      taken.clear();
    };
  }, [excludeRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-cursor-field=""
      style={{ position: "absolute", inset: 0, zIndex: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    />
  );
}

export default CursorField;
