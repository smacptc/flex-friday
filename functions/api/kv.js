/* GET  /api/kv?key=ff:season   ->  {value, version}   (version 0 means it does not exist yet)
   PUT  /api/kv                 ->  {key, value, ifVersion}
        200 {version}    saved
        409 {value, version, conflict:true}   somebody else wrote first, here is the current copy

   The version check is what keeps two people from clobbering each other when they
   submit at the same moment. The client re-applies its change to the fresh copy and retries. */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });

export async function onRequest(context) {
  const { request, env } = context;

  if (!env.DB) return json({ error: "No D1 binding named DB. Add it in Settings, Bindings, then redeploy." }, 500);

  if (request.method === "GET") {
    const key = new URL(request.url).searchParams.get("key");
    if (!key) return json({ error: "missing key" }, 400);
    const row = await env.DB.prepare("SELECT value, version FROM kv WHERE key = ?").bind(key).first();
    if (!row) return json({ value: null, version: 0 });
    return json({ value: row.value, version: row.version });
  }

  if (request.method === "PUT") {
    // Optional shared password. Set POOL_KEY in Settings, Variables to turn it on.
    if (env.POOL_KEY && request.headers.get("x-pool-key") !== env.POOL_KEY)
      return json({ error: "wrong pool password" }, 401);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
    const { key, value, ifVersion } = body || {};
    if (!key || typeof value !== "string") return json({ error: "need key and value" }, 400);
    if (value.length > 900000) return json({ error: "document too large" }, 413);

    const now = Date.now();
    let changed;

    if (!ifVersion) {
      const r = await env.DB
        .prepare("INSERT INTO kv (key, value, version, updated) VALUES (?, ?, 1, ?) ON CONFLICT(key) DO NOTHING")
        .bind(key, value, now).run();
      changed = r.meta.changes;
    } else {
      const r = await env.DB
        .prepare("UPDATE kv SET value = ?, version = version + 1, updated = ? WHERE key = ? AND version = ?")
        .bind(value, now, key, ifVersion).run();
      changed = r.meta.changes;
    }

    if (changed) {
      const row = await env.DB.prepare("SELECT version FROM kv WHERE key = ?").bind(key).first();
      return json({ version: row ? row.version : 1 });
    }

    const cur = await env.DB.prepare("SELECT value, version FROM kv WHERE key = ?").bind(key).first();
    return json({ conflict: true, value: cur ? cur.value : null, version: cur ? cur.version : 0 }, 409);
  }

  return json({ error: "use GET or PUT" }, 405);
}
