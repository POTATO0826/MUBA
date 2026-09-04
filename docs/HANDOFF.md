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

## State at last update (post-P2+P5b gate + UI wave + escrow review)

- Tests: 530 pass / 0 fail, 18 files. Typecheck clean repo-wide.
- SHIPPED (all pushed on zq; main has everything through 051889b):
  7 game waves (sound+CS:GO spin, live news terminal, sectors, BLITZ/QUICK/
  NORMAL modes, duel soundtrack, rank moment + copy-trade fiction, /ranks
  ladder) + room music + 4 EX.O button clips + case-open spin samples + hero
  cursor trail + ticker-only ordered wire + hansen's wallet layer + Thetanuts
  P0 (guard, SDK 0.3.0, .d.ts gate) + P1 live market layer + P5a DuelEscrow.sol
  compiled/tested, NOT deployed.
- SHIPPED this gate: P2 /desk fully live (mmPricing MM chain in the snapshot,
  live spot label · LIVE/· REFERENCE, $1 previewFillOrder quote line +
  numContracts 0n depth guard, payoff.ts moved src/engine→src/desk, engine
  floor now exactly 6) + P5b attest referee (src/server/attest.ts wired at
  /api/lock, /api/attest, /api/duel-status; test/attest.test.ts's digest test
  rebuilds the EIP-712 hash from the contract source) + owner UI wave (study
  wire sym filter; PlayerMark pixel-glyph identicons replace ALL initials
  avatars; Room seat dossiers off LeaderPlayer; parlay-pick music seam →
  owner drops src/assets/parlay-pick.mp3).
- ESCROW ADVERSARIAL REVIEW: DONE — verdict SHIP WITH NOTES, full report at
  docs/reviews/escrow-adversarial-review.md (371 executed assertions vs the
  committed bytecode; reentrancy/replay/rake/races/USDC/griefing all clean).
  Deploy still blocked on the owner's own read. Action items from it:
  X-1 (HIGH, server not contract): /api/lock is unauthenticated and takes
  a/b/picks from the body — MUST be fixed before THETADUEL_STAKE ever turns
  on (sign the lock as `a`, or read seats from chain events); 5-1 (MED):
  deploy.ts must hard-refuse non-canonical USDC + non-8453 chainid, not warn;
  6-1 (LOW): duelId preimage is guessable, add a per-room nonce; 4-1 (LOW):
  UI copy "claim within 6 hours" (refund can front-run a verdict past TIMEOUT).
- IN FLIGHT next wave: eToro-style dollar-denominated ranking rework (owner
  request: copy-trade stats header, $ not PTS in copy economics — fiction's
  own $, NEVER a PTS→$ rate; pinned ladder numbers stay byte-identical) ∥
  security hardening (X-1 lock auth + 5-1 deploy refusals + 6-1 nonce).
- NEXT per plan: P3 (real fillOrder, ~$0.01 target, $2 code cap,
  THETADUEL_TRADE=on) ∥ P4 (spotFor at the remaining hardcoded-spot sites +
  honesty chips) → P6 (staking UI; X-1 fix is a hard prerequisite) → P7
  (truth pass: README live table + residual-trust statement, still owed).

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
  has room-inspect.mp3 (Spectrum Guardian), parlay-pick.mp3 (hero-pick theme,
  the bed behind the parlay pick screen), exo-kill-1..4.mp3, case-tick.mp3 +
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
