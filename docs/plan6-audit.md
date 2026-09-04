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

## The one-paragraph summary

Plan 6's *engine* landed and is excellent: `TIERS` is genuinely gone, the tier is
genuinely a delta band, the gate is genuinely a pure measurement, the fill
genuinely caps the slip sum and shows its degradation policy before you sign, and
the attestor genuinely re-derives its own verdict from one frozen snapshot. Plan
6's *UI* landed in half. The detail levels and the card face are wired; the live
card path and the asset gate are not. **`cardsForSlice`, `multipleAt`,
`spinSlice` and `qualifiedAssets` have zero production call sites**, so several
boxes that read as done are true of a unit test and false of the running app.
Nothing here is broken; some of it is merely unplugged, and a green suite hides
exactly that. Two boxes cannot be closed by any agent: nobody has spent a cent on
Base from this repo.

## The table

| # | §9 item | Verdict | Evidence |
|---|---|---|---|
| 1 | `TIERS` no longer exists anywhere in the tree | **PASS** | `src/engine/parlay.ts` exports `TIER_BANDS:67`, `tierOf:77`, `tierProb:95`, `tierOdds:108`, `TIER_MOVE:126` — no `TIERS`. The only `TIERS` in `src/` is `src/data/rewards.ts:25`, the MINNOW→WHALE rank ladder that §E1 says to keep, re-exported as `RANK_TIERS` by `src/engine/rank.ts:21`. Doc rot: `src/data/spot.ts:179-180` still cites `TIERS.SHARP.prob` and "`TIERS` and `summarize()` are pinned" as a live pin. Comment only — not my file, not fixed. |
| 2 | Every rendered multiplier traces to a live `ask` or to `calculatePayout` | **FAIL** | `multipleAt` (`parlay.ts:600`) is the only function that calls `calculatePayout`, and it has **zero call sites** outside its own module. The screen that renders card multipliers, `src/views/ParlayPick.tsx:404`, prints `quote.multiplier` from `src/desk/optionize.ts:277 multiplierFor` — a hand-rolled `PAYOFF_REFERENCE_MOVE × K/S ÷ premium`, clamped to `[MULT_MIN, MULT_MAX]` — or falls back to `leg.mult` = `tierOdds(tier)` = `1 / band midpoint`. The first is neither; the second is not a live ask either. |
| 3 | Max loss on every card face, at every detail level, above the upside figure | **PASS** (closed mid-audit) | `src/components/ParlayCardFace.tsx` now renders every face from one ordered contract: `CARD_FACE_ORDER` (`src/state/detail.ts:127`) puts `maxLoss` before `payout`, so "above the upside figure" is **structural, not stylistic** — there is no branch that could drop it. `test/detail.test.ts` asserts it at all three levels; 52 pass / 0 fail. Was PARTIAL at first pass, when the face was inline in `ParlayPick.tsx` and no detail level existed at runtime. On the seeded path the line still reads `max loss — · no live premium` rather than a number, which is the honest render — a made-up dollar figure beside a real one is worse than a dash. |
| 4 | `MINNOW/FISH/SHARK/ORCA/WHALE` is the only rank ladder | **PASS** | `src/data/rewards.ts:25`, pinned name-for-name and threshold-for-threshold by `test/rank.test.ts:58-68`. A grep for bronze/silver/gold/platinum/diamond/novice/rookie/apprentice/legend/master across `src/` finds no second ladder. |
| 5 | Detail level is a visible toggle, reversible in both directions, never locked | **PASS** (closed mid-audit) | `src/views/ParlayPick.tsx:42,44` import them for real; `:169` takes the rank-defaulted level via `useCardDetail(rankAt(…).tier)`; `:281` mounts `<DetailToggle level onChange>`. `test/detail.test.ts:516` asserts all three levels are on screen at once with the live one pressed — a switch, not a lock, reversible in both directions. Was **FAIL** at first pass, when the toggle had zero imports outside its own module and its test. |
| 6 | A test greps the card components for "moneyness" / "implied volatility" | **PASS** | `test/detail.test.ts:376 BANNED`, over a runtime glob of card surfaces (`:388`, so a new card file is covered the moment it lands), comment-stripped at `:412`, with non-vacuity guards at `:456` and `:478` and a "does the ban catch what it names" control at `:502`. `moneyness` survives in `src/data/spot.ts` and `src/desk/optionize.ts` as a maths variable — explicitly out of scope at `:384`, which is the right call. |
| 7 | `test/determinism.test.ts` still passes, market data injected not imported | **PASS** (closed mid-audit) | Green on re-run. The injection design is genuine and is the substance of the item: `spinSlice(book, qualified, seed)` at `src/engine/spin.ts:294` takes the book **and** the qualified list as arguments, and `ASSET_GATE_RE` (`test/determinism.test.ts:107`) additionally bans engine modules from importing `data/qualify` — a reel that computes its own universe is one refactor from a reel that computes its own prices. **Worth recording, because it will recur:** at first pass this had 7 failures, and one of them was a *false positive* — the boundary scan at `:133-138` is a raw text match with **no comment stripping**, so `score.ts`'s docblock merely *naming* `src/server/thetanuts.ts` tripped it exactly as an import would. The sibling scan at `test/detail.test.ts:412` has a comment stripper; this one does not. See finding 2 below. |
| 8 | A card with no qualifying quote renders a dead slot, and a test asserts it | **PARTIAL** | The engine does it and the engine test asserts it: `cardsForSlice` returns `null` per slot (`parlay.ts:556`), `test/parlay.test.ts:449` — "a dead slot is the honest answer, and the grid keeps its shape" — pins seven dead slots in place. But `cardsForSlice` has **zero production call sites**. `ParlayPick.tsx` still deals all eight `PARLAY_CARDS` unconditionally and prints `max loss — · no live premium` where there is no quote. **No UI ever renders a dead slot.** |
| 9 | `MAX_FILL_USDC` checked against the leg sum, with a test that steps over it | **PASS** | Four checks in `src/desk/fill.ts`: `:1481` per requested leg, `:1492` the requested sum, `:1633` each previewed leg, `:1642` the previewed total. `test/fill.test.ts:901` steps a leg over the cap; `:885` asserts every leg under it. (`test/fill.test.ts` has 3 in-flight typecheck errors from the branded-units change — unrelated to this item.) |
| 10 | No `MaxUint256` approval anywhere; a test asserts it is never passed | **PASS** | Every `MaxUint256` occurrence in `src/` is a comment forbidding it — `fill.ts:942`, `fill.ts:1704`, `escrow.ts:725`, `rfq.ts:~1290`. Assertions: `test/fill.test.ts:548`, `:1160` (each leg its own collateral, never the slip total), `:1188` ("at any slip size"); `test/duel-stake.test.ts:297` — and `:306` is stricter than the checkbox, refusing even one base unit over. `test/rfq.test.ts:343`. |
| 11 | Partial-fill policy is on screen before the first signature | **PASS** | `src/desk/fill.ts:1047 PARTIAL_FILL_POLICY` — one exported sentence, carried on the slip quote at `:1202`/`:1663` so the confirm screen structurally cannot omit it. Rendered at `src/views/Parlay.tsx:1560` and again at `:1678`. |
| 12 | `duelScore` is pure and driven off a frozen fixture in tests | **PASS** | `src/engine/score.ts:340` — no clock, no network, marks passed in as one map for both players. `test/score.test.ts` builds every leg through a single `leg()` helper against one frozen `BOOK` (four instruments: two up, one down, one flat — the four signs the formula must get right). Caveat: score.ts has 1 in-flight typecheck error and its docblock breaks the determinism scan (item 7). |
| 13 | The attestor derives the verdict from its own snapshot, never from client input | **PASS** | `src/server/attest.ts:1773-1777` — **one snapshot, both players**, through `duelOutcome`. The snapshot is frozen onto the lock by the first in-window attest (`:592-598`) so a re-attest cannot re-roll it; `:998` refuses to sign a verdict it cannot re-derive; `:1313` signs nothing when a leg is unmarkable, falling through to the six-hour refund. |
| 14 | **No hardcoded `"ETH" \| "BTC"` union survives anywhere** | **PARTIAL — one of two fixed** | Two live sites at audit time. **`src/desk/rfq.ts:256` — FIXED** (see below). **`src/server/thetanuts.ts:345`** — the `getPricingArray` dep signature; another agent's file, reported not edited. It is narrower than the SDK's own `RFQUnderlying` (eight members), and FINDINGS §3 records that the other six return `[]` rather than throwing — so the honest shape is the eight with an empty answer, not a two-member gate. `scripts/probe-assets.ts:256` casts `underlying as "ETH" \| "BTC"` at the call site, documented at `:246`; that is a mirror of the signature above, not an independent claim, and it resolves when the signature does. |
| 15 | `qualifiedUnderlyings` is pure, fixture-driven, enforces all four conditions | **PASS as a module — unwired in the app** | `src/data/qualify.ts:526`; thresholds `MIN_ORDERS:52`, `MIN_GREEKED:63`, `MIN_DEPTH_USDC:75`; all four conditions in `probeAssets:401`; per-condition reasons at `:103-107`. `test/qualify.test.ts` runs the real gate over `test/fixtures/orders.json` (loaded at `:37`, not hand-built). **But no runtime call site**: the only three `data/qualify` imports in `src/` — `data/sectors.ts:3`, `ui/LobbyCards.tsx:5`, `views/CreateLobby.tsx:11` — are all `import type`. `CreateLobby` takes `live?: readonly QualifiedAsset[]` (`:349`) and `src/App.tsx:440-457` never passes it, so `qualified` is always `[]`. |
| 16 | Feed aliases deduplicated by address — a test asserts ETH appears once | **PASS** | `feedIndex` at `src/data/qualify.ts:237`. `test/qualify.test.ts:78` first proves the fixture really does hold identical addresses for `ETH` and `ETH/USD`; `:116` asserts `ETH/USD` is absent from the output names; `:131` asserts dedup happens by address and not by key; `:136` covers case-folded addresses. |
| 17 | `scripts/probe-assets.ts` runs against the live book and its output is committed | **PARTIAL** | The script exists; `--fixture` and `--help` are exercised end-to-end by shelling out (`test/qualify.test.ts:555-655`, including output stability at `:648`); `docs/asset-gate.md` is committed. **But the committed live run is a failure notice, not a table** — `BOOK UNREACHABLE`, exit 1. The only committed table is the `--fixture` run over the frozen 2026-09-04T09:31Z capture. See the outage section below. |
| 18 | A sector with no qualified members renders greyed with a reason, not hidden | **PARTIAL** | `src/data/sectors.ts:241 NO_BOOK_REASON = "no live book today"`, `liveSectorStatus` at `~:248`, rendered greyed with the explanation at `src/views/CreateLobby.tsx:486-488`. But because `live` is never passed (item 15), **every** live group greys — the screen is technically correct and carries no information, because nothing measured. Both files are mid-flight. |
| 19 | DEEP/THIN grade on the lobby card and the slice reveal | **PARTIAL** | Lobby card: `src/ui/LobbyCards.tsx:51-54`, `:128`, `:238`, reading an **optional** `grades` prop no caller supplies. Create screen: `src/views/CreateLobby.tsx:287-292`, defaulting to `"THIN"` for every symbol when the map is empty — so the grade currently renders a fixed word rather than a measurement. **Slice reveal: absent** — `spinSlice` has no call sites and no reveal surface renders a grade. |
| 20 | One end-to-end fill on Base, under $2, with a Basescan link in the README | **OWNER-ONLY — not done** | There is no `basescan.org/tx` link in `README.md` or anywhere under `docs/`. **No fill has ever executed on Base from this repo.** The code path is complete and wired (`runParlayFill`, `src/views/Parlay.tsx:1377`) and flag-gated behind `THETADUEL_TRADE=on`; every seam up to the RPC boundary is tested against injected fakes. Nobody has spent a cent. Only the owner can close this. |
| 21 | **A second end-to-end fill on a non-ETH/BTC underlying**, same evidence | **OWNER-ONLY — not done, and blocked upstream** | Same evidence: none. Additionally blocked by the book-endpoint 404 below — the qualified set cannot currently be measured against a live book, so the asset to fill on cannot be chosen honestly. Only the owner can close this. |

### Scoreboard

**PASS 12** · **PARTIAL 5** · **FAIL 1** · **OWNER-ONLY 2**

(First pass, before three rows closed mid-audit: PASS 9 · PARTIAL 6 · FAIL 3.)

The one remaining FAIL (item 2) and four of the five PARTIALs (8, 15, 18, 19)
reduce to a single root cause: **plan 6 built some modules and did not wire them
into the views.** Two clusters remain:

- **The card path.** `cardsForSlice` and `multipleAt` have no production call
  site, so `ParlayPick` still deals eight seeded cards priced by
  `optionize.multiplierFor`, never renders a dead slot, and never shows a
  multiplier that came from the protocol's own `calculatePayout`. Closes items 2
  and 8.
- **The gate path.** `qualifiedAssets` has no production call site; the only
  `data/qualify` imports in `src/` are `import type`. `CreateLobby` accepts
  `live?: QualifiedAsset[]` and `App.tsx` never passes it. Closes items 15, 18
  and 19 in one edit.

`spinSlice` also has no caller, which is what leaves the DEEP/THIN grade off the
slice reveal. All of it is plumbing over code that already exists and is already
tested — the highest value per line currently available in this repo.

## 🔴 The live book is 404ing — demo-critical

Re-verified during this audit, 2026-09-05, from this machine:

| URL | Response |
|---|---|
| `https://indexer.thetanuts.finance/api/v1/book` | **404** |
| `https://indexer.thetanuts.finance/api/v1/orders` | **404** |
| `https://indexer.thetanuts.finance/api/book` | **404** |
| `https://indexer.thetanuts.finance/api/state` | **200**, live, at chain head |

The first of those is the `indexerApiUrl` baked into
`@thetanuts-finance/thetanuts-client@0.3.0`'s Base chain config, and the only URL
`fetchOrders()` ever asks for. `https://pricing.thetanuts.finance` also serves
live MM quotes. **The indexer is up; that one route is not where the SDK thinks
it is.**

- **Effect:** the asset-gate probe cannot read a live book, and `/api/market`
  falls back to its last good snapshot and labels itself `stale` rather than
  pretending (`src/server/thetanuts.ts:1578`).
- **The fix is a URL, not a refactor.** `indexerApiUrl` is overridable in the
  client config. Ask the protocol team for the current book endpoint — this is
  the single highest-value question to put to them, and it blocks the §7 demo
  beat that plan6 §10 says is the one that lands.
- A second, machine-local problem stacks on top: TLS interception here makes the
  SDK's Node HTTP agent report `unable to get local issuer certificate`. Bun's
  own `fetch` (different CA store) reaches the host fine. Run the probe from an
  un-intercepted network before any demo.
- **Demo-safe path today:** `bun run scripts/probe-assets.ts --fixture` runs the
  identical gate and the identical formatter over a genuine frozen capture,
  banner-marked so it can never be mistaken for a live table. It proves the
  method, which is what §10's third claim actually needs.

Long-form write-up, with the raw output of both runs:
[`docs/asset-gate.md`](asset-gate.md).

## The `rfq.ts` union — decided and changed

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
comment collapsed the MM-pricing set (two) onto the price-feed set (eight), which
is precisely the conflation §7 exists to kill and precisely what once made AVAX
the broken default asset.

The counter-argument was weighed and rejected. RFQ *is* MM-dependent, and a
sealed-bid request on DOGE will very likely get no bids. But **"nobody bid" is
already a first-class state in this module** — `awaitOffers` returns `unanswered`,
not an error, because a sealed-bid auction with no bidders is the protocol
working, not failing. A type that refuses the request in advance pre-answers a
question only the makers can answer, and answers it wrong for six assets.
Nothing in `rfq.ts` branches on the value: it is threaded to the SDK's builder
and written into a public breadcrumb, and `RfqBreadcrumb.underlying` was already
`string`, so the file was internally inconsistent as well.

**Changed:** a new exported `RfqUnderlying` mirroring the SDK's eight, with the
reasoning in its docblock so the next reader does not re-litigate it.
`src/ui/RfqPanel.tsx` still offers ETH and BTC from its own `TRADABLE` list —
that is a **product** decision about where a bid is likeliest, and it stays a
subset of the union. Four tests in `test/rfq.test.ts` hold the line: the union
must equal the SDK's declaration (read out of the `.d.ts`, so an SDK bump fails
loudly), all eight reach the builder unchanged, an AVAX request produces the same
call sequence and breadcrumb shape as an ETH one, and `TRADABLE` must stay inside
the union. `bun test test/rfq.test.ts` → **60 pass / 0 fail**.

## Things worth fixing that are outside this audit's file grant

Reported, not edited.

1. **`src/server/thetanuts.ts:345`** — the surviving `"ETH" | "BTC"` union
   (item 14). Widening it to the SDK's eight matches the protocol's own typing
   and the FINDINGS §3 fact that the other six return `[]` rather than throwing;
   `scripts/probe-assets.ts:256`'s cast then becomes unnecessary.
2. **`test/determinism.test.ts:139`** — the boundary scan matches raw file text
   with no comment stripping, so an engine docblock that merely *names*
   `src/server/thetanuts.ts` fails the build identically to an import. It cost
   this audit a false FAIL on item 7, and it was worked around by rewording the
   docblock rather than fixing the scan, so it will happen again. Give it the
   comment stripper `test/detail.test.ts:412` already has. A scan that cannot
   tell an import from a sentence about an import trains people to stop writing
   the sentence — which is the opposite of what this codebase wants.
3. **`src/data/spot.ts:179-180`** — a comment still citing `TIERS.SHARP.prob` and
   describing `TIERS` / `summarize()` as pinned. `TIERS` is gone; the sentence
   teaches the next reader a constant that does not exist, and it is the kind of
   rot that makes someone re-add it.
4. **The wiring, and it is two edits:** pass `qualifiedAssets()` into
   `CreateLobby` from `src/App.tsx:440` (closes items 15, 18, 19), and drive
   `ParlayPick`'s cards off `cardsForSlice` / `multipleAt` instead of
   `optionize.quoteFor` (closes items 2 and 8). Everything both edits need is
   already written and already tested.

@see `plan6-real-parlay.md` §9, §10 · `docs/asset-gate.md` · `docs/HANDOFF.md`
