import index from "./src/index.html";
import { routes } from "./src/server/http.ts";

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== "production",
  routes: { ...routes, "/*": index },
});

console.log(`THETADUEL running at ${server.url}`);
if (!Bun.env.WALLETCONNECT_PROJECT_ID) {
  console.log("no WALLETCONNECT_PROJECT_ID — running on the mock wallet.");
}
