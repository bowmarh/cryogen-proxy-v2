'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createFairPlay = require('../lib/fairplay');

h.setEnv();
let app, admin, mod;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
});
after(() => app.close());
beforeEach(() => { app.world.discord.length = 0; });

const { detect } = createFairPlay({ redis: async () => [], HttpError: Error, requireRole() {}, fetchRoster: async () => ({ riders: [] }), activeMembers: async () => [] });
const D = n => new Date(Date.UTC(2026, 9, 31) - n * 86400000).toISOString().slice(0, 10);   // n days before 31 Oct 2026
const hist = rows => rows.map(([n, w, p5, p20, v]) => ({ d: D(n), w, p5, p20, v }));

test('weight: a drop of more than 2 kg inside 7 days is flagged, a smaller one or a slow one is not', () => {
  const f = detect(hist([[6, 78], [3, 76.5], [0, 74.5]]));
  assert.deepEqual(f.map(x => [x.type, x.severity]), [['weight_drop', 2]]);
  assert.match(f[0].metric, /78 kg → 74.5 kg \(−3.5 kg in 7 days\)/);
  assert.deepEqual(detect(hist([[6, 76], [3, 75.5], [0, 75]])), [], '1 kg');
  assert.deepEqual(detect(hist([[40, 80], [20, 78], [0, 75]])), [], 'over weeks, not a week');
  assert.equal(detect(hist([[5, 77], [0, 34]])).some(x => x.severity === 3), true, 'an implausible weight');
  assert.deepEqual(detect(hist([[0, 0]])), [], 'no weight on file is not a drop');
});

test('W/kg: more than 5% above the best of the earlier 90 days is flagged, with severity by size, and only with enough history', () => {
  const base = [[80, 0, 4.0, 3.0], [60, 0, 4.1, 3.1], [40, 0, 4.0, 3.0], [20, 0, 4.05, 3.05]];
  const mk = (p5, p20) => hist([...base, [0, 0, p5, p20]]);
  assert.deepEqual(detect(mk(4.3, 3.1)), [], 'inside 5%');
  const f = detect(mk(4.65, 3.1));
  assert.deepEqual(f.map(x => [x.type, x.sub, x.severity]), [['wkg_spike', 'p5', 2]]);
  assert.match(f[0].metric, /5 min: 4\.65 W\/kg vs 4\.1 best over 90 days \(\+13\.4%\)/);
  assert.equal(detect(mk(4.1, 3.7)).find(x => x.sub === 'p20').severity, 3, '+19%');
  assert.deepEqual(detect(hist([[20, 0, 4.0, 3.0], [0, 0, 5.0, 4.0]])), [], 'not enough earlier readings');
  assert.deepEqual(detect(hist([...base.slice(0, 3), [10, 0, 4.5, 3.4], [0, 0, 4.6, 3.4]])), [], 'readings from the last two weeks are not the baseline');
});

test('vELO: a rise of 150 or more in 14 days is flagged', () => {
  assert.deepEqual(detect(hist([[14, 0, 0, 0, 1100], [0, 0, 0, 0, 1290]])).map(x => [x.type, x.severity]), [['velo_jump', 1]]);
  assert.deepEqual(detect(hist([[14, 0, 0, 0, 1100], [0, 0, 0, 0, 1200]])), []);
  assert.equal(detect(hist([[14, 0, 0, 0, 1000], [0, 0, 0, 0, 1450]]))[0].severity, 3);
});

test('the daily check flags from the roster, staff only; a person marks each item; reviewed items are not raised again; only counts reach Discord', async () => {
  const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  // Rider Two (1002) has been 78 kg and 3.0 W/kg for 20 minutes for weeks; the roster now says 75 kg and 3.5 W/kg.
  app.world.db['cg:fair:snap'] = { 1002: JSON.stringify([[80, 78, 3.9, 3.0], [60, 78, 3.9, 3.0], [40, 78, 3.9, 3.0], [20, 78, 3.9, 3.0], [3, 78, 3.9, 3.0]].map(([n, w, p5, p20]) => ({ d: day(n), w, p5, p20, v: 1200 }))) };
  assert.equal((await app.get('/api/fairplay')).status, 401);
  assert.equal(JSON.stringify((await app.get('/api/roster')).body).includes('"weight"'), false, 'weight is still not in the roster members can fetch');
  assert.equal((await app.get('/api/fairplay', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  assert.equal((await app.post('/api/fairplay/run', {}, { token: mod })).status, 403, 'only an admin forces a check');
  const r = (await app.post('/api/fairplay/run', {}, { token: admin })).body;
  assert.deepEqual([r.ran, r.added], [true, 2]);
  const list = (await app.get('/api/fairplay', { token: mod })).body;
  const by = Object.fromEntries(list.flags.map(f => [f.type, f]));
  assert.equal(list.open, 2);
  assert.deepEqual([by.weight_drop.zwid, by.weight_drop.severity, by.wkg_spike.severity], ['1002', 1, 3]);
  assert.match(by.wkg_spike.profile, /^https:\/\/www\.zwiftracing\.app\/riders\/1002$/);
  assert.ok(list.cannotSee.some(x => /Heart rate/.test(x)));
  const said = app.world.discord.map(d => d.body.content).filter(c => /Fair play/.test(c));
  assert.equal(said.length, 1); assert.match(said[0], /2 new items/); assert.ok(!/Rider Two|1002|kg/.test(said[0]), 'no names or numbers in Discord');

  assert.equal((await app.post('/api/fairplay/review', { id: by.weight_drop.id, status: 'nonsense' }, { token: mod })).status, 400);
  assert.equal((await app.post('/api/fairplay/review', { id: 'nope', status: 'ok' }, { token: mod })).status, 404);
  const rev = (await app.post('/api/fairplay/review', { id: by.weight_drop.id, status: 'dismissed', note: 'Rider told us they lost weight on purpose' }, { token: mod })).body.flag;
  assert.deepEqual([rev.status, rev.reviewedBy !== '', rev.note.slice(0, 5)], ['dismissed', true, 'Rider']);

  app.world.discord.length = 0;
  const again = (await app.post('/api/fairplay/run', {}, { token: admin })).body;
  assert.equal(again.added, 0, 'the dismissed one is not raised again, the open one only refreshes');
  assert.equal((await app.get('/api/fairplay', { token: admin })).body.flags.filter(f => f.status === 'open').length, 1);
  assert.equal(app.world.discord.filter(d => /Fair play/.test(d.body.content)).length, 0, 'no repeat message');
});

test('a day with nothing to check changes nothing, and the scheduled run is quiet', async () => {
  const r = await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(r.body.ran || []).includes('fair'), false);
});
