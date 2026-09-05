import { routes } from "../src/server/http.ts";

type RouteRequest = Request & { params: Record<string, string> };
type Handler = (request: RouteRequest) => Response | Promise<Response>;
type Route = Handler | Record<string, Handler>;

// Share the local handlers without importing the HTML bundler or starting a
// listening server inside a Vercel Function.
const entries = Object.entries(routes).map(([path, route]) => ({
  segments: path.split("/"),
  route: route as Route,
}));

export default {
  async fetch(request: Request): Promise<Response> {
    const segments = new URL(request.url).pathname.replace(/\/$/, "").split("/");
    for (const entry of entries) {
      if (entry.segments.length !== segments.length) continue;
      const params: Record<string, string> = {};
      const matches = entry.segments.every((segment, i) => {
        if (!segment.startsWith(":")) return segment === segments[i];
        params[segment.slice(1)] = segments[i]!;
        return true;
      });
      if (!matches) continue;

      const handler = typeof entry.route === "function"
        ? entry.route
        : entry.route[request.method];
      if (!handler) {
        return new Response(null, {
          status: 405,
          headers: { Allow: Object.keys(entry.route).join(", ") },
        });
      }
      const response = await handler(Object.assign(request, { params }));
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
