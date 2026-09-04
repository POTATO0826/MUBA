import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { audioAvailable, installUnlock, isSoundOn, sfx, subscribeSound } from "./engine.ts";
import type { SfxName, SfxOpts } from "./map.ts";

/**
 * The React surface: four hooks, none of which render anything or cause a
 * render. `sfx()` is fire-and-forget by design — a sound that re-rendered the
 * tree it was triggered from would be a very expensive click.
 */

/**
 * Mounted once, at the top of `App`. The listeners are capture-phase and
 * `once`, so the context is built before React's own click handler runs and
 * the first click of the session is already audible. Under happy-dom the whole
 * body is skipped: no listeners, nothing to clean up.
 */
export function useSoundUnlock(): void {
  useEffect(() => {
    if (!audioAvailable) return;
    return installUnlock();
  }, []);
}

/**
 * A stable `{ onPointerEnter }` to spread onto anything hoverable. Stability
 * matters: this lands on rows and cards that re-render on every tape tick, and
 * a fresh handler each time would churn the DOM listener.
 */
export function useSoundHover(
  name: SfxName = "ui.hover",
  opts?: SfxOpts,
): { onPointerEnter: () => void } {
  const pitch = opts?.pitch;
  const gain = opts?.gain;
  return useMemo(
    () => ({
      onPointerEnter: () => {
        sfx(name, {
          ...(pitch !== undefined ? { pitch } : {}),
          ...(gain !== undefined ? { gain } : {}),
        });
      },
    }),
    [name, pitch, gain],
  );
}

/** The mute state, for anything that draws it. */
export function useSoundEnabled(): boolean {
  return useSyncExternalStore(subscribeSound, isSoundOn, () => true);
}

/** Wrap a click handler in its sound. Arguments pass straight through. */
export function useSfxClick<A extends unknown[]>(
  name: SfxName,
  handler?: (...args: A) => void,
): (...args: A) => void {
  return useCallback(
    (...args: A) => {
      sfx(name);
      handler?.(...args);
    },
    [name, handler],
  );
}
