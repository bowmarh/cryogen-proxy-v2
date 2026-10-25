'use strict';
// Several DIRT teams: each has its own season, squad, calendar and record; a rider can be in more than one squad.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const RATINGS = [1400, 1450, 1500, 1520, 1530, 1380, 1390, 1410];
before(async () => {
  world = h.createWorld({ riders: RATINGS.map((r, i) => ({ riderId: 3000 + i, name: `Dirt ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: r, mixed: { category: 'Platinum' } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const ID = i => String(3000 + i);
const get = (team, token = admin) => app.get(`/api/drs${team ? `?team=${team}` : ''}`, { token });
const post = (path, body, token = admin) => app.post(`/api/drs/${path}`, body, { token });
const ukParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const inHours = hrs => { const p = ukParts(Date.now() + hrs * 3600000); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
const SEASON = { name: 'DRS Autumn', division: 'Platinum', threshold: 1500, slot: 'Tuesday EU', time: '19:30', tz: 'Europe/London' };
const teamStage = async (team, extra = {}) => (await post('stage', { type: 'scratch', route: 'Dirt Loop', km: 28, team, ...extra })).body.stages.slice(-1)[0];

test('the first team added keeps the original one; teams are renamed, limited to 10 and need unique names', async () => {
  await post('season', SEASON);
  await post('squad', { zwid: ID(0), force: true });
  const r = await post('team', { name: 'Gold Squad' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.teams.map(t => [t.id, t.name, t.riders, t.division]), [['main', 'CRYO-GEN', 1, 'Platinum'], ['gold-squad', 'Gold Squad', 0, '']], 'the original keeps its season and rider');
  assert.equal((await post('team', { name: 'gold squad' })).status, 409);
  assert.equal((await post('team', { id: 'gold-squad', name: 'Gold Team' })).body.team.name, 'Gold Team');
  for (let i = 0; i < 8; i++) assert.equal((await post('team', { name: `Team ${i}` })).status, 200);
  const full = await post('team', { name: 'One too many' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /10 teams/);
  assert.equal((await post('team', { name: 'Nope' }, null)).status, 401);
});

test('each team has its own season, squad, calendar and record', async () => {
  await post('team', { name: 'Gold Squad' });
  assert.equal((await get('gold-squad')).body.season, null, 'a new team has no season yet');
  assert.equal((await post('squad', { zwid: ID(0), team: 'gold-squad', force: true })).status, 409, 'set the season first');
  await post('season', SEASON);
  await post('season', { ...SEASON, name: 'Gold Autumn', division: 'Gold', threshold: 1300, team: 'gold-squad' });
  assert.deepEqual([(await get('main')).body.season.division, (await get('gold-squad')).body.season.division], ['Platinum', 'Gold']);
  await post('squad', { zwid: ID(0), force: true });
  await post('squad', { zwid: ID(1), team: 'gold-squad', force: true });
  assert.deepEqual((await get('main')).body.squad.map(r => r.zwid), [ID(0)]);
  assert.deepEqual((await get('gold-squad')).body.squad.map(r => r.zwid), [ID(1)]);
  const st = await teamStage('gold-squad', { date: inHours(100).date });
  assert.equal(st.team, 'gold-squad');
  assert.equal((await get('main')).body.stages.length, 0, 'the other team has no stage');
  assert.equal((await get('nope')).status, 404);
  // stage routes find the team from the stage
  assert.equal((await post('roles', { stage: st.id, scorers: [ID(1)] })).status, 200);
  assert.equal((await post('roles', { stage: st.id, scorers: [ID(0)] })).status, 400, 'not in that team\'s squad');
  assert.equal((await post('result', { stage: st.id, results: { [ID(1)]: { pos: 1, pts: 20 } } })).status, 200);
  assert.deepEqual([(await get('gold-squad')).body.record.teamPoints, (await get('main')).body.record.teamPoints], [20, 0]);
});

test('the same rider can be in more than one squad, and two stages at the same time are flagged', async () => {
  await post('team', { name: 'Gold Squad' });
  await post('season', SEASON);
  await post('season', { ...SEASON, name: 'Gold Autumn', division: 'Gold', threshold: 1500, team: 'gold-squad' });
  for (const team of ['main', 'gold-squad']) assert.equal((await post('squad', { zwid: ID(0), team, force: true })).status, 200);
  const when = inHours(30);
  const a = await teamStage('main', { ...when });
  await teamStage('gold-squad', { ...when });
  const view = (await get('gold-squad')).body.stages[0];
  assert.deepEqual(view.clashes.map(c => [c.name, c.team]), [['Dirt 0', 'CRYO-GEN']]);
  assert.equal((await get('gold-squad', await app.memberSession('1002', { name: 'Rider Two' }))).body.stages[0].clashes, undefined, 'staff only');
  assert.ok(a.id);
});

test('the reminders name the team when there is more than one', async () => {
  await post('team', { name: 'Gold Squad' });
  await post('season', { ...SEASON, name: 'Gold Autumn', division: 'Gold', threshold: 1500, team: 'gold-squad' });
  for (const i of [0, 1, 2, 3]) await post('squad', { zwid: ID(i), team: 'gold-squad', force: true });
  await teamStage('gold-squad', { ...inHours(1) });
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.ok(app.world.discord.some(p => /DRS stage in about two hours\*\* \(Gold Squad\)/.test(p.body.content)), app.world.discord.map(p => p.body.content).join('|'));
});

test('resetting or removing one team leaves the others', async () => {
  await post('team', { name: 'Gold Squad' });
  await post('season', SEASON);
  await post('season', { ...SEASON, name: 'Gold Autumn', division: 'Gold', threshold: 1500, team: 'gold-squad' });
  await post('squad', { zwid: ID(0), force: true });
  await post('squad', { zwid: ID(1), team: 'gold-squad', force: true });
  assert.equal((await post('reset', { confirm: 'RESET', team: 'gold-squad' })).status, 200);
  assert.equal((await get('gold-squad')).body.season, null);
  assert.equal((await get('main')).body.squad.length, 1, 'the original team is untouched');
  assert.equal((await post('team-remove', { id: 'gold-squad' })).status, 400, 'typed confirmation');
  const gone = await post('team-remove', { id: 'gold-squad', confirm: 'REMOVE' });
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body.teams.map(t => t.id), ['main']);
  assert.equal((await post('team-remove', { id: 'main', confirm: 'REMOVE' })).status, 409, 'keep one');
});

test('a played stage can be posted as a result: the team points and who scored', async () => {
  await post('season', SEASON);
  for (const i of [0, 1, 2, 3, 4]) await post('squad', { zwid: ID(i), force: true });
  const st = await teamStage('main', { date: inHours(100).date });
  assert.equal((await post('post', { stage: st.id, kind: 'result' })).status, 409, 'enter the result first');
  await post('result', { stage: st.id, results: { [ID(0)]: { pos: 1, pts: 25 }, [ID(1)]: { pos: 2, pts: 20 }, [ID(2)]: { pos: 3, pts: 16 }, [ID(3)]: { pos: 4, pts: 12 }, [ID(4)]: { pos: 9, pts: 3 } } });
  app.world.discord.length = 0;
  assert.equal((await post('post', { stage: st.id, kind: 'result' })).status, 200);
  const msg = app.world.discord.find(p => p.channel === 'drs' || p.channel === 'public').body.content;
  assert.match(msg, /DRS stage 1 result/);
  assert.match(msg, /73 team points/);
  assert.match(msg, /⭐ P1  Dirt 0 · 25 pts/);
  assert.match(msg, /• P9  Dirt 4/, 'the fifth did not score');
});
