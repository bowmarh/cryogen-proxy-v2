'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ WP_API_USER: null, WP_API_APP_PASSWORD: null });
let app;
before(async () => { app = await h.startApp(h.createWorld()); });
after(() => app.close());

test('without WordPress credentials the live roster still loads and members are unknown', async () => {
  const r = await app.get('/api/roster');
  assert.equal(r.status, 200);
  assert.equal(r.body.riders.length, 5);
  assert.equal(r.body.members, null);
  assert.equal(r.body.membersError, undefined, 'the reason is for staff only');
  const staff = await app.get('/api/roster', { token: await app.login('admin') });
  assert.match(staff.body.membersError, /not configured/);
});

test('member edits say so plainly instead of failing oddly', async () => {
  const r = await app.post('/api/members/1000', { tier: 'half' }, { token: await app.login('admin') });
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not configured/i);
});

test('member sign-in still works from the roster, without member records', async () => {
  const session = await app.memberSession('1002');
  const me = await app.get('/api/me', { token: session });
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'Rider 2');
  assert.equal(me.body.tier, null);
});
