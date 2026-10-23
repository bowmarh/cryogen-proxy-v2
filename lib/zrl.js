'use strict';
// ZRL (Zwift Racing League) round management: riders sign up for a round once, saying which
// time zones they can race; staff set up the teams; the dashboard shows demand per time zone.
// Lives outside api/ on purpose: every file in api/ becomes a public serverless function.
// Everything the module needs from the server is passed in, so there is no circular require.

module.exports = function createZrl(deps) {
  const { redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, identify, discord, discordEscape, fetchRoster, validDate, ukTime, ukLabel, teamId, fetchGrid, siteUrl } = deps;

  const KEYS = {
    round: 'cg:zrl:round',       // JSON: the current round and its teams
    signups: 'cg:zrl:signups',   // field "<zwid, or lowercase name>" -> sign-up JSON
    assign: 'cg:zrl:assign',     // field "<same key>" -> team id (filled in by team forming)
    archive: 'cg:zrl:archive',   // field "<round id>" -> { round, signups, assign }
    weekly: 'cg:zrl:weekly',     // "a:<week>:<zwid>" -> yes|maybe|no; "l:<week>:<team id>" -> JSON array of the Zwift IDs racing; "r:<team id>" -> time marked registered on WTRL
    results: 'cg:zrl:results',   // field "<week>:<team id>" -> JSON {pos, pts, note}: how the team finished and the points it scored
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

  async function load() {
    const [round, signups, assign, archiveIds, weekly] = await redis([
      ['GET', KEYS.round], ['HGETALL', KEYS.signups], ['HGETALL', KEYS.assign], ['HKEYS', KEYS.archive], ['HGETALL', KEYS.weekly],
    ]);
    return {
      weekly: parseWeekly(weekly),
      round: round ? JSON.parse(round) : null,
      signups: pairs(signups).map(([key, v]) => ({ key, ...JSON.parse(v) })).sort((a, b) => a.ts.localeCompare(b.ts)),
      assign: Object.fromEntries(pairs(assign)),
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
      return { field: `${week}:${team.id}`, value: pos === null && pts === null && !note ? null : { pos, pts, note } };
    });
  }
  async function loadArchived(id) {
    const [raw] = await redis([['HGET', KEYS.archive, String(id || '')]]);
    if (!raw) throw new HttpError(404, 'There is no archived round with that id.');
    const a = JSON.parse(raw);
    return { ...a, signups: a.signups || [], assign: a.assign || {} };
  }
  // Standings: per division (or league), our teams ranked by total points, then best finish. Ties share a rank.
  function standingsOf(round, results, staff) {
    const groups = new Map();
    for (const t of round.teams) {
      const weeks = Array.from({ length: round.weeks }, (_, i) => { const r = results[`${i}:${t.id}`]; return r && (r.pos || r.pts !== undefined && r.pts !== null) ? { pos: r.pos || null, pts: r.pts ?? null } : null; });
      if (!weeks.some(Boolean)) continue;
      const total = weeks.reduce((n, w) => n + ((w && w.pts) || 0), 0), pos = weeks.filter(w => w && w.pos).map(w => w.pos);
      const name = t.division || t.league || 'All teams';
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push({ id: t.id, name: t.name, total, races: weeks.filter(Boolean).length, best: pos.length ? Math.min(...pos) : null, weeks });
    }
    return {
      dates: Array.from({ length: round.weeks }, (_, i) => weekDate(round, i)),
      groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([name, teams]) => {
        teams.sort((a, b) => b.total - a.total || (a.best ?? 999) - (b.best ?? 999) || a.name.localeCompare(b.name));
        teams.forEach((t, i) => { t.rank = i > 0 && teams[i - 1].total === t.total && teams[i - 1].best === t.best ? teams[i - 1].rank : i + 1; });
        return { name, teams };
      }),
      ...(staff ? { entries: results } : {}),
    };
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

  function planAssignments({ teams, signups, assign, rosterSize = ROSTER_SIZE }) {
    const members = Object.fromEntries(teams.map(t => [t.id, 0]));
    for (const id of Object.values(assign)) if (id in members) members[id]++;
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
  const csvCell = v => {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;   // a name must never run as a spreadsheet formula
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };

  function buildExport({ round, signups, assign }) {
    const bySignup = new Map(signups.map(x => [x.key, x]));
    const teams = round.teams.map(t => {
      const riders = signups.filter(x => x.in && assign[x.key] === t.id)
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
  function myZrl({ round, signups, assign }, member, weekly = { avail: {}, lineup: {} }) {
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
      weeks: weeks(t).map(w => ({ ...w, riders: t.riders.filter(r => r.zwid).map(r => ({ zwid: r.zwid, name: r.name, status: weekly.avail[`${w.i}:${r.zwid}`] || '' })) })),
    }));
    const teamId = own && assign[own.key];
    const team = teamId && round.published ? full.teams.find(t => t.id === teamId) : null;
    return {
      round: { name: round.name, start: round.start, weeks: round.weeks, racing: round.racing, rosterSize: round.rosterSize, published: !!round.published, open: !!round.open, wtrlDeadline: round.wtrlDeadline || null },
      signup: own ? { in: own.in, regions: own.regions, cat: own.cat, commit: own.commit || 'full' } : null,
      placed: !!teamId,
      team: team ? shape(team, false) : null,
      // Published teams only: this rider's own answer for each week, and whether the captain has picked them.
      weeks: team ? weeks(team).map(w => ({ i: w.i, date: w.date, mine: weekly.avail[`${w.i}:${member.zwid}`] || '', picked: w.lineup.includes(member.zwid),
        lineupSet: w.lineup.length > 0, lineup: w.lineup.map(z => (team.riders.find(r => r.zwid === z) || {}).name).filter(Boolean) })) : [],
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
        ? { name: s.name, zwid: s.zwid, in: s.in, cat: s.cat, regions: s.regions, preferred: s.preferred, captain: s.captain, comments: s.comments, ts: s.ts, key: s.key, league: s.league, backup: s.backup, commit: s.commit, prevTeam: s.prevTeam, source: s.source }
        : { name: s.name, in: s.in, cat: s.cat, regions: s.regions, captain: s.captain, key: s.key })),
      demand: demandOf(round, data.signups),
      assign: staff ? data.assign : undefined,
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
        }
        done.push(`zrl-${event}`);
      }
    }
    // WTRL deadline in three days: the admin channel lists the teams not yet marked registered (once).
    if (round.published && round.wtrlDeadline) {
      const deadline = Date.parse(round.wtrlDeadline);
      if (now >= deadline - 3 * 86400000 && now < deadline) {
        const open = round.teams.filter(t => data.signups.some(x => x.in && data.assign[x.key] === t.id) && !data.weekly.reg[t.id]);
        if (open.length && await claim(`${round.id}:wtrl3`)) {
          await postWtrlNudge(round, open);
          done.push('zrl-wtrl');
        }
      }
    }
    // Race weeks (once the rosters are out): five days before, ask the riders whether they can race; two days before, tell the
    // captains' channel which teams have not picked a full line-up. Each fires once per week, and only until that race day starts.
    if (round.published) {
      const playing = round.teams.filter(t => data.signups.some(x => x.in && data.assign[x.key] === t.id));
      for (let i = 0; i < round.weeks; i++) {
        const race = Date.parse(`${weekDate(round, i)}T00:00:00Z`);
        if (now >= race) continue;
        if (now >= race - 5 * 86400000 && await claim(`${round.id}:w${i}:avail`)) {
          await postAvailability(round, i);
          done.push(`zrl-avail-${i + 1}`);
        }
        if (now >= race - 2 * 86400000) {
          const weekly = await loadWeekly();
          const short = playing.filter(t => (weekly.lineup[`${i}:${t.id}`] || []).length < round.racing);
          // Everyone sorted: nothing to say, and the claim stays free in case a line-up is cleared before the race.
          if (short.length && await claim(`${round.id}:w${i}:lineup`)) {
            await postLineupNudge(round, i, short);
            done.push(`zrl-lineup-${i + 1}`);
          }
        }
      }
    }
    return done;
  }

  // One row for the admin health panel: [status, detail] for "is the ZRL round in a state that needs someone's attention?".
  function healthRow(data, now = Date.now()) {
    const { round, signups, assign } = data;
    if (!round) return ['info', 'No ZRL round yet. Start one in the ZRL tab when the next round opens.'];
    const racing = signups.filter(x => x.in);
    const byZone = REGIONS.map(r => `${r.name.slice(0, 2).toUpperCase()} ${racing.filter(x => x.regions.includes(r.id)).length}`).join(' · ');
    const ids = new Set(round.teams.map(t => t.id));
    const placed = racing.filter(x => ids.has(assign[x.key])).length;
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
      const withRiders = round.teams.filter(t => racing.some(x => assign[x.key] === t.id));
      const bare = withRiders.filter(t => !t.captain).length, noTime = withRiders.filter(t => !t.slot).length;
      if (bare) issues.push(n(bare, `team${bare === 1 ? ' has' : 's have'} no captain.`));
      if (noTime) issues.push(n(noTime, `team${noTime === 1 ? ' has' : 's have'} riders but no race time.`));
    }
    // WTRL registration: once a deadline is set, the teams whose captain has not said they registered.
    if (round.wtrlDeadline && data.weekly && (round.published || !round.open)) {
      const deadline = Date.parse(round.wtrlDeadline);
      const playing = round.teams.filter(t => racing.some(x => assign[x.key] === t.id));
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
        const playing = round.teams.filter(t => racing.some(x => assign[x.key] === t.id));
        const short = playing.filter(t => (data.weekly.lineup[`${i}:${t.id}`] || []).length < round.racing).length;
        if (short) issues.push(n(short, `team${short === 1 ? ' has' : 's have'} not picked a full line-up for race ${i + 1} (${weekDate(round, i)}).`));
      }
    }
    if (issues.length) return ['warn', `${state} ${issues.join(' ')}`];
    return ['ok', `${state}${round.open && !Number.isNaN(closes) ? ` Closes ${ukLabel(closes)}.` : ''}`];
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
      const volunteer = signups.filter(x => x.in && x.captain && x.zwid && assign[x.key] === t.id).sort((a, b) => String(a.ts).localeCompare(String(b.ts)))[0];
      if (!volunteer) { teams.push(t); continue; }
      names = names || await riderNames();
      teams.push({ ...t, captain: volunteer.zwid, captainName: names.get(volunteer.zwid) || volunteer.name });
      changed = true;
    }
    if (changed) await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
    return changed;
  }

  // ── Routes ─────────────────────────────────────────────────
  async function categoryFor(zwid) {
    try {
      const { riders } = await fetchRoster();
      const r = riders.find(x => String(x.riderId) === String(zwid));
      const cat = r && String(r.zpCategory || '').replace('+', '');
      return CATS.includes(cat) ? cat : '';
    } catch (e) { return ''; }
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
      return myZrl(data, member, data.weekly);
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
        const snapshot = { round: current.round, signups: current.signups, assign: current.assign, weekly: await loadWeekly(), results: await loadResults() };
        commands.push(['HSET', KEYS.archive, current.round.id, JSON.stringify(snapshot)]);
      }
      // Teams always carry over (name, zone, league, division, grade). Race times follow the league colour for the new dates and
      // captains are cleared, unless the riders carry over too: then each rider on a team stays there, and a captain who is still
      // on their team stays captain. Carried riders are marked `carried`, and the rider can still change their own sign-up.
      const carry = body.carryRiders === true && !!current.round;
      const stays = new Map();   // rider key -> team id
      const carried = carry ? current.signups.filter(x => x.in && current.assign[x.key]) : [];
      carried.forEach(x => stays.set(x.key, current.assign[x.key]));
      const teams = current.round ? current.round.teams.map(t => {
        const kept = carry && t.captain && carried.some(x => x.zwid === t.captain && stays.get(x.key) === t.id);
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
        commands.push(['HSET', KEYS.signups, key, JSON.stringify({ ...rest, carried: true })], ['HSET', KEYS.assign, key, stays.get(key)]);
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

    // Everyone: the standings so far (staff also get the raw entries, with notes, for the entry form).
    'GET /api/zrl/standings': async req => {
      const { round } = await load();
      if (!round) return { dates: [], groups: [] };
      return standingsOf(round, await loadResults(), isStaff(req));
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
      const placed = teams.reduce((n, t) => n + signups.filter(x => x.in && assign[x.key] === t.id).length, 0);
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
      const drop = Object.entries(assign).filter(([, id]) => !valid.has(id)).map(([k]) => ['HDEL', KEYS.assign, k]);
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
      for (const t of found.teams) {
        for (const r of t.riders) {
          if (!existing.has(r.key)) {
            const entry = { name: r.name, zwid: r.zwid, in: true, cat: r.cat, regions: [t.region], preferred: '', captain: false, comments: 'Imported from the sheet', ts: now, source: 'sheet' };
            commands.push(['HSET', KEYS.signups, r.key, JSON.stringify(entry)]);
            existing.add(r.key);
          }
          commands.push(['HSET', KEYS.assign, r.key, t.id]);
          placed++;
        }
      }
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

    // Puts one rider on a team, or back in the pool with an empty team.
    'POST /api/zrl/assign': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups } = await requireRound();
      const key = String(body.key || '');
      if (!signups.some(x => x.key === key)) throw new HttpError(404, 'That rider has not signed up for this round.');
      const team = String(body.team || '');
      if (team && !round.teams.some(t => t.id === team)) throw new HttpError(400, 'That team does not exist.');
      await redis([team ? ['HSET', KEYS.assign, key, team] : ['HDEL', KEYS.assign, key]]);
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
        if (!rider || assign[key] !== team.id) throw new HttpError(400, 'The captain must be a rider on that team.');
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
        if (!rider || assign[rider.key] !== team.id) throw new HttpError(400, `${team.name}: the captain must be a rider on that team.`);
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
        comments: text(given('comments', ''), 'comment', 300, false),
        ts: old ? old.ts : new Date().toISOString(), source: 'staff', edited: new Date().toISOString(),
      };
      delete entry.key;
      const commands = [];
      if (key !== oldKey && oldKey) commands.push(['HDEL', KEYS.signups, oldKey]);
      commands.push(['HSET', KEYS.signups, key, JSON.stringify(entry)]);
      const placed = team !== undefined ? team : (assign[oldKey] || '');
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
      const team = rider && round.teams.find(t => t.id === assign[rider.key]);
      if (!team) throw new HttpError(400, 'That rider is not on a team yet.');
      if (!staff && zwid !== member.zwid && team.captain !== member.zwid) throw new HttpError(403, 'Only the rider, their captain or the staff can change this.');
      const field = `a:${week}:${zwid}`;
      await redis([status ? ['HSET', KEYS.weekly, field, status] : ['HDEL', KEYS.weekly, field]]);
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
      const zwids = [...new Set((Array.isArray(body.zwids) ? body.zwids : []).map(String))];
      if (zwids.length > round.racing) throw new HttpError(400, `Pick at most ${round.racing} riders.`);
      const weekly = await loadWeekly();
      for (const z of zwids) {
        const rider = signups.find(x => x.in && x.zwid === z && assign[x.key] === team.id);
        if (!rider) throw new HttpError(400, 'Every rider picked must be on this team and have a Zwift ID.');
        if (weekly.avail[`${week}:${z}`] === 'no') throw new HttpError(400, `${rider.name} said they cannot race that week.`);
      }
      const field = `l:${week}:${team.id}`;
      await redis([zwids.length ? ['HSET', KEYS.weekly, field, JSON.stringify(zwids)] : ['HDEL', KEYS.weekly, field]]);
    },

    // Staff: per week and team, the line-up picked and how many riders said yes, maybe or no.
    'GET /api/zrl/weekly': async req => {
      requireRole(req, ['admin', 'mod']);
      const { round, signups, assign } = await requireRound();
      const weekly = await loadWeekly();
      const teams = round.teams.filter(t => signups.some(x => x.in && assign[x.key] === t.id));
      return {
        racing: round.racing,
        weeks: Array.from({ length: round.weeks }, (_, i) => ({
          i, date: weekDate(round, i),
          teams: teams.map(t => {
            const riders = signups.filter(x => x.in && x.zwid && assign[x.key] === t.id);
            const count = st => riders.filter(x => weekly.avail[`${i}:${x.zwid}`] === st).length;
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
      const mine = signups.filter(x => x.in && assign[x.key] === team.id);
      const bench = mine.filter(x => x.zwid && !lineup.includes(x.zwid) && weekly.avail[`${week}:${x.zwid}`] !== 'no')
        .map(x => ({ name: x.name, cat: x.cat || '', status: weekly.avail[`${week}:${x.zwid}`] || '' }))
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
      a.signups.filter(x => x.in && a.assign[x.key]).forEach(x => (members[a.assign[x.key]] = members[a.assign[x.key]] || []).push(x.name));
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
      await redis([['HSET', KEYS.archive, a.round.id, JSON.stringify({ round: a.round, signups: a.signups, assign: a.assign, weekly: a.weekly, results: a.results })]]);
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

  return { routes, view, load, loadWeekly, runSchedule, parseBoard, parseSignups, planAssignments, myZrl, healthRow, afterChange, REGIONS, KEYS, regionName };
};
