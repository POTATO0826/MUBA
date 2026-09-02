/**
 * Thetanuts SDK scratch exploration — read-only, no signer, no writes.
 * Run one step at a time:   npx tsx test.ts <step>
 */
import { inspect } from 'node:util';
import { ethers } from 'ethers';
import { ThetanutsClient, isThetanutsError } from '@thetanuts-finance/thetanuts-client';

const RPC = process.env.RPC_URL ?? 'https://mainnet.base.org';
const CHAIN_ID = 8453;

const provider = new ethers.JsonRpcProvider(RPC);
const client = new ThetanutsClient({ chainId: CHAIN_ID, provider });

// ---------- output helpers ----------

const line = (c = '-') => console.log(c.repeat(72));
const head = (t: string) => { line('='); console.log(t); line('='); };

/** Deep-dump an object with every field, BigInts made visible. */
const dump = (label: string, v: unknown) => {
  console.log(`\n${label}:`);
  console.log(inspect(v, { depth: null, colors: false, maxArrayLength: null, breakLength: 100 }));
};

/** Field-name -> runtime type map, so the shape is unambiguous. */
const shapeOf = (o: Record<string, unknown>) =>
  Object.entries(o).map(([field, val]) => ({
    field,
    type: Array.isArray(val) ? 'array' : val === null ? 'null' : typeof val,
    sample: typeof val === 'object' && val !== null
      ? (Array.isArray(val) ? `[${val.length} items]` : `{${Object.keys(val).join(', ')}}`)
      : String(val),
  }));

// ---------- error handling ----------

/** The public Base RPC throttles bursts and surfaces it as CALL_EXCEPTION with no revert data. */
const looksThrottled = (err: any): boolean => {
  const chain = [err, err?.cause, err?.cause?.cause].filter(Boolean);
  return chain.some((e: any) =>
    e?.code === 'CALL_EXCEPTION' ||
    e?.code === 'RATE_LIMIT' ||
    e?.code === 'SERVER_ERROR' ||
    /missing revert data|could not coalesce|429|rate ?limit|too many requests/i.test(String(e?.message ?? '')),
  );
};

const reportError = (err: any) => {
  line();
  console.log('FAILED');
  console.log(`  code    : ${err?.code ?? '(none)'}`);
  console.log(`  message : ${err?.message ?? String(err)}`);
  if (isThetanutsError(err)) {
    console.log(`  typed   : yes (${err.constructor.name})`);
    const c: any = (err as any).cause;
    if (c) console.log(`  cause   : ${[c?.code, c?.message ?? String(c)].filter(Boolean).join(' ')}`);
  } else {
    console.log('  typed   : no (not a ThetanutsError)');
  }
  if (looksThrottled(err)) {
    line();
    console.log('>> This looks like PUBLIC RPC THROTTLING on https://mainnet.base.org');
    console.log('>> (CALL_EXCEPTION with no revert data / rate-limit shape.)');
    console.log('>> Do NOT retry blindly. Swap in a private RPC instead:');
    console.log('>>   RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY" npx tsx test.ts <step>');
  }
  line();
};

// ---------- steps ----------

async function step1_connectivity() {
  head('1. connectivity — client.api.getMarketData()');
  const market = await client.api.getMarketData();
  console.log(`RPC        : ${RPC}`);
  console.log(`chainId    : ${client.chainId}`);
  const bn = await provider.getBlockNumber();
  console.log(`block      : ${bn}   (chain is reachable)`);
  dump('getMarketData() full response', market);
  console.log('\nTop-level field shape:');
  console.table(shapeOf(market as any));
}

async function step2_liveOrders() {
  head('2. liveOrders — client.api.fetchOrders()');
  const orders = await client.api.fetchOrders();
  console.log(`order count: ${orders.length}`);
  if (orders.length === 0) {
    console.log('RESULT: empty array — no live maker orders right now. Valid result, NOT an error.');
    return;
  }
  dump('ONE full order object (orders[0])', orders[0]);
  console.log('\nField shape of one order:');
  console.table(shapeOf(orders[0] as any));
}

async function pricing(underlying: 'ETH' | 'BTC', stepLabel: string) {
  head(`${stepLabel} — client.mmPricing.getPricingArray('${underlying}')`);
  const rows = await client.mmPricing.getPricingArray(underlying);
  console.log(`pricing row count: ${rows.length}`);
  if (rows.length === 0) {
    console.log(`RESULT: empty array — no live ${underlying} MM options at this moment.`);
    console.log('This is a LEGITIMATE result (the call succeeded), NOT an error.');
    return;
  }
  console.log(`\nFirst ${Math.min(10, rows.length)} rows:`);
  console.table(rows.slice(0, 10).map((r: any) => ({
    ticker: r.ticker,
    strike: r.strike,
    isCall: r.isCall,
    expiry: r.expiry,
    expiryUTC: new Date(r.expiry * 1000).toISOString(),
    rawBid: r.rawBidPrice,
    rawAsk: r.rawAskPrice,
    mark: r.markPrice,
    underlyingPrice: r.underlyingPrice,
    passesTol: r.passesToleranceCheck,
  })));
  dump('ONE full pricing object (rows[0]) — every field, nested included', rows[0]);
  console.log('\nField shape of one mmPricing object:');
  console.table(shapeOf(rows[0] as any));
  const byCollateral = (rows[0] as any).byCollateral;
  if (byCollateral && typeof byCollateral === 'object') {
    const keys = Object.keys(byCollateral);
    console.log(`\nbyCollateral keys: [${keys.join(', ')}]`);
    if (keys[0]) {
      console.log(`\nField shape of byCollateral['${keys[0]}']:`);
      console.table(shapeOf(byCollateral[keys[0]]));
    }
  }
}

const step3_ethPricing = () => pricing('ETH', '3. ethPricing');
const step4_btcPricing = () => pricing('BTC', '4. btcPricing');

async function step5_chainConfig() {
  head('5. chainConfig — priceFeeds + implementations');
  const cfg: any = client.chainConfig;
  const feeds = cfg.priceFeeds ?? {};
  const impls = cfg.implementations ?? {};

  console.log(`priceFeeds — ${Object.keys(feeds).length} keys:`);
  console.log(Object.keys(feeds));
  console.table(Object.entries(feeds).map(([asset, addr]) => ({ asset, address: String(addr) })));

  console.log(`\nimplementations — ${Object.keys(impls).length} keys:`);
  console.log(Object.keys(impls));
  console.table(Object.entries(impls).map(([name, addr]) => ({
    implementation: name,
    address: String(addr),
    deployed: String(addr) !== ethers.ZeroAddress,
  })));

  console.log(`\nAll chainConfig top-level keys: ${Object.keys(cfg).join(', ')}`);
}

async function step6_localPayoff() {
  head('6. localPayoff — client.utils.calculatePayout()  [pure local math, no RPC]');

  const toStrike = (n: number) => client.utils.toStrikeDecimals(n);
  const ONE = 10n ** 18n;                 // 1 contract, 18dp
  const usd = (bn: bigint) => client.utils.fromUsdcDecimals(bn);

  const sweep: number[] = [];
  for (let p = 2000; p <= 4000; p += 200) sweep.push(p);

  // --- 6a: single-strike call + put, 1 contract, strike 3000
  console.log('\n[6a] type=call / type=put, strikes=[3000], numContracts=1e18 (1 contract)');
  console.table(sweep.map((p) => {
    const settlementPrice = toStrike(p);
    const call = client.utils.calculatePayout({
      type: 'call', strikes: [toStrike(3000)], settlementPrice, numContracts: ONE,
    });
    const put = client.utils.calculatePayout({
      type: 'put', strikes: [toStrike(3000)], settlementPrice, numContracts: ONE,
    });
    return {
      settlementPrice: p,
      callPayoutRaw: call.toString(),
      callPayoutUSDC: usd(call),
      putPayoutRaw: put.toString(),
      putPayoutUSDC: usd(put),
    };
  }));

  // --- 6b: two-strike spreads
  console.log('\n[6b] type=call_spread / put_spread, strikes=[2800, 3200], numContracts=1e18');
  console.table(sweep.map((p) => {
    const settlementPrice = toStrike(p);
    const cs = client.utils.calculatePayout({
      type: 'call_spread', strikes: [toStrike(2800), toStrike(3200)], settlementPrice, numContracts: ONE,
    });
    const ps = client.utils.calculatePayout({
      type: 'put_spread', strikes: [toStrike(2800), toStrike(3200)], settlementPrice, numContracts: ONE,
    });
    return {
      settlementPrice: p,
      callSpreadRaw: cs.toString(),
      callSpreadUSDC: usd(cs),
      putSpreadRaw: ps.toString(),
      putSpreadUSDC: usd(ps),
    };
  }));

  // --- 6c: does it accept RANGER? Probe it, do not fall back silently.
  console.log('\n[6c] RANGER probe — 4 strikes, as a RangerOption would be described');
  const rangerAttempts: Array<{ label: string; type: string; strikes: bigint[] }> = [
    { label: "type:'RANGER'  (registry-style name, 4 strikes)", type: 'RANGER',
      strikes: [toStrike(2600), toStrike(2900), toStrike(3100), toStrike(3400)] },
    { label: "type:'ranger'  (lowercase, 4 strikes)", type: 'ranger',
      strikes: [toStrike(2600), toStrike(2900), toStrike(3100), toStrike(3400)] },
  ];
  for (const a of rangerAttempts) {
    try {
      const out = client.utils.calculatePayout({
        type: a.type as any, strikes: a.strikes, settlementPrice: toStrike(3000), numContracts: ONE,
      });
      console.log(`  ACCEPTED  ${a.label} -> ${out.toString()}`);
    } catch (err: any) {
      console.log(`  REJECTED  ${a.label}`);
      console.log(`            code=${err?.code ?? '(none)'}  message="${err?.message ?? String(err)}"`);
    }
  }
  console.log('\n>> The RANGER outcome above is printed verbatim. No silent fallback:');
  console.log('>> the call was actually attempted and its result reported as-is.');

  // --- 6d: the argument surface actually accepted, per the shipped .d.ts
  console.log('\n[6d] Argument surface accepted by client.utils.calculatePayout(params):');
  console.table([
    { arg: 'type', required: true, type: "'call' | 'put' | 'call_spread' | 'put_spread'" },
    { arg: 'strikes', required: true, type: 'bigint[]  (1 for call/put, 2 for spreads)' },
    { arg: 'settlementPrice', required: true, type: 'bigint (8dp)' },
    { arg: 'numContracts', required: true, type: 'bigint (18dp)' },
    { arg: 'priceDecimals', required: false, type: 'number (default 8)' },
    { arg: 'sizeDecimals', required: false, type: 'number (default 18)' },
    { arg: 'collateralDecimals', required: false, type: 'number (default 6, USDC)' },
  ]);
}

// ---------- CLI ----------

const STEPS: Record<string, { name: string; fn: () => Promise<void>; rpc: boolean }> = {
  '1': { name: 'connectivity', fn: step1_connectivity, rpc: true },
  '2': { name: 'liveOrders',   fn: step2_liveOrders,   rpc: true },
  '3': { name: 'ethPricing',   fn: step3_ethPricing,   rpc: true },
  '4': { name: 'btcPricing',   fn: step4_btcPricing,   rpc: true },
  '5': { name: 'chainConfig',  fn: step5_chainConfig,  rpc: false },
  '6': { name: 'localPayoff',  fn: step6_localPayoff,  rpc: false },
};

function usage() {
  head('Thetanuts SDK scratch — read-only');
  console.log('Usage:  npx tsx test.ts <step>\n');
  console.table(Object.entries(STEPS).map(([k, v]) => ({
    step: k, name: v.name, 'needs network': v.rpc ? 'yes' : 'no (pure local)',
  })));
  console.log(`\nRPC in use: ${RPC}`);
  console.log('Override:   RPC_URL="https://base-mainnet.g.alchemy.com/v2/KEY" npx tsx test.ts 3');
  console.log('\nRead-only: no signer, no private key, no writes.');
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === 'help' || arg === '--help') { usage(); return; }

  // accept either the number or the name
  const entry = STEPS[arg] ?? Object.values(STEPS).find((s) => s.name === arg);
  if (!entry) {
    console.log(`Unknown step: "${arg}"\n`);
    usage();
    process.exitCode = 1;
    return;
  }

  const t0 = Date.now();
  try {
    await entry.fn();
    line();
    console.log(`OK — step "${entry.name}" completed in ${Date.now() - t0}ms`);
  } catch (err) {
    reportError(err);
    process.exitCode = 1;
  }
}

main();
