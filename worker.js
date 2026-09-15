/* One Worker serves the site, the API routes, the icons, and the live feed.
   The icons are decoded from base64 in src/icons.js rather than read from disk,
   so no binary file ever has to survive a copy and paste. */
import { handleKv } from "./src/kv.js";
import { handleFinals } from "./src/finals.js";
import { handleLive, refreshLive } from "./src/live.js";
import { handleSlip } from "./src/slip.js";
import { ICON_FILES, MANIFEST } from "./src/icons.js";

function bytes(b64){
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

/* Eastern time, whatever the server thinks the date is */
export function inGameWindow(now = new Date()) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false
  }).formatToParts(now);
  const day = p.find(x => x.type === "weekday").value;
  const hour = +p.find(x => x.type === "hour").value % 24;
  switch (day) {
    case "Sun": return hour >= 12;               // early window through Sunday night
    case "Mon": return hour < 2 || hour >= 19;   // the tail of Sunday night, then Monday night
    case "Tue": return hour < 2;
    case "Thu": return hour >= 19;
    case "Fri": return hour < 2;
    case "Sat": return hour >= 12;               // late season Saturday games
    default: return false;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/kv") return handleKv(request, env);
    if (url.pathname === "/api/finals") return handleFinals(request, env);
    if (url.pathname === "/api/live") return handleLive(request, env);
    if (url.pathname === "/api/slip") return handleSlip(request, env);

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
  },

  /* The cron runs every couple of minutes all week. Deciding when a game could
     be on happens here rather than in the schedule, because Cloudflare's cron
     syntax refused the day-of-week form and the free plan caps the number of
     triggers. Outside a window this returns immediately, touching nothing. */
  async scheduled(event, env, ctx) {
    if (!inGameWindow()) return;
    ctx.waitUntil(refreshLive(env));
  }
};
