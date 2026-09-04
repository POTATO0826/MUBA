import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type MouseEventHandler,
} from "react";
import { sfx } from "../lib/sound/index.ts";

/**
 * Starfield Button — Originkit.
 *
 * Idle: accent lights travel the border band at constant arc-length speed.
 * Hover: the face fills with a twinkling pixel grid drawn on a 2D canvas, and an
 * inner rim glow fades up.
 *
 * Ported from `StarfieldButton.jsx` in the design source.
 */

const MAX_BAND_WIDTH = 30;
/** Seconds for one full lap at `speed = 100`. */
const SECONDS_AT_SPEED_1 = 10;
const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface BorderSpec {
  borderWidth?: number | string;
  borderTopWidth?: number | string;
  borderRightWidth?: number | string;
  borderBottomWidth?: number | string;
  borderLeftWidth?: number | string;
  borderStyle?: string;
  borderColor?: string;
}

export interface StarfieldButtonProps {
  label?: string;
  onClick?: MouseEventHandler<HTMLButtonElement>;
  /** Padding inside the face, not the border band. */
  padding?: string;
  /** 0–100, as a percentage of the maximum possible radius. */
  rounded?: number;
  fill?: string;
  textColor?: string;
  font?: CSSProperties;
  border?: BorderSpec;
  glowColor?: string;
  glowSize?: number;
  /** 0–100. */
  glowOpacity?: number;
  lightColor?: string;
  /** 1–12. */
  lightCount?: number;
  lightSize?: number;
  lightThickness?: number;
  /** 0–100; 50 is the reference rate, 0 stops. */
  speed?: number;
  direction?: "cw" | "ccw";
  /** `continuous` travels by arc length; `step` by angle, which whips the corners. */
  movement?: "continuous" | "step";
  pixelColor?: string;
  pixelSize?: number;
  /** 0–100. */
  pixelDensity?: number;
  /** 0–100+. */
  pixelBrightness?: number;
  style?: CSSProperties;
}

function bandWidth(v: number | string | undefined): number {
  const parsed = parseFloat(String(v ?? ""));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_BAND_WIDTH) : 0;
}

function bandWidthsOf(b: BorderSpec | undefined) {
  const spec = b ?? {};
  const fused = bandWidth(spec.borderWidth);
  return {
    top: spec.borderTopWidth !== undefined ? bandWidth(spec.borderTopWidth) : fused,
    right: spec.borderRightWidth !== undefined ? bandWidth(spec.borderRightWidth) : fused,
    bottom: spec.borderBottomWidth !== undefined ? bandWidth(spec.borderBottomWidth) : fused,
    left: spec.borderLeftWidth !== undefined ? bandWidth(spec.borderLeftWidth) : fused,
  };
}

function parseColor(input: string | undefined): RGBA {
  if (!input) return WHITE;
  let c = String(input).trim();

  const token = c.match(/^var\([^,]+,\s*(.+)\)$/i);
  if (token?.[1]) c = token[1].trim();

  if (c[0] === "#") {
    let h = c.slice(1);
    if (h.length === 3 || h.length === 4) h = h.split("").map((ch) => ch + ch).join("");
    if (h.length !== 6 && h.length !== 8) return WHITE;
    const n = parseInt(h, 16);
    if (Number.isNaN(n)) return WHITE;
    return h.length === 6
      ? { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
      : { r: (n >>> 24) & 255, g: (n >>> 16) & 255, b: (n >>> 8) & 255, a: (n & 255) / 255 };
  }

  const fn = c.match(/rgba?\(([^)]+)\)/i);
  if (fn?.[1]) {
    const p = fn[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    if (p.length >= 3 && p.slice(0, 3).every((v) => !Number.isNaN(v))) {
      return { r: p[0]!, g: p[1]!, b: p[2]!, a: p.length > 3 && !Number.isNaN(p[3]!) ? p[3]! : 1 };
    }
  }
  return WHITE;
}

const rgba = (c: RGBA, a: number) =>
  `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.max(0, Math.min(1, a))})`;

/** `rounded` is a percentage of the maximum possible radius (half the short
 *  side), measured rather than handed to CSS — a CSS percentage resolves per
 *  axis and would give an ellipse. */
const radiusFromPercent = (w: number, h: number, pct: number) =>
  (Math.min(w, h) / 2) * (Math.max(0, Math.min(100, pct)) / 100);

/** Punches the content box out of the border box, leaving only the band. */
const BAND_MASK: CSSProperties = {
  maskImage: "linear-gradient(#000 0 0), linear-gradient(#000 0 0)",
  maskClip: "border-box, content-box",
  maskComposite: "exclude",
  WebkitMaskImage: "linear-gradient(#000 0 0), linear-gradient(#000 0 0)",
  WebkitMaskClip: "border-box, content-box",
  WebkitMaskComposite: "xor",
};

const rnd = (i: number, salt: number) => {
  const x = Math.sin((i + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

interface Point {
  x: number;
  y: number;
}

/** Point at travel fraction `t` along a rounded rect's perimeter, by ARC LENGTH —
 *  constant speed, always on the border. */
function pointOnRoundRect(t: number, w: number, h: number, r: number): Point {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  const sx = Math.max(0, w - 2 * rr);
  const sy = Math.max(0, h - 2 * rr);
  const arc = (Math.PI / 2) * rr;
  const total = 2 * sx + 2 * sy + 4 * arc;
  if (total <= 0) return { x: w / 2, y: h / 2 };

  let d = ((((t % 1) + 1) % 1) * total + sx / 2) % total;

  if (d < sx) return { x: rr + d, y: 0 };
  d -= sx;
  if (d < arc) { const a = d / rr; return { x: w - rr + rr * Math.sin(a), y: rr - rr * Math.cos(a) }; }
  d -= arc;
  if (d < sy) return { x: w, y: rr + d };
  d -= sy;
  if (d < arc) { const a = d / rr; return { x: w - rr + rr * Math.cos(a), y: h - rr + rr * Math.sin(a) }; }
  d -= arc;
  if (d < sx) return { x: w - rr - d, y: h };
  d -= sx;
  if (d < arc) { const a = d / rr; return { x: rr - rr * Math.sin(a), y: h - rr + rr * Math.cos(a) }; }
  d -= arc;
  if (d < sy) return { x: 0, y: h - rr - d };
  d -= sy;
  const a = d / rr;
  return { x: rr - rr * Math.cos(a), y: rr - rr * Math.sin(a) };
}

/** Same outline, but constant ANGULAR speed — hesitates on the long sides and
 *  whips the corners, exactly what a rotating conic gradient produces. */
function pointOnRoundRectAngular(t: number, w: number, h: number, r: number): Point {
  const a = w / 2;
  const b = h / 2;
  if (a <= 0 || b <= 0) return { x: w / 2, y: h / 2 };

  const rr = Math.max(0, Math.min(r, a, b));
  const th = -Math.PI / 2 + (((t % 1) + 1) % 1) * Math.PI * 2;
  const dx = Math.cos(th);
  const dy = Math.sin(th);
  const kx = Math.abs(dx) > 1e-9 ? a / Math.abs(dx) : Infinity;
  const ky = Math.abs(dy) > 1e-9 ? b / Math.abs(dy) : Infinity;
  let k = Math.min(kx, ky);

  const cx = a - rr;
  const cy = b - rr;
  if (rr > 0 && Math.abs(dx * k) > cx && Math.abs(dy * k) > cy) {
    const Cx = Math.sign(dx * k) * cx;
    const Cy = Math.sign(dy * k) * cy;
    const proj = dx * Cx + dy * Cy;
    const disc = rr * rr - (Cx * Cx + Cy * Cy) + proj * proj;
    k = proj + Math.sqrt(Math.max(0, disc));
  }
  return { x: a + dx * k, y: b + dy * k };
}

interface Cell {
  cx: number;
  cy: number;
  base: number;
  speed: number;
  phase: number;
}

export function StarfieldButton(props: StarfieldButtonProps) {
  const label = props.label ?? "STARFIELD";
  const padding = props.padding ?? "8px 14px";
  const rounded = props.rounded ?? 100;
  const fill = props.fill ?? "#0A0A0A";
  const textColor = props.textColor ?? "#FFFFFF";
  const font: CSSProperties = props.font ?? {
    fontFamily: "'DM Sans', sans-serif",
    fontWeight: 700,
    fontSize: 12,
    lineHeight: "1.5em",
  };

  const border: BorderSpec = props.border ?? {
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "rgba(255,255,255,0.14)",
  };
  const glowColor = props.glowColor ?? "#FC731C";
  const glowSize = props.glowSize ?? 12;
  const glowOpacity = props.glowOpacity ?? 100;

  const lightColor = props.lightColor ?? "#FC731C";
  const speedPct = props.speed ?? 50;
  const direction = props.direction ?? "ccw";
  const movement = props.movement ?? "continuous";

  const pixelColor = props.pixelColor ?? "#FC731C";
  const pixelSize = props.pixelSize ?? 4;
  const pixelDensity = props.pixelDensity ?? 50;
  const pixelBrightness = props.pixelBrightness ?? 100;

  const buttonRef = useRef<HTMLButtonElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef<HTMLDivElement>(null);
  const faceRef = useRef<HTMLSpanElement>(null);
  const innerGlowRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lightsRef = useRef<(HTMLDivElement | null)[]>([]);

  const band = bandWidthsOf(border);
  const bandPadding = `${band.top}px ${band.right}px ${band.bottom}px ${band.left}px`;
  const bandMax = Math.max(band.top, band.right, band.bottom, band.left);

  const glowAlpha = Math.max(0, Math.min(100, glowOpacity)) / 100;
  const glowAlphaRef = useRef(glowAlpha);
  glowAlphaRef.current = glowAlpha;

  const lightCount = Math.max(1, Math.min(12, Math.round(props.lightCount ?? 1)));
  const lightPx = Math.max(4, Math.round(props.lightSize ?? 96));
  const lightThick = Math.max(1, Math.min(MAX_BAND_WIDTH, Math.round(props.lightThickness ?? 2)));
  const ringInset = bandMax / 2 - lightThick / 2;
  const glowPx = Math.max(1, Math.round(glowSize));
  const glowRimPx = Math.max(1, Math.round(glowPx * 0.18));
  const glowBlurPx = Math.max(1, Math.round(glowPx * 0.5));

  const speed = 2 * (Math.max(0, Math.min(100, Math.round(speedPct))) / 50);

  const geom = useRef({ w: 0, h: 0, radius: 0 });
  const reveal = useRef(0);
  const revealTarget = useRef(0);
  const size = useRef({ w: 1, h: 1, dpr: 1 });
  const city = useRef<{ cols: number; rows: number; dens: number; cells: Cell[] }>({
    cols: 0, rows: 0, dens: -1, cells: [],
  });

  const cfgRef = useRef({
    pixelColor, pixelSize, pixelDensity, pixelBrightness,
    lightCount, bandMax, ringInset, movement, direction,
    turnsPerSec: Math.max(0, speed) / SECONDS_AT_SPEED_1,
  });
  cfgRef.current = {
    pixelColor, pixelSize, pixelDensity, pixelBrightness,
    lightCount, bandMax, ringInset, movement, direction,
    turnsPerSec: Math.max(0, speed) / SECONDS_AT_SPEED_1,
  };

  // Radius has to be measured, so it is applied imperatively after layout and
  // re-applied on resize. The face and its glow get an *inner* radius, inset by
  // each border width, so the band keeps an even thickness around the curve.
  useLayoutEffect(() => {
    const el = buttonRef.current;
    if (!el) return;

    const applyRadius = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      if (!w || !h) return;
      const radius = radiusFromPercent(w, h, rounded);
      geom.current = { w, h, radius };
      el.style.borderRadius = `${radius}px`;
      if (trackRef.current) trackRef.current.style.borderRadius = `${radius}px`;
      if (bandRef.current) bandRef.current.style.borderRadius = `${Math.max(0, radius - ringInset)}px`;
      if (faceRef.current) {
        const inset = (v: number) => Math.max(0, radius - v);
        const x = [inset(band.left), inset(band.right), inset(band.right), inset(band.left)];
        const y = [inset(band.top), inset(band.top), inset(band.bottom), inset(band.bottom)];
        const innerRadius = `${x.map((v) => `${v}px`).join(" ")} / ${y.map((v) => `${v}px`).join(" ")}`;
        faceRef.current.style.borderRadius = innerRadius;
        if (innerGlowRef.current) innerGlowRef.current.style.borderRadius = innerRadius;
      }
    };

    applyRadius();
    const ro = new ResizeObserver(applyRadius);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rounded, ringInset, band.top, band.right, band.bottom, band.left]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const face = faceRef.current;
    if (!canvas || !face) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const buildCity = (w: number, h: number, cell: number) => {
      const c = Math.max(4, Math.round(cell));
      const cols = Math.max(1, Math.floor(w / c));
      const rows = Math.max(1, Math.floor(h / c));
      const dens = Math.max(0, Math.min(1, cfgRef.current.pixelDensity / 100));
      const cur = city.current;
      if (cols === cur.cols && rows === cur.rows && dens === cur.dens && cur.cells.length) return;

      const offX = (w - cols * c) / 2;
      const offY = (h - rows * c) / 2;
      const cells: Cell[] = [];
      for (let r = 0; r < rows; r++) {
        for (let col = 0; col < cols; col++) {
          const i = r * cols + col;
          const lit = rnd(i, 1) < dens;
          cells.push({
            cx: offX + col * c + c / 2,
            cy: offY + r * c + c / 2,
            base: lit ? 0.5 + rnd(i, 2) * 0.5 : 0.05 + rnd(i, 3) * 0.18,
            speed: 0.6 + rnd(i, 4) * 2.4,
            phase: rnd(i, 5) * Math.PI * 2,
          });
        }
      }
      city.current = { cols, rows, dens, cells };
    };

    const draw = () => {
      const s = size.current;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.clearRect(0, 0, s.w, s.h);
      const rv = reveal.current;
      if (rv < 0.001) return;

      const cfg = cfgRef.current;
      buildCity(s.w, s.h, cfg.pixelSize);
      const cells = city.current.cells;
      const c = Math.max(4, Math.round(cfg.pixelSize));
      const dot = Math.max(1, Math.round(c * 0.62));
      const off = dot / 2;
      const t = performance.now() / 1000;
      const cx = s.w / 2;
      const cy = s.h / 2;
      const maxD = Math.hypot(cx, cy) || 1;
      const lightMul = Math.max(0, cfg.pixelBrightness) / 100;

      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = cfg.pixelColor;
      for (const p of cells) {
        const tw = 0.55 + 0.45 * Math.sin(t * p.speed + p.phase);
        const d = Math.hypot(p.cx - cx, p.cy - cy) / maxD;
        const centerBias = 0.55 + 0.45 * (1 - d);
        let a = p.base * tw * centerBias * rv * lightMul;
        if (a <= 0.002) continue;
        if (a > 1) a = 1;
        ctx.globalAlpha = a;
        ctx.fillRect(p.cx - off, p.cy - off, dot, dot);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    };

    const placeLights = (elapsedSec: number) => {
      const g = geom.current;
      if (!g.w || !g.h) return;
      const cfg = cfgRef.current;
      const half = cfg.bandMax / 2;
      const pw = Math.max(0, g.w - cfg.bandMax);
      const ph = Math.max(0, g.h - cfg.bandMax);
      const pr = Math.max(0, g.radius - half);
      const dir = cfg.direction === "cw" ? 1 : -1;
      const base = elapsedSec * cfg.turnsPerSec * dir;

      for (let i = 0; i < cfg.lightCount; i++) {
        const el = lightsRef.current[i];
        if (!el) continue;
        const t = ((((base + i / cfg.lightCount) % 1) + 1) % 1);
        const p =
          cfg.movement === "step"
            ? pointOnRoundRectAngular(t, pw, ph, pr)
            : pointOnRoundRect(t, pw, ph, pr);
        el.style.transform =
          `translate3d(${p.x + half - cfg.ringInset}px, ${p.y + half - cfg.ringInset}px, 0)`;
      }
    };

    const applySize = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      size.current = { w, h, dpr };
      canvas.width = Math.max(1, Math.floor(w * dpr));
      canvas.height = Math.max(1, Math.floor(h * dpr));
    };

    const ro = new ResizeObserver(() => {
      applySize(face.clientWidth, face.clientHeight);
      placeLights(performance.now() / 1000);
    });
    ro.observe(face);
    applySize(face.clientWidth, face.clientHeight);
    placeLights(performance.now() / 1000);

    let inView = true;
    const io = new IntersectionObserver(
      ([e]) => { inView = e?.isIntersecting ?? true; },
      { threshold: 0.01 },
    );
    io.observe(face);

    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!inView) return;
      // Eased hover progress — approach the target rather than tween per gesture.
      reveal.current += (revealTarget.current - reveal.current) * 0.14;
      if (Math.abs(revealTarget.current - reveal.current) < 0.001) {
        reveal.current = revealTarget.current;
      }
      if (innerGlowRef.current) {
        innerGlowRef.current.style.opacity = String(reveal.current * glowAlphaRef.current);
      }
      draw();
      placeLights(performance.now() / 1000);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, []);

  const lightRGB = parseColor(lightColor);
  const scaleTo = (s: number) => {
    if (buttonRef.current) buttonRef.current.style.transform = `scale(${s})`;
  };

  return (
    <div
      style={{
        position: "relative",
        display: "inline-grid",
        placeItems: "stretch",
        overflow: "visible",
        ...props.style,
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => {
          sfx("wallet.connect");
          props.onClick?.(e);
        }}
        aria-label={label || undefined}
        onPointerEnter={() => { sfx("ui.hover"); revealTarget.current = 1; }}
        onPointerLeave={() => { revealTarget.current = 0; scaleTo(1); }}
        onPointerDown={() => scaleTo(0.97)}
        onPointerUp={() => scaleTo(1)}
        style={{
          boxSizing: "border-box",
          position: "relative",
          padding: bandPadding,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          userSelect: "none",
          textDecoration: "none",
          overflow: "visible",
          transition: "transform .16s ease",
        }}
      >
        {/* Static border band. */}
        <div
          aria-hidden
          ref={trackRef}
          style={{
            position: "absolute",
            inset: 0,
            boxSizing: "border-box",
            padding: bandPadding,
            background: border.borderColor ?? "transparent",
            zIndex: 0,
            pointerEvents: "none",
            ...BAND_MASK,
          }}
        />
        {/* Travelling lights, clipped to a thin ring inside the band. */}
        <div
          aria-hidden
          ref={bandRef}
          style={{
            position: "absolute",
            top: ringInset,
            right: ringInset,
            bottom: ringInset,
            left: ringInset,
            boxSizing: "border-box",
            padding: lightThick,
            zIndex: 0,
            pointerEvents: "none",
            ...BAND_MASK,
          }}
        >
          {Array.from({ length: lightCount }, (_, i) => (
            <div
              key={i}
              ref={(el) => { lightsRef.current[i] = el; }}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: lightPx,
                height: lightPx,
                marginTop: -lightPx / 2,
                marginLeft: -lightPx / 2,
                pointerEvents: "none",
                background: `radial-gradient(circle, ${lightColor} 0%, ${lightColor} 30%, ${rgba(lightRGB, 0)} 72%)`,
              }}
            />
          ))}
        </div>

        <span
          ref={faceRef}
          style={{
            position: "relative",
            zIndex: 1,
            boxSizing: "border-box",
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding,
            whiteSpace: "nowrap",
            background: fill,
            overflow: "hidden",
          }}
        >
          <canvas
            ref={canvasRef}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 0,
              width: "100%",
              height: "100%",
              pointerEvents: "none",
            }}
          />
          <span
            ref={innerGlowRef}
            aria-hidden
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 1,
              border: `${glowRimPx}px solid ${glowColor}`,
              filter: `blur(${glowBlurPx}px)`,
              opacity: 0,
              pointerEvents: "none",
              maskImage: "linear-gradient(#000 0 0)",
              maskClip: "border-box",
              WebkitMaskImage: "linear-gradient(#000 0 0)",
              WebkitMaskClip: "border-box",
            }}
          />
          <span style={{ position: "relative", zIndex: 2, color: textColor, ...font }}>{label}</span>
        </span>
      </button>
    </div>
  );
}

export default StarfieldButton;
