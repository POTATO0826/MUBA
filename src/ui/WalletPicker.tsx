import { useEffect, useState } from "react";
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
 * Hovering (or keyboard-focusing) a row springs a big sticker of that wallet's
 * own icon out of the row's top-right corner — see `WalletRow` for the
 * choreography and `styles.css` for the two loops it uses.
 *
 * Nothing in this dialog clips: the backdrop, the panel, the list and the rows
 * all keep `overflow:visible`, and the seat below keeps the tile inside the
 * panel's padding box anyway. The hazard here was never clipping but *paint
 * order* — see `STICKER_SEAT`.
 */

/** The sticker tile, in px. Every number in `STICKER_SEAT` is derived from
 *  this one, so the arithmetic there has to be redone if it changes. */
const STICKER = 88;

/**
 * Where the sticker comes to rest, relative to the row's top-right corner.
 *
 * This seat is arithmetic, not taste, and the arithmetic was checked against
 * measured `getBoundingClientRect`s rather than done on paper — a tilted tile's
 * *bounding box* is what can collide with the close button, and it is fatter
 * than the tile's own rotated outline, which is how an earlier seat that
 * penciled out as safe still landed 2px under the button.
 *
 * Working in the panel's 360px border-box (1px border, 20px padding → a 318px
 * content column at x 21…339), with the header's 44px bottom margin putting
 * row 1's top edge at y=91, each row 48px tall on an 8px gap, and the tile at
 * its widest (8° settled + 3° of wobble):
 *
 * - `right:4` puts the tile's right edge at x=335; tilted, its box reaches
 *   x≈352, a deliberate overhang into the panel's padding that still leaves
 *   ~7px to the panel's inner border. It never crosses the panel edge on any
 *   row, so nothing needs clipping and nothing needs to be clipped.
 * - `top:-20` centres the tile on the row's top-right corner: 20px of an 88px
 *   tile rises above the row and 20px falls below it. Sinking is only allowed
 *   because the sticker outranks *every* row rather than only its own — see the
 *   wrapper in `WalletRow`. When each row was its own stacking context the tile
 *   could not pass below its row at all, and that rule alone capped it at 64px.
 * - On row 1 that leaves ~9px between the tile's box and the bottom of the
 *   close button, which is the ceiling on all of this: the tile is as large as
 *   it can be and still clear the one piece of chrome it can reach. Every extra
 *   pixel of height costs 1.17px of that clearance, and the header's margin —
 *   16px originally, 44px now — is what has been buying it back.
 *
 * Measured on all four cases that differ — first row, a middle row, the last
 * row, and a two-row picker — since the first row is the only one the close
 * button can reach and the last is the only one with nothing beneath it.
 */
const STICKER_SEAT = `top:-20px;right:4px;width:${STICKER}px;height:${STICKER}px`;

/**
 * Sparkles, thrown clear of the tile at three sizes and staggered so they
 * twinkle on three different clocks rather than pulsing as one.
 *
 * The largest is deliberately flung well up and to the left, into the gap under
 * the header — the source's confetti clears the card's edge entirely, and a
 * sparkle that stays inside the row reads as decoration on the row rather than
 * as something the sticker knocked loose. All three are checked against the
 * panel's inner edge and the close button's box in the same measurement pass as
 * the tile.
 */
const SPARKS: { at: string; size: number; delay: number }[] = [
  { at: "top:-46px;right:98px", size: 14, delay: 90 },
  { at: "top:52px;right:-12px", size: 10, delay: 230 },
  { at: "top:-6px;right:-8px", size: 8, delay: 350 },
];

/* ------------------------------------------------------------------ *
 *  Brand colour
 *
 *  A hovered row answers in the hovered wallet's *own* colour — Phantom's
 *  violet, MetaMask's orange — at the density the source motion study used: a
 *  soft wash plus one solid accent. The app's own lime never appears here.
 *  Hovering a wallet is not a selection, and the accent is the vocabulary of
 *  selection everywhere else in this app.
 *
 *  Two sources, in order. A short table for wallets worth being exact about,
 *  then — because EIP-6963 is open and the next wallet to announce itself is
 *  one nobody has heard of — the icon the wallet already handed us, sampled at
 *  runtime. Anything that fails either way falls to a neutral grey treatment.
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
 * This started at the source's pastel 10% and the answer was that the row
 * barely moved. On a near-black ground a tint that reads as "soft" on the
 * source's white card reads as nothing at all, so the row is the piece that
 * carries the colour statement now — 22% of the brand over `#0a0a0c`, which is
 * plainly the wallet's colour at a glance and still dark enough to keep
 * `C.text` at full legibility over it.
 */
const WASH = 0.22;

/** The tile is near-white, so the cat's tint is judged against *it*, not
 *  against the dialog: `forDarkUi`'s lift would wash a pastel brand out to
 *  nearly the tile's own colour. */
const CAT_ON_LIGHT: [number, number] = [0.5, 0.68];

/**
 * The mascot's colour for wallets that resolve to none.
 *
 * The mascot ships cream (`#f7f7f4`) and cream was the plan here, back when the
 * tile it stands on was dark. On the near-white tile the tile became, a cream
 * cat is a cream cat on cream — the render was a pair of floating eyes. So the
 * uncoloured cat takes the palette's mid grey instead, which is the same
 * neutral the row's border and chip fall back to and reads cleanly on white.
 */
const CAT_NEUTRAL = C.muted;

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
 * The colour a row answers in, or `null` for the neutral treatment.
 *
 * The table is synchronous, so a known wallet is coloured on its first paint.
 * Sampling needs the icon decoded, so it lands a frame or two later — before
 * any pointer could plausibly arrive, and harmless if it doesn't.
 */
function useBrand(rdns: string, name: string, icon: string): string | null {
  const table = tableBrand(rdns, name);
  const [sampled, setSampled] = useState<string | null>(
    () => table ?? SAMPLED.get(icon) ?? null,
  );

  useEffect(() => {
    if (table || !icon) return;
    const cached = SAMPLED.get(icon);
    if (cached !== undefined) {
      setSampled(cached);
      return;
    }
    let live = true;
    void loadAndSample(icon).then((c) => {
      SAMPLED.set(icon, c);
      if (live) setSampled(c);
    });
    return () => {
      live = false;
    };
  }, [table, icon]);

  const raw = table ?? sampled;
  return raw ? forDarkUi(raw) : null;
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

/** A four-point diamond, the sparkle shape from the source motion study, in the
 *  hovered wallet's own colour. */
function Spark({
  size,
  delay,
  at,
  on,
  color,
}: {
  size: number;
  delay: number;
  at: string;
  on: boolean;
  color: string;
}) {
  return (
    <span
      data-wspark=""
      aria-hidden="true"
      style={sx(
        `position:absolute;${at};width:${size}px;height:${size}px;z-index:3;pointer-events:none;` +
          "opacity:0;transform:scale(.2);transition:opacity 180ms ease;" +
          (on ? `animation:vcSparkle 1500ms ease-in-out ${delay}ms infinite` : ""),
      )}
    >
      {/* A rounded square stood on its corner, not a four-point star — the
          source throws soft confetti diamonds, and a star reads as sharper and
          more "magic sparkle" than the character wants. */}
      <svg viewBox="0 0 24 24" width={size} height={size} style={sx("display:block")}>
        <rect x="5" y="5" width="14" height="14" rx="3" fill={color} transform="rotate(45 12 12)" />
      </svg>
    </span>
  );
}

/**
 * One wallet, and the sticker that springs out of it.
 *
 * The geometry, in one place, because it is the whole trick:
 *
 * - The sticker sits at `z-index:2`, *above* the row's opaque `z-index:1`
 *   button, inside a wrapper that owns the stacking context. An earlier draft
 *   had it at `z-index:0`, genuinely behind the row, on the theory that a
 *   sticker should emerge from behind the card the way the source's does. It
 *   looked broken: the seat overlaps the row by design, so the row's own
 *   background ate the middle of the tile — icon included — and the effect read
 *   as a clipped half-sticker. Nothing was clipping anything; it was paint
 *   order. The tile now always paints whole, and "from behind" survives as
 *   motion rather than as z-order: at rest it is parked scaled to 42% in the
 *   row's corner at `opacity:0`, so it still grows *out of* that corner.
 * - On hover it travels to `STICKER_SEAT`, overshooting on the way with
 *   `cubic-bezier(.34,1.56,.64,1)`: it arrives tilted -14°, swings past +11°
 *   and settles at +8°, which is the source's spring. The settle is 8° rather
 *   than the source's ~10-12° because the tilt is what swings the tile's corner
 *   toward the panel edge, and `STICKER_SEAT`'s clearances are computed from
 *   this angle plus the wobble's ±3°.
 * - Once seated, an inner span picks up `vcStickerWobble` on a 440ms delay
 *   (i.e. as the launch lands) and drifts ±3° for as long as the pointer stays.
 *   Two elements, because a keyframe and a transition cannot share a
 *   `transform`.
 * - Leaving reverses every one of those, on a shorter, non-springy curve: a
 *   bouncing *retraction* reads as indecision rather than as recoil.
 *
 * Alongside the motion, the row answers in the hovered wallet's own colour —
 * see the brand section above for where that colour comes from and why it is
 * never the app's accent. Colour keys off `hot` rather than `launched`, so a
 * reduced-motion reader loses the sticker, the sparkles and the lean but keeps
 * the wash, the border and the chip; a hue costs nobody a vestibular symptom.
 * The resting state is untouched by all of it.
 */
function WalletRow({
  wallet,
  onChoose,
  still,
}: {
  wallet: InjectedWallet;
  onChoose: (rdns: string) => void;
  /** `prefers-reduced-motion` — the sticker, sparkles and lean are all off. */
  still: boolean;
}) {
  /**
   * Two sources, one treatment. They are tracked apart because they overlap:
   * a keyboard user who tabs to a row and then happens to sweep the pointer
   * across it would otherwise have the sticker torn away by the mouse-leave
   * while the row was still focused.
   */
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const hot = hovered || focused;
  /**
   * EIP-6963 promises a data: URI, but a wallet that announces a broken one
   * would leave an empty box in the row. The sticker is unaffected — it wears
   * the mascot now, and the icon's only remaining job there is to have been
   * *sampled* for its colour, which fails to `null` on its own.
   */
  const [broken, setBroken] = useState(false);
  const hasIcon = wallet.icon !== "" && !broken;

  /** Hover state that *moves* things. Colour answers to `hot` instead, so the
   *  reduced-motion path keeps the full brand treatment: a wash is not motion,
   *  and a row that only ever dims would be the poorer for losing it. */
  const launched = hot && !still;

  const brand = useBrand(wallet.rdns, wallet.name, wallet.icon);
  /** Everything the hover paints, resolved once. `null` brand — a monochrome
   *  icon, an unreadable one, the mock — takes the neutral column. */
  const paint = {
    bg: hot ? (brand ? mix("#0a0a0c", brand, WASH) : NEUTRAL.bg) : "#0a0a0c",
    border: hot ? (brand ?? NEUTRAL.border) : C.border,
    ink: hot ? (brand ?? NEUTRAL.ink) : C.dim,
    spark: brand ? forSparkle(brand) : NEUTRAL.ink,
    /** The mascot is read against the near-white tile, so it is banded for a
     *  light ground; with no brand it keeps its own cream. */
    cat: brand ? band(brand, CAT_ON_LIGHT[0], CAT_ON_LIGHT[1]) : CAT_NEUTRAL,
    /** The tile: white, warmed by a few percent of the wallet's colour so it
     *  belongs to the same object as the cat standing on it. */
    tileTop: brand ? mix(TILE_TOP, brand, 0.07) : TILE_TOP,
    tileBottom: brand ? mix(TILE_BOTTOM, brand, 0.12) : TILE_BOTTOM,
    tileRing: brand ? `${brand}59` : "rgba(255,255,255,.28)",
  };

  const initial = (wallet.name.trim()[0] ?? "?").toUpperCase();

  return (
    <div
      // Positioned so the sticker has something to be absolute against, and
      // pointedly *without* a z-index, so it does not become a stacking
      // context. That is what lets the tile grow: sealed inside its own row the
      // sticker outranked only that row's button, so any part of it hanging
      // below the row was painted over by the next row and the tile was capped
      // at the row's own height. Unsealed, the sticker's `z-index:2` is measured
      // against every row's `z-index:1` at once and wins over all of them,
      // whichever direction it overhangs. The dialog's chrome sits above it on
      // the same scale — see the close button.
      style={sx("position:relative")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!still && (
        <span
          data-wsticker=""
          aria-hidden="true"
          style={sx(
            `position:absolute;${STICKER_SEAT};z-index:2;pointer-events:none;` +
              // Scaling about the bottom-right corner is what tucks it *into*
              // the row: the corner it shrinks toward is the corner it emerges
              // from, so at rest the tile is a small patch sitting in the row's
              // right-hand end, and the launch reads as growing out of it.
              "transform-origin:100% 100%;" +
              (launched
                ? "opacity:1;transform:translate(0,0) scale(1) rotate(8deg);" +
                  "transition:transform 420ms cubic-bezier(.34,1.56,.64,1),opacity 150ms ease"
                : // The tile now paints above the row, so opacity is the only
                  // thing hiding it at rest — it fades marginally faster than it
                  // retracts so it cannot ghost over the row on the way out.
                  "opacity:0;transform:translate(-12px,-6px) scale(.42) rotate(-14deg);" +
                  "transition:transform 260ms cubic-bezier(.4,0,.6,1),opacity 180ms ease"),
          )}
        >
          <span
            // The wobble's own element, and the tile proper.
            //
            // Near-white, because that is what makes a sticker read as stuck
            // *on* the dialog rather than cut out of it: the source's tile is
            // white against a pale page, and the equivalent move on a near-black
            // panel is the same white, not another dark surface. A faint wash of
            // the wallet's colour warms it; the shadow underneath is what sells
            // the height.
            //
            // `overflow:hidden` is load-bearing — it is what crops the cat's
            // head against the corner radius and gives the art its framing.
            style={sx(
              "display:block;width:100%;height:100%;overflow:hidden;border-radius:24px;" +
                `background:linear-gradient(170deg,${paint.tileTop},${paint.tileBottom});` +
                `box-shadow:0 0 0 1px ${paint.tileRing},0 26px 46px rgba(0,0,0,.72),` +
                "0 10px 20px rgba(0,0,0,.5);" +
                "transition:transform 300ms ease,background 220ms ease;" +
                (launched ? "animation:vcStickerWobble 2400ms ease-in-out 440ms infinite alternate" : ""),
            )}
          >
            <CatMascot color={paint.cat} wink={launched} />
          </span>
        </span>
      )}

      {!still &&
        SPARKS.map((s) => (
          <Spark
            key={s.at}
            at={s.at}
            size={s.size}
            delay={s.delay}
            on={launched}
            color={paint.spark}
          />
        ))}

      <button
        onClick={() => onChoose(wallet.rdns)}
        // Focus gets the hover treatment verbatim — the modal is keyboard
        // navigable, and a focus ring alone would hide half the affordance.
        // `:focus-visible` keeps the sticker from firing on a mouse click.
        onFocus={(e) => {
          if (focusVisible(e.currentTarget)) setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        style={sx(
          "position:relative;z-index:1;width:100%;display:flex;align-items:center;gap:12px;" +
            "padding:10px 12px;border-radius:12px;cursor:pointer;text-align:left;" +
            // The wallet's own colour, at the source's density: a 10% wash on
            // the background and a 33% tint on the border. Composited to a flat
            // colour rather than layered translucently, so what shows is a tint
            // of the row's real resting black and not of the panel behind it.
            `border:1px solid ${paint.border};background-color:${paint.bg};` +
            // Leaning the top-right corner up, toward the sticker that just
            // pulled it, and lifting the row off the panel to match.
            (launched
              ? "transform:rotate(-1.5deg);box-shadow:0 12px 30px rgba(0,0,0,.5);"
              : "transform:rotate(0deg);box-shadow:0 0 0 0 rgba(0,0,0,0);") +
            "transition:transform 240ms cubic-bezier(.2,.8,.2,1),border-color 200ms ease," +
            "background-color 200ms ease,box-shadow 240ms ease",
        )}
      >
        {/* Wallets announce their icon as a data: URI, so nothing loads
            over the network here. */}
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
        {/* The source's CTA — solid brand colour on hover, ~200ms — and this
            chip inherits that job, in the tinted-tag shape `theme.miniTag`
            uses: brand ink over a 10% wash inside a 30% border.

            The padding and border are cancelled by an exactly equal negative
            margin, which is what lets the chip grow a box on hover without
            moving by a pixel at rest: `4+1` vertical and `6+1` horizontal, so
            the flex item measures precisely the same as the bare text it was
            before, and the wash paints outward into the row's own padding. */}
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
    </div>
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
            // through: a row's sticker hangs outside the row's box and into
            // this padding, and anything that clipped here would behead it.
            "overflow:visible;position:relative;" +
            "box-shadow:0 24px 64px rgba(0,0,0,.6)",
        )}
      >
        {/* 44px, not the 16px this header used to carry. The extra 28px is
            clearance: it is what the first row's sticker rises through, and
            every pixel of it is a pixel of tile size. `STICKER_SEAT` does that
            arithmetic; changing this number invalidates it. */}
        <div style={sx("display:flex;align-items:center;gap:12px;margin-bottom:44px")}>
          <span style={sx(`font:700 14px/1 ${SANS};letter-spacing:-.01em`)}>Connect a wallet</span>
          <div style={sx("flex:1")} />
          <button
            onClick={onCancel}
            aria-label="Close"
            style={sx(
              // Above the stickers (2) and their sparkles (3), now that the rows
              // no longer seal those into per-row stacking contexts. Insurance
              // rather than mechanism: the first row's sticker is seated clear
              // of this button's box by ~9px measured, and hiding a sticker
              // under the close button is precisely the bug that seat exists to
              // avoid. If a future seat does stray up here, the chrome wins and
              // the close button stays legible.
              `position:relative;z-index:6;width:26px;height:26px;border:1px solid ${C.border};border-radius:8px;` +
                `background:transparent;color:${C.muted};font:500 13px/1 ${SANS};cursor:pointer`,
            )}
          >
            ×
          </button>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:8px")}>
          {wallets.map((w) => (
            <WalletRow key={w.rdns} wallet={w} onChoose={onChoose} still={still} />
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
