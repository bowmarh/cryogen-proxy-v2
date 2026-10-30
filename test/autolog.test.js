'use strict';
// The automation log: what each automatic step changed, and undoing it once.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald'];
before(async () => {
  const world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
const A = { get token() { return admin; } };
const log = async () => (await app.get('/api/auto', A)).body.entries;
beforeEach(() => { app.world.db = {}; });

test('ZRL: a fix is logged and undoing it puts teams, captains and line-ups back; once only', async () => {
  await app.post('/api/zrl/round', { name: 'R', start: h.ymd(8), closes: h.ymd(10) }, A);
  await app.post('/api/zrl/teams', { teams: [{ name: 'Alpha', region: 'eu', grade: 'Open B', league: 'Purple' }] }, A);
  await app.post('/api/zrl/signup', { name: 'Lad 0', zwid: '2000', regions: ['eu'], cat: 'B', captain: true });
  await app.post('/api/zrl/fix', { apply: true }, A);
  let v = (await app.get('/api/zrl', A)).body;
  assert.equal(v.placements['2000'][0], 'alpha'); assert.equal(v.round.teams[0].captain, '2000');
  const [e] = await log();
  assert.equal(e.series, 'ZRL'); assert.match(e.summary, /Place riders on teams: 1/); assert.equal(e.by, 'staff'); assert.equal(e.undone, false);
  assert.equal((await app.post('/api/auto/undo', { id: e.id }, A)).status, 200);
  v = (await app.get('/api/zrl', A)).body;
  assert.equal(v.placements['2000'], undefined); assert.equal(v.round.teams[0].captain || '', '');
  assert.equal((await app.post('/api/auto/undo', { id: e.id }, A)).status, 409, 'once only');
  assert.equal((await log())[0].undone, true);
});

test('Ladder: a one-click line-up is logged and undone; staff only; unknown ids are 404', async () => {
  for (let i = 0; i < 6; i++) await app.post('/api/ladder/roster', { zwid: String(2000 + i) }, A);
  const t = new Date(Date.now() + 5 * 86400000), m = (await app.post('/api/ladder/match', { opponent: 'X', challenger: 'us', date: t.toISOString().slice(0, 10), time: '19:30' }, A)).body.matches[0];
  await app.post('/api/ladder/auto-lineup', { match: m.id }, A);
  assert.equal((await app.get('/api/ladder', A)).body.matches[0].lineup.length, 5);
  const [e] = await log();
  assert.equal(e.series, 'Ladder');
  assert.equal((await app.get('/api/auto')).status, 401);
  assert.equal((await app.post('/api/auto/undo', { id: e.id }, { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  assert.equal((await app.post('/api/auto/undo', { id: 'nope' }, A)).status, 404);
  await app.post('/api/auto/undo', { id: e.id }, A);
  assert.deepEqual((await app.get('/api/ladder', A)).body.matches[0].lineup, []);
});

test('the log only accepts plain data commands on the club\'s own keys', async () => {
  app.world.db['cg:auto:log'] = [JSON.stringify({ id: 'bad', ts: 'x', series: 'x', summary: 'x', undo: [['FLUSHALL']], undone: false })];
  assert.equal((await app.post('/api/auto/undo', { id: 'bad' }, A)).status, 400);
});
