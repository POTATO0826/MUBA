/**
 * A very small software rasterizer that turns shaded vector shapes into
 * image-like ASCII: anti-aliased edges via supersampling, a top-left light
 * source, sphere shading on discs, and a luminance ramp for the characters.
 *
 * Shapes are defined in a "square pixel" space `W × H*ASPECT`, where ASPECT is
 * the height/width ratio of one monospace cell, so a circle in shape space is a
 * circle on screen.
 */

export const ASPECT = 1.75;
const RAMP = " .:-=+*#%@";
const SS = 3; // supersamples per axis

type Shade = "flat" | "sphere" | "none";

export type Shape =
  | { kind: "circle"; cx: number; cy: number; r: number; lum: number; shade?: Shade }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; lum: number; shade?: Shade }
  | { kind: "ring"; cx: number; cy: number; r: number; width: number; lum: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number; lum: number; shade?: Shade }
  | { kind: "poly"; pts: readonly (readonly [number, number])[]; lum: number; shade?: Shade };

export interface AsciiImageSpec {
  /** Columns. */
  w: number;
  /** Rows. */
  h: number;
  /** Painter's order — later shapes cover earlier ones. */
  shapes: readonly Shape[];
  /** 0–1 film-grain intensity on the empty background. */
  grain?: number;
}

function inPoly(px: number, py: number, pts: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    const cross = yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (cross) inside = !inside;
  }
  return inside;
}

/** 1 inside the shape, 0 outside. */
function hit(s: Shape, x: number, y: number): boolean {
  switch (s.kind) {
    case "circle": {
      const dx = x - s.cx;
      const dy = y - s.cy;
      return dx * dx + dy * dy <= s.r * s.r;
    }
    case "ellipse": {
      const dx = (x - s.cx) / s.rx;
      const dy = (y - s.cy) / s.ry;
      return dx * dx + dy * dy <= 1;
    }
    case "ring": {
      const d = Math.hypot(x - s.cx, y - s.cy);
      return d <= s.r && d >= s.r - s.width;
    }
    case "rect":
      return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
    case "poly":
      return inPoly(x, y, s.pts);
  }
}

/** Luminance multiplier at a point: top-left light, sphere falloff on discs. */
function light(s: Shape, x: number, y: number, W: number, HA: number): number {
  const shade = "shade" in s ? (s.shade ?? "flat") : "flat";
  if (shade === "none") return 1;
  const g = 0.68 + 0.32 * (1 - Math.min(1, Math.max(0, (x / W) * 0.55 + (y / HA) * 0.45)));
  if (shade === "sphere" && (s.kind === "circle" || s.kind === "ellipse")) {
    const rx = s.kind === "circle" ? s.r : s.rx;
    const ry = s.kind === "circle" ? s.r : s.ry;
    // Highlight sits up and left of centre.
    const dx = (x - s.cx + rx * 0.35) / rx;
    const dy = (y - s.cy + ry * 0.35) / ry;
    const d = Math.min(1, Math.hypot(dx, dy));
    return g * (1 - 0.55 * d * d);
  }
  return g;
}

function grainAt(x: number, y: number): number {
  const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return v - Math.floor(v);
}

const cache = new Map<AsciiImageSpec, string>();

/** Render a spec to a multi-line string. Pure and memoised per spec object. */
export function renderAscii(spec: AsciiImageSpec): string {
  const hit0 = cache.get(spec);
  if (hit0) return hit0;

  const { w: W, h: H, shapes } = spec;
  const HA = H * ASPECT;
  const grain = spec.grain ?? 0.1;
  const rows: string[] = [];

  for (let row = 0; row < H; row++) {
    let line = "";
    for (let col = 0; col < W; col++) {
      let lum = 0;
      let covered = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = col + (sx + 0.5) / SS;
          const y = (row + (sy + 0.5) / SS) * ASPECT;
          let sample = -1;
          for (const s of shapes) {
            if (hit(s, x, y)) sample = s.lum * light(s, x, y, W, HA);
          }
          if (sample >= 0) {
            lum += sample;
            covered++;
          }
        }
      }
      let value: number;
      if (covered === 0) {
        value = grainAt(col, row) < grain ? 0.12 : 0;
      } else {
        // Uncovered subsamples read as dark, which is what anti-aliases the edge.
        value = lum / (SS * SS);
      }
      const idx = Math.max(0, Math.min(RAMP.length - 1, Math.round(value * (RAMP.length - 1))));
      line += RAMP[idx];
    }
    rows.push(line.replace(/\s+$/, ""));
  }

  const out = rows.join("\n");
  cache.set(spec, out);
  return out;
}
