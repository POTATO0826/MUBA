# Plan 7 — Definition of Done, audited against the tree

`plan7-box-builder-arena (1).md` §9 is twenty-nine checkboxes. This file is each
one measured against `src/` and `test/` on **2026-09-05**, branch `new`, HEAD
`8b457f2`, working tree clean (`git status --porcelain` shows only `.scratch/`).

**The plan audited here is the corrected text**, i.e. the file as it stands after
`9c3a37e` ("Docs: plan 7 corrected where the venue disproved it"). Several §9
rows only make sense against that revision — §3.1 was rewritten from *listed
condor* onto `RANGER`, and §2.1's `['ETH','BTC']` RFQ enum was struck. Where a
source file still argues from the **struck** text, that is recorded as a
contradiction rather than smoothed over.

**A commit message is not evidence.** Every verdict below is a grep, a
`file:line`, or a test that was actually run. Where a commit claims something the
code does not do, that is said plainly.

Tests run read-only this pass, at HEAD:
`test/box.test.ts` + `test/boxbuilder.test.tsx` + `test/boxduel.test.tsx` +
`test/rfq.test.ts` — **217 pass / 0 fail**, 123,980 expect() calls, 2.28s. The
full suite was not run: another agent is mid-edit on a live/browser pass.

---

## The one-paragraph summary

Plan 7's **pure layer is the best-evidenced code in this repo.** `src/data/box.ts`,
`src/data/condor.ts` and `src/data/ranger.ts` do exactly what §§1–5 ask, in exact
integer arithmetic, with property tests that run the SDK's own `validateCondor`
over every reachable box on every fixture ladder. The ladder is derived first and
the chart is fitted to it; the minimum box height is a fact about the book rather
than a constant; the payout multiple is one division in one file and a test greps
both sources for an invented rate. §7 landed cleanly: `SpotDiff.tsx` and
`ParlayRfq.tsx` are gone, `GameMode` is the single member `"box"`, and the arena
renders no "RFQ" anywhere.

What is **not** true is the last two rows, and they are not merely
owner-blocked — they are blocked in code. `App.tsx` mounts `<BoxBuilder>` without
an `onConfirm` prop (`src/App.tsx:540-560`), so the "Buy this box" button is
permanently disabled by `canSign` regardless of the trade flag; and
`src/ui/RfqPanel.tsx` — the whole of step 5's surface — **has no mount anywhere in
`src/`** (`grep -rn "RfqPanel" src/` returns only doc comments). Step 5 shipped as
modules and tests; it did not ship as a path a player can walk. `App.tsx:435-443`
still says so in a comment, which contradicts `06118b9`'s own message.

And one thing is worse than unproven: the arena prints **custody language for
money nothing holds** (D1 below).

---

## The table

| # | §9 item | Verdict | Evidence | What closes it |
|---|---|---|---|---|
| 1 | `SpotDiff.tsx` and `ParlayRfq.tsx` both deleted, not left dormant | **PASS** | Neither file exists: `find . -iname "*SpotDiff*" -o -iname "*ParlayRfq*"` (excluding `.git`) returns nothing. The only surviving mentions are five doc comments naming them as deleted (`src/App.tsx:361`, `src/views/BoxBuilder.tsx:580-581`, `test/boxduel.test.tsx:9,366`). `src/types.ts:18` — `export type GameMode = "box"` — one member; `src/types.ts:10` records the two it replaced. `src/views/Hub.tsx:30-45` `MODES` is an array of one. | — |
| 2 | `edge`-based scoring has no remaining call sites | **PASS** (with a note) | The scoring path is gone with its data: `src/data/board.ts` (which held `edgeIndex`/`scorePick`, `git show 9d8f704^:src/views/SpotDiff.tsx:2`) no longer exists. `PricingRow.edge` is still **produced** at `src/server/thetanuts.ts:1817` (`edge: edgeOf(level, medianIv)`, helper at `:1426`) and still asserted at `test/market-builder.test.ts:485-509`, but `grep -rn "\.edge\b" src/` finds **no reader** — the field is dead payload on the wire, which `src/server/thetanuts.ts:817-819` says out loud. `edgeOf` in `src/engine/match.ts:19` is a *different* function (the seeded tape duel, still live via `src/state/match.ts:564` and `src/server/attest.ts:915`) and is not what this row bans. | Nothing required. Deleting the dead `PricingRow.edge` field would remove the ambiguity. |
| 3 | Price history renders behind the grid, with a visible "now" divider | **PASS** | `src/views/BoxBuilder.tsx:1325-1346` renders `<svg data-role="history">` first in the plot's stacking order; `:1372-1386` renders `data-role="now-divider"` as a real `border-left` plus a `NOW` label, not an implied edge. `:1392-1400` adds `data-role="last-print"`. Asserted at `test/boxbuilder.test.tsx:339` ("history draws behind the grid, and names its feed"), `:364`, `:375`. | — |
| 4 | The box cannot be dragged left of "now" | **PASS** (untested) | Structural, not guarded: `Drag` (`BoxBuilder.tsx:701-704`) is `{from, to}` **prices** only — there is no horizontal drag to constrain. Both the drag outline (`:1419`) and the committed box (`:1489`) hard-pin `left: ${xPct(t0, t1, dividerMs)}%`, and the right edge is `100 - xPct(…, chosen*1000)`. `NOW_COPY` (`:151-152`) says why. | A test asserting the box element's computed `left` equals the divider's. No test currently exercises the pointer path at all. |
| 5 | Chart and strike ladder share one y-axis — ladder derived first, chart fitted to it | **PASS** | `src/data/box.ts:403-409` derives `prices` **from** `strikes` inside `deriveLadders`, in one place, so the axis cannot disagree with the rungs. `ladderBounds` (`:454`) is the ladder's own extent; `BoxBuilder.tsx:788` is the only `band`, and grid rows (`:1349`), spot (`:1360`), history (`:1341`), box (`:1491`) and drag arithmetic (`priceAtClientY:1001`) all go through `yPct`/`priceAtFraction` (`:366`, `:373`). History is **clipped** to the band by `fitToLadder`, never rescaled (`:827`), and prints that fall outside are counted and stated (`:1667`). Asserted at `test/box.test.ts:153,162`; `test/boxbuilder.test.tsx:351`. | — |
| 6 | The price source is named in the PR, and settlement-feed disagreement is acknowledged | **PARTIAL** | The **acknowledgement** is real and in one place: `src/data/history.ts:110` `PRICE_SOURCE = "Chainlink · Base 8453"` and `:118-119` `SETTLEMENT_NOTE` ("Settlement takes a TWAP of it, so the last tick and the settlement print can differ slightly"), both rendered under the chart at `BoxBuilder.tsx:1660-1663` whenever there is a line. The **naming in a durable artifact** is missing: `README.md` never mentions Chainlink or the arena's price source, and its §"Live arena" (`README.md:52-70`) still documents the two deleted modes. | Two or three lines in `README.md` §"Live arena": name Chainlink-on-Base as the arena's history feed, repeat the TWAP caveat, and delete the "Parlay · RFQ" / "Find a difference" bullets. |
| 7 | The box snaps to strikes that carry live orders — a test asserts an irregular ladder snaps irregularly | **PASS** | `deriveLadders` (`box.ts:357`) buckets only strikes from orders with remaining size, a readable option expiry ahead of the clock, and a live signature (`liveExpiryOf:304`). `snapStrike:507` / `nearestIndex:483` round to the ladder's own rungs with ties downward. Tests: `test/box.test.ts:222` ("an irregular ladder snaps irregularly — no constant increment anywhere"), `:244` (BTC's $3,500 gap), `:252`, `:258`, `:166` (no size ⇒ not a rung), `:175` (stale signature ⇒ not a rung). | — |
| 8 | Minimum box height is derived from the live ladder, not a constant | **PASS** | `minBoxHeight` (`box.ts:537`) returns the next rung minus this one — there is no `MIN_BOX_HEIGHT` in the file. Enforced in `snapBox:773-779` as "at least one rung apart". Rendered in dollars at `BoxBuilder.tsx:1760-1765` ("that is the next rung the book quotes, not a rule of ours"). Tests `test/box.test.ts:274,285,298,309`. | — |
| 9 | Expiry is chosen from live expiries only; no free-dragged date can be submitted | **PASS** | Structural: `snapBox` takes `expiry` **from the ladder**, never from the box (`box.ts:789`). The picker's vocabulary is `liveExpiries` (`box.ts:437`) filtered by `isFuture` against the divider (`BoxBuilder.tsx:772-775`), and the selection falls back to `columns[0]` when a chosen date stops being quoted (`:779`). Test `test/box.test.ts:337`; `test/boxbuilder.test.tsx:151`. | — |
| 10 | **One expiry, one number, shown once** — asserted in a UI test | **PASS** | The picker *offers* dates (`BoxBuilder.tsx:1564-1585`); the panel *states* one, once, at `data-role="expiry-value"` as `by Sep 11` (`:1704-1709`). On the confirm step that row is replaced, and the instrument line states it once (`:1856-1859`). `test/boxbuilder.test.tsx:162` ("one expiry, one number, shown once") and `:170`. | — |
| 11 | Copy says "lands in your box at expiry", never "stays within" | **PASS** | `SETTLEMENT_COPY` (`BoxBuilder.tsx:148`) is the only sentence, rendered twice (`:1754`, `:1889`). `test/boxbuilder.test.tsx:292` asserts the presence of "lands in your box at expiry" and the absence of "stays within", plus `/\bRFQ\b/`, `/\bSUI\b/`, `moneyness` and `implied volatility`. | — |
| 12 | `boxToCondor` passes `validateCondor` for every reachable non-matching box (property test); `zoneToRanger` passes `validateRanger` for every matching box, with `isRanger: true` on every payout call | **PARTIAL** | **Condor half: PASS, and strong.** `test/box.test.ts:498` runs the real SDK named export over every reachable box on every fixture ladder; `:516` adds a seeded fuzz of raw drags. The invariant is guaranteed by construction (`condor.ts:141-146`, one wing in `bigint`), so `validateSpec:186` needs no tolerance. **Ranger half: thin.** `validateRanger` is run on the fixture's zones only (`test/box.test.ts:921`, `:1214`) — which is n=2 on this capture (`:1163-1166`) — not as a property over every matching box. **`isRanger`: vacuous.** `grep -rn "isRanger" src/` finds only comments (`condor.ts:41`, `ranger.ts:115`, `thetanuts.ts:1062`, `types.ts:497`) and one rendered debug string (`Parlay.tsx:588`); there is **no call to `calculatePayoutAtPrice` or `calculateMaxPayout` anywhere in `src/`**, so "carried on every payout call" is true of zero calls. `RangerSpec.payoutType: "ranger"` (`ranger.ts:467`) carries the intent but nothing enforces it at a boundary that does not yet exist. | Make the ranger assertion a loop over `matchListedZone` hits the way `:498` loops over boxes, and add a test that fails if an SDK payout helper is ever called on a `RangerSpec` without the flag. |
| 13 | Wing width is visible in the parameters panel even when not draggable | **PASS** | `BoxBuilder.tsx:1713-1722` — a `WING WIDTH` row with the value and the sentence "It is also the most this can pay per contract, which is why it is on screen even while it is fixed." The wing is carried on the `Box` itself (`box.ts:576`) rather than swallowed. For a listed zone the panel additionally says the wing is the maker's (`LISTED_WING_COPY:171-172`, rendered `:1776`). Test `test/boxbuilder.test.tsx:215`, `:460`. | — |
| 14 | Max loss equals the premium, shown above the upside figure, at every detail level | **PASS** (see D4) | `condor.ts:307` — `maxLoss` is `premiumPaid`, with no other branch, on both instruments through one `economics()` (`:345`). DOM order is `MAX LOSS` (`BoxBuilder.tsx:1728-1737`) before `MAX PAYOUT` (`:1739-1755`) in the draw panel and again in `Review` (`:1868-1890`). This screen has no detail toggle, so "every detail level" is both of its two states. Asserted positionally at `test/boxbuilder.test.tsx:226` and `:237`, and arithmetically at `test/box.test.ts:674`. | Nothing for this row. See defect **D4** for the unquoted case. |
| 15 | Payout multiple is computed from premium — no invented rate, and a test greps for hardcoded multipliers | **PASS** | `multipleOf` (`condor.ts:294`) is the one division in the repo; `payoutMultiple:273` and the listed path's `zoneEconomics` (`ranger.ts:543`) both route through it, and `null` — not a placeholder — is the answer without a premium. Rendered only when non-null (`BoxBuilder.tsx:1746`, `:1881`). Tests `test/box.test.ts:703`, `:714`, `:730` ("no hardcoded rate hides in either source file"), `:742`; `test/box.test.ts:1238-1246` for the zone. | — |
| 16 | Difficulty shading cannot change a price | **PASS** | There is no tier argument to pass: `payoutMultiple(spec, premiumPaid, numContracts)` and `economics(wing, zone, premiumPaid, numContracts)` take no `Tier`, and `TIER_BANDS` is imported by neither `condor.ts` nor `ranger.ts` (nor by `BoxBuilder.tsx`). Test `test/box.test.ts:720` asserts exactly that. On the listed path the plan's own shading is refused with a reason rather than faked: `LISTED_NO_GREEKS_COPY` (`BoxBuilder.tsx:180-181`, rendered `:1780`). | — |
| 17 | No code path can construct a short leg — a test asserts buy-side only | **PARTIAL** | **Data layer: PASS, at the type level.** `CondorSpec.isLong: true` (`condor.ts:110`) and `RangerSpec.isLong: true` (`ranger.ts:478`) are literal types; `test/box.test.ts:643` and `:1203` both use `@ts-expect-error` on `{ isLong: false }`, and `:656` greps both sources for a sell side. `listedZones` additionally only admits taker-buyable orders (`ranger.ts:194-196`, `:306`). **Desk layer: open.** `RfqInput.isLong` is `boolean` (`src/desk/rfq.ts:448`), and no phase of the four-phase flow refuses `false` — `grep -n "isLong" src/desk/rfq.ts` finds the declaration and one pass-through at `:1769`. Both call sites happen to pass `true` (`boxauction.ts:225-239` via `spec.isLong`; `RfqPanel.tsx:394`) and `test/rfq.test.ts:1233` asserts it for the box path, but the lock stops at the module boundary. | Narrow `RfqInput.isLong` to the literal `true`, or add the same refusal `assertCollateralZero` gets, plus a test that a `false` never reaches a dep. |
| 18 | Quote resolves on release, not during drag — one price call per box | **PASS** (drag path untested) | `onPointerMove` (`BoxBuilder.tsx:1302-1307`) sets outline state and nothing else — no readout, no `onQuote`. `onPointerUp` (`:1308-1313`) calls `commit` → `snapBox` → `commitBox`, and `commitBox` (`:952-973`) fires `onQuote` exactly once, after `isPlayable` → `boxToCondor` → `condorStrikeNumbers` → `validateSpec`. The rung-click twin goes through the same `commit` (`onRung:1016`). `test/boxbuilder.test.tsx:179` proves one quote for two clicks and zero for the first. No test drives `pointerdown`/`pointermove`/`pointerup`. | A pointer-event test asserting zero `onQuote` calls across N moves and exactly one on release. |
| 19 | Prices shown come from `previewFillOrder` or a decrypted offer, never from mid | **PASS** | Traced end to end. Server: `zoneQuoter` (`src/server/thetanuts.ts:2048-2070`) calls `book.previewFillOrder(entry, QUOTE_USDC, referrer)` and reads `pricePerContract` **verbatim**, returning `null` rather than falling back to `totalCollateral / numContracts` (`:2058-2060` says why — the rounded recovery is off by the whole spread). Client: `zoneQuote` (`ranger.ts:573`) parses that and returns `null` for every not-having-it case; `App.tsx:459-465` sets `boxPremium` to it or to `null`; `BoxBuilder` renders no multiple without it (`:1053-1055`). RFQ side: `offerPremiumUsd` (`boxauction.ts:269-273`) returns `null` for an unreadable offer. Tests `test/box.test.ts:1255`, `:1268`. | — |
| 20 | `MAX_FILL_USDC` is checked before any signature | **PASS at the module level; unreachable from the arena** | `src/desk/fill.ts:94` `MAX_FILL_USDC = 2_000000n`, checked four times before anything signs (`:876` requested single, `:1613` per leg, `:1624` requested sum, `:1794`/`:1803` on the **previewed** figures), all inside the `cap` gate that runs "before any signature" (`:842`). RFQ's twin `MAX_RFQ_USDC` (`rfq.ts:178`) is checked at `:1159` before any dep is touched and again on the incoming bid at `:1489`; `test/rfq.test.ts:751` ("the cap runs before any dep is touched") and `:763`. Note: no box can reach either, because `onConfirm` is not wired (row 28). | — |
| 21 | `ensureAllowance` returning `null` is treated as success | **PASS** | `fill.ts:1091` and `:1874` — `approvalSkipped = receipt === null \|\| receipt === undefined`, surfaced on the result (`:319`, `:1293`); `rfq.ts:1525` identical, surfaced `:1563`. The rule is stated at `fill.ts:62-63` and `rfq.ts:1057`. No branch anywhere treats a falsy return as failure. | — |
| 22 | RFQ path passes `keyStorageProvider` explicitly — no plaintext localStorage anywhere | **PASS** | `new MemoryStorageProvider()` on **every** construction: `rfq.ts:1855`, `:1882`; `fill.ts:2089`, `:2120`, `:2184`, `:2235`. The rule is written down at `rfq.ts:1789`. Tests: `test/rfq.test.ts:533-596` — a full run writes breadcrumbs and none contains the key (`:534`), browser storage is untouched (`:555`), `rememberRequest` refuses a payload containing the key (`:566`), no storage at all is supported (`:589`), and mounting the panel writes nothing (`:1034`). | — |
| 23 | RFQ params carry `collateralAmount = 0` | **PASS** | Asserted on the **built** request rather than on our input — `assertCollateralZero` (`rfq.ts:782-833`) reads `request.params.collateralAmount` and refuses a non-zero, an unparseable and a missing value alike, before submission. `test/rfq.test.ts:392-436`: `:393` zero passes and comes back frozen, `:399` non-zero "is refused, and never reaches the network", `:410` missing/unparseable, `:419` string zero, `:423` "every phase-1 run asserts on the BUILT request, not on our input", `:1245` the same for a request built from a box. | — |
| 24 | Unfilled side ⇒ no verdict signed ⇒ escrow refund path | **PARTIAL** | **The no-verdict half is real and asserted.** `duelOutcome` (`src/engine/score.ts:395`) returns `noVerdict: true` for both-unfilled, one-side-filled, and unmarkable slates, with a control proving it is not a function that always refuses (`test/boxduel.test.tsx:331-349`). The reveal prints `NO_FILL_COPY` and names no winner — six banned verdict strings are asserted absent (`:351-372`). **The refund half is copy, not a path.** `useDuelStake` is wired only to the seeded match flow (`App.tsx:113`, called from `readyUp:264`, `lockParlay:273`, `settle:300`); the arena's `createArena`/`roomState` path opens no duel on `DuelEscrow` — `grep -n "escrow\|createDuel" src/state/room.ts src/server/rooms.ts` returns nothing. `README.md:505-506` states the escrow is "compiled, reviewed, and never deployed". See **D1**. | Either wire the arena room to `useDuelStake` so a box duel actually escrows, or change the arena's copy to stop promising a refund of stakes nothing took. |
| 25 | Both boxes render on one chart at reveal | **PASS** | `BoxBuilder.tsx:1446-1475` draws the opponent's box **before** mine so the outline paints over the fill, and mine loses its fill at reveal (`:1492-1493`) so the overlap reads as overlap. Cross-asset and cross-expiry mismatches are said in words rather than drawn wrong (`:1179-1194`). At reveal the authoritative version of *my* box is restored from the wire (`:920-942`), so a reloaded tab renders the same two rectangles. Tests `test/boxduel.test.tsx:202` ("a box locks, stays unreadable on the wire, and both appear together"), `:294`, `:304`. | — |
| 26 | The word "RFQ" appears nowhere in UI copy, `Hub.tsx` mode copy, or route names | **PASS** (three notes) | Mode key: `GameMode = "box"` (`types.ts:18`). Routes: `src/lib/route.ts` has `/`, `/battles`, `/create`, `/desk`, `/ranks`, `/arena`, `/room/:id`, `/match/...` — no rfq. `Hub.tsx`'s blurb is "Draw a price band and an expiry on the chart…" (`:41-43`); the old copy survives only inside the docblock at `:19-24`. Rendered assertion: `test/boxbuilder.test.tsx:299` — `expect(body).not.toMatch(/\bRFQ\b/)`. `RFQ_PHASE_COPY` (`rfq.ts:574-591`), the only RFQ-module strings that reach a screen, read "REQUEST / OFFER / REVEAL / SETTLE" and contain no "RFQ". **Notes:** (a) `README.md:57` still lists "**Parlay · RFQ**" as a live mode — see C3; (b) `src/ui/RfqPanel.tsx:577` renders `data-testid="rfq-panel"` and `:725` `data-testid="rfq-max-bid"`; (c) the file is still named `RfqPanel.tsx`. None of the three is UI copy, a mode key or a route name, but §7 asks for a tree-wide grep. | Fix the README bullets; optionally rename the panel and its test ids. |
| 27 | SUI appears nowhere | **PASS** | No source **value**: `test/box.test.ts:830` ("SUI is never a value in either source file") runs a comment-stripped scan over `box.ts` and `condor.ts` and asserts `isCondorUnderlying("SUI") === false`. The only occurrences in `src/` are two doc comments (`condor.ts:85`, `history.ts:718`) explaining that SUI is not a Thetanuts asset. `boxProblem`'s sentence is interpolated from `b.underlying`, not hardcoded (`box.ts:806`). | — |
| 28 | One real `RANGER` filled on Base under $2 via the OptionBook, Basescan link in the README | **OWNER-ONLY — not done, and blocked in code** | No `basescan.org/tx` anywhere in `README.md` or `docs/` (the only hit is the plan-6 audit describing its absence). `README.md:502-506` states no fill has ever executed. **And it cannot be attempted from the app:** `App.tsx:540-560` mounts `<BoxBuilder>` with no `onConfirm`, so `canSign = Boolean(onConfirm)` is `false` (`BoxBuilder.tsx:1683`) and the "Buy this box" button is disabled irrespective of `THETADUEL_TRADE` (`:1896-1899`). | Pass an `onConfirm` that routes a `ListedFill` to `fillOrder` through `src/desk/fill.ts`, then the owner spends under $2 and pastes the hash. |
| 29 | One real `CALL_CONDOR` filled on Base under $2 via RFQ, Basescan link in the README | **OWNER-ONLY — not done, and blocked in code** | Same evidence for the link. **And step 5 has no mount:** `grep -rn "RfqPanel" src/` returns only doc comments (`rfq.ts:70,400`, `DetailToggle.tsx:28`, `BoxBuilder.tsx:637`); the only place the component is instantiated is `test/rfq.test.ts:954`. `src/desk/boxauction.ts` likewise has no importer outside `RfqPanel.tsx` and the tests. `App.tsx:435-443` still documents this ("the RFQ path is plan 7 §5 and is not built"), which `06118b9` contradicts. | Mount `<RfqPanel box={spec} …>` behind the arena's unmatched-box branch, then the owner places one real request. |

### Scoreboard

**PASS 23 · PARTIAL 4 · FAIL 0 · OWNER-ONLY 2.**

The four PARTIALs are 6 (price source not named in a durable artifact), 12 (the
ranger half of the property test, and a vacuous `isRanger`), 17 (`RfqInput.isLong`
is `boolean` at the desk boundary), and 24 (the escrow refund is copy, not a
wired path). None of them is a wrong number on screen. The two OWNER-ONLY rows
are the ones that matter, and their honest status is stronger than "the owner has
not got round to it": **neither can be attempted from the running app today.**

---

## Where the code contradicts the plan

### C1 — two files still argue from §2.1's struck text

`src/data/condor.ts:83-86` and `src/data/box.ts:803-806` both justify the ETH/BTC
limit with:

> plan7 §2.1 — `prepare_request_rfq`'s underlying enum is `['ETH','BTC']` and
> nothing else can be RFQ'd

That sentence is **struck** in the corrected plan (`§2.1`, lines 255-261): it was
the MCP tool's schema, not the SDK's. The SDK's `RFQUnderlying` is eight assets
(`index.d.ts:3102`) and `buildCondorRFQ` resolves a feed for six. The corrected
plan asks for ETH/BTC anyway, but explicitly *"as a liquidity choice, not an SDK
restriction"*, and asks the greyed copy to say so.

The **behaviour** is right and the **player-facing copy** is defensible — the chip
title and `boxProblem` both read "has no condor market — ETH and BTC only", which
is a liquidity statement. `src/desk/rfq.ts:400` and `:416-418` get the reasoning
right ("why it is eight and not the two this field used to allow"). The two
`src/data` docblocks are the stale half, and they are the two a future reader will
consult when asked "why can't I draw a SOL box".

### C2 — `App.tsx` says step 5 is not built; `06118b9` says it is

`src/App.tsx:435-443`:

> A drawn box that matches no listed zone has no price until a market maker
> answers an RFQ, which is plan 7 §5 and is not built — so `onQuote` sets `null`
> for it rather than reaching for a mid.

`06118b9` is titled "Feat: plan 7 step 5 — the free-draw auction, and the reserve
that never left" and `42374b0` added `src/desk/boxauction.ts` (359 lines). Both
are true at once: the modules exist and are tested (`test/rfq.test.ts:1151-1330`),
and nothing in `src/` mounts them. The comment is accurate about the *app* and
the commit message is accurate about the *modules*. What is missing is the sentence
that says which.

### C3 — `README.md` still ships the two deleted modes

`README.md:52-70`, §"Live arena", verbatim:

> - **Parlay · RFQ** — choose up to four strikes on one underlying; the captured
>   volatility edge decides the round.
> - **Find a difference** — pick the largest hidden volatility outlier in the
>   live order book.

Both screens were deleted in `9d8f704`. This single paragraph contradicts §9
rows 1, 2 and 26 at once — it names a deleted mode, describes `edge`-based
scoring as the live scoring rule, and puts "RFQ" in a mode name. The same section
also still describes plan 6's engine as having no production call sites
(`README.md:521-529`), which `docs/plan6-audit.md`'s second pass closed.

### C4 — a citation that does not resolve

`src/server/thetanuts.ts:818-819` cites *"`docs/plan7-measurements.md` §9's
'`edge`-based scoring has no remaining call sites'"*. That checklist line is
plan 7 §9; `docs/plan7-measurements.md` has no §9. Trivial, and worth one
character of fix, because the whole method of this audit is following citations.

---

## Defects found — in neither audit

### D1 — the arena prints custody language for money nothing holds

This is the most dangerous thing in plan 7 as shipped, and it is not on any
checklist.

`src/views/BoxBuilder.tsx:1118-1121` renders, on every duel:

```
{usdc(room.stakeUsdc)} each · winner takes {usdc(poolOf(room.stakeUsdc))} · {room.durationMinutes} min
```

and at the reveal, `NO_FILL_COPY` (`:244-245`):

> Neither box was filled, so there is nothing to mark and no verdict is signed.
> **DuelEscrow's six-hour refund returns both stakes, rake-free, with no signature
> from anyone.** There is no tiebreak.

Neither claim has a contract behind it:

- `stakeUsdc` is an in-memory number clamped by `src/server/rooms.ts:117` and
  echoed back at `:68`. Nothing collects it.
- `useDuelStake` — the only escrow seam in the app — is constructed at
  `src/App.tsx:113` and called from `readyUp` (`:264`), `lockParlay` (`:273`) and
  `settle` (`:300`), all of which belong to the **seeded match flow**. The arena's
  `createArena` / `roomState` path never touches it.
- `README.md:505-506`: the escrow is "compiled, reviewed, and never deployed."

So a player who reads the strip believes two stakes are held and a refund is
guaranteed; in fact no USDC moved, no duel exists on chain, and the "six-hour
refund" is a property of a contract that has never been deployed. The copy is
*more* dangerous than a blank screen precisely because it is specific and
confident — it names the mechanism, the window and the rake.

The fix is a choice, not a bug hunt: escrow the arena's stake, or say plainly on
the strip that this pot is not yet on chain. Note that `Review`'s inert state
already models the honest version of this ("Buying is switched off in this build.
The position above is real and priced; nothing here can sign…", `:1904-1909`) —
the duel strip needs the same sentence.

### D2 — the long-only lock stops at the desk boundary

`src/desk/rfq.ts:448` declares `isLong: boolean`, and no phase of the four-phase
flow refuses `false`. `assertCollateralZero` (`:782`) shows exactly the pattern
this field is missing: a guard on the **built** request, before submission, with
its own error code. Today both callers pass `true` and `test/rfq.test.ts:1233`
pins the box path, so nothing is wrong on chain — but plan 7 §5's promise is
"no code path can construct a short leg", and the type that enforces it
(`CondorSpec.isLong: true`) is discarded one function later.

### D3 — the 18dp that survived `5644a1f`, and the fallback that makes it a trap

`5644a1f` fixed `CONTRACT_DECIMALS` from 18 to 6 in `src/desk/fill.ts:148` and
`src/server/thetanuts.ts:144`, against 362 live Base orders. A third constant of
the same name survives at `src/engine/parlay.ts:341` and is still `18`.

`src/server/thetanuts.ts:139-143` argues that one is *correct*, because the engine
"both writes (`toUnits`) and reads (`fromUnits`) with no SDK value in between — it
cancels". That is true of today's callers: `parlay.ts:740` and `:890` both set
`sizeDecimals: CONTRACT_DECIMALS` explicitly.

What makes it a trap rather than a private scale is `parlay.ts:439`:

```ts
const contracts = fromUnits(q.numContracts, q.sizeDecimals ?? CONTRACT_DECIMALS);
```

`vanillaPayout` is exported (`parlay.ts:433`, re-exported from
`src/views/ParlayPick.tsx:79`) and takes a public `PayoutQuery`. The first caller
who hands it a real `previewFillOrder` result — which carries `numContracts` and
no `sizeDecimals` — gets a silent factor of 10¹², which is the exact failure mode
`5644a1f` was written to remove ("a real fill of $1.00 … rendered `"0.0000"` and
scored as 2.5 × 10⁻¹³ contracts"). Not a live bug. One line of defence away from
being one: make `sizeDecimals` required on `PayoutQuery`, or drop the fallback.

### D4 — the ordinary box shows an upside figure with no downside figure

`BoxBuilder.tsx:1730-1743`: `MAX LOSS` renders `quoted && econ ? usd(econ.maxLoss)
: "—"`, while `MAX PAYOUT` renders `econ ? usd(econ.maxPayout) : "—"`. `econ`
exists as soon as a valid box does; `quoted` requires a premium.

The common case in the running app is an **unmatched** box, for which
`App.tsx:459-465` sets `boxPremium = null`. So the ordinary screen shows a green
`$60.00 per contract` under MAX PAYOUT and a red `—` under MAX LOSS. §4.3 is
satisfied positionally, and the explanatory sentence is right there ("Nothing has
priced this box yet, so there is no figure to print.", `:1735`) — but the only
state in which most players will see the arena's money panel is one where the
upside is a number and the downside is a dash. `test/boxbuilder.test.tsx:226`
only exercises the ordering with `premium={12.5}` supplied, so no test covers the
asymmetry.

Cheapest honest fix: when unquoted, render the bound that *is* known —
`preOfferMaxLossUsd` in `src/desk/boxauction.ts:307` already computes exactly it
("at most your max bid, and all of it") — or suppress MAX PAYOUT until there is a
premium, so the two rows appear and disappear together.

---

## Method notes, so this can be re-run

Every row above was produced by one of: a `grep` whose exact pattern is quoted,
a `file:line` read in full, or a named test executed at HEAD. Nothing was taken
from a commit message; where a commit message and the code disagree (C2, C3),
the disagreement is the finding.

The four test files re-run this pass are the fastest way to re-check rows 5, 7,
8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26 and 27:

```
bun test test/box.test.ts test/boxbuilder.test.tsx test/boxduel.test.tsx test/rfq.test.ts
```

Rows 1, 2, 3, 4, 6, 13, 20, 28 and 29 are greps and reads, and their patterns are
in the Evidence column verbatim.

---

# Second pass — three PARTIALs and a README close, 2026-09-05, HEAD `01da9fd`

Scope is narrow, same rule as `docs/plan6-audit.md`'s later passes: only the
rows this file left open, re-verified against the tree rather than against a
commit message. Nothing below rewrites the table above — the first-pass
verdicts stay exactly as written, because they show what was true when they
were taken.

Three commits landed between the first pass (HEAD `8b457f2`) and this one:
`0541a70` and `a760ce8` ("the arena stops promising money nothing holds" / "…
and the tripwire grows teeth"), and `28c8551` ("the last three audited
PARTIALs — and the ranger trap has a number"). Plus this session's own edit to
`README.md`'s "Live arena" section, which is row 6's own fix.

## Row 12 — `isRanger` — **PARTIAL → PASS**

The first pass found the ranger half of the property test thin (fixture-only,
n=2) and `isRanger` itself vacuous — no call to `calculatePayoutAtPrice` or
`calculateMaxPayout` anywhere in `src/`. `28c8551` closes the vacuity, which
was the sharper half of the finding: `src/data/ranger.ts:609-615` —
`rangerPayoutOrder(spec)` — is now **the only constructor** of a
`RangerPayoutOrder` in the repo, it sets `isRanger: true` unconditionally
(`:613`), and both SDK helpers are only ever called through it
(`:628 calculateMaxPayout(rangerPayoutOrder(spec), …)`, `:644
calculatePayoutAtPrice(rangerPayoutOrder(spec), …)`) — the first live callers
of either helper this repo has had. A test now locks the trap the commit
message describes finding: `test/box.test.ts:1340` asserts a flagged order
prices as a ranger, `:1346` constructs the same order unflagged, and
`:1367`/`test/market-builder.test.ts:1372` assert a ranger fed to either
helper without the flag prices as a `call_condor` instead — silently at half
the correct collateral (measured: 1000 USDC flagged vs 500 unflagged on the
same four strikes). The fixture-only property-test half of the original
finding is unchanged (still `test/box.test.ts:921,1214`, still n=2 on this
capture) — narrower than a property test over every matching box, but the
part of row 12 that was actually dangerous (an unflagged call reachable at
all) is closed.

## Row 17 — short leg via RFQ — **PARTIAL → PASS**

The first pass found `RfqInput.isLong: boolean` at the desk boundary — both
callers happened to pass `true`, but nothing refused `false`. `28c8551`
closes it exactly the way **D2** below recommended: `src/desk/rfq.ts:467` —
`isLong: true;` — is now the literal type, and `:1228` —
`if (input.isLong !== true) return raise("SHORT_REFUSED", "cap");` — refuses
in the cap phase, above every dependency, the same place `assertCollateralZero`
guards `collateralAmount`. A short leg now cannot compile (`@ts-expect-error`
on `{ isLong: false }`, already asserted at the data layer) **and** cannot
reach a dep at the desk layer even if a caller coerced past the type. Defect
**D2** is closed by the same commit; see below.

## Row 24 / Defect D1 — the refund promise — **PARTIAL → PASS**

The first pass's sharpest finding: the arena printed "DuelEscrow's six-hour
refund returns both stakes, rake-free" and a `winner takes $X` pot line, for a
contract that is compiled, reviewed, and never deployed, on a stake that is an
in-memory number nobody ever escrows. `0541a70` and `a760ce8` fix this by
choice, not by building the missing path: `src/views/BoxBuilder.tsx` now
carries a `DuelCustody` seam (`escrow` address + `refundHours`, `:269-275`)
that every claim about custody is gated on, defaulting to `null` — the honest
state — everywhere `App.tsx` constructs it today. `stakeBasisLine` (`:285`)
prints "notional · nothing is held" without custody and only prices a "winner
takes" pot with a named escrow; `NO_FILL_COPY` (`:355`) now reads "Nothing was
staked on this duel, so there is nothing to return" instead of naming a
mechanism, a window and a rake. Verified live: `grep -n "six-hour refund"
src/views/BoxBuilder.tsx` returns exactly one hit, `:253`, inside the docblock
recording this history — not in any rendered string. A screen-scanning
tripwire (`a760ce8`) mounts all four player states and greps rendered text for
"winner takes", "refund", "rake", "escrow", "both stakes", "the pot", with the
disclaimer node itself pinned to its exact copy so the exemption cannot
smuggle a promise back in; the commit message records verifying it by
reinstating each old sentence and watching the tripwire fail by name. The
literal escrow refund *path* plan 7 §6.1 describes still does not exist —
`DuelEscrow` is still not deployed, and that is unchanged and owner-only — but
the checklist item's substance, that an unfillable promise not be printed as
fact, is now true rather than merely asserted.

## Row 6 — README names the price source — **PARTIAL → PASS**

Closed by this session's edit to `README.md`'s "Live arena" section: it now
names Chainlink-on-Base as the arena's price-history feed
(`src/data/history.ts`), repeats the TWAP settlement caveat, and the "Parlay ·
RFQ" / "Find a difference" bullets this row's own evidence quoted are gone —
replaced with what the one remaining mode, the box, actually is.

## Defect D2 — closed alongside row 17

Covered above: `RfqInput.isLong` is the literal `true`, and `assertLongOnly`
(`rfq.ts:1228`) refuses a coerced `false` in the cap phase. No further action.

## Second-pass scoreboard

**PASS 27 · PARTIAL 0 · FAIL 0 · OWNER-ONLY 2.**

Every row that was open at the first pass is now closed except the two rows
no agent can close: 28 and 29, one real `RANGER` fill and one real
`CALL_CONDOR` fill on Base, each with a Basescan link in the README. Re-checked
this pass: `grep -rn "basescan.org/tx" README.md docs/` returns nothing but
this file's own descriptions of the absence, and `App.tsx` still mounts
`<BoxBuilder>` with no `onConfirm` (`grep -n "onConfirm" src/App.tsx` finds
only the docblock explaining why it is deliberately not wired to the duel
lock) and `RfqPanel` still has no mount anywhere in `src/` outside its own
tests — so rows 28 and 29 remain not just owner-only but, as the first pass
found, currently unreachable from the running app as well. Building the mount
is not this file's job; recording that it still has not happened is.

---

# Third pass — three overstated claims, corrected without touching a verdict, 2026-09-05, HEAD `e090a10`

Same rule as the second pass: nothing below moves a verdict. All three rows
stay exactly what they were — **PASS**. What was wrong was a claim made *about*
the evidence, not the evidence itself. Found by re-reading the second pass's
own citations against the current tree rather than trusting the line numbers.

## Row 12, second pass — "the first live callers" overclaims what "live" means

The second pass is right that `rangerPayoutOrder` is the only constructor of a
`RangerPayoutOrder` and that `isRanger: true` cannot be bypassed — that closed
the actual trap and the **PASS** stands. But "the first live callers of either
helper this repo has had" reads as *reachable from the running app*, and it
is not. Current line numbers: `rangerPayoutOrder` is `src/data/ranger.ts:639`;
`rangerMaxPayout` (`:657`) calls `utils.calculateMaxPayout(rangerPayoutOrder(spec),
numContracts)` at `:662`; `rangerPayoutAtPrice` (`:672`) calls
`utils.calculatePayoutAtPrice(rangerPayoutOrder(spec), numContracts, settlementPrice)`
at `:678`. But:

```
$ grep -rn "rangerMaxPayout\|rangerPayoutAtPrice\|rangerPayoutOrder" src/ | grep -v ranger.ts
(no output)
```

Nothing in `src/` outside `ranger.ts` itself calls any of the three. The only
callers anywhere in the tree are `test/box.test.ts` (`:100`, `:1345`, `:1384`,
`:1414`) and `test/zone-units.test.ts` (`:27`, `:158-184`). So the SDK's
`calculateMaxPayout`/`calculatePayoutAtPrice` are, today, called from exactly
one place in `src/` each, and that place has never itself been called by
anything the running app reaches — `zoneEconomics` and `condorEconomics`
(row 15) answer the arena's actual money questions, and neither of them calls
either SDK helper. The real, worth-stating achievement is narrower than "first
live callers": **an unflagged call to either SDK helper is now structurally
impossible to write**, because `rangerPayoutOrder` is the only constructor and
it hardcodes the flag. That it is not yet a live call site is a fact about
what the arena has built on top of `ranger.ts`, not a gap in `ranger.ts`
itself.

## Row 15 — stale line, and the routing has one more hop than stated

`zoneEconomics` moved: it is `src/data/ranger.ts:710` today, not `:543`
(the file has grown since the first pass). `multipleOf` moved too —
`src/data/condor.ts:297`, not `:294`; `payoutMultiple` is still `:273`. The
row's substance holds, but "both route through it" undersells the
indirection by one layer: neither `payoutMultiple` nor `zoneEconomics` calls
`multipleOf` directly on the listed path. `zoneEconomics` (`ranger.ts:710-716`)
and `condorEconomics` (`condor.ts:354-360`) both call the shared `economics()`
(`condor.ts:398-419`), and `economics()` is the one place that calls
`multipleOf` (`:414`). So the chain is `zoneEconomics` → `economics` →
`multipleOf`, not `zoneEconomics` → `multipleOf` — the same single division,
one hop further from either caller than the row implies.

Unlike row 12's helpers, `zoneEconomics` is a real, live call site:
`src/views/BoxBuilder.tsx:840` (`positionEconomics`, the arena's actual money
panel for a matched listed zone) and `:2522` (a zone chip's ticket). Both are
reachable from the running app, not test-only — this row was never the one
with the reachability problem.

## Row 24 / D1, second pass — the grep proves less than it was read as proving

The second pass's `grep -n "six-hour refund" src/views/BoxBuilder.tsx` really
does return exactly one hit, in the docblock — that part is accurate. What it
cannot show is whether the *reveal's own custody sentence* still exists in
some other shape, because that sentence is not a literal string: `noFillCopy`
(`BoxBuilder.tsx:506-513`) builds it by interpolation —

```ts
`no tiebreak. DuelEscrow's ${custody.refundHours}-hour refund returns both stakes, ` +
"rake-free, with no signature from anyone."
```

— so with `custody.refundHours` at, say, 6, the *rendered* text would read
"DuelEscrow's 6-hour refund returns both stakes" without the source ever
containing the literal word "six". A grep for "six-hour refund" cannot see
this by construction, the same way it could not have seen the original defect
if `refundHours` had been a variable back then too. The docblock immediately
above the function says so itself (`:496-504`): this branch is "unreachable
today by construction" because `App.tsx:607` passes `custody={null}`
unconditionally, and it stays unreachable only because every caller keeps
passing `null` — nothing in the type system stops a future caller from naming
a deployed escrow and reviving the sentence. The **PASS** is earned, same as
the second pass found, but by the branch being unreachable, not by the grep
having proven the sentence gone. A tripwire that mounted the custody branch
itself (with a fake `DuelCustody`) and asserted its text, rather than grepping
source for a phrase that can be reassembled from a variable, would prove the
thing the second pass believed it had already proven.

### Third-pass scoreboard

**PASS 27 · PARTIAL 0 · FAIL 0 · OWNER-ONLY 2** — unchanged. No verdict moved;
three citations did.
