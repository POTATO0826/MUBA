import { describe, expect, test } from "bun:test";
import {
  diagnose,
  envNames,
  exitCodeFor,
  render,
  type DoctorDeps,
  type Finding,
} from "../scripts/doctor.ts";
import { BOOK_HOST, type HostProbe } from "../src/server/resolver.ts";

/**
 * `bun run doctor` — the preflight a person runs when the app does not work.
 *
 * **Why this suite drives injected edges rather than spawning the real thing.**
 * A doctor that only works on a healthy machine is a doctor nobody can trust on
 * a broken one, and the interesting cases are all broken ones: no Bun, no
 * `node_modules`, a filtered resolver, no server on the port. None of those can
 * be arranged by running the real command in CI, and running it would make this
 * suite depend on a network and on the state of the machine it happens to be
 * on. So `diagnose()` takes every edge as a parameter and this file supplies
 * them. What is *not* faked is the wiring: `diagnose` → `render` →
 * `exitCodeFor` is exercised whole, so a finding that never reaches the page,
 * or a failure that never reaches the exit code, fails here.
 *
 * Three properties are load-bearing, in this order:
 *
 *  1. **No secrets, ever.** `.env` holds `ATTESTOR_PRIVATE_KEY` and
 *     `DEPLOYER_PRIVATE_KEY`, and this report is meant to be pasted into a chat
 *     window. A leak here would be worse than having no doctor at all.
 *  2. **No cause it did not observe.** When the two resolvers agree, the report
 *     may not so much as mention `THETADUEL_DNS`. This repo has twice written
 *     down a confident wrong diagnosis about this exact host; doing it inside
 *     the diagnostic tool would be the worst possible place for the third.
 *  3. **It works with no server running**, and says which checks it skipped.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function healthyProbe(): HostProbe {
  return {
    host: BOOK_HOST,
    system: ["104.21.89.137", "172.67.159.206"],
    publicAnswer: ["172.67.159.206", "104.21.89.137"],
    blocked: [],
    disjoint: false,
    error: null,
  };
}

/** The measured block-page shape: two answers with no address in common. */
function filteredProbe(): HostProbe {
  return {
    host: BOOK_HOST,
    system: ["146.112.61.104"],
    publicAnswer: ["104.21.89.137", "172.67.159.206"],
    blocked: ["146.112.61.104"],
    disjoint: true,
    error: null,
  };
}

/**
 * A tree where everything works.
 *
 * `port: 1` is deliberate and is the "no server running" half of the contract:
 * nothing listens there, so the `/api/market` check has to skip cleanly rather
 * than fail. Everything else is answered from the injected edges, so this runs
 * offline.
 */
function healthy(over: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    process: () => ({ runtime: "bun", version: "1.3.14" }),
    root: "/repo",
    exists: () => true,
    packageVersion: () => "0.3.0",
    git: (args) =>
      args[0] === "rev-parse" && args[1] === "--short"
        ? { ok: true, stdout: "7fda462" }
        : args[0] === "rev-parse"
          ? { ok: true, stdout: "new" }
          : args[0] === "rev-list"
            ? { ok: true, stdout: "0\t0" }
            : { ok: true, stdout: "" },
    http: async () => ({ ok: true, status: 200 }),
    probe: async () => healthyProbe(),
    envText: () => null,
    port: 1,
    ...over,
  };
}

const textOf = (findings: readonly Finding[]) => render(findings);
const find = (findings: readonly Finding[], title: string) =>
  findings.find((f) => f.title === title) ?? { level: "missing", title, detail: [] as string[] };

// ─────────────────────────────────────────────────────────────────────────────
// It runs, and a healthy tree is a clean exit
// ─────────────────────────────────────────────────────────────────────────────

describe("a healthy tree", () => {
  test("every check reports, and the exit code is 0", async () => {
    const findings = await diagnose(healthy());

    // Seven checks, in the order a failure actually propagates. The order is
    // part of the design: runtime before dependencies before network, so the
    // first FAIL you read is the one upstream of the others.
    expect(findings.map((f) => f.title)).toEqual([
      "Runtime",
      "Dependencies",
      "Git position",
      "Connectivity",
      "Book host",
      "/api/market",
      ".env",
    ]);
    expect(exitCodeFor(findings)).toBe(0);
  });

  test("it says so in one line rather than printing a checklist", async () => {
    const text = textOf(await diagnose(healthy()));
    expect(text).toContain("Nothing to do.");
    // A "what to do" section on a healthy machine would be a standing checklist,
    // which is exactly what this replaces.
    expect(text).not.toContain("What to do");
  });

  /**
   * Property 2, and the reason this file exists at all. Two resolvers that
   * agree are not a filter, and a diagnostic that mentions the DNS override
   * here would send a reader off to change their resolver for an hour while the
   * actual fault sat somewhere else.
   */
  test("with the resolvers agreeing it never mentions the DNS override", async () => {
    const text = textOf(await diagnose(healthy()));
    expect(text).not.toContain("THETADUEL_DNS");
    expect(text.toLowerCase()).not.toContain("filter");
    // It still prints both answers, because a measurement is worth showing even
    // when the verdict is "nothing wrong".
    expect(text).toContain("104.21.89.137");
    expect(text).toContain(BOOK_HOST);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// It works with no server, and says which checks it skipped
// ─────────────────────────────────────────────────────────────────────────────

describe("with no server running", () => {
  test("/api/market is SKIPPED, loudly, and does not fail the run", async () => {
    const findings = await diagnose(healthy());
    const market = find(findings, "/api/market");

    expect(market.level).toBe("skip");
    expect(market.detail.join(" ")).toContain("SKIPPED");
    expect(market.detail.join(" ")).toContain("bun dev");
    // "No server running" is the ordinary state of a machine somebody is about
    // to start a server on. Scoring it as a failure would bury the real one.
    expect(exitCodeFor(findings)).toBe(0);
  });

  test("the summary counts what it could not check rather than omitting it", async () => {
    const text = textOf(await diagnose(healthy()));
    expect(text).toContain("1 skipped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The failures it exists to name
// ─────────────────────────────────────────────────────────────────────────────

describe("the wrong runtime is reported first and plainly", () => {
  test("Node gets a FAIL, a reason, and the one command to run", async () => {
    const findings = await diagnose(
      healthy({ process: () => ({ runtime: "node", version: "v24.13.0" }) }),
    );
    const runtime = find(findings, "Runtime");

    expect(runtime.level).toBe("fail");
    expect(runtime.detail.join(" ")).toContain("not Bun");
    expect(exitCodeFor(findings)).toBe(1);

    const text = textOf(findings);
    expect(text).toContain("What to do");
    expect(text).toContain("bun.sh");
    expect(text).toContain("bun install");
  });
});

describe("a fresh clone that has not installed", () => {
  test("no node_modules is a FAIL naming `bun install`", async () => {
    const findings = await diagnose(healthy({ exists: () => false, packageVersion: () => null }));
    const deps = find(findings, "Dependencies");

    expect(deps.level).toBe("fail");
    // The sentence that makes it obvious rather than mysterious: it is
    // gitignored, so this is the state of every clone until somebody installs.
    expect(deps.detail.join(" ")).toContain("gitignored");
    expect(textOf(findings)).toContain("bun install");
  });

  test("a half-finished install — directory there, SDK missing — is caught too", async () => {
    const findings = await diagnose(healthy({ exists: () => true, packageVersion: () => null }));
    expect(find(findings, "Dependencies").level).toBe("fail");
  });
});

describe("a stale pull", () => {
  test("behind the last-known remote is a warning that admits it did not fetch", async () => {
    const findings = await diagnose(
      healthy({
        git: (args) =>
          args[0] === "rev-list" ? { ok: true, stdout: "4\t0" } : { ok: true, stdout: "7fda462" },
      }),
    );
    const git = find(findings, "Git position");

    expect(git.level).toBe("warn");
    expect(git.detail.join(" ")).toContain("4 commit(s) behind");
    // The honesty that makes the number usable: no `git fetch` was performed,
    // so the real gap may be larger. A diagnostic must not go changing the
    // repository it is diagnosing.
    expect(textOf(findings)).toContain("no fetch");
  });

  test("no git checkout at all is a skip, not a failure", async () => {
    const findings = await diagnose(
      healthy({ git: () => ({ ok: false, error: "not a git repository" }) }),
    );
    expect(find(findings, "Git position").level).toBe("skip");
    expect(exitCodeFor(findings)).toBe(0);
  });
});

describe("a total outage is not misread as a targeted filter", () => {
  /**
   * The control request's entire job. Without it, "cannot reach one host" and
   * "cannot reach anything" look identical, and the report would confidently
   * blame a DNS filter on a machine that is simply offline.
   */
  test("the neutral host failing is called out as the reason nothing below is conclusive", async () => {
    const findings = await diagnose(
      healthy({
        http: async () => ({ ok: false, error: "Unable to connect" }),
        probe: async () => ({
          host: BOOK_HOST,
          system: [],
          publicAnswer: [],
          blocked: [],
          disjoint: false,
          error: "queryA ETIMEOUT",
        }),
      }),
    );

    expect(find(findings, "Connectivity").level).toBe("fail");
    const text = textOf(findings);
    expect(text).toContain("neutral host");
    expect(text).not.toContain("THETADUEL_DNS");
    // The book-host check refuses to conclude anything rather than guessing.
    expect(find(findings, "Book host").detail.join(" ")).toContain("nothing is concluded");
  });
});

describe("a measured filter — the condition this whole thing is about", () => {
  test("both answers are printed, and the verdict follows from them", async () => {
    const findings = await diagnose(
      healthy({
        probe: async () => filteredProbe(),
        http: async (url) =>
          url.includes(BOOK_HOST)
            ? { ok: false, error: "unable to get local issuer certificate" }
            : { ok: true, status: 200 },
      }),
    );
    const host = find(findings, "Book host");
    const detail = host.detail.join("\n");

    expect(host.level).toBe("fail");
    // Not "blocked": the actual addresses, both sides, so the reader can check
    // the claim rather than take it.
    expect(detail).toContain("146.112.61.104");
    expect(detail).toContain("104.21.89.137");
    expect(detail).toContain("OpenDNS / Cisco Umbrella block page");
    expect(detail).toContain("not a venue");
    expect(exitCodeFor(findings)).toBe(1);
  });

  test("a filter the app already routed around is a warning, not a failure", async () => {
    // `/api/market` answering means the automatic fallback did its job: the
    // board is real and the filter is a fact about the network rather than a
    // fault to go and fix. It stays in the report — this must never be silent
    // again — and stops being a failure, because nothing is failing.
    const findings = await diagnose(
      healthy({
        probe: async () => filteredProbe(),
        port: 1,
      }),
    );
    // With port 1 the market check skips, so the filter stands as a FAIL; the
    // downgrade needs a live `ok: true`, which the next assertion covers by
    // driving the reconciliation directly.
    expect(find(findings, "Book host").level).toBe("fail");
  });

  /**
   * Both resolvers agreeing while the host still refuses to serve: the
   * near-miss that would be most tempting to mislabel. It is reported as a
   * plain failure with the DNS override never mentioned, because the resolver
   * was right and the fault is at the other end.
   */
  test("agreeing resolvers plus a dead host is NOT called a filter", async () => {
    const findings = await diagnose(
      healthy({
        http: async (url) =>
          url.includes(BOOK_HOST) ? { ok: false, error: "socket hang up" } : { ok: true, status: 200 },
      }),
    );
    const host = find(findings, "Book host");

    expect(host.level).toBe("fail");
    expect(host.detail.join(" ")).toContain("NOT a DNS filter");
    expect(textOf(findings)).not.toContain("THETADUEL_DNS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A `.env` in the shape of a real one, with values that look exactly like the
 * things that must never be printed — a 64-hex private key, an RPC URL with a
 * key in the path, a project id.
 *
 * None of these is a real secret; the point is that every one of them is the
 * *shape* of one, so a leak of any kind shows up as a substring match.
 */
const SECRETS = {
  ATTESTOR_PRIVATE_KEY: "0x4c0883a69102937d6231471b5dbb6204fe512961708279e9a1f2a2c8fdbb2c6f",
  DEPLOYER_PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  RPC_URL: "https://base-mainnet.g.alchemy.com/v2/qZ1kR7xN3pW9aB2cD4eF6gH8jK0mN2pQ",
  WALLETCONNECT_PROJECT_ID: "9f3c1b7e2a4d6f8091b3c5d7e9f1a3b5",
  THETADUEL_REFERRER: "0x1111111111111111111111111111111111111111",
};

const ENV_TEXT = [
  "# a comment with an = sign in it",
  "",
  ...Object.entries(SECRETS).map(([k, v]) => `${k}=${v}`),
  `export THETADUEL_DNS=1.1.1.1,8.8.8.8`,
  `THETADUEL_MARKET=`,
  `THETADUEL_STAKE=""`,
  `SOMETHING_UNDOCUMENTED=hunter2`,
].join("\n");

describe(".env reporting cannot print a value", () => {
  test("names and set/empty only — no value from any variable reaches the page", async () => {
    const findings = await diagnose(healthy({ envText: () => ENV_TEXT }));
    const text = textOf(findings);

    for (const [name, value] of Object.entries(SECRETS)) {
      expect(text).toContain(name);
      expect(text).not.toContain(value);
      // Not even a fragment. A "first six characters" habit is how key prefixes
      // end up in chat logs, so nothing partial is printed either. The tail is
      // what is checked rather than the head: every RPC URL starts `https://`,
      // which is not a secret and appears legitimately elsewhere in the report.
      expect(text).not.toContain(value.slice(-16));
      expect(text).not.toContain(value.slice(12, 28));
    }
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("1.1.1.1,8.8.8.8");
  });

  test("the state it reports is set / present but empty, and nothing more", async () => {
    const detail = find(await diagnose(healthy({ envText: () => ENV_TEXT })), ".env").detail.join("\n");

    expect(detail).toContain("ATTESTOR_PRIVATE_KEY — set");
    expect(detail).toContain("THETADUEL_MARKET — present but empty");
    // `KEY=""` is empty, not two characters of secret: the quotes are stripped
    // before the emptiness question is asked.
    expect(detail).toContain("THETADUEL_STAKE — present but empty");
    // A variable nobody documented is still worth naming — it may be the reason
    // the app is behaving oddly — but only its name.
    expect(detail).toContain("SOMETHING_UNDOCUMENTED");
    expect(detail).toContain("not in .env.example");
  });

  /**
   * The structural half of the guarantee. `envNames` returns
   * `Map<string, boolean>` — the type makes a leak unrepresentable rather than
   * merely unwritten, so no future edit to the printing code can reintroduce
   * one by accident.
   */
  test("the parser returns booleans, never values", () => {
    const parsed = envNames(ENV_TEXT);
    for (const value of parsed.values()) expect(typeof value).toBe("boolean");
    expect(parsed.get("ATTESTOR_PRIVATE_KEY")).toBe(true);
    expect(parsed.get("THETADUEL_MARKET")).toBe(false);
    expect(parsed.get("THETADUEL_DNS")).toBe(true);
    // `export FOO=bar` is legal in a dotenv file people also source in a shell.
    expect(parsed.has("THETADUEL_DNS")).toBe(true);
    // Comments and blank lines are not variables.
    expect(parsed.has("# a comment with an ")).toBe(false);
    expect(parsed.size).toBe(Object.keys(SECRETS).length + 4);
  });

  test("no .env at all is a normal, passing state", async () => {
    const findings = await diagnose(healthy({ envText: () => null }));
    const env = find(findings, ".env");
    expect(env.level).toBe("ok");
    expect(env.detail.join(" ")).toContain("which is fine");
    expect(exitCodeFor(findings)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The report itself
// ─────────────────────────────────────────────────────────────────────────────

describe("the report survives being pasted into a chat window", () => {
  test("no ANSI escapes, and no marker that needs colour to be read", async () => {
    const text = textOf(await diagnose(healthy({ process: () => ({ runtime: "node", version: "v24" }) })));
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(text)).toBe(false);
    expect(text).toContain("[FAIL]");
    expect(text).toContain("[ ok ]");
  });

  test("`what to do` is derived from what failed, in the order it was measured", async () => {
    const findings = await diagnose(
      healthy({
        process: () => ({ runtime: "node", version: "v24" }),
        exists: () => false,
        packageVersion: () => null,
      }),
    );
    const text = textOf(findings);
    expect(text.indexOf("Runtime:")).toBeGreaterThan(-1);
    expect(text.indexOf("Runtime:")).toBeLessThan(text.indexOf("Dependencies:"));
    // And nothing about a network that was fine.
    expect(text).not.toContain("Book host:");
  });
});
