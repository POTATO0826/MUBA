import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { BOOK_HOST, FALLBACK_SERVERS, blockPageOwner, probeHost, type HostProbe } from "../src/server/resolver.ts";

/**
 * `bun run doctor` — the thing you run when the app does not work.
 *
 * ## Why this exists
 *
 * One condition — a network whose DNS filters `*.workers.dev`, and so filters
 * the Cloudflare Worker the Thetanuts order book is served from — has now cost
 * this project four separate investigations. Twice it was written down as a
 * Thetanuts outage (`docs/asset-gate.md` and `docs/plan6-audit.md` carry the
 * retractions), once it cost the owner an afternoon, and once it cost a
 * teammate who pulled the repo and got `ETH · NO BOARD` with nothing on screen
 * to say why. `src/server/resolver.ts` now routes around it automatically, but
 * a fallback cannot fix the other four ways a fresh clone fails: the wrong
 * runtime, no `bun install`, a stale pull, and the venue genuinely being down.
 *
 * So this turns "it's broken" into "here is the one line to fix", by measuring
 * seven things in the order a failure actually propagates and printing what it
 * measured. It is the first thing the README's Running block points at.
 *
 * ## The rules it works under, none of them negotiable
 *
 *  - **It never claims a cause it did not observe.** Every line is a
 *    measurement or an explicit "could not check, and here is why". If the two
 *    resolvers agree, it must not so much as mention `THETADUEL_DNS` — a
 *    confident wrong diagnosis about this exact host is the mistake this repo
 *    keeps making, and making it in a diagnostic tool would be the worst place
 *    of all.
 *  - **No secrets, ever.** `.env` holds `ATTESTOR_PRIVATE_KEY` and
 *    `DEPLOYER_PRIVATE_KEY`. This reports variable **names** and a
 *    set/empty/absent flag, and the parser is written so a value is never bound
 *    to a variable that could reach the output — not in a summary, not in an
 *    error message, not partially. `test/doctor.test.ts` drives a `.env` full
 *    of realistic-looking secrets through it and asserts none of them appears.
 *  - **It mutates nothing.** No writing `.env`, no installing, no `git fetch`,
 *    no `git` anything but reads. It diagnoses and prints; the human acts.
 *  - **It reports everything and stops at nothing.** A failed step does not
 *    end the run, because the interesting cases are the combinations — "the
 *    internet is fine AND the book's host resolves somewhere else" is the
 *    diagnosis, and neither half is one on its own.
 *  - **Plain output.** No spinners, no colour carrying meaning: it is written
 *    to be pasted into a chat window by someone asking for help.
 *
 * ## Shape
 *
 * `diagnose()` is a pure-ish function over injected edges and returns
 * {@link Finding}s; `render()` turns those into text; `main()` wires the real
 * edges and sets the exit code. That split is what lets the suite drive a
 * healthy tree, a filtered tree and a `.env` full of fake keys without touching
 * a network or a disk — which matters, because a diagnostic that only works on
 * a healthy machine is a diagnostic nobody can trust on a broken one.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Findings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `fail` is the only level that changes the exit code.
 *
 * `warn` is for things that are worth saying and are not, on their own, why the
 * app is broken — a dirty tree, a branch behind its last-known remote. `skip`
 * is for a check that could not run (no server on the port, no git), and it is
 * a first-class outcome rather than a silent omission: a report with a hole in
 * it that does not say so is how you end up diagnosing the wrong half.
 */
export type Level = "ok" | "warn" | "fail" | "skip";

export type Finding = {
  level: Level;
  /** Short label, printed after the marker. */
  title: string;
  /** What was measured. Facts and numbers; no advice. */
  detail: string[];
  /** The action, if there is one. Collected into "What to do" at the end. */
  fix?: string;
};

const MARKER: Record<Level, string> = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]", skip: "[skip]" };

// ─────────────────────────────────────────────────────────────────────────────
// The edges, all injectable
// ─────────────────────────────────────────────────────────────────────────────

export type ProcessInfo = {
  /** `"bun"`, `"node"`, or whatever else is executing this. */
  runtime: string;
  /** Version of that runtime, or `null` when it will not say. */
  version: string | null;
};

export type HttpResult =
  | { ok: true; status: number }
  | { ok: false; error: string };

export type GitResult = { ok: true; stdout: string } | { ok: false; error: string };

export type DoctorDeps = {
  process?: () => ProcessInfo;
  /** Absolute path of the repo root, used for `node_modules` and `.env`. */
  root?: string;
  exists?: (path: string) => boolean;
  /** The installed version of a dependency, or `null` if it does not resolve. */
  packageVersion?: (name: string) => string | null;
  /** Read-only git, please. `args` never contains a mutating verb. */
  git?: (args: string[]) => GitResult;
  /** A GET against a URL, for the connectivity control and the book host. */
  http?: (url: string) => Promise<HttpResult>;
  /** The two-resolver comparison — `probeHost` from `src/server/resolver.ts`. */
  probe?: () => Promise<HostProbe>;
  /** Raw `.env` text, or `null` when there is no such file. NEVER logged. */
  envText?: () => string | null;
  /** Where the dev server is expected. */
  port?: number;
};

/** The dependency whose absence means "you did not run `bun install`". */
const SDK = "@thetanuts-finance/thetanuts-client";

/**
 * A host that is not the venue and not on anybody's block list, used as the
 * control. Its whole job is to separate "this machine has no internet" from
 * "this machine has internet and cannot reach one specific host" — without it,
 * a total outage reads exactly like a targeted filter, which is the error this
 * file is built to prevent rather than commit.
 */
const CONTROL_URL = "https://example.com";

const BOOK_URL = `https://${BOOK_HOST}/`;

/** The variables worth reporting, in the order `.env.example` introduces them. */
const KNOWN_VARS: readonly string[] = [
  "WALLETCONNECT_PROJECT_ID",
  "RPC_URL",
  "THETADUEL_MARKET",
  "THETADUEL_OPTIONS",
  "THETADUEL_TRADE",
  "THETADUEL_STAKE",
  "THETADUEL_REFERRER",
  "THETADUEL_ESCROW",
  "ATTESTOR_PRIVATE_KEY",
  "THETADUEL_DNS",
  "DEPLOYER_PRIVATE_KEY",
];

// ─────────────────────────────────────────────────────────────────────────────
// The seven checks
// ─────────────────────────────────────────────────────────────────────────────

export async function diagnose(deps: DoctorDeps = {}): Promise<Finding[]> {
  const root = deps.root ?? process.cwd();
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const findings: Finding[] = [];

  // ── 1. Runtime ────────────────────────────────────────────────────────────
  // First, and plainly, because everything below is downstream of it: `bun dev`
  // is `bun --hot index.ts`, the server uses `Bun.serve`, `Bun.env` and Bun's
  // HTML bundler, and none of that has a Node equivalent here. A person who
  // reached for `npm run dev` and got a stack trace needs this sentence before
  // they read anything else.
  const proc = (deps.process ?? realProcess)();
  if (proc.runtime === "bun") {
    findings.push({ level: "ok", title: "Runtime", detail: [`Bun ${proc.version ?? "(unknown version)"}`] });
  } else {
    findings.push({
      level: "fail",
      title: "Runtime",
      detail: [
        `running under ${proc.runtime}${proc.version ? ` ${proc.version}` : ""}, not Bun`,
        `this project does not run on Node: the dev script is \`bun --hot index.ts\` and the`,
        `server is built on Bun.serve and Bun's HTML bundler.`,
      ],
      fix: `Install Bun (https://bun.sh) and use \`bun install\` and \`bun dev\` — not npm, not node.`,
    });
  }

  // ── 2. Dependencies ───────────────────────────────────────────────────────
  // `node_modules` is gitignored, so this is the state of every fresh clone
  // until somebody installs. Checked as "does the SDK resolve" rather than
  // "does the directory exist", because a half-finished install leaves the
  // directory there and the interesting package missing.
  const hasModules = exists(`${root}/node_modules`);
  const sdkVersion = (deps.packageVersion ?? realPackageVersion)(SDK);
  if (hasModules && sdkVersion !== null) {
    findings.push({ level: "ok", title: "Dependencies", detail: [`${SDK} ${sdkVersion}`] });
  } else {
    findings.push({
      level: "fail",
      title: "Dependencies",
      detail: [
        hasModules ? `node_modules exists but ${SDK} does not resolve` : `no node_modules directory`,
        `node_modules is gitignored — a fresh clone has none.`,
      ],
      fix: `Run \`bun install\`.`,
    });
  }

  // ── 3. Git position ───────────────────────────────────────────────────────
  findings.push(gitFinding(deps.git ?? realGit));

  // ── 4. General connectivity ───────────────────────────────────────────────
  const http = deps.http ?? realHttp;
  const control = await http(CONTROL_URL);
  findings.push(
    control.ok
      ? { level: "ok", title: "Connectivity", detail: [`${CONTROL_URL} → HTTP ${control.status}`] }
      : {
          level: "fail",
          title: "Connectivity",
          detail: [
            `${CONTROL_URL} → ${control.error}`,
            `this machine cannot reach a neutral host, so nothing below distinguishes`,
            `a filtered host from an offline machine.`,
          ],
          fix: `Get this machine online, then run \`bun run doctor\` again.`,
        },
  );

  // ── 5. The book host, specifically ────────────────────────────────────────
  const probe = await (deps.probe ?? (() => probeHost()))();
  const book = await http(BOOK_URL);
  const host = bookFinding(probe, book, control.ok);

  // ── 6. /api/market, if a server is running ────────────────────────────────
  const market = await marketFinding(deps.port ?? 3000);

  // Reconciled, because 5 and 6 can both be true and only one of them is the
  // user's problem. A filtered resolver with a *working* `/api/market` means
  // the automatic fallback already did its job: the board is real, and the
  // filter is a fact about the network rather than a fault to go and fix. It
  // stays in the report — this condition must never be silent again — but it
  // stops being a failure, because nothing here is failing.
  findings.push(
    host.level === "fail" && probe.disjoint && market.level === "ok"
      ? {
          ...host,
          level: "warn",
          detail: [...host.detail, `  /api/market below is answering anyway — the app resolved around this.`],
          fix:
            `Nothing, unless you want to. The app routes around the filter by itself and says so
` +
            `    in the footer and the server log. To leave your network's answer alone instead, put
` +
            `    THETADUEL_DNS=off in .env; to pin the resolvers explicitly, THETADUEL_DNS=${FALLBACK_SERVERS.join(",")}.`,
        }
      : host,
    market,
  );

  // ── 7. .env, names only ───────────────────────────────────────────────────
  findings.push(envFinding((deps.envText ?? (() => readEnv(root)))()));

  return findings;
}

/**
 * Current commit, branch, and position against the **last-known** remote ref.
 *
 * "Last-known" is load-bearing and is printed, not just meant: this does no
 * `git fetch`, because a diagnostic must not go changing the repository it is
 * diagnosing. So "up to date" here means "up to date with what your last fetch
 * saw", which is a weaker claim than it looks and is worth saying out loud —
 * a stale pull is a real cause of "the arena isn't there".
 */
function gitFinding(git: (args: string[]) => GitResult): Finding {
  const head = git(["rev-parse", "--short", "HEAD"]);
  if (!head.ok) {
    return {
      level: "skip",
      title: "Git position",
      detail: [`could not read: ${head.error}`, `(not a git checkout, or git is not on PATH)`],
    };
  }
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const detail = [`HEAD ${head.stdout}${branch.ok ? ` on ${branch.stdout}` : ""}`];

  const counts = git(["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
  let level: Level = "ok";
  let fix: string | undefined;
  if (!counts.ok) {
    detail.push(`no upstream configured for this branch — nothing to compare against`);
  } else {
    const [behindRaw = "0", aheadRaw = "0"] = counts.stdout.split(/\s+/);
    const behind = Number(behindRaw);
    const ahead = Number(aheadRaw);
    if (behind > 0) {
      level = "warn";
      detail.push(`${behind} commit(s) behind the upstream ref your last fetch saw`);
      fix = `Run \`git pull\` — this check does no fetch, so the real gap may be larger.`;
    } else {
      detail.push(`level with the upstream ref your last fetch saw (no fetch was performed)`);
    }
    if (ahead > 0) detail.push(`${ahead} local commit(s) not pushed`);
  }

  const dirty = git(["status", "--porcelain"]);
  if (dirty.ok && dirty.stdout !== "") {
    if (level === "ok") level = "warn";
    detail.push(`${dirty.stdout.split("\n").length} file(s) with uncommitted changes`);
  }
  return { level, title: "Git position", detail, ...(fix === undefined ? {} : { fix }) };
}

/**
 * The one check this whole file was written for: **both resolvers' answers,
 * printed**, and a verdict that follows from them rather than from a hunch.
 *
 * The verdict is a set comparison — two answers with no address in common — and
 * not a block-list lookup, because no list of every filtering vendor's
 * block-page range would ever be complete, while "your resolver is alone in its
 * opinion" catches all of them. A named range (`BLOCK_PAGE_RANGES`) only lets
 * the report say *whose* block page it is, when it happens to know.
 *
 * The four outcomes, and note that only one of them is allowed to say the word
 * "filter":
 *
 *   - answers disjoint → filtered, and the addresses are right there to check;
 *   - answers overlap, HTTP fails → **not** a DNS problem. Reported as a plain
 *     failure with no mention of `THETADUEL_DNS`, because suggesting it here is
 *     precisely the confident wrong diagnosis this repo has already made twice
 *     about this host;
 *   - answers overlap, HTTP fine → healthy;
 *   - a resolver did not answer → nothing concluded, and it says so.
 */
function bookFinding(probe: HostProbe, book: HttpResult, controlOk: boolean): Finding {
  const detail = [
    `${probe.host}`,
    `  this machine's resolver → ${probe.system.join(", ") || "(no answer)"}`,
    `  ${FALLBACK_SERVERS.join(" / ")} → ${probe.publicAnswer.join(", ") || "(no answer)"}`,
    `  direct HTTPS GET → ${book.ok ? `HTTP ${book.status}` : book.error}`,
  ];
  for (const address of probe.blocked) {
    detail.push(`  ${address} is a known ${blockPageOwner(address)}`);
  }
  if (probe.error) detail.push(`  probe note: ${probe.error}`);

  if (probe.system.length === 0 || probe.publicAnswer.length === 0) {
    return {
      level: controlOk ? "warn" : "skip",
      title: "Book host",
      detail: [...detail, `  one side did not answer, so nothing is concluded about filtering`],
    };
  }

  if (probe.disjoint) {
    return {
      level: "fail",
      title: "Book host",
      detail: [
        ...detail,
        `  the two answers share NO address. That is a local DNS filter, not a venue`,
        `  outage — *.workers.dev is blocked by category on many networks.`,
      ],
      fix:
        `The app now routes around this by itself (see src/server/resolver.ts) — start the\n` +
        `    server and check the board before doing anything else. To pin it explicitly, put\n` +
        `    THETADUEL_DNS=${FALLBACK_SERVERS.join(",")} in .env; to leave your network's answer alone,\n` +
        `    put THETADUEL_DNS=off there instead.`,
    };
  }

  if (!book.ok) {
    return {
      level: "fail",
      title: "Book host",
      detail: [
        ...detail,
        `  both resolvers agree on the address, so this is NOT a DNS filter. The host`,
        `  resolves correctly and did not serve. That is the venue's end, a proxy, or`,
        `  this machine's network in general.`,
      ],
      fix: `Nothing to change locally. Re-run in a few minutes; if the control host above was fine, the venue's end is the place to look.`,
    };
  }

  return { level: "ok", title: "Book host", detail };
}

/**
 * `/api/market` on the dev port, when there is one.
 *
 * A refused connection is `skip`, not `fail`: "no server running" is the
 * ordinary state of a machine somebody is about to start a server on, and
 * scoring it as a failure would bury the real one under a false one.
 */
async function marketFinding(port: number): Promise<Finding> {
  const url = `http://localhost:${port}/api/market`;
  let wire: {
    ok?: boolean;
    reason?: string;
    cause?: string;
    advisory?: string;
    orders?: unknown[];
    pricing?: Record<string, unknown[]>;
  };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    wire = (await response.json()) as typeof wire;
  } catch (error) {
    return {
      level: "skip",
      title: "/api/market",
      detail: [
        `no answer from ${url} (${error instanceof Error ? error.message : String(error)})`,
        `SKIPPED because no dev server is running on port ${port}. Everything above was`,
        `checked without one; start \`bun dev\` and re-run to include this.`,
      ],
    };
  }
  if (wire.ok !== true) {
    const detail = [`ok: false — reason: ${wire.reason ?? "(none given)"}`];
    if (wire.cause) detail.push(`cause: ${wire.cause}`);
    if (wire.advisory) detail.push(wire.advisory);
    return {
      level: wire.reason === "disabled" ? "warn" : "fail",
      title: "/api/market",
      detail,
      ...(wire.reason === "disabled"
        ? { fix: `THETADUEL_MARKET=off is set in .env. Remove it for the live book.` }
        : {}),
    };
  }

  const rows = Object.entries(wire.pricing ?? {})
    .map(([underlying, list]) => `${underlying}=${list.length}`)
    .join(" ");
  const detail = [`ok: true — ${(wire.orders ?? []).length} order rows, pricing rows ${rows || "(none)"}`];
  if (wire.advisory) detail.push(wire.advisory);
  return { level: "ok", title: "/api/market", detail };
}

/**
 * Which variables `.env` sets — **names only, never values**.
 *
 * The safety property is structural rather than careful: {@link envNames} keeps
 * the value only long enough to ask `!== ""` and returns a boolean, so there is
 * no point after the parser at which a value exists to be printed by a summary
 * line, an error path, or a future edit that forgets. `ATTESTOR_PRIVATE_KEY`
 * and `DEPLOYER_PRIVATE_KEY` live in this file; a doctor that leaked one into a
 * report somebody pastes into a chat window would be worse than no doctor.
 */
function envFinding(text: string | null): Finding {
  if (text === null) {
    return {
      level: "ok",
      title: ".env",
      detail: [
        `no .env file — which is fine. Every variable is optional and the app runs`,
        `without one: seeded wallet, live book, no chain writes.`,
      ],
    };
  }
  const set = envNames(text);
  const detail: string[] = [];
  for (const name of KNOWN_VARS) {
    const state = set.get(name);
    if (state === undefined) continue;
    detail.push(`  ${name} — ${state ? "set" : "present but empty"}`);
  }
  for (const [name, state] of set) {
    if (!KNOWN_VARS.includes(name)) detail.push(`  ${name} — ${state ? "set" : "present but empty"} (not in .env.example)`);
  }
  if (detail.length === 0) detail.push(`  (file present, no variables in it)`);
  return { level: "ok", title: ".env", detail: [`names only — no values are read out of this file:`, ...detail] };
}

/**
 * `NAME → is it non-empty`, for every assignment in a dotenv file.
 *
 * Returns a **boolean**, never the value. That is the entire security design of
 * this file and it is why the map is `Map<string, boolean>` and not
 * `Map<string, string>`: the type makes the leak unrepresentable rather than
 * merely unwritten.
 */
export function envNames(text: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const cut = trimmed.indexOf("=");
    if (cut <= 0) continue;
    const name = trimmed.slice(0, cut).replace(/^export\s+/, "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    // The only thing ever asked of the value, in one expression, so nothing
    // downstream is holding it. Quotes are stripped first so `KEY=""` reads as
    // empty rather than as two characters of secret.
    out.set(name, trimmed.slice(cut + 1).trim().replace(/^["']|["']$/g, "") !== "");
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The report.
 *
 * "What to do" is assembled from the `fix` of the findings that actually
 * failed, in the order they were measured — never a standing checklist. A
 * generic list of things to try is what a person already has; what they do not
 * have is the one line that applies to their machine right now.
 */
export function render(findings: readonly Finding[]): string {
  const lines: string[] = ["", "THETADUEL doctor", ""];
  for (const finding of findings) {
    lines.push(`${MARKER[finding.level]} ${finding.title}`);
    for (const line of finding.detail) lines.push(`       ${line}`);
    lines.push("");
  }

  const fixes = findings.filter((f) => (f.level === "fail" || f.level === "warn") && f.fix);
  if (fixes.length === 0) {
    const skipped = findings.filter((f) => f.level === "skip");
    lines.push(
      skipped.length === 0
        ? "Everything checked here is working. Nothing to do."
        : `Everything that could be checked is working (${skipped.length} skipped, see above). Nothing to do.`,
      "",
    );
    return lines.join("\n");
  }

  lines.push("What to do", "");
  for (const finding of fixes) lines.push(`  ${finding.title}: ${finding.fix}`, "");
  return lines.join("\n");
}

/** Only `fail` moves the needle — see {@link Level}. */
export function exitCodeFor(findings: readonly Finding[]): number {
  return findings.some((f) => f.level === "fail") ? 1 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// The real edges
// ─────────────────────────────────────────────────────────────────────────────

function realProcess(): ProcessInfo {
  // `Bun` is a global under Bun and absent everywhere else. Guarded with
  // `typeof` because this branch has to survive being evaluated by a runtime
  // that has never heard of it — which is exactly the case it reports on.
  if (typeof Bun !== "undefined") return { runtime: "bun", version: Bun.version };
  const versions = (globalThis as { process?: { versions?: { node?: string } } }).process?.versions;
  if (versions?.node) return { runtime: "node", version: versions.node };
  return { runtime: "unknown", version: null };
}

function realPackageVersion(name: string): string | null {
  try {
    const path = `${process.cwd()}/node_modules/${name}/package.json`;
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version?: string };
    return parsed.version ?? "(no version field)";
  } catch {
    return null;
  }
}

/** Read-only git. Every call site passes a query verb; none of them writes. */
function realGit(args: string[]): GitResult {
  try {
    const result = spawnSync("git", args, { encoding: "utf8" });
    if (result.error) return { ok: false, error: result.error.message };
    if (result.status !== 0) return { ok: false, error: (result.stderr || "").trim() || `exit ${result.status}` };
    return { ok: true, stdout: (result.stdout || "").trim() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function realHttp(url: string): Promise<HttpResult> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "manual" });
    return { ok: true, status: response.status };
  } catch (error) {
    // The message, not the object: an axios/undici error object stringifies to
    // a page of internals and this report is meant to be pasted somewhere.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readEnv(root: string): string | null {
  try {
    const path = `${root}/.env`;
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    // Deliberately not echoing the error: on a bad path it can contain the file
    // path, which is harmless, but this is the one function that has touched
    // secret bytes and the habit is worth more than the detail.
    return null;
  }
}

if (import.meta.main) {
  const findings = await diagnose();
  console.log(render(findings));
  process.exit(exitCodeFor(findings));
}
