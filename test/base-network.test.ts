import { describe, expect, test } from "bun:test";
import {
  BASE_MAINNET,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA,
  BASE_SEPOLIA_CHAIN_ID,
  baseExplorerAddress,
  baseExplorerTx,
  baseNetworkByChainId,
  baseNetworkFrom,
} from "../src/data/base-network.ts";

describe("Base network configuration", () => {
  test("defaults to Base Sepolia and refuses explicit mainnet", () => {
    expect(baseNetworkFrom(undefined)).toBe(BASE_SEPOLIA);
    expect(baseNetworkFrom("")).toBe(BASE_SEPOLIA);
    expect(baseNetworkFrom("   ")).toBe(BASE_SEPOLIA);
    expect(baseNetworkFrom("base")).toBeNull();
    expect(baseNetworkFrom("8453")).toBeNull();
    expect(baseNetworkFrom("base-sepolia")).toBe(BASE_SEPOLIA);
    expect(baseNetworkFrom("testnet")).toBe(BASE_SEPOLIA);
    expect(baseNetworkFrom(84532)).toBe(BASE_SEPOLIA);
  });

  test("unknown values fail closed", () => {
    expect(baseNetworkFrom("ethereum-sepolia")).toBeNull();
    expect(baseNetworkFrom(1)).toBeNull();
    expect(baseNetworkByChainId(1)).toBeNull();
  });

  test("pins the official chain ids and Circle USDC addresses", () => {
    expect(BASE_MAINNET_CHAIN_ID).toBe(8453);
    expect(BASE_SEPOLIA_CHAIN_ID).toBe(84532);
    expect(BASE_MAINNET.usdc).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(BASE_SEPOLIA.usdc).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });

  test("builds explorer links for the configured network", () => {
    expect(baseExplorerTx(84532, "0xabc")).toBe("https://sepolia.basescan.org/tx/0xabc");
    expect(baseExplorerAddress(84532, "0xdef")).toBe(
      "https://sepolia.basescan.org/address/0xdef",
    );
    expect(baseExplorerTx(8453, "0xabc")).toBe("https://basescan.org/tx/0xabc");
  });
});
