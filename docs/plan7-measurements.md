# Plan 7 §10 — the three measurements

Answers to the three unknowns that gate step 5 (the free-draw RFQ path).
Read-only throughout: no wallet, no signature, no spend.

**Measured 2026-09-04, 18:42Z–19:00Z**, Base mainnet 8453, RPC
`https://mainnet.base.org`, `@thetanuts-finance/thetanuts-client@0.3.0`
(the version the repo pins). Chain head at the start of the session was block
**50879095**, timestamp 2026-09-04T18:45:37Z.

Every section separates **FACT** (what a request returned) from **INFERENCE**
(what I read into it). Where a question cannot be closed from a read-only
seat, it says so and names the thing that would close it.

**The MCP server in plan §10 was not used** — MCP loads only at Claude Code
startup and was unavailable to this session. Everything below was measured
directly against the SDK, the indexer, and Base RPC, which is strictly more
verifiable anyway.

## Addresses this document refers to

| What | Address |
|---|---|
| OptionFactory, current (Base_r12, deployed 2026-05-05, block 45601440) | `0x8118daD971dEbffB49B9280047659174128A8B94` |
| OptionFactory, retired | `0x1adcd391cf15fb699ed29b1d394f4a64106886e5` |
| OptionBook | `0x1bDff855d6811728acaDC00989e79143a2bdfDed` |
| The market maker | `0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E` |
| `CALL_CONDOR` implementation | `0x14476CF2ea9F7C448100F061670E390f17c78817` |
| `RANGER` implementation | `0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc` |

---

# The short version

| # | Question | Answer |
|---|---|---|
| 1 | Do MMs answer RFQs, and how fast? | **Yes — 84.2% of 1,091 RFQs got an offer, median 6 s.** Condors specifically: 43 of 48 answered, 2–12 s. But **zero RFQ traffic in the last 15 days**, so "today" is inference, not fact. |
| 2 | Minimum `offerDeadlineMinutes`? | **There is no floor.** SDK validates only "in the future" and "before expiry". Shortest window ever accepted on chain: **8 s**; 13 s on the current factory. `settleQuotationEarly` is in production use (20 of 58 settlements). RFQ duels are viable at a 30–60 s window. |
| 3 | How many underlyings have listed condors? | **Zero. On any underlying. Ever.** Not one condor has been created through the OptionBook in its entire 15,740-position history. The listed zone product is **RANGER**, on ETH and BTC only. |

**Recommendation: build step 5.** Evidence in [§4](#4-the-recommendation).
§3.1 as written must change too — see [§5](#5-what-this-changes-in-plan-7).

---

# 1. Do market makers answer RFQs, and how fast?

## 1.1 Method

Three independent reads, deliberately overlapping so each checks the others.

1. **`GET https://indexer.thetanuts.finance/api/state`** — 3,202,885 bytes,
   fetched 18:42Z. `lastUpdateTimestamp` 1788547364 (2026-09-04T18:42:44Z),
   `lastProcessedBlock` 50879001, `indexedFactoryAddresses` = the two factories
   above. It carries `rfqs` (1,091 entries), `offers` (919 entries, each keyed
   by offeror), and `options` (558). Each RFQ carries `createdAt`,
   `createdBlock`, `offerEndTimestamp`, `updatedAt`, `status`,
   `implementationName`, `winner`. Each offer carries its own `createdAt` and
   `createdBlock`. Response rate is (RFQs with ≥1 offer) ÷ (RFQs); latency is
   `min(offer.createdAt) − rfq.createdAt`.
2. **`eth_getLogs`** on the current factory for
   `QuotationRequested(uint256,address,uint256,string)`
   (topic `0x848964356faaf5170f9011e4eaaf78bdd14cccdf4922aac203161c0dda154a73`)
   and `QuotationSettled(uint256,address,address,address)`
   (topic `0x01eb30e4397b04802dde011fe91f2b2ca455e8e04f2628b0b96183081d9ab637`),
   in 9,999-block chunks. This is the method plan §10 asks for, run directly.
3. **`getQuotationCount()`** `eth_call` on both factories, to prove the indexer
   is not lagging.

Public RPC would not serve a `getLogs` range wider than ~10k blocks
(`could not coalesce error` on anything larger), hence the chunking.

## 1.2 Raw numbers — FACT

**Indexer parity.** At head block 50879095: `getQuotationCount()` = **124** on
the current factory and **968** on the retired one. The indexer holds 123 rows
for the current factory (ids 1–123) and 968 for the retired one (ids 0–967).
Parity within one row on one factory. The indexer is not behind.

**All RFQs ever, both factories.** Window: 2025-07-28T07:50:37Z →
2026-08-20T17:34:27Z, blocks 33449845 → 50228960.

| | count | share |
|---|---|---|
| RFQs | 1,091 | |
| received ≥1 offer | 919 | **84.2%** |
| settled | 600 | 55.0% |
| cancelled | 427 | 39.1% |
| still active | 64 | 5.9% |
| total offers | 927 | 1.01 per answered RFQ |
| distinct requesters | 78 | |
| distinct offerors | **3** | |

First-offer latency, n=919: min **2 s**, p10 2 s, p25 4 s, **median 6 s**,
p75 8 s, p90 16 s, max 3,304 s.

**Current factory only** (the one the SDK points at), 2026-05-11 → 2026-08-20,
123 RFQs:

- offered **95 (77.2%)**, settled **58 (47.2%)**
- first-offer latency: min 4 s, **median 8 s**, p90 12 s
- request → settle wall clock: min **16 s**, p10 20 s, median 112 s, p90 192 s

**Condor family specifically** (`CALL_CONDOR` + `PUT_CONDOR` + `IRON_CONDOR`),
48 RFQs, 2025-09-01 → 2026-08-03, across both factories:

- offered **43 (89.6%)**, settled **26 (54.2%)**, cancelled 22
- first-offer latency on windows ≤55 s: **2–12 s**, every single one
- first-offer latency on the three 351–358 s windows: 58–66 s

The most recent one, and the single most load-bearing row in this document:

```
quotationId   104  on 0x8118daD9… (the current factory)
created       2026-08-03T17:57:25Z, block 49495249
implementation 0x14476CF2… = CALL_CONDOR
strikes       1820 / 1840 / 1860 / 1880   (ETH, 8dp)
offer window  32 seconds
reservePrice  1000000  (= $1.00 USDC)   requesterDeposit 1000000
first offer   +4 s, block 49495251, from 0xEcda1D00…
status        settled at +110 s
option        deployed at 0x36Bc2117BEb622b752072c33Dbc521240C1a8a4C
```

A tight four-strike ETH condor, auctioned for 32 seconds, answered in 4, filled.
That is plan 7's step 5 already having happened once, by someone else.

**`eth_getLogs`, window A** — blocks **50150000–50240000** (90,001 blocks,
≈2026-08-18 → 2026-08-20):

```
QuotationRequested   19 logs   ids 105…123 (contiguous)
QuotationSettled      8 logs   ids 110,112,116,118,119,120,121,123
settle latency from the request tx: 28, 30, 30, 32, 34, 42, 108, 112 seconds
```

**`eth_getLogs`, window B** — blocks **50240001–50879137** (639,137 blocks;
2026-08-20T17:35Z → 2026-09-04T18:47Z, **15.0 days**), 64 chunks, no chunk
failed:

```
QuotationRequested   0 logs
QuotationSettled     0 logs
```

**Offerors.** Three addresses have ever made an RFQ offer. In the last 90 days
of RFQ activity only two were active (`0xEcda1D00…`, `0xD9A23753…`), placing 50
offers between them. Winners all-time: `0xf1711BA7…` 541, `0xEcda1D00…` 49,
`0xD9A23753…` 8, two others 1 each.

## 1.3 Verdict

**FACT: market makers answer RFQs, they answer nearly all of them, and they
answer in single-digit seconds.** 84.2% over 1,091 requests at a 6-second
median; 89.6% on the 48 condor requests at 2–12 seconds. The RFQ path is not
decoration. Plan §10's stated abort condition — *"if nothing settles"* — is not
met: 600 RFQs have settled, 26 of them condors.

**FACT: the venue's RFQ flow has been completely idle for 15.0 days.** Zero
requests and zero settlements in 639,137 blocks, confirmed twice (log scan and
quotation counter). The last request of any kind was 2026-08-20T17:34:27Z. This
is not indexer lag and it is not our network.

**INFERENCE (high confidence): the responder is still armed.** `0xEcda1D00…`,
the address that answered and won condor RFQ 104, is at this moment the maker of
**all 374 orders** on the live OptionBook (§3.2), refreshing them roughly once a
minute. The counterparty is online, quoting, and taking risk right now. The 15
days of silence is an absence of *demand*, not an absence of *supply* — nobody
has asked.

**UNKNOWN, and here is what would answer it: whether that MM's RFQ listener is
still subscribed today.** No read closes this. The only thing that closes it is
one real `requestForQuotation` on Base. Cost, from the measured rows: a
`requesterDeposit` equal to the reserve price — $1.00 on RFQ 104, $0.01–$1.00
across the USDC-collateralised condor requests — plus Base gas. That is inside
`MAX_FILL_USDC` ($2.00), and it is the cheapest decisive experiment available.
**Run it before step 5 is demonstrated to anyone**, not because the odds are bad
but because a 15-day gap is exactly the kind of thing that turns out to matter
in front of a room.

---

# 2. What is the minimum `offerDeadlineMinutes`?

## 2.1 Method

1. Read every validation site in the shipped SDK
   (`node_modules/@thetanuts-finance/thetanuts-client/dist/index.js`).
2. Call `client.optionFactory.buildCondorRFQ(…)` locally across a sweep of
   deadline values and pass each result to `validateRFQRequest` — pure local
   code, no network, no signer.
3. Read the on-chain constants the factory exposes.
4. Check what the chain has actually *accepted*: the distribution of
   `offerEndTimestamp − createdAt` over 1,091 real requests, and what happened
   to the short ones.

## 2.2 What the SDK enforces — FACT

Every RFQ builder computes `offerEndTimestamp = now + offerDeadlineMinutes × 60`
(`index.js:5903, 6218, 6449, 6550, 6651, 6767`) and then applies exactly two
checks. In the builders:

```js
if (expiryTimestamp <= offerEndTimestamp) throw INVALID_PARAMS
  "Option expiry must be after offer deadline. Choose a shorter deadline or later expiry."
```

and in `validateRFQRequest` (`index.js:6841-6845`):

```js
if (request.params.offerEndTimestamp <= now) throw INVALID_PARAMS "offerEndTimestamp must be in the future"
if (request.params.expiryTimestamp <= request.params.offerEndTimestamp) throw INVALID_PARAMS
```

**There is no minimum anywhere in the SDK.** No constant, no comparison, no
clamp.

**Correction to plan §3.3.** The plan says *"`offerDeadlineMinutes` in the SDK
example is 60"*. That is stale for 0.3.0. Five builders default the field to
**6** (`params.offerDeadlineMinutes ?? 6`), and the newer docstrings use 6. The
60 survives only in the older `buildQuotationParameters` examples, where the
field is required rather than defaulted. `CondorRFQParams.offerDeadlineMinutes`
is **required** (`index.d.ts`), so for our path no default is reached at all —
we name the number.

**Measured sweep** (`buildCondorRFQ`, ETH `CALL_CONDOR` 2400/2450/2550/2600,
expiry 2026-09-05T08:00Z, then `validateRFQRequest`):

| `offerDeadlineMinutes` | resulting window | `validateRFQRequest` |
|---|---|---|
| 60 | 3600 s | valid |
| 6 | 360 s | valid |
| 2 | 120 s | valid |
| 1 | 60 s | valid |
| 0.5 | 30 s | valid |
| 0.25 | 15 s | valid |
| 0.2 | 12 s | valid |
| 0.1 | 6 s | valid |
| 0.7 | 42 s | valid |
| 1/60 | — | **`RangeError: Not an integer`** at build |
| 0 | 0 s | INVALID_PARAMS — must be in the future |
| −1 | −60 s | INVALID_PARAMS — must be in the future |

Every case built `collateralAmount: 0` and `requesterDeposit: 0`, and resolved
the implementation to `0x14476CF2…` (`CALL_CONDOR`) — so plan §3.3's
`collateralAmount = 0` rule is enforced by the helper, as documented.

**Gotcha worth a line in the code.** `BigInt(now + minutes * 60)` throws
`RangeError: Not an integer` whenever `minutes × 60` is not an exact integer in
IEEE-754. `1/60` fails. `0.7` happens to survive. **Pass only values where
`minutes × 60` is exactly integral** — or, better, compute the seconds you want
and divide by 60 from a whole number.

## 2.3 What the contract enforces — FACT

Read live off the current factory (`eth_call`, no signer):

```
getRevealWindow()  = 60      (seconds)
getTwapPeriod()    = 1800    (seconds)
getMaxRfqValue()   = 100000000000000
```

And what the chain has actually accepted, over the 1,091 real requests:

| | current factory | retired factory |
|---|---|---|
| shortest offer window ever accepted | **13 s** (id 16, `PUT`, settled, 1 offer) | **8 s** (id 445, `PHYSICAL_PUT`, settled, 1 offer) |
| p10 / median / p90 window | 25 s / 42 s / 116 s | 23 s / 52 s / 276 s |
| requests with window ≤30 s | 27 → 17 offered, 5 settled | 127 → 101 offered, **98 settled** |
| requests with window ≤60 s | 99 → 81 offered, 52 settled | 793 → 715 offered, 457 settled |
| settlements landing **before** `offerEndTimestamp` (i.e. `settleQuotationEarly`) | **20 of 58** | 73 of 542 |
| request → settle, minimum | **16 s** | 8 s |

(17 rows across both factories have `offerEndTimestamp` at or before
`createdAt`; all are cancelled or stale artefacts and are excluded from the
positive-window statistics above.)

## 2.4 Verdict

**FACT: no floor exists that threatens an RFQ duel.** The SDK imposes none. The
contract has accepted a **13-second** offer window on the deployment we would
use and an **8-second** one historically, and both settled. 154 requests across
the two factories used windows of 30 seconds or less; 118 of them received
offers and 103 settled. This is not a theoretical bound read off a type — these
are transactions that exist.

**FACT: `settleQuotationEarly` works and is in production use.** 20 of 58
settlements on the current factory landed before the offer deadline; the fastest
complete request→settle round trip observed is **16 seconds**.

**FACT: the 60-second `REVEAL_WINDOW` is why the ordinary path is slow, and why
early settle matters.** `settleQuotation` must wait out the offer deadline *and*
the reveal window, which is exactly why the median request→settle is 112 s on a
42 s auction. `settleQuotationEarly(quotationId, offerAmount, nonce, offeror)`
skips both: the requester decrypts the sealed offer with their own ECDH key and
supplies `(offerAmount, nonce)` directly. **Plan 7 must use the early path.** If
it uses `settleQuotation`, every duel inherits a ~2-minute floor from
`REVEAL_WINDOW` and the mode does not work.

**INFERENCE (medium-high confidence): a shorter window may cost you latency, not
answers.** On the three 351–358 s windows the MM's first offer arrived at
58–66 s; on windows ≤55 s it arrived at 2–12 s. The responder appears to pace
itself against the deadline rather than firing as fast as it can. That reads as
*shorter is better*, not worse — but it is a pattern over ~50 rows, not a
guarantee.

**Design number: a 30–60 second offer window, settled early on the first
acceptable offer.** Total expected wall clock 20–40 s. That fits a duel.

---

# 3. How many underlyings have listed condors on the OptionBook?

## 3.1 Method

- `client.api.fetchOrders()` against the real client construction
  (`chainId: 8453`, `JsonRpcProvider(https://mainnet.base.org)`), which requests
  `GET https://round-snowflake-9c31.devops-118.workers.dev/` per
  `docs/book-endpoint.md`. **26 polled snapshots** at ~40 s intervals,
  2026-09-04T18:51:53Z → 19:09:36Z, plus six ad-hoc reads from 18:49:16Z —
  **32 reads of the live book in all**.
- Cross-checked against the repo's own frozen fixture
  `test/fixtures/orders.json`, captured **2026-09-04T09:31Z** — an independent
  read 9¼ hours earlier.
- Grouped by `rawApiData.implementation` looked up in
  `chainConfig.optionImplementations` (46 entries, lowercase-keyed) — the
  authoritative product name, per FINDINGS' own correction — and by
  `rawApiData.priceFeed` mapped through `chainConfig.priceFeeds`.
- Lifetime history from `GET /api/v1/book/state` (35,097,822 bytes,
  `lastProcessedBlock` 50879325) and `GET /api/v1/book/stats/protocol`.
- `previewFillOrder` run against live orders — synchronous, no signer, no spend.

## 3.2 Raw numbers — FACT

**The live book, every one of 32 reads:**

```
orders           370–375
makers                 1   (0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E — 374 of 374)
4-strike orders    37–38   100% RANGER, every snapshot
CALL_CONDOR            0
PUT_CONDOR             0
IRON_CONDOR            0
```

Orders by underlying × implementation (18:49Z snapshot, 375 orders):

| | CALL_FLY | CALL_SPREAD | LINEAR_CALL | PHYS_CALL | PHYS_PUT | PUT | PUT_FLY | PUT_SPREAD | RANGER |
|---|---|---|---|---|---|---|---|---|---|
| AVAX | 0 | 0 | 11 | 0 | 0 | 7 | 0 | 0 | 0 |
| BNB | 0 | 2 | 21 | 0 | 0 | 17 | 0 | 3 | 0 |
| BTC | 3 | 12 | 11 | 35 | 35 | 14 | 3 | 10 | **21** |
| ETH | 2 | 9 | 12 | 28 | 29 | 13 | 2 | 10 | **17** |
| SOL | 0 | 2 | 15 | 0 | 0 | 12 | 0 | 2 | 0 |
| XRP | 0 | 0 | 9 | 0 | 0 | 8 | 0 | 0 | 0 |

The 09:31Z fixture shows the identical shape, and its own provenance note
already recorded it: *"No CONDOR was resting on the book: every 4-strike order
passed the ranger invariants."*

**Lifetime OptionBook history** — 15,740 positions, first trade 2025-10-09,
last trade 2026-09-04T18:07:33Z (39 minutes before this read):

| implementation | positions | 24h | 7d | 30d | buyer win rate |
|---|---|---|---|---|---|
| **RANGE** | **9,766** | **39** | **218** | **1,144** | 70.61% |
| PUT | 2,721 | 8 | 29 | 64 | 34.08% |
| LINEAR_CALL | 2,344 | 18 | 47 | 156 | 30.57% |
| CALL_SPREAD | 249 | 0 | 1 | 1 | 66.13% |
| INVERSE_CALL | 234 | 0 | 0 | 0 | 31.20% |
| PHYSICAL_PUT | 188 | 0 | 1 | 1 | 29.41% |
| PHYSICAL_CALL | 159 | 0 | 0 | 0 | 6.29% |
| PUT_SPREAD | 68 | 0 | 0 | 2 | 88.24% |
| CALL_FLYS | 8 | 0 | 0 | 0 | 25.00% |
| PUT_FLYS | 2 | 0 | 0 | 1 | 0.00% |
| UNKNOWN | 1 | 0 | 0 | 0 | — |

**`CALL_CONDOR`, `PUT_CONDOR` and `IRON_CONDOR` do not appear in this table at
all.** Not one condor has ever been created through the OptionBook.

Condors *do* exist on Base — 26 of them were created through the **OptionFactory
RFQ** path (§1.2). The two venues have cleanly separate product sets: the book
lists **RANGE**, the factory mints **condors on demand**.

**Which side is buyable.** `order.isBuyer` is derived by the SDK as
`!rawApiData.isLong` (`index.js:3360`). The polarity matters absolutely under
plan §5 (long only), so it was settled against settled positions rather than
against the field name:

- 4-strike RANGE positions (`optionType 0xe`, n=9,766): the MM is recorded as
  `seller` in **5,635** and as `buyer` in **0**. Including all **168** entered
  in the last ~4 days (`entryBlock > 50,700,000`, most recent 50876277,
  `createdBy` = the OptionBook), every one MM-as-seller.
- `PHYSICAL_CALL` (`0xa`) and `PHYSICAL_PUT` (`0xb`): the MM is recorded as
  **buyer** (5 and 13) and as seller **zero** times.
- On today's book, `PHYSICAL_*` are precisely the orders carrying
  `isLong === true`; everything else carries `isLong === false`.

Therefore, **FACT**: `rawApiData.isLong === false` ⟹ the maker is short ⟹ **the
taker buys**. Today's 37 RANGER orders, and all the vanillas and spreads, are
buyable. The 126 `PHYSICAL_*` orders are the ones where the taker would be
selling.

**The listed RANGE ladder** (18:58Z; ETH spot 2449.57, BTC spot 79575). Premium
and payout are per contract, in USDC; multiple is `maxPayout ÷ premium`:

| underlying | expiry | zone | wing | premium | max payout | multiple | spot inside? |
|---|---|---|---|---|---|---|---|
| ETH | 5 Sep | 2300–2400 | 20 | 1.18 | 20 | 16.98x | no |
| ETH | 6 Sep | 2300–2400 | 20 | 3.37 | 20 | 5.94x | no |
| ETH | 7 Sep | 2300–2400 | 20 | 5.49 | 20 | 3.64x | no |
| ETH | 7 Sep | 2400–2500 | 20 | 17.39 | 20 | 1.15x | **yes** |
| ETH | 7 Sep | 2400–2500 | 40 | 35.80 | 40 | 1.12x | **yes** |
| ETH | 11 Sep | 2400–2450 | 50 | 18.85 | 50 | 2.65x | **yes** |
| ETH | 11 Sep | 2400–2500 | 50 | 27.00 | 50 | 1.85x | **yes** |
| ETH | 11 Sep | 2450–2500 | 50 | 18.22 | 50 | 2.74x | no |
| ETH | 18 / 25 Sep, 30 Oct | same three zones | 50 | 6.22–17.52 | 50 | 2.85x–8.05x | two of three |
| BTC | 5 Sep | 79000–80000 | 500 | 490.19 | 500 | 1.02x | **yes** |
| BTC | 5 Sep | 80000–81000 | 500 | 230.37 | 500 | 2.17x | no |
| BTC | 6 / 7 Sep | 79000–80000 (×2 wings), 80000–81000 | 500/1000 | 207.83–867.24 | 500/1000 | 1.15x–2.41x | two of three |
| BTC | 11 / 18 / 25 Sep, 30 Oct | 79000–80000, 79000–81000, 80000–81000 | 1000 | 110.04–454.77 | 1000 | 2.20x–9.09x | two of three |

- 7 expiries per underlying: 5, 6, 7, 11, 18, 25 Sep and 30 Oct 2026, all 08:00Z.
- **1–3 distinct zones per (underlying, expiry)**. ETH's two nearest expiries
  carry exactly **one** zone each, and spot is outside it.
- `availableAmount` = **$10,000 per order** (~$370k across the book) —
  5,000× `MAX_FILL_USDC`. Depth is not the constraint.
- **No greeks on any RANGER order** (`rawApiData.greeks` absent, 0 of 38).
- `previewFillOrder(order, 2000000n)` returns a real quote on every one of the
  37 zones with no signer and no spend — e.g. the BTC 79000–80000 / 5 Sep zone
  prices 0.004073 contracts at 490.97/contract for exactly $2.00.
- `validateCondor(strikes)` and `validateRanger(strikes)` both return
  `{valid: true}` on the same arrays, and
  `calculatePayout({type:"ranger"|"call_condor", …})` returns identical payouts
  across a strike sweep for these symmetric-wing structures.

## 3.3 Verdict

**FACT: the answer to the question as asked is ZERO.** No underlying has a
listed condor on the OptionBook, none did at 09:31Z, and none ever has in the
book's entire 15,740-position history. **Plan §3.1's snap-to-listed default, as
specified, has no coverage at all and cannot carry the mode.**

**FACT: the answer to the question as intended — "is there a listed zone-bound
structure the player can buy without any MM round trip?" — is TWO: ETH and
BTC**, via `RANGER`. 37 buyable offers, 7 expiries each, $10k depth per order,
multiples 1.02x–9.09x straight off the market, previewable today with no signer.

**INFERENCE (high confidence): RANGER *is* the box, and plan §1's prohibition
does not apply to the book path.** §1 rules RANGER out because
`client.ranger` exposes no create method. That reasoning is sound for the RFQ
path — you cannot *mint* one — and irrelevant on the OptionBook, where you fill
an order the maker already created. Retail is doing exactly this **39 times a
day**; RANGE is the venue's single busiest product, 62% of all positions ever.
A `RANGER` with strikes `[callLower, callUpper, putLower, putUpper]` pays max
between `callUpper` and `putLower`, decaying through equal wings — which is the
box, drawn.

**FACT, and this is the real limit on snap-to-listed: the ladder is coarse.**
About three zones per (underlying, expiry), two underlyings, and on ETH's two
nearest expiries the only listed zone does not contain spot. A player who draws
a box around today's price for tomorrow's expiry on ETH has **nothing to snap
to**. Snap-to-listed is not "draw a box"; it is "pick one of about three".

**FACT: the entire live book is one maker.** 374 of 374 orders from
`0xEcda1D00…` — the same address that answers condor RFQs. Both of plan 7's
execution paths terminate at the same counterparty. There is no diversification
between them, and no fallback if that one bot stops.

---

# 4. The recommendation

**Build step 5.**

The evidence that decides it is not that RFQ is attractive. It is that **RFQ is
the only path that can produce the instrument plan 7 is about.**

1. A condor cannot be bought off the book. Zero listed, zero ever created there,
   across 15,740 positions and eleven months. The only 26 condors that exist on
   Base were minted through RFQ.
2. RFQ answers, and answers fast. 84.2% of 1,091 requests received an offer at a
   6-second median; on the 48 condor requests specifically, 89.6% at 2–12
   seconds. Twenty-six settled. The most recent — a 32-second auction on a tight
   ETH condor — was answered in 4 seconds and filled.
3. There is no deadline floor to design around. 13-second windows have been
   accepted and settled on the deployment we would use; `settleQuotationEarly`
   is in production and the fastest observed round trip is 16 seconds. A 30–60
   second auction settled early lands inside a duel.
4. Steps 1–4 as currently specified do **not** constitute a shippable mode.
   §3.1's fallback does not exist. What exists in its place is a three-zone
   RANGE ladder on two assets — worth building, and genuinely useful as the
   no-MM-dependency path, but it is "pick one of three boxes", not "draw one".

Ship steps 1–4 with §3.1 rewritten onto `RANGER` **and** build step 5. They are
not alternatives here; the listed path is the shallow end and the RFQ path is
the mode.

**The one condition on that recommendation.** Fifteen days of zero RFQ traffic
means nobody has proven the MM's listener is armed *today*. Before step 5 is
shown to anyone, place one real RFQ: a `CALL_CONDOR` on ETH, four strikes off
the live ladder, 60-second window, reserve at `calculateReservePrice`. Measured
cost is a `requesterDeposit` equal to the reserve — $0.01 to $1.00 on the
comparable rows — plus Base gas, all inside `MAX_FILL_USDC`. If an offer lands,
step 5 is proven end to end for about a dollar. If none lands within 60 seconds,
that is the abort signal plan §10 asked for, bought at the cheapest possible
price, and steps 1–4 on the RANGE ladder are still a mode.

---

# 5. What this changes in plan 7

Findings that fall outside the three questions but that step 5 (and steps 1–4)
would be built wrong without.

**§3.1 — snap-to-listed must target `RANGER`, not `CALL_CONDOR`.** Zero condors
are listed and none ever have been. Rewrite the default around the 37 live
RANGE zones on ETH and BTC. Consequences to carry with it: the zone grid is
$50/$100 on ETH and $1,000 on BTC (not the ~$20 near-spot spacing §2.4 assumes,
which was measured on vanilla puts); RANGE orders carry **no greeks**, so
`TIER_BANDS` delta shading cannot be applied to a listed zone; and on some
near-dated cells no listed zone contains spot, so the UI must be able to say
"nothing listed here — this box goes to auction" rather than snapping to
something absurd.

**§1 — "Do not use RANGER" is correct for RFQ and wrong for the OptionBook.**
There is no create method, so it cannot be RFQ'd; it can absolutely be *filled*,
and 9,766 positions say so. Keep `CALL_CONDOR` for the free-draw path and use
`RANGER` for the listed path. FINDINGS' warning applies at full force: a
four-strike order read off the book and passed to `calculatePayoutAtPrice`
**silently prices as a condor** unless `isRanger: true` is set. Resolve the type
from `rawApiData.implementation` (`0x9980ec85…` = RANGER), never from the
strikes — `validateCondor` and `validateRanger` both accept the same arrays.

**§2.1 — the RFQ underlying enum is eight assets, not two.**
`type RFQUnderlying = 'ETH' | 'BTC' | 'SOL' | 'DOGE' | 'XRP' | 'BNB' | 'PAXG' | 'AVAX'`
(`index.d.ts:3102`), and `buildCondorRFQ` resolves a price feed for ETH, BTC,
SOL, XRP, BNB and AVAX — verified by construction. The `['ETH','BTC']` enum in
the plan is the **MCP tool's** schema, not the SDK's. Shipping ETH and BTC is
still the right call (they are the only assets with a zone ladder and MM
pricing), but the reason is liquidity, not an SDK restriction — so say that in
the greyed-out copy.

**§3.3 — use `settleQuotationEarly`, and know why.** `REVEAL_WINDOW` is 60
seconds on chain. `settleQuotation` waits out the offer deadline *and* the
reveal window; that is the whole explanation for the 112-second median settle on
42-second auctions. Early settle skips both, and the requester needs the ECDH
private key to decrypt the offer to do it — which is the §3.3 `keyStorageProvider`
requirement becoming load-bearing rather than hygienic. Lose the key mid-duel and
the position cannot be settled early, only waited out.

**§3.3 — `offerDeadlineMinutes` arithmetic.** `BigInt(now + minutes * 60)` throws
`RangeError: Not an integer` for any value where `minutes × 60` is not exactly
integral (`1/60` throws; `0.7` happens not to). Derive it from whole seconds.

**Not in the plan at all: the book is a single maker.** All 374 live orders come
from `0xEcda1D00…`, which is also the address that won the last condor RFQ. Both
execution paths, and the entire asset gate, rest on one bot. Worth one sentence
in the README and worth knowing before the demo.

**Flagged for the owner of `src/`, not acted on (this investigation is
read-only): the bid/ask polarity at `src/server/thetanuts.ts` was inverted.
**CONFIRMED AND FIXED** in `37f0c37` — do not re-report it. It was settled by
measurement, not by reading: 142 live orders joined to the venue's own two-sided
quotes showed `isBuyer=true` resting at 1.58-1.66x the MM mark and NEVER at or
below its bid, while `isBuyer=false` rests at 0.69-0.72x and never at or above
the ask. Total separation, zero counterexamples. `isBuyer === true` is the
maker's ASK — the side a player can buy. The code now splits `takerBuys` (which
labels `OrderRow.side`, byte-identical, because `fill.ts` rebuilds that exact
string to match an order) from `isBid` (the maker's side, which picks the fill
target). Before the fix, `askEntry` pointed at the maker's bid — filling one
would have made the player the writer.


---

# Appendix — how to re-measure

```bash
# Q1a — RFQ history, response rate, latency (one 3.2 MB read, no RPC)
curl -sS https://indexer.thetanuts.finance/api/state -o state.json
#   rfqs[].createdAt / .status / .offerEndTimestamp
#   offers["<factory>:<id>"][<offeror>].createdAt   -> first-offer latency

# Q1b — is the indexer current? (one eth_call per factory)
#   OptionFactory.getQuotationCount()  ->  124 (current) / 968 (retired) on 2026-09-04

# Q1c — the plan's own method, bounded (9,999-block chunks; wider ranges are refused)
#   eth_getLogs address=0x8118daD971dEbffB49B9280047659174128A8B94
#     topic0 QuotationRequested 0x848964356faaf5170f9011e4eaaf78bdd14cccdf4922aac203161c0dda154a73
#     topic0 QuotationSettled   0x01eb30e4397b04802dde011fe91f2b2ca455e8e04f2628b0b96183081d9ab637

# Q2 — the SDK's own validation, offline
#   client.optionFactory.buildCondorRFQ({... offerDeadlineMinutes: 0.5 ...})
#   client.optionFactory.validateRFQRequest(req)
#   client.optionFactory.getRevealWindow()   -> 60n

# Q3 — the live book, grouped
bun run scripts/probe-assets.ts
#   then: group fetchOrders() by chainConfig.optionImplementations[rawApiData.implementation]
#   4-strike orders today are 100% RANGER; CALL_CONDOR count is 0
curl -sS https://indexer.thetanuts.finance/api/v1/book/stats/protocol   # byImplementationType
```
