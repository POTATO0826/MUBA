import { afterEach, describe, expect, test } from "bun:test";
import { fetchWalletConfig } from "../src/wallet/project.ts";

/**
 * The wallet boot config — the one fetch that happens before any wallet tier
 * is chosen.
 *
 * `origin/gamestake` added a `chainId` to this payload and tested that a
 * server could not widen it to mainnet. The field is gone: this build does not
 * take the signing chain from the server at all. `SIGNING_CHAIN_ID`
 * (`src/data/wallet.ts`) is a constant, `src/wallet/config.ts` offers AppKit
 * exactly one network, and `assertSigningChain` refuses everything else at the
 * last moment before a signer is handed over. A chain id that never travels
 * over the wire cannot be widened over the wire, which is the stronger version
 * of the property that test was reaching for — `test/wallet-boundary.test.ts`
 * and `test/chain-guard.test.ts` are where it is now pinned.
 *
 * What is left here is what this module actually decides: whether AppKit is
 * configured at all, and that a server that answers badly cannot make the
 * boundary throw or arm a tier on a value it did not send.
 */
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("wallet boot config", () => {
  test("a project id is taken as the server sent it", async () => {
    globalThis.fetch = (async () =>
      Response.json({ projectId: "project" })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "project" });
  });

  test("no chain id is read off the payload, whatever the server puts there", async () => {
    // Mainnet, named explicitly, and it changes nothing — there is no field to
    // land in. The live tier is pinned by a constant, not by this response.
    globalThis.fetch = (async () =>
      Response.json({ projectId: "project", chainId: 8453 })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "project" });
  });

  test("a non-string project id is empty, not the value", async () => {
    // Empty means "AppKit is not configured", which the boundary answers by
    // falling back to an injected wallet or the mock. Passing a number through
    // would arm the live tier with a project id it cannot use.
    globalThis.fetch = (async () =>
      Response.json({ projectId: 42 })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "" });
  });

  test("a failed config request is inert rather than fatal", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "" });
  });

  test("a fetch that throws is inert too", async () => {
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "" });
  });
});
