#!/usr/bin/env bun
/**
 * Does ATTESTOR_PRIVATE_KEY match the escrow's on-chain attestor?
 *
 *     bun run scripts/check-attestor.ts
 *
 * Paste the key into `.env` first. This script derives its address and compares
 * that against `attestor()` read live from `THETADUEL_ESCROW`, which is the only
 * comparison that matters: the escrow's attestor is set in the constructor and
 * is immutable, so a verdict signed by any other key reverts `winStake` with
 * "bad attestor signature".
 *
 * ## Why this script exists
 *
 * `src/server/attest.ts` builds its signer inside a try/catch and caches `null`
 * on failure, so a malformed key, a key for the wrong account, and no key at all
 * are all reported identically as `{"ok":false,"reason":"attestor not
 * configured"}`. That is correct for a server -- an error message must never
 * carry key material -- but it leaves no way to tell the three apart. This
 * script is the missing distinction, run locally and deliberately.
 *
 * It NEVER prints the key, any prefix of it, or its length beyond the pass/fail
 * of a format check. The only things it puts on stdout are two public addresses
 * and a verdict.
 *
 * `fetch` rather than ethers' JsonRpcProvider on purpose: one POST with no
 * connection pooling, no retry loop, and nothing to hang on.
 */
import { Wallet, getAddress } from "ethers";

const RPC = (Bun.env.ESCROW_RPC_URL ?? "https://sepolia.base.org").trim();
const ESCROW = (Bun.env.THETADUEL_ESCROW ?? "").trim();
/** `attestor()` -- keccak256 of the signature, first four bytes. */
const ATTESTOR_SELECTOR = "0xcada25c2";

function fail(message: string): never {
  console.error(`\n  FAIL  ${message}\n`);
  process.exit(1);
}

const raw = (Bun.env.ATTESTOR_PRIVATE_KEY ?? "").trim();
if (!raw) {
  fail(
    "ATTESTOR_PRIVATE_KEY is empty in .env.\n" +
      "        Paste the 64-hex-character private key -- not the 40-character address.",
  );
}

// A bare key is a typo, not an error: ethers wants the prefix, the user meant
// the same value either way.
const key = raw.startsWith("0x") ? raw : `0x${raw}`;
const hex = key.slice(2);

if (!/^[0-9a-fA-F]+$/.test(hex)) fail("ATTESTOR_PRIVATE_KEY contains non-hex characters.");
if (hex.length === 40) {
  fail(
    "That is a 40-character ADDRESS, not a private key.\n" +
      "        A private key is 64 hex characters. Export it from the wallet that\n" +
      "        owns the attestor account, and never share it with anyone.",
  );
}
if (hex.length !== 64) {
  fail(`A private key is 64 hex characters; this value has ${hex.length}.`);
}

let derived: string;
try {
  derived = new Wallet(key).address;
} catch {
  fail("ethers rejected this value as a private key.");
}

console.log(`\n  key derives to   ${derived}`);

const declared = (Bun.env.ATTESTOR_ADDRESS ?? "").trim();
if (declared) {
  const ok = getAddress(declared) === derived;
  console.log(`  ATTESTOR_ADDRESS ${getAddress(declared)}   ${ok ? "match" : "MISMATCH"}`);
}

if (!ESCROW) {
  console.log("\n  THETADUEL_ESCROW is unset, so the on-chain attestor was not read.\n");
  process.exit(0);
}

const response = await fetch(RPC, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_call",
    params: [{ to: ESCROW, data: ATTESTOR_SELECTOR }, "latest"],
  }),
});
const body = (await response.json()) as { result?: string; error?: { message?: string } };
if (!body.result) fail(`RPC could not read attestor(): ${body.error?.message ?? "no result"}`);

const onChain = getAddress(`0x${body.result.slice(-40)}`);
const matches = onChain === derived;

console.log(`  escrow expects   ${onChain}   (${ESCROW})`);
console.log(
  matches
    ? "\n  OK  This key can sign verdicts the escrow accepts.\n"
    : "\n  FAIL  This key is NOT the escrow's attestor. winStake would revert with\n" +
        "        \"bad attestor signature\". Use the key for the address above, or\n" +
        "        redeploy DuelEscrow with an attestor you control.\n",
);
process.exit(matches ? 0 : 1);
