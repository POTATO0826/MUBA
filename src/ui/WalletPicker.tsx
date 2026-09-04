import { useCallback, useEffect, useMemo, useState } from "react";
import { CatMascot } from "../components/CatMascot.tsx";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { InjectedWallet } from "../wallet/injected.ts";

/**
 * Which browser wallet to connect.
 *
 * Only shown when more than one extension announced itself — with a single
 * wallet installed there is nothing to choose and `connect()` goes straight to
 * its prompt.
 *
 * One cat lives at the top of this dialog. It springs in when the dialog opens,
 * breathes and leans for as long as the dialog is up, and on every wallet the
 * pointer arrives at it pops — recolouring to that wallet as it does. See
 * `CatSeat` for the seat and the choreography, the brand section for where a
 * wallet's colour comes from, and `styles.css` for the four keyframes.
 *
 * That is a deliberate replacement for what was here before: a sticker per row,
 * each springing out of its own row's corner. Six cats taking turns read as six
 * cats. One cat that changes colour reads as *the* cat, watching you shop —
 * which is the whole idea, and is also what the reference motion study does.
 *
 * Nothing in this dialog clips: the backdrop, the panel and the rows all keep
 * `overflow:visible`, and the cat deliberately overhangs the panel's top-right
 * corner. The hazard here was never clipping but *paint order* and the close
 * button — see `CAT_SEAT`.
 */

/** The mascot tile, in px — 34% of the panel's 360, which is the reference's
 *  proportion (its mascot is 163 of a 446px card). Every number in `CAT_SEAT`
 *  is derived from this one. */
const CAT = 124;

/**
 * The settled tilt, and the widest the tile ever gets.
 *
 * Three things move this tile after it lands, and the clearances in `CAT_SEAT`
 * are measured against all three at once:
 *
 * - `vcCatLean` runs the tilt from -10° *up* to -4°, never past -10°.
 * - `vcCatBreathe` runs the scale from 1 *down* to 0.965, never past 1.
 * - `vcCatPopA` runs the scale up to 1.14 on every hover — and past it, since
 *   `cubic-bezier(.34,1.56,.64,1)` overshoots between keyframes. That is why
 *   the swept peak lands at ~80ms rather than at the 34% keyframe.
 *
 * Both loops are deliberately one-sided so the pop owns the whole budget on its
 * own: the worst case is a pop at full breathe and full lean, which is the
 * sweep `CAT_SEAT` reports, and it is that box — not the resting one — the
 * close button and the first row are measured against. Had the lean and the
 * breathe been symmetric they would have compounded with the pop into a box
 * ~30px wider, which puts a popping cat into row one.
 */
const CAT_TILT = -10;

/** The tile's corner radius, at the same 27% of its edge the 88px sticker
 *  used. Load-bearing with the `overflow:hidden` below it: together they crop
 *  the cat's head and give the art its sticker framing. */
const CAT_RADIUS = 34;

/**
 * Where the cat sits, against the panel's padding box.
 *
 * Arithmetic, not taste, and taken from measured `getBoundingClientRect`s
 * rather than done on paper — a tilted tile's *bounding box* is what can
 * collide with chrome, and it is fatter than the tile's own rotated outline.
 * Paper got this wrong twice, in ways worth recording.
 *
 * The first: the seat rotates about `transform-origin:100% 100%`, not about its
 * centre. The origin belongs to the
 * launch — it is what makes the cat grow *out of* the panel's corner — but it
 * also means the tile pivots on its own bottom-right corner, which stays put
 * while everything else swings up and to the left. A seat computed for a
 * centred rotation puts the tile ~16px lower and ~6px further right than it
 * actually lands, and the first draft of these numbers duly had the cat's
 * bottom-left corner 4px into the first row.
 *
 * The second: `getBoundingClientRect` on the seat
 * measures the seat's *own* 124px box, and the pop and the breathe live on
 * descendants, whose overflow does not touch it. Every number below is read off
 * the innermost painting element, whose rect accumulates the whole nested
 * stack.
 *
 * And the whole thing is swept rather than reasoned about, because the pop's
 * curve overshoots between keyframes and its true peak is not where the
 * keyframe says. The rig pins every loop with `animation-play-state:paused` and
 * a negative `animation-delay` — a clock-free way to render an exact phase —
 * and walks the pop from 0 to 420ms with the breathe at its largest (scale 1)
 * and the lean at its most tilted (-10°), which is the worst combination
 * available. In the panel's 360px border-box (1px border, 20px padding → a
 * 318px content column at x 21…339):
 *
 * |  pop t | tile box                        | → close | → row 1 | past panel |
 * |-------:|---------------------------------|--------:|--------:|-----------:|
 * |    0ms | `[217.4,-55.1 → 361.0, 88.5]`   |  170.4  |  24.5   |     1.0    |
 * |   40ms | `[212.2,-60.3 → 366.2, 93.7]`   |  165.2  |  19.3   |     6.2    |
 * |   80ms | `[211.0,-61.5 → 367.4, 94.9]`   |  164.0  |  18.1   |     7.4    |
 * |  143ms | `[211.5,-60.9 → 366.8, 94.4]`   |  164.5  |  18.6   |     6.8    |
 * |  230ms | `[216.8,-55.6 → 361.5, 89.1]`   |  169.8  |  23.9   |     1.5    |
 * |  419ms | `[217.4,-55.1 → 361.0, 88.5]`   |  170.4  |  24.5   |     1.0    |
 *
 * The tile's box runs 143.6 → 156.4 → 143.6px across a pop, and 143.6 → 128.7px
 * across the idle breathe. What that costs:
 *
 * - `right:-2` hangs the pivot corner 1px past the panel's right border at rest
 *   and 7.4px at the peak. The panel's `max-width:calc(100vw - 32px)` keeps
 *   16px either side of it on the narrowest viewport, so even a popping cat
 *   cannot push the page sideways. The idle breathe pulls it back *inside* the
 *   panel entirely (-6.5px at its smallest).
 * - `top:-58` lifts 55.1px of the tile clear of the panel into the backdrop at
 *   rest and 61.5px at the peak, leaving the rest over the header band —
 *   straddling the corner the way the reference's mascot straddles its card's.
 * - The close button ends at x=47 and the title's text at x=129.2: **164.0px
 *   and 82.3px of clearance at the worst frame**. That margin is why the close
 *   button could stay a real, full-size, fully visible button rather than being
 *   shrunk or shoved somewhere odd.
 * - Row one's top is y=113, or y=108.8 when it is itself the hovered row — its
 *   -1.5° lean raises it — against the cat's bottom at y=94.9 at the worst
 *   frame: **18.1px, or 13.9px if row one is the row being popped at**. That
 *   gap is the ceiling on all of this, and `HEADER_GAP` is what buys it.
 *
 * Swept across the whole pop and the whole idle cycle, and checked on the cases
 * that differ — resting, a hovered first row, a hovered last row, and a two-row
 * picker — since the first row is the only one the cat can reach and a short
 * list is the only case where the panel itself is short.
 */
const CAT_SEAT = `top:-58px;right:-2px;width:${CAT}px;height:${CAT}px`;

/**
 * The header's two gaps, which are the price of the cat's size.
 *
 * The close button's row, then 34px, then the title, then 14px, then the list —
 * 109px of header against the 90px this dialog carried when the mascot was a
 * per-row sticker. The owner explicitly traded panel height for cat size; this
 * is that trade, and it is 19px.
 *
 * The close button leads on its own line rather than sitting opposite the title
 * because the top-right is the cat's now. The title then falls to the foot of
 * the band, which is where the reference puts its own headline — under the
 * badge, beside the mascot's chin — so the swap reads as the intended
 * composition rather than as a close button that got moved.
 */
const HEADER_GAP = 34;
const TITLE_GAP = 14;

/**
 * Sparkles, clustered around the one cat at three sizes and staggered so they
 * twinkle on three different clocks rather than pulsing as one.
 *
 * Positioned against the panel, not the cat, because the cat leans, breathes
 * and pops, and sparkles that did all that with it would read as glued on. They
 * fan down the cat's left flank — the largest flung well up and clear of the
 * panel's top edge entirely, since the reference's confetti leaves its card and
 * a sparkle that stays inside the panel reads as decoration on the panel rather
 * than as something the cat knocked loose.
 *
 * The left flank rather than a ring around the tile because the tile's box is
 * 156.4px across at the pop's peak against 143.6px at rest: the two obvious
 * seats, above the tile's top-left corner and under its chin, are both inside
 * the swollen one. All three positions are measured against the tile *at peak*,
 * the close button, the title and the first row in the same pass as the seat.
 *
 * Two delays each. `entry` is the opening burst, timed off the landing;
 * `burst` is the much tighter stagger used on every hover afterwards, when the
 * cluster is re-keyed and has to land with the pop rather than a beat behind it.
 */
const SPARKS: { at: string; size: number; entry: number; burst: number }[] = [
  { at: "top:-86px;right:132px", size: 16, entry: 620, burst: 60 },
  { at: "top:-14px;right:160px", size: 11, entry: 800, burst: 190 },
  { at: "top:46px;right:172px", size: 9, entry: 940, burst: 320 },
];

/**
 * The entrance, in ms.
 *
 * `LAUNCH` is the opening spring; the lean and the breathe pick up as it lands,
 * and the sparkles start a beat after that so they read as thrown by the
 * landing rather than as arriving with it. `CatMascot` winks on its own 640ms
 * clock, which falls in the same window.
 */
const LAUNCH = 520;
const IDLE_IN = LAUNCH + 40;

/**
 * The hover pop: the beat that was missing.
 *
 * The first cut of this redesign gave the cat one entrance on open and nothing
 * afterwards but colour — which meant the only motion in the whole dialog
 * played before anyone was looking at it, and hovering wallets, the thing
 * people actually spend time doing here, was a silent recolour. The pop puts
 * the spring back where it can be seen: once per arrival on a wallet, on the
 * same overshoot curve as the entrance.
 *
 * 420ms because the pop has to finish inside the time it takes to slide from
 * one row to the next; a slower one gets cut off mid-swell by its own
 * replacement and reads as a stutter.
 */
const POP = 420;

/**
 * Two names for one animation. See `vcCatPopA` in `styles.css`: re-applying an
 * animation name an element already carries does nothing, so the pop alternates
 * between these on every hover and the name always changes.
 */
const POP_NAMES = ["vcCatPopA", "vcCatPopB"] as const;

/* ------------------------------------------------------------------ *
 *  Brand colour
 *
 *  A hovered row answers in the hovered wallet's *own* colour — Phantom's
 *  violet, MetaMask's orange — and so, now, does the cat. The app's own lime
 *  never appears here: hovering a wallet is not a selection, and the accent is
 *  the vocabulary of selection everywhere else in this app.
 *
 *  Two sources, in order. A short table for wallets worth being exact about,
 *  then — because EIP-6963 is open and the next wallet to announce itself is
 *  one nobody has heard of — the icon the wallet already handed us, sampled at
 *  runtime. Anything that fails either way falls to a neutral treatment.
 * ------------------------------------------------------------------ */

/**
 * The wallets worth hard-coding, keyed by `rdns` with the name as a fallback
 * for forks and mobile builds that ship a different id.
 *
 * These are the published brand values, but they were *checked* rather than
 * recalled: each wallet's real icon was run through `sampleBrand` below and the
 * derived hue compared against the entry here. Phantom's icon samples to hue
 * 249° against 249° for `#AB9FF2`; Brave's to 14° against 12°; Rabby's to 236°
 * against 231°; MetaMask's fox to the orange band. Where a wallet's icon is
 * monochrome — OKX and Ledger both sample to `null` — no entry is made, because
 * a black brand mark has no usable colour on a black dialog and the neutral
 * path is the honest answer.
 */
const BRANDS: { rdns: string; name: string; color: string }[] = [
  { rdns: "io.metamask", name: "metamask", color: "#F6851B" },
  { rdns: "app.phantom", name: "phantom", color: "#AB9FF2" },
  { rdns: "com.coinbase.wallet", name: "coinbase", color: "#0052FF" },
  { rdns: "io.rabby", name: "rabby", color: "#7084FF" },
  { rdns: "com.brave.wallet", name: "brave", color: "#FB542B" },
  { rdns: "com.trustwallet.app", name: "trust", color: "#3375BB" },
];

/** Where the neutral path lands: a one-step background lift and a brighter
 *  border, no hue at all. Used for the monochrome-icon wallets, for anything
 *  the sampler cannot read, and for the mock. */
const NEUTRAL = { bg: C.cardAlt, border: C.borderMid, ink: C.muted } as const;

/**
 * How much of the brand goes into the hovered row's background.
 *
 * This started at the reference's pastel 10% and the answer was that the row
 * barely moved. On a near-black ground a tint that reads as "soft" on a white
 * card reads as nothing at all, so the row is the piece that carries the colour
 * statement now — 22% of the brand over `#0a0a0c`, which is plainly the
 * wallet's colour at a glance and still dark enough to keep `C.text` at full
 * legibility over it.
 */
const WASH = 0.22;

/** The tile is near-white, so the cat's tint is judged against *it*, not
 *  against the dialog: `forDarkUi`'s lift would wash a pastel brand out to
 *  nearly the tile's own colour. */
const CAT_ON_LIGHT: [number, number] = [0.5, 0.68];

/**
 * The cat's colour when no row is hovered — which, now that there is only one
 * cat and it is up the whole time the dialog is, is the state most people will
 * actually see.
 *
 * Rendered against zinc (`C.muted`), the mascot's shipped cream (`#f7f7f4`) and
 * two warmer creams. Zinc reads as a *disabled* cat: it is the same grey as the
 * dimmed chip two rows below it, so the mascot looks switched off rather than
 * waiting. The shipped cream is cream on cream — the tile is near-white, and
 * the render was a pair of floating eyes. `#d8d0bd` is the one that has body
 * against the tile's `#dcdce4` foot and still reads warm rather than khaki: a
 * cat at rest, not a placeholder.
 */
const CAT_NEUTRAL = "#d8d0bd";

/** Sparkles at rest, a shade lighter than the resting cat so they twinkle
 *  rather than sit. */
const SPARK_NEUTRAL = "#e9e3d4";

/** The tile's near-white, top and bottom of a shallow vertical shade. */
const TILE_TOP = "#fbfbfd";
const TILE_BOTTOM = "#dcdce4";

type Rgb = [number, number, number];

function parseHex(hex: string): Rgb | null {
  const h = hex.replace("#", "");
  if (h.length !== 6) return null;
  const n = Number.parseInt(h, 16);
  if (!Number.isFinite(n)) return null;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (rgb: Rgb): string =>
  "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

/** `t` of `top` over `base`, both opaque — used for the row's wash so the
 *  result is a flat colour that transitions cleanly, rather than a translucent
 *  layer whose apparent colour depends on the panel gradient behind it. */
function mix(base: string, top: string, t: number): string {
  const a = parseHex(base);
  const b = parseHex(top);
  if (!a || !b) return base;
  return toHex([0, 1, 2].map((i) => a[i]! + (b[i]! - a[i]!) * t) as Rgb);
}

function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
  return toHex([f(0), f(8), f(4)] as Rgb);
}

/** Hue, saturation and lightness of a hex colour, or `null` if it is grey. */
function toHsl(hex: string): { h: number; s: number; l: number } | null {
  const rgb = parseHex(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((v) => v / 255) as Rgb;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return null; // grey has no hue to preserve
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** Hold a hue, force its lightness into `[lo, hi]` and keep it saturated
 *  enough to read as a colour rather than as a tinted grey. */
function band(hex: string, lo: number, hi: number): string {
  const c = toHsl(hex);
  if (!c) return hex;
  return hslToHex(c.h, Math.max(0.42, Math.min(c.s, 0.92)), Math.max(lo, Math.min(c.l, hi)));
}

/**
 * Pull a colour into a band that works as ink on this dialog.
 *
 * Brand values are chosen against white marketing pages and several are far too
 * dark to read on `#0a0a0c` — Coinbase's `#0052FF` at 50% lightness is the
 * clear case. Everything, table entry or sampled, goes through here so the chip
 * is legible and the wash is a tint of the same hue the row's border shows.
 */
const forDarkUi = (hex: string): string => band(hex, 0.58, 0.78);

/** Sparkles are small and thrown clear of everything, so they get a lighter,
 *  airier cut of the brand than the chrome does. */
const forSparkle = (hex: string): string => band(hex, 0.68, 0.84);

/**
 * The dominant hue of an icon, or `null` if it hasn't got one.
 *
 * Averaging RGB across an icon returns mud, so this averages *hue* as a vector
 * — the circular mean — weighted by each pixel's saturation, which lets the few
 * brand-coloured pixels outvote a large white or transparent field. Near-black,
 * near-white and grey pixels are skipped outright: they are the mark's outline
 * and background, never its colour.
 *
 * `null` when fewer than 6% of the opaque pixels carry any colour at all. That
 * is the monochrome case — OKX, Ledger — where inventing a hue would be worse
 * than the neutral treatment.
 */
function sampleBrand(img: HTMLImageElement): string | null {
  const N = 16; // 256 pixels is plenty for a hue, and costs nothing
  const cv = document.createElement("canvas");
  cv.width = N;
  cv.height = N;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, N, N);
  const px = ctx.getImageData(0, 0, N, N).data;

  let vx = 0;
  let vy = 0;
  let sSum = 0;
  let wSum = 0;
  let opaque = 0;
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]! / 255;
    if (a < 0.5) continue;
    opaque++;
    const r = px[i]! / 255;
    const g = px[i + 1]! / 255;
    const b = px[i + 2]! / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (l < 0.1 || l > 0.94) continue;
    const d = max - min;
    if (d === 0) continue;
    const s = d / (1 - Math.abs(2 * l - 1));
    if (s < 0.22) continue;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    const w = s * a;
    const rad = (h * Math.PI) / 180;
    vx += Math.cos(rad) * w;
    vy += Math.sin(rad) * w;
    sSum += s * w;
    wSum += w;
  }

  if (!opaque || wSum / opaque < 0.06) return null;
  let hue = (Math.atan2(vy, vx) * 180) / Math.PI;
  if (hue < 0) hue += 360;
  return hslToHex(hue, Math.max(0.45, Math.min(sSum / wSum, 0.92)), 0.64);
}

/**
 * Sampled colours, keyed by the icon's own URI so a wallet is measured once for
 * the life of the page however often the picker is opened and closed.
 * `null` is a cached answer too — a wallet that sampled to nothing is not
 * re-sampled on the next open.
 */
const SAMPLED = new Map<string, string | null>();

function loadAndSample(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (typeof document === "undefined" || typeof Image === "undefined") {
        resolve(null);
        return;
      }
      const img = new Image();
      // EIP-6963 icons are data: URIs, which are same-origin and read back
      // fine. A wallet that ships an http(s) icon instead would taint the
      // canvas and make `getImageData` throw; asking for CORS up front turns
      // that into an ordinary load failure, which is the neutral path.
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          resolve(sampleBrand(img));
        } catch {
          // A tainted canvas, or a DOM with no canvas implementation at all.
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    } catch {
      resolve(null);
    }
  });
}

/** The table entry for a wallet, if it has one. */
function tableBrand(rdns: string, name: string): string | undefined {
  const id = rdns.toLowerCase();
  const label = name.toLowerCase();
  const hit =
    BRANDS.find((b) => b.rdns === id || id.startsWith(`${b.rdns}.`)) ??
    // Forks and mobile builds announce their own rdns (`io.metamask.mmi`,
    // vendor-prefixed ids) but keep the name.
    BRANDS.find((b) => label.includes(b.name));
  return hit?.color;
}

/**
 * Every wallet's colour, by `rdns`, resolved in one place.
 *
 * This is a picker-level hook rather than a row-level one because the cat is
 * picker-level: the row knows which wallet the pointer is on, but the thing
 * that has to be *painted* in that wallet's colour lives two levels up. Having
 * the picker own the whole table means the hover handler passes an `rdns` and
 * nothing has to be threaded back up through a callback that could arrive a
 * frame late or out of order.
 *
 * The table is synchronous, so a known wallet is coloured on its first paint.
 * Sampling needs each icon decoded, so it lands a frame or two later — before
 * any pointer could plausibly arrive, and harmless if it doesn't. `SAMPLED`
 * makes the whole pass a no-op on every open after the first.
 */
function useBrands(wallets: InjectedWallet[]): Record<string, string | null> {
  const [sampledAt, setSampledAt] = useState(0);

  useEffect(() => {
    const pending = wallets.filter(
      (w) => !tableBrand(w.rdns, w.name) && w.icon !== "" && !SAMPLED.has(w.icon),
    );
    if (pending.length === 0) return;
    let live = true;
    void Promise.all(
      pending.map((w) => loadAndSample(w.icon).then((c) => SAMPLED.set(w.icon, c))),
    ).then(() => {
      // One bump for the whole batch: the icons decode within a frame or two of
      // each other and re-rendering the dialog per wallet buys nothing.
      if (live) setSampledAt((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [wallets]);

  return useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const w of wallets) {
      const raw = tableBrand(w.rdns, w.name) ?? SAMPLED.get(w.icon) ?? null;
      out[w.rdns] = raw ? forDarkUi(raw) : null;
    }
    return out;
    // `sampledAt` is the dependency that matters — `SAMPLED` is a module-level
    // map and mutating it cannot invalidate anything on its own.
  }, [wallets, sampledAt]);
}

/**
 * The reduced-motion probe, local to this module so the picker does not reach
 * into `sound/engine.ts` for it — the same shape `RankUpSequence` uses.
 */
function stillMotion(): boolean {
  try {
    return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  } catch {
    return false;
  }
}

/** `:focus-visible` is unimplemented in some test DOMs, where `matches` throws
 *  on the selector rather than returning false. */
function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/** A four-point diamond, the sparkle shape from the reference motion study, in
 *  whichever colour the cat is currently wearing. */
function Spark({
  size,
  delay,
  at,
  color,
}: {
  size: number;
  delay: number;
  at: string;
  color: string;
}) {
  return (
    <span
      data-wspark=""
      aria-hidden="true"
      style={sx(
        `position:absolute;${at};width:${size}px;height:${size}px;z-index:3;pointer-events:none;` +
          `opacity:0;transform:scale(.2);animation:vcSparkle 1500ms ease-in-out ${delay}ms infinite`,
      )}
    >
      {/* A rounded square stood on its corner, not a four-point star — the
          reference throws soft confetti diamonds, and a star reads as sharper
          and more "magic sparkle" than the character wants. */}
      <svg viewBox="0 0 24 24" width={size} height={size} style={sx("display:block")}>
        <rect
          x="5"
          y="5"
          width="14"
          height="14"
          rx="3"
          fill={color}
          transform="rotate(45 12 12)"
          // Retints with the cat, on the cat's clock.
          style={sx("transition:fill 220ms ease")}
        />
      </svg>
    </span>
  );
}

/** Every animated element in the stack is a bare full-size block; only the
 *  innermost one paints anything. */
const LAYER = "display:block;width:100%;height:100%;";

/**
 * The one cat, and its seat at the top of the dialog.
 *
 * The geometry is `CAT_SEAT`'s. What lives here is the choreography — four
 * transforms and a colour, on four clocks that must not be confused:
 *
 * - **The entrance runs once, on open.** `landed` flips on the frame after
 *   mount, which turns a resting transform into the seated one and lets a
 *   transition carry it: the tile arrives from the panel's top-right corner at
 *   46% scale and -38°, overshoots on `cubic-bezier(.34,1.56,.64,1)` and settles
 *   at -10°. `transform-origin:100% 100%` is what makes it grow *out of* that
 *   corner rather than swelling in place. The picker unmounts when it closes, so
 *   the next open replays this from scratch with no reset to manage.
 * - **The pop runs on every arrival.** `pops` counts hovers; each one swaps the
 *   animation name and the browser restarts it — the swap is the whole trick,
 *   see `POP_NAMES`. This is the beat the first cut of the redesign was missing:
 *   with the entrance as the only motion, everything animated happened before
 *   the dialog had been looked at.
 * - **The breathe and the lean run the whole time.** Slow, small, and on
 *   separate elements from each other and from everything above, because CSS
 *   gives one element one `transform` and a running animation beats a
 *   transition outright.
 * - **The colour runs on the pointer, and moves nothing.** Every coloured
 *   surface transitions over 220ms — the cat's fur (a `fill` transition inside
 *   `CatMascot`), the tile's warm cast, its ring, the sparkles.
 *
 * Nesting order is outermost-first: seat (launch) → pop → breathe → lean →
 * tile. Scale before rotate, so the pop and the breathe stay square to the
 * screen and the lean turns the finished object; reversing them makes the pop
 * scale along the tilted axis and the tile visibly skews.
 */
function CatSeat({
  brand,
  hot,
  still,
}: {
  brand: string | null;
  /** The hovered wallet's `rdns`, which is what the pop keys off. */
  hot: string | null;
  still: boolean;
}) {
  /**
   * `false` for exactly one frame after mount, which is what gives the
   * transition two different values to interpolate between. A `useEffect` that
   * sets state immediately would be flushed before paint and the browser would
   * see only the final value; the nested `requestAnimationFrame` guarantees the
   * resting frame is painted first.
   */
  const [landed, setLanded] = useState(false);
  useEffect(() => {
    if (still) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setLanded(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [still]);

  /**
   * How many wallets the pointer has arrived on. Only arrivals count: leaving
   * the list for the panel's dead space is not an event the cat should react
   * to, and popping on the way *out* of every row would make crossing the list
   * a stutter. Zero means the cat has only ever been entered — no pop yet, and
   * the entrance owns the motion.
   */
  const [pops, setPops] = useState(0);
  useEffect(() => {
    if (!hot || still) return;
    setPops((n) => n + 1);
  }, [hot, still]);

  /** The mascot is read against the near-white tile, so it is banded for a
   *  light ground; with no wallet hovered it takes the resting cream. */
  const fur = brand ? band(brand, CAT_ON_LIGHT[0], CAT_ON_LIGHT[1]) : CAT_NEUTRAL;
  /** The tile: white, warmed by a few percent of the wallet's colour so it
   *  belongs to the same object as the cat standing on it. */
  const tileTop = brand ? mix(TILE_TOP, brand, 0.07) : TILE_TOP;
  const tileBottom = brand ? mix(TILE_BOTTOM, brand, 0.12) : TILE_BOTTOM;
  const ring = brand ? `${brand}59` : "rgba(255,255,255,.28)";
  const spark = brand ? forSparkle(brand) : SPARK_NEUTRAL;

  /** Reduced motion: seated from the first frame, and never a launch. */
  const seated = still || landed;

  return (
    <>
      <span
        data-wcat=""
        aria-hidden="true"
        style={sx(
          `position:absolute;${CAT_SEAT};z-index:2;pointer-events:none;` +
            "transform-origin:100% 100%;" +
            (seated
              ? `opacity:1;transform:translate(0,0) scale(1) rotate(${CAT_TILT}deg);`
              : "opacity:0;transform:translate(6px,22px) scale(.46) rotate(-38deg);") +
            (still
              ? ""
              : `transition:transform ${LAUNCH}ms cubic-bezier(.34,1.56,.64,1),opacity 200ms ease`),
        )}
      >
        <span
          // The pop. Nothing here until the pointer has reached a wallet, and
          // then a different animation name on every arrival — see `POP_NAMES`
          // for why the alternation is load-bearing rather than decorative.
          style={sx(
            LAYER +
              (pops === 0 || still
                ? ""
                : `animation:${POP_NAMES[pops % 2]} ${POP}ms cubic-bezier(.34,1.56,.64,1)`),
          )}
        >
          <span
            // The breathe. Deliberately not in step with the lean below it —
            // 2800 against 2400 — so the two never settle into one visible
            // pulse.
            style={sx(
              LAYER +
                (still
                  ? ""
                  : `animation:vcCatBreathe 2800ms ease-in-out ${IDLE_IN}ms infinite alternate`),
            )}
          >
            <span
              // The lean.
              style={sx(
                LAYER +
                  (still
                    ? ""
                    : `animation:vcCatLean 2400ms ease-in-out ${IDLE_IN}ms infinite alternate`),
              )}
            >
              <span
                // The tile proper, and the only element here that paints.
                //
                // Near-white, because that is what makes a sticker read as
                // stuck *on* the dialog rather than cut out of it: the
                // reference's tile is white against a pale page, and the
                // equivalent move on a near-black panel is the same white, not
                // another dark surface. A faint wash of the wallet's colour
                // warms it; the shadow underneath is what sells the height.
                //
                // `overflow:hidden` is load-bearing — it is what crops the
                // cat's head against the corner radius and gives the art its
                // framing.
                style={sx(
                  `${LAYER}overflow:hidden;border-radius:${CAT_RADIUS}px;` +
                    `background:linear-gradient(170deg,${tileTop},${tileBottom});` +
                    `box-shadow:0 0 0 1px ${ring},0 30px 54px rgba(0,0,0,.72),` +
                    "0 12px 24px rgba(0,0,0,.5);" +
                    "transition:background 220ms ease,box-shadow 220ms ease",
                )}
              >
                <CatMascot color={fur} wink={!still} />
              </span>
            </span>
          </span>
        </span>
      </span>

      {/* Re-keyed on `pops`, which remounts them and restarts their clocks: the
          cluster bursts again with each pop instead of twinkling obliviously
          through it. Remounting is safe here in a way it would not be one level
          in — a sparkle is at `opacity:0` for its whole delay, so it has no
          visible colour to transition and nothing to lose by starting over.

          Pure twinkle, so a reduced-motion reader gets none of them: there is no
          static state of a sparkle worth keeping. */}
      {!still &&
        SPARKS.map((s) => (
          <Spark
            key={`${pops}:${s.at}`}
            at={s.at}
            size={s.size}
            delay={pops === 0 ? s.entry : s.burst}
            color={spark}
          />
        ))}
    </>
  );
}

/**
 * One wallet.
 *
 * The row keeps the colour treatment it has always had — a 22% wash of the
 * wallet's own brand on the background, a solid brand border, the brand-tinted
 * `INSTALLED` chip and a -1.5° lean — and has lost the sticker that used to
 * spring out of its corner. What replaces it is a report upward: while the
 * pointer (or the keyboard) is on this row, the picker's one cat wears this
 * wallet's colour.
 *
 * Hover and focus are tracked apart because they overlap: a keyboard user who
 * tabs to a row and then happens to sweep the pointer across it would otherwise
 * have the row handed back by the mouse-leave while it was still focused.
 *
 * Colour keys off `hot` rather than off any motion flag, so a reduced-motion
 * reader loses the lean and keeps the wash, the border, the chip *and* the
 * cat's retint. A hue costs nobody a vestibular symptom. The resting state is
 * untouched by all of it.
 */
function WalletRow({
  wallet,
  brand,
  onChoose,
  onHot,
  still,
}: {
  wallet: InjectedWallet;
  /** This wallet's colour, or `null` for the neutral treatment. */
  brand: string | null;
  onChoose: (rdns: string) => void;
  /** Reports this row entering or leaving the pointer, to the one cat. */
  onHot: (rdns: string, on: boolean) => void;
  /** `prefers-reduced-motion` — the lean is off. */
  still: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hot = hovered || focused;

  /**
   * EIP-6963 promises a data: URI, but a wallet that announces a broken one
   * would leave an empty box in the row. The cat is unaffected — the icon's
   * only job up there is to have been *sampled* for its colour, which fails to
   * `null` on its own.
   */
  const [broken, setBroken] = useState(false);
  const hasIcon = wallet.icon !== "" && !broken;

  // Reported from an effect rather than from the handlers so that focus and
  // hover fold into one answer before the picker hears about it. Leaving row A
  // for row B lands both updates in the same React batch — the mouseleave and
  // mouseenter come off one native mousemove — so the cat never flickers
  // through neutral on the way across.
  useEffect(() => {
    onHot(wallet.rdns, hot);
  }, [hot, wallet.rdns, onHot]);

  /** Everything the hover paints, resolved once. `null` brand — a monochrome
   *  icon, an unreadable one, the mock — takes the neutral column. */
  const paint = {
    bg: hot ? (brand ? mix("#0a0a0c", brand, WASH) : NEUTRAL.bg) : "#0a0a0c",
    border: hot ? (brand ?? NEUTRAL.border) : C.border,
    ink: hot ? (brand ?? NEUTRAL.ink) : C.dim,
  };

  const initial = (wallet.name.trim()[0] ?? "?").toUpperCase();

  return (
    <button
      onClick={() => onChoose(wallet.rdns)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      // Focus gets the hover treatment verbatim — the modal is keyboard
      // navigable, and a focus ring alone would hide half the affordance.
      // `:focus-visible` keeps the cat from retinting on a mouse click.
      onFocus={(e) => {
        if (focusVisible(e.currentTarget)) setFocused(true);
      }}
      onBlur={() => setFocused(false)}
      style={sx(
        // `z-index:1` against the cat's 2: the cat overhangs the panel's header
        // and must paint over anything it reaches, and the close button's 6
        // outranks both.
        "position:relative;z-index:1;width:100%;display:flex;align-items:center;gap:12px;" +
          "padding:10px 12px;border-radius:12px;cursor:pointer;text-align:left;" +
          // Composited to a flat colour rather than layered translucently, so
          // what shows is a tint of the row's real resting black and not of the
          // panel gradient behind it.
          `border:1px solid ${paint.border};background-color:${paint.bg};` +
          // Leaning the top-right corner up, toward the cat, and lifting the row
          // off the panel to match.
          (hot && !still
            ? "transform:rotate(-1.5deg);box-shadow:0 12px 30px rgba(0,0,0,.5);"
            : "transform:rotate(0deg);box-shadow:0 0 0 0 rgba(0,0,0,0);") +
          "transition:transform 240ms cubic-bezier(.2,.8,.2,1),border-color 200ms ease," +
          "background-color 200ms ease,box-shadow 240ms ease",
      )}
    >
      {/* Wallets announce their icon as a data: URI, so nothing loads over the
          network here. */}
      {hasIcon ? (
        <img
          src={wallet.icon}
          alt=""
          onError={() => setBroken(true)}
          style={sx("width:26px;height:26px;border-radius:7px;flex:none")}
        />
      ) : (
        <span
          style={sx(
            `width:26px;height:26px;border-radius:7px;flex:none;display:grid;place-items:center;` +
              `background:${C.raised};font:700 12px/1 ${MONO};color:${C.muted}`,
          )}
        >
          {initial}
        </span>
      )}
      <span style={sx(`font:700 13px/1 ${SANS};color:${C.text};flex:1`)}>{wallet.name}</span>
      {/* The reference's CTA — solid brand colour on hover, ~200ms — and this
          chip inherits that job, in the tinted-tag shape `theme.miniTag` uses:
          brand ink over a 10% wash inside a 30% border.

          The padding and border are cancelled by an exactly equal negative
          margin, which is what lets the chip grow a box on hover without moving
          by a pixel at rest: `4+1` vertical and `6+1` horizontal, so the flex
          item measures precisely the same as the bare text it was before, and
          the wash paints outward into the row's own padding. */}
      <span
        style={sx(
          `font:500 9px/1 ${MONO};letter-spacing:.1em;color:${paint.ink};` +
            "padding:4px 6px;margin:-5px -7px;border-radius:5px;" +
            `border:1px solid ${hot && brand ? `${brand}4d` : "transparent"};` +
            `background-color:${hot && brand ? `${brand}1a` : "transparent"};` +
            "transition:color 200ms ease,border-color 200ms ease,background-color 200ms ease",
        )}
      >
        INSTALLED
      </span>
    </button>
  );
}

export function WalletPicker({
  wallets,
  error,
  onChoose,
  onCancel,
}: {
  wallets: InjectedWallet[];
  error: string | null;
  onChoose: (rdns: string) => void;
  onCancel: () => void;
}) {
  // Read once per render of the picker, not per row: `matchMedia` is cheap but
  // there is no reason to ask it five times for the same answer.
  const still = stillMotion();
  const brands = useBrands(wallets);

  /**
   * Which wallet the cat is wearing. Held by `rdns` rather than as a colour so
   * that a sampled colour arriving late still reaches the cat: `brands` is what
   * resolves, and this only says *whose*.
   *
   * Cleared by identity, never unconditionally — a row that reports itself cold
   * after another row has already claimed the cat must not take it away.
   */
  const [hotRdns, setHotRdns] = useState<string | null>(null);
  const onHot = useCallback((rdns: string, on: boolean) => {
    setHotRdns((cur) => (on ? rdns : cur === rdns ? null : cur));
  }, []);
  const hotBrand = hotRdns ? (brands[hotRdns] ?? null) : null;

  return (
    <div
      onClick={onCancel}
      style={sx(
        "position:fixed;inset:0;z-index:80;display:grid;place-items:center;" +
          "background:rgba(6,6,8,.72);backdrop-filter:blur(6px)",
      )}
    >
      <div
        // The backdrop closes the picker; clicks inside it must not bubble up.
        onClick={(e) => e.stopPropagation()}
        style={sx(
          "width:360px;max-width:calc(100vw - 32px);border:1px solid #27272a;border-radius:16px;" +
            "background:linear-gradient(180deg,#101012,#0b0b0d);padding:20px;" +
            // `overflow:visible` is load-bearing, not the default falling
            // through: the cat hangs up to 61.5px above this box and 7.4px past
            // its right edge at the pop's peak, and anything that clipped
            // here would behead it.
            "overflow:visible;position:relative;" +
            "box-shadow:0 24px 64px rgba(0,0,0,.6)",
        )}
      >
        <CatSeat brand={hotBrand} hot={hotRdns} still={still} />

        {/* The close button leads on its own line: the top-right corner, where
            it used to sit opposite the title, is the cat's seat now. Measured
            clear of the cat's widest box by 164.0px — see `CAT_SEAT` — so this
            is composition rather than a dodge, and the button keeps its full
            26px target. */}
        <div style={sx(`margin-bottom:${HEADER_GAP}px`)}>
          <button
            onClick={onCancel}
            aria-label="Close"
            style={sx(
              // Above the cat (2) and its sparkles (3). Insurance rather than
              // mechanism: the seat is measured clear of this button in both
              // axes, and hiding the close button under a mascot is precisely
              // the bug that measurement exists to avoid. If a future seat does
              // stray over here, the chrome wins and the button stays legible.
              `position:relative;z-index:6;width:26px;height:26px;border:1px solid ${C.border};border-radius:8px;` +
                `background:transparent;color:${C.muted};font:500 13px/1 ${SANS};cursor:pointer`,
            )}
          >
            ×
          </button>
        </div>

        <div style={sx(`margin-bottom:${TITLE_GAP}px`)}>
          <span style={sx(`font:700 14px/1 ${SANS};letter-spacing:-.01em`)}>Connect a wallet</span>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:8px")}>
          {wallets.map((w) => (
            <WalletRow
              key={w.rdns}
              wallet={w}
              brand={brands[w.rdns] ?? null}
              onChoose={onChoose}
              onHot={onHot}
              still={still}
            />
          ))}
        </div>

        {error && (
          <p style={sx(`margin:14px 0 0;font:500 11px/1.5 ${SANS};color:${C.red}`)}>{error}</p>
        )}

        <p style={sx(`margin:16px 0 0;font:500 10px/1.5 ${MONO};color:${C.faint}`)}>
          BASE MAINNET · 8453
        </p>
      </div>
    </div>
  );
}
