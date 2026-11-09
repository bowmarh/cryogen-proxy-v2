'use strict';
// Club health for staff: is the club growing, who is actually racing, and where is it leaking? Built only from what the app already holds (the roster and
// race history through the tidy tool, the daily club snapshots, the staff trend and the first-seen dates from onboarding). No names are returned.
module.exports = function createClubStats({ redis, HttpError, requireRole, tidy, trend }) {
  const DAY = 86400000, JOINERS = 'cg:onboard:seen', STAFF = 'cg:staff:trend';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const pct = (n, d) => (d ? Math.round(n / d * 100) : 0);
  const month = ms => new Date(ms).toISOString().slice(0, 7);

  async function build(now = Date.now()) {
    const [{ inactive }, tv, [seenRaw, staffRaw]] = await Promise.all([tidy.analyse(now), trend.view(), redis([['HGETALL', JOINERS], ['HGETALL', STAFF]])]);
    // Who is racing: members in the club's data (associates are not counted), by days since their last race.
    const people = inactive.filter(m => m.inClub && m.tier !== 'associate');
    const b = { d30: 0, d90: 0, d180: 0, older: 0, never: 0 };
    for (const m of people) {
      if (m.daysSinceRace === null || m.finishes === 0) b.never++;
      else if (m.daysSinceRace <= 30) b.d30++; else if (m.daysSinceRace <= 90) b.d90++; else if (m.daysSinceRace <= 180) b.d180++; else b.older++;
    }
    const total = people.length, quiet = people.filter(m => m.daysSinceRace !== null && m.daysSinceRace >= 45 && m.daysSinceRace <= 180).length;
    const activity = { total, racedLast30: b.d30, racedLast90: b.d30 + b.d90, quiet, neverRaced: b.never, buckets: [['Raced in the last 30 days', b.d30], ['31 to 90 days ago', b.d90], ['91 to 180 days ago', b.d180], ['Over 180 days', b.older], ['Never raced', b.never]], pct30: pct(b.d30, total), pct90: pct(b.d30 + b.d90, total) };

    // New members by month (people the app first saw after it started watching), last 12 months.
    const months = Array.from({ length: 12 }, (_, i) => month(Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 11 + i, 1))), joined = Object.fromEntries(months.map(m => [m, 0]));
    for (const [, v] of pairs(seenRaw)) { const s = parse(v); if (s && !s.seed && s.at && joined[s.at.slice(0, 7)] !== undefined) joined[s.at.slice(0, 7)]++; }
    const joiners = months.map(m => ({ month: m, n: joined[m] }));

    // Club size and average vELO, one point a month from the daily snapshots (the last snapshot of each month).
    const byMonth = new Map(); for (const p of tv.velo || []) byMonth.set(p.d.slice(0, 7), p);
    const size = [...byMonth.values()].slice(-6).map(p => ({ d: p.d, n: p.n, avg: p.avg }));

    // Sign-up fill: of the active riders, how many are in this round's ZRL (from the staff trend, which keeps the latest counts).
    const days = pairs(staffRaw).map(([d, v]) => ({ d, ...(parse(v) || {}) })).sort((x, y) => x.d.localeCompare(y.d)), last = days[days.length - 1] || {};
    const signups = { racing: last.racing ?? null, unplaced: last.unplaced ?? null, fillPct: last.racing != null && total ? pct(last.racing, total) : null, attention: last.attention ?? null, asOf: last.d || null };

    // Plain-English reading of the numbers.
    const notes = [];
    if (total) notes.push(`${activity.pct30}% of ${total} members raced in the last 30 days, and ${activity.pct90}% in the last 90.`);
    if (quiet && pct(quiet, total) >= 10) notes.push(`${quiet} members (${pct(quiet, total)}%) have not raced for 45 to 180 days. They are on the quiet list under Comms: a friendly message works best before they drift away.`);
    if (activity.neverRaced) notes.push(`${activity.neverRaced} member${activity.neverRaced === 1 ? ' has' : 's have'} never raced: the first-race checklist and a ride leader's nudge are the lever here.`);
    const j3 = joiners.slice(-3).reduce((n, x) => n + x.n, 0), j3p = joiners.slice(-6, -3).reduce((n, x) => n + x.n, 0);
    if (j3 || j3p) notes.push(`${j3} new member${j3 === 1 ? '' : 's'} in the last 3 months, against ${j3p} in the 3 months before.`);
    if (size.length >= 2) { const a = size[0], z = size[size.length - 1]; if (a.n && z.n !== a.n) notes.push(`Active riders went from ${a.n} to ${z.n} between ${a.d} and ${z.d}.`); }
    if (signups.fillPct != null) notes.push(`${signups.racing} riders are in this round's ZRL (${signups.fillPct}% of members)${signups.unplaced ? `; ${signups.unplaced} still need a team` : ''}.`);
    return { activity, joiners, size, signups, notes, joinersNote: 'Counts people first seen by this app after it started watching; earlier joiners are not dated.' };
  }

  return { build, routes: { 'GET /api/staff/clubstats': async req => { requireRole(req, ['admin', 'mod']); return build(); } } };
};
