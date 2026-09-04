#!/usr/bin/env bun
/**
 * The asset gate, measured against the LIVE book.
 *
 *     bun run scripts/probe-assets.ts
 *
 * Prints one row per price-feed asset: order count, greeked count, summed
 * depth, MM pricing yes/no, grade, and the qualify/reject verdict with which
 * condition failed.
 *
 * ## Why this script exists
 *
 * "Which assets does this actually support" is the first question anyone who
 * wrote these contracts will ask, and the honest answer is a *measurement*, not
 * a claim. A list in a README goes stale the day a maker pulls their quotes —
 * that is the bug that made AVAX the broken default asset. This never goes
 * stale, because it reads the book in front of you.
 *
 * Run it before every demo, and run it *in* the demo. Its committed output
 * lives in `docs/asset-gate.md`.
 *
 * ## `--fixture`
 *
 * Runs the identical gate over `test/fixtures/orders.json` — the frozen Base
 * capture — instead of the network, and says so in a banner nobody can miss.
 * It exists because the room's wifi is not part of the argument: if the orders
 * API is unreachable you can still show what the gate *does*, without ever
 * letting a frozen table be mistaken for a live one.
 *
 * ## What it is not
 *
 * It is read-only and has no signer, so nothing here can move funds even if it
 * is wrong. The gate itself is `src/data/qualify.ts` — pure, fixture-driven and
 * unit-tested. This file is I/O and a table; every decision it prints was made
 * there.
 *
 * @see plan6-real-parlay.md §7.3
 */

import { ThetanutsClient } from "@thetanuts-finance/thetanuts-client";
import { JsonRpcProvider } from "ethers";
import {
  CONDITION_REASON,
  MIN_DEPTH_USDC,
  MIN_GREEKED,
  MIN_ORDERS,
  feedIndex,
  probeAssets,
  type AssetReport,
  type QualifySnapshot,
} from "../src/data/qualify.ts";

const RPC_URL = Bun.env.RPC_URL ?? "https://mainnet.base.org";
const CHAIN_ID = 8453 as const;

if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
  console.log(
    [
      "probe-assets — which Thetanuts underlyings can the game deal today?",
      "",
      "  bun run scripts/probe-assets.ts",
      "  bun run scripts/probe-assets.ts --fixture",
      "",
      "Reads the live Base book (read-only, no signer) and prints the four-condition",
      "gate from src/data/qualify.ts for every price-feed asset.",
      "",
      "  --fixture  run the same gate over the frozen capture in",
      "             test/fixtures/orders.json instead of the network",
      "  RPC_URL    override the Base RPC (default https://mainnet.base.org)",
      "",
      "Exit 0 when the book was read. Exit 1 when a source was unreachable — a",
      "failed probe must look failed, not empty.",
    ].join("\n"),
  );
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Table formatting — plain ASCII, because this gets pasted into docs and read
// out loud in a room.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = [
  { head: "ASSET", width: 6, right: false },
  { head: "SPOT", width: 12, right: true },
  { head: "ORDERS", width: 7, right: true },
  { head: "GREEKED", width: 8, right: true },
  { head: "DEPTH USD", width: 13, right: true },
  { head: "MM", width: 4, right: false },
  { head: "GRADE", width: 6, right: false },
  { head: "VERDICT", width: 0, right: false },
] as const;

function row(cells: readonly string[]): string {
  return cells
    .map((cell, i) => {
      const col = COLUMNS[i]!;
      return col.width === 0 ? cell : col.right ? cell.padStart(col.width) : cell.padEnd(col.width);
    })
    .join("  ")
    .trimEnd();
}

const usd = (n: number): string =>
  n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);

/** `REJECTED — no market price; not enough depth`. Every failing condition, not
 *  just the first: "unpriced and empty" is a different story from "priced,
 *  quoted and $3 deep", and the difference is what tells you whether an asset
 *  is coming back. */
function verdict(report: AssetReport): string {
  if (report.qualified) return "QUALIFIED";
  return `REJECTED — ${report.failed.map((c) => CONDITION_REASON[c]).join("; ")}`;
}

function render(reports: readonly AssetReport[], mmProbed: boolean): string {
  const lines = [row(COLUMNS.map((c) => c.head))];
  lines.push("-".repeat(88));
  for (const r of reports) {
    lines.push(
      row([
        r.underlying,
        r.spot === null ? "—" : `$${usd(r.spot)}`,
        String(r.orders),
        String(r.greeked),
        r.depthUsd > 0 ? `$${usd(r.depthUsd)}` : "—",
        // `?` rather than `no` when the MM feed was not read: an unasked
        // question has no answer, and "no MM pricing" is a claim about a
        // market maker, not about our network.
        mmProbed ? (r.mmPricing ? "yes" : "no") : "?",
        !r.qualified ? "—" : mmProbed ? r.grade : "?",
        verdict(r),
      ]),
    );
  }
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The probe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The whole cause chain, not just the top of it.
 *
 * The SDK wraps transport failures as `ThetanutsError: HTTP request failed`,
 * which is true and useless: a 404 on a moved route, a DNS failure and a TLS
 * chain the Node agent will not trust all print identically. The thing that
 * decides whether the demo is broken or the market is closed lives one or two
 * `cause` links down, so unwrap it. Depth-capped so a self-referential cause
 * cannot spin.
 */
function message(e: unknown, depth = 4): string {
  if (!(e instanceof Error)) return String(e);
  const head = `${e.name}: ${e.message}`;
  const status = (e as { meta?: { status?: unknown } }).meta?.status;
  const withStatus = typeof status === "number" ? `${head} (HTTP ${status})` : head;
  const cause = (e as { cause?: unknown }).cause;
  if (depth <= 0 || !(cause instanceof Error)) return withStatus;
  // A wrapper that re-states its own cause verbatim adds a line and no
  // information. `undici` wraps TLS failures exactly like that.
  const below = message(cause, depth - 1);
  if (below === head || below.startsWith(`${head}\n`)) return withStatus;
  return `${withStatus}\n    caused by ${below}`;
}

const FIXTURE_MODE = Bun.argv.includes("--fixture");

/** What one run measured, whatever it read. */
interface Probe {
  at: number;
  snapshot: QualifySnapshot;
  /** False when a source was not read, which caveats the MM/GRADE columns and
   *  sets the exit code. */
  mmProbed: boolean;
  ok: boolean;
  source: string;
}

/** The frozen Base capture — the same file `test/qualify.test.ts` drives off. */
async function fromFixture(): Promise<Probe> {
  const path = new URL("../test/fixtures/orders.json", import.meta.url);
  const raw = (await Bun.file(path).json()) as QualifySnapshot & {
    _provenance?: { captured?: string };
  };
  const captured = Date.parse(String(raw._provenance?.captured ?? ""));
  console.log("");
  console.log("  !!  SOURCE: FROZEN FIXTURE — NOT THE LIVE BOOK  !!");
  console.log("  test/fixtures/orders.json, 30 of 426 orders, hand-trimmed.");
  console.log("  It carries no mmPricing, so MM and GRADE below are unanswered, not 'no'.");
  return {
    // The capture's own timestamp, not now: judging a frozen book's expiries
    // against today's clock measures how old the file is, not what the book had.
    at: Number.isFinite(captured) ? captured : 0,
    snapshot: { ...raw, mmPricing: undefined },
    mmProbed: false,
    ok: true,
    source: "test/fixtures/orders.json",
  };
}

/** The live Base book, read-only. */
async function fromNetwork(): Promise<Probe> {
  const at = Date.now();
  const client = new ThetanutsClient({ chainId: CHAIN_ID, provider: new JsonRpcProvider(RPC_URL) });
  const chainConfig = client.chainConfig as unknown as QualifySnapshot["chainConfig"];
  /**
   * Named in the failure path: "the book is empty" and "the route we asked for
   * is gone" are different sentences, and only one of them is about the market.
   *
   * ⚠ This MUST be `apiBaseUrl`, not `indexerApiUrl`. `fetchOrders()` issues a
   * relative `get("/")` against the axios instance built on `apiBaseUrl`
   * (`dist/index.js:2585`); `indexerApiUrl` is a path *prefix* every other
   * caller appends a subpath to, so the bare URL 404s by design and always has.
   *
   * Printing the wrong field here once cost hours: a transport failure (local
   * TLS interception) printed an endpoint nobody calls, someone curled it, got
   * the expected 404, and the two unrelated facts fused into "the venue moved
   * its book". The book had never moved. A diagnostic that names the wrong
   * subject does not merely fail to help — it manufactures a false diagnosis
   * with a URL attached, which is far more convincing than no answer at all.
   */
  const bookUrl = (client as unknown as { apiBaseUrl?: string }).apiBaseUrl ?? "(unset)";

  /**
   * The order book is the load-bearing feed. Without it there is nothing to
   * measure, and printing an empty table would read as "no asset qualifies" —
   * a false claim about the market rather than a true one about the network.
   */
  let orders: readonly unknown[];
  try {
    orders = await client.api.fetchOrders();
  } catch (e) {
    console.error("");
    console.error("BOOK UNREACHABLE — fetchOrders() failed. No table: this is a network");
    console.error("result, not a market result, and an empty table would say the wrong thing.");
    console.error(`  endpoint  ${bookUrl}`);
    console.error(`  error     ${message(e)}`);
    console.error("");
    console.error("Re-run with --fixture to show the same gate over the frozen capture.");
    process.exit(1);
  }

  /** Spot is condition 1. If this is down every asset fails it, which is true of
   *  the app too — but say so, or the table looks like the market died. */
  let prices: Record<string, number> = {};
  let ok = true;
  try {
    prices = (await client.api.getMarketData()).prices ?? {};
  } catch (e) {
    ok = false;
    console.error(`SPOT UNREACHABLE — getMarketData() failed: ${message(e)}`);
    console.error("Every asset below will fail condition 1 for that reason and no other.");
    console.error("");
  }

  /**
   * MM pricing, probed per asset rather than assumed for ETH/BTC.
   *
   * `getPricingArray` is typed `('ETH' | 'BTC')` but does not throw on the other
   * six — it returns `[]` (FINDINGS §5.5). Asking all of them is the only way
   * the table can ever report an altcoin that gained a market maker, which is
   * exactly the fact a hardcoded pair would hide. The cast is the point, not an
   * oversight.
   */
  const mmPricing: Record<string, readonly unknown[]> = {};
  let mmProbed = true;
  for (const underlying of new Set(feedIndex(chainConfig?.priceFeeds).values())) {
    try {
      mmPricing[underlying] = await client.mmPricing.getPricingArray(underlying as "ETH" | "BTC");
    } catch (e) {
      // One asset failing is data; the pricing host being down is a caveat on
      // the whole GRADE column, and the table says `?` rather than `no`.
      mmProbed = false;
      console.error(`  mmPricing(${underlying}) failed: ${message(e)}`);
    }
  }
  if (!mmProbed) {
    console.error("MM PRICING INCOMPLETE — the GRADE column is unreliable this run.");
    console.error("It grades; it does not gate, so the qualify/reject verdicts still stand.");
    console.error("");
  }

  return {
    at,
    snapshot: { orders: orders as QualifySnapshot["orders"], prices, chainConfig, mmPricing },
    mmProbed,
    ok,
    source: `live Base ${CHAIN_ID}`,
  };
}

console.log("THETADUEL — asset gate probe");
console.log(`  chain     Base ${CHAIN_ID} via ${RPC_URL}`);
console.log(`  run       ${new Date().toISOString()}`);
console.log(
  `  gate      ≥${MIN_ORDERS} fillable orders, ≥${MIN_GREEKED} with a usable delta, ≥$${MIN_DEPTH_USDC} depth, spot readable`,
);

const probe = FIXTURE_MODE ? await fromFixture() : await fromNetwork();
const reports = probeAssets(probe.snapshot, probe.at);
const orderCount = probe.snapshot.orders?.length ?? 0;
const priceCount = Object.keys(probe.snapshot.prices ?? {}).length;

console.log("");
console.log(`  source    ${probe.source}, book as of ${new Date(probe.at).toISOString()}`);
console.log(`  read      ${orderCount} resting orders, ${priceCount} market prices, ${reports.length} price-feed assets`);
console.log("");
console.log(render(reports, probe.mmProbed));
console.log("");

const qualified = reports.filter((r) => r.qualified);
console.log(
  qualified.length === 0
    ? "NOTHING QUALIFIES on this book. The lobby greys every sector, with the reasons above."
    : `QUALIFIED: ${qualified
        .map((r) => `${r.underlying}${probe.mmProbed ? ` (${r.grade})` : ""}`)
        .join(", ")}`,
);
console.log(
  "MM pricing grades, it never gates — the resting order book is a separate source and covers more assets.",
);

process.exit(probe.ok ? 0 : 1);
