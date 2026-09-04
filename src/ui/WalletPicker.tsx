import { useState } from "react";
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
 * own icon out from behind the row's top-right corner — see `WalletRow` for the
 * choreography and `styles.css` for the two loops it uses.
 */

/** The sticker tile, in px. Sized so it clears the row it launches from
 *  without reaching the modal's own edge — see `STICKER_SEAT`. */
const STICKER = 84;

/**
 * Where the sticker comes to rest, relative to the row's top-right corner.
 *
 * `right:-6` lets it hang 6px past the row into the modal's 20px of padding —
 * enough to read as "outside the row", nowhere near the modal's border, so
 * nothing ever needs clipping. `top:-26` lifts it over the row above it. The
 * row wrapper is `position:relative;z-index:0`, which makes each row its own
 * stacking context; because a hovered row is always *later* in the document
 * than the row its sticker overlaps, it paints on top without any hover-time
 * z-index juggling (and so nothing snaps back mid-retraction).
 */
const STICKER_SEAT = `top:-26px;right:-6px;width:${STICKER}px;height:${STICKER}px`;

/**
 * Sparkles, placed around the sticker's seat and staggered so they twinkle on
 * three different clocks rather than pulsing as one.
 *
 * These sit *above* the row (`z-index:2`) rather than behind it like the
 * sticker: one of them lands over the row itself, and behind the row's opaque
 * background it would simply never be seen.
 */
const SPARKS: { at: string; size: number; delay: number }[] = [
  { at: "top:-38px;right:68px", size: 12, delay: 90 },
  { at: "top:30px;right:2px", size: 9, delay: 230 },
  { at: "top:-14px;right:-8px", size: 8, delay: 350 },
];

/** The accent, at the weights the app's selected-state vocabulary already uses
 *  (`theme.pill`): a .38 border over a .10 wash. */
const HOT_BORDER = "rgba(200,255,0,.38)";
const HOT_WASH = "rgba(200,255,0,.1)";

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

/** A four-point diamond, the sparkle shape from the source motion study. */
function Spark({ size, delay, at, on }: { size: number; delay: number; at: string; on: boolean }) {
  return (
    <span
      data-wspark=""
      aria-hidden="true"
      style={sx(
        `position:absolute;${at};width:${size}px;height:${size}px;z-index:2;pointer-events:none;` +
          "opacity:0;transform:scale(.2);transition:opacity 180ms ease;" +
          (on ? `animation:vcSparkle 1500ms ease-in-out ${delay}ms infinite` : ""),
      )}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} style={sx("display:block")}>
        <path d="M12 0 L14.6 9.4 L24 12 L14.6 14.6 L12 24 L9.4 14.6 L0 12 L9.4 9.4 Z" fill={C.accent} />
      </svg>
    </span>
  );
}

/**
 * One wallet, and the sticker that springs out of it.
 *
 * The geometry, in one place, because it is the whole trick:
 *
 * - The row is a `<button>` with an opaque background at `z-index:1`; the
 *   sticker is its sibling at `z-index:0`, inside a wrapper that owns the
 *   stacking context. So the sticker is genuinely *behind* the row, and at rest
 *   it is parked (scaled to 40% about its own bottom-right corner, then nudged
 *   left and up) entirely within the row's box — invisible because the row is
 *   painted over it, not merely because its opacity is 0.
 * - On hover it travels to `STICKER_SEAT`, overshooting on the way with
 *   `cubic-bezier(.34,1.56,.64,1)`: it arrives tilted -16°, swings past +14°
 *   and settles at +10°, which is the source's spring. Nothing clips it — the
 *   modal, the rows container and the row all keep `overflow:visible`, and the
 *   seat keeps it inside the modal's padding box regardless.
 * - Once seated, an inner span picks up `vcStickerWobble` on a 440ms delay
 *   (i.e. as the launch lands) and drifts ±3.5° for as long as the pointer
 *   stays. Two elements, because a keyframe and a transition cannot share a
 *   `transform`.
 * - Leaving reverses every one of those, on a shorter, non-springy curve: a
 *   bouncing *retraction* reads as indecision rather than as recoil.
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
   * would otherwise leave two empty boxes: the row's icon and the sticker.
   * One flag, both call sites, because they share the src.
   */
  const [broken, setBroken] = useState(false);
  const hasIcon = wallet.icon !== "" && !broken;

  /** Hover state that draws things; `hot` alone still drives the colour shift
   *  under reduced motion. */
  const launched = hot && !still;

  const initial = (wallet.name.trim()[0] ?? "?").toUpperCase();

  return (
    <div
      // Owns the stacking context the sticker sits behind the row in. `z-index:0`
      // rather than `auto` so the sticker's own `z-index:0` is scoped here and
      // cannot be out-painted by a neighbouring row's button at `z-index:1`.
      style={sx("position:relative;z-index:0")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {!still && (
        <span
          data-wsticker=""
          aria-hidden="true"
          style={sx(
            `position:absolute;${STICKER_SEAT};z-index:0;pointer-events:none;` +
              // Scaling about the bottom-right corner is what tucks it *into*
              // the row: the corner it shrinks toward is the corner it emerges
              // from, so the whole tile is inside the row's box at rest.
              "transform-origin:100% 100%;" +
              (launched
                ? "opacity:1;transform:translate(0,0) scale(1) rotate(10deg);" +
                  "transition:transform 420ms cubic-bezier(.34,1.56,.64,1),opacity 150ms ease"
                : "opacity:0;transform:translate(-30px,-20px) scale(.4) rotate(-16deg);" +
                  "transition:transform 260ms cubic-bezier(.4,0,.6,1),opacity 200ms ease 60ms"),
          )}
        >
          <span
            // The wobble's own element. Its transition is what eases the
            // hand-back when the animation is removed on mouse-leave.
            style={sx(
              `display:grid;place-items:center;width:100%;height:100%;border-radius:22px;` +
                `background:${C.raised};border:1px solid ${launched ? HOT_BORDER : C.border};` +
                "box-shadow:0 18px 38px rgba(0,0,0,.6);transition:transform 300ms ease,border-color 240ms ease;" +
                (launched ? "animation:vcStickerWobble 2400ms ease-in-out 440ms infinite alternate" : ""),
            )}
          >
            {hasIcon ? (
              // Same src as the row's own icon — the browser has it cached, so
              // the sticker costs no second fetch.
              <img
                src={wallet.icon}
                alt=""
                style={sx("width:52px;height:52px;border-radius:14px;display:block")}
              />
            ) : (
              <span style={sx(`font:700 26px/1 ${MONO};color:${C.muted}`)}>{initial}</span>
            )}
          </span>
        </span>
      )}

      {!still &&
        SPARKS.map((s) => (
          <Spark key={s.at} at={s.at} size={s.size} delay={s.delay} on={launched} />
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
            "padding:10px 12px;border-radius:12px;cursor:pointer;text-align:left;border:1px solid " +
            (hot ? HOT_BORDER : C.border) +
            `;background-color:${hot ? C.cardAlt : "#0a0a0c"};` +
            // Leaning the top-right corner up, toward the sticker that just
            // pulled it. Rotation is the one part of the hover that reduced
            // motion drops — the colour shift below survives it.
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
        {/* The source's CTA — black, then brand green on hover. Here the chip
            carries that shift. The border is transparent rather than absent at
            rest so the chip does not change size when it lights up. */}
        <span
          style={sx(
            `flex:none;font:500 9px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:5px;` +
              `border:1px solid ${hot ? HOT_BORDER : "transparent"};` +
              `background-color:${hot ? HOT_WASH : "transparent"};color:${hot ? C.accent : C.dim};` +
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
        <div style={sx("display:flex;align-items:center;gap:12px;margin-bottom:16px")}>
          <span style={sx(`font:700 14px/1 ${SANS};letter-spacing:-.01em`)}>Connect a wallet</span>
          <div style={sx("flex:1")} />
          <button
            onClick={onCancel}
            aria-label="Close"
            style={sx(
              // Lifted above the rows' stacking contexts (each is `z-index:0`)
              // so the first row's sticker passes *behind* the close button
              // instead of over it. Same instinct as the sticker emerging from
              // behind the row: the chrome stays in front.
              `position:relative;z-index:2;width:26px;height:26px;border:1px solid ${C.border};border-radius:8px;` +
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
