'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

const FULL = '900000000000000001', ASSOC = '900000000000000002', OTHER = '900000000000000099';
const D = n => `70000000000000000${n}`;
h.setEnv({ DISCORD_BOT_TOKEN: 'bot-token', DISCORD_GUILD_ID: '800000000000000000', DISCORD_ROLE_FULL: FULL, DISCORD_ROLE_ASSOCIATE: ASSOC, WP_SYNC_SECRET: 'sync-secret' });
let app, world, admin;
before(async () => { world = h.createWorld(); app = await h.startApp(world); admin = await app.login('admin'); });
after(() => app.close());
beforeEach(() => {
  // 1000: active full, has only the Associate role -> +Full -Associate. 1002: active, set below. 1001: left, still has Full -> -Full.
  world.members = [
    { id: 1, zwift_id: '1000', name: 'Rick DB', status: 'active', tier: 'full' },
    { id: 2, zwift_id: '1001', name: 'Rider One', status: 'left', tier: 'full' },
    { id: 4, zwift_id: '1002', name: 'Rider Two', status: 'active', tier: 'half' },
    { id: 6, zwift_id: '1003', name: 'Unverified', status: 'active', tier: 'full' },
  ];
  world.guildMembers = [
    { user: { id: D(1) }, roles: [ASSOC, OTHER] },
    { user: { id: D(2) }, roles: [FULL] },
    { user: { id: D(3) }, roles: [ASSOC] },          // already right: no change
    { user: { id: D(4) }, roles: [] },
  ];
  world.roleCalls = []; world.roleDenied = false;
  app.world.db['cg:comms:discord'] = {
    1000: JSON.stringify({ id: D(1), verified: true, dm: true }),
    1001: JSON.stringify({ id: D(2), verified: true, dm: true }),
    1002: JSON.stringify({ id: D(3), verified: true, dm: true }),
    1003: JSON.stringify({ id: D(4), verified: false, dm: true }),   // not verified: never touched
  };
  delete app.world.db['cg:droles:settings'];
});

test('the preview lists exactly the role changes the membership levels need, and touches no other role or unverified account', async () => {
  const r = await app.get('/api/discord/roles', { token: await app.login('mod') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const by = Object.fromEntries(r.body.changes.map(c => [c.zwid, c.summary]));
  assert.deepEqual(by, { 1000: '+Full −Associate', 1001: '−Full' });
  assert.equal(world.roleCalls.length, 0, 'a preview changes nothing');
});

test('an administrator applies the changes; other roles stay; a moderator cannot apply', async () => {
  assert.equal((await app.post('/api/discord/roles/apply', {}, { token: await app.login('mod') })).status, 403);
  const r = await app.post('/api/discord/roles/apply', {}, { token: admin });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.done, 2);
  assert.deepEqual(world.guildMembers[0].roles.sort(), [FULL, OTHER].sort(), 'the unrelated role is kept');
  assert.deepEqual(world.guildMembers[1].roles, []);
  assert.equal((await app.get('/api/discord/roles', { token: admin })).body.changes.length, 0, 'nothing left to do');
});

test('a tier change reported by cryogen.team updates the roles straight away when automatic sync is on', async () => {
  assert.equal((await app.post('/api/discord/roles/settings', { auto: true }, { token: admin })).status, 200);
  world.members[2].tier = 'full';   // Rider Two upgraded on cryogen.team
  const body = { event: 'member_updated', ts: Math.floor(Date.now() / 1000) };
  const ping = await app.call('POST', '/api/wp/members-changed', { body, headers: { 'Content-Type': 'application/json', 'X-Cryogen-Signature': crypto.createHmac('sha256', 'sync-secret').update(JSON.stringify(body)).digest('hex') } });
  assert.equal(ping.status, 200, JSON.stringify(ping.body));
  assert.deepEqual(world.guildMembers[2].roles, [FULL]);
});

test('when the bot lacks permission, staff are told how to fix it', async () => {
  world.roleDenied = true;
  const r = await app.post('/api/discord/roles/apply', {}, { token: admin });
  assert.equal(r.body.done, 0); assert.match(r.body.failed[0].error, /Manage Roles/);
});
