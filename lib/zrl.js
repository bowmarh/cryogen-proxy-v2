'use strict';
// ZRL (Zwift Racing League) round management: riders sign up for a round once, saying which
// time zones they can race; staff set up the teams; the dashboard shows demand per time zone.
// Lives outside api/ on purpose: every file in api/ becomes a public serverless function.
// Everything the module needs from the server is passed in, so there is no circular require.

module.exports = function createZrl(deps) {
  const { redis, HttpError, text, requireRole, roleFromRequest, identify, discord, discordEscape, fetchRoster, validDate, ukTime, ukLabel, teamId, siteUrl } = deps;

  const KEYS = {
    round: 'cg:zrl:round',       // JSON: the current round and its teams
    signups: 'cg:zrl:signups',   // field "<zwid, or lowercase name>" -> sign-up JSON
    assign: 'cg:zrl:assign',     // field "<same key>" -> team id (filled in by team forming)
    archive: 'cg:zrl:archive',   // field "<round id>" -> { round, signups, assign }
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
  const MAX_TEAMS = 25;

  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const isStaff = req => ['admin', 'mod'].includes(roleFromRequest(req));
  const regionName = id => (REGIONS.find(r => r.id === id) || { name: id }).name;

  async function load() {
    const [round, signups, assign, archiveIds] = await redis([
      ['GET', KEYS.round], ['HGETALL', KEYS.signups], ['HGETALL', KEYS.assign], ['HKEYS', KEYS.archive],
    ]);
    return {
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

  // ── Team list (staff) ──────────────────────────────────────
  async function riderNames() {
    try {
      const { riders } = await fetchRoster();
      return new Map(riders.map(r => [String(r.riderId), r.name]));
    } catch (e) { return new Map(); }
  }

  async function parseTeams(list) {
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
      return { id, name, region: t.region, slot: text(t.slot, 'race time', 40, false), captain, captainName: captain ? names.get(captain) || '' : '' };
    });
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
      round: { ...round, regions: REGIONS },
      signups: data.signups.map(s => (staff
        ? { name: s.name, zwid: s.zwid, in: s.in, cat: s.cat, regions: s.regions, preferred: s.preferred, captain: s.captain, comments: s.comments, ts: s.ts, key: s.key }
        : { name: s.name, in: s.in, cat: s.cat, regions: s.regions, captain: s.captain, key: s.key })),
      demand: demandOf(round, data.signups),
      archive: data.archive,
      role: roleFromRequest(req) || null,
    };
  }

  // ── Discord ────────────────────────────────────────────────
  const demandLines = demand => demand.regions
    .filter(r => r.riders || r.teams)
    .map(r => `• **${discordEscape(r.name)}**: ${r.riders} rider${r.riders === 1 ? '' : 's'}${r.teams ? `, ${r.teams} team${r.teams === 1 ? '' : 's'} (${r.places} places)` : ''}`)
    .join('\n');

  const postOpen = round => discord('public', {
    content: `🏁 **ZRL ${discordEscape(round.name)}: sign-ups are open!**\nIt takes a minute: sign in at ${siteUrl} → 🚀 ZRL, tick the time zones you can race, done.${round.closesAt ? `\nSign-ups close **${ukLabel(Date.parse(round.closesAt))}**.` : ''}\nHelp us fill every team, and let's grow our Asia-Pacific races too. 🌏`,
  });

  const postReminder = (round, signups) => {
    const demand = demandOf(round, signups);
    return discord('public', {
      content: `⏰ **ZRL ${discordEscape(round.name)}: sign-ups close in 24 hours.** ${demand.riders} rider${demand.riders === 1 ? ' is' : 's are'} in so far.\n${demandLines(demand)}\nSign up at ${siteUrl} → 🚀 ZRL.`,
    });
  };

  const postClosed = (round, signups) => {
    const demand = demandOf(round, signups);
    return Promise.all([
      discord('public', { content: `🔒 **ZRL ${discordEscape(round.name)}: sign-ups are closed.** ${demand.riders} riders are in. Teams will be announced soon.` }),
      discord('admin', { content: `🛠️ **ZRL ${discordEscape(round.name)}**: sign-ups closed with ${demand.riders} rider${demand.riders === 1 ? '' : 's'}, ${demand.captains} happy to captain.\n${demandLines(demand)}\nForm the teams in the dashboard → 🚀 ZRL.` }),
    ]);
  };

  // Closes sign-ups at their close time and posts the reminder; each event fires once.
  async function runSchedule(now = Date.now()) {
    const data = await load();
    const round = data.round;
    if (!round || !round.open || !round.closesAt) return [];
    const closes = Date.parse(round.closesAt);
    const due = [];
    if (now >= closes - 24 * 3600 * 1000 && now < closes) due.push('reminder');
    if (now >= closes) due.push('close');
    const done = [];
    for (const event of due) {
      const [claimed] = await redis([['HSETNX', KEYS.sent, `${round.id}:${event}`, new Date(now).toISOString()]]);
      if (!claimed) continue;
      if (event === 'reminder') await postReminder(round, data.signups);
      if (event === 'close') {
        await redis([['SET', KEYS.round, JSON.stringify({ ...round, open: false })]]);
        await postClosed(round, data.signups);
      }
      done.push(`zrl-${event}`);
    }
    return done;
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
        const snapshot = { round: current.round, signups: current.signups, assign: current.assign };
        commands.push(['HSET', KEYS.archive, current.round.id, JSON.stringify(snapshot)]);
      }
      const teams = current.round ? current.round.teams.map(t => ({ ...t })) : [];
      const round = {
        id: start, name, start, weeks, open: true, published: false,
        closesAt: closes ? new Date(ukTime(closes, 23)).toISOString() : null,
        rosterSize: ROSTER_SIZE, racing: RACING, teams,
      };
      commands.push(['SET', KEYS.round, JSON.stringify(round)], ['DEL', KEYS.signups], ['DEL', KEYS.assign]);
      await redis(commands);
      await postOpen(round);
    },

    'POST /api/zrl/status': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round } = await requireRound();
      const changes = {};
      if (typeof body.open === 'boolean') changes.open = body.open;
      if (typeof body.published === 'boolean') changes.published = body.published;
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, ...changes })]]);
    },

    'POST /api/zrl/teams': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const { round, assign } = await requireRound();
      const teams = await parseTeams(body.teams);
      await redis([['SET', KEYS.round, JSON.stringify({ ...round, teams })]]);
      // Riders placed on a team that no longer exists go back to the pool.
      const valid = new Set(teams.map(t => t.id));
      const drop = Object.entries(assign).filter(([, id]) => !valid.has(id)).map(([k]) => ['HDEL', KEYS.assign, k]);
      if (drop.length) await redis(drop);
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

    'POST /api/zrl/withdraw': async (req, body) => {
      await requireRound();
      const who = identify(req, body);
      const keys = [...new Set([keyOf(who), who.name.toLowerCase()])];
      await redis(keys.flatMap(k => [['HDEL', KEYS.signups, k], ['HDEL', KEYS.assign, k]]));
    },
  };

  return { routes, view, load, runSchedule, REGIONS, KEYS, regionName };
};
