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

HOW A GRADED PRIZEPICKS LEG IS LAID OUT. Read carefully, these are easy to mix up:
- The LINE is the number inside the bordered box on the right, under an arrow, with the stat name beneath it.
  An up arrow means the pick was More. A down arrow means Less.
- The player's FINAL (what they actually recorded) is the number in the rounded pill sitting on the progress bar.
- Do not decide which number is the line from how it looks. A final can end in .5 (fantasy scores do), and a line can be a whole number. Go by position only: box on the right is the line, pill on the bar is the final.
- The ring around the player photo shows the result: a green ring with a check mark means the leg hit, a red ring with an x means it missed.

DEMONS AND GOBLINS:
- These are small icons shown with the projection: a demon is a red or dark devil face, a goblin is a green goblin face.
- The green ring around a winning player is NOT a goblin. Colour alone never means demon or goblin.
- If you do not see an actual demon or goblin face icon, the flavor is "standard". Most legs are standard.

For each leg report:
- player: the player name exactly as printed
- stat: the stat type as printed
- line: the number in the box on the right
- side: "More" for an up arrow, "Less" for a down arrow
- final: the number in the pill on the bar, or null if not shown
- mark: "check" for a green ring with a check, "x" for a red ring with an x, "none" if neither is shown
- result: "H" for a check, "M" for an x, "V" if voided or refunded, null if not graded yet
- flavor: "demon", "goblin" or "standard"
- flavor_evidence: if flavor is demon or goblin, describe the icon you saw and where. Otherwise ""
- team: the team abbreviation if shown, otherwise ""
- confidence: "high" if every field is clearly readable, "low" if you are unsure of any part

Rules:
- Report only legs that are actually visible. Never invent one.
- If a field is cut off or unreadable, use null and set confidence to "low".
- Report numbers exactly as printed. Do not recalculate.

Reply with ONLY a JSON object, no prose and no markdown fences:
{"legs":[{"player":"Kenneth Walker III","stat":"Rush Yards","line":80.5,"side":"More","final":117,"mark":"check","result":"H","flavor":"standard","flavor_evidence":"","team":"KC","confidence":"high"}],"note":""}

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

  /* Claude Sonnet 5 thinks by default when a request does not say otherwise, and
     max_tokens caps thinking and answer together, so thinking alone could use up
     the whole budget and leave no answer. Reading a lineup does not need
     deliberation, so thinking is switched off explicitly. If the API ever refuses
     that setting, the second attempt keeps thinking on but at low effort with far
     more room. */
  const ask = (extra, maxTokens) => fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(Object.assign({
      model: "claude-sonnet-5",
      max_tokens: maxTokens,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
          { type: "text", text: PROMPT }
        ]
      }]
    }, extra))
  });
  const PLAN_A = [{ thinking: { type: "disabled" } }, 4000];
  const PLAN_B = [{ thinking: { type: "adaptive" }, output_config: { effort: "low" } }, 16000];

  let res;
  try {
    res = await ask(...PLAN_A);
    if (res.status === 400) {
      let msg = "";
      try { const e = await res.clone().json(); msg = (e.error && e.error.message) || ""; } catch (e) {}
      if (/thinking|effort|output_config/i.test(msg)) res = await ask(...PLAN_B);
    }
  } catch (e) {
    return json({ error: "could not reach the reader: " + (e.message || e) }, 502);
  }

  if (!res.ok) {
    let detail = "";
    try { const e = await res.json(); detail = (e.error && e.error.message) || ""; } catch (e) {}
    return json({ error: "the reader said " + res.status + (detail ? ": " + detail : "") }, 502);
  }

  let text = "", stop = "", data = null;
  try {
    data = await res.json();
    stop = data.stop_reason || "";
    text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
  } catch (e) { return json({ error: "unreadable reply from the reader" }, 502); }

  /* A 200 with no text at all is unusual, so report exactly what came back
     instead of a shrug. This is what tells us whether the image arrived, whether
     the model stopped early, and what kind of blocks it sent. */
  if (!text && stop === "max_tokens") {
    try {
      const again = await ask(...PLAN_B);
      if (again.ok) {
        data = await again.json();
        stop = data.stop_reason || "";
        text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("").trim();
      }
    } catch (e) {}
  }

  if (!text) {
    const blocks = (data && Array.isArray(data.content)) ? data.content : [];
    const kinds = blocks.map(b => b && b.type).filter(Boolean).join(", ") || "none";
    const usage = (data && data.usage) || {};
    return json({
      legs: [],
      error: "the reader answered but sent no text back"
        + ". stop_reason=" + (stop || "unknown")
        + ", blocks=" + kinds
        + ", in=" + (usage.input_tokens != null ? usage.input_tokens : "?")
        + ", out=" + (usage.output_tokens != null ? usage.output_tokens : "?")
        + ", model=" + ((data && data.model) || "?"),
      diagnostic: true
    });
  }

  const out = parseSlip(text);
  if (stop === "max_tokens") out.note = (out.note ? out.note + " " : "") + "The reply ran long and was cut off, so check every leg.";
  return json(out);
}

/* Pull the JSON out of the reply and sanity check every field. Anything odd is
   dropped or flagged rather than passed through to the board. */
export function parseSlip(text) {
  let raw = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const open = raw.indexOf("{"), close = raw.lastIndexOf("}");
  if (open > 0 || close < raw.length - 1) raw = raw.slice(open === -1 ? 0 : open, close === -1 ? raw.length : close + 1);

  let obj, salvaged = false;
  try { obj = JSON.parse(raw); }
  catch (e) {
    /* A reply that was cut off or wrapped in chatter still usually holds complete
       leg objects. Pull out every one that parses on its own. */
    const found = [];
    const re = /\{[^{}]*"player"[^{}]*\}/g;
    let m;
    while ((m = re.exec(String(text || ""))) !== null) {
      try { found.push(JSON.parse(m[0])); } catch (e2) {}
    }
    if (!found.length) {
      const snippet = String(text || "").replace(/\s+/g, " ").slice(0, 160);
      return { legs: [], error: "could not read the lineup from that image. The reader said: " + (snippet || "nothing") };
    }
    obj = { legs: found, note: "" };
    salvaged = true;
  }

  const num = v => { const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.-]/g, "")); return isNaN(n) ? null : n; };
  const legs = (Array.isArray(obj.legs) ? obj.legs : []).slice(0, 12).map(L => {
    const f = String(L.flavor || "").toLowerCase().trim();
    let flavor = ["demon", "goblin", "standard"].includes(f) ? f : "standard";
    const side = String(L.side || "").toLowerCase().startsWith("l") ? "Less" : "More";
    let result = ["H", "M", "V"].includes(L.result) ? L.result : null;
    const mark = ["check", "x", "none"].includes(String(L.mark || "").toLowerCase()) ? String(L.mark).toLowerCase() : "none";
    let line = num(L.line), final = num(L.final);
    let confidence = L.confidence === "low" ? "low" : "high";
    const fixes = [];

    /* The ring is the most reliable thing on a graded leg, so it settles the result. */
    const fromMark = mark === "check" ? "H" : mark === "x" ? "M" : null;
    if (fromMark && result !== "V") result = fromMark;

    /* Check the numbers against the ring. If they disagree, the usual cause is the
       line and the final being read the wrong way round, so try them swapped. */
    const grade = (ln, fn) => (ln === null || fn === null || ln === fn) ? null
      : ((side === "More" ? fn > ln : fn < ln) ? "H" : "M");
    if (fromMark && line !== null && final !== null) {
      const asRead = grade(line, final), swapped = grade(final, line);
      if (asRead && asRead !== fromMark) {
        if (swapped === fromMark) {
          [line, final] = [final, line];
          fixes.push("line and final looked swapped, so they were flipped to match the result");
        } else {
          fixes.push("the numbers do not agree with the result shown");
        }
        confidence = "low";
      }
    }

    /* A demon or goblin needs an actual icon behind it. Colour is not evidence. */
    const ev = String(L.flavor_evidence || "").toLowerCase();
    if (flavor !== "standard") {
      const sawIcon = /icon|face|devil|demon|goblin|horn/.test(ev) && !/ring|circle|border|check|green outline/.test(ev);
      if (!sawIcon) {
        fixes.push("no demon or goblin icon was described, so it was set back to standard");
        flavor = "standard";
        confidence = "low";
      }
    }

    return {
      player: String(L.player || "").slice(0, 60).trim(),
      stat: String(L.stat || "").slice(0, 40).trim(),
      line, side, flavor,
      team: String(L.team || "").slice(0, 4).toUpperCase().trim(),
      final, result, mark,
      confidence,
      fixes
    };
  }).filter(L => L.player && L.line !== null);

  const note = String(obj.note || "").slice(0, 200);
  return { legs, note: salvaged ? ((note ? note + " " : "") + "Part of the reply was unreadable, so some legs may be missing. Check the list against the screenshot.") : note };
}
