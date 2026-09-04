# HANDOFF — THETADUEL session continuity

> For a fresh Claude session/account picking this project up. Read this, then
> `plan6-real-parlay.md` (repo root — the CURRENT plan), then
> docs/plans/BUILD-ORDER.md (the shipped game) and docs/plans/plan5-thetanuts.md
> (the Thetanuts integration plan 6 builds on). Updated at every wave gate.

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

## State at last update (2026-09-05 — plan 6's engine has landed, its UI has not)

> Written for a FRESH SESSION picking this up cold. Everything under "Older
> gates" is history. Protocol unchanged: the MAIN session orchestrates, briefs,
> gates and commits; Opus 5 subagents build; parallel ONLY on disjoint file
> sets; every wave `bunx tsc --noEmit` clean + full `bun test` green + one
> commit + push.

### Where the branch is

- Work moved to branch **`new`** (not `zq` — `zq` is merged in, `new` carries
  everything). HEAD is now **`7229f2e`**, pushed — `git log origin/new..HEAD`
  is empty, everything below is on `origin/new`. Plan 6's five phases each
  landed as their own commit: `89bbd7f` A, `c4d52df` B, `a5fed99` C, `185d646`
  D, `316d969` E, `067d4ee` the §7 asset gate. Then, after the audit doc landed
  (`c5fb304`, see below), four more commits shipped:
  - `199fd85` — the duel score was dividing ETH-denominated marks by USDC
    premiums: wrong by ~2,375× on ETH and ~81,000× on BTC, and *differently*
    wrong per player. Fixed by converting to USD at both edges, with branded
    unit types. A third defect was found in passing: `bid`/`ask`/`mid` are
    USDC on the same row as an ETH-denominated `mark`.
  - `4876630` — plan 7 box/condor logic: `deriveLadders` is the only book
    reader, snapping is irregular by construction, and for a long call condor
    **the wing width IS the maximum payout**.
  - `d3e64d8` — plan 6 phase E card faces: driven from `CARD_CONTRACT`, max
    loss now the same 17px as the payout (it was 9.5px under a 22px
    multiplier). IV and theta print an em dash because the data does not
    reach the card.
  - `7229f2e` — plan 7 price history from Chainlink on Base, the same feed
    that settles the option; `AnswerUpdated` logs at 9 RPC calls for 33h of
    history versus a rate-limited round walk.
  - (`c5fb304` itself: the plan 6 §9 audit — `docs/plan6-audit.md` — plus the
    RFQ underlying union widened to the SDK's own eight assets.)
- **`plan 7` is a new, separate plan layered on top of plan 6** (box/condor
  logic + Chainlink price history so far; untracked `plan7-box-builder-arena
  (1).md` at repo root is its spec). **`docs/plan6-audit.md` does not cover
  any of it** — treat plan 7 as unaudited until someone runs the same
  file:line exercise over it.
- **The tree is dirty again, right now, on top of all of that** — six agents
  were in flight when this was written. See "IN FLIGHT at handoff time" below
  for who owns which files before you touch any of them.

### Open items — what did not pass

Primary source: **`docs/plan6-audit.md`**, audited 2026-09-05, scoreboard
**PASS 12 · PARTIAL 5 · FAIL 1 · OWNER-ONLY 2**. Re-run the greps yourself
before trusting a row — this is a summary, not a substitute.

**One root cause explains the single FAIL and four of the five PARTIALs**:
`cardsForSlice`, `multipleAt` (`src/engine/parlay.ts`), `spinSlice`
(`src/engine/spin.ts`) and `qualifiedAssets`/`qualifiedUnderlyings`
(`src/data/qualify.ts`) are built, pure, and unit-tested — and had **zero
production call sites** at audit time. Wiring them in was in progress at
handoff time (see "IN FLIGHT" below) — do not assume it landed without
re-checking.

- **#2 — FAIL. No rendered multiplier traces to a live ask or
  `calculatePayout`.** `multipleAt` (`parlay.ts:600`) is the only caller of
  `calculatePayout`, and nothing outside its own module calls *it*.
  `ParlayPick.tsx:404` instead prints `quote.multiplier` from
  `desk/optionize.ts:277 multiplierFor` (a hand-rolled clamped ratio) or
  `tierOdds(tier)`. Closes by driving `ParlayPick`'s cards off
  `cardsForSlice`/`multipleAt` instead of `optionize.quoteFor`.
- **#8 — PARTIAL. No UI ever renders a dead slot.** The engine does it right —
  `cardsForSlice` returns `null` per unqualified slot (`parlay.ts:556`),
  `test/parlay.test.ts:449` pins seven dead slots — but `ParlayPick.tsx` still
  deals all eight seeded `PARLAY_CARDS` unconditionally. Same fix as #2.
- **#14 — PARTIAL, one of two fixed.** `src/desk/rfq.ts:256`'s hardcoded
  `"ETH"|"BTC"` union was widened to the SDK's real eight-member
  `RFQUnderlying` this session (`test/rfq.test.ts`, 60 pass).
  **`src/server/thetanuts.ts:345`** (`getPricingArray`'s dependency signature)
  still has the narrow union — outside this audit's file grant, reported not
  edited.
- **#15 — PARTIAL, "passes as a module, unwired in the app".**
  `qualifiedUnderlyings` (`data/qualify.ts:526`) is pure and fixture-tested,
  but the only three `data/qualify` imports under `src/` (`sectors.ts:3`,
  `ui/LobbyCards.tsx:5`, `views/CreateLobby.tsx:11`) are all `import type`.
  `CreateLobby` accepts `live?: readonly QualifiedAsset[]` and
  `src/App.tsx:440-457` never passes it, so it's always `[]`. Closes by
  passing `qualifiedAssets()` into `CreateLobby` from `App.tsx:440`.
- **#17 — PARTIAL.** The committed live run in `docs/asset-gate.md` is a
  failure notice (`BOOK UNREACHABLE`, exit 1, 17:10Z) — a transient local TLS
  problem, not a real outage (see below). A same-day re-run at 17:53Z passed
  (exit 0, 6 qualified) but was never committed as a replacement table.
  **Re-run and commit a fresh live table before the room.**
- **#18 — PARTIAL, follows from #15.** `sectors.ts:241 NO_BOOK_REASON` +
  `CreateLobby.tsx:486-488` do grey a sector with a reason — but since `live`
  is never passed, **every** sector greys, always, carrying no information.
  Same fix as #15.
- **#19 — PARTIAL, follows from #15.** DEEP/THIN defaults to `THIN` for every
  symbol (`CreateLobby.tsx:287-292`, empty grades map). The slice reveal has
  **no grade surface at all** — `spinSlice` has no caller.
- **#20/#21 — OWNER-ONLY, not done.** No Base fill has ever executed from
  this repo; no BaseScan link exists anywhere in it. #21 was additionally
  recorded as "blocked upstream by the book-endpoint 404" — **that block is
  stale**, the book was healthy again the same day (`docs/book-endpoint.md`);
  the only real blocker left is that nobody has funded a wallet and executed
  the fill.

#### Check when the app/chain is running again

What the owner means by "check soon when server is running" — these can only
be verified against a live app or a live chain:

- **Two end-to-end fills on Base**, under $2 each — one ETH/BTC, one
  non-ETH/BTC — with BaseScan links. Never done from this repo.
- **Deploy + BaseScan-verify `DuelEscrow.sol`** (compiled, adversarially
  reviewed SHIP-WITH-NOTES, never deployed).
- **Whether an MM ticker is still quoted minutes later**, so a duel can
  actually be scored end-to-end rather than only at the instant it was dealt.
- **Re-run `bun run scripts/probe-assets.ts` live, in front of an audience**,
  and commit the table if it passes — the one currently committed is the
  stale failure notice from #17 above.

#### Owner-only (no agent can close these)

- Fund the demo wallet (~$10 USDC + $2 ETH on Base) plus a second wallet for
  the two-seat escrow demo.
- An Alchemy/QuickNode Base RPC key → `RPC_URL`.
- Personally review, then deploy and BaseScan-verify `DuelEscrow.sol`.
- The two end-to-end fills themselves (#20/#21 above).
- Drop `src/assets/parlay-pick.mp3` (seam is live, silence until then).

### IN FLIGHT at handoff time

Six agents were running when this was written. Their work may be sitting
**uncommitted in the working tree right now** — check file ownership below
before editing any of these files, and before believing any status above that
touches them.

| Agent | Owns | What it's closing |
|---|---|---|
| **B2 equities removal** | `src/data/universe.ts`, `sectors.ts`, `lobbies.ts`, `src/views/CreateLobby.tsx`, `src/ui/LobbyCards.tsx`, `test/app.test.tsx`, `test/determinism.test.ts` | The owner's outstanding complaint: fictional equities (NVDA/TSLA/AAPL…) are still visible in the UI. Choosing between deleting them outright (retiring the pinned NVDA replay locks) or keeping them as a clearly-marked offline practice board. |
| **Gate wiring** | `src/data/market.ts`, `src/App.tsx`, `src/server/thetanuts.ts`, `test/market-route.test.ts` | Closing the audit's headline finding — the new engine modules had zero production call sites (items #2/#8/#15/#18/#19 above). |
| **BoxBuilder UI** (plan 7) | `src/views/BoxBuilder.tsx`, `test/boxbuilder.test.tsx` | Neither file exists in the tree yet as of this writing — this agent had not landed its first commit. |
| **Plan 7 §10 measurements** | read-only; writes `docs/plan7-measurements.md` (does not exist yet) | Gates plan 7 step 5 (the RFQ path) — plan 7 §8 says do not start step 5 before this is answered. |
| **IV threading** | `src/desk/optionize.ts`, `test/detail.test.ts` | Getting IV/theta data to the card face (see `d3e64d8` above — they currently print an em dash). |
| **You (this session)** | `docs/HANDOFF.md` | This document. |

`git status` at the moment this was written also showed `src/data/thetanuts.tsx`
modified and `.scratch/` untracked, both outside the six file sets above —
unclear which agent, if any, owns them; check before assuming either is safe
to touch.

**Recovery recipe if a session dies mid-flight:** uncommitted work sits in the
working tree, it does not vanish. Run `git status` and the full suite. If
green: review the diff against the relevant plan section and gate-commit it.
If red or partial: prefer reverting that file set and re-running the phase
with the plan section as the brief, rather than trying to finish someone
else's half-done edit blind.

### ⚠ The single most important thing to understand about plan 6

**The engine shipped ahead of the UI, and a green suite hides the gap.** Half the
UI has since caught up; half has not. These are all built, pure and thoroughly
unit-tested — the column that matters is the second one:

| Built and tested | Wired into the app? |
|---|---|
| `cardsForSlice` / `multipleAt` (`engine/parlay.ts`) | **NO.** Grep finds only comments. `ParlayPick.tsx` still deals eight seeded `PARLAY_CARDS` and prices them with `desk/optionize.ts`'s `quoteFor` |
| `spinSlice` (`engine/spin.ts`) | **NO.** No caller |
| `qualifiedUnderlyings` / `qualifiedAssets` (`data/qualify.ts`) | **NO.** The only `data/qualify` imports in `src/` are `import type`. `CreateLobby` takes `live?: QualifiedAsset[]`; `App.tsx:440` never passes it, so the list is always `[]` |
| `DetailToggle` + `useCardDetail` + `ParlayCardFace` | **YES**, landed mid-audit — `ParlayPick.tsx:42,44,169,281,426` |
| `duelScore` (`engine/score.ts`) | **YES** — `attest.ts:1773-1777` scores both players off one frozen snapshot |
| `runParlayFill` (`desk/fill.ts`) | **YES** — `views/Parlay.tsx:1377`, flag-gated |

Consequences worth stating plainly, because a §9 checkbox reads as done for each:
**the multiplier a player actually sees comes from `optionize.multiplierFor`** (a
hand-rolled clamped ratio) or from `tierOdds` — **not** from the protocol's
`calculatePayout`; **no screen ever renders a dead slot**, so a card always
exists, which §A4 calls the tell that the odds are house-set; and DEEP/THIN
defaults to `THIN` for every symbol because nothing measured. Two edits close all
of it — see "Next" below. Full item-by-item audit with a `file:line` per row:
**`docs/plan6-audit.md`**.

### The live book endpoint — RESOLVED, it was never actually down

- **Was reported as "404ing" / "moved". That claim was WRONG and is retracted.**
  `fetchOrders()` never requests `indexerApiUrl`; it issues a relative `get("/")`
  against the axios instance built on `apiBaseUrl`, a Cloudflare Worker origin
  that has been serving ~382 greeked orders throughout. `indexerApiUrl` is a path
  *prefix* every other SDK caller appends a subpath to, so requesting it bare
  404s by design and always did. A real transport failure (local TLS
  interception, since cleared) printed the wrong field in the probe's error
  banner; someone curled that URL, got the expected 404, and two unrelated facts
  fused into "the venue moved its book". Live probe re-run the same day: ETH
  $1.18M and BTC $1.41M depth (DEEP), SOL/XRP/BNB/AVAX qualified (THIN) — six
  underlyings, exit 0. **Do NOT ask the protocol team whether the book moved —
  it didn't**, and asking costs credibility with the people who wrote the
  service. Full teardown: `docs/book-endpoint.md`.

- **The committed `docs/asset-gate.md` failure table (17:10Z, exit 1,
  `BOOK UNREACHABLE`) is stale.** It captured the TLS-interception window below,
  not a real outage, and `/api/market`'s `stale` fallback at that moment was the
  designed degradation working correctly, not a bug. The identical gate passed
  live at 17:53Z the same day (exit 0, 6 qualified) — but that success run was
  never committed as a replacement table, so the only *table* on record in the
  repo is still the frozen `--fixture` one. **Re-run the probe yourself; don't
  trust either committed table's freshness.**
- A machine-local problem caused it: TLS interception here made the SDK's Node
  agent report `unable to get local issuer certificate`. Bun's own `fetch`
  (different CA store) reaches the host fine. This can recur — it is a property
  of this machine's network, not the protocol's — so run the probe from an
  un-intercepted network before any demo; if it fails again with that message,
  it's a proxy in the room, not Thetanuts.
- **The one thing still worth asking the protocol team** (low priority, per
  `docs/book-endpoint.md` §7): whether the Cloudflare Workers.dev origin the SDK
  resolves to (`round-snowflake-9c31.devops-118.workers.dev`) is stable
  production infra for a live demo, or whether there's a canonical hostname
  instead. If a URL genuinely needs repointing, the knob is `apiBaseUrl` (env
  `THETANUTS_API_BASE_URL`, see `docs/book-endpoint.md` §8) — **not**
  `indexerApiUrl`, which is the wrong field for the book.
- Meanwhile `bun run scripts/probe-assets.ts --fixture` demonstrates the identical
  gate over a frozen genuine capture, banner-marked so it can never be mistaken
  for a live table. That is the demo-safe path regardless of network state.

### A landmine that will bite the next session

`test/determinism.test.ts:139` scans engine source with a **raw text match and no
comment stripping**. A docblock that merely *names* `src/server/thetanuts.ts`
fails the build identically to an actual import. This audit lost time to exactly
that false positive on `src/engine/score.ts`, and it was worked around by
rewording the docblock rather than by fixing the scan — so it will recur. The
sibling scan at `test/detail.test.ts:412` has a comment stripper; give this one
the same. **Before you go hunting for a dependency, check whether it is a
sentence.**

Related: `test/determinism.test.ts`'s pinned spin locks and `bookFor` expectations
have to be re-pinned every time §B3's universe retirement moves. They are locks
on a board that is deliberately changing; re-pin them, never delete them.

### Owner still owes — nothing below can be closed by an agent

- **Two end-to-end fills on Base**, under $2 each, one of them on a **non-ETH/BTC**
  underlying, with Basescan links in the README. **No fill has ever executed from
  this repo.** There is no Basescan link in any doc because there is nothing to
  link to. The second one is additionally blocked upstream by the 404 above.
- Personally review + deploy + BaseScan-verify `DuelEscrow.sol` (compiled,
  adversarially reviewed SHIP-WITH-NOTES, never deployed).
- Alchemy/QuickNode Base key → `RPC_URL`; fund the demo wallet (~$10 USDC + $2
  ETH on Base) plus a second wallet for the two-seat escrow demo.
- Ask Thetanuts for the current book endpoint (see above) and, optionally,
  referrer whitelisting + `WALLETCONNECT_PROJECT_ID`.
- Drop `src/assets/parlay-pick.mp3` (the hero-pick theme). Seam is live, silence
  until then.

### Next, in priority order

1. **Wire what is already built — two edits, five §9 rows.** Highest value per
   line in the repo, and both are plumbing over tested code:
   (a) pass `qualifiedAssets()` into `CreateLobby` from `src/App.tsx:440` — closes
   the asset gate, the greyed sector reason and the DEEP/THIN grade at once;
   (b) drive `ParlayPick`'s cards off `cardsForSlice` / `multipleAt` instead of
   `optionize.quoteFor` — puts `calculatePayout` behind the number a player reads
   and finally makes a dead slot reachable.
2. Chase the book endpoint (see above). Until then, demo on `--fixture`.
3. Give the determinism boundary scan a comment stripper.
4. `docs/plan6-audit.md` lists every §9 item with its evidence — work the FAIL
   and PARTIAL rows from there rather than re-deriving them.

### Operational facts a fresh session cannot see

- Dev server: `bun run dev` → :3000, in the orchestrator's background. It dies
  with the session; restart it.
- Machine sleep is DISABLED (`powercfg` standby-timeout 0/0). Restore to 5/3
  when the owner says done.
- ⚙ **UI builders must see their own work.** Headless Chrome is installed;
  `--screenshot` needs an ABSOLUTE WINDOWS path (a relative one dies with
  "Access is denied") and `--virtual-time-budget` lets animations settle:
  `"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new
  --disable-gpu --hide-scrollbars --virtual-time-budget=2500
  --screenshot="C:\...\out.png" --window-size=700,560 "file:///C:\...\harness.html"`
  The builder then READS the PNG and looks at it. Every UI wave before this was
  built blind, which is why the card ornament and the wallet sticker each needed
  2–4 owner rejections. Brief every UI builder with it, and tell them not to
  report done on anything they have not looked at.
- ⚙ Owner's standing rule: **an extra task given mid-work gets its own parallel
  agent immediately**, never queued. Only file-set disjointness constrains it; if
  it collides with a running builder's files, send it to THAT builder via
  SendMessage instead.
- ⚠ A model switch mid-wave KILLS in-process subagents silently. Check
  `git status` before trusting any report that arrived around one.
- ⚠ Do NOT diagnose a `test/secrets.test.ts` bundle-scan failure without checking
  WHICH bundle — `bun build` used not to clean `dist/`, and a past session blamed
  vendor code for an already-fixed leak.

### ✅ Plans 6 and 7 are built, and the triple-check has run

**HEAD 28c8551 · 1577 pass / 0 fail · typecheck clean · pushed to origin/new.**

All three passes done (protocol below, kept for the next time):
- **Pass 1** — typecheck clean, full suite green, fresh build, and the secrets
  scan verified non-vacuous ("1 bundle file, all built by this run").
- **Pass 2** — `docs/plan7-audit.md` (first ever audit of plan 7): 23 PASS /
  4 PARTIAL / 0 FAIL / 2 owner-only, since narrowed to **1 PARTIAL + the 2
  owner-only**. `docs/plan6-audit.md` re-verified: **19 PASS / 0 PARTIAL /
  0 FAIL / 2 owner-only**.
- **Pass 3** — `docs/reality-check.md`: 17 surfaces in a real browser at
  1280/1600/1920. Zero console errors, no NaN/undefined/0.0000 anywhere, no
  overflow. Every defect it found was **truthfulness, not breakage** — and all
  of them are now fixed.

**What pass 3 caught that nothing else could**, all fixed: `index.ts` never
emitted the `options` flag, so the parlay screen — the surface a demo walks —
fell back to seeded in every configuration under a home page promising live
pricing; live news reached 1 match in 20 because the allowlist still came from
the retired equity fixture; `/ranks` wore a pulsing LIVE chip over an entirely
seeded ladder; `/desk` called an axis fraction a probability and printed one of
two breakevens.

**Money bugs found and fixed this session** (none had ever executed, so nothing
was lost — but each would have on the first real fill):
1. `isBuyer` inverted — `askEntry` pointed at the maker's BID, so a fill would
   have made the player the writer. Settled by measuring 142 live orders.
2. The duel score divided ETH-denominated marks by USDC premiums — wrong by
   ~2,375x on ETH, ~81,000x on BTC, and differently per player.
3. `CONTRACT_DECIMALS` 18 where the venue answers 6 — `duelScore` multiplied by
   it, so a real 0.25-contract leg contributed 2.5e-13 of its PnL.
4. `reservePrice` was never sent, so every RFQ would have gone out at 0n —
   accepting any price a maker offered.
5. A `Level` keyed on the signature deadline merged three different contracts
   into one row, publishing a mid between two different options.
6. The arena promised "DuelEscrow's six-hour refund returns both stakes" for a
   contract that is not deployed and stakes nobody took.

**What is left, and it is all yours** — no agent can close these:
- One real RANGER filled off the book, under $2, BaseScan link in the README.
- One real CALL_CONDOR via RFQ, same evidence. The measurements say makers
  answer 84.2% of requests with a median first offer of 6s, but nothing has
  been sent from this repo.
- Deploy + verify `DuelEscrow` after your own read of it. Until then the arena
  correctly says stakes are notional.
- `RPC_URL` (a private Base endpoint) and a funded wallet.
- The one remaining plan 7 PARTIAL is README copy (§"Live arena" still lists
  the two deleted modes).

### The triple-check, owed once plan 6 and plan 7 are both built

The owner asked for the whole project to be checked three times over
after both plans land. Three DIFFERENT passes, not the same pass run
three times — a repeated pass mostly re-confirms its own blind spot.

**Pass 1 — does it agree with itself?**
`bunx tsc --noEmit` clean and the FULL `bun test` green in one run on a
quiet tree (no agents writing). Then `bun run build` and confirm
`test/secrets.test.ts` scans a bundle it made this run — that gate was
silently scanning stale build output for weeks, so "green" there means
nothing unless the bundle is fresh.

**Pass 2 — does it agree with the plans?**
Re-run the §9 checklists of BOTH plans against the code, not against
commit messages. `docs/plan6-audit.md` is the template and the precedent:
it found 12 PASS / 5 PARTIAL / 1 FAIL where the commits implied done, and
the single root cause was four engine modules with zero call sites. Plan 7
has never been audited at all. **Do not accept a commit message as
evidence** — grep the tree.

**Pass 3 — does it agree with reality?**
The parts no test can reach: `bun run scripts/probe-assets.ts` against the
live book; the app open in a browser at several viewport widths with
screenshots read, not just captured; and the owner-only chain items
(the two Base fills, the escrow deploy and BaseScan verification). Every
"only a live X can confirm" line the builders recorded belongs here —
they are collected in the per-agent reports and in the audit.

**Standing rules while this runs:** commit and push each landed piece
rather than batching; keep the fleet full on disjoint file sets; Sonnet
for mechanical work, Opus for anything whose failure mode is *wrong*
rather than merely *incomplete*.

## Older gates (history)

### Post-P6 gate (branch `zq`, HEAD 281f843) — superseded by plan 6 on `new`

> Kept because the P0–P6 phase notes below are still the best account of how the
> Thetanuts layer got built. Its claim that "README's live table is current" is
> **no longer true** — plan 6 rewrote what the product is, and the README's
> Thetanuts section was rewritten with it on 2026-09-05.

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

### Earlier gates

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

- **`plan6-real-parlay.md`** (repo root) — the CURRENT plan. §9 is its
  Definition of Done; §10 is what to say in the room.
- **`docs/plan6-audit.md`** — every §9 checkbox against the actual tree, with
  evidence. Read it before you believe a checkbox.
- **`docs/asset-gate.md`** — the committed probe output, the four gate
  conditions, and the book-endpoint 404 write-up.
- docs/plans/plan5-thetanuts.md — the integration plan plan 6 builds on
  (phases, fit/won't-fit, security, do-not-touch pins).
- tnuts-test/FINDINGS.md — SDK ground truth incl. the "0.3.0 delta" section
  (RANGER supported; isRanger discriminator trap; ensureAllowance null=SUCCESS;
  previewFillOrder SYNCHRONOUS 10 fields; referrer split 0 bps un-whitelisted).
- docs/plans/BUILD-ORDER.md + plan1..4 — the shipped game's architecture.
- README.md — rewritten 2026-09-05 for plan 6. Its "Thetanuts — what is actually
  live" section now carries an explicit **"Not true yet"** block; keep that block
  honest, it is the thing a reviewer will check first.

## Hard invariants (breaking these = broken replays or burned money)

- test/determinism.test.ts: LIVE_NEWS_RE + LIVE_MARKET_RE + ASSET_GATE_RE source
  scans; the price locks; the engineFiles floor; spin deal locks. **Plan 6 moved
  the market seam, it did not open it** — market data is an injected argument to
  `spinSlice` / `cardsForSlice`, never an import. Engine modules also may not
  import `data/qualify`: a reel that computes its own universe is one refactor
  from a reel that computes its own prices.
- One quantity, one term. `test/detail.test.ts` greps the card surfaces for
  "moneyness" and a spelled-out "implied volatility" and fails on either.
  Max loss is not a detail level — it is on the face at SIMPLE and never leaves,
  above the upside figure.
- The odds are not the house's: `TIERS` is deleted and must not return. A tier is
  a `|delta|` band (`TIER_BANDS`) and its price is `1 / probability`. A card with
  no qualifying quote is **not dealt** — that dead slot is a feature, and a card
  that always exists is the tell that the odds are set.
- Pinned UI numbers: ×47.52, the /desk headings "Combined payoff at expiry" +
  "MM pricing", OPP_READY_MS/TAPE_STEP imports, stakePointsFor ×1000. (The
  "universe.ts all 18 rows" pin is being retired with the universe — §B3.)
- Money rules: features stake/trade are opt-IN env flags; approve exact
  amounts never MaxUint256; the `$2` `MAX_FILL_USDC` cap is checked against each
  leg **and** the slip sum; server never signs a client-supplied winner;
  ATTESTOR/DEPLOYER keys never under src/ or in any Response; secrets test
  scans dist/.

## Owner still owes (can't be done by agents)

See **"Owner still owes"** in the current state block at the top — it is the
live list. Summarised: two end-to-end Base fills (one on a non-ETH/BTC
underlying) with Basescan links, deploy + verify `DuelEscrow`, an RPC key, funded
wallets, and the book-endpoint question for the protocol team.

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
