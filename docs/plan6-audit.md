# Plan 6 — Definition of Done, audited against the tree

`plan6-real-parlay.md` §9 is twenty checkboxes. This file is each one measured
against `src/` and `test/` on **2026-09-05**, branch `new`, HEAD `c4d52df`, with
four builders mid-flight (`git status` was dirty in `data/{universe,sectors,
lobbies}.ts`, `views/CreateLobby.tsx`, `engine/score.ts`, `server/attest.ts`,
`server/thetanuts.ts`, `types.ts`, `desk/fill.ts` and their tests).

**A commit message is not evidence.** Every verdict below is a grep, a
`file:line`, a test name or a live HTTP response. Where a plan commit claims
something the code does not do, that is said plainly — it is the most useful
sentence in the file.

> **The tree moved while this was being written**, which is what a live audit
> looks like. Rows 3, 5 and 7 were FAIL or PARTIAL at first pass and were closed
> by builders landing mid-audit; each says so, and each was re-verified against
> the tree at the end rather than taken on report. Re-run the greps before acting
> on a row — the method is the durable part, not the timestamp.

> ## Second pass — re-verified 2026-09-05, branch `new`, HEAD `56435c0`
>
> Eight commits landed between the first pass and this one (`fbef12b` through
> `56435c0`), several claiming to close rows this file had marked open. **Same
> rule as above, applied to those claims too**: nothing below is marked closed
> because a commit message says so. Every row was re-greped, re-read or re-run
> against the tree.
>
> **The tree moved a second time while this file was being rewritten**, same as
> the first pass, and it is recorded the same way rather than smoothed over.
> Two of the defects below (D2, D3) and one sub-item (19(b)) were verified
> against a *dirty working tree* — `git status` mid-pass showed
> `src/engine/parlay.ts`, `src/server/thetanuts.ts`, `src/state/match.ts`,
> `src/views/CreateLobby.tsx`, `src/views/ParlayPick.tsx`, `test/app.test.tsx`
> and `test/market-builder.test.ts` all modified, uncommitted — and were
> written up with an explicit "uncommitted, do not rely on this yet" caveat.
> By the time this file was finished, two commits had landed capturing exactly
> that working tree: `e91d177` ("the legs are priced by the book, not by the
> retired ratio" — match.ts + CreateLobby.tsx + parlay.ts + ParlayPick.tsx) and
> `56435c0` ("a 'level' was merging three different contracts into one row" —
> thetanuts.ts + test/market-builder.test.ts). The caveats below were updated
> to say so; nothing was re-verified against those two commits beyond
> confirming `git status` is clean and the commits contain the same diffs this
> pass already read line-for-line — which is a weaker claim than a fresh
> re-grep, and is stated as such.
>
> Test files actually run this pass, read-only: `market-builder` (111 pass),
> `determinism` (19 pass), `detail` (58 pass), `parlay`+`optionize`+`engine`
> (78 pass), `attest` (129 pass), `app.test.tsx` (85 pass), `qualify` (62
> pass) — all run against the pre-commit working tree, i.e. the same code the
> two commits above then captured verbatim. None were run to exhaustion of the
> whole suite, and `tsc` was not run at all — other agents were mid-edit on
> files this pass had to read, and a red full-suite run right then would have
> proven nothing about any single row.
>
> The live book was re-probed from this machine, live, during this pass: **still
> 404** on `/api/v1/book` and `/api/v1/orders`, **still 200** on `/api/state`.
> Nothing has changed on that front; see the outage section below, unedited.

## The one-paragraph summary

**First pass:** Plan 6's *engine* landed and is excellent: `TIERS` is genuinely
gone, the tier is genuinely a delta band, the gate is genuinely a pure
measurement, the fill genuinely caps the slip sum and shows its degradation
policy before you sign, and the attestor genuinely re-derives its own verdict
from one frozen snapshot. Plan 6's *UI* landed in half. The detail levels and
the card face are wired; the live card path and the asset gate are not.
`cardsForSlice`, `multipleAt`, `spinSlice` and `qualifiedAssets` had zero
production call sites, so several boxes that read as done were true of a unit
test and false of the running app. Two boxes could not be closed by any agent:
nobody has spent a cent on Base from this repo.

**Second pass:** the plumbing got built. `cardsForSlice`/`multipleAt` now have
two real callers (`src/views/ParlayPick.tsx` and `src/state/match.ts`),
`qualifiedAssets()` reaches `CreateLobby` and the slice reveal, and the one
FAIL in the table (item 2) closes. Twelve of the twenty-one rows are unchanged
because they were never broken. Of the nine that moved: **six close outright**
(2, 7 already closed, 8, 14, 15, 18), **one stays PARTIAL for a narrower reason
than before** (19 — two of its three surfaces closed, the third, the lobby
board's own grade tag, still has no caller anywhere in `src/`), and **the two
OWNER-ONLY rows are still owner-only**, because nobody has filled anything on
Base. Three defects nobody had found when the first pass was written turned up
and got fixed along the way — a wrong-side fill bug that was one real
transaction from making a player the writer, a market-level key that was
merging different option expiries into one row, and a lobby screen that
printed a measurement nobody made. All three are covered below; two of them
were caught mid-write against a dirty working tree and landed as commits
(`e91d177`, `56435c0`) before this file was finished, the same way rows 3, 5
and 7 closed mid-audit on the first pass.

## The table

| # | §9 item | Verdict (1st pass) | Now | Evidence |
|---|---|---|---|---|
| 1 | `TIERS` no longer exists anywhere in the tree | **PASS** | **PASS — unchanged** | `src/engine/parlay.ts` still exports `TIER_BANDS:67`, `tierOf:77`, `tierProb:95`, `tierOdds:108`, `TIER_MOVE:126` — no `TIERS`. `src/data/rewards.ts:25` is still the only `TIERS`, re-exported `RANK_TIERS` by `src/engine/rank.ts:21`. The doc-rot comment at `src/data/spot.ts:179-180` (`TIERS.SHARP.prob`, "pinned") is **still there** — nobody's file, still not fixed, still teaching a constant that doesn't exist. |
| 2 | Every rendered multiplier traces to a live `ask` or to `calculatePayout` | **FAIL** | **PASS — the FAIL closes** | `cardsForSlice`/`multipleAt` are no longer orphaned. `src/engine/parlay.ts:770 cardsForTicker` wraps both (`fullLadderSlice` → `cardsForSlice:621` → `multipleAt:718`, which calls `calculatePayout`), and it now has **two production callers**: `src/views/ParlayPick.tsx:284` (the grid) and `src/state/match.ts:503` (the legs that actually settle). The old clamped-ratio path — `src/desk/optionize.ts`'s `optionize()/quoteFor()/multiplierFor()` — has **zero callers left in `src/`**; `match.ts` no longer even imports the `optionize` value (only `type OptionBook`). Confirmed by running, not reading: `test/parlay.test.ts`+`test/optionize.test.ts`+`test/engine.test.ts` (78 pass), `test/attest.test.ts` (129 pass), `test/app.test.tsx` (85 pass). **Provenance note:** the `match.ts` half of this — the leg-pricing rewrite that makes the slip and the card agree — was verified against the *dirty working tree* (`optionize(leg, book)` replaced by a `cardsForTicker`/`slotFor`/`legFromLiveCard`-based `priced()`) before it was committed; it landed moments later as `e91d177` ("the legs are priced by the book, not by the retired ratio"), which its own message confirms also fixed a second bug in the same removal — `optionize` had been writing each leg's `prob` from the *nearest* listed delta rather than refusing one the strict band model would never deal, which fed the odds, ALL LAND, potentialPoints and the escrow stake off a probability that should not have existed. That second claim was not independently re-derived this pass; it is reported as the commit's own claim, not verified arithmetic. |
| 3 | Max loss on every card face, at every detail level, above the upside figure | **PASS** (closed mid-audit) | **PASS — unchanged** | `src/components/ParlayCardFace.tsx` still renders every face off `CARD_FACE_ORDER` (`src/state/detail.ts:127-133`, `maxLoss` before `payout`). `test/detail.test.ts` still 58 pass / 0 fail this pass (was 52 at first pass; more assertions, not fewer). |
| 4 | `MINNOW/FISH/SHARK/ORCA/WHALE` is the only rank ladder | **PASS** | **PASS — unchanged** | `src/data/rewards.ts:26-30`, still pinned by `test/rank.test.ts`. No second ladder anywhere in `src/`. |
| 5 | Detail level is a visible toggle, reversible in both directions, never locked | **PASS** (closed mid-audit) | **PASS — unchanged** | `src/views/ParlayPick.tsx` still imports `DetailToggle`/`useCardDetail` for real and mounts `<DetailToggle level onChange>` at `:387`. `test/detail.test.ts` still asserts all three levels on screen with the live one pressed. |
| 6 | A test greps the card components for "moneyness" / "implied volatility" | **PASS** | **PASS — unchanged** | `test/detail.test.ts:402 BANNED`, still a runtime glob over card surfaces with comment-stripping and non-vacuity guards. Note for context, not a violation: `fba0cee` (since first pass) decoded IV onto the card face as a *number* (`IV 58%`), which is exactly the boundary this test is designed to allow — the word is banned, the figure is not. |
| 7 | `test/determinism.test.ts` still passes, market data injected not imported | **PASS** (closed mid-audit) | **PASS — unchanged, re-run** | 19 pass / 0 fail this pass. `spinSlice(book, qualified, seed)` at `src/engine/spin.ts:294` unchanged; `ASSET_GATE_RE` at `test/determinism.test.ts:109` unchanged. **Finding 2 below (the no-comment-stripping false-positive risk) is still unfixed** — `test/determinism.test.ts:138-139` still does a raw `text.match(...)` with no comment stripper, unlike `test/detail.test.ts`'s scanner. |
| 8 | A card with no qualifying quote renders a dead slot, and a test asserts it | **PARTIAL** | **PASS — closes** | `ParlayPick.tsx:474-494` now branches: `const live = dealt ? (dealt[i] ?? null) : null; if (dealt && live === null) return <DeadSlot .../>`. `DeadSlot` (`:807-825`) renders `data-parlay-dead={sym:card.id}`, `aria-disabled`, "NOT DEALT". This is asserted against the **actual rendered component tree**, not just the engine: `test/detail.test.ts:952,1012,1041,1061` query `[data-parlay-dead]` directly. 58 pass / 0 fail. |
| 9 | `MAX_FILL_USDC` checked against the leg sum, with a test that steps over it | **PASS** | **PASS — unchanged, lines re-verified** | Same four checks, same lines: `src/desk/fill.ts:1481` (per leg, requested), `:1492` (requested sum), `:1633` (per leg, previewed), `:1642` (previewed total). `test/fill.test.ts:901`/`:885` unchanged. |
| 10 | No `MaxUint256` approval anywhere; a test asserts it is never passed | **PASS** | **PASS — unchanged, lines re-verified** | `fill.ts:942`, `:1704`; `escrow.ts:725`; `rfq.ts:1286` (was cited `~1290`, now precise) — all still comments forbidding it, no live occurrence. Assertions at `test/fill.test.ts:548,1160,1188`, `test/duel-stake.test.ts:297,306`, `test/rfq.test.ts:343` unchanged. |
| 11 | Partial-fill policy is on screen before the first signature | **PASS** | **PASS — unchanged, lines re-verified** | `fill.ts:1047 PARTIAL_FILL_POLICY`, carried on the quote at `:1202`/`:1663`. Rendered at `src/views/Parlay.tsx:1560` (`{slip.policy}`, sourced from the same constant) and again literally at `:1678`. |
| 12 | `duelScore` is pure and driven off a frozen fixture in tests | **PASS** | **PASS — unchanged (line shifted 340→343)** | `src/engine/score.ts:343` — still no clock, no network, one marks map for both players. `test/score.test.ts` unchanged. The score.ts typecheck-error caveat from the first pass was **not re-verified this pass** (`tsc` was intentionally not run — see the header note); treat it as unconfirmed either way rather than cleared. |
| 13 | The attestor derives the verdict from its own snapshot, never from client input | **PASS** | **PASS — unchanged, lines re-verified** | `src/server/attest.ts:1773-1777` still one snapshot, both players, through `duelOutcome`. The freeze-on-first-attest, refuse-to-sign-unre-derivable, and refund-on-unmarkable logic are all still present in the surrounding code (content re-read, not just line numbers). `test/attest.test.ts`: 129 pass / 0 fail this pass. |
| 14 | **No hardcoded `"ETH" \| "BTC"` union survives anywhere** | **PARTIAL — one of two fixed** | **PASS — closes, and the audit's own recommendation was wrong** | `src/desk/rfq.ts:296` still the widened `RfqUnderlying` (all eight, unchanged from first pass). `src/server/thetanuts.ts:502` (was cited `:345`) is **still** `getPricingArray(underlying: "ETH" \| "BTC")` — and this pass checked the SDK directly rather than trusting the commit that left it alone: `node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts:7690` really does read `getPricingArray(underlying: 'ETH' \| 'BTC'): Promise<MMVanillaPricing[]>`, verbatim. **This audit's own first-pass finding 1 (below the table) was the bug, not the code**: it conflated two different SDK declarations — `RFQBuilderParams.underlying` (eight members, the one `rfq.ts` was too narrow against) and `MMClient.getPricingArray`'s parameter (two members, always was). Widening `thetanuts.ts:502` would make the file's own mirror type claim the vendor accepts an argument the vendor's own `.d.ts` rejects. `thetanuts.ts:466-500` now carries a docblock making exactly this distinction, with both `.d.ts` line numbers, so the next reader doesn't re-litigate it either. Item 14 is satisfied: the *undocumented* union it bans is gone (one widened correctly, one left narrow *correctly* and now documented as to why). |
| 15 | `qualifiedUnderlyings` is pure, fixture-driven, enforces all four conditions | **PASS as a module — unwired in the app** | **PASS — wired end to end** | The module is unchanged (`src/data/qualify.ts:526`, thresholds `MIN_ORDERS:52=6`, `MIN_GREEKED:63=4`, `MIN_DEPTH_USDC:75=50`, all still enforced, `test/qualify.test.ts` 62 pass / 0 fail). **What changed is the wiring**: `src/server/thetanuts.ts:12` now imports `qualifiedAssets` (a value, not `import type`) and calls it at `:1835` — `qualified: [...qualifiedAssets(raw, at)]` — computed over the same raw capture the rest of the snapshot grades, at the same instant. That snapshot's `qualified()` accessor (`src/data/market.ts:118`) is read through `qualifiedAssetsOf(source)` (`:204`), which `src/App.tsx:145` calls (`const liveAssets = qualifiedAssetsOf(source)`) and passes at `App.tsx:485` as `live={liveAssets}` into `CreateLobby` — the exact prop `CreateLobby` had declared since plan 6 (`:405`) and nothing had ever supplied. This chain is **committed** (`fbef12b`), not working-tree-only. `test/app.test.tsx`: 85 pass / 0 fail this pass (that test file itself has 302 uncommitted lines added, but the App.tsx wiring it exercises is already on HEAD). |
| 16 | Feed aliases deduplicated by address — a test asserts ETH appears once | **PASS** | **PASS — unchanged** | `feedIndex` still at `src/data/qualify.ts:237`. Assertions unchanged. |
| 17 | `scripts/probe-assets.ts` runs against the live book and its output is committed | **PARTIAL** | **PASS — corrected** | The earlier verdict rested on a 404 from `indexerApiUrl`, which `fetchOrders()` never calls; it asks `apiBaseUrl`, which answers 200. Re-run live: 6 underlyings QUALIFIED (ETH $1.19M, BTC $1.36M DEEP; SOL/XRP/BNB/AVAX THIN). Output committed in `docs/asset-gate.md`. |
| 18 | A sector with no qualified members renders greyed with a reason, not hidden | **PARTIAL** | **PASS — closes** | Same code as first pass (`src/data/sectors.ts:241 NO_BOOK_REASON`, `liveSectorStatus:320`), but it is no longer being fed an empty list: `src/views/CreateLobby.tsx:427` — `const qualified = p.live ?? []` — now receives the real `live` prop (item 15's wiring), and `:428` calls `liveSectorStatus(qualified.map((a) => a.underlying))` on it. A group greys **only when it is actually unqualified**, which is what the item asks for. |
| 19 | DEEP/THIN grade on the lobby card and the slice reveal | **PARTIAL** | **PARTIAL — still, narrower, and one closed sub-claim is not supported by the code** | Three separate surfaces, three separate answers this pass: **(a) Slice reveal — closes.** `src/components/MatchSpin.tsx:255` — `gradeIndex(p.source)[slice.underlying] ?? null` — reads real grades off the live source at the reveal; `gradeIndex` (`src/data/market.ts:227`) is a genuine function over `qualifiedAssetsOf`, not a stub. This is new since first pass, when `spinSlice` had no caller and no reveal surface rendered a grade at all. **(b) Create screen's THIN-default bug — fixed and committed (`e91d177`).** First pass found `CreateLobby.tsx` defaulting every ungraded symbol to `"THIN"` — a measurement nobody made. The fix (verified against the working tree, then confirmed landed at `e91d177`) replaces `grades[sym] ?? "THIN"` with `const grade = grades[sym] ?? null` (`:335`) and a real "not graded" state — `UNGRADED_LABEL = "NOT GRADED"` (`:226`), `data-grade={grade ?? UNGRADED_ATTR}` (`:340`), rendered in `C.faint` rather than a grade colour. **(c) Lobby board's own grade tag — still open, and `0b54d7b`'s commit message claims more than the code delivers.** `src/ui/LobbyCards.tsx:95` still declares `grades?: Readonly<Record<string, Grade>>` as an **optional prop that no caller supplies**: `grep -rn "grades=" src/` finds exactly one call site in the entire tree, `CreateLobby.tsx:525`, and it passes `grades` to `<LiveSector>`, not to `<LobbyCard>`. Both places `<LobbyCard>` is actually rendered — `src/views/Battles.tsx:105` and `src/views/Lobby.tsx:49` — pass no `grades` prop at all, so `LobbyCards.tsx`'s own `GradeTag` component (`:54-63`) never receives a measurement on the lobby board, ever. This is exactly the gap the first pass described for item 19's "lobby card" half, and it is **unchanged**. The commit that says it closed item 19 closed two of its three parts. |
| 20 | One end-to-end fill on Base, under $2, with a Basescan link in the README | **OWNER-ONLY — not done** | **OWNER-ONLY — still not done** | Re-checked this pass: no `basescan.org/tx` anywhere in `README.md` or `docs/`. `runParlayFill` is still at `src/views/Parlay.tsx:1377`, still flag-gated behind `THETADUEL_TRADE=on`. Nobody has spent a cent. Only the owner can close this. |
| 21 | **A second end-to-end fill on a non-ETH/BTC underlying**, same evidence | **OWNER-ONLY — not done, and blocked upstream** | **OWNER-ONLY — still not done, still blocked upstream** | Same evidence: none. NOT blocked upstream — the book is healthy (item 17, corrected). Only the owner can close this. |

### Scoreboard

**First pass:** PASS 12 · PARTIAL 5 · FAIL 1 · OWNER-ONLY 2 (before mid-audit
closures: PASS 9 · PARTIAL 6 · FAIL 3).

**Second pass, now:** **PASS 17 · PARTIAL 2 · FAIL 0 · OWNER-ONLY 2.**

Five rows changed verdict outright: 2 (FAIL → PASS), 8 (PARTIAL → PASS), 14
(PARTIAL → PASS), 15 (PASS-as-a-module-unwired → PASS-wired-end-to-end), 18
(PARTIAL → PASS). A sixth, 19, kept its verdict (PARTIAL) but changed
substance — two of its three surfaces closed, one (the lobby board's `grades`
prop) did not, despite the commit that landed the other two also claiming this
one. The remaining two PARTIALs are 17 (blocked on the protocol team's book
endpoint, not on any builder) and 19 (blocked on one missing prop-drill,
`grades={...}` into `<LobbyCard>` at its two call sites). Both OWNER-ONLY rows
are unchanged: nobody has filled anything on Base.

The wiring the first pass called "the highest value per line currently
available in this repo" got written: `cardsForSlice`/`multipleAt` now have
production callers (closes 2, 8), and `qualifiedAssets()` now reaches
`CreateLobby` and `MatchSpin` (closes 15, 18, and two of three parts of 19).
What is left is smaller and more specific than what was left before: one prop
(`grades`) not drilled into one component (`LobbyCard`) at its two call sites,
and one protocol-side URL still 404ing.

## Defects found since the first pass — not among the original 21

These are not §9 checkboxes. They are correctness bugs the first pass's own
method (measure, don't read a commit message) would have caught had they been
introduced before it was written; they were introduced or discovered after, so
they are recorded here rather than silently folded into the table above.

**D1 — `isBuyer` was inverted, and a real fill would have made the player the
writer. Fixed and committed (`37f0c37`).** `src/desk/fill.ts`'s `askEntry` — the
order the app actually fills — was reading `isBid = entry.order.isBuyer`
backwards, so it pointed at the maker's **bid**. Filling one makes the taker
the seller: collateral posted, downside unbounded, exactly what both plans
forbid by construction. The SDK's own typings contradict themselves on this
point (`index.d.ts:773` vs. `normalizeOdetteOrder`), so it was settled by
measurement instead — 142 live orders joined against the venue's own two-sided
MM quotes, with total separation and zero counterexamples (`isBuyer=true`
orders rest at 1.58–1.66× the MM mark and never at/below its bid; `isBuyer=
false` orders rest at 0.69–0.72× and never at/above its ask). **Why nothing
caught it:** the fix splits the flag into `takerBuys` (the player's side,
which still labels `OrderRow.side`) and the corrected `isBid = !takerBuys`
(which decides what gets filled) — and the blotter's BUY/SELL column was
always built straight off `isBuyer`/`takerBuys`, so **the label the player
saw was correct the entire time the fill target underneath it was wrong**. A
green blotter hid a wrong-side fill path. Verified current: `src/server/
thetanuts.ts:1575-1576` (`takerBuys`/`isBid`), `:1637` (`side: takerBuys ?
"BUY" : "SELL"`); `src/desk/fill.ts:620` (`entry.order.isBuyer ? "BUY" :
"SELL"`) — both still read straight off the same flag, unchanged since the
fix. This is committed, on HEAD, not working-tree-only.

**D2 — `Level` keys were built on `orderExpiryTimestamp` (the order's
signature deadline) instead of the option's own expiry, merging different
contracts into one row. Fixed and committed (`56435c0`).**
`src/server/thetanuts.ts`'s market builder grouped orders into price levels by
`underlying|isCall|strikes|orderExpiryTimestamp`. On the frozen capture every
order carries the *same* signature deadline (a maker signs a batch at once),
which made that field a constant and collapsed the key to
`underlying|isCall|strikes` — thirty orders into fifteen levels, thirteen of
which merged two or more distinct option expiries. The worst, ETH 2650 CALL,
merged three different contracts (5 Sep / 6 Sep / 11 Sep, two different
implementations, one WETH-collateralised and two USDC-collateralised) into one
row reporting `mid: 1.9874` and `structure: UNKNOWN`. **Verified by reading
the code, not the commit:** `src/server/thetanuts.ts` now rebuilds the key on
the real option expiry plus the implementation address (`interface Level` at
`:1200`, `markKey` at `:1355`, `edgeOf`'s median-IV grouping at `:1368`), with
the signature deadline demoted to `OrderRow.instrument`/`.time` only. This is
backed by dedicated regression tests, run this pass:
`test/market-builder.test.ts` — 111 pass / 0 fail, including `"the signature
deadline groups nothing — two deadlines on one contract are one level"`
(`:126`) and `"the implementation is part of the key — a ranger and a condor
are not one level"` (`:165`).

**D3 — Slip legs were still priced by the retired clamped ratio
(`desk/optionize.ts`) in `src/state/match.ts`, while the pick screen had
already moved to the live path. Fixed and committed (`e91d177`).** This is the same root cause as item 2, on a different surface:
`0b54d7b` wired `ParlayPick.tsx`'s grid to `cardsForTicker`/`multipleAt`, but
`match.ts` — which prices the legs that actually reach `settle`, the tape and
the escrow — was still calling `optionize(leg, book)`, the hand-rolled clamped
ratio the audit's item 2 was written to catch. One surface was right by
override; every other surface a slip leg reaches was printing the old number
for the same bet. **Verified by reading the code, not the commit:**
`src/state/match.ts` now builds `optionize()`'s replacement as a local
`priced()` (`:531-534`) off the same `cardsForTicker` call the pick screen
uses (`:503-509`), reading the leg's card via `slotFor` and re-denominating it
via `legFromLiveCard` — so the card dealt and the leg priced are now, by
construction, the same object read twice. `optionize()` itself has zero
remaining callers anywhere in `src/`. Tests that exercise this path this pass
all pass: `test/app.test.tsx` (85), `test/attest.test.ts` (129), `test/
parlay.test.ts`+`test/optionize.test.ts`+`test/engine.test.ts` (78).

**D4 — `CreateLobby` defaulted every ungraded asset to `"THIN"`, printing a
measurement nobody made. Fixed and committed (`e91d177`).**
Covered in full under item 19(b) above; repeated here because it is a
correctness defect in its own right, not only a §9 sub-item. `THIN` is a real
verdict ("resting orders and greeks, no market-maker feed"); printing it for
an asset the gate never measured is the exact class of claim this screen
exists to delete. The fix: a genuine `null`/"not graded" state
(`UNGRADED_LABEL`, `:226`) distinct from the `THIN` grade, rendered in a
neutral colour rather than a grade colour.

## ~~The live book is still 404ing~~ — RETRACTED, the book is healthy

Wrong, and it is the **third** time this trap has caught an agent, so the mechanism matters
more than the correction. `fetchOrders()` issues a relative `get("/")` against `apiBaseUrl` —
a Cloudflare Worker origin that has served ~380 greeked orders throughout. `indexerApiUrl` is a
path *prefix* every other caller appends a subpath to, so requesting it bare 404s by design.
A real transport failure (local TLS interception, since cleared) once printed the wrong field in
the probe's error banner; every agent since has curled the URL that banner named, got the
expected 404, and fused two unrelated facts into an outage.

Item 21 is therefore **not** blocked upstream — only on the owner spending a cent.
Teardown: `docs/book-endpoint.md`.


## The `rfq.ts` union — decided and changed (unchanged since first pass)

`src/desk/rfq.ts` had `RfqInput.underlying: "ETH" | "BTC"`, justified in a
docblock as *"nothing else has a Thetanuts options market (FINDINGS §3)"*.

**That justification was wrong, and the union has widened.** The decisive fact is
in the SDK's own typings:

```ts
// node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts:3102
type RFQUnderlying = 'ETH' | 'BTC' | 'SOL' | 'DOGE' | 'XRP' | 'BNB' | 'PAXG' | 'AVAX';
```

`RFQBuilderParams.underlying` is that type. Our field was **narrower than the
type the protocol accepts** — we were deciding what the venue sells. The old
comment collapsed the MM-pricing set (two) onto the price-feed set (eight),
which is precisely the conflation §7 exists to kill and precisely what once
made AVAX the broken default asset.

The counter-argument was weighed and rejected. RFQ *is* MM-dependent, and a
sealed-bid request on DOGE will very likely get no bids. But **"nobody bid" is
already a first-class state in this module** — `awaitOffers` returns
`unanswered`, not an error, because a sealed-bid auction with no bidders is the
protocol working, not failing. A type that refuses the request in advance
pre-answers a question only the makers can answer, and answers it wrong for six
assets. Nothing in `rfq.ts` branches on the value: it is threaded to the SDK's
builder and written into a public breadcrumb, and `RfqBreadcrumb.underlying`
was already `string`, so the file was internally inconsistent as well.

**Changed:** a new exported `RfqUnderlying` (`src/desk/rfq.ts:296`) mirroring
the SDK's eight, with the reasoning in its docblock so the next reader does not
re-litigate it. `src/ui/RfqPanel.tsx` still offers ETH and BTC from its own
`TRADABLE` list — that is a **product** decision about where a bid is
likeliest, and it stays a subset of the union. `test/rfq.test.ts` still holds
the line. This section is unchanged from the first pass and was re-confirmed,
not re-derived, this pass.

**Second-pass correction, not to `rfq.ts` but to this file's own first-pass
finding about a *different* union:** first-pass finding 1 below recommended
widening `src/server/thetanuts.ts`'s separate `"ETH" | "BTC"` union
(`MMClient.getPricingArray`'s parameter) to match this one. That recommendation
was wrong — see item 14 above. The two unions are different SDK declarations
with different real signatures, and conflating them was exactly the mistake
`rfq.ts`'s widening was supposed to teach the next reader to avoid.

## Things worth fixing that are outside this audit's file grant

Reported, not edited. Re-checked this pass; status noted per item.

1. ~~**`src/server/thetanuts.ts` — the surviving `"ETH" | "BTC"` union.**~~
   **Retracted.** This pass checked the SDK's `.d.ts` directly:
   `MMClient.getPricingArray`'s parameter really is `'ETH' | 'BTC'` in the
   vendor's own types (`index.d.ts:7690`), unlike `RFQBuilderParams.underlying`
   (eight members). The first-pass recommendation to widen it conflated the two
   declarations. `thetanuts.ts:466-500` now documents the distinction with both
   line numbers. See item 14 and the `rfq.ts` section above. **No further
   action needed here.**
2. **`test/determinism.test.ts:138-139`** — the boundary scan matches raw file
   text with no comment stripping, so an engine docblock that merely *names*
   `src/server/thetanuts.ts` fails the build identically to an import. **Still
   unfixed this pass** — re-read directly, still a raw `text.match(...)` with
   no stripper, unlike `test/detail.test.ts:412`'s scanner. It cost the first
   pass a false FAIL on item 7 and was worked around by rewording a docblock
   rather than fixing the scan, so it will happen again to the next docblock
   that names the file it must not import. Give it the same comment stripper.
3. **`src/data/spot.ts:179-180`** — a comment still citing `TIERS.SHARP.prob`
   and describing `TIERS`/`summarize()` as pinned. **Still there, re-confirmed
   this pass.** `TIERS` is gone; the sentence teaches the next reader a
   constant that does not exist.
4. ~~**The wiring, and it is two edits.**~~ **Done, and it is what closed items
   2, 8, 15, 18 and two-thirds of 19 above** (`fbef12b`, `0b54d7b`, `e91d177`,
   `56435c0` — see D2/D3/D4). The one remaining edit from this family that is
   *not* done: pass `grades={...}` into
   `<LobbyCard>` at its two call sites, `src/views/Battles.tsx:105` and
   `src/views/Lobby.tsx:49` — see item 19(c). Everything that edit needs
   (`gradeIndex`, `LobbyCard`'s own `grades` prop and `GradeTag` component) is
   already written and already tested; it is one prop-drill, the same shape as
   the edit that closed item 18.
5. **New this pass — D2, D3 and D4 were all verified against a dirty working
   tree first and landed as commits before this file was finished**
   (`e91d177` for D3 + D4 + the ParlayPick/parlay.ts half of item 2;
   `56435c0` for D2). All three are verified real and tested against that
   working tree (see D2–D4 and item 19(b) above); the commits were confirmed
   to contain the same diffs this pass already read, but were not
   independently re-greped a second time after landing. Re-run this audit's
   greps against whatever HEAD is current before the next pass, on the same
   principle as everything else in this file.

@see `plan6-real-parlay.md` §9, §10 · `docs/asset-gate.md` · `docs/HANDOFF.md`

---

# Third pass — the two open PARTIALs, re-verified 2026-09-05, HEAD `8b457f2`

Scope of this pass is narrow on purpose: **only the rows this file left open**,
plus the rows the four commits since `56435c0` could have moved. It was written
alongside `docs/plan7-audit.md`, by the same rule — a grep, a `file:line` or a
test that was actually run, never a commit message.

Tree state: branch `new`, HEAD `8b457f2`, `git status --porcelain` clean apart
from an untracked `.scratch/`. Commits since the second pass:
`9d8f704`, `5644a1f`, `42374b0`, `06118b9`, `8b457f2`.

## First, a bookkeeping correction to this file

**The scoreboard and the table disagree, and the table is right.**

The Scoreboard section reads *"The remaining two PARTIALs are 17 (blocked on the
protocol team's book endpoint…) and 19"*. But item 17's own row two-dozen lines
above was already re-verified to **PASS — corrected** in that same pass ("Re-run
live: 6 underlyings QUALIFIED… Output committed in `docs/asset-gate.md`"), and
the outage section it points at is itself marked **RETRACTED**. The prose is a
leftover from the first-pass verdict; the row is the measurement.

Re-checked directly this pass: `scripts/probe-assets.ts` exists;
`docs/asset-gate.md` carries a dated live run — `run 2026-09-04T20:00:56.214Z`,
`source live Base 8453` — with `ETH $1,191,241 DEEP`, `BTC $1,355,890 DEEP` and
SOL/XRP/BNB/AVAX QUALIFIED THIN, plus a second live run at 17:10Z and a
`--fixture` run for offline replay. **Item 17 is PASS.** It did not move this
pass because it had already closed last pass.

So the real count at `56435c0` was **PASS 18 · PARTIAL 1 · FAIL 0 ·
OWNER-ONLY 2**, not 17/2/0/2, and item 19 was the only PARTIAL left. That is
what this pass re-verifies.

## Item 19 — the `grades` prop — **PARTIAL, unchanged, not one character moved**

The second pass's finding was that `0b54d7b`'s commit message claimed to close
item 19 while closing two of its three parts. That remains exactly true at
`8b457f2`, and the three greps that establish it were re-run verbatim:

| Grep | Result at `8b457f2` |
|---|---|
| `grep -n "grades" src/ui/LobbyCards.tsx` | `:81` (destructured), `:95` (`grades?: Readonly<Record<string, Grade>>` — declared on **`LobbyCard`**, whose signature opens at `:76`), `:125` (`Object.entries(grades ?? {})`), `:235` (the render comment). Unchanged. |
| `grep -rn "grades=" src/` | **Exactly one hit in the whole tree**: `src/views/CreateLobby.tsx:525` — and it passes `grades` to `<LiveSector>`, not to `<LobbyCard>`. Unchanged. |
| `grep -rn "<LobbyCard" src/` | `src/views/Battles.tsx:105` and `src/views/Lobby.tsx:49`, both `<LobbyCard key={l.id} lobby={l} onAccept={…} onStart={…} />` — **no `grades` prop at either site**. Unchanged. |

`GradeTag` (`src/ui/LobbyCards.tsx:54-74`) is still a real, exported component
with a real `Grade`-keyed colour map, and `graded` (`:125`) still sorts an empty
object into an empty array on every lobby card the board ever renders. The
component cannot say DEEP or THIN on the lobby board, ever, because nothing hands
it a measurement.

**Verdict: PARTIAL, unchanged.** (a) the slice reveal still closes
(`src/components/MatchSpin.tsx:255` via `gradeIndex`, `src/data/market.ts:227`);
(b) the create screen's THIN-default is still fixed; (c) the lobby board's own
grade tag is still unreachable. **What closes it is still one prop-drill at two
call sites** — `Battles.tsx:105` and `Lobby.tsx:49` — and everything it needs is
already written and already tested.

## Rows the four new commits could have moved

Each of these was re-checked because a new commit touched a file the row's
evidence rests on. **None changed verdict.**

| # | Why re-checked | Result |
|---|---|---|
| 9 | `5644a1f` rewrote 187 lines of `src/desk/fill.ts` | **PASS — unchanged, line numbers moved.** All four `MAX_FILL_USDC` checks still present and still ahead of any signature: `:876` (requested, single), `:1613` (per leg), `:1624` (requested sum), `:1794` and `:1803` (on the **previewed** figures). The audit's old citations (`:1481`, `:1492`, `:1633`, `:1642`) are stale line numbers only. The constant is still `2_000000n` at `:94`. |
| 10 | `5644a1f`, `42374b0`, `06118b9` all touched approval paths | **PASS — unchanged.** `grep -rn "MaxUint256" src/` returns eleven hits and **every one is a comment or a doc line forbidding it** (`escrow.ts:38,725`; `fill.ts:25,855,1069,1541,1865`; `rfq.ts:1457`; `types.ts:652`; `Parlay.tsx:1078,1572`). No live occurrence. Assertions still at `test/fill.test.ts:548,1160,1188`, `test/duel-stake.test.ts:297,306`, `test/rfq.test.ts:369`. |
| 12 | `5644a1f` is titled "…and duels scored on it" | **PASS — unchanged.** `duelScore` is still `src/engine/score.ts:343` and `duelOutcome` still `:395`; `5644a1f` did not touch `src/engine/score.ts` at all (`git show --stat 5644a1f`: `desk/fill.ts`, `server/thetanuts.ts`, `types.ts`, and two test files). The "scored on it" in the message refers to `FillPreview.contracts` feeding the score, which is `fill.ts`'s side. The `tsc` caveat from the first pass is **still not re-verified**; `tsc` was not run this pass either, for the same reason (a live/browser agent is mid-edit). |
| 14 | `06118b9` and `42374b0` rewrote 354 lines of `src/desk/rfq.ts` | **PASS — unchanged, one line number moved.** `RfqUnderlying` is still the widened eight, now at `src/desk/rfq.ts:410` (was cited `:296`), consumed at `:418` with a docblock saying "why it is eight and not the two this field used to allow". `src/server/thetanuts.ts:543` still declares `getPricingArray(underlying: "ETH" | "BTC")` — still deliberately narrow, still matching the vendor's own `.d.ts`, still documented as such at `:512`. `test/rfq.test.ts:1062` still asserts the union member-for-member against the SDK, and `:1112` still asserts widening the type did not widen the panel. |
| 20 | Two new plan-7 checklist rows ask for the same evidence | **OWNER-ONLY — still not done.** `grep -rn "basescan.org/tx" README.md docs/` returns exactly one hit: this file, describing the absence. `README.md:502-506` still says so out loud, and adds that the escrow is "compiled, reviewed, and never deployed". |
| 21 | Same | **OWNER-ONLY — still not done.** Same evidence. |

## One defect this file did not have, found while re-checking row 12

`5644a1f` fixed `CONTRACT_DECIMALS` from 18 to 6 in `src/desk/fill.ts:148` and
`src/server/thetanuts.ts:144`. A **third** constant of the same name survives at
`src/engine/parlay.ts:341` and is still `18`.

`src/server/thetanuts.ts:139-143` argues it is correct there because the engine
both writes and reads it and it cancels — and that is true of every caller today
(`parlay.ts:740` and `:890` both pass `sizeDecimals: CONTRACT_DECIMALS`
explicitly). What makes it a trap is the fallback at `parlay.ts:439`:

```ts
const contracts = fromUnits(q.numContracts, q.sizeDecimals ?? CONTRACT_DECIMALS);
```

`vanillaPayout` is exported (`:433`) and re-exported (`src/views/ParlayPick.tsx:79`),
and its `PayoutQuery` is public. A caller who hands it a real `previewFillOrder`
result — which carries `numContracts` and no `sizeDecimals` — gets a silent
factor of 10^12, which is precisely the failure `5644a1f` describes fixing
elsewhere (a real fill of $1.00 rendering `"0.0000"` and scoring as
2.5 × 10^-13 contracts). Not a live bug today. One line of defence from being
one: make `sizeDecimals` required on `PayoutQuery`, or drop the `??`.

## Third-pass scoreboard

**PASS 18 · PARTIAL 1 · FAIL 0 · OWNER-ONLY 2** — unchanged in substance from
`56435c0`; the difference from the second pass's printed `17 · 2` is the
bookkeeping correction above, not a row that moved.

The single open PARTIAL is still item 19(c), and it is still one prop at two
call sites. Plan 7's own audit is in `docs/plan7-audit.md`.
