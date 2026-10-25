'use strict';
// Riders save their own Discord ID (verified by a code when the bot is on), can opt out, and staff reminders are personal and come ready-made.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => { delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; world.dms = []; world.dmFail = new Set(); delete process.env.DISCORD_BOT_TOKEN; });

const D1 = '123456789012345678', D2 = '223456789012345678';
const rider = () => app.memberSession('1002', { name: 'Rider Two' });
const mine = async t => (await app.get('/api/me/discord', { token: t })).body;
const mePost = (path, body, t) => app.post(`/api/me/discord${path}`, body, { token: t });
const send = (body, token = admin) => app.post('/api/comms/send', body, { token });
const lastCode = () => /\*\*(\d{6})\*\*/.exec(world.dms[world.dms.length - 1].body.content)[1];

test('a rider needs to be signed in; staff passwords are not a rider', async () => {
  assert.equal((await app.get('/api/me/discord', { token: null })).status, 401);
  assert.equal((await app.get('/api/me/discord', { token: admin })).status, 401);
  assert.equal((await mePost('', { discordId: D1 }, null)).status, 401);
});

test('without a bot a rider\'s ID is saved as unverified, and staff can use it', async () => {
  const t = await rider();
  assert.equal((await mePost('', { discordId: 'nope' }, t)).status, 400);
  const r = await mePost('', { discordId: D1 }, t);
  assert.deepEqual([r.body.saved, r.body.needsCode, r.body.verified], [true, false, false]);
  const me = await mine(t);
  assert.deepEqual([me.linked, me.id, me.verified, me.dm, me.byStaff, me.canVerify, me.pending, me.oauth], [true, D1, false, true, false, false, false, false]);
  assert.deepEqual(me.prefs, { race: true, rides: true, club: true });
  const row = (await app.get('/api/comms', { token: admin })).body.links['1002'];
  assert.deepEqual(row, { id: D1, self: true, verified: false, dm: true, off: [] });
  const out = await send({ audience: 'members', zwids: ['1002'], message: 'Hello' });
  assert.equal(out.body.sent, 1, 'with no bot there is nothing to verify with, so the ID is used');
});

test('with the bot: a code is sent to that account, a wrong code is refused, the right one verifies', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot-secret';
  const t = await rider();
  const r = await mePost('', { discordId: D1 }, t);
  assert.deepEqual([r.body.needsCode, r.body.verified], [true, false]);
  assert.equal(world.dms.length, 1);
  assert.equal(world.dms[0].userId, D1);
  assert.equal((await mine(t)).pending, true);
  // not usable by staff until verified
  const early = await send({ audience: 'members', zwids: ['1002'], message: 'Hello' });
  assert.match(early.body.results[0].error, /not verified/);
  assert.equal((await mePost('/verify', { code: '000000' }, t)).status, 400);
  const ok = await mePost('/verify', { code: lastCode() }, t);
  assert.equal(ok.status, 200);
  assert.equal((await mine(t)).verified, true);
  assert.equal((await send({ audience: 'members', zwids: ['1002'], message: 'Hello' })).body.sent, 1);
});

test('too many wrong codes lock that code, and a closed-DM account is told how to fix it', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot-secret';
  const t = await rider();
  await mePost('', { discordId: D1 }, t);
  const code = lastCode();
  for (let i = 0; i < 5; i++) assert.equal((await mePost('/verify', { code: '111111' }, t)).status, 400);
  const locked = await mePost('/verify', { code }, t);
  assert.equal(locked.status, 429, 'even the right code, after five wrong ones');
  world.dmFail.add(D2);
  const closed = await mePost('', { discordId: D2 }, t);
  assert.equal(closed.status, 409);
  assert.match(closed.body.error, /server members/);
});

test('a rider can turn the club\'s messages off and on, remove their ID, and send themselves a test', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot-secret';
  const t = await rider();
  assert.equal((await mePost('/prefs', { dm: false }, t)).status, 409, 'save an ID first');
  await mePost('', { discordId: D1 }, t); await mePost('/verify', { code: lastCode() }, t);
  world.dms.length = 0;
  assert.equal((await mePost('/test', {}, t)).status, 200);
  assert.match(world.dms[0].body.content, /test message/);
  await mePost('/prefs', { dm: false }, t);
  const skipped = await send({ audience: 'members', zwids: ['1002'], message: 'Hello' });
  assert.match(skipped.body.results[0].error, /Opted out/);
  assert.equal(world.dms.length, 1, 'nothing more was sent');
  await mePost('/prefs', { dm: true }, t);
  assert.equal((await send({ audience: 'members', zwids: ['1002'], message: 'Hello' })).body.sent, 1);
  await mePost('/remove', {}, t);
  assert.equal((await mine(t)).linked, false);
});

test('an associate can link Discord, and a verified account ticks their checklist item', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot-secret';
  const nora = await app.memberSession('5551', { name: 'Newbie Nora', associate: true });
  const before = (await app.get('/api/assoc/status', { token: nora })).body.items.find(i => i.id === 'discord');
  assert.equal(before.done, false);
  await mePost('', { discordId: D1 }, nora); await mePost('/verify', { code: lastCode() }, nora);
  const after = (await app.get('/api/assoc/status', { token: nora })).body.items.find(i => i.id === 'discord');
  assert.equal(after.done, true);
});

test('{name} and other values are filled in for each member; without a bot a personal message is one post each', async () => {
  await app.post('/api/comms/link', { zwid: '1002', discordId: D1 }, { token: admin });
  await app.post('/api/comms/link', { zwid: '1000', discordId: D2 }, { token: admin });
  const r = await send({ audience: 'members', zwids: ['1002', '1000'], message: 'Hi {name}, can you race for {teams}?', vars: { 1002: { teams: 'Alpha' }, 1000: { teams: 'Bravo and Charlie' } } });
  assert.equal(r.status, 200);
  const posts = app.world.discord.filter(p => p.channel === 'public').map(p => p.body);
  assert.equal(posts.length, 2);
  assert.match(posts[0].content, new RegExp(`^<@${D1}> Hi Rider, can you race for Alpha\\?`));
  assert.deepEqual(posts[0].allowed_mentions, { users: [D1] });
  assert.match(posts[1].content, /Hi Rick, can you race for Bravo and Charlie\?/);
  // with the bot, direct messages are personal too
  process.env.DISCORD_BOT_TOKEN = 'bot-secret';
  await send({ audience: 'members', zwids: ['1002'], message: 'Hi {name}!' });
  assert.match(world.dms[0].body.content, /^Hi Rider!/);
  // to everyone there is no name, so it reads naturally
  app.world.discord.length = 0;
  await send({ audience: 'all', message: 'Hi {name}, note this.' });
  assert.match(app.world.discord[0].body.content, /^Hi there, note this\./);
});

test('a personal message to many members needs the bot', async () => {
  for (let i = 0; i < 16; i++) await app.post('/api/comms/link', { zwid: String(4000 + i), discordId: String(300000000000000000 + i) }, { token: admin });
  const many = await send({ audience: 'members', zwids: Array.from({ length: 16 }, (_, i) => String(4000 + i)), message: 'Hi {name}' });
  assert.equal(many.status, 400);
  assert.match(many.body.error, /at most 15/);
});

test('the ready-made reminders say who they are for', async () => {
  await app.post('/api/zrl/round', { name: 'Round 2', start: h.ymd(4), closes: h.ymd(2), weeks: 2 }, { token: admin });
  await app.post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu' }] }, { token: admin });
  await app.post('/api/zrl/signup-edit', { name: 'Rider Two', zwid: '1002', regions: ['eu'], cat: 'C' }, { token: admin });
  await app.post('/api/zrl/assign', { key: '1002', team: 'cryo-gen-alpha' }, { token: admin });
  const get = async () => (await app.get('/api/comms/templates', { token: admin })).body.templates;
  let list = await get();
  const ids = list.map(t => t.id);
  for (const id of ['zrl-availability', 'zrl-lineups', 'zrl-signup', 'ladder-availability', 'assoc-ready', 'link-discord']) assert.ok(ids.includes(id), id);
  const avail = list.find(t => t.id === 'zrl-availability');
  assert.deepEqual(avail.recipients.map(r => [r.zwid, r.name, r.vars.teams]), [['1002', 'Rider Two', 'Alpha']]);
  assert.match(avail.text, /ZRL Round 2 race 1/);
  assert.match(avail.note, /not published/);
  // answering takes them off the list
  await app.post('/api/zrl/status', { published: true }, { token: admin });
  await app.post('/api/zrl/availability', { week: 0, status: 'yes', zwid: '1002', team: 'cryo-gen-alpha' }, { token: admin });
  list = await get();
  assert.deepEqual(list.find(t => t.id === 'zrl-availability').recipients, []);
  assert.equal(list.find(t => t.id === 'link-discord').audience, 'all');
  assert.match(list.find(t => t.id === 'link-discord').note, /of \d+ members have added one/);
  assert.equal((await app.get('/api/comms/templates', { token: null })).status, 401);
});
