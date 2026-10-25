'use strict';
// Zwift Club Ladder (ZwiftRacing.app): a 5v5 head-to-head format that runs apart from the WTRL league. The club carries up to 15 riders,
// but one race line-up is five riders from at most three consecutive vELO ranks (Diamond, Ruby, Emerald, Sapphire, ...). A challenge goes
// out, the date, route and private event link are agreed, the line-up is picked, and the result (10 points for 1st down to 1 for 10th, team
// total wins) goes into the record. Rider categories and ratings come from the club roster the dashboard already holds, so this module
// makes no ZwiftRacing.app requests of its own and cannot trip its rate limits.
// The club can run several ladder teams (up to 15), each with its own roster of 15, matches, record and line-ups; a rider can be on more than one,
// and a warning shows when two teams' line-ups ask for the same rider at the same time. Staff manage every team.
// Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createLadder({ redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, getRiders, siteUrl }) {
  const KEYS = {
    teams: 'cg:ladder:teams',     // team id -> {id, name, at}; none stored means the one original team, 'main'
    teamMeta: 'cg:ladder:teammeta', // team id -> JSON {rung}
    roster: 'cg:ladder:roster',   // "<team id>|<zwid>" -> {zwid, name, at} (a plain zwid is the original team)
    matches: 'cg:ladder:matches', // match id -> JSON (with its team id)
    avail: 'cg:ladder:avail',     // "<match id>|<zwid>" -> yes | maybe | no
    meta: 'cg:ladder:meta',       // JSON {rung}: where the club sits on the ladder
    sent: 'cg:ladder:sent',       // "<match id>:<event>" -> ISO time, so each notice goes once
  };
  const RANKS = ['Diamond', 'Ruby', 'Emerald', 'Sapphire', 'Amethyst', 'Platinum', 'Gold', 'Silver', 'Bronze', 'Copper'];   // best first
  const MAX_ROSTER = 15, MAX_TEAMS = 15, LINEUP = 5, MAX_SPREAD = 2, DEFAULT_TEAM = 'main', DEFAULT_TEAM_NAME = 'CRYO-GEN';   // a window of three ranks is a spread of two
  const TZ = 'Europe/London';
  const DAY_MS = 86400000;

  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const isStaff = req => ['admin', 'mod'].includes(roleFromRequest(req));
  const rankOf = cat => RANKS.indexOf(cat);
  const pad = n => String(n).padStart(2, '0');

  // ── UK time ──
  const partsIn = ms => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).map(x => [x.type, +x.value]));
  const offsetMin = ms => { const p = partsIn(ms); return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000) / 60000); };
  const ukMs = (date, time) => {
    const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number), guess = Date.UTC(y, m - 1, d, hh, mm);
    let ms = guess - offsetMin(guess) * 60000;
    ms = guess - offsetMin(ms) * 60000;
    return ms;
  };
  const whenLabel = ms => new Date(ms).toLocaleString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) + ' UK';

  // ── The vELO spread rule ──
  // A line-up is legal when it has at most five riders, all in the roster, each with a known vELO category, and the best and worst rank
  // are no more than three ranks apart (e.g. Diamond, Ruby, Emerald is fine; adding a Sapphire is not).
  function checkLineup(zwids, roster, info) {
    const issues = [];
    const ids = [...new Set(zwids.map(String))];
    if (ids.length !== zwids.length) issues.push('The same rider is in the line-up twice.');
    if (ids.length > LINEUP) issues.push(`A ladder line-up is ${LINEUP} riders, not ${ids.length}.`);
    const ranks = [];
    for (const id of ids) {
      if (!roster[id]) { issues.push(`${(info[id] && info[id].name) || id} is not on the ladder roster.`); continue; }
      const r = rankOf(info[id] && info[id].cat);
      if (r < 0) issues.push(`${roster[id].name} has no vELO category yet, so the spread cannot be checked.`);
      else ranks.push({ id, r });
    }
    let window = null;
    if (ranks.length) {
      const lo = Math.min(...ranks.map(x => x.r)), hi = Math.max(...ranks.map(x => x.r));
      window = { from: RANKS[lo], to: RANKS[hi], ranks: hi - lo + 1 };
      if (hi - lo > MAX_SPREAD) issues.push(`The line-up spans ${hi - lo + 1} ranks (${RANKS[lo]} to ${RANKS[hi]}); the ladder allows three.`);
    }
    return { ok: !issues.length, complete: ids.length === LINEUP, issues, window };
  }

  // The strongest five (by vELO rating) that fit inside one window of three ranks, among the riders given. Returns null if no window has five.
  function suggest(candidates) {
    let best = null;
    for (let lo = 0; lo <= RANKS.length - 1 - MAX_SPREAD; lo++) {
      const inside = candidates.filter(c => rankOf(c.cat) >= lo && rankOf(c.cat) <= lo + MAX_SPREAD).sort((a, b) => b.rating - a.rating);
      if (inside.length < LINEUP) continue;
      const pick = inside.slice(0, LINEUP), total = pick.reduce((n, c) => n + c.rating, 0);
      if (!best || total > best.total) best = { total, window: `${RANKS[lo]} to ${RANKS[lo + MAX_SPREAD]}`, zwids: pick.map(c => c.zwid) };
    }
    return best;
  }

  // 10 points for first down to 1 for tenth; our five riders' positions give both teams' totals (55 points are shared out).
  function scoreMatch(positions) {
    const entries = Object.entries(positions || {});
    if (entries.length !== LINEUP) throw new HttpError(400, `Enter the finishing position of all ${LINEUP} of our riders.`);
    const used = new Set();
    for (const [id, p] of entries) {
      if (!Number.isInteger(p) || p < 1 || p > 10) throw new HttpError(400, 'Positions are whole numbers from 1 to 10.');
      if (used.has(p)) throw new HttpError(400, `Position ${p} is given twice.`);
      used.add(p);
    }
    const ours = entries.reduce((n, [, p]) => n + (11 - p), 0);
    return { ourPoints: ours, theirPoints: 55 - ours, won: ours > 55 - ours };
  }

  // ── Storage and view ──
  const obj = raw => Object.fromEntries(pairs(raw).map(([f, v]) => [f, parse(v)]).filter(([, v]) => v));
  // Everything the module keeps, split by team. With no team stored there is one, 'main', and a plain-zwid roster field belongs to it.
  async function fetchAll() {
    const [roster, matches, avail, meta, teams, teamMeta] = await redis([['HGETALL', KEYS.roster], ['HGETALL', KEYS.matches], ['HGETALL', KEYS.avail], ['GET', KEYS.meta], ['HGETALL', KEYS.teams], ['HGETALL', KEYS.teamMeta]]);
    const list = Object.values(obj(teams)).filter(t => t.id).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    if (!list.length) list.push({ id: DEFAULT_TEAM, name: DEFAULT_TEAM_NAME, at: '' });
    const rosterBy = {};
    for (const [f, v] of pairs(roster)) {
      const rec = parse(v); if (!rec) continue;
      const [t, z] = f.includes('|') ? f.split('|') : [DEFAULT_TEAM, f];
      (rosterBy[t] = rosterBy[t] || {})[z] = rec;
    }
    const metaBy = obj(teamMeta); if (!metaBy[DEFAULT_TEAM] && parse(meta)) metaBy[DEFAULT_TEAM] = parse(meta);
    return { list, stored: pairs(teams).length > 0, rosterBy, matches: Object.values(obj(matches)).filter(m => m.id).map(m => ({ ...m, team: m.team || DEFAULT_TEAM })), avail: Object.fromEntries(pairs(avail)), metaBy };
  }
  function sliceFor(all, teamId) {
    const team = teamId ? all.list.find(t => t.id === String(teamId)) : all.list[0];
    if (!team) throw new HttpError(404, 'That team does not exist.');
    return { all, teams: all.list, team, roster: all.rosterBy[team.id] || {}, matches: all.matches.filter(m => m.team === team.id), avail: all.avail, meta: all.metaBy[team.id] || {} };
  }
  const load = async teamId => sliceFor(await fetchAll(), teamId);
  // Routes about one match find its team from the match itself, so they need no team in the request.
  async function loadForMatch(id) {
    const all = await fetchAll(), m = all.matches.find(x => x.id === String(id || ''));
    if (!m) throw new HttpError(404, 'That match does not exist.');
    return sliceFor(all, m.team);
  }
  const teamName = (all, id) => ((all.list.find(t => t.id === id) || {}).name) || DEFAULT_TEAM_NAME;
  const rosterField = (data, zwid) => `${data.team.id}|${zwid}`;
  async function riderInfo() {
    const out = {};
    try {
      for (const r of await getRiders()) out[String(r.riderId)] = { name: r.name, cat: (r.race && r.race.current && r.race.current.mixed && r.race.current.mixed.category) || '', rating: Math.round((r.race && r.race.current && r.race.current.rating) || 0) };
    } catch (e) { /* the roster source is down: the saved names still show, just without categories */ }
    return out;
  }
  const upcoming = (m, now) => m.status !== 'played' && m.status !== 'cancelled' && (!m.at || m.at > now - 3 * 3600000);

  function standings(matches) {
    const played = matches.filter(m => m.status === 'played' && m.result);
    const riders = new Map();
    for (const m of played) for (const [id, p] of Object.entries(m.result.positions || {})) {
      const cur = riders.get(id) || { zwid: id, name: (m.lineupNames && m.lineupNames[id]) || id, races: 0, points: 0, best: 11 };
      cur.races++; cur.points += 11 - p; cur.best = Math.min(cur.best, p); riders.set(id, cur);
    }
    return {
      played: played.length, won: played.filter(m => m.result.won).length, lost: played.filter(m => !m.result.won).length,
      pointsFor: played.reduce((n, m) => n + m.result.ourPoints, 0), pointsAgainst: played.reduce((n, m) => n + m.result.theirPoints, 0),
      riders: [...riders.values()].map(r => ({ ...r, avg: Math.round(r.points / r.races * 10) / 10, best: r.best > 10 ? null : r.best })).sort((a, b) => b.avg - a.avg || b.races - a.races),
    };
  }

  // Another team's line-up asking for the same rider at (nearly) the same time: a warning for staff, not a block.
  const CLASH_MS = 2 * 3600000;
  const clashesOf = (m, all, info) => (m.lineup || []).flatMap(z => all.matches
    .filter(o => o.id !== m.id && o.at && m.at && Math.abs(o.at - m.at) < CLASH_MS && o.status !== 'played' && o.status !== 'cancelled' && (o.lineup || []).includes(z))
    .map(o => ({ zwid: z, name: (info[z] && info[z].name) || (m.lineupNames || {})[z] || z, team: teamName(all, o.team), opponent: o.opponent })));

  // What every team looks like at a glance, for the team picker and the overview.
  function overview(all, now) {
    return all.list.map(t => {
      const ms = all.matches.filter(m => m.team === t.id), rec = standings(ms), next = ms.filter(m => m.status === 'scheduled' && m.at && m.at > now).sort((a, b) => a.at - b.at)[0];
      return { id: t.id, name: t.name, riders: Object.keys(all.rosterBy[t.id] || {}).length, played: rec.played, won: rec.won, lost: rec.lost, open: ms.filter(m => upcoming(m, now)).length, next: next ? { id: next.id, opponent: next.opponent, at: next.at } : null };
    });
  }

  async function view(req, teamId, now = Date.now()) {
    const [data, info] = await Promise.all([load(teamId), riderInfo()]);
    const staff = isStaff(req), me = memberFromRequest(req);
    const roster = Object.values(data.roster).map(r => ({ zwid: r.zwid, name: info[r.zwid] ? info[r.zwid].name : r.name, cat: (info[r.zwid] || {}).cat || '', rating: (info[r.zwid] || {}).rating || 0 }))
      .sort((a, b) => rankOf(a.cat) - rankOf(b.cat) || b.rating - a.rating || a.name.localeCompare(b.name));
    const matches = data.matches.sort((a, b) => (b.at || b.createdAt || '').toString().localeCompare((a.at || a.createdAt || '').toString())).map(m => {
      const counts = { yes: 0, maybe: 0, no: 0 };
      for (const z of Object.keys(data.roster)) { const a = data.avail[`${m.id}|${z}`]; if (counts[a] !== undefined) counts[a]++; }
      const check = checkLineup(m.lineup || [], data.roster, info);
      const canSee = staff || !!(me && data.roster[me.zwid]);   // the private event link is for the riders and the captains
      return { ...m, teamName: data.team.name, eventLink: canSee ? m.eventLink : (m.eventLink ? 'hidden' : ''), lineupInfo: (m.lineup || []).map(z => ({ zwid: z, name: (info[z] && info[z].name) || (data.roster[z] && data.roster[z].name) || z, cat: (info[z] || {}).cat || '', rating: (info[z] || {}).rating || 0 })),
        lineupCheck: check, clashes: staff ? clashesOf(m, data.all, info) : undefined, counts, myAvailability: me ? data.avail[`${m.id}|${me.zwid}`] || '' : '', onRoster: !!(me && data.roster[me.zwid]), upcoming: upcoming(m, now),
        availability: staff ? Object.fromEntries(Object.keys(data.roster).map(z => [z, data.avail[`${m.id}|${z}`] || ''])) : undefined };
    });
    return { staff, ranks: RANKS, limits: { roster: MAX_ROSTER, lineup: LINEUP, spread: MAX_SPREAD + 1, teams: MAX_TEAMS }, team: { id: data.team.id, name: data.team.name }, teams: overview(data.all, now),
      roster, matches, meta: data.meta, record: standings(data.matches), me: me && { zwid: me.zwid, onRoster: !!data.roster[me.zwid] } };
  }

  // ── Messages: the ladder channel (DISCORD_WEBHOOK_LADDER), or the club one if that is not set ──
  const post = (kind, content) => discord(kind === 'admin' ? 'ladder-admin' : 'ladder', { content: String(content).slice(0, 1900) });
  const lineupLines = m => (m.lineupInfo || []).map(r => `• ${discordEscape(r.name)}${r.cat ? ` (${r.cat})` : ''}`).join('\n');

  function announcement(m, kind) {
    const when = m.at ? whenLabel(m.at) : 'time to be agreed';
    if (kind === 'callout') return `🪜 **Ladder challenge: ${discordEscape(m.teamName || DEFAULT_TEAM_NAME)} v ${discordEscape(m.opponent)}**\n${m.challenger === 'us' ? 'We are challenging, so we pick the route.' : 'They challenged us.'} ${m.at ? `Proposed: **${when}**.` : 'Date and time are being agreed with their captain.'}${m.route && m.route.name ? `\nRoute: ${discordEscape(m.route.name)}${m.route.km ? ` (${m.route.km} km` : ''}${m.route.minutes ? `${m.route.km ? ', ' : ' ('}about ${m.route.minutes} min` : ''}${m.route.km || m.route.minutes ? ')' : ''}` : ''}\nCan you ride a 5v5 head-to-head? Say so at ${siteUrl} → 🪜 Ladder. We need five riders within three vELO ranks of each other.`;
    const link = m.eventLink ? `\n🔗 **Private event link:** ${m.eventLink}` : '\n🔗 The private event link is still to come.';
    const route = m.route && m.route.name ? `\n🗺️ ${discordEscape(m.route.name)}${m.route.km ? `, ${m.route.km} km` : ''}${m.route.minutes ? `, about ${m.route.minutes} min` : ''}` : '';
    const head = kind === 'h2' ? '⏰ **Ladder race in about two hours**' : kind === 'd1' ? '📅 **Ladder race tomorrow**' : '🏁 **Ladder line-up**';
    return `${head}: ${discordEscape(m.teamName || DEFAULT_TEAM_NAME)} v ${discordEscape(m.opponent)}\n🕒 ${when}${route}${link}\n**Our five:**\n${lineupLines(m) || '• line-up to be confirmed'}\nOpening tips: expect an all-out sprint from the line, so be warmed up and on steering. Full results go on ${siteUrl}.`;
  }

  // ── Who may do what ──
  const matchOr404 = (data, id) => { const m = data.matches.find(x => x.id === String(id || '')); if (!m) throw new HttpError(404, 'That match does not exist.'); return m; };   // data is the match's own team (loadForMatch)
  const save = (m) => redis([['HSET', KEYS.matches, m.id, JSON.stringify(m)]]);

  const routes = {
    'GET /api/ladder': async (req, _b, query = {}) => {
      if (!isStaff(req) && !memberFromRequest(req)) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      return view(req, query.team);
    },

    // Staff: add a team (up to 15), or rename one with its id. The first team added keeps the original one, so nothing already entered is lost.
    'POST /api/ladder/team': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const all = await fetchAll(), name = text(body.name, 'team name', 40);
      const cmds = [];
      if (!all.stored) cmds.push(['HSET', KEYS.teams, DEFAULT_TEAM, JSON.stringify({ id: DEFAULT_TEAM, name: DEFAULT_TEAM_NAME, at: '' })]);
      let id;
      if (body.id) {
        const t = all.list.find(x => x.id === String(body.id));
        if (!t) throw new HttpError(404, 'That team does not exist.');
        id = t.id;
        cmds.push(['HSET', KEYS.teams, id, JSON.stringify({ ...t, name })]);
      } else {
        if (all.list.length >= MAX_TEAMS) throw new HttpError(409, `The ladder has ${MAX_TEAMS} teams already. Remove one first.`);
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'team';
        id = base; for (let n = 2; all.list.some(t => t.id === id); n++) id = `${base}-${n}`;
        cmds.push(['HSET', KEYS.teams, id, JSON.stringify({ id, name, at: new Date().toISOString() })]);
      }
      if (all.list.some(t => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Another team already has that name.');
      await redis(cmds);
      return view(req, id);
    },

    // Staff: remove a team with its roster, matches and answers. A team that has matches needs `force`.
    'POST /api/ladder/team-remove': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(body.id);
      if (data.teams.length <= 1) throw new HttpError(409, 'Keep at least one team.');
      if (data.matches.length && body.force !== true) throw new HttpError(409, `${data.team.name} has ${data.matches.length} match${data.matches.length === 1 ? '' : 'es'}. Removing the team deletes them and their results.`);
      const ids = new Set(data.matches.map(m => m.id));
      const rosterFields = Object.keys(data.roster).flatMap(z => [`${data.team.id}|${z}`, ...(data.team.id === DEFAULT_TEAM ? [z] : [])]);
      const stale = Object.keys(data.avail).filter(f => ids.has(f.split('|')[0]));
      await redis([['HDEL', KEYS.teams, data.team.id], ['HDEL', KEYS.teamMeta, data.team.id], ...rosterFields.map(f => ['HDEL', KEYS.roster, f]), ...[...ids].map(id => ['HDEL', KEYS.matches, id]), ...stale.map(f => ['HDEL', KEYS.avail, f])]);
      return view(req, data.teams.find(t => t.id !== data.team.id).id);
    },

    // Staff: add a rider to the ladder roster (up to 15) or take them off it.
    'POST /api/ladder/roster': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const zwid = String(body.zwid || '');
      if (!/^\d{1,12}$/.test(zwid)) throw new HttpError(400, 'A Zwift ID is needed (numbers only).');
      const data = await load(body.team);
      if (body.remove) {
        await redis([['HDEL', KEYS.roster, rosterField(data, zwid)], ...(data.team.id === DEFAULT_TEAM ? [['HDEL', KEYS.roster, zwid]] : [])]);
        return view(req, data.team.id);
      }
      if (data.roster[zwid]) return view(req, data.team.id);
      const info = await riderInfo();
      const known = info[zwid];
      if (!known && !body.name) throw new HttpError(404, 'That Zwift ID is not in the club roster.');
      if (Object.keys(data.roster).length >= MAX_ROSTER) throw new HttpError(409, `${data.team.name}'s roster is full (${MAX_ROSTER} riders). Take someone off first.`);
      await redis([['HSET', KEYS.roster, rosterField(data, zwid), JSON.stringify({ zwid, name: known ? known.name : text(body.name, 'name', 60), at: new Date().toISOString() })]]);
      return view(req, data.team.id);
    },

    // Staff: where the team sits on the ladder.
    'POST /api/ladder/meta': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const rung = body.rung === '' || body.rung === null || body.rung === undefined ? null : Number(body.rung);
      if (rung !== null && !(Number.isInteger(rung) && rung >= 1 && rung <= 999)) throw new HttpError(400, 'The rung is a whole number from 1.');
      const data = await load(body.team);
      await redis([['HSET', KEYS.teamMeta, data.team.id, JSON.stringify({ rung })]]);
      return view(req, data.team.id);
    },

    // Staff: open a challenge, or change one (opponent, who challenged, route, time, private event link, notes).
    'POST /api/ladder/match': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = body.id ? await loadForMatch(body.id) : await load(body.team);
      const old = body.id ? matchOr404(data, body.id) : null;
      const date = String(body.date || ''), time = String(body.time || '');
      let at = old ? old.at : null;
      if (date || time) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new HttpError(400, 'Give the date and the start time (UK) as 2026-11-12 and 19:30.');
        at = ukMs(date, time);
      } else if (body.clearTime) at = null;
      const link = String(body.eventLink || '').trim();
      if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw new HttpError(400, 'The private event link must be a web address starting https://.');
      const km = body.routeKm === '' || body.routeKm === undefined ? null : Number(body.routeKm), mins = body.routeMinutes === '' || body.routeMinutes === undefined ? null : Number(body.routeMinutes);
      if ((km !== null && !(km > 0 && km < 200)) || (mins !== null && !(mins > 0 && mins < 300))) throw new HttpError(400, 'The route length and time must be sensible numbers (for example 20 km, 45 minutes).');
      const m = {
        ...(old || { id: `m${Date.now().toString(36)}`, team: data.team.id, status: 'challenge', lineup: [], createdAt: new Date().toISOString() }),
        opponent: text(body.opponent, 'opponent', 60),
        challenger: body.challenger === 'them' ? 'them' : 'us',
        route: { name: text(body.routeName, 'route', 80, false), km, minutes: mins },
        at, eventLink: link, notes: text(body.notes, 'notes', 300, false),
        status: (old ? old.status : 'challenge') === 'challenge' && at && link ? 'scheduled' : (old ? old.status : 'challenge'),   // time and private link agreed: it is on
      };
      await save(m);
      return view(req, data.team.id);
    },

    'POST /api/ladder/match-remove': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForMatch(body.id), m = matchOr404(data, body.id);
      const stale = Object.keys(data.avail).filter(f => f.startsWith(`${m.id}|`));
      await redis([['HDEL', KEYS.matches, m.id], ...stale.map(f => ['HDEL', KEYS.avail, f])]);
      return view(req, data.team.id);
    },

    'POST /api/ladder/status': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForMatch(body.id), m = matchOr404(data, body.id);
      if (!['challenge', 'scheduled', 'cancelled'].includes(body.status)) throw new HttpError(400, 'Status is challenge, scheduled or cancelled.');
      await save({ ...m, status: body.status });
      return view(req, data.team.id);
    },

    // A rider on the ladder roster says whether they can ride a match (staff can answer for someone).
    'POST /api/ladder/availability': async (req, body) => {
      const me = memberFromRequest(req), staff = isStaff(req);
      if (!me && !staff) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const data = await loadForMatch(body.match), m = matchOr404(data, body.match);
      const zwid = staff && body.zwid ? String(body.zwid) : me && me.zwid;
      if (!zwid || !data.roster[zwid]) throw new HttpError(403, 'Only riders on the ladder roster answer for a match. Ask the captains to add you.');
      if (!['yes', 'maybe', 'no', ''].includes(body.status)) throw new HttpError(400, 'Answer yes, maybe or no.');
      await redis([body.status ? ['HSET', KEYS.avail, `${m.id}|${zwid}`, body.status] : ['HDEL', KEYS.avail, `${m.id}|${zwid}`]]);
      return view(req, data.team.id);
    },

    // The strongest legal five among the riders who have not said no.
    'GET /api/ladder/suggest': async (req, _b, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      const [data, info] = await Promise.all([loadForMatch(query.match), riderInfo()]);
      const m = matchOr404(data, query.match);
      const cands = Object.keys(data.roster).filter(z => data.avail[`${m.id}|${z}`] !== 'no' && info[z] && rankOf(info[z].cat) >= 0)
        .map(z => ({ zwid: z, cat: info[z].cat, rating: info[z].rating, name: info[z].name }));
      const best = suggest(cands);
      if (!best) throw new HttpError(409, `No five riders (who have not said no) fit inside three vELO ranks. ${cands.length} rider${cands.length === 1 ? ' is' : 's are'} eligible.`);
      return { zwids: best.zwids, window: best.window, riders: best.zwids.map(z => cands.find(c => c.zwid === z)) };
    },

    // Staff: set the line-up. It must be legal (the three-rank rule) unless staff force it.
    'POST /api/ladder/lineup': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const [data, info] = await Promise.all([loadForMatch(body.match), riderInfo()]);
      const m = matchOr404(data, body.match);
      const zwids = (Array.isArray(body.zwids) ? body.zwids : []).map(String).filter(z => /^\d{1,12}$/.test(z));
      const check = checkLineup(zwids, data.roster, info);
      if (!check.ok && body.force !== true) throw new HttpError(400, check.issues.join(' '));
      await save({ ...m, lineup: zwids, lineupNames: Object.fromEntries(zwids.map(z => [z, (info[z] && info[z].name) || (data.roster[z] && data.roster[z].name) || z])) });
      return view(req, data.team.id);
    },

    // Staff: post to the ladder channel: the call for riders, or the line-up with the private event link.
    'POST /api/ladder/post': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const [data, info] = await Promise.all([loadForMatch(body.match), riderInfo()]);
      const raw = matchOr404(data, body.match), kind = body.kind === 'callout' ? 'callout' : 'lineup';
      const m = { ...raw, teamName: data.team.name, lineupInfo: (raw.lineup || []).map(z => ({ name: (info[z] && info[z].name) || (raw.lineupNames || {})[z] || z, cat: (info[z] || {}).cat || '' })) };
      if (kind === 'lineup' && !m.lineup.length) throw new HttpError(409, 'Pick the line-up first.');
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${m.id}:manual-${kind}:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, 'That was posted a moment ago.');
      await post('public', announcement(m, kind));
      return { posted: kind };
    },

    // Staff: enter how our five finished (1 to 10 in the race of ten). The points, the winner and the record follow.
    'POST /api/ladder/result': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForMatch(body.match), m = matchOr404(data, body.match);
      const positions = {};
      for (const z of m.lineup || []) { const p = Number(body.positions && body.positions[z]); positions[z] = p; }
      if (!(m.lineup || []).length) throw new HttpError(409, 'Set the line-up before entering the result.');
      const score = scoreMatch(positions);
      await save({ ...m, status: 'played', result: { positions, ...score, at: new Date().toISOString() } });
      return view(req, data.team.id);
    },
  };

  // ── The scheduled tick: a reminder the day before and two hours before, and a warning when the line-up is not ready (for every team) ──
  async function runSchedule(now = Date.now()) {
    const all = await fetchAll(), done = [];
    const claim = async key => (await redis([['HSETNX', KEYS.sent, key, new Date(now).toISOString()]]))[0];
    const info = Object.values(all.rosterBy).some(r => Object.keys(r).length) || all.matches.some(m => m.lineup && m.lineup.length) ? await riderInfo() : {};
    for (const team of all.list) {
      const data = sliceFor(all, team.id);
      for (const raw of data.matches) {
        if (raw.status !== 'scheduled' || !raw.at || raw.at <= now) continue;
        const hours = (raw.at - now) / 3600000;
        const m = { ...raw, teamName: team.name, lineupInfo: (raw.lineup || []).map(z => ({ name: (info[z] && info[z].name) || (raw.lineupNames || {})[z] || z, cat: (info[z] || {}).cat || '' })) };
        const check = checkLineup(m.lineup || [], data.roster, info);
        const clash = clashesOf(m, all, info);
        if (hours <= 72 && (!check.complete || !check.ok) && await claim(`${m.id}:incomplete`)) {
          await post('admin', `⚠️ **Ladder: ${discordEscape(team.name)} v ${discordEscape(m.opponent)} on ${whenLabel(m.at)}** has no legal line-up yet (${check.complete ? check.issues.join(' ') : `${(m.lineup || []).length} of 5 riders picked`}). Pick the five at ${siteUrl} → 🪜 Ladder.`);
          done.push('ladder-incomplete');
        }
        if (hours <= 72 && clash.length && await claim(`${m.id}:clash`)) {
          await post('admin', `⚠️ **Ladder: ${discordEscape(team.name)} v ${discordEscape(m.opponent)} on ${whenLabel(m.at)}** picks ${clash.map(c => `${discordEscape(c.name)} (also in ${discordEscape(c.team)}'s line-up v ${discordEscape(c.opponent)})`).join(', ')} at the same time. One rider cannot race twice.`);
          done.push('ladder-clash');
        }
        if (hours <= 24 && check.complete && check.ok && await claim(`${m.id}:d1`)) { await post('public', announcement(m, 'd1')); done.push('ladder-d1'); }
        if (hours <= 2 && check.complete && await claim(`${m.id}:h2`)) { await post('public', announcement(m, 'h2')); done.push('ladder-h2'); }
      }
    }
    return done;
  }

  async function healthRow(now = Date.now()) {
    const all = await fetchAll(), riders = Object.values(all.rosterBy).reduce((n, r) => n + Object.keys(r).length, 0);
    if (!riders && !all.matches.length) return ['info', 'The ladder is not set up yet. Add the roster and a challenge in the Ladder tab when the club is ready.'];
    const teams = `${all.list.length} team${all.list.length === 1 ? '' : 's'}`;
    const soon = all.matches.filter(m => m.status === 'scheduled' && m.at && m.at > now).sort((a, b) => a.at - b.at);
    if (!soon.length) return ['ok', `${teams}, ${riders} rider${riders === 1 ? '' : 's'} on the ladder rosters; no match scheduled.`];
    const info = await riderInfo();
    const notReady = soon.filter(m => { const d = sliceFor(all, m.team), c = checkLineup(m.lineup || [], d.roster, info); return Math.ceil((m.at - now) / DAY_MS) <= 3 && (!c.complete || !c.ok); });
    if (notReady.length) return ['warn', `${notReady.map(m => `${teamName(all, m.team)} v ${m.opponent} in ${Math.ceil((m.at - now) / DAY_MS)} day${Math.ceil((m.at - now) / DAY_MS) === 1 ? '' : 's'}`).join('; ')}: no legal line-up yet.`];
    const next = soon[0], c = checkLineup(next.lineup || [], sliceFor(all, next.team).roster, info);
    return ['ok', `${teams}, ${riders} on the rosters. Next: ${teamName(all, next.team)} v ${next.opponent}, ${whenLabel(next.at)}${c.complete && c.ok ? ', line-up set' : ''}.`];
  }

  // Every team's matches in one list, for the staff "This week" page and a rider's "My week".
  async function allMatches(req, now = Date.now()) {
    const all = await fetchAll();
    const views = await Promise.all(all.list.map(t => view(req, t.id, now)));
    return views.flatMap(v => v.matches.map(m => ({ ...m, teamId: v.team.id, teamName: v.team.name })));
  }

  // Riders on a roster who have not answered for a scheduled match that starts within `hours` (for the automatic reminder; no request needed).
  async function pendingAnswers(now = Date.now(), hours = 30) {
    const all = await fetchAll(), out = [];
    for (const m of all.matches) {
      if (m.status !== 'scheduled' || !m.at || m.at <= now || m.at - now > hours * 3600000) continue;
      const d = sliceFor(all, m.team);
      for (const z of Object.keys(d.roster)) if (!all.avail[`${m.id}|${z}`]) out.push({ matchId: m.id, teamName: d.team.name, opponent: m.opponent, at: m.at, zwid: z });
    }
    return out;
  }

  return { routes, runSchedule, load, healthRow, view, allMatches, pendingAnswers, checkLineup, suggest, scoreMatch, KEYS, RANKS };
};
