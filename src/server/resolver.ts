import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THETADUEL_DNS — an opt-in resolver override for a network that filters the
 * book's host. Unset, this file does nothing at all.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## The failure this exists to remove, stated precisely
 *
 * The Thetanuts SDK reads the Base order book from its `apiBaseUrl`,
 * `https://round-snowflake-9c31.devops-118.workers.dev` — a Cloudflare Worker
 * (`node_modules/@thetanuts-finance/thetanuts-client/dist/index.js:170`).
 *
 * On the owner's machine, on a phone hotspot, the resolver is `172.20.10.1` and
 * it answers that host with **`146.112.61.104`**, whose reverse lookup is
 * **`hit-block.opendns.com`** — an OpenDNS / Cisco Umbrella block page.
 * `*.workers.dev` is a commonly filtered domain because it is cheap to abuse
 * for phishing, so the whole zone gets blocked by category. Public DNS
 * (`1.1.1.1`) returns the real Cloudflare addresses, `104.21.89.137` and
 * `172.67.159.206`, and those serve the book normally.
 *
 * So the connection is made — to the block page — and its certificate does not
 * chain to a trusted root. axios reports `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
 * and `/api/market` answers `{"ok":false,"reason":"HTTP request failed"}`.
 *
 * **This is a local DNS filter, not a Thetanuts outage.** That distinction has
 * already been got wrong twice in this repo, at real cost —
 * `docs/book-endpoint.md` is the retraction of the first misdiagnosis ("the
 * book moved"; it had not), and `docs/asset-gate.md` and `docs/plan6-audit.md`
 * carry banners about the second. The venue has been up the entire time. If you
 * are reading this because the book looks dead, check your resolver before you
 * write down "venue down" anywhere: `nslookup round-snowflake-9c31.devops-118.workers.dev`
 * against your machine's resolver and then against `1.1.1.1`, and compare.
 *
 * The correct fix is to fix the network — change the machine's DNS servers, or
 * get off the filtered link. That needs Administrator, which the environment
 * this was written in does not have, so the escape hatch below lives in the
 * process instead. It is a **developer escape hatch, not a product feature**.
 *
 * ## Why the obvious mechanism does not work under Bun
 *
 * `dns.setServers(["1.1.1.1"])` needs no elevation and does work: after it,
 * `dns.resolve4(host)` returns the real Cloudflare addresses. But `setServers`
 * alone changes nothing about outbound HTTP, because `dns.lookup` — not
 * `resolve4` — is what the socket layer calls, and `lookup` goes to the OS
 * `getaddrinfo`, which is still asking the filtered resolver. Measured on this
 * machine: after `setServers`, `resolve4` gives `104.21.89.137` and `lookup`
 * still gives `146.112.61.104`.
 *
 * The usual Node trick from here is to monkey-patch `dns.lookup` itself.
 * **Under Bun 1.3.14 that does not work either** — measured, not assumed. Bun
 * resolves hostnames for `fetch` and for `node:http`/`node:https` in native
 * code and never consults the JS `dns.lookup` binding, so a patched `dns.lookup`
 * returns the right address to anyone who calls it directly and is ignored by
 * every actual connection. Replacing `https.globalAgent` with an agent carrying
 * a `lookup` option does not work either: Bun does not merge the agent's
 * options into the connect options.
 *
 * What Bun *does* honour is a `lookup` function passed **explicitly in the
 * request options** — `https.request({ ..., lookup })`. Measured: that request
 * returns 200 and ~270 KB of real orders on the same machine where the plain
 * one fails.
 *
 * ## The mechanism chosen, and how invasive it is
 *
 * So `install()` does two things, and only when the env var is set:
 *
 *   1. `dns.setServers(servers)` — so `dns.resolve4` / `dns.resolve6` ask the
 *      configured resolvers rather than the machine's.
 *   2. Wraps `http.request`, `http.get`, `https.request` and `https.get` to
 *      inject a `lookup` implemented over `dns.resolve4`/`resolve6`, **only
 *      when the caller did not supply one of its own**.
 *
 * Step 2 is a **process-global override of four functions on the `node:http`
 * and `node:https` module objects.** That is stated plainly because it deserves
 * to be: every HTTP request this process makes through those modules — ours,
 * the SDK's, any dependency's — resolves through the configured servers
 * afterwards. That is precisely why it is behind an env var that defaults to
 * unset, and why `install()` returns without touching a single global when the
 * var is absent. The default path is byte-identical to having no such file.
 *
 * It was chosen over the alternatives because it is the narrowest thing that
 * actually works under Bun: it touches HTTP only, not the socket layer
 * (`net.connect`, `tls.connect`) and not the DNS module's own exports, so
 * anything that opens a raw socket, and anything that calls `dns.lookup`
 * directly, behaves exactly as it did before.
 *
 * ### What it does NOT affect, explicitly
 *
 *  - **`fetch`.** Bun's native `fetch` does not go through `node:http`, so it
 *    keeps using the OS resolver. That is deliberate and it is fine: the only
 *    filtered host is the Worker, which the SDK reads over axios (→
 *    `node:https`), while `fetch` here is what ethers uses for the Base RPC —
 *    and `mainnet.base.org` is **not** filtered. Chainlink spot and history
 *    were working throughout this failure, which is itself part of the evidence
 *    that the problem is a DNS block on one zone and not a network outage.
 *    Wrapping `fetch` would mean rewriting each URL to a literal IP and
 *    carrying the hostname in a `Host` header and a TLS `serverName`, which
 *    breaks redirects and non-HTTP schemes for no benefit here. If a day comes
 *    when a `fetch` target is filtered too, that is the moment to reconsider —
 *    not before.
 *  - **Certificate validation.** Nothing here touches TLS. `rejectUnauthorized`
 *    is untouched, no CA is added, no `NODE_TLS_REJECT_UNAUTHORIZED` is set.
 *    The cert error in the diagnosis was a *symptom* — the block page's
 *    certificate, correctly rejected — and the fix is to stop talking to the
 *    block page, not to start trusting it. **Do not add a TLS bypass option
 *    here.** If you find yourself wanting one, you are about to make the app
 *    accept a man-in-the-middle silently, and the right move is to stop and say
 *    so out loud instead.
 *  - **Hosts-file and local names.** The injected lookup falls back to the
 *    original `dns.lookup` whenever the configured resolvers have no answer, so
 *    `localhost`, `.local` names and hosts-file entries resolve as before. The
 *    override only ever *replaces an answer the public resolvers also have* —
 *    which is the whole shape of the bug: the filtered resolver returns a
 *    successful, wrong answer.
 */

/** Read once per install, named here so the string appears in one place. */
export const DNS_ENV = "THETADUEL_DNS";

/** What `parseResolvers` learned from the raw env string. */
export type ResolverSpec = {
  /** Well-formed entries, de-duplicated, in the order given. */
  servers: string[];
  /** Entries refused by validation, verbatim, so they can be named in the log. */
  rejected: string[];
};

/**
 * Split and validate `THETADUEL_DNS`.
 *
 * Accepted, matching what `dns.setServers` itself documents:
 *   - a bare IPv4 or IPv6 address        `1.1.1.1`, `2606:4700:4700::1111`
 *   - either with an explicit port       `1.1.1.1:53`
 *   - bracketed IPv6 with a port         `[2606:4700:4700::1111]:53`
 *
 * Refused, deliberately:
 *   - **hostnames.** `dns.google` looks reasonable and is a trap: resolving the
 *     resolver needs the resolver we are trying to replace. `setServers` would
 *     throw on it anyway; refusing it here means the message says which entry
 *     was wrong instead of a stack trace.
 *   - anything else — empty fragments, ports out of range, junk.
 *
 * Separators are commas and/or whitespace, so `1.1.1.1,8.8.8.8` and
 * `"1.1.1.1 8.8.8.8"` both work and a stray space is not an error.
 *
 * Pure, and exported for the tests: nothing here reads the environment or
 * touches a global.
 */
export function parseResolvers(raw: string | null | undefined): ResolverSpec {
  const servers: string[] = [];
  const rejected: string[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/)) {
    if (entry === "") continue;
    if (!isValidServer(entry)) {
      rejected.push(entry);
      continue;
    }
    if (!servers.includes(entry)) servers.push(entry);
  }
  return { servers, rejected };
}

/** `host`, `host:port`, or `[v6]:port` — the address part must be a literal IP. */
function isValidServer(entry: string): boolean {
  // `[2606:4700:4700::1111]:53` — the only form where a port and an IPv6
  // address are unambiguous.
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
  if (bracketed) return isIP(bracketed[1] ?? "") === 6 && isPort(bracketed[2]);

  // A bare IP of either family. Checked before the port split so that a plain
  // IPv6 address, which is nothing but colons, is not read as `host:port`.
  if (isIP(entry) !== 0) return true;

  // `1.1.1.1:53`. Only meaningful for IPv4: an unbracketed IPv6 address with a
  // port cannot be parsed, and `setServers` does not accept one either.
  const cut = entry.lastIndexOf(":");
  if (cut <= 0) return false;
  return isIP(entry.slice(0, cut)) === 4 && isPort(entry.slice(cut + 1));
}

/** Absent is fine (no port given); present must be 1–65535, digits only. */
function isPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  return n >= 1 && n <= 65535;
}

/** What `install()` did, returned rather than only logged so tests can read it. */
export type ResolverInstall = {
  /** True only if the servers were set AND the HTTP override is in place. */
  active: boolean;
  /** The servers now in use. Empty when inert. */
  servers: string[];
  /** Entries that failed validation and were dropped. */
  rejected: string[];
  /**
   * Why it is inert, when it is:
   *   `"unset"`      — the env var is absent or empty. The default. Silent.
   *   `"no-valid"`   — the var was set but nothing in it validated. Loud.
   *   `"failed"`     — `dns.setServers` refused the list. Loud.
   *   `"already"`    — install() already ran in this process; ignored.
   */
  reason?: "unset" | "no-valid" | "failed" | "already";
};

/**
 * Guard against a second install. The wrappers below capture the *current*
 * `http.request`, so installing twice would stack one wrapper on another and
 * make the override's own footprint grow every time. It is idempotent instead.
 */
let installed = false;

/** Test seam only — lets the suite assert the inert path more than once. */
export function resetResolverForTests(): void {
  installed = false;
}

export type InstallOptions = {
  /** The raw env value. Defaults to `Bun.env[DNS_ENV]`. */
  value?: string | null;
  /** Where the banner goes. Defaults to `console.log`. */
  log?: (message: string) => void;
  /** Where refusals go. Defaults to `console.error`. */
  warn?: (message: string) => void;
};

/**
 * Apply the override if `THETADUEL_DNS` asks for it.
 *
 * **Unset means completely inert.** No `setServers`, no wrapping, nothing
 * logged — a process without the variable behaves exactly as it did before this
 * file existed. That is the property worth protecting: this is an escape hatch
 * for one filtered network, not a thing anyone should have to think about.
 *
 * When it *is* set, it says so at startup, on purpose and at length. A resolver
 * override that took effect quietly would be a new way to get the same wrong
 * diagnosis: someone would see live data appear or disappear and reach for the
 * venue as the explanation. So the banner names the servers in use, and a bad
 * value is a loud refusal rather than a silent fallback — never a silent
 * *wrong* resolver.
 */
export function install(options: InstallOptions = {}): ResolverInstall {
  const log = options.log ?? ((m: string) => console.log(m));
  const warn = options.warn ?? ((m: string) => console.error(m));
  const raw = options.value !== undefined ? options.value : (Bun.env[DNS_ENV] ?? null);

  const { servers, rejected } = parseResolvers(raw);

  // The default path. Note it returns before reading anything else and before
  // touching any global — including when the var is set to only whitespace.
  if (servers.length === 0 && rejected.length === 0) {
    return { active: false, servers: [], rejected: [], reason: "unset" };
  }

  if (rejected.length > 0) {
    warn(
      `${DNS_ENV}: ignoring ${rejected.length} malformed ` +
        `${rejected.length === 1 ? "entry" : "entries"}: ${rejected.join(", ")}\n` +
        `  expected literal IP addresses, optionally with a port — ` +
        `e.g. ${DNS_ENV}=1.1.1.1,8.8.8.8\n` +
        `  hostnames are refused on purpose: resolving the resolver would need ` +
        `the resolver being replaced.`,
    );
  }

  if (servers.length === 0) {
    warn(
      `${DNS_ENV} is set but nothing in it is a valid DNS server address — ` +
        `the resolver override is OFF and DNS is unchanged.`,
    );
    return { active: false, servers: [], rejected, reason: "no-valid" };
  }

  if (installed) return { active: true, servers, rejected, reason: "already" };

  try {
    dns.setServers(servers);
  } catch (error) {
    warn(
      `${DNS_ENV}: dns.setServers(${servers.join(", ")}) was refused — ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `  the resolver override is OFF and DNS is unchanged.`,
    );
    return { active: false, servers: [], rejected, reason: "failed" };
  }

  const lookup = makeLookup();
  patchModule(http, lookup);
  patchModule(https, lookup);
  installed = true;

  log(
    `${DNS_ENV} ON — this process resolves hostnames via ${servers.join(", ")}, ` +
      `not the machine's resolver.\n` +
      `  It overrides http/https request resolution process-wide (see ` +
      `src/server/resolver.ts). fetch and TLS verification are untouched; ` +
      `certificates are still fully validated.\n` +
      `  This is a workaround for a network whose DNS filters the book's host. ` +
      `If the book is failing, that is a local filter, NOT a venue outage.`,
  );

  return { active: true, servers, rejected };
}

// ─────────────────────────────────────────────────────────────────────────────
// The lookup, and the four functions it is injected into
// ─────────────────────────────────────────────────────────────────────────────

/** The shape `net.Socket` calls a custom `lookup` with. */
type LookupAddress = { address: string; family: number };
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `dns.lookup`-compatible function backed by `dns.resolve4`/`resolve6`, which
 * — unlike `lookup` — honour `dns.setServers`. That difference is the entire
 * point of this file; see the header.
 *
 * Three behaviours worth naming:
 *
 *  - **A literal IP short-circuits.** `lookup("1.2.3.4")` must not become a DNS
 *    query; `net` relies on that when connecting to an address.
 *  - **`all: true` is honoured.** Bun's socket layer calls the injected lookup
 *    in `all` mode, and a lookup that answers a single string there fails with
 *    `results.sort is not a function` — measured, and the reason this returns
 *    the array form when asked.
 *  - **Any failure falls back to the original `dns.lookup`.** The configured
 *    resolvers know nothing about `localhost`, hosts-file entries or mDNS
 *    names, and this override has no business breaking them. It is strictly
 *    additive: it changes an answer only where the public resolvers have one.
 */
function makeLookup(): typeof dns.lookup {
  const original = dns.lookup;

  const lookup = (hostname: string, options: unknown, callback?: unknown): void => {
    const cb = (typeof options === "function" ? options : callback) as LookupCallback;
    const opts =
      typeof options === "number"
        ? { family: options }
        : typeof options === "object" && options !== null
          ? (options as { family?: number; all?: boolean })
          : {};
    const wantAll = opts.all === true;

    const literal = isIP(hostname);
    if (literal !== 0) {
      cb(null, wantAll ? [{ address: hostname, family: literal }] : hostname, literal);
      return;
    }

    const fallback = () => (original as (...a: unknown[]) => void)(hostname, options, callback);
    const answer = (addresses: string[], family: 4 | 6) => {
      if (addresses.length === 0) return fallback();
      if (wantAll) {
        cb(
          null,
          addresses.map((address) => ({ address, family })),
        );
        return;
      }
      cb(null, addresses[0], family);
    };

    // family 4 or 6 asks for exactly that; 0 (or absent) means "either", and
    // A records are tried first because the filtered host — and nearly
    // everything else this process talks to — is reachable over IPv4.
    if (opts.family === 6) {
      dns.resolve6(hostname, (err, addrs) => (err ? fallback() : answer(addrs, 6)));
      return;
    }
    dns.resolve4(hostname, (err, addrs) => {
      if (!err && addrs.length > 0) return answer(addrs, 4);
      if (opts.family === 4) return fallback();
      dns.resolve6(hostname, (err6, addrs6) => (err6 ? fallback() : answer(addrs6, 6)));
    });
  };

  return lookup as unknown as typeof dns.lookup;
}

/**
 * Wrap `request` and `get` on one of the two HTTP modules so every outgoing
 * request carries our `lookup` unless it brought its own.
 *
 * `??=`, not an assignment: a caller that passed a `lookup` deliberately keeps
 * it. And the options object is copied rather than mutated, because it may be
 * shared, reused or frozen by whoever built it.
 *
 * `get` is re-derived from the wrapped `request` rather than wrapped
 * separately — that is exactly what Node's own `get` is (a `request` plus an
 * immediate `end()`), and deriving it means there is one code path to get right
 * instead of two.
 */
function patchModule(mod: typeof http | typeof https, lookup: typeof dns.lookup): void {
  const request = mod.request.bind(mod) as (...args: unknown[]) => http.ClientRequest;

  const wrapped = (arg1: unknown, arg2?: unknown, arg3?: unknown): http.ClientRequest => {
    if (typeof arg1 === "string" || arg1 instanceof URL) {
      // request(url, options?, cb?) — when arg2 is not an options object it is
      // the callback, and the options slot is ours to fill.
      if (typeof arg2 === "object" && arg2 !== null) {
        return request(arg1, withLookup(arg2, lookup), arg3);
      }
      return request(arg1, { lookup }, arg2);
    }
    // request(options, cb?)
    if (typeof arg1 === "object" && arg1 !== null) {
      return request(withLookup(arg1, lookup), arg2, arg3);
    }
    return request(arg1, arg2, arg3);
  };

  mod.request = wrapped as typeof mod.request;
  mod.get = ((arg1: unknown, arg2?: unknown, arg3?: unknown) => {
    const req = wrapped(arg1, arg2, arg3);
    req.end();
    return req;
  }) as typeof mod.get;
}

function withLookup(options: object, lookup: typeof dns.lookup): object {
  if ("lookup" in options && (options as { lookup?: unknown }).lookup !== undefined) {
    return options;
  }
  return { ...options, lookup };
}
