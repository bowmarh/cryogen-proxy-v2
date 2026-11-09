'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, token;
before(async () => {
  const world = h.createWorld({ riders: [{ riderId: 2000, name: 'Ann Lee', country: 'gb', zpCategory: 'B', power: { wkg300: 4.1, wkg1200: 3.3 }, race: { finishes: 12, wins: 1, podiums: 3, current: { rating: 1500, mixed: { category: 'Ruby' } } } }] });
  app = await h.startApp(world); token = await app.memberSession('2000', { name: 'Ann Lee' });
});
after(() => app.close());
beforeEach(() => { app.world.discord.length = 0; });

test('Wrapped is for the signed-in rider, built from their own record, with a vELO change from their line', async () => {
  assert.equal((await app.get('/api/me/wrapped')).status, 401);
  app.world.db['cg:rider:velo'] = { 2000: JSON.stringify([['2026-09-01', 1380], ['2026-10-01', 1450]]) };
  const w = (await app.get('/api/me/wrapped', { token })).body;
  assert.equal(w.title, "Ann's season"); assert.equal(w.empty, false);
  const by = Object.fromEntries(w.stats.map(x => [x.label, x.value]));
  assert.equal(by['Races finished'], '12'); assert.equal(by.Wins, '1'); assert.equal(by.Podiums, '3');
  assert.match(by['vELO since 2026-09-01'], /\+120 \(now 1500\)/);
  assert.match(by['W/kg'], /4\.10 \(5 min\)/);
  assert.ok(w.badges.some(b => b.label === '10 races'));
  assert.ok(w.lines.some(l => /vELO up 120 to 1500/.test(l)));
});

test('sharing is the rider\'s own choice: it posts the sentences, never the registered weight, once a day', async () => {
  const r = await app.post('/api/me/wrapped/share', {}, { token });
  assert.equal(r.status, 200);
  const post = app.world.discord.find(p => p.channel === 'public');
  assert.ok(post && /Ann's season/.test(post.body.content) && /12 races finished/.test(post.body.content));
  assert.equal(/weight|kg\b/i.test(post.body.content.replace(/W\/kg/g, '')), false);
  assert.equal((await app.post('/api/me/wrapped/share', {}, { token })).status, 429);
  assert.equal((await app.post('/api/me/wrapped/share', {})).status, 401);
});

test('a rider with almost nothing yet gets no card and cannot share an empty one', async () => {
  const t = await app.memberSession('9999', { name: 'New Rider' });
  const w = (await app.get('/api/me/wrapped', { token: t })).body;
  assert.equal(w.empty, true);
  assert.equal((await app.post('/api/me/wrapped/share', {}, { token: t })).status, 409);
});
