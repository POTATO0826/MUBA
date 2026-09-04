# MCP cross-check — our SDK integration audited against `@thetanuts-finance/mcp@1.0.0`

**VERDICT: the read path holds up; the browser trade path does not. 3 BUGs, one of them fatal.**
Every SDK call we make on the server is the same call, in the same shape, with the same units the
SDK's own authors make in their MCP server — `previewFillOrder` sync, `rawApiData` as the
load-bearing field, the lowercase `PayoutType` namespace, exact-amount approvals, `feeAdjusted*`
read never recomputed. But `new ThetanutsClient(...)` **throws in a browser** on 0.3.0 unless a
`keyStorageProvider` is passed, and all four of our browser constructions omit it, so
`src/desk/fill.ts` cannot execute a single fill today (BUG-1). Two further defects are latent:
our RANGER discriminator also matches every symmetric condor (BUG-2), and our allowance spender is
an API-supplied address the SDK explicitly refuses to trust (BUG-3).

Method: `npm pack @thetanuts-finance/mcp` into the session scratchpad, static read of
`dist/index.js` (~100 tool handlers), `dist/prepare/{sdk,allowance,core,keystore}.js`, and the
README; cross-read against the installed `@thetanuts-finance/thetanuts-client@0.3.0`
`dist/index.js` where the MCP's behaviour needed explaining. The server was never run. One
empirical check was run in Node (BUG-1, reproduction below).

---

## Findings

| # | Class | What | Ours | Theirs / SDK |
|---|---|---|---|---|
| 1 | **BUG** | Browser `ThetanutsClient` ctor throws `INVALID_KEY` — the live fill path is dead | `src/desk/fill.ts:965`, `:991`, `:1049`, `:1093` | `mcp/dist/prepare/sdk.js:12-19`; SDK `dist/index.js:16645`, `:11714-11719` |
| 2 | **BUG** | RANGER discriminator also matches every symmetric call/put condor | `src/server/thetanuts.ts:577-594` | `mcp/dist/index.js:347-349`; SDK `dist/index.js:16838`, `:16871` |
| 3 | **BUG** | Allowance spender is an unvalidated API-supplied address | `src/desk/fill.ts:811`, doctrine at `src/server/thetanuts.ts:413-433` | SDK `dist/index.js:1561-1582` (`resolveOptionBookTarget`) |
| 4 | DIVERGENCE | Client config: we add `referrer` + `logger`; they pass neither | `src/server/thetanuts.ts:355-367` | `mcp/dist/index.js:78-86` |
| 5 | DIVERGENCE | We pass `referrer` to `previewFillOrder`; they don't | `src/server/thetanuts.ts:1075` | `mcp/dist/index.js:1884` |
| 6 | DIVERGENCE | MM pricing via `getPricingArray` + `filterByStrikeRange`; they use `getAllPricing` | `src/server/thetanuts.ts:1026-1047` | `mcp/dist/index.js:1996`, `:2033` |
| 7 | DIVERGENCE | Staleness: we refetch + match by identity + expiry buffer; they address orders by array index | `src/desk/fill.ts:981-1009`, `:742` | `mcp/dist/index.js:1876-1884` |
| 8 | DIVERGENCE | RFQ deliberately skipped — and the MCP has **no** fill builder at all | — | `mcp/README.md:327-336` |
| 9 | OPPORTUNITY | `chainConfig.optionImplementations` gives the exact product name per order — the fix for BUG-2 | — | SDK config, 46 entries |
| 10 | OPPORTUNITY | `fillOrder` checks **both** expiry fields against chain time; we check one against local time | `src/desk/fill.ts:619-624` | SDK `dist/index.js` `fillOrder` preamble |
| 11 | OPPORTUNITY | `preview.totalCollateral` is the input amount verbatim — "exact approval" over-approves when clamped | `src/desk/fill.ts:825-829` | SDK `previewFillOrder` body |
| 12 | OPPORTUNITY | `getFees(token, referrer)` / `getAllClaimableFees(address)` for a real fee readout | `src/desk/fill.ts:1044` reads only the split | `mcp/dist/index.js:2299-2312` |
| 13 | OPPORTUNITY | Keystore design, if P7 is ever taken: scrypt + AES-256-GCM in SQLite at 0700, never localStorage | — | `mcp/dist/prepare/keystore.js` |

Confirmed-correct, stated plainly (evidence in the detail sections): `previewFillOrder` is
synchronous and takes `(order, usdcAmount?, referrer?)`; `rawApiData` is the real home of
`isCall`/`strikes`/`collateral`/`orderExpiryTimestamp`; `availableAmount` is a collateral budget;
the three structure namespaces are kept apart correctly; `feeAdjustedBid/Ask` are copied not
recomputed; approvals are exact and `MaxUint256` never appears; chain id 8453 and the
`https://mainnet.base.org` default match theirs exactly.

---

## BUG-1 — the browser client throws before it is ever used

**Severity: fatal to the trade path. Currently every fill fails, with misleading copy.**

SDK 0.3.0 constructs `rfqKeys` **eagerly** in the client constructor:

```js
// node_modules/@thetanuts-finance/thetanuts-client/dist/index.js:16645
this.rfqKeys = new RFQKeyManagerModule(this, config.keyStorageProvider, config.rfqKeyPrefix);
```

and `RFQKeyManagerModule`'s constructor falls back to `getDefaultStorageProvider()`, which in a
browser does not auto-detect `localStorage` — it **throws**:

```js
// :11714-11719
function getDefaultStorageProvider() {
  if (typeof window !== "undefined" && window.localStorage) {
    throw new InvalidKeyError(
      "Browser RFQ key storage must be configured explicitly. Pass keyStorageProvider to ThetanutsClient; do not rely on plaintext localStorage defaults."
    );
  }
  return new FileStorageProvider();
}
```

Reproduced against the installed 0.3.0:

```
$ node -e "globalThis.window={localStorage:{getItem(){return null},setItem(){},removeItem(){}}}; …
           new ThetanutsClient({chainId:8453, provider:new JsonRpcProvider('https://mainnet.base.org')})"
THREW: InvalidKeyError INVALID_KEY Browser RFQ key storage must be configured explicitly. …
```

`tnuts-test/FINDINGS.md` §"0.3.0 delta" records this field as *"auto-detects: localStorage in
browser, file storage in Node"* — that is the `.d.ts` doc comment, and the shipped code no longer
does it. The doc comment is stale; the code is not.

All four of our browser constructions omit `keyStorageProvider`:

- `src/desk/fill.ts:965` — `createLiveFillDeps().getSigner()`
- `src/desk/fill.ts:991` — the read-only client inside `refetchOrder`
- `src/desk/fill.ts:1049` — `readReferrerSplit`
- `src/desk/fill.ts:1093` — `claimReferrerFees`

**What the user sees.** The throw lands inside `getSigner`, and `runFill` step 2 treats a throw
from `getSigner` as connected-but-wrong-chain (`src/desk/fill.ts:706-720`) — by design, and here
that design amplifies the failure: the panel says *"The wallet is not on Base. Switch the wallet
to Base mainnet (8453)"* to a user who is already on Base, every time, forever. The footer's
referrer chip silently reads `SPLIT — unread` for the same reason.

**Why the MCP is the witness.** Their per-wallet client factory always supplies one:

```js
// mcp/dist/prepare/sdk.js:12-19
export function buildClient(opts) {
  return new ThetanutsClient({
    chainId: BASE_CHAIN_ID,
    provider: opts.provider,
    keyStorageProvider: opts.keyStorageProvider,
    rfqKeyPrefix: `thetanuts_rfq_${opts.wallet.toLowerCase()}`,
  });
}
```

Their read-only client (`mcp/dist/index.js:78-86`) omits it and is fine — it only ever runs in
Node, where the fallback is the inert `FileStorageProvider` (its constructor stores a path and
touches no disk; the `mkdir` is inside `ensureDirectory()`, called only on a real key write). That
is why **our server client is unaffected**: `src/server/thetanuts.ts:357` runs under Bun with no
`window`.

**Fix (one line per site).** `MemoryStorageProvider` is exported from the SDK root
(`Object.keys(require(...))` → `['LocalStorageProvider','MemoryStorageProvider']`). We never touch
`client.rfqKeys`, so memory storage is the honest choice — it also guarantees no ECDH private key
is ever persisted, which is exactly the plaintext-localStorage hazard P7 flagged:

```ts
const { ThetanutsClient, MemoryStorageProvider } = await import("@thetanuts-finance/thetanuts-client");
new ThetanutsClient({ chainId: BASE_CHAIN_ID, provider, signer, referrer,
                      keyStorageProvider: new MemoryStorageProvider() });
```

Note the `LocalStorageProvider` class is still exported and still logs its own warning
(`:11682`) — do not reach for it.

---

## BUG-2 — RANGER is not distinguishable from a condor by strikes alone

**Severity: correctness now (a false label and a false claim in the footer); money the day
`payout` reaches `calculatePayoutAtPrice`.**

`classify()` (`src/server/thetanuts.ts:577-594`) decides RANGER from four numbers:

```ts
const ascending  = a < b && b < c && c < d;
const equalWidths = Math.abs(b - a - (d - c)) < 1e-9;
const zoneGap    = b < c;
const sdkAgrees  = validateRanger([a, b, c, d]).valid;
return ascending && equalWidths && zoneGap && sdkAgrees ? "RANGER" : "CONDOR";
```

The comment above it says an iron condor "has no equal-width rule, so equal widths + a gap is the
discriminator." That is true of the *iron* condor and false of the plain one. The SDK's own
authors state the convention in the MCP's `calculate_payout` tool description:

```js
// mcp/dist/index.js:347-349
'call_condor/put_condor = [K1, K2, K3, K4] ASCENDING with K2-K1 === K4-K3; ' +
'iron_condor = [putLower, putUpper, callLower, callUpper] with putUpper <= callLower; ' +
'ranger = [callLower, callUpper, putLower, putUpper] with equal spread widths and callUpper < putLower.'
```

Ascending with equal outer widths is the *condor* convention too, and `zoneGap` (`b < c`) is
implied by ascending. The two validators confirm it — they accept the identical set:

```js
// SDK dist/index.js:16838  validateCondor  → sorts, requires |(s1-s0) - (s3-s2)| <= 1e-4
// SDK dist/index.js:16871  validateRanger  → requires |(s1-s0) - (s3-s2)| <= 1e-4 and s1 < s2
```

So `validateRanger` is not a cross-check on our heuristic; it re-states one of its own clauses.
Every symmetric ascending four-strike order on the book — i.e. every ordinary condor — is
currently typed `RANGER`, coloured RANGER in the pricing table, and given
`payout: "ranger"`. `src/views/Parlay.tsx:460` then prints
`N RANGER · payout 'ranger' — priced off-chain, isRanger set`, which would be a false statement
about a condor.

Why it has not bitten yet: in the frozen capture (`test/fixtures/orders.json`) only 2 of 30 orders
carry four strikes, and both are genuine rangers — their `rawApiData.implementation` is
`0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc`, which is `implementations.RANGER` on Base. The
heuristic is right by luck on this data. `CALL_CONDOR` (`0x14476CF2…`) and `PUT_CONDOR`
(`0xC742E422…`) are deployed and will appear.

Also currently harmless because nothing spends on it: `payout` and `structure` are read only by
`src/views/Parlay.tsx:150-151,460` and the row colour at `src/server/thetanuts.ts:909`. The moment
a payoff chart or a settlement estimate feeds `payout` into `utils.calculatePayout`, a condor
priced as a ranger is a wrong number on a screen about money.

**Fix — stop guessing, look it up.** Every order carries `rawApiData.implementation` (FINDINGS §2;
the SDK itself rejects a zero one in `buildContractOrder`), and the chain config carries a
46-entry reverse map:

```js
chainConfig.optionImplementations["0x9980ec85…"] // { name: "RANGER", type: "RANGER", numStrikes: 4 }
chainConfig.optionImplementations["0x051791df…"] // { name: "LINEAR_CALL", type: "VANILLA", numStrikes: 1 }
chainConfig.optionImplementations["0xa1d5f6b1…"] // { name: "CALL_FLY", type: "BUTTERFLY", numStrikes: 3 }
```

`name` is exactly the `ProductName` (UPPER_SNAKE) key our `PAYOUT_TYPE` map is already keyed by,
so the whole of `classify()` + `productNameOf()` collapses into one lookup with the current
heuristic kept only as the fallback for an address the map does not know. That also fixes the
smaller mislabels the heuristic has today: `PHYSICAL_CALL`, `PHYSICAL_PUT` and `INVERSE_CALL`
orders are all currently flattened to `LINEAR_CALL` / `PUT`.

---

## BUG-3 — we approve to an address the SDK refuses to trust

**Severity: latent. Bounded by exact-amount + `MAX_FILL_USDC` ($2) + a human click. Not
exploitable today because the two addresses agree.**

`src/desk/fill.ts:811`:

```ts
const spender = order.rawApiData?.optionBookAddress ?? "";
```

and the doctrine that justifies it, stated at `src/desk/fill.ts:807-810` and at length in
`src/server/thetanuts.ts:413-433`: *"the order's own `optionBookAddress` wins … `chainConfig`
is the cross-check, not the authority."*

The shipped SDK takes the opposite position, and says why in the same words the threat model
would use:

```js
// SDK dist/index.js:1561-1582
/**
 * The API may attach `rawApiData.optionBookAddress` to support orders signed for
 * a non-default OptionBook contract. To prevent a compromised API from redirecting
 * fills to an attacker contract that drains pre-existing allowances, the address
 * MUST match the chain-configured OptionBook for the current network.
 */
resolveOptionBookTarget(orderWithSig) {
  …
  if (apiAddress.toLowerCase() !== canonical.toLowerCase()) {
    throw createError("INVALID_ORDER", `rawApiData.optionBookAddress (…) does not match configured OptionBook (…)`);
  }
  return canonical;
}
```

Two consequences:

1. **The approval is unguarded.** If the indexer response ever carried a different
   `optionBookAddress`, we would `ensureAllowance(collateralToken, thatAddress, totalCollateral)`
   — an approval to an address nothing validated — and then `fillOrder` would throw
   `INVALID_ORDER`, leaving the approval standing with nothing to consume it. Our
   `classifyFillError` maps `INVALID_ORDER` to `ORDER_EXPIRED`, so the panel would blame the book.
2. **`agreed: false` is not an amber chip, it is "no fill is possible".** `resolveOptionBook`
   (`src/server/thetanuts.ts:434-452`) surfaces disagreement as a UI state; per the SDK it means
   every fill against those orders throws. The copy should say so.

Latent today: `chainConfig.contracts.optionBook` is `0x1bDff855d6811728acaDC00989e79143a2bdfDed`
and every order in the frozen capture names the same address.

**Fix.** Cross-check before approving, and refuse on mismatch. The live adapter already reads the
chain config in the same closure — `usdcAddress = client.chainConfig?.tokens?.USDC?.address`
(`src/desk/fill.ts:977`) — so the canonical book address is one property away. The MCP's
`approveCore` does the same class of check on its own path, pinning the spender to the current
OptionFactory and rejecting anything else (`mcp/dist/prepare/core.js:115-122`).

---

## The divergences, and why ours is fine

**4 — Client construction.** Theirs (`mcp/dist/index.js:78-86`) is
`{ chainId: 8453, provider: new ethers.JsonRpcProvider(process.env.THETANUTS_RPC_URL || 'https://mainnet.base.org') }`,
built lazily behind a `getClient()` singleton over a shared provider, no signer. Ours
(`src/server/thetanuts.ts:355-367`) is the same lazy singleton, the same literal `8453`, the same
default RPC, plus `referrer` and `logger` — both first-class `ThetanutsClientConfig` fields. A
superset of theirs; nothing they set, we omit. (Except `keyStorageProvider` — see BUG-1, which
does not affect the server.)

**5 — `previewFillOrder`.** Theirs, verbatim:

```js
// mcp/dist/index.js:1876-1894
const orders = await c.api.fetchOrders();
const order = orders[orderIndex];
const usdcAmount = args.usdcAmount ? BigInt(args.usdcAmount) : undefined;
const preview = c.optionBook.previewFillOrder(order, usdcAmount);
```

No `await` on the preview — the SDK's own MCP treats it as synchronous, confirming FINDINGS
"0.3.0 delta" against the docs. The order object goes in exactly as `fetchOrders` returned it,
unmodified — which is our `freezeOrder` discipline, enforced rather than merely observed. They
read `numContracts`, `collateralToken`, `totalCollateral`, `pricePerContract`, `maker`, `expiry`,
`isCall`, `strikes` off the result: eight of the ten fields, so the rich shape is confirmed a
third time. They pass no `referrer`; we do, and the SDK's fallback chain is
`referrer ?? this.client.referrer ?? ethers.ZeroAddress`, so passing it explicitly is a no-op
when the ctor already has it and correct when it does not.

**6 — MM pricing.** They call `c.mmPricing.getAllPricing(underlying)` (ticker-keyed record) and
`getTickerPricing(ticker)`; we call `getPricingArray(underlying)` and the SDK's own
`filterByStrikeRange`. Both pairs are real 0.3.0 methods (`SDK dist/index.js:12765`, `:12780`).
The important agreement is what neither of us does: they surface `rawBidPrice`/`rawAskPrice`
*and* `feeAdjustedBid`/`feeAdjustedAsk` straight off the payload and **never recompute the fee**.
Our `buildMmQuotes` copies `feeAdjusted*` and computes only `ask - bid`. The 3e-4/4e-4 doc
contradiction stays defused by not touching it. They also expose
`getSpreadPricing`/`getCondorPricing`/`getButterflyPricing`, which we have no use for.

**7 — Staleness.** They do nothing about it: no cache, no expiry check, and `preview_fill_order`
addresses an order by its **index in the array from a previous `fetch_orders` call** — an index
that is meaningless the moment the book moves. Their `suggestReservePriceCore` even documents a
watcher-latency default of 120s. Our path is strictly stronger: refetch the book at fill time,
match by nonce when we have one and by printed identity otherwise, refuse on an ambiguous match,
and require `EXPIRY_BUFFER_MS` of signature life. (See OPPORTUNITY 10 for the one gap.)

**8 — RFQ and the keystore: our skip stands, and is reinforced.** The MCP's entire write surface
is RFQ/factory — `prepare_request_rfq`, `prepare_make_offer(_with_signature)`,
`prepare_settle_rfq(_early)`, `prepare_cancel_*`, `prepare_approve`. There is **no
`prepare_fill_order`**: you cannot build an OptionBook fill through the MCP at all, which is why
they pair it with a signer-MCP for everything else. So the MCP is not an alternative to our fill
path and offers nothing that would change the judgement to skip RFQ. What RFQ would cost us is
visible in `prepare/core.js` and `prepare/keystore.js`: an ECDH keypair per wallet, a
challenge/nonce auth handshake with replay protection, an encrypted SQLite keystore and a
32-byte master key in the environment. Also worth recording: their `PRODUCT` enum for RFQ
(`core.js:150-156`) has **no `RANGER`** — rangers are buy-off-the-book only.

---

## The opportunities

**9 — `chainConfig.optionImplementations`.** Covered in BUG-2. The single highest-value item here:
it removes a heuristic from a code path that labels money instruments.

**10 — Expiry, both fields and chain time.** The SDK's `fillOrder` checks *two* clocks before it
will sign:

```js
const currentTimestamp = await this.client.getCurrentTimestamp();
if (orderWithSig.order.expiry <= BigInt(currentTimestamp)) throw ORDER_EXPIRED;
…
if (orderWithSig.rawApiData.orderExpiryTimestamp <= currentTimestamp) throw …
```

Our `expiryMs` (`src/desk/fill.ts:619-624`) takes `rawApiData.orderExpiryTimestamp ?? order.expiry`
— the first that is present, not the smaller of the two — and compares against local wall clock.
They were equal in the capture, so this is a nit today; `Math.min` of both is free and removes the
case where the option expiry is the binding one.

**11 — "exact approval" is only exact when the fill is not clamped.** From the SDK's
`previewFillOrder`:

```js
const totalPremium = usdcAmount ?? numContracts * orderWithSig.order.price / 100000000n;
…
if (numContracts > maxContracts) numContracts = maxContracts;   // happens BEFORE, and does not feed totalPremium
return { numContracts, …, totalCollateral: totalPremium, … };
```

When we pass a rung, `totalCollateral` **is** that rung, verbatim — even when `numContracts` was
clamped down to the maker's remaining depth. So the approval and the confirmed figure can both
exceed what the contract will actually pull, leaving residual allowance. The exact number is
`numContracts * pricePerContract / 1e8`. Bounded at $2 by `MAX_FILL_USDC`, so this is a precision
and honesty point (the receipt's collateral line), not a risk.

**12 — Fees.** They expose `c.optionBook.getFees(token, referrer)` and
`getAllClaimableFees(address)` returning `{token, symbol, decimals, amount}` per token
(`mcp/dist/index.js:2299-2312`). We read only `getReferrerFeeSplit` for the footer chip. Both are
signer-free reads; a "0 bps, $0.00 accrued across N tokens" line would be strictly more honest
than the split alone.

**13 — Keystore, if P7 is ever taken.** `mcp/dist/prepare/keystore.js`: per-row 16-byte salt,
`scrypt(N=2^14, r=8, p=1)`, AES-256-GCM, SQLite under `~/.thetanuts` created `mode 0o700`, master
key from `KEYSTORE_MASTER_KEY` and validated as 64 hex chars, v1 rows with a fixed salt explicitly
refused rather than silently upgraded. That is the reference implementation for the hazard
FINDINGS flagged.

**Not a finding, but worth knowing.** The MCP hardens two things we get for free: it sanitizes
on-chain strings before they reach an LLM transcript (`sanitizeOnchainString`, TNU-AUDIT-0065 —
attacker-controlled ERC20 `symbol` as a prompt-injection vector) and caps list responses at
50/500 rows (TNU-AUDIT-0066). Our `ORDER_ROWS = 40` and `MM_ROWS = 14` caps are the same instinct,
and no attacker-controlled token symbol reaches our DOM — the instrument strings are ones we
build. Their `filter_orders` also advertises filtering "by asset" in the README while the handler
only filters `isCall` and `minExpiry`; irrelevant to us, noted so nobody trusts that column.
