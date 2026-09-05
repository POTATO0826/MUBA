/** Palette and style builders lifted from the design source. */

export const MONO = "'JetBrains Mono',monospace";
export const SANS = "'DM Sans',sans-serif";

export const C = {
  bg: "#09090b",
  panel: "#0b0b0d",
  panelAlt: "#0d0d10",
  card: "#0f0f11",
  cardAlt: "#101013",
  raised: "#131316",
  line: "#1c1c20",
  lineSoft: "#1a1a1e",
  border: "#27272a",
  borderMid: "#3f3f46",
  text: "#fafafa",
  textSoft: "#d4d4d8",
  muted: "#a1a1aa",
  dim: "#71717a",
  faint: "#52525b",
  accent: "#c8ff00",
  green: "#4ade80",
  red: "#f87171",
  blue: "#38bdf8",
  violet: "#a78bfa",
  indigo: "#6366f1",
  amber: "#f59e0b",
} as const;

export const SEC_COLOR: Record<string, string> = {
  SEMIS: C.green,
  TECH: C.blue,
  AUTO: "#f472b6",
  ENERGY: C.amber,
  FIN: C.violet,
  METALS: "#fbbf24",
  "EQUITY-BETA": C.accent,
  L1: C.accent,
  L2: C.blue,
  ORACLE: "#2dd4bf",
  DEFI: C.violet,
  MEME: "#f472b6",
};

export const sectorColor = (sector: string): string => SEC_COLOR[sector] ?? C.muted;

/** Header nav button. */
export const tabBtn = (active: boolean): string =>
  `height:32px;padding:0 13px;border:none;border-radius:8px;cursor:pointer;font:${
    active ? "700" : "500"
  } 12.5px/1 ${SANS};` +
  (active ? `background:#1f1f23;color:${C.text}` : `background:transparent;color:${C.muted}`);

/** Small rounded filter chip. */
export const pill = (active: boolean): string =>
  `height:26px;padding:0 10px;border-radius:99px;cursor:pointer;font:500 11px/1 ${MONO};border:1px solid ` +
  (active
    ? `rgba(200,255,0,.4);background:rgba(200,255,0,.12);color:${C.accent}`
    : `${C.border};background:transparent;color:${C.muted}`);

/** Parallax backdrop behind a case card. */
export const wall = (a: string, b: string, deg: number): string =>
  `position:absolute;inset:-10%;background:linear-gradient(${deg}deg,${a} 0%,#0d0d0f 62%),` +
  `radial-gradient(60% 55% at 70% 22%,${b},transparent 70%);transition:transform .2s cubic-bezier(.2,.8,.2,1)`;

/** Monospace category tag, tinted to `color`. */
export const tag = (color: string): string =>
  `display:inline-flex;align-items:center;font:500 9px/1 ${MONO};letter-spacing:.12em;` +
  `padding:6px 8px;border-radius:6px;border:1px solid ${color}55;background:${color}1f;color:${color}`;

/** Tighter monospace tag for sector / mode chips. */
export const miniTag = (color: string): string =>
  `font:700 8.5px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:5px;` +
  `border:1px solid ${color}4d;background:${color}1a;color:${color}`;

/* `avatarStyle` lived here — a flat colour square with two initials on it. Every
   call site now renders `components/PlayerMark.tsx` instead, which seeds a
   procedural pixel glyph off the player's name, so the builder is dead and gone
   rather than left as a second, drifting way to draw a player. */

export const chipStyle = (color: string): string =>
  `flex:none;font:500 10px/1 ${MONO};padding:6px 8px;border-radius:6px;border:1px solid ${C.border};` +
  `background:${C.raised};color:${color}`;

/* ------------------------------------------------------------------------ *
 *  Feed state — the four words this app may use about where a number came
 *  from, and the one colour each of them owns.
 * ------------------------------------------------------------------------ */

/**
 * Provenance, as a closed set.
 *
 * Every wave that shipped a live feed invented its own badge for this, so the
 * same idea ended up said four ways: the wire called a fixture `SEEDED` in
 * amber, the footer called the same thing "mock data" in grey, `/desk` called
 * it `SEEDED` beside a green pulsing dot, and the lobby called it `MOCK`. Worse,
 * amber meant "this is a fixture" on the wire and "this is real but old" in the
 * footer — the same colour making two different claims on two screens of one
 * app.
 *
 * This record is the single definition. A surface picks a state and takes the
 * label and the colour with it; it does not get to phrase or tint its own.
 *
 * The four states are exhaustive over what a feed can be and are deliberately
 * *not* about anything else — a season that is running, a wallet that is a
 * stub, an order that filled halfway, a feature that is switched off. Those all
 * use words that collide with these (`MOCK WALLET`,
 * `PARTIAL` on an order row, `SIDE BET · UNAVAILABLE`) and they are correct as
 * they stand; what keeps them from being confusing is that none of them wear
 * one of these four colours. Accent is the brand, and no feed state is accent.
 */
export type FeedState = "live" | "seeded" | "stale" | "partial";

export interface FeedStateSpec {
  /** The chip's text. Rendered verbatim, never re-cased or abbreviated. */
  label: string;
  /** The state's colour, everywhere it appears — chip, dot, tinted text. */
  color: string;
  /** Exactly what the chip claims. Also the chip's `title`, so the claim is
   *  readable on the screen and not only in this file. */
  means: string;
}

export const FEED_STATE: Record<FeedState, FeedStateSpec> = {
  /** Fresh data from the venue, right now — read inside the source's own
   *  refresh window with nothing degraded. The only state that may pulse. */
  live: {
    label: "LIVE",
    color: C.green,
    means: "Fresh from the venue — read within the refresh window.",
  },
  /**
   * A deterministic fixture. Grey rather than amber because a fixture is the
   * app's ordinary resting state, not a warning — amber is reserved for the one
   * case where the numbers are real and wrong.
   *
   * **A fixture reaches the screen two ways, and this `means` describes only
   * the first.** Either nothing asked the network (the offline build, a static
   * export, `THETADUEL_MARKET=off`, a seeded story) — that is this sentence,
   * and it is true. Or `/api/market` was asked, failed, and `useLiveMarket`
   * degraded to `mockMarketSource` with no last-good snapshot to fall back on
   * (`data/thetanuts.tsx`, `degrade()`) — and then "nothing failed" is the chip
   * asserting the opposite of what just happened, in the one place a reader
   * goes to check. {@link SEEDED_FALLBACK_MEANS} is that second sentence and
   * {@link meansOf} is how a surface that knows which it is picks between them.
   */
  seeded: {
    label: "SEEDED",
    color: C.dim,
    means: "Deterministic fixture — no network, nothing failed.",
  },
  /**
   * Was live; the refresh failed; these are the last good numbers still on
   * screen. Real data wearing the wrong timestamp, which is the one genuinely
   * dangerous state — hence the warning colour, and hence the rule that a
   * STALE chip always appears next to the age of the read it is showing
   * (`stateAge`). The age is the disclosure; the word alone is not.
   */
  stale: {
    label: "STALE",
    color: C.amber,
    means: "Last good read — the refresh failed. The age is how old it is.",
  },
  /**
   * Some feeds answered and some did not. The rows on screen are live; a
   * source that should have contributed to them is missing. Blue because it is
   * neither clean nor wrong — it is incomplete, and the reader's question is
   * "what is missing", not "should I trust this".
   */
  partial: {
    label: "PARTIAL",
    color: C.blue,
    means: "Live, but a feed dropped — some sources did not answer.",
  },
};

/**
 * The wire word for a source's own kind string.
 *
 * `MarketMeta.source` is `"mock" | "live" | "stale"` and `NewsSource` reports
 * `"mock" | "live" | "partial"`; both spell a fixture `"mock"`, which is the
 * *implementation's* word for it (`mockMarketSource`, `wallet.id === "mock"`)
 * and not the reader's. This is the one place the translation happens, so no
 * view has to remember that "mock" is shown as SEEDED.
 */
export function feedState(kind: "mock" | "live" | "stale" | "partial"): FeedState {
  return kind === "mock" ? "seeded" : kind;
}

/**
 * SEEDED's other sentence: the fixture is here because the venue is not.
 *
 * The label and the colour do not move — the numbers on screen really are the
 * deterministic fixture, which is what SEEDED names, and re-tinting it amber
 * would collide with STALE, whose amber means "real numbers, wrong timestamp".
 * What moves is the claim. `FEED_STATE.seeded.means` ends "nothing failed", and
 * on this path something did: that is the difference between a build that never
 * needed the book and a build that wanted it and could not have it, and a
 * reader deciding whether to trust the screen is asking exactly that.
 *
 * It does **not** say what failed. The reason is a separate, longer string the
 * app already carries and already renders — `LiveMarketState.error`, printed in
 * the footer as prose beside this chip — and duplicating it into a tooltip
 * would be two places to correct one wording.
 */
export const SEEDED_FALLBACK_MEANS =
  "Deterministic fixture — the live read failed and the app fell back to it.";

/**
 * The claim a state chip is making, given what the surface knows about how the
 * data got there.
 *
 * `fellBack` is "a live read was attempted and did not succeed", which for a
 * caller holding `LiveMarketState` is `error !== null`. It only changes the
 * seeded case: LIVE cannot have fallen back and still be live, STALE already
 * says a refresh failed in its own `means`, and PARTIAL already says a feed
 * dropped. Every other caller can keep reading `FEED_STATE[state].means`
 * directly, and this exists so that the ones that know better are not forced to
 * assemble the sentence themselves.
 */
export function meansOf(state: FeedState, fellBack = false): string {
  return state === "seeded" && fellBack ? SEEDED_FALLBACK_MEANS : FEED_STATE[state].means;
}

/**
 * A state chip: `tag()` in the state's colour.
 *
 * Reusing `tag` rather than inventing a fifth chip shape is the point — a
 * provenance chip is a category tag whose category happens to be "where this
 * came from", and it should sit on a header bar looking like every other tag
 * there. `stateMiniChip` is the same chip at `miniTag` scale, for the header
 * bars that are already running two chips deep.
 */
export const stateChip = (state: FeedState): string => tag(FEED_STATE[state].color);

export const stateMiniChip = (state: FeedState): string => miniTag(FEED_STATE[state].color);

/**
 * The 6px status dot, in the state's colour.
 *
 * It pulses for `live` and only for `live`. A pulsing dot is the universal
 * "something is arriving" signal, and putting one beside a fixture — which
 * `/desk` did — is a claim the data does not support, made in animation rather
 * than in words so that no amount of reading the label catches it.
 */
export const stateDot = (state: FeedState): string =>
  `width:6px;height:6px;border-radius:99px;background:${FEED_STATE[state].color}` +
  (state === "live" ? ";animation:vcPulse 2s infinite" : "");

/**
 * `"12s ago"` / `"4m ago"`, or `null` when a source has no age.
 *
 * Lives here, beside the vocabulary, rather than in whichever view drew it
 * first, because the age is half of what STALE means: the word says the
 * refresh failed and this number says how much that cost you. Two surfaces
 * phrasing it two ways would be the same drift this block exists to end.
 *
 * `fetchedAt: 0` is the mock's marker for "no age at all" — a fixture is not
 * "from 3 seconds ago" — and returns `null` rather than a nonsense duration.
 */
export function stateAge(fetchedAt: number, now: number): string | null {
  if (!fetchedAt) return null;
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}
