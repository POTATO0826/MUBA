import { renderAscii, type AsciiImageSpec, type Shape } from "../engine/asciiImage.ts";

/**
 * One picture per reward case, rasterised to ASCII by `renderAscii`. Shapes
 * live in a 48 × 31.5 square-pixel space (48 columns, 18 rows × 1.75 cell
 * aspect); the centre is (24, 15.75).
 */

const W = 48;
const H = 18;
const CX = 24;
const CY = 15.75;

const spec = (shapes: readonly Shape[], grain = 0.1): AsciiImageSpec => ({ w: W, h: H, shapes, grain });

/** Ethereum diamond: upper octahedron with a darker right facet, smaller base below. */
const ETH_VOL_BOX = spec([
  { kind: "circle", cx: CX, cy: CY, r: 15, lum: 0.16, shade: "sphere" },
  { kind: "poly", pts: [[24, 1.5], [36, 17], [24, 23.5], [12, 17]], lum: 0.95 },
  { kind: "poly", pts: [[24, 1.5], [36, 17], [24, 23.5]], lum: 0.6 },
  { kind: "poly", pts: [[24, 9.5], [30, 17], [24, 21.5], [18, 17]], lum: 0.4 },
  { kind: "poly", pts: [[24, 9.5], [30, 17], [24, 21.5]], lum: 0.28 },
  { kind: "poly", pts: [[12, 19.5], [24, 30], [36, 19.5], [24, 26]], lum: 0.82 },
  { kind: "poly", pts: [[24, 26], [36, 19.5], [24, 30]], lum: 0.48 },
]);

/** A Bitcoin coin with two dark range lines cut across it. */
const BTC_RANGER = spec([
  { kind: "circle", cx: CX, cy: CY, r: 13.5, lum: 0.95, shade: "sphere" },
  { kind: "ring", cx: CX, cy: CY, r: 11.5, width: 0.9, lum: 0.3 },
  { kind: "rect", x: 6, y: 10.2, w: 36, h: 1.1, lum: 0.08, shade: "none" },
  { kind: "rect", x: 6, y: 21.3, w: 36, h: 1.1, lum: 0.08, shade: "none" },
  { kind: "poly", pts: [[19, 12.5], [29, 12.5], [29, 19], [19, 19]], lum: 0.55, shade: "none" },
  { kind: "poly", pts: [[20.5, 13.5], [24, 13.5], [24, 18], [20.5, 18]], lum: 0.95, shade: "none" },
  { kind: "poly", pts: [[25, 13.5], [27.6, 13.5], [27.6, 18], [25, 18]], lum: 0.95, shade: "none" },
]);

/** Concentric target with cardinal ticks. */
const SKEW_HUNTER = spec([
  { kind: "circle", cx: CX, cy: CY, r: 14, lum: 0.9 },
  { kind: "circle", cx: CX, cy: CY, r: 11.2, lum: 0.12, shade: "none" },
  { kind: "circle", cx: CX, cy: CY, r: 8.4, lum: 0.9 },
  { kind: "circle", cx: CX, cy: CY, r: 5.6, lum: 0.12, shade: "none" },
  { kind: "circle", cx: CX, cy: CY, r: 2.8, lum: 1, shade: "none" },
  { kind: "rect", x: 23.4, y: 0.2, w: 1.2, h: 3.2, lum: 0.75, shade: "none" },
  { kind: "rect", x: 23.4, y: 28.1, w: 1.2, h: 3.2, lum: 0.75, shade: "none" },
  { kind: "rect", x: 5, y: 15.1, w: 4, h: 1.3, lum: 0.75, shade: "none" },
  { kind: "rect", x: 39, y: 15.1, w: 4, h: 1.3, lum: 0.75, shade: "none" },
]);

/** Hourglass: theta running out. */
const WEEKLY_GRIND = spec([
  { kind: "rect", x: 12, y: 1.5, w: 24, h: 1.8, lum: 0.85 },
  { kind: "rect", x: 12, y: 28.2, w: 24, h: 1.8, lum: 0.85 },
  { kind: "poly", pts: [[13.5, 3.5], [34.5, 3.5], [24.6, 15.5], [23.4, 15.5]], lum: 0.3 },
  { kind: "poly", pts: [[13.5, 28], [34.5, 28], [24.6, 16], [23.4, 16]], lum: 0.3 },
  { kind: "poly", pts: [[18.5, 8.5], [29.5, 8.5], [24, 15]], lum: 0.95 },
  { kind: "rect", x: 23.55, y: 15, w: 0.9, h: 7.5, lum: 0.95, shade: "none" },
  { kind: "poly", pts: [[15.5, 27.5], [32.5, 27.5], [24, 21.5]], lum: 0.95 },
]);

/** Lightning bolt with a soft glow behind it. */
const GAMMA_SPRINT = spec([
  { kind: "circle", cx: CX, cy: CY, r: 15, lum: 0.22, shade: "sphere" },
  {
    kind: "poly",
    pts: [[28, 1], [13.5, 17.5], [22.5, 17.5], [19, 30.5], [34.5, 12.5], [26, 12.5], [31, 1]],
    lum: 1,
  },
  { kind: "poly", pts: [[28, 1], [22.5, 17.5], [26, 12.5]], lum: 0.7 },
  { kind: "poly", pts: [[22.5, 17.5], [19, 30.5], [27, 17.5]], lum: 0.7 },
]);

/** Shield with a keyhole. */
const DOWNSIDE_VAULT = spec([
  { kind: "poly", pts: [[24, 1.5], [39, 6], [39, 16], [24, 30.5], [9, 16], [9, 6]], lum: 0.9 },
  { kind: "poly", pts: [[24, 4], [36.5, 7.8], [36.5, 15.2], [24, 27.5], [11.5, 15.2], [11.5, 7.8]], lum: 0.55 },
  { kind: "poly", pts: [[24, 1.5], [39, 6], [39, 16], [24, 30.5]], lum: 0.72 },
  { kind: "poly", pts: [[24, 4], [36.5, 7.8], [36.5, 15.2], [24, 27.5]], lum: 0.42 },
  { kind: "circle", cx: 24, cy: 12.5, r: 3, lum: 0.06, shade: "none" },
  { kind: "poly", pts: [[22.7, 13.5], [25.3, 13.5], [26.2, 21], [21.8, 21]], lum: 0.06, shade: "none" },
]);

/** Two coins, one bright and one dark, overlapping. */
const DUAL_ASSET = spec([
  { kind: "circle", cx: 17, cy: CY, r: 11, lum: 0.95, shade: "sphere" },
  { kind: "ring", cx: 17, cy: CY, r: 9.4, width: 0.8, lum: 0.35 },
  { kind: "circle", cx: 31, cy: CY, r: 11, lum: 0.55, shade: "sphere" },
  { kind: "ring", cx: 31, cy: CY, r: 9.4, width: 0.8, lum: 0.2 },
  { kind: "poly", pts: [[26, 9], [30, 9], [30, 22], [26, 22]], lum: 0.14, shade: "none" },
  { kind: "poly", pts: [[26, 12], [29, 12], [29, 19], [26, 19]], lum: 0.55, shade: "none" },
]);

/** Whale silhouette, water line under it. */
const WHALE_BOX = spec([
  { kind: "ellipse", cx: 22, cy: 17, rx: 15, ry: 7, lum: 0.85, shade: "sphere" },
  { kind: "circle", cx: 10.5, cy: 15.5, r: 6.8, lum: 0.85, shade: "sphere" },
  { kind: "poly", pts: [[34, 15.5], [45, 8.5], [42.5, 17], [46.5, 24], [35.5, 19.5]], lum: 0.75 },
  { kind: "ellipse", cx: 21, cy: 20.8, rx: 12, ry: 2.2, lum: 0.92, shade: "sphere" },
  { kind: "circle", cx: 9, cy: 14, r: 1, lum: 0.04, shade: "none" },
  { kind: "circle", cx: 11.5, cy: 7, r: 1.1, lum: 0.5, shade: "none" },
  { kind: "circle", cx: 9.5, cy: 4.5, r: 0.8, lum: 0.4, shade: "none" },
  { kind: "rect", x: 0, y: 26.5, w: 48, h: 0.9, lum: 0.45, shade: "none" },
  { kind: "rect", x: 3, y: 29, w: 42, h: 0.7, lum: 0.28, shade: "none" },
]);

const SPECS: Record<string, AsciiImageSpec> = {
  "ETH Vol Box": ETH_VOL_BOX,
  "BTC Ranger": BTC_RANGER,
  "Skew Hunter": SKEW_HUNTER,
  "Weekly Grind": WEEKLY_GRIND,
  "Gamma Sprint": GAMMA_SPRINT,
  "Downside Vault": DOWNSIDE_VAULT,
  "Dual Asset": DUAL_ASSET,
  "Whale Box": WHALE_BOX,
};

/** Rendered picture for a case, or null when it has none. */
export function caseArt(name: string): string | null {
  const s = SPECS[name];
  return s ? renderAscii(s) : null;
}

export const CASE_ART_NAMES = Object.keys(SPECS);
