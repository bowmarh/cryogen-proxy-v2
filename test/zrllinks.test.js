'use strict';
// ZRL league links (RacePass, results, standings): an administrator sets them, everyone signed in can read them.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
h.setEnv();
let app, admin, mod;
before(async () => { app = await h.startApp(h.createWorld({ riders: [] })); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());

test('an administrator saves the three links; staff read them; a moderator cannot change them', async () => {
  assert.equal((await app.get('/api/zrl/links')).status, 401);
  const empty = await app.get('/api/zrl/links', { token: mod }); assert.equal(empty.status, 200); assert.deepEqual([empty.body.racepass, empty.body.results, empty.body.standings, empty.body.canEdit], ['', '', '', false]);
  assert.equal((await app.post('/api/zrl/links', { racepass: 'https://example.com/rp' }, { token: mod })).status, 403);
  const r = await app.post('/api/zrl/links', { racepass: 'https://example.com/rp', results: 'https://example.com/res', standings: '' }, { token: admin });
  assert.equal(r.status, 200); assert.equal(r.body.racepass, 'https://example.com/rp');
  const back = await app.get('/api/zrl/links', { token: mod }); assert.equal(back.body.results, 'https://example.com/res'); assert.equal(back.body.canEdit, false);
  assert.equal((await app.get('/api/zrl/links', { token: admin })).body.canEdit, true);
});

test('only https links are accepted', async () => {
  assert.equal((await app.post('/api/zrl/links', { racepass: 'javascript:alert(1)' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/zrl/links', { results: 'http://example.com' }, { token: admin })).status, 400);
  assert.equal((await app.post('/api/zrl/links', { standings: 'https://example.com/a b' }, { token: admin })).status, 400);
});
