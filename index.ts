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
  "/assets/exo-kill-2.mp3": audio("exo-kill-2.mp3"),
  "/assets/exo-kill-4.mp3": audio("exo-kill-4.mp3"),
};

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    // Bun matches most-specific first, so this wins over the `/*` catch-all
    // below. `handle` never throws and always answers 200 with a typed
    // envelope — a dead feed degrades the wire, it does not fail the request.
    "/api/news": (req: Request) => news.handle(new URL(req.url)),
    ...ASSETS,
    "/*": index,
  },
});

console.log(`THETADUEL running at ${server.url}`);
