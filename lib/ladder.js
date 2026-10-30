'use strict';
// Zwift Club Ladder (ZwiftRacing.app): a 5v5 head-to-head format that runs apart from the WTRL league. The club carries up to 15 riders,
// but one race line-up is five riders from at most three consecutive vELO ranks (Diamond, Ruby, Emerald, Sapphire, ...). A challenge goes
// out, the date, route and private event link are agreed, the line-up is picked, and the result (10 points for 1st down to 1 for 10th, team
// total wins) goes into the record. Rider categories and ratings come from the club roster the dashboard already holds, so this module
// makes no ZwiftRacing.app requests of its own and cannot trip its rate limits.
// The club can run several ladder teams (up to 15), each with its own roster of 15, matches, record and line-ups; a rider can be on more than one,
// and a warning shows when two teams' line-ups ask for the same rider at the same time. Staff manage every team.
// Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createLadder({ fetchZrResults, redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, getRiders, siteUrl }) {
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
  // A rider's answer counts against their rating a little (maybe) or more (no answer yet: `pref` 1 or 2), so those who said yes are preferred.
  // The reserve is the next best rider from the same window, who can step into any of the five without breaking the spread.
  const PREF_COST = [0, 60, 150];
  function suggest(candidates) {
    let best = null;
    const score = c => c.rating - (PREF_COST[c.pref || 0] || 0);
    for (let lo = 0; lo <= RANKS.length - 1 - MAX_SPREAD; lo++) {
      const inside = candidates.filter(c => rankOf(c.cat) >= lo && rankOf(c.cat) <= lo + MAX_SPREAD).sort((a, b) => score(b) - score(a));
      if (inside.length < LINEUP) continue;
      const pick = inside.slice(0, LINEUP), total = pick.reduce((n, c) => n + score(c), 0);
      if (!best || total > best.total) best = { total, window: `${RANKS[lo]} to ${RANKS[lo + MAX_SPREAD]}`, zwids: pick.map(c => c.zwid), reserve: inside[LINEUP] ? inside[LINEUP].zwid : '' };
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

  // The league's guidance for a route the challenger picks: 15 to 25 km, about 40 to 50 minutes, one or two power-ups.
  function routeWarnings(m) {
    const r = m.route || {}, out = [];
    if (r.km && (r.km < 15 || r.km > 25)) out.push(`${r.km} km is outside the 15 to 25 km the league asks for.`);
    if (r.minutes && (r.minutes < 40 || r.minutes > 50)) out.push(`${r.minutes} minutes is outside the 40 to 50 minutes the league aims for.`);
    return out;
  }
  const ukDay = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: TZ });

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

  // The five (and a reserve) the app would pick for a match: riders who have not said no, with a known category, who are not already in another
  // team's line-up at the same time; those who said yes first. `keep` riders (already settled in the line-up) are not offered a place again.
  function autoPick(data, m, info, all, exclude = []) {
    const answer = z => data.avail[`${m.id}|${z}`] || '';
    const busy = new Set((m.at ? all.matches : []).filter(o => o.id !== m.id && o.at && Math.abs(o.at - m.at) < CLASH_MS && o.status !== 'played' && o.status !== 'cancelled').flatMap(o => [...(o.lineup || [])]));
    const cands = Object.keys(data.roster).filter(z => answer(z) !== 'no' && !busy.has(z) && !exclude.includes(z) && info[z] && rankOf(info[z].cat) >= 0)
      .map(z => ({ zwid: z, cat: info[z].cat, rating: info[z].rating, name: info[z].name, pref: answer(z) === 'yes' ? 0 : answer(z) === 'maybe' ? 1 : 2 }));
    return { best: suggest(cands), eligible: cands.length };
  }
  const autoOn = data => !data.meta || data.meta.auto !== false;

  // Another team's line-up asking for the same rider at (nearly) the same time: a warning for staff, not a block.
  const CLASH_MS = 2 * 3600000;
  const clashesOf = (m, all, info) => (m.lineup || []).flatMap(z => all.matches
    .filter(o => o.id !== m.id && o.at && m.at && Math.abs(o.at - m.at) < CLASH_MS && o.status !== 'played' && o.status !== 'cancelled' && (o.lineup || []).includes(z))
    .map(o => ({ zwid: z, name: (info[z] && info[z].name) || (m.lineupNames || {})[z] || z, team: teamName(all, o.team), opponent: o.opponent })));

  // How long since the team last raced (a played match, or one that was scheduled and has started), unless it has a match coming up.
  // The league calls a team that has not raced in 21 days a zombie, and removes one that has been inactive for 35.
  function activityOf(matches, now) {
    if (matches.some(m => m.status === 'scheduled' && m.at && m.at > now)) return { state: 'active', days: 0 };
    const last = Math.max(0, ...matches.filter(m => m.status === 'played' || (m.status === 'scheduled' && m.at && m.at <= now)).map(m => m.at || Date.parse((m.result || {}).at || '') || 0));
    if (!last) return { state: 'none', days: null };
    const days = Math.floor((now - last) / DAY_MS);
    return { state: days >= 35 ? 'removed' : days >= 21 ? 'zombie' : days >= 14 ? 'warn' : 'active', days, last };
  }

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
      const dayTwin = m.at && m.status !== 'cancelled' ? data.matches.filter(o => o.id !== m.id && o.at && o.status !== 'cancelled' && ukDay(o.at) === ukDay(m.at)).map(o => o.opponent) : [];
      return { ...m, routeWarnings: routeWarnings(m), sameDay: dayTwin, reserveInfo: m.reserve ? { zwid: m.reserve, name: (info[m.reserve] && info[m.reserve].name) || (data.roster[m.reserve] && data.roster[m.reserve].name) || m.reserve, cat: (info[m.reserve] || {}).cat || '' } : null,
        teamName: data.team.name, eventLink: canSee ? m.eventLink : (m.eventLink ? 'hidden' : ''), lineupInfo: (m.lineup || []).map(z => ({ zwid: z, name: (info[z] && info[z].name) || (data.roster[z] && data.roster[z].name) || z, cat: (info[z] || {}).cat || '', rating: (info[z] || {}).rating || 0 })),
        lineupCheck: check, clashes: staff ? clashesOf(m, data.all, info) : undefined, counts, myAvailability: me ? data.avail[`${m.id}|${me.zwid}`] || '' : '', onRoster: !!(me && data.roster[me.zwid]), upcoming: upcoming(m, now),
        availability: staff ? Object.fromEntries(Object.keys(data.roster).map(z => [z, data.avail[`${m.id}|${z}`] || ''])) : undefined };
    });
    return { staff, ranks: RANKS, limits: { roster: MAX_ROSTER, lineup: LINEUP, spread: MAX_SPREAD + 1, teams: MAX_TEAMS }, team: { id: data.team.id, name: data.team.name }, teams: overview(data.all, now),
      roster, matches, meta: { ...data.meta, auto: autoOn(data) }, record: standings(data.matches),
      challengeRange: data.meta.rung ? { from: Math.max(1, data.meta.rung - 7), to: Math.max(1, data.meta.rung - 1), note: 'Teams that have not raced for 21 days are zombies and do not count towards the seven.' } : null,
      activity: staff ? activityOf(data.matches, now) : undefined,
      shared: staff ? Object.keys(data.roster).filter(z => data.all.list.some(t => t.id !== data.team.id && (data.all.rosterBy[t.id] || {})[z])).map(z => ({ zwid: z, name: (info[z] && info[z].name) || data.roster[z].name, teams: data.all.list.filter(t => t.id !== data.team.id && (data.all.rosterBy[t.id] || {})[z]).map(t => t.name) })) : undefined, me: me && { zwid: me.zwid, onRoster: !!data.roster[me.zwid] } };
  }

  // ── Messages: the ladder channel (DISCORD_WEBHOOK_LADDER), or the club one if that is not set ──
  const post = (kind, content) => discord(kind === 'admin' ? 'ladder-admin' : 'ladder', { content: String(content).slice(0, 1900) });
  const lineupLines = m => (m.lineupInfo || []).map(r => `• ${discordEscape(r.name)}${r.cat ? ` (${r.cat})` : ''}`).join('\n');

  const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
  // The result of a played match: the score, then our five in finishing order (m.lineupInfo carries zwid, name and category).
  function resultMessage(m) {
    const r = m.result, pos = r.positions || {};
    const rows = (m.lineupInfo || []).filter(x => pos[x.zwid]).sort((a, b) => pos[a.zwid] - pos[b.zwid]);
    return `${r.won ? '🏆' : '🏁'} **Ladder result: ${discordEscape(m.teamName || DEFAULT_TEAM_NAME)} v ${discordEscape(m.opponent)}**\n${r.won ? '**We won**' : '**They won this one**'}, ${r.ourPoints} to ${r.theirPoints}.\n${rows.map(x => `${ordinal(pos[x.zwid])}  ${discordEscape(x.name)}`).join('\n')}\nWell ridden, all five. The ladder is at ${siteUrl}. Protests go to #race-committee within 24 hours.`;
  }

  function announcement(m, kind) {
    if (kind === 'result') return resultMessage(m);
    const when = m.at ? whenLabel(m.at) : 'time to be agreed';
    if (kind === 'callout') return `🪜 **Ladder challenge: ${discordEscape(m.teamName || DEFAULT_TEAM_NAME)} v ${discordEscape(m.opponent)}**\n${m.challenger === 'us' ? 'We are challenging, so we pick the route.' : 'They challenged us.'} ${m.at ? `Proposed: **${when}**.` : 'Date and time are being agreed with their captain.'}${m.route && m.route.name ? `\nRoute: ${discordEscape(m.route.name)}${m.route.km ? ` (${m.route.km} km` : ''}${m.route.minutes ? `${m.route.km ? ', ' : ' ('}about ${m.route.minutes} min` : ''}${m.route.km || m.route.minutes ? ')' : ''}` : ''}\nCan you ride a 5v5 head-to-head? Say so at ${siteUrl} → 🪜 Ladder. We need five riders within three vELO ranks of each other.`;
    const link = m.eventLink ? `\n🔗 **Private event link:** ${m.eventLink}` : '\n🔗 The private event link is still to come.';
    const route = m.route && m.route.name ? `\n🗺️ ${discordEscape(m.route.name)}${m.route.km ? `, ${m.route.km} km` : ''}${m.route.minutes ? `, about ${m.route.minutes} min` : ''}` : '';
    const reserve = m.reserveInfo ? `\n**Reserve:** ${discordEscape(m.reserveInfo.name)}` : '';
    const power = m.powerUps ? `\n⚡ Power-ups: ${discordEscape(m.powerUps)}` : '';
    const head = kind === 'h2' ? '⏰ **Ladder race in about two hours**' : kind === 'd1' ? '📅 **Ladder race tomorrow**' : '🏁 **Ladder line-up**';
    return `${head}: ${discordEscape(m.teamName || DEFAULT_TEAM_NAME)} v ${discordEscape(m.opponent)}\n🕒 ${when}${route}${power}${link}\n**Our five:**\n${lineupLines(m) || '• line-up to be confirmed'}${reserve}\nOpening tips: expect an all-out sprint from the line, so be warmed up and on steering.${kind === 'lineup' ? '' : ' Only the five starters enter the pen; captains direct from Fan View. Pair your heart rate monitor and cadence, and keep your Zwift activity public.'} Full results go on ${siteUrl}.`;
  }

  // ── Who may do what ──
  const matchOr404 = (data, id) => { const m = data.matches.find(x => x.id === String(id || '')); if (!m) throw new HttpError(404, 'That match does not exist.'); return m; };   // data is the match's own team (loadForMatch)
  const save = (m) => redis([['HSET', KEYS.matches, m.id, JSON.stringify(m)]]);

  const saveLineup = (m, data, info, zwids, reserve = '') => save({ ...m, lineup: zwids, reserve: reserve || '',
    lineupNames: Object.fromEntries([...zwids, ...(reserve ? [reserve] : [])].map(z => [z, (info[z] && info[z].name) || (data.roster[z] && data.roster[z].name) || z])) });

  // A starter (or the reserve) says they cannot ride: the reserve steps in, or the best legal rider; the admin channel is told who. If nobody fits the
  // line-up is left short and the staff are warned. Only a match still to come, and only while the team has automatic picking on.
  async function replaceStarter(matchId, zwid, now = Date.now()) {
    const data = await loadForMatch(matchId), info = await riderInfo(), m = data.matches.find(x => x.id === matchId);
    if (!m || !upcoming(m, now) || m.status === 'challenge' || !autoOn(data) || ![...(m.lineup || []), m.reserve].includes(zwid)) return null;
    const name = (info[zwid] && info[zwid].name) || (m.lineupNames || {})[zwid] || zwid, label = `${discordEscape(data.team.name)} v ${discordEscape(m.opponent)}`;
    if (m.reserve === zwid) { await saveLineup(m, data, info, m.lineup, ''); return null; }
    const rest = m.lineup.filter(z => z !== zwid), answer = z => data.avail[`${m.id}|${z}`] || '';
    const fits = z => data.roster[z] && answer(z) !== 'no' && checkLineup([...rest, z], data.roster, info).ok;
    const reserveOk = m.reserve && fits(m.reserve) ? m.reserve : '';
    const other = () => autoPick(data, m, info, data.all, [...m.lineup, m.reserve]).best;
    let pick = reserveOk;
    if (!pick) {
      const cand = Object.keys(data.roster).filter(z => !m.lineup.includes(z) && fits(z) && info[z]).sort((a, b) => (answer(a) === 'yes' ? 0 : 1) - (answer(b) === 'yes' ? 0 : 1) || info[b].rating - info[a].rating)[0];
      pick = cand || '';
    }
    const next = pick ? [...rest, pick] : rest;
    const reserve = pick === m.reserve ? ((other() || {}).reserve || '') : m.reserve;
    await saveLineup(m, data, info, next, reserve);
    await post('admin', pick ? `🔁 **Ladder ${label} on ${whenLabel(m.at)}**: ${discordEscape(name)} can't ride, so ${discordEscape((info[pick] && info[pick].name) || pick)}${pick === m.reserve ? ' (the reserve)' : ''} takes the place. Check it at ${siteUrl} → 🪜 Ladder.`
      : `⚠️ **Ladder ${label} on ${whenLabel(m.at)}**: ${discordEscape(name)} can't ride and nobody else fits inside three vELO ranks. The line-up has ${next.length} of 5. Sort it out at ${siteUrl} → 🪜 Ladder.`);
    return pick || null;
  }

  // Results straight from ZwiftRacing.app: the roster riders who appear in the event are the five who raced (which may differ from the line-up, if
  // the reserve stepped in), their finishing places are the positions, and the score follows. Needs exactly five of our riders in the event.
  const eventIdOf = m => (/\/events\/view\/(\d+)/.exec(m.eventLink || '') || [])[1] || '';
  async function importResult(data, m, info, eventId) {
    const found = await fetchZrResults(eventId), finish = new Map(found.results.map(x => [String(x.riderId), x]));
    const ours = Object.keys(data.roster).filter(z => finish.has(z));
    if (ours.length !== LINEUP) throw new HttpError(409, `${ours.length} of our roster riders are in that event, and a ladder match needs ${LINEUP}. Enter the result by hand.`);
    const positions = Object.fromEntries(ours.map(z => [z, Number(finish.get(z).position)]));
    const score = scoreMatch(positions);
    const names = Object.fromEntries(ours.map(z => [z, (info[z] && info[z].name) || (data.roster[z] && data.roster[z].name) || z]));
    return { positions, score, names, changed: ours.some(z => !(m.lineup || []).includes(z)) || (m.lineup || []).some(z => !ours.includes(z)), eventId };
  }
  const applyImported = (m, imp) => save({ ...m, status: 'played', lineup: Object.keys(imp.positions), lineupNames: imp.names, result: { positions: imp.positions, ...imp.score, at: new Date().toISOString(), source: 'zwiftracing', eventId: imp.eventId } });

  const routes = {
    // Staff: read the result from the match's Zwift event (the id is the end of the private link, or given as `event`). A preview unless `apply` is true.
    'POST /api/ladder/result-import': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const [data, info] = await Promise.all([loadForMatch(body.match), riderInfo()]), m = matchOr404(data, body.match);
      const eventId = String(body.event || eventIdOf(m) || '');
      if (!eventId) throw new HttpError(400, 'Add the Zwift event link to the match first, or give the event id.');
      const imp = await importResult(data, m, info, eventId);
      if (body.apply !== true) return { preview: { positions: imp.positions, names: imp.names, ourPoints: imp.score.ourPoints, theirPoints: imp.score.theirPoints, won: imp.score.won, lineupChanged: imp.changed, eventId } };
      await applyImported(m, imp);
      return view(req, data.team.id);
    },

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
      const data = await load(body.team);
      let rung = data.meta.rung === undefined ? null : data.meta.rung;
      if (body.rung !== undefined) {
        rung = body.rung === '' || body.rung === null ? null : Number(body.rung);
        if (rung !== null && !(Number.isInteger(rung) && rung >= 1 && rung <= 999)) throw new HttpError(400, 'The rung is a whole number from 1.');
      }
      const meta = { ...data.meta, rung };
      if (body.auto !== undefined) meta.auto = body.auto !== false;   // false switches the automatic line-up picking off for this team
      await redis([['HSET', KEYS.teamMeta, data.team.id, JSON.stringify(meta)]]);
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
        powerUps: text(body.powerUps, 'power-ups', 80, false),
        at, eventLink: link, notes: text(body.notes, 'notes', 300, false),
        status: (old ? old.status : 'challenge') === 'challenge' && at && link ? 'scheduled' : (old ? old.status : 'challenge'),   // time and private link agreed: it is on
      };
      const twin = m.at ? data.matches.find(o => o.id !== m.id && o.at && o.status !== 'cancelled' && ukDay(o.at) === ukDay(m.at)) : null;
      if (twin && body.force !== true) throw new HttpError(409, `${data.team.name} already has a match that day (v ${twin.opponent}). The ladder allows one race a team a day.`);
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
      if (body.status === 'no') await replaceStarter(m.id, zwid).catch(e => console.error('Ladder replace:', e.message));
      return view(req, data.team.id);
    },

    // The strongest legal five among the riders who have not said no.
    'GET /api/ladder/suggest': async (req, _b, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      const [data, info] = await Promise.all([loadForMatch(query.match), riderInfo()]);
      const m = matchOr404(data, query.match);
      const { best, eligible } = autoPick(data, m, info, data.all);
      if (!best) throw new HttpError(409, `No five riders (who have not said no, and are not racing for another team then) fit inside three vELO ranks. ${eligible} rider${eligible === 1 ? ' is' : 's are'} eligible.`);
      const who = z => ({ zwid: z, name: (info[z] || {}).name || z, cat: (info[z] || {}).cat || '', rating: (info[z] || {}).rating || 0, answer: data.avail[`${m.id}|${z}`] || '' });
      return { zwids: best.zwids, window: best.window, reserve: best.reserve, riders: best.zwids.map(who), reserveRider: best.reserve ? who(best.reserve) : null };
    },

    // Staff: pick the line-up (and a reserve) in one go, as the suggestion would, and save it.
    'POST /api/ladder/auto-lineup': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForMatch(body.match), info = await riderInfo(), m = matchOr404(data, body.match);
      const { best, eligible } = autoPick(data, m, info, data.all);
      if (!best) throw new HttpError(409, `No five riders (who have not said no, and are not racing for another team then) fit inside three vELO ranks. ${eligible} rider${eligible === 1 ? ' is' : 's are'} eligible.`);
      await saveLineup(m, data, info, best.zwids, best.reserve);
      return view(req, data.team.id);
    },

    // Staff: set the line-up. It must be legal (the three-rank rule) unless staff force it.
    'POST /api/ladder/lineup': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const [data, info] = await Promise.all([loadForMatch(body.match), riderInfo()]);
      const m = matchOr404(data, body.match);
      const zwids = (Array.isArray(body.zwids) ? body.zwids : []).map(String).filter(z => /^\d{1,12}$/.test(z));
      const check = checkLineup(zwids, data.roster, info);
      if (!check.ok && body.force !== true) throw new HttpError(400, check.issues.join(' '));
      let reserve = m.reserve || '';
      if (body.reserve !== undefined) reserve = data.roster[String(body.reserve)] ? String(body.reserve) : '';
      if (zwids.includes(reserve)) reserve = '';
      await saveLineup(m, data, info, zwids, reserve);
      return view(req, data.team.id);
    },

    // Staff: post to the ladder channel: the call for riders, or the line-up with the private event link.
    'POST /api/ladder/post': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const [data, info] = await Promise.all([loadForMatch(body.match), riderInfo()]);
      const raw = matchOr404(data, body.match), kind = ['callout', 'result'].includes(body.kind) ? body.kind : 'lineup';
      const m = { ...raw, reserveInfo: raw.reserve ? { name: (info[raw.reserve] && info[raw.reserve].name) || (raw.lineupNames || {})[raw.reserve] || raw.reserve } : null, teamName: data.team.name, lineupInfo: (raw.lineup || []).map(z => ({ zwid: z, name: (info[z] && info[z].name) || (raw.lineupNames || {})[z] || z, cat: (info[z] || {}).cat || '' })) };
      if (kind === 'result' && !(m.status === 'played' && m.result)) throw new HttpError(409, 'Enter the result first.');
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

  // ── The scheduled tick: reminders, the line-up picked for you when it is still open three days out, chasing a challenge that has no date, the result, and an inactivity watch (for every team) ──
  async function runSchedule(now = Date.now()) {
    const all = await fetchAll(), done = [];
    const claim = async key => (await redis([['HSETNX', KEYS.sent, key, new Date(now).toISOString()]]))[0];
    const info = Object.values(all.rosterBy).some(r => Object.keys(r).length) || all.matches.some(m => m.lineup && m.lineup.length) ? await riderInfo() : {};
    for (const team of all.list) {
      const data = sliceFor(all, team.id);
      const tag = `${discordEscape(team.name)}`;
      // 1. A team that has gone quiet: the league calls it a zombie after 21 days and drops it after 35.
      const act = activityOf(data.matches, now);
      for (const [limit, key, msg] of [[14, 'z14', 'has not raced for 14 days. At 21 days it counts as a zombie team and others can skip past it; at 35 it is removed from the ladder. Get a challenge out.'], [21, 'z21', 'has not raced for 21 days: it is now a zombie team. Get a match scheduled before 35 days or the ladder removes it.'], [30, 'z30', 'has not raced for 30 days: five days from removal from the ladder. Schedule a match now.']])
        if (act.days >= limit && act.state !== 'none' && act.state !== 'active' && await claim(`${team.id}:${key}:${act.last}`)) { await post('admin', `🧟 **Ladder: ${tag}** ${msg}`); done.push(`ladder-${key}`); }
      for (const raw of data.matches) {
        // 2. A challenge that still has no date: nudge the staff to agree one with the other captain (the league suggests five to seven days ahead).
        if (raw.status === 'challenge' && raw.createdAt) {
          const age = Math.floor((now - Date.parse(raw.createdAt)) / DAY_MS);
          if (age >= 2 && age <= 10 && await claim(`${raw.id}:chase:${Math.floor(age / 3)}`)) { await post('admin', `📨 **Ladder: ${tag} v ${discordEscape(raw.opponent)}** was opened ${age} days ago and still has no ${raw.at ? 'private event link' : 'date'}. Agree it with their captain on the ladder Discord, ideally five to seven days before the race.`); done.push('ladder-chase'); }
          continue;
        }
        if (raw.status !== 'scheduled' || !raw.at) continue;
        // 3. The race has started and there is no result: the staff enter it (and the 24-hour protest window runs from the finish).
        if (raw.at + 2 * 3600000 <= now) {
          // Once the race should be over, ask ZwiftRacing.app for the result (hourly, for a day); it is saved as played and the staff are asked to check it.
          const hourly = !raw.result && eventIdOf(raw) && process.env.ZWIFTRACING_API_KEY && fetchZrResults && now - raw.at < DAY_MS;
          if (hourly && await claim(`${raw.id}:autores:${Math.floor((now - raw.at) / 3600000)}`)) {
            try {
              const imp = await importResult(data, raw, info, eventIdOf(raw));
              await applyImported(raw, imp);
              await post('admin', `📥 **Ladder: ${tag} v ${discordEscape(raw.opponent)}** result imported from ZwiftRacing.app: ${imp.score.won ? 'we won' : 'they won'} ${imp.score.ourPoints}–${imp.score.theirPoints}${imp.changed ? ' (the five who raced differ from the line-up, which was updated)' : ''}. Check it at ${siteUrl} → 🪜 Ladder, then post it. Protests go to #race-committee within 24 hours.`);
              done.push('ladder-result-imported'); continue;
            } catch (e) { /* not published yet, or not five of ours: try again next hour, then the reminder below */ }
          }
          const waitForImport = !raw.result && eventIdOf(raw) && process.env.ZWIFTRACING_API_KEY && now - raw.at < 8 * 3600000;
          if (!raw.result && !waitForImport && now - raw.at < 7 * DAY_MS && await claim(`${raw.id}:result-due`)) { await post('admin', `📝 **Ladder: ${tag} v ${discordEscape(raw.opponent)}** has been run. Enter the finishing positions at ${siteUrl} → 🪜 Ladder. Protests go to #race-committee within 24 hours of the finish; after that the result is final.`); done.push('ladder-result-due'); }
          continue;
        }
        if (raw.at <= now) continue;
        const hours = (raw.at - now) / 3600000;
        let cur = raw;
        // 4. Three days out and no legal line-up: pick one from the riders' answers (a reserve too), unless the team has that switched off.
        const legal = r => { const c = checkLineup(r.lineup || [], data.roster, info); return c.complete && c.ok; };
        if (hours <= 72 && !legal(cur) && autoOn(data) && Object.keys(info).length) {
          const { best } = autoPick(data, cur, info, all);
          if (best && await claim(`${cur.id}:autopick`)) {
            await saveLineup(cur, data, info, best.zwids, best.reserve);
            cur = { ...cur, lineup: best.zwids, reserve: best.reserve, lineupNames: Object.fromEntries(best.zwids.map(z => [z, info[z].name])) };
            await post('admin', `🤖 **Ladder: ${tag} v ${discordEscape(cur.opponent)} on ${whenLabel(cur.at)}**: the line-up was picked automatically (${best.window}): ${best.zwids.map(z => discordEscape(info[z].name)).join(', ')}${best.reserve ? `. Reserve: ${discordEscape(info[best.reserve].name)}` : ''}. Change it at ${siteUrl} → 🪜 Ladder if you want someone else.`);
            done.push('ladder-autopick');
          }
        }
        const m = { ...cur, reserveInfo: cur.reserve ? { name: (info[cur.reserve] && info[cur.reserve].name) || (cur.lineupNames || {})[cur.reserve] || cur.reserve } : null, teamName: team.name, lineupInfo: (cur.lineup || []).map(z => ({ name: (info[z] && info[z].name) || (cur.lineupNames || {})[z] || z, cat: (info[z] || {}).cat || '' })) };
        const check = checkLineup(m.lineup || [], data.roster, info);
        const clash = clashesOf(m, all, info);
        if (hours <= 72 && (!check.complete || !check.ok) && await claim(`${m.id}:incomplete`)) {
          await post('admin', `⚠️ **Ladder: ${tag} v ${discordEscape(m.opponent)} on ${whenLabel(m.at)}** has no legal line-up yet (${check.complete ? check.issues.join(' ') : `${(m.lineup || []).length} of 5 riders picked`}). ${autoOn(data) ? 'Not enough riders fit inside three vELO ranks, so ' : ''}pick the five at ${siteUrl} → 🪜 Ladder.`);
          done.push('ladder-incomplete');
        }
        if (hours <= 72 && clash.length && await claim(`${m.id}:clash`)) {
          await post('admin', `⚠️ **Ladder: ${tag} v ${discordEscape(m.opponent)} on ${whenLabel(m.at)}** picks ${clash.map(c => `${discordEscape(c.name)} (also in ${discordEscape(c.team)}'s line-up v ${discordEscape(c.opponent)})`).join(', ')} at the same time. One rider cannot race twice.`);
          done.push('ladder-clash');
        }
        if (hours <= 48 && !m.eventLink && await claim(`${m.id}:nolink`)) { await post('admin', `🔗 **Ladder: ${tag} v ${discordEscape(m.opponent)} on ${whenLabel(m.at)}** has no private event link yet. Add it in ${siteUrl} → 🪜 Ladder so the riders get it.`); done.push('ladder-nolink'); }
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

  return { routes, runSchedule, load, healthRow, view, allMatches, pendingAnswers, checkLineup, suggest, scoreMatch, activityOf, replaceStarter, KEYS, RANKS };
};
