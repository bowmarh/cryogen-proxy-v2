'use strict';
// DIRT Racing Series (DRS): a structured, calendar-based league on Tuesdays. The club nominates a squad of eight riders into a vELO
// division (for example Platinum, capped at a raw rating), commits to one time-zone slot for the season, and races a fixed calendar of
// scratch, points, individual time trial and team time trial stages. All of the squad can race, but only the four best finishers score for the team,
// so the rest of the squad can ride as domestiques. A rider may sit up to 35 vELO points above the division's threshold and stay for the season; a rise of
// more than 50 points in one race that breaks that buffer is a single-race DQ and a forced upgrade.
// The squad must be final in the DRS portal 24 hours before a stage. This module watches the raw vELO rating of each squad rider (from the club
// roster the dashboard already caches, so it makes no ZwiftRacing.app requests of its own), speaks only when someone is near the cap, and reminds
// staff before the lock. Lives outside api/ on purpose (every file in api/ becomes a public function).
// The club can enter several DIRT teams (up to 10): each has its own season (division and threshold), squad, calendar and record, a rider can be
// in more than one squad, and staff manage every team. Riders say whether they can race each stage; the scoring four are picked from those answers and
// the vELO buffer (nobody close to the cap is put up to score), and the squad is locked once a rider has started a stage.
module.exports = function createDrs({ redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, getRatings, siteUrl }) {
  const KEYS = {
    season: 'cg:drs:season',     // JSON: the original team's season (before teams existed)
    teams: 'cg:drs:teams',       // team id -> {id, name, at}; none stored means the one original team, 'main'
    seasons: 'cg:drs:seasons',   // team id -> JSON: that team's season settings
    squad: 'cg:drs:squad',       // "<team id>|<zwid>" -> {zwid, name, at, entry} (a plain zwid is the original team)
    stages: 'cg:drs:stages',     // stage id -> JSON (with its team id)
    ratings: 'cg:drs:ratings',   // zwid -> {last, at, history:[{r, at}]}
    sent: 'cg:drs:sent',         // notice keys -> ISO time, so each goes once
    avail: 'cg:drs:avail',       // "<stage id>|<zwid>" -> yes | maybe | no
    archive: 'cg:drs:archive',   // season name + time -> JSON snapshot of a finished season
  };
  const TYPES = { scratch: 'Scratch race', points: 'Points race', itt: 'Individual time trial', ttt: 'Team time trial' };
  const TACTICS = {
    scratch: 'Scratch: first across the line. The four scorers stay fresh; the other four close gaps, set the pace on climbs and lead out.',
    points: 'Points race: the intermediate sprints and the finish both count. Decide who contests which sprint, and keep the scorers out of the wind.',
    itt: 'Individual time trial: no drafting help, so every rider rides their own best. The four fastest of ours count.',
    ttt: 'Team time trial: ride as a train, rotate smoothly, and keep the strongest four together to the line.',
  };
  const DEFAULTS = { buffer: 35, alertWithin: 10, spikeLimit: 50, squadMax: 8, scorers: 4, tz: 'Europe/London' };
  const DAY_MS = 86400000, HOUR_MS = 3600000, MAX_TEAMS = 10, DEFAULT_TEAM = 'main', DEFAULT_TEAM_NAME = 'CRYO-GEN';
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const isStaff = req => ['admin', 'mod'].includes(roleFromRequest(req));

  // ── Time: a stage is a date plus the squad's slot time in the series' time zone ──
  const partsIn = (tz, ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).map(x => [x.type, +x.value]));
  const offsetMin = (tz, ms) => { const p = partsIn(tz, ms); return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000) / 60000); };
  const zonedMs = (date, time, tz) => {
    const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number), guess = Date.UTC(y, m - 1, d, hh, mm);
    let ms = guess - offsetMin(tz, guess) * 60000;
    ms = guess - offsetMin(tz, ms) * 60000;
    return ms;
  };
  const validZone = tz => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; } };
  const whenLabel = (ms, tz) => new Date(ms).toLocaleString('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });

  // ── The vELO rules ──
  // State of one rider's rating against the division threshold. Before a rider's first race they must be at or below the threshold; after it they
  // may use the buffer. "danger" means within alertWithin points of the cap; "breach" is past it.
  function buffer(rating, season, raced) {
    const cap = season.threshold + season.buffer, remaining = cap - rating;
    let state;
    if (!rating) state = 'unknown';
    else if (!raced && rating > season.threshold) state = 'entry-over';
    else if (rating > cap) state = 'breach';
    else if (remaining <= season.alertWithin) state = 'danger';
    else if (rating > season.threshold) state = 'buffer';
    else state = 'ok';
    return { state, cap, remaining };
  }
  const worse = s => ({ 'entry-over': 4, breach: 4, danger: 3, buffer: 1, ok: 0, unknown: 0 })[s] || 0;

  // The best four of ours score. Points are the ones the DRS results give each rider; positions decide who the four are.
  function scoreStage(rows, scorers) {
    const finished = rows.filter(r => r.pos).sort((a, b) => a.pos - b.pos);
    const scoring = finished.slice(0, scorers);
    return { scorers: scoring.map(r => r.zwid), teamPoints: scoring.reduce((n, r) => n + r.pts, 0) };
  }

  // ── Storage and view ──
  const obj = raw => Object.fromEntries(pairs(raw).map(([f, v]) => [f, parse(v)]).filter(([, v]) => v));
  // Everything the module keeps, split by team. With no team stored there is one, 'main', whose season may still be in the old single key.
  async function fetchAll() {
    const [season, squad, stages, ratings, teams, seasons, avail] = await redis([['GET', KEYS.season], ['HGETALL', KEYS.squad], ['HGETALL', KEYS.stages], ['HGETALL', KEYS.ratings], ['HGETALL', KEYS.teams], ['HGETALL', KEYS.seasons], ['HGETALL', KEYS.avail]]);
    const list = Object.values(obj(teams)).filter(t => t.id).sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    if (!list.length) list.push({ id: DEFAULT_TEAM, name: DEFAULT_TEAM_NAME, at: '' });
    const squadBy = {};
    for (const [f, v] of pairs(squad)) {
      const rec = parse(v); if (!rec) continue;
      const [t, z] = f.includes('|') ? f.split('|') : [DEFAULT_TEAM, f];
      (squadBy[t] = squadBy[t] || {})[z] = rec;
    }
    const seasonBy = obj(seasons); if (!seasonBy[DEFAULT_TEAM] && parse(season)) seasonBy[DEFAULT_TEAM] = parse(season);
    return { list, stored: pairs(teams).length > 0, squadBy, seasonBy, stages: Object.values(obj(stages)).filter(x => x.id).map(x => ({ ...x, team: x.team || DEFAULT_TEAM })), ratings: obj(ratings), avail: Object.fromEntries(pairs(avail)) };
  }
  function sliceFor(all, teamId) {
    const team = teamId ? all.list.find(t => t.id === String(teamId)) : all.list[0];
    if (!team) throw new HttpError(404, 'That team does not exist.');
    const sn = all.seasonBy[team.id];
    return { all, teams: all.list, team, season: sn && { ...DEFAULTS, ...sn }, squad: all.squadBy[team.id] || {}, stages: all.stages.filter(x => x.team === team.id).sort((a, b) => a.n - b.n), ratings: all.ratings, avail: all.avail };
  }
  const load = async teamId => sliceFor(await fetchAll(), teamId);
  // Routes about one stage find its team from the stage itself, so they need no team in the request.
  async function loadForStage(id) {
    const all = await fetchAll(), st = all.stages.find(x => x.id === String(id || ''));
    if (!st) throw new HttpError(404, 'That stage does not exist.');
    return sliceFor(all, st.team);
  }
  const squadField = (data, zwid) => `${data.team.id}|${zwid}`;
  async function liveRatings() { try { return await getRatings(); } catch (e) { return {}; } }
  const startOf = (st, season) => zonedMs(st.date, st.time || season.time, season.tz);
  const racedIds = data => new Set(data.stages.filter(x => x.status === 'played' && x.result).flatMap(x => Object.keys(x.result.riders || {})));

  function squadRows(data, live) {
    if (!data.season) return [];
    const raced = racedIds(data);
    return Object.values(data.squad).map(r => {
      const rating = (live[r.zwid] && live[r.zwid].rating) || 0, prev = (data.ratings[r.zwid] || {}).history || [];
      const before = ([...prev].reverse().find(x => x.r !== rating) || {}).r || 0;   // the last different rating we saw
      return { zwid: r.zwid, name: (live[r.zwid] && live[r.zwid].name) || r.name, rating, cat: (live[r.zwid] || {}).cat || '', entry: r.entry || 0, raced: raced.has(r.zwid), ...buffer(rating, data.season, raced.has(r.zwid)),
        change: rating && before ? rating - before : 0, spike: !!(rating && before && rating - before > data.season.spikeLimit),
        dq: !!(rating && before && rating - before > data.season.spikeLimit && rating > data.season.threshold + data.season.buffer) };
    }).sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  }

  function standings(data) {
    const played = data.stages.filter(x => x.status === 'played' && x.result);
    const riders = new Map();
    for (const st of played) for (const [z, r] of Object.entries(st.result.riders || {})) {
      const cur = riders.get(z) || { zwid: z, name: (data.squad[z] && data.squad[z].name) || z, stages: 0, points: 0, scored: 0, best: null };
      cur.stages++; if (st.result.scorers.includes(z)) { cur.scored++; cur.points += r.pts; }
      if (r.pos && (cur.best === null || r.pos < cur.best)) cur.best = r.pos;
      riders.set(z, cur);
    }
    return { played: played.length, teamPoints: played.reduce((n, x) => n + x.result.teamPoints, 0), riders: [...riders.values()].sort((a, b) => b.points - a.points || b.scored - a.scored || a.name.localeCompare(b.name)) };
  }

  // Who the scoring four should be for a stage: the highest-rated riders who have not said no, leaving out anyone already close to (or past) the
  // vELO cap so a big finish does not push them out of the division. If that leaves too few, those riders are used last.
  function pickScorers(data, st, rows) {
    const answer = z => data.avail[`${st.id}|${z}`] || '', n = data.season.scorers;
    const can = rows.filter(r => answer(r.zwid) !== 'no');
    const rank = r => [answer(r.zwid) === 'yes' ? 0 : answer(r.zwid) === 'maybe' ? 1 : 2, worse(r.state) >= 3 ? 1 : 0];
    const ordered = [...can].sort((a, b) => rank(a)[1] - rank(b)[1] || rank(a)[0] - rank(b)[0] || b.rating - a.rating || a.name.localeCompare(b.name));
    const scorers = ordered.slice(0, n).map(r => r.zwid);
    const risky = ordered.slice(0, n).filter(r => worse(r.state) >= 3).map(r => r.name);
    return { scorers, risky, available: can.length, short: Math.max(0, n - scorers.length) };
  }
  const answersOf = (data, st) => { const c = { yes: 0, maybe: 0, no: 0, none: 0 }; for (const z of Object.keys(data.squad)) c[data.avail[`${st.id}|${z}`] || 'none']++; return c; };

  // What every team looks like at a glance, for the team picker and the overview.
  function overview(all, now) {
    return all.list.map(t => {
      const d = sliceFor(all, t.id), rec = standings(d);
      const next = d.season ? d.stages.filter(x => x.status === 'upcoming' && startOf(x, d.season) > now).sort((a, b) => a.n - b.n)[0] : null;
      return { id: t.id, name: t.name, division: d.season ? d.season.division : '', season: d.season ? d.season.name : '', riders: Object.keys(d.squad).length, squadMax: d.season ? d.season.squadMax : DEFAULTS.squadMax,
        played: rec.played, teamPoints: rec.teamPoints, next: next ? { id: next.id, n: next.n, at: startOf(next, d.season) } : null };
    });
  }

  async function view(req, teamId, now = Date.now()) {
    const data = await load(teamId);
    const staff = isStaff(req), me = memberFromRequest(req);
    const base = { team: { id: data.team.id, name: data.team.name }, teams: overview(data.all, now), limits: { teams: MAX_TEAMS } };
    if (!data.season) return { staff, ...base, season: null, squad: [], stages: [], record: standings(data), types: TYPES, me: me && { zwid: me.zwid } };
    const live = await liveRatings(), rows = squadRows(data, live);
    const inSquad = !!(me && data.squad[me.zwid]);
    const stages = data.stages.map(st => {
      const startMs = startOf(st, data.season);
      return { ...st, teamName: data.team.name, startMs, lockMs: startMs - 24 * HOUR_MS, eventLink: staff || inSquad ? st.eventLink : (st.eventLink ? 'hidden' : ''), tactics: TACTICS[st.type] || '',
        suggestedScorers: pickScorers(data, st, rows).scorers, counts: answersOf(data, st), myAvailability: me ? data.avail[`${st.id}|${me.zwid}`] || '' : '',
        availability: staff ? Object.fromEntries(Object.keys(data.squad).map(z => [z, data.avail[`${st.id}|${z}`] || ''])) : undefined,
        dnqRisk: Object.keys(data.squad).length - answersOf(data, st).no < data.season.scorers, upcoming: st.status !== 'played' && st.status !== 'cancelled' && startMs > now - 3 * HOUR_MS,
        clashes: staff ? stageClashes(st, data, now) : undefined };
    });
    return { staff, ...base, season: { ...data.season, cap: data.season.threshold + data.season.buffer }, squad: rows, stages, record: standings(data), types: TYPES, tactics: TACTICS, me: me && { zwid: me.zwid, inSquad },
      liveFeed: Object.keys(live).length > 0 };
  }

  // Another team's stage starting within two hours of this one with the same rider in its squad: a warning for staff.
  function stageClashes(st, data, now) {
    const start = startOf(st, data.season), out = [];
    for (const t of data.all.list) {
      if (t.id === data.team.id) continue;
      const d = sliceFor(data.all, t.id); if (!d.season) continue;
      for (const o of d.stages) {
        if (o.status !== 'upcoming' || Math.abs(startOf(o, d.season) - start) >= 2 * HOUR_MS) continue;
        for (const z of Object.keys(data.squad)) if (d.squad[z]) out.push({ zwid: z, name: data.squad[z].name, team: t.name, stage: o.n });
      }
    }
    return out;
  }

  // Every team's stages in one list, for the staff "This week" page and a rider's "My week".
  async function allStages(req, now = Date.now()) {
    const all = await fetchAll();
    const views = await Promise.all(all.list.map(t => view(req, t.id, now)));
    return views.flatMap(v => (v.stages || []).map(st => ({ ...st, teamId: v.team.id, teamName: v.team.name, inSquad: !!(v.me && v.me.inSquad) })));
  }

  // ── Messages ──
  const post = (kind, content) => discord(kind === 'admin' ? 'drs-admin' : 'drs', { content: String(content).slice(0, 1900) });
  function stageMessage(st, season, rows, kind, label = '') {
    const tag = label ? ` (${discordEscape(label)})` : '';   // the team's name, only when the club runs more than one
    const head = kind === 'h2' ? `⏰ **DRS stage in about two hours**${tag}` : kind === 'd1' ? `📅 **DRS stage tomorrow**${tag}` : `🏜️ **DRS stage**${tag}`;
    const roles = st.roles || {};
    const scorers = rows.filter(r => roles[r.zwid] === 'scorer'), support = rows.filter(r => roles[r.zwid] === 'support');
    const plan = scorers.length ? `\n🎯 **Scoring four:** ${scorers.map(r => discordEscape(r.name)).join(', ')}${support.length ? `\n🛡️ **Support:** ${support.map(r => discordEscape(r.name)).join(', ')}` : ''}` : '';
    const link = st.eventLink ? `\n🔗 **Private event link:** ${st.eventLink}` : '\n🔗 The private event link is still to come from the DRS portal.';
    return `${head} ${st.n}: ${TYPES[st.type] || st.type}${st.route ? ` — ${discordEscape(st.route)}${st.km ? ` (${st.km} km)` : ''}` : ''}\n🕒 ${whenLabel(startOf(st, season), season.tz)}${link}${plan || `\n**Squad (${rows.length}):**\n${rows.map(r => `• ${discordEscape(r.name)}${r.rating ? ` (${r.rating})` : ''}`).join('\n')}`}\n${TACTICS[st.type] || ''} One power-up leaves the pen with you for the whole race, so keep it for the finish or a key segment. Never change height or weight once you are in the pen, keep your heart rate monitor paired, and wear the club kit with [CRYO-GEN] in your name. Only our best four finishers score.`;
  }

  // The result of a played stage: our scoring riders in finishing order and the team's points.
  function resultMessage(st, rows, label = '') {
    const res = st.result || {}, riders = res.riders || {}, names = Object.fromEntries(rows.map(r => [r.zwid, r.name]));
    const finished = Object.entries(riders).filter(([, v]) => v.pos).sort((a, b) => a[1].pos - b[1].pos);
    const scoring = new Set(res.scorers || []);
    return `🏁 **DRS stage ${st.n} result${label ? ` (${discordEscape(label)})` : ''}**: ${res.teamPoints} team point${res.teamPoints === 1 ? '' : 's'}.\n${finished.map(([z, v]) => `${scoring.has(z) ? '⭐' : '•'} P${v.pos}  ${discordEscape(names[z] || z)}${v.pts ? ` · ${v.pts} pts` : ''}`).join('\n')}\n⭐ marks the riders whose points counted. Thank you to everyone who raced.`;
  }

  // ── Who may do what ──
  const stageOr404 = (data, id) => { const st = data.stages.find(x => x.id === String(id || '')); if (!st) throw new HttpError(404, 'That stage does not exist.'); return st; };
  const seasonOr409 = data => { if (!data.season) throw new HttpError(409, 'Set up the season first (division, threshold and time slot).'); return data.season; };
  const saveStage = st => redis([['HSET', KEYS.stages, st.id, JSON.stringify(st)]]);
  const num = (v, what, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be a number from ${lo} to ${hi}.`); return n; };

  const routes = {
    'GET /api/drs': async (req, _b, query = {}) => {
      if (!isStaff(req) && !memberFromRequest(req)) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      return view(req, query.team);
    },

    // Staff: add a team (up to 10), or rename one with its id. The first team added keeps the original one, so nothing already entered is lost.
    'POST /api/drs/team': async (req, body) => {
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
        if (all.list.length >= MAX_TEAMS) throw new HttpError(409, `The DIRT Series has ${MAX_TEAMS} teams already. Remove one first.`);
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'team';
        id = base; for (let n = 2; all.list.some(t => t.id === id); n++) id = `${base}-${n}`;
        cmds.push(['HSET', KEYS.teams, id, JSON.stringify({ id, name, at: new Date().toISOString() })]);
      }
      if (all.list.some(t => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Another team already has that name.');
      await redis(cmds);
      return view(req, id);
    },

    // Admin: remove a team with its season, squad and calendar (typed REMOVE). The season is archived first.
    'POST /api/drs/team-remove': async (req, body) => {
      requireRole(req, ['admin']);
      const data = await load(body.id);
      if (data.teams.length <= 1) throw new HttpError(409, 'Keep at least one team.');
      if (body.confirm !== 'REMOVE') throw new HttpError(400, 'Type REMOVE to confirm.');
      if (data.season) await redis([['HSET', KEYS.archive, `${data.season.name}|${new Date().toISOString()}`, JSON.stringify({ team: data.team, season: data.season, squad: data.squad, stages: data.stages })]]);
      const fields = Object.keys(data.squad).flatMap(z => [`${data.team.id}|${z}`, ...(data.team.id === DEFAULT_TEAM ? [z] : [])]);
      await redis([['HDEL', KEYS.teams, data.team.id], ['HDEL', KEYS.seasons, data.team.id], ...(data.team.id === DEFAULT_TEAM ? [['DEL', KEYS.season]] : []), ...fields.map(f => ['HDEL', KEYS.squad, f]), ...data.stages.map(x => ['HDEL', KEYS.stages, x.id])]);
      return view(req, data.teams.find(t => t.id !== data.team.id).id);
    },

    // Staff: the season's settings. `threshold` is the division's raw vELO ceiling (for example 2500 for Platinum).
    'POST /api/drs/season': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(body.team), old = data.season || {};
      const time = String(body.time || old.time || '19:30');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'The slot time looks like 19:30.');
      const tz = String(body.tz || old.tz || DEFAULTS.tz);
      if (!validZone(tz)) throw new HttpError(400, 'That time zone is not known (for example Europe/London).');
      const season = {
        name: text(body.name, 'season name', 60), division: text(body.division, 'division', 30), threshold: num(body.threshold, 'The vELO threshold', 100, 5000),
        buffer: body.buffer === undefined || body.buffer === '' ? DEFAULTS.buffer : num(body.buffer, 'The buffer', 0, 500),
        alertWithin: body.alertWithin === undefined || body.alertWithin === '' ? DEFAULTS.alertWithin : num(body.alertWithin, 'The alert distance', 1, 100),
        spikeLimit: body.spikeLimit === undefined || body.spikeLimit === '' ? DEFAULTS.spikeLimit : num(body.spikeLimit, 'The spike limit', 1, 500),
        squadMax: body.squadMax === undefined || body.squadMax === '' ? DEFAULTS.squadMax : num(body.squadMax, 'The squad size', 1, 20),
        scorers: body.scorers === undefined || body.scorers === '' ? DEFAULTS.scorers : num(body.scorers, 'The number of scorers', 1, 10),
        slot: text(body.slot, 'time slot name', 60, false), time, tz,
        ...(old.autoRoles === false ? { autoRoles: false } : {}),
      };
      await redis([['HSET', KEYS.seasons, data.team.id, JSON.stringify(season)]]);
      return view(req, data.team.id);
    },

    // Admin: archive the finished season and clear the squad, stages and rating history for the next one.
    'POST /api/drs/reset': async (req, body) => {
      requireRole(req, ['admin']);
      if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
      const data = await load(body.team);
      if (data.season) await redis([['HSET', KEYS.archive, `${data.season.name}|${new Date().toISOString()}`, JSON.stringify({ team: data.team, season: data.season, squad: data.squad, stages: data.stages })]]);
      if (data.teams.length === 1) await redis([['DEL', KEYS.season], ['DEL', KEYS.seasons], ['DEL', KEYS.squad], ['DEL', KEYS.stages], ['DEL', KEYS.ratings]]);
      else await redis([['HDEL', KEYS.seasons, data.team.id], ...(data.team.id === DEFAULT_TEAM ? [['DEL', KEYS.season]] : []), ...Object.keys(data.squad).flatMap(z => [['HDEL', KEYS.squad, `${data.team.id}|${z}`], ...(data.team.id === DEFAULT_TEAM ? [['HDEL', KEYS.squad, z]] : [])]), ...data.stages.map(x => ['HDEL', KEYS.stages, x.id])]);
      return view(req, data.team.id);
    },

    // Staff: nominate a rider (up to eight, or whatever the season sets) or take them out. Entering above the threshold is refused unless forced.
    'POST /api/drs/squad': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(body.team), season = seasonOr409(data);
      const zwid = String(body.zwid || '');
      if (!/^\d{1,12}$/.test(zwid)) throw new HttpError(400, 'A Zwift ID is needed (numbers only).');
      const next = data.stages.filter(x => x.status === 'upcoming' && startOf(x, season) > Date.now()).sort((a, b) => a.n - b.n)[0];
      if (body.force !== true && next && startOf(next, season) - Date.now() < 24 * HOUR_MS) throw new HttpError(409, `The squad is locked: stage ${next.n} starts within 24 hours and the DRS portal needs the final squad by then. Use force if Race Control has agreed a change.`);
      if (body.remove && body.force !== true && racedIds(data).has(zwid)) throw new HttpError(409, `${(data.squad[zwid] || {}).name || zwid} has started a stage, so they are locked into this squad for the season. Use force only if Race Control has agreed the change.`);
      if (body.remove) { await redis([['HDEL', KEYS.squad, squadField(data, zwid)], ...(data.team.id === DEFAULT_TEAM ? [['HDEL', KEYS.squad, zwid]] : [])]); return view(req, data.team.id); }
      if (data.squad[zwid]) return view(req, data.team.id);
      const info = (await liveRatings())[zwid];
      if (!info && !body.name) throw new HttpError(404, 'That Zwift ID is not in the club roster.');
      if (Object.keys(data.squad).length >= season.squadMax) throw new HttpError(409, `The squad is full (${season.squadMax} riders). Take someone out first.`);
      const rating = (info && info.rating) || 0;
      if (rating > season.threshold && !data.stages.some(x => x.status === 'played') && body.force !== true) throw new HttpError(400, `${(info && info.name) || zwid} is rated ${rating}, above the ${season.division} threshold of ${season.threshold}. A rider must be at or below it before their first race.`);
      await redis([['HSET', KEYS.squad, squadField(data, zwid), JSON.stringify({ zwid, name: info ? info.name : text(body.name, 'name', 60), at: new Date().toISOString(), entry: rating })]]);
      return view(req, data.team.id);
    },

    // Staff: a stage of the fixed calendar.
    'POST /api/drs/stage': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = body.id ? await loadForStage(body.id) : await load(body.team), season = seasonOr409(data);
      const old = body.id ? stageOr404(data, body.id) : null;
      const date = String(body.date || ''), time = String(body.time || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new HttpError(400, 'The stage date looks like 2026-11-03.');
      if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'The start time looks like 19:30 (leave it empty to use the squad\'s slot).');
      if (!TYPES[body.type]) throw new HttpError(400, 'Choose scratch, points, itt or ttt.');
      const link = String(body.eventLink || '').trim();
      if (link && !/^https:\/\/[^\s]+$/i.test(link)) throw new HttpError(400, 'The private event link must be a web address starting https://.');
      const km = body.km === '' || body.km === undefined ? null : num(body.km, 'The distance', 1, 400);
      const n = body.n ? num(body.n, 'The stage number', 1, 99) : (old ? old.n : Math.max(0, ...data.stages.map(x => x.n)) + 1);
      if (data.stages.some(x => x.n === n && (!old || x.id !== old.id))) throw new HttpError(409, `Stage ${n} already exists.`);
      const st = { ...(old || { id: `s${n}-${Date.now().toString(36)}`, team: data.team.id, status: 'upcoming', roles: {} }), n, date, time, type: body.type, route: text(body.route, 'route', 80, false), km, eventLink: link, notes: text(body.notes, 'notes', 300, false) };
      await saveStage(st);
      return view(req, data.team.id);
    },

    // Staff: paste the whole calendar, one stage a line: "2026-11-03 | scratch | Route name | 28". Existing stage numbers are kept.
    'POST /api/drs/calendar': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(body.team); seasonOr409(data);
      const lines = String(body.lines || '').split('\n').map(l => l.trim()).filter(Boolean).slice(0, 30);
      if (!lines.length) throw new HttpError(400, 'Paste one stage a line: date | type | route | km.');
      let n = Math.max(0, ...data.stages.map(x => x.n));
      const cmds = [];
      for (const [i, line] of lines.entries()) {
        const [date, type, route, km] = line.split('|').map(x => (x || '').trim());
        const t = String(type || '').toLowerCase().replace(/\s+/g, '');
        const key = { scratch: 'scratch', points: 'points', itt: 'itt', timetrial: 'itt', individualtimetrial: 'itt', ttt: 'ttt', teamtimetrial: 'ttt' }[t];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || Number.isNaN(Date.parse(`${date}T12:00:00Z`))) throw new HttpError(400, `Line ${i + 1}: the date looks like 2026-11-03.`);
        if (!key) throw new HttpError(400, `Line ${i + 1}: the type is scratch, points, itt or ttt.`);
        n++;
        const st = { id: `s${n}-${Date.now().toString(36)}${i}`, team: data.team.id, n, date, time: '', type: key, route: (route || '').slice(0, 80), km: km && Number(km) > 0 ? Number(km) : null, eventLink: '', notes: '', status: 'upcoming', roles: {} };
        cmds.push(['HSET', KEYS.stages, st.id, JSON.stringify(st)]);
      }
      await redis(cmds);
      return view(req, data.team.id);
    },

    'POST /api/drs/stage-remove': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForStage(body.id), st = stageOr404(data, body.id);
      await redis([['HDEL', KEYS.stages, st.id]]);
      return view(req, data.team.id);
    },

    // Staff: who the scoring four are for a stage; everyone else in the squad is support.
    'POST /api/drs/roles': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForStage(body.stage), season = seasonOr409(data), st = stageOr404(data, body.stage);
      let picked = body.auto === true ? pickScorers(data, st, squadRows(data, await liveRatings())) : null;
      const scorers = picked ? picked.scorers : [...new Set((Array.isArray(body.scorers) ? body.scorers : []).map(String))];
      if (scorers.some(z => !data.squad[z])) throw new HttpError(400, 'Only riders in the squad can be named.');
      if (scorers.length > season.scorers) throw new HttpError(400, `Only the best ${season.scorers} finishers score, so name at most ${season.scorers}.`);
      await saveStage({ ...st, roles: Object.fromEntries(Object.keys(data.squad).map(z => [z, scorers.includes(z) ? 'scorer' : 'support'])) });
      return view(req, data.team.id);
    },

    // A squad rider says whether they can race a stage (staff can answer for someone).
    'POST /api/drs/availability': async (req, body) => {
      const me = memberFromRequest(req), staff = isStaff(req);
      if (!me && !staff) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const data = await loadForStage(body.stage), st = stageOr404(data, body.stage);
      const zwid = staff && body.zwid ? String(body.zwid) : me && me.zwid;
      if (!zwid || !data.squad[zwid]) throw new HttpError(403, 'Only riders in the squad answer for a stage. Ask the captains to add you.');
      if (!['yes', 'maybe', 'no', ''].includes(body.status)) throw new HttpError(400, 'Answer yes, maybe or no.');
      await redis([body.status ? ['HSET', KEYS.avail, `${st.id}|${zwid}`, body.status] : ['HDEL', KEYS.avail, `${st.id}|${zwid}`]]);
      return view(req, data.team.id);
    },

    // Staff: the automatic steps (scoring four and reminders' audit before a stage) on or off for this team.
    'POST /api/drs/auto': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(body.team), season = seasonOr409(data);
      await redis([['HSET', KEYS.seasons, data.team.id, JSON.stringify({ ...season, autoRoles: body.on !== false })]]);
      return view(req, data.team.id);
    },

    // Staff: post the stage (route, time, the private link from the DRS portal, the squad and the plan) to the DRS channel.
    'POST /api/drs/post': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForStage(body.stage), season = seasonOr409(data), st = stageOr404(data, body.stage);
      const rows = squadRows(data, await liveRatings()), kind = body.kind === 'result' ? 'result' : 'post';
      if (kind === 'result' && !(st.status === 'played' && st.result)) throw new HttpError(409, 'Enter the result first.');
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${st.id}:manual${kind === 'result' ? '-result' : ''}:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, 'That was posted a moment ago.');
      const label = data.teams.length > 1 ? data.team.name : '';
      await post('public', kind === 'result' ? resultMessage(st, rows, label) : stageMessage(st, season, rows, 'post', label));
      return { posted: true };
    },

    // Staff: how our riders finished and the points the DRS results gave them. The best four finishers score for the team.
    'POST /api/drs/result': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await loadForStage(body.stage), season = seasonOr409(data), st = stageOr404(data, body.stage);
      const rows = [], riders = {}, used = new Set();
      for (const [zwid, v] of Object.entries(body.results || {})) {
        if (!data.squad[zwid]) throw new HttpError(400, 'Only riders in the squad can have a result.');
        const pos = v && v.pos !== '' && v.pos !== undefined && v.pos !== null ? Number(v.pos) : 0, pts = v && v.pts !== '' && v.pts !== undefined && v.pts !== null ? Number(v.pts) : 0;
        if (pos && (!Number.isInteger(pos) || pos < 1 || pos > 999)) throw new HttpError(400, 'Positions are whole numbers from 1.');
        if (!(pts >= 0 && pts <= 9999)) throw new HttpError(400, 'Points are numbers from 0.');
        if (pos && used.has(pos)) throw new HttpError(400, `Position ${pos} is given twice.`);
        if (pos) used.add(pos);
        if (pos || pts) { rows.push({ zwid, pos, pts }); riders[zwid] = { pos: pos || null, pts }; }
      }
      if (!rows.length) throw new HttpError(400, 'Enter at least one rider\'s finish.');
      const score = scoreStage(rows, season.scorers);
      await saveStage({ ...st, status: 'played', result: { riders, ...score, at: new Date().toISOString() } });
      return view(req, data.team.id);
    },
  };

  // ── The scheduled tick ──
  // Daily-ish: record each squad rider's rating, and speak only when someone is near the cap, over it, or has jumped. Before a stage: a pre-check
  // three days out, a finalise-in-the-portal reminder, the stage post a day and two hours before.
  async function runSchedule(now = Date.now()) {
    const all = await fetchAll(), done = [];
    const live = await liveRatings();
    for (const t of all.list) done.push(...await runTeam(sliceFor(all, t.id), all, live, now));
    return done;
  }

  async function runTeam(data, all, live, now) {
    const done = [];
    if (!data.season || !Object.keys(data.squad).length) return done;
    const label = all.list.length > 1 ? data.team.name : '';
    const claim = async key => (await redis([['HSETNX', KEYS.sent, key, new Date(now).toISOString()]]))[0];
    // 1. Snapshot the ratings (a new entry only when the number changed) and look for trouble.
    const cmds = [];
    for (const z of Object.keys(data.squad)) {
      const r = live[z] && live[z].rating; if (!r) continue;
      const rec = data.ratings[z] || { history: [] }, lastR = rec.history.length ? rec.history[rec.history.length - 1].r : 0;
      if (r !== lastR) { rec.history = [...rec.history, { r, at: now }].slice(-20); data.ratings[z] = rec; cmds.push(['HSET', KEYS.ratings, z, JSON.stringify(rec)]); }
    }
    if (cmds.length) await redis(cmds);
    const week = Math.floor(now / (7 * DAY_MS));
    const rows = squadRows(data, live), trouble = [];
    for (const r of rows) {
      if (!r.rating) continue;
      if (worse(r.state) >= 3 && await claim(`${r.zwid}:${r.state}:${week}`)) trouble.push(`• **${discordEscape(r.name)}**: ${r.rating}. ${r.state === 'entry-over' ? `Above the ${data.season.threshold} threshold before a first race: they cannot start.` : r.state === 'breach' ? `Past the cap of ${r.cap} by ${-r.remaining}: they must move up a division${r.spike ? ' (and a rise this big in one race is a single-race DQ)' : ''}.` : `Only ${r.remaining} point${r.remaining === 1 ? '' : 's'} below the cap of ${r.cap}.`}`);
      else if (r.spike && await claim(`${r.zwid}:spike:${r.rating}`)) trouble.push(`• **${discordEscape(r.name)}** jumped ${r.change} points to ${r.rating}. ${r.dq ? 'That is past the cap: a single-race DQ and a forced upgrade.' : `A rise of more than ${data.season.spikeLimit} in one race that also breaks the buffer is a single-race DQ.`}`);
    }
    if (trouble.length) { await post('admin', `🚨 **DRS vELO alert (${label ? discordEscape(label) + ', ' : ''}${discordEscape(data.season.division)}, cap ${data.season.threshold + data.season.buffer})**\n${trouble.join('\n')}`); done.push('drs-velo'); }
    // 2. Stage reminders, the availability survey five days out, the audit and the scoring four two days out, and the result.
    for (const st of data.stages) {
      if (st.status !== 'upcoming') continue;
      const start = startOf(st, data.season), hours = (start - now) / HOUR_MS;
      if (start + 3 * HOUR_MS <= now) {
        if (!st.result && now - start < 7 * DAY_MS && await claim(`${st.id}:result-due`)) { await post('admin', `📝 **DRS stage ${st.n}${label ? ` ${discordEscape(label)}` : ''}** has been run. Enter how the squad finished at ${siteUrl} → 🏜️ DIRT. Provisional results can be protested on the DRS Discord.`); done.push('drs-result-due'); }
        continue;
      }
      if (start <= now) continue;
      const bad = rows.filter(r => worse(r.state) >= 3);
      if (hours <= 120 && hours > 24 && await claim(`${st.id}:avail`)) {
        await post('public', `🗓️ **DRS stage ${st.n}${label ? ` (${discordEscape(label)})` : ''}: can you race?** ${TYPES[st.type] || st.type}${st.route ? ` — ${discordEscape(st.route)}` : ''}, ${whenLabel(start, data.season.tz)}. Squad riders: tap Yes, Maybe or No at ${siteUrl} → 🏜️ DIRT so the captains can set the scoring four.`);
        done.push('drs-avail');
      }
      if (hours <= 72 && (rows.length < data.season.scorers || bad.length) && await claim(`${st.id}:precheck`)) {
        await post('admin', `⚠️ **DRS stage ${st.n}${label ? ` ${discordEscape(label)}` : ''} (${whenLabel(start, data.season.tz)})**: ${rows.length < data.season.scorers ? `only ${rows.length} rider${rows.length === 1 ? '' : 's'} in the squad (at least ${data.season.scorers} are needed to score). ` : ''}${bad.length ? `${bad.map(r => discordEscape(r.name)).join(', ')} ${bad.length === 1 ? 'is' : 'are'} at or past the vELO limit. ` : ''}The squad must be final in the DRS portal by ${whenLabel(start - 24 * HOUR_MS, data.season.tz)}.`);
        done.push('drs-precheck');
      }
      // Two days out: the audit (buffer margins, answers, DNQ risk) and, unless switched off, the scoring four chosen from the answers.
      if (hours <= 48 && await claim(`${st.id}:audit`)) {
        const c = answersOf(data, st), roleless = !Object.keys(st.roles || {}).length;
        let line = '';
        if (roleless && data.season.autoRoles !== false) {
          const pick = pickScorers(data, st, rows);
          if (pick.scorers.length) {
            await saveStage({ ...st, roles: Object.fromEntries(Object.keys(data.squad).map(z => [z, pick.scorers.includes(z) ? 'scorer' : 'support'])) });
            st.roles = Object.fromEntries(Object.keys(data.squad).map(z => [z, pick.scorers.includes(z) ? 'scorer' : 'support']));
            line = `\n🎯 Scoring four picked automatically: ${pick.scorers.map(z => discordEscape((rows.find(r => r.zwid === z) || {}).name || z)).join(', ')}${pick.risky.length ? ` (⚠️ ${pick.risky.map(discordEscape).join(', ')} ${pick.risky.length === 1 ? 'is' : 'are'} near the cap: nobody better was free)` : ''}.`;
          }
        }
        const warn = rows.filter(r => r.state === 'danger' || r.state === 'breach' || r.state === 'entry-over' || r.dq);
        await post('admin', `🔎 **DRS stage ${st.n}${label ? ` ${discordEscape(label)}` : ''} audit (${whenLabel(start, data.season.tz)})**\nAnswers: ${c.yes} yes · ${c.maybe} maybe · ${c.no} no · ${c.none} not answered.${Object.keys(data.squad).length - c.no < data.season.scorers ? ` ⚠️ Fewer than ${data.season.scorers} can race: the team would not score.` : ''}\nvELO buffer: ${warn.length ? warn.map(r => `${discordEscape(r.name)} ${r.rating} (${r.dq ? 'single-race DQ risk' : r.remaining < 0 ? 'past the cap' : `${r.remaining} to the cap`})`).join(', ') : 'everyone is clear of the warning zone'}.${line}\nThe squad locks ${whenLabel(start - 24 * HOUR_MS, data.season.tz)}.`);
        done.push('drs-audit');
      }
      if (hours <= 36 && hours > 24 && await claim(`${st.id}:finalise`)) {
        await post('admin', `🔒 **Finalise the DRS squad for stage ${st.n}${label ? ` (${discordEscape(label)})` : ''}**: it locks at ${whenLabel(start - 24 * HOUR_MS, data.season.tz)}. ${rows.length} rider${rows.length === 1 ? '' : 's'} nominated. Race Control runs its automated checks after the lock.`);
        done.push('drs-finalise');
      }
      if (hours <= 24 && await claim(`${st.id}:d1`)) { await post('public', stageMessage(st, data.season, rows, 'd1', label)); done.push('drs-d1'); }
      if (hours <= 2 && await claim(`${st.id}:h2`)) { await post('public', stageMessage(st, data.season, rows, 'h2', label)); done.push('drs-h2'); }
    }
    return done;
  }

  async function healthRow(now = Date.now()) {
    const all = await fetchAll();
    const teams = all.list.map(t => sliceFor(all, t.id)).filter(d => d.season);
    if (!teams.length) return ['info', 'The DIRT Racing Series is not set up yet. Add the season in the DIRT tab when the club enters.'];
    const live = await liveRatings();
    const parts = [], bad = [];
    for (const data of teams) {
      const rows = squadRows(data, live), over = rows.filter(r => worse(r.state) >= 3 && r.rating);
      const next = data.stages.filter(x => x.status === 'upcoming' && startOf(x, data.season) > now).sort((a, b) => a.n - b.n)[0];
      const tail = next ? ` Next: stage ${next.n}, ${whenLabel(startOf(next, data.season), data.season.tz)}.` : ' No stage coming up.';
      const who = teams.length > 1 ? `${data.team.name} ` : '';
      if (over.length) bad.push(`${who}${data.season.division}: ${over.map(r => `${r.name} (${r.rating})`).join(', ')} at or past the vELO limit.${tail}`);
      parts.push(`${who}${data.season.division}, ${rows.length} of ${data.season.squadMax} riders, all inside the vELO limit.${tail}`);
    }
    return bad.length ? ['warn', bad.join(' ')] : ['ok', parts.join(' ')];
  }

  // Squad riders who have not answered for a stage that starts within `hours` (for the automatic reminder, no request needed).
  async function pendingAnswers(now = Date.now(), hours = 120) {
    const all = await fetchAll(), out = [];
    for (const t of all.list) {
      const d = sliceFor(all, t.id); if (!d.season) continue;
      for (const st of d.stages) {
        const start = st.status === 'upcoming' ? startOf(st, d.season) : 0;
        if (!start || start <= now || start - now > hours * HOUR_MS) continue;
        for (const z of Object.keys(d.squad)) if (!all.avail[`${st.id}|${z}`]) out.push({ stageId: st.id, teamName: d.team.name, n: st.n, at: start, zwid: z });
      }
    }
    return out;
  }

  return { routes, runSchedule, load, healthRow, view, allStages, pendingAnswers, pickScorers, buffer, scoreStage, KEYS };
};
