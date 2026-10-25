'use strict';
// Staff messages to Discord: everyone in the club channel, or chosen members by DM (bot) or @mention (no bot).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => { delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; world.dms = []; world.dmFail = new Set(); delete process.env.DISCORD_BOT_TOKEN; });

const post = (path, body, token = admin) => app.post(`/api/comms/${path}`, body, { token });
const D1 = '123456789012345678', D2 = '223456789012345678';
const clubPosts = () => app.world.discord.filter(p => p.channel === 'public').map(p => p.body);

test('staff only', async () => {
  assert.equal((await app.get('/api/comms', { token: null })).status, 401);
  assert.equal((await app.get('/api/comms', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  assert.equal((await post('send', { audience: 'all', message: 'Hi' }, null)).status, 401);
  assert.equal((await app.get('/api/comms', { token: mod })).status, 200);
});

test('a Discord ID is saved, cleared and checked', async () => {
  assert.equal((await post('link', { zwid: '1002', discordId: 'not-an-id' })).status, 400);
  assert.equal((await post('link', { zwid: 'abc', discordId: D1 })).status, 400);
  assert.equal((await post('link', { zwid: '1002', discordId: D1 })).status, 200);
  assert.deepEqual((await app.get('/api/comms', { token: admin })).body.links['1002'], { id: D1, self: false, verified: true, dm: true });
  assert.equal((await post('link', { zwid: '1002', discordId: '' })).status, 200);
  assert.deepEqual((await app.get('/api/comms', { token: admin })).body.links, {});
});

test('to everyone: one post in the club channel, signed, and nothing in it can ping', async () => {
  const r = await post('send', { audience: 'all', message: 'Club ride moved to 9am. @everyone please note.' });
  assert.equal(r.status, 200);
  const [p] = clubPosts();
  assert.match(p.content, /Club ride moved to 9am/);
  assert.match(p.content, /— CRYO-GEN staff$/);
  assert.deepEqual(p.allowed_mentions, { parse: [] }, 'typed @everyone does not ping');
  assert.equal(p.content.startsWith('@everyone'), false);
});

test('only an administrator can notify everyone, and then it really does', async () => {
  assert.equal((await post('send', { audience: 'all', message: 'Hi', pingEveryone: true }, mod)).status, 403);
  assert.equal(clubPosts().length, 0);
  assert.equal((await post('send', { audience: 'all', message: 'Important', pingEveryone: true })).status, 200);
  const [p] = clubPosts();
  assert.match(p.content, /^@everyone Important/);
  assert.deepEqual(p.allowed_mentions, { parse: ['everyone'] });
  assert.equal((await app.get('/api/comms', { token: mod })).body.canPingEveryone, false);
});

test('without a bot, members are mentioned in the club channel and only they can be pinged; someone with no ID is reported', async () => {
  await post('link', { zwid: '1002', discordId: D1 });
  await post('link', { zwid: '1000', discordId: D2 });
  const r = await post('send', { audience: 'members', zwids: ['1002', '1000', '1003'], message: 'Can you lead on Sunday?' });
  assert.equal(r.status, 200);
  assert.equal(r.body.via, 'mention');
  assert.deepEqual(r.body.results.map(x => [x.zwid, x.ok]), [['1002', true], ['1000', true], ['1003', false]]);
  assert.match(r.body.results[2].error, /No Discord ID/);
  const [p] = clubPosts();
  assert.match(p.content, new RegExp(`^<@${D1}> <@${D2}> Can you lead on Sunday\\?`));
  assert.deepEqual(p.allowed_mentions, { users: [D1, D2] });
  assert.equal(world.dms.length, 0);
});

test('with a bot, each member gets a direct message; closed DMs are reported per member', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot-secret';
  await post('link', { zwid: '1002', discordId: D1 });
  await post('link', { zwid: '1000', discordId: D2 });
  world.dmFail.add(D2);
  const r = await post('send', { audience: 'members', zwids: ['1002', '1000'], message: 'Your ZRL team is published.' });
  assert.equal(r.status, 200);
  assert.equal(r.body.via, 'dm');
  assert.deepEqual([r.body.sent, r.body.failed], [1, 1]);
  assert.match(r.body.results.find(x => x.zwid === '1000').error, /would not open a DM/);
  assert.deepEqual(world.dms.map(d => [d.userId, d.auth]), [[D1, 'Bot bot-secret']]);
  assert.match(world.dms[0].body.content, /Your ZRL team is published\./);
  assert.deepEqual(world.dms[0].body.allowed_mentions, { parse: [] });
  assert.equal(clubPosts().length, 0, 'nothing goes to the channel');
  assert.equal((await app.get('/api/comms', { token: admin })).body.dm, true);
});

test('bad requests: no message, nobody picked, too many, not numbers', async () => {
  assert.equal((await post('send', { audience: 'all', message: '   ' })).status, 400);
  assert.equal((await post('send', { audience: 'members', zwids: [], message: 'Hi' })).status, 400);
  assert.equal((await post('send', { audience: 'members', zwids: Array.from({ length: 51 }, (_, i) => String(2000 + i)), message: 'Hi' })).status, 400);
  assert.equal((await post('send', { audience: 'members', zwids: ['abc'], message: 'Hi' })).status, 400);
  assert.equal(clubPosts().length, 0);
});

test('a flood is slowed: more than ten sends a minute is refused', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await post('send', { audience: 'all', message: `Note ${i}` })).status, 200);
  assert.equal((await post('send', { audience: 'all', message: 'One more' })).status, 429);
});

test('what was sent is recorded, newest first, without any Discord IDs', async () => {
  await post('link', { zwid: '1002', discordId: D1 });
  await post('send', { audience: 'all', message: 'First' });
  await post('send', { audience: 'members', zwids: ['1002'], message: 'Second' });
  const log = (await app.get('/api/comms', { token: admin })).body.log;
  assert.deepEqual(log.map(l => [l.audience, l.text]), [['members', 'Second'], ['all', 'First']]);
  assert.equal(log[0].by, 'admin');
  assert.ok(!JSON.stringify(log).includes(D1));
});
