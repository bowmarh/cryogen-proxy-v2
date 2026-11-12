'use strict';
// An audit trail of what staff did in the app: who, when, which action (the route), never the contents. Kept to the last 500 entries; admins can read it.
// Reads are not recorded: only changes (POST) in the areas that matter (email, the AI desk, joins, autopilot, go-live, supporters, payments, admin).
module.exports = function createAudit({ redis, requireRole }) {
  const KEY = 'cg:audit', AREAS = /^\/api\/(mail|aiops|join|raceweek|livecheck|support|admin|privacy|me\/data|zrl\/lineup|zrl\/results)/;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const watched = (method, path) => method === 'POST' && AREAS.test(path);
  async function record({ who, role, method, path }) { await redis([['LPUSH', KEY, JSON.stringify({ at: new Date().toISOString(), who: String(who || role || '?').slice(0, 60), role: String(role || '').slice(0, 12), action: `${method} ${path}`.slice(0, 120) })], ['LTRIM', KEY, 0, 499]]); }
  async function list(limit = 200) { const [raw] = await redis([['LRANGE', KEY, 0, Math.min(limit, 500) - 1]]); return (raw || []).map(parse).filter(Boolean); }
  return { watched, record, list, routes: { 'GET /api/audit': async req => { requireRole(req, ['admin']); return { entries: await list() }; } } };
};
