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

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    // Bun matches most-specific first, so this wins over the `/*` catch-all
    // below. `handle` never throws and always answers 200 with a typed
    // envelope — a dead feed degrades the wire, it does not fail the request.
    "/api/news": (req: Request) => news.handle(new URL(req.url)),
    "/*": index,
  },
});

console.log(`THETADUEL running at ${server.url}`);
