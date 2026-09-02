/**
 * Thetanuts SDK scratch UI — local read-only server.
 *
 *   npx tsx server.ts     ->  http://localhost:8787
 *
 * The SDK runs here in Node (it needs an ethers provider); the browser page just
 * fetches JSON from these endpoints. No signer, no private key, no writes.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ethers } from 'ethers';
import { ThetanutsClient, isThetanutsError } from '@thetanuts-finance/thetanuts-client';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8787);
const RPC = process.env.RPC_URL ?? 'https://mainnet.base.org';
const CHAIN_ID = 8453;

const provider = new ethers.JsonRpcProvider(RPC);
const client = new ThetanutsClient({ chainId: CHAIN_ID, provider });

// ---------- helpers ----------

/** BigInt -> string, so anything the SDK returns survives JSON.stringify. */
const encode = (v: unknown) =>
  JSON.stringify(v, (_k, val) => (typeof val === 'bigint' ? val.toString() : val));

/** Public Base RPC throttles bursts and surfaces it as CALL_EXCEPTION with no revert data. */
const looksThrottled = (err: any): boolean => {
  const chain = [err, err?.cause, err?.cause?.cause].filter(Boolean);
  return chain.some((e: any) =>
    e?.code === 'CALL_EXCEPTION' ||
    e?.code === 'RATE_LIMIT' ||
    e?.code === 'SERVER_ERROR' ||
    /missing revert data|could not coalesce|429|rate ?limit|too many requests/i.test(String(e?.message ?? '')),
  );
};

const errorPayload = (err: any) => ({
  ok: false as const,
  code: err?.code ?? null,
  message: err?.message ?? String(err),
  typed: isThetanutsError(err) ? err.constructor.name : null,
  throttled: looksThrottled(err),
  throttleHint: looksThrottled(err)
    ? 'Public RPC https://mainnet.base.org is throttling. Do not retry blindly — restart with RPC_URL="https://base-mainnet.g.alchemy.com/v2/YOUR_KEY" npx tsx server.ts'
    : null,
});

/** Tiny TTL cache so clicking around the UI does not hammer the public RPC. */
const cache = new Map<string, { at: number; data: unknown }>();
const TTL_MS = 15_000;

async function cached<T>(key: string, fn: () => Promise<T>): Promise<{ data: T; ageMs: number }> {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return { data: hit.data as T, ageMs: now - hit.at };
  const data = await fn();
  cache.set(key, { at: now, data });
  return { data, ageMs: 0 };
}

// ---------- route handlers ----------

const routes: Record<string, (url: URL) => Promise<unknown>> = {
  '/api/health': async () => {
    const t0 = Date.now();
    const [market, block] = await Promise.all([
      client.api.getMarketData(),
      provider.getBlockNumber(),
    ]);
    return {
      ok: true,
      rpc: RPC,
      chainId: client.chainId,
      chainName: (client.chainConfig as any).name ?? null,
      block,
      latencyMs: Date.now() - t0,
      sdkVersion: '0.2.5',
      readOnly: client.signer === undefined,
      market,
    };
  },

  '/api/orders': async () => {
    const { data, ageMs } = await cached('orders', () => client.api.fetchOrders());
    return { ok: true, ageMs, count: (data as unknown[]).length, orders: data };
  },

  '/api/pricing': async (url) => {
    const underlying = (url.searchParams.get('underlying') ?? 'ETH').toUpperCase();
    const { data, ageMs } = await cached(`pricing:${underlying}`, () =>
      (client.mmPricing as any).getPricingArray(underlying),
    );
    const rows = data as any[];
    return {
      ok: true,
      ageMs,
      underlying,
      count: rows.length,
      // An empty array is a legitimate result, not an error. It also happens for
      // underlyings the SDK does not price (SOL/DOGE/PAXG) — it returns [] rather than throwing.
      empty: rows.length === 0,
      emptyNote: rows.length === 0
        ? `getPricingArray('${underlying}') returned an empty array. The call SUCCEEDED — this means no live MM options, or the underlying is not priced by the SDK (only ETH and BTC are).`
        : null,
      rows,
    };
  },

  '/api/config': async () => {
    const cfg: any = client.chainConfig;
    const impls = cfg.implementations ?? {};
    return {
      ok: true,
      chainId: cfg.chainId,
      name: cfg.name,
      topLevelKeys: Object.keys(cfg),
      priceFeeds: cfg.priceFeeds ?? {},
      implementations: Object.entries(impls).map(([name, address]) => ({
        name,
        address: String(address),
        deployed: String(address) !== ethers.ZeroAddress,
      })),
      contracts: cfg.contracts ?? {},
    };
  },

  '/api/payout': async (url) => {
    const type = url.searchParams.get('type') ?? 'call';
    const strikes = (url.searchParams.get('strikes') ?? '3000')
      .split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    const contracts = Number(url.searchParams.get('contracts') ?? '1');
    const from = Number(url.searchParams.get('from') ?? '2000');
    const to = Number(url.searchParams.get('to') ?? '4000');
    const steps = Math.min(Math.max(Number(url.searchParams.get('steps') ?? '21'), 2), 200);

    const numContracts = ethers.parseUnits(String(contracts), 18);
    const strikeBns = strikes.map((s) => client.utils.toStrikeDecimals(s));

    // Probe the type once. If the SDK rejects it (e.g. RANGER), report that verbatim
    // rather than silently falling back to something it does accept.
    try {
      client.utils.calculatePayout({
        type: type as any, strikes: strikeBns,
        settlementPrice: client.utils.toStrikeDecimals(from), numContracts,
      });
    } catch (err: any) {
      return {
        ok: false,
        rejected: true,
        type,
        code: err?.code ?? null,
        message: err?.message ?? String(err),
        accepted: ['call', 'put', 'call_spread', 'put_spread'],
        note: `client.utils.calculatePayout rejected type "${type}". No fallback was applied.`,
      };
    }

    const rows = [];
    for (let i = 0; i < steps; i++) {
      const price = from + ((to - from) * i) / (steps - 1);
      const payout = client.utils.calculatePayout({
        type: type as any, strikes: strikeBns,
        settlementPrice: client.utils.toStrikeDecimals(price), numContracts,
      });
      rows.push({
        settlementPrice: price,
        payoutRaw: payout.toString(),
        payoutUsdc: Number(client.utils.fromUsdcDecimals(payout)),
      });
    }
    return { ok: true, type, strikes, contracts, local: true, rows };
  },

  /** Demonstrates that unsupported underlyings return [] instead of throwing. */
  '/api/probe-underlyings': async () => {
    const out = [];
    for (const u of ['ETH', 'BTC', 'SOL', 'DOGE', 'XRP', 'BNB', 'PAXG', 'AVAX']) {
      try {
        const rows = await (client.mmPricing as any).getPricingArray(u);
        out.push({ underlying: u, outcome: 'returned array', rows: rows.length, threw: false });
      } catch (err: any) {
        out.push({ underlying: u, outcome: `threw ${err?.code ?? 'error'}`, rows: 0, threw: true });
      }
    }
    return { ok: true, results: out };
  },
};

// ---------- server ----------

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const send = (code: number, body: string, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  };

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(join(HERE, 'ui.html'), 'utf8');
      return send(200, html, 'text/html; charset=utf-8');
    } catch {
      return send(500, encode({ ok: false, message: 'ui.html not found next to server.ts' }));
    }
  }

  const handler = routes[url.pathname];
  if (!handler) return send(404, encode({ ok: false, message: `no route ${url.pathname}` }));

  try {
    const data = await handler(url);
    send(200, encode(data));
  } catch (err) {
    console.error(`[${url.pathname}]`, (err as any)?.code ?? '', (err as any)?.message ?? err);
    send(200, encode(errorPayload(err))); // 200 so the UI can render the typed error itself
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Thetanuts scratch UI  —  read-only, no signer');
  console.log(`  http://localhost:${PORT}`);
  console.log(`  RPC: ${RPC}`);
  console.log('');
  console.log('  Override RPC:  RPC_URL="https://base-mainnet.g.alchemy.com/v2/KEY" npx tsx server.ts');
  console.log('');
});
