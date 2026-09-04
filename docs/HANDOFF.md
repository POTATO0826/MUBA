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

## State at last update (post-P6 gate — every plan phase but P7 is shipped)

> Written for a FRESH ACCOUNT picking this up cold after a rate-limit switch.
> Everything below "Older gates" is history; this block + "NEXT" + "Owner
> still owes" is what you act on. Protocol: the MAIN session
> orchestrates/briefs/gates/commits, Opus 5 subagents build, parallel ONLY
> on disjoint file sets, every wave `bunx tsc --noEmit` clean + full
> `bun test` green + commit on `zq` + push. (This session ran as Fable 5,
> then continued as Opus 5 after a model switch — the switch KILLED every
> in-process subagent silently, so if you switch models mid-wave, assume
> your builders are gone and check `git status` before trusting a report.)

- HEAD at this update: 281f843. Full suite **791 pass / 0 fail, 24 files**,
  typecheck clean, working tree clean apart from the untracked reference
  assets named below.
- ALL Thetanuts SDK phases are now SHIPPED: P0 guard, P1 live book,
  P2 /desk live, P3 real fillOrder (THETADUEL_TRADE=on opt-in, $2 cap,
  $0.01 ladder, flag-off byte-identical — proven in test/fill.test.ts),
  P4 spot annotations + book-delta advisory (src/data/spot.ts), P5a escrow
  (NOT deployed), P5b attest referee with EIP-191-signed locks.
  README's "Thetanuts — what is actually live" table is current.
- ⚙ **UI BUILDERS CAN NOW SEE THEIR OWN WORK — always give them this.**
  Headless Chrome is installed; `--screenshot` needs an ABSOLUTE WINDOWS
  path (a relative one dies with "Access is denied"), and
  `--virtual-time-budget` lets animations settle so a mid-animation frame
  is captured:
  `"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new
  --disable-gpu --hide-scrollbars --virtual-time-budget=2500
  --screenshot="C:\...\scratchpad\out.png" --window-size=700,560
  "file:///C:\...\scratchpad\harness.html"`
  The builder then READS the PNG and looks at it. Every UI wave before this
  was built blind, which is why the card ornament and the wallet sticker
  each needed 2-4 owner rejections. Brief every future UI builder with it,
  and tell them not to report done on anything they have not looked at.
  A screenshot of the live app works too (dev server on :3000).
- ⚙ Owner's standing workflow rule: **an extra task given mid-work gets its
  own parallel agent immediately** — never queued behind the current one.
  Only file-set disjointness constrains it; if it collides with a running
  builder's files, send it to THAT builder via SendMessage instead.
- ALL FIVE of the last wave's builders LANDED and are pushed (see below).
  NOTHING is in flight as of this update — the tree is clean and green.
- SHIPPED this wave (791 pass / 0 fail, 24 files, typecheck clean):
  * da3307e ChromeRally — the card ornament REBUILT after the owner
    rejected v1 as "way off". Slender bars (11u on a 34u pitch), bodies 5%
    above black, hairline rim, specular running ALONG the bar, ice-blue
    light with the card accent only in a faint pool. TWO objects now:
    crypto = candle rally, stocks = "the tape" (chrome line chart), MIXED
    picks by hash. ChromeCandles.tsx is DELETED; component is
    src/components/ChromeRally.tsx.
  * 460b3a8 Wallet single cat — per-row stickers deleted; ONE 124px cat
    tile at the dialog's top-right, arriving once on open; hovering a row
    only RETINTS cat+tile+ring+sparkles to that wallet's brand (220ms)
    alongside the row's 22% brand wash. No hover = warm cream #d8d0bd
    (grey read as a disabled cat). The × moved TOP-LEFT and the title
    dropped to the header band's foot — that is deliberate, it gives the
    × a 169px moat so the cat can never block it again.
  * 2236e08 On-chain seat binding — X-1's last residual CLOSED. With an
    escrow configured, a lock's claimed seats must match the chain's
    `duels` getter, compared ORDERED (a set compare would bless the
    exploit). RPC failure fails closed. Escrow unconfigured = today's
    signature-only path, byte-identical and asserted.
  * 25fe9c1 P6 staking UI — src/desk/escrow.ts + src/state/stake.ts, the
    6-state machine, 17 typed codes all landing in PTS-only fallback,
    ledger settles first and unconditionally, CLAIM panel with the
    "claim within 6 hours" warning (review finding 4-1), stake amount in
    CreateLobby (min $0.10, >$20 warning). Gated on features.stake AND a
    configured escrow AND a non-mock wallet. The 1100ms OPP_READY_MS
    timer is untouched for PTS-only play (one boolean removes it only
    when real seats are watched). The lock is posted ONLY by the on-chain
    opener, ONLY after join lands, ordered opener→a joiner→b.
  * 281f843 test/secrets.test.ts hardened — it had been scanning the
    UNION OF ALL BUILD HISTORY: `bun build` never cleaned dist/ and its
    chunk hash is not content-stable, so every build since P0 left another
    6.5MB bundle behind. Now the build script clears dist/ and the suite
    wipes+rebuilds unconditionally, with 18 controls (11 planting real
    secret shapes) through one exported `scanBundle`. ⚠ Do NOT diagnose a
    bundle-scan failure without checking WHICH bundle — this session got
    that wrong and blamed vendor code for an already-fixed leak.
- Owner asks pending: drop the Dota 2 hero-pick theme at
  src/assets/parlay-pick.mp3 (seam is live, silence until then). The owner
  has NOT yet eyeballed the single-cat wallet or the reworked card
  ornament in a browser — expect feedback on both; their pattern is short
  visual critiques ("way off", "too empty", "no colour changes"), so read
  the commit history for what has already been rejected before changing
  either.
- NEXT, in priority order:
  1. **P7 truth pass** — the last plan phase. README's "what is actually
     live" table exists and is current; still owed is the consistent
     LIVE / SEEDED / STALE / PARTIAL chip vocabulary sweep across views.
  2. Whatever the owner asks for after seeing the two UI reworks.
  3. Optional hardening surfaced by the wave: mint a per-room nonce into
     `matchKey` (review 6-1; `parseMatchKey` already accepts a third
     segment, nothing mints one yet — it lives wherever a room is minted,
     src/state/match.ts).
- ⚠ NOTHING on chain is verified. The escrow is compiled, adversarially
  reviewed (SHIP WITH NOTES) and NOT deployed; P3's fill and P6's staking
  have never touched a chain. Everything up to the RPC boundary is tested
  against fakes. Deploy remains the owner's call after their own read.
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
