'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createRsvp = require('../lib/rsvp'), createJoin = require('../lib/join'), createControlRoom = require('../lib/controlroom'), createAiOps = require('../lib/aiops');

h.setEnv();

const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };
const ROUND = { name: 'Round 2', start: '2026-11-03', weeks: 3, racing: 2, teams: [{ id: 't1', name: 'Alpha', captain: '1' }] };
const SIGN = [['1', 'Ann Lee'], ['2', 'Bo Dunn'], ['3', 'Cy Ray']].map(([zwid, name]) => ({ key: 'k' + zwid, zwid, name, in: true }));
const zrlStub = db => ({ KEYS: { weekly: 'cg:zrl:weekly' }, load: async () => ({ round: ROUND, signups: SIGN, assign: { k1: ['t1'], k2: ['t1'], k3: ['t1'] } }), loadWeekly: async () => ({ avail: {}, lineup: {} }), loadResults: async () => ({}), availOf: () => '',
  standingsOf: () => ({ groups: [{ name: 'Div 1', teams: [{ id: 't1', rank: 1, total: 50 }] }] }) });
const tokens = { good: { zwid: '2', hash: 'x' } };

test('one-tap availability: the page only shows buttons, the answer is recorded by a POST for the rider\'s own teams, and bad links are refused', async () => {
  const { db, redis } = mem(), r = createRsvp({ redis, zrl: zrlStub(db), readToken: t => tokens[t] || null, siteUrl: 'https://club.test' });
  assert.match(await r.show('good', '1'), /Can you race\?[\s\S]*race 2 on <b>2026-11-10<\/b> for Alpha/); assert.equal(db['cg:zrl:weekly'], undefined, 'showing the page records nothing');
  assert.match(await r.show('bad', '1'), /link is not valid/);
  assert.match(await r.answer('good', '1', 'yes'), /Thanks, Bo!/); assert.equal(db['cg:zrl:weekly']['a:1:2'], 'yes');
  await r.answer('good', '1', 'no'); assert.equal(db['cg:zrl:weekly']['a:1:2'], 'no', 'a later answer replaces it');
  assert.match(await r.answer('good', '1', 'banana'), /choose yes, maybe or no/); assert.match(await r.answer('bad', '1', 'yes'), /not valid/);
  const other = createRsvp({ redis, zrl: zrlStub(db), readToken: () => ({ zwid: '99', hash: 'x' }) }); assert.match(await other.show('t', '0'), /could not find you on a ZRL team/);
});

test('join requests: a hidden field and bad input are refused, a request is queued once, limited per connection, and only an administrator decides', async () => {
  const { redis } = mem(), posts = [], sent = [], mail = { sendDirect: async m => sent.push(m) };
  const j = createJoin({ redis, HttpError, requireRole: (req, roles) => { if (!roles.includes(req.role)) throw new HttpError(403, 'no'); }, discord: async (c, b) => { posts.push(c); }, mail, siteUrl: 'https://club.test', hashIp: s => s });
  await assert.rejects(() => j.submit({ name: 'A', email: 'a@b.test', consent: true }, '1.1.1.1'), /your name/); await assert.rejects(() => j.submit({ name: 'Ann', email: 'nope', consent: true }, '1.1.1.1'), /valid email/);
  await assert.rejects(() => j.submit({ name: 'Ann', email: 'a@b.test' }, '1.1.1.1'), /tick the box/);
  await j.submit({ name: 'Bot', email: 'bot@b.test', consent: true, website: 'http://spam' }, '1.1.1.1'); assert.equal((await j.list()).length, 0, 'the hidden field: nothing queued');
  await j.submit({ name: 'Ann Lee', email: 'ANN@b.test', zwid: 'ID 24650', note: 'hi', consent: true }, '1.1.1.1'); await j.submit({ name: 'Ann Again', email: 'ann@b.test', consent: true }, '1.1.1.1');
  const list = await j.list(); assert.equal(list.length, 1); assert.deepEqual([list[0].email, list[0].zwid], ['ann@b.test', '24650']); assert.deepEqual(posts, ['admin']);
  for (const n of [2, 3, 4]) await j.submit({ name: 'P' + n, email: `p${n}@b.test`, consent: true }, '2.2.2.2').catch(e => assert.equal(e.status, 429));
  await assert.rejects(() => j.routes['POST /api/join/decide']({ role: 'mod' }, { id: list[0].id, action: 'welcome' }), /no/);
  const r = await j.routes['POST /api/join/decide']({ role: 'admin' }, { id: list[0].id, action: 'welcome' }); assert.equal(r.request.status, 'welcomed'); assert.equal(sent[0].to, 'ann@b.test'); assert.match(sent[0].body, /Hi \{first\}/);
  await assert.rejects(() => j.routes['POST /api/join/decide']({ role: 'admin' }, { id: list[0].id, action: 'decline' }), /already been dealt/);
});

test('the control room lists problems first, shows each team\'s race-day state and the radio feed, and the watchdog speaks only when the set of problems changes', async () => {
  const { db, redis } = mem(), posts = []; let paused = [{ id: 'c', subject: 'News', error: 'HTTP 503' }];
  const mail = { health: async () => ({ configured: true, provider: 'hostinger', enabled: true, paused, sending: 0, addresses: { withEmail: 8, members: 10 } }) };
  const aiops = { settings: async () => ({ radio: { on: true } }), feed: async () => [{ team: 'Alpha', text: 'Alpha 1st' }] };
  const weekly = { avail: { '0:1': 'yes', '0:2': 'maybe' }, lineup: { '0:t1': ['1'] } }, zrl = { ...zrlStub(db), load: async () => ({ round: { ...ROUND, start: '2030-01-07' }, signups: SIGN, assign: { k1: ['t1'], k2: ['t1'], k3: ['t1'] } }), loadWeekly: async () => weekly, loadResults: async () => ({ '0:t1': { pos: 2, pts: 24 } }), availOf: (w, wk, z) => w.avail[`${wk}:${z}`] || '' };
  const cr = createControlRoom({ redis, requireRole: () => {}, zrl, aiops, mail, join: { list: async () => [{ status: 'open' }, { status: 'welcomed' }] }, gsheets: { status: () => ({ configured: false, error: '' }) }, ai: { enabled: () => false, available: async () => false }, discord: async (c, b) => { posts.push(b.content); return true; }, siteUrl: 'https://club.test' });
  const o = await cr.overview(); assert.equal(o.systems[0].level, 'bad'); assert.match(o.systems[0].detail, /paused.*News/); assert.equal(o.joinOpen, 1); assert.equal(o.feed[0].team, 'Alpha');
  const team = o.race.teams[0]; assert.deepEqual([team.yes, team.maybe, team.picked, team.short, team.result.pos], [1, 1, 1, 1, 2]);
  assert.deepEqual(await cr.watchdog(), ['watchdog']); assert.match(posts[0], /needs attention[\s\S]*Email service/); assert.deepEqual(await cr.watchdog(), [], 'the same problem is not announced twice');
  paused = []; assert.deepEqual(await cr.watchdog(), ['watchdog']); assert.match(posts[1], /healthy again/); assert.deepEqual(await cr.watchdog(), []);
});

test('a season report summarises a team\'s races to its riders by email, once per set of results; an RSVP draft is only ever a draft', async () => {
  const { db, redis } = mem(), sent = [], drafts = [], results = { '0:t1': { pos: 2, pts: 24 }, '1:t1': { pos: 1, pts: 30 } };
  const zrl = { ...zrlStub(db), loadResults: async () => results }, ai = { enabled: () => false, available: async () => false, clip: (v, n) => String(v).trim().slice(0, n), json: JSON.parse };
  const mail = { autoSend: async b => { sent.push(b); return { sent: true, id: 'c1' }; }, createDraft: async b => { drafts.push(b); return { id: 'd1', subject: b.subject }; } };
  const o = createAiOps({ redis, HttpError, requireRole: () => 'admin', staffNameOf: () => 'Ricks', ai, zrl, tidy: { analyse: async () => ({ inactive: [] }) }, fetchRoster: async () => ({ riders: [] }), publicClub: async () => ({}), digest: async () => ({}), discord: async () => true, mail, siteUrl: 'https://club.test' });
  const prev = await o.routes['POST /api/aiops/season-report']({}, { team: 't1' }); assert.match(prev.body, /raced 2 of 3 races in Round 2: race 1 2nd, race 2 1st\. That is 54 points, 1st of 1 in Div 1\. Best finish: 1st/); assert.equal(sent.length, 0, 'a preview sends nothing');
  assert.equal((await o.routes['POST /api/aiops/season-report']({}, { team: 't1', send: true })).sent, true); assert.deepEqual(sent[0].zwids.sort(), ['1', '2', '3']);
  await assert.rejects(() => o.routes['POST /api/aiops/season-report']({}, { team: 'zz' }), /does not exist/);
  const d = await o.routes['POST /api/aiops/rsvp-draft']({}, { team: 't1', week: 1 }); assert.equal(d.recipients, 3); assert.match(drafts[0].body, /\(\{rsvp\}&w=1\)/); assert.equal(drafts[0].category, 'service'); assert.equal(sent.length, 1, 'a draft is never sent');
});

let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

test('through the app: the join form is public and queues a request for staff; the availability link answers without a sign-in', async () => {
  const res = await fetch(`${app.base}/api/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'New Rider', email: 'new@example.com', consent: true }) });
  assert.equal(res.status, 200); const tok = await app.login('admin'); const list = await app.get('/api/join', { token: tok }); assert.equal(list.body.requests[0].email, 'new@example.com');
  assert.equal((await app.get('/api/join')).status, 401, 'the queue is staff only');
  const bad = await fetch(`${app.base}/api/rsvp?t=garbage`); assert.equal(bad.status, 200); assert.match(await bad.text(), /not valid/);
  const ctl = await app.get('/api/control', { token: tok }); assert.equal(ctl.status, 200); assert.ok(ctl.body.systems.some(s => s.name === 'Storage'));
  assert.equal((await app.get('/api/control', { token: await app.memberSession('1002') })).status, 401);
});
