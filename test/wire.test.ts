import { describe, expect, test } from "bun:test";
import { briefsFor } from "../src/data/briefs.ts";
import { bookFor } from "../src/data/lobbies.ts";
import { DOWN_WORDS, UP_WORDS, WIRE_PER_SYM, mockWire } from "../src/data/wire.ts";
import { spinCase } from "../src/engine/spin.ts";
import { TAPE_LEN, fmtPx, pctAt, series } from "../src/engine/tape.ts";

/** Real books, real deals — the same call the study screen makes. */
function deal(market: "STOCK" | "CRYPTO" | "MIXED", legs: number, seed: number): readonly string[] {
  return spinCase(bookFor(market), legs, seed).syms;
}

const wireFor = (syms: readonly string[], salt: number) => mockWire(syms, salt, briefsFor(syms, salt));

// "STOCK" is deliberately not used here: plan 6 retired the fictional equity
// universe, so `bookFor("STOCK")` is permanently empty on the live board and
// `deal("STOCK", …)` would throw before a single item could be built. This is
// simply a second, differently-seeded/-sized CRYPTO deal — the live board has
// only one real market now, and the point of three separate `boards` entries
// was always variety of arena/salt, not market identity.
const STOCKS = deal("CRYPTO", 3, 424242);
const CRYPTO = deal("CRYPTO", 3, 918273);
const MIXED = deal("MIXED", 4, 100001);

const upRe = new RegExp(`\\b(${UP_WORDS.join("|")})\\b`);
const downRe = new RegExp(`\\b(${DOWN_WORDS.join("|")})\\b`);

describe("mockWire — determinism", () => {
  test("the same syms and salt produce a deep-equal wire", () => {
    expect(wireFor(MIXED, 424242)).toEqual(wireFor(MIXED, 424242));
    expect(wireFor(STOCKS, 7)).toEqual(wireFor(STOCKS, 7));
  });

  test("a different salt produces a different wire", () => {
    expect(wireFor(MIXED, 424242)).not.toEqual(wireFor(MIXED, 424243));
    const a = wireFor(STOCKS, 11).map((i) => i.headline).join("|");
    const b = wireFor(STOCKS, 12).map((i) => i.headline).join("|");
    expect(a).not.toBe(b);
  });

  test("every id is unique", () => {
    const items = wireFor(MIXED, 555);
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
});

describe("mockWire — shape", () => {
  const boards: readonly (readonly string[])[] = [STOCKS, CRYPTO, MIXED];

  test("no item ever has an empty body, dateline or signature", () => {
    for (const syms of boards) {
      for (const salt of [1, 424242, 918273, 999983]) {
        for (const it of wireFor(syms, salt)) {
          expect(it.body.length).toBeGreaterThan(40);
          expect(it.dateline.length).toBeGreaterThan(10);
          expect(it.headline.length).toBeGreaterThan(10);
          expect(it.publisher.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("the signature reads as a wire sign-off", () => {
    for (const it of wireFor(MIXED, 424242)) {
      expect(it.signature).toMatch(
        /^\(END\) .+ \/ \d{2}-\d{2}-\d{2} \d{4}ET \/ Copyright \(c\) \d{4} .+\.$/,
      );
      expect(it.signature).toContain(it.publisher);
    }
  });

  test("every time is a session clock stamp", () => {
    for (const syms of boards) {
      for (const it of wireFor(syms, 424242)) expect(it.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });

  test("the dateline carries the item's own date, time and subject", () => {
    for (const it of wireFor(MIXED, 424242)) {
      expect(it.dateline).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2} \d{2}:\d{2}:\d{2}: /);
      expect(it.dateline).toContain(it.time);
      expect(it.dateline).toContain(it.headline);
      if (it.kind === "news") expect(it.dateline).toContain(`: ${it.sym}: `);
    }
  });

  test("ts is strictly descending", () => {
    for (const syms of boards) {
      for (const salt of [3, 424242, 777777]) {
        const items = wireFor(syms, salt);
        for (let i = 1; i < items.length; i++) {
          expect(items[i]!.ts).toBeLessThan(items[i - 1]!.ts);
        }
      }
    }
  });
});

/**
 * The stamp has to be readable as an *order*, not merely be one.
 *
 * A wire is newest-first and prints `hh:mm:ss` with no date. That is fine
 * inside one session and unreadable across two: `04:08:51` above `21:23:32` is
 * a correct descent that looks like a broken one, and a time-only stamp has no
 * way to say "yesterday". `day` is what closes that hole, so these tests pin
 * that it exists, that it agrees with the row's own `ts`, and that it can only
 * ever run backwards alongside the clock it labels.
 */
describe("mockWire — the day the stamp belongs to", () => {
  const boards: readonly (readonly string[])[] = [STOCKS, CRYPTO, MIXED];

  test("every row carries a day band label, weekday and date", () => {
    for (const syms of boards) {
      for (const salt of [1, 424242, 918273]) {
        for (const it of wireFor(syms, salt)) {
          expect(it.day).toMatch(/^(SUN|MON|TUE|WED|THU|FRI|SAT) · \d{2}-\d{2}-\d{2}$/);
        }
      }
    }
  });

  test("the day agrees with the row's own ts, dateline and signature", () => {
    for (const syms of boards) {
      for (const it of wireFor(syms, 424242)) {
        const d = new Date(it.ts);
        const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(d.getUTCDate()).padStart(2, "0");
        const yy = String(d.getUTCFullYear()).slice(2);
        expect(it.day).toContain(`${mm}-${dd}-${yy}`);
        // The signature prints the same date in the same shape; the dateline
        // prints it unpadded. All three are read off one timestamp, so a drift
        // between them is a bug in whichever one moved.
        expect(it.signature).toContain(`${mm}-${dd}-${yy}`);
        expect(it.dateline.startsWith(`${Number(mm)}/${Number(dd)}/${yy} `)).toBe(true);
      }
    }
  });

  test("the day never runs forwards while the clock runs backwards", () => {
    for (const syms of boards) {
      for (const salt of [3, 424242, 777777]) {
        const items = wireFor(syms, salt);
        for (let i = 1; i < items.length; i++) {
          const prev = items[i - 1]!;
          const cur = items[i]!;
          // Same day means the printed clock must itself be descending; a new
          // day is the only licence a row has to show a *larger* hh:mm:ss than
          // the row above it — which is precisely the case the band exists for.
          if (cur.day === prev.day) expect(cur.time < prev.time).toBe(true);
        }
      }
    }
  });

  test("a run of rows changes day at most once per day-boundary crossing", () => {
    // Bands are emitted on change, so a day may not reappear after it closes —
    // that would draw two bands for one session and read as a re-sort.
    for (const syms of boards) {
      const items = wireFor(syms, 424242);
      const opened: string[] = [];
      for (const it of items) if (opened.at(-1) !== it.day) opened.push(it.day!);
      expect(new Set(opened).size).toBe(opened.length);
    }
  });

  test("the desk rows pinned on top are the newest rows, so the pin never re-orders", () => {
    // `NewsWire` renders `[...desk, ...news]`. That concatenation ignores time,
    // so it is only honest while the desk half really is the newest half — and
    // if it ever stops being, the terminal would draw a day band that runs
    // backwards. Pin it here rather than discover it on screen.
    for (const syms of [STOCKS, CRYPTO, MIXED]) {
      for (const salt of [1, 424242, 777777]) {
        const items = mockWire(syms, salt, briefsFor(syms, salt));
        const desk = items.filter((i) => i.kind === "desk");
        const news = items.filter((i) => i.kind === "news");
        expect(desk.length).toBeGreaterThan(0);
        expect(Math.min(...desk.map((d) => d.ts))).toBeGreaterThan(Math.max(...news.map((n) => n.ts)));
      }
    }
  });
});

describe("mockWire — composition", () => {
  test("the desk exchange is pinned on top, exactly one pair", () => {
    const briefs = briefsFor(MIXED, 424242);
    expect(briefs.filter((b) => b.kind === "desk")).toHaveLength(2);

    const items = mockWire(MIXED, 424242, briefs);
    const desk = items.filter((i) => i.kind === "desk");
    expect(desk).toHaveLength(2);
    expect(items.slice(0, 2)).toEqual(desk);
    expect(desk.map((d) => d.who)).toEqual(["DESK", "COACH"]);
    expect(desk.every((d) => d.sym === null && d.bodyKind === "desk-note")).toBe(true);
  });

  test("every dealt ticker gets at least three filed stories", () => {
    for (const syms of [STOCKS, CRYPTO, MIXED]) {
      const items = wireFor(syms, 424242);
      for (const sym of syms) {
        const mine = items.filter((i) => i.kind === "news" && i.sym === sym);
        expect(mine.length).toBeGreaterThanOrEqual(3);
        expect(mine).toHaveLength(WIRE_PER_SYM);
        // No template repeats inside one ticker.
        expect(new Set(mine.map((i) => i.headline)).size).toBe(mine.length);
      }
    }
  });

  test("news rows carry a seeded body and no link", () => {
    const items = wireFor(CRYPTO, 424242);
    const news = items.filter((i) => i.kind === "news");
    expect(news.length).toBe(CRYPTO.length * WIRE_PER_SYM);
    expect(news.every((i) => i.bodyKind === "seeded" && i.link === null)).toBe(true);
  });
});

describe("mockWire — the wire never contradicts the chart", () => {
  test("a ticker that rose over the study window never draws a bearish headline", () => {
    let sawUp = 0;
    let sawDown = 0;
    for (const syms of [STOCKS, CRYPTO, MIXED]) {
      for (const salt of [1, 2, 3, 424242, 918273, 100001, 777777]) {
        const items = wireFor(syms, salt);
        for (const it of items) {
          if (it.kind !== "news" || it.sym === null) continue;
          const up = pctAt(it.sym, salt, TAPE_LEN) >= 0;
          if (up) {
            sawUp++;
            expect(it.headline).toMatch(upRe);
            expect(it.headline).not.toMatch(downRe);
          } else {
            sawDown++;
            expect(it.headline).toMatch(downRe);
            expect(it.headline).not.toMatch(upRe);
          }
        }
      }
    }
    // The sweep is only meaningful if it actually saw both directions.
    expect(sawUp).toBeGreaterThan(0);
    expect(sawDown).toBeGreaterThan(0);
  });

  test("bodies quote the tape the chart is drawn from", () => {
    for (const syms of [STOCKS, CRYPTO]) {
      for (const it of wireFor(syms, 424242)) {
        if (it.kind !== "news" || it.sym === null) continue;
        const s = series(it.sym, 424242);
        const last = fmtPx(s[s.length - 1]!);
        const lo = fmtPx(Math.min(...s));
        expect(it.body).toContain(it.sym);
        // Every body prints at least one figure read straight off the window.
        expect(it.body.includes(last) || it.body.includes(lo)).toBe(true);
      }
    }
  });
});
