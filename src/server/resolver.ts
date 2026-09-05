import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * Resolving the book's host on a network that filters it.
 *
 * Two mechanisms live here, and the order matters:
 *
 *   1. **`THETADUEL_DNS`** — an explicit, opt-in resolver override. Unset, it
 *      does nothing at all. `THETADUEL_DNS=off` disables everything in this
 *      file including 2.
 *   2. **An automatic, one-shot fallback** — on a market read that fails with
 *      the *interception signature*, and only then, this file measures whether
 *      the machine's resolver and a public one disagree about the book's host,
 *      and if they do it applies the same override and says so loudly.
 *
 * 2 was added because 1 is unreachable for the person who needs it: `.env` is
 * gitignored, so every fresh clone starts without the line, and the arena's
 * `ETH · NO BOARD` — which is the board correctly refusing to draw cells nobody
 * can buy — told nobody why. That cost the owner an afternoon and then cost a
 * teammate the same afternoon. See "## The automatic fallback" below, which
 * also states the trade-off it makes, because it is a real one.
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
 *
 * ## The automatic fallback
 *
 * `THETADUEL_DNS` fixed the owner's machine and fixed nothing else, because
 * `.env` is gitignored: a teammate who pulls this repo gets no such line, gets
 * `ETH · NO BOARD`, and gets no way to find out why. So {@link autoFallback}
 * runs the same override without being asked — under four conditions, each of
 * which exists to stop it firing when it would be wrong:
 *
 *  1. **Only on the interception signature.** {@link classifyFailure} reads the
 *     error's own code. A 429, a timeout, a socket hang up, an expired venue
 *     certificate — none of them get here. If the venue is genuinely down,
 *     retrying through Cloudflare finds it equally down and all a blanket retry
 *     would buy is a doubled timeout and a muddier diagnosis.
 *  2. **Only on measured disagreement.** {@link probeHost} asks the machine's
 *     resolver and a public one for the same name and compares the answers. It
 *     falls back only when they have **no address in common** — the shape a
 *     block page has, and not the shape of two resolvers returning the same
 *     Cloudflare anycast set in a different order. A code alone would be an
 *     inference; two answers side by side is an observation.
 *  3. **Once per process.** The outcome is cached, so the 30s refresh does not
 *     re-probe. One retry, not a loop.
 *  4. **Never over an explicit choice.** `THETADUEL_DNS=<servers>` wins and
 *     skips the probe entirely; `THETADUEL_DNS=off` disables the fallback and
 *     the override both, and the network's answer is then respected whatever it
 *     says.
 *
 * ### The trade-off, stated rather than buried
 *
 * **A network operator may have blocked that host on purpose.** Routing around
 * a filter is defensible for a local dev tool on a personal machine — the owner
 * cannot change the DNS servers on a hotspot he does not administer — and it is
 * much less defensible on a managed corporate network, where the filter is
 * somebody's deliberate policy and this process is quietly stepping over it.
 *
 * That is precisely why the behaviour is **loud rather than silent**: it prints
 * a paragraph to the server log naming both answers it measured, and it rides
 * to the screen as an advisory on the market envelope, so nobody can be using
 * the fallback without knowing they are. And it is why `THETADUEL_DNS=off`
 * exists: one line, and the network's answer stands, board or no board.
 *
 * It still does not weaken TLS. The fallback fixes **name resolution only** —
 * every certificate is validated exactly as before, and the reason the block
 * page throws a certificate error is that this is working.
 */

/** Read once per install, named here so the string appears in one place. */
export const DNS_ENV = "THETADUEL_DNS";

/**
 * The one value of `THETADUEL_DNS` that is not a server list.
 *
 * Same opt-out spelling as `THETADUEL_MARKET=off` and `THETADUEL_OPTIONS=off`,
 * deliberately: one word to remember across every switch in this app. It turns
 * off the explicit override AND the automatic fallback, which is the point —
 * it is the answer for anyone who wants their network's answer respected
 * whatever it says.
 */
export const DNS_OFF = "off";

/**
 * The host the Thetanuts SDK reads the Base order book from —
 * `chainConfig.apiBaseUrl` for chain 8453, hostname only.
 *
 * Transcribed rather than imported: this module is the *first* import in
 * `index.ts`, ahead of anything that can open a socket, and pulling the SDK
 * (axios, viem, ethers) in here to read one string would invert that. It cannot
 * drift silently — `test/resolver.test.ts` asserts it equals
 * `getChainConfigById(8453).apiBaseUrl`'s host, read from the SDK itself.
 */
export const BOOK_HOST = "round-snowflake-9c31.devops-118.workers.dev";

/**
 * Where {@link autoFallback} looks when the machine's resolver is filtering.
 *
 * Two, from two operators, so one being unreachable is not the end of it.
 * Literal addresses for the reason `parseResolvers` refuses hostnames: a
 * resolver you have to resolve is not a resolver.
 */
export const FALLBACK_SERVERS: readonly string[] = ["1.1.1.1", "8.8.8.8"];

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
   *   `"off"`        — the var is the literal `off`. Everything in this file,
   *                    including the automatic fallback, is disabled. Silent.
   *   `"no-valid"`   — the var was set but nothing in it validated. Loud.
   *   `"failed"`     — `dns.setServers` refused the list. Loud.
   *   `"already"`    — install() already ran in this process; ignored.
   */
  reason?: "unset" | "off" | "no-valid" | "failed" | "already";
};

/**
 * Guard against a second install. The wrappers below capture the *current*
 * `http.request`, so installing twice would stack one wrapper on another and
 * make the override's own footprint grow every time. It is idempotent instead.
 */
let installed = false;

/** Set by `install()` when it saw `THETADUEL_DNS=off`. Read by the fallback. */
let optedOut = false;

/** Test seam only — lets the suite assert the inert path more than once. */
export function resetResolverForTests(): void {
  installed = false;
  optedOut = false;
  fallback = null;
  fallbackJob = null;
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

  // Checked before parsing, because `off` is not a malformed server list — it
  // is a decision, and reporting it as junk would be the opposite of what the
  // operator asked for. Silent like `unset`: someone who turned the feature off
  // does not need a paragraph about it every boot.
  if ((raw ?? "").trim().toLowerCase() === DNS_OFF) {
    optedOut = true;
    return { active: false, servers: [], rejected: [], reason: "off" };
  }

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

  const applied = applyOverride(servers);
  if (!applied.ok) {
    warn(
      `${DNS_ENV}: dns.setServers(${servers.join(", ")}) was refused — ` +
        `${applied.error instanceof Error ? applied.error.message : String(applied.error)}\n` +
        `  the resolver override is OFF and DNS is unchanged.`,
    );
    return { active: false, servers: [], rejected, reason: "failed" };
  }

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

/**
 * Point `dns.resolve*` at `servers` and inject the matching lookup into the
 * four HTTP entry points. The one place either path — explicit env var or
 * automatic fallback — actually touches a global, so the blast radius
 * documented in the header has exactly one implementation.
 */
function applyOverride(servers: readonly string[]): { ok: true } | { ok: false; error: unknown } {
  try {
    dns.setServers([...servers]);
  } catch (error) {
    return { ok: false, error };
  }
  const lookup = makeLookup();
  patchModule(http, lookup);
  patchModule(https, lookup);
  installed = true;
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Classifying a failed read — the part that must not guess
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a failed market read looks like, as far as this file can *observe*.
 *
 *   `"filtered"` — something between this process and the venue answered in
 *                  the venue's place. The strong form of this claim is only
 *                  ever made after {@link probeHost} confirms it.
 *   `"unknown"`  — everything else, including "the venue is genuinely down".
 *                  The deliberate default: a confident wrong "your network is
 *                  blocking this" while Thetanuts is actually offline would be
 *                  this repo's fourth misdiagnosis of the same host, pointing
 *                  the other way.
 */
export type FailureKind = "filtered" | "unknown";

export type FailureVerdict = {
  kind: FailureKind;
  /** The observable that decided it — an error code or an address. Never a
   *  paraphrase, so a log line can be checked against the machine. */
  evidence: string | null;
};

/**
 * TLS errors that mean *somebody else answered*, not *the venue is misbehaving*.
 *
 * The book is served from Cloudflare behind a publicly trusted certificate. A
 * chain that will not validate against the system store is therefore not the
 * venue's certificate at all — it is a block page, or a corporate MITM proxy
 * whose root this process does not trust. Both are the same class of thing and
 * both are fixed by not talking to them.
 *
 * `CERT_HAS_EXPIRED` is deliberately **absent**. An expired certificate is the
 * one cert error a real venue plausibly serves itself, and calling that a
 * network filter would send the reader off to check their DNS while the actual
 * fault sat at the other end. The list is short on purpose; a code not on it
 * lands in `"unknown"`, which is the honest answer.
 *
 * Bun/node surface these on `error.code`, and axios wraps them so the code can
 * be a level or two down `cause`; the message often carries the bare code too.
 * All three are searched.
 */
const INTERCEPTION_CODES: readonly string[] = [
  // Node/OpenSSL: the presented chain does not reach a trusted root.
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_UNTRUSTED",
  // Windows/SChannel's word for the same thing, which Bun can surface instead.
  "SEC_E_UNTRUSTED_ROOT",
  // A valid certificate for the wrong name: an interceptor that did not even
  // try to impersonate the host it is standing in front of.
  "ERR_TLS_CERT_ALTNAME_INVALID",
];

/**
 * Ranges a filtering resolver hands out instead of the real address.
 *
 * One entry, because one is what has actually been measured here:
 * `146.112.61.104`, reverse `hit-block.opendns.com`, which is OpenDNS / Cisco
 * Umbrella's block-page range. This list is evidence, not a guess at the shape
 * of the internet — the general detector is {@link probeHost}'s disagreement
 * check, which needs no list at all and catches every other vendor. A named
 * range only lets the log say *whose* block page it is.
 */
export const BLOCK_PAGE_RANGES: readonly { cidr: string; who: string }[] = [
  { cidr: "146.112.61.0/24", who: "OpenDNS / Cisco Umbrella block page" },
];

/** Whose block page this address is, or `null` if it is not a known one. */
export function blockPageOwner(address: string): string | null {
  if (isIP(address) !== 4) return null;
  const value = ipv4ToInt(address);
  if (value === null) return null;
  for (const range of BLOCK_PAGE_RANGES) {
    const [base = "", bitsRaw = ""] = range.cidr.split("/");
    const baseValue = ipv4ToInt(base);
    const bits = Number(bitsRaw);
    if (baseValue === null || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    // `>>> 0` because a 32-bit mask with the top bit set is negative under
    // JavaScript's signed shift, and `-1 >>> 0` is the mask we actually want.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((value & mask) >>> 0 === (baseValue & mask) >>> 0) return range.who;
  }
  return null;
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value * 256 + octet) >>> 0;
  }
  return value;
}

/**
 * Read a failed request for the interception signature — **on the error's own
 * fields only**, never on how the failure felt.
 *
 * Two things count as evidence:
 *
 *  - one of {@link INTERCEPTION_CODES}, on the error, on any `cause` beneath
 *    it, or spelled out in the message (axios stringifies the code into the
 *    message and Bun sometimes surfaces it only there);
 *  - an address from {@link BLOCK_PAGE_RANGES} appearing in the message, which
 *    is what a refused or reset connection to a block page looks like
 *    (`connect ECONNREFUSED 146.112.61.104:443`).
 *
 * Everything else is `"unknown"`. That includes `ENOTFOUND` and `EAI_AGAIN`:
 * a name that does not resolve at all looks identical whether the zone is
 * blocked by NXDOMAIN or the machine simply has no network, and "you are
 * offline" is by far the likelier of the two. The doctor (`scripts/doctor.ts`)
 * can tell those apart because it is allowed to make its own requests; a
 * classifier handed one exception cannot, so it does not pretend to.
 */
export function classifyFailure(error: unknown): FailureVerdict {
  const text = errorText(error);

  for (const code of INTERCEPTION_CODES) {
    if (text.includes(code)) return { kind: "filtered", evidence: code };
  }

  for (const address of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) {
    const who = blockPageOwner(address);
    if (who) return { kind: "filtered", evidence: `${address} (${who})` };
  }

  return { kind: "unknown", evidence: null };
}

/** Message + `code` of an error and everything under its `cause` chain, flattened. */
function errorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error !== "object") return String(error);
  const record = error as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
  const parts = [
    typeof record.message === "string" ? record.message : "",
    typeof record.code === "string" ? record.code : "",
    errorText(record.cause, depth + 1),
  ];
  // `AggregateError` — what a happy-eyeballs connect produces when every
  // address fails, and where the only interesting code lives.
  if (Array.isArray(record.errors)) {
    for (const inner of record.errors) parts.push(errorText(inner, depth + 1));
  }
  return parts.filter(Boolean).join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// The probe: two resolvers, one name, side by side
// ─────────────────────────────────────────────────────────────────────────────

export type HostProbe = {
  host: string;
  /** What this machine's own resolver says — `dns.lookup`, i.e. `getaddrinfo`,
   *  which is the answer the socket layer would use if nothing here intervened. */
  system: string[];
  /** What the public resolvers say, asked through a **scoped** `dns.Resolver`
   *  that touches no global — so a probe that decides against falling back has
   *  changed nothing at all. */
  publicAnswer: string[];
  /** System addresses that are in a named block-page range. */
  blocked: string[];
  /** True when both sides answered and share no address. The block-page shape. */
  disjoint: boolean;
  /** Why the probe could not decide, or `null`. */
  error: string | null;
};

/**
 * Ask both resolvers for `host` and put the answers next to each other.
 *
 * This is the measurement the whole automatic path rests on, and it is worth
 * being clear about why it is a *comparison* rather than a block-list check.
 * Every filtering vendor has its own block-page addresses and no list of them
 * would ever be complete; but no filter can avoid the one property that gives
 * it away, which is that its answer is not the answer everyone else gets.
 *
 * Compared as **sets with no overlap**, not for equality: Cloudflare returns
 * an anycast pair and two resolvers routinely return them in a different order
 * or return only one of them. Sharing even one address means both sides are
 * looking at the same service, and there is nothing to route around.
 *
 * Never throws. A resolver that cannot be reached is a `null`-free `error`
 * string and a refusal to conclude anything.
 */
export async function probeHost(
  host: string = BOOK_HOST,
  servers: readonly string[] = FALLBACK_SERVERS,
): Promise<HostProbe> {
  const [system, publicAnswer] = await Promise.all([systemAddresses(host), publicAddresses(host, servers)]);

  const blocked = system.ok ? system.value.filter((a) => blockPageOwner(a) !== null) : [];
  const errors = [system.ok ? "" : `system resolver: ${system.error}`, publicAnswer.ok ? "" : `${servers.join("/")}: ${publicAnswer.error}`]
    .filter(Boolean)
    .join("; ");

  const left = system.ok ? system.value : [];
  const right = publicAnswer.ok ? publicAnswer.value : [];
  return {
    host,
    system: left,
    publicAnswer: right,
    blocked,
    disjoint: left.length > 0 && right.length > 0 && !left.some((a) => right.includes(a)),
    error: errors === "" ? null : errors,
  };
}

type Answer = { ok: true; value: string[] } | { ok: false; error: string };

/** `getaddrinfo`, which is what the socket layer uses and what a filter sits on. */
function systemAddresses(host: string): Promise<Answer> {
  return new Promise((resolve) => {
    // The ORIGINAL lookup, captured at module load: `patchModule` replaces
    // `http.request`, never `dns.lookup`, so this is the machine's answer even
    // after the override is installed — which is what makes the log line
    // "your resolver says X" still true when it is printed.
    ORIGINAL_LOOKUP(host, { all: true }, (error, addresses) => {
      if (error) return resolve({ ok: false, error: error.message });
      const list = Array.isArray(addresses) ? addresses.map((a) => a.address) : [];
      resolve({ ok: true, value: list });
    });
  });
}

/** The public answer, through a resolver instance that is not the global one. */
function publicAddresses(host: string, servers: readonly string[]): Promise<Answer> {
  return new Promise((resolve) => {
    let resolver: dns.Resolver;
    try {
      resolver = new dns.Resolver();
      resolver.setServers([...servers]);
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    resolver.resolve4(host, (error, addresses) => {
      if (error) return resolve({ ok: false, error: error.message });
      resolve({ ok: true, value: [...addresses] });
    });
  });
}

const ORIGINAL_LOOKUP = dns.lookup;

// ─────────────────────────────────────────────────────────────────────────────
// The automatic, one-shot fallback
// ─────────────────────────────────────────────────────────────────────────────

export type FallbackReason =
  /** The override was applied and a retry is worth making. */
  | "applied"
  /** The failure did not carry the interception signature. Nothing was probed. */
  | "not-filtered"
  /** `THETADUEL_DNS=off`. The operator's network, the operator's answer. */
  | "opted-out"
  /** An override is already in place — explicit, or a previous fallback. */
  | "already"
  /** Both resolvers agree. Whatever is wrong, it is not name resolution. */
  | "agree"
  /** Neither answer could be obtained; nothing was concluded and nothing changed. */
  | "probe-failed"
  /** `dns.setServers` refused the fallback list. */
  | "failed";

export type FallbackOutcome = {
  /** True only when the override is now in place *because of this call*. */
  applied: boolean;
  reason: FallbackReason;
  /** The measurement, or `null` when no probe was run. */
  probe: HostProbe | null;
};

/**
 * ## The four sentences
 *
 * They live here, beside the thing that measures the condition, so there is one
 * wording per situation and no surface can invent a fifth. They are *sentences*
 * and not a paragraph because their destination is the footer's single error
 * line — this is an error line, not a tutorial; the tutorial is the README and
 * `bun run doctor`.
 *
 * Each one carries the two facts this repo has twice failed to get across:
 * **it is this network**, and **it is not a venue outage**.
 */

/** Applied, and the retry worked. The board is real; how it got here is not. */
export const FALLBACK_ADVISORY = `Live via public DNS — this network filters the book's host. Not a venue outage.`;

/** Filtered, and nothing has been done about it — so name the one line to add. */
export const FILTERED_ADVICE = `Network filter, not a venue outage — add ${DNS_ENV}=${FALLBACK_SERVERS.join(",")} to .env and restart.`;

/**
 * Filtered, a public resolver was already in use, and it *still* failed. Do not
 * offer `THETADUEL_DNS` here: it is set, and repeating it as advice is how a
 * user spends an hour re-doing the thing they already did.
 */
export const FILTER_PERSISTS_ADVICE = `Something on this network is intercepting the book's host and a public resolver did not get past it. Not a venue outage.`;

/** Filtered, and the operator asked us not to route around it. Their call. */
export const FILTER_OPTED_OUT_ADVICE = `This network filters the book's host and ${DNS_ENV}=${DNS_OFF} is set, so it is being respected. Not a venue outage.`;

/** The cached outcome. One probe per process; the 30s refresh re-reads nothing. */
let fallback: FallbackOutcome | null = null;
/** In-flight guard, so two concurrent failed reads do not both probe. */
let fallbackJob: Promise<FallbackOutcome> | null = null;

/** What the fallback did, for anything that wants to report it without
 *  triggering it. `null` until a failure has actually been classified. */
export function fallbackOutcome(): FallbackOutcome | null {
  return fallback;
}

export type FallbackOptions = {
  /** The raw env value. Defaults to `Bun.env[DNS_ENV]`. */
  value?: string | null;
  /** Where the banner goes. Defaults to `console.error` — this is a condition,
   *  not a status line, and it must survive someone's log filter. */
  warn?: (message: string) => void;
  /** Test seam: the measurement. Defaults to the real {@link probeHost}. */
  probe?: (host: string) => Promise<HostProbe>;
  host?: string;
  /**
   * Test seam: the one call that touches a global.
   *
   * It exists for the same reason the whole suite refuses to exercise the live
   * override — applying it replaces four functions on `node:http`/`node:https`
   * process-wide, and a unit test that did so would hand every later suite in
   * the run a patched HTTP stack. With this injected, the *decision* is fully
   * testable and the *application* is not attempted; the application itself is
   * verified the only way that proves anything, by starting a real server and
   * reading `/api/market`. See the note at the top of `test/resolver.test.ts`.
   */
  apply?: (servers: readonly string[]) => { ok: true } | { ok: false; error: unknown };
};

/**
 * Decide, once per process, whether this failure is a network filter — and if
 * it demonstrably is, route name resolution around it and say so.
 *
 * Returns `applied: true` **only** when the caller should retry. Every other
 * outcome means "nothing changed, report the failure you already have".
 *
 * The header's trade-off section is the thing to read before changing anything
 * here: a network operator may have blocked this host on purpose, and this
 * function steps over that. It is loud for that reason.
 */
export function autoFallback(error: unknown, options: FallbackOptions = {}): Promise<FallbackOutcome> {
  if (fallback) return Promise.resolve({ ...fallback, applied: false });
  if (fallbackJob) return fallbackJob.then((outcome) => ({ ...outcome, applied: false }));

  const verdict = classifyFailure(error);
  // Guardrail 1, and the one that matters most: a generic failure never gets
  // here. Not cached — the *next* failure might be the filtered one, and a
  // 429 on the first read should not decide the process's diagnosis forever.
  if (verdict.kind !== "filtered") {
    return Promise.resolve({ applied: false, reason: "not-filtered", probe: null });
  }

  const job = run(verdict, options).then((outcome) => {
    // Cached so the 30s refresh does not re-probe — one measurement per
    // process, one retry, never a loop.
    //
    // `probe-failed` is the one outcome deliberately NOT cached. It means
    // neither resolver answered, which concludes nothing; letting a single DNS
    // timeout wedge the recovery for the life of the process would turn a
    // transient hiccup into the exact permanent empty board this exists to
    // remove. Every *decisive* outcome is cached, and since only an
    // interception-signature failure reaches this function at all, the
    // un-cached case cannot become chatty on a healthy network.
    //
    // Known limit, stated rather than hidden: a decisive outcome survives a
    // change of network. Move a running process from a clean link onto a
    // filtered one — a phone hotspot, which is the exact machine this was
    // written on — and it keeps the verdict it measured. Restarting re-measures.
    if (outcome.reason !== "probe-failed") fallback = { ...outcome, applied: false };
    fallbackJob = null;
    return outcome;
  });
  fallbackJob = job;
  return job;
}

async function run(verdict: FailureVerdict, options: FallbackOptions): Promise<FallbackOutcome> {
  const warn = options.warn ?? ((m: string) => console.error(m));
  const raw = options.value !== undefined ? options.value : (Bun.env[DNS_ENV] ?? null);
  const host = options.host ?? BOOK_HOST;

  if (optedOut || (raw ?? "").trim().toLowerCase() === DNS_OFF) {
    // Printed once, even though the operator asked for this: the whole failure
    // mode being fixed here is a board that is empty for a reason nobody can
    // see. Somebody who set `off` months ago and has since forgotten is exactly
    // the person who needs one line in the log rather than a fifth
    // investigation.
    warn(
      `[dns] the book read failed with the interception signature and ` +
        `${DNS_ENV}=${DNS_OFF} is set — not probing, not falling back. ` +
        `Your network's answer is being respected. This is a local network ` +
        `filter, NOT a Thetanuts outage.`,
    );
    return { applied: false, reason: "opted-out", probe: null };
  }
  // An explicit `THETADUEL_DNS=<servers>` already ran and still failed, or a
  // previous fallback is in place. Either way the override is not the missing
  // piece and re-applying it would prove nothing.
  if (installed) {
    warn(
      `[dns] the book read failed with the interception signature while a ` +
        `resolver override was already in place — a public resolver did not get ` +
        `past it, so something on this network is intercepting more than DNS. ` +
        `Still NOT a Thetanuts outage; see src/server/resolver.ts.`,
    );
    return { applied: false, reason: "already", probe: null };
  }

  const probe = await (options.probe ?? ((h: string) => probeHost(h)))(host);

  if (probe.system.length === 0 || probe.publicAnswer.length === 0) {
    return { applied: false, reason: "probe-failed", probe };
  }
  // Guardrail 2. Two resolvers that agree are not a filter, whatever the cert
  // said — an expired or misissued certificate at the venue lands here, and
  // routing around a resolver that was right would fix nothing and confuse
  // everyone.
  if (!probe.disjoint) {
    return { applied: false, reason: "agree", probe };
  }

  const applied = (options.apply ?? applyOverride)(FALLBACK_SERVERS);
  if (!applied.ok) {
    warn(
      `[dns] the book's host is being filtered on this network, and the automatic ` +
        `fallback could not be applied: dns.setServers was refused — ` +
        `${applied.error instanceof Error ? applied.error.message : String(applied.error)}\n` +
        `  ${FILTERED_ADVICE}`,
    );
    return { applied: false, reason: "failed", probe };
  }

  warn(banner(verdict, probe));
  return { applied: true, reason: "applied", probe };
}

/**
 * The startup shout.
 *
 * Long, and unapologetically so. This condition has been investigated four
 * separate times in this repo and misdiagnosed as a Thetanuts outage twice; the
 * cost of a paragraph in a dev server's log is nothing beside another
 * afternoon. It names both measurements so the reader can check the claim
 * themselves rather than take it, and it names the opt-out so nobody has to
 * come and find this file to turn it off.
 */
function banner(verdict: FailureVerdict, probe: HostProbe): string {
  const whose = probe.blocked.map((a) => blockPageOwner(a)).filter(Boolean)[0];
  return [
    ``,
    `  ┌─ THIS NETWORK IS FILTERING THE OPTION BOOK ────────────────────────`,
    `  │ NOT a Thetanuts outage. The venue is fine; your DNS is answering`,
    `  │ for it. Measured just now, both sides:`,
    `  │`,
    `  │   ${probe.host}`,
    `  │     this machine's resolver → ${probe.system.join(", ") || "(no answer)"}` +
      (whose ? `   ← ${whose}` : ``),
    `  │     ${FALLBACK_SERVERS.join(" / ")} → ${probe.publicAnswer.join(", ") || "(no answer)"}`,
    `  │`,
    `  │ They share no address, and the read failed with ${verdict.evidence ?? "a TLS error"}`,
    `  │ — the block page's certificate, correctly rejected.`,
    `  │`,
    `  │ SO: this process now resolves hostnames through ${FALLBACK_SERVERS.join(", ")}`,
    `  │ instead of the machine's resolver. TLS is untouched and every`,
    `  │ certificate is still fully validated — only the name lookup moved.`,
    `  │`,
    `  │ Your network operator may have blocked this host deliberately. To`,
    `  │ respect that and leave DNS alone, set ${DNS_ENV}=${DNS_OFF} in .env.`,
    `  │ Details and the full trade-off: src/server/resolver.ts`,
    `  └────────────────────────────────────────────────────────────────────`,
    ``,
  ].join("\n");
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
