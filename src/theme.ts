/** Palette and style builders lifted from the design source. */

export const MONO = "'JetBrains Mono',monospace";
export const SANS = "'DM Sans',sans-serif";

export const C = {
  bg: "#09090b",
  panel: "#0b0b0d",
  panelAlt: "#0d0d10",
  card: "#0f0f11",
  cardAlt: "#101013",
  raised: "#131316",
  line: "#1c1c20",
  lineSoft: "#1a1a1e",
  border: "#27272a",
  borderMid: "#3f3f46",
  text: "#fafafa",
  textSoft: "#d4d4d8",
  muted: "#a1a1aa",
  dim: "#71717a",
  faint: "#52525b",
  accent: "#c8ff00",
  green: "#4ade80",
  red: "#f87171",
  blue: "#38bdf8",
  violet: "#a78bfa",
  indigo: "#6366f1",
  amber: "#f59e0b",
} as const;

export const SEC_COLOR: Record<string, string> = {
  SEMIS: C.green,
  TECH: C.blue,
  AUTO: "#f472b6",
  ENERGY: C.amber,
  FIN: C.violet,
  METALS: "#fbbf24",
  "EQUITY-BETA": C.accent,
  L1: C.accent,
  L2: C.blue,
  ORACLE: "#2dd4bf",
  DEFI: C.violet,
  MEME: "#f472b6",
};

export const sectorColor = (sector: string): string => SEC_COLOR[sector] ?? C.muted;

/** Header nav button. */
export const tabBtn = (active: boolean): string =>
  `height:32px;padding:0 13px;border:none;border-radius:8px;cursor:pointer;font:${
    active ? "700" : "500"
  } 12.5px/1 ${SANS};` +
  (active ? `background:#1f1f23;color:${C.text}` : `background:transparent;color:${C.muted}`);

/** Small rounded filter chip. */
export const pill = (active: boolean): string =>
  `height:26px;padding:0 10px;border-radius:99px;cursor:pointer;font:500 11px/1 ${MONO};border:1px solid ` +
  (active
    ? `rgba(200,255,0,.4);background:rgba(200,255,0,.12);color:${C.accent}`
    : `${C.border};background:transparent;color:${C.muted}`);

/** Parallax backdrop behind a case card. */
export const wall = (a: string, b: string, deg: number): string =>
  `position:absolute;inset:-10%;background:linear-gradient(${deg}deg,${a} 0%,#0d0d0f 62%),` +
  `radial-gradient(60% 55% at 70% 22%,${b},transparent 70%);transition:transform .2s cubic-bezier(.2,.8,.2,1)`;

/** Monospace category tag, tinted to `color`. */
export const tag = (color: string): string =>
  `display:inline-flex;align-items:center;font:500 9px/1 ${MONO};letter-spacing:.12em;` +
  `padding:6px 8px;border-radius:6px;border:1px solid ${color}55;background:${color}1f;color:${color}`;

/** Tighter monospace tag for sector / mode chips. */
export const miniTag = (color: string): string =>
  `font:700 8.5px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:5px;` +
  `border:1px solid ${color}4d;background:${color}1a;color:${color}`;

export const avatarStyle = (bg: string, size = 26): string =>
  `width:${size}px;height:${size}px;border-radius:8px;background:${bg};display:grid;place-items:center;` +
  `font:700 10px/1 ${SANS};color:${C.bg}`;

export const chipStyle = (color: string): string =>
  `flex:none;font:500 10px/1 ${MONO};padding:6px 8px;border-radius:6px;border:1px solid ${C.border};` +
  `background:${C.raised};color:${color}`;
