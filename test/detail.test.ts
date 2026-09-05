/**
 * Card detail level — plan 6 §6 (Phase E).
 *
 * Phase E is an argument before it is an API, and the argument is what this
 * file pins down. Three of its clauses are the kind that erode into a comment
 * and then out of the codebase entirely, so each is a test:
 *
 *   §E1  There is exactly ONE rank ladder — `MINNOW → FISH → SHARK → ORCA →
 *        WHALE`, owned by `src/data/rewards.ts`. This module imports it and
 *        restates neither the names nor the XP thresholds.
 *   §E2  Rank sets the OPENING DEFAULT. It never gates. Every level is
 *        reachable from every tier, in either direction, and a choice outlives
 *        the rank-up that would otherwise have moved it.
 *   §E4  (1) Never change the word for a number — SIMPLE's "70% chance" *is*
 *        delta, and one quantity keeps one term forever. (2) Max loss is not a
 *        detail level: it is on the face at SIMPLE and never leaves, at every
 *        level, above the upside figure.
 *   §E5  ITM / OTM / ATM, never the textbook noun. `IV`, never spelled out.
 *
 * The §E5 test is a SOURCE SCAN of the card components, per §9's definition of
 * done. It is written here, in the detail module's own test, deliberately
 * ahead of the card work it guards: it is the vocabulary's tripwire, and a
 * tripwire laid after the fact catches nothing.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TIERS, tierFor, type TierName } from "../src/data/rewards.ts";
import {
  CARD_CONTRACT,
  CARD_DETAILS,
  CARD_FACE_ORDER,
  DETAIL_DEFAULTS,
  DETAIL_LADDER,
  defaultDetail,
  defaultDetailForXp,
  detailRank,
  forgetDetailMemo,
  getStoredDetail,
  parseDetail,
  quantitiesAt,
  setStoredDetail,
  termFor,
  useCardDetail,
  type CardDetail,
  type CardQuantity,
} from "../src/state/detail.ts";
import { DetailToggle } from "../src/ui/DetailToggle.tsx";
import {
  ATM_BAND,
  DASH,
  FACE_TYPE,
  ParlayCardFace,
  breakevenAt,
  faceOrder,
  faceRows,
  faceText,
  itmOtmAt,
  type FaceValues,
} from "../src/components/ParlayCardFace.tsx";
import { mockMarketSource } from "../src/data/market.ts";
import { MODES } from "../src/data/modes.ts";
import {
  PARLAY_CARDS,
  PRICE_DECIMALS,
  TIER_BANDS,
  REFERENCE_MOVE,
  cardsForTicker,
  legForCard,
  legFromLiveCard,
  multipleAt,
  oddsOf,
  slotFor,
  summarize,
  type LiveCard,
} from "../src/engine/parlay.ts";
import { OPTIONS_CHIP, SETTLEMENT_NOTE, type OptionBook } from "../src/desk/optionize.ts";
import { SPOT_CHIP } from "../src/data/spot.ts";
import { SEEDED_FALLBACK_MEANS, FEED_STATE } from "../src/theme.ts";
import {
  ParlayPick,
  SEEDED_CARDS_CHIP,
  SEEDED_SETTLEMENT_NOTE,
  SEEDED_SPOT_CHIP,
  vanillaPayout,
} from "../src/views/ParlayPick.tsx";
import type { PricingRow } from "../src/types.ts";

const ROOT = join(import.meta.dir, "..");
const rel = (p: string) => relative(ROOT, p).replaceAll("\\", "/");
const abs = (p: string) => join(ROOT, ...p.split("/"));

/** Every test starts with the toggle never pressed. */
afterEach(() => {
  setStoredDetail(null);
  forgetDetailMemo();
});

// ─────────────────────────────────────────────────────────────────────────────
// §E1 — one ladder, imported, never restated
// ─────────────────────────────────────────────────────────────────────────────

describe("§E1 — MINNOW/FISH/SHARK/ORCA/WHALE is the only ladder this code knows", () => {
  test("the defaults are keyed by the real ladder, in its real order", () => {
    // Not "a ladder that happens to match" — the SAME ladder object. If a tier
    // is renamed, added or removed in `rewards.ts`, `DETAIL_DEFAULTS` is a
    // `Record<TierName, …>` and stops compiling; this asserts the runtime half.
    expect(Object.keys(DETAIL_DEFAULTS)).toEqual(TIERS.map((t) => t.name));
    expect(DETAIL_LADDER).toEqual(["MINNOW", "FISH", "SHARK", "ORCA", "WHALE"]);
    expect(DETAIL_LADDER).toEqual(TIERS.map((t) => t.name));
  });

  test("there is no second ladder and no second copy of the thresholds", async () => {
    const src = stripComments(await Bun.file(abs("src/state/detail.ts")).text());
    // The XP thresholds live in exactly one file. A number from that column
    // appearing here would be a second, drifting copy of the ladder.
    for (const t of TIERS) {
      if (t.xp === 0) continue;
      expect(src).not.toContain(String(t.xp));
    }
    // …and the arithmetic that uses them is imported, not rewritten.
    expect(src).toContain("tierFor");
  });

  test("the opening default per tier is exactly §E2's table", () => {
    const expected: Record<TierName, CardDetail> = {
      MINNOW: "SIMPLE",
      FISH: "SIMPLE",
      SHARK: "STANDARD",
      ORCA: "FULL",
      WHALE: "FULL",
    };
    for (const t of TIERS) expect(defaultDetail(t)).toBe(expected[t.name]);
  });

  test("the XP form agrees with the tier form at every threshold and either side of it", () => {
    for (const t of TIERS) {
      expect(defaultDetailForXp(t.xp)).toBe(defaultDetail(t));
      expect(defaultDetailForXp(t.xp + 1)).toBe(defaultDetail(t));
      if (t.xp > 0) expect(defaultDetailForXp(t.xp - 1)).toBe(defaultDetail(tierFor(t.xp - 1)));
    }
    // A negative or absurd total still lands on a real tier rather than throwing.
    expect(defaultDetailForXp(-1)).toBe("SIMPLE");
    expect(defaultDetailForXp(1e9)).toBe("FULL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §E2 — the default is a default; nothing is ever gated
// ─────────────────────────────────────────────────────────────────────────────

describe("§E2 — rank sets the opening default, it never gates", () => {
  test("every level is reachable from every tier, in either direction", () => {
    for (const t of TIERS) {
      for (const from of CARD_DETAILS) {
        for (const to of CARD_DETAILS) {
          setStoredDetail(from);
          setStoredDetail(to);
          // No tier, no direction, no starting point is refused. The MINNOW
          // who trades options gets FULL on the first press; the WHALE who
          // does not want greeks gets SIMPLE on the first press.
          expect(getStoredDetail()).toBe(to);
          expect(levelFor(t.name)).toBe(to);
        }
      }
    }
  });

  test("a downward move from the tier default is honoured, not snapped back", () => {
    const whale = TIERS[4];
    expect(defaultDetail(whale)).toBe("FULL");
    setStoredDetail("SIMPLE");
    expect(levelFor("WHALE")).toBe("SIMPLE");
    expect(detailRank("SIMPLE")).toBeLessThan(detailRank(defaultDetail(whale)));
  });

  test("an untouched toggle tracks the ladder; a pressed one outranks it forever", () => {
    // Never pressed: the level walks up with the player, which is the ramp.
    expect(getStoredDetail()).toBeNull();
    expect(levelFor("MINNOW")).toBe("SIMPLE");
    expect(levelFor("SHARK")).toBe("STANDARD");
    expect(levelFor("WHALE")).toBe("FULL");

    // Pressed at MINNOW: the choice survives every rank-up above it. A rank-up
    // is not new information about what someone can read.
    setStoredDetail("FULL");
    for (const t of TIERS) expect(levelFor(t.name)).toBe("FULL");
  });

  test("clearing hands the player back to the ladder", () => {
    setStoredDetail("SIMPLE");
    expect(levelFor("ORCA")).toBe("SIMPLE");
    setStoredDetail(null);
    expect(levelFor("ORCA")).toBe("FULL");
  });

  test("no gating vocabulary survives in the mechanism or the control", async () => {
    // §E2 has no `locked`, no `minTier`, no `canSee`, no `disabled`. Comments
    // are stripped first so the files may explain the rule in prose without
    // tripping over the words the rule forbids in code.
    const GATE = /\block(ed)?\b|minTier|canSee|requiresTier|disabled/i;
    for (const path of ["src/state/detail.ts", "src/ui/DetailToggle.tsx"]) {
      const src = stripComments(await Bun.file(abs(path)).text());
      expect({ file: path, hit: src.match(GATE)?.[0] ?? null }).toEqual({
        file: path,
        hit: null,
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — and the silence when there is none
// ─────────────────────────────────────────────────────────────────────────────

describe("the choice persists, and degrades silently when it cannot", () => {
  test("a choice survives a reload", () => {
    setStoredDetail("FULL");
    // A reload re-reads storage. `forgetDetailMemo` is the only honest way to
    // say that in-process: it drops the memo, so the next read hits the store.
    forgetDetailMemo();
    expect(getStoredDetail()).toBe("FULL");
    expect(globalThis.localStorage.getItem("thetaduel.cardDetail")).toBe("FULL");
  });

  test("clearing removes the key rather than storing a level", () => {
    setStoredDetail("SIMPLE");
    setStoredDetail(null);
    forgetDetailMemo();
    expect(globalThis.localStorage.getItem("thetaduel.cardDetail")).toBeNull();
    expect(getStoredDetail()).toBeNull();
  });

  test("a value the app does not recognise is 'never chosen', not a wrong level", () => {
    expect(parseDetail(null)).toBeNull();
    expect(parseDetail("")).toBeNull();
    expect(parseDetail("simple")).toBeNull(); // case matters; a near-miss is not a guess
    expect(parseDetail("EXPERT")).toBeNull(); // a level from a future build
    expect(parseDetail('{"level":"FULL"}')).toBeNull();
    for (const d of CARD_DETAILS) expect(parseDetail(d)).toBe(d);
  });

  test("storage that throws on read leaves the rank default in force", () => {
    withBrokenStorage("read", () => {
      forgetDetailMemo();
      expect(() => getStoredDetail()).not.toThrow();
      expect(getStoredDetail()).toBeNull();
      expect(levelFor("SHARK")).toBe("STANDARD");
    });
  });

  test("storage that throws on write keeps the choice for the session", () => {
    withBrokenStorage("write", () => {
      expect(() => setStoredDetail("FULL")).not.toThrow();
      // The preference did not reach the disk. It is still in force on screen,
      // which is the whole of the degradation: a preference that cannot be
      // remembered is a preference that lasts the session.
      expect(getStoredDetail()).toBe("FULL");
      expect(levelFor("MINNOW")).toBe("FULL");
    });
  });

  test("the app still renders with no storage at all", () => {
    withBrokenStorage("read", () => {
      forgetDetailMemo();
      const seen: CardDetail[] = [];
      function Probe() {
        seen.push(useCardDetail(TIERS[2]).level);
        return null;
      }
      // The rule the plan states as an absolute: the app must never fail to
      // render because a preference could not be read.
      expect(() => mount(createElement(Probe))).not.toThrow();
      expect(seen).toEqual(["STANDARD"]);
      unmount();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §E3 — the level contract
// ─────────────────────────────────────────────────────────────────────────────

describe("§E3 — what each level shows", () => {
  test("SIMPLE is direction, max loss, payout — and nothing else", () => {
    expect(quantitiesAt("SIMPLE")).toEqual(["direction", "maxLoss", "payout"]);
  });

  test("STANDARD adds strike, the odds, and ITM/OTM", () => {
    expect(added("SIMPLE", "STANDARD")).toEqual(["strike", "delta", "itmOtm"]);
  });

  test("FULL adds breakeven, the payoff curve, and the greeks", () => {
    expect(added("STANDARD", "FULL")).toEqual([
      "breakeven",
      "payoffCurve",
      "theta",
      "iv",
      "premium",
    ]);
  });

  test("the levels are cumulative — nothing a player has seen ever disappears", () => {
    for (let i = 1; i < CARD_DETAILS.length; i += 1) {
      const below = new Set(quantitiesAt(CARD_DETAILS[i - 1]!));
      const here = quantitiesAt(CARD_DETAILS[i]!);
      for (const q of below) expect(here).toContain(q);
    }
  });

  test("`from` and `face` cannot disagree about when a quantity appears", () => {
    for (const q of CARD_FACE_ORDER) {
      const spec = CARD_CONTRACT[q];
      const first = CARD_DETAILS.find((d) => spec.face[d] !== null);
      expect({ q, first }).toEqual({ q, first: spec.from });
      // And once it appears it is present at every level above.
      let seen = false;
      for (const d of CARD_DETAILS) {
        if (spec.face[d] !== null) seen = true;
        else expect({ q, d, seen }).toEqual({ q, d, seen: false });
      }
    }
  });

  test("the contract covers every quantity, exactly once, in render order", () => {
    const keys = Object.keys(CARD_CONTRACT) as CardQuantity[];
    expect([...CARD_FACE_ORDER].sort()).toEqual(keys.sort());
    expect(new Set(CARD_FACE_ORDER).size).toBe(CARD_FACE_ORDER.length);
    for (const d of CARD_DETAILS) {
      const shown = quantitiesAt(d);
      const order = CARD_FACE_ORDER.filter((q) => shown.includes(q));
      expect(shown).toEqual(order);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §E4.1 — never change the word for a number
// ─────────────────────────────────────────────────────────────────────────────

describe("§E4.1 — one quantity, one term, forever", () => {
  test("'70% chance' and 'Δ 0.70' are the same quantity, and it is called delta", () => {
    const delta = CARD_CONTRACT.delta;
    expect(delta.face.STANDARD).toBe("70% chance");
    expect(delta.face.FULL).toBe("Δ 0.70");
    // STANDARD does not rename it and FULL does not introduce a new thing —
    // FULL only reveals that it was always called delta.
    expect(termFor("delta")).toBe("delta");
    expect(delta.face.STANDARD).not.toBe(delta.face.FULL);
  });

  test("a term is a single string — there is nowhere to put a per-level synonym", () => {
    for (const q of CARD_FACE_ORDER) {
      const spec = CARD_CONTRACT[q] as unknown as Record<string, unknown>;
      expect(Object.keys(spec).sort()).toEqual(["face", "from", "term"]);
      expect(typeof spec.term).toBe("string");
      expect(String(spec.term).length).toBeGreaterThan(0);
    }
  });

  test("no two quantities share a word", () => {
    const terms = CARD_FACE_ORDER.map(termFor);
    expect(new Set(terms).size).toBe(terms.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §E4.2 — max loss is not a detail level
// ─────────────────────────────────────────────────────────────────────────────

describe("§E4.2 — max loss appears at SIMPLE and never leaves", () => {
  test("it is on the face at every level", () => {
    for (const d of CARD_DETAILS) {
      expect(CARD_CONTRACT.maxLoss.face[d]).not.toBeNull();
      expect(quantitiesAt(d)).toContain("maxLoss");
    }
    expect(CARD_CONTRACT.maxLoss.from).toBe("SIMPLE");
  });

  test("it is above the upside figure at every level", () => {
    for (const d of CARD_DETAILS) {
      const shown = quantitiesAt(d);
      const loss = shown.indexOf("maxLoss");
      const upside = shown.indexOf("payout");
      expect(loss).toBeGreaterThanOrEqual(0);
      expect(upside).toBeGreaterThanOrEqual(0);
      // Ordering, not styling: the downside is read first, at SIMPLE and at
      // FULL alike. A face built from `quantitiesAt` gets this for free.
      expect({ level: d, above: loss < upside }).toEqual({ level: d, above: true });
    }
  });

  test("max loss is not reachable by changing detail level — it is unconditional", () => {
    const everywhere = CARD_FACE_ORDER.filter((q) =>
      CARD_DETAILS.every((d) => CARD_CONTRACT[q].face[d] !== null),
    );
    expect(everywhere).toContain("maxLoss");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §E5 — say what people say (the §9 tripwire)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two banned forms.
 *
 * Neither is wrong; both are textbook. Nobody at a desk says "moneyness" out
 * loud, and on a crypto options venue "IV" *is* the word — spelling it out
 * reads as an explanation, which on a card face is a second term for a
 * quantity that already has one (§E4.1).
 */
const BANNED = [/moneyness/i, /implied\s+vol(atility)?/i];

/**
 * The scanned set: the surfaces that put words in front of a player about a
 * parlay card.
 *
 * Globbed, not listed, so a card component that lands next wave is covered the
 * moment it appears — the file names below are today's members, not the rule.
 * Deliberately NOT scanned: `src/data/spot.ts` and `src/desk/optionize.ts`,
 * which use the textbook noun as a maths variable behind the boundary and
 * never render a word.
 */
function cardSurfaces(): readonly string[] {
  const globs: readonly [string, string][] = [
    ["src/views", "Parlay*.tsx"],
    ["src/components", "*Card*.tsx"],
    ["src/ui", "DetailToggle.tsx"],
    ["src/state", "detail.ts"],
  ];
  const out: string[] = [];
  for (const [dir, pattern] of globs) {
    out.push(...new Bun.Glob(pattern).scanSync({ cwd: abs(dir), absolute: true }));
  }
  return out.sort();
}

/**
 * Comments out, everything else in.
 *
 * The rule is about the words a player reads, so a builder's note explaining
 * that a ratio *is* the textbook quantity is fine and a label, prop, test id or
 * variable carrying that word is not — those all reach a screen sooner or
 * later, and the ones that do not still teach the next reader the wrong word.
 * Quoted text is preserved verbatim (including its `//`), which is what makes
 * this safe to run over JSX.
 */
function stripComments(src: string): string {
  let out = "";
  let quote: string | null = null;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += "  ";
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

describe("§E5 — ITM/OTM/ATM, and IV is never spelled out", () => {
  test("the scan actually covers the card surfaces", () => {
    const files = cardSurfaces().map(rel);
    // A broken glob returning [] would make the scan below pass vacuously.
    expect(files.length).toBeGreaterThanOrEqual(4);
    expect(files).toContain("src/views/ParlayPick.tsx");
    expect(files).toContain("src/ui/DetailToggle.tsx");
    expect(files).toContain("src/state/detail.ts");
  });

  test("the comment stripper keeps code and drops only commentary", () => {
    expect(stripComments("const a = 1; // moneyness\n")).toBe("const a = 1; \n");
    expect(stripComments("/* moneyness */const a = 1;")).toBe("const a = 1;");
    expect(stripComments('const u = "https://x/y"; // gone')).toBe('const u = "https://x/y"; ');
    expect(stripComments('const s = "moneyness";')).toBe('const s = "moneyness";');
    expect(stripComments("const j = <b>implied volatility</b>;")).toBe(
      "const j = <b>implied volatility</b>;",
    );
  });

  test("no card component says 'moneyness' or spells out 'implied volatility'", async () => {
    const offenders: string[] = [];
    for (const path of cardSurfaces()) {
      const src = stripComments(await Bun.file(path).text());
      // Non-vacuity: a stripper that ate the file would find nothing in it.
      const raw = (await Bun.file(path).text()).length;
      expect(src.length).toBeGreaterThan(raw * 0.2);
      for (const re of BANNED) {
        const hit = src.match(re);
        if (hit) offenders.push(`${rel(path)} → ${hit[0]}`);
      }
    }
    // One quantity, one term. `ITM` / `OTM` / `ATM` is what a desk says; `IV`
    // is what a crypto options venue says. Neither has a longer form on a card.
    expect(offenders).toEqual([]);
  });

  test("the contract's own vocabulary is the vocabulary the scan enforces", () => {
    expect(termFor("itmOtm")).toBe("ITM/OTM/ATM");
    expect(termFor("iv")).toBe("IV");
    for (const q of CARD_FACE_ORDER) {
      const spec = CARD_CONTRACT[q];
      const words = [spec.term, ...CARD_DETAILS.map((d) => spec.face[d] ?? "")].join(" ");
      for (const re of BANNED) expect({ q, hit: words.match(re)?.[0] ?? null }).toEqual({
        q,
        hit: null,
      });
    }
  });

  test("the ban is narrow — it must not swallow the words we DO want", () => {
    const keep = ["OTM", "ITM", "ATM", "IV 58%", "Δ 0.70", "θ −0.4", "breakeven", "premium"];
    for (const word of keep) for (const re of BANNED) expect(re.test(word)).toBe(false);
    // …and it really does catch the two forms it names.
    expect(BANNED.some((re) => re.test("the card's moneyness"))).toBe(true);
    expect(BANNED.some((re) => re.test("Implied Volatility 58%"))).toBe(true);
    expect(BANNED.some((re) => re.test("implied vol"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The face — §E3/§E4 as rendered DOM, not as a table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A market-priced card: every figure the book supplies, supplied.
 *
 * `mult` and `winAt` are the two quantities the face keeps apart, and this
 * fixture is honest about both. `mult` is `oddsOf(prob)` — 1/0.70 = ×1.43,
 * fair odds that a 70-delta call lands — and `winAt` is the contract's own
 * example payout, `WIN $160`, which is `premium × payoutMult` = 40 × 4. They
 * are 1.43 and 4 here and hundreds apart on a real DEGEN card; that they are
 * two fields is the point.
 */
const LIVE_FACE: FaceValues = {
  stance: "bull",
  strike: 4200,
  spot: 4000,
  prob: 0.7,
  mult: oddsOf(0.7),
  premium: 40,
  winAt: 160,
  theta: -0.4,
  iv: 0.58,
};

/** A seeded card: a real line and a real chance, and no premium anywhere — so
 *  no dollar payout either, and the `×` is all it knows. */
const SEEDED_FACE: FaceValues = {
  ...LIVE_FACE,
  premium: null,
  winAt: null,
  theta: null,
  iv: null,
};

/** The `data-q` of every quantity the face put on screen, top to bottom. */
const rendered = (): readonly CardQuantity[] =>
  [...container.querySelectorAll<HTMLElement>("[data-q]")].map(
    (el) => el.getAttribute("data-q") as CardQuantity,
  );

/** The text a quantity rendered. */
const valueOf = (q: CardQuantity): string =>
  container.querySelector(`[data-q="${q}"]`)?.textContent ?? "";

/** The type size a rendered quantity is set in, off its own style attribute. */
function sizeOf(q: CardQuantity): number {
  const style = container.querySelector(`[data-q="${q}"]`)?.getAttribute("style") ?? "";
  const hit = /(\d+(?:\.\d+)?)px/.exec(style);
  expect({ q, style }).toEqual({ q, style: hit ? style : "no px size found" });
  return Number(hit![1]);
}

function face(level: CardDetail, values: FaceValues = LIVE_FACE) {
  mount(createElement(ParlayCardFace, { level, values, accent: "#c8ff00", testKey: "ETH:safe-bull" }));
}

describe("§E3 — the face is rendered from the contract, never from a level branch", () => {
  test("what reaches the DOM at each level is exactly what `quantitiesAt` names", () => {
    for (const level of CARD_DETAILS) {
      face(level);
      // Same set, every time — the face may group quantities onto one line but
      // it may not add one the contract withheld or drop one it granted.
      expect({ level, shown: [...rendered()].sort() }).toEqual({
        level,
        shown: [...quantitiesAt(level)].sort(),
      });
      // …and the DOM order is the order `faceRows` derived from the contract.
      expect({ level, order: rendered() }).toEqual({ level, order: faceOrder(level) });
      unmount();
    }
  });

  test("no view in the tree decides the face by testing the level", async () => {
    // The contract is the single source of truth precisely so a face cannot
    // drift from it. A `switch (level)` — or any comparison of the level to a
    // literal — is how that drift starts, so neither surface may contain one.
    for (const path of ["src/components/ParlayCardFace.tsx", "src/views/ParlayPick.tsx"]) {
      const src = stripComments(await Bun.file(abs(path)).text());
      expect({ path, hit: /switch\s*\(\s*level/.test(src) }).toEqual({ path, hit: false });
      for (const d of CARD_DETAILS) {
        expect({ path, d, hit: src.includes(`"${d}"`) }).toEqual({ path, d, hit: false });
      }
    }
  });

  test("SIMPLE really is three lines, and FULL adds without removing", () => {
    face("SIMPLE");
    expect(rendered()).toEqual(["direction", "maxLoss", "payout"]);
    unmount();
    face("FULL");
    for (const q of ["direction", "maxLoss", "payout"] as const) expect(rendered()).toContain(q);
    expect(rendered()).toContain("payoffCurve");
    unmount();
  });

  test("the greeks are one line, in the contract's order", () => {
    face("FULL");
    const strip = faceRows("FULL").find((r) => r.length > 1);
    expect(strip).toEqual(["delta", "theta", "iv"]);
    // One line means one parent: the three spans hang off the same row.
    const rows = (["delta", "theta", "iv"] as const).map(
      (q) => container.querySelector(`[data-q="${q}"]`)!.parentElement!.parentElement,
    );
    expect(new Set(rows).size).toBe(1);
    expect(valueOf("delta")).toBe("Δ 0.70");
    unmount();
  });
});

describe("§E4.1 — the face prints the contract's own words", () => {
  /**
   * Fed the contract's example numbers, the view must produce the contract's
   * example strings — character for character. This is the tie that stops a
   * synonym ever appearing on a card: to reword the face you must reword
   * `CARD_CONTRACT`, and `CARD_CONTRACT` is what §E5's scan reads.
   */
  const CASES: readonly (readonly [CardQuantity, CardDetail, FaceValues])[] = [
    ["maxLoss", "SIMPLE", LIVE_FACE],
    ["maxLoss", "FULL", LIVE_FACE],
    ["payout", "SIMPLE", LIVE_FACE],
    ["strike", "STANDARD", LIVE_FACE],
    ["strike", "FULL", LIVE_FACE],
    ["delta", "STANDARD", LIVE_FACE],
    ["delta", "FULL", LIVE_FACE],
    ["itmOtm", "STANDARD", LIVE_FACE],
    ["breakeven", "FULL", { ...LIVE_FACE, premium: 140 }],
    ["theta", "FULL", LIVE_FACE],
    ["iv", "FULL", LIVE_FACE],
    ["premium", "FULL", { ...LIVE_FACE, premium: 18 }],
  ];

  test("every quantity the contract states as a string is rendered as that string", () => {
    for (const [q, level, values] of CASES) {
      expect({ q, level, text: faceText(q, level, values)?.value ?? null }).toEqual({
        q,
        level,
        text: CARD_CONTRACT[q].face[level],
      });
    }
  });

  test("the two quantities the table cannot pin are pinned here instead", () => {
    // `direction` — this app's one word for it is BULL/BEAR, on the tier label,
    // in `slipLabel` and on the result screen. The contract table's `LONG /
    // SHORT` is illustrative; printing it on the card would be the second word
    // for one quantity that §E4.1 forbids.
    expect(faceText("direction", "SIMPLE", LIVE_FACE)?.value).toBe("↑ BULL");
    expect(faceText("direction", "FULL", { ...LIVE_FACE, stance: "bear" })?.value).toBe("↓ BEAR");
    // `payoffCurve` is a drawing, so it has no string at all.
    expect(faceText("payoffCurve", "FULL", LIVE_FACE)).toBeNull();
    face("FULL");
    expect(container.querySelector("svg")).not.toBeNull();
    unmount();
  });

  test("the curve is drawn in two runs — the loss leg and the win leg", () => {
    // The breakeven is the zero crossing by construction, so it must land on
    // both runs. Left to float error it lands on neither and the winning half
    // of the curve silently disappears; this is that regression, pinned.
    face("FULL");
    const runs = [...container.querySelectorAll("polyline")];
    expect(runs.length).toBe(2);
    expect(runs[0]!.getAttribute("stroke")).toBe("#f87171"); // C.red, below zero
    expect(runs[1]!.getAttribute("stroke")).toBe("#c8ff00"); // the accent, above
    unmount();

    // A card whose breakeven is past the drawn band never turns a profit on
    // screen, so it is one run and it is all loss.
    face("FULL", { ...LIVE_FACE, strike: 9000, premium: 40 });
    expect([...container.querySelectorAll("polyline")].length).toBe(1);
    unmount();
  });

  test("delta is one number wearing one name — the contract picks the rendering", () => {
    // 0.70 at both levels. Only the rendering moves, and it moves because
    // `CARD_CONTRACT.delta.face[level]` says so, not because the view branched.
    expect(faceText("delta", "STANDARD", LIVE_FACE)?.value).toBe("70% chance");
    expect(faceText("delta", "FULL", LIVE_FACE)?.value).toBe("Δ 0.70");
    expect(termFor("delta")).toBe("delta");
  });

  test("ITM / OTM / ATM, from the strike and the spot", () => {
    // A long call is in the money below its strike; a long put, above it.
    expect(itmOtmAt("bull", 3800, 4000)).toBe("ITM");
    expect(itmOtmAt("bull", 4200, 4000)).toBe("OTM");
    expect(itmOtmAt("bear", 4200, 4000)).toBe("ITM");
    expect(itmOtmAt("bear", 3800, 4000)).toBe("OTM");
    // Inside the band, neither — and the band is symmetric.
    expect(itmOtmAt("bull", 4000 * (1 + ATM_BAND / 2), 4000)).toBe("ATM");
    expect(itmOtmAt("bear", 4000 * (1 - ATM_BAND / 2), 4000)).toBe("ATM");
    // No spot, no claim.
    expect(itmOtmAt("bull", 4200, 0)).toBe(DASH);
  });

  test("breakeven is the strike moved by the premium, the buyer's way", () => {
    expect(breakevenAt("bull", 4200, 140)).toBe(4340);
    expect(breakevenAt("bear", 4200, 140)).toBe(4060);
  });
});

describe("§A7 — the downside is read first, and never in smaller type", () => {
  test("max loss is above the payout in the rendered DOM at every level", () => {
    for (const level of CARD_DETAILS) {
      face(level);
      const order = rendered();
      expect({ level, above: order.indexOf("maxLoss") < order.indexOf("payout") }).toEqual({
        level,
        above: true,
      });
      unmount();
    }
  });

  test("and it is never set smaller than the upside figure", () => {
    // Stated once, in the component, so the clause cannot erode into a style
    // string nobody reads.
    expect(FACE_TYPE.maxLoss).toBeGreaterThanOrEqual(FACE_TYPE.payout);
    for (const level of CARD_DETAILS) {
      face(level);
      expect({ level, loss: sizeOf("maxLoss"), win: sizeOf("payout") }).toEqual({
        level,
        loss: FACE_TYPE.maxLoss,
        win: FACE_TYPE.payout,
      });
      unmount();
    }
  });

  test("no tooltip, no hover, no press — it is on the face as text", () => {
    face("SIMPLE");
    const el = container.querySelector('[data-q="maxLoss"]')!;
    expect(el.textContent).toBe("MAX LOSS $40");
    expect(el.getAttribute("title")).toBeNull();
    expect(container.querySelector('[data-testid="max-loss-ETH:safe-bull"]')).not.toBeNull();
    unmount();
  });
});

describe("a card with no live premium says so rather than inventing one", () => {
  test("the figures the book did not supply are dashes, at every level", () => {
    face("FULL", SEEDED_FACE);
    expect(valueOf("maxLoss")).toBe(`MAX LOSS ${DASH}`);
    expect(container.querySelector('[data-testid="max-loss-ETH:safe-bull"]')?.textContent).toContain(
      "no live premium",
    );
    expect(valueOf("breakeven")).toBe(`B/E ${DASH}`);
    expect(valueOf("premium")).toBe(`${DASH} premium`);
    // The curve's offset IS the premium, so without one there is no curve to
    // draw — an invented one would show no loss region at all.
    expect(container.querySelector("svg")).toBeNull();
    expect(valueOf("payoffCurve")).toBe(`payoff curve ${DASH}`);
    // The upside is all the seeded card knows, and it is a multiple — fair
    // odds on the chance above it, 1/0.70, and never a payout ratio.
    expect(valueOf("payout")).toBe(`×${oddsOf(0.7).toFixed(2)}`);
    expect(valueOf("payout")).toBe("×1.43");
    // The line and the chance are real on both paths, so neither is dashed.
    expect(valueOf("strike")).toBe("$4,200 strike");
    expect(valueOf("delta")).toBe("Δ 0.70");
    unmount();
  });

  test("θ and IV are dashed because nothing in the feed carries them yet", () => {
    face("FULL", SEEDED_FACE);
    expect(valueOf("theta")).toBe(`θ ${DASH}`);
    expect(valueOf("iv")).toBe(`IV ${DASH}`);
    unmount();
  });
});

describe("the parlay screen wears the toggle and the faces obey it", () => {
  const OPPONENT = { name: "KZ", initial: "K", bg: "#6366f1" };

  function pickScreen() {
    const arena = ["BTC"] as const;
    const legs = arena.map((s) => legForCard(s, PARLAY_CARDS[0]!));
    mount(
      createElement(ParlayPick, {
        lobbyName: "T",
        source: mockMarketSource,
        mode: MODES.NORMAL,
        opponent: OPPONENT,
        arena,
        picks: {},
        allPicked: false,
        secondsLeft: null,
        myLegs: legs,
        summary: summarize(legs, 100),
        stakePoints: 100,
        prizeLabel: "1,000",
        onPick: () => {},
        onLock: () => {},
      }),
    );
  }

  test("the control is on the surface, and it moves every card at once", () => {
    pickScreen();
    // SHARK's opening default — `PLAYER.xp` is what `useLedger` opens at.
    expect(container.querySelector('[data-testid="detail-STANDARD"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
    const cards = () => [...container.querySelectorAll("[data-parlay]")];
    expect(cards().length).toBe(PARLAY_CARDS.length);
    const quantities = (card: Element) =>
      [...card.querySelectorAll("[data-q]")].map((el) => el.getAttribute("data-q"));
    for (const card of cards()) expect(quantities(card)).toEqual([...faceOrder("STANDARD")]);

    // One press, from any rank, and every face on the screen changes with it.
    click("detail-FULL");
    for (const card of cards()) expect(quantities(card)).toEqual([...faceOrder("FULL")]);
    click("detail-SIMPLE");
    for (const card of cards()) expect(quantities(card)).toEqual([...faceOrder("SIMPLE")]);
    unmount();
  });

  test("every card on the screen shows its max loss above its payout", () => {
    pickScreen();
    click("detail-FULL");
    for (const card of container.querySelectorAll("[data-parlay]")) {
      const order = [...card.querySelectorAll("[data-q]")].map((el) => el.getAttribute("data-q"));
      expect(order.indexOf("maxLoss")).toBeLessThan(order.indexOf("payout"));
      // The seeded board has no premium anywhere, and the face says so on all
      // eight cards rather than dealing a number the book never quoted.
      expect(card.querySelector('[data-q="maxLoss"]')?.textContent).toBe(`MAX LOSS ${DASH}`);
    }
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plan6 §9 items 2 and 8 — the live card path, on screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two claims this block exists to make true of the RUNNING SCREEN rather
 * than of a unit test (`docs/plan6-audit.md` items 2 and 8):
 *
 *  - **provenance** — a rendered multiplier is `multipleAt(card, spot,
 *    REFERENCE_MOVE, calculatePayout)`, i.e. the protocol's payout arithmetic
 *    over the ask a buyer actually pays. Asserted by *equality with the engine
 *    function*, not by a copied literal, and additionally against the number the
 *    retired path would have printed — so this cannot pass by coincidence.
 *  - **the dead slot** — a tier/stance no resting order backs renders dead, in
 *    the position it would have occupied, and is not pressable.
 */
describe("the live card path — the multiplier's provenance and the dead slot", () => {
  const OPPONENT = { name: "KZ", initial: "K", bg: "#6366f1" };
  const SPOT = 2000;
  const EXPIRY = 1_788_595_200;

  /** One fillable live row, the shape `buildSnapshot` builds. */
  function liveRow(o: {
    type: "CALL" | "PUT";
    strike: number;
    delta: number;
    ask: number;
  }): PricingRow {
    return {
      type: o.type,
      strike: o.strike.toLocaleString("en-US"),
      expiry: "12 SEP",
      bid: (o.ask * 0.98).toFixed(4),
      ask: o.ask.toFixed(4),
      iv: "58.2%",
      delta: o.delta.toFixed(2),
      depth: 40,
      size: "10.0k",
      structure: o.type,
      order: {
        order: { price: "1", isBuyer: false, expiry: String(EXPIRY) },
        rawApiData: {
          strikes: [String(Math.round(o.strike * 10 ** PRICE_DECIMALS))],
          isCall: o.type === "CALL",
        },
      },
    };
  }

  /**
   * Three orders, three tiers, five holes.
   *
   * SAFE bull (Δ0.70), SHARP bull (Δ0.30) and DEGEN bear (Δ|0.20|) are backed;
   * nothing backs EVEN on either side, SAFE/SHARP bear, or DEGEN bull. That is
   * a completely ordinary shape for a book on Base — one side of a wing is
   * simply not quoted — and it is the shape the dead slot exists for.
   */
  const CHAIN = [
    liveRow({ type: "CALL", strike: 1900, delta: 0.7, ask: 60 }),
    liveRow({ type: "CALL", strike: 2100, delta: 0.3, ask: 20 }),
    liveRow({ type: "PUT", strike: 1850, delta: -0.2, ask: 15 }),
  ];

  const BOOK: OptionBook = {
    at: 1_788_500_000_000,
    source: "live",
    spot: { ETH: SPOT },
    chain: { ETH: CHAIN },
  };

  /**
   * `pick` mirrors `src/state/match.ts` exactly: deal the ticker off the frozen
   * book, then derive the leg from the card it dealt. That is what makes the
   * header and the slip below assert the numbers the app really renders rather
   * than numbers this file computed a second way.
   */
  function pickScreen(book?: OptionBook, pickId?: string) {
    const arena = ["ETH"] as const;
    const picked = pickId ? PARLAY_CARDS.find((c) => c.id === pickId)! : null;
    const dealt = book
      ? cardsForTicker("ETH", book.chain.ETH ?? [], book.spot.ETH ?? 0, vanillaPayout)
      : null;
    const legs = arena.map((sym) => {
      const seeded = legForCard(sym, picked ?? PARLAY_CARDS[0]!);
      const card = picked ? slotFor(dealt, picked.tier, picked.stance) : null;
      return card ? legFromLiveCard(seeded, card, book?.spot[sym] ?? 0) : seeded;
    });
    mount(
      createElement(ParlayPick, {
        lobbyName: "T",
        source: mockMarketSource,
        book,
        mode: MODES.NORMAL,
        opponent: OPPONENT,
        arena,
        picks: picked ? { ETH: picked } : {},
        allPicked: picked !== null,
        secondsLeft: null,
        myLegs: legs,
        summary: summarize(legs, 100),
        stakePoints: 100,
        prizeLabel: "1,000",
        onPick: () => {},
        onLock: () => {},
      }),
    );
  }

  /** The whole payout row. With a premium on the face it reads `WIN $400` with
   *  the reference move as its aside; with none it is the multiple alone — so
   *  the row is the thing to read, and the figure is asserted inside it. */
  const payoutOf = (id: string) =>
    container.querySelector(`[data-testid="payout-ETH:${id}"]`)?.textContent ?? "";

  const slot = (id: string) =>
    container.querySelector<HTMLElement>(`[data-parlay="ETH:${id}"]`) ??
    container.querySelector<HTMLElement>(`[data-parlay-dead="ETH:${id}"]`);

  /** The engine's own answer for the fixture's SHARP BULLISH card, computed
   *  here from the same inputs the screen was handed. Equality with THIS is
   *  the provenance claim; a literal would only pin today's arithmetic. */
  const SHARP: LiveCard = {
    ...PARLAY_CARDS.find((c) => c.id === "sharp-bull")!,
    underlying: "ETH",
    strike: "2,100",
    strikeAt: 2100,
    expiry: "12 SEP",
    expiryAt: EXPIRY,
    prob: 0.3,
    premium: 20,
    odds: oddsOf(0.3),
    payoutMult: 0,
    mark: null,
    row: CHAIN[1]!,
  };

  test("a dealt card's payout is exactly `multipleAt` over the live ask — in dollars, not the retired ratio", () => {
    pickScreen(BOOK);

    const expected = multipleAt(SHARP, SPOT, REFERENCE_MOVE, vanillaPayout);
    // Worked by hand as well: ETH 2,000 +25% settles at 2,500; a 2,100 call is
    // worth 400 there; at a 20 premium that is ×20.
    expect(expected).toBeCloseTo(20, 8);
    // `calculatePayout` still reaches the screen — plan 6 §9 item 2 — and it
    // reaches it as MONEY: 20 of premium at ×20 is $400. The multiple's full
    // magnitude is in that figure; nothing is clamped and nothing is dropped.
    expect(payoutOf("sharp-bull")).toContain(`$${(20 * expected).toFixed(0)}`);
    expect(payoutOf("sharp-bull")).toContain("$400");
    // The basis, beside it, rather than a ratio — see the mixed-basis suite.
    expect(payoutOf("sharp-bull")).toContain("payout at ±25%");

    // …and it is NOT what the screen printed before. `desk/optionize`'s
    // `multiplierFor` reads 0.25 × 2100/2000 ÷ 20 = 0.013, clamped up to its
    // MULT_MIN floor of 1.05 — the hand-rolled ratio plan 6 §9.2 retired. The
    // seeded fallback (`tierOdds("SHARP")` = 1/0.35) would print ×2.86.
    expect(payoutOf("sharp-bull")).not.toContain("×1.05");
    expect(payoutOf("sharp-bull")).not.toContain("×2.86");

    // The max loss beside it is the ask itself, which is what a bought option
    // can cost you and not a cent more.
    expect(text("max-loss-ETH:sharp-bull")).toContain("20");
    unmount();
  });

  /**
   * The mixed-basis guard, on the rendered DOM.
   *
   * A board deals ETH beside tickers with no options book, so a live grid and a
   * seeded grid are on screen together — always. The seeded card's headline is
   * `×tierOdds`, fair odds on a band midpoint. If a live card printed
   * `×payoutMult` — `calculatePayout ÷ premium`, which on a cheap far-OTM call
   * runs into the hundreds — a player would read the two as one quantity and
   * conclude the live bet was a hundred times better. It is not; it is an
   * answer to a different question.
   *
   * So: **no `×` on a live face at all**, and the payout multiple appears in
   * dollars with its basis printed beside it. Not clamped — plan 6 retired a
   * clamped ratio for exactly this reason and a `Math.min` here would be the
   * same mistake wearing new clothes.
   */
  test("a live card prints no bare `×` — the multiple is money, and the odds are the chance", () => {
    pickScreen(BOOK);

    // The live payout row is a dollar figure and a basis. No `×` anywhere in it.
    const live = payoutOf("sharp-bull");
    expect(live).toContain("$400");
    expect(live).not.toContain("×");
    // The seeded control, at the same detail level, in the grid below: `×` is
    // still the seeded card's headline, and it still means fair odds.
    unmount();
    pickScreen();
    expect(payoutOf("sharp-bull")).toBe("×2.86");
    unmount();
  });

  test("the `×` a live card DOES put on screen is odds, on the same basis as the seeded card", () => {
    pickScreen(BOOK, "sharp-bull");
    // The ticker header prints the picked card's multiple, directly above a
    // grid that may be live while the next ticker's is seeded. It is
    // `oddsOf(|delta|)` = 1/0.30 = ×3.33 — NOT `payoutMult` (×20), and not the
    // seeded band midpoint (×2.86).
    const header = container.querySelector('[data-leg-picker="ETH"]')?.textContent ?? "";
    expect(header).toContain(`×${oddsOf(0.3).toFixed(2)}`);
    expect(header).toContain("×3.33");
    expect(header).not.toContain("×20.00");
    expect(header).not.toContain("×2.86");
    // And the slip's leg row, which is the column a player adds up.
    const slipLeg = container.querySelector('[data-leg="ETH"]')?.textContent ?? "";
    expect(slipLeg).toContain("×3.3");
    expect(slipLeg).not.toContain("×20");
    unmount();
  });

  test("every dealt card carries its own provenance line, with the stated reference move", () => {
    pickScreen(BOOK);
    const line = container.querySelector('[data-testid="option-ETH:sharp-bull"]')?.textContent ?? "";
    expect(line).toContain("ETH 2,100 CALL");
    expect(line).toContain("Δ0.30");
    expect(line).toContain("exp 12 SEP");
    // The convention the multiple was read at, on the card as well as in the
    // engine's docblock — it is a stated convention, not something the market
    // said.
    expect(line).toContain(`±${Math.round(REFERENCE_MOVE * 100)}%`);
    unmount();
  });

  test("a tier no resting order backs renders a dead slot, in place, and cannot be pressed", () => {
    pickScreen(BOOK);

    // The grid still holds exactly eight slots, in `PARLAY_CARDS` order.
    const grid = [
      ...container.querySelectorAll<HTMLElement>("[data-parlay],[data-parlay-dead]"),
    ];
    expect(grid).toHaveLength(PARLAY_CARDS.length);
    expect(
      grid.map((el) => el.dataset.parlay ?? el.dataset.parlayDead),
    ).toEqual(PARLAY_CARDS.map((c) => `ETH:${c.id}`));

    // Three backed, five dead — and the five are the ones with no order.
    const dealt = [...container.querySelectorAll("[data-parlay]")].map(
      (el) => (el as HTMLElement).dataset.parlay,
    );
    expect(dealt).toEqual(["ETH:safe-bull", "ETH:sharp-bull", "ETH:degen-bear"]);

    // A missing DEGEN BULLISH is a true statement about the book (plan 6 §A4
    // step 6): it says so, it is not a button, and pressing is not on offer.
    const dead = slot("degen-bull")!;
    expect(dead).not.toBeNull();
    expect(dead.tagName).not.toBe("BUTTON");
    expect(dead.querySelector("button")).toBeNull();
    expect(dead.getAttribute("aria-disabled")).not.toBeNull();
    expect(dead.textContent).toContain("NOT DEALT");
    // …and the header chip agrees with the grid under it.
    expect(text("book-state-ETH")).toBe("LIVE");
    unmount();
  });

  test("with no book the screen is the seeded screen — eight cards, no dead slot", () => {
    pickScreen();
    expect(container.querySelectorAll("[data-parlay]")).toHaveLength(PARLAY_CARDS.length);
    expect(container.querySelectorAll("[data-parlay-dead]")).toHaveLength(0);
    // Seeded fair odds on SHARP's band midpoint: 1/0.35 = ×2.86.
    expect(payoutOf("sharp-bull")).toBe("×2.86");
    expect(container.querySelector('[data-testid="option-ETH:sharp-bull"]')).toBeNull();
    unmount();
  });

  test("a chain with no fillable order deals nothing, and that ticker stays seeded", () => {
    // The seeded fixtures are exactly this: rendered rows, no `order`. A book
    // that cannot back a single card must not empty the grid — it must leave
    // the ticker exactly where it was, and the chip must say SEEDED rather than
    // labelling seeded cards LIVE.
    const unfillable: OptionBook = {
      at: 1,
      source: "live",
      spot: { ETH: SPOT },
      chain: { ETH: mockMarketSource.pricing("ETH") },
    };
    pickScreen(unfillable);
    expect(container.querySelectorAll("[data-parlay]")).toHaveLength(PARLAY_CARDS.length);
    expect(container.querySelectorAll("[data-parlay-dead]")).toHaveLength(0);
    expect(payoutOf("sharp-bull")).toBe("×2.86");
    expect(text("book-state-ETH")).toBe("SEEDED");
    unmount();
  });

  // ── the flag off, and the seeded ticker beside a live one ─────────────────

  /**
   * Two tickers, one of which the book prices and one of which it never will.
   * That is the real board — the reel deals up to five names and only ETH and
   * BTC have an options book — and it is the configuration the mixed-basis
   * question is actually about.
   */
  function board(book?: OptionBook, marketError?: string) {
    const arena = ["ETH", "AAPL"] as const;
    const legs = arena.map((sym) => legForCard(sym, PARLAY_CARDS[0]!));
    mount(
      createElement(ParlayPick, {
        lobbyName: "T",
        source: mockMarketSource,
        book,
        marketError: marketError ?? null,
        mode: MODES.NORMAL,
        opponent: OPPONENT,
        arena,
        picks: {},
        allPicked: false,
        secondsLeft: null,
        myLegs: legs,
        summary: summarize(legs, 100),
        stakePoints: 100,
        prizeLabel: "1,000",
        onPick: () => {},
        onLock: () => {},
      }),
    );
  }

  /** Every card face in one ticker's grid, as markup. */
  const grid = (sym: string) =>
    [...container.querySelectorAll<HTMLElement>(`[data-parlay^="${sym}:"]`)].map(
      (el) => `${el.getAttribute("data-parlay")}
${el.innerHTML}`,
    );

  /**
   * **The rollback story, held as a string comparison.**
   *
   * `THETADUEL_OPTIONS=off` — or a seeded source, or a static build with no
   * server to ask — means `useOptionBook` answers `undefined`, `book` is absent,
   * and this screen must be the screen that shipped before any of the live path
   * existed — not "close to it". (The flag itself is opt-out now, on by default;
   * what this test pins is the no-book render, which is every one of the degrade
   * paths above and is where the kill switch has to land.) Byte-for-byte over the rendered
   * card faces is the only version of that claim worth asserting, because every
   * near-miss (a stray chip, a reordered row, a re-rounded number) is invisible
   * to a substring check.
   */
  test("with no book the grid is the seeded grid, byte for byte, and carries nothing live", () => {
    board();
    const seeded = grid("AAPL");
    const eth = grid("ETH");
    expect(seeded).toHaveLength(PARLAY_CARDS.length);
    const html = container.innerHTML;
    // None of the live path's own marks: no live chip, no live note, no
    // provenance line, no dollar payout, no reference-move aside, no dead slot.
    //
    // `book-state-` came OFF this list, and that is the point of the block
    // below rather than an exemption from this one. The per-ticker chip used to
    // be gated on the book being present, which meant the four disclosures on
    // this screen all switched themselves off in the one state they were
    // written for — a board of seeded cards, printing a $4,182.60 ETH strike
    // against a live spot near $2,450, wearing no mark of any kind. What must
    // still be absent here is any claim the data is LIVE; what must now be
    // present is the claim that it is not.
    for (const mark of ["WIN $", "payout at ±", "options-chip", "options-note", "data-parlay-dead", "NOT DEALT"]) {
      expect({ mark, present: html.includes(mark) }).toEqual({ mark, present: false });
    }
    // And the payout row on every card is a bare multiple, which is what the
    // seeded card has always printed.
    for (const el of container.querySelectorAll<HTMLElement>('[data-q="payout"]')) {
      expect(el.textContent).toMatch(/^×\d+\.\d\d$/);
    }

    // The other half of the claim: every card on this board is a fixture, and
    // the screen says so four times — a chip about the spot, a chip about the
    // cards, a chip on each ticker header, and the sentence in the rules box.
    expect(text("seeded-spot-chip")).toBe(SEEDED_SPOT_CHIP);
    expect(text("seeded-cards-chip")).toBe(SEEDED_CARDS_CHIP);
    expect(text("book-state-ETH")).toBe("SEEDED");
    expect(text("book-state-AAPL")).toBe("SEEDED");
    expect(text("seeded-cards-note")).toBe(SEEDED_SETTLEMENT_NOTE);
    // And the live chip is not merely absent from the markup — the live claim
    // is nowhere in the words either.
    expect(html).not.toContain(SPOT_CHIP);
    expect(html).not.toContain(OPTIONS_CHIP);
    unmount();

    // The same board with the book present: ETH goes live, AAPL does not, and
    // AAPL's eight faces are the identical markup they were with no book at
    // all. Turning the flag on perturbs a seeded ticker in no way whatever.
    board(BOOK);
    expect(grid("AAPL")).toEqual(seeded);
    expect(grid("ETH")).not.toEqual(eth);
    unmount();
  });

  /**
   * ──────────────────────────────────────────────────────────────────────────
   * THE DISCLOSURE IS LOUDEST WHERE THE DATA IS WEAKEST
   * ──────────────────────────────────────────────────────────────────────────
   *
   * Two audits found the same thing and it is the one worth a test of its own:
   * this screen's four provenance markers were every one of them gated on a
   * live read having SUCCEEDED. With `/api/market` unreachable — which is the
   * state of this machine as these were written — `useLiveMarket` degrades to
   * `mockMarketSource`, `book` is `undefined`, and twenty-four cards rendered a
   * $4,182.60 ETH strike (about 70% above the real price), a `70% chance` and a
   * `×6.67` with no chip, no note and no dash anywhere above the fold. The only
   * word `SEEDED` on the route was in the page footer, below it.
   *
   * The rule these assertions hold is the inversion: a marker is MORE present
   * when the data is fake, not less. Each of the four is checked in both of its
   * states, so neither can be deleted by a change that only exercises the other.
   */
  test("every disclosure has a seeded half, and it is the half that shows on a dead venue", () => {
    // The venue answered nothing. Nothing on this board came from a market.
    board();
    expect(text("seeded-spot-chip")).toBe(SEEDED_SPOT_CHIP);
    expect(text("seeded-cards-chip")).toBe(SEEDED_CARDS_CHIP);
    expect(text("seeded-cards-note")).toBe(SEEDED_SETTLEMENT_NOTE);
    expect(text("book-state-ETH")).toBe("SEEDED");
    // The live half is not on screen, in markup or in words.
    expect(chip("spot-chip")).toBeNull();
    expect(chip("options-chip")).toBeNull();
    expect(chip("options-note")).toBeNull();
    unmount();

    // The book arrives. The live half takes over, and the seeded half stands
    // down on the ticker the book actually prices — AAPL keeps its SEEDED chip,
    // because a mixed board is the ordinary board.
    board(BOOK);
    expect(chip("options-chip")?.textContent).toBe(OPTIONS_CHIP);
    expect(text("options-note")).toBe(SETTLEMENT_NOTE);
    expect(text("book-state-ETH")).toBe("LIVE");
    expect(text("book-state-AAPL")).toBe("SEEDED");
    expect(chip("seeded-cards-chip")).toBeNull();
    expect(chip("seeded-cards-note")).toBeNull();
    unmount();
  });

  /**
   * The third state, which had no reader anywhere in `src/`.
   *
   * `OptionBook.source` has been written as `"stale" | "live"` since `bookOf`
   * was first written and nothing read it; `OptionBook.at` was never rendered.
   * So a book whose refresh had failed — real strikes and real premiums wearing
   * an unknown number of minutes — dealt cards under a green LIVE chip. That is
   * the state `theme.ts` calls "the one genuinely dangerous state", and the rule
   * it sets is that the word alone is not the disclosure: the age is.
   */
  test("a book that stopped refreshing says STALE, and says how old", () => {
    const at = Date.now() - 4 * 60_000;
    board({ ...BOOK, source: "stale", at });

    // The ticker chip, and the header chip above it, both move off LIVE.
    expect(text("book-state-ETH")).toBe("STALE · 4m ago");
    expect(chip("options-chip")?.getAttribute("data-book-state")).toBe("stale");
    expect(text("options-chip")).toBe(`${OPTIONS_CHIP} · 4m ago`);
    // Amber, not green: the chip's colour is half of what it says.
    expect(chip("options-chip")?.getAttribute("style")).toContain(FEED_STATE.stale.color);
    // A ticker the stale book backs nothing on is still seeded, not stale —
    // the chip describes the eight cards under it, not the book.
    expect(text("book-state-AAPL")).toBe("SEEDED");
    unmount();
  });

  /**
   * SEEDED arrives two ways and the tooltip is the only place the difference is
   * written down. `FEED_STATE.seeded.means` ends "nothing failed", which is
   * true of an offline build and false of a fallback — and the fallback is
   * exactly the path that puts this screen in the seeded state on a machine
   * that cannot reach the book.
   */
  test("the seeded chip says whether the network failed or was never needed", () => {
    board();
    expect(chip("seeded-cards-chip")?.getAttribute("title")).toBe(FEED_STATE.seeded.means);
    unmount();

    board(undefined, "Could not reach the book.");
    expect(chip("seeded-cards-chip")?.getAttribute("title")).toBe(SEEDED_FALLBACK_MEANS);
    expect(chip("seeded-spot-chip")?.getAttribute("title")).toBe(SEEDED_FALLBACK_MEANS);
    expect(chip("book-state-ETH")?.getAttribute("title")).toBe(SEEDED_FALLBACK_MEANS);
    // …and the reason itself is in the rules box, where a player reading that
    // the numbers are a fixture immediately asks why.
    expect(text("seeded-cards-note")).toContain("Could not reach the book.");
    unmount();
  });

  /**
   * The headline of the report, as an assertion: `×430.75` beside `×6.67`.
   *
   * With the flag on, the two grids are on screen together. Every `×` a player
   * can see must be fair odds on a chance — the seeded card's over its band
   * midpoint, the live card's over the option's own delta — and the payout
   * multiple must be somewhere else entirely, in dollars.
   */
  test("across a mixed board every `×` on screen is odds, and no two of them are on different bases", () => {
    board(BOOK);
    const html = container.innerHTML;
    // The one live number that could have been a `×`: ×20 here (a $400 payout
    // over a $20 ask), ×430 on a real DEGEN card. It is money, and it says so.
    expect(html).toContain("WIN $400");
    expect(html).toContain("payout at ±25%");
    expect(html).not.toContain("×20.00");

    // Every `×N` in the rendered DOM, from every surface at once — card faces,
    // ticker headers, slip rows, the combined ODDS stat.
    // Every per-LEG `×` on screen, from all three surfaces that print one: the
    // card faces, the ticker headers and the slip rows. The combined ODDS stat
    // is deliberately excluded — it is a product of leg odds and legitimately
    // exceeds any single leg's ceiling.
    const legMultiples = () =>
      [
        ...container.querySelectorAll<HTMLElement>('[data-q="payout"]'),
        ...container.querySelectorAll<HTMLElement>("[data-leg-picker] > div:first-child"),
        ...container.querySelectorAll<HTMLElement>("[data-leg]"),
      ]
        .flatMap((el) => [...(el.textContent ?? "").matchAll(/×(\d+(?:\.\d+)?)/g)])
        .map((m) => Number(m[1]!));

    const shown = legMultiples();
    // AAPL's eight seeded faces at minimum; more as picks land on the header
    // and the slip.
    expect(shown.length).toBeGreaterThanOrEqual(PARLAY_CARDS.length);
    // Fair odds on a delta are bounded by the tier ladder itself: every band
    // sits inside [0.05, 0.85), so no `×` anywhere on this screen can be below
    // ×1.18 or above ×20 — on either path. A payout multiple has no such
    // ceiling (×430 on the report's live DEGEN card), which is precisely why
    // the two may not share the glyph. This loop is the guard: one number out
    // of that range means a payout multiple has leaked back into a `×`.
    const CEIL = 1 / TIER_BANDS.DEGEN[0]!;
    const FLOOR = 1 / TIER_BANDS.SAFE[1]!;
    for (const n of shown) {
      expect({ n, inRange: n >= FLOOR && n <= CEIL }).toEqual({ n, inRange: true });
    }
    unmount();

    // …and the same sweep with a live card actually picked, so the ticker
    // header and the slip row are in the sample too.
    pickScreen(BOOK, "sharp-bull");
    const picked = legMultiples();
    // The header and the slip both print the live leg now: ×3.33, the option's
    // own delta at fair odds — not ×20, its payout multiple.
    expect(picked).toContain(3.33);
    expect(picked).not.toContain(20);
    for (const n of picked) {
      expect({ n, inRange: n >= FLOOR && n <= CEIL }).toEqual({ n, inRange: true });
    }
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The control
// ─────────────────────────────────────────────────────────────────────────────

describe("DetailToggle — a visible three-way switch, never a lock", () => {
  test("all three levels are on screen at once, with the live one pressed", () => {
    mount(createElement(DetailToggle, { level: "STANDARD", onChange: () => {} }));
    const buttons = [...container.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["SIMPLE", "STANDARD", "FULL"]);
    expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual(["false", "true", "false"]);
    unmount();
  });

  test("it is a labelled group of real buttons — tab-reachable, none inert", () => {
    mount(createElement(DetailToggle, { level: "SIMPLE", onChange: () => {} }));
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toBe("Card detail");
    for (const b of container.querySelectorAll("button")) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
      // A `<button>` is focusable by default; nothing here removes it from the
      // tab order or greys it out, because no level is ever unavailable.
      expect(b.hasAttribute("disabled")).toBe(false);
      expect(b.getAttribute("tabindex")).toBeNull();
    }
    unmount();
  });

  test("pressing moves the level in both directions", () => {
    const seen: CardDetail[] = [];
    mount(createElement(DetailToggle, { level: "FULL", onChange: (d) => seen.push(d) }));
    click("detail-SIMPLE");
    click("detail-FULL");
    click("detail-STANDARD");
    // Down from FULL, back up, and to the middle — three presses, no refusals.
    expect(seen).toEqual(["SIMPLE", "FULL", "STANDARD"]);
    unmount();
  });

  test("wired to the hook it moves a WHALE down to SIMPLE and keeps it there", () => {
    function Harness() {
      const { level, setLevel } = useCardDetail(TIERS[4]);
      return createElement(
        "div",
        null,
        createElement("span", { "data-testid": "level" }, level),
        createElement(DetailToggle, { level, onChange: setLevel }),
      );
    }
    mount(createElement(Harness));
    expect(text("level")).toBe("FULL"); // the ORCA/WHALE opening default
    click("detail-SIMPLE");
    expect(text("level")).toBe("SIMPLE");
    unmount();

    // …and it is still SIMPLE on the next mount, and after a reload.
    forgetDetailMemo();
    mount(createElement(Harness));
    expect(text("level")).toBe("SIMPLE");
    unmount();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** The level a player of `name`'s tier sees right now, given the store. */
function levelFor(name: TierName): CardDetail {
  const tier = TIERS.find((t) => t.name === name)!;
  return getStoredDetail() ?? defaultDetail(tier);
}

/** The quantities `high` puts on the face that `low` does not, in render order. */
function added(low: CardDetail, high: CardDetail): readonly CardQuantity[] {
  const before = new Set(quantitiesAt(low));
  return quantitiesAt(high).filter((q) => !before.has(q));
}

let container: HTMLDivElement;
let root: Root;

function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(node);
  });
}

function unmount() {
  act(() => root.unmount());
  container.remove();
}

function click(testId: string) {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  expect(el).not.toBeNull();
  act(() => {
    el!.click();
  });
}

function text(testId: string): string {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "";
}

/** The element itself, or `null` — for the assertions that are about a chip
 *  being absent, or about its `title` and its colour rather than its words. */
function chip(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

/**
 * Run `body` with a `localStorage` that throws — Safari's private mode on read,
 * a full quota on write. The descriptor is restored afterwards whatever
 * happens, so one broken-storage test cannot leak into the next.
 */
function withBrokenStorage(when: "read" | "write", body: () => void): void {
  const key = "localStorage";
  const original = Object.getOwnPropertyDescriptor(globalThis, key);
  const boom = () => {
    throw new Error("SecurityError: storage is not available");
  };
  const store: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
    getItem: when === "read" ? boom : () => null,
    setItem: boom,
    removeItem: boom,
  };
  Object.defineProperty(globalThis, key, { configurable: true, value: store });
  try {
    body();
  } finally {
    if (original) Object.defineProperty(globalThis, key, original);
    else delete (globalThis as Record<string, unknown>)[key];
    forgetDetailMemo();
  }
}
