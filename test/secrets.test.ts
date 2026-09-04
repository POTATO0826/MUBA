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
 * On patterns: the naive scan for the literal strings `RPC_URL` and
 * `alchemy.com` false-positives on our dependencies before a line of our code
 * is written — `@reown/appkit` ships a `BLOCKCHAIN_API_RPC_URL` constant and
 * viem's chain registry lists ~18 public `*.g.alchemy.com/public` endpoints for
 * chains we have nothing to do with. So each pattern is written to match the
 * leak and not the library: the *bare* env-var identifier (not a suffix of some
 * vendor constant) and a *keyed* Alchemy endpoint (`alchemy.com/v2/<key>`,
 * which is the only shape that carries our secret). The 64-hex-character
 * private-key heuristic from the plan is deliberately NOT used: the bundle
 * contains 984 such runs (contract addresses, hashes, ABI selectors, chain
 * salts) and it would fail every run for reasons that are never our bug.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist");
const SRC = join(ROOT, "src");

const distFiles = () => [...new Bun.Glob("**/*.js").scanSync({ cwd: DIST, absolute: true })];

/** Newest mtime across a set of paths; 0 if there are none. */
const newest = (paths: readonly string[]): number =>
  paths.reduce((max, p) => Math.max(max, statSync(p).mtimeMs), 0);

/**
 * The build is an input to this test, so the test owns it: if `dist/` is empty
 * or older than the newest source file, run `bun run build` before scanning.
 * Scanning a stale bundle would pass while the real one leaked.
 */
function ensureFreshBuild(): { built: boolean; reason: string } {
  const before = distFiles();
  const sources = [
    join(ROOT, "index.ts"),
    ...new Bun.Glob("**/*.{ts,tsx,html,css}").scanSync({ cwd: SRC, absolute: true }),
  ];
  const reason =
    before.length === 0 ? "dist/ was empty" : newest(sources) > newest(before) ? "dist/ was stale" : "";
  if (!reason) return { built: false, reason: "dist/ was already fresh" };

  const build = Bun.spawnSync(["bun", "run", "build"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) {
    throw new Error(`bun run build failed (${reason}):\n${build.stderr.toString()}`);
  }
  return { built: true, reason };
}

const build = ensureFreshBuild();
const BUNDLES = distFiles();
const TEXT = BUNDLES.map((path) => ({ path, text: Bun.file(path).text() }));

afterAll(() => {
  console.log(`  secrets scan: ${BUNDLES.length} bundle file(s) — ${build.reason}`);
});

/** Every scan reports which file leaked, because "a secret is in dist" is
 *  useless without knowing which chunk to go read. */
async function offenders(re: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const { path, text } of TEXT) {
    const hit = (await text).match(re);
    if (hit) out.push(`${path.slice(ROOT.length + 1).replaceAll("\\", "/")} → ${hit[0]}`);
  }
  return out;
}

describe("secrets never reach the client bundle", () => {
  test("the scan actually has something to scan", () => {
    // A missing build would make every assertion below pass vacuously.
    expect(BUNDLES.length).toBeGreaterThanOrEqual(1);
  });

  test("no bundle mentions ATTESTOR_PRIVATE_KEY", async () => {
    // src/server/attest.ts reads this and nothing under src/ may import it.
    expect(await offenders(/ATTESTOR_PRIVATE_KEY/)).toEqual([]);
  });

  test("no bundle mentions DEPLOYER_PRIVATE_KEY", async () => {
    // contracts/deploy.ts only — it is not part of the app at all.
    expect(await offenders(/DEPLOYER_PRIVATE_KEY/)).toEqual([]);
  });

  test("no bundle mentions the bare RPC_URL env var", async () => {
    // Bare, so @reown's BLOCKCHAIN_API_RPC_URL stays legal — see the header.
    expect(await offenders(/(?<![A-Za-z0-9_])RPC_URL/)).toEqual([]);
  });

  test("no bundle carries a keyed Alchemy endpoint", async () => {
    // `*.g.alchemy.com/public` is viem's chain registry and is fine; the `/v2/`
    // form is the only one that carries an API key, and it is ours.
    expect(await offenders(/alchemy\.com\/v2\//)).toEqual([]);
  });

  test("no bundle carries the literal value of a server-only env var", async () => {
    // The strongest check available and the cheapest: if the operator running
    // the suite has these set, their actual values must not appear anywhere.
    for (const name of ["RPC_URL", "ATTESTOR_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY"]) {
      const value = Bun.env[name];
      // Short values would be noise (an unset var is ""); real ones are long.
      if (!value || value.length < 16) continue;
      const escaped = value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(await offenders(new RegExp(escaped))).toEqual([]);
    }
  });
});
