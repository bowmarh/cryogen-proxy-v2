'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createLaunch = require('../lib/launch'), createWpProbe = require('../lib/wpprobe'), createAutoResults = require('../lib/autoresults');

h.setEnv();
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };

function launchKit(over = {}) {
  const { redis } = mem(), posts = [], st = { owner: false, checks: {}, radio: { on: false }, ar: { on: false, url: '' }, rw: { on: false }, sf: { on: false }, wp: { on: false }, joins: 0, wpConn: true, systems: [], feedback: [], errors: [], requests: [], last: [], ...over };
  const l = createLaunch({ redis, requireRole: () => {}, discord: async (c, b) => { posts.push(b.content); return true; }, siteUrl: 'https://club.test', state: { ownerSet: () => st.owner, wpConnected: () => st.wpConn, checks: async () => st.checks, radio: async () => st.radio, autoresults: async () => st.ar, raceweek: async () => st.rw, sitefeed: async () => st.sf, wpsync: async () => st.wp, joinsSeen: async () => st.joins > 0, systems: async () => st.systems, feedback: async () => st.feedback, errors: async () => st.errors, requests: async () => st.requests, lastErrors: async () => st.last } });
  return { l, st, posts };
}
const byId = p => Object.fromEntries(p.steps.map(s => [s.id, s]));

test('the launch plan works out what is done, what is next and what is waiting, in order', async () => {
  const k = launchKit(); let p = await k.l.plan(); assert.equal(p.total, 8); assert.equal(p.done, 0); assert.equal(p.next.id, 'owner'); assert.equal(byId(p).owner.status, 'ready'); assert.equal(byId(p).golive.status, 'blocked'); assert.deepEqual(byId(p).golive.blockedBy, ['Set the owner password first']);
  k.st.owner = true; p = await k.l.plan(); assert.equal(byId(p).owner.status, 'done'); assert.equal(byId(p).golive.status, 'ready'); assert.equal(p.next.id, 'golive');
  k.st.checks = { storage: { ok: true }, email: { ok: true }, 'discord-admin': { ok: true }, 'discord-dm': { ok: true }, pdf: { ok: true } }; p = await k.l.plan(); assert.equal(byId(p).golive.status, 'done'); assert.equal(byId(p).radio.status, 'ready'); assert.equal(byId(p).results.status, 'blocked', 'results wait for the radio'); assert.match(byId(p).results.blockedBy[0], /radio first/);
  assert.equal(byId(p).autopilot.status, 'blocked'); assert.deepEqual(byId(p).autopilot.blockedBy, ['The availability link check must pass']); k.st.checks.rsvp = { ok: true }; assert.equal(byId(await k.l.plan()).autopilot.status, 'ready');
  k.st.radio = { on: true }; k.st.ar = { on: true, url: 'https://x.test/a.csv' }; k.st.rw = { on: true }; k.st.sf = { on: true }; p = await k.l.plan(); assert.deepEqual([byId(p).radio.status, byId(p).results.status, byId(p).autopilot.status, byId(p).website.status], ['done', 'done', 'done', 'done']); assert.equal(p.done, 6);
  assert.equal(byId(p).wpaccounts.status, 'blocked', 'WordPress accounts wait for a handled join request'); k.st.joins = 1; k.st.checks.join = { ok: true }; assert.equal(byId(await k.l.plan()).wpaccounts.status, 'ready'); k.st.wpConn = false; k.st.sf = { on: false }; assert.deepEqual(byId(await k.l.plan()).website.blockedBy, ['WordPress must be connected']);
});

test('"needs fixing" collects red systems, open bugs, recent browser errors and failed jobs; the Monday post is once a week and only when there is something to say', async () => {
  const now = Date.parse('2026-11-16T09:00:00Z'), k = launchKit({ systems: [{ name: 'Email service', level: 'bad', detail: 'A send is paused' }, { name: 'Storage', level: 'ok', detail: 'fine' }, { name: 'Housekeeping', level: 'warn', detail: 'late' }], feedback: [{ status: 'open', kind: 'bug', priority: 'high', summary: 'Cannot answer availability' }, { status: 'done', kind: 'bug', priority: 'high', summary: 'old' }, { status: 'open', kind: 'request', summary: 'dark mode' }],
    errors: [{ message: 'x is undefined', count: 4, file: 'app.js', last: new Date(now - 86400000).toISOString() }, { message: 'ancient', count: 1, file: '', last: new Date(now - 40 * 86400000).toISOString() }], requests: [{ status: 'open' }], last: [{ area: 'Automatic results', text: 'The results address answered HTTP 503.', where: 'Control room → Results' }] });
  const real = Date.now; Date.now = () => now;
  try {
    const list = await k.l.issues(); assert.deepEqual(list.map(i => [i.level, i.area]), [['bad', 'Email service'], ['bad', 'Bug report'], ['warn', 'Housekeeping'], ['warn', 'Browser error'], ['warn', 'Automatic results'], ['info', 'Member requests']]); assert.match(list[3].text, /x is undefined \(4×, app\.js\)/);
    assert.deepEqual(await k.l.runSchedule(Date.parse('2026-11-17T09:00:00Z')), [], 'only on Monday'); assert.deepEqual(await k.l.runSchedule(Date.parse('2026-11-16T05:00:00Z')), [], 'not before 8'); await k.l.runSchedule(now); assert.equal(k.posts.length, 1); assert.match(k.posts[0], /Weekly: what needs fixing\*\* \(5\)[\s\S]*Email service: A send is paused[\s\S]*Next launch step: Set the owner password/);
    await k.l.runSchedule(now + 3600000); assert.equal(k.posts.length, 1, 'once a week');
    const quiet = launchKit(); await quiet.l.runSchedule(Date.parse('2026-11-23T09:00:00Z')); assert.equal(quiet.posts.length, 0, 'nothing to say, nothing posted');
  } finally { Date.now = real; }
});

test('the plugin probe lists routes with methods and arguments and the member field names and types (never values), keeps the answer, and says when something is not available', async () => {
  const { redis } = mem(); let mode = 'ok';
  const fetchImpl = async u => {
    if (!/^https:\/\/wp\.test\/wp-json\/cryogen\/v1/.test(u)) return { status: 404, json: async () => null };
    if (mode === 'down') return { status: 500, json: async () => null };
    if (u.endsWith('/v1')) return { status: 200, json: async () => ({ routes: { '/cryogen/v1/members': { endpoints: [{ methods: ['GET'], args: {} }, { methods: ['POST'], args: { name: { type: 'string', required: true }, tier: { type: 'string', enum: ['full', 'associate'] } } }] }, '/cryogen/v1/members/(?P<id>[\\d]+)': { endpoints: [{ methods: ['GET', 'PATCH'], args: { status: { type: ['string'], enum: ['active', 'left'] } } }] }, '/cryogen/v1/zwift/public/clubs': { endpoints: [{ methods: ['GET'], args: {} }] } } }) };
    if (u.endsWith('/members')) return { status: 200, json: async () => [{ id: 1, name: 'Secret Person', zwift_id: '123', tier: 'full', email: 'secret@x.test', offboard_discord: '0', tags: ['a'] }] };
    return { status: 404, json: async () => null };
  };
  const p = createWpProbe({ redis, HttpError, requireRole: (r, roles) => { if (!roles.includes(r.role)) throw new HttpError(403, 'no'); }, wpApi: 'https://wp.test/wp-json/cryogen/v1', wpAuth: () => 'u:p', fetchImpl });
  await assert.rejects(() => p.routes['POST /api/wpprobe/run']({ role: 'mod' }), /no/); const r = (await p.routes['POST /api/wpprobe/run']({ role: 'admin' })).result;
  assert.deepEqual(r.routes.find(x => x.route === '/members').methods, ['GET', 'POST']); assert.deepEqual(r.routes.find(x => x.route === '/members').args.tier, { type: 'string', required: false, values: ['full', 'associate'] }); assert.equal(r.routes.find(x => x.route.startsWith('/members/(')).args.status.type, 'string');
  assert.deepEqual(r.memberFields.map(f => f.name), ['id', 'name', 'zwift_id', 'tier', 'email', 'offboard_discord', 'tags']); assert.ok(!JSON.stringify(r).includes('Secret Person') && !JSON.stringify(r).includes('secret@x.test'), 'no values leave the inspection'); assert.match(r.summary, /GET\/POST \/members/);
  assert.equal((await p.routes['GET /api/wpprobe']({ role: 'admin' })).last.at, r.at); mode = 'down'; const bad = (await p.routes['POST /api/wpprobe/run']({ role: 'admin' })).result; assert.equal(bad.routes.length, 0); assert.match(bad.notes.join(' '), /route list was not available[\s\S]*member list could not be read/);
  await assert.rejects(() => createWpProbe({ redis, HttpError, requireRole: () => {}, wpApi: 'x', wpAuth: () => null }).run(), /not connected/);
});

test('automatic results can read a table from a web page: the first table with a team column and a position or points column', () => {
  const ar = createAutoResults({ redis: mem().redis, HttpError, requireRole: () => {}, zrl: {}, asStaff: () => ({}) });
  const html = '<html><body><table><tr><th>Menu</th></tr><tr><td>Home</td></tr></table><table class="x"><thead><tr><th>#</th><th>Team</th><th>Points</th></tr></thead><tbody><tr><td>1</td><td><a href="/t">Alpha &amp; Co</a></td><td>54</td></tr><tr><td>2</td><td>Bravo, Inc</td><td>40</td></tr></tbody></table></body></html>';
  assert.equal(ar.htmlTableToCsv(html), '#,Team,Points\n1,Alpha & Co,54\n2,"Bravo, Inc",40'); assert.equal(ar.htmlTableToCsv('<table><tr><td>nothing</td></tr></table>'), ''); assert.equal(ar.htmlTableToCsv('plain text'), '');
});

let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

test('through the app: the launch plan and the fix list are staff pages, and the Control room reuses its systems list unless asked to refresh', async () => {
  const mod = await app.login('mod'), rider = await app.memberSession('1002'); assert.equal((await app.get('/api/launch', { token: rider })).status, 401);
  const l = await app.get('/api/launch', { token: mod }); assert.equal(l.status, 200); assert.equal(l.body.plan.total, 13); assert.ok(l.body.plan.steps.every(s => ['done', 'ready', 'blocked'].includes(s.status))); assert.ok(Array.isArray(l.body.issues));
  const a = await app.get('/api/control', { token: mod }), b = await app.get('/api/control?fresh=1', { token: mod }); assert.deepEqual(a.body.systems.map(s => s.name), b.body.systems.map(s => s.name));
  assert.equal((await app.get('/api/wpprobe', { token: mod })).status, 403, 'the plugin inspection is for administrators'); assert.equal((await app.get('/api/wpprobe', { token: await app.login('admin') })).status, 200);
});

test('storage cost: the roster refresh writes the riders\' weights in a few commands, not one per rider', async () => {
  const riders = Array.from({ length: 300 }, (_, i) => ({ riderId: 5000 + i, name: `R ${i}`, country: 'gb', weight: 70 + (i % 20), zpCategory: 'B', race: { current: { rating: 1500, mixed: { category: 'Ruby' } } } }));
  const w2 = h.createWorld({ riders }), a2 = await h.startApp(w2); try { const tok = await a2.login('mod'); const before = w2.redisCommands || 0; await a2.get('/api/roster', { token: tok }); assert.ok((w2.redisCommands || 0) - before < 40, `a 300-rider roster refresh used ${(w2.redisCommands || 0) - before} commands`); assert.equal(Object.keys(w2.db['cg:fair:weights'] || {}).length, 300, 'every weight was still saved'); } finally { await a2.close(); }
});
