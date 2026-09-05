import assert from "node:assert/strict";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Run after `vercel build --prod`. Import the emitted function itself so
// extension-resolution failures cannot hide behind passing source tests.
const output = new URL("../.vercel/output/functions/api/[...path].func/api/[...path].js", import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const functionRoot = resolve(root, ".vercel/output/functions/api/[...path].func");
const config = await Bun.file(resolve(functionRoot, ".vc-config.json")).json();
// Vercel leaves explicit includeFiles as upload-time mappings instead of
// copying them into local output. Materialize those mappings for this check.
for (const [target, source] of Object.entries(config.filePathMap ?? {})) {
  assert.equal(typeof source, "string");
  const from = resolve(root, source as string);
  const to = resolve(functionRoot, target);
  assert.ok(from.startsWith(resolve(root, "node_modules") + sep));
  assert.ok(to.startsWith(functionRoot + sep));
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}
const { default: api } = await import(output.href);
for (const [path, expected] of [
  ["/api/config", 200],
  ["/api/wallet-config", 200],
  ["/api/unknown", 404],
] as const) {
  const response = await api.fetch(new Request(`https://example.vercel.app${path}`));
  assert.equal(response.status, expected, path);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  console.log(`${path}: ${response.status}`);
}
