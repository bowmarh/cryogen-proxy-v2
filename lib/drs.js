'use strict';
// DIRT Racing Series (DRS): a structured, calendar-based league on Tuesdays. The club nominates a squad of up to eight riders into a vELO
// division (for example Platinum, capped at a raw rating), commits to one time-zone slot for the season, and races a fixed calendar of
// scratch, points, individual time trial and team time trial stages. All eight can race, but only the four best finishers score for the team,
// so half the squad can ride as domestiques. A rider may sit up to 35 vELO points above the division's threshold and stay for the season; a rise of
// more than 50 points in one race that breaks that buffer is a single-race DQ and a forced upgrade.
// The squad must be final in the DRS portal 24 hours before a stage. This module watches the raw vELO rating of each squad rider (from the club
// roster the dashboard already caches, so it makes no ZwiftRacing.app requests of its own), speaks only when someone is near the cap, and reminds
// staff before the lock. Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createDrs({ redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, getRatings, siteUrl }) {
  const KEYS = {
    season: 'cg:drs:season',     // JSON: the current season's settings
    squad: 'cg:drs:squad',       // zwid -> {zwid, name, at, entry}
    stages: 'cg:drs:stages',     // stage id -> JSON
    ratings: 'cg:drs:ratings',   // zwid -> {last, at, history:[{r, at}]}
    sent: 'cg:drs:sent',         // notice keys -> ISO time, so each goes once
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
  const DAY_MS = 86400000, HOUR_MS = 3600000;
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
  async function load() {
    const [season, squad, stages, ratings] = await redis([['GET', KEYS.season], ['HGETALL', KEYS.squad], ['HGETALL', KEYS.stages], ['HGETALL', KEYS.ratings]]);
    const obj = raw => Object.fromEntries(pairs(raw).map(([f, v]) => [f, parse(v)]).filter(([, v]) => v));
    const s = parse(season);
    return { season: s && { ...DEFAULTS, ...s }, squad: obj(squad), stages: Object.values(obj(stages)).filter(x => x.id).sort((a, b) => a.n - b.n), ratings: obj(ratings) };
  }
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
        change: rating && before ? rating - before : 0, spike: !!(rating && before && rating - before > data.season.spikeLimit) };
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

  async function view(req, now = Date.now()) {
    const data = await load();
    const staff = isStaff(req), me = memberFromRequest(req);
    if (!data.season) return { staff, season: null, squad: [], stages: [], record: standings(data), types: TYPES, me: me && { zwid: me.zwid } };
    const live = await liveRatings(), rows = squadRows(data, live);
    const inSquad = !!(me && data.squad[me.zwid]);
    const ratedTop = [...rows].filter(r => r.rating).sort((a, b) => b.rating - a.rating).slice(0, data.season.scorers).map(r => r.zwid);
    const stages = data.stages.map(st => {
      const startMs = startOf(st, data.season);
      return { ...st, startMs, lockMs: startMs - 24 * HOUR_MS, eventLink: staff || inSquad ? st.eventLink : (st.eventLink ? 'hidden' : ''), tactics: TACTICS[st.type] || '',
        suggestedScorers: ratedTop, upcoming: st.status !== 'played' && st.status !== 'cancelled' && startMs > now - 3 * HOUR_MS };
    });
    return { staff, season: { ...data.season, cap: data.season.threshold + data.season.buffer }, squad: rows, stages, record: standings(data), types: TYPES, tactics: TACTICS, me: me && { zwid: me.zwid, inSquad },
      liveFeed: Object.keys(live).length > 0 };
  }

  // ── Messages ──
  const post = (kind, content) => discord(kind === 'admin' ? 'drs-admin' : 'drs', { content: String(content).slice(0, 1900) });
  function stageMessage(st, season, rows, kind) {
    const head = kind === 'h2' ? '⏰ **DRS stage in about two hours**' : kind === 'd1' ? '📅 **DRS stage tomorrow**' : '🏜️ **DRS stage**';
    const roles = st.roles || {};
    const scorers = rows.filter(r => roles[r.zwid] === 'scorer'), support = rows.filter(r => roles[r.zwid] === 'support');
    const plan = scorers.length ? `\n🎯 **Scoring four:** ${scorers.map(r => discordEscape(r.name)).join(', ')}${support.length ? `\n🛡️ **Support:** ${support.map(r => discordEscape(r.name)).join(', ')}` : ''}` : '';
    const link = st.eventLink ? `\n🔗 **Private event link:** ${st.eventLink}` : '\n🔗 The private event link is still to come from the DRS portal.';
    return `${head} ${st.n}: ${TYPES[st.type] || st.type}${st.route ? ` — ${discordEscape(st.route)}${st.km ? ` (${st.km} km)` : ''}` : ''}\n🕒 ${whenLabel(startOf(st, season), season.tz)}${link}${plan || `\n**Squad (${rows.length}):**\n${rows.map(r => `• ${discordEscape(r.name)}${r.rating ? ` (${r.rating})` : ''}`).join('\n')}`}\n${TACTICS[st.type] || ''} No PowerUps in DRS: it is all racecraft and drafting. Only our best four finishers score.`;
  }

  // ── Who may do what ──
  const stageOr404 = (data, id) => { const st = data.stages.find(x => x.id === String(id || '')); if (!st) throw new HttpError(404, 'That stage does not exist.'); return st; };
  const seasonOr409 = data => { if (!data.season) throw new HttpError(409, 'Set up the season first (division, threshold and time slot).'); return data.season; };
  const saveStage = st => redis([['HSET', KEYS.stages, st.id, JSON.stringify(st)]]);
  const num = (v, what, lo, hi) => { const n = Number(v); if (!Number.isFinite(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be a number from ${lo} to ${hi}.`); return n; };

  const routes = {
    'GET /api/drs': async req => {
      if (!isStaff(req) && !memberFromRequest(req)) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      return view(req);
    },

    // Staff: the season's settings. `threshold` is the division's raw vELO ceiling (for example 2500 for Platinum).
    'POST /api/drs/season': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const old = (await load()).season || {};
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
      };
      await redis([['SET', KEYS.season, JSON.stringify(season)]]);
      return view(req);
    },

    // Admin: archive the finished season and clear the squad, stages and rating history for the next one.
    'POST /api/drs/reset': async (req, body) => {
      requireRole(req, ['admin']);
      if (body.confirm !== 'RESET') throw new HttpError(400, 'Type RESET to confirm.');
      const data = await load();
      if (data.season) await redis([['HSET', KEYS.archive, `${data.season.name}|${new Date().toISOString()}`, JSON.stringify({ season: data.season, squad: data.squad, stages: data.stages })]]);
      await redis([['DEL', KEYS.season], ['DEL', KEYS.squad], ['DEL', KEYS.stages], ['DEL', KEYS.ratings]]);
      return view(req);
    },

    // Staff: nominate a rider (up to eight) or take them out. Entering above the threshold is refused unless forced.
    'POST /api/drs/squad': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(), season = seasonOr409(data);
      const zwid = String(body.zwid || '');
      if (!/^\d{1,12}$/.test(zwid)) throw new HttpError(400, 'A Zwift ID is needed (numbers only).');
      if (body.remove) { await redis([['HDEL', KEYS.squad, zwid]]); return view(req); }
      if (data.squad[zwid]) return view(req);
      const info = (await liveRatings())[zwid];
      if (!info && !body.name) throw new HttpError(404, 'That Zwift ID is not in the club roster.');
      if (Object.keys(data.squad).length >= season.squadMax) throw new HttpError(409, `The squad is full (${season.squadMax} riders). Take someone out first.`);
      const rating = (info && info.rating) || 0;
      if (rating > season.threshold && !data.stages.some(x => x.status === 'played') && body.force !== true) throw new HttpError(400, `${(info && info.name) || zwid} is rated ${rating}, above the ${season.division} threshold of ${season.threshold}. A rider must be at or below it before their first race.`);
      await redis([['HSET', KEYS.squad, zwid, JSON.stringify({ zwid, name: info ? info.name : text(body.name, 'name', 60), at: new Date().toISOString(), entry: rating })]]);
      return view(req);
    },

    // Staff: a stage of the fixed calendar.
    'POST /api/drs/stage': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(), season = seasonOr409(data);
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
      const st = { ...(old || { id: `s${n}-${Date.now().toString(36)}`, status: 'upcoming', roles: {} }), n, date, time, type: body.type, route: text(body.route, 'route', 80, false), km, eventLink: link, notes: text(body.notes, 'notes', 300, false) };
      await saveStage(st);
      return view(req);
    },

    // Staff: paste the whole calendar, one stage a line: "2026-11-03 | scratch | Route name | 28". Existing stage numbers are kept.
    'POST /api/drs/calendar': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(); seasonOr409(data);
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
        const st = { id: `s${n}-${Date.now().toString(36)}${i}`, n, date, time: '', type: key, route: (route || '').slice(0, 80), km: km && Number(km) > 0 ? Number(km) : null, eventLink: '', notes: '', status: 'upcoming', roles: {} };
        cmds.push(['HSET', KEYS.stages, st.id, JSON.stringify(st)]);
      }
      await redis(cmds);
      return view(req);
    },

    'POST /api/drs/stage-remove': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const st = stageOr404(await load(), body.id);
      await redis([['HDEL', KEYS.stages, st.id]]);
      return view(req);
    },

    // Staff: who the scoring four are for a stage; everyone else in the squad is support.
    'POST /api/drs/roles': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(), season = seasonOr409(data), st = stageOr404(data, body.stage);
      const scorers = [...new Set((Array.isArray(body.scorers) ? body.scorers : []).map(String))];
      if (scorers.some(z => !data.squad[z])) throw new HttpError(400, 'Only riders in the squad can be named.');
      if (scorers.length > season.scorers) throw new HttpError(400, `Only the best ${season.scorers} finishers score, so name at most ${season.scorers}.`);
      await saveStage({ ...st, roles: Object.fromEntries(Object.keys(data.squad).map(z => [z, scorers.includes(z) ? 'scorer' : 'support'])) });
      return view(req);
    },

    // Staff: post the stage (route, time, the private link from the DRS portal, the squad and the plan) to the DRS channel.
    'POST /api/drs/post': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(), season = seasonOr409(data), st = stageOr404(data, body.stage);
      const rows = squadRows(data, await liveRatings());
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${st.id}:manual:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, 'That was posted a moment ago.');
      await post('public', stageMessage(st, season, rows, 'post'));
      return { posted: true };
    },

    // Staff: how our riders finished and the points the DRS results gave them. The best four finishers score for the team.
    'POST /api/drs/result': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(), season = seasonOr409(data), st = stageOr404(data, body.stage);
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
      return view(req);
    },
  };

  // ── The scheduled tick ──
  // Daily-ish: record each squad rider's rating, and speak only when someone is near the cap, over it, or has jumped. Before a stage: a pre-check
  // three days out, a finalise-in-the-portal reminder, the stage post a day and two hours before.
  async function runSchedule(now = Date.now()) {
    const data = await load(), done = [];
    if (!data.season || !Object.keys(data.squad).length) return done;
    const claim = async key => (await redis([['HSETNX', KEYS.sent, key, new Date(now).toISOString()]]))[0];
    const live = await liveRatings();
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
      else if (r.spike && await claim(`${r.zwid}:spike:${r.rating}`)) trouble.push(`• **${discordEscape(r.name)}** jumped ${r.change} points to ${r.rating}. A rise of more than ${data.season.spikeLimit} in one race that breaks the buffer is a single-race DQ.`);
    }
    if (trouble.length) { await post('admin', `🚨 **DRS vELO alert (${discordEscape(data.season.division)}, cap ${data.season.threshold + data.season.buffer})**\n${trouble.join('\n')}`); done.push('drs-velo'); }
    // 2. Stage reminders.
    for (const st of data.stages) {
      if (st.status !== 'upcoming') continue;
      const start = startOf(st, data.season), hours = (start - now) / HOUR_MS;
      if (start <= now) continue;
      const bad = rows.filter(r => worse(r.state) >= 3);
      if (hours <= 72 && (rows.length < data.season.scorers || bad.length) && await claim(`${st.id}:precheck`)) {
        await post('admin', `⚠️ **DRS stage ${st.n} (${whenLabel(start, data.season.tz)})**: ${rows.length < data.season.scorers ? `only ${rows.length} rider${rows.length === 1 ? '' : 's'} in the squad (at least ${data.season.scorers} are needed to score). ` : ''}${bad.length ? `${bad.map(r => discordEscape(r.name)).join(', ')} ${bad.length === 1 ? 'is' : 'are'} at or past the vELO limit. ` : ''}The squad must be final in the DRS portal by ${whenLabel(start - 24 * HOUR_MS, data.season.tz)}.`);
        done.push('drs-precheck');
      }
      if (hours <= 36 && hours > 24 && await claim(`${st.id}:finalise`)) {
        await post('admin', `🔒 **Finalise the DRS squad for stage ${st.n}**: it locks at ${whenLabel(start - 24 * HOUR_MS, data.season.tz)}. ${rows.length} rider${rows.length === 1 ? '' : 's'} nominated. Race Control runs its automated checks after the lock.`);
        done.push('drs-finalise');
      }
      if (hours <= 24 && await claim(`${st.id}:d1`)) { await post('public', stageMessage(st, data.season, rows, 'd1')); done.push('drs-d1'); }
      if (hours <= 2 && await claim(`${st.id}:h2`)) { await post('public', stageMessage(st, data.season, rows, 'h2')); done.push('drs-h2'); }
    }
    return done;
  }

  async function healthRow(now = Date.now()) {
    const data = await load();
    if (!data.season) return ['info', 'The DIRT Racing Series is not set up yet. Add the season in the DIRT tab when the club enters.'];
    const rows = squadRows(data, await liveRatings()), bad = rows.filter(r => worse(r.state) >= 3 && r.rating);
    const next = data.stages.filter(x => x.status === 'upcoming' && startOf(x, data.season) > now).sort((a, b) => a.n - b.n)[0];
    const tail = next ? ` Next: stage ${next.n}, ${whenLabel(startOf(next, data.season), data.season.tz)}.` : ' No stage coming up.';
    if (bad.length) return ['warn', `${data.season.division}: ${bad.map(r => `${r.name} (${r.rating})`).join(', ')} at or past the vELO limit.${tail}`];
    return ['ok', `${data.season.division}, ${rows.length} of ${data.season.squadMax} riders, all inside the vELO limit.${tail}`];
  }

  return { routes, runSchedule, load, healthRow, view, buffer, scoreStage, KEYS };
};
