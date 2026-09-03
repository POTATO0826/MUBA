import type { CaseDef } from "../types.ts";
import { C } from "../theme.ts";

/** Podium entries for BIGGEST WINS 24H. */
export const TOP_WINS = [
  { rank: "01", payout: "+46.0 Ξ", mult: "4.60×", who: "0xsilo", structure: "WHALE BOX · 8 legs · 27 sep" },
  { rank: "02", payout: "+12.4 Ξ", mult: "8.20×", who: "kazuo.eth", structure: "SKEW HUNTER · 6 legs · 27 sep" },
  { rank: "03", payout: "+9.85 Ξ", mult: "3.10×", who: "mira.base", structure: "ETH VOL BOX · 4 legs · 27 sep" },
] as const;

/** Settled duels feeding the marquee. The strip renders these twice so the
 *  `vcStream` translate can loop seamlessly at -50%. */
export const DUELS = [
  { who: "kazuo.eth", initial: "KZ", bg: C.red, mode: "1v1", payout: "+1.42 Ξ", structure: "ETH 4300/4700 CS", win: true },
  { who: "lexa", initial: "LX", bg: C.violet, mode: "2v2", payout: "+0.86 Ξ", structure: "BTC RANGER 90–104K", win: true },
  { who: "0xdrift", initial: "DR", bg: C.accent, mode: "1v1", payout: "+3.90 Ξ", structure: "SKEW HUNTER 6L", win: true },
  { who: "tonoi", initial: "TO", bg: C.blue, mode: "1v1", payout: "−0.28 Ξ", structure: "ETH 3900 P LADDER", win: false },
  { who: "saph.base", initial: "SP", bg: C.green, mode: "1v1v1v1", payout: "+2.05 Ξ", structure: "MIXED VOL 5L", win: true },
  { who: "vane", initial: "VN", bg: "#f472b6", mode: "2v2", payout: "+0.44 Ξ", structure: "WEEKLY GRIND 3L", win: true },
  { who: "qbit", initial: "QB", bg: "#fbbf24", mode: "1v1", payout: "−1.60 Ξ", structure: "GAMMA SPRINT 4L", win: false },
  { who: "arlo.eth", initial: "AR", bg: C.indigo, mode: "1v1", payout: "+5.20 Ξ", structure: "WHALE BOX 8L", win: true },
  { who: "noor", initial: "NO", bg: "#2dd4bf", mode: "2v2", payout: "+0.72 Ξ", structure: "DOWNSIDE VAULT 2L", win: true },
  { who: "zeph", initial: "ZE", bg: C.accent, mode: "1v1", payout: "+1.18 Ξ", structure: "DUAL ASSET 5L", win: true },
  { who: "mira.base", initial: "MI", bg: C.green, mode: "1v1", payout: "+0.31 Ξ", structure: "ETH WEEKLY 3L", win: true },
  { who: "jpx", initial: "JP", bg: C.red, mode: "2v2", payout: "−0.95 Ξ", structure: "BTC 88K P SPREAD", win: false },
] as const;

/** The four cards on the lobby; also the head of the rewards library. */
export const FEATURED_CASES: readonly CaseDef[] = [
  { name: "ETH Vol Box", tag: "STRUCTURED", tc: C.accent, legs: "4 LEGS", blurb: "Long call spread against a short put spread. Wins on drift, dies on chop.", cost: "0.41 Ξ", max: "1.86 Ξ", w: ["#1c2a12", "rgba(200,255,0,.22)", 145] },
  { name: "BTC Ranger", tag: "BASE ONLY", tc: C.amber, legs: "2 LEGS", blurb: "Pays if BTC stays inside the band until expiry. Reverts on breakout.", cost: "0.28 Ξ", max: "1.12 Ξ", w: ["#2a1f0d", "rgba(245,158,11,.22)", 120] },
  { name: "Skew Hunter", tag: "HIGH VAR", tc: C.violet, legs: "6 LEGS", blurb: "Buys the wings where MM skew is fattest. Rare, large outcomes.", cost: "0.64 Ξ", max: "5.40 Ξ", w: ["#221436", "rgba(167,139,250,.24)", 165], tier: "SHARK" },
  { name: "Weekly Grind", tag: "LOW VAR", tc: C.blue, legs: "3 LEGS", blurb: "Short-dated theta collection. Small, frequent, boring wins.", cost: "0.12 Ξ", max: "0.31 Ξ", w: ["#0c2230", "rgba(56,189,248,.2)", 130] },
];

export const CASE_LIBRARY: readonly CaseDef[] = [
  ...FEATURED_CASES,
  { name: "Gamma Sprint", tag: "STRUCTURED", tc: C.accent, legs: "4 LEGS", blurb: "Straddle bought two days before expiry. Pure realized-vol bet.", cost: "0.33 Ξ", max: "2.40 Ξ", w: ["#1c2a12", "rgba(200,255,0,.18)", 200] },
  { name: "Downside Vault", tag: "HEDGE", tc: C.red, legs: "2 LEGS", blurb: "Put ladder financed by a covered call. Insurance with a coupon.", cost: "0.19 Ξ", max: "0.88 Ξ", w: ["#2e1215", "rgba(248,113,113,.2)", 110] },
  { name: "Dual Asset", tag: "MIXED", tc: C.muted, legs: "5 LEGS", blurb: "ETH calls against BTC puts. Trades the correlation, not direction.", cost: "0.52 Ξ", max: "3.10 Ξ", w: ["#1a1a1f", "rgba(161,161,170,.16)", 155] },
  { name: "Whale Box", tag: "WHALE", tc: C.accent, legs: "8 LEGS", blurb: "10 ETH entry. Full-book draft, no bans, winner takes the pot.", cost: "10.0 Ξ", max: "46.0 Ξ", w: ["#252a10", "rgba(200,255,0,.3)", 175], tier: "ORCA" },
];

/** Pick/ban turn order shown as the draft ticker. Purely illustrative — the
 *  board it sits above is driven by the real picks. */
export const DRAFT_STEPS = [
  { kind: "BAN", label: "YOU", s: "done" },
  { kind: "BAN", label: "KZ", s: "active" },
  { kind: "PICK", label: "KZ", s: "next" },
  { kind: "PICK", label: "YOU", s: "idle" },
  { kind: "PICK", label: "YOU", s: "idle" },
  { kind: "PICK", label: "KZ", s: "idle" },
  { kind: "BAN", label: "YOU", s: "idle" },
  { kind: "PICK", label: "KZ", s: "idle" },
  { kind: "PICK", label: "YOU", s: "idle" },
  { kind: "LOCK", label: "—", s: "idle" },
] as const;

export type DraftStepState = (typeof DRAFT_STEPS)[number]["s"];

export const DRAFT_STEP_STYLE: Record<DraftStepState, string> = {
  done: "#1f1f23;color:#52525b;border:1px solid #27272a",
  active: "rgba(200,255,0,.14);color:#c8ff00;border:1px solid rgba(200,255,0,.45)",
  next: "#131316;color:#a1a1aa;border:1px solid #3f3f46",
  idle: "transparent;color:#3f3f46;border:1px dashed #27272a",
};

/** The worked ETH vol box shown on the Duel attack screen. */
export const SLIP_LEGS = [
  { side: "B", label: "ETH 4300 C ×2", meta: "27 sep · Δ0.42 · IV 57.4%", prem: "−0.172" },
  { side: "S", label: "ETH 4700 C ×2", meta: "27 sep · Δ0.18 · IV 61.8%", prem: "+0.062" },
  { side: "B", label: "ETH 3900 P ×1", meta: "27 sep · Δ−0.31 · IV 65.2%", prem: "−0.062" },
  { side: "S", label: "ETH 3600 P ×1", meta: "27 sep · Δ−0.14 · IV 70.3%", prem: "+0.024" },
] as const;

export const SLIP_ROWS = [
  { label: "NET DEBIT", value: "0.412 Ξ", c: C.text },
  { label: "MAX PAYOUT", value: "1.86 Ξ", c: C.accent },
  { label: "IMPLIED ODDS", value: "4.51×", c: C.text },
  { label: "NET DELTA / VEGA", value: "+0.29 / −1.4", c: C.muted },
] as const;

export const SLIP_NOTES = [
  { tag: "RISK", tc: C.red, title: "Your legs share one expiry", body: "All four settle 27 Sep. A quiet fortnight is a total loss on the box, not a partial one." },
  { tag: "EDGE", tc: C.accent, title: "You are short the fat wing", body: "The 4700 call you sold carries 4.4 IV points more than the 4300 you bought. That spread is the trade." },
  { tag: "SIZING", tc: C.blue, title: "17% of bankroll", body: "0.412 of 2.40 ETH. Above the 5% rule the coach teaches for single-expiry structures." },
] as const;

export const ASK_CHIPS = ["Why is vega negative?", "Cheaper version?", "Explain rangers"] as const;

/** Open lobbies. `pot`/`entry` are null on the room the admin is configuring —
 *  that row tracks the live prize slider instead. */
export const ROOMS = [
  { mode: "1v1", status: "DRAFTING", sc: C.accent, phase: "pick & ban", pot: "4.80", entry: "2.40", syms: ["NVDA", "TSLA", "XOM"], players: [["YO", C.indigo], ["KZ", C.red]], slots: "2/2", cta: "Spectate", hot: true },
  { mode: "1v1", status: "OPEN", sc: C.green, phase: "waiting for P2", pot: null, entry: null, syms: ["AAPL", "META", "GLD"], players: [["YO", C.indigo]], slots: "1/2", cta: "Join", hot: false },
  { mode: "1v1", status: "OPEN", sc: C.green, phase: "waiting for P2", pot: "1.20", entry: "0.60", syms: ["COIN", "AMD"], players: [["SN", C.blue]], slots: "1/2", cta: "Join", hot: false },
  { mode: "1v1", status: "STUDY", sc: C.blue, phase: "case study", pot: "8.00", entry: "4.00", syms: ["JPM", "XOM", "GLD"], players: [["QB", "#f472b6"], ["ZE", C.accent]], slots: "2/2", cta: "Spectate", hot: false },
  { mode: "1v1", status: "LIVE TAPE", sc: C.amber, phase: "fighting", pot: "6.40", entry: "3.20", syms: ["NVDA", "AMD", "COIN"], players: [["AR", C.blue], ["TO", C.red]], slots: "2/2", cta: "Watch", hot: false },
  { mode: "1v1", status: "OPEN", sc: C.green, phase: "waiting for P2", pot: "20.00", entry: "10.00", syms: ["TSLA", "NVDA", "META"], players: [["0X", C.accent]], slots: "1/2", cta: "Join", hot: false },
] as const;

export const CHAMP_ART = [
  "  \\_______/",
  "   \\_____/",
  "    |___|",
  "     |_|",
  "   __|_|__",
  "  |_______|",
].join("\n");
