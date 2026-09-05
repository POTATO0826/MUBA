/**
 * Deploy DuelEscrow to Base Sepolia and print everything BaseScan needs to
 * verify the source.
 *
 *     bun contracts/deploy.ts              # PREFLIGHT — broadcasts nothing
 *     bun contracts/deploy.ts --broadcast  # actually spends gas
 *
 * This script is the ONLY place `DEPLOYER_PRIVATE_KEY` is ever read. Nothing
 * under `src/` may import it, and `test/secrets.test.ts` fails the build if that
 * name ever reaches a client bundle.
 *
 * ─── Why this now says Sepolia where it used to say mainnet ──────────────────
 *
 * The owner's instruction was: "connecting wallet should only be on testnet not
 * mainnet, and work on testnet only." `src/data/wallet.ts` is the long-form
 * statement of what that split means; read its header before this one. The
 * short version is that the app now touches two chains and only one of them is
 * ever signed on:
 *
 *   - **Signing chain — Base Sepolia, 84532.** Everything that signs, approves,
 *     sends or settles. `DuelEscrow` is a signing-chain contract, so this
 *     script targets 84532 and refuses everything else.
 *   - **Data chain — Base mainnet, 8453.** Read only, forever: the Thetanuts
 *     options book is deployed there and has no testnet, so strikes and
 *     premiums are a mainnet read. Nothing is ever signed there. It has no
 *     bearing on the escrow and must never be confused for a deploy target.
 *
 * Every refusal below used to point at 8453 and now points at 84532. **They are
 * the same refusals, inverted, and the inversion is the safety property, not a
 * relaxation of it.** The old script refused Sepolia because a mainnet-only
 * attestor could not settle a Sepolia escrow. The new one refuses mainnet
 * because a mainnet escrow is a contract a user's wallet is forbidden to sign
 * against at all (`assertSigningChain`, `src/data/wallet.ts`) — an escrow
 * deployed to 8453 today would be unreachable by this app's own UI, and the
 * only way to reach it would be to undo the owner's instruction. Neither
 * direction is a warning; both are exits.
 *
 * It is deliberately paranoid, because it is a one-shot irreversible action
 * with an unaudited, un-upgradeable, un-ownable contract. Testnet lowers what
 * a mistake costs; it does not lower how permanent it is, and the identical
 * script would one day be pointed at real money:
 *
 *   - every required env var must be present, or it refuses to do anything;
 *   - every address is checksum-validated before a transaction is built;
 *   - the token MUST be Circle's test USDC on Base Sepolia and the chain MUST
 *     be Base Sepolia — both are hard refusals with no override, see below;
 *   - the attestor's EIP-712 domain chain id is read out of
 *     `src/server/attest.ts` and compared against the deploy chain, and a
 *     disagreement refuses the broadcast — see "THE DOMAIN AGREEMENT" below.
 *     They agree today; this is the check that keeps it that way;
 *   - the committed artifact is recompiled and compared byte-for-byte, so a
 *     stale `contracts/out/DuelEscrow.json` can never be what gets deployed
 *     (and can never be what the operator then pastes into BaseScan);
 *   - the default run broadcasts NOTHING. Deploying takes `--broadcast`.
 *
 * Two of those used to be warnings and are now refusals — finding 5-1 of
 * `docs/reviews/escrow-adversarial-review.md`, executed against the real
 * bytecode:
 *
 *   - **A non-canonical token is unrecoverable.** The constructor takes any
 *     non-zero address, and there is no owner, no sweep and no rotation. With a
 *     1 % fee-on-transfer token the reviewer watched the escrow book a
 *     `2 × stake` pot, receive less than that, pay a settle out of the
 *     shortfall and then strand `claimRake` forever — with several duels live,
 *     the gap comes out of other players' stakes. One wrong constructor
 *     argument is permanent. That is still true of a test token: the stranded
 *     amount is worth nothing, but the escrow is just as dead and the duel is
 *     just as unsettleable.
 *   - **A chain the attestor does not sign for silently invalidates every
 *     verdict.** `src/server/attest.ts` hard-codes its EIP-712 domain chain id,
 *     so a deployment on any *other* chain produces signatures that recover to
 *     a stranger — discovered only after both stakes are locked, with the
 *     six-hour timeout as the only way out. That was written when the constant
 *     and the deploy target both said 8453. Both now say 84532, and keeping
 *     them saying the same thing is the subject of the next section.
 *
 * ─── THE DOMAIN AGREEMENT — resolved, and checked on every run ───────────────
 *
 * **Status: the attestor's domain and this script's deploy chain AGREE. This
 * section describes a hazard that was live and is now closed, and it is kept —
 * not deleted — because the agreement is a thing one line in either of two
 * files can silently break again.**
 *
 * There was a window during the testnet retarget when the two halves of finding
 * 5-1 pointed at different chains, and it is worth stating exactly what it
 * looked like, because that shape is what {@link attestorDomainChainId} exists
 * to catch:
 *
 *   - this script deploys to **84532** (Base Sepolia), because that is the only
 *     chain the app will sign on. That changed first;
 *   - `src/server/attest.ts` declared `export const BASE_CHAIN_ID = 8453`,
 *     and `attest.ts` folds that constant into the EIP-712 domain it signs
 *     verdicts over. It now reads `84532`;
 *   - `test/attest.test.ts` pinned that value with `expect(BASE_CHAIN_ID)
 *     .toBe(8453)`, so the mismatch was *green* the whole time. It now pins
 *     `84532`. Note what that test can and cannot do: it asserts the
 *     transcription is **stable**, not that it is **correct**, because the
 *     contract reads `block.chainid` and no source read can confirm it. A
 *     passing suite was never going to be the thing that caught this;
 *   - `src/server/seats.ts` held a third, deliberately un-imported copy of
 *     the same number for the seat-reading provider. It now reads `84532` too.
 *     A wrong value there cannot mis-sign anything — it fails reads closed —
 *     but "fails closed" would have meant every seat read refused, on every
 *     duel, with `/api/lock` rejecting locks and nothing on screen saying why.
 *
 * Why it would have mattered: `DuelEscrow.sol` builds its `DOMAIN_SEPARATOR`
 * from `block.chainid` in its constructor. An escrow constructed on
 * 84532 separates over 84532; an attestor signing over 8453 produces verdicts
 * that `settle` recovers a stranger from and reverts on — for every duel,
 * forever, with both stakes locked and only the six-hour `refund` to get them
 * out. That is finding 5-1 landing exactly as written, and it was pointing the
 * other way from the direction the original review imagined.
 *
 * So the check stays, and `--broadcast` is still REFUSED whenever the two
 * disagree. {@link attestorDomainChainId} reads the constant out of `attest.ts`
 * at run time rather than trusting a copy kept here, because a copy is a thing
 * that goes stale and this is the precise failure mode a stale copy would hide
 * — and because the number now lives in three files, a deploy script that
 * agreed with itself would prove nothing. Preflight still runs and still prints
 * the verification inputs whether or not they agree; only the irreversible half
 * is gated, and it is gated with an exit rather than a prompt. No flag lifts it.
 *
 * If it ever fires again, the fix is one line in `src/server/attest.ts` and it
 * is deliberately NOT made from here: that constant is money-critical, it is
 * imported by the test that pins it, and changing it from inside a deploy
 * script is how a chain id gets changed by someone who was thinking about
 * something else. Route it to the owner, as the last one was. Nothing is
 * deployed today (`THETADUEL_ESCROW` is unset, `.env.example`:54), so refusing
 * costs nothing and shipping a silently-unsettleable escrow costs everything.
 *
 * Neither the token nor the chain refusal has an override flag, deliberately.
 * If a future deployment genuinely needs a different token or chain, that is a
 * code change and a review, not a flag someone can reach for at 3am on deploy
 * night. That reasoning survives the move to testnet unchanged: the flag would
 * still be there on the day this is pointed at mainnet.
 *
 * Env:
 *   RPC_URL               required, secret. Base Sepolia JSON-RPC. The public
 *                         endpoint https://sepolia.base.org works.
 *   DEPLOYER_PRIVATE_KEY  required, secret. Needs Base Sepolia ETH, which is
 *                         free from a faucet — see the README runbook.
 *   ATTESTOR_ADDRESS      required. The referee key's ADDRESS (never its key).
 *   TREASURY_ADDRESS      required. Sole rake recipient, immutable forever.
 *   USDC                  optional. Defaults to Circle's TEST USDC on Base
 *                         Sepolia, and is REFUSED if set to anything else.
 */

import { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers";
import { join } from "node:path";
import { ARTIFACT_PATH, CONTRACT_NAME, OPTIMIZER_RUNS, SOURCE_NAME, compileEscrow } from "./build.ts";

/**
 * Circle's official **test** USDC on Base Sepolia, 6 decimals — the same
 * FiatTokenV2 lineage as native USDC on Base mainnet, so it returns `true`,
 * reverts on failure and takes no transfer fee. The escrow's whole accounting
 * rests on those three properties (the `IERC20` natspec in `DuelEscrow.sol`,
 * named rather than line-cited for the reason given below), which is why this
 * particular test token and not an arbitrary mock ERC-20: a hand-rolled test
 * token that returns nothing, or charges a fee, would break the escrow in the
 * exact way finding 5-1 describes, and would break it *quietly on testnet*
 * where nobody is watching the balance.
 *
 * **It is a test token. It has no market value and cannot be exchanged for
 * anything, and that is the entire point** — it is what makes it true that
 * nothing a user signs in this build can spend real money. Every dollar figure
 * the UI prints against a stake denominated in this token is a testnet dollar.
 *
 * Mainnet's native USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) does not
 * exist at any address on Base Sepolia; it is recorded here only so that a
 * future reader who finds it in the git history knows what it was and why it
 * left. The only token this script will deploy against; see 5-1 above.
 */
const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/**
 * Base Sepolia — the signing chain, and the only chain this script will deploy
 * to. A mismatch is a HARD REFUSAL, see 5-1 above and `main`.
 *
 * The attestor's constant has since been renamed `SIGNING_CHAIN_ID` as well as
 * re-valued, for the reason below — the regex accepts either spelling so that a
 * rename cannot quietly turn this check into a no-op that reads `null` and
 * refuses for the wrong reason.
 *
 * Named for what it is rather than `BASE_CHAIN_ID`, which is now an ambiguous
 * name in this repo: `src/data/wallet.ts` deleted its own `BASE_CHAIN_ID`
 * rather than alias it, precisely so that no call site could say "Base" and
 * leave the reader to guess which one. This file follows that.
 */
const SIGNING_CHAIN_ID = 84532n;

/** How the chain must be spelled everywhere this script prints it. */
const SIGNING_CHAIN_NAME = "Base Sepolia";

/** Base mainnet — the READ-ONLY data chain, named here only so the refusal can
 *  tell an operator who pointed `RPC_URL` at it exactly what they did. */
const DATA_CHAIN_ID = 8453n;

/** Base Sepolia's explorer. Same Etherscan software, separate deployment. */
const EXPLORER = "https://sepolia.basescan.org";

/** The attestor module, read as text — see {@link attestorDomainChainId}. */
const ATTESTOR_SOURCE = join(import.meta.dir, "..", "src", "server", "attest.ts");

/**
 * The chain id `src/server/attest.ts` folds into its EIP-712 domain, read out
 * of the source at run time. `null` when the declaration cannot be found.
 *
 * Read rather than imported: importing `attest.ts` from a deploy script would
 * pull the whole attest service — and its secret-reading env surface — into a
 * process that holds `DEPLOYER_PRIVATE_KEY`, and this script's one rule is that
 * it is the only thing that ever sees that key. Read rather than transcribed
 * into a constant here, because a transcribed copy agreeing with itself is
 * exactly the reassurance that would hide the mismatch it exists to catch.
 *
 * The alternates in the pattern are the names the constant could plausibly take
 * when it is corrected. If it takes some other name, this returns `null` and
 * the caller refuses — fail closed, and the fix is to teach this regex the new
 * name, which is a two-second edit made by someone who is looking right at the
 * thing that matters.
 */
async function attestorDomainChainId(): Promise<number | null> {
  const file = Bun.file(ATTESTOR_SOURCE);
  if (!(await file.exists())) return null;
  const source = await file.text();
  const match = source.match(
    /export\s+const\s+(?:BASE_CHAIN_ID|SIGNING_CHAIN_ID|VERDICT_DOMAIN_CHAIN_ID)\s*(?::\s*number\s*)?=\s*(\d+)/,
  );
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

/** Read a required env var or collect the reason it is missing. */
function required(name: string, missing: string[]): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    missing.push(name);
    return "";
  }
  return value;
}

/** Checksum an address or record why it is unusable. */
function address(name: string, raw: string, bad: string[]): string {
  if (!raw) return "";
  try {
    return getAddress(raw);
  } catch {
    bad.push(`${name} is not a valid address: ${raw}`);
    return "";
  }
}

async function main(): Promise<void> {
  const broadcast = Bun.argv.includes("--broadcast");

  // -- 1. environment ------------------------------------------------------
  const missing: string[] = [];
  const rpcUrl = required("RPC_URL", missing);
  const deployerKey = required("DEPLOYER_PRIVATE_KEY", missing);
  const attestorRaw = required("ATTESTOR_ADDRESS", missing);
  const treasuryRaw = required("TREASURY_ADDRESS", missing);
  const usdcRaw = Bun.env["USDC"]?.trim() || USDC_BASE_SEPOLIA;

  if (missing.length > 0) {
    console.error(`REFUSING TO RUN — missing required env var(s): ${missing.join(", ")}`);
    console.error("");
    console.error(`  RPC_URL               ${SIGNING_CHAIN_NAME} JSON-RPC (secret)`);
    console.error("  DEPLOYER_PRIVATE_KEY  faucet-funded deploy key (secret, this script only)");
    console.error("  ATTESTOR_ADDRESS      the referee key's address");
    console.error("  TREASURY_ADDRESS      sole rake recipient, immutable after deploy");
    console.error(`  USDC                  optional, defaults to test USDC on ${SIGNING_CHAIN_NAME}`);
    process.exit(1);
  }

  const bad: string[] = [];
  const usdc = address("USDC", usdcRaw, bad);
  const attestor = address("ATTESTOR_ADDRESS", attestorRaw, bad);
  const treasury = address("TREASURY_ADDRESS", treasuryRaw, bad);
  if (bad.length > 0) {
    console.error(`REFUSING TO RUN — ${bad.join("; ")}`);
    process.exit(1);
  }

  // The token is checked here, before a single RPC call or compile, because it
  // is the one constructor argument whose wrongness is silent: a fee-on-transfer
  // or otherwise non-canonical token deploys cleanly, settles cleanly, and only
  // fails once `claimRake` reaches for rake the escrow never received — by
  // which time there is no owner, no sweep and no rotation to fix it. Both
  // sides are checksummed by `address()` above, so this is a value comparison.
  //
  // Testnet does not soften this. The stranded amount is worthless, but the
  // escrow is bricked identically, and a broken settle discovered on testnet by
  // accident rather than on purpose is the whole reason to be on testnet.
  if (usdc !== USDC_BASE_SEPOLIA) {
    console.error(`REFUSING TO RUN — USDC is not Circle test USDC on ${SIGNING_CHAIN_NAME}.`);
    console.error(`  got       ${usdc}`);
    console.error(`  expected  ${USDC_BASE_SEPOLIA}`);
    console.error("");
    console.error("  The escrow assumes a token that returns true, reverts on failure and");
    console.error("  charges no transfer fee. It has no owner, no sweep and no rotation, so a");
    console.error("  wrong token address is unrecoverable — every stake behind it included.");
    console.error("  Mainnet USDC (0x8335…2913) does not exist on this chain; a mock ERC-20 is");
    console.error("  not a substitute, because the ways a mock differs are the ways the escrow");
    console.error("  breaks. Unset USDC to take the default. There is no override flag.");
    process.exit(1);
  }

  // -- 2. artifact integrity ----------------------------------------------
  // Recompile and compare: the bytes that go on chain must be the bytes that
  // are committed, or BaseScan verification will fail after the money is spent.
  const fresh = await compileEscrow();
  for (const warning of fresh.warnings) console.warn(warning);

  const artifactFile = Bun.file(ARTIFACT_PATH);
  if (!(await artifactFile.exists())) {
    console.error(`REFUSING TO RUN — no artifact at ${ARTIFACT_PATH}. Run: bun contracts/build.ts`);
    process.exit(1);
  }
  const committed = (await artifactFile.json()) as { bytecode?: string; solcVersion?: string };
  if (committed.bytecode !== fresh.bytecode || committed.solcVersion !== fresh.solcVersion) {
    console.error("REFUSING TO RUN — contracts/out/DuelEscrow.json is stale.");
    console.error("  The committed artifact does not match a fresh compile of DuelEscrow.sol.");
    console.error("  Run `bun contracts/build.ts`, review the diff, commit it, then retry.");
    process.exit(1);
  }

  // -- 3. network + signer -------------------------------------------------
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();

  // Refused before the deployer is even loaded, for two independent reasons,
  // either of which alone would be enough:
  //
  //   1. `src/server/attest.ts` binds its EIP-712 domain to one chain id as a
  //      constant, so an escrow deployed on any other chain is an escrow no
  //      verdict this repo can sign will ever settle — and the failure surfaces
  //      with both stakes already locked. (Which chain id that constant names
  //      is checked separately, immediately below; this check is about the
  //      endpoint, that one is about the attestor.)
  //   2. `src/data/wallet.ts` refuses to hand a signer to anything unless the
  //      wallet is on 84532. An escrow on any other chain — Base mainnet most
  //      of all — could not be opened, joined, settled or refunded from this
  //      app's own UI at all. The owner's instruction was that nothing a user
  //      signs can spend real money; a mainnet escrow is precisely the object
  //      that instruction forbids.
  if (network.chainId !== SIGNING_CHAIN_ID) {
    console.error(`REFUSING TO RUN — RPC_URL is not ${SIGNING_CHAIN_NAME}.`);
    console.error(`  got       chainId ${network.chainId} (${network.name})`);
    console.error(`  expected  chainId ${SIGNING_CHAIN_ID} (${SIGNING_CHAIN_NAME})`);
    console.error("");
    if (network.chainId === DATA_CHAIN_ID) {
      console.error("  That is Base MAINNET — the READ-ONLY data chain. The Thetanuts options");
      console.error("  book is read from there and nothing in this build ever signs there. It");
      console.error("  is not a deploy target; an escrow deployed there would spend real money");
      console.error("  and no wallet this app connects is allowed to reach it.");
    } else {
      console.error("  This build signs on one chain and one chain only.");
    }
    console.error(`  Point RPC_URL at ${SIGNING_CHAIN_NAME} (https://sepolia.base.org works).`);
    console.error("  There is deliberately no override flag.");
    process.exit(1);
  }

  // The other half of the same question: the endpoint is on 84532, but does the
  // attestor sign for 84532? Today it does — `src/server/attest.ts` was
  // corrected to 84532 and this block is quiet, exactly as designed. It went
  // quiet by itself: nothing here was edited to silence it, because it reads
  // the answer out of the source rather than holding an opinion about it. That
  // is the whole reason it is a read and not a constant — it will speak up
  // again the moment either side moves, including the day someone "fixes" the
  // attestor to a third value. See "THE DOMAIN AGREEMENT" in the header for
  // what it looked like while it was firing.
  const attestorChainId = await attestorDomainChainId();
  const domainAgrees = attestorChainId !== null && BigInt(attestorChainId) === SIGNING_CHAIN_ID;

  if (!domainAgrees) {
    const seen = attestorChainId === null ? "(could not be read)" : String(attestorChainId);
    console.error("");
    console.error("################################################################");
    console.error("#  DOMAIN MISMATCH — BROADCAST IS REFUSED                      #");
    console.error("################################################################");
    console.error("");
    console.error(`  deploy chain (this script)     ${SIGNING_CHAIN_ID}  (${SIGNING_CHAIN_NAME})`);
    console.error(`  attestor EIP-712 domain        ${seen}`);
    console.error(`  read from                      ${ATTESTOR_SOURCE}`);
    console.error("");
    if (attestorChainId === null) {
      console.error("  The chain-id constant could not be found in that file. This script will");
      console.error("  not guess. If the constant was renamed, teach `attestorDomainChainId`");
      console.error("  the new name; if the file moved, fix the path. Failing closed here is");
      console.error("  deliberate — an unreadable domain is not a matching domain.");
    } else {
      console.error("  DuelEscrow builds DOMAIN_SEPARATOR from block.chainid at construction");
      console.error("  in DuelEscrow.sol's constructor). An escrow constructed here would");
      console.error("  separate over");
      console.error(`  ${SIGNING_CHAIN_ID}, while the attestor signs verdicts over ${seen}.`);
      console.error("  `settle` would recover a stranger from EVERY verdict and revert on the");
      console.error("  attestor check — for every duel, forever — discovered only after both");
      console.error("  stakes are locked, with the six-hour refund as the only way out.");
      console.error("");
      console.error("  This is finding 5-1 of docs/reviews/escrow-adversarial-review.md landing");
      console.error("  exactly as written, now pointing the other way: it was written when the");
      console.error("  attestor and the deploy target both said 8453 and agreed.");
      console.error("");
      console.error("  THE FIX (one line, owner-routed, NOT made by this script):");
      console.error(`    src/server/attest.ts   export const SIGNING_CHAIN_ID = ${seen};`);
      console.error(`                    ->     export const SIGNING_CHAIN_ID = ${SIGNING_CHAIN_ID};`);
      console.error(`    test/attest.test.ts    expect(SIGNING_CHAIN_ID).toBe(${seen});`);
      console.error(`                    ->     expect(SIGNING_CHAIN_ID).toBe(${SIGNING_CHAIN_ID});`);
      console.error("    src/server/seats.ts    its own SIGNING_CHAIN_ID — a third,");
      console.error("                           deliberately un-imported copy of the same");
      console.error("                           number, for the seat-reading provider.");
      console.error("");
      console.error("    Grep the symbol; these are deliberately not cited by line. All three");
      console.error("    constants moved line during the Sepolia retarget, and a banner that");
      console.error("    sends an operator to the wrong line at 3am is the same defect as one");
      console.error("    naming a symbol the file no longer has. SIGNING_CHAIN_ID is unique");
      console.error("    across the repo and greppable; a line number goes stale in silence.");
      console.error("");
      console.error("    A wrong value in seats.ts fails reads closed rather than mis-signing,");
      console.error("    but it would refuse every seat read against this escrow. All three");
      console.error("    moved together for the retarget and have to move together again.");
      console.error("    That constant is money-critical and lives with its test, so it is");
      console.error("    changed there and reviewed there, not from a deploy script.");
    }
    console.error("");
    console.error("  Nothing is deployed today (THETADUEL_ESCROW is unset), so refusing costs");
    console.error("  nothing. Shipping an escrow no verdict can settle costs everything.");
    console.error("");

    // Refused at the broadcast gate rather than at the top of the script:
    // preflight sends no transaction and spends nothing, so it stays useful —
    // the operator can still read the constructor arguments and the BaseScan
    // inputs back while the fix is being routed. Only the irreversible half is
    // blocked, and it is blocked with an exit, not a prompt. No flag lifts it.
    if (broadcast) {
      console.error("REFUSING TO BROADCAST. Fix the attestor domain first.");
      process.exit(1);
    }
  }

  const wallet = new Wallet(deployerKey, provider);
  const balance = await provider.getBalance(wallet.address);

  const encodedArgs = AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [usdc, attestor, treasury],
  );

  console.log("");
  console.log(`contract        ${CONTRACT_NAME}  (${SOURCE_NAME})`);
  console.log(`chain           ${network.name} (chainId ${network.chainId}) — ${SIGNING_CHAIN_NAME}`);
  console.log(`deployer        ${wallet.address}`);
  console.log(`balance         ${formatEther(balance)} ETH  (testnet ETH, no value)`);
  console.log("");
  console.log("constructor arguments (IMMUTABLE FOREVER — check every one):");
  // `usdc` and the chain are already proven above; these two are not, and no
  // check can prove them. Read them back against your notes and against
  // BaseScan before broadcasting — a typo here is a redeploy at best.
  console.log(`  usdc          ${usdc}  (Circle TEST USDC, verified)`);
  console.log(`  attestor      ${attestor}  <-- CONFIRM ON BASESCAN`);
  console.log(`  treasury      ${treasury}  <-- CONFIRM ON BASESCAN`);
  console.log("");

  if (balance === 0n) {
    console.warn("WARNING: deployer balance is 0 — the deployment will fail.");
    console.warn("  Base Sepolia ETH is free: https://www.alchemy.com/faucets/base-sepolia");
    console.warn("  or the Coinbase Developer Platform faucet. There is nothing to buy.");
  }

  // -- 4. verification inputs (printed either way) -------------------------
  // Unchanged by the move to Sepolia, and that is a fact worth stating rather
  // than leaving to inference: Base Sepolia is the same OP-stack node software
  // as Base mainnet at the same hardfork, so the same solc, the same optimizer
  // settings and the same `cancun` EVM target apply. sepolia.basescan.org is
  // the same Etherscan verifier, and it wants the same seven fields.
  const metadata = JSON.parse(fresh.metadata) as { settings?: { evmVersion?: string } };
  console.log("BaseScan (Sepolia) verification inputs (Verify & Publish -> Solidity, Single file):");
  console.log(`  Compiler Type       Solidity (Single file)`);
  console.log(`  Compiler Version    ${fresh.solcLongVersion}`);
  console.log(`  Open Source License MIT`);
  console.log(`  Optimization        Yes`);
  console.log(`  Runs                ${OPTIMIZER_RUNS}`);
  console.log(`  EVM Version         ${metadata.settings?.evmVersion ?? "(compiler default)"}`);
  console.log(`  Source file         contracts/${SOURCE_NAME} (paste verbatim, no imports to flatten)`);
  console.log(`  Constructor args    ${encodedArgs.slice(2)}`);
  console.log("    (BaseScan wants the ABI-encoded args WITHOUT the leading 0x — that is the line above.)");
  console.log("");

  if (!domainAgrees) {
    // Reached only on a preflight; `--broadcast` already exited above. Say the
    // refusal again at the bottom, because the banner has scrolled by now and
    // "PREFLIGHT ONLY — re-run with --broadcast" would be a straight lie.
    console.log("PREFLIGHT ONLY — nothing was broadcast, and --broadcast is currently REFUSED:");
    console.log("the attestor's EIP-712 domain does not name this chain. See the DOMAIN");
    console.log("MISMATCH block above for the exact one-line fix, and route it to the owner.");
    return;
  }

  if (!broadcast) {
    console.log("PREFLIGHT ONLY — nothing was broadcast. Re-run with --broadcast to deploy.");
    return;
  }

  // -- 5. deploy -----------------------------------------------------------
  const factory = new ContractFactory(fresh.abi, fresh.bytecode, wallet);
  const contract = await factory.deploy(usdc, attestor, treasury);
  const tx = contract.deploymentTransaction();
  console.log(`broadcast       ${tx?.hash ?? "(unknown)"}`);
  console.log("waiting for confirmation...");
  await contract.waitForDeployment();
  const deployed = await contract.getAddress();

  console.log("");
  console.log(`DEPLOYED        ${deployed}`);
  console.log(`tx              ${tx?.hash ?? "(unknown)"}`);
  console.log(`explorer        ${EXPLORER}/address/${deployed}#code`);
  console.log("");
  console.log(`Set THETADUEL_ESCROW=${deployed} in .env — it is a ${SIGNING_CHAIN_NAME} address,`);
  console.log("and RPC_URL must stay pointed at the same chain or seat reads fail closed.");
  console.log(`Then verify the source at ${EXPLORER} using the inputs printed above.`);
  console.log("Source verification is a release gate.");
}

if (import.meta.main) {
  await main();
}
