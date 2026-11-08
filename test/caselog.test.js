'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createCaseLog = require('../lib/caselog');

h.setEnv();
let app, admin, mod;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());

const entry = (o = {}) => ({ zwift_id: '1001', event_name: 'ZRL round 3', event_date: '2026-10-20', indicators: ['constant_offset'], outcome: 'clarified', escalated: false, note: 'Second recording read 9% high; rider changed trainer calibration.', ...o });

test('every route is administrator only: moderators, members and the public are refused', async () => {
  for (const [m, p, b] of [['get', '/api/caselog'], ['post', '/api/caselog/add', entry()], ['post', '/api/caselog/delete', { id: 'x' }], ['post', '/api/caselog/settings', { retentionMonths: 6 }], ['post', '/api/caselog/purge', {}]]) {
    assert.equal((await app[m](p, ...(b ? [b, { token: mod }] : [{ token: mod }]))).status, 403, `${p} as mod`);
    assert.equal((await app[m](p, ...(b ? [b] : []))).status, 401, `${p} signed out`);
  }
  assert.equal((await app.get('/api/caselog', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
});

test('add, list (with the name from the roster) and delete', async () => {
  const r = await app.post('/api/caselog/add', entry(), { token: admin });
  assert.equal(r.status, 200);
  assert.ok(r.body.entry.created_by && r.body.entry.created_at);
  const list = (await app.get('/api/caselog', { token: admin })).body;
  assert.equal(list.retentionMonths, 12, 'default retention is 12 months');
  const e = list.entries.find(x => x.id === r.body.entry.id);
  assert.equal(e.zwift_id, '1001'); assert.ok(e.rider_name, 'the name is added for staff when the log is opened');
  assert.equal(JSON.stringify(r.body.entry).includes('rider_name'), false, 'the stored entry holds the ID, not the name');
  assert.equal((await app.post('/api/caselog/delete', { id: e.id }, { token: admin })).status, 200);
  assert.equal((await app.post('/api/caselog/delete', { id: e.id }, { token: admin })).status, 404);
});

test('bad input is refused with a plain message', async () => {
  for (const bad of [{ zwift_id: 'abc' }, { event_name: '' }, { event_date: '20/10/2026' }, { outcome: 'banned' }, { indicators: ['made_up'] }, { note: 'x'.repeat(301) }]) {
    const r = await app.post('/api/caselog/add', entry(bad), { token: admin });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 40)); assert.ok(r.body.error);
  }
  assert.equal((await app.post('/api/caselog/add', entry({ note: 'x'.repeat(300) }), { token: admin })).status, 200, '300 characters is allowed');
});

test('retention: entries older than the period are purged, newer ones stay, and the period is configurable', async () => {
  const store = {};
  const redis = async cmds => cmds.map(([c, k, ...a]) => {
    const t = store[k] = store[k] || {};
    if (c === 'HSET') { t[a[0]] = a[1]; return 1; } if (c === 'HGET') return t[a[0]] ?? null;
    if (c === 'HGETALL') return Object.entries(t).flat(); if (c === 'HDEL') { let n = 0; for (const f of a) if (f in t) { delete t[f]; n++; } return n; }
  });
  const cl = createCaseLog({ redis, HttpError: Error, requireRole() {} });
  const put = (id, at) => redis([['HSET', 'cg:cases:log', id, JSON.stringify({ id, created_at: at })]]);
  await put('old', '2025-09-01T00:00:00.000Z'); await put('mid', '2026-03-01T00:00:00.000Z'); await put('new', '2026-10-01T00:00:00.000Z');
  assert.equal(await cl.purge(Date.parse('2026-11-08T00:00:00Z')), 1, '12 months: only the oldest goes');
  assert.equal((await cl.routes['POST /api/caselog/settings'](null, { retentionMonths: 6 })).retentionMonths, 6);
  await put('mid', '2026-03-01T00:00:00.000Z'); await put('new', '2026-10-01T00:00:00.000Z');
  await cl.purge(Date.parse('2026-11-08T00:00:00Z'));
  assert.deepEqual(Object.keys(store['cg:cases:log']), ['new'], 'a 6 month period also removes the March entry');
  await assert.rejects(() => cl.routes['POST /api/caselog/settings'](null, { retentionMonths: 0 }));
});
