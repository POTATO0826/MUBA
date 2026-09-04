import index from "./src/index.html";
import { createNewsService } from "./src/server/news.ts";

/**
 * Bun serves the app directly from `index.html`: it walks the tags, bundles
 * `client.tsx` and `styles.css`, and hot-reloads them in development. No Vite,
 * no build step.
 */

/**
 * One service instance for the process, because both of its caches — the
 * per-feed TTL cache and the frozen per-match snapshot — are what make two
 * players on the same seed read the same wire. Constructing it per request
 * would defeat both and hammer the feeds.
 */
const news = createNewsService();

/**
 * The optional media: the room's waiting music and the two button clips. They
 * are deliberately NOT `import`s from `src/`: Bun's html bundler resolves
 * imports at startup and a missing one is a build error, whereas these files
 * are optional by design — operator-supplied, likely licensed, and gitignored.
 * A route that answers from disk turns "no file" into one clean 404 that the
 * sound engine already treats as silence.
 */
const audio = (name: string) => async (): Promise<Response> => {
  const file = Bun.file(`${import.meta.dir}/src/assets/${name}`);
  if (!(await file.exists())) return new Response(null, { status: 404 });
  return new Response(file, {
    headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=3600" },
  });
};

/**
 * An allowlist, not a `/assets/:name` parameter: every servable file is named
 * here in full, so no request can name a file this map does not, and a
 * traversal has nothing to reach. Adding an asset is adding a line.
 */
const ASSETS = {
  "/assets/room-inspect.mp3": audio("room-inspect.mp3"),
  "/assets/exo-kill-1.mp3": audio("exo-kill-1.mp3"),
  "/assets/exo-kill-2.mp3": audio("exo-kill-2.mp3"),
  "/assets/exo-kill-3.mp3": audio("exo-kill-3.mp3"),
  "/assets/exo-kill-4.mp3": audio("exo-kill-4.mp3"),
  // Sliced from the owner's case-open recording by `src/assets/slice-case-open.sh`
  // and played by the `spin.tick` / `spin.land` recipes, which keep their synth
  // as the fallback — so a 404 here is a voicing change, not a silence.
  "/assets/case-tick.mp3": audio("case-tick.mp3"),
  "/assets/case-land.mp3": audio("case-land.mp3"),
};

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    // Bun matches most-specific first, so this wins over the `/*` catch-all
    // below. `handle` never throws and always answers 200 with a typed
    // envelope — a dead feed degrades the wire, it does not fail the request.
    "/api/news": (req: Request) => news.handle(new URL(req.url)),

    /**
     * The WalletConnect project id, read at boot by `src/wallet/config.ts`.
     *
     * It goes over the wire rather than into the bundle because Bun's HTML
     * bundler does not inline `process.env` for `Bun.serve` routes — a
     * build-time read would work under `bun run build` and silently be
     * `undefined` under `bun dev`. The id is public either way (it ships in
     * every dApp bundle and is domain-restricted in the dashboard); serving it
     * just keeps it out of git.
     *
     * Unset means the app falls back to the mock wallet.
     */
    "/api/wallet-config": () =>
      Response.json(
        { projectId: Bun.env.WALLETCONNECT_PROJECT_ID ?? "" },
        { headers: { "cache-control": "no-store" } },
      ),

    /**
     * The whole client-visible boot configuration, of which the wallet id is
     * now one field. `/api/wallet-config` above stays byte-identical as the
     * alias `src/wallet/config.ts` already fetches — this route supersets it
     * rather than replacing it, so the wallet layer needs no edit and the
     * rollback story ("flags off → today's app") stays exact.
     *
     * Everything here is public by construction: a WalletConnect id, a chain
     * id, two on-chain addresses and three booleans. The secrets that make
     * these useful — `RPC_URL`, `ATTESTOR_PRIVATE_KEY` — are read only on the
     * server and never appear in this envelope (`test/secrets.test.ts` holds
     * that line for the bundle).
     *
     * Feature flags, and why they default the way they do:
     *   - `market` is OPT-OUT (`THETADUEL_MARKET=off` is the kill switch): live
     *     market data is read-only and display-only, so the safe default is on
     *     and a dead API degrades to the mock rather than to a broken page.
     *   - `stake` and `trade` are OPT-IN (`=on` exactly): both move real money
     *     on Base mainnet. Anything that can spend USDC is off until an
     *     operator says otherwise, in this process, on purpose.
     *
     * `no-store`, like the alias: flipping a kill switch must take effect on
     * the next reload, not after a cache expires.
     */
    "/api/config": () =>
      Response.json(
        {
          projectId: Bun.env.WALLETCONNECT_PROJECT_ID ?? "",
          chainId: 8453,
          referrer: Bun.env.THETADUEL_REFERRER ?? "",
          escrow: Bun.env.THETADUEL_ESCROW ?? "",
          features: {
            market: Bun.env.THETADUEL_MARKET !== "off",
            stake: Bun.env.THETADUEL_STAKE === "on",
            trade: Bun.env.THETADUEL_TRADE === "on",
          },
        },
        { headers: { "cache-control": "no-store" } },
      ),
    ...ASSETS,
    "/*": index,
  },
});

console.log(`THETADUEL running at ${server.url}`);
if (!Bun.env.WALLETCONNECT_PROJECT_ID) {
  console.log(
    "no WALLETCONNECT_PROJECT_ID — running on the mock wallet.\n" +
      "  get an id at https://dashboard.walletconnect.com and put it in .env",
  );
}
