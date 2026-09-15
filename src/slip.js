/* POST /api/slip  ->  {image: "<base64, no data: prefix>", mediaType: "image/jpeg"}

   Reads a PrizePicks lineup screenshot and returns the legs it can see: player,
   stat, line, side, whether the line was a demon or a goblin, and the graded
   result if the screenshot shows one.

   Needs the same ANTHROPIC_API_KEY secret as /api/finals. Without it this says so
   plainly and the app keeps working by hand.

   Nothing here is trusted automatically. The app shows what was read and the
   commissioner confirms it before anything is written to the board. */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const MAX_BYTES = 5 * 1024 * 1024;          /* the API limit for one image */
const OK_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

const PROMPT = `This is a screenshot of a PrizePicks lineup. Read every leg you can see.

PrizePicks marks some projections with a special icon:
- A demon (a red or dark devil face) means a harder line that pays more.
- A goblin (a green goblin face) means an easier line that pays less.
- Most projections have no icon at all, which is a standard line.

For each leg report:
- player: the player name exactly as printed
- stat: the stat type as printed, for example "Pass Yards", "Rush+Rec Yards", "Receptions"
- line: the projection number, as a number
- side: "More" or "Less", whichever the lineup shows was taken
- flavor: "demon", "goblin" or "standard"
- team: the team abbreviation if shown, otherwise ""
- final: the player's actual result for that stat if the screenshot shows it graded, otherwise null
- result: "H" if this leg is shown as a win or correct, "M" if shown as a loss or incorrect, "V" if voided or refunded, or null if the screenshot does not show a result yet
- confidence: "high" if you can read every field clearly, "low" if you are guessing at any part

Rules:
- Report only legs that are actually visible. Never invent one to round out a lineup.
- If a field is cut off or unreadable, use null for it and set confidence to "low".
- Do not convert or recalculate anything. Report the numbers as printed.

Reply with ONLY a JSON object, no prose and no markdown fences:
{"legs":[{"player":"Bijan Robinson","stat":"Rush+Rec Yards","line":99.5,"side":"More","flavor":"standard","team":"ATL","final":112,"result":"H","confidence":"high"}],"note":""}

If the image is not a PrizePicks lineup, reply {"legs":[],"note":"say what the image appears to show instead"}.`;

export async function handleSlip(request, env, opts = {}) {
  const fetchFn = opts.fetch || fetch;
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  if (!env.ANTHROPIC_API_KEY)
    return json({ error: "No ANTHROPIC_API_KEY secret is set, so reading screenshots is off. Grade by hand." }, 501);
  if (env.POOL_KEY && request.headers.get("x-pool-key") !== env.POOL_KEY)
    return json({ error: "wrong pool password" }, 401);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }

  const b64 = String(body.image || "").replace(/^data:[^,]*,/, "");
  const mediaType = OK_TYPES.includes(body.mediaType) ? body.mediaType : "image/jpeg";
  if (!b64) return json({ error: "no image sent" }, 400);
  if (b64.length * 0.75 > MAX_BYTES)
    return json({ error: "that image is too big. Crop it or send a smaller screenshot." }, 413);

  let res;
  try {
    res = await fetchFn("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 1500,
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: PROMPT }
          ]
        }]
      })
    });
  } catch (e) {
    return json({ error: "could not reach the reader: " + (e.message || e) }, 502);
  }

  if (!res.ok) {
    let detail = "";
    try { const e = await res.json(); detail = (e.error && e.error.message) || ""; } catch (e) {}
    return json({ error: "the reader said " + res.status + (detail ? ": " + detail : "") }, 502);
  }

  let text = "";
  try {
    const data = await res.json();
    text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  } catch (e) { return json({ error: "unreadable reply from the reader" }, 502); }

  return json(parseSlip(text));
}

/* Pull the JSON out of the reply and sanity check every field. Anything odd is
   dropped or flagged rather than passed through to the board. */
export function parseSlip(text) {
  let raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const open = raw.indexOf("{"), close = raw.lastIndexOf("}");
  if (open > 0 || close < raw.length - 1) raw = raw.slice(open === -1 ? 0 : open, close === -1 ? raw.length : close + 1);

  let obj;
  try { obj = JSON.parse(raw); } catch (e) { return { legs: [], error: "could not read the lineup from that image" }; }

  const num = v => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.-]/g, "")); return isNaN(n) ? null : n; };
  const legs = (Array.isArray(obj.legs) ? obj.legs : []).slice(0, 12).map(L => {
    const f = String(L.flavor || "").toLowerCase().trim();
    const flavor = ["demon", "goblin", "standard"].includes(f) ? f : "standard";
    const side = String(L.side || "").toLowerCase().startsWith("l") ? "Less" : "More";
    const result = ["H", "M", "V"].includes(L.result) ? L.result : null;
    return {
      player: String(L.player || "").slice(0, 60).trim(),
      stat: String(L.stat || "").slice(0, 40).trim(),
      line: num(L.line),
      side, flavor,
      team: String(L.team || "").slice(0, 4).toUpperCase().trim(),
      final: num(L.final),
      result,
      confidence: L.confidence === "low" ? "low" : "high"
    };
  }).filter(L => L.player && L.line !== null);

  return { legs, note: String(obj.note || "").slice(0, 200) };
}
