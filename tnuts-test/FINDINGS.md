# Thetanuts SDK — exploration findings

SDK `@thetanuts-finance/thetanuts-client` pinned at exactly `0.2.5` (no caret).
ethers 6.17.0. Chain: Base mainnet 8453. RPC: `https://mainnet.base.org`.
Read-only client (provider only, no signer). All 6 steps ran successfully.
Data captured 2026-09-03 ~08:00 UTC (block 50790061).

Run one step at a time: `npx tsx test.ts <1-6>` (or by name, e.g. `npx tsx test.ts ethPricing`).
No arg prints the step menu.

---

## 1. Field shape of one mmPricing object

From `client.mmPricing.getPricingArray('ETH')` → `MMVanillaPricing`. 15 top-level fields.

| field | type | example |
|---|---|---|
| `ticker` | string | `'ETH-3SEP26-2100-C'` |
| `rawBidPrice` | number | `0.115` |
| `rawAskPrice` | number | `0.119` |
| `feeAdjustedBid` | number | `0.11460000000000001` |
| `feeAdjustedAsk` | number | `0.11939999999999999` |
| `markPrice` | number | `0.116552` |
| `underlyingPrice` | number | `2375.76` |
| `strike` | number | `2100` |
| `expiry` | number | `1788422400` (unix seconds) |
| `isCall` | boolean | `true` |
| `underlying` | string | `'ETH'` |
| `passesToleranceCheck` | boolean | `false` |
| `timeToExpiryYears` | number | `0.0016778919330289192` |
| `feeMultiplier` | number | `1.03` |
| `byCollateral` | object | `{ ETH, USD }` |

All prices are `number` (JS float), not bigint. Prices are quoted **in units of the
underlying**, not USD — an ETH call at `0.1155` mark is 0.1155 ETH.

`byCollateral` is keyed by collateral asset. Keys observed: `ETH` + `USD` for ETH options,
`BTC` + `USD` for BTC options. Each value has 11 fields:

| field | type | example (byCollateral.ETH) |
|---|---|---|
| `collateralAsset` | string | `'ETH'` |
| `collateralAmount` | number | `1` |
| `collateralCostPerUnit` | number | `0.00006711567732115677` |
| `mmBidPrice` | number | `0.11453288432267886` |
| `mmAskPrice` | number | `0.11946711567732114` |
| `mmWlBidPrice` | number | `0.11608488432267886` |
| `mmWlAskPrice` | number | `0.11701911567732115` |
| `mmBidPriceBuffered` | number | `0.11119697507056199` |
| `mmAskPriceBuffered` | number | `0.12305112914764078` |
| `mmWlBidPriceBuffered` | number | `0.11270377118706684` |
| `mmWlAskPriceBuffered` | number | `0.12052968914764078` |

`Wl` = whitelisted. `Buffered` applies `feeMultiplier` (1.03).
For `collateralAsset: 'USD'`, `collateralAmount` equals the strike (2100), not 1.

Counts at capture time: ETH **782** rows, BTC **925** rows. Neither was empty.

---

## 2. Field shape of one order object

From `client.api.fetchOrders()` → `OrderWithSignature`. **426** live orders at capture.
5 top-level fields, with the EIP-712 payload nested under `order`.

| field | type |
|---|---|
| `order` | object (14 fields, below) |
| `signature` | string (0x, 65-byte) |
| `availableAmount` | **bigint** |
| `makerAddress` | string |
| `rawApiData` | object (11 fields, below) |

`order` (the signed struct):

| field | type | example |
|---|---|---|
| `maker` | string | `0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E` |
| `taker` | string | `0x0000...0000` (open order) |
| `option` | string | `''` — **empty string**, not an address |
| `isBuyer` | boolean | `true` |
| `numContracts` | bigint | `0n` |
| `price` | bigint | `144246644n` |
| `expiry` | bigint | `1788422400n` |
| `nonce` | bigint | `25365122831975758400662931726290595927861030329151298978392616734748722343309n` |
| `optionType` | number | `1` |
| `strikes` | bigint[] | `[230000000000n]` (8dp → $2300) |
| `strikePrice` | bigint | `230000000000n` |
| `collateralToken` | string | `0x8335...2913` (USDC) |
| `underlyingToken` | string | `0x4200...0006` (WETH) |
| `deadline` | bigint | `1788422400n` |

`rawApiData` (indexer passthrough):

| field | type |
|---|---|
| `collateral` | string |
| `priceFeed` | string |
| `implementation` | string |
| `strikes` | string[] (decimal strings, not bigint) |
| `isCall` | boolean |
| `isLong` | boolean |
| `orderExpiryTimestamp` | number |
| `extraOptionData` | string (`'0x'`) |
| `maxCollateralUsable` | string |
| `optionBookAddress` | string |
| `greeks` | object: `{ delta, iv, gamma, theta, vega }` — all number |

Observed on the sampled order: `order.numContracts` is `0n` and `order.option` is `''`.
`availableAmount` was `10000000000n` = 10,000 USDC at 6dp, matching
`rawApiData.maxCollateralUsable`. `strikes` is duplicated in three places with two
different encodings (`order.strikes` bigint[], `order.strikePrice` bigint,
`rawApiData.strikes` string[]).

---

## 3. Price feeds vs MM options pricing

`client.chainConfig.priceFeeds` — **10 keys**, 8 distinct assets:

`ETH`, `BTC`, `SOL`, `DOGE`, `XRP`, `BNB`, `PAXG`, `AVAX`, plus two aliases
`ETH/USD` and `BTC/USD` whose addresses are identical to `ETH` and `BTC`.

`client.chainConfig.implementations` — **22 keys**. 15 have real addresses:
`PUT`, `INVERSE_CALL`, `LINEAR_CALL`, `CALL_SPREAD`, `PUT_SPREAD`, `INVERSE_CALL_SPREAD`,
`CALL_FLY`, `PUT_FLY`, `CALL_CONDOR`, `PUT_CONDOR`, `IRON_CONDOR`, `RANGER`, `CALL_LOAN`,
`PHYSICAL_CALL`, `PHYSICAL_PUT`.

7 are the zero address: `PHYSICAL_CALL_SPREAD`, `PHYSICAL_PUT_SPREAD`, `PHYSICAL_CALL_FLY`,
`PHYSICAL_PUT_FLY`, `PHYSICAL_CALL_CONDOR`, `PHYSICAL_PUT_CONDOR`, `PHYSICAL_IRON_CONDOR`.

**MM options pricing exists for ETH and BTC only.** `getPricingArray` is typed
`(underlying: 'ETH' | 'BTC')`. Probed against all 8 price-feed assets — none of the other
six throw, they all return `[]`:

| underlying | outcome | rows |
|---|---|---|
| ETH | returned array | 781 |
| BTC | returned array | 923 |
| SOL | returned array | 0 |
| DOGE | returned array | 0 |
| XRP | returned array | 0 |
| BNB | returned array | 0 |
| PAXG | returned array | 0 |
| AVAX | returned array | 0 |

`getMarketData().prices` returned **7** assets: ETH, BTC, SOL, XRP, BNB, AVAX, DOGE.
PAXG has a price feed but no entry in market prices.

So, three different asset sets: 8 price feeds / 7 market prices / 2 with MM pricing.

---

## 4. calculatePayout and RANGER

**`client.utils.calculatePayout` does NOT support RANGER.** Probed at runtime, both casings:

```
REJECTED  type:'RANGER'  code=INVALID_PARAMS  message="Unknown option type: RANGER"
REJECTED  type:'ranger'  code=INVALID_PARAMS  message="Unknown option type: ranger"
```

The shipped type is `PayoutType = 'call' | 'put' | 'call_spread' | 'put_spread'`.
The implementation is a 4-case switch with `default: throw INVALID_PARAMS`.
No butterfly, condor, or iron-condor support either, despite those implementations
being deployed on chain.

Args it wants (`PayoutParams`):

| arg | required | type |
|---|---|---|
| `type` | yes | `'call' \| 'put' \| 'call_spread' \| 'put_spread'` |
| `strikes` | yes | `bigint[]` — exactly 1 for call/put, exactly 2 for spreads (throws otherwise) |
| `settlementPrice` | yes | `bigint`, 8dp |
| `numContracts` | yes | `bigint`, 18dp |
| `priceDecimals` | no | number, default 8 |
| `sizeDecimals` | no | number, default 18 |
| `collateralDecimals` | no | number, default 6 (USDC) |

Returns `bigint` in collateral decimals. Pure local, no RPC (step ran in 2ms).

Sweep, strike 3000, 1 contract (`10n**18n`), payout in USDC:

| settlement | call | put | call_spread [2800,3200] | put_spread [2800,3200] |
|---|---|---|---|---|
| 2000 | 0 | 1000 | 0 | 400 |
| 2400 | 0 | 600 | 0 | 400 |
| 2800 | 0 | 200 | 0 | 400 |
| 3000 | 0 | 0 | 200 | 200 |
| 3200 | 200 | 0 | 400 | 0 |
| 3600 | 600 | 0 | 400 | 0 |
| 4000 | 1000 | 0 | 400 | 0 |

For spreads, `strikes[0]` is the lower strike and `strikes[1]` the upper.

RangerOption payoff is not reachable locally. The only ranger payout paths are
`client.ranger.calculatePayout(addr, price)` and
`client.ranger.simulatePayout(addr, price, strikes, numContracts)` — both take a
deployed ranger contract address and both are async/on-chain.

---

## 5. Where the responses contradict the docs

1. **Fee adjustment cap is 0.0004, not 0.0003.** `llms-full.txt` states
   `feeAdjustment = min(0.0003, rawPrice × 0.125)`. The shipped code uses `Math.min(4e-4, …)`.
   Live data agrees with the code: ETH raw bid 0.115 → feeAdjustedBid 0.1146 (delta 0.0004);
   BTC raw bid 0.1025 → 0.1021 (delta 0.0004).

2. **`applyFeeAdjustment` signature is different.** Docs say `applyFeeAdjustment(price, side)`.
   Actual: `applyFeeAdjustment(bid, ask, markPrice = 0, isWhitelisted = false)` returning the
   tuple `[adjustedBid, adjustedAsk]`.

3. **`COLLATERAL_APR` is keyed `BTC`/`ETH`/`USD`, not `cbBTC`/`WETH`/`USD`.** Docs describe the
   rates as "cbBTC: 1%, WETH: 4%, USD: 7%". The actual object is `{BTC: 0.01, ETH: 0.04, USD: 0.07}`.
   Lookup is `COLLATERAL_APR[asset] ?? DEFAULT_CARRY_RATE` where `DEFAULT_CARRY_RATE = 0.05`,
   so passing `'WETH'` or `'cbBTC'` silently yields 5% instead of 4%/1%.

4. **`calculatePayout` type strings are lowercase and snake_case.** The implementation registry
   and docs use `PUT`, `CALL_SPREAD`, etc.; `client.utils.calculatePayout` accepts only
   `'call'`, `'put'`, `'call_spread'`, `'put_spread'`. The two namespaces do not share strings.

5. **`getPricingArray` with an unsupported underlying returns `[]` rather than throwing.**
   The docs' error table implies `INVALID_PARAMS` for bad input. All six non-ETH/BTC feed
   assets returned an empty array instead — indistinguishable from "no live options right now".
   An empty result therefore has two possible causes and the SDK does not let you tell them apart.

6. **`priceFeeds` has 10 keys, not the 8 assets listed.** `ETH/USD` and `BTC/USD` are duplicate
   aliases of `ETH` and `BTC` at the same addresses.

7. **`greeks` is undocumented.** `rawApiData.greeks` (`delta`, `iv`, `gamma`, `theta`, `vega`)
   is present on live orders but appears nowhere in `llms-full.txt`.

8. **PAXG has a price feed but no market price.** `getMarketData().prices` omits it while
   `chainConfig.priceFeeds.PAXG` is populated.

Not contradicted / confirmed as documented: `availableAmount` is a collateral budget in
collateral decimals (10000000000n = 10,000 USDC), not a contract count; the 7 physical
multi-leg implementations are zero addresses; `RANGER` is deployed at
`0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc`.

## Browser UI

`npx tsx server.ts` → http://localhost:8787. The SDK stays in Node (it needs the ethers
provider); `ui.html` is plain HTML/JS with no build step and no CDN, fetching JSON from
the local server. Same read-only client, no signer.

A published/hosted static page cannot do this job: outbound fetch/XHR is blocked in the
Artifact sandbox, so live indexer and RPC data is unreachable from there.

Endpoints: `/api/health`, `/api/orders`, `/api/pricing?underlying=`, `/api/config`,
`/api/payout?type=&strikes=&contracts=&from=&to=&steps=`, `/api/probe-underlyings`.
Reads are cached 15s to avoid bursting the public RPC. Errors return HTTP 200 with
`{ok:false, code, message, throttled}` so the page renders the typed SDK error itself.

## Notes on running

RPC throttling was not hit in this session — all network steps returned first try
(getMarketData 659ms, fetchOrders 181ms, ETH pricing 288ms). The script detects the
`CALL_EXCEPTION`/no-revert-data shape and prints an instruction to set `RPC_URL` to an
Alchemy key rather than retrying.

Steps 5 and 6 make no network calls at all — `chainConfig` is bundled static config and
`utils.calculatePayout` is local math. Both completed in 2ms.

---

## 0.3.0 delta (verified from the installed .d.ts, 2026-09-04)

Everything above was captured against `@thetanuts-finance/thetanuts-client@0.2.5`, which
`tnuts-test/package.json` still pins — that pin is the provenance of this document and is
deliberately **not** bumped. The main app now depends on `^0.3.0` (root `package.json`,
resolved `0.3.0`, `sha512-+HFZVP8U69Om...`). This section records what changed, read
directly out of the shipped types rather than the docs.

Source of every quote below (identical bytes; the ESM twin is `index.d.mts`):
`node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts` (14,833 lines, 494,767 bytes).
Runtime confirmations are from `dist/index.js`.
Package: MIT, `main dist/index.js`, `types dist/index.d.ts`, hard deps
`axios ^1.16.1`, `ethers ^6.0.0` (also a required peer), `viem ^2.47.0`.

### RANGER is supported — the P2 gate resolves to the SUPPORTED branch

`PayoutType` (`index.d.ts:6500`) is a ten-member union and it names `ranger` explicitly:

```ts
type PayoutType = 'call' | 'put' | 'call_spread' | 'put_spread' | 'call_fly' | 'put_fly'
                | 'call_condor' | 'put_condor' | 'iron_condor' | 'ranger';
```

The doc comment above it (`:6480-6499`) carries the strike conventions as a table. The two
that matter for us:

| type | count | order | invariant |
|---|---|---|---|
| `iron_condor` | 4 | `[putLower, putUpper, callLower, callUpper]` ASCENDING | `putUpper <= callLower` (non-overlapping) |
| `ranger` | 4 | `[callLower, callUpper, putLower, putUpper]` ASCENDING | `callUpper - callLower === putUpper - putLower` AND `callUpper < putLower` |

This is not just a type-level claim: `dist/index.js:10966` (payout) and `:11117`
(collateral) both contain a real `case "ranger":` implementing the zone-bound math and
throwing `INVALID_PARAMS` on each invariant — `"Ranger requires exactly four strikes"`,
`"Ranger requires callLower < callUpper"`, `"Ranger spread widths must be equal
(callUpper-callLower === putUpper-putLower)"`, `"Ranger requires callUpper < putLower
(zone gap)"`. The 0.2.5 limitation this file recorded is fixed. Multi-leg off-chain payout
math works.

**Two namespaces, do not conflate them** — this is the "one map, no guessing" the plan asks for:

- `PayoutType` (lowercase, payout/collateral math): `'ranger'`, `'iron_condor'`, `'call_fly'`, ...
- `ProductName` (`:14681`, UPPER_SNAKE, registry/implementation names):
  `'INVERSE_CALL' | 'PUT' | 'LINEAR_CALL' | 'CALL_SPREAD' | 'INVERSE_CALL_SPREAD' | 'PUT_SPREAD' | 'CALL_FLY' | 'PUT_FLY' | 'CALL_CONDOR' | 'PUT_CONDOR' | 'IRON_CONDOR' | 'RANGER' | 'PHYSICAL_CALL' | 'PHYSICAL_PUT'`
  — the same keys as `ImplementationAddresses` (`:186`ff, which has a `RANGER` field).
- A third, unrelated union also exists and must not be mistaken for either:
  `OptionStructure` (`:14541`) `= 'call' | 'put' | 'call_spread' | 'put_spread' | 'butterfly' | 'iron_condor' | 'straddle' | 'strangle'` — no `ranger`, and it has `straddle`/`strangle` that `PayoutType` does not.
- `ProductType` (`:14537`) `= 'spread' | 'butterfly' | 'condor'` is the coarse bucket returned by `utils.getProductType()`.

Payout entry points (`UtilsModule`):

```ts
calculatePayout(params: PayoutParams): bigint;            // :6655  — sync, local math
calculateCollateral(params: CollateralParams): bigint;    // (same block)
calculateMaxPayout(order: { optionType: number; strikes?: bigint[];
                            isIronCondor?: boolean; isRanger?: boolean },
                   numContracts: bigint): bigint;         // :6866
calculatePayoutAtPrice(order: { optionType: number; strikes?: bigint[];
                                isIronCondor?: boolean; isRanger?: boolean },
                       numContracts: bigint, settlementPrice: bigint): bigint;  // :6889
getProductType(order: { optionType: number; strikes?: bigint[] }):
  'vanilla' | 'spread' | 'butterfly' | 'condor';          // :6924
```

`PayoutParams` (`:6504`) = `{ type: PayoutType; strikes: bigint[]; settlementPrice: bigint;
numContracts: bigint; priceDecimals?: number /* 8 */; sizeDecimals?: number /* 18 */;
collateralDecimals?: number /* 6 */ }`. `CollateralParams` (`:6523`) is the same minus
`settlementPrice`.

WARNING — **the 4-strike discriminator trap.** `calculateMaxPayout` / `calculatePayoutAtPrice`
take the *order* shape, which does not carry a payout type — the SDK derives one via the
private `getPayoutTypeFromOptionType` (`:7002`), whose own doc says: *"4-strike orders
default to call_condor / put_condor. Callers that know the order is an iron condor or ranger
must pass the appropriate flag in `opts`."* So a ranger read off the book and fed to
`calculatePayoutAtPrice` **silently prices as a condor** unless we set `isRanger: true`.
Our `classify()` heuristic (equal wing widths + zone gap = RANGER) is what sets that flag;
`validateRanger(strikes: number[]): ValidationResult` (`:14727`) is the SDK's own checker
and is exported, so the heuristic can be cross-checked rather than trusted.

### `previewFillOrder` — 10 fields, and it is SYNCHRONOUS

The docs' two-field description is wrong; the richer shape wins, as the design assumed —
and there is a further correction the design did not have: **it does not return a Promise.**

```ts
// index.d.ts:1991
previewFillOrder(orderWithSig: OrderWithSignature, usdcAmount?: bigint, referrer?: string): {
    numContracts: bigint;
    maxContracts: bigint;
    collateralToken: string;
    pricePerContract: bigint;
    totalCollateral: bigint;
    referrer: string;
    maker: string;
    expiry: bigint;
    isCall: boolean;
    strikes: bigint[];
};
```

Ten fields, not eleven and not two. `await`ing it is harmless but misleading; the honest
call site is a plain call. `usdcAmount` is optional — omitted means "max available" — and
the doc comment adds *"Amount of collateral to spend (6 decimals)"*. The book-depth guard
the plan specifies (`numContracts === 0n` then grey out, "no fill available") reads a field
that is present here, so it needs no defensive shape check; the surrounding preview object
is fully typed and stable.

Companion, same module, also sync: `calculateMaxContracts(orderWithSig: OrderWithSignature): bigint`
(`:1973`) — "*For PUT options: maxContracts = maxCollateral / strike. For CALL options:
INVERSE_CALL maxContracts = maxCollateral / decimal_adjustment; LINEAR_CALL maxContracts =
maxCollateral / strike (same as PUT). For SPREADs: maxContracts = maxCollateral /
spreadWidth*", returning 6 decimals for USDC collateral. Its `@param` says the order must
carry `rawApiData` — which is doc contradiction #10 again: `rawApiData` is real and load-bearing.

### `fillOrder` — arity 3, two optional

```ts
// index.d.ts:2025
fillOrder(orderWithSig: OrderWithSignature, usdcAmount?: bigint, referrer?: string): Promise<TransactionReceipt>;
```

Declared throws: `ORDER_EXPIRED`, `INVALID_ORDER`, `SIGNER_REQUIRED`. Note the return is a
raw ethers `TransactionReceipt`, **not** the exported `FillOrderResult` type — that type
exists in the export list but is not what this method hands back. Do not annotate against it.

Related, for a wallet that is not the SDK's signer:
`encodeFillOrder(...)` returning `{ to: string; data: string }`, and
`swapAndFillOrder(orderWithSig, swapRouter, swapSrcToken, swapSrcAmount, swapData, referrer?)`.

### `ensureAllowance` — arity 3, returns a nullable receipt

```ts
// index.d.ts:577  (ERC20Module)
ensureAllowance(token: string, spender: string, amount: bigint): Promise<TransactionReceipt | null>;
```

Three arguments, no options bag, no fourth `owner`. **`null` is the success case for "no
approval was needed"** — the doc comment spells it out: *"Transaction receipt if approval
was needed, null otherwise"*. Code that treats a falsy return as failure will report a
phantom error on every fill after the first.

WARNING — there is an exported `EnsureAllowanceResult` interface (`:14492`),
`{ approvalNeeded: boolean; receipt: TransactionReceipt | null; currentAllowance: bigint }`,
that looks like this method's return type and **is not**. It is dead weight from the
caller's perspective in 0.3.0. Same trap as `FillOrderResult`. Also present:
`getAllowance(token, owner, spender): Promise<bigint>` (`:551`) if we want to show the
current allowance before approving.

Exact-amount approval (never `MaxUint256`) is unaffected: pass `preview.totalCollateral`.

### Referrer-fee methods — all four names exist, on `client.optionBook`

The digest's C1/N5 correction is confirmed and then some — the 0.3.0 surface is larger than
"claimFees / claimAllFees":

```ts
getFees(token: string, referrer: string): Promise<bigint>;                 // :2070
getAllClaimableFees(address: string): Promise<ClaimableFee[]>;             // :2089
claimFees(token: string): Promise<TransactionReceipt>;                     // :2103
claimAllFees(address?: string): Promise<ClaimFeeResult[]>;                 // :2132
getReferrerFeeSplit(referrer: string): Promise<bigint>;                    // :2181
setReferrerFeeSplit(referrer: string, feeBps: bigint): Promise<TransactionReceipt>;  // admin only, reverts for us
sweepProtocolFees(token: string): Promise<TransactionReceipt>;             // admin only
```

- `ClaimableFee` (`:1674`) = `{ token: string; symbol: string; decimals: number; amount: bigint }`.
  `getAllClaimableFees` fans out over every collateral token in the chain config with
  `Promise.allSettled` and returns only the non-zero balances.
- `ClaimFeeResult` (`:1691`) = `{ symbol: string; amount: bigint; receipt?: TransactionReceipt; error?: Error }`
  — per-token, partial failure is normal and the caller is expected to read both fields.
  `claimAllFees` claims sequentially (each write must mine before the next gas estimate).
- `claimAllFees(address?)` defaults `address` to the signer's — but our referrer address is
  not necessarily the connected wallet, so pass it explicitly.
- `getReferrerFeeSplit` returns **basis points as a bigint**. `0n` for an un-whitelisted
  referrer, which is our expected reading: the `/desk` footer says `SPLIT 0 bps — not yet
  whitelisted` and calls it attribution, never revenue.

### `ThetanutsClientConfig` — `referrer` and `logger` are both first-class

```ts
// index.d.ts:136
interface ThetanutsClientConfig {
    chainId: SupportedChainId;      // 8453 | 1  (:112) — a literal union, so Number(env) will not typecheck
    provider: Provider;             // ethers v6, REQUIRED
    signer?: Signer;                // optional — omit for the read-only server client
    referrer?: string;              // "Referrer address for fee sharing (optional)"
    apiBaseUrl?: string;
    indexerApiUrl?: string;
    pricingApiUrl?: string;         // defaults to pricing.thetanuts.finance
    wsUrl?: string;
    stateApiUrl?: string;
    env?: Environment;              // 'dev' | 'prod', default 'prod'
    logger?: ThetanutsLogger;
    keyStorageProvider?: KeyStorageProvider;  // auto-detects: localStorage in browser, file storage in Node
    rfqKeyPrefix?: string;          // default 'thetanuts_rfq_key'
}
```

So P1's "client ctor gains `referrer` + `logger`" needs no wrapper — both are native
fields. `ThetanutsLogger` (`:8`) is four **optional** methods,
`debug/info/warn/error(msg: string, meta?: unknown): void`, so a partial logger is legal;
`consoleLogger` and `noopLogger` are exported if we want neither. `SupportedChainId` being
the literal union `8453 | 1` means our config plumbing must narrow, not just parse.

WARNING — `keyStorageProvider` auto-detecting `localStorage` in a browser is the
plaintext-ECDH-key hazard the plan's P7 stretch flags. Server-side (our reads) it never engages.

### Doc contradictions #9 / #10 — both now resolved by the shipped types

- **#9 `previewFillOrder`**: resolved in favour of the rich shape, above. Additional
  correction: it is synchronous.
- **#10 `rawApiData`**: confirmed. `calculateMaxContracts`'s `@param` reads
  *"Order with signature containing rawApiData"* — the field the docs describe under an
  `OrderWithSignature` heading is genuinely `rawApiData`, and hansen's
  `entry.rawApiData.priceFeed` read is correct. Comment-protect it at the call site.
- **Fee cap, 3e-4 vs 4e-4** — the earlier FINDINGS reading holds in 0.3.0.
  `applyFeeAdjustment(bid, ask, markPrice?, isWhitelisted?): [number, number]` (`:7465`)
  documents its own formula as *"min(0.0004, price * 0.125) - matches v4-webapp"*. That is
  **4e-4**, not the docs page's 3e-4. Read `feeAdjustedBid`/`feeAdjustedAsk` off the API
  rather than recomputing, and if we ever must recompute, use this exported helper.

### Consequences for the phases

- **P2 RANGER: take the supported branch.** Build the `PAYOUT_TYPE` map over the lowercase
  `PayoutType` namespace, keep `ProductName`/`ImplementationAddresses` (`RANGER`) strictly
  separate, and always pass `isRanger`/`isIronCondor` on the order-shaped calls or 4-strike
  structures price as condors. The `PAYOFF UNAVAILABLE — ranger math is on-chain only`
  fallback copy is not needed.
- **P3 fill sequence**: `previewFillOrder` is sync (no await needed, no loading state for
  it), `ensureAllowance` is `(token, spender, amount)` and returns `null` on the happy
  no-approval path, `fillOrder` is `(order, usdcAmount, referrer)` returning an ethers
  receipt. `preview.totalCollateral` is the exact-approval amount and the number the user
  clicks.
- **P1 client construction**: `{ chainId: 8453, provider, referrer, logger }` — all native.

---

## Correction (2026-09-04, after the MCP cross-check)

Nothing above is rewritten; this section supersedes two lines of it. The audit is
`docs/reviews/mcp-crosscheck.md`, which read the SDK authors' own MCP server
(`@thetanuts-finance/mcp@1.0.0`) against our integration.

### `keyStorageProvider` does NOT auto-detect. In a browser it THROWS.

The `§0.3.0 delta` block above records the field as
*"auto-detects: localStorage in browser, file storage in Node"*, and the WARNING beneath it
treats browser localStorage as a hazard we would be opted into by default. Both statements
came from the shipped `.d.ts` doc comment, which is **stale**. The shipped *code* does the
opposite:

```js
// node_modules/@thetanuts-finance/thetanuts-client/dist/index.js:11714
function getDefaultStorageProvider() {
  if (typeof window !== "undefined" && window.localStorage) {
    throw new InvalidKeyError(
      "Browser RFQ key storage must be configured explicitly. Pass keyStorageProvider to ThetanutsClient; do not rely on plaintext localStorage defaults."
    );
  }
  return new FileStorageProvider();
}
```

and the client constructor reaches it **eagerly**, before anything is used:

```js
// :16645
this.rfqKeys = new RFQKeyManagerModule(this, config.keyStorageProvider, config.rfqKeyPrefix);
```

Reproduced twice against the installed 0.3.0: once in Node with a faked `window`, and once
through `createLiveFillDeps().getSigner()` under `bun test`, where happy-dom supplies a real
`window.localStorage`. Both threw `InvalidKeyError` / `INVALID_KEY` from inside
`new ThetanutsClient(...)`.

Consequences, all now fixed:

- **Every browser construction must pass `keyStorageProvider`.** All four in
  `src/desk/fill.ts` now pass `new MemoryStorageProvider()` — memory rather than
  `LocalStorageProvider` because we never touch `client.rfqKeys`, so no ECDH key is
  generated and none is persisted. The SDK's own MCP does the same thing for the same
  reason (`mcp/dist/prepare/sdk.js:12-19` always supplies one).
- **The P7 plaintext-localStorage hazard is no longer a default we inherit.** It is now
  strictly opt-in, via `LocalStorageProvider`, which logs its own warning on construction.
  Do not reach for it.
- **P1's server client is unaffected.** `src/server/thetanuts.ts` runs under Bun, where
  `typeof window === "undefined"`, so the fallback is the inert `FileStorageProvider`
  (its constructor stores a path and touches no disk). Verified: `bun -e 'typeof window'`
  is `undefined`.

### P2's ranger decision was not decidable from strikes, and no longer tries to be

The `§4 calculatePayout and RANGER` note and the P2 consequence above assume a four-strike
order can be told apart from a condor by its strikes — ascending, equal outer widths, a gap
in the middle. It cannot. The SDK's own `calculate_payout` tool description states the
*condor* convention as `[K1..K4] ASCENDING with K2-K1 === K4-K3`, i.e. the identical test,
and `validateCondor` / `validateRanger` (`dist/index.js:16838`, `:16871`) accept the same
set — so consulting `validateRanger` was restating our own arithmetic, not cross-checking it.

The authoritative reading is `rawApiData.implementation` looked up in
`chainConfig.optionImplementations` (46 entries on Base, keyed by **lowercase** address),
whose `name` is already the UPPER_SNAKE `ProductName` our `PAYOUT_TYPE` map is keyed by. On
Base: `RANGER` is `0x9980ec85…`, `CALL_CONDOR` `0x14476CF2…`, `PUT_CONDOR` `0xC742E422…`.
`src/server/thetanuts.ts` now does that lookup; the strike count survives only as the
fallback for one, two and three strikes, and a four-strike row it cannot resolve is quoted
with `structure: "UNKNOWN"` and no payout type rather than guessed at.

### `rawApiData.optionBookAddress` is a claim to check, not an authority to trust

Recorded here because it contradicts the doctrine both `src/desk/fill.ts` and
`src/server/thetanuts.ts` used to state. The SDK's `resolveOptionBookTarget`
(`dist/index.js:1561-1582`) requires the API-supplied address to **equal** the
chain-configured OptionBook and throws `INVALID_ORDER` otherwise, documenting the reason:
"to prevent a compromised API from redirecting fills to an attacker contract that drains
pre-existing allowances". The approval spender is therefore
`chainConfig.contracts.optionBook`, and a mismatch refuses the fill before anything is
approved.
