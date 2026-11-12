'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createAccess = require('../lib/access');

h.setEnv();
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };

test('member types are worked out automatically: associates are Social, people on a team or racing lately are Racing, the rest Standard; an override wins; captains are marked', async () => {
  const { redis } = mem(); let clock = 1_800_000_000_000;
  const zrl = { load: async () => ({ round: { teams: [{ id: 't1', captain: '2' }] }, signups: [{ key: 'k1', zwid: '1', in: true }, { key: 'k2', zwid: '2', in: true }], assign: { k1: ['t1'], k2: ['t1'] } }) };
  const tidy = { analyse: async () => ({ inactive: [{ zwid: '4', daysSinceRace: 200 }, { zwid: '5', daysSinceRace: null }, { zwid: '6', daysSinceRace: 50 }] }) };
  const fetchRoster = async () => ({ riders: [{ riderId: 3 }, { riderId: 4 }, { riderId: 5 }, { riderId: 6 }], members: [{ zwift_id: '1', name: 'Ann', tier: 'full', status: 'active' }, { zwift_id: '4', name: 'Dee', tier: 'full', status: 'active' }, { zwift_id: '7', name: 'Soc', tier: 'associate', status: 'active' }, { zwift_id: '8', name: 'Gone', tier: 'full', status: 'left' }] });
  const a = createAccess({ redis, HttpError, requireRole: () => {}, sessionFromRequest: r => r.session || null, memberFromRequest: r => r.member || null, zrl, tidy, fetchRoster, now: () => clock });
  assert.deepEqual(await a.typeOf('1', false), { type: 'racing', by: 'team or recent racing' }); assert.equal((await a.typeOf('3', false)).type, 'racing', 'raced lately: in the roster and not stale');
  assert.equal((await a.typeOf('6', false)).type, 'racing', '50 days is still recent'); assert.equal((await a.typeOf('4', false)).type, 'standard', '200 days since a race'); assert.equal((await a.typeOf('5', false)).type, 'standard', 'never raced'); assert.equal((await a.typeOf('9', false)).type, 'standard');
  assert.deepEqual(await a.typeOf('1', true), { type: 'social', by: 'associate' }, 'an associate is Social whatever else is true');
  const as = (zwid, assoc) => ({ session: { role: 'member', assoc }, member: { zwid } });
  assert.deepEqual((await a.me(as('2', false))), { level: 'Captain', staff: false, owner: false, role: 'member', type: 'racing', typeBy: 'team or recent racing', captain: true });
  assert.equal((await a.me(as('4', false))).level, 'Standard'); assert.equal((await a.me(as('7', true))).level, 'Social');
  assert.equal((await a.me({ session: { role: 'member', assoc: true }, member: { zwid: '2' } })).captain, false, 'a Social member is never a captain');
  const prevOwner = process.env.OWNER_PASSWORD, owner = { session: { role: 'admin', owner: true } }; process.env.OWNER_PASSWORD = 'pw'; owner.session.ov = a.ownerVersion();
  try { assert.equal((await a.me(owner)).level, 'Owner'); assert.equal((await a.me({ session: { role: 'admin' } })).level, 'Administrator'); assert.equal((await a.me({ session: { role: 'mod' } })).level, 'Moderator'); assert.equal((await a.me({ session: { role: 'admin', owner: true, ov: 'forged000' } })).level, 'Administrator', 'a wrong owner mark is just an administrator'); } finally { process.env.OWNER_PASSWORD = prevOwner; }
  await assert.rejects(() => a.routes['POST /api/access/override']({ session: { role: 'admin' } }, { zwid: '4', type: 'racing' }), /Only the owner/);
  process.env.OWNER_PASSWORD = 'pw'; try { const o = { session: { role: 'admin', owner: true, ov: a.ownerVersion() } }; await a.routes['POST /api/access/override'](o, { zwid: '4', type: 'racing' }); assert.deepEqual(await a.typeOf('4', false), { type: 'racing', by: 'override' });
    await assert.rejects(() => a.routes['POST /api/access/override'](o, { zwid: '4', type: 'king' }), /social, standard or racing/); await a.routes['POST /api/access/override'](o, { zwid: '4', type: '' }); assert.equal((await a.typeOf('4', false)).type, 'standard', 'cleared'); } finally { process.env.OWNER_PASSWORD = prevOwner; }
  const list = await a.routes['GET /api/access/members']({}, {}, {}); assert.deepEqual(list.members.map(m => [m.zwid, m.type]), [['1', 'racing'], ['4', 'standard'], ['7', 'social']]); assert.equal(list.members.find(m => m.zwid === '1').captain, false);
  assert.deepEqual((await a.routes['GET /api/access/members']({}, {}, { q: 'ann' })).members.map(m => m.name), ['Ann']);
});

test('the access matrix is consistent: every level is listed, nothing a moderator can do is missing from an administrator, nor anything an administrator can do from the owner', () => {
  const { MATRIX, LEVELS } = createAccess; assert.deepEqual(LEVELS, ['Social', 'Standard', 'Racing', 'Captain', 'Moderator', 'Administrator', 'Owner']);
  for (const [what, ...v] of MATRIX) { assert.equal(v.length, LEVELS.length, what); if (v[5]) assert.equal(v[6], 1, `the owner can whatever an administrator can: ${what}`); if (v[4]) assert.equal(v[5], 1, `an administrator can whatever a moderator can: ${what}`); }
});

let app, world, tokens;
before(async () => {
  world = h.createWorld(); app = await h.startApp(world);
  tokens = { owner: await app.login('owner'), admin: await app.login('admin'), mod: await app.login('mod'), standard: await app.memberSession('1002'), social: await app.memberSession('99999', { associate: true }) };
});
after(() => app.close());
beforeEach(() => { app.world.db = {}; });
const call = (who, method, path, body) => (method === 'GET' ? app.get(path, { token: who && tokens[who] }) : app.post(path, body, { token: who && tokens[who] }));

test('through the app: everyone is told their own level when they sign in', async () => {
  const lvl = async who => (await call(who, 'GET', '/api/access/me')).body.level;
  assert.deepEqual([await lvl('owner'), await lvl('admin'), await lvl('mod'), await lvl('standard'), await lvl('social')], ['Owner', 'Administrator', 'Moderator', 'Standard', 'Social']);
  assert.equal((await call(null, 'GET', '/api/access/me')).status, 401);
  assert.equal((await call('mod', 'GET', '/api/access/matrix')).status, 200); assert.equal((await call('standard', 'GET', '/api/access/matrix')).status, 401, 'members do not read the staff matrix');
});

test('through the app: the owner-only list is refused to administrators, moderators, members and visitors, and open to the owner', async () => {
  for (const key of createAccess.OWNER_ONLY) {
    const [method, path] = key.split(' '), body = {};
    for (const who of ['admin', 'mod']) { const r = await call(who, method, path, body); assert.equal(r.status, 403, `${key} for ${who}`); assert.match(r.body.error, /Only the owner/); }
    for (const who of ['standard', 'social', null]) assert.equal((await call(who, method, path, body)).status, 401, `${key} for ${who || 'a visitor'}`);
    const o = await call('owner', method, path, body); assert.ok(![401, 403].includes(o.status), `${key} is open to the owner (got ${o.status})`);
  }
});

test('through the app: what each staff level can and cannot do (administrator work stays with administrators; moderator work is open to both)', async () => {
  const want = { 'GET /api/control': [200, 200, 200, 401], 'GET /api/feedback': [200, 200, 200, 401], 'GET /api/access/members': [200, 200, 200, 401], 'GET /api/join/referrers': [200, 200, 200, 401],
    'POST /api/join/decide': [404, 404, 403, 401], 'POST /api/mail/approve': [404, 404, 403, 401], 'GET /api/staff': [200, 200, 403, 401] };
  for (const [key, [owner, admin, mod, member]] of Object.entries(want)) {
    const [method, path] = key.split(' '); const got = [];
    for (const who of ['owner', 'admin', 'mod', 'standard']) got.push((await call(who, method, path, { id: 'none' })).status);
    assert.deepEqual(got, [owner, admin, mod, member], key);
  }
});

test('through the app: the owner signs in with the owner password only, the session ends when that password changes, and with no password set there is no owner', async () => {
  const bad = await app.post('/api/login', { role: 'owner', password: 'admin-pw' }); assert.equal(bad.status, 401, 'the administrator password does not open the owner');
  const ok = await app.post('/api/login', { role: 'owner', password: 'owner-pw' }); assert.equal(ok.status, 200); assert.deepEqual([ok.body.role, ok.body.owner], ['admin', true]);
  const saved = process.env.OWNER_PASSWORD;
  try { process.env.OWNER_PASSWORD = 'changed'; assert.equal((await app.get('/api/access/me', { token: ok.body.token })).status, 401, 'the old owner session ends'); assert.equal((await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).status, 401);
    delete process.env.OWNER_PASSWORD; const none = await app.post('/api/login', { role: 'owner', password: 'x' }); assert.equal(none.status, 503); assert.equal(none.body.missing, 'OWNER_PASSWORD'); assert.equal((await app.post('/api/mail/settings', { perHour: 40 }, { token: tokens.owner })).status, 401, 'an owner session does not outlive the password'); }
  finally { process.env.OWNER_PASSWORD = saved; }
  assert.equal((await app.post('/api/mail/settings', { perHour: 40 }, { token: tokens.owner })).status, 200, 'and works again with the password back');
});

test('through the app: Social members keep to the associate pages, and an owner override changes a member\'s type', async () => {
  assert.equal((await call('social', 'GET', '/api/coach/status')).status, 403, 'the AI coach is not for Social members'); assert.equal((await call('standard', 'GET', '/api/coach/status')).status, 200);
  assert.equal((await call('admin', 'POST', '/api/access/override', { zwid: '1002', type: 'social' })).status, 403);
  assert.equal((await call('owner', 'POST', '/api/access/override', { zwid: '1002', type: 'racing' })).status, 200);
  assert.equal((await call('standard', 'GET', '/api/access/me')).body.type, 'racing'); assert.equal((await call('standard', 'GET', '/api/access/me')).body.typeBy, 'override');
});

test('until an owner password exists, administrators keep the owner\'s powers (nothing is locked out), and the Control room says so', async () => {
  const saved = process.env.OWNER_PASSWORD; delete process.env.OWNER_PASSWORD;
  try {
    assert.equal((await app.post('/api/mail/settings', { perHour: 41 }, { token: tokens.admin })).status, 200, 'an administrator can still change the switches');
    assert.equal((await call('admin', 'GET', '/api/access/me')).body.level, 'Administrator', 'but is not called the owner');
    const sys = (await call('admin', 'GET', '/api/control?fresh=1')).body.systems.find(s => s.name === 'Owner login'); assert.equal(sys.level, 'warn'); assert.match(sys.detail, /Add OWNER_PASSWORD/);
    assert.equal((await call('mod', 'POST', '/api/mail/settings', {})).status, 403, 'a moderator never gets it');
  } finally { process.env.OWNER_PASSWORD = saved; }
  assert.equal((await call('admin', 'POST', '/api/mail/settings', { perHour: 42 })).status, 403, 'with the owner password set, administrators are refused again');
  assert.equal((await call('admin', 'GET', '/api/control?fresh=1')).body.systems.find(s => s.name === 'Owner login').level, 'ok');
});
