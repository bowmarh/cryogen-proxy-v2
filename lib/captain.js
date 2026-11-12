'use strict';
// A page for team captains: their team's availability, line-up and result for the next race, with one-tap actions (ask unanswered riders on Discord, get a
// proposed line-up). Setting the line-up itself uses the ordinary ZRL line-up route, which already lets a captain do it. A captain only ever sees their own
// team(s); the staff keep the club-wide view in the Control room.
module.exports = function createCaptain({ HttpError, memberFromRequest, zrl, aiops }) {
  const DAY = 86400000, weekDate = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * DAY).toISOString().slice(0, 10);
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  async function mine(m) { const data = await zrl.load(); return { data, teams: data.round ? data.round.teams.filter(t => String(t.captain) === String(m.zwid)) : [] }; }
  const weekNow = (round, now = Date.now()) => { const today = new Date(now).toISOString().slice(0, 10), w = Array.from({ length: round.weeks }, (_, i) => i).find(i => weekDate(round, i) >= today); return w === undefined ? round.weeks - 1 : w; };
  async function overview(req) {
    const m = need(req), { data, teams } = await mine(m); if (!teams.length) return { captain: false, teams: [] };
    const [weekly, results] = await Promise.all([zrl.loadWeekly(), zrl.loadResults()]), week = weekNow(data.round), out = [];
    for (const t of teams) {
      const pool = data.signups.filter(x => x.in && x.zwid && (data.assign[x.key] || []).includes(t.id)), picked = weekly.lineup[`${week}:${t.id}`] || [], r = results[`${week}:${t.id}`];
      const riders = pool.map(x => ({ zwid: x.zwid, name: x.name, answer: zrl.availOf(weekly, week, x.zwid, t.id) || '', picked: picked.includes(x.zwid) }));
      const n = a => riders.filter(x => x.answer === a).length;
      out.push({ id: t.id, name: t.name, week, date: weekDate(data.round, week), racing: data.round.racing, riders, yes: n('yes'), maybe: n('maybe'), no: n('no'), none: n(''), picked: picked.length, result: r && (r.pos || (r.pts !== undefined && r.pts !== null)) ? { pos: r.pos || null, pts: r.pts ?? null } : null });
    }
    return { captain: true, round: data.round.name, teams: out };
  }
  async function guard(req, body) {
    const m = need(req), { data, teams } = await mine(m), t = teams.find(x => x.id === String(body.team || ''));
    if (!t) throw new HttpError(403, 'You are not the captain of that team.');
    return { week: Math.max(0, Math.min(Number(body.week) || 0, data.round.weeks - 1)), team: t.id };
  }
  const routes = {
    'GET /api/captain': async req => overview(req),
    'POST /api/captain/ask': async (req, body) => aiops.discordAsk({ ...(await guard(req, body)), step: 'captain' }),
    'POST /api/captain/suggest': async (req, body) => aiops.lineupSuggest(await guard(req, body)),
  };
  return { routes, overview };
};
