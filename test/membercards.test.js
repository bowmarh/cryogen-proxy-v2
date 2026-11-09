'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, rider, token;
before(async () => { app = await h.startApp(h.createWorld()); token = await app.memberSession('1002', { name: 'Rider Two' }); rider = app.world.riders.find(r => String(r.riderId) === '1002'); });
after(() => app.close());
beforeEach(() => { app.world.discord.length = 0; });
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

test('recap: needs a signed-in member and builds lines from the riders own numbers', async () => {
  assert.equal((await app.get('/api/me/recap')).status, 401);
  const r = (await app.get('/api/me/recap', { token })).body;
  assert.ok(r.velo.now > 0); assert.match(r.lines.join(' '), /vELO/);
});

test('recap: vELO change is measured against the reading about a week ago', async () => {
  const now = Math.round(rider.race.current.rating), d = daysAgo(7).slice(0, 10);
  app.world.db['cg:fair:snap'] = { '1002': JSON.stringify([{ d, w: 0, p5: 4, p20: 3, v: now - 40 }]) };
  const r = (await app.get('/api/me/recap', { token })).body;
  assert.equal(r.velo.change, 40); assert.equal(r.velo.days, 7);
  assert.match(r.lines.find(l => l.includes('vELO')), /\+40 in 7 days/);
  assert.equal(r.headline.startsWith('Nice climb'), true);
  assert.equal(JSON.stringify(r).includes('"w"'), false, 'registered weight never leaves the private snapshot');
});

test('recap: shared to the club channel only when pressed, and once a day', async () => {
  const a = await app.post('/api/me/recap/share', {}, { token });
  assert.equal(a.status, 200);
  const post = app.world.discord.find(p => p.channel === 'public'); assert.ok(post && /vELO/.test(post.body.content));
  assert.equal((await app.post('/api/me/recap/share', {}, { token })).status, 429);
  assert.equal((await app.post('/api/me/recap/share', {})).status, 401);
});

test('checklist: only for new members, ticks off as they go, and hides when complete or after 60 days', async () => {
  assert.equal((await app.get('/api/onboarding/me')).status, 401);
  assert.equal((await app.get('/api/onboarding/me', { token })).body.show, false, 'not seen as new: no checklist');
  app.world.db['cg:onboard:seen'] = { '1002': JSON.stringify({ at: daysAgo(3), seed: false }) };
  let c = (await app.get('/api/onboarding/me', { token })).body;
  assert.equal(c.show, true); assert.equal(c.total, 5);
  assert.deepEqual(c.steps.map(s => s.id), ['discord', 'category', 'series', 'standard', 'raced']);
  assert.equal(c.steps.find(s => s.id === 'category').done, true, 'the category comes from the roster');
  assert.equal(c.steps.find(s => s.id === 'standard').done, false);
  const before = c.done;
  c = (await app.post('/api/onboarding/ack', {}, { token })).body;
  assert.equal(c.done, before + 1); assert.equal(c.steps.find(s => s.id === 'standard').done, true);
  app.world.db['cg:onboard:seen'] = { '1002': JSON.stringify({ at: daysAgo(61), seed: false }) };
  assert.equal((await app.get('/api/onboarding/me', { token })).body.show, false, 'after 60 days it is left alone');
  app.world.db['cg:onboard:seen'] = { '1002': JSON.stringify({ at: daysAgo(2), seed: true }) };
  assert.equal((await app.get('/api/onboarding/me', { token })).body.show, false, 'members who were already here never see it');
});

test('the staff onboarding list still works', async () => {
  const admin = await app.login('admin');
  assert.equal((await app.get('/api/onboarding', { token: admin })).status, 200);
  assert.equal((await app.get('/api/onboarding', { token })).status, 401, 'members cannot see the staff list');
});
