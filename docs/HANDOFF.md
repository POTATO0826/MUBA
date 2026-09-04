# HANDOFF — THETADUEL session continuity

> For a fresh Claude session/account picking this project up. Read this, then
> docs/plans/BUILD-ORDER.md (the shipped game) and docs/plans/plan5-thetanuts.md
> (the approved, in-progress Thetanuts integration). Updated at every wave gate.

## Who / how

- Owner: zhanquan21@gmail.com ("zq"). Repo: POTATO0826/MUBA, working dir
  `c:\Users\zhan quan\OneDrive\New folder\mubahack`.
- Orchestration pattern the owner mandates: the MAIN session (Fable 5) plans,
  briefs, gates, commits; Opus 5 subagents build. Parallelize builders ONLY on
  fully disjoint file sets; hot files serial. Every wave: `bunx tsc --noEmit`
  clean + full `bun test` green + ONE commit on `zq` + push.
- Branch discipline: all work on `zq`. `main` was fast-forwarded to 051889b
  once at the owner's request; later promotion is the owner's call.
- Dev server: `bun run dev` → :3000 (background). Machine sleep is DISABLED
  (powercfg standby-timeout 0/0; restore to 5/3 when the owner says done).

## State at last update (post-P1+P5a gate, Thetanuts integration)

- Tests: 433 pass / 0 fail, 16 files. Typecheck clean. Last commit: c6ecf94.
- SHIPPED (all pushed on zq; main has everything through 051889b):
  7 game waves (sound+CS:GO spin, live news terminal, sectors, BLITZ/QUICK/
  NORMAL modes, duel soundtrack, rank moment + copy-trade fiction, /ranks
  ladder) + room music + 4 EX.O button clips + case-open spin samples + hero
  cursor trail + ticker-only ordered wire + hansen's wallet layer (EIP-6963 +
  AppKit + mock) + Thetanuts P0 (guard regex, SDK 0.3.0 installed, .d.ts gate,
  /api/config, secrets test).
- SHIPPED additionally: P1 live market layer (/api/market live-verified:
  OptionBook agreement true, greeksSeen 310/426, multi-collateral decimals
  fix) + P5a DuelEscrow.sol compiled/tested, NOT deployed.
- IN FLIGHT: the contract ADVERSARIAL REVIEW (read-only agent; deploy stays
  blocked until its verdict + the owner's own read), P2 (/desk fully live) and
  P5b (attest referee: /api/lock + /api/attest) as a parallel pair.
- NEXT per plan: gate+commit P1/P5a → P2 (/desk fully live) ∥ P5b
  (src/server/attest.ts: /api/lock + /api/attest referee) → contract
  adversarial review → P3 (real fillOrder, ~$0.01 target, $2 code cap,
  THETADUEL_TRADE=on) ∥ P4 (spotFor at the FIVE hardcoded-spot sites +
  honesty chips) → P6 (staking UI, PTS∥USDC parallel non-convertible) → P7.

## Ground truth documents (in-repo, read before building)

- docs/plans/plan5-thetanuts.md — the approved integration plan (phases,
  fit/won't-fit, security, do-not-touch pins).
- tnuts-test/FINDINGS.md — SDK ground truth incl. the "0.3.0 delta" section
  (RANGER supported; isRanger discriminator trap; ensureAllowance null=SUCCESS;
  previewFillOrder SYNCHRONOUS 10 fields; referrer split 0 bps un-whitelisted).
- docs/plans/BUILD-ORDER.md + plan1..4 — the shipped game's architecture.
- README.md — current and accurate for everything shipped.

## Hard invariants (breaking these = broken replays or burned money)

- test/determinism.test.ts: LIVE_NEWS_RE + LIVE_MARKET_RE source scans;
  4 absolute price locks (NVDA 118.4 series values); engineFiles >= 6 floor
  (exactly 6 after P2 moves payoff.ts — budget spent); spin deal locks.
- Pinned UI numbers: ×47.52, the /desk headings "Combined payoff at expiry" +
  "MM pricing", OPP_READY_MS/TAPE_STEP imports, universe.ts all 18 rows,
  stakePointsFor ×1000.
- Money rules: features stake/trade are opt-IN env flags; approve exact
  amounts never MaxUint256; server never signs a client-supplied winner;
  ATTESTOR/DEPLOYER keys never under src/ or in any Response; secrets test
  scans dist/.

## Owner still owes (can't be done by agents)

Alchemy/QuickNode Base key → RPC_URL; fund demo wallet (~$10 USDC + $2 ETH on
Base) + a second wallet for the two-seat escrow demo; personally review +
deploy + BaseScan-verify DuelEscrow; optional WALLETCONNECT_PROJECT_ID and
Thetanuts referrer whitelisting.

## Local-only artifacts a fresh clone will miss

- src/assets/*.mp3 are GITIGNORED on purpose (game-ripped audio): the owner
  has room-inspect.mp3 (Spectrum Guardian), exo-kill-1..4.mp3, case-tick.mp3 +
  case-land.mp3 (sliced from csgo-case-open.mp3 in repo root via
  src/assets/slice-case-open.sh). Missing files = silence, never errors.
- .env (gitignored): currently empty of secrets; .env.example lists the
  full inventory.
- The shareable status page: https://claude.ai/code/artifact/4ea6855f-98e4-40ad-bf36-c36a99edfe68

## If builders were mid-flight when the session died

Their uncommitted work is in the working tree. Run `git status` + the full
suite: if green, review the diff against the phase spec in plan5 and gate-
commit it; if red or partial, prefer reverting the unfinished file set and
re-running that phase's builder with the plan section as the brief.
