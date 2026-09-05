import { parseEnv } from "node:util";

// Values travel only through stdin to the authenticated Vercel CLI. Never
// print them or place them in command-line arguments or a committed file.
const project = process.argv[2];
if (!project || !/^[a-zA-Z0-9_-]+$/.test(project)) {
  throw new Error("Usage: bun scripts/vercel-env.ts <vercel-project>");
}
const values = parseEnv(await Bun.file(new URL("../.env.local", import.meta.url)).text());
for (const [name, value] of Object.entries(values)) {
  if (name === "DEPLOYER_PRIVATE_KEY" || name.startsWith("VERCEL_")) continue;
  if (!value) {
    console.log(`${name}: empty locally; not uploaded (check that no old remote value exists)`);
    continue;
  }
  const child = Bun.spawn([
    "bunx", "vercel", "env", "add", name, "production", "--project", project,
    "--force", "--yes", "--sensitive",
  ], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  child.stdin.write(value);
  child.stdin.end();
  // Drain output but don't echo it: even CLI error output could contain input.
  const [, , code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`Vercel rejected ${name}; values were not logged.`);
  console.log(`${name}: uploaded to production${value ? "" : " (empty)"}`);
}
