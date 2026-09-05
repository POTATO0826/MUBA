import { describe, expect, test } from "bun:test";
import { briefsFor } from "../src/data/briefs.ts";
import { bookFor } from "../src/data/lobbies.ts";
import { DOWN_WORDS, UP_WORDS, WIRE_PER_SYM, mockWire, priceSignal } from "../src/data/wire.ts";
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

/**
 * The date the seeded wire files its session on.
 *
 * `mockWire` used to derive it from `windowSeed()` — a byte-for-byte copy of
 * the hash inside `windowLabel()` in `engine/tape.ts` — so that its datelines
 * would land inside the invented 2017–2024 "historical window" the chart cards
 * were labelled with. Two fabrications agreeing with each other, which is
 * strictly worse than one: `docs/reality-check.md` §5.10 is the version a
 * reader caught on screen, an AVAX story datelined eighteen months before
 * Avalanche launched.
 *
 * Both are gone. The fixture is now openly dated *today* — a fixture with a
 * real date rather than a fixture dressed as history — and the clock it is an
 * argument, which is what these tests hold it to.
 */
describe("mockWire — the session is dated, not invented", () => {
  /** A fixed Thursday, so the assertions below are about the code and not
   *  about the day the suite happens to run on. */
  const DAY = Date.UTC(2026, 8, 3, 14, 22, 9);

  test("every row falls on the day it was built for", () => {
    for (const salt of [1, 424242, 918273]) {
      for (const it of mockWire(MIXED, salt, briefsFor(MIXED, salt), DAY)) {
        const d = new Date(it.ts);
        expect(d.getUTCFullYear()).toBe(2026);
        expect(d.getUTCMonth()).toBe(8);
        expect(d.getUTCDate()).toBe(3);
        // One session: the feed opens and closes inside its own day, so the
        // terminal draws exactly one band over it.
        expect(it.day).toBe("THU · 09-03-26");
      }
    }
  });

  test("no row is ever datelined before the assets on it existed", () => {
    // The shape of §5.10, pinned. Nothing on this board launched before 2013
    // and the fixture may not claim a year that predates the app itself.
    for (const syms of [STOCKS, CRYPTO, MIXED]) {
      for (const salt of [1, 3, 424242, 918273, 777777]) {
        for (const it of mockWire(syms, salt, briefsFor(syms, salt))) {
          expect(new Date(it.ts).getUTCFullYear()).toBeGreaterThanOrEqual(2025);
        }
      }
    }
  });

  test("the same day and the same salt still produce a deep-equal wire", () => {
    // The clock is an argument precisely so the fixture stays pinnable: two
    // seats deriving the seeded feed on one day agree byte for byte.
    expect(mockWire(MIXED, 424242, briefsFor(MIXED, 424242), DAY)).toEqual(
      mockWire(MIXED, 424242, briefsFor(MIXED, 424242), DAY),
    );
    // …and a different day is a different session, dated as such.
    const next = mockWire(MIXED, 424242, briefsFor(MIXED, 424242), DAY + 86_400_000);
    expect(next[0]!.day).toBe("FRI · 09-04-26");
    expect(next[0]!.ts).not.toBe(mockWire(MIXED, 424242, briefsFor(MIXED, 424242), DAY)[0]!.ts);
  });

  test("the hour of day does not move the session, only the date does", () => {
    const morning = mockWire(CRYPTO, 7, briefsFor(CRYPTO, 7), Date.UTC(2026, 8, 3, 0, 0, 1));
    const night = mockWire(CRYPTO, 7, briefsFor(CRYPTO, 7), Date.UTC(2026, 8, 3, 23, 59, 59));
    expect(morning).toEqual(night);
  });
});

/**
 * What ties a story to a price, measured off its own words.
 *
 * The owner's note was that the wire should carry *"major news that's affecting
 * each crypto or stock's movements"*. The honest limit on answering that is the
 * whole design of {@link priceSignal}: nothing in this app knows whether a
 * story caused a move, so this measures the only thing a headline actually
 * contains — whether it talks about price at all — and returns the evidence
 * rather than a score. These tests hold it to that limit in both directions:
 * it must catch price copy, and it must not pretend to catch anything else.
 */
describe("priceSignal — evidence, not a score", () => {
  test("a quoted percentage, level, move word and event are each found and named", () => {
    expect(priceSignal("Solana Surges 7.4% After ETF Inflows").join(" | ")).toContain("7.4%");
    expect(priceSignal("Bitcoin Cleared $81,000 Overnight").join(" | ")).toContain("$81,000");
    expect(priceSignal("XRP tumbled into the close").some((r) => r.includes("tumble"))).toBe(true);
    expect(priceSignal("Regulator opens an SEC review").some((r) => r.includes("SEC"))).toBe(true);
  });

  test("a story with none of the three markers comes back empty", () => {
    // The stadium-logo shape: a real headline, filed under a real ticker, that
    // says nothing about price. Empty is a statement about the TEXT and never a
    // claim that the story did not move anything.
    expect(priceSignal("Florida Athletics Debuts XRP cryptocurrency logo at Ben Hill Griffin Stadium")).toEqual([]);
    expect(priceSignal("Where Will Solana Be in 5 Years?")).toEqual([]);
    expect(priceSignal("")).toEqual([]);
  });

  test("the vocabulary is word-bounded, so it cannot match inside a longer word", () => {
    // "fell" is a move word; "fellowship" is not. "fed" is an event word;
    // "federated" is not. A substring test would mark half the wire.
    expect(priceSignal("The fellowship announced its cohort")).toEqual([]);
    expect(priceSignal("A federated identity standard shipped")).toEqual([]);
  });

  test("a bare small integer is not a price level", () => {
    // "3 blockchains", "5 years" — the level rule wants a currency symbol or a
    // thousands separator, or it would fire on every headline with a number.
    expect(priceSignal("Grayscale Names 3 Blockchains Leading The Boom")).toEqual([]);
  });

  test("every seeded row carries the classifier's verdict, whatever it is", () => {
    for (const it of mockWire(MIXED, 424242, briefsFor(MIXED, 424242))) {
      expect(Array.isArray(it.signal)).toBe(true);
      // The verdict is reproducible from the row's own words — the terminal is
      // not being handed a number it cannot check.
      if (it.kind === "news") expect(it.signal).toEqual(priceSignal(`${it.headline} ${it.body}`));
    }
  });
});
