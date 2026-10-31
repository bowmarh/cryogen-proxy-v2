'use strict';
// Club trends for the dashboard charts: one snapshot a day of the active roster (average vELO, riders per category, size), kept for 120 days,
// plus social-ride RSVPs per week for the last eight weeks (read from the rides themselves). Only totals; no names.
module.exports = function createTrend({ redis, HttpError, requireRole, memberFromRequest, fetchRoster, activeMembers, keys, staffMetrics = async () => ({}) }) {
  const KEY = 'cg:club:trend', STAFF = 'cg:staff:trend', RIDER = 'cg:rider:velo', KEEP = 120, RIDER_KEEP = 60, DAY = 86400000;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const day = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

  async function snapshot() {
    const [ids, { riders }] = await Promise.all([activeMembers(), fetchRoster()]);
    const on = new Set(ids), act = riders.filter(r => on.has(String(r.riderId)));
    const rated = act.map(r => Math.round((r.race && r.race.current && r.race.current.rating) || 0)).filter(x => x > 0);
    const cats = {};
    for (const r of act) { const c = r.zpCategory || 'D'; cats[c] = (cats[c] || 0) + 1; }
    return { avg: rated.length ? Math.round(rated.reduce((a, b) => a + b, 0) / rated.length) : 0, n: act.length, cats };
  }

  // Scheduled: once a day. Older than KEEP days are dropped.
  async function runSchedule(now = Date.now()) {
    const d = day(now);
    const [have] = await redis([['HGET', KEY, d]]);
    if (have) return [];
    const snap = await snapshot();
    if (!snap.n) return [];
    await redis([['HSET', KEY, d, JSON.stringify(snap)]]);
    const [fields, sfields] = await redis([['HKEYS', KEY], ['HKEYS', STAFF]]);
    const cut = day(now - KEEP * DAY);
    await redis([...(fields || []).filter(f => f < cut).map(f => ['HDEL', KEY, f]), ...(sfields || []).filter(f => f < cut).map(f => ['HDEL', STAFF, f])]);
    // The staff view (what needs attention, sign-ups, riders without a team) and each rider's own vELO line, one point a day.
    try { const m = await staffMetrics(); if (Object.keys(m).length) await redis([['HSET', STAFF, d, JSON.stringify(m)]]); } catch (e) { console.error('Staff trend:', e.message); }
    try {
      const { riders } = await fetchRoster(), on = new Set(await activeMembers());
      const [raw] = await redis([['HGETALL', RIDER]]), have = Object.fromEntries(pairs(raw).map(([z, v]) => [z, parse(v) || []]));
      const cmds = [];
      for (const r of riders) {
        const z = String(r.riderId), v = Math.round((r.race && r.race.current && r.race.current.rating) || 0);
        if (!on.has(z) || !v) continue;
        const list = (have[z] || []).filter(x => x[0] !== d);
        list.push([d, v]);
        cmds.push(['HSET', RIDER, z, JSON.stringify(list.slice(-RIDER_KEEP))]);
      }
      if (cmds.length) await redis(cmds);
    } catch (e) { console.error('Rider trend:', e.message); }
    return [];   // a quiet job: it is not an event anyone needs to be told about
  }

  const monday = ms => { const d = new Date(ms); const k = (d.getUTCDay() + 6) % 7; return day(ms - k * DAY); };

  async function view(now = Date.now()) {
    const [raw, rideRaw, rsvpRaw] = await redis([['HGETALL', KEY], ['HGETALL', keys.rides], ['HGETALL', keys.rsvps]]);
    const velo = pairs(raw).map(([d, v]) => ({ d, ...(parse(v) || {}) })).filter(x => x.avg).sort((a, b) => a.d.localeCompare(b.d)).slice(-60);
    const dates = new Map();
    for (const [id, v] of pairs(rideRaw)) { const r = parse(v); if (r && r.date) dates.set(id, r.date); }
    const weeks = [];
    for (let i = 7; i >= 0; i--) weeks.push({ week: monday(now - i * 7 * DAY), rsvps: 0 });
    const byWeek = new Map(weeks.map(w => [w.week, w]));
    for (const [field] of pairs(rsvpRaw)) {
      const date = dates.get(field.split('|')[0]); if (!date) continue;
      const w = byWeek.get(monday(Date.parse(date + 'T12:00:00Z')));
      if (w) w.rsvps++;
    }
    const last = velo[velo.length - 1];
    return { velo, cats: last ? last.cats : {}, riders: last ? last.n : 0, attendance: weeks };
  }

  // Staff: how the club's workload and sign-ups moved. A rider: their own vELO line only.
  async function staffView() {
    const [raw] = await redis([['HGETALL', STAFF]]);
    return { days: pairs(raw).map(([d, v]) => ({ d, ...(parse(v) || {}) })).sort((a, b) => a.d.localeCompare(b.d)).slice(-60) };
  }
  const routes = {
    'GET /api/club/trend': async () => view(),
    'GET /api/staff/trend': async req => { requireRole(req, ['admin', 'mod']); return staffView(); },
    'GET /api/me/velo': async req => {
      const me = memberFromRequest(req);
      if (!me) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const [v] = await redis([['HGET', RIDER, me.zwid]]);
      return { history: (parse(v) || []).map(([d, x]) => ({ d, v: x })) };
    },
  };
  return { routes, runSchedule, view, snapshot, KEY };
};
