'use strict';
// TTT extras taken from the ZRL: a race-day summary, a one-click ask for riders, and spreadsheet exports.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
before(async () => { app = await h.startApp(h.createWorld()); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const posts = channel => app.world.discord.filter(p => p.channel === channel).map(p => p.body.content);
const teams = async () => (await app.get('/api/ttt')).body.week.teams;
async function startWeek(date) {
  await app.post('/api/ttt/new-week', { date }, { token: admin });
  app.world.discord.length = 0;
  const t = await teams();
  for (const [name, tm] of [['Ann Able', t[0]], ['Bob Baker', t[0]], ['Cy Cook', t[1]]]) {
    await app.post('/api/ttt/signup', { name });
    await app.post('/api/ttt/assign', { name, teams: [tm.id] }, { token: admin });
  }
  return t;
}

test('on race day the staff get one summary of the week; not before; once', async () => {
  const t = await startWeek(h.ymd(3));
  assert.ok(!(await tick()).includes('digest'), 'three days out: nothing');
  const w = JSON.parse(app.world.db['cg:ttt:week']); app.world.db['cg:ttt:week'] = JSON.stringify({ ...w, date: h.ymd(0) });
  app.world.discord.length = 0;
  assert.ok((await tick()).includes('digest'));
  const text = posts('admin').find(p => /race day/.test(p));
  assert.match(text, /2 teams racing/);
  assert.match(text, /not published yet/);
  assert.match(text, new RegExp(`Under 4 riders: ${t[0].name} \\(2\\), ${t[1].name} \\(1\\)`));
  assert.match(text, /No captain yet: /);
  assert.ok(!(await tick()).includes('digest'), 'once');
});

test('asking for riders: staff only, sign-ups open, once a day, and it says how many teams are short', async () => {
  await startWeek(h.ymd(5));
  const ask = token => app.post('/api/ttt/recruit', {}, { token });
  assert.equal((await ask(null)).status, 401);
  const r = await ask(admin);
  assert.equal(r.status, 200); assert.equal(r.body.short, 2);
  assert.match(posts('public')[0], /we need more riders!.*3 signed up so far, and 2 teams are short of riders.*at least four/s);
  assert.equal((await ask(admin)).status, 429);
  await app.post('/api/ttt/status', { open: false }, { token: admin });
  app.world.db['cg:ttt:sent'] = {};
  assert.equal((await ask(admin)).status, 409, 'closed sign-ups refuse');
});

test('exports: this week\'s line-ups and the season\'s results, staff only, formulas neutralised', async () => {
  const t = await startWeek(h.ymd(5));
  await app.post('/api/ttt/captain', { team: t[0].id, name: 'Ann Able' }, { token: admin });
  await app.post('/api/ttt/signup', { name: '=SUM(1)' }); await app.post('/api/ttt/assign', { name: '=SUM(1)', teams: [t[1].id] }, { token: admin });
  const exp = (kind, token = admin) => app.get(`/api/ttt/export?kind=${kind}`, { token });
  assert.equal((await exp('lineups', null)).status, 401);
  const lineups = (await exp('lineups')).body;
  assert.equal(lineups.filename, `ttt-lineups-${h.ymd(5)}.csv`);
  assert.match(lineups.csv, /^Team,Level,Zone,Rider,Captain,Double-up/);
  assert.match(lineups.csv, new RegExp(`${t[0].name},[^\\n]*,Ann Able,yes,`));
  assert.match(lineups.csv, /'=SUM\(1\)/, 'a name that looks like a formula is neutralised');
  assert.equal((await exp('results')).status, 409, 'no results yet');
  await app.post('/api/ttt/results', { weekId: JSON.parse(app.world.db['cg:ttt:week']).id, results: { [t[0].id]: { position: 2, time: '41:07' }, [t[1].id]: { dnf: true } } }, { token: admin });
  const results = (await exp('results')).body;
  assert.match(results.csv, /^Date,Week,Team,Level,Zone,Position,Time,Did not finish,Captain,Riders/);
  assert.match(results.csv, new RegExp(`${t[0].name},[^\\n]*,2,41:07,,Ann Able,Ann Able; Bob Baker`));
  assert.match(results.csv, new RegExp(`${t[1].name},[^\\n]*,,,yes,`), 'a team that did not finish');
});
