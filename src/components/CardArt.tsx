import type { ReactNode } from "react";
import { seededRandom } from "../engine/spin.ts";
import { sx } from "../lib/sx.ts";

/**
 * Artwork for a lobby card: one of eight minimal generative patterns in the
 * manner of bookofshapes.com, drawn in the market colour, seeded by the lobby
 * id, and animated. Pure SVG — no asset, no network — so every card has its
 * own picture, the same picture every time, and it moves.
 *
 * Motion is SMIL (`<animate>` / `<animateTransform>`) where a shape morphs or
 * turns, and a CSS dash-offset keyframe where a line should read as flowing.
 * `prefers-reduced-motion` stills the CSS half from `styles.css`.
 */

/**
 * A small string hash, so an id becomes a seed. FNV-1a, then murmur3's final
 * mix: FNV alone leaves its low bits weak, and on ids sharing a suffix a plain
 * `% 8` handed several lobbies the same pattern. The mix spreads every input
 * bit across the word, so the remainder is fair.
 */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Salts the pattern choice so the six lobbies on the board each get a
 *  different one. Chosen by search; any created lobby is still a fair draw. */
const PATTERN_SALT = "#11";

const W = 320;
const H = 180;

type Rand = () => number;
type Pattern = (r: Rand, seed: number, color: string) => ReactNode;

const f1 = (n: number) => n.toFixed(1);

// ---------- Joy Division ----------
// Stacked ridge lines, each occluding the one above; the ridge breathes.

function joyDivision(r: Rand, _seed: number, color: string): ReactNode {
  const rows = 15;
  const cx = W * (0.4 + r() * 0.25);
  const rowPath = (i: number, jitter: Rand) => {
    const y0 = 24 + (i * (H - 34)) / rows;
    const pts: string[] = [];
    for (let x = 0; x <= W; x += 8) {
      const env = Math.exp(-(((x - cx) / (W * 0.2)) ** 2));
      const bump = env * (14 + jitter() * 26) * (0.6 + i / rows);
      const grain = (jitter() - 0.5) * 2.2;
      pts.push(`${x},${f1(y0 - bump + grain)}`);
    }
    return `M${pts.join("L")}L${W},${H}L0,${H}Z`;
  };
  const a = seededRandom(hash("a") ^ _seed);
  const b = seededRandom(hash("b") ^ _seed);
  return Array.from({ length: rows }, (_, i) => {
    const dA = rowPath(i, a);
    const dB = rowPath(i, b);
    return (
      <path key={i} d={dA} fill="#0c0c0e" fillOpacity="0.92" stroke={color} strokeWidth="1.1" strokeOpacity={0.35 + (i / rows) * 0.5}>
        <animate attributeName="d" values={`${dA};${dB};${dA}`} dur={`${7 + i * 0.35}s`} repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" />
      </path>
    );
  });
}

// ---------- Concentric Noise Rings ----------
// Rings with a wobble that grows outward, each turning at its own pace.

function noiseRings(r: Rand, _seed: number, color: string): ReactNode {
  const cx = W * 0.68;
  const cy = H * 0.5;
  const rings = 9;
  return Array.from({ length: rings }, (_, i) => {
    const base = 12 + i * 10.5;
    const k = 3 + Math.floor(r() * 4);
    const phase = r() * Math.PI * 2;
    const amp = 1.5 + i * 0.7;
    const pts: string[] = [];
    for (let s = 0; s < 72; s++) {
      const th = (s / 72) * Math.PI * 2;
      const rad = base + Math.sin(k * th + phase) * amp + (r() - 0.5) * 0.8;
      pts.push(`${f1(cx + Math.cos(th) * rad)},${f1(cy + Math.sin(th) * rad)}`);
    }
    return (
      <path key={i} d={`M${pts.join("L")}Z`} fill="none" stroke={color} strokeWidth="1" strokeOpacity={0.22 + (i / rings) * 0.5}>
        <animateTransform attributeName="transform" type="rotate" from={`0 ${cx} ${cy}`} to={`${i % 2 ? 360 : -360} ${cx} ${cy}`} dur={`${36 + i * 7}s`} repeatCount="indefinite" />
      </path>
    );
  });
}

// ---------- Flow Lines ----------
// Streamlines through a seeded vector field; the dashes run along them.

function flowLines(r: Rand, _seed: number, color: string): ReactNode {
  const s1 = r() * 10;
  const s2 = r() * 10;
  const angle = (x: number, y: number) => Math.sin(x * 0.018 + s1) * Math.cos(y * 0.024 + s2) * Math.PI;
  return Array.from({ length: 64 }, (_, i) => {
    let x = r() * W;
    let y = r() * H;
    const pts: string[] = [`${f1(x)},${f1(y)}`];
    for (let k = 0; k < 26; k++) {
      const a = angle(x, y);
      x += Math.cos(a) * 4.5;
      y += Math.sin(a) * 4.5;
      pts.push(`${f1(x)},${f1(y)}`);
    }
    const dur = 3.5 + r() * 4;
    return (
      <path
        key={i}
        d={`M${pts.join("L")}`}
        fill="none"
        stroke={color}
        strokeWidth="1"
        strokeLinecap="round"
        strokeOpacity={0.3 + r() * 0.45}
        style={sx(`stroke-dasharray:22 160;animation:vcFlow ${f1(dur)}s linear infinite;animation-delay:-${f1(r() * dur)}s`)}
      />
    );
  });
}

// ---------- Lissajous Field ----------
// A grid of small lissajous figures, each slowly turning.

function lissajousField(r: Rand, _seed: number, color: string): ReactNode {
  const cols = 7;
  const rows = 4;
  const cw = W / cols;
  const ch = H / rows;
  const out: ReactNode[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const a = 1 + Math.floor(r() * 3);
      const b = 1 + Math.floor(r() * 3);
      const ph = r() * Math.PI;
      const cx = cw * (i + 0.5);
      const cy = ch * (j + 0.5);
      const rx = cw * 0.34;
      const ry = ch * 0.34;
      const pts: string[] = [];
      for (let s = 0; s <= 96; s++) {
        const t = (s / 96) * Math.PI * 2;
        pts.push(`${f1(cx + Math.sin(a * t + ph) * rx)},${f1(cy + Math.sin(b * t) * ry)}`);
      }
      out.push(
        <path key={`${i}-${j}`} d={`M${pts.join("L")}`} fill="none" stroke={color} strokeWidth="0.9" strokeOpacity={0.3 + r() * 0.4}>
          <animateTransform attributeName="transform" type="rotate" from={`0 ${f1(cx)} ${f1(cy)}`} to={`${r() > 0.5 ? 360 : -360} ${f1(cx)} ${f1(cy)}`} dur={`${14 + r() * 16}s`} repeatCount="indefinite" />
        </path>,
      );
    }
  }
  return out;
}

// ---------- Phyllotaxis Bloom ----------
// The sunflower spiral, turning as one.

function phyllotaxis(r: Rand, _seed: number, color: string): ReactNode {
  const cx = W * (0.62 + r() * 0.16);
  const cy = H * 0.55;
  const n = 230;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const spread = 5.2 + r() * 1.2;
  return (
    <g>
      {Array.from({ length: n }, (_, i) => {
        const th = i * golden;
        const rad = spread * Math.sqrt(i);
        const x = cx + Math.cos(th) * rad;
        const y = cy + Math.sin(th) * rad;
        const size = 0.9 + ((i * 7) % 11) / 6;
        return <circle key={i} cx={f1(x)} cy={f1(y)} r={f1(size)} fill={color} fillOpacity={Math.max(0.08, 0.7 - rad / 190)} />;
      })}
      <animateTransform attributeName="transform" type="rotate" from={`0 ${f1(cx)} ${f1(cy)}`} to={`360 ${f1(cx)} ${f1(cy)}`} dur="80s" repeatCount="indefinite" />
    </g>
  );
}

// ---------- Halftone Sphere ----------
// A dot grid whose dots swell into a lit sphere; the sphere drifts.

function halftoneSphere(r: Rand, _seed: number, color: string): ReactNode {
  const step = 10;
  const cx = W * (0.58 + r() * 0.2);
  const cy = H * 0.5;
  const R = 62 + r() * 12;
  const lx = -0.6;
  const ly = -0.7;
  const dots: ReactNode[] = [];
  const field: ReactNode[] = [];
  for (let x = step / 2; x < W; x += step) {
    for (let y = step / 2; y < H; y += step) {
      const dx = (x - cx) / R;
      const dy = (y - cy) / R;
      const d2 = dx * dx + dy * dy;
      if (d2 <= 1) {
        const nz = Math.sqrt(1 - d2);
        const light = Math.max(0, dx * lx + dy * ly + nz * 0.75);
        dots.push(<circle key={`s${x}-${y}`} cx={x} cy={y} r={f1(0.6 + light * 3.4)} fill={color} fillOpacity="0.85" />);
      } else {
        field.push(<circle key={`f${x}-${y}`} cx={x} cy={y} r="0.8" fill={color} fillOpacity="0.14" />);
      }
    }
  }
  return (
    <g>
      {field}
      <g>
        {dots}
        <animateTransform attributeName="transform" type="translate" values="0 0;9 -6;-4 5;0 0" dur="14s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1;0.4 0 0.6 1" />
      </g>
    </g>
  );
}

// ---------- Isometric Cubes ----------
// A field of iso cubes of seeded height, each pulsing on its own clock.

function isoCubes(r: Rand, _seed: number, color: string): ReactNode {
  const s = 13;
  const out: ReactNode[] = [];
  const hw = s * Math.cos(Math.PI / 6);
  const hh = s * 0.5;
  for (let row = -1; row < 9; row++) {
    for (let col = -1; col < 11; col++) {
      const ox = col * hw * 2 + (row % 2 ? hw : 0) + 10;
      const oy = row * (hh * 3) + 6;
      const h = s * (0.6 + Math.floor(r() * 3) * 0.55);
      const top = `${f1(ox)},${f1(oy)} ${f1(ox + hw)},${f1(oy + hh)} ${f1(ox)},${f1(oy + hh * 2)} ${f1(ox - hw)},${f1(oy + hh)}`;
      const left = `${f1(ox - hw)},${f1(oy + hh)} ${f1(ox)},${f1(oy + hh * 2)} ${f1(ox)},${f1(oy + hh * 2 + h)} ${f1(ox - hw)},${f1(oy + hh + h)}`;
      const right = `${f1(ox)},${f1(oy + hh * 2)} ${f1(ox + hw)},${f1(oy + hh)} ${f1(ox + hw)},${f1(oy + hh + h)} ${f1(ox)},${f1(oy + hh * 2 + h)}`;
      out.push(
        <g key={`${row}-${col}`} opacity={0.5}>
          <polygon points={top} fill={color} fillOpacity="0.32" stroke={color} strokeOpacity="0.5" strokeWidth="0.6" />
          <polygon points={left} fill={color} fillOpacity="0.14" stroke={color} strokeOpacity="0.35" strokeWidth="0.6" />
          <polygon points={right} fill={color} fillOpacity="0.06" stroke={color} strokeOpacity="0.3" strokeWidth="0.6" />
          <animate attributeName="opacity" values="0.35;1;0.35" dur={`${4 + r() * 4}s`} begin={`-${f1(r() * 6)}s`} repeatCount="indefinite" />
        </g>,
      );
    }
  }
  return out;
}

// ---------- Chaos Circles ----------
// Overlapping rings, each breathing at a different rate.

function chaosCircles(r: Rand, _seed: number, color: string): ReactNode {
  return Array.from({ length: 28 }, (_, i) => {
    const cx = r() * W;
    const cy = r() * H;
    const rad = 6 + r() * 44;
    const dur = 5 + r() * 7;
    return (
      <circle key={i} cx={f1(cx)} cy={f1(cy)} r={f1(rad)} fill="none" stroke={color} strokeWidth={f1(0.6 + r() * 1.2)} strokeOpacity={0.18 + r() * 0.5}>
        <animate attributeName="r" values={`${f1(rad)};${f1(rad * 1.18)};${f1(rad)}`} dur={`${f1(dur)}s`} begin={`-${f1(r() * dur)}s`} repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1" />
      </circle>
    );
  });
}

export const PATTERNS: readonly { name: string; draw: Pattern }[] = [
  { name: "joy-division", draw: joyDivision },
  { name: "noise-rings", draw: noiseRings },
  { name: "flow-lines", draw: flowLines },
  { name: "lissajous-field", draw: lissajousField },
  { name: "phyllotaxis-bloom", draw: phyllotaxis },
  { name: "halftone-sphere", draw: halftoneSphere },
  { name: "isometric-cubes", draw: isoCubes },
  { name: "chaos-circles", draw: chaosCircles },
];

/** Which pattern a lobby gets. A function of the id, so it never changes. */
export function patternFor(id: string) {
  return PATTERNS[hash(id + PATTERN_SALT) % PATTERNS.length]!;
}

export function CardArt({ id, color }: { id: string; color: string }) {
  const seed = hash(id);
  const pattern = patternFor(id);
  const shapes = pattern.draw(seededRandom(seed), seed, color);

  return (
    <div data-art={id} data-pattern={pattern.name} aria-hidden style={sx("position:absolute;inset:0;overflow:hidden;pointer-events:none")}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice" style={sx("position:absolute;inset:0;width:100%;height:100%;display:block")}>
        {shapes}
      </svg>
      {/* Keep the top-left readable: the host and the badges sit there. */}
      <div style={sx("position:absolute;inset:0;background:linear-gradient(180deg,rgba(9,9,11,.6) 0%,rgba(9,9,11,.12) 40%,rgba(9,9,11,.78) 100%)")} />
    </div>
  );
}
