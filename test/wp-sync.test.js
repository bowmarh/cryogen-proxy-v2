'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

h.setEnv({ WP_SYNC_SECRET: 'sync-secret' });
let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());

const sign = (body, secret = 'sync-secret') => crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
const ping = (body, sig = sign(body)) => app.call('POST', '/api/wp/members-changed', { body, headers: { 'Content-Type': 'application/json', 'X-Cryogen-Signature': sig } });
const now = () => Math.floor(Date.now() / 1000);

test('a WordPress edit shows in the app straight away, not after the cache runs out', async () => {
  const first = await app.get('/api/roster');
  const id = String(world.members[0].zwift_id);
  assert.notEqual(first.body.members.find(m => String(m.zwift_id) === id).status, 'suspended');
  world.members[0].status = 'suspended';   // changed on cryogen.team
  const cached = await app.get('/api/roster');
  assert.notEqual(cached.body.members.find(m => String(m.zwift_id) === id).status, 'suspended', 'without the ping the cached copy is still served');
  const r = await ping({ event: 'member_updated', zwift_id: id, ts: now() });
  assert.equal(r.status, 200);
  const fresh = await app.get('/api/roster');
  assert.equal(fresh.body.members.find(m => String(m.zwift_id) === id).status, 'suspended');
});

test('unsigned, wrongly signed and replayed pings are refused', async () => {
  const body = { event: 'member_updated', ts: now() };
  assert.equal((await ping(body, '')).status, 401);
  assert.equal((await ping(body, sign(body, 'wrong'))).status, 401);
  const old = { event: 'member_updated', ts: now() - 3600 };
  assert.equal((await ping(old)).status, 401);
});

test('an associate tier saved by WordPress as "half" counts as saved (plugin 1.24.6 stores both names as half)', async () => {
  const rec = world.members.find(m => m.tier === 'full') || world.members[0];
  world.patchApply = (r, body) => Object.assign(r, body, body.tier === 'associate' ? { tier: 'half' } : {});
  world.patchEcho = [];   // nothing echoed: the check must rely on the re-read
  const token = await app.login('admin');
  const r = await app.post(`/api/members/${rec.zwift_id}`, { tier: 'associate' }, { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(rec.tier, 'half');
  const bulk = await app.post('/api/members/bulk', { zwids: [String(rec.zwift_id)], changes: { tier: 'associate' } }, { token });
  assert.equal(bulk.body.saved, 1, JSON.stringify(bulk.body));
});
