import { C } from "../theme.ts";

/** Podium entries for BIGGEST PAYOFFS 24H. */
export const TOP_WINS = [
  { rank: "01", payout: "+46.0 Ξ", mult: "4.60×", who: "0xsilo", structure: "WHALE BOX · 8 legs · 27 sep" },
  { rank: "02", payout: "+12.4 Ξ", mult: "8.20×", who: "0xdrift", structure: "SKEW HUNTER · 6 legs · 27 sep" },
  { rank: "03", payout: "+9.85 Ξ", mult: "3.10×", who: "mira.base", structure: "ETH VOL BOX · 4 legs · 27 sep" },
] as const;

/** Recently settled cases feeding the marquee. The strip renders these twice so
 *  the `vcStream` translate can loop seamlessly at -50%. */
export const SETTLED_CASES = [
  { who: "lexa", initial: "LX", bg: C.violet, legs: "2L", payout: "+0.86 Ξ", structure: "BTC RANGER 90–104K", win: true },
  { who: "0xdrift", initial: "DR", bg: C.accent, legs: "6L", payout: "+3.90 Ξ", structure: "SKEW HUNTER", win: true },
  { who: "tonoi", initial: "TO", bg: C.blue, legs: "2L", payout: "−0.19 Ξ", structure: "DOWNSIDE VAULT", win: false },
  { who: "saph.base", initial: "SP", bg: C.green, legs: "5L", payout: "+2.05 Ξ", structure: "DUAL ASSET", win: true },
  { who: "vane", initial: "VN", bg: "#f472b6", legs: "3L", payout: "+0.44 Ξ", structure: "WEEKLY GRIND", win: true },
  { who: "qbit", initial: "QB", bg: "#fbbf24", legs: "4L", payout: "−0.33 Ξ", structure: "GAMMA SPRINT", win: false },
  { who: "arlo.eth", initial: "AR", bg: C.indigo, legs: "8L", payout: "+5.20 Ξ", structure: "WHALE BOX", win: true },
  { who: "noor", initial: "NO", bg: "#2dd4bf", legs: "2L", payout: "+0.72 Ξ", structure: "DOWNSIDE VAULT", win: true },
  { who: "zeph", initial: "ZE", bg: C.accent, legs: "5L", payout: "+1.18 Ξ", structure: "DUAL ASSET", win: true },
  { who: "mira.base", initial: "MI", bg: C.green, legs: "3L", payout: "+0.31 Ξ", structure: "WEEKLY GRIND", win: true },
  { who: "jpx", initial: "JP", bg: C.red, legs: "4L", payout: "−0.41 Ξ", structure: "ETH VOL BOX", win: false },
  { who: "0xsilo", initial: "SI", bg: C.amber, legs: "4L", payout: "+1.42 Ξ", structure: "ETH VOL BOX", win: true },
] as const;

/** The worked ETH vol box shown on the options desk. */
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

export const CHAMP_ART = [
  "  \\_______/",
  "   \\_____/",
  "    |___|",
  "     |_|",
  "   __|_|__",
  "  |_______|",
].join("\n");
