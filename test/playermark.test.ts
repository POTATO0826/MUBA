/**
 * The player mark — the procedural pixel glyph that replaced the initials
 * avatar (`src/components/PlayerMark.tsx`).
 *
 * Everything asserted here is a property of a pure function of a string, so
 * every assertion is exact and nothing needs a DOM, a clock or a seed argument.
 * The rendering tests go through `react-dom/server`, which is enough to check
 * that the props reach the SVG — the component has no state and no effects, so
 * there is nothing a mounted render would catch that a static one would not.
 *
 * The determinism block is the load-bearing one. A player's mark is their face
 * on five different screens, and it is derived, not stored: if the hash, the
 * bit order, the mirror or the re-roll rule moves, every player in the app
 * silently gets a new face and the ladder stops being recognisable between two
 * builds. Do not "fix" a failing pin here by updating the expected grid.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_LIT, MIN_LIT, PlayerMark, markGrid } from "../src/components/PlayerMark.tsx";
import { PERSONAS, YOU_INITIALS, YOU_NAME } from "../src/data/leaderboard.ts";
import { C } from "../src/theme.ts";

/** The sizes the app actually asks for: result row, parlay slip, ladder row,
 *  lobby card, room seat. Anything that reads well at 24 reads well above it. */
const SIZES = [24, 26, 28, 30, 44] as const;

const render = (name: string, size = 26, bg: string = C.accent): string =>
  renderToStaticMarkup(
    createElement(PlayerMark, { name, initials: "XX", bg, size }),
  );

const lit = (name: string): number =>
  markGrid(name).reduce((n, row) => n + row.filter(Boolean).length, 0);

/** A deterministic bag of names to sweep the property tests over. Seeded from
 *  an LCG rather than `Math.random` so a failure here is always reproducible. */
function names(count: number): string[] {
  let s = 123456789;
  const next = () => (s = (s * 1103515245 + 12345) % 2147483648);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = next() % 97;
    const b = next() % 9973;
    out.push(`p${a}-${b}.eth`);
  }
  return out;
}

const ROSTER = PERSONAS.map((p) => p.name);

describe("markGrid — shape", () => {
  test("every mark is 5 rows of 5", () => {
    for (const name of [...ROSTER, YOU_NAME, "", "a"]) {
      const rows = markGrid(name);
      expect(rows.length).toBe(5);
      for (const row of rows) expect(row.length).toBe(5);
    }
  });

  test("every mark is mirrored about its centre column", () => {
    // The mirror is what makes the output read as an emblem rather than as
    // static — it is a design invariant, not an implementation detail.
    for (const name of [...ROSTER, YOU_NAME, ...names(400)]) {
      for (const row of markGrid(name)) {
        expect(row[0]).toBe(row[4]!);
        expect(row[1]).toBe(row[3]!);
      }
    }
  });
});

describe("markGrid — density", () => {
  test("the whole roster lands inside the density bounds", () => {
    for (const name of [...ROSTER, YOU_NAME]) {
      const n = lit(name);
      expect(n).toBeGreaterThanOrEqual(MIN_LIT);
      expect(n).toBeLessThanOrEqual(MAX_LIT);
    }
  });

  test("2000 arbitrary names never yield an empty or a solid tile", () => {
    for (const name of names(2000)) {
      const n = lit(name);
      expect(n).toBeGreaterThanOrEqual(MIN_LIT);
      expect(n).toBeLessThanOrEqual(MAX_LIT);
    }
  });

  test("the bounds themselves are the ones the component documents", () => {
    expect(MIN_LIT).toBe(4);
    expect(MAX_LIT).toBe(21);
  });
});

describe("markGrid — determinism and distinctness", () => {
  test("the same name yields the identical grid, every call", () => {
    for (const name of [...ROSTER, YOU_NAME, ...names(200)]) {
      expect(markGrid(name)).toEqual(markGrid(name));
    }
  });

  test("the roster's thirteen marks are pairwise different", () => {
    // If two personas ever collide the fix is a different salt, not a looser
    // test: two players sharing a face is the exact failure this replaced.
    const seen = new Map<string, string>();
    for (const name of [...ROSTER, YOU_NAME]) {
      const key = markGrid(name)
        .map((row) => row.map((on) => (on ? "1" : "0")).join(""))
        .join("/");
      expect(seen.has(key)).toBe(false);
      seen.set(key, name);
    }
    expect(seen.size).toBe(ROSTER.length + 1);
  });

  test("a one-character change repaints the mark", () => {
    expect(markGrid("lexa")).not.toEqual(markGrid("lexb"));
    expect(markGrid("noor")).not.toEqual(markGrid("Noor"));
  });
});

describe("PlayerMark — rendering", () => {
  test("the same name renders byte-identical SVG twice", () => {
    for (const name of [...ROSTER, YOU_NAME]) {
      expect(render(name)).toBe(render(name));
    }
  });

  test("`kazuo.eth` at 28px is pinned", () => {
    // THIS IS THE FACE CONTRACT. A change to the hash, the bit order, the
    // mirror, the re-roll or the geometry moves this string — and with it every
    // player's mark on every screen. Fix the change, not the expectation.
    expect(markGrid("kazuo.eth").map((r) => r.map((n) => (n ? 1 : 0)).join(""))).toEqual([
      "00100",
      "01010",
      "00100",
      "01110",
      "01110",
    ]);
    const svg = render("kazuo.eth", 28, C.blue);
    expect(svg).toContain('viewBox="0 0 28 28"');
    expect(svg).toContain('fill="#38bdf8"');
    expect(svg).toContain('stroke="#38bdf84d"');
  });

  test("the size prop threads through to the box and the geometry", () => {
    for (const size of SIZES) {
      const svg = render("lexa", size);
      expect(svg).toContain(`width="${size}"`);
      expect(svg).toContain(`height="${size}"`);
      expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
      // The tile is inset half a pixel so the 1px rule sits on the grid.
      expect(svg).toContain(`width="${size - 1}"`);
      // The glyph occupies the middle 75%: one cell edge is 0.15·size.
      expect(svg).toContain(`h${Number((size * 0.15).toFixed(2))}`);
    }
  });

  test("two sizes of the same player differ only in geometry, not in glyph", () => {
    const small = markGrid("qbit");
    const big = markGrid("qbit");
    expect(small).toEqual(big);
    expect(render("qbit", 24)).not.toBe(render("qbit", 44));
  });

  test("the initials are the accessible name, not rendered text", () => {
    const svg = renderToStaticMarkup(
      createElement(PlayerMark, {
        name: YOU_NAME,
        initials: YOU_INITIALS,
        bg: C.indigo,
        size: 26,
      }),
    );
    expect(svg).toContain(`aria-label="${YOU_INITIALS} · ${YOU_NAME}"`);
    expect(svg).toContain(`title="${YOU_INITIALS} · ${YOU_NAME}"`);
    expect(svg).toContain(`data-player-mark="${YOU_NAME}"`);
    // No <text> anywhere: the letters are for assistive tech and the tooltip.
    expect(svg).not.toContain("<text");
  });

  test("the tile is near-black on every player — the accent is the glyph", () => {
    for (const p of PERSONAS) {
      const svg = renderToStaticMarkup(
        createElement(PlayerMark, { name: p.name, initials: p.initials, bg: p.bg, size: 28 }),
      );
      expect(svg).toContain(`fill="${C.panelAlt}"`);
      expect(svg).toContain(`fill="${p.bg}"`);
    }
  });
});
