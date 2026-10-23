'use strict';
// ZwiftRacing.app event lookup (admin): the key stays on the server; the answer's shape is returned so it can be understood.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => { delete process.env.ZWIFTRACING_API_KEY; app.close(); });
beforeEach(() => { process.env.ZWIFTRACING_API_KEY = 'zr-secret-key'; world.zr = { status: 200, body: { eventId: 5, results: [{ riderId: 1, position: 1, name: 'A', time: 3600.5, team: null }] }, seen: [] }; });

const look = (q, token = admin) => app.get(`/api/zrl/zr-event${q}`, { token });

test('admin only; needs the key and a numeric event id', async () => {
  assert.equal((await look('?id=5', null)).status, 401);
  assert.equal((await look('?id=5', mod)).status, 403, 'a moderator is not an admin');
  assert.equal((await look('?id=abc')).status, 400);
  assert.equal((await look('')).status, 400);
  delete process.env.ZWIFTRACING_API_KEY;
  const r = await look('?id=5'); assert.equal(r.status, 503); assert.match(r.body.error, /ZWIFTRACING_API_KEY/);
});

test('it calls the results endpoint with the raw key, and shows the shape without the key', async () => {
  const r = await look('?id=5');
  assert.equal(r.status, 200);
  assert.deepEqual(world.zr.seen, [{ path: '/api/public/results/5', auth: 'zr-secret-key' }], 'the raw key in Authorization, no Bearer');
  assert.deepEqual(r.body.shape, { eventId: 'number', results: [{ riderId: 'number', position: 'number', name: 'string', time: 'number', team: 'null' }, '(1 items)'] });
  assert.equal(r.body.status, 200); assert.ok(JSON.parse(r.body.body).results[0].riderId === 1);
  assert.ok(!JSON.stringify(r.body).includes('zr-secret-key'), 'the key never leaves the server');
  await look('?id=5&source=zp');
  assert.equal(world.zr.seen[1].path, '/api/public/zp/5/results', 'the ZwiftPower view too');
});

test('their errors are shown as they are (a rate limit, a bad key)', async () => {
  world.zr = { status: 429, body: { message: 'Too many', retryAfter: 41, windowMinutes: 1, limit: 1 }, seen: [] };
  let r = await look('?id=5'); assert.equal(r.status, 200); assert.equal(r.body.status, 429);
  assert.equal(JSON.parse(r.body.body).retryAfter, 41);
  world.zr = { status: 401, body: { message: 'Unauthorized' }, seen: [] };
  r = await look('?id=5'); assert.equal(r.body.status, 401);
});
