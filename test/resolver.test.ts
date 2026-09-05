import { afterEach, describe, expect, test } from "bun:test";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { getChainConfigById } from "@thetanuts-finance/thetanuts-client";
import {
  BOOK_HOST,
  DNS_ENV,
  FALLBACK_ADVISORY,
  FALLBACK_SERVERS,
  FILTERED_ADVICE,
  FILTER_OPTED_OUT_ADVICE,
  FILTER_PERSISTS_ADVICE,
  autoFallback,
  blockPageOwner,
  classifyFailure,
  install,
  parseResolvers,
  resetResolverForTests,
  type HostProbe,
} from "../src/server/resolver.ts";

/**
 * The `THETADUEL_DNS` resolver override — the two halves that can be tested
 * without a network.
 *
 * **What is deliberately NOT tested here: the working path.** Turning the
 * override on calls `dns.setServers` and replaces four functions on the
 * `node:http`/`node:https` module objects, process-wide, for the rest of the
 * test run — every other suite in this repo would inherit it. So the active
 * path is verified the only way that actually proves anything anyway: by
 * starting a server with the variable set and reading `/api/market`. It
 * returned `ok:true` with 114 ETH and 141 BTC pricing rows on the same machine
 * where the unset run returned `{"ok":false,"reason":"HTTP request failed"}`.
 * A mock of `dns.resolve4` would have proved nothing about that, because the
 * whole difficulty was which resolver Bun's socket layer actually consults.
 *
 * What is tested is what a unit test is good for and what can silently rot:
 * the validation, and the promise that an unset variable does nothing at all.
 */

afterEach(() => resetResolverForTests());

/** A recorder for the two log sinks, so no test writes to the console. */
function sink() {
  const logs: string[] = [];
  const warns: string[] = [];
  return {
    logs,
    warns,
    log: (m: string) => logs.push(m),
    warn: (m: string) => warns.push(m),
  };
}

describe("parseResolvers", () => {
  test("the documented form: a comma-separated pair of IPv4 addresses", () => {
    expect(parseResolvers("1.1.1.1,8.8.8.8")).toEqual({
      servers: ["1.1.1.1", "8.8.8.8"],
      rejected: [],
    });
  });

  test("whitespace is a separator too, and stray spaces are not an error", () => {
    expect(parseResolvers("  1.1.1.1 ,\t8.8.8.8\n").servers).toEqual(["1.1.1.1", "8.8.8.8"]);
  });

  test("order is preserved and duplicates collapse", () => {
    expect(parseResolvers("8.8.8.8,1.1.1.1,8.8.8.8").servers).toEqual(["8.8.8.8", "1.1.1.1"]);
  });

  test("IPv6, bare and bracketed with a port", () => {
    const spec = parseResolvers("2606:4700:4700::1111,[2001:4860:4860::8888]:53");
    expect(spec.servers).toEqual(["2606:4700:4700::1111", "[2001:4860:4860::8888]:53"]);
    expect(spec.rejected).toEqual([]);
  });

  test("an IPv4 address with a port", () => {
    expect(parseResolvers("1.1.1.1:5353").servers).toEqual(["1.1.1.1:5353"]);
  });

  /**
   * The trap this refuses on purpose. `dns.google` reads like a resolver and is
   * useless as one: resolving it needs the resolver being replaced. Refusing it
   * here means the operator is told which entry was wrong.
   */
  test("hostnames are refused, however plausible", () => {
    const spec = parseResolvers("dns.google,one.one.one.one");
    expect(spec.servers).toEqual([]);
    expect(spec.rejected).toEqual(["dns.google", "one.one.one.one"]);
  });

  test("junk, near-misses and out-of-range ports are all refused", () => {
    const spec = parseResolvers("999.1.1.1,1.1.1,1.1.1.1:0,1.1.1.1:70000,1.1.1.1:,:53,,,-");
    expect(spec.servers).toEqual([]);
    expect(spec.rejected).toEqual([
      "999.1.1.1",
      "1.1.1",
      "1.1.1.1:0",
      "1.1.1.1:70000",
      "1.1.1.1:",
      ":53",
      "-",
    ]);
  });

  test("one bad entry does not discard the good ones beside it", () => {
    const spec = parseResolvers("1.1.1.1,nope,8.8.8.8");
    expect(spec.servers).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(spec.rejected).toEqual(["nope"]);
  });

  test("absent, empty and whitespace-only all read as nothing configured", () => {
    for (const raw of [undefined, null, "", "   ", ",", " , \t "]) {
      expect(parseResolvers(raw)).toEqual({ servers: [], rejected: [] });
    }
  });
});

describe("install — the inert default", () => {
  /**
   * The property the whole feature rests on: with no variable set, nothing is
   * touched and nothing is said. A clone of this repo must behave exactly as it
   * did before `src/server/resolver.ts` existed.
   */
  test("unset touches no global and logs nothing", () => {
    const before = {
      servers: dns.getServers(),
      httpRequest: http.request,
      httpGet: http.get,
      httpsRequest: https.request,
      httpsGet: https.get,
      lookup: dns.lookup,
    };
    const io = sink();

    for (const value of [null, "", "   "]) {
      const result = install({ value, log: io.log, warn: io.warn });
      expect(result).toEqual({ active: false, servers: [], rejected: [], reason: "unset" });
    }

    expect(io.logs).toEqual([]);
    expect(io.warns).toEqual([]);
    expect(dns.getServers()).toEqual(before.servers);
    expect(http.request).toBe(before.httpRequest);
    expect(http.get).toBe(before.httpGet);
    expect(https.request).toBe(before.httpsRequest);
    expect(https.get).toBe(before.httpsGet);
    expect(dns.lookup).toBe(before.lookup);
  });
});

describe("install — a set-but-unusable value fails loudly, and still inert", () => {
  /**
   * Never a silent *wrong* resolver. A value that validates to nothing leaves
   * DNS exactly as it was and says so, rather than half-applying or pointing
   * somewhere unintended — the failure mode that produced two wrong "the venue
   * is down" diagnoses in this repo is precisely a resolver quietly answering
   * with something other than the truth.
   */
  test("all entries malformed: warns, changes nothing, reports no-valid", () => {
    const before = { servers: dns.getServers(), request: https.request };
    const io = sink();

    const result = install({ value: "dns.google, 999.999.999.999", log: io.log, warn: io.warn });

    expect(result.active).toBe(false);
    expect(result.reason).toBe("no-valid");
    expect(result.servers).toEqual([]);
    expect(result.rejected).toEqual(["dns.google", "999.999.999.999"]);

    expect(io.logs).toEqual([]);
    expect(io.warns.length).toBe(2);
    expect(io.warns[0]).toContain("dns.google");
    expect(io.warns[0]).toContain("999.999.999.999");
    expect(io.warns[1]).toContain("the resolver override is OFF");

    expect(dns.getServers()).toEqual(before.servers);
    expect(https.request).toBe(before.request);
  });

  test("the warning names the variable, so the message is searchable", () => {
    const io = sink();
    install({ value: "not-an-ip", log: io.log, warn: io.warn });
    expect(io.warns.every((w) => w.includes(DNS_ENV))).toBe(true);
    expect(DNS_ENV).toBe("THETADUEL_DNS");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The classifier, and the automatic fallback's decision
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything below tests a *decision*, never an application.
 *
 * The rule stated at the top of this file still holds: applying the override
 * replaces four functions on `node:http`/`node:https` for the rest of the test
 * run, so no test here is allowed to do it. `autoFallback` takes an `apply`
 * seam for exactly that reason, and every test passes one. The application
 * itself is proved the only way that proves anything — by starting a real
 * server and reading `/api/market`, which on the machine this was written on
 * went from `{"ok":false,"reason":"HTTP request failed"}` to 40 order rows and
 * 112 ETH / 139 BTC pricing rows with **no `.env` file at all**, purely because
 * this decision came out `applied`.
 *
 * The thing most worth protecting here is the NEGATIVE case. A false "your
 * network is blocking this" while Thetanuts is genuinely down would be this
 * repo's fourth misdiagnosis of the same host, pointing the other way, and it
 * would be believed because the app said it.
 */

/** An error shaped like the ones axios actually throws, code and all. */
function coded(code: string, message = "some failure"): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** A probe result, defaulting to the shape of a healthy machine. */
function probeResult(over: Partial<HostProbe> = {}): HostProbe {
  const system = over.system ?? ["104.21.89.137"];
  const publicAnswer = over.publicAnswer ?? ["104.21.89.137"];
  return {
    host: BOOK_HOST,
    system,
    publicAnswer,
    blocked: over.blocked ?? [],
    disjoint:
      over.disjoint ??
      (system.length > 0 && publicAnswer.length > 0 && !system.some((a) => publicAnswer.includes(a))),
    error: over.error ?? null,
  };
}

/** The measured block-page shape: a resolver alone in its opinion. */
const FILTERED = probeResult({
  system: ["146.112.61.104"],
  publicAnswer: ["104.21.89.137", "172.67.159.206"],
  blocked: ["146.112.61.104"],
});

/** An `apply` that records rather than patching the process. */
function fakeApply() {
  const seen: string[][] = [];
  return {
    seen,
    apply: (servers: readonly string[]) => {
      seen.push([...servers]);
      return { ok: true } as const;
    },
  };
}

describe("BOOK_HOST is the SDK's host, not a hopeful copy of it", () => {
  /**
   * The one constant in this file transcribed from somebody else's package. If
   * the SDK moved its Worker, the probe would be measuring a host nothing reads
   * and would report "no filter" forever — a silent false negative in the one
   * place that must not have one.
   */
  test("it equals chain 8453's apiBaseUrl host, read from the SDK itself", () => {
    const config = getChainConfigById(8453) as { apiBaseUrl?: string };
    expect(new URL(config.apiBaseUrl ?? "").hostname).toBe(BOOK_HOST);
  });
});

describe("classifyFailure — the interception signature", () => {
  test("the measured error: axios' UNABLE_TO_GET_ISSUER_CERT_LOCALLY", () => {
    const verdict = classifyFailure(
      coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "unable to get local issuer certificate"),
    );
    expect(verdict.kind).toBe("filtered");
    expect(verdict.evidence).toBe("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
  });

  test("the other spellings the same block page produces on other stacks", () => {
    for (const code of [
      "SEC_E_UNTRUSTED_ROOT",
      "ERR_TLS_CERT_ALTNAME_INVALID",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "SELF_SIGNED_CERT_IN_CHAIN",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    ]) {
      expect(classifyFailure(coded(code)).kind).toBe("filtered");
    }
  });

  test("a code buried under axios' cause chain still counts", () => {
    const outer = Object.assign(new Error("HTTP request failed"), {
      cause: coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"),
    });
    expect(classifyFailure(outer).kind).toBe("filtered");
  });

  test("an AggregateError's members are searched too", () => {
    const aggregate = Object.assign(new Error("all connections failed"), {
      errors: [coded("ECONNRESET"), coded("SEC_E_UNTRUSTED_ROOT")],
    });
    expect(classifyFailure(aggregate).kind).toBe("filtered");
  });

  test("a block-page address in the message is evidence on its own", () => {
    const verdict = classifyFailure(new Error("connect ECONNREFUSED 146.112.61.104:443"));
    expect(verdict.kind).toBe("filtered");
    expect(verdict.evidence).toContain("146.112.61.104");
    expect(verdict.evidence).toContain("OpenDNS");
  });
});

describe("classifyFailure — the negative case, which matters more", () => {
  /**
   * Every one of these is a real way this read fails on an unfiltered network,
   * and not one of them may come back "filtered". The app saying "your network
   * is blocking this" while the venue is down would send a reader to check
   * their DNS for an hour and then write the wrong thing in a doc — exactly the
   * shape of the two mistakes already recorded in this repo, pointing the other
   * way.
   */
  test("ordinary upstream and transport failures are NOT a DNS block", () => {
    const ordinary: unknown[] = [
      new Error("HTTP request failed"),
      new Error("socket hang up"),
      coded("ETIMEDOUT", "timeout of 30000ms exceeded"),
      coded("ECONNRESET", "read ECONNRESET"),
      coded("ECONNREFUSED", "connect ECONNREFUSED 104.21.89.137:443"),
      coded("ERR_BAD_RESPONSE", "Request failed with status code 502"),
      new Error("HTTP 429 rate limited"),
      new Error("Request failed with status code 503"),
      "socket hang up",
      null,
      undefined,
    ];
    for (const error of ordinary) {
      const verdict = classifyFailure(error);
      expect(verdict.kind).toBe("unknown");
      expect(verdict.evidence).toBeNull();
    }
  });

  /**
   * The one cert error a real venue plausibly serves itself. Calling it a
   * network filter would send the reader to their resolver while the fault sat
   * at the other end, so it is deliberately off the list.
   */
  test("CERT_HAS_EXPIRED is the venue's problem, not the network's", () => {
    expect(classifyFailure(coded("CERT_HAS_EXPIRED", "certificate has expired")).kind).toBe("unknown");
  });

  /**
   * A name that does not resolve at all looks identical whether the zone is
   * NXDOMAIN'd by a filter or the machine has no network — and "you are
   * offline" is much the likelier. `bun run doctor` can separate them because
   * it makes its own control request; a classifier handed one exception cannot.
   */
  test("ENOTFOUND / EAI_AGAIN are not claimed either way", () => {
    expect(classifyFailure(coded("ENOTFOUND", "getaddrinfo ENOTFOUND x")).kind).toBe("unknown");
    expect(classifyFailure(coded("EAI_AGAIN", "getaddrinfo EAI_AGAIN x")).kind).toBe("unknown");
  });

  test("an ordinary address in the message is not a block page", () => {
    expect(classifyFailure(new Error("connect ETIMEDOUT 172.67.159.206:443")).kind).toBe("unknown");
    expect(classifyFailure(new Error("connect ETIMEDOUT 146.112.62.104:443")).kind).toBe("unknown");
  });
});

describe("blockPageOwner — the named range, and only the named range", () => {
  test("the measured address, and its /24 neighbours", () => {
    expect(blockPageOwner("146.112.61.104")).toContain("Umbrella");
    expect(blockPageOwner("146.112.61.0")).not.toBeNull();
    expect(blockPageOwner("146.112.61.255")).not.toBeNull();
  });

  test("one octet out, and the real addresses, are not block pages", () => {
    expect(blockPageOwner("146.112.62.104")).toBeNull();
    expect(blockPageOwner("146.113.61.104")).toBeNull();
    expect(blockPageOwner("104.21.89.137")).toBeNull();
    expect(blockPageOwner("172.67.159.206")).toBeNull();
  });

  test("nonsense and IPv6 are refused rather than matched", () => {
    for (const junk of ["", "146.112.61", "999.112.61.104", "2606:4700:3035::6815:5989", "not an ip"]) {
      expect(blockPageOwner(junk)).toBeNull();
    }
  });
});

describe("autoFallback — the guardrails", () => {
  test("a generic failure never probes and never applies", async () => {
    let probed = false;
    const applier = fakeApply();
    const outcome = await autoFallback(new Error("HTTP 429 rate limited"), {
      value: null,
      probe: async () => {
        probed = true;
        return FILTERED;
      },
      apply: applier.apply,
      warn: () => {},
    });

    expect(outcome).toEqual({ applied: false, reason: "not-filtered", probe: null });
    // Not merely "did not fall back": it did not even ask. Retrying a genuine
    // outage through Cloudflare would double every timeout and buy nothing.
    expect(probed).toBe(false);
    expect(applier.seen).toEqual([]);
  });

  test("a generic failure is NOT cached — the next failure is judged fresh", async () => {
    const applier = fakeApply();
    await autoFallback(new Error("socket hang up"), {
      value: null,
      apply: applier.apply,
      warn: () => {},
    });
    const second = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe: async () => FILTERED,
      apply: applier.apply,
      warn: () => {},
    });
    expect(second.applied).toBe(true);
  });

  test("both resolvers agreeing is a refusal, however bad the cert error", async () => {
    // The expired-certificate case, and every interception that is not doing
    // DNS. The resolver was right; routing around it would fix nothing while
    // printing a confident sentence about the user's network that is false.
    const applier = fakeApply();
    const outcome = await autoFallback(coded("DEPTH_ZERO_SELF_SIGNED_CERT"), {
      value: null,
      probe: async () => probeResult(),
      apply: applier.apply,
      warn: () => {},
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("agree");
    expect(applier.seen).toEqual([]);
  });

  test("an inconclusive probe is not cached — a later failure measures again", async () => {
    // `probe-failed` concludes nothing. Letting one DNS timeout wedge the
    // recovery for the life of the process would turn a transient hiccup into
    // the permanent empty board this whole feature exists to remove.
    const applier = fakeApply();
    let call = 0;
    const probe = async () => {
      call += 1;
      return call === 1 ? probeResult({ system: [], publicAnswer: [], error: "queryA ETIMEOUT" }) : FILTERED;
    };

    const first = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe,
      apply: applier.apply,
      warn: () => {},
    });
    const second = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe,
      apply: applier.apply,
      warn: () => {},
    });

    expect(first.reason).toBe("probe-failed");
    expect(second.applied).toBe(true);
    expect(call).toBe(2);
  });

  test("a decisive `agree` IS cached — the 30s refresh never re-probes", async () => {
    let call = 0;
    const applier = fakeApply();
    const probe = async () => {
      call += 1;
      return probeResult();
    };
    for (let i = 0; i < 4; i += 1) {
      await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
        value: null,
        probe,
        apply: applier.apply,
        warn: () => {},
      });
    }
    expect(call).toBe(1);
    expect(applier.seen).toEqual([]);
  });

  test("a resolver that did not answer concludes nothing", async () => {
    const applier = fakeApply();
    const outcome = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe: async () => probeResult({ system: [], publicAnswer: [], error: "queryA ETIMEOUT" }),
      apply: applier.apply,
      warn: () => {},
    });
    expect(outcome.reason).toBe("probe-failed");
    expect(applier.seen).toEqual([]);
  });

  test("the opt-out refuses even a measured filter, and does not probe", async () => {
    let probed = false;
    const applier = fakeApply();
    const warnings: string[] = [];
    const outcome = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: "off",
      probe: async () => {
        probed = true;
        return FILTERED;
      },
      apply: applier.apply,
      warn: (m) => warnings.push(m),
    });
    expect(outcome.reason).toBe("opted-out");
    expect(probed).toBe(false);
    expect(applier.seen).toEqual([]);
    // Still one line in the log. The whole failure mode being fixed is a board
    // that is empty for a reason nobody can see, and somebody who set `off`
    // months ago and forgot is exactly who needs telling.
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("NOT a Thetanuts outage");
    expect(warnings[0]).toContain(DNS_ENV + "=off");
  });

  test("OFF, with whitespace, is the same decision", async () => {
    const outcome = await autoFallback(coded("SEC_E_UNTRUSTED_ROOT"), {
      value: "  OFF \n",
      probe: async () => FILTERED,
      apply: fakeApply().apply,
      warn: () => {},
    });
    expect(outcome.reason).toBe("opted-out");
  });

  test("install() seeing `off` opts the fallback out too", async () => {
    expect(install({ value: "off", log: () => {}, warn: () => {} })).toEqual({
      active: false,
      servers: [],
      rejected: [],
      reason: "off",
    });
    const outcome = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      // Deliberately NOT `off` here: the opt-out was recorded by install and
      // must survive, so a later caller passing a different value cannot
      // quietly re-enable it.
      value: "1.1.1.1",
      probe: async () => FILTERED,
      apply: fakeApply().apply,
      warn: () => {},
    });
    expect(outcome.reason).toBe("opted-out");
  });

  test("a measured filter applies the public resolvers, once", async () => {
    const applier = fakeApply();
    const warnings: string[] = [];
    const first = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe: async () => FILTERED,
      apply: applier.apply,
      warn: (m) => warnings.push(m),
    });

    expect(first.applied).toBe(true);
    expect(first.reason).toBe("applied");
    expect(applier.seen).toEqual([[...FALLBACK_SERVERS]]);

    // One retry, not a loop: a second failure finds the cached outcome, is told
    // `applied: false`, and the caller rethrows instead of reading again.
    const second = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe: async () => FILTERED,
      apply: applier.apply,
      warn: (m) => warnings.push(m),
    });
    expect(second.applied).toBe(false);
    expect(second.reason).toBe("applied");
    expect(applier.seen.length).toBe(1);
    expect(warnings.length).toBe(1);
  });

  test("two concurrent failures share one probe", async () => {
    let probes = 0;
    const applier = fakeApply();
    const probe = async () => {
      probes += 1;
      return FILTERED;
    };
    const [a, b] = await Promise.all([
      autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
        value: null,
        probe,
        apply: applier.apply,
        warn: () => {},
      }),
      autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
        value: null,
        probe,
        apply: applier.apply,
        warn: () => {},
      }),
    ]);
    expect(probes).toBe(1);
    // Exactly one of the two is told to retry. Both retrying would be two reads
    // where one will do, and the joiner has nothing to add.
    expect([a.applied, b.applied].filter(Boolean).length).toBe(1);
  });

  test("the banner names both answers, the code, the trade-off and the opt-out", async () => {
    const warnings: string[] = [];
    await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe: async () => FILTERED,
      apply: fakeApply().apply,
      warn: (m) => warnings.push(m),
    });
    const banner = warnings.join("\n");

    // The measurements, so a reader can check the claim rather than take it.
    expect(banner).toContain("146.112.61.104");
    expect(banner).toContain("104.21.89.137");
    expect(banner).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    // The two sentences this repo has twice failed to write down.
    expect(banner).toContain("NOT a Thetanuts outage");
    expect(banner).toContain("OpenDNS / Cisco Umbrella block page");
    // The trade-off, stated rather than buried, and the way out of it.
    expect(banner).toContain("deliberately");
    expect(banner).toContain(DNS_ENV + "=off");
    // And the promise this file never breaks.
    expect(banner).toContain("certificate is still fully validated");
  });

  test("a refused setServers is a loud failure, not a silent one", async () => {
    const warnings: string[] = [];
    const outcome = await autoFallback(coded("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"), {
      value: null,
      probe: async () => FILTERED,
      apply: () => ({ ok: false, error: new Error("EINVAL") }),
      warn: (m) => warnings.push(m),
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("failed");
    expect(warnings.join("")).toContain("EINVAL");
  });
});

describe("the four sentences a user can be shown", () => {
  /**
   * They go on the footer's single error line, so they are checked for the two
   * claims that matter and for being short enough to read there. The wording
   * this replaced — `Book unavailable — HTTP request failed.` — named neither
   * the cause nor the fix, and is what a teammate actually saw.
   */
  test("each names this network and denies a venue outage", () => {
    for (const sentence of [
      FALLBACK_ADVISORY,
      FILTERED_ADVICE,
      FILTER_PERSISTS_ADVICE,
      FILTER_OPTED_OUT_ADVICE,
    ]) {
      expect(sentence.toLowerCase()).toContain("network");
      // Case-insensitive: two of the four open with the phrase and two carry
      // it mid-sentence, and which is which is a matter of prose rather than of
      // the claim being made.
      expect(sentence.toLowerCase()).toContain("not a venue outage");
      expect(sentence.length).toBeLessThanOrEqual(140);
    }
  });

  test("only the one with something to offer names the env line", () => {
    expect(FILTERED_ADVICE).toContain(DNS_ENV + "=1.1.1.1,8.8.8.8");
    // Telling somebody who already set it to set it is how an hour disappears.
    expect(FILTER_PERSISTS_ADVICE).not.toContain("1.1.1.1");
    expect(FILTER_OPTED_OUT_ADVICE).toContain(DNS_ENV + "=off");
  });

  test("no sentence anywhere offers to weaken TLS", () => {
    const all = [FALLBACK_ADVISORY, FILTERED_ADVICE, FILTER_PERSISTS_ADVICE, FILTER_OPTED_OUT_ADVICE]
      .join(" ")
      .toLowerCase();
    for (const banned of ["rejectunauthorized", "node_tls_reject_unauthorized", "--insecure", "ignore certificate"]) {
      expect(all).not.toContain(banned);
    }
  });
});
