import type { CSSProperties } from "react";

/**
 * The design source (`THETHADUEL Battles.dc.html`) expresses every style as a CSS
 * declaration string, and its logic layer *computes* those strings — a row's
 * background depends on its index, a leg's border on whether it won. Rewriting
 * each one as an object literal would fork the port from the design it came from,
 * so instead the strings survive verbatim and are converted here, once, on first
 * use. Parsed results are cached: a style string that recurs every render (most of
 * them) is parsed a single time for the life of the process.
 */
const cache = new Map<string, CSSProperties>();

function camel(prop: string): string {
  if (prop.startsWith("--")) return prop; // custom property — pass through
  const parts = prop.replace(/^-ms-/, "ms-").split("-");
  const [head, ...rest] = parts;
  return (
    (head ?? "") + rest.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("")
  );
}

export function sx(css: string | undefined | null): CSSProperties {
  if (!css) return {};
  const hit = cache.get(css);
  if (hit) return hit;

  const out: Record<string, string> = {};
  for (const decl of css.split(";")) {
    const at = decl.indexOf(":");
    if (at < 0) continue;
    const prop = decl.slice(0, at).trim();
    const value = decl.slice(at + 1).trim();
    if (!prop || !value) continue;
    out[camel(prop)] = value;
  }

  const style = out as CSSProperties;
  cache.set(css, style);
  return style;
}

/** Merge a computed style string with extra properties. */
export function sxWith(css: string | undefined | null, extra: CSSProperties): CSSProperties {
  return { ...sx(css), ...extra };
}
