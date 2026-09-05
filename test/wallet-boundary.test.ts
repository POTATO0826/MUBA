import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WalletBoundary } from "../src/wallet/boundary.tsx";

const boundarySource = readFileSync(
  join(import.meta.dir, "..", "src", "wallet", "boundary.tsx"),
  "utf8",
);
const projectSource = readFileSync(
  join(import.meta.dir, "..", "src", "wallet", "project.ts"),
  "utf8",
);
const appKitConfigSource = readFileSync(
  join(import.meta.dir, "..", "src", "wallet", "config.ts"),
  "utf8",
);

describe("WalletBoundary startup graph", () => {
  test("can be imported without evaluating the Reown live-wallet tier", () => {
    expect(typeof WalletBoundary).toBe("function");
  });

  test("keeps every Reown import behind the dynamic live-wallet boundary", () => {
    expect(boundarySource).toContain('lazy(() => import("./live.tsx"))');
    expect(boundarySource).not.toMatch(/from\s+["']@reown\//);
    expect(boundarySource).not.toMatch(/from\s+["']\.\/(?:appkit|config|live)\.tsx?["']/);
    expect(projectSource).not.toContain("@reown/");
  });

  test("offers Base Sepolia as the only AppKit network", () => {
    expect(appKitConfigSource).toContain("export const NETWORKS = [baseSepolia] as const");
    expect(appKitConfigSource).not.toMatch(/import\s*\{[^}]*\bbase\b[^}]*\}/);
  });
});
