'use strict';
// Club history: everything the archives hold (finished ZRL rounds, Ladder seasons, DIRT seasons) in one workbook, so the record survives
// resets and can be kept outside the app. Staff only. Reads only; nothing is changed or deleted.
module.exports = function createHistory({ redis, requireRole, xlsx, keys }) {
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const sheet = (name, cols, rows) => ({ name, columns: cols.map(([header, width]) => ({ header, width })), rows });

  async function build() {
    const [zraw, lraw, draw] = await redis([['HGETALL', keys.zrl.archive], ['HGETALL', keys.ladder.archive], ['HGETALL', keys.drs.archive]]);
    const rounds = [], results = [], riders = [], ladder = [], dirt = [];
    for (const [id, v] of pairs(zraw)) {
      const a = parse(v); if (!a || !a.round) continue;
      const teamName = Object.fromEntries((a.round.teams || []).map(t => [t.id, t.name]));
      const totals = {};
      for (const [field, r] of Object.entries(a.results || {})) {
        const [week, team] = field.split(':');
        results.push([a.round.name, a.round.start, Number(week) + 1, teamName[team] || team, r.pos || '', r.pts === undefined || r.pts === null ? '' : r.pts, r.note || '']);
        totals[team] = (totals[team] || 0) + (Number(r.pts) || 0);
      }
      const racing = (a.signups || []).filter(x => x.in);
      rounds.push([a.round.name, a.round.start, a.round.weeks, (a.round.teams || []).length, racing.length, Object.entries(totals).sort((x, y) => y[1] - x[1]).map(([t, p]) => `${teamName[t] || t} ${p}`).join('; ')]);
      for (const x of racing) riders.push([a.round.name, x.name, x.zwid || '', x.cat || '', String(a.assign && a.assign[x.key] || '').split(',').filter(Boolean).map(t => teamName[t] || t).join('; ')]);
    }
    for (const [id, v] of pairs(lraw)) {
      const s = parse(v); if (!s) continue;
      const r = s.record || {};
      ladder.push([(s.team || {}).name || '', s.name || id, s.closedAt || '', r.played || 0, r.won || 0, r.lost || 0, (s.roster || []).map(x => x.name).join('; ')]);
    }
    for (const [id, v] of pairs(draw)) {
      const s = parse(v); if (!s) continue;
      dirt.push([(s.team || {}).name || '', (s.season || {}).name || id.split('|')[0], id.split('|')[1] || '', (s.stages || []).length, Object.keys(s.squad || {}).length]);
    }
    const byDate = (a, b) => String(b[1]).localeCompare(String(a[1]));
    return xlsx.build([
      sheet('ZRL rounds', [['Round', 26], ['First race', 12], ['Weeks', 7], ['Teams', 7], ['Riders racing', 13], ['Team points', 60]], rounds.sort(byDate)),
      sheet('ZRL results', [['Round', 26], ['First race', 12], ['Race', 6], ['Team', 28], ['Position', 9], ['Points', 8], ['Note', 30]], results.sort(byDate)),
      sheet('ZRL riders', [['Round', 26], ['Rider', 24], ['Zwift ID', 12], ['Category', 9], ['Team(s)', 30]], riders),
      sheet('Ladder seasons', [['Team', 24], ['Season', 22], ['Closed', 22], ['Played', 8], ['Won', 6], ['Lost', 6], ['Roster', 60]], ladder.sort((a, b) => String(b[2]).localeCompare(String(a[2])))),
      sheet('DIRT seasons', [['Team', 24], ['Season', 22], ['Archived', 22], ['Stages', 8], ['Squad size', 11]], dirt.sort((a, b) => String(b[2]).localeCompare(String(a[2])))),
    ]);
  }

  const routes = {
    'GET /api/history/export': async req => {
      requireRole(req, ['admin', 'mod']);
      const buf = await build();
      return { filename: `cryogen-history-${new Date().toISOString().slice(0, 10)}.xlsx`, base64: buf.toString('base64') };
    },
  };
  return { routes, build };
};
