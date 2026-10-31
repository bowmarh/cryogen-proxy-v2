'use strict';
// ZRL (Zwift Racing League) round management: riders sign up for a round once, saying which
// time zones they can race; staff set up the teams; the dashboard shows demand per time zone.
// Lives outside api/ on purpose: every file in api/ becomes a public serverless function.
// Everything the module needs from the server is passed in, so there is no circular require.

const xlsx = require('./xlsx');

module.exports = function createZrl(deps) {
  const csvLib = require('./csv');
  const { staffNameOf = () => '', autoLog, notify = async () => false, redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, identify, discord, discordEscape, fetchRoster, validDate, ukTime, ukLabel, teamId, fetchGrid, siteUrl, coverHonours } = deps;

  const KEYS = {
    round: 'cg:zrl:round',       // JSON: the current round and its teams
    signups: 'cg:zrl:signups',   // field "<zwid, or lowercase name>" -> sign-up JSON
    assign: 'cg:zrl:assign',     // field "<same key>" -> team id (filled in by team forming)
    archive: 'cg:zrl:archive',   // field "<round id>" -> { round, signups, assign }
    weekly: 'cg:zrl:weekly',     // "a:<week>:<zwid>" -> yes|maybe|no; "l:<week>:<team id>" -> JSON array of the Zwift IDs racing; "r:<team id>" -> time marked registered on WTRL
    results: 'cg:zrl:results',   // field "<week>:<team id>" -> JSON {pos, pts, note}: how the team finished and the points it scored
    log: 'cg:zrl:log',           // list, newest first (capped): JSON {ts, role, who, route, what} for each change made through the dashboard
    zrClub: 'cg:zrl:zrclub',     // JSON: {at, riders:{<zwift id>:{z: ZwiftPower category, v: vELO category name}}} from the ZwiftRacing.app club list, refreshed after an hour
    zrExtra: 'cg:zrl:zrextra',   // JSON: {at, riders:{<zwift id>:{z, v} or {none:true}}} for riders looked up one by one (not in the club list)
    sent: 'cg:zrl:sent',         // field "<round id>:<event>" -> ISO time, so scheduled posts fire once
  };
  const REGIONS = [
    { id: 'eu', name: 'Europe' },
    { id: 'am', name: 'Americas' },
    { id: 'ap', name: 'Asia-Pacific' },
  ];
  const REGION_IDS = REGIONS.map(r => r.id);
  const CATS = ['A', 'B', 'C', 'D', 'E'];
  const ROSTER_SIZE = 10;   // ZRL 2026/27: 10 riders on a team, 5 race each week
  const RACING = 5;
  const MAX_TEAMS = 60;

  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const isStaff = req => ['admin', 'mod'].includes(roleFromRequest(req));
  const regionName = id => (REGIONS.find(r => r.id === id) || { name: id }).name;

  // A rider can ride for several teams (different leagues and race times): their place is a list of team ids, stored comma-joined.
  const teamsOf = v => (Array.isArray(v) ? v : String(v || '').split(',').filter(Boolean));
  const inTeam = (v, id) => teamsOf(v).includes(id);
  const joinTeams = list => [...new Set(list)].join(',');
  async function load() {
    const [round, signups, assign, archiveIds, weekly] = await redis([
      ['GET', KEYS.round], ['HGETALL', KEYS.signups], ['HGETALL', KEYS.assign], ['HKEYS', KEYS.archive], ['HGETALL', KEYS.weekly],
    ]);
    return {
      weekly: parseWeekly(weekly),
      round: round ? JSON.parse(round) : null,
      signups: pairs(signups).map(([key, v]) => ({ key, ...JSON.parse(v) })).sort((a, b) => a.ts.localeCompare(b.ts)),
      assign: Object.fromEntries(pairs(assign).map(([k, v]) => [k, teamsOf(v)])),
      archive: archiveIds.sort().reverse(),
    };
  }

  const requireRound = async () => {
    const data = await load();
    if (!data.round) throw new HttpError(409, 'There is no ZRL round yet.');
    return data;
  };

  // ── Weekly: who can race each week, and the line-up the captain picks ──
  const AVAIL = ['yes', 'maybe', 'no'];
  const weekDate = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * 86400000).toISOString().slice(0, 10);
  // A rider's answer for a race week and a team. An answer given for one team wins; otherwise the answer for all their teams (the only kind
  // there used to be) applies.
  const availOf = (weekly, week, zwid, teamId) => weekly.avail[`${week}:${zwid}:${teamId}`] || weekly.avail[`${week}:${zwid}`] || '';
  function parseWeekly(raw) {
    const avail = {}, lineup = {}, reg = {};
    pairs(raw).forEach(([f, v]) => {
      const [kind, ...rest] = f.split(':');
      if (kind === 'r') reg[rest.join(':')] = v;   // r:<team id> -> ISO time the team was marked registered on WTRL
      else if (kind === 'a') avail[`${rest[0]}:${rest.slice(1).join(':')}`] = v;
      else if (kind === 'l') { try { lineup[`${rest[0]}:${rest.slice(1).join(':')}`] = JSON.parse(v); } catch (e) { /* ignore a bad row */ } }
    });
    return { avail, lineup, reg };
  }
  async function loadWeekly() {
    const [raw] = await redis([['HGETALL', KEYS.weekly]]);
    return parseWeekly(raw);
  }
  async function loadResults() {
    const [raw] = await redis([['HGETALL', KEYS.results]]);
    return Object.fromEntries(pairs(raw).map(([f, v]) => { try { return [f, JSON.parse(v)]; } catch (e) { return [f, {}]; } }));
  }
  // Validates a batch of results for one race week: [{field, value|null}], null meaning "clear this entry".
  function resultEdits(round, week, rows) {
    rows = Array.isArray(rows) ? rows : [];
    if (!rows.length) throw new HttpError(400, 'Nothing to save.');
    return rows.map(row => {
      const team = round.teams.find(t => t.id === String(row && row.team || ''));
      if (!team) throw new HttpError(404, 'One of those teams does not exist.');
      const blank = v => v === undefined || v === null || String(v).trim() === '';
      const pos = blank(row.pos) ? null : Number(row.pos), pts = blank(row.pts) ? null : Number(row.pts);
      if (pos !== null && !(Number.isInteger(pos) && pos >= 1 && pos <= 999)) throw new HttpError(400, `${team.name}: the finishing position must be a whole number from 1.`);
      if (pts !== null && !(Number.isFinite(pts) && pts >= 0 && pts <= 9999)) throw new HttpError(400, `${team.name}: the points must be a number from 0.`);
      const note = text(row.note, 'note', 80, false);
      // League points follow WTRL's rule: the first of N teams in the division gets N, one less each place down, halved when an ineligible
      // rider raced, zero for a DNQ. With the number of teams that started and the position given, they are worked out here; otherwise the typed points stand.
      const field = blank(row.field) ? null : Number(row.field);
      if (field !== null && !(Number.isInteger(field) && field >= 1 && field <= 999)) throw new HttpError(400, `${team.name}: the number of teams that started is a whole number from 1.`);
      const flag = ['ineligible', 'dnq'].includes(row.flag) ? row.flag : '';
      if (field !== null && pos !== null && pos > field) throw new HttpError(400, `${team.name}: position ${pos} is more than the ${field} teams that started.`);
      const stat = (v, what, int) => { if (blank(v)) return null; const n = Number(v); if (!(Number.isFinite(n) && n >= 0 && n <= 99999 && (!int || Number.isInteger(n)))) throw new HttpError(400, `${team.name}: ${what} is not a valid number.`); return n; };
      const extra = { score: stat(row.score, 'the rider points', false), fin: stat(row.fin, 'the FIN points', false), fal: stat(row.fal, 'the FAL points', false), fts: stat(row.fts, 'the FTS points', false), best: stat(row.best, 'the best rider position', true) };
      let league = pts;
      if (flag === 'dnq') league = 0;
      else if (field !== null && pos !== null) league = (field - pos + 1) * (flag === 'ineligible' ? 0.5 : 1);
      const kept = Object.fromEntries(Object.entries({ field, flag: flag || null, ...extra }).filter(([, v]) => v !== null));
      return { field: `${week}:${team.id}`, value: pos === null && league === null && !note && !Object.keys(kept).length ? null : { pos, pts: league, note, ...kept } };
    });
  }
  async function loadArchived(id) {
    const [raw] = await redis([['HGET', KEYS.archive, String(id || '')]]);
    if (!raw) throw new HttpError(404, 'There is no archived round with that id.');
    const a = JSON.parse(raw);
    return { ...a, signups: a.signups || [], assign: Object.fromEntries(Object.entries(a.assign || {}).map(([k, v]) => [k, teamsOf(v)])) };
  }
  // Standings: per division (or league), our teams ranked by total league points with WTRL's tie-breaks. Ties share a rank.
  function standingsOf(round, results, staff) {
    const groups = new Map();
    for (const t of round.teams) {
      const raw = Array.from({ length: round.weeks }, (_, i) => results[`${i}:${t.id}`]);
      const weeks = raw.map(r => (r && (r.pos || r.pts !== undefined && r.pts !== null) ? { pos: r.pos || null, pts: r.pts ?? null } : null));
      if (!weeks.some(Boolean)) continue;
      const total = weeks.reduce((n, w) => n + ((w && w.pts) || 0), 0), pos = weeks.filter(w => w && w.pos).map(w => w.pos);
      const sum = k => raw.reduce((n, r) => n + ((r && r[k]) || 0), 0), riders = raw.filter(r => r && r.best).map(r => r.best);
      const name = t.division || t.league || 'All teams';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ id: t.id, name: t.name, total, races: weeks.filter(Boolean).length, best: pos.length ? Math.min(...pos) : null, weeks, fin: sum('fin'), fal: sum('fal'), fts: sum('fts'), riderBest: riders.length ? Math.min(...riders) : null });
    }
    return {
      dates: Array.from({ length: round.weeks }, (_, i) => weekDate(round, i)),
      groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, teams]) => {
        // WTRL's tie-breaks: total league points, then FIN points, FAL points, FTS points, then the single best rider finish; our own best team finish after that.
        const key = t => [-t.total, -t.fin, -t.fal, -t.fts, t.riderBest ?? 999, t.best ?? 999];
        const cmp = (a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
        teams.sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
        teams.forEach((t, i) => { t.rank = i > 0 && cmp(teams[i - 1], t) === 0 ? teams[i - 1].rank : i + 1; });
        return { name, teams };
      }),
      ...(staff ? { entries: results } : {}),
    };
  }

  // ── Change log: who changed what, newest first, capped. Only a short description is kept (never a password or token). ──
  const LOG_MAX = 500;
  function describeChange(body) {
    body = body && typeof body === 'object' ? body : {};
    const parts = [];
    for (const f of ['team', 'week', 'status', 'region', 'date', 'registered', 'published', 'open', 'name', 'key', 'zwid', 'id', 'slot', 'captain', 'title', 'rideId', 'match', 'opponent', 'stage', 'division'])
      if (body[f] !== undefined && body[f] !== null && body[f] !== '' && !/pass|token|secret/i.test(f)) parts.push(`${f}=${String(body[f]).slice(0, 40)}`);
    for (const f of ['rows', 'picks', 'zwids', 'teams', 'signups']) if (Array.isArray(body[f])) parts.push(`${f}=${body[f].length}`);
    return parts.join(' ');
  }
  async function logChange(req, pathname, body, { staffOnly = false } = {}) {
    const staff = roleFromRequest(req), member = staff ? null : memberFromRequest(req);
    if (pathname === '/api/zrl/fix' && !(body && body.apply === true)) return;   // a preview changes nothing
    if (pathname === '/api/zrl/score' || pathname === '/api/zrl/score-all') return;   // a calculator: it saves nothing
    if (staffOnly && !staff) return;   // the TTT and social rides log only what staff change: riders' own sign-ups would bury it
    // Staff share one password per role, so a name they give the page ("working as") is what tells two admins apart in the log.
    let rawLabel = String((req.headers && req.headers['x-staff-name']) || ''); try { rawLabel = decodeURIComponent(rawLabel); } catch (e) { /* keep it as sent */ }
    const label = rawLabel.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
    const who = staff ? (staffNameOf(req) || label) : member ? member.name || member.zwid : 'guest';
    let what = describeChange(body);
    // Name the rider and the team(s) a change was about, not just their ids.
    if (staff && /^\/api\/zrl\/(assign|signup-edit|signup-remove|captain|team-kind|team-slot)$/.test(pathname)) {
      try {
        const { round, signups } = await load();
        const rider = signups.find(x => x.key === String(body.key || ''));
        const ids = [body.team, ...(Array.isArray(body.teams) ? body.teams : [])].filter(Boolean).map(String);
        const teams = ids.map(id => (round && round.teams.find(t => t.id === id) || {}).name).filter(Boolean);
        const extra = [rider ? `rider: ${rider.name}` : '', teams.length ? `team: ${teams.join(', ')}` : (body.team === '' ? 'team: none' : '')].filter(Boolean).join(' · ');
        if (extra) what = `${extra} · ${what}`;
      } catch (e) { /* the log line still stands without names */ }
    }
    const entry = { ts: new Date().toISOString(), role: staff || (member ? 'member' : 'guest'), who, route: pathname.replace(/^\/api\//, ''), what };
    await redis([['LPUSH', KEYS.log, JSON.stringify(entry)], ['LTRIM', KEYS.log, 0, LOG_MAX - 1]]);
  }

  // Who a request may act for: staff for anyone, a rider for themselves, a captain for their own team's riders.
  const weekOf = (round, body) => {
    const week = parseInt(body.week, 10);
    if (!(week >= 0 && week < round.weeks)) throw new HttpError(400, 'That race week does not exist in this round.');
    return week;
  };

  // ── Team list (staff) ──────────────────────────────────────
  async function riderNames() {
    try {
      const { riders } = await fetchRoster();
      return new Map(riders.map(r => [String(r.riderId), r.name]));
    } catch (e) { return new Map(); }
  }

  async function parseTeams(list, previous = []) {
    if (!Array.isArray(list)) throw new HttpError(400, 'Teams must be a list.');
    if (list.length > MAX_TEAMS) throw new HttpError(400, `At most ${MAX_TEAMS} teams.`);
    const names = await riderNames();
    const seen = new Set();
    return list.map(t => {
      const name = text(t && t.name, 'team name', 40);
      const id = teamId(name);
      if (seen.has(id)) throw new HttpError(400, `There are two teams called "${name}".`);
      seen.add(id);
      if (!REGION_IDS.includes(t.region)) throw new HttpError(400, `${name}: pick a time zone.`);
      const captain = /^\d{1,12}$/.test(String(t.captain || '')) ? String(t.captain) : '';
      if (t.captain && !captain) throw new HttpError(400, `${name}: the captain must be a Zwift ID (numbers only).`);
      const old = previous.find(p => p.id === id) || {};   // division and grade come from the sheet import; editing a team keeps them
      return {
        id, name, region: t.region, slot: text(t.slot, 'race time', 40, false), captain, captainName: captain ? names.get(captain) || ((previous.find(p => p.id === id) || {}).captain === captain ? previous.find(p => p.id === id).captainName : '') || '' : '',
        division: text(t.division === undefined ? old.division : t.division, 'division', 40, false),
        grade: text(t.grade === undefined ? old.grade : t.grade, 'grade', 40, false),
        league: text(t.league === undefined ? old.league : t.league, 'league', 40, false),
        captainLocked: captain ? false : (old.captain ? true : !!old.captainLocked),   // clearing a captain by hand stops auto-picking one
        ...(t.dev === undefined ? (old.dev ? { dev: true } : {}) : (t.dev === true ? { dev: true } : {})),
      };
    });
  }


  // ── Importing the sheet's team board ───────────────────────
  // The board has one block of columns per team: a colour or zone label, the team name, "Division n",
  // a grade, a header row ("Rider", "ID", ... "Cat"), then one rider per row. Blocks differ in width,
  // so each block runs from its "Division" cell to the next one.
  // Labels above a team block: the board's own zone names, and the leagues whose region is spelled out in the sign-up form.
  const REGION_HINTS = [[/^emea/i, 'eu'], [/^america/i, 'am'], [/^(apac|asia|oce|aus|anz)/i, 'ap'], [/^yellow\b/i, 'am'],
    // Each WTRL league is anchored to the time zone highlighted in its row of the league table (Round 1 2026/27):
    // evenings in Paris/London give Europe; 7:30 PM in Auckland/Sydney gives Asia-Pacific; 7:30 PM in New York/Chicago/Denver gives the Americas.
    [/^(red|green|lime|blue|shamrock|mint|emerald|aqua|cobalt|navy|royal)\b/i, 'eu'],
    [/^(crimson|pink)\b/i, 'ap'],
    [/^(indigo|lavender|lilac|purple|cherry)\b/i, 'am']];
  // WTRL fixes each league's race time (it never depends on the division or men/women): the league colour sets it. Each colour
  // is anchored to one city's local evening or morning (the violet cell on the league table, 2026/27), so the UTC time moves
  // with that city's daylight saving: [colour, IANA zone, local HH:MM].
  const LEAGUE_ANCHORS = [['pink', 'Australia/Sydney', '19:30'], ['crimson', 'Pacific/Auckland', '19:30'], ['ruby', 'Asia/Tokyo', '20:00'], ['teal', 'Asia/Tokyo', '05:00'],
    ['red', 'Europe/Paris', '06:00'], ['cherry', 'Europe/London', '06:00'], ['yellow', 'America/New_York', '04:30'], ['amber', 'America/New_York', '05:00'],
    ['orange', 'America/Chicago', '05:00'], ['saffron', 'America/Edmonton', '05:00'], ['topaz', 'America/Los_Angeles', '05:00'],
    ['green', 'Europe/Paris', '18:00'], ['emerald', 'Europe/Paris', '18:30'], ['lime', 'Europe/Paris', '19:00'], ['mint', 'Europe/Paris', '19:15'], ['shamrock', 'Europe/Paris', '19:30'],
    ['blue', 'Europe/London', '18:45'], ['aqua', 'Europe/London', '19:00'], ['cobalt', 'Europe/London', '19:15'], ['navy', 'Europe/London', '19:30'], ['royal', 'Europe/London', '19:45'],
    ['purple', 'America/New_York', '18:30'], ['indigo', 'America/New_York', '19:30'], ['lavender', 'America/Chicago', '19:30'], ['lilac', 'America/Edmonton', '19:45']];
  const LEAGUE_WORD = new RegExp(`\\b(${LEAGUE_ANCHORS.map(a => a[0]).join('|')})\\b`, 'i');
  const zoneOffsetMin = (zone, ms) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(new Date(ms)).map(x => [x.type, +x.value]));
    return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000) / 60000);
  };
  // 'Tue 09:30 UTC' for a league colour on the round's first race day, or '' for a label that names no known colour.
  const leagueSlot = (label, start) => {
    const m = LEAGUE_WORD.exec(String(label || ''));
    const day = Date.parse(`${start}T12:00:00Z`);
    if (!m || Number.isNaN(day)) return '';
    const [, zone, local] = LEAGUE_ANCHORS.find(a => a[0] === m[1].toLowerCase());
    const mins = (((+local.slice(0, 2) * 60 + +local.slice(3)) - zoneOffsetMin(zone, day)) % 1440 + 1440) % 1440;
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(day).getUTCDay()]} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')} UTC`;
  };
  // Under each team's riders the sheet has summary rows (averages, totals, a time-zone table); riders never reach them.
  const SUMMARY_ROW = /^(av\b|average|team total|makeup|sprinters|team overall|time zones|total)/i;
  const MAX_ROSTER_ROWS = 25;
  const normName = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();

  function parseBoard(grid, nameToId = new Map()) {
    const cell = (r, c) => String((grid[r] && grid[r][c]) || '').trim();
    const divRow = grid.findIndex(row => row.filter(v => /^division\s*\d+$/i.test(String(v || '').trim())).length >= 2);
    if (divRow < 0) throw new HttpError(422, 'That tab does not look like the team board: no "Division 1, Division 2..." row was found. Check the tab name (Google answers an unknown name with the first tab).');
    const starts = grid[divRow].map((v, c) => (/^division\s*\d+$/i.test(String(v || '').trim()) ? c : -1)).filter(c => c >= 0);
    const firstRider = /^rider$/i.test(cell(divRow + 2, starts[0])) ? divRow + 3 : divRow + 2;
    const warnings = [];
    // First the teams, each with a unique name (a repeat gets its division, then a number); then the riders.
    const blocks = [];
    const seen = new Set();
    starts.forEach((c, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : Math.max(...grid.map(r => r.length), c + 1);
      const name = cell(divRow - 1, c);
      if (!name) return warnings.push(`A team block at column ${c + 1} has no name and was skipped.`);
      if (/ghost/i.test(name)) return;
      const division = cell(divRow, c);
      let unique = name;
      for (let n = 2; seen.has(unique.toLowerCase()); n++) unique = n === 2 && division ? `${name} (${division})` : `${name} ${n}`;
      seen.add(unique.toLowerCase());
      const hint = cell(divRow - 2, c);
      blocks.push({ c, end, team: {
        name: unique, id: teamId(unique), division, grade: cell(divRow + 1, c), hint,
        region: (REGION_HINTS.find(([re]) => re.test(hint)) || [])[1] || '', riders: [],
      } });
    });
    const taken = new Map();   // rider key -> team name that kept them
    for (const { c, end, team } of blocks) {
      for (let r = firstRider; r < Math.min(grid.length, firstRider + MAX_ROSTER_ROWS); r++) {
        const rider = cell(r, c);
        if (SUMMARY_ROW.test(rider)) break;
        if (!rider || /^rider$/i.test(rider)) continue;
        let zwid = '';
        for (let k = c + 1; k <= Math.min(c + 3, end - 1) && !zwid; k++) {
          const v = cell(r, k).replace(/[\s,]/g, '');
          if (/^\d{4,9}$/.test(v)) zwid = v;
        }
        let idFrom = zwid ? 'sheet' : '';
        if (!zwid && nameToId.get(normName(rider))) { zwid = nameToId.get(normName(rider)); idFrom = 'roster'; }
        let cat = '';
        for (let k = end - 1; k > c && !cat; k--) {
          const v = cell(r, k).toUpperCase();
          if (/^(A\+|[A-E])$/.test(v)) cat = v.replace('+', '');
        }
        const key = zwid || normName(rider);
        if (taken.get(key) === team.name) continue;   // listed twice on the same team
        if (taken.has(key)) { warnings.push(`${rider} is listed on ${taken.get(key)} and ${team.name}; kept on ${taken.get(key)}.`); continue; }
        taken.set(key, team.name);
        if (!zwid) warnings.push(`${rider} (${team.name}) has no Zwift ID.`);
        team.riders.push({ name: rider, zwid, cat, idFrom, key });
      }
    }
    const teams = blocks.map(b => b.team);
    return { teams, warnings };
  }

  async function importBoard(body) {
    const tab = text(body.tab, 'tab name', 60);
    const sheetId = parseSheetLink(body);   // optional: another Google Sheet; blank means the club sheet the dashboard already reads
    const [grid, names] = await Promise.all([fetchGrid(tab, sheetId), riderNames()]);
    const byName = new Map();
    for (const [id, name] of names) { const k = normName(name); byName.set(k, byName.has(k) ? '' : id); }
    return { tab, ...parseBoard(grid, byName) };
  }
  // ── Importing sign-ups from the form responses tab ─────────
  // One row per form submission: name, ZwiftPower link, primary league, backup league, commitment, previous
  // sub-team, captain, comments. People often submit twice or mistype the link, so the latest row per rider wins
  // and a Zwift ID is looked for in the link, then as a bare number, then by name in the club roster.
  // A league label gives its region by, in order: words in the label (EMEA, Americas, Asia-Pacific), the UTC race time read as
  // a local evening (Europe/Middle East 14:00-22:00 UTC, Americas 22:00-04:00, Asia-Pacific 04:00-14:00), then its colour.
  const regionOfLeague = label => {
    const w = String(label || '').replace(/^[^A-Za-z]+/, '');
    if (!w || /^(none|primary choice only)/i.test(w)) return '';
    if (/emea|europe/i.test(w)) return 'eu';
    if (/americas?/i.test(w)) return 'am';
    if (/asia|oceania|apac|pacific/i.test(w)) return 'ap';
    const t = /(\d{1,2}):(\d{2})\s*(AM|PM)\s*UTC/i.exec(w);
    if (t) {
      const mins = ((+t[1] % 12) + (/pm/i.test(t[3]) ? 12 : 0)) * 60 + +t[2];
      if (mins >= 14 * 60 && mins < 22 * 60) return 'eu';
      if (mins >= 22 * 60 || mins < 4 * 60) return 'am';
      return 'ap';
    }
    return (REGION_HINTS.find(([re]) => re.test(w)) || [])[1] || '';
  };
  const leagueText = label => String(label || '').replace(/^[^A-Za-z]+/, '').trim();
  const stamp = v => {
    const m = /^Date\((\d+),(\d+),(\d+)(?:,(\d+),(\d+),(\d+))?/.exec(String(v || ''));
    if (m) return new Date(Date.UTC(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))).toISOString();
    const t = Date.parse(String(v || '').replace(' ', 'T'));
    return Number.isNaN(t) ? '' : new Date(t).toISOString();
  };
  const bareTeam = n => String(n || '').replace(/\s*\(.*\)\s*$/, '').toLowerCase().replace(/cryo[\s-]*gen/g, '').replace(/[^a-z0-9]/g, '');
  const distance = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  // The team a rider named, if it is clearly one of ours ("Maria Blanque" means Marie-Blanque).
  function teamNamed(text, teams) {
    const want = bareTeam(text);
    if (want.length < 3) return '';
    const exact = teams.filter(t => bareTeam(t.name) === want);
    if (exact.length) return new Set(exact.map(t => bareTeam(t.name))).size === 1 && exact.length === 1 ? exact[0].id : '';
    const near = teams.filter(t => distance(bareTeam(t.name), want) <= 2);
    return near.length === 1 ? near[0].id : '';
  }

  function parseSignups(grid, { nameToId = new Map(), idToCat = new Map(), teams = [] } = {}) {
    const find = (row, re) => row.findIndex(v => re.test(String(v || '').trim()));
    const head = grid.findIndex(row => find(row, /^full name$/i) >= 0 && find(row, /zwiftpower|profile/i) >= 0);
    if (head < 0) throw new HttpError(422, 'That tab does not look like the form responses: no "Full Name" and "ZwiftPower Profile" headings were found. Check the tab name (Google answers an unknown name with the first tab).');
    const h = grid[head];
    const col = {
      ts: find(h, /^timestamp$/i), name: find(h, /^full name$/i), link: find(h, /zwiftpower|profile/i),
      primary: find(h, /primary.*(zone|league)/i), backup: find(h, /backup|cover/i), commit: find(h, /commitment/i),
      sub: find(h, /sub-?team/i), captain: find(h, /captain/i), comments: find(h, /comments|questions/i),
    };
    const warnings = [];
    const latest = new Map();   // rider key -> parsed row
    let blank = 0;
    for (let r = head + 1; r < grid.length; r++) {
      const at = c => (c >= 0 ? String(grid[r][c] || '').trim() : '');
      const name = at(col.name).replace(/\s+/g, ' ');
      if (!name) { blank++; continue; }
      const link = at(col.link);
      let zwid = ((/(?:[?&]z=|\/riders?\/|\/profile\/)(\d{4,9})\b/.exec(link) || /^(\d{4,9})(?:\.0)?$/.exec(link) || [])[1]) || '';
      let idFrom = zwid ? 'sheet' : '';
      if (!zwid && nameToId.get(normName(name))) { zwid = nameToId.get(normName(name)); idFrom = 'roster'; }
      const primary = at(col.primary), backup = at(col.backup);
      const regions = [...new Set([regionOfLeague(primary), regionOfLeague(backup)].filter(Boolean))];
      const sub = at(col.sub);
      const comments = at(col.comments);
      const row = {
        key: zwid || normName(name), name, zwid, idFrom,
        cat: zwid ? idToCat.get(zwid) || '' : '',
        regions, league: leagueText(primary), backup: /^(none|primary choice only)/i.test(leagueText(backup)) ? '' : leagueText(backup),
        commit: /reserve|rotation/i.test(at(col.commit)) ? 'reserve' : 'full',
        captain: /^yes/i.test(at(col.captain)),
        preferred: teamNamed(sub, teams),
        prevTeam: /^(open to any|none|stay with)/i.test(sub) ? (/^stay with/i.test(sub) ? 'stay' : '') : sub,
        comments: /^(none|n\/a|no|-)$/i.test(comments) ? '' : comments.slice(0, 300),
        ts: stamp(at(col.ts)) || new Date(0).toISOString(),
      };
      const before = latest.get(row.key);
      if (before) {
        warnings.push(`${name} submitted more than once; the latest answer is used.`);
        if (before.ts > row.ts) continue;
      }
      latest.set(row.key, row);
      if (!zwid && !before) warnings.push(`${name} has no usable Zwift ID (link: "${link.slice(0, 40)}").`);
      if (!regions.length) warnings.push(`${name}: no time zone could be read from "${primary.slice(0, 40)}".`);
    }
    return { rows: [...latest.values()].sort((a, b) => a.ts.localeCompare(b.ts)), warnings, blank };
  }

  const parseSheetLink = body => {
    const link = String(body.sheet || '').trim();
    if (!link) return undefined;
    const m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(link) || /^([A-Za-z0-9_-]{20,})$/.exec(link);
    if (!m) throw new HttpError(400, 'That does not look like a Google Sheets link. Paste the address from the browser bar (it contains /d/ and a long ID).');
    return m[1];
  };

  async function importSignupRows(body, round) {
    const tab = text(body.tab, 'tab name', 60);
    const [grid, roster] = await Promise.all([fetchGrid(tab, parseSheetLink(body)), fetchRoster().catch(() => ({ riders: [] }))]);
    const nameToId = new Map(), idToCat = new Map();
    for (const r of roster.riders || []) {
      const id = String(r.riderId), k = normName(r.name), cat = String(r.zpCategory || '').replace('+', '');
      nameToId.set(k, nameToId.has(k) ? '' : id);
      if (CATS.includes(cat)) idToCat.set(id, cat);
    }
    return { tab, ...parseSignups(grid, { nameToId, idToCat, teams: round.teams }) };
  }

  // ── Auto-assign: suggest a team for every rider who has none ───────────────
  // A rider may ride a team of their own category or a weaker one (an A rider cannot drop into a B team).
  // Riders go in this order: full-season before reserves, those who named a team first, then first come.
  // Each goes to the eligible team (right time zone, category, a free place) that is nearest to full, so teams complete
  // instead of every team being left half-filled; a close category match breaks ties.
  const teamCat = t => { const m = /\b([A-E])\+?\s*$/i.exec(String(t.grade || '')); return m ? m[1].toUpperCase() : ''; };
  const catGap = (rider, team) => (rider && team ? CATS.indexOf(rider) - CATS.indexOf(team) : 0);   // >= 0 means the rider may ride it

  // A team holds at most one roster of racing riders. Throws when adding `key` would take it past that.
  function requireRoom(round, signups, assign, teamId, key) {
    const team = round.teams.find(t => t.id === teamId), size = round.rosterSize || ROSTER_SIZE;
    if (!team || inTeam(assign[key], teamId)) return;
    const racing = signups.filter(x => x.in && x.key !== key && inTeam(assign[x.key], teamId)).length;
    if (racing >= size) throw new HttpError(409, `${team.name} is full (${racing}/${size}). Move a rider off it first.`);
  }

  function planAssignments({ teams, signups, assign, rosterSize = ROSTER_SIZE }) {
    const members = Object.fromEntries(teams.map(t => [t.id, 0]));
    for (const ids of Object.values(assign)) for (const id of teamsOf(ids)) if (id in members) members[id]++;
    const placed = new Map(), moves = [], unplaced = [];
    const captains = {};   // team id -> rider proposed as captain
    const pool = signups.filter(x => x.in && !assign[x.key]).sort((a, b) =>
      (a.commit === 'reserve') - (b.commit === 'reserve') || (!!b.preferred) - (!!a.preferred) || String(a.ts).localeCompare(String(b.ts)));
    for (const rider of pool) {
      const fits = t => members[t.id] < rosterSize && (!rider.cat || !teamCat(t) || catGap(rider.cat, teamCat(t)) >= 0);
      const open = teams.filter(t => members[t.id] < rosterSize);
      let team = rider.preferred && teams.find(t => t.id === rider.preferred && fits(t));
      let why = team ? 'the team they asked for' : '';
      if (!team) {
        const inZone = teams.filter(t => rider.regions.includes(t.region) && fits(t));
        inZone.sort((a, b) => members[b.id] - members[a.id]
          || Math.abs(catGap(rider.cat, teamCat(a))) - Math.abs(catGap(rider.cat, teamCat(b))));
        team = inZone[0];
        why = team ? 'fills a team in their time zone' : '';
      }
      if (!team) {
        const anyZone = rider.regions.some(r => open.some(t => t.region === r));
        unplaced.push({ key: rider.key, name: rider.name, cat: rider.cat, regions: rider.regions, reason: !rider.regions.length ? 'no time zone given'
          : !anyZone ? 'every team in their time zone is full or there is none' : `no free place in their time zone for category ${rider.cat || '?'}` });
        continue;
      }
      members[team.id]++;
      placed.set(rider.key, team.id);
      moves.push({ key: rider.key, name: rider.name, cat: rider.cat, team: team.id, teamName: team.name, why, captain: false, _rider: rider });
    }
    // A volunteer (the star, with a Zwift ID) becomes captain of a team that has none: the earliest sign-up, wherever the plan placed them.
    for (const t of teams) {
      if (t.captain || t.captainLocked || captains[t.id]) continue;
      const first = moves.filter(m => m.team === t.id && m._rider.captain && m._rider.zwid).sort((a, b) => String(a._rider.ts).localeCompare(String(b._rider.ts)))[0];
      if (first) { captains[t.id] = { zwid: first._rider.zwid, name: first._rider.name }; first.captain = true; }
    }
    for (const m of moves) delete m._rider;
    const teamsAfter = teams.map(t => ({ id: t.id, name: t.name, region: t.region, grade: t.grade, cat: teamCat(t), division: t.division,
      before: members[t.id] - moves.filter(m => m.team === t.id).length, after: members[t.id], captain: t.captain || (captains[t.id] ? captains[t.id].zwid : '') }));
    return { moves, unplaced, teams: teamsAfter, captains };
  }

  // ── Registration list for WTRL ─────────────────────────────
  // WTRL has no public registration API, so captains register their team there by hand. This builds what they need to
  // paste: per team a readable block and a plain list of Zwift IDs, plus one CSV for everything.
  const ordinal = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th')}`;
  const csvCell = v => {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;   // a name must never run as a spreadsheet formula
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };

  function buildExport({ round, signups, assign }) {
    const bySignup = new Map(signups.map(x => [x.key, x]));
    const teams = round.teams.map(t => {
      const riders = signups.filter(x => x.in && inTeam(assign[x.key], t.id))
        .map(x => ({ key: x.key, name: x.name, zwid: x.zwid || '', cat: x.cat || '', commit: x.commit || 'full', isCaptain: !!t.captain && x.zwid === t.captain }))
        .sort((a, b) => (b.isCaptain - a.isCaptain) || ((a.commit === 'reserve') - (b.commit === 'reserve')) || a.name.localeCompare(b.name));
      const issues = [];
      if (!t.captain) issues.push('no captain yet');
      if (riders.length !== round.rosterSize) issues.push(`${riders.length} rider${riders.length === 1 ? '' : 's'}, ${round.rosterSize} expected`);
      const noId = riders.filter(r => !r.zwid).length;
      if (noId) issues.push(`${noId} without a Zwift ID`);
      const noCat = riders.filter(r => !r.cat).length;
      if (noCat) issues.push(`${noCat} without a category`);
      const head = `${t.name}${[t.division, t.grade].filter(Boolean).length ? ` — ${[t.division, t.grade].filter(Boolean).join(' · ')}` : ''} — ${regionName(t.region)}${t.slot ? ` — ${t.slot}` : ''}`;
      const text = [head, t.captain ? `Captain: ${t.captainName || (bySignup.get(t.captain) || {}).name || ''} (${t.captain})`.replace('  ', ' ') : 'Captain: not chosen yet',
        ...riders.map((r, i) => `${i + 1}. ${r.name} — ${r.zwid || 'no Zwift ID'}${r.cat ? ` — ${r.cat}` : ''}${r.commit === 'reserve' ? ' (reserve)' : ''}`)].join('\n');
      return { id: t.id, name: t.name, division: t.division || '', grade: t.grade || '', region: t.region, regionName: regionName(t.region), slot: t.slot || '',
        captain: t.captain || '', captainName: t.captainName || '', riders, issues, text, ids: riders.filter(r => r.zwid).map(r => r.zwid).join('\n') };
    });
    const rows = [['Team', 'Division', 'Grade', 'Time zone', 'Race time', 'Rider', 'Zwift ID', 'Category', 'Captain', 'Commitment']];
    for (const t of teams) for (const r of t.riders) rows.push([t.name, t.division, t.grade, t.regionName, t.slot, r.name, r.zwid, r.cat, r.isCaptain ? 'yes' : '', r.commit === 'reserve' ? 'reserve' : 'full season']);
    const unassigned = signups.filter(x => x.in && !assign[x.key]).map(x => ({ name: x.name, zwid: x.zwid || '', cat: x.cat || '' }));
    return { round: round.name, teams, unassigned, csv: rows.map(r => r.map(csvCell).join(',')).join('\n'),
      allText: teams.map(t => t.text).join('\n\n') };
  }

  // ── What one signed-in rider sees: their sign-up, their team, and (for a captain) the team to register ──
  // A rider sees their team once the staff publish; a captain sees the team they captain straight away, with Zwift IDs
  // and the registration block, because they have to register it on WTRL. Nobody sees comments.
  function myZrl({ round, signups, assign }, member, weekly = { avail: {}, lineup: {} }, results = {}) {
    const own = signups.find(x => x.key === member.zwid);
    const full = buildExport({ round, signups, assign });
    const shape = (t, forCaptain) => ({
      id: t.id, name: t.name, division: t.division, grade: t.grade, region: t.region, regionName: t.regionName, slot: t.slot,
      captainName: t.captainName || ((t.riders.find(r => r.isCaptain) || {}).name) || '', published: !!round.published,
      riders: t.riders.map(r => ({ name: r.name, cat: r.cat, reserve: r.commit === 'reserve', isCaptain: r.isCaptain, ...(forCaptain ? { zwid: r.zwid } : {}) })),
      ...(forCaptain ? { text: t.text, ids: t.ids, issues: t.issues } : {}),
    });
    const weeks = t => Array.from({ length: round.weeks }, (_, i) => ({ i, date: weekDate(round, i), lineup: weekly.lineup[`${i}:${t.id}`] || [] }));
    const captainOf = full.teams.filter(t => t.captain === member.zwid).map(t => ({
      ...shape(t, true), registered: !!weekly.reg[t.id],
      weeks: weeks(t).map(w => ({ ...w, riders: t.riders.filter(r => r.zwid).map(r => ({ zwid: r.zwid, name: r.name, status: availOf(weekly, w.i, r.zwid, t.id) })) })),
    }));
    const teamIds = own ? teamsOf(assign[own.key]) : [];
    const mine = round.published ? full.teams.filter(t => teamIds.includes(t.id)) : [];
    const team = mine[0] || null;
    const weeksOf = tm => weeks(tm).map(w => ({ i: w.i, date: w.date, mine: availOf(weekly, w.i, member.zwid, tm.id), team: tm.id, picked: w.lineup.includes(member.zwid),
      lineupSet: w.lineup.length > 0, lineup: w.lineup.map(z => (tm.riders.find(r => r.zwid === z) || {}).name).filter(Boolean),
      result: (() => { const r = results[`${w.i}:${tm.id}`]; return r && (r.pos || r.pts !== undefined && r.pts !== null) ? { pos: r.pos || null, pts: r.pts ?? null } : null; })() }));
    return {
      round: { name: round.name, start: round.start, weeks: round.weeks, racing: round.racing, rosterSize: round.rosterSize, published: !!round.published, open: !!round.open, wtrlDeadline: round.wtrlDeadline || null },
      signup: own ? { in: own.in, regions: own.regions, cat: own.cat, commit: own.commit || 'full', preferred: own.preferred || '', also: own.also || [] } : null,
      placed: teamIds.length > 0,
      team: team ? shape(team, false) : null,   // the first team; `teams` lists every team they ride for
      teams: mine.map(tm => ({ ...shape(tm, false), weeks: weeksOf(tm) })),
      // Published teams only: this rider's own answer for each week, and whether the captain has picked them.
      weeks: team ? weeksOf(team) : [],
      captainOf,
    };
  }

  // ── Demand: how many riders want each time zone, against the places on teams ──
  function demandOf(round, signups) {
    const ins = signups.filter(s => s.in);
    const regions = REGIONS.map(r => {
      const riders = ins.filter(s => s.regions.includes(r.id)).length;
      const teams = round.teams.filter(t => t.region === r.id).length;
      return { id: r.id, name: r.name, riders, teams, places: teams * round.rosterSize };
    });
    const cats = Object.fromEntries(CATS.map(c => [c, ins.filter(s => s.cat === c).length]));
    return { riders: ins.length, regions, cats, captains: ins.filter(s => s.captain).length };
  }

  // ── The page's view of everything ──────────────────────────
  function view(data, req) {
    const staff = isStaff(req);
    const { round } = data;
    if (!round) return { round: null, signups: [], demand: null, archive: data.archive, role: roleFromRequest(req) || null };
    return {
      round: { ...round, regions: REGIONS, teams: round.teams.map(t => ({ ...t, wtrlSlot: leagueSlot(t.league, round.start), wtrlRegistered: !!(data.weekly && data.weekly.reg[t.id]) })) },
      signups: data.signups.map(s => (staff
        ? { name: s.name, zwid: s.zwid, in: s.in, cat: s.cat, regions: s.regions, preferred: s.preferred, also: s.also || [], captain: s.captain, comments: s.comments, ts: s.ts, key: s.key, league: s.league, backup: s.backup, commit: s.commit, prevTeam: s.prevTeam, source: s.source, devOk: s.devOk === true }
        : { name: s.name, in: s.in, cat: s.cat, regions: s.regions, captain: s.captain, key: s.key })),
      demand: demandOf(round, data.signups),
      assign: staff ? Object.fromEntries(Object.entries(data.assign).map(([k, v]) => [k, v[0]])) : undefined,   // the first team, as before
      placements: staff ? data.assign : undefined,   // every team a rider rides for: key -> [team ids]
      weekly: staff && data.weekly ? { avail: data.weekly.avail, lineup: data.weekly.lineup } : undefined,   // staff edit line-ups and answers
      archive: data.archive,
      role: roleFromRequest(req) || null,
    };
  }

  // ── Discord ────────────────────────────────────────────────
  const demandLines = demand => demand.regions
    .filter(r => r.riders || r.teams)
    .map(r => `• **${discordEscape(r.name)}**: ${r.riders} rider${r.riders === 1 ? '' : 's'}${r.teams ? `, ${r.teams} team${r.teams === 1 ? '' : 's'} (${r.places} places)` : ''}`)
    .join('\n');

  const postOpen = round => discord('zrl-public', {
    content: `🏁 **ZRL ${discordEscape(round.name)}: sign-ups are open!**\nIt takes a minute: sign in at ${siteUrl} → 🚀 ZRL, tick the time zones you can race, done.${round.closesAt ? `\nSign-ups close **${ukLabel(Date.parse(round.closesAt))}**.` : ''}\nHelp us fill every team, and let's grow our Asia-Pacific races too. 🌏`,
  });

  const postReminder = (round, signups) => {
    const demand = demandOf(round, signups);
    return discord('zrl-public', {
      content: `⏰ **ZRL ${discordEscape(round.name)}: sign-ups close in 24 hours.** ${demand.riders} rider${demand.riders === 1 ? ' is' : 's are'} in so far.\n${demandLines(demand)}\nSign up at ${siteUrl} → 🚀 ZRL.`,
    });
  };

  const raceLabel = (round, i) => new Date(`${weekDate(round, i)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const postAvailability = (round, i) => discord('zrl-public', {
    content: `🚴 **ZRL ${discordEscape(round.name)}: race ${i + 1} is on ${raceLabel(round, i)}.**\nCan you race? Tell your captain: sign in at ${siteUrl} → 🚀 ZRL → **Your team** and tap Yes, Maybe or No. Captains pick their five from the answers.`,
  });
  // Race-day summary for the ZRL admin channel: how many teams race, which have no full line-up, no race time or no WTRL registration (when a
  // deadline is set), and how many riders have not said whether they can race.
  async function postDigest(round, i, data, playing) {
    const weekly = await loadWeekly();
    const names = list => `${list.slice(0, 12).map(t => discordEscape(t.name.replace(/^CRYO-GEN\s+/, ''))).join(', ')}${list.length > 12 ? ` and ${list.length - 12} more` : ''}`;
    const short = playing.filter(t => (weekly.lineup[`${i}:${t.id}`] || []).length < round.racing);
    const noTime = playing.filter(t => !t.slot);
    const unregistered = round.wtrlDeadline ? playing.filter(t => !weekly.reg[t.id]) : [];
    const riders = data.signups.filter(x => x.in && x.zwid && playing.some(t => inTeam(data.assign[x.key], t.id)));
    const silent = riders.filter(x => playing.some(t => inTeam(data.assign[x.key], t.id) && !availOf(weekly, i, x.zwid, t.id))).length;   // a rider with two teams is silent if either is unanswered
    const lines = [`📅 **ZRL ${discordEscape(round.name)}: race ${i + 1} is today (${raceLabel(round, i)})**`, `• ${playing.length} team${playing.length === 1 ? '' : 's'} racing`,
      short.length ? `• ⚠️ No full line-up of ${round.racing}: ${names(short)}` : `• ✅ Every team has a full line-up of ${round.racing}`];
    if (noTime.length) lines.push(`• ⚠️ No race time set: ${names(noTime)}`);
    if (unregistered.length) lines.push(`• ⚠️ Not marked as registered on WTRL: ${names(unregistered)}`);
    if (silent) lines.push(`• ${silent} of ${riders.length} riders have not said if they can race`);
    lines.push(`Captains and staff: ${siteUrl} → 🚀 ZRL.`);
    await discord('zrl-admin', { content: lines.join('\n') });
  }
  const postLineupNudge = (round, i, teams) => discord('zrl-admin', {
    content: `📋 **ZRL race ${i + 1} (${raceLabel(round, i)}): ${teams.length} team${teams.length === 1 ? ' has' : 's have'} not picked a full line-up of ${round.racing}.**\n${teams.slice(0, 15).map(t => `• ${discordEscape(t.name)}${t.captainName ? ` (captain ${discordEscape(t.captainName)})` : ''}`).join('\n')}${teams.length > 15 ? `\n…and ${teams.length - 15} more` : ''}\nCaptains: ${siteUrl} → 🚀 ZRL → **You captain this team** → Save line-up.`,
  });

  const postWtrlNudge = (round, teams) => discord('zrl-admin', {
    content: `📝 **ZRL ${discordEscape(round.name)}: the WTRL registration deadline is ${ukLabel(Date.parse(round.wtrlDeadline))}. ${teams.length} team${teams.length === 1 ? ' is' : 's are'} not marked as registered.**\n${teams.slice(0, 15).map(t => `• ${discordEscape(t.name)}${t.captainName ? ` (captain ${discordEscape(t.captainName)})` : ' (no captain)'}`).join('\n')}${teams.length > 15 ? `\n…and ${teams.length - 15} more` : ''}\nCaptains register at wtrl.racing/zrl, then tick **Registered on WTRL** under ${siteUrl} → 🚀 ZRL → **You captain this team**.`,
  });
  const postClosed = (round, signups) => {
    const demand = demandOf(round, signups);
    return Promise.all([
      discord('zrl-public', { content: `🔒 **ZRL ${discordEscape(round.name)}: sign-ups are closed.** ${demand.riders} riders are in. Teams will be announced soon.` }),
      discord('zrl-admin', { content: `🛠️ **ZRL ${discordEscape(round.name)}**: sign-ups closed with ${demand.riders} rider${demand.riders === 1 ? '' : 's'}, ${demand.captains} happy to captain.\n${demandLines(demand)}\nForm the teams in the dashboard → 🚀 ZRL.` }),
    ]);
  };

  // Tells the club the rosters are out. Names stay off Discord: riders read their team on the site, where only they and their
  // captain see it. The admin channel gets a to-do list of what is still missing.
  const postPublished = async (round, signups, assign) => {
    const x = buildExport({ round, signups, assign });
    const placed = x.teams.reduce((n, t) => n + t.riders.length, 0);
    const zones = REGIONS.map(r => ({ name: r.name, teams: x.teams.filter(t => t.region === r.id) })).filter(z => z.teams.length)
      .map(z => `• **${discordEscape(z.name)}**: ${z.teams.length} team${z.teams.length === 1 ? '' : 's'}, ${z.teams.reduce((n, t) => n + t.riders.length, 0)} riders`).join('\n');
    const todo = [];
    const noCaptain = x.teams.filter(t => t.riders.length && !t.captain);
    if (noCaptain.length) todo.push(`${noCaptain.length} team${noCaptain.length === 1 ? ' has' : 's have'} no captain: ${noCaptain.slice(0, 8).map(t => discordEscape(t.name)).join(', ')}${noCaptain.length > 8 ? '…' : ''}`);
    const short = x.teams.filter(t => t.riders.length && t.riders.length < round.rosterSize);
    if (short.length) todo.push(`${short.length} team${short.length === 1 ? ' has' : 's have'} fewer than ${round.rosterSize} riders`);
    const noId = x.teams.reduce((n, t) => n + t.riders.filter(r => !r.zwid).length, 0);
    if (noId) todo.push(`${noId} rider${noId === 1 ? ' has' : 's have'} no Zwift ID`);
    if (x.unassigned.length) todo.push(`${x.unassigned.length} rider${x.unassigned.length === 1 ? ' is' : 's are'} still without a team`);
    return Promise.all([
      discord('zrl-public', {
        content: `📣 **ZRL ${discordEscape(round.name)}: the rosters are out!**\n${placed} riders are on ${x.teams.filter(t => t.riders.length).length} teams.\n${zones}\nSign in at ${siteUrl} → your profile (**My ZRL**) or 🚀 ZRL to see your team, race time and captain.\nCaptains: register your team on WTRL (wtrl.racing/zrl). Your team's details are under 🚀 ZRL → "You captain this team", ready to copy.`,
      }),
      discord('zrl-admin', {
        content: `🛠️ **ZRL ${discordEscape(round.name)}**: rosters published.${todo.length ? `\nStill to sort out:\n${todo.map(t => `• ${t}`).join('\n')}` : '\nNothing outstanding: every team has a captain and a full roster.'}`,
      }),
    ]);
  };

  // The automatic steps are on unless staff switch them off in Setup (round.autoFix = { place, lineups }).
  const autoOn = (round, what) => !round.autoFix || round.autoFix[what] !== false;
  // When sign-ups close: place everyone, give teams their volunteer captain and the league race time, then tell the staff what is left.
  async function autoPlace(round, now) {
    const r = await autoFix({ apply: true, only: ['placed', 'captains', 'times'], fallbackCaptain: false }, now);
    if (!r.total && !r.left.length) return;
    await discord('zrl-admin', { content: `🤖 **ZRL ${discordEscape(round.name)}: sign-ups closed, teams suggested automatically.**\n${r.steps.map(s => `• ${discordEscape(s.title)}: ${s.count}`).join('\n') || '• nothing to place'}${r.left.length ? `\n⚠️ Needs a person (${r.left.length}):\n${r.left.slice(0, 8).map(l => `• ${discordEscape(l.title)}: ${discordEscape(l.detail)}`).join('\n')}${r.left.length > 8 ? '\n…and more' : ''}` : ''}\nCheck it in ${siteUrl} → 🚀 ZRL, then publish the rosters.` });
  }

  // Closes sign-ups at their close time and posts the reminder; each event fires once.
  async function runSchedule(now = Date.now()) {
    const data = await load();
    const round = data.round;
    if (!round) return [];
    const done = [];
    const claim = async key => (await redis([['HSETNX', KEYS.sent, key, new Date(now).toISOString()]]))[0];
    if (round.open && round.closesAt) {
      const closes = Date.parse(round.closesAt);
      const due = [];
      if (now >= closes - 24 * 3600 * 1000 && now < closes) due.push('reminder');
      if (now >= closes) due.push('close');
      for (const event of due) {
        if (!await claim(`${round.id}:${event}`)) continue;
        if (event === 'reminder') await postReminder(round, data.signups);
        if (event === 'close') {
          await redis([['SET', KEYS.round, JSON.stringify({ ...round, open: false })]]);
          await postClosed(round, data.signups);
          if (autoOn(round, 'place')) await autoPlace(round, now).catch(e => console.error('ZRL auto-place:', e.message));
        }
        done.push(`zrl-${event}`);
      }
    }
    // WTRL deadline in three days: the admin channel lists the teams not yet marked registered (once).
    if (round.published && round.wtrlDeadline) {
      const deadline = Date.parse(round.wtrlDeadline);
      if (now >= deadline - 3 * 86400000 && now < deadline) {
        const open = round.teams.filter(t => data.signups.some(x => x.in && inTeam(data.assign[x.key], t.id)) && !data.weekly.reg[t.id]);
        if (open.length && await claim(`${round.id}:wtrl3`)) {
          await postWtrlNudge(round, open);
          done.push('zrl-wtrl');
        }
      }
    }
    // Race weeks (once the rosters are out): five days before, ask the riders whether they can race; two days before, tell the
    // captains' channel which teams have not picked a full line-up. Each fires once per week, and only until that race day starts.
    if (round.published) {
      const playing = round.teams.filter(t => data.signups.some(x => x.in && inTeam(data.assign[x.key], t.id)));
      for (let i = 0; i < round.weeks; i++) {
        const race = Date.parse(`${weekDate(round, i)}T00:00:00Z`);
        // Race day (UTC): one summary for the staff, whatever state the week is in. It is the last look before the racing starts.
        if (now >= race && now < race + 24 * 3600000 && await claim(`${round.id}:w${i}:digest`)) {
          await postDigest(round, i, data, playing);
          done.push(`zrl-digest-${i + 1}`);
        }
        if (now >= race) continue;
        if (now >= race - 5 * 86400000 && await claim(`${round.id}:w${i}:avail`)) {
          await postAvailability(round, i);
          done.push(`zrl-avail-${i + 1}`);
        }
        if (now >= race - 2 * 86400000 && autoOn(round, 'lineups') && await claim(`${round.id}:w${i}:autolineup`)) {
          const r = await autoFix({ apply: true, only: ['lineups'], horizonDays: 2, fallbackCaptain: false }, now).catch(e => { console.error('ZRL auto line-ups:', e.message); return null; });
          if (r && r.total) { await discord('zrl-admin', { content: `🤖 **ZRL ${discordEscape(round.name)}, race ${i + 1}**: line-ups filled in from the riders' answers for ${r.steps[0].count} team${r.steps[0].count === 1 ? '' : 's'}. Captains can still change them.${r.left.length ? `\nStill short: ${r.left.slice(0, 8).map(l => `${discordEscape(l.title)} (${discordEscape(l.detail)})`).join('; ')}` : ''}` }); done.push(`zrl-autolineup-${i + 1}`); }
        }
        if (now >= race - 2 * 86400000) {
          const weekly = await loadWeekly();
          const short = playing.filter(t => (weekly.lineup[`${i}:${t.id}`] || []).length < round.racing);
          // Everyone sorted: nothing to say, and the claim stays free in case a line-up is cleared before the race.
          if (short.length && await claim(`${round.id}:w${i}:lineup`)) {
            await postLineupNudge(round, i, short);
            // The captains hear it directly too (once per team and race), if the club has automatic messages on.
            for (const t of short) if (t.captain) await notify(t.captain, `Hi, your team ${t.name} has not picked a full line-up of ${round.racing} for ZRL ${round.name} race ${i + 1} (${raceLabel(round, i)}). Open the dashboard, go to ZRL and tap "You captain this team" to save it.`, { key: `zrl-lineup:${round.id}:${i}:${t.id}` }).catch(() => false);
            done.push(`zrl-lineup-${i + 1}`);
          }
        }
      }
      // The last race is over (and results are in): tell the staff to post the recognition and roll the round over, once.
      const last = Date.parse(`${weekDate(round, round.weeks - 1)}T00:00:00Z`);
      if (now >= last + 36 * 3600000 && Object.keys(await loadResults()).length && await claim(`${round.id}:finished`)) {
        await discord('zrl-admin', { content: `🎉 **ZRL ${discordEscape(round.name)}: the last race is done.**\nPost the round recognition (🚀 ZRL → Results → 🏅 Round recognition), then archive the round and start the next in Setup.` });
        done.push('zrl-finished');
      }
    }
    return done;
  }

  // ── End-of-round recognition: who showed up, who stood on the podium, which teams led their division, who covered the rides ──
  async function recognition(now = Date.now()) {
    const { round, signups, assign } = await requireRound();
    const weekly = await loadWeekly(), results = await loadResults();
    const today = new Date(now).toISOString().slice(0, 10);
    const past = Array.from({ length: round.weeks }, (_, i) => i).filter(i => weekDate(round, i) <= today);
    if (!past.length) throw new HttpError(409, 'No races have been run yet, so there is nothing to recognise.');
    const names = new Map(signups.filter(x => x.zwid).map(x => [x.zwid, x.name]));
    const placed = signups.filter(x => x.in && x.zwid && round.teams.some(t => inTeam(assign[x.key], t.id)));
    const stat = new Map();
    const of = z => { if (!stat.has(z)) stat.set(z, { name: names.get(z) || '', picked: 0, podiums: 0, answered: 0 }); return stat.get(z); };
    for (const i of past) {
      for (const t of round.teams) {
        const r = results[`${i}:${t.id}`];
        for (const z of weekly.lineup[`${i}:${t.id}`] || []) { const s = of(z); s.picked++; if (r && r.pos && r.pos <= 3) s.podiums++; }
      }
      for (const x of placed) if (round.teams.filter(t => inTeam(assign[x.key], t.id)).every(t => availOf(weekly, i, x.zwid, t.id))) of(x.zwid).answered++;
    }
    const people = [...stat.values()].filter(s => s.name);
    const list = a => `${a.slice(0, 12).map(n => discordEscape(n)).join(', ')}${a.length > 12 ? ` and ${a.length - 12} more` : ''}`;
    const sections = [];
    const leaders = standingsOf(round, results, false).groups.map(g => ({ division: g.name, team: g.teams.filter(t => t.rank === 1) })).filter(g => g.team.length && g.team[0].total > 0);
    if (leaders.length) sections.push(`🏆 **Top of the table**\n${leaders.slice(0, 10).map(g => `• ${discordEscape(g.division)}: ${g.team.map(t => `${discordEscape(t.name.replace(/^CRYO-GEN\s+/, ''))} (${t.total} pts)`).join(' / ')}`).join('\n')}`);
    if (past.length >= 2) {
      const ever = people.filter(s => s.picked === past.length).map(s => s.name).sort((a, b) => a.localeCompare(b));
      if (ever.length) sections.push(`🏁 **Raced every race (${past.length} of ${past.length})**\n${list(ever)}`);
    }
    const pod = people.filter(s => s.podiums > 0).sort((a, b) => b.podiums - a.podiums || a.name.localeCompare(b.name));
    if (pod.length) sections.push(`🥇 **On the podium with their team**\n${pod.slice(0, 5).map(s => `• ${discordEscape(s.name)}: ${s.podiums} podium${s.podiums === 1 ? '' : 's'}`).join('\n')}`);
    if (past.length >= 2) {
      const always = people.filter(s => s.answered === past.length).map(s => s.name).sort((a, b) => a.localeCompare(b));
      if (always.length) sections.push(`✅ **Always told their captain if they could race**\n${list(always)}`);
    }
    const honours = coverHonours ? await coverHonours(round.start, now).catch(() => []) : [];
    if (honours.length) sections.push(`🧭 **Ride-cover stars (leading and sweeping the social rides)**\n${honours.slice(0, 5).map(h => `• ${discordEscape(h.name)}: ${h.count} ride${h.count === 1 ? '' : 's'}`).join('\n')}`);
    if (!sections.length) throw new HttpError(409, 'There is nothing to recognise yet: enter the line-ups and results first.');
    const messages = [];
    let cur = `🎉 **ZRL ${discordEscape(round.name)}: round recognition after ${past.length} race${past.length === 1 ? '' : 's'}**\nThank you to everyone who raced, captained and kept the teams full.`;
    for (const sec of sections) { if (cur.length + sec.length + 2 > 1800) { messages.push(cur); cur = ''; } cur += `${cur ? '\n\n' : ''}${sec}`; }
    messages.push(`${cur}\n\nFull standings: ${siteUrl} → 🚀 ZRL`);
    return { round: round.name, races: past.length, messages };
  }

  // ZRL 2026/27 points for one team in one points race. Per rider: FIN (starters - position + 1) + podium bonus for the top 5 (10, 8, 6, 4, 2)
  // + segment points entered by hand (FAL and FTS). Then the penalties: missing heart rate is zero for an A rider and half for B/C/D, ZPower is half.
  // The team total is the sum over the riders given.
  const PODIUM = [10, 8, 6, 4, 2];
  function scoreRace(body) {
    const num = (v, what, max) => {
      if (v === undefined || v === null || String(v).trim() === '') return 0;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new HttpError(400, `${what} must be a number from 0 to ${max}.`);
      return n;
    };
    const starters = num(body && body.starters, 'Starters', 999);
    if (!starters) throw new HttpError(400, 'Enter how many riders started the race.');
    const rows = Array.isArray(body.riders) ? body.riders.slice(0, 20) : [];
    if (!rows.length) throw new HttpError(400, 'Add at least one rider.');
    const riders = rows.map(r => {
      const name = String(r && r.name || 'Rider').slice(0, 60), pos = num(r.pos, `${name}: position`, 999);
      if (pos > starters) throw new HttpError(400, `${name}: position ${pos} is more than the ${starters} starters.`);
      const fin = pos ? starters - pos + 1 : 0, pbp = pos && pos <= PODIUM.length ? PODIUM[pos - 1] : 0;
      const segments = num(r.fal, `${name}: FAL points`, 9999) + num(r.fts, `${name}: FTS points`, 9999);
      const raw = fin + pbp + segments;
      const cat = String(r.cat || '').toUpperCase().slice(0, 1);
      const noHr = !!r.noHr, zpower = !!r.zpower;
      let factor = 1; const notes = [];
      if (noHr) { if (cat === 'A') { factor = 0; notes.push('no heart rate: zero (A)'); } else { factor *= 0.5; notes.push('no heart rate: 50%'); } }
      if (zpower) { factor *= 0.5; notes.push('ZPower: 50%'); }
      const fal = num(r.fal, `${name}: FAL points`, 9999), fts = num(r.fts, `${name}: FTS points`, 9999);
      return { name, pos: pos || null, fin, pbp, fal, fts, segments, raw, factor, points: Math.round(raw * factor * 100) / 100, notes };
    });
    const sumOf = k => Math.round(riders.reduce((n, r) => n + r[k] * r.factor, 0) * 100) / 100;
    const placed = riders.filter(r => r.pos).map(r => r.pos);
    return { starters, riders, total: Math.round(riders.reduce((n, r) => n + r.points, 0) * 100) / 100,
      totals: { fin: sumOf('fin'), fal: sumOf('fal'), fts: sumOf('fts') }, bestRider: placed.length ? Math.min(...placed) : null };
  }

  // A team time trial has no individual points. The team's time is taken when the fourth rider finishes; fewer than four finishers is a DNQ
  // (no league points). Riders on ZPower may be at most 40% of the squad. Times are seconds or m:ss(.s) / h:mm:ss.
  function parseClock(v, what) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const parts = String(v).trim().split(':');
    if (parts.length > 3 || parts.some(x => !/^\d+(\.\d+)?$/.test(x))) throw new HttpError(400, `${what}: the time looks like 31:12.4 or 1872.4 seconds.`);
    const secs = parts.reduce((n, x) => n * 60 + Number(x), 0);
    if (!(secs > 0) || secs > 86400) throw new HttpError(400, `${what}: that time does not look right.`);
    return Math.round(secs * 1000) / 1000;
  }
  const clock = secs => { const m = Math.floor(secs / 60), r = secs - m * 60; return `${m}:${(r < 10 ? '0' : '') + r.toFixed(1)}`; };
  function scoreTtt(body) {
    const rows = Array.isArray(body && body.riders) ? body.riders.slice(0, 20) : [];
    if (!rows.length) throw new HttpError(400, 'Add at least one rider.');
    const riders = rows.map(r => { const name = String(r && r.name || 'Rider').slice(0, 60); return { name, time: parseClock(r.time, name), zpower: !!r.zpower }; });
    const finished = riders.filter(r => r.time !== null).sort((a, b) => a.time - b.time);
    const dnq = finished.length < 4;
    const teamTime = dnq ? null : finished[3].time;
    const zCount = riders.filter(r => r.zpower).length, zShare = Math.round(zCount / riders.length * 100);
    const warnings = [];
    if (dnq) warnings.push(`Only ${finished.length} finished: fewer than four is a DNQ and scores no league points.`);
    if (zShare > 40) warnings.push(`${zCount} of ${riders.length} riders (${zShare}%) are on ZPower: the limit is 40% of the squad.`);
    return { dnq, finishers: finished.length, teamTime, teamClock: teamTime === null ? null : clock(teamTime), zpowerShare: zShare, warnings, riders };
  }

  // Staff checklist for getting a round ready to race: each item is ok / todo / warn with a count, a plain sentence and the tab to fix it in.
  function readiness(data, now = Date.now()) {
    const { round, signups, assign } = data, weekly = data.weekly || { reg: {}, lineup: {}, avail: {} };
    const racing = signups.filter(x => x.in), ids = new Set(round.teams.map(t => t.id));
    const placedRiders = racing.filter(x => teamsOf(assign[x.key]).some(i => ids.has(i)));
    const playing = round.teams.filter(t => placedRiders.some(x => inTeam(assign[x.key], t.id)));
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const items = [];
    const add = (id, title, bad, okText, badText, go) => items.push({ id, title, state: bad ? 'todo' : 'ok', detail: bad ? badText : okText, go, fix: bad && FIX_IDS.includes(id) });
    const unplaced = racing.length - placedRiders.length;
    add('placed', 'Every rider is on a team', unplaced > 0, `${plural(racing.length, 'rider is', 'riders are')} placed.`, `${plural(unplaced, 'rider has', 'riders have')} no team yet.`, 'riders');
    const noId = racing.filter(x => !x.zwid).length;
    add('ids', 'Every rider has a Zwift ID', noId > 0, 'All riders have an ID.', `${plural(noId, 'rider has', 'riders have')} no Zwift ID, so cannot be registered or checked.`, 'riders');
    const noCap = playing.filter(t => !t.captain).length;
    add('captains', 'Every team has a captain', noCap > 0, 'All teams have a captain.', `${plural(noCap, 'team has', 'teams have')} no captain.`, 'teams');
    const noTime = playing.filter(t => !t.slot).length;
    add('times', 'Every team has a race time', noTime > 0, 'All teams have a race time.', `${plural(noTime, 'team has', 'teams have')} no race time.`, 'setup');
    const thin = playing.filter(t => placedRiders.filter(x => inTeam(assign[x.key], t.id)).length < round.racing).length;
    add('size', `Every team has at least ${round.racing} riders`, thin > 0, 'All teams can field a line-up.', `${plural(thin, 'team has', 'teams have')} fewer than ${round.racing} riders.`, 'teams');
    const low = placedRiders.filter(x => { const t = round.teams.find(tt => inTeam(assign[x.key], tt.id)); return x.cat && t && teamCat(t) && catGap(x.cat, teamCat(t)) < 0; }).length;
    add('class', 'Nobody is placed below their class', low > 0, 'Everyone is in a class they may ride.', `${plural(low, 'rider is', 'riders are')} below their team's class (see the category check in Setup).`, 'riders');
    add('published', 'Rosters are published', !round.published, 'Riders can see their teams.', 'Riders cannot see their teams yet. Publish in the Teams tab.', 'teams');
    const deadline = round.wtrlDeadline ? Date.parse(round.wtrlDeadline) : NaN;
    add('deadline', 'WTRL registration deadline is set', Number.isNaN(deadline), `Deadline ${ukLabel(deadline)}.`, 'No deadline set, so nobody gets chased. Setup → WTRL registration.', 'setup');
    const unreg = playing.filter(t => !weekly.reg[t.id]).length;
    add('wtrl', 'Every team is registered on WTRL', unreg > 0, 'All teams are marked registered.', `${plural(unreg, 'team is', 'teams are')} not marked registered${Number.isNaN(deadline) ? '' : deadline <= now ? '; the deadline has passed' : `; ${Math.ceil((deadline - now) / 86400000)} days to the deadline`}.`, 'export');
    const first = Date.parse(`${weekDate(round, 0)}T00:00:00Z`);
    const days = Math.ceil((first - now) / 86400000);
    const noLine = playing.filter(t => (weekly.lineup[`0:${t.id}`] || []).length < round.racing).length;
    add('lineups', 'Race 1 line-ups are picked', noLine > 0, 'Every team has a full line-up for race 1.', `${plural(noLine, 'team has', 'teams have')} not picked ${round.racing} riders for race 1.`, 'weeks');
    const done = items.filter(i => i.state === 'ok').length;
    return { round: round.name, firstRace: weekDate(round, 0), daysToFirstRace: days, done, total: items.length, ready: done === items.length, items, auto: { place: autoOn(round, 'place'), lineups: autoOn(round, 'lineups') } };
  }

  // One row for the admin health panel: [status, detail] for "is the ZRL round in a state that needs someone's attention?".
  function healthRow(data, now = Date.now()) {
    const { round, signups, assign } = data;
    if (!round) return ['info', 'No ZRL round yet. Start one in the ZRL tab when the next round opens.'];
    const racing = signups.filter(x => x.in);
    const byZone = REGIONS.map(r => `${r.name.slice(0, 2).toUpperCase()} ${racing.filter(x => x.regions.includes(r.id)).length}`).join(' · ');
    const ids = new Set(round.teams.map(t => t.id));
    const placed = racing.filter(x => teamsOf(assign[x.key]).some(i => ids.has(i))).length;
    const state = `${round.name}: sign-ups ${round.open ? 'open' : 'closed'}, ${racing.length} riders in (${byZone}), ${round.teams.length} team${round.teams.length === 1 ? '' : 's'}, ${placed} placed, rosters ${round.published ? 'published' : 'not published'}.`;
    const closes = round.closesAt ? Date.parse(round.closesAt) : NaN;
    if (round.open && Number.isNaN(closes)) return ['warn', `${state} No close date is set, so sign-ups will not close by themselves.`];
    if (round.open && now >= closes) return ['warn', `${state} The close time (${ukLabel(closes)}) has passed but sign-ups are still open: the next scheduled run will close them.`];
    // Once sign-ups are over or the rosters are out, everything below is something somebody has to do.
    const issues = [];
    const start = Date.parse(`${round.start}T00:00:00Z`);
    if (!round.published && !Number.isNaN(start) && start - now < 7 * 86400000)
      issues.push(`The first race is ${start <= now ? 'under way' : 'less than a week away'} and the rosters are not published.`);
    const n = (count, rest) => `${count} ${rest}`;
    if (!round.open && racing.length > placed) {
      const k = racing.length - placed;
      issues.push(n(k, `rider${k === 1 ? ' has' : 's have'} no team yet (use Suggest teams in the ZRL tab).`));
    }
    if (!round.open || round.published) {
      const withRiders = round.teams.filter(t => racing.some(x => inTeam(assign[x.key], t.id)));
      const bare = withRiders.filter(t => !t.captain).length, noTime = withRiders.filter(t => !t.slot).length;
      if (bare) issues.push(n(bare, `team${bare === 1 ? ' has' : 's have'} no captain.`));
      if (noTime) issues.push(n(noTime, `team${noTime === 1 ? ' has' : 's have'} riders but no race time.`));
    }
    // WTRL registration: once a deadline is set, the teams whose captain has not said they registered.
    if (round.wtrlDeadline && data.weekly && (round.published || !round.open)) {
      const deadline = Date.parse(round.wtrlDeadline);
      const playing = round.teams.filter(t => racing.some(x => inTeam(assign[x.key], t.id)));
      const open = playing.filter(t => !data.weekly.reg[t.id]).length;
      if (open) {
        const left = Math.ceil((deadline - now) / 86400000);
        issues.push(n(open, `team${open === 1 ? ' is' : 's are'} not registered on WTRL; ${deadline <= now ? 'the deadline has passed' : left <= 1 ? 'the deadline is within a day' : `${left} days to the deadline`}.`));
      }
    }
    // Race week coming up (within three days, or today): teams still without a full line-up.
    if (round.published && data.weekly) {
      const i = Array.from({ length: round.weeks }, (_, k) => k).find(k => Date.parse(`${weekDate(round, k)}T23:59:59Z`) >= now);
      if (i !== undefined && Date.parse(`${weekDate(round, i)}T00:00:00Z`) - now < 3 * 86400000) {
        const playing = round.teams.filter(t => racing.some(x => inTeam(assign[x.key], t.id)));
        const short = playing.filter(t => (data.weekly.lineup[`${i}:${t.id}`] || []).length < round.racing).length;
        if (short) issues.push(n(short, `team${short === 1 ? ' has' : 's have'} not picked a full line-up for race ${i + 1} (${weekDate(round, i)}).`));
      }
    }
    if (issues.length) return ['warn', `${state} ${issues.join(' ')}`];
    return ['ok', `${state}${round.open && !Number.isNaN(closes) ? ` Closes ${ukLabel(closes)}.` : ''}`];
  }

  // ── One-click fixes ────────────────────────────────────────
  // Works out (and, when applied, makes) everything the readiness list can sort out without a person: place unplaced riders, give each team a
  // captain, set race times from the league colour, move riders out of a class they are below, and pick line-ups from the riders' answers.
  // What needs a human (a missing Zwift ID, a WTRL registration, a team too small) is returned as `left`. Nothing is ever taken off a team.
  const FIX_IDS = ['placed', 'captains', 'times', 'class', 'lineups'];
  async function rosterInfo() {
    try {
      const { riders } = await fetchRoster();
      return { ratings: new Map(riders.map(r => [String(r.riderId), Math.round((r.race && r.race.current && r.race.current.rating) || 0)])), names: new Map(riders.map(r => [String(r.riderId), r.name])) };
    } catch (e) { return { ratings: new Map(), names: new Map() }; }
  }
  // The weeks to fill line-ups for: only the next race, or (scheduled run) every race that starts within `horizonDays`.
  function fixWeeks(round, now, horizonDays) {
    const today = new Date(now).toISOString().slice(0, 10);
    const ahead = Array.from({ length: round.weeks }, (_, i) => i).filter(i => weekDate(round, i) >= today);
    return horizonDays === undefined ? ahead.slice(0, 1) : ahead.filter(i => Date.parse(`${weekDate(round, i)}T00:00:00Z`) - now <= horizonDays * 86400000);
  }
  function planFixes({ round, signups, assign, weekly }, info, now, { only, horizonDays, fallbackCaptain = true } = {}) {
    const want = id => !only || only.includes(id);
    const steps = [], left = [], next = { ...assign }, writes = { assign: {}, lineups: {}, teams: false };
    const teams = round.teams.map(t => ({ ...t })), size = round.rosterSize || ROSTER_SIZE;
    const racing = signups.filter(x => x.in), nameOf = z => info.names.get(z) || (racing.find(x => x.zwid === z) || {}).name || z;
    const step = (id, title, lines) => { if (lines.length) steps.push({ id, title, count: lines.length, lines: lines.slice(0, 14), more: Math.max(0, lines.length - 14) }); };
    const members = id => racing.filter(x => inTeam(next[x.key], id));
    const setTeam = (key, ids) => { next[key] = joinTeams(ids); writes.assign[key] = next[key]; };

    if (want('placed')) {
      const plan = planAssignments({ teams, signups, assign: next, rosterSize: size });
      for (const m of plan.moves) setTeam(m.key, [m.team]);
      for (const t of teams) if (plan.captains[t.id] && !t.captain) { t.captain = plan.captains[t.id].zwid; t.captainName = nameOf(t.captain); writes.teams = true; }
      step('placed', 'Place riders on teams', plan.moves.map(m => `${m.name} → ${m.teamName}`));
      for (const u of plan.unplaced) left.push({ id: 'placed', title: u.name, detail: `not placed: ${u.reason}`, go: 'riders' });
    }
    if (want('class')) {
      const lines = [];
      for (const x of racing) for (const from of teamsOf(next[x.key])) {
        const t = teams.find(tt => tt.id === from);
        if (!t || !x.cat || !teamCat(t) || catGap(x.cat, teamCat(t)) >= 0) continue;
        const to = teams.filter(tt => tt.id !== from && !inTeam(next[x.key], tt.id) && (x.regions || []).includes(tt.region) && members(tt.id).length < size && (!teamCat(tt) || catGap(x.cat, teamCat(tt)) >= 0))
          .sort((a, b) => members(b.id).length - members(a.id).length || Math.abs(catGap(x.cat, teamCat(a))) - Math.abs(catGap(x.cat, teamCat(b))))[0];
        if (!to) { left.push({ id: 'class', title: x.name, detail: `is ${x.cat} but ${t.name} is a ${teamCat(t)} team and no other team in their zone has a place`, go: 'riders' }); continue; }
        setTeam(x.key, teamsOf(next[x.key]).map(id => (id === from ? to.id : id)));
        lines.push(`${x.name} (${x.cat}): ${t.name} → ${to.name}`);
      }
      step('class', 'Move riders out of a class they are below', lines);
    }
    if (want('captains')) {
      const lines = [];
      for (const t of teams) {
        if (t.captain || t.captainLocked) continue;
        const pool = members(t.id).filter(x => x.zwid);
        if (!members(t.id).length) continue;
        const volunteers = pool.filter(x => x.captain).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
        const pick = volunteers[0] || (fallbackCaptain ? [...pool].sort((a, b) => (info.ratings.get(b.zwid) || 0) - (info.ratings.get(a.zwid) || 0) || String(a.ts).localeCompare(String(b.ts)))[0] : null);
        if (!pick) { left.push({ id: 'captains', title: t.name, detail: pool.length ? 'no captain volunteered' : 'no rider has a Zwift ID, so nobody can be captain', go: 'teams' }); continue; }
        t.captain = pick.zwid; t.captainName = nameOf(pick.zwid); writes.teams = true;
        lines.push(`${t.name}: ${pick.name}${volunteers[0] ? ' (volunteered)' : ' (nobody volunteered: the strongest rider)'}`);
      }
      step('captains', 'Give every team a captain', lines);
    }
    if (want('times')) {
      const lines = [];
      for (const t of teams) {
        if (t.slot || !members(t.id).length) continue;
        const slot = leagueSlot(t.league, round.start);
        if (slot) { t.slot = slot; writes.teams = true; lines.push(`${t.name}: ${slot}`); } else left.push({ id: 'times', title: t.name, detail: `no race time: its league (${t.league || 'none set'}) names no WTRL colour`, go: 'setup' });
      }
      step('times', 'Set race times from the league colour', lines);
    }
    if (want('lineups')) {
      const lines = [], rank = st => (st === 'yes' ? 0 : st === 'maybe' ? 1 : st === '' ? 2 : 3);
      for (const i of fixWeeks(round, now, horizonDays)) for (const t of teams) {
        const pool = members(t.id).filter(x => x.zwid);
        if (!pool.length) continue;
        const have = (weekly.lineup[`${i}:${t.id}`] || []).filter(z => pool.some(x => x.zwid === z)), need = round.racing - have.length;
        if (need <= 0) continue;
        const cands = pool.filter(x => !have.includes(x.zwid) && availOf(weekly, i, x.zwid, t.id) !== 'no')
          .sort((a, b) => rank(availOf(weekly, i, a.zwid, t.id)) - rank(availOf(weekly, i, b.zwid, t.id)) || (info.ratings.get(b.zwid) || 0) - (info.ratings.get(a.zwid) || 0) || a.name.localeCompare(b.name));
        const chosen = cands.slice(0, need);
        if (chosen.length) { writes.lineups[`${i}:${t.id}`] = [...have, ...chosen.map(x => x.zwid)]; lines.push(`Race ${i + 1} · ${t.name}: ${chosen.map(x => x.name + (availOf(weekly, i, x.zwid, t.id) ? '' : ' (not answered)')).join(', ')}${have.length ? ` (added to ${have.length} already picked)` : ''}`); }
        if (chosen.length < need) left.push({ id: 'lineups', title: `Race ${i + 1} · ${t.name}`, detail: `only ${have.length + chosen.length} of ${round.racing} riders can race: find ${need - chosen.length} sub${need - chosen.length === 1 ? '' : 's'}`, go: 'weeks' });
      }
      step('lineups', 'Pick line-ups from the riders\' answers', lines);
    }
    return { steps, left, total: steps.reduce((n, s) => n + s.count, 0), writes, teams };
  }
  async function autoFix({ apply, only, horizonDays, fallbackCaptain, by = 'automatic' }, now = Date.now()) {
    const { round, signups, assign } = await requireRound();
    if (!round.teams.length) throw new HttpError(409, 'Add teams first (type them in, or import the team board).');
    const weekly = await loadWeekly(), info = await rosterInfo();
    const plan = planFixes({ round, signups, assign, weekly }, info, now, { only, horizonDays, fallbackCaptain });
    const out = { steps: plan.steps, left: plan.left, total: plan.total };
    if (!apply || !plan.total) return out;
    const cmds = [
      ...Object.entries(plan.writes.assign).map(([k, v]) => ['HSET', KEYS.assign, k, v]),
      ...Object.entries(plan.writes.lineups).map(([f, z]) => ['HSET', KEYS.weekly, `l:${f}`, JSON.stringify(z)]),
    ];
    if (plan.writes.teams) cmds.push(['SET', KEYS.round, JSON.stringify({ ...round, teams: plan.teams })]);
    await redis(cmds);
    if (autoLog) {
      const prev = k => { const v = assign[k]; return Array.isArray(v) ? joinTeams(v) : v; };
      const undo = [
        ...Object.keys(plan.writes.assign).map(k => (prev(k) ? ['HSET', KEYS.assign, k, prev(k)] : ['HDEL', KEYS.assign, k])),
        ...Object.keys(plan.writes.lineups).map(f => { const old = weekly.lineup[f]; return old && old.length ? ['HSET', KEYS.weekly, `l:${f}`, JSON.stringify(old)] : ['HDEL', KEYS.weekly, `l:${f}`]; }),
        ...(plan.writes.teams ? [['SET', KEYS.round, JSON.stringify(round)]] : []),
      ];
      await autoLog.record({ series: 'ZRL', by, summary: plan.steps.map(s => `${s.title}: ${s.count}`).join(' · '), undo }).catch(e => console.error('Auto log:', e.message));
    }
    return out;
  }

  // After any change: a team that has riders and no captain gets its first volunteer (the earliest sign-up with the star and a
  // Zwift ID). A captain is never replaced, and a captain cleared by hand (captainLocked) is not put back.
  async function afterChange() {
    const { round, signups, assign } = await load();
    if (!round || !round.teams.length) return false;
    let names = null, changed = false;
    const teams = [];
    for (const t of round.teams) {
      if (t.captain || t.captainLocked) { teams.push(t); continue; }
      const volunteer = signups.filter(x => x.in && x.captain && x.zwid && inTeam(assign[x.key], t.id)).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))[0];
      if (!volunteer) { teams.push(t); continue; }
      names = names || await riderNames();
      teams.push({ ...t, captain: volunteer.zwid, captainName: names.get(volunteer.zwid) || volunteer.name });
      changed = true;
    }
    if (changed) await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
    return changed;
  }

  // ── Routes ─────────────────────────────────────────────────
  // Team results from a pasted table (WTRL's standings page, or a spreadsheet): the columns are found by their headings (team, position, points; optionally
  // how many teams started), our teams are matched by name, and the rows are shown before anything is saved. Rows for other clubs' teams are ignored.
  const teamKey = n => String(n || '').normalize('NFKD').toLowerCase().replace(/cryo[\s-]*gen/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  function resultsFromTable(round, table) {
    const cols = csvLib.columns(table, { team: /^(team|club|name)\b/i, pos: /^(pos|position|rank|place|#)/i, pts: /^(pts|points|score|league points)/i, field: /^(field|teams|starters|started)/i });
    if (!cols || cols.idx.team < 0 || (cols.idx.pos < 0 && cols.idx.pts < 0)) throw new HttpError(400, 'I could not find the columns. The first row should name them: Team, Position and/or Points.');
    const byName = new Map(round.teams.map(t => [teamKey(t.name), t]));
    const rows = [], skipped = [];
    for (const r of table.slice(cols.header + 1)) {
      const name = r[cols.idx.team] || '', team = byName.get(teamKey(name));
      if (!team) { if (name) skipped.push(name); continue; }
      const num = i => (i >= 0 && /^\d+(\.\d+)?$/.test(String(r[i] || '').trim()) ? Number(r[i]) : null);
      rows.push({ team: team.id, name: team.name, pos: num(cols.idx.pos), pts: num(cols.idx.pts), field: num(cols.idx.field) });
    }
    return { rows, skipped: [...new Set(skipped)].slice(0, 12), missing: round.teams.filter(t => !rows.some(x => x.team === t.id)).map(t => t.name) };
  }

  async function categoryFor(zwid) {
    try {
      const { riders } = await fetchRoster();
      const r = riders.find(x => String(x.riderId) === String(zwid));
      const cat = r && String(r.zpCategory || '').replace('+', '');
      return CATS.includes(cat) ? cat : '';
    } catch (e) { return ''; }
  }

  // The teams as rows for the mirror tab on the club's ZRL sheet: one row per rider, then the riders who have no team.
  async function mirrorRows() {
    const { round, signups, assign } = await load();
    const head = ['Team', 'Division', 'Grade', 'League', 'Time zone', 'Race time', 'Captain', 'Rider', 'Zwift ID', 'Cat', 'Commitment', 'Dev eligible'];
    if (!round) return [head];
    const rows = [head], racing = signups.filter(x => x.in);
    for (const t of round.teams) {
      const riders = racing.filter(x => inTeam(assign[x.key], t.id)).sort((a, b) => (b.zwid === t.captain) - (a.zwid === t.captain) || a.name.localeCompare(b.name));
      const base = [t.name + (t.dev ? ' (Dev)' : ''), t.division || '', t.grade || '', t.league || '', regionName(t.region), t.slot || '', t.captainName || t.captain || ''];
      if (!riders.length) rows.push([...base, '', '', '', '', '']);
      for (const r of riders) rows.push([...base, r.name, r.zwid || '', r.cat || '', r.commit === 'reserve' ? 'Reserve' : 'Full season', r.devOk ? 'Yes' : '']);
    }
    for (const r of racing.filter(x => !teamsOf(assign[x.key]).length).sort((a, b) => a.name.localeCompare(b.name))) rows.push(['— Not in a team —', '', '', '', (r.regions || []).map(regionName).join(' / '), '', '', r.name, r.zwid || '', r.cat || '', r.commit === 'reserve' ? 'Reserve' : 'Full season', r.devOk ? 'Yes' : '']);
    return rows;
  }

  const keyOf = who => who.zwid || who.name.toLowerCase();

  const routes = {
    'GET /api/zrl': async () => {},

    // Staff only: everything a captain needs to register their team on WTRL.

    // The signed-in rider's own view: sign-up, team (once published), and the team they captain.
    'GET /api/zrl/mine': async req => {
      const member = memberFromRequest(req);
      if (!member) throw new HttpError(401, 'Sign in with your cryogen.team account to see your ZRL status.');
      const data = await load();
      if (!data.round) return { round: null };
      return myZrl(data, member, data.weekly, await loadResults());
    },

    // Staff: every sign-up as an Excel workbook (Riders and Teams sheets): basic info, power numbers, the team names, and what needs attention.
    'GET /api/zrl/riders-xlsx': async req => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      let roster = [];
      try { roster = (await fetchRoster()).riders; } catch (e) { /* the workbook still works without the power numbers */ }
      const byId = new Map(roster.map(r => [String(r.riderId), r]));
      const teamBy = new Map(round.teams.map(t => [t.id, t]));
      const size = round.rosterSize || ROSTER_SIZE, zone = id => regionName(id);
      const rows = [], teamOver = {}, teamN = {};
      for (const x of [...signups].sort((a, b) => a.name.localeCompare(b.name))) {
        const r = byId.get(String(x.zwid)) || {}, p = r.power || {};
        const placed = teamsOf(assign[x.key]).map(id => teamBy.get(id)).filter(Boolean);
        const zp = String(r.zpCategory || '').replace('+', '').toUpperCase();
        const own = CATS.includes(zp) ? zp : x.cat || '';
        const over = placed.filter(t => teamCat(t) && own && catGap(own, teamCat(t)) < 0);
        for (const t of placed) if (x.in) { teamN[t.id] = (teamN[t.id] || 0) + 1; if (over.includes(t)) teamOver[t.id] = (teamOver[t.id] || 0) + 1; }
        const status = !x.in ? 'Not racing' : !x.zwid ? 'No Zwift ID' : over.length ? `Over category (${zp} on a ${over.map(teamCat).join('/')} team)` : placed.length ? 'OK' : 'No team';
        const row = [x.name, x.zwid || '', x.in ? 'Yes' : 'No', placed.map(t => t.name).join('; '), placed.map(t => teamCat(t) || '').filter(Boolean).join('/'),
          placed.length ? (placed.some(t => t.dev) ? 'Dev' : 'Regular') : '', x.cat || '', zp, (x.regions || []).map(zone).join(' / '), x.commit === 'reserve' ? 'Reserve' : 'Full season',
          x.devOk ? 'Yes' : '', x.captain ? 'Yes' : '', r.zpFTP ? Math.round(r.zpFTP) : '', p.wkg1200 ? Math.round(p.wkg1200 * 95) / 100 : '', p.wkg300 ? Math.round(p.wkg300 * 100) / 100 : '',
          r.race && r.race.current && r.race.current.rating ? Math.round(r.race.current.rating) : '', status, x.league || '', x.comments || ''];
        row.flag = status === 'OK' ? { 16: 4 } : x.in ? { 16: 3 } : {};
        rows.push(row);
      }
      const teamRows = round.teams.map(t => {
        const row = [t.name, t.division || '', t.grade || '', teamCat(t), t.league || '', t.dev ? 'Dev' : 'Regular', zone(t.region), t.slot || '', t.captainName || t.captain || '', teamN[t.id] || 0, size, teamOver[t.id] || 0, t.wtrlRegistered ? 'Yes' : ''];
        row.flag = (teamN[t.id] || 0) > size || teamOver[t.id] ? { 9: 3, 11: 3 } : (teamN[t.id] || 0) === size ? { 9: 4 } : {};
        return row;
      });
      const buf = xlsx.build([
        { name: 'Riders', columns: [['Name', 24], ['Zwift ID', 12], ['Racing', 9], ['Team(s)', 30], ['Team cat', 10], ['Regular / Dev', 13], ['Declared cat', 12], ['ZwiftPower cat', 14], ['Time zone', 14], ['Commitment', 13], ['Dev eligible', 12], ['Volunteer captain', 16], ['FTP (W)', 9], ['FTP (w/kg)', 11], ['zMAP (w/kg)', 12], ['vELO', 8], ['Status', 34], ['League pick', 18], ['Notes', 40]].map(([header, width]) => ({ header, width })), rows },
        { name: 'Teams', columns: [['Team', 28], ['Division', 12], ['Grade', 14], ['Cat', 6], ['League', 14], ['Regular / Dev', 13], ['Time zone', 14], ['Race time', 16], ['Captain', 22], ['Riders', 8], ['Size', 7], ['Over category', 14], ['On WTRL', 9]].map(([header, width]) => ({ header, width })), rows: teamRows },
      ]);
      const safe = String(round.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'zrl';
      return { filename: `${safe}-riders.xlsx`, base64: buf.toString('base64') };
    },

    'GET /api/zrl/export': async req => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      return buildExport({ round, signups, assign });
    },

    // Starts a new round: the previous one is archived, the teams carry over, riders sign up afresh.
    'POST /api/zrl/round': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const name = text(body.name, 'round name', 60);
      const start = String(body.start || '');
      if (!validDate(start)) throw new HttpError(400, 'The first race date must be a real date, like 2026-11-17.');
      const closes = String(body.closes || '');
      if (closes && !validDate(closes)) throw new HttpError(400, 'The sign-up close date must be a real date.');
      const weeks = Math.min(Math.max(parseInt(body.weeks, 10) || 6, 1), 12);
      const current = await load();
      if (current.round && current.round.id === start) throw new HttpError(409, 'A round starting on that date already exists.');
      const commands = [];
      if (current.round) {
        const snapshot = { round: current.round, signups: current.signups, assign: Object.fromEntries(Object.entries(current.assign).map(([k, v]) => [k, joinTeams(v)])), weekly: await loadWeekly(), results: await loadResults() };
        commands.push(['HSET', KEYS.archive, current.round.id, JSON.stringify(snapshot)]);
      }
      // Teams always carry over (name, zone, league, division, grade). Race times follow the league colour for the new dates and
      // captains are cleared, unless the riders carry over too: then each rider on a team stays there, and a captain who is still
      // on their team stays captain. Carried riders are marked `carried`, and the rider can still change their own sign-up.
      const carry = body.carryRiders === true && !!current.round;
      const stays = new Map();   // rider key -> team id
      const carried = carry ? current.signups.filter(x => x.in && current.assign[x.key]) : [];
      carried.forEach(x => stays.set(x.key, teamsOf(current.assign[x.key])));
      const teams = current.round ? current.round.teams.map(t => {
        const kept = carry && t.captain && carried.some(x => x.zwid === t.captain && stays.get(x.key).includes(t.id));
        return { ...t, slot: leagueSlot(t.league, start) || '', captain: kept ? t.captain : '', captainName: kept ? t.captainName || '' : '', captainLocked: false };
      }) : [];
      const round = {
        id: start, name, start, weeks, open: true, published: false,
        closesAt: closes ? new Date(ukTime(closes, 23)).toISOString() : null,
        rosterSize: ROSTER_SIZE, racing: RACING, teams,
      };
      commands.push(['SET', KEYS.round, JSON.stringify(round)], ['DEL', KEYS.signups], ['DEL', KEYS.assign], ['DEL', KEYS.weekly], ['DEL', KEYS.results]);
      carried.forEach(x => {
        const { key, ...rest } = x;
        commands.push(['HSET', KEYS.signups, key, JSON.stringify({ ...rest, carried: true })], ['HSET', KEYS.assign, key, joinTeams(stays.get(key))]);
      });
      await redis(commands);
      await postOpen(round);
    },

    // Corrects the round's name and dates without starting over: sign-ups, teams and placements stay, nothing is announced.
    'POST /api/zrl/round-edit': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const name = text(body.name, 'round name', 60);
      const start = String(body.start || '');
      if (!validDate(start)) throw new HttpError(400, 'The first race date must be a real date, like 2026-11-17.');
      const closes = String(body.closes || '');
      if (closes && !validDate(closes)) throw new HttpError(400, 'The sign-up close date must be a real date.');
      const weeks = Math.min(Math.max(parseInt(body.weeks, 10) || round.weeks || 6, 1), 12);
      if (start !== round.id && (await redis([['HGET', KEYS.archive, start]]))[0]) throw new HttpError(409, 'An earlier round already started on that date.');
      const edited = { ...round, id: start, name, start, weeks, closesAt: closes ? new Date(ukTime(closes, 23)).toISOString() : null };
      // Reminder and close fire once per round and date: new dates start clean.
      await redis([['SET', KEYS.round, JSON.stringify(edited)],
        ...[round.id, start].flatMap(id => ['reminder', 'close'].map(ev => ['HDEL', KEYS.sent, `${id}:${ev}`]))]);
    },

    // Staff: one race time for several teams at once (everyone in a league races at the same time).
    'POST /api/zrl/team-slot': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const slot = text(body.slot, 'race time', 40, false);
      const ids = new Set(Array.isArray(body.teams) ? body.teams.map(String) : []);
      if (!ids.size) throw new HttpError(400, 'No teams chosen.');
      const known = new Set(round.teams.map(t => t.id));
      if ([...ids].some(id => !known.has(id))) throw new HttpError(400, 'Unknown team.');
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams: round.teams.map(t => (ids.has(t.id) ? { ...t, slot } : t)) })]]);
    },

    // Staff: mark teams as Regular or Development (a switch on the team: the sheet's grades do not say).
    'POST /api/zrl/team-kind': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const ids = new Set(Array.isArray(body.teams) ? body.teams.map(String) : []);
      if (!ids.size) throw new HttpError(400, 'No teams chosen.');
      const known = new Set(round.teams.map(t => t.id));
      if ([...ids].some(id => !known.has(id))) throw new HttpError(400, 'Unknown team.');
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams: round.teams.map(t => { if (!ids.has(t.id)) return t; const { dev, ...rest } = t; return body.dev === true ? { ...rest, dev: true } : rest; }) })]]);
    },

    // Staff: bring the sheet's published teams into the app with the sheet winning, without the upheaval of a full import: for teams that exist here, a
    // rider listed on the sheet is placed on it (a missing sign-up is created) and a rider the app has there but the sheet does not is taken off. Captains,
    // race times and teams the app has but the sheet lacks are left alone; teams the sheet has but the app lacks are reported, not created. Full teams are not overfilled.
    'POST /api/zrl/sync-board': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const found = await importBoard({ tab: body.tab || 'TEAM LIST', sheet: body.sheet });
      const appTeams = new Map(round.teams.map(t => [t.id, t])), size = round.rosterSize || ROSTER_SIZE;
      const onBoth = found.teams.filter(t => appTeams.has(t.id));
      if (round.teams.length && !onBoth.length) throw new HttpError(409, 'None of the teams on that sheet match the teams in the app, so nothing was changed. Check the tab name and the sheet.');
      const have = new Map(signups.map(x => [x.key, x])), place = new Map(Object.entries(assign).map(([k, v]) => [k, [...teamsOf(v)]]));
      const count = id => [...place.entries()].filter(([k, v]) => v.includes(id) && (have.get(k) || { in: true }).in !== false).length;
      const now = new Date().toISOString(), cmds = [], touched = new Set(), skipped = [];
      let placed = 0, removed = 0, created = 0;
      for (const t of onBoth) {
        const listed = new Set(t.riders.map(r => r.key));
        for (const r of t.riders) {
          const cur = place.get(r.key) || [];
          if (cur.includes(t.id)) continue;
          if (count(t.id) >= size) { skipped.push({ name: r.name, team: appTeams.get(t.id).name, reason: 'The team is full' }); continue; }
          if (!have.has(r.key)) {
            const entry = { name: r.name, zwid: r.zwid, in: true, cat: r.cat, regions: [appTeams.get(t.id).region], preferred: '', captain: false, comments: 'Imported from the sheet', ts: now, source: 'sheet' };
            cmds.push(['HSET', KEYS.signups, r.key, JSON.stringify(entry)]); have.set(r.key, entry); created++;
          }
          place.set(r.key, [...cur, t.id]); touched.add(r.key); placed++;
        }
        for (const [k, v] of [...place.entries()]) if (v.includes(t.id) && !listed.has(k)) { place.set(k, v.filter(id => id !== t.id)); touched.add(k); removed++; }
      }
      for (const k of touched) { const v = place.get(k) || []; cmds.push(v.length ? ['HSET', KEYS.assign, k, joinTeams(v)] : ['HDEL', KEYS.assign, k]); }
      if (cmds.length) await redis(cmds);
      return { sync: { teams: onBoth.length, placed, removed, created, skipped, newOnSheet: found.teams.filter(t => !appTeams.has(t.id)).map(t => t.name), notOnSheet: round.teams.filter(t => !found.teams.some(f => f.id === t.id)).map(t => t.name) } };
    },

    // Staff: give every team the race time WTRL fixes for its league colour (only teams whose league names a colour; the rest keep theirs).
    'POST /api/zrl/league-times': async (req) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      let changed = 0;
      const teams = round.teams.map(t => {
        const slot = leagueSlot(t.league, round.start);
        if (!slot || slot === t.slot) return t;
        changed++;
        return { ...t, slot };
      });
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
      return { changed, skipped: teams.filter(t => !leagueSlot(t.league, round.start)).length };
    },

    // Staff: how each team finished a race week and the points it scored (blank clears it). rows: [{team, pos, pts, note}].
    'POST /api/zrl/results': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const edits = resultEdits(round, weekOf(round, body), body.rows);
      await redis(edits.map(e => (e.value ? ['HSET', KEYS.results, e.field, JSON.stringify(e.value)] : ['HDEL', KEYS.results, e.field])));
    },

    // Staff: team results for a race week from a pasted table. A preview unless `apply` is true; applying can be undone from This week.
    'POST /api/zrl/results-import': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound(), week = weekOf(round, body);
      const found = resultsFromTable(round, csvLib.parseTable(body.csv));
      if (!found.rows.length) throw new HttpError(409, 'None of our teams are in that table (teams are matched by name).');
      const edits = resultEdits(round, week, found.rows.map(r => ({ team: r.team, pos: r.pos, pts: r.pts, field: r.field })));
      if (body.apply !== true) return { preview: { week, ...found, rows: found.rows.map(r => ({ ...r, points: (edits.find(e => e.field === `${week}:${r.team}`) || { value: {} }).value?.pts ?? null })) } };
      const before = await redis(edits.map(e => ['HGET', KEYS.results, e.field]));
      // What the table does not carry (the rider points, a note) stays as it was.
      const merged = edits.map((e, i) => { let old = null; try { old = before[i] ? JSON.parse(before[i]) : null; } catch (x) { /* replaced */ } return { ...e, value: e.value ? { ...(old || {}), ...Object.fromEntries(Object.entries(e.value).filter(([, v]) => v !== null && v !== '')) } : null }; });
      await redis(merged.map(e => (e.value ? ['HSET', KEYS.results, e.field, JSON.stringify(e.value)] : ['HDEL', KEYS.results, e.field])));
      if (autoLog) await autoLog.record({ series: 'ZRL', by: 'staff', summary: `Race ${week + 1}: results read from a table for ${edits.length} team${edits.length === 1 ? '' : 's'}`, undo: edits.map((e, i) => (before[i] ? ['HSET', KEYS.results, e.field, before[i]] : ['HDEL', KEYS.results, e.field])) }).catch(e => console.error('Auto log:', e.message));
      return { applied: edits.length, skipped: found.skipped, missing: found.missing };
    },

    // Staff: post the standings to the ZRL club channel, a block per division (split so no message passes Discord's length limit). At most once every
    // five minutes, so a double click cannot post twice.
    'POST /api/zrl/post-standings': async (req) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const st = standingsOf(round, await loadResults(), false);
      if (!st.groups.length) throw new HttpError(409, 'There are no results to post yet.');
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${round.id}:standings:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, 'The standings were posted a moment ago.');
      const done = st.groups.flatMap(g => g.teams.map(t => t.races)).length ? Math.max(...st.groups.flatMap(g => g.teams.map(t => t.races))) : 0;
      const blocks = st.groups.map(g => `**${discordEscape(g.name)}**\n${g.teams.map(t => `${t.rank}. ${discordEscape(t.name.replace(/^CRYO-GEN\s+/, ''))} · ${t.total} pts${t.best ? ` (best ${ordinal(t.best)})` : ''}`).join('\n')}`);
      const messages = [];
      let cur = `🏆 **ZRL ${discordEscape(round.name)}: standings after race ${done}**`;
      for (const b of blocks) { if (cur.length + b.length + 2 > 1800) { messages.push(cur); cur = ''; } cur += `${cur ? '\n\n' : ''}${b}`; }
      messages.push(`${cur}\n\nFull table: ${siteUrl} → 🚀 ZRL`);
      for (const content of messages) await discord('zrl-public', { content });
      return { posted: messages.length };
    },

    // Staff: preview the end-of-round recognition, then post it to the ZRL club channel (at most once every five minutes).
    'GET /api/zrl/recognition': async req => { requireRole(req, ['admin', 'mod']); return recognition(); },
    'POST /api/zrl/post-recognition': async req => {
      requireRole(req, ['admin', 'mod']);
      const r = await recognition();
      const { round } = await requireRound();
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${round.id}:recognition:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, 'The recognition was posted a moment ago.');
      for (const content of r.messages) await discord('zrl-public', { content });
      return { posted: r.messages.length };
    },

    // Staff: post one race's results (each team's position and points, by division) to the ZRL club channel. Notes are staff-only and left out.
    'POST /api/zrl/post-race': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const week = weekOf(round, body);
      const results = await loadResults();
      const groups = new Map();
      for (const t of round.teams) {
        const r = results[`${week}:${t.id}`];
        if (!r || !(r.pos || (r.pts !== undefined && r.pts !== null))) continue;
        const name = t.division || t.league || 'All teams';
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push({ name: t.name.replace(/^CRYO-GEN\s+/, ''), pos: r.pos || null, pts: r.pts ?? null });
      }
      if (!groups.size) throw new HttpError(409, `There are no results for race ${week + 1} yet.`);
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${round.id}:race:${week}:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, 'This race was posted a moment ago.');
      const blocks = [...groups].map(([name, teams]) => `**${discordEscape(name)}**\n${teams.sort((a, b) => (a.pos || 999) - (b.pos || 999)).map(t => `${t.pos ? ordinal(t.pos) : '—'} ${discordEscape(t.name)}${t.pts !== null ? ` · ${t.pts} pts` : ''}`).join('\n')}`);
      const messages = [];
      let cur = `🏁 **ZRL ${discordEscape(round.name)}: race ${week + 1} results (${raceLabel(round, week)})**`;
      for (const b of blocks) { if (cur.length + b.length + 2 > 1800) { messages.push(cur); cur = ''; } cur += `${cur ? '\n\n' : ''}${b}`; }
      messages.push(`${cur}\n\nStandings: ${siteUrl} → 🚀 ZRL`);
      for (const content of messages) await discord('zrl-public', { content });
      return { posted: messages.length };
    },

    // Staff: the standings or the race-by-race results as a spreadsheet (CSV). Cells that look like formulas are neutralised.
    'GET /api/zrl/results-export': async (req, _body, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const results = await loadResults();
      const rows = [];
      if (query.kind === 'results') {
        rows.push(['Race', 'Date', 'Team', 'Division', 'League', 'Position', 'Points', 'Note']);
        for (let i = 0; i < round.weeks; i++) for (const t of round.teams) {
          const r = results[`${i}:${t.id}`];
          if (r) rows.push([i + 1, weekDate(round, i), t.name, t.division || '', t.league || '', r.pos ?? '', r.pts ?? '', r.note || '']);
        }
      } else {
        const st = standingsOf(round, results, false);
        rows.push(['Division', 'Rank', 'Team', 'Points', 'Races', 'Best finish', ...st.dates.map((d, i) => `Race ${i + 1} (${d})`)]);
        for (const g of st.groups) for (const t of g.teams) rows.push([g.name, t.rank, t.name, t.total, t.races, t.best ?? '', ...t.weeks.map(w => (w ? [w.pos ? ordinal(w.pos) : '', w.pts !== null ? `${w.pts} pts` : ''].filter(Boolean).join(' · ') : ''))]);
      }
      if (rows.length === 1) throw new HttpError(409, 'There are no results to export yet.');
      const safe = String(round.name).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'zrl';
      return { filename: `${safe}-${query.kind === 'results' ? 'results' : 'standings'}.csv`, csv: rows.map(r => r.map(csvCell).join(',')).join('\n') };
    },

    // Everyone: the standings so far (staff also get the raw entries, with notes, for the entry form).
    'GET /api/zrl/standings': async req => {
      const { round } = await load();
      if (!round) return { dates: [], groups: [] };
      return standingsOf(round, await loadResults(), isStaff(req));
    },

    // Staff: the latest changes made through the dashboard (who, when, what).
    // Staff: score every one of our teams from one race check in a single go (finish and podium points, or the team time), and list the riders
    // whose category is below their team's class (a likely ineligible rider). FAL and FTS points are not in the results: they are added per team afterwards.
    'POST /api/zrl/score-all': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const list = Array.isArray(body && body.teams) ? body.teams.slice(0, 80) : [];
      if (!list.length) throw new HttpError(400, 'There are no teams to score.');
      const ttt = body.mode === 'ttt';
      const results = list.map(item => {
        const team = round.teams.find(t => t.id === String(item && item.team || ''));
        if (!team) return { team: String(item && item.team || ''), error: 'That team does not exist.' };
        const riders = Array.isArray(item.riders) ? item.riders : [];
        const tcat = teamCat(team);
        const belowClass = riders.filter(r => r && r.cat && tcat && catGap(String(r.cat).toUpperCase().slice(0, 1), tcat) < 0).map(r => String(r.name || 'Rider').slice(0, 60));
        try { return { team: team.id, name: team.name, belowClass, result: ttt ? scoreTtt({ riders }) : scoreRace({ starters: body.starters, riders }) }; }
        catch (e) { if (e instanceof HttpError) return { team: team.id, name: team.name, belowClass, error: e.message }; throw e; }
      });
      return { mode: ttt ? 'ttt' : 'points', results };
    },

    'POST /api/zrl/score': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      return body && body.mode === 'ttt' ? scoreTtt(body) : scoreRace(body);
    },

    'GET /api/zrl/readiness': async req => {
      requireRole(req, ['admin', 'mod']);
      const data = await requireRound();
      return readiness({ ...data, weekly: await loadWeekly() });
    },

    'GET /api/zrl/log': async req => {
      requireRole(req, ['admin', 'mod']);
      const [raw] = await redis([['LRANGE', KEYS.log, 0, 99]]);
      return { entries: (raw || []).map(v => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean) };
    },

    // Staff: post a "riders wanted" message for one time zone (default Asia-Pacific) to the ZRL club channel. Sign-ups must be open,
    // and each zone is posted at most once a day so it cannot be spammed. The message says how many places are open and when they race.
    'POST /api/zrl/recruit': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const region = String(body.region || 'ap');
      if (!REGION_IDS.includes(region)) throw new HttpError(400, 'Choose a time zone.');
      if (!round.open) throw new HttpError(409, 'Sign-ups are closed. Reopen them before asking for riders.');
      const day = new Date().toISOString().slice(0, 10);
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${round.id}:recruit:${region}:${day}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, `A message for ${regionName(region)} was already posted today.`);
      const teams = round.teams.filter(t => t.region === region);
      const placed = teams.reduce((n, t) => n + signups.filter(x => x.in && inTeam(assign[x.key], t.id)).length, 0);
      const open = Math.max(0, teams.length * round.rosterSize - placed);
      const times = [...new Set(teams.map(t => t.slot).filter(Boolean))].slice(0, 3);
      const interested = signups.filter(x => x.in && !assign[x.key] && x.regions.includes(region)).length;
      const zone = discordEscape(regionName(region));
      const lines = teams.length
        ? [`🌏 **${zone}: ${open} place${open === 1 ? '' : 's'} open on ${teams.length} team${teams.length === 1 ? '' : 's'}!**`, times.length ? `Race times: ${times.map(discordEscape).join(' · ')}.` : '', `Come and race the ZRL ${discordEscape(round.name)} with CRYO-GEN.`]
        : [`🌏 **${zone}: we want to start a team!**`, `${interested} rider${interested === 1 ? ' is' : 's are'} interested so far. A team needs ${round.rosterSize}.`];
      await discord('zrl-public', { content: `${lines.filter(Boolean).join('\n')}\nSign in at ${siteUrl} → 🚀 ZRL and tick ${zone}.` });
      return { posted: true, open, interested };
    },

    // Admin: look at what the ZwiftRacing.app organizer API returns. The key stays on the server (ZWIFTRACING_API_KEY, sent raw in
    // Authorization). `kind` picks one documented endpoint, `host` the site (zwiftracing.app) or its api. subdomain. It returns the status,
    // the address asked (never the key), whether the answer was a web page instead of data, the *shape* of the answer (field names and types)
    // and the answer cut at 150 KB. Their rate limits are tight (results: one a minute), so this is for looking, not for polling.
    'GET /api/zrl/zr-event': async (req, _body, query = {}) => {
      requireRole(req, ['admin']);
      const key = process.env.ZWIFTRACING_API_KEY;
      if (!key) throw new HttpError(503, 'ZWIFTRACING_API_KEY is not set in Vercel yet.');
      const kind = query.kind || (query.source === 'zp' ? 'zp' : 'results');
      const paths = { results: id => `/api/public/results/${id}`, zp: id => `/api/public/zp/${id}/results`, rider: id => `/api/public/riders/${id}`, club: id => `/api/public/clubs/${id}`, categories: () => '/api/v2/public/categories' };
      if (!paths[kind]) throw new HttpError(400, 'Choose results, zp, rider, club or categories.');
      const id = String(query.id || '').trim();
      if (kind !== 'categories' && !/^\d{1,12}$/.test(id)) throw new HttpError(400, 'The id is a number (an event id, or a rider or club id).');
      const base = query.host === 'api' ? 'https://api.zwiftracing.app' : 'https://zwiftracing.app';
      const url = base + paths[kind](id);
      const started = Date.now();
      let r, raw;
      try {
        r = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) });
        raw = await r.text();
      } catch (e) {
        throw new HttpError(e && e.name === 'TimeoutError' ? 504 : 502, e && e.name === 'TimeoutError' ? 'ZwiftRacing.app did not answer in time.' : `ZwiftRacing.app could not be reached (${base.replace('https://', '')}).`);
      }
      let data = null;
      try { data = JSON.parse(raw); } catch (e) { /* not JSON: shown as text */ }
      const shape = (v, depth = 0) => (Array.isArray(v) ? [v.length ? shape(v[0], depth + 1) : 'empty', `(${v.length} items)`]
        : v && typeof v === 'object' ? (depth > 4 ? '{…}' : Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [k, shape(x, depth + 1)]))) : v === null ? 'null' : typeof v);
      const body = raw.length > 150000 ? raw.slice(0, 150000) : raw;
      const isPage = data === null && /<!doctype html|<html/i.test(raw.slice(0, 500));
      return { status: r.status, ms: Date.now() - started, url, isPage, truncated: raw.length > 150000, shape: data === null ? (isPage ? 'a web page, not data' : 'not JSON') : shape(data), body: isPage ? raw.slice(0, 600) : body };
    },

    // Staff: compare each racing rider's declared category with their ZwiftPower category from the ZwiftRacing.app club data (one call for the
    // whole club, which that API allows once every ten minutes, so the answer is kept in Redis, refreshed after an hour (or on request, at most every ten minutes) and used again if they say wait).
    // Lists riders who understated their category (declared weaker than ZwiftPower's), riders placed on a team whose category is weaker than
    // their ZwiftPower category, riders overstating (harmless), and riders not found in the club data.
    'GET /api/zrl/category-check': async (req, _body, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      const key = process.env.ZWIFTRACING_API_KEY;
      if (!key) throw new HttpError(503, 'ZWIFTRACING_API_KEY is not set in Vercel yet.');
      const { round, signups, assign } = await requireRound();
      const [cached] = await redis([['GET', KEYS.zrClub]]);
      let club = cached ? JSON.parse(cached) : null;
      let stale = false;
      const age = club ? Date.now() - club.at : Infinity;
      if (!club || age > 3600000 || (query.fresh === '1' && age > 10 * 60000)) {
        let r, data;
        try {
          r = await fetch(`https://api.zwiftracing.app/api/public/clubs/${encodeURIComponent(process.env.ZWIFT_CLUB_ID || '2740')}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(9000) });
          const raw = await r.text();
          try { data = JSON.parse(raw); } catch (e) { data = null; }
        } catch (e) {
          if (!club) throw new HttpError(e && e.name === 'TimeoutError' ? 504 : 502, e && e.name === 'TimeoutError' ? 'ZwiftRacing.app did not answer in time.' : 'ZwiftRacing.app could not be reached.');
          stale = true;
        }
        if (r && r.ok && data && Array.isArray(data.riders)) {
          club = { at: Date.now(), riders: Object.fromEntries(data.riders.map(x => [String(x.riderId), { z: String(x.zpCategory || '').toUpperCase(), v: (((((x.race || {}).current || {}).mixed || {}).category) || {}).name || '' }])) };
          await redis([['SET', KEYS.zrClub, JSON.stringify(club)]]);
        } else if (r && !club) {
          throw new HttpError(r.status === 429 ? 429 : 502, r.status === 429 ? `ZwiftRacing.app allows the club list once every ten minutes. Try again in ${data && data.retryAfter ? `${data.retryAfter} seconds` : 'a few minutes'}.` : r.status === 401 ? 'ZwiftRacing.app did not accept the key (401).' : 'ZwiftRacing.app did not return the club list.');
        } else if (r) stale = true;
      }
      // Racing riders with a Zwift ID who are not in the club list are asked about one by one (a single batch request, which the API allows
      // once every ten minutes for a standard key): the answers, and "no profile" for those it omits, are kept so they are not asked again.
      const [extraRaw] = await redis([['GET', KEYS.zrExtra]]);
      let extra = extraRaw ? JSON.parse(extraRaw) : { at: 0, riders: {} };
      if (Date.now() - extra.at > 24 * 3600000) extra = { at: 0, riders: {} };   // categories change: ask again after a day
      const wanted = [...new Set(signups.filter(x => x.in && x.zwid && !club.riders[x.zwid] && !extra.riders[x.zwid]).map(x => x.zwid))].slice(0, 1000);
      let lookedUpNow = 0, lookupNote = '';
      if (wanted.length && Date.now() - extra.at > 10 * 60000) {
        try {
          const r2 = await fetch('https://api.zwiftracing.app/api/public/riders', { method: 'POST', headers: { Authorization: key, 'Content-Type': 'application/json' }, body: JSON.stringify(wanted.map(Number)), signal: AbortSignal.timeout(9000) });
          let list = null; try { const d2 = JSON.parse(await r2.text()); list = Array.isArray(d2) ? d2 : (d2 && Array.isArray(d2.riders) ? d2.riders : null); } catch (e) { /* not JSON */ }
          if (r2.ok && list) {
            const got = new Map(list.map(x => [String(x.riderId), x]));
            for (const id of wanted) { const x = got.get(id); extra.riders[id] = x ? { z: String(x.zpCategory || '').toUpperCase(), v: ((((x.race || {}).current || {}).mixed || {}).category || {}).name || '' } : { none: true }; }
            extra.at = Date.now(); lookedUpNow = wanted.length;
            await redis([['SET', KEYS.zrExtra, JSON.stringify(extra)]]);
          } else lookupNote = r2.status === 429 ? 'ZwiftRacing.app asked us to wait before looking up riders outside the club.' : 'The individual rider lookup did not work this time.';
        } catch (e) { lookupNote = 'The individual rider lookup could not be reached.'; }
      } else if (wanted.length) lookupNote = 'Riders outside the club will be looked up on the next check after ten minutes.';
      const letter = v => { const m = /^[A-E]/.exec(String(v || '').toUpperCase()); return m ? m[0] : ''; };
      const teamsFor = x => round.teams.filter(t => inTeam(assign[x.key], t.id));
      const understated = [], misplaced = [], overstated = [], notFound = [];
      let looked = 0;
      for (const x of signups.filter(x => x.in)) {
        const inClub = x.zwid ? club.riders[x.zwid] : null;
        const alone = !inClub && x.zwid ? extra.riders[x.zwid] : null;
        const zr = inClub || (alone && !alone.none ? alone : null);
        if (!zr) { notFound.push({ key: x.key, name: x.name, cat: x.cat || '', hasId: !!x.zwid, noProfile: !!(alone && alone.none) }); continue; }
        if (!inClub) looked++;
        const zp = letter(zr.z), declared = x.cat || '', riderTeams = teamsFor(x);
        const row = { key: x.key, name: x.name, declared, zp, velo: zr.v, team: riderTeams.map(t => t.name).join(', '), outsideClub: !inClub };
        if (zp && declared && CATS.indexOf(declared) > CATS.indexOf(zp)) understated.push(row);
        else if (zp && declared && CATS.indexOf(declared) < CATS.indexOf(zp)) overstated.push(row);
        else if (zp && !declared) understated.push({ ...row, missing: true });
        for (const t of riderTeams) if (zp && teamCat(t) && catGap(zp, teamCat(t)) < 0) misplaced.push({ ...row, team: t.name, teamCat: teamCat(t) });
      }
      const byName = (a, b) => a.name.localeCompare(b.name);
      return { at: club.at, stale, clubRiders: Object.keys(club.riders).length, checked: signups.filter(x => x.in).length, looked, lookedUpNow, lookupNote,
        understated: understated.sort(byName), misplaced: misplaced.sort(byName), overstated: overstated.sort(byName), notFound: notFound.sort(byName) };
    },

    // Admin: try every documented endpoint on both addresses at once (in parallel, inside the function's time limit) and summarise each:
    // status, JSON or web page, and the first keys or words. Needs a rider id and an event id to try. The key is never returned.
    'GET /api/zrl/zr-probe': async (req, _body, query = {}) => {
      requireRole(req, ['admin']);
      const key = process.env.ZWIFTRACING_API_KEY;
      if (!key) throw new HttpError(503, 'ZWIFTRACING_API_KEY is not set in Vercel yet.');
      const rider = String(query.rider || '').trim(), event = String(query.event || '').trim();
      if (!/^\d{1,12}$/.test(rider) || !/^\d{1,12}$/.test(event)) throw new HttpError(400, 'Give a rider id and an event id (numbers).');
      const sites = { site: 'https://zwiftracing.app', api: 'https://api.zwiftracing.app' };
      const tries = [['categories', 'site', '/api/v2/public/categories'], ['categories', 'api', '/api/v2/public/categories'], ['rider', 'site', `/api/public/riders/${rider}`],
        ['rider', 'api', `/api/public/riders/${rider}`], ['event results', 'site', `/api/public/results/${event}`], ['event results', 'api', `/api/public/results/${event}`]];
      const one = async ([name, host, path]) => {
        const started = Date.now(), url = sites[host] + path;
        try {
          const r = await fetch(url, { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) });
          const raw = await r.text();
          let data = null; try { data = JSON.parse(raw); } catch (e) { /* not JSON */ }
          const isPage = data === null && /<!doctype html|<html/i.test(raw.slice(0, 500));
          const sample = data === null ? (isPage ? 'the website (a web page), not the API' : raw.slice(0, 120))
            : Array.isArray(data) ? `a list of ${data.length}` : data && typeof data === 'object' ? `keys: ${Object.keys(data).slice(0, 12).join(', ')}` : String(data).slice(0, 120);
          return { name, host, url, status: r.status, ms: Date.now() - started, kind: isPage ? 'page' : data === null ? 'text' : 'json', sample };
        } catch (e) {
          return { name, host, url, status: 0, ms: Date.now() - started, kind: 'error', sample: e && e.name === 'TimeoutError' ? 'no answer in 8 seconds' : 'could not be reached' };
        }
      };
      return { probes: await Promise.all(tries.map(one)) };
    },

    // Staff: check one ZRL race event (its Zwift event id) against our teams. ZwiftRacing.app's organizer API (api.zwiftracing.app, key in
    // ZWIFTRACING_API_KEY) lists every finisher; the title names the league, division and race ("... Open Shamrock League Division 4 - Race 3"),
    // which gives the race week and the teams. For each of our teams in it: who raced and how they finished, whether each was in the captain's
    // line-up, and who was picked but did not appear. Team positions and points still come from WTRL. Results allow one request a minute.
    'GET /api/zrl/event-check': async (req, _body, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      const key = process.env.ZWIFTRACING_API_KEY;
      if (!key) throw new HttpError(503, 'ZWIFTRACING_API_KEY is not set in Vercel yet.');
      const id = String(query.id || '').trim();
      if (!/^\d{1,12}$/.test(id)) throw new HttpError(400, 'The event id is a number (the end of the Zwift event link).');
      const { round, signups, assign } = await requireRound();
      let r, data;
      try {
        r = await fetch(`https://api.zwiftracing.app/api/public/results/${id}`, { headers: { Authorization: key }, signal: AbortSignal.timeout(8000) });
        const raw = await r.text();
        try { data = JSON.parse(raw); } catch (e) { data = null; }
      } catch (e) {
        throw new HttpError(e && e.name === 'TimeoutError' ? 504 : 502, e && e.name === 'TimeoutError' ? 'ZwiftRacing.app did not answer in time.' : 'ZwiftRacing.app could not be reached.');
      }
      if (r.status === 429) throw new HttpError(429, `ZwiftRacing.app allows one results request a minute. Try again${data && data.retryAfter ? ` in ${data.retryAfter} seconds` : ' in a minute'}.`);
      if (r.status === 401) throw new HttpError(502, 'ZwiftRacing.app did not accept the key (401).');
      if (!r.ok || !data || !Array.isArray(data.results)) throw new HttpError(404, 'ZwiftRacing.app has no results for that event id yet.');
      const title = String(data.title || '');
      const m = /([A-Za-z][A-Za-z' -]*?)\s+League\s+Division\s+(\d+)\s*[-–]\s*Race\s+(\d+)/i.exec(title);
      const parsed = m ? { league: m[1].trim().split(/\s+/).pop(), division: Number(m[2]), race: Number(m[3]) } : null;
      // The race week comes from the race's own date when it has one (a race falls on or just after a week's start, UTC), because the title's
      // race number repeats every round. A race outside this round's weeks belongs to an earlier or later round: no line-up applies to it.
      const eventMs = Number(data.time) * 1000;
      let week = null, outsideRound = false;
      if (Number.isFinite(eventMs) && eventMs > 0) {
        const found = Array.from({ length: round.weeks }, (_, i) => i).find(i => { const start = Date.parse(`${weekDate(round, i)}T00:00:00Z`); return eventMs >= start - 12 * 3600000 && eventMs < start + 36 * 3600000; });
        if (found === undefined) outsideRound = true; else week = found;
      } else if (parsed && parsed.race >= 1 && parsed.race <= round.weeks) week = parsed.race - 1;
      const weekly = await loadWeekly();
      const finish = new Map(data.results.map(x => [String(x.riderId), x]));
      const mine = new Map();   // team id -> riders on it
      for (const x of signups.filter(x => x.in && x.zwid)) for (const id of teamsOf(assign[x.key])) (mine.get(id) || mine.set(id, []).get(id)).push(x);
      const teams = round.teams.map(t => {
        const riders = mine.get(t.id) || [];
        const lineup = week === null ? [] : weekly.lineup[`${week}:${t.id}`] || [];
        const raced = riders.filter(x => finish.has(x.zwid)).map(x => { const f = finish.get(x.zwid);
          return { name: x.name, position: f.position ?? null, inCategory: f.positionInCategory ?? null, cat: f.category || '', time: f.time ?? null, gap: f.gap ?? null, picked: lineup.includes(x.zwid) }; })
          .sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999));
        const missing = lineup.filter(z => !finish.has(z)).map(z => (riders.find(x => x.zwid === z) || {}).name || z);
        return { id: t.id, name: t.name, league: t.league || '', division: t.division || '', raced: raced.map(x => ({ ...x, picked: week !== null && x.picked })), missing, lineupSet: lineup.length };
      });
      // In this event: teams with a rider in the results, and teams whose league and division the title names that picked riders who are not in it.
      const named = t => !!parsed && t.league.toLowerCase().includes(parsed.league.toLowerCase()) && new RegExp(`\\b${parsed.division}\\b`).test(t.division);
      const inEvent = teams.filter(t => t.raced.length || (named(t) && t.lineupSet > 0)).map(t => ({ ...t, named: named(t) }));
      return { event: { id, title, time: data.time || null, type: data.type || '', subType: data.subType || '', distance: data.distance || null, finishers: data.results.length, date: Number.isFinite(eventMs) && eventMs > 0 ? new Date(eventMs).toISOString().slice(0, 10) : null }, parsed, week, outsideRound, teams: inEvent };
    },

    'POST /api/zrl/status': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const changes = {};
      if (typeof body.open === 'boolean') changes.open = body.open;
      if (typeof body.published === 'boolean') changes.published = body.published;
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, ...changes })]]);
      // Publishing tells the club once per round (unpublishing and publishing again stays quiet), unless staff ask for silence.
      if (changes.published === true && !round.published && body.announce !== false) {
        const [claimed] = await redis([['HSETNX', KEYS.sent, `${round.id}:published`, new Date().toISOString()]]);
        if (claimed) {
          const data = await load();
          await postPublished(round, data.signups, data.assign).catch(e => console.error('ZRL publish post:', e.message));
        }
      }
    },

    'POST /api/zrl/teams': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, assign } = await requireRound();
      const teams = await parseTeams(body.teams, round.teams);
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
      // Riders placed on a team that no longer exists go back to the pool.
      const valid = new Set(teams.map(t => t.id));
      const drop = Object.entries(assign).flatMap(([k, ids]) => {
        const keep = ids.filter(id => valid.has(id));
        return keep.length === ids.length ? [] : [keep.length ? ['HSET', KEYS.assign, k, joinTeams(keep)] : ['HDEL', KEYS.assign, k]];
      });
      if (drop.length) await redis(drop);
    },


    // Reads the team board from a tab of the Google Sheet. Without `apply` it only previews; with it, the
    // teams and rosters replace what is here (riders keep any sign-up they already made).
    'POST /api/zrl/import': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups } = await requireRound();
      const found = await importBoard(body);
      if (body.apply !== true) {
        return { preview: { tab: found.tab, warnings: found.warnings, teams: found.teams.map(t => ({ id: t.id, name: t.name, division: t.division, grade: t.grade, hint: t.hint, region: t.region, riders: t.riders })) } };
      }
      if (body.refresh === true) {
        // Only the board's labels (league, division, grade) for teams that already exist: nothing about riders, captains or race times changes.
        const labels = new Map(found.teams.map(t => [t.id, t]));
        const refreshed = [];
        const teams = round.teams.map(t => {
          const f = labels.get(t.id);
          if (!f) return t;
          refreshed.push(t.name);
          return { ...t, league: f.hint || t.league || '', division: f.division, grade: f.grade };
        });
        await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
        return { refreshed: { teams: refreshed.length, missing: round.teams.filter(t => !labels.has(t.id)).map(t => t.name) } };
      }
      if (found.teams.length > MAX_TEAMS) throw new HttpError(400, `At most ${MAX_TEAMS} teams.`);
      const picks = body.regions && typeof body.regions === 'object' ? body.regions : {};
      const missing = [];
      for (const t of found.teams) {
        const region = REGION_IDS.includes(picks[t.id]) ? picks[t.id] : t.region;
        if (!REGION_IDS.includes(region)) missing.push(t.name); else t.region = region;
      }
      if (missing.length) throw new HttpError(400, `Pick a time zone for: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.`);
      const teams = found.teams.map(t => ({ id: t.id, name: t.name, region: t.region, slot: '', captain: '', captainName: '', division: t.division, grade: t.grade, league: t.hint || '' }));
      const existing = new Set(signups.map(s => s.key));
      const now = new Date().toISOString();
      const commands = [['SET', KEYS.round, JSON.stringify({ ...round, teams })], ['DEL', KEYS.assign]];
      let placed = 0;
      const placedOn = new Map();   // a rider listed on several sheet teams rides for each
      for (const t of found.teams) {
        for (const r of t.riders) {
          if (!existing.has(r.key)) {
            const entry = { name: r.name, zwid: r.zwid, in: true, cat: r.cat, regions: [t.region], preferred: '', captain: false, comments: 'Imported from the sheet', ts: now, source: 'sheet' };
            commands.push(['HSET', KEYS.signups, r.key, JSON.stringify(entry)]);
            existing.add(r.key);
          }
          placedOn.set(r.key, [...(placedOn.get(r.key) || []), t.id]);
          placed++;
        }
      }
      for (const [key, ids] of placedOn) commands.push(['HSET', KEYS.assign, key, joinTeams(ids)]);
      await redis(commands);
      return { imported: { teams: teams.length, riders: placed } };
    },

    // Reads the sign-ups from the form responses tab. Without `apply` it only previews; with it, each rider gets a sign-up
    // (their own sign-ups made here are never overwritten; earlier sheet imports are refreshed).
    'POST /api/zrl/import-signups': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups } = await requireRound();
      const found = await importSignupRows(body, round);
      const existing = new Map(signups.map(x => [x.key, x]));
      const fromSheet = e => e && (e.source ? e.source === 'sheet' : e.comments === 'Imported from the sheet');   // staff edits and riders' own sign-ups are never overwritten
      const mine = found.rows.filter(r => existing.has(r.key) && !fromSheet(existing.get(r.key)));
      const summary = { riders: found.rows.length, keptOwn: mine.length, noId: found.rows.filter(r => !r.zwid).length,
        regions: Object.fromEntries(REGION_IDS.map(id => [id, found.rows.filter(r => r.regions.includes(id)).length])),
        captains: found.rows.filter(r => r.captain).length, reserves: found.rows.filter(r => r.commit === 'reserve').length };
      if (body.apply !== true) return { preview: { tab: found.tab, warnings: found.warnings, summary, sample: found.rows.slice(0, 8) } };
      const ownKeys = new Set(mine.map(r => r.key));
      const commands = [];
      for (const r of found.rows) {
        if (ownKeys.has(r.key)) continue;
        const old = existing.get(r.key);
        const entry = {
          name: r.name, zwid: r.zwid, in: true, cat: r.cat || (old && old.cat) || '',
          regions: [...new Set([...r.regions, ...((old && old.regions) || [])])],
          preferred: r.preferred, captain: r.captain, comments: r.comments, ts: old ? old.ts : r.ts, source: 'sheet',
          league: r.league, backup: r.backup, commit: r.commit, prevTeam: r.prevTeam,
        };
        commands.push(['HSET', KEYS.signups, r.key, JSON.stringify(entry)]);
      }
      if (commands.length) await redis(commands);
      return { imported: { signups: commands.length, keptOwn: mine.length } };
    },

    'POST /api/zrl/signup': async (req, body) => {
      const { round } = await requireRound();
      if (!round.open) throw new HttpError(409, 'ZRL sign-ups are closed.');
      const who = identify(req, body);
      const racing = body.in !== false;
      const regions = [...new Set(Array.isArray(body.regions) ? body.regions : [])].filter(r => REGION_IDS.includes(r));
      if (racing && !regions.length) throw new HttpError(400, 'Pick at least one time zone you can race in.');
      const cat = CATS.includes(body.cat) ? body.cat : (who.zwid ? await categoryFor(who.zwid) : '');
      const teamIds = new Set(round.teams.map(t => t.id));
      const key = keyOf(who);
      const [existing] = await redis([['HGET', KEYS.signups, key]]);
      const entry = {
        name: who.name, zwid: who.zwid, in: racing, cat, regions: racing ? regions : [],
        preferred: racing && teamIds.has(body.preferred) ? body.preferred : '',
        also: racing && Array.isArray(body.also) ? [...new Set(body.also)].filter(id => teamIds.has(id) && id !== body.preferred).slice(0, 5) : [],   // other teams they ask to ride for too; staff decide
        captain: racing && body.captain === true,
        comments: text(body.comments, 'comment', 300, false),
        ts: existing ? JSON.parse(existing).ts : new Date().toISOString(), // updating keeps your place
      };
      await redis([['HSET', KEYS.signups, key, JSON.stringify(entry)]]);
    },

    // Suggests (or, with `apply`, makes) team places for every rider who has none. Staff can move anyone afterwards.
    'POST /api/zrl/auto-assign': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      if (!round.teams.length) throw new HttpError(409, 'Add teams first (type them in, or import the team board).');
      const plan = planAssignments({ teams: round.teams, signups, assign, rosterSize: round.rosterSize });
      const summary = { toPlace: plan.moves.length + plan.unplaced.length, placed: plan.moves.length, unplaced: plan.unplaced.length };
      if (body.apply !== true) return { plan: { ...plan, summary } };
      const names = await riderNames();
      const commands = plan.moves.map(m => ['HSET', KEYS.assign, m.key, m.team]);
      const teams = round.teams.map(t => (plan.captains[t.id] && !t.captain
        ? { ...t, captain: plan.captains[t.id].zwid, captainName: names.get(plan.captains[t.id].zwid) || plan.captains[t.id].name } : t));
      commands.push(['SET', KEYS.round, JSON.stringify({ ...round, teams })]);
      await redis(commands);
      return { assigned: { placed: plan.moves.length, unplaced: plan.unplaced.length } };
    },

    // Staff: everything the readiness list can sort out by itself, as a preview (default) or applied. `only` limits it to some of the checks.
    'POST /api/zrl/fix': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const only = Array.isArray(body.only) ? body.only.filter(id => FIX_IDS.includes(id)) : undefined;
      if (only && !only.length) throw new HttpError(400, 'Nothing there can be fixed automatically.');
      const r = await autoFix({ apply: body.apply === true, only, fallbackCaptain: body.fallbackCaptain !== false, by: 'staff' });
      return body.apply === true ? { applied: r } : { plan: r };
    },

    // Staff: switch the automatic steps on or off (place riders when sign-ups close; fill line-ups two days before a race).
    'POST /api/zrl/auto-settings': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const autoFix = { place: body.place !== false, lineups: body.lineups !== false };
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, autoFix })]]);
      return { autoFix };
    },

    // Puts one rider on a team, or back in the pool with an empty team.
    'POST /api/zrl/assign': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const key = String(body.key || '');
      if (!signups.some(x => x.key === key)) throw new HttpError(404, 'That rider has not signed up for this round.');
      const team = String(body.team || '');
      if (team && !round.teams.some(t => t.id === team)) throw new HttpError(400, 'That team does not exist.');
      // `team` alone puts the rider on that team only (an empty team takes them off every team); `add` and `remove` change one team and
      // leave the rest, for riders who ride for several teams.
      const now = teamsOf(assign[key]);
      let next;
      if (body.add === true) next = [...now, team];
      else if (body.remove === true) next = now.filter(id => id !== team);
      else next = team ? [team] : [];
      if (body.add === true && !team) throw new HttpError(400, 'Pick a team to add.');
      const racer = signups.find(x => x.key === key);
      if (team && racer && racer.in) for (const id of next) requireRoom(round, signups, assign, id, key);
      await redis([next.length ? ['HSET', KEYS.assign, key, joinTeams(next)] : ['HDEL', KEYS.assign, key]]);
    },

    // Staff override: add a rider, or change anything about a sign-up (even name or Zwift ID, which moves their team place with them).
    // Edits are marked `source: 'staff'`, so a later sheet import never undoes them.
    // Staff: pick a team's captain from its own riders (or clear it with an empty key). The captain is stored by Zwift ID.
    'POST /api/zrl/captain': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const team = round.teams.find(t => t.id === String(body.team || ''));
      if (!team) throw new HttpError(404, 'That team does not exist.');
      const key = String(body.key || '');
      let captain = '', captainName = '';
      if (key) {
        const rider = signups.find(x => x.key === key);
        if (!rider || !inTeam(assign[key], team.id)) throw new HttpError(400, 'The captain must be a rider on that team.');
        if (!rider.zwid) throw new HttpError(400, `${rider.name} has no Zwift ID yet. Add it with the ✏️ button first.`);
        captain = rider.zwid;
        captainName = (await riderNames()).get(captain) || rider.name;
      }
      const teams = round.teams.map(t => (t.id === team.id ? { ...t, captain, captainName, captainLocked: !key } : t));   // an empty choice is deliberate: no auto-pick
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
    },

    // Staff: set the captain of several teams at once, [{team, key}]. All or nothing: one bad pick changes nothing.
    'POST /api/zrl/captains': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const picks = Array.isArray(body.picks) ? body.picks : [];
      if (!picks.length) throw new HttpError(400, 'Choose at least one captain.');
      const names = await riderNames();
      const chosen = new Map();
      for (const p of picks) {
        const team = round.teams.find(t => t.id === String(p && p.team || ''));
        if (!team) throw new HttpError(404, 'One of those teams does not exist.');
        const rider = signups.find(x => x.key === String(p.key || ''));
        if (!rider || !inTeam(assign[rider.key], team.id)) throw new HttpError(400, `${team.name}: the captain must be a rider on that team.`);
        if (!rider.zwid) throw new HttpError(400, `${rider.name} has no Zwift ID yet. Add it with the ✏️ button first.`);
        chosen.set(team.id, { captain: rider.zwid, captainName: names.get(rider.zwid) || rider.name });
      }
      const teams = round.teams.map(t => (chosen.has(t.id) ? { ...t, ...chosen.get(t.id), captainLocked: false } : t));
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
      return { set: chosen.size };
    },

    'POST /api/zrl/signup-edit': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const oldKey = body.key ? String(body.key) : '';
      const old = oldKey ? signups.find(x => x.key === oldKey) : null;
      if (oldKey && !old) throw new HttpError(404, 'That rider has not signed up for this round.');
      const name = text(body.name === undefined && old ? old.name : body.name, 'name', 60).replace(/\s+/g, ' ');
      const zwidRaw = body.zwid === undefined && old ? old.zwid : String(body.zwid || '').trim();
      if (zwidRaw && !/^\d{1,12}$/.test(zwidRaw)) throw new HttpError(400, 'A Zwift ID is numbers only.');
      const zwid = zwidRaw || '';
      const key = zwid || name.toLowerCase();
      if (key !== oldKey && signups.some(x => x.key === key)) throw new HttpError(409, `${name} already has a sign-up. Edit that one instead.`);
      const given = (field, fallback) => (body[field] !== undefined ? body[field] : (old && old[field] !== undefined ? old[field] : fallback));
      const racing = given('in', true) !== false;
      const regions = [...new Set((Array.isArray(body.regions) ? body.regions : (old ? old.regions : [])).filter(r => REGION_IDS.includes(r)))];
      if (racing && !regions.length) throw new HttpError(400, 'Pick at least one time zone for a rider who is racing.');
      const cat = String(given('cat', '') || '');
      if (cat && !CATS.includes(cat)) throw new HttpError(400, 'Category must be A to E.');
      const commit = String(given('commit', 'full') || 'full');   // a rider's own sign-up has no commitment stored
      if (!['full', 'reserve'].includes(commit)) throw new HttpError(400, 'Commitment must be full season or reserve.');
      const preferred = String(given('preferred', '') || '');
      if (preferred && !round.teams.some(t => t.id === preferred)) throw new HttpError(400, 'That preferred team does not exist.');
      const team = body.team === undefined ? undefined : String(body.team || '');
      if (team && !round.teams.some(t => t.id === team)) throw new HttpError(400, 'That team does not exist.');
      const entry = {
        ...(old || {}), name, zwid, in: racing, cat, commit, regions: racing ? regions : (old ? old.regions : regions), preferred,
        captain: racing && given('captain', false) === true,
        devOk: given('devOk', false) === true,
        comments: text(given('comments', ''), 'comment', 300, false),
        ts: old ? old.ts : new Date().toISOString(), source: 'staff', edited: new Date().toISOString(),
      };
      delete entry.key;
      const commands = [];
      if (key !== oldKey && oldKey) commands.push(['HDEL', KEYS.signups, oldKey]);
      commands.push(['HSET', KEYS.signups, key, JSON.stringify(entry)]);
      if (team && racing) requireRoom(round, signups, assign, team, oldKey || key);
      const placed = team !== undefined ? team : joinTeams(teamsOf(assign[oldKey]));
      if (oldKey && key !== oldKey) commands.push(['HDEL', KEYS.assign, oldKey]);
      if (placed) commands.push(['HSET', KEYS.assign, key, placed]);
      else if (team === '') commands.push(['HDEL', KEYS.assign, key]);
      await redis(commands);
    },

    'POST /api/zrl/signup-remove': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { signups } = await requireRound();
      const key = String(body.key || '');
      if (!signups.some(x => x.key === key)) throw new HttpError(404, 'That rider has not signed up for this round.');
      await redis([['HDEL', KEYS.signups, key], ['HDEL', KEYS.assign, key]]);
    },

    // A rider says whether they can race a week (yes / maybe / no, or '' to clear). Captains and staff can answer for a rider.
    'POST /api/zrl/availability': async (req, body) => {
      const { round, signups, assign } = await requireRound();
      const staff = isStaff(req), member = memberFromRequest(req);
      if (!staff && !member) throw new HttpError(401, 'Sign in with your cryogen.team account first.');
      const week = weekOf(round, body);
      const status = String(body.status || '');
      if (status && !AVAIL.includes(status)) throw new HttpError(400, 'Choose yes, maybe or no.');
      const zwid = String(body.zwid || (member && member.zwid) || '');
      const rider = signups.find(x => x.in && x.zwid && x.zwid === zwid);
      const riderTeams = rider ? round.teams.filter(t => inTeam(assign[rider.key], t.id)) : [];
      if (!riderTeams.length) throw new HttpError(400, 'That rider is not on a team yet.');
      if (!staff && zwid !== member.zwid && !riderTeams.some(t => t.captain === member.zwid)) throw new HttpError(403, 'Only the rider, their captain or the staff can change this.');
      // With a team the answer is for that team only; without one it is for all their teams and replaces any team-by-team answers.
      const teamId = String(body.team || '');
      const team = teamId ? riderTeams.find(t => t.id === teamId) : null;
      if (teamId && !team) throw new HttpError(400, 'That rider is not on that team.');
      if (team && !staff && zwid !== member.zwid && team.captain !== member.zwid) throw new HttpError(403, 'Only the rider, that team\'s captain or the staff can change this.');
      const field = team ? `a:${week}:${zwid}:${team.id}` : `a:${week}:${zwid}`;
      const commands = [status ? ['HSET', KEYS.weekly, field, status] : ['HDEL', KEYS.weekly, field]];
      if (!team) for (const t of riderTeams) commands.push(['HDEL', KEYS.weekly, `a:${week}:${zwid}:${t.id}`]);
      await redis(commands);
    },

    // The captain (or staff) picks who races a week: only riders on the team with a Zwift ID, no more than the number who race, nobody who said no.
    'POST /api/zrl/lineup': async (req, body) => {
      const { round, signups, assign } = await requireRound();
      const staff = isStaff(req), member = memberFromRequest(req);
      if (!staff && !member) throw new HttpError(401, 'Sign in with your cryogen.team account first.');
      const week = weekOf(round, body);
      const team = round.teams.find(t => t.id === String(body.team || ''));
      if (!team) throw new HttpError(404, 'That team does not exist.');
      if (!staff && team.captain !== member.zwid) throw new HttpError(403, 'Only the team captain or the staff can pick the line-up.');
      const weekly = await loadWeekly();
      let picked = body.zwids;
      if (body.auto === true) {   // "Pick for me": keep who is already picked, then fill with yes, then maybe, then no answer; never someone who said no
        const rank = st => (st === 'yes' ? 0 : st === 'maybe' ? 1 : 2);
        const pool = signups.filter(x => x.in && x.zwid && inTeam(assign[x.key], team.id));
        const have = (weekly.lineup[`${week}:${team.id}`] || []).filter(z => pool.some(x => x.zwid === z));
        const info = await rosterInfo();
        const more = pool.filter(x => !have.includes(x.zwid) && availOf(weekly, week, x.zwid, team.id) !== 'no')
          .sort((a, b) => rank(availOf(weekly, week, a.zwid, team.id)) - rank(availOf(weekly, week, b.zwid, team.id)) || (info.ratings.get(b.zwid) || 0) - (info.ratings.get(a.zwid) || 0) || a.name.localeCompare(b.name))
          .slice(0, Math.max(round.racing - have.length, 0)).map(x => x.zwid);
        picked = [...have, ...more];
      }
      const zwids = [...new Set((Array.isArray(picked) ? picked : []).map(String))];
      if (zwids.length > round.racing) throw new HttpError(400, `Pick at most ${round.racing} riders.`);
      for (const z of zwids) {
        const rider = signups.find(x => x.in && x.zwid === z && inTeam(assign[x.key], team.id));
        if (!rider) throw new HttpError(400, 'Every rider picked must be on this team and have a Zwift ID.');
        if (availOf(weekly, week, z, team.id) === 'no') throw new HttpError(400, `${rider.name} said they cannot race that week.`);
      }
      const field = `l:${week}:${team.id}`;
      await redis([zwids.length ? ['HSET', KEYS.weekly, field, JSON.stringify(zwids)] : ['HDEL', KEYS.weekly, field]]);
      return { zwids, short: Math.max(round.racing - zwids.length, 0) };
    },

    // Staff: per week and team, the line-up picked and how many riders said yes, maybe or no.
    'GET /api/zrl/weekly': async req => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const weekly = await loadWeekly();
      const teams = round.teams.filter(t => signups.some(x => x.in && inTeam(assign[x.key], t.id)));
      return {
        racing: round.racing,
        weeks: Array.from({ length: round.weeks }, (_, i) => ({
          i, date: weekDate(round, i),
          teams: teams.map(t => {
            const riders = signups.filter(x => x.in && x.zwid && inTeam(assign[x.key], t.id));
            const count = st => riders.filter(x => availOf(weekly, i, x.zwid, t.id) === st).length;
            return { id: t.id, name: t.name, riders: riders.length, lineup: (weekly.lineup[`${i}:${t.id}`] || []).length, yes: count('yes'), maybe: count('maybe'), no: count('no') };
          }),
        })),
      };
    },

    // The captain (or staff) marks a team as registered on WTRL, or takes the mark off.
    'POST /api/zrl/wtrl-registered': async (req, body) => {
      const { round } = await requireRound();
      const staff = isStaff(req), member = memberFromRequest(req);
      if (!staff && !member) throw new HttpError(401, 'Sign in with your cryogen.team account first.');
      const team = round.teams.find(t => t.id === String(body.team || ''));
      if (!team) throw new HttpError(404, 'That team does not exist.');
      if (!staff && team.captain !== member.zwid) throw new HttpError(403, 'Only the team captain or the staff can say a team is registered.');
      await redis([body.registered === false ? ['HDEL', KEYS.weekly, `r:${team.id}`] : ['HSET', KEYS.weekly, `r:${team.id}`, new Date().toISOString()]]);
    },

    // Staff: the WTRL registration deadline (a date, or empty to remove it). It ends at 23:00 UK time on that day, like the sign-up close.
    'POST /api/zrl/wtrl-deadline': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const date = String(body.date || '');
      if (date && !validDate(date)) throw new HttpError(400, 'The deadline must be a real date, like 2026-11-10.');
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, wtrlDeadline: date ? new Date(ukTime(date, 23)).toISOString() : null })]]);
    },

    // Subs finder for one team and race week: who is on the bench (their own riders not in the line-up and not saying no), and
    // riders with no team who could fill a place (racing, in the team's time zone, category allowed). Captain or staff.
    'GET /api/zrl/subs': async (req, _body, query = {}) => {
      const { round, signups, assign } = await requireRound();
      const staff = isStaff(req), member = memberFromRequest(req);
      if (!staff && !member) throw new HttpError(401, 'Sign in with your cryogen.team account first.');
      const team = round.teams.find(t => t.id === String(query.team || ''));
      if (!team) throw new HttpError(404, 'That team does not exist.');
      if (!staff && team.captain !== member.zwid) throw new HttpError(403, 'Only the team captain or the staff can look for subs.');
      const week = weekOf(round, { week: query.week });
      const weekly = await loadWeekly();
      const lineup = weekly.lineup[`${week}:${team.id}`] || [];
      const rank = st => (st === 'yes' ? 0 : st === 'maybe' ? 1 : st === '' ? 2 : 3);
      const mine = signups.filter(x => x.in && inTeam(assign[x.key], team.id));
      const bench = mine.filter(x => x.zwid && !lineup.includes(x.zwid) && availOf(weekly, week, x.zwid, team.id) !== 'no')
        .map(x => ({ name: x.name, cat: x.cat || '', status: availOf(weekly, week, x.zwid, team.id) }))
        .sort((a, b) => rank(a.status) - rank(b.status) || a.name.localeCompare(b.name));
      const tcat = teamCat(team);
      const pool = signups.filter(x => x.in && !assign[x.key] && (x.regions || []).includes(team.region) && (!x.cat || !tcat || catGap(x.cat, tcat) >= 0))
        .map(x => ({ name: x.name, cat: x.cat || '', hasId: !!x.zwid, ...(staff ? { key: x.key } : {}) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { team: team.name, week, date: weekDate(round, week), racing: round.racing, picked: lineup.length, short: Math.max(0, round.racing - lineup.length),
        rosterFull: mine.length >= round.rosterSize, bench, pool };
    },

    // ── Past rounds (staff): list, look at, rename, correct results, delete ──
    'GET /api/zrl/archive': async (req, _body, query = {}) => {
      requireRole(req, ['admin', 'mod']);
      if (!query.id) {
        const [raw] = await redis([['HGETALL', KEYS.archive]]);
        return { rounds: pairs(raw).map(([id, v]) => {
          const a = JSON.parse(v);
          return { id, name: a.round.name, start: a.round.start, weeks: a.round.weeks, teams: a.round.teams.length, riders: Object.keys(a.assign || {}).length };
        }).sort((x, y) => y.start.localeCompare(x.start)) };
      }
      const a = await loadArchived(query.id);
      const members = {};
      a.signups.filter(x => x.in).forEach(x => teamsOf(a.assign[x.key]).forEach(id => (members[id] = members[id] || []).push(x.name)));
      return {
        id: a.round.id, name: a.round.name, start: a.round.start, weeks: a.round.weeks,
        teams: a.round.teams.map(t => ({ id: t.id, name: t.name, division: t.division, captainName: t.captainName || '', riders: (members[t.id] || []).sort() })),
        standings: standingsOf(a.round, a.results || {}, true),
      };
    },

    'POST /api/zrl/archive-edit': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const a = await loadArchived(body.id);
      if (body.name !== undefined) a.round.name = text(body.name, 'round name', 60);
      if (body.rows !== undefined) {
        const results = { ...(a.results || {}) };
        resultEdits(a.round, weekOf(a.round, body), body.rows).forEach(e => { if (e.value) results[e.field] = e.value; else delete results[e.field]; });
        a.results = results;
      }
      await redis([['HSET', KEYS.archive, a.round.id, JSON.stringify({ round: a.round, signups: a.signups, assign: Object.fromEntries(Object.entries(a.assign).map(([k, v]) => [k, joinTeams(v)])), weekly: a.weekly, results: a.results })]]);
    },

    // Admin only: remove a past round for good, or the current round (say its id to confirm), with everything stored for it.
    'POST /api/zrl/archive-delete': async (req, body) => {
      requireRole(req, ['admin']);
      const id = String(body.id || '');
      await loadArchived(id);
      await redis([['HDEL', KEYS.archive, id]]);
    },

    'POST /api/zrl/round-delete': async (req, body) => {
      requireRole(req, ['admin']);
      const { round } = await requireRound();
      if (String(body.confirm || '') !== round.id) throw new HttpError(400, `To delete the current round, confirm its start date (${round.id}).`);
      const [sentKeys] = await redis([['HKEYS', KEYS.sent]]);
      const mine = (sentKeys || []).filter(f => f.startsWith(`${round.id}:`));
      await redis([['DEL', KEYS.round], ['DEL', KEYS.signups], ['DEL', KEYS.assign], ['DEL', KEYS.weekly], ['DEL', KEYS.results], ...mine.map(f => ['HDEL', KEYS.sent, f])]);
    },

    'POST /api/zrl/withdraw': async (req, body) => {
      await requireRound();
      const who = identify(req, body);
      const keys = [...new Set([keyOf(who), who.name.toLowerCase()])];
      await redis(keys.flatMap(k => [['HDEL', KEYS.signups, k], ['HDEL', KEYS.assign, k]]));
    },
  };

  return { routes, mirrorRows, teamCat, catGap, view, load, loadWeekly, loadResults, logChange, runSchedule, parseBoard, parseSignups, planAssignments, myZrl, healthRow, readiness, planFixes, autoFix, availOf, afterChange, REGIONS, KEYS, regionName };
};
