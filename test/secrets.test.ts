/**
 * The secrets gate: nothing that must stay on the server may reach the bundle.
 *
 * The Thetanuts integration introduces the first genuinely dangerous env vars
 * this app has had — a private RPC key, a settlement-signing key, a deploy key.
 * Bun's HTML bundler happily inlines a `Bun.env.X` read that ends up in a
 * client module, and the failure is silent: the app works, the key ships. This
 * test is the thing that notices.
 *
 * The rule it enforces: server-only names and server-only *values* never occur
 * in `dist/**\/*.js`. Everything the client legitimately needs travels over
 * `/api/config` at runtime instead, where an operator can see it.
 *
 * ── Why this file builds its own bundle ──────────────────────────────────────
 * A gate that passes because it had nothing current to look at is worse than no
 * gate: it reports safety. `bun build --outdir=dist` never removed what was
 * already there, and its chunk hash changes on every run even when nothing
 * changed, so `dist/` accumulated one 6.5 MB bundle per build forever. The scan
 * then ran over a *union of build history* — which cuts both ways: a leak fixed
 * this morning still fails from a bundle built last night, and (much worse) a
 * build that produced nothing at all still leaves enough old `.js` lying around
 * for "we scanned something" to look true. So: `package.json`'s build script
 * now clears `dist/` first, and this suite wipes `dist/` and rebuilds before it
 * reads a byte. Everything it scans, it made. A build failure fails the suite;
 * it is never a printed note.
 *
 * ── Why the patterns look the way they do ────────────────────────────────────
 * A naive scan for `RPC_URL` or `alchemy.com` false-positives before a line of
 * our code is written, and a gate that cries wolf gets loosened until it is
 * decorative. So each rule matches the *leak shape* rather than a keyword:
 *
 *   • `RPC_URL` bare is legal. Our own client says "set a private RPC_URL (see
 *     .env.example) and reload" (src/desk/fill.ts) — an operator hint carrying
 *     no secret — and @reown/appkit ships a `BLOCKCHAIN_API_RPC_URL` constant
 *     pointing at its public relay. What is never legal is *reading* the var
 *     (`Bun.env.RPC_URL`) or *binding it to a value* (`RPC_URL="https://…"`).
 *   • A bare vendor hostname is legal: ethers' `AlchemyProvider` carries a table
 *     of ~31 `*.g.alchemy.com` hosts and viem lists `/public` endpoints for
 *     chains we have nothing to do with. What is never legal is a host followed
 *     by a path segment long and random enough to be a real key — and even then
 *     an obvious placeholder (`YOUR_ALCHEMY_KEY`) is not a secret.
 *   • A 64-hex run cannot be judged on shape: this bundle contains 544 of them
 *     (secp256k1 field/order/generator constants, endomorphism scalars, noble's
 *     test vectors), 142 of them `0x`-prefixed. An unconditional rule would fail
 *     every run for reasons that are never our bug, which is how gates die. So a
 *     64-hex literal is flagged only in secret-bearing *context* — within 160
 *     chars of a word-initial `privateKey` / `mnemonic` / `signingKey` /
 *     `secretKey`. (Word-initial matters: noble exports `randomPrivateKey` two
 *     hundred bytes from a curve constant.) The positive controls below prove
 *     the realistic leak shape is caught.
 *   • A mnemonic is checked for real: the candidate is run through ethers'
 *     BIP-39 validator, checksum and all, so prose can never trip it.
 *
 * Every allowance above is narrow and names the vendor it exists for. There is
 * no blanket ignore anywhere in this file.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { Mnemonic } from "ethers";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");

// ─── The scanner ─────────────────────────────────────────────────────────────
// Pure, exported, and the ONLY way anything is inspected — the real bundle and
// the synthetic fixtures at the bottom of this file go through identical code,
// so a rule cannot rot into a no-op without a positive control noticing.

export type Finding = { readonly rule: string; readonly file: string; readonly match: string };

/** A leaked secret must not be echoed verbatim into a CI log. */
const redact = (s: string): string => (s.length <= 12 ? s : `${s.slice(0, 6)}…${s.slice(-4)}`);

/** Same, but keeps the context that tells you where to go looking. */
const redactHex = (s: string): string =>
  s.replaceAll(/(?:0x)?[0-9a-fA-F]{64}/g, "<64-hex redacted>").replaceAll(/\s+/g, " ").slice(0, 120);

/**
 * Server-only modules, each keyed by a string literal that exists in it and
 * nowhere else. If one of these turns up in client output, an entire server
 * module was pulled into the graph and every secret it reads came with it.
 *
 * Each marker is a *runtime* literal, not a phrase from a comment: `--minify`
 * strips comments, so a comment-borne marker would be a rule that can never
 * fire (the first draft of this list made exactly that mistake, and the
 * plant-a-leak drill is what caught it). Minifiers rewrite identifiers, not
 * string literals, so these survive the bundler intact. `markers stay attached
 * to their modules` below fails if one is ever edited away, so the rule cannot
 * silently stop meaning anything.
 */
export const SERVER_MARKERS: ReadonlyArray<readonly [file: string, marker: string]> = [
  ["src/server/attest.ts", "opponent is not the on-chain seat"],
  ["src/server/seats.ts", "seats not configured"],
  // thetanuts.ts is nearly all template literals; this is its one stable plain
  // fragment. It also reads Bun.env.RPC_URL at module scope, so bundling it
  // trips the env-read rule as well — this marker is the belt to that braces.
  ["src/server/thetanuts.ts", "stale — refresh failed:"],
  ["contracts/deploy.ts", "compiled artifact is stale; run bun contracts/build.ts and review it"],
];

/** The names that must never be read, and whose values must never be bound. */
const SERVER_ONLY_VARS = [
  "RPC_URL",
  "ESCROW_RPC_URL",
  "ATTESTOR_PRIVATE_KEY",
  "DEPLOYER_PRIVATE_KEY",
] as const;
const VARS = SERVER_ONLY_VARS.join("|");

/** Hosts that sell keyed RPC access. A hostname alone is a vendor's routing
 *  table; a hostname plus a key is our money. */
const PROVIDER_HOST =
  String.raw`(?:[a-z0-9-]+\.)*(?:alchemy\.com|infura\.io|quiknode\.pro|ankr\.com|blastapi\.io` +
  String.raw`|nodereal\.io|drpc\.org|chainstacklabs\.com|blockpi\.network|getblock\.io` +
  String.raw`|tenderly\.co|thirdweb\.com|moralis\.io)`;

/** A path segment or query value long and dense enough to be a real API key. */
const KEYISH = String.raw`[A-Za-z0-9_-]{20,}`;

/** …unless it is plainly a stand-in. Documentation ships these on purpose and
 *  they authorise nothing; failing on them teaches people to mute the gate. */
const PLACEHOLDER = /your|placeholder|example|apikey|api_key|_key|key_|token|secret|xxxx|<|\.\.\./i;
const isPlaceholder = (candidate: string): boolean =>
  PLACEHOLDER.test(candidate) || new Set(candidate.toLowerCase()).size <= 2;

/** The four sizes BIP-39 defines; anything else cannot be a wallet phrase. */
const MNEMONIC_SIZES = [12, 15, 18, 21, 24] as const;

const all = (text: string, re: RegExp): string[] => [...new Set([...text.matchAll(re)].map((m) => m[0]))];

type Rule = { readonly name: string; readonly find: (text: string) => string[] };

const RULES: readonly Rule[] = [
  {
    // A name that exists only in src/server/attest.ts and contracts/deploy.ts.
    // No client string has any reason to contain it, so bare is sharp enough.
    name: "server-only env name in client output",
    find: (t) => all(t, /(?<![A-Za-z0-9_])(?:ATTESTOR_PRIVATE_KEY|DEPLOYER_PRIVATE_KEY)(?![A-Za-z0-9_])/g),
  },
  {
    // The read itself. The leading lookbehind is what keeps @reown/appkit's
    // BLOCKCHAIN_API_RPC_URL — a vendor constant whose NAME merely ends in
    // RPC_URL — out of it.
    name: "server-only env var read in client output",
    find: (t) =>
      all(
        t,
        new RegExp(
          String.raw`(?:(?:process|Bun|globalThis)\s*\.\s*env|import\s*\.\s*meta\s*\.\s*env)\s*` +
            String.raw`(?:\.\s*(?:${VARS})(?![A-Za-z0-9_])|\[\s*["'\`](?:${VARS})["'\`]\s*\])`,
          "g",
        ),
      ),
  },
  {
    // The var bound to a literal — `RPC_URL="https://…"`, `"RPC_URL":"0x…"`.
    // This is the shape src/desk/fill.ts's help text used to ship. Prose that
    // merely names the variable ("set a private RPC_URL (see .env.example)")
    // has no `=` and no value, so it stays legal. Again lookbehind-guarded so
    // BLOCKCHAIN_API_RPC_URL:"https://rpc.walletconnect.org" is not a hit.
    name: "server-only env var bound to a literal value",
    find: (t) => all(t, new RegExp(String.raw`(?<![A-Za-z0-9_])(?:${VARS})\s*[=:]\s*["'\`][^"'\`\s]{8,}`, "g")),
  },
  {
    // Provider host + a key-shaped path segment. `*.g.alchemy.com` on its own
    // (ethers' AlchemyProvider table) and `…/public` (viem's chain registry)
    // are both too short / too plain to reach here.
    name: "keyed provider endpoint",
    find: (t) =>
      all(t, new RegExp(PROVIDER_HOST + String.raw`(?:\/[A-Za-z0-9._~-]+)*?\/(${KEYISH})`, "g")).filter(
        (hit) => !isPlaceholder(hit.slice(hit.lastIndexOf("/") + 1)),
      ),
  },
  {
    // The same secret smuggled as a query parameter, on any host.
    name: "keyed endpoint query parameter",
    find: (t) =>
      all(
        t,
        new RegExp(String.raw`[?&](?:api[-_]?key|apikey|access[-_]?token|auth[-_]?token|key|token)=(${KEYISH})`, "gi"),
      ).filter((hit) => !isPlaceholder(hit.slice(hit.indexOf("=") + 1))),
  },
  {
    // 64 hex, with or without 0x, in secret-bearing context — see the header
    // for why context is mandatory here and nowhere else.
    name: "private key literal",
    find: (t) =>
      all(
        t,
        /(?<![A-Za-z])(?:private[_\s-]?key|mnemonic|signing[_\s-]?key|secret[_\s-]?key)[\s\S]{0,160}?["'`](?:0x)?[0-9a-fA-F]{64}["'`]/gi,
      ).map(redactHex),
  },
  {
    name: "mnemonic phrase",
    find: (t) => {
      const out: string[] = [];
      for (const run of new Set([...t.matchAll(/\b[a-z]{3,8}(?: [a-z]{3,8}){11,23}\b/g)].map((m) => m[0]))) {
        const words = run.split(" ");
        for (const n of MNEMONIC_SIZES) {
          if (words.length < n) break;
          const phrase = words.slice(0, n).join(" ");
          // Checksum-validated, so English prose cannot reach this line.
          if (Mnemonic.isValidMnemonic(phrase)) out.push(redact(phrase));
        }
      }
      return out;
    },
  },
  {
    name: "server-only module bundled",
    find: (t) => SERVER_MARKERS.filter(([, marker]) => t.includes(marker)).map(([file]) => file),
  },
];

/**
 * Scan one bundle file. `secretValues` are literal strings that must not appear
 * anywhere — in the real scan, the operator's own env; in the positive controls,
 * a synthetic one.
 */
export function scanBundle(file: string, text: string, secretValues: readonly string[] = []): Finding[] {
  const findings: Finding[] = RULES.flatMap((rule) =>
    rule.find(text).map((match) => ({ rule: rule.name, file, match })),
  );
  for (const value of secretValues) {
    // An unset env var reads as ""; short values would be noise, real ones are long.
    if (!value || value.length < 16) continue;
    if (text.includes(value)) {
      findings.push({ rule: "literal value of a server-only env var", file, match: redact(value) });
    }
  }
  return findings;
}

// ─── The build this suite owns ───────────────────────────────────────────────

const distFiles = () => [...new Bun.Glob("**/*.js").scanSync({ cwd: DIST, absolute: true })];

/**
 * Wipe and rebuild, unconditionally. A build is ~0.9s — cheaper than any scheme
 * for proving a bundle on disk corresponds to the code we mean to police. After
 * this returns, everything in `dist/` was written by this call, and `startedAt`
 * lets the tests below say so out loud.
 */
function buildFresh(): { startedAt: number; error: string | null } {
  const startedAt = Date.now();
  rmSync(DIST, { recursive: true, force: true });
  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  return {
    startedAt,
    error: build.exitCode === 0 ? null : `bun run build exited ${build.exitCode}:\n${build.stderr.toString()}`,
  };
}

const BUILD = buildFresh();
const BUNDLES = BUILD.error ? [] : distFiles();
const TEXTS = await Promise.all(BUNDLES.map(async (path) => ({ path, text: await Bun.file(path).text() })));

/** Filesystems round mtimes (FAT to 2s); the rm above is the real guarantee. */
const MTIME_SLACK_MS = 2_000;
const rel = (p: string) => p.slice(ROOT.length + 1).replaceAll("\\", "/");

afterAll(() => {
  console.log(`  secrets scan: ${BUNDLES.length} bundle file(s), all built by this run`);
});

describe("secrets never reach the client bundle", () => {
  test("the build this suite scans actually succeeded", () => {
    // Not a printed note. A build we could not run is a gate we cannot claim.
    expect(BUILD.error).toBeNull();
  });

  test("the scan has something to scan", () => {
    // Without this, every assertion below would pass by scanning nothing.
    expect(BUNDLES.length).toBeGreaterThanOrEqual(1);
  });

  test("every file scanned was written by this run", () => {
    // `dist/` was removed a moment ago, so anything here is ours; the mtimes
    // are the second lock, in case the removal ever silently fails.
    const stale = BUNDLES.filter((p) => statSync(p).mtimeMs < BUILD.startedAt - MTIME_SLACK_MS).map(rel);
    expect(stale).toEqual([]);
  });

  test("no bundle carries a secret", () => {
    // The operator's own env is the strongest check available and the cheapest:
    // if RPC_URL / ATTESTOR_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY are set in this
    // shell, their actual values must not appear anywhere in client output.
    const secretValues = SERVER_ONLY_VARS.map((name) => {
      const value = Bun.env[name] ?? "";
      // This exact, keyless public endpoint also belongs in the browser's
      // Base Sepolia network registry. Custom/keyed RPCs remain secret.
      if (name === "ESCROW_RPC_URL" && value === "https://sepolia.base.org") return "";
      return value;
    });
    const findings = TEXTS.flatMap(({ path, text }) => scanBundle(rel(path), text, secretValues));
    expect(findings.map((f) => `${f.file} → ${f.rule}: ${f.match}`)).toEqual([]);
  });
});

// ─── Positive controls ───────────────────────────────────────────────────────
// The gate's own alarm test. These run the SAME scanBundle over content we
// synthesise, so "the suite is green" can never again mean "the scanner does
// nothing". Each fixture is a leak shape we would actually ship if we blundered.

const caught = (text: string, secrets: readonly string[] = []) =>
  scanBundle("fixture.js", text, secrets).map((f) => f.rule);

describe("the scanner catches what it claims to (positive controls)", () => {
  test("a keyed provider endpoint", () => {
    const leak = `var t="https://base-mainnet.g.alchemy.com/v2/Xk3nQ7pR2sT9vW1yB4dF6hJ8mN0qA5cZ";`;
    expect(caught(leak)).toContain("keyed provider endpoint");
  });

  test("a keyed endpoint smuggled as a query parameter", () => {
    const leak = `fetch("https://rpc.example.net/base?apikey=Xk3nQ7pR2sT9vW1yB4dF6hJ8mN0qA5cZ")`;
    expect(caught(leak)).toContain("keyed endpoint query parameter");
  });

  test("a 0x-prefixed private key", () => {
    const leak = `var w={privateKey:"0x4c0883a69102937d6231471b5dbb6204fe512961708279dbf2f2e0a1c4e6d3a9"};`;
    expect(caught(leak)).toContain("private key literal");
  });

  test("a private key with no 0x prefix", () => {
    const leak = `const signingKey = "4c0883a69102937d6231471b5dbb6204fe512961708279dbf2f2e0a1c4e6d3a9";`;
    expect(caught(leak)).toContain("private key literal");
  });

  test("a mnemonic phrase", () => {
    const leak = `var m="test test test test test test test test test test test junk";`;
    expect(caught(leak)).toContain("mnemonic phrase");
  });

  test("a server-only module dragged into the bundle", () => {
    // src/server/seats.ts's own miss reason, verbatim.
    expect(caught(`return{ok:!1,reason:"seats not configured"}`)).toContain("server-only module bundled");
  });

  test("a server-only env var name", () => {
    expect(caught(`Bun.env.ATTESTOR_PRIVATE_KEY`)).toContain("server-only env name in client output");
  });

  test("a server-only env var read", () => {
    expect(caught(`const u=process.env["RPC_URL"]||"";`)).toContain("server-only env var read in client output");
  });

  test("a server-only env var bound to a value", () => {
    // The exact shape src/desk/fill.ts's help string used to ship.
    const leak = `RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY"`;
    expect(caught(leak)).toContain("server-only env var bound to a literal value");
  });

  test("the operator's literal secret, whatever shape it takes", () => {
    const secret = "https://base-mainnet.example/v2/not-a-shape-any-rule-knows";
    expect(caught(`var e=${JSON.stringify(secret)};`, [secret])).toContain(
      "literal value of a server-only env var",
    );
  });

  test("a leaked secret is never echoed whole", () => {
    const secret = "0x4c0883a69102937d6231471b5dbb6204fe512961708279dbf2f2e0a1c4e6d3a9";
    const [finding] = scanBundle("fixture.js", `var k=${JSON.stringify(secret)};`, [secret]);
    expect(finding?.match).not.toContain(secret);
  });
});

// ─── Negative controls ───────────────────────────────────────────────────────
// The other half of the contract: each of these is real third-party or
// first-party content that used to fail, or would fail under a lazier rule.
// If one of them starts tripping, the gate has become a nuisance and someone
// will loosen it — so they are assertions too.

describe("the scanner does not cry wolf (negative controls)", () => {
  test("@reown/appkit's BLOCKCHAIN_API_RPC_URL constant", () => {
    expect(caught(`BLOCKCHAIN_API_RPC_URL:"https://rpc.walletconnect.org"`)).toEqual([]);
  });

  test("ethers' AlchemyProvider hostname table", () => {
    expect(caught(`case"base":return"base-mainnet.g.alchemy.com";case"optimism":return"opt-mainnet.g.alchemy.com"`)).toEqual([]);
  });

  test("viem's public chain-registry endpoints", () => {
    expect(caught(`{http:["https://base-mainnet.g.alchemy.com/public"]}`)).toEqual([]);
  });

  test("our own operator hint naming the variable", () => {
    // src/desk/fill.ts — no value, no read, no secret.
    expect(caught(`"The public Base RPC is throttling. Set a private RPC_URL (see .env.example) and reload."`)).toEqual([]);
  });

  test("noble-curves' secp256k1 constants beside randomPrivateKey", () => {
    // The exact adjacency that a word-boundary-free rule trips on.
    const vendor =
      `{randomPrivateKey:q.utils.randomPrivateKey,lift_x:y}}))(),P=(()=>f(s,[["0x8e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38e38daaaaa8c7",` +
      `"0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"]]))()`;
    expect(caught(vendor)).toEqual([]);
  });

  test("documentation placeholders are not secrets", () => {
    expect(caught(`"https://base-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY_HERE"`)).toEqual([]);
  });

  test("prose is not a mnemonic", () => {
    expect(caught(`"link listing main marquee menu menuitem meta nav noembed noframes noscript object"`)).toEqual([]);
  });
});

describe("the gate cannot rot", () => {
  test("markers stay attached to their modules", async () => {
    // If someone rewords one of these strings, this fails loudly instead of the
    // module-bundled rule quietly becoming a no-op.
    for (const [file, marker] of SERVER_MARKERS) {
      const source = await Bun.file(join(ROOT, file)).text();
      expect(`${file}: ${source.includes(marker)}`).toBe(`${file}: true`);
    }
  });
});
