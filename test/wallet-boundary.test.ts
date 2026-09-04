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
});
