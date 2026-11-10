'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createReach = require('../lib/reach');

h.setEnv();
const make = ({ ids = ['1', '2', '3', '4'], linked = ['1'], subs = ['2'], posts = [], db = {} } = {}) => createReach({
  redis: async cmds => cmds.map(([c, k, ...a]) => { const t = db[k] = db[k] || {}; if (c === 'HKEYS') return subs; if (c === 'HSETNX') { if (a[0] in t) return 0; t[a[0]] = a[1]; return 1; } return null; }),
  HttpError: Error, memberFromRequest: () => ({ zwid: '3' }), activeMembers: async () => ids, verifiedLinks: async () => new Set(linked), pushKey: 'cg:push:subs',
  discord: async (ch, b) => { posts.push([ch, b.content]); return true; }, siteUrl: 'https://club.test',
});

test('reach counts verified Discord links and phone notifications, once each, over the active members', async () => {
  const s = await make({ linked: ['1', '2'], subs: ['2', '3'] }).stats();
  assert.deepEqual([s.total, s.discord, s.push, s.reachable, s.pct, s.unreachable], [4, 2, 2, 3, 75, 1], 'rider 2 has both and counts once');
});

test('a rider is told whether they can be reached; a captain gets only the riders of their own team who cannot be', async () => {
  const r = make();
  assert.deepEqual(await r.mine('1'), { reachable: true, discord: true, push: false });
  assert.deepEqual(await r.mine('4'), { reachable: false, discord: false, push: false });
  assert.deepEqual(await r.unreachable(['1', '2', '3', '4']), ['3', '4']);
});

test('one summary line a month goes to the admin channel, with counts and no names', async () => {
  const posts = [], db = {}, r = make({ posts, db });
  delete process.env.REACH_SUMMARY_AUTO;
  try {
    const NOW = Date.parse('2026-11-04T10:00:00Z');
    assert.deepEqual(await r.runSchedule(NOW), ['reach-summary']);
    assert.deepEqual(await r.runSchedule(NOW + 86400000), [], 'once a month');
    assert.match(posts[0][1], /2 of 4 active members \(50%\)/); assert.equal(posts[0][0], 'admin');
    assert.deepEqual(await make({ posts, db }).runSchedule(Date.parse('2026-12-02T10:00:00Z')), ['reach-summary'], 'and again next month');
  } finally { process.env.REACH_SUMMARY_AUTO = '0'; }
});

let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());
test('the rider route is for the signed-in member, and Club health shows the staff numbers', async () => {
  assert.equal((await app.get('/api/me/reach')).status, 401);
  const t = await app.memberSession('1002', { name: 'Rider Two' }), r = (await app.get('/api/me/reach', { token: t })).body;
  assert.equal(typeof r.reachable, 'boolean');
  const stats = (await app.get('/api/staff/clubstats', { token: await app.login('admin') })).body;
  assert.ok(stats.reach && stats.reach.total >= 0 && 'pct' in stats.reach);
});
