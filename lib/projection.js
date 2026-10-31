'use strict';
// Season outlook: where each team is heading if the rest of the season goes like the first part. It is arithmetic on results already entered (an average
// per race carried forward), not a prediction model, and it says so when there is too little to go on (fewer than two results).
module.exports = function createProjection({ requireRole, adminReq, zrl, ladder, drs }) {
  const round1 = n => Math.round(n * 10) / 10;
  const MIN = 2;

  async function zrlOutlook() {
    const data = await zrl.load(); if (!data.round) return [];
    const results = await zrl.loadResults(), out = [];
    for (const t of data.round.teams) {
      const done = Array.from({ length: data.round.weeks }, (_, i) => results[`${i}:${t.id}`]).filter(r => r && r.pts !== null && r.pts !== undefined);
      if (!done.length && !data.signups.some(x => x.in && String(data.assign[x.key] || '').split(',').includes(t.id))) continue;
      const total = done.reduce((n, r) => n + (r.pts || 0), 0), left = data.round.weeks - done.length, avg = done.length ? total / done.length : 0;
      const best = done.filter(r => r.pos).map(r => r.pos);
      out.push({ team: t.name, division: t.division || '', raced: done.length, left, points: round1(total), perRace: round1(avg), projected: done.length >= MIN ? round1(total + avg * left) : null,
        trend: best.length >= 3 ? (best[best.length - 1] < best[0] ? 'improving' : best[best.length - 1] > best[0] ? 'slipping' : 'steady') : null, note: done.length >= MIN ? '' : 'Not enough races yet' });
    }
    return out;
  }
  async function drsOutlook(req, now) {
    const out = [];
    for (const t of (await drs.view(req, undefined, now)).teams) {
      const v = await drs.view(req, t.id, now); if (!v.season) continue;
      const played = v.stages.filter(s => s.status === 'played' && s.result), left = v.stages.filter(s => s.status === 'upcoming').length;
      const total = played.reduce((n, s) => n + (s.result.teamPoints || 0), 0), avg = played.length ? total / played.length : 0;
      const heading = v.squad.filter(r => r.forecast === 'breach').map(r => r.name), over = v.squad.filter(r => ['danger', 'breach'].includes(r.state)).map(r => r.name);
      out.push({ team: t.name, division: v.season.division, played: played.length, left, points: total, perStage: round1(avg), projected: played.length >= MIN ? Math.round(total + avg * left) : null, heading, over, note: played.length >= MIN ? '' : 'Not enough stages yet' });
    }
    return out;
  }
  async function ladderOutlook(req, now) {
    const out = [];
    for (const t of (await ladder.view(req, undefined, now)).teams) {
      const v = await ladder.view(req, t.id, now), r = v.record, left = v.matches.filter(m => m.status === 'scheduled').length;
      out.push({ team: t.name, played: r.played, won: r.won, lost: r.lost, winRate: r.played ? Math.round(r.won / r.played * 100) : null, scheduled: left, expectedWins: r.played >= MIN && left ? round1(r.won / r.played * left) : null, rung: (v.meta && v.meta.rung) || null, note: r.played >= MIN ? '' : 'Not enough matches yet' });
    }
    return out;
  }

  const routes = {
    'GET /api/projection': async req => {
      requireRole(req, ['admin', 'mod']);
      const now = Date.now(), staff = adminReq(), out = { generated: new Date(now).toISOString(), zrl: [], drs: [], ladder: [] };
      for (const [k, f] of [['zrl', () => zrlOutlook()], ['drs', () => drsOutlook(staff, now)], ['ladder', () => ladderOutlook(staff, now)]]) { try { out[k] = await f(); } catch (e) { out[k] = []; } }
      return out;
    },
  };
  return { routes };
};
