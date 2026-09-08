/* One Worker serves the site, the two API routes, and the icons.
   The icons are decoded from base64 in src/icons.js rather than being read from
   disk, so no binary file ever has to survive a copy and paste. */
import { handleKv } from "./src/kv.js";
import { handleFinals } from "./src/finals.js";
import { ICON_FILES, MANIFEST } from "./src/icons.js";

function bytes(b64){
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/kv") return handleKv(request, env);
    if (url.pathname === "/api/finals") return handleFinals(request, env);

    if (url.pathname === "/manifest.webmanifest")
      return new Response(MANIFEST, {
        headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" }
      });

    const icon = ICON_FILES[url.pathname];
    if (icon)
      return new Response(bytes(icon.b64), {
        headers: { "content-type": icon.type, "cache-control": "public, max-age=86400" }
      });

    return env.ASSETS.fetch(request);
  }
};
