/* POST /api/finals  ->  {week, from, to, legs:[{player, stat}]}
   Looks up final box score numbers with Claude and web search.
   Needs a secret named ANTHROPIC_API_KEY. Without it this returns a clear message
   and the app falls back to entering finals by hand.

   The prompt is built here, not in the browser, so nobody with the URL can send
   arbitrary requests against your API credits. */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export async function handleFinals(request, env) {
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  if (!env.ANTHROPIC_API_KEY)
    return json({ error: "No ANTHROPIC_API_KEY secret is set, so lookups are off. Enter finals by hand." }, 501);
  if (env.POOL_KEY && request.headers.get("x-pool-key") !== env.POOL_KEY)
    return json({ error: "wrong pool password" }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const legs = Array.isArray(body.legs) ? body.legs.slice(0, 8) : [];
  if (!legs.length) return json({ error: "no legs sent" }, 400);

  const list = legs.map((x, i) =>
    i + ". " + String(x.player || "").slice(0, 40) + " | stat: " + String(x.stat || "").slice(0, 30)).join("\n");

  const teamsOnly = body.mode === "teams";
  const prompt = teamsOnly ?
    ("For each numbered NFL player below, search for the team they are on right now, as of " +
     new Date().toDateString() + ".\n\n" + list.replace(/ \| stat:[^\n]*/g, "") +
     "\n\nReply with ONLY a JSON array, no prose and no markdown fences, one object per item in order:\n" +
     '[{"i":0,"team":"ATL"}]\n' +
     'Use standard abbreviations such as ATL, KC, NYJ, LV. Use "" if you are not certain or the player is a free agent.')
    :
    "Settle NFL player props from the 2026 season, Week " + Number(body.week || 0) + ".\n" +
    "Today is " + new Date().toDateString() + ". The relevant games were played between " +
      String(body.from || "").slice(0, 40) + " and " + String(body.to || "").slice(0, 40) + ".\n" +
    "For each numbered item, search for that player's official final box score total for that exact stat in that week's game.\n\n" +
    list + "\n\n" +
    "Rules:\n" +
    "- final is the raw total for that stat only, as a number.\n" +
    "- For combined stats such as Rush+Rec Yards or Pass+Rush Yards, add the components.\n" +
    "- Longest Reception and Longest Rush mean the single longest play, not the total.\n" +
    "- Fantasy Score means PrizePicks scoring: 1 point per 10 rush or rec yards, 1 per 25 pass yards, 6 per rush or rec TD, 4 per pass TD, 1 per reception, minus 1 per interception or fumble lost. If you cannot compute it confidently, use status unsure.\n" +
    "- If the player did not play, use status dnp with final null. If the game has not finished or sources disagree, use status unsure with final null.\n" +
    "- Also report the NFL team the player was on for that game, as a standard abbreviation such as ATL, KC or NYJ. Leave it empty if unsure.\n- Never guess a number.\n\n" +
    "Reply with ONLY a JSON array, no prose and no markdown fences, one object per numbered item in the same order:\n" +
    '[{"i":0,"final":75,"game":"ATL at PIT, Sep 13","team":"ATL","status":"ok"}]';

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
        tools: [{ type: "web_search_20250305", name: "web_search" }]
      })
    });
    if (!res.ok) return json({ error: "Anthropic API said " + res.status }, 502);
    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    const a = text.indexOf("["), b = text.lastIndexOf("]");
    if (a < 0 || b < 0) return json({ error: "no usable answer came back" }, 502);
    return json({ rows: JSON.parse(text.slice(a, b + 1)) });
  } catch (e) {
    return json({ error: "lookup failed: " + (e && e.message ? e.message : e) }, 502);
  }
}
