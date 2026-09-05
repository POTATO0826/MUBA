import { afterEach, describe, expect, test } from "bun:test";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import {
  DNS_ENV,
  install,
  parseResolvers,
  resetResolverForTests,
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
