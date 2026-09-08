/* One Worker serves the site and the two API routes.
   Anything that is not /api/... falls through to the static files in ./public. */
import { handleKv } from "./src/kv.js";
import { handleFinals } from "./src/finals.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/kv") return handleKv(request, env);
    if (url.pathname === "/api/finals") return handleFinals(request, env);
    return env.ASSETS.fetch(request);
  }
};
