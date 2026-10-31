'use strict';
// The go-live checklist: what is on, what is missing, the next step for each, and never a secret.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => { for (const k of ['DISCORD_PUBLIC_KEY', 'ANTHROPIC_API_KEY', 'DISCORD_BOT_TOKEN']) delete process.env[k]; return app.close(); });
const A = { get token() { return admin; } };
beforeEach(() => { app.world.db = {}; });
const by = items => Object.fromEntries(items.map(i => [i.id, i]));

test('administrators only; each item has a state and what to do next', async () => {
  assert.equal((await app.get('/api/golive')).status, 401);
  assert.equal((await app.get('/api/golive', { token: await app.login('mod') })).status, 403);
  const r = (await app.get('/api/golive', A)).body, items = by(r.items);
  for (const i of r.items) { assert.ok(['ok', 'todo', 'off'].includes(i.state)); assert.ok(i.title && i.detail); }
  assert.equal(items.db.state, 'ok');
  assert.equal(items.buttons.state, 'off'); assert.match(items.buttons.how, /DISCORD_PUBLIC_KEY/);
  assert.equal(items.staff.state, 'todo'); assert.equal(items.assistant.state, 'off');
  assert.equal(r.ready, r.todo === 0);
});

test('switching things on moves them to ok, counts reach and captains, and shows no key', async () => {
  process.env.DISCORD_PUBLIC_KEY = 'a'.repeat(64); process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value';
  await app.post('/api/staff', { username: 'ann', name: 'Ann', role: 'mod', password: 'long-enough-1' }, A);
  await app.post('/api/ladder/roster', { zwid: '1002', name: 'Rider Two' }, A);
  await app.post('/api/ladder/captains', { zwids: ['1002'] }, A);
  const r = (await app.get('/api/golive', A)).body, items = by(r.items);
  assert.equal(items.buttons.state, 'ok'); assert.equal(items.assistant.state, 'ok'); assert.equal(items.staff.state, 'ok');
  assert.equal(items.captains.state, 'ok');
  assert.ok(!JSON.stringify(r).includes('sk-ant-secret-value') && !JSON.stringify(r).includes('a'.repeat(64)), 'no key is ever shown');
  assert.match(items.reach.detail, /\d+% of active members|\d+ of \d+/);
});
