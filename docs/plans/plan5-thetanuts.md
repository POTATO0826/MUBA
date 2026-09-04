# Thetanuts SDK integration — THETADUEL goes on-protocol

> Supersedes the previous plan in this file (the three polish items — all shipped in commits `c9254f1`/`051889b`).

## Context

THETADUEL is complete as a game (7 waves + wallet layer, 344 tests, branch `zq`) but every market number is seeded fiction and the home hero's claim — "Options pricing streams live from Thetanuts on Base" — is false. The owner wants the project genuinely connected to Thetanuts: use their SDK/contracts where they exist and are usable, build our own where they don't, with every SDK problem treated as a first-class item (dispositioned, not ignored).

Three research tracks completed (hansen-branch SDK code · zq seam map · live protocol verification). Owner's locked decisions:

1. **Hybrid settlement** — live Thetanuts data anchors everything visible; the duel stays the seeded, replayable sim.
2. **Real USDC stakes on Base mainnet** via a custom minimal escrow contract we write (Thetanuts has no wager primitive — verified). **No stake cap, 4% rake** to an app treasury (owner's call; risk stated: uncapped + unaudited on mainnet means a contract bug risks whatever players stake — mitigations: minimal contract, adversarial review before deploy, treasury withdraw can only touch accrued rake, unconditional timeout refund).
3. **App-signed settlement** — the escrow pays the winner against our server key's signature.
4. **Real option fill on /desk is IN scope** at minimal notional — target a ~$0.01 fill (partial fills by USDC amount are supported; no documented minimum), hard-coded notional cap in our code, fallback ladder $0.10 → $1 if the book rejects penny fills at demo time; every fill tagged with our referrer address.

## Research verdicts (evidence-backed, live-verified 2026-09-04)

**What Thetanuts offers that we can use:**
- SDK `@thetanuts-finance/thetanuts-client@0.3.0` (latest; MIT; public repo). Read modules keyless; write modules take an ethers-v6 signer.
- **Live signed order book** (ETH + BTC only) via open API — 130+ orders with greeks/IV inline; `client.optionBook.fillOrder(order, usdcAmount, referrer)` executes a real option buy in one approval + one tx. **This is the flagship integration path** — plus `claimReferrerFees()` provably attributes every trade to our app.
- MM two-sided pricing (`getPricingArray('ETH'|'BTC')`), spot for 7 crypto assets, 8 Chainlink-on-Base price feeds in `chainConfig`, WebSocket stream, position/history indexers.
- SDK 0.3.0 fixed the 0.2.5 limitation our `tnuts-test/FINDINGS.md` recorded: multi-leg + RANGER payout math now works off-chain.
- Hansen's branch contains an author-declared **known-good** server/client market-read layer (15s cache, stale-on-failure, median-IV edge signal) that transplants like the wallet layer did.

**What doesn't fit (headline items — full table in the plan body):**
- **Only ETH + BTC are tradable options**; 7 assets have spot; our board has 18 (9 equities have zero Thetanuts presence). → Hybrid keeps the full board seeded; *real-trade* surfaces are ETH/BTC-scoped and labelled.
- **RFQ is a 4-phase multi-transaction protocol** with MM-dependent fills — too slow for the duel loop. → Scoped out of the game loop; `fillOrder` against the resting book is the fast path.
- **No testnet exists** (Base mainnet + an Ethereum-vaults-only deployment). → Mainnet with hard-coded cent-level stake caps.
- **No escrow/wager primitive.** → Custom ~100–150-line USDC escrow (per decision 2/3).
- **Docs have verified errors** (the LLM-context file contradicts shipped code in 8 places; one docs page still shows ethers-v5/Arbitrum; two pages disagree on the OptionBook address). → Trust the shipped `.d.ts`; resolve addresses at runtime from `client.chainConfig`.
- **Public Base RPC throttles** and book depth swings several-fold intraday. → Private RPC key required; `previewFillOrder` guard + graceful "no fill available" UX.
- **greeks/IV arrive via an undocumented field** (`rawApiData.greeks`). → Runtime shape-check with an "unscoreable" path.

**zq structural facts the plan must respect:**
- `/desk` is a zero-risk live landing zone (outside the match path, no pinned tests, its UI already names the SDK calls).
- Settlement funnels through one function (`pctAt`); 4 absolute price locks in `test/determinism.test.ts:176-193` pin the seeded tape; the determinism source-scan regex does **not** yet cover market modules and must be extended before any live market code lands.
- Money choke points: `stakePointsFor` (the ×1000 bridge), `useLedger`, and two `App.tsx` call sites; `readyUp` is sync and needs a pending state for on-chain staking.
- `getSigner()` is fully built with zero callers — the write path is waiting.

## Digest corrections the design verified (builders: these outrank earlier notes)

- **C1/N5**: referrer fee methods are `claimFees(token)`/`claimAllFees()`; an un-whitelisted referrer's split is **0 bps** — surface as attribution (`SPLIT 0 bps — not yet whitelisted`), never as revenue. Owner action: request whitelisting from Thetanuts.
- **C4**: there are **five** hardcoded-spot sites, not three — `ParlayPick.tsx:146`, `MatchSpin.tsx:154` & `:273`, `payoff.ts:59`, and the JSX literal `SPOT 4,182` at `views/Parlay.tsx:120` (the one that would keep lying).
- **C3**: /desk is *nearly* zero-risk — `app.test.tsx:122-124` pins the strings `Combined payoff at expiry` and `MM pricing`; both must survive.
- **New doc contradictions #9/#10** (append to FINDINGS): `previewFillOrder` is documented two incompatible ways (code to the richer 11-field shape, read defensively); the docs' `OrderWithSignature` page actually describes `rawApiData` — hansen reading `entry.rawApiData.priceFeed` is correct and must be comment-protected.
- **C6**: SDK 0.3.0's RANGER/multi-leg payout support is changelog-verified but **unverifiable offline until installed** — P0.3's `.d.ts` gate decides P2's branch.
- OptionBook address **conflicts across two official doc pages** — resolve at runtime (`chainConfig` cross-checked vs `rawApiData.optionBookAddress`, order's address wins), never hardcode.

## Implementation plan (phases; each ends demoable, typecheck clean, full `bun test` green, one commit on `zq`)

### P0 — Guardrail, install, verify (~1.5h) — BLOCKS EVERYTHING
1. **Extend `test/determinism.test.ts` FIRST**: add `LIVE_MARKET_RE = /data\/thetanuts|server\/thetanuts|\/api\/market|\/api\/attest|\/api\/lock|thetanuts-client/` beside `LIVE_NEWS_RE` (:46), fold into the offender scan, extend the narrowness meta-test (:84) with positive AND negative cases (dry-run verified: zero matches today, lands green). ⚠ `engineFiles() >= 6` floor (:65): P2's payoff move leaves exactly 6 — the budget is spent; say so in the commit.
2. `bun add @thetanuts-finance/thetanuts-client@^0.3.0` (bun, not npm; SDK pulls axios+viem+ethers as hard deps — keep reads server-side to protect the bundle).
3. **The `.d.ts` gate**: grep the installed types for `PayoutType`/`previewFillOrder`/`ensureAllowance`/`claimFees`; record a "0.3.0 delta" section in `tnuts-test/FINDINGS.md` (tnuts-test itself stays at 0.2.5 — it's the provenance).
4. `/api/config` route (supersets `/api/wallet-config`, kept as alias): projectId, chainId, referrer, escrow, features `{market: opt-out, stake: opt-IN, trade: opt-IN}` — money-moving features default OFF. `.env.example` gains the full inventory (below).

### P1 — Live market layer (~4h) → /desk shows the real Base book
- Transplant hansen's `src/server/thetanuts.ts` with 4 adaptations: split pure `buildSnapshot(raw, at)` from `createMarketService({client, now})` (mirrors `createNewsService` — makes the untested book-builder testable); client ctor gains `referrer` + `logger`; `resolveOptionBook()` runtime resolution with `agreed` flag + amber chip; `greeksOf()` shape-check (greeks are undocumented — `rawApiData.greeks`) + `greeksSeen` count with `GREEKS UNAVAILABLE` degrade. Improve RANGER heuristic: 4 strikes with equal wing widths = RANGER, else CONDOR (`classify()` → new `PricingRow.structure?`).
- `src/types.ts`: `PricingRow` += optional `edge?`, `mid?`, `structure?` (mock still typechecks).
- `src/data/market.ts`: widen `MarketSource` with `meta: MarketMeta {ok, source: "mock"|"live"|"stale", fetchedAt, note?}` + `spot(u): number|null` — **accessors stay sync** (the fetch resolves before the source is built; no Suspense). Mock: `fetchedAt: 0`, `spot: () => null`.
- Transplant `src/data/thetanuts.tsx` (useLiveMarket/LiveMarket, 30s poll, mock-first, stale-on-failure) + gate on `features.market`. `/api/market` route (always-200 envelope + `THETADUEL_MARKET=off`). `client.tsx`: LiveMarket inside WalletBoundary, `newsSource` kept. `Footer`: marketError amber, live green + snapshot age chip, version bump 0.2.5→0.3.0. Port `src/data/board.ts` (pure helpers; its two bug postmortems are /desk's exact hazards).
- **Do NOT port**: hansen's universe (kills the 4 price locks), ParlayRfq/SpotDiff (author-flagged NOT QC'd), rooms layer.
- Tests: NEW `test/market-builder.test.ts` (fixtures from one real response, checked in: grouping, best bid/ask, 8dp/6dp decimals, availableAmount-is-collateral-budget, median-IV edge, alias dedupe ETH/USD→ETH, per-underlying depth scaling, ranger-vs-condor, empty-book safety) + `test/market-route.test.ts` (always-200, TTL, inflight dedupe, stale-on-failure, kill switch).

### P2 — /desk fully live, read-only (~5h)
- **Move `src/engine/payoff.ts` → `src/desk/payoff.ts`** (it's inside the guard directory but unimported by settlement; going live inside the guard would force widening it — the forbidden move). `ETH_VOL_BOX` stays a frozen test constant; engine.test.ts updates the import path only.
- Live payoff: `buildPayoffChart(structure, spot: number|null = null)`, `spot ?? SPOT_FALLBACK(4182)` keeps the default byte-identical; label `SPOT 2,375.76 · LIVE` vs `· REFERENCE`. Delete `Parlay.tsx:120`'s literal, render `chart.spotLabel`.
- Real pricing: `getPricingArray('ETH'|'BTC')` server-side only (no CORS on pricing host); use documented filter helpers; **read `feeAdjustedBid/Ask`, never recompute** (docs say cap 3e-4; shipped code says 4e-4 — FINDINGS wins).
- RANGER: branch on P0.3's gate — supported → `PAYOUT_TYPE` map (registry `RANGER` vs payout `'ranger'` namespaces, one map, no guessing); unsupported → rows stay quoted, panel reads `PAYOFF UNAVAILABLE — ranger math is on-chain only`.
- Quote line: `previewFillOrder(order, usdc, referrer)` on row select — also the book-depth guard (`numContracts === 0n` → grey + "no fill available"). Upgrade the decorative SDK captions to the true exact call strings. Optional garnish: `client.ws.subscribeOrders` making the `● STREAMING` pill honest.

### P3 — The flagship: "Launch attack" becomes a real `fillOrder` (~5h, behind `THETADUEL_TRADE=on`)
- NEW `src/desk/fill.ts`: `runFill(order, usdcAmount, deps, onStep)` with injectable `FillDeps` — sequence: cap check (`MAX_FILL_USDC = 2_000000n`, enforced in code AND clamped UI; **target fill ~$0.01** per owner, fallback ladder $0.10 → $1 if the book rejects dust) → `getSigner()` (first-ever call site; null → connect UX; throw → switchToBase) → re-fetch order by nonce (stale orders cause "Signer Not Authorized" per troubleshooting docs; likely path given 426→130 intraday depth swings) → 60s expiry buffer → `previewFillOrder` (show `totalCollateral`, require a click on that number) → `ensureAllowance(USDC, resolvedOptionBook, totalCollateral)` exact, never MaxUint256 → `fillOrder(order, usdc, referrer)` with the order **Object.frozen** on arrival (mutation invalidates the EIP-712 sig) → receipt + BaseScan link.
- Full typed error map (SIGNER_REQUIRED/ORDER_EXPIRED/INSUFFICIENT_*/SIZE/SLIPPAGE/CONTRACT_REVERT/NETWORK/RATE_LIMIT) with per-code copy + recovery; `looksThrottled()` reused from tnuts-test with the Alchemy hint.
- Referrer on every fill + a `/desk` footer: `getReferrerFeeSplit` → `SPLIT n bps` (`not yet whitelisted` at 0), `claimAllFees` wired.
- Tests: `test/fill.test.ts` — call ordering, cap-before-network, referrer threading, frozen-order invariance, one case per error code.

### P4 — Hybrid anchoring (~2.5h)
- NEW `src/data/spot.ts` (outside the guard): `spotFor(sym, source): number|null` — null is the normal case (7 of 18 light up). Applied at all **five** C4 sites. Rule: **live sits beside seeded, never replaces** (`$4,182.60 seeded · $2,375.76 live`) + the global honesty chip `LIVE SPOT · SEEDED TAPE`.
- ParlayPick advisory: `book Δ 0.31 (second opinion)` beside tier `~25%`, from greeks.delta, ETH/BTC only, hidden when null — `TIERS`/`summarize()`/pinned `×47.52` untouched by construction. News wire: zero edits.

### P5 — USDC duel escrow on Base mainnet (~7h) — **owner's terms: NO stake cap, 4% rake**
- `contracts/DuelEscrow.sol` (~160 lines, solc 0.8.26): immutable `usdc`, `attestor`, `treasury`; `RAKE_BPS = 400` **constant**; `MIN_STAKE = 100_000` ($0.10, anti-grief); **no MAX_STAKE per owner decision** — ⚠ risk stated: uncapped + unaudited means a bug risks whatever players choose to stake; mitigations are minimality, the adversarial review gate, and rake/stake accounting separation. `TIMEOUT = 6 hours`. Functions: `open(duelId, stake, invited)`, `join`, `settle(duelId, winner, deadline, sig)` (EIP-712 `Verdict(bytes32 duelId,address winner,uint64 deadline)` verified against `attestor`; pays winner `2×stake × 9600/10000`, accrues the 4% to `rakeAccrued`), `claimRake()` (**only** transfers `rakeAccrued` to treasury — structurally cannot touch stakes), `refund` (past TIMEOUT, each player pulls their own stake, no rake on refunds), `cancel` (unjoined opener exit). CEI ordering, vendored ~25-line ECDSA with malleability guards, checked transfer returns, permissionless `settle` relay, no owner/pause/upgrade/sweep.
- Toolchain: `bun add -d solc` + `contracts/build.ts` (pinned solc, optimizer 200 runs, committed ABI) + `contracts/deploy.ts` (ethers ContractFactory, prints BaseScan verification inputs — **source verification is a release gate**). No foundry/hardhat.
- **Adversarial review gate before deploy**: one dedicated review pass of the contract (fresh agent, checklist: reentrancy, sig replay across duels/chains, rake math rounding, refund-vs-settle races, USDC-return-value, griefing via `invited`).
- Server: NEW `src/server/attest.ts` — `createAttestService({signer, now})`. **The crux**: the verdict depends on the player's picks, so `POST /api/lock` commits `{matchKey, picks, a, b}` first-write-wins (validated: known lobby, seed range, pick ids ∈ PARLAY_CARDS, keys === the seed's dealt syms), then `POST /api/attest` **re-derives** the verdict server-side from stored picks + seed (never trusts a claimed winner) and returns the EIP-712 signature (`deadline = now+30min`). Residual trust (server-as-referee) stated in README; commit-reveal is named v2.
- Tests: `test/attest.test.ts` (lock idempotency/validation; digest equals an independently computed `TypedDataEncoder.hash` — the one offline-testable thing that burns money if wrong; signer recovery; verdict flips with picks) + `test/escrow.test.ts` (compiles clean; ABI = exactly the expected externals/events; `RAKE_BPS === 400` read from compiled metadata; duelId derivation matches).

### P6 — Staking UI (~4h, behind `THETADUEL_STAKE=on` + real wallet)
- **PTS ↔ USDC: parallel, non-convertible.** PTS ledger/XP/rank untouched (`ledger.enter/settle` byte-identical); USDC is an opt-in side bet, own panel, own `$`, copy: "Side bet: $N USDC each, on-chain. Separate from the PTS pool." No exchange rate ever shown. Stake amount owner-settable in the create form (min $0.10, no cap — the UI shows a "large stake" warning above $20).
- Room ready button becomes the 6-state machine (idle→approving→staking→confirming→staked / failed→PTS-only fallback). The fake `OPP_READY_MS` timer is replaced by `DuelJoined` polling (`GET /api/duel/:id`) **only when live-staked** — PTS-only and all tests keep the 1100ms timer.
- Result: `ledger.settle` fires first, unconditionally; then attest → `escrow.settle` → `CLAIM $N` button + BaseScan link; server-down copy: "stake refunds automatically after 6 hours."
- Tests: `test/stake.test.ts` (state machine over fake escrow; every failure → PTS-only; mock wallet never approves; flag-off renders today's DOM).

### P7 — Truth pass + stretch (~2h)
README "What is actually live" table; consistent LIVE/SEEDED/STALE/PARTIAL chip vocabulary; `docs/plans/plan5-thetanuts.md` recorded. Stretch (only if P0–P6 done): the *patient* RFQ panel on /desk (0.3.0 sealed-bid helpers; `collateralAmount` must be 0 at creation; ECDH key never in plaintext localStorage).

## Fit / won't-fit (headline dispositions; the 33-item gotcha table lives in the design record + FINDINGS)

| Mismatch | Fix |
|---|---|
| 18 board assets / 2 tradable / 7 spot / 8 feeds | Board stays 18 seeded (hybrid); live spot annotates 7; real trades ETH/BTC on /desk only. Vocabulary: "the board" = seeded 18, "the book" = ETH/BTC. |
| RFQ = 4 phases, MM-dependent, no SLA | Out of the duel loop; patient stretch panel only. |
| No testnet | Mainnet + tiny fills ($0.01 target, $2 code cap) + opt-in flags + mock wallet inert. Escrow uncapped per owner — compensated by review gate + separation of rake/stakes. |
| Docs contradict shipped code (10+ verified sites) | Trust the `.d.ts`; every affected call site carries a comment citing FINDINGS + the doc URL. |
| Book depth swings several-fold intraday | Preview-before-fill, fresh re-fetch, "no fill available" grey-out; demo never assumes a fill. |
| greeks undocumented | Shape-checked, counted, graceful degrade. |
| Sync string-typed MarketSource | Widened with meta + spot(), stays sync. |
| 4 absolute price locks + guard blind spot | Guard extended first (P0.1); payoff.ts moves out rather than the guard widening; locks never move. |
| Copy-trade on-chain | Out of scope; referrer = attribution-only until whitelisted (0 bps). |

## Environment & security

Env: `RPC_URL` (secret, server-only, Alchemy Base), `THETADUEL_MARKET` (opt-out) / `THETADUEL_TRADE` / `THETADUEL_STAKE` (opt-in), `THETADUEL_REFERRER`, `THETADUEL_ESCROW` (public addrs), `ATTESTOR_PRIVATE_KEY` (server/attest.ts ONLY), `DEPLOYER_PRIVATE_KEY` (contracts/deploy.ts ONLY, never under src/). Security gates: `test/secrets.test.ts` scans `dist/` for keys post-build; attestor is a fresh unfunded EOA (signs typed data only, never transacts); server never signs a client-supplied winner; exact-amount approvals; CEI + checked transfers; BaseScan source verification as a release gate; every phase one commit behind a flag over intact mocks (full rollback = flags off → today's app byte-for-byte).

## Verification

Per phase: `bunx tsc --noEmit` clean + full `bun test` green (baseline 344 + new suites: market-builder, market-route, fill, attest, escrow-compile, stake, secrets) + dev-server smoke. Do-not-touch pins: determinism locks (:111-193), `engineFiles >= 6` floor, `ETH_VOL_BOX` payoff block, `×47.52`, the two /desk headings, `OPP_READY_MS`/`TAPE_STEP` imports, universe.ts in full, `stakePointsFor`.
**Manual mainnet checklist** (demo morning): book depth curl → /desk green + greeks → OptionBook agreement on BaseScan → wallet on Base funded → $1 preview non-zero → approve/fill/receipt (screenshot = demo artifact) → referrer split read → escrow open/join/duel/attest/settle $2 payout (screenshot) → refund path (seed an unsettled duel the night before, 6h timeout) → all kill switches degrade cleanly.

## Owner's hands (can't be done by agents)

1. **Alchemy/QuikNode Base key** → `RPC_URL` (~10 min; public RPC throttles under demo load).
2. **Fund a demo wallet on Base**: ~$10 USDC + ~$2 ETH gas. A second wallet for the two-seat escrow demo.
3. **Review the ~160-line contract yourself** before deploy (it's written to be readable in full) + run the deploy (`bun contracts/deploy.ts`, ~$0.50 gas) + verify source on BaseScan.
4. Optional: `WALLETCONNECT_PROJECT_ID`; email Thetanuts to whitelist the referrer address for a fee split.

**Effort ~31h total. Critical path to the flagship real-trade demo: P0→P1→P2→P3 ≈ 15.5h; P4 slots anywhere after P1. If time runs short, P0–P4 ships a fully honest hybrid app; P5–P6 are day two.**
