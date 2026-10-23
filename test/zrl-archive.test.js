'use strict';
// Past rounds: staff can list and look at them, rename them, correct their results; admins can delete them (and the current round).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
});
after(() => app.close());

const list = token => app.get('/api/zrl/archive', { token });
const one = (id, token = admin) => app.get(`/api/zrl/archive?id=${id}`, { token });

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: '2026-11-17', closes: h.ymd(10), weeks: 2 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', division: 'Division 1' }, { name: 'CRYO-GEN Beta', region: 'eu', division: 'Division 1' }] }, { token: admin });
  for (const [n, z, t] of [['Rider 2', '1002', 'cryo-gen-alpha'], ['Ann Able', '4378027', 'cryo-gen-alpha'], ['Bob Baker', '2436518', 'cryo-gen-beta']]) {
    await app.post('/api/zrl/signup', { name: n, zwid: z, regions: ['eu'], cat: 'C' });
    await app.post('/api/zrl/assign', { key: z, team: t }, { token: admin });
  }
  await app.post('/api/zrl/captain', { team: 'cryo-gen-alpha', key: '1002' }, { token: admin });
  await app.post('/api/zrl/results', { week: 0, rows: [{ team: 'cryo-gen-alpha', pos: 2, pts: 100 }, { team: 'cryo-gen-beta', pos: 1, pts: 120 }] }, { token: admin });
  await app.post('/api/zrl/round', { name: 'Round 3', start: '2027-01-12', closes: h.ymd(10) }, { token: admin });   // archives Round 2
});

test('past rounds are staff only; the list and a round show names, rosters and the standings', async () => {
  assert.equal((await list(null)).status, 401);
  assert.equal((await list(await app.memberSession('1002'))).status, 401);
  const rounds = (await list(mod)).body.rounds;
  assert.deepEqual(rounds.map(r => [r.id, r.name, r.teams, r.riders]), [['2026-11-17', 'Round 2', 2, 3]]);
  const r = (await one('2026-11-17', mod)).body;
  assert.deepEqual(r.teams.map(t => [t.name, t.captainName, t.riders]), [['CRYO-GEN Alpha', 'Rider 2', ['Ann Able', 'Rider 2']], ['CRYO-GEN Beta', '', ['Bob Baker']]]);
  assert.deepEqual(r.standings.groups[0].teams.map(t => [t.name, t.total, t.rank]), [['CRYO-GEN Beta', 120, 1], ['CRYO-GEN Alpha', 100, 2]]);
  assert.equal((await one('1999-01-01')).status, 404);
});

test('a past round can be renamed and its results corrected, by any staff', async () => {
  const edit = (body, token = mod) => app.post('/api/zrl/archive-edit', { id: '2026-11-17', ...body }, { token });
  assert.equal((await edit({ name: 'x' }, null)).status, 401);
  assert.equal((await edit({ name: '' })).status, 400);
  assert.equal((await edit({ name: 'Round 2 · Team Tempo' })).status, 200);
  assert.equal((await edit({ week: 1, rows: [{ team: 'cryo-gen-alpha', pos: 1, pts: 150 }] })).status, 200);
  assert.equal((await edit({ week: 0, rows: [{ team: 'cryo-gen-beta', pos: '', pts: '' }] })).status, 200, 'clearing a result');
  assert.equal((await edit({ week: 0, rows: [{ team: 'cryo-gen-beta', pos: 0 }] })).status, 400, 'same checks as live results');
  assert.equal((await edit({ week: 5, rows: [{ team: 'cryo-gen-beta', pos: 1 }] })).status, 400);
  const r = (await one('2026-11-17')).body;
  assert.equal(r.name, 'Round 2 · Team Tempo');
  assert.deepEqual(r.standings.groups[0].teams.map(t => [t.name, t.total]), [['CRYO-GEN Alpha', 250]]);
  assert.equal((await list(admin)).body.rounds[0].name, 'Round 2 · Team Tempo');
  assert.equal(JSON.parse(app.world.db['cg:zrl:archive']['2026-11-17']).assign['1002'], 'cryo-gen-alpha', 'the rest of the snapshot is untouched');
});

test('deleting is admin only: a past round, and the current round once its start date is confirmed', async () => {
  assert.equal((await app.post('/api/zrl/archive-delete', { id: '2026-11-17' }, { token: mod })).status, 403, 'a moderator is not an admin');
  assert.equal((await app.post('/api/zrl/archive-delete', { id: 'nope' }, { token: admin })).status, 404);
  assert.equal((await app.post('/api/zrl/archive-delete', { id: '2026-11-17' }, { token: admin })).status, 200);
  assert.deepEqual((await list(admin)).body.rounds, []);

  await app.post('/api/zrl/signup', { name: 'Ann Able', zwid: '4378027', regions: ['eu'], cat: 'C' });
  assert.equal((await app.post('/api/zrl/round-delete', { confirm: '2027-01-12' }, { token: mod })).status, 403);
  assert.equal((await app.post('/api/zrl/round-delete', { confirm: 'yes' }, { token: admin })).status, 400, 'must say which round');
  assert.equal((await app.post('/api/zrl/round-delete', { confirm: '2027-01-12' }, { token: admin })).status, 200);
  const s = (await app.get('/api/zrl', { token: admin })).body;
  assert.equal(s.round, null); assert.deepEqual(s.signups, []);
  assert.deepEqual(Object.keys(app.world.db['cg:zrl:sent'] || {}).filter(k => k.startsWith('2027-01-12:')), [], 'its scheduled-post marks go too');
});
