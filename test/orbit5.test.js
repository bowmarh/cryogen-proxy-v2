'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const createSeasonPlan = require('../lib/seasonplan'), createSelfService = require('../lib/selfservice'), createWpSync = require('../lib/wpsync'), createSiteFeed = require('../lib/sitefeed'), createJoin = require('../lib/join'), createWebPush = require('../lib/webpush');

h.setEnv();
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };
const MON = Date.parse('2026-11-09T08:00:00Z');

test('season plan: phases and an easy week every fourth, sessions sized to the hours with power targets from FTP, a goal date sets the length, bad input is explained', async () => {
  const { redis } = mem(), sent = [], sp = createSeasonPlan({ redis, HttpError, memberFromRequest: r => r.member || null, fetchRoster: async () => ({ riders: [{ riderId: 7, zpFTP: 250 }] }), notify: async (z, t, o) => { sent.push([z, t, o]); return true; }, now: () => MON });
  const p = sp.build({ ftp: 250, hours: 6, weeks: 12, start: MON }); assert.equal(p.list.length, 12); assert.equal(p.start, '2026-11-09'); assert.deepEqual([p.list[0].phase, p.list[6].phase, p.list[11].phase], ['Base', 'Build', 'Race and taper']);
  assert.deepEqual(p.list.filter(w => w.easy).map(w => w.week), [4, 8], 'an easier week every fourth, never the last'); assert.ok(p.list[3].hours < p.list[2].hours);
  const w1 = p.list[0]; assert.ok(w1.sessions.length >= 4 && w1.sessions.some(s => s.name === 'Long ride')); assert.match(w1.sessions.find(s => s.name === 'Long ride').target, /^140 to 188 W$/, 'zone 2 is 56 to 75% of 250 W'); assert.ok(w1.sessions.every(s => s.minutes >= 30));
  assert.equal(sp.build({ ftp: 250, hours: 3, weeks: 8, start: MON }).list[0].sessions.length, 2, 'three hours is a short week'); assert.equal(sp.build({ ftp: 250, hours: 12, weeks: 8, start: MON }).list[0].sessions.length, 6);
  assert.equal(sp.build({ ftp: 250, hours: 6, goalDate: '2027-01-17', start: MON }).weeks, 10, 'a goal race ten weeks away makes a ten-week plan');
  for (const [bad, re] of [[{ ftp: 20, hours: 6, weeks: 8 }, /FTP/], [{ ftp: 250, hours: 1, weeks: 8 }, /Hours a week/], [{ ftp: 250, hours: 6, weeks: 2 }, /4 to 16 weeks/], [{ ftp: 250, hours: 6, goalDate: '2026-11-20' }, /4 and 16 weeks away/], [{ ftp: 250, hours: 6, goalDate: 'nope' }, /not a date/]]) assert.throws(() => sp.build({ ...bad, start: MON }), re);
  const rider = { member: { zwid: '7' } }; assert.equal((await sp.routes['GET /api/me/season-plan'](rider)).plan, null);
  const made = await sp.routes['POST /api/me/season-plan'](rider, { hours: 6, weeks: 12 }); assert.equal(made.plan.ftp, 250, 'the FTP comes from their Zwift profile when not typed'); assert.equal(made.thisWeek.week, 1);
  assert.deepEqual(await sp.run(Date.parse('2026-11-10T08:00:00Z')), [], 'only on Monday'); assert.deepEqual(await sp.run(Date.parse('2026-11-09T05:00:00Z')), [], 'not before 7');
  assert.deepEqual(await sp.run(MON), ['seasonplan-7']); assert.match(sent[0][1], /Your plan this week \(Base, about \d+(\.\d)? h\)[\s\S]*Long ride[\s\S]*FTP of 250 W/); assert.deepEqual([sent[0][2].kind, sent[0][2].key], ['coach', 'seasonplan:2026-11-09:7']);
  assert.equal((await sp.routes['GET /api/me/season-plan'](rider)).thisWeek.week, 1); await sp.routes['POST /api/me/season-plan/delete'](rider); assert.equal((await sp.routes['GET /api/me/season-plan'](rider)).plan, null); await assert.rejects(() => sp.routes['GET /api/me/season-plan']({}), /Sign in/);
});

test('my details: email choice and first name apply at once; change requests are limited and de-duplicated; staff apply "leave" through WordPress, and only an administrator decides', async () => {
  const { redis, db } = mem(), prefs = { choice: 'on' }, posts = [], statusSet = [];
  const mail = { prefsOf: async () => ({ known: true, email: 'r***@x.test', choice: prefs.choice }), setPrefs: async (z, c) => { if (!['on', 'news', 'all'].includes(c)) throw new HttpError(400, 'Choose everything, only emails I need, or none.'); prefs.choice = c; } };
  const ss = createSelfService({ redis, HttpError, requireRole: (r, roles) => { if (!roles.includes(r.role)) throw new HttpError(403, 'no'); }, memberFromRequest: r => r.member || null, mail, access: { me: async () => ({ level: 'Racing' }) }, discord: async (c, b) => { posts.push(b.content); return true; }, setMemberStatus: async (z, s) => statusSet.push([z, s]), siteUrl: 'https://club.test' });
  const me = { member: { zwid: '7', name: 'Rick B' } };
  let d = await ss.routes['POST /api/me/prefs'](me, { emails: 'news', preferredName: 'Rick' }); assert.deepEqual([d.email.choice, d.preferredName, d.level], ['news', 'Rick', 'Racing']); assert.equal(db['cg:me:names']['7'], 'Rick');
  await assert.rejects(() => ss.routes['POST /api/me/prefs'](me, { emails: 'bogus' }), /Choose everything/); d = await ss.routes['POST /api/me/prefs'](me, { preferredName: '  ' }); assert.equal(d.preferredName, '', 'an empty name goes back to the real one'); await assert.rejects(() => ss.routes['GET /api/me/details']({}), /Sign in/);
  await assert.rejects(() => ss.routes['POST /api/me/request'](me, { type: 'details', text: 'x' }), /what you would like changed/); const r = (await ss.routes['POST /api/me/request'](me, { type: 'details', text: 'Please change my email address' })).request; assert.match(posts[0], /Member request.*Rick B.*change to their details/);
  await assert.rejects(() => ss.routes['POST /api/me/request'](me, { type: 'details', text: 'And another thing please' }), /already have one/); const lv = (await ss.routes['POST /api/me/request'](me, { type: 'leave' })).request;
  assert.equal((await ss.routes['GET /api/requests']({ role: 'mod' })).requests.length, 2); await assert.rejects(() => ss.routes['POST /api/requests/decide']({ role: 'mod' }, { id: r.id, action: 'done' }), /no/);
  await assert.rejects(() => ss.routes['POST /api/requests/decide']({ role: 'admin' }, { id: r.id, action: 'apply-leave' }), /Only a request to leave/); assert.equal((await ss.routes['POST /api/requests/decide']({ role: 'admin' }, { id: r.id, action: 'done', note: 'Changed in WordPress' })).request.status, 'done');
  assert.equal((await ss.routes['POST /api/requests/decide']({ role: 'admin' }, { id: lv.id, action: 'apply-leave' })).request.status, 'applied'); assert.deepEqual(statusSet, [['7', 'left']]); await assert.rejects(() => ss.routes['POST /api/requests/decide']({ role: 'admin' }, { id: lv.id, action: 'done' }), /already been dealt with/);
  d = await ss.routes['GET /api/me/details'](me); assert.deepEqual(d.requests.map(x => x.status).sort(), ['applied', 'done']);
});

test('WordPress accounts for join requests: off by default, a preview first, an existing account is linked not duplicated, a new one is created as a subscriber with a random password and checked, and a refusal is explained', async () => {
  const { redis } = mem(), calls = [], users = [{ id: 5, username: 'ann.existing', email: 'ann@x.test', name: 'Ann' }]; let refuse = false;
  const fetchImpl = async (u, o = {}) => {
    const url = new URL(u), method = o.method || 'GET'; calls.push([method, url.pathname + url.search, o.body ? JSON.parse(o.body) : null]);
    if (!/^Basic /.test(o.headers.Authorization)) return { ok: false, status: 401, json: async () => ({}) };
    if (method === 'POST') { if (refuse) return { ok: false, status: 403, json: async () => ({ code: 'rest_cannot_create_user', message: 'Sorry, you are not allowed to create new users.' }) }; const b = JSON.parse(o.body); users.push({ id: 90 + users.length, username: b.username, email: b.email, name: b.name }); return { ok: true, status: 201, json: async () => ({ id: 90 }) }; }
    const q = (url.searchParams.get('search') || '').toLowerCase(); return { ok: true, status: 200, json: async () => users.filter(x => x.email.toLowerCase() === q || x.username === q) };
  };
  const j = createJoin({ redis, HttpError, requireRole: () => {}, mail: { sendDirect: async () => {} }, siteUrl: 'https://club.test', hashIp: s => s }), posts = [];
  await j.submit({ name: 'Bo Dunn', email: 'bo@x.test', consent: true }, '1.1.1.1'); await j.submit({ name: 'Ann Lee', email: 'ann@x.test', consent: true }, '2.2.2.2'); const [bo, ann] = [(await j.list()).find(r => r.name === 'Bo Dunn'), (await j.list()).find(r => r.name === 'Ann Lee')];
  const ws = createWpSync({ redis, HttpError, requireRole: (r, roles) => { if (!roles.includes(r.role)) throw new HttpError(403, 'no'); }, join: j, wpSite: () => 'https://wp.test', wpAuth: () => 'api:pw', discord: async (c, b) => { posts.push(b.content); return true; }, fetchImpl });
  await assert.rejects(() => ws.routes['POST /api/wpsync/create']({ role: 'admin' }, { id: bo.id }), /switched off/); await assert.rejects(() => ws.routes['POST /api/wpsync/plan']({ role: 'mod' }, { id: bo.id }), /no/);
  const plan = await ws.routes['POST /api/wpsync/plan']({ role: 'admin' }, { id: bo.id }); assert.deepEqual([plan.exists, plan.username, plan.role], [false, 'bo.dunn', 'subscriber']); assert.ok(!calls.some(c => c[0] === 'POST'), 'a preview creates nothing');
  await ws.routes['POST /api/wpsync/settings']({ role: 'admin' }, { on: true }); const made = await ws.routes['POST /api/wpsync/create']({ role: 'admin' }, { id: bo.id }); assert.deepEqual([made.created, made.username], [true, 'bo.dunn']);
  const post = calls.find(c => c[0] === 'POST'); assert.deepEqual([post[1], post[2].roles, post[2].username, post[2].email], ['/wp-json/wp/v2/users', ['subscriber'], 'bo.dunn', 'bo@x.test']); assert.ok(post[2].password.length >= 30, 'a long random password nobody sees'); assert.match(posts[0], /WordPress account was created for Bo Dunn/);
  assert.equal((await j.list()).find(r => r.id === bo.id).wpUserId > 0, true); const linked = await ws.routes['POST /api/wpsync/create']({ role: 'admin' }, { id: ann.id }); assert.deepEqual([linked.created, linked.linked, linked.userId], [false, true, 5]); assert.equal(calls.filter(c => c[0] === 'POST').length, 1, 'an existing account is linked, not duplicated');
  await j.submit({ name: 'Cy Ray', email: 'cy@x.test', consent: true }, '3.3.3.3'); refuse = true; const cy = (await j.list()).find(r => r.name === 'Cy Ray'); await assert.rejects(() => ws.routes['POST /api/wpsync/create']({ role: 'admin' }, { id: cy.id }), /rest_cannot_create_user.*not allowed to create new users/);
  // One press: the account (when switched on) and the welcome email together.
  const sent2 = [], j2 = createJoin({ redis: mem().redis, HttpError, requireRole: () => {}, mail: { sendDirect: async m => sent2.push(m.to) }, siteUrl: 'https://club.test', hashIp: s => s }); await j2.submit({ name: 'Ed Gray', email: 'ed@x.test', consent: true }, '5.5.5.5'); const ed = (await j2.list())[0];
  const ws2 = createWpSync({ redis: mem().redis, HttpError, requireRole: () => {}, join: j2, wpSite: () => 'https://wp.test', wpAuth: () => '', discord: async () => true, fetchImpl }); const ap = await ws2.routes['POST /api/wpsync/approve']({ role: 'admin' }, { id: ed.id }); assert.deepEqual([ap.account, ap.welcome, sent2], ['skipped', true, ['ed@x.test']], 'with WordPress account creation off the welcome still goes');
  const wel = createJoin({ redis: mem().redis, HttpError, requireRole: () => {}, mail: { sendDirect: async m => posts.push(m.body) }, siteUrl: 'https://club.test', hashIp: s => s }); await wel.submit({ name: 'Di Fox', email: 'di@x.test', consent: true }, '4.4.4.4'); const di = (await wel.list())[0]; await wel.update(di.id, { wpUserId: 12 }); await wel.routes['POST /api/join/decide']({}, { id: di.id, action: 'welcome' }); assert.match(posts.at(-1), /Lost your password\?/);
});

test('website standings: a post only when every team has a result, a draft unless publishing is chosen, once per race, escaped, and a failed post can be tried again', async () => {
  const { redis } = mem(), made = [], posts = []; let results = { '0:t1': { pos: 2, pts: 24 } }, fail = false;
  const round = { name: 'R2 <b>', weeks: 2, teams: [{ id: 't1', name: 'Alpha & Co' }, { id: 't2', name: 'Bravo' }] };
  const zrl = { load: async () => ({ round }), loadResults: async () => results, standingsOf: () => ({ groups: [{ name: 'Div 1', teams: [{ id: 't1', rank: 1, name: 'Alpha & Co', races: 1, total: 24 }, { id: 't2', rank: 2, name: 'Bravo', races: 1, total: 20 }] }] }) };
  const sf = createSiteFeed({ redis, HttpError, requireRole: (r, roles) => { if (!roles.includes(r.role)) throw new HttpError(403, 'no'); }, zrl, wpPost: async b => { if (fail) throw new Error('WordPress refused the post (403)'); made.push(b); return { id: 7, link: 'https://wp.test/?p=7' }; }, discord: async (c, b) => { posts.push(b.content); return true; }, siteUrl: 'https://club.test' });
  assert.deepEqual(await sf.tick(), [], 'off by default'); await assert.rejects(() => sf.routes['POST /api/sitefeed/settings']({ role: 'mod' }, { on: true }), /no/); await sf.routes['POST /api/sitefeed/settings']({ role: 'admin' }, { on: true });
  assert.deepEqual(await sf.tick(), [], 'one team still has no result'); await assert.rejects(() => sf.routes['POST /api/sitefeed/preview']({ role: 'mod' }, {}), /No race has results for every team/);
  results = { '0:t1': { pos: 2, pts: 24 }, '0:t2': { pos: 1, pts: 30 } }; const pv = await sf.routes['POST /api/sitefeed/preview']({ role: 'mod' }, {}); assert.equal(pv.week, 0); assert.match(pv.title, /standings after race 1/); assert.ok(!pv.content.includes('<b>R2'), 'names are escaped'); assert.match(pv.content, /Alpha &amp; Co/);
  assert.deepEqual(await sf.tick(), ['sitefeed-0']); assert.equal(made[0].status, 'draft'); assert.match(posts[0], /A draft is ready on the website/); assert.deepEqual(await sf.tick(), [], 'once per race'); assert.equal(made.length, 1);
  results['1:t1'] = { pos: 1, pts: 30 }; results['1:t2'] = { pos: 2, pts: 20 }; await sf.routes['POST /api/sitefeed/settings']({ role: 'admin' }, { on: true, publish: true }); fail = true; assert.deepEqual(await sf.tick(), [], 'a refused post is not an event');
  assert.match((await sf.routes['GET /api/sitefeed']({ role: 'mod' })).last.error, /refused the post/); fail = false; assert.deepEqual(await sf.tick(), ['sitefeed-1'], 'and it is tried again next time'); assert.equal(made[1].status, 'publish'); assert.ok(!JSON.stringify(made).includes('Rick'), 'no riders');
});

test('staff alerts: a staff sign-in can register devices, and alerts reach every staff device but no rider', async () => {
  const { redis } = mem(); process.env.PUSH_EXTRA_HOSTS = 'push.test';
  const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), jwk = kp.privateKey.export({ format: 'jwk' }), x = Buffer.from(jwk.x, 'base64url'), y = Buffer.from(jwk.y, 'base64url');
  process.env.VAPID_PUBLIC_KEY = Buffer.concat([Buffer.from([4]), x, y]).toString('base64url'); process.env.VAPID_PRIVATE_KEY = jwk.d; const sent = [];
  try {
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); const sub = path => ({ endpoint: `https://push.test/${path}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
    const wp = createWebPush({ redis, HttpError, requireRole: () => {}, memberFromRequest: r => r.member || null, staffIdFromRequest: r => (r.staff ? `staff:${r.staff}` : ''), siteUrl: 'https://club.test', fetchImpl: async u => { sent.push(String(u)); return { ok: true, status: 201 }; } });
    await assert.rejects(() => wp.routes['GET /api/push/status']({}), /Sign in first/);
    await wp.routes['POST /api/push/subscribe']({ staff: 'owner:' }, sub('owner')); await wp.routes['POST /api/push/subscribe']({ staff: 'admin:ricks' }, sub('admin')); await wp.routes['POST /api/push/subscribe']({ member: { zwid: '7' } }, sub('rider'));
    assert.equal((await wp.routes['GET /api/push/status']({ staff: 'owner:' })).devices, 1); assert.equal(await wp.sendStaff({ title: 'CRYO-GEN needs attention', body: 'Email service' }), 2);
    assert.deepEqual(sent.sort(), ['https://push.test/admin', 'https://push.test/owner'], 'the rider\'s device is not alerted');
  } finally { delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY; delete process.env.PUSH_EXTRA_HOSTS; }
});

let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

test('through the app: a rider can open My details and ask for a change, build a season plan, and staff see the request; Social members can use My details but not the plan', async () => {
  const rider = await app.memberSession('1002'), social = await app.memberSession('99999', { associate: true }), owner = await app.login('owner'), mod = await app.login('mod');
  const d = await app.get('/api/me/details', { token: rider }); assert.equal(d.status, 200); assert.equal(d.body.zwid, '1002'); assert.equal((await app.get('/api/me/details', { token: social })).status, 200);
  assert.equal((await app.post('/api/me/request', { type: 'details', text: 'Please update my email address' }, { token: rider })).status, 200); assert.equal((await app.get('/api/requests', { token: mod })).body.requests[0].type, 'details'); assert.equal((await app.get('/api/requests', { token: rider })).status, 401);
  const plan = await app.post('/api/me/season-plan', { ftp: 240, hours: 6, weeks: 8 }, { token: rider }); assert.equal(plan.status, 200); assert.equal(plan.body.plan.list.length, 8); assert.equal((await app.post('/api/me/season-plan', { ftp: 240, hours: 6, weeks: 8 }, { token: social })).status, 403, 'the plan is not a Social-member page');
  for (const p of ['/api/wpsync', '/api/sitefeed']) assert.equal((await app.get(p, { token: mod })).status, 200, p); for (const p of ['/api/wpsync/settings', '/api/sitefeed/settings']) { assert.equal((await app.post(p, { on: true }, { token: mod })).status, 403, p); assert.equal((await app.post(p, { on: true }, { token: owner })).status, 200, p); }
});
