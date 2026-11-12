'use strict';
// Engagement and retention for the committee: how many members race regularly, how many are cooling off or gone quiet, how that has moved month by month
// (a snapshot is saved once a month), how ZRL participation looks race by race, and who is most at risk. Counts only, except the at-risk list for staff.
module.exports = function createEngagement({ redis, requireRole, tidy, zrl, aiops }) {
  const K = { snap: 'cg:engage:snap' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const month = ms => new Date(ms).toISOString().slice(0, 7);
  const BANDS = [['active', 'Raced in the last 30 days', 0, 30], ['cooling', 'Last raced 31 to 60 days ago', 31, 60], ['quiet', 'Last raced 61 to 180 days ago', 61, 180], ['gone', 'More than 180 days, or never', 181, Infinity]];
  async function bands(now = Date.now()) {
    const a = await tidy.analyse(now), people = (a.inactive || []);
    // analyse() lists only members who are not recently active, so the active count is the rest of the club.
    const inClub = a.total || 0, counts = { active: 0, cooling: 0, quiet: 0, gone: 0 };
    for (const m of people) { if (!m.inClub || m.tier === 'associate') continue; const d = m.daysSinceRace; const b = d === null ? 'gone' : d <= 60 ? 'cooling' : d <= 180 ? 'quiet' : 'gone'; counts[b]++; }
    counts.active = Math.max(0, inClub - counts.cooling - counts.quiet - counts.gone - (a.counts && a.counts.notInClub || 0));
    return { counts, total: inClub };
  }
  async function zrlParticipation() {
    const data = await zrl.load(); if (!data.round) return [];
    const [weekly, results] = await Promise.all([zrl.loadWeekly(), zrl.loadResults()]), today = new Date().toISOString().slice(0, 10), rows = [];
    for (let w = 0; w < data.round.weeks; w++) {
      const date = new Date(Date.parse(`${data.round.start}T00:00:00Z`) + 7 * w * 86400000).toISOString().slice(0, 10), teams = data.round.teams;
      const picked = teams.reduce((n, t) => n + (weekly.lineup[`${w}:${t.id}`] || []).length, 0), seats = teams.length * data.round.racing, scored = teams.filter(t => results[`${w}:${t.id}`]).length;
      rows.push({ race: w + 1, date, past: date <= today, filled: seats ? Math.round(100 * picked / seats) : 0, teamsScored: scored, teams: teams.length });
    }
    return rows;
  }
  async function snapshot(now = Date.now()) { const b = await bands(now), key = month(now); await redis([['HSET', K.snap, key, JSON.stringify({ ...b.counts, total: b.total, at: new Date(now).toISOString() })]]); return key; }
  async function overview(now = Date.now()) {
    const [b, part, [raw], churn] = await Promise.all([bands(now), zrlParticipation().catch(() => []), redis([['HGETALL', K.snap]]), aiops.churn().catch(() => ({ members: [] }))]);
    const history = []; for (let i = 0; i < (raw || []).length; i += 2) { const v = parse(raw[i + 1]); if (v) history.push({ month: raw[i], ...v }); }
    history.sort((a, c) => a.month.localeCompare(c.month));
    const retained = b.total ? Math.round(100 * b.counts.active / b.total) : 0;
    return { generated: new Date(now).toISOString(), bands: BANDS.map(([k, label]) => ({ key: k, label, count: b.counts[k] })), total: b.total, activePercent: retained, history: history.slice(-12), zrl: part, atRisk: churn.members.slice(0, 10) };
  }
  // Scheduled: a snapshot on the first run of each month.
  async function runSchedule(now = Date.now()) { const [first] = await redis([['HSETNX', K.snap + ':done', month(now), new Date(now).toISOString()]]); if (!first) return []; await snapshot(now).catch(e => console.error('Engagement snapshot:', e.message)); return []; }   // quiet housekeeping: not reported as an event
  return { routes: { 'GET /api/engagement': async req => { requireRole(req, ['admin', 'mod']); return overview(); } }, overview, snapshot, runSchedule, bands };
};
