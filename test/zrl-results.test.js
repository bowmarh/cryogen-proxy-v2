'use strict';
// Results and standings: staff enter each team's finish and points per race; everyone sees the standings per division.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

const save = (week, rows, token = admin) => app.post('/api/zrl/results', { week, rows }, { token });
const standings = token => app.get('/api/zrl/standings', { token }).then(r => r.body);

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0;
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(-14), closes: h.ymd(-20), weeks: 3 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [
    { name: 'CRYO-GEN Alpha', region: 'eu', division: 'Division 1' }, { name: 'CRYO-GEN Beta', region: 'eu', division: 'Division 1' },
    { name: 'CRYO-GEN Gamma', region: 'am', division: 'Division 2' }, { name: 'CRYO-GEN Quiet', region: 'am', division: 'Division 2' }] }, { token: admin });
});

test('entering results is staff only and validated; blanks clear an entry', async () => {
  const rows = [{ team: 'cryo-gen-alpha', pos: 3, pts: 120 }];
  assert.equal((await save(0, rows, null)).status, 401);
  assert.equal((await save(0, rows, await app.memberSession('1002'))).status, 401);
  assert.equal((await save(9, rows)).status, 400, 'no such week');
  assert.equal((await save(0, [])).status, 400);
  assert.equal((await save(0, [{ team: 'nope', pos: 1 }])).status, 404);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pos: 0 }])).status, 400);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pos: 2.5 }])).status, 400);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pts: -1 }])).status, 400);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pts: 'lots' }])).status, 400);
  assert.equal((await save(0, rows)).status, 200);
  assert.equal((await standings()).groups[0].teams[0].total, 120);
  assert.equal((await save(0, [{ team: 'cryo-gen-alpha', pos: '', pts: '' }])).status, 200);
  assert.deepEqual((await standings()).groups, [], 'cleared');
});

test('standings rank teams within their division by total points, then best finish, with shared ranks for ties; teams with nothing yet are left out', async () => {
  await save(0, [{ team: 'cryo-gen-alpha', pos: 2, pts: 100 }, { team: 'cryo-gen-beta', pos: 1, pts: 120 }, { team: 'cryo-gen-gamma', pos: 5, pts: 50 }]);
  await save(1, [{ team: 'cryo-gen-alpha', pos: 1, pts: 130 }, { team: 'cryo-gen-beta', pos: 4, pts: 110 }]);
  const s = await standings();
  assert.equal(s.dates.length, 3);
  assert.deepEqual(s.groups.map(g => g.name), ['Division 1', 'Division 2']);
  const d1 = s.groups[0].teams;
  assert.deepEqual(d1.map(t => [t.name, t.total, t.best, t.rank, t.races]), [['CRYO-GEN Alpha', 230, 1, 1, 2], ['CRYO-GEN Beta', 230, 1, 1, 2]], 'level on points and best finish: shared rank');
  assert.deepEqual(d1[0].weeks.map(w => w && [w.pos, w.pts]), [[2, 100], [1, 130], null]);
  assert.deepEqual(s.groups[1].teams.map(t => t.name), ['CRYO-GEN Gamma'], 'a team with no result is not listed');
  assert.equal(s.entries, undefined, 'the public does not get the raw entries');
});

test('staff also get the raw entries with notes, and starting the next round archives and clears the results', async () => {
  await save(0, [{ team: 'cryo-gen-alpha', pos: 1, pts: 150, note: 'won the sprint' }]);
  const staff = await standings(admin);
  assert.equal(staff.entries['0:cryo-gen-alpha'].note, 'won the sprint');
  await app.post('/api/zrl/round', { name: 'Round 3', start: h.ymd(30), closes: h.ymd(25) }, { token: admin });
  assert.deepEqual((await standings()).groups, []);
  const id = Object.keys(app.world.db['cg:zrl:archive'])[0];
  assert.equal(JSON.parse(app.world.db['cg:zrl:archive'][id]).results['0:cryo-gen-alpha'].pts, 150);
});

test('level on points, the better best finish ranks higher; more points always wins', async () => {
  await save(0, [{ team: 'cryo-gen-alpha', pos: 3, pts: 100 }, { team: 'cryo-gen-beta', pos: 2, pts: 100 }]);
  assert.deepEqual((await standings()).groups[0].teams.map(t => [t.name, t.rank]), [['CRYO-GEN Beta', 1], ['CRYO-GEN Alpha', 2]]);
  await save(1, [{ team: 'cryo-gen-alpha', pts: 5 }]);
  assert.deepEqual((await standings()).groups[0].teams.map(t => [t.name, t.rank]), [['CRYO-GEN Alpha', 1], ['CRYO-GEN Beta', 2]], 'points count even with no position');
});

test('posting the standings to Discord and exporting them as a spreadsheet', async () => {
  const post = (token = admin) => app.post('/api/zrl/post-standings', {}, { token });
  const exp = (kind, token = admin) => app.get(`/api/zrl/results-export${kind ? `?kind=${kind}` : ''}`, { token });
  assert.equal((await post(null)).status, 401);
  assert.equal((await exp('', null)).status, 401);
  assert.equal((await post()).status, 409, 'nothing to post yet');
  assert.equal((await exp()).status, 409);
  await save(0, [{ team: 'cryo-gen-alpha', pos: 2, pts: 100, note: '=HYPERLINK("x")' }, { team: 'cryo-gen-beta', pos: 1, pts: 120 }, { team: 'cryo-gen-gamma', pos: 11, pts: 5 }]);
  app.world.discord.length = 0;
  assert.equal((await post()).status, 200);
  const text = app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content).join('\n');
  assert.match(text, /standings after race 1/);
  assert.match(text, /\*\*Division 1\*\*\n1\. Beta · 120 pts \(best 1st\)\n2\. Alpha · 100 pts \(best 2nd\)/);
  assert.match(text, /\*\*Division 2\*\*\n1\. Gamma · 5 pts \(best 11th\)/);
  assert.equal((await post()).status, 429, 'not twice in five minutes');
  const standings = (await exp()).body;
  assert.equal(standings.filename, 'round-2-standings.csv');
  assert.match(standings.csv, /^Division,Rank,Team,Points,Races,Best finish,Race 1 \(/);
  assert.match(standings.csv, /Division 1,1,CRYO-GEN Beta,120,1,1,1st · 120 pts/);
  const results = (await exp('results')).body;
  assert.equal(results.filename, 'round-2-results.csv');
  assert.match(results.csv, /^Race,Date,Team,Division,League,Position,Points,Note/);
  assert.match(results.csv, /1,2026-11-17,CRYO-GEN Alpha,Division 1,,2,100,'=HYPERLINK\("x"\)|"'=HYPERLINK/, 'a note that looks like a formula is neutralised');
});

test('a long standings post is split below the Discord message limit', async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `CRYO-GEN Team ${String(i).padStart(2, '0')} with a rather long name`, region: 'eu', division: `Division ${i % 3 + 1}` }));
  await app.post('/api/zrl/teams', { teams: many }, { token: admin });
  await save(0, many.map((t, i) => ({ team: t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), pos: i + 1, pts: 100 - i })));
  app.world.discord.length = 0;
  assert.equal((await app.post('/api/zrl/post-standings', {}, { token: admin })).status, 200);
  const msgs = app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content);
  assert.ok(msgs.every(m => m.length <= 2000), 'every message fits');
  assert.match(msgs[msgs.length - 1], /Full table: /);
});
