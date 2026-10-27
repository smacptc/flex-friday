/* Pick research for the Research screen.

   The app keeps a watch list per week under ff:research:<week>. Anyone in the pool
   adds a player and stat they are thinking about; this file fills in a brief for it:

   - Recent games: the player's number for that stat in each of his team's last six
     games, read from ESPN box scores with the same matching the live feed uses.
     Finished games never change, so each box score is saved once (ff:box:<id>) and
     every later lookup reuses it.
   - This week's game: opponent, kickoff and venue from ESPN's scoreboard.
   - The rest comes from Claude with web search: the public sportsbook line for the
     prop (PrizePicks does not publish its lines), the matchup, injuries, weather,
     news, and a lean. Needs the ANTHROPIC_API_KEY secret. Without it the recent
     games still fill in and the brief says the rest is off.

   POST /api/research {week, id}   research one watched item now, save it, return it
   researchTick(env)               the Friday morning pass, one item per cron run */

import { normName, teamCanon, flattenPlayers, readStat, currentWeek, getJson } from "./live.js";

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const researchKey = w => "ff:research:" + w;
const sbKey = espnWeek => "ff:sb:" + espnWeek;
const boxKey = id => "ff:box:" + id;
const GAMES_BACK = 6;

/* ---- D1 helpers --------------------------------------------------------------- */
async function readRow(env, key) {
  const row = await env.DB.prepare("SELECT value, version FROM kv WHERE key = ?").bind(key).first();
  if (!row) return { value: null, version: 0 };
  try { return { value: JSON.parse(row.value), version: row.version }; } catch (e) { return { value: null, version: row.version }; }
}
async function putCache(env, key, obj) {
  await env.DB.prepare(
    "INSERT INTO kv (key, value, version, updated) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, updated = excluded.updated"
  ).bind(key, JSON.stringify(obj), Date.now()).run();
}
/* Save one item's brief without clobbering anything the app wrote in the meantime:
   re-read, change only this item, write only if nobody saved in between. */
async function saveItem(env, week, id, patch) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const { value, version } = await readRow(env, researchKey(week));
    if (!value || !value.items || !value.items[id]) return null;           // removed while we were working
    Object.assign(value.items[id], patch);
    const r = await env.DB.prepare("UPDATE kv SET value = ?, version = version + 1, updated = ? WHERE key = ? AND version = ?")
      .bind(JSON.stringify(value), Date.now(), researchKey(week), version).run();
    if (r.meta.changes) return value.items[id];
  }
  throw new Error("too many saves at once");
}

/* ---- ESPN ------------------------------------------------------------------------ */
function compactBoard(board) {
  return ((board && board.events) || []).map(ev => {
    const comp = (ev.competitions && ev.competitions[0]) || {};
    const st = (ev.status && ev.status.type) || {};
    return {
      id: ev.id, date: ev.date || comp.date || null, state: st.state || "pre", detail: st.shortDetail || "",
      venue: (comp.venue && comp.venue.fullName) || null,
      indoor: comp.venue && typeof comp.venue.indoor === "boolean" ? comp.venue.indoor : null,
      weather: ev.weather ? (ev.weather.displayValue || null) : null,
      temp: ev.weather && ev.weather.temperature != null ? ev.weather.temperature : null,
      teams: (comp.competitors || []).map(c => ({ abbr: c.team && c.team.abbreviation, home: c.homeAway === "home", score: c.score }))
    };
  });
}
/* A finished week's scoreboard is saved and reused; an unfinished one is fetched. */
async function boardFor(env, espnWeek, fetchFn, trace) {
  const cached = await readRow(env, sbKey(espnWeek));
  if (cached.value && cached.value.games && cached.value.games.length && cached.value.games.every(g => g.state === "post")) {
    trace.cached++; return cached.value.games;
  }
  const games = compactBoard(await getJson("/scoreboard?seasontype=2&week=" + espnWeek + "&limit=100", fetchFn, trace));
  trace.fetched++;
  try { await putCache(env, sbKey(espnWeek), { games, at: Date.now() }); } catch (e) {}
  return games;
}
const gameFor = (games, team) => games.find(g => g.teams.some(t => teamCanon(t.abbr) === teamCanon(team))) || null;

async function boxFor(env, game, fetchFn, trace) {
  const cached = await readRow(env, boxKey(game.id));
  if (cached.value) { trace.cached++; return cached.value; }
  const box = flattenPlayers(await getJson("/summary?event=" + game.id, fetchFn, trace));
  trace.fetched++;
  if (game.state === "post") { try { await putCache(env, boxKey(game.id), box); } catch (e) {} }
  return box;
}
function findRec(box, player, team) {
  const k = normName(player);
  if (box[k]) return box[k];
  const tight = k.replace(/ /g, "");
  const byTight = Object.values(box).find(r => normName(r.name).replace(/ /g, "") === tight);
  if (byTight) return byTight;
  const last = k.split(" ").pop();
  const hits = Object.values(box).filter(r => normName(r.name).split(" ").pop() === last && (!team || teamCanon(r.team) === teamCanon(team)));
  return hits.length === 1 ? hits[0] : null;
}

/* The player's number in each of his team's last six games. A game where his team
   played but he has no line in the box score is reported as "did not play". */
async function recentGames(env, item, week, fetchFn, trace) {
  const out = [];
  if (!item.team) return { games: out, note: "No team set, so recent games could not be looked up." };
  for (let w = week; w >= 1 && out.length < GAMES_BACK; w--) {          // app week index `week` = ESPN week week+1, so ESPN weeks week..1 are past
    let games;
    try { games = await boardFor(env, w, fetchFn, trace); } catch (e) { trace.errors.push(e.message); continue; }
    const g = gameFor(games, item.team);
    if (!g) { out.push({ week: w, bye: true }); continue; }
    if (g.state !== "post") continue;
    const me = g.teams.find(t => teamCanon(t.abbr) === teamCanon(item.team)) || {};
    const opp = g.teams.find(t => teamCanon(t.abbr) !== teamCanon(item.team)) || {};
    let box;
    try { box = await boxFor(env, g, fetchFn, trace); } catch (e) { trace.errors.push(e.message); continue; }
    const rec = findRec(box, item.player, item.team);
    /* in the box score but no line for this stat (no carries, no catches) counts as zero */
    let value = rec ? readStat(rec, item.stat) : null;
    if (rec && value === null) value = 0;
    out.push({ week: w, date: g.date, opp: opp.abbr || "", home: !!me.home, value, dnp: !rec,
               score: (me.abbr || "") + " " + (me.score ?? "") + ", " + (opp.abbr || "") + " " + (opp.score ?? "") });
  }
  return { games: out.filter(x => !x.bye).slice(0, GAMES_BACK) };
}

/* ---- Claude with web search ------------------------------------------------------- */
function promptFor(item, week, game, recent) {
  const kick = game && game.date ? new Date(game.date).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " ET" : "unknown";
  const opp = game ? (game.teams.find(t => teamCanon(t.abbr) !== teamCanon(item.team)) || {}).abbr : null;
  const home = game ? !!(game.teams.find(t => teamCanon(t.abbr) === teamCanon(item.team)) || {}).home : null;
  const log = recent.length ? recent.map(g => "Week " + g.week + " " + (g.home ? "vs " : "at ") + g.opp + ": " + (g.dnp ? "did not play" : (g.value ?? "no number"))).join("\n") : "none found";
  return "Research one NFL player prop for a friends' PrizePicks pool. Today is " + new Date().toDateString() + ", 2026 NFL season, Week " + (week + 1) + ".\n\n" +
    "Player: " + String(item.player).slice(0, 40) + " (" + (item.team || "team unknown") + ")\n" +
    "Prop: " + String(item.stat).slice(0, 30) + (item.line != null && item.line !== "" ? ", line they are looking at: " + item.line : "") + "\n" +
    "This week: " + (game ? (home ? "home vs " : "away at ") + opp + ", kickoff " + kick + (game.venue ? ", " + game.venue : "") + (game.indoor ? " (indoors)" : "") : "no game found, maybe a bye") + "\n" +
    "Recent games for this stat, from ESPN box scores:\n" + log + "\n\n" +
    "Search the web and report:\n" +
    "1. The public sportsbook line for this exact prop this week (DraftKings, FanDuel, BetMGM, Caesars or a consensus page). PrizePicks does not publish lines, so use a sportsbook. For Fantasy Score there is usually no sportsbook equivalent, so use null.\n" +
    "2. Matchup: how this week's opponent defends this stat (rank or yards allowed to the position if you find it), and pace or game script if relevant.\n" +
    "3. Injuries: the player's status, key teammates (QB, linemen, other targets) and key opposing defenders.\n" +
    "4. Weather at kickoff for outdoor stadiums (wind, rain, cold). Say indoors if it is a dome or closed roof.\n" +
    "5. Recent news that changes his role or usage.\n" +
    "6. A lean on the line: More, Less or Pass, with the reason in two or three short sentences, and a confidence.\n\n" +
    "Rules: Never invent a number, line, injury or quote. If you cannot find something, use null. Keep each text field to one or two plain sentences. Never use em dashes.\n" +
    "Reply with ONLY a JSON object, no prose and no markdown fences:\n" +
    '{"line":{"value":74.5,"book":"DraftKings","url":"https://..."},"matchup":"...","injuries":"...","weather":"...","news":"...","lean":"More","why":"...","confidence":"medium","sources":[{"title":"...","url":"https://..."}]}';
}
async function askClaude(env, prompt, fetchFn) {
  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    /* same model and settings as the finals lookup: thinking off so search results
       plus the answer fit, and a cap on searches so one brief stays cheap */
    body: JSON.stringify({
      model: "claude-sonnet-5", max_tokens: 3000, thinking: { type: "disabled" },
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]
    })
  });
  if (!res.ok) {
    let detail = ""; try { const e = await res.json(); detail = (e.error && e.error.message) || ""; } catch (e) {}
    throw new Error("Anthropic API said " + res.status + (detail ? ": " + detail : ""));
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no usable answer came back" + (data.stop_reason ? " (" + data.stop_reason + ")" : ""));
  return JSON.parse(text.slice(a, b + 1));
}
const cleanText = v => (typeof v === "string" && v.trim() ? v.trim().replace(/\s*[\u2013\u2014]\s*/g, ", ").slice(0, 400) : null);
const cleanUrl = v => (typeof v === "string" && /^https:\/\//.test(v) ? v.slice(0, 500) : null);
function cleanBrief(r) {
  const line = r && r.line && r.line.value != null && !isNaN(parseFloat(r.line.value))
    ? { value: parseFloat(r.line.value), book: cleanText(r.line.book), url: cleanUrl(r.line.url) } : null;
  return {
    line, matchup: cleanText(r.matchup), injuries: cleanText(r.injuries), weather: cleanText(r.weather), news: cleanText(r.news),
    lean: ["More", "Less", "Pass"].includes(r.lean) ? r.lean : null, why: cleanText(r.why),
    confidence: ["low", "medium", "high"].includes(String(r.confidence || "").toLowerCase()) ? String(r.confidence).toLowerCase() : null,
    sources: (Array.isArray(r.sources) ? r.sources : []).map(s => ({ title: cleanText(s && s.title) || "Source", url: cleanUrl(s && s.url) })).filter(s => s.url).slice(0, 6)
  };
}

/* ---- one item, start to finish ------------------------------------------------------ */
export async function researchItem(env, week, id, opts = {}) {
  const fetchFn = opts.fetch || fetch;
  const { value } = await readRow(env, researchKey(week));
  const item = value && value.items && value.items[id];
  if (!item) throw new Error("that player is not on the research list anymore");
  const trace = { fetched: 0, cached: 0, errors: [] };
  const brief = { updated: Date.now(), game: null, recent: [], recentNote: null, ai: null, aiError: null, via: null };

  let game = null;
  if (item.team) {
    try { game = gameFor(await boardFor(env, week + 1, fetchFn, trace), item.team); } catch (e) { trace.errors.push(e.message); }
  }
  if (game) {
    const opp = game.teams.find(t => teamCanon(t.abbr) !== teamCanon(item.team)) || {};
    const me = game.teams.find(t => teamCanon(t.abbr) === teamCanon(item.team)) || {};
    brief.game = { opp: opp.abbr || "", home: !!me.home, date: game.date, venue: game.venue, indoor: game.indoor, weather: game.weather, temp: game.temp };
  }
  try {
    const r = await recentGames(env, item, week, fetchFn, trace);
    brief.recent = r.games; brief.recentNote = r.note || null;
  } catch (e) { trace.errors.push(e.message); }

  if (!env.ANTHROPIC_API_KEY) brief.aiError = "No ANTHROPIC_API_KEY secret is set, so the line, matchup, injuries and lean are off. Recent games still work.";
  else {
    try { brief.ai = cleanBrief(await askClaude(env, promptFor(item, week, game, brief.recent), fetchFn)); }
    catch (e) { brief.aiError = "Web research failed: " + (e && e.message ? e.message : e); }
  }
  brief.via = trace.fetched + " fetched, " + trace.cached + " reused" + (trace.errors.length ? "; " + trace.errors.slice(0, 2).join("; ") : "");
  return saveItem(env, week, id, { brief, researching: null });
}

export async function handleResearch(request, env, opts = {}) {
  if (request.method !== "POST") return json({ error: "use POST" }, 405);
  if (!env.DB || !env.DB.prepare) return json({ error: "No D1 binding named DB." }, 500);
  if (env.POOL_KEY && request.headers.get("x-pool-key") !== env.POOL_KEY) return json({ error: "wrong pool password" }, 401);
  let body; try { body = await request.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const week = Number.isInteger(body.week) && body.week >= 0 && body.week < 18 ? body.week : currentWeek();
  const id = String(body.id || "").slice(0, 120);
  const { value } = await readRow(env, researchKey(week));
  const item = value && value.items && value.items[id];
  if (!item) return json({ error: "that player is not on the research list" }, 404);
  /* a refresh tapped twice, or by two people at once, runs once */
  if (item.brief && Date.now() - item.brief.updated < 90 * 1000) return json({ item, note: "just refreshed" });
  try { await saveItem(env, week, id, { researching: Date.now() }); } catch (e) {}   // so the Friday pass doesn't start the same player
  try { return json({ item: await researchItem(env, week, id, opts) }); }
  catch (e) { return json({ error: e && e.message ? e.message : String(e) }, 502); }
}

/* ---- Friday morning ------------------------------------------------------------------ */
const etParts = now => {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const v = t => (p.find(x => x.type === t) || {}).value;
  return { day: v("weekday"), hour: +v("hour") % 24, date: v("year") + "-" + v("month") + "-" + v("day") };
};
/* 7 to 11 AM Eastern on Friday: every item on this week's list gets a fresh brief
   before the 5 PM lock. One item per cron run keeps each run short. */
export function inResearchWindow(now = new Date()) {
  const t = etParts(now);
  return t.day === "Fri" && t.hour >= 7 && t.hour < 11;
}
export async function researchTick(env, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const week = currentWeek(now.getTime());
  const { value } = await readRow(env, researchKey(week));
  const items = Object.values((value && value.items) || {});
  const today = etParts(now).date;
  /* skip an item another run started in the last 4 minutes: the cron fires every 2
     minutes and one brief can take longer than that, so without this two runs could
     research the same player and pay for it twice */
  const busy = it => it.researching && now.getTime() - it.researching < 4 * 60 * 1000;
  const stale = items.filter(it => !busy(it) && (!it.brief || etParts(new Date(it.brief.updated)).date !== today || etParts(new Date(it.brief.updated)).hour < 7))
    .sort((a, b) => ((a.brief && a.brief.updated) || 0) - ((b.brief && b.brief.updated) || 0));
  if (!stale.length) return { week, done: true };
  await saveItem(env, week, stale[0].id, { researching: now.getTime() });
  const it = await researchItem(env, week, stale[0].id, opts);
  return { week, researched: stale[0].id, left: stale.length - 1, ok: !!it };
}
