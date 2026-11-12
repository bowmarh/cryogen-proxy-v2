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

test('the PDF writer makes a valid file: header, correct cross-reference offsets, text and bars, and odd characters become "?"', () => {
  const { buildPdf } = require('../lib/pdf'), buf = buildPdf([{ items: [{ t: 'rect', x: 10, y: 10, w: 50, h: 5, color: [0, 0.5, 1] }, { t: 'text', x: 20, y: 700, size: 12, bold: true, text: 'Alpha (1st) \\ ✓' }] }, { items: [] }]), txt = buf.toString('latin1');
  assert.match(txt, /^%PDF-1\.4/); assert.match(txt, /\/Count 2/); assert.match(txt, /Alpha \\\(1st\\\) \\\\ \?/); assert.ok(txt.trimEnd().endsWith('%%EOF'));
  const start = Number(/startxref\n(\d+)/.exec(txt)[1]); assert.equal(txt.slice(start, start + 4), 'xref');
  const entries = [...txt.slice(start).matchAll(/(\d{10}) 00000 n/g)].map(m => Number(m[1])); entries.forEach((off, i) => assert.equal(txt.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, 'every object starts where the table says'));
});

test('Discord availability asks reach riders who have not answered and say who could not be reached; a proposed line-up is applied through the ZRL route', async () => {
  const { db, redis } = mem(), asked = [], applied = [];
  const zrl = { ...zrlStub(db), availOf: (w, wk, z) => (z === '1' ? 'yes' : ''), routes: { 'POST /api/zrl/lineup': async (req, b) => applied.push(b) } };
  const o = createAiOps({ redis, HttpError, requireRole: () => 'admin', staffNameOf: () => 'R', ai: { enabled: () => false, available: async () => false, clip: String, json: JSON.parse }, zrl, tidy: { analyse: async () => ({ inactive: [] }) }, fetchRoster: async () => ({ riders: [] }), publicClub: async () => ({}), digest: async () => ({}), discord: async () => true,
    notify: async (z, text, opt) => { asked.push([z, text, opt.key, opt.components]); return z !== '3'; }, buttons: (s, id) => `buttons:${s}:${id}`, siteUrl: 'https://club.test' });
  const r = await o.routes['POST /api/aiops/discord-ask']({}, { team: 't1', week: 1 }); assert.deepEqual([r.reached, r.answered, r.unreachable], [1, 1, ['Cy Ray']]);
  assert.deepEqual(asked.map(a => a[0]), ['2', '3'], 'the rider who already answered is not asked again'); assert.equal(asked[0][3], 'buttons:zrl:1:t1'); assert.match(asked[0][1], /Hi Bo, can you race for Alpha in race 2 of Round 2/);
  await o.routes['POST /api/aiops/lineup-apply']({}, { team: 't1', week: 1, zwids: ['1', '2'] }); assert.deepEqual(applied, [{ team: 't1', week: 1, zwids: ['1', '2'] }]);
  await assert.rejects(() => o.routes['POST /api/aiops/lineup-apply']({}, { team: 't1', week: 1, zwids: [] }), /no line-up/);
});

test('progress cards: nothing without activity, numbers only to the AI, once per rider per month in the first week, only when switched on', async () => {
  const createProgress = require('../lib/progress'), { redis } = mem(), sent = [], seen = [];
  const seasons = { 1: { zrl: { placed: true, round: 'Round 2', team: 'Alpha', races: 3, picked: 3, points: 70, podiums: 1 }, highlights: ['🏁 Raced every ZRL race so far'] }, 2: {} };
  const ai = { available: async () => true, clip: (v, n) => String(v).slice(0, n), complete: async o => { seen.push(o.user); return 'You are flying.'; } };
  const mail = { everyone: async () => ({ list: [{ z: '1', n: 'Ann Lee', e: 'a@x' }, { z: '2', n: 'Bo Dunn', e: 'b@x' }] }), sendTo: async m => sent.push(m) };
  const p = createProgress({ redis, HttpError, requireRole: () => {}, mail, seasonOf: async m => seasons[m.zwid] || {}, ai, siteUrl: 'https://club.test', eligible: async z => z !== '3' });
  assert.deepEqual(await p.run(Date.parse('2026-11-03T10:00:00Z')), [], 'off by default'); await p.routes['POST /api/aiops/progress-settings']({}, { on: true });
  assert.deepEqual(await p.run(Date.parse('2026-11-20T10:00:00Z')), [], 'only in the first week of the month'); assert.deepEqual(await p.run(Date.parse('2026-11-03T07:00:00Z')), [], 'not before 9 in the morning');
  assert.deepEqual(await p.run(Date.parse('2026-11-03T10:00:00Z')), ['progress-1']); assert.equal(sent.length, 1); assert.match(sent[0].body, /Hi \{first\},[\s\S]*ZRL Round 2 with Alpha: raced 3 of 3 races so far, 70 team points, 1 podium\.[\s\S]*You are flying\./); assert.equal(sent[0].category, 'news');
  assert.ok(!/Ann|Alpha/.test(seen[0]), 'no names go to the AI'); assert.deepEqual(await p.run(Date.parse('2026-11-04T10:00:00Z')), [], 'once each, and a rider with nothing to report is skipped');
});

test('the open race page shows team results and the radio only; join requests get a first look from the racing data and a welcome that lists what is coming up', async () => {
  const { redis } = mem(), cr = createControlRoom({ redis, requireRole: () => {}, zrl: { ...zrlStub({}), load: async () => ({ round: { ...ROUND, start: '2030-01-07' }, signups: SIGN, assign: { k1: ['t1'], k2: ['t1'], k3: ['t1'] } }), loadWeekly: async () => ({ avail: { '0:1': 'yes' }, lineup: {} }), loadResults: async () => ({ '0:t1': { pos: 1, pts: 30 } }), availOf: () => 'yes' },
    aiops: { settings: async () => ({ radio: { on: true } }), feed: async () => [{ at: 'x', team: 'Alpha', text: 'Alpha 1st', secret: 'no' }] }, mail: null, join: null, gsheets: { status: () => ({ configured: false }) }, ai: { enabled: () => false, available: async () => false }, backup: { healthRow: async () => ['warn', '1 daily copy kept; the last was 80 h ago.'] } });
  const pub = await cr.publicRace(); assert.deepEqual(Object.keys(pub.teams[0]).sort(), ['name', 'result']); assert.deepEqual(pub.feed, [{ at: 'x', text: 'Alpha 1st' }]); assert.ok(!JSON.stringify(pub).includes('yes'), 'no answers or names on the open page');
  const sys = await cr.systems(); assert.deepEqual([sys[0].name, sys[0].level], ['Backups', 'bad'], 'an old backup is a problem, listed first');
  const { redis: r2 } = mem(), sent = [], j = createJoin({ redis: r2, HttpError, requireRole: () => {}, mail: { sendDirect: async m => sent.push(m) }, lookup: async z => (z === '24650' ? { category: 'B', vELO: 1500 } : null), teamsWithSpace: async () => [{ name: 'Bravo', grade: 'B', places: 2 }], nextEvents: async () => [{ series: 'ZRL', title: 'Race 3', date: '2026-11-17' }], siteUrl: 'https://club.test', hashIp: s => s });
  await j.submit({ name: 'New Rider', email: 'n@x.test', zwid: '24650', consent: true }, '9.9.9.9'); await j.submit({ name: 'No Id', email: 'o@x.test', consent: true }, '8.8.8.8');
  const list = await j.list(), withId = list.find(x => x.zwid === '24650'); assert.deepEqual([withId.look.category, withId.look.vELO, withId.look.teams[0].name], ['B', 1500, 'Bravo']); assert.equal(list.find(x => !x.zwid).look, null);
  await j.routes['POST /api/join/decide']({}, { id: withId.id, action: 'welcome' }); assert.match(sent[0].body, /2026-11-17 ZRL: Race 3/);
});

test('progress cards go to Racing members only: a Standard or Social member is skipped without a card', async () => {
  const createProgress = require('../lib/progress'), { redis } = mem(), sent = [];
  const mail = { everyone: async () => ({ list: [{ z: '1', n: 'Ann', e: 'a@x' }, { z: '3', n: 'Cy', e: 'c@x' }] }), sendTo: async m => sent.push(m.zwid) };
  const seasons = { 1: { zrl: { placed: true, round: 'R', team: 'A', races: 1, picked: 1, points: 5, podiums: 0 } }, 3: { zrl: { placed: true, round: 'R', team: 'A', races: 1, picked: 1, points: 5, podiums: 0 } } };
  const p = createProgress({ redis, HttpError, requireRole: () => {}, mail, seasonOf: async m => seasons[m.zwid], ai: null, siteUrl: 'https://club.test', eligible: async z => z === '1' });
  await p.routes['POST /api/aiops/progress-settings']({}, { on: true }); await p.run(Date.parse('2026-11-03T10:00:00Z')); assert.deepEqual(sent, ['1']);
});

test('the Control room reuses its systems list for five minutes, so an open tab does not re-run every check each refresh', async () => {
  const { redis } = mem(); let pings = 0; const counting = async c => { pings += c.length; return redis(c); };
  const cr = createControlRoom({ redis: counting, requireRole: () => {}, zrl: { load: async () => ({ round: null }) }, aiops: { settings: async () => ({ radio: { on: false } }), feed: async () => [] }, mail: null, join: null, gsheets: { status: () => ({ configured: false }) }, ai: { enabled: () => false, available: async () => false } });
  await cr.overview(); const first = pings; await cr.overview(); await cr.overview(); assert.ok(pings - first < first, `later refreshes cost less than the first (${first} then ${pings - first})`); assert.equal((await cr.systemsCached(0)).length > 0, true, 'a zero ttl asks afresh');
});
