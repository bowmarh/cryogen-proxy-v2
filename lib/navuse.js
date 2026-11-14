'use strict';
// What people tap first: an anonymous tally of the Home buttons ("What would you like to do?"), kept per month. Only a page name and a count are stored, never who tapped,
// and only for the fixed list of pages below, so it cannot be filled with anything else. Shown to staff under Control room → Engagement.
module.exports = function createNavUse({ redis, HttpError, requireRole, memberFromRequest, roleFromRequest, now = () => Date.now() }) {
  const KEY = 'cg:navuse', PAGES = ['events', 'week', 'zrl', 'ttt', 'drs', 'rides', 'captain', 'profile', 'mydetails', 'plan', 'upgrade', 'control', 'members', 'mail', 'aidesk', 'studio', 'comms', 'clubstats', 'fair', 'inv'];
  const month = ms => new Date(ms).toISOString().slice(0, 7);
  const routes = {
    'POST /api/usage/nav': async (req, body) => {
      if (!memberFromRequest(req) && !roleFromRequest(req)) throw new HttpError(401, 'Please sign in.');
      const id = String(body.id || ''); if (!PAGES.includes(id)) throw new HttpError(400, 'Unknown page.');
      await redis([['HINCRBY', KEY, `${month(now())}:${id}`, 1]]); return { ok: true };
    },
    'GET /api/usage/nav': async req => {
      requireRole(req, ['admin', 'mod']); const [raw] = await redis([['HGETALL', KEY]]), by = {};
      for (let i = 0; i < (raw || []).length; i += 2) { const [m, id] = raw[i].split(':'); (by[m] = by[m] || []).push({ id, taps: Number(raw[i + 1]) || 0 }); }
      const months = Object.keys(by).sort().reverse().slice(0, 2);
      return { months: months.map(m => ({ month: m, pages: by[m].sort((a, b) => b.taps - a.taps), total: by[m].reduce((n, x) => n + x.taps, 0) })) };
    },
  };
  return { routes, PAGES };
};
