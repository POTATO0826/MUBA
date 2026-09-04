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

## State at last update (post-P3+P4 gate — the account-switch handoff)

> Written for a FRESH ACCOUNT picking this up cold after a rate-limit switch.
> Everything below "Older gates" is history; this block + "IN FLIGHT" +
> "Owner still owes" is what you act on. Protocol unchanged: Fable 5 MAIN
> session orchestrates/briefs/gates/commits, Opus 5 subagents build,
> parallel ONLY on disjoint file sets, every wave `bunx tsc --noEmit` clean
> + full `bun test` green + commit on `zq` + push.

- Last commits: 4e47663 (P3 real fillOrder + P4 hybrid spot anchoring),
  96a66d4 (chrome-candles card ornament v1). Targeted suites 278/0 at that
  gate; run the full suite yourself before your first commit.
- ALL Thetanuts SDK phases are now SHIPPED: P0 guard, P1 live book,
  P2 /desk live, P3 real fillOrder (THETADUEL_TRADE=on opt-in, $2 cap,
  $0.01 ladder, flag-off byte-identical — proven in test/fill.test.ts),
  P4 spot annotations + book-delta advisory (src/data/spot.ts), P5a escrow
  (NOT deployed), P5b attest referee with EIP-191-signed locks.
  README's "Thetanuts — what is actually live" table is current.
- IN FLIGHT at handoff time (two Opus builders; if they died mid-work, see
  the mid-flight section at the bottom — their briefs are summarized here):
  1) WALLET HOVER, ROUND 4 (CAT MASCOT) — src/ui/WalletPicker.tsx +
     src/styles.css + optionally new src/components/CatMascot.tsx ONLY.
     Already SHIPPED (6368c9d): sticker launch + brand colours (rdns map
     for 6 majors, canvas dominant-colour fallback, all failure→neutral).
     IN FLIGHT: the sticker's face becomes the owner's CAT mascot instead
     of the wallet icon — asset at repo root "Cat Icon.zip" (SVG inside:
     cream #f7f7f4 head paths + #050608 features; clean the metadata bloat,
     inline as JSX, tint cream→wallet brand); tile more pronounced (lighter
     surface, real shadow, bigger if the 28-check geometry harness in the
     builder's history allows — never under the ×, never clipped); the
     hovered ROW reads clearly brand-coloured (~18-25% mix, the reference's
     black→green CTA move — owner explicitly upgraded this from the subtle
     10% wash); optional one-time wink after launch. Owner steers to date:
     NOT an exact copy of the Daniluk reference — priorities are cat
     pop-up + wallet colour driving cat AND buttons, animated; lime
     accents rejected; sticker-under-× rejected; sticker-covering-chip
     ACCEPTED (the row carries the colour). Reference gifs:
     chrome-capture-2026-09-04.gif + " (1).gif" at repo root.
  2) CHROME-CANDLES REWORK — src/components/ChromeCandles.tsx +
     src/ui/LobbyCards.tsx ONLY (styles.css belongs to builder 1). v1
     (committed) was rejected by the owner: capsules too huge, sheens are
     flat milky bands, green-washed. Required material (from the owner's
     watch-clip frames, chrome-capture-2026-09-04.gif in repo root):
     ~85% darkness, hairline 1px rim speculars, narrow feathered traveling
     sheen, cold ice-blue light (#7dd3fc family) with card accent only in
     the faint ambient pool, slender 1-1.5px trend-line. THEN per-card
     THEMED objects (crypto = candle rally, stocks = a different chrome
     object) — owner's words: "custom theme related object for each,
     please don't make them identical; if not, focus on only 1 first."
- Owner asks pending beyond that: drop the Dota 2 hero-pick theme at
  src/assets/parlay-pick.mp3 (seam is live, silence until then); eyeball
  the wallet sticker covering the INSTALLED chip while hovered and the
  36px dialog header gap (accepted for now unless the owner objects).
- NEXT per plan after in-flight lands: P6 staking UI — HARD PREREQUISITE:
  on-chain seat binding (read a/b from DuelOpened/DuelJoined instead of the
  lock body; docs/reviews/escrow-adversarial-review.md X-1 residual +
  attest.ts docstring) — then P7 truth pass (README table exists; still
  owed: consistent LIVE/SEEDED/STALE/PARTIAL chip vocabulary sweep).
- Session facts a fresh account cannot see: dev server runs `bun run dev`
  on :3000 in the orchestrator's background (restart it — it dies with the
  session); a passive standby session "mubahack-15" may message you via
  cross-session pipe (it stood down; the tree is the active session's);
  the shareable status artifact URL is in "Local-only artifacts" below.

## Older gates (history)

- Tests at the P2+P5b gate: 530 pass / 0 fail, 18 files. Typecheck clean.
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
- SHIPPED next gate (572 pass / 0 fail, 19 files): security wave — X-1
  CLOSED (/api/lock requires seat a's EIP-191 sig over THETADUEL_LOCK_V1,
  layout documented in attest.ts; refused locks never burn first-write-wins),
  5-1 deploy.ts hard-refuses non-canonical USDC/chain, 6-1 nonce grammar live
  (clients don't mint it yet); residuals stated in attest.ts docstring —
  counterparty seat-claim (v2 = on-chain seat binding, REQUIRED before P6),
  EIP-1271 smart wallets fail closed. Plus: eToro dollar ranking (GAIN 12M,
  RISK 1-10, AUM, COPY-button fiction, all copy economics in the fiction's
  own $; rank.test.ts passed with ZERO edits) + wallet-row hover sticker
  (Daniluk transplant in WalletPicker.tsx) + spin landing keeps only the
  case-open clip (reveal arpeggio cut from MatchSpin, LAND_SAMPLE_GAIN 1.0).
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

- Repo-root reference assets for the in-flight UI work (untracked on
  purpose — same machine, so an account switch keeps them; a fresh CLONE
  loses them and must ask the owner): chrome-capture-2026-09-04.gif +
  " (1).gif" (the Daniluk hover reference) and "Cat Icon.zip" (the owner's
  mascot: SVG + PNG + Idle/Wink gifs).

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
