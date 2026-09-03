import { useEffect } from "react";

/**
 * Pointer-tracked 3D tilt for any element marked `data-tilt`.
 *
 * One document-level listener drives every card rather than a listener per card:
 * the handler finds the card under the cursor, tilts it, and clears the rest. A
 * `data-tilt-layer` child lifts toward the viewer and a `data-wall` child drifts
 * the opposite way, which is what sells the depth.
 */
export function useTilt(): void {
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const target = e.target as Element | null;
      const card = target?.closest?.("[data-tilt]") as HTMLElement | null;

      for (const el of document.querySelectorAll<HTMLElement>("[data-tilt]")) {
        if (el !== card) {
          el.style.transform = "";
          el.style.boxShadow = "";
        }
      }
      if (!card) return;

      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;

      card.style.transform =
        `perspective(900px) rotateY(${(px * 13).toFixed(2)}deg) ` +
        `rotateX(${(-py * 13).toFixed(2)}deg) scale(1.025)`;
      card.style.boxShadow =
        `${(-px * 26).toFixed(1)}px ${(-py * 26 + 14).toFixed(1)}px 42px rgba(0,0,0,.6)`;

      const layer = card.querySelector<HTMLElement>("[data-tilt-layer]");
      if (layer) {
        layer.style.transform =
          `translateZ(46px) translate3d(${(-px * 18).toFixed(1)}px,${(-py * 14).toFixed(1)}px,0)`;
      }
      const wall = card.querySelector<HTMLElement>("[data-wall]");
      if (wall) {
        wall.style.transform =
          `translate3d(${(px * 26).toFixed(1)}px,${(py * 20).toFixed(1)}px,0) scale(1.14)`;
      }
    };

    const onLeave = () => {
      for (const el of document.querySelectorAll<HTMLElement>("[data-tilt]")) {
        el.style.transform = "";
        el.style.boxShadow = "";
      }
      for (const el of document.querySelectorAll<HTMLElement>("[data-wall]")) {
        el.style.transform = "";
      }
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
    };
  }, []);
}
