'use strict';
// Several ladder teams: each has its own roster of 15, matches and record; a rider can be on more than one; a clash is flagged.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald', 'Emerald', 'Emerald', 'Sapphire', 'Sapphire', 'Sapphire', 'Amethyst', 'Amethyst', 'Platinum', 'Gold', ''];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: cat ? { rating: 2300 - i * 50, mixed: { category: cat } } : undefined } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

const ID = i => String(2000 + i);
const get = (team, token = admin) => app.get(`/api/ladder${team ? `?team=${team}` : ''}`, { token });
const post = (path, body, token = admin) => app.post(`/api/ladder/${path}`, body, { token });
const ukParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const inHours = hrs => { const p = ukParts(Date.now() + hrs * 3600000); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };

test('the first team added keeps the original one; teams are renamed, limited to 15 and need unique names', async () => {
  assert.deepEqual((await get()).body.teams.map(t => t.name), ['CRYO-GEN'], 'one team to start with');
  await post('roster', { zwid: ID(0) });
  const r = await post('team', { name: 'Ladder B' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.teams.map(t => [t.id, t.name, t.riders]), [['main', 'CRYO-GEN', 1], ['ladder-b', 'Ladder B', 0]], 'the original keeps its rider');
  assert.equal((await post('team', { name: 'ladder b' })).status, 409, 'unique names');
  assert.equal((await post('team', { id: 'ladder-b', name: 'Ladder Bravo' })).body.team.name, 'Ladder Bravo');
  assert.equal((await post('team', { id: 'nope', name: 'X' })).status, 404);
  for (let i = 0; i < 13; i++) assert.equal((await post('team', { name: `Team ${i}` })).status, 200);
  const full = await post('team', { name: 'One too many' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /15 teams/);
  assert.equal((await post('team', { name: 'Nope' }, null)).status, 401);
});

test('each team has its own roster, matches and record', async () => {
  await post('team', { name: 'Ladder B' });
  await post('roster', { zwid: ID(0), team: 'main' });
  await post('roster', { zwid: ID(1), team: 'ladder-b' });
  assert.deepEqual((await get('main')).body.roster.map(r => r.zwid), [ID(0)]);
  assert.deepEqual((await get('ladder-b')).body.roster.map(r => r.zwid), [ID(1)]);
  const m = (await post('match', { opponent: 'Team Rocket', challenger: 'us', team: 'ladder-b' })).body.matches[0];
  assert.equal(m.team, 'ladder-b');
  assert.equal((await get('main')).body.matches.length, 0, 'the other team does not see it');
  assert.equal((await get('ladder-b')).body.matches.length, 1);
  assert.equal((await get('nope')).status, 404);
  // match routes find the team from the match: no team needed
  await post('roster', { zwid: ID(2), team: 'ladder-b' });
  assert.equal((await post('availability', { match: m.id, zwid: ID(1), status: 'yes' })).status, 200);
  assert.equal((await post('availability', { match: m.id, zwid: ID(0), status: 'yes' })).status, 403, 'only on that team\'s roster');
});

test('the roster limit is per team, and the same rider can be on several teams', async () => {
  await post('team', { name: 'Ladder B' });
  for (let i = 0; i < 15; i++) assert.equal((await post('roster', { zwid: ID(i), team: 'main' })).status, 200);
  assert.equal((await post('roster', { zwid: ID(15), name: 'Lad 15', team: 'main' })).status, 409, 'main is full');
  assert.equal((await post('roster', { zwid: ID(0), team: 'ladder-b' })).status, 200, 'the same rider in a second team');
  assert.equal((await get('ladder-b')).body.roster.length, 1);
});

test('two teams asking for the same rider at the same time are flagged, and the admins are told', async () => {
  await post('team', { name: 'Ladder B' });
  const when = inHours(30);
  for (const team of ['main', 'ladder-b']) for (const i of [0, 1, 2, 3, 4]) await post('roster', { zwid: ID(i), team });
  const a = (await post('match', { opponent: 'Rocket', challenger: 'us', team: 'main', ...when, eventLink: 'https://zwift.example/a' })).body.matches[0];
  const b = (await post('match', { opponent: 'Comet', challenger: 'us', team: 'ladder-b', ...when, eventLink: 'https://zwift.example/b' })).body.matches[0];
  await post('lineup', { match: a.id, zwids: [0, 1, 2, 3, 4].map(ID) });
  await post('lineup', { match: b.id, zwids: [0, 1, 2, 3, 4].map(ID) });
  const view = (await get('ladder-b')).body.matches[0];
  assert.equal(view.clashes.length, 5);
  assert.deepEqual([view.clashes[0].team, view.clashes[0].opponent], ['CRYO-GEN', 'Rocket']);
  assert.equal((await get('ladder-b', await app.memberSession('1002', { name: 'Rider Two' }))).body.matches[0].clashes, undefined, 'staff only');
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.ok(app.world.discord.filter(p => p.channel === 'ladder-admin' || p.channel === 'admin').some(p => /at the same time/.test(p.body.content)), 'staff are warned');
  const ok = await post('lineup', { match: b.id, zwids: [5, 6, 7, 8, 9].map(ID), force: true });
  assert.equal(ok.status, 200);
  assert.equal((await get('ladder-b')).body.matches[0].clashes.length, 0);
});

test('removing a team deletes its roster and matches; the last team cannot go', async () => {
  await post('team', { name: 'Ladder B' });
  await post('roster', { zwid: ID(0), team: 'ladder-b' });
  await post('match', { opponent: 'Rocket', challenger: 'us', team: 'ladder-b' });
  const refused = await post('team-remove', { id: 'ladder-b' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /1 match/);
  const done = await post('team-remove', { id: 'ladder-b', force: true });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.teams.map(t => t.id), ['main']);
  assert.equal(Object.keys(app.world.db['cg:ladder:matches'] || {}).length, 0);
  assert.equal((await post('team-remove', { id: 'main' })).status, 409, 'keep one');
});

test('the message names the team, and the health row reports every team', async () => {
  await post('team', { name: 'Ladder B' });
  const when = inHours(100);
  await post('roster', { zwid: ID(0), team: 'ladder-b' });
  const m = (await post('match', { opponent: 'Comet', challenger: 'us', team: 'ladder-b', ...when, eventLink: 'https://zwift.example/b' })).body.matches[0];
  await post('post', { match: m.id, kind: 'callout' });
  assert.ok(app.world.discord.some(p => /Ladder B v Comet/.test(p.body.content)), 'the post names Ladder B');
  const row = (await app.get('/api/health', { token: admin })).body.checks.find(c => c.id === 'ladder');
  assert.match(row.detail, /2 teams/);
});

test('a played match can be posted as a result: the score and our five in finishing order', async () => {
  for (const i of [0, 1, 2, 3, 4]) await post('roster', { zwid: ID(i) });
  const when = inHours(30);
  const m = (await post('match', { opponent: 'Rocket', challenger: 'us', ...when, eventLink: 'https://zwift.example/r' })).body.matches[0];
  assert.equal((await post('post', { match: m.id, kind: 'result' })).status, 409, 'no line-up or result yet');
  await post('lineup', { match: m.id, zwids: [0, 1, 2, 3, 4].map(ID) });
  assert.equal((await post('post', { match: m.id, kind: 'result' })).status, 409, 'enter the result first');
  assert.equal((await post('result', { match: m.id, positions: { [ID(0)]: 2, [ID(1)]: 1, [ID(2)]: 4, [ID(3)]: 3, [ID(4)]: 6 } })).status, 200);
  app.world.discord.length = 0;
  assert.equal((await post('post', { match: m.id, kind: 'result' })).status, 200);
  const msg = app.world.discord.find(p => p.channel === 'ladder' || p.channel === 'public').body.content;
  assert.match(msg, /Ladder result: CRYO-GEN v Rocket/);
  assert.match(msg, /We won/);
  assert.ok(msg.indexOf('Lad 1') < msg.indexOf('Lad 0') && msg.indexOf('Lad 0') < msg.indexOf('Lad 3'), 'in finishing order');
  assert.equal((await post('post', { match: m.id, kind: 'result' })).status, 429, 'not twice in a row');
  assert.equal((await post('post', { match: m.id, kind: 'result' }, null)).status, 401);
});
