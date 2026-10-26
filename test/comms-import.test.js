'use strict';
// Importing Discord IDs in bulk: the server's member list through the bot, or a file; paired with riders by name; staff confirm; saved as staff links.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => {
  world = h.createWorld({ riders: [
    { riderId: 4001, name: 'Anna Berg [CRYO-GEN]', country: 'gb', zpCategory: 'B', race: {} },
    { riderId: 4002, name: 'Chris Gibbard', country: 'gb', zpCategory: 'C', race: {} },
    { riderId: 4003, name: 'Chris Gillard', country: 'gb', zpCategory: 'C', race: {} },
    { riderId: 4004, name: 'Dmitri Volkov (CRYO)', country: 'ru', zpCategory: 'A', race: {} },
  ] });
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
});
after(() => { delete process.env.DISCORD_BOT_TOKEN; delete process.env.DISCORD_GUILD_ID; return app.close(); });
beforeEach(() => {
  app.world.db = {}; world.guildDenied = false;
  process.env.DISCORD_BOT_TOKEN = 'bot-secret'; process.env.DISCORD_GUILD_ID = '123456789012345678';
  world.guildMembers = [
    { user: { id: '900000000000000001', username: 'annab', global_name: 'Anna Berg' }, nick: null },
    { user: { id: '900000000000000002', username: 'chrisg', global_name: 'Chris' }, nick: 'Chris G' },
    { user: { id: '900000000000000003', username: 'volkov99', global_name: 'Dmitri Volkov' }, nick: 'Dmitri Volkov (CRYO-GEN)' },
    { user: { id: '900000000000000004', username: 'randomuser', global_name: 'Mystery' }, nick: null },
    { user: { id: '900000000000000005', username: 'thebot', bot: true }, nick: null },
  ];
});
const A = { get token() { return admin; } };

test('name matching: exact, first and last word, initial; tags and accents are ignored', () => {
  const c = require('../lib/comms')({ redis: async () => [], HttpError: Error, text: x => x, requireRole() {}, discord: async () => {} });
  const n = c.norm;
  assert.equal(n('Dmitri Volkov (CRYO-GEN)'), 'dmitri volkov');
  assert.equal(n('[CRYO-GEN] Zoë  Müller'), 'zoe muller');
  assert.equal(c.nameScore('anna berg', 'anna berg'), 100);
  assert.equal(c.nameScore('anna van berg', 'anna berg'), 90);
  assert.equal(c.nameScore('chris g', 'chris gibbard'), 70);
  assert.equal(c.nameScore('chris', 'chris gibbard'), 0, 'a first name alone is not a match');
  assert.equal(c.nameScore('bob smith', 'anna berg'), 0);
});

test('from the server: members come back paired, bots are left out, and it is staff only', async () => {
  assert.equal((await app.get('/api/comms/discord-members')).status, 401);
  const r = await app.get('/api/comms/discord-members', { token: mod });
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 4, 'the bot account is skipped');
  const by = Object.fromEntries(r.body.rows.map(x => [x.discordId, x]));
  assert.deepEqual([by['900000000000000001'].status, by['900000000000000001'].pick], ['exact', '4001']);
  assert.equal(by['900000000000000003'].pick, '4004', 'a tag in the nickname does not stop the match');
  assert.equal(by['900000000000000002'].status, 'near', 'Chris G fits two riders: staff choose');
  assert.deepEqual(by['900000000000000002'].matches.map(m => m.zwid).sort(), ['4002', '4003']);
  assert.equal(by['900000000000000002'].pick, '');
  assert.equal(by['900000000000000004'].status, 'none');
  assert.deepEqual(r.body.counts, { exact: 2, near: 1, none: 1, linked: 0 });
});

test('clear messages when the bot, the server ID or the Server Members Intent is missing', async () => {
  delete process.env.DISCORD_GUILD_ID;
  let r = await app.get('/api/comms/discord-members', A);
  assert.equal(r.status, 409); assert.match(r.body.error, /DISCORD_GUILD_ID/);
  process.env.DISCORD_GUILD_ID = '123456789012345678'; world.guildDenied = true;
  r = await app.get('/api/comms/discord-members', A);
  assert.equal(r.status, 409); assert.match(r.body.error, /Server Members Intent/);
  delete process.env.DISCORD_BOT_TOKEN;
  r = await app.get('/api/comms/discord-members', A);
  assert.equal(r.status, 409); assert.match(r.body.error, /DISCORD_BOT_TOKEN/);
});

test('from a file: the same pairing for a list of IDs and names; rows without a valid ID are dropped', async () => {
  const r = await app.post('/api/comms/discord-match', { members: [{ id: '800000000000000001', name: 'Anna Berg' }, { id: 'abc', name: 'Bad' }, { id: '800000000000000002', name: 'Nobody Known' }] }, A);
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 2);
  assert.deepEqual(r.body.rows.map(x => [x.status, x.pick]), [['exact', '4001'], ['none', '']]);
  assert.equal((await app.post('/api/comms/discord-match', { members: [{ id: 'x', name: 'y' }] }, A)).status, 400);
  assert.equal((await app.post('/api/comms/discord-match', { members: [] })).status, 401);
});

test('saving: confirmed pairings become staff links; a rider\'s own link is never replaced; linked members show as already linked', async () => {
  const save = links => app.post('/api/comms/import', { links }, A);
  const r = await save([{ zwid: '4001', discordId: '900000000000000001', tag: 'annab' }, { zwid: '4002', discordId: '900000000000000002' }, { zwid: 'x', discordId: '1' }, { zwid: '4001', discordId: '900000000000000009' }]);
  assert.equal(r.status, 200);
  assert.equal(r.body.saved, 2);
  assert.deepEqual(r.body.skipped.map(s => s.reason), ['Not a valid Zwift ID and Discord ID', 'Chosen twice']);
  const link = JSON.parse(app.world.db['cg:comms:discord']['4001']);
  assert.deepEqual([link.id, link.by, link.verified, link.tag], ['900000000000000001', 'staff', true, 'annab']);
  // the rider's own verified link wins
  app.world.db['cg:comms:discord']['4003'] = JSON.stringify({ id: '700000000000000003', by: 'self', verified: true, dm: true });
  const again = await save([{ zwid: '4003', discordId: '900000000000000003' }]);
  assert.equal(again.body.saved, 0);
  assert.match(again.body.skipped[0].reason, /themselves/);
  assert.equal(JSON.parse(app.world.db['cg:comms:discord']['4003']).id, '700000000000000003');
  const fetched = (await app.get('/api/comms/discord-members', A)).body;
  assert.equal(fetched.rows.find(x => x.discordId === '900000000000000001').alreadyLinkedTo, '4001');
  assert.equal(fetched.counts.linked, 2);
  assert.equal((await save([])).status, 400);
  assert.equal((await app.post('/api/comms/import', { links: [{ zwid: '4001', discordId: '900000000000000001' }] })).status, 401);
});

test('a whole server fits: thousands of members to match and hundreds of links to save, staff only, in a few Redis trips', async () => {
  const members = Array.from({ length: 3000 }, (_, i) => ({ id: String(500000000000000000n + BigInt(i)), name: `Member Number ${i}` }));
  members.push({ id: '800000000000000777', name: 'Anna Berg' });
  const m = await app.post('/api/comms/discord-match', { members }, A);
  assert.equal(m.status, 200, 'a ~200 KB body is accepted for staff');
  assert.equal(m.body.total, 3001);
  const links = Array.from({ length: 600 }, (_, i) => ({ zwid: String(60000 + i), discordId: String(500000000000000000n + BigInt(i)), tag: `Member Number ${i}` }));
  const r = await app.post('/api/comms/import', { links }, A);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.saved, r.body.skipped.length], [600, 0]);
  assert.equal(Object.keys(app.world.db['cg:comms:discord']).length, 600);
  // someone not signed in is refused before any body is read
  assert.equal((await app.post('/api/comms/import', { links: links.slice(0, 5) }, {})).status, 401);
  assert.equal((await app.post('/api/comms/discord-match', { members: members.slice(0, 5) }, {})).status, 401);
});

test('one Discord member chosen for two riders is saved once', async () => {
  const r = await app.post('/api/comms/import', { links: [{ zwid: '4001', discordId: '900000000000000001' }, { zwid: '4002', discordId: '900000000000000001' }] }, A);
  assert.equal(r.body.saved, 1);
  assert.match(r.body.skipped[0].reason, /another rider/);
});
