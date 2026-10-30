'use strict';
// The public club page: off until an administrator turns it on, team results only, nothing about riders or private links.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby'];
before(async () => {
  const world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Secret Rider ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
const A = { get token() { return admin; } };
const ID = i => String(2000 + i);
beforeEach(() => { app.world.db = {}; });

async function seed() {
  for (let i = 0; i < 5; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  await app.post('/api/ladder/meta', { rung: 9 }, A);
  const played = (await app.post('/api/ladder/match', { opponent: 'Team Rocket', challenger: 'us', eventLink: 'https://www.zwift.com/events/view/5?eventSecret=PRIVATE' }, A)).body.matches[0];
  await app.post('/api/ladder/lineup', { match: played.id, zwids: [0, 1, 2, 3, 4].map(ID) }, A);
  await app.post('/api/ladder/result', { match: played.id, positions: Object.fromEntries([1, 2, 3, 5, 7].map((p, i) => [ID(i), p])) }, A);
  const t = new Date(Date.now() + 5 * 86400000);
  await app.post('/api/ladder/match', { opponent: 'Next Up', challenger: 'us', date: t.toISOString().slice(0, 10), time: '19:30', eventLink: 'https://www.zwift.com/events/view/6?eventSecret=PRIVATE2' }, A);
  await app.post('/api/drs/season', { name: 'DRS Autumn', division: 'Platinum', threshold: 5000, time: '19:30', tz: 'Europe/London' }, A);
  await app.post('/api/drs/squad', { zwid: ID(0), force: true }, A);
  const st = (await app.post('/api/drs/stage', { type: 'scratch', route: 'Dirt Loop', date: '2026-11-03', eventLink: 'https://www.zwift.com/events/view/7?eventSecret=PRIVATE3' }, A)).body.stages[0];
  await app.post('/api/drs/result', { stage: st.id, results: { [ID(0)]: { pos: 1, pts: 120 } } }, A);
}

test('off until an administrator turns it on: 404 for everyone, a moderator can read the setting but not change it', async () => {
  assert.equal((await app.get('/api/public/club')).status, 404);
  assert.equal((await app.get('/api/public/settings')).status, 401);
  assert.equal((await app.get('/api/public/settings', A)).body.on, false);
  const mod = await app.login('mod');
  assert.equal((await app.post('/api/public/settings', { on: true }, { token: mod })).status, 403);
  assert.equal((await app.get('/api/public/settings', { token: mod })).body.canChange, false);
  assert.equal((await app.post('/api/public/settings', { on: true }, A)).body.on, true);
  assert.equal((await app.get('/api/public/club')).status, 200, 'no sign-in needed once it is on');
  await app.post('/api/public/settings', { on: false }, A);
  assert.equal((await app.get('/api/public/club')).status, 404);
});

test('it shows the tables, results and next races, and nothing about people or private links', async () => {
  await seed();
  await app.post('/api/public/settings', { on: true }, A);
  const r = await app.get('/api/public/club');
  assert.equal(r.status, 200);
  const d = r.body, text = JSON.stringify(d);
  assert.deepEqual([d.ladder[0].won, d.ladder[0].lost, d.ladder[0].rung], [1, 0, 9]);
  assert.equal(d.ladder[0].recent[0].opponent, 'Team Rocket');
  assert.deepEqual([d.drs[0].division, d.drs[0].teamPoints, d.drs[0].stages[0].route], ['Platinum', 120, 'Dirt Loop']);
  assert.ok(d.next.some(n => n.series === 'Ladder' && /Next Up/.test(n.title)));
  assert.ok(!/Secret Rider/.test(text), 'no rider names');
  assert.ok(!/eventSecret|PRIVATE|events\/view/.test(text), 'no private links');
  assert.ok(!/"zwid"|"zwift_id"|lineup/i.test(text), 'no ids or line-ups');
});

test('the page itself is served', async () => {
  const r = await app.call('GET', '/club.html');
  assert.equal(r.status, 200);
  assert.match(String(r.body), /CRYO-GEN/);
});
