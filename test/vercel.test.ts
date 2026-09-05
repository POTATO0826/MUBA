import { describe, expect, test } from "bun:test";
import api from "../api/[...path].ts";

const request = (path: string, init?: RequestInit) =>
  api.fetch(new Request(`https://example.vercel.app${path}`, init));

describe("Vercel API routing", () => {
  test("boot config exposes only the public configuration", async () => {
    const response = await request("/api/config");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(await response.json()).sort()).toEqual([
      "dataChainId", "escrow", "features", "projectId", "referrer", "signingChainId",
    ]);
  });

  test("static room listing wins over the room ID parameter", async () => {
    const response = await request("/api/rooms/mine?address=0x1111111111111111111111111111111111111111");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rooms: [] });
  });

  test("room ID parameters reach the existing validation", async () => {
    const response = await request("/api/rooms/nonexistent-vercel-test");
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe("NOT_FOUND");
  });

  test("POST-only routes reject GET", async () => {
    const response = await request("/api/rooms/example/join");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  test("unknown API paths return JSON, not the SPA", async () => {
    const response = await request("/api/unknown");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });
});
