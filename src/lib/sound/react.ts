import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  audioAvailable,
  installUnlock,
  isSoundOn,
  prefersReducedMotion,
  sfx,
  subscribeSound,
} from "./engine.ts";
import type { SfxName, SfxOpts } from "./map.ts";

/**
 * The React surface. Four of these five hooks render nothing and cause no
 * render — `sfx()` is fire-and-forget by design, since a sound that re-rendered
 * the tree it was triggered from would be a very expensive click. `useCountUp`
 * is the one exception: its whole job is to hand back a number that climbs.
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

// ── The debrief count-up ──────────────────────────────────────────────────

/** R6 caps the run at 24 ticks; `rCount` reads progress as `leg / 24`. */
const COUNT_STEPS = 24;
const COUNT_MS = 900;

const clock = (): number => globalThis.performance?.now?.() ?? Date.now();

/**
 * Climbs to `target` over ~`durationMs`, quantised to at most `steps` distinct
 * values, ticking `result.count` on every change and `result.count.done` once
 * at the top. The banked-PTS figure on the result screen is the only caller.
 *
 * The count-up is **decoration on a number that is already true**, so when
 * there is no audio context (happy-dom) or the viewer asked for reduced
 * motion, the hook is a pure pass-through: `target` comes back on the first
 * synchronous render, no state, no rAF, nothing to clean up. `app.test.tsx`'s
 * `/PTS/` assertion depends on exactly that.
 */
export function useCountUp(target: number, opts?: { steps?: number; durationMs?: number }): number {
  const steps = Math.max(1, Math.min(COUNT_STEPS, Math.floor(opts?.steps ?? COUNT_STEPS)));
  const durationMs = Math.max(1, opts?.durationMs ?? COUNT_MS);
  const animated =
    audioAvailable && typeof requestAnimationFrame === "function" && !prefersReducedMotion();

  const [shown, setShown] = useState(() => (animated ? 0 : target));
  // Where the next run starts: a target that changes mid-climb continues from
  // the figure on screen rather than snapping back to zero.
  const fromRef = useRef(0);

  useEffect(() => {
    if (!animated) return;
    const from = fromRef.current;
    const span = target - from;
    if (span === 0) return;

    let raf = 0;
    let bucket = 0;
    const t0 = clock();
    const frame = () => {
      const t = Math.min(1, (clock() - t0) / durationMs);
      // Ease out: the figure sprints and then settles onto its last few points.
      const eased = 1 - (1 - t) ** 3;
      const next = Math.min(steps, Math.max(bucket, Math.ceil(eased * steps)));
      if (next !== bucket) {
        bucket = next;
        const value = bucket >= steps ? target : from + Math.round(span * (bucket / steps));
        fromRef.current = value;
        setShown(value);
        // `leg` is what `rCount` reads for its 1200 → 1800Hz ramp.
        sfx("result.count", { leg: bucket });
      }
      if (t >= 1) {
        fromRef.current = target;
        setShown(target);
        sfx("result.count.done");
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [animated, target, steps, durationMs]);

  return animated ? shown : target;
}
