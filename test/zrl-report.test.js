'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const create = require('../lib/studio');

// A ZRL result post says where the team stands in the league and how far that moved since the race before.
test('the ZRL result draft includes league position and movement', async () => {
  const round = { id: 'r2', name: 'Round 2', start: '2026-11-03', weeks: 3, published: true, teams: [{ id: 'a', name: 'CRYO-GEN Alpha' }, { id: 'b', name: 'CRYO-GEN Beta' }] };
  const results = { '0:a': { pos: 3, pts: 20 }, '0:b': { pos: 5, pts: 10 }, '1:a': { pos: 9, pts: 5 }, '1:b': { pos: 2, pts: 30 } };
  // A stand-in for the league table: rank by total points over the weeks given.
  const standingsOf = (rd, res) => {
    const totals = rd.teams.map(t => ({ id: t.id, name: t.name, total: Object.entries(res).filter(([k]) => k.endsWith(':' + t.id)).reduce((n, [, v]) => n + v.pts, 0) })).sort((x, y) => y.total - x.total);
    totals.forEach((t, i) => { t.rank = i + 1; });
    return { groups: [{ name: 'Division 1', teams: totals }] };
  };
  const store = {}, redis = async cmds => cmds.map(([c, k, ...a]) => { const h = store[k] = store[k] || {}; if (c === 'HGETALL') return Object.entries(h).flat(); if (c === 'HSET') { h[a[0]] = a[1]; return 1; } return null; });
  const studio = create({ redis, HttpError: Error, requireRole() {}, memberFromRequest: () => null, ai: { available: async () => false, enabled: () => false, json: () => null }, fetchRoster: async () => ({ riders: [] }),
    zrl: { load: async () => ({ round, signups: [{ key: '1', in: true }, { key: '2', in: true }], assign: { 1: ['a'], 2: ['b'] } }), loadResults: async () => results, loadWeekly: async () => ({ lineup: {} }), standingsOf },
    ladder: { allMatches: async () => [] }, drs: { allStages: async () => [] }, adminReq: () => ({}), discord: async () => true, siteUrl: 'https://club.test', publicClub: async () => ({}) });
  const ev = (await studio.findEvents(Date.parse('2026-11-12T12:00:00Z'))).find(e => e.key === 'zrl:r2:1');
  assert.ok(ev, 'race 2 has results for both teams');
  const alpha = ev.facts.teams.find(t => t.team === 'Alpha'), beta = ev.facts.teams.find(t => t.team === 'Beta');
  assert.equal(beta.leagueRank, 1); assert.equal(beta.rankChange, 1, 'Beta moved up one place');
  assert.equal(alpha.leagueRank, 2); assert.equal(alpha.rankChange, -1, 'Alpha dropped one place');
  assert.equal(ev.facts.teams[0].team, 'Beta', 'still ordered by race position');
});
