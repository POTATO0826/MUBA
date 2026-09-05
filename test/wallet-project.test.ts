import { afterEach, describe, expect, test } from "bun:test";
import { fetchWalletConfig } from "../src/wallet/project.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("wallet boot config", () => {
  test("pins wallet connections to Base Sepolia", async () => {
    globalThis.fetch = (async () =>
      Response.json({ projectId: "project", chainId: 84532 })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "project", chainId: 84532 });
  });

  test("does not allow server configuration to widen wallet access to mainnet", async () => {
    globalThis.fetch = (async () =>
      Response.json({ projectId: "project", chainId: 8453 })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "project", chainId: 84532 });
  });

  test("an unsupported chain id remains pinned to Base Sepolia", async () => {
    globalThis.fetch = (async () =>
      Response.json({ projectId: "project", chainId: 1 })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "project", chainId: 84532 });
  });

  test("a failed config request keeps the inert Base Sepolia fallback", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    expect(await fetchWalletConfig()).toEqual({ projectId: "", chainId: 84532 });
  });
});
