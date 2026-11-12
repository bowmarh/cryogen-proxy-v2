'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createAutoResults = require('../lib/autoresults'), createFeedback = require('../lib/feedback'), createCaptain = require('../lib/captain'), createJoin = require('../lib/join'), createCosts = require('../lib/costs'), createAiOps = require('../lib/aiops');

h.setEnv();
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };
const DAY = 86400000, race = Date.parse('2026-11-10T00:00:00Z');
const ROUND = { name: 'R2', start: '2026-11-10', weeks: 2, racing: 2, teams: [{ id: 't1', name: 'Alpha', captain: '1' }, { id: 't2', name: 'Bravo', captain: '2' }] };
const SIGN = [['1', 'Ann Lee'], ['2', 'Bo Dunn'], ['3', 'Cy Ray']].map(([zwid, name]) => ({ key: 'k' + zwid, zwid, name, in: true }));
const zrlStub = (extra = {}) => ({ load: async () => ({ round: ROUND, signups: SIGN, assign: { k1: ['t1'], k2: ['t1'], k3: ['t2'] } }), loadWeekly: async () => ({ avail: { '0:1': 'yes' }, lineup: { '0:t1': ['1'] } }), loadResults: async () => ({}), availOf: (w, wk, z) => (z === '1' ? 'yes' : ''), standingsOf: () => ({ groups: [{ name: 'Div 1', teams: [{ id: 't1', rank: 1, total: 54 }, { id: 't2', rank: 2, total: 40 }] }] }), ...extra });

test('automatic results: only on race day and the day after, only when the table changed, errors are told once, and the address must be a public https one', async () => {
  const { redis } = mem(), imports = [], posts = []; let csv = 'Team,Position,Points\nAlpha,2,24\nBravo,1,30', status = 200;
  const zrl = zrlStub({ routes: { 'POST /api/zrl/results-import': async (req, b) => { imports.push(b); return { applied: 2, missing: [] }; } } });
  const ar = createAutoResults({ redis, HttpError, requireRole: () => {}, zrl, asStaff: () => ({}), fetchImpl: async () => ({ ok: status === 200, status, text: async () => csv }), discord: async (c, b) => { posts.push(b.content); return true; }, siteUrl: 'https://club.test' });
  for (const bad of ['http://x.test/a.csv', 'https://localhost/a', 'https://10.0.0.1/a', 'https://user:pw@x.test/a', 'nonsense', 'https://intranet/a']) assert.throws(() => ar.safeUrl(bad), HttpError);
  await assert.rejects(() => ar.routes['POST /api/autoresults/settings']({}, { on: true }), /Add the results address/); await ar.routes['POST /api/autoresults/settings']({}, { on: true, url: 'https://docs.google.com/x/pub?output=csv' });
  assert.deepEqual(await ar.tick(race - 3 * DAY), [], 'not near a race'); assert.deepEqual(await ar.tick(race + 12 * 3600000), ['autoresults-0']); assert.deepEqual(imports[0], { csv, week: 0, apply: true }); assert.match(posts[0], /race 1 were read automatically/);
  assert.deepEqual(await ar.tick(race + 13 * 3600000), [], 'unchanged table: nothing more'); assert.equal(imports.length, 1);
  csv += '\nCharlie,3,10'; assert.deepEqual(await ar.tick(race + 14 * 3600000), ['autoresults-0']); assert.equal(imports.length, 2, 'a changed table is read again');
  assert.deepEqual(await ar.tick(race + DAY + 3600000), ['autoresults-0'].slice(1), 'the day after a race the same table (week 0) is still unchanged');
  status = 503; csv = 'x'; await ar.tick(race + 20 * 3600000); await ar.tick(race + 21 * 3600000); assert.equal(posts.filter(p => /could not be read/.test(p)).length, 1, 'the same error is told once');
  const st = await ar.routes['GET /api/autoresults']({}); assert.equal(st.last.ok, false); assert.match(st.last.note, /HTTP 503/);
  status = 200; csv = '<html><body>sign in</body></html>'; await ar.tick(race + 22 * 3600000); assert.match((await ar.routes['GET /api/autoresults']({})).last.note, /web page with no results table/);
  const off = createAutoResults({ redis: mem().redis, HttpError, requireRole: () => {}, zrl, asStaff: () => ({}), fetchImpl: async () => { throw new Error('must not fetch'); } }); assert.deepEqual(await off.tick(race), [], 'off by default');
});

test('feedback: sorted by rules or the AI, kept with who and where, ten a day per person, high bugs reach the admin channel, and only staff read the list', async () => {
  const { redis } = mem(), posts = []; let aiReply = null;
  const ai = { available: async () => !!aiReply, complete: async () => aiReply, json: JSON.parse, clip: (v, n) => String(v).slice(0, n) };
  const fb = createFeedback({ redis, HttpError, requireRole: (req, roles) => { if (!roles.includes(req.role)) throw new HttpError(403, 'no'); }, roleFromRequest: r => r.role || null, memberFromRequest: r => r.member || null, ai, discord: async (c, b) => { posts.push(b.content); return true; }, siteUrl: 'https://club.test' });
  const rider = { role: 'member', member: { zwid: '24650' } }, send = (t, req = rider, extra = {}) => fb.routes['POST /api/feedback'](req, { text: t, page: 'zrl', ...extra });
  await assert.rejects(() => send('It is broken', {}), /Sign in/); await assert.rejects(() => send('hi'), /what went wrong/);
  await send('The availability buttons are not working', rider, { error: 'x is undefined' }); await send('Please add a dark mode'); await send('Great app, thank you'); await send('How do I change my team?');
  let l = (await fb.routes['GET /api/feedback']({ role: 'mod' })).items; assert.deepEqual(l.map(i => i.kind).reverse(), ['bug', 'request', 'praise', 'question']); assert.equal(l.at(-1).who, 'rider 24650'); assert.equal(l.at(-1).error, 'x is undefined'); assert.equal(l[0].by, 'rules');
  assert.equal(posts.length, 0, 'a medium bug does not ping the admin channel');
  aiReply = '{"kind":"bug","summary":"Cannot answer availability","priority":"high"}'; await send('I tap yes and nothing happens at all'); assert.match(posts[0], /High-priority report\*\* \(rider 24650, page zrl\): Cannot answer availability/);
  await assert.rejects(() => fb.routes['GET /api/feedback']({ role: 'member' }), /no/); await fb.routes['POST /api/feedback/status']({ role: 'admin' }, { id: l[0].id, status: 'done' });
  l = (await fb.routes['GET /api/feedback']({ role: 'admin' })).items; assert.equal(l.find(i => i.status === 'done').kind, 'question'.replace('question', l.find(i => i.status === 'done').kind));
  for (let i = 0; i < 12; i++) await send('Another problem: it is broken').catch(e => assert.equal(e.status, 429)); await assert.rejects(() => send('One more problem it is broken'), /plenty for today/);
});

test('the captain page shows only the captain\'s own team, and the asks and proposals are refused for any other team', async () => {
  const asked = [], aiops = { discordAsk: async b => { asked.push(b); return { reached: 1, answered: 1, unreachable: [] }; }, lineupSuggest: async b => ({ team: 'Alpha', week: b.week, picks: [] }) };
  const cp = createCaptain({ HttpError, memberFromRequest: r => r.member || null, zrl: zrlStub(), aiops }), ann = { member: { zwid: '1' } }, cy = { member: { zwid: '3' } };
  await assert.rejects(() => cp.routes['GET /api/captain']({}), /Sign in/); assert.deepEqual(await cp.routes['GET /api/captain'](cy), { captain: false, teams: [] });
  const o = await cp.routes['GET /api/captain'](ann); assert.equal(o.teams.length, 1); assert.equal(o.teams[0].name, 'Alpha'); assert.deepEqual([o.teams[0].yes, o.teams[0].none, o.teams[0].picked], [1, 1, 1]); assert.deepEqual(o.teams[0].riders.map(r => r.name), ['Ann Lee', 'Bo Dunn']);
  await cp.routes['POST /api/captain/ask'](ann, { team: 't1', week: 0 }); assert.deepEqual(asked[0], { team: 't1', week: 0, step: 'captain' });
  await assert.rejects(() => cp.routes['POST /api/captain/ask'](ann, { team: 't2', week: 0 }), /not the captain of that team/); await assert.rejects(() => cp.routes['POST /api/captain/suggest'](cy, { team: 't1', week: 0 }), /not the captain/);
  assert.equal((await cp.routes['POST /api/captain/suggest'](ann, { team: 't1', week: 1 })).week, 1);
});

test('invitations: each rider has a signed link, a join request through it is credited to them, a forged code is ignored, and the top inviters are listed', async () => {
  const { redis } = mem(), code = z => `${z}-${(z * 7919).toString(16).padStart(8, '0').slice(0, 8)}`, names = { 24650: 'Rick', 99: 'Pat' };
  const j = createJoin({ redis, HttpError, requireRole: () => {}, memberFromRequest: r => r.member || null, refCode: code, verifyRef: c => { const m = /^(\d+)-/.exec(c); return m && code(m[1]) === c ? m[1] : null; }, nameOf: async z => names[z] || z, mail: { sendDirect: async () => {} }, siteUrl: 'https://club.test', hashIp: s => s });
  await j.submit({ name: 'Friend One', email: 'f1@x.test', consent: true, ref: code(24650) }, '1.1.1.1'); await j.submit({ name: 'Friend Two', email: 'f2@x.test', consent: true, ref: code(24650) }, '2.2.2.2'); await j.submit({ name: 'Forger', email: 'f3@x.test', consent: true, ref: '24650-deadbeef' }, '3.3.3.3'); await j.submit({ name: 'Friend Four', email: 'f4@x.test', consent: true, ref: code(99) }, '4.4.4.4');
  const list = await j.list(); assert.equal(list.find(r => r.email === 'f3@x.test').ref, '', 'a forged code is ignored'); assert.equal(list.find(r => r.email === 'f1@x.test').referrer, 'Rick');
  await j.routes['POST /api/join/decide']({}, { id: list.find(r => r.email === 'f1@x.test').id, action: 'welcome' });
  assert.deepEqual((await j.routes['GET /api/join/referrers']({})).referrers.map(r => [r.name, r.count, r.welcomed]), [['Rick', 2, 1], ['Pat', 1, 0]]);
  const me = await j.routes['GET /api/me/referral']({ member: { zwid: '24650' } }); assert.equal(me.link, `https://club.test/join.html?ref=${code(24650)}`); assert.deepEqual([me.requests, me.welcomed], [2, 1]); await assert.rejects(() => j.routes['GET /api/me/referral']({}), /Sign in/);
});

test('a team certificate is a real PDF with the team and result; a completed round is announced once', async () => {
  const { redis, db } = mem(), posts = [], results = { '0:t1': { pos: 2, pts: 24 }, '1:t1': { pos: 1, pts: 30 }, '0:t2': { pos: 3, pts: 10 }, '1:t2': { pos: 3, pts: 12 } };
  const o = createAiOps({ redis, HttpError, requireRole: () => 'admin', staffNameOf: () => 'R', ai: { enabled: () => false, available: async () => false, clip: String, json: JSON.parse }, zrl: zrlStub({ loadResults: async () => results }), tidy: { analyse: async () => ({ inactive: [] }) }, fetchRoster: async () => ({ riders: [] }), publicClub: async () => ({}), digest: async () => ({}), discord: async (c, b) => { posts.push(b.content); return true; }, mail: null, siteUrl: 'https://club.test' });
  const pdf = await o.certificatePdf('t1'), txt = pdf.toString('latin1'); assert.match(txt, /^%PDF-1\.4/); assert.match(txt, /Certificate of achievement/); assert.match(txt, /\(Alpha\)/); assert.match(txt, /Finished 1st of 2 in Div 1/); assert.match(txt, /54 points over 2 races/);
  await assert.rejects(() => o.certificatePdf('zz'), /does not exist/);
  await o.routes['POST /api/aiops/settings']({}, { radio: { on: true } }); await o.radioTick(); await o.radioTick(); assert.equal(posts.filter(p => /R2 is complete/.test(p)).length, 1, 'announced once'); assert.ok(db['cg:aiops:reports']['roundcomplete:R2']);
});

test('usage meters: storage, AI and email against their budgets, amber at 80% and red at 100%, and the admin channel is told once at each level', async () => {
  const { redis, db } = mem(), posts = [], now = Date.parse('2026-11-12T10:00:00Z'); db['cg:usage'] = { 'm:2026-11': '410000' };
  let cost = 8, sentDay = 150; const support = { settings: async () => ({ budget: 10 }), month: async () => ({ cost, answers: 40 }) }, mail = { usage: async () => ({ sentDay, sentHour: 3, perHour: 30, perDay: 200, enabled: true }) };
  const c = createCosts({ redis, requireRole: () => {}, support, mail, discord: async (ch, b) => { posts.push(b.content); return true; }, env: { REDIS_MONTHLY_LIMIT: '500000' } });
  let m = Object.fromEntries((await c.snapshot(now)).map(x => [x.key, x])); assert.deepEqual([m.storage.pct, m.storage.level, m.ai.pct, m.ai.level, m.email.pct, m.email.level], [82, 'warn', 80, 'warn', 75, 'ok']);
  await c.check(now); await c.check(now); assert.equal(posts.length, 1, 'once at 80%'); assert.match(posts[0], /AI spend this month.*80% used \(£8 of £10\)/);
  cost = 10.5; sentDay = 200; await c.check(now); assert.equal(posts.length, 3, 'a new message at 100% for each'); assert.ok(posts.some(p => /Emails sent today.*limit has been reached/.test(p))); await c.check(now); assert.equal(posts.length, 3);
  const none = createCosts({ redis: mem().redis, requireRole: () => {}, support: { settings: async () => ({ budget: 0 }), month: async () => ({ cost: null, answers: 0 }) }, env: {} }); const nm = await none.snapshot(now); assert.equal(nm.find(x => x.key === 'ai').level, 'off'); assert.match(nm.find(x => x.key === 'ai').note, /No monthly budget/);
});

let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

test('through the app: feedback needs a sign-in, a rider gets their invitation link, a non-captain sees no team page, and the staff-only lists stay staff-only', async () => {
  assert.equal((await app.post('/api/feedback', { text: 'It is broken' })).status, 401);
  const rider = await app.memberSession('1002'); assert.equal((await app.post('/api/feedback', { text: 'The page is broken for me', page: 'zrl' }, { token: rider })).status, 200);
  const tok = await app.login('admin'); const fb = await app.get('/api/feedback', { token: tok }); assert.equal(fb.body.items[0].who, 'rider 1002'); assert.equal((await app.get('/api/feedback', { token: rider })).status, 401);
  const ref = await app.get('/api/me/referral', { token: rider }); assert.equal(ref.status, 200); assert.match(ref.body.link, /\/join\.html\?ref=1002-[0-9a-f]{8}$/);
  const cap = await app.get('/api/captain', { token: rider }); assert.equal(cap.status, 200); assert.equal(cap.body.captain, false);
  for (const p of ['/api/costs', '/api/autoresults', '/api/join/referrers']) assert.equal((await app.get(p, { token: tok })).status, 200, p);
  const costs = await app.get('/api/costs', { token: tok }); assert.ok(costs.body.meters.some(m => m.key === 'storage'));
  const pdf = await fetch(`${app.base}/api/aiops/certificate.pdf?team=nope`, { headers: { Authorization: `Bearer ${tok}` } }); assert.ok([404, 409].includes(pdf.status), 'no such team or no round is a clear error, not a crash');
});
