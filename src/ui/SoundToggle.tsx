import { useSyncExternalStore } from "react";
import { isSoundOn, setSoundOn, subscribeSound } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO } from "../theme.ts";

/**
 * The mute switch, self-contained: it reads and writes the sound module's own
 * preference store, so the header gains a child and not a prop. Glyph-only by
 * design — a text label would collide with the exact-label button matchers the
 * app tests use.
 */

const BTN = (on: boolean): string =>
  `width:28px;height:28px;flex:none;display:grid;place-items:center;border-radius:8px;cursor:pointer;` +
  `font:500 13px/1 ${MONO};padding:0;` +
  `border:1px solid ${on ? "rgba(200,255,0,.28)" : C.border};` +
  `background:${on ? "rgba(200,255,0,.10)" : "transparent"};color:${on ? C.accent : C.dim}`;

export function SoundToggle() {
  const on = useSyncExternalStore(subscribeSound, isSoundOn, () => true);
  return (
    <button
      type="button"
      onClick={() => setSoundOn(!on)}
      aria-label={on ? "Mute sound" : "Unmute sound"}
      aria-pressed={on}
      title={on ? "Sound on" : "Sound off"}
      style={sx(BTN(on))}
    >
      {on ? "♪" : "♪⃠"}
    </button>
  );
}
