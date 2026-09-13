/* Live numbers during games.

   A cron trigger calls refreshLive every minute during game windows. It reads the
   week's picks, finds each player's game on ESPN's scoreboard, pulls that game's
   box score, and writes one document to D1 under ff:live. The app polls that key.

   The ESPN endpoints are undocumented. Everything here is defensive: a missing
   field means "no number yet", never a crash, and every failure is written into
   the document so the app can say plainly that the feed is down.

   GET /api/live            -> the current ff:live document
   GET /api/live?refresh=1  -> refresh first (skipped if it ran in the last 30s), then return it */

const LIVE_KEY = "ff:live", SEASON_KEY = "ff:season", ROSTER_KEY = "ff:roster";

/* Friday 5pm locks, Tuesday 7am rollovers, mirrored from the app so the Worker
   agrees with it about which week is on screen. */
const ROLLOVERS = [
  "2026-09-15T07:00:00-04:00","2026-09-22T07:00:00-04:00","2026-09-29T07:00:00-04:00",
  "2026-10-06T07:00:00-04:00","2026-10-13T07:00:00-04:00","2026-10-20T07:00:00-04:00",
  "2026-10-27T07:00:00-04:00","2026-11-03T07:00:00-05:00","2026-11-10T07:00:00-05:00",
  "2026-11-17T07:00:00-05:00","2026-11-24T07:00:00-05:00","2026-12-01T07:00:00-05:00",
  "2026-12-08T07:00:00-05:00","2026-12-15T07:00:00-05:00","2026-12-22T07:00:00-05:00",
  "2026-12-29T07:00:00-05:00","2027-01-05T07:00:00-05:00","2027-01-12T07:00:00-05:00"
].map(s => new Date(s).getTime());
export const currentWeek = (now = Date.now()) => {
  for (let i = 0; i < ROLLOVERS.length; i++) if (ROLLOVERS[i] > now) return i;
  return ROLLOVERS.length - 1;
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/* ---- name matching, same rules as the app ------------------------------- */
export const normName = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[.'`\u2019-]/g, " ").replace(/\s+(jr|sr|ii|iii|iv)\s*$/, "").replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const lastOf = n => { const p = normName(n).split(" "); return p[p.length - 1]; };

/* ---- reading a box score -------------------------------------------------- */
const num = v => { const n = parseFloat(String(v ?? "").replace(/,/g, "")); return isNaN(n) ? null : n; };
/* "22/31" -> [22, 31]; "3-27" -> [3, 27] */
const pair = v => { const m = String(v ?? "").match(/(-?[\d.]+)\s*[\/-]\s*(-?[\d.]+)/); return m ? [num(m[1]), num(m[2])] : [null, null]; };

/* Pull every stat ESPN lists for one athlete into a flat object keyed by the
   category and the key name it uses, e.g. rushing.rushingYards. Keys are matched
   by name so column order changing does not break anything. */
export function flattenPlayers(summary) {
  const out = {};
  const teams = (summary && summary.boxscore && summary.boxscore.players) || [];
  for (const t of teams) {
    const abbr = t.team && t.team.abbreviation;
    for (const cat of t.statistics || []) {
      const keys = cat.keys || cat.labels || [];
      for (const a of cat.athletes || []) {
        const name = a.athlete && a.athlete.displayName;
        if (!name) continue;
        const k = normName(name);
        const rec = out[k] || (out[k] = { name, team: abbr, stats: {} });
        (a.stats || []).forEach((v, i) => { if (keys[i]) rec.stats[cat.name + "." + keys[i]] = v; });
      }
    }
  }
  return out;
}

/* One picked stat from a flattened record. The stat field in the app is free
   text, so people type "Pass yards", "Pass Yards", "pass yds". Match on a
   normalized form with ordered rules, longest and most specific first, rather
   than on an exact string. Returns null when the box score has no line for it
   yet, which is different from zero. */
export const statKey = s => String(s || "").toLowerCase()
  .replace(/&/g, "+").replace(/\band\b/g, "+")
  .replace(/yds/g, "yards").replace(/rec\b/g, "rec").replace(/tds?\b/g, "td")
  .replace(/receiving/g, "rec").replace(/receptions?/g, "receptions")
  .replace(/rushing/g, "rush").replace(/passing/g, "pass")
  .replace(/[^a-z+]+/g, " ").replace(/\s*\+\s*/g, "+").replace(/\s+/g, " ").trim();

export function readStat(rec, stat) {
  const s = rec ? rec.stats : {};
  const g = k => s[k];
  const passY = num(g("passing.passingYards")), passTD = num(g("passing.passingTouchdowns"));
  const ints = num(g("passing.interceptions"));
  const [comp, att] = pair(g("passing.completions/passingAttempts"));
  const rushY = num(g("rushing.rushingYards")), rushTD = num(g("rushing.rushingTouchdowns"));
  const rushA = num(g("rushing.rushingAttempts")), longRush = num(g("rushing.longRushing"));
  const rec_ = num(g("receiving.receptions")), recY = num(g("receiving.receivingYards"));
  const recTD = num(g("receiving.receivingTouchdowns")), longRec = num(g("receiving.longReception"));
  const fumLost = num(g("fumbles.fumblesLost"));
  const sum = (...xs) => xs.some(x => x !== null) ? xs.reduce((a, x) => a + (x || 0), 0) : null;

  const k = statKey(stat);
  const fantasy = () => {
    if ([passY, rushY, recY, rec_].every(x => x === null)) return null;
    const v = (passY || 0) * 0.04 + (passTD || 0) * 4 - (ints || 0) + (rushY || 0) * 0.1 + (rushTD || 0) * 6
            + (recY || 0) * 0.1 + (recTD || 0) * 6 + (rec_ || 0) - (fumLost || 0) * 2;
    return Math.round(v * 100) / 100;
  };

  /* order matters: the combined props have to be tested before the single ones */
  const RULES = [
    [/^pass\+rush\+rec\s*td/,        () => sum(passTD, rushTD, recTD)],
    [/^rush\+rec\s*td/,               () => sum(rushTD, recTD)],
    [/^(total|any)?\s*td/,             () => sum(passTD, rushTD, recTD)],
    [/^pass\+rush\s*yard/,            () => sum(passY, rushY)],
    [/^rush\+rec\s*yard/,             () => sum(rushY, recY)],
    [/fantasy/,                       fantasy],
    [/^pass\s*yard/,                   () => passY],
    [/^pass\s*td/,                     () => passTD],
    [/^pass\s*(attempt|att)/,          () => att],
    [/completion/,                    () => comp],
    [/interception/,                  () => ints],
    [/^rush\s*yard/,                   () => rushY],
    [/^rush\s*(attempt|att|carr)/,     () => rushA],
    [/^rush\s*td/,                     () => rushTD],
    [/longest\s*rec/,                 () => longRec],
    [/longest\s*rush/,                () => longRush],
    [/^rec\s*yard/,                    () => recY],
    [/^rec\s*td/,                      () => recTD],
    [/reception|^rec$|catches/,       () => rec_],
    [/kick/,                          () => num(g("kicking.totalKickingPoints"))],
    [/tackle/,                        () => num(g("defensive.totalTackles"))],
    [/sack/,                          () => num(g("defensive.sacks"))]
  ];
  for (const [re, fn] of RULES) if (re.test(k)) return fn();
  return null;
}

/* ---- the scoreboard ------------------------------------------------------- */
function gamesByTeam(scoreboard) {
  const map = {};
  for (const ev of (scoreboard && scoreboard.events) || []) {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp) continue;
    const st = (ev.status && ev.status.type) || {};
    const g = {
      id: ev.id,
      state: st.state || "pre",           // pre, in, post
      detail: st.shortDetail || st.detail || "",
      clock: (ev.status && ev.status.displayClock) || "",
      period: (ev.status && ev.status.period) || 0,
      teams: (comp.competitors || []).map(c => ({
        abbr: c.team && c.team.abbreviation, score: c.score, home: c.homeAway === "home"
      }))
    };
    for (const t of g.teams) if (t.abbr) map[t.abbr] = g;
  }
  return map;
}

/* ---- the refresh ---------------------------------------------------------- */
async function readKey(env, key) {
  const row = await env.DB.prepare("SELECT value, version FROM kv WHERE key = ?").bind(key).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch (e) { return null; }
}
async function writeLive(env, doc) {
  const now = Date.now(), value = JSON.stringify(doc);
  await env.DB.prepare(
    "INSERT INTO kv (key, value, version, updated) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, updated = excluded.updated"
  ).bind(LIVE_KEY, value, now).run();
}

/* ESPN's edge filters on the User-Agent, and not the way you would expect: it
   refuses browser-impersonating strings AND bare custom tokens like
   "flex-friday/1.0", while accepting an honest token that links to the project,
   or plain library defaults. Several projects hit this in August 2026. So try a
   short chain and remember whichever one answers. */
const UA_CHAIN = [
  { host: "https://site.api.espn.com", ua: "flex-friday/1.0 (+https://github.com/smacptc/flex-friday)", label: "site+token" },
  { host: "https://site.api.espn.com", ua: "curl/8.5.0", label: "site+curl" },
  { host: "https://site.web.api.espn.com", ua: "flex-friday/1.0 (+https://github.com/smacptc/flex-friday)", label: "web+token" },
  { host: "https://site.web.api.espn.com", ua: "curl/8.5.0", label: "web+curl" }
];
const PATH = "/apis/site/v2/sports/football/nfl";
let WORKING = null;          /* set once a combination answers, reused for the rest of the run */

async function getJson(path, fetchFn, trace) {
  const order = WORKING ? [WORKING, ...UA_CHAIN.filter(c => c !== WORKING)] : UA_CHAIN;
  let last = "";
  for (const combo of order) {
    let r;
    try {
      r = await fetchFn(combo.host + PATH + path, {
        headers: { "user-agent": combo.ua, "accept": "application/json" },
        cf: { cacheTtl: 20 }
      });
    } catch (e) { last = combo.label + " threw " + (e.message || e); continue; }
    if (r.ok) {
      WORKING = combo;
      if (trace) trace.via = combo.label;
      return r.json();
    }
    last = "ESPN " + r.status + " via " + combo.label;
    if (r.status !== 403 && r.status !== 401) break;   /* only the block is worth retrying */
  }
  throw new Error(last + " on " + (path.split("?")[0] || "scoreboard"));
}

export async function refreshLive(env, opts = {}) {
  const fetchFn = opts.fetch || fetch;
  const now = opts.now || Date.now();
  const week = opts.week !== undefined ? opts.week : currentWeek(now);
  const doc = { week, updated: now, source: "ESPN, unofficial", via: null, games: {}, legs: {}, error: null };

  try {
    const season = await readKey(env, SEASON_KEY);
    const roster = await readKey(env, ROSTER_KEY);
    const picks = (season && season.weeks && season.weeks[week] && season.weeks[week].picks) || {};
    const members = (roster && roster.members) || [];
    if (!Object.keys(picks).length) { doc.note = "no legs posted for this week"; await writeLive(env, doc); return doc; }

    /* The bare scoreboard can come back with only part of the slate, which left a
       team looking like it had no game. Ask for the week explicitly. */
    const board = await getJson("/scoreboard?seasontype=2&week=" + (week + 1) + "&limit=100", fetchFn, doc);
    const byTeam = gamesByTeam(board);

    /* which games do we actually need box scores for */
    const wanted = {};
    for (const m of members) {
      const p = picks[m.id]; if (!p) continue;
      const g = p.team && byTeam[p.team];
      if (g) wanted[g.id] = g;
    }
    const boxes = {};
    for (const id of Object.keys(wanted)) {
      const g = wanted[id];
      if (g.state === "pre") continue;                      // nothing to read before kickoff
      try { boxes[id] = flattenPlayers(await getJson("/summary?event=" + id, fetchFn, doc)); }
      catch (e) { doc.error = (doc.error ? doc.error + "; " : "") + e.message; }
    }

    for (const m of members) {
      const p = picks[m.id]; if (!p) continue;
      const g = p.team && byTeam[p.team];
      const leg = { player: p.player, team: p.team || null, stat: p.stat, line: p.line, side: p.side,
                    game: null, state: "unknown", value: null, matched: false };
      if (g) {
        leg.game = g.id; leg.state = g.state; leg.clock = g.clock; leg.period = g.period; leg.detail = g.detail;
        leg.score = g.teams.map(t => t.abbr + " " + (t.score ?? "")).join(", ");
        doc.games[g.id] = { state: g.state, detail: g.detail, clock: g.clock, period: g.period, teams: g.teams };
        const box = boxes[g.id];
        if (box) {
          const k = normName(p.player);
          let rec = box[k];
          if (!rec) {                                       // fall back to last name on the right team
            const last = lastOf(p.player);
            const hits = Object.values(box).filter(r => lastOf(r.name) === last && (!p.team || r.team === p.team));
            if (hits.length === 1) rec = hits[0];
          }
          if (rec) { leg.matched = true; leg.espnName = rec.name; leg.value = readStat(rec, p.stat); }
          else if (g.state !== "pre") { leg.matched = false; leg.value = null; leg.note = "not in the box score yet"; }
        }
      } else if (p.team) {
        leg.state = "off";                                  // bye week, or the team abbreviation did not match
        leg.note = "no game found for " + p.team + " this week";
      }
      doc.legs[m.id] = leg;
    }
  } catch (e) {
    doc.error = e.message || String(e);
  }

  try { await writeLive(env, doc); } catch (e) { doc.error = (doc.error ? doc.error + "; " : "") + "could not save: " + e.message; }
  return doc;
}

export async function handleLive(request, env, opts = {}) {
  if (!env.DB || !env.DB.prepare) return json({ error: "No D1 binding named DB." }, 500);
  const url = new URL(request.url);
  if (url.searchParams.get("refresh") === "1") {
    const cur = await readKey(env, LIVE_KEY);
    const age = cur && cur.updated ? Date.now() - cur.updated : Infinity;
    if (age > 30000) {
      const doc = await refreshLive(env, opts);
      return json(doc);
    }
    return json(cur);
  }
  const cur = await readKey(env, LIVE_KEY);
  return json(cur || { week: currentWeek(), updated: null, via: null, games: {}, legs: {}, error: null, note: "not fetched yet" });
}
