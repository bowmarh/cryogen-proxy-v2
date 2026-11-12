'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');
const createStripe = require('../lib/stripe'), createAudit = require('../lib/audit'), createRaceWeek = require('../lib/raceweek'), { createMailer } = require('../lib/mailer'), createMail = require('../lib/mail');

h.setEnv();
const HttpError = class extends Error { constructor(s, m) { super(m); this.status = s; } };
const mem = () => { const db = {}; return { db, redis: async cmds => cmds.map(c => h.redisRun(db, c)) }; };

function stripeKit(extra = {}) {
  const { db, redis } = mem(), calls = [], posts = [], clock = { t: 1_800_000_000_000 };
  const env = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_x', ...extra };
  const support = { KEYS: { LIST: 'cg:support:list' }, isSupporter: async z => !!(db['cg:support:list'] || {})[z] };
  const fetchImpl = async (u, o) => { calls.push([u, Object.fromEntries(new URLSearchParams(o.body)), o.headers.Authorization]); return { ok: true, json: async () => ({ url: 'https://checkout.stripe.test/s1' }) }; };
  const s = createStripe({ redis, HttpError, memberFromRequest: req => req.member || null, support, discord: async (c, b) => { posts.push(b.content); return true; }, siteUrl: 'https://club.test', env, fetchImpl, now: () => clock.t });
  const sign = (body, t = clock.t / 1000, secret = 'whsec_x') => `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  return { s, db, calls, posts, sign, clock };
}

test('Stripe: checkout is for signed-in non-supporters and sends the rider\'s Zwift ID; the webhook adds and removes supporters only when the signature is right', async () => {
  const k = stripeKit(), req = { member: { zwid: '24650', name: 'Rick' } };
  await assert.rejects(() => k.s.routes['POST /api/support/checkout']({}), /Sign in/);
  const r = await k.s.routes['POST /api/support/checkout'](req); assert.equal(r.url, 'https://checkout.stripe.test/s1');
  assert.deepEqual([k.calls[0][0], k.calls[0][1].client_reference_id, k.calls[0][1]['line_items[0][price]'], k.calls[0][1].mode, k.calls[0][2]], ['https://api.stripe.com/v1/checkout/sessions', '24650', 'price_1', 'subscription', 'Bearer sk_test']); assert.ok(!JSON.stringify(k.calls).includes('card'));
  const off = stripeKit({ STRIPE_SECRET_KEY: '' }); await assert.rejects(() => off.s.routes['POST /api/support/checkout'](req), /not set up/);
  const done = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: '24650', customer: 'cus_1' } } });
  await assert.rejects(() => k.s.webhook(done, k.sign(done, undefined, 'wrong')), /Bad signature/); await assert.rejects(() => k.s.webhook(done, k.sign(done, k.clock.t / 1000 - 1000)), /Bad signature/, 'an old signature is refused'); await assert.rejects(() => k.s.webhook(done, ''), /Bad signature/);
  assert.equal((await k.s.webhook(done, k.sign(done))).added, '24650'); assert.equal(JSON.parse(k.db['cg:support:list']['24650']).by, 'stripe'); assert.match(k.posts[0], /New supporter/);
  assert.equal((await k.s.webhook(done, k.sign(done))).duplicate, true, 'a repeated delivery does nothing');
  await assert.rejects(() => k.s.routes['POST /api/support/checkout'](req), /already a supporter/);
  const gone = JSON.stringify({ id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { customer: 'cus_1' } } }); assert.equal((await k.s.webhook(gone, k.sign(gone))).removed, '24650'); assert.equal(k.db['cg:support:list']['24650'], undefined);
  const fail = JSON.stringify({ id: 'evt_3', type: 'invoice.payment_failed', data: { object: { customer: 'cus_1' } } }); await k.s.webhook(fail, k.sign(fail)); assert.match(k.posts.at(-1), /payment failed/);
  assert.equal((await k.s.routes['POST /api/support/portal'](req)).url, 'https://checkout.stripe.test/s1', 'a past supporter can still open their billing page'); await assert.rejects(() => k.s.routes['POST /api/support/portal']({ member: { zwid: '1' } }), /could not find a Stripe subscription/);
});

test('the audit trail records only changes in the watched areas, who and what but never contents, newest first, capped', async () => {
  const { redis } = mem(), a = createAudit({ redis, requireRole: () => {} });
  assert.equal(a.watched('POST', '/api/mail/approve'), true); assert.equal(a.watched('POST', '/api/aiops/lineup-apply'), true); assert.equal(a.watched('GET', '/api/mail'), false); assert.equal(a.watched('POST', '/api/login'), false);
  await a.record({ who: 'Ricks', role: 'admin', method: 'POST', path: '/api/mail/approve' }); await a.record({ who: '', role: 'mod', method: 'POST', path: '/api/join/decide' });
  const l = (await a.routes['GET /api/audit']({})).entries; assert.deepEqual(l.map(e => [e.who, e.action]), [['mod', 'POST /api/join/decide'], ['Ricks', 'POST /api/mail/approve']]);
  for (let i = 0; i < 520; i++) await a.record({ who: 'x', role: 'admin', method: 'POST', path: '/api/mail/x' }); assert.equal((await a.list(1000)).length, 500);
});

test('a preview deployment sends no real email unless allowed', async () => {
  const sent = [], fetchImpl = async () => { sent.push(1); return { ok: true, status: 202, json: async () => ({}) }; }, base = { HOSTINGER_MAIL_TOKEN: 't', HOSTINGER_MAIL_MAILBOX_ID: 'm' }, msg = { to: 'a@b.test', subject: 'Hi', html: '<p>x</p>', text: 'x' };
  assert.equal((await createMailer({ fetchImpl, env: () => ({ ...base, VERCEL_ENV: 'preview' }) }).send(msg)).staged, true); assert.equal(sent.length, 0);
  await createMailer({ fetchImpl, env: () => ({ ...base, VERCEL_ENV: 'preview', ALLOW_OUTBOUND: '1' }) }).send(msg); assert.equal(sent.length, 1);
  await createMailer({ fetchImpl, env: () => ({ ...base, VERCEL_ENV: 'production' }) }).send(msg); assert.equal(sent.length, 2);
});

test('the autopilot preview says what would happen, per team, and sends nothing', async () => {
  const { redis } = mem(), round = { name: 'R', start: '2026-11-10', weeks: 2, racing: 2, teams: [{ id: 't1', name: 'Alpha', captain: '1' }, { id: 't2', name: 'Bravo', captain: '' }] };
  const SIGN = [['1', 'a'], ['2', 'b'], ['3', 'c']].map(([z, n]) => ({ key: 'k' + z, zwid: z, name: n, in: true })), sent = [];
  const rw = createRaceWeek({ redis, HttpError, requireRole: () => {}, zrl: { load: async () => ({ round, signups: SIGN, assign: { k1: ['t1'], k2: ['t1'], k3: ['t2'] } }), loadWeekly: async () => ({ avail: { '0:1': 'yes' }, lineup: {} }), availOf: (w, wk, z) => (z === '1' ? 'yes' : '') }, aiops: { discordAsk: async () => sent.push('ask') }, mail: null, notify: async () => sent.push('dm'), lineupButtons: () => [], applyLineup: async () => {}, discord: async () => sent.push('post') });
  const race = Date.parse('2026-11-10T00:00:00Z'), p4 = await rw.preview(race - 4 * 86400000); assert.equal(p4.step, 'remind'); assert.deepEqual(p4.teams.map(t => [t.team, t.wouldAsk]), [['Alpha', 1], ['Bravo', 1]]);
  const p6 = await rw.preview(race - 6 * 86400000); assert.deepEqual(p6.teams.map(t => t.wouldAsk), [2, 1]); const p2 = await rw.preview(race - 2 * 86400000); assert.equal(p2.teams[1].note, 'No captain: staff would be told instead.'); assert.equal((await rw.preview(race - 20 * 86400000)).step, 'nothing yet'); assert.deepEqual(sent, [], 'a preview sends nothing');
});

test('an email with the {rsvp} link renders it as a real link in both the HTML and the plain text', async () => {
  const { redis } = mem(), m = createMail({ redis, HttpError, requireRole: () => 'admin', staffNameOf: () => 'R', mailer: { status: () => ({ configured: true }), send: async () => ({}) }, ai: { enabled: () => false, available: async () => false }, fetchRoster: async () => ({}), activeMembers: async () => [], wpUsers: async () => [], segmentsOf: async () => new Set(), publicClub: async () => ({}), secret: () => 's', siteUrl: 'https://club.test' });
  const c = await m.routes['POST /api/mail/preview']({}, { subject: 'RSVP', body: 'Hi {first},\n\n[Tell us in one tap]({rsvp}&w=2)', category: 'service' });
  assert.match(c.html, /<a href="https:\/\/club\.test\/api\/rsvp\?t=[\w.-]+&amp;w=2"[^>]*>Tell us in one tap<\/a>/); assert.match(c.text, /Tell us in one tap \(https:\/\/club\.test\/api\/rsvp\?t=[\w.-]+&w=2\)/);
  assert.ok(!m.rules('RSVP', 'Hi {first},\n\n[Go]({rsvp}&w=2)', 'service').some(i => i.level === 'error'), 'the placeholder passes the fixed checks');
});

let app, world;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => app.close());
beforeEach(() => { app.world.db = {}; });

test('through the app: the smoke endpoint needs the shared secret and reports every check; the audit trail fills as staff act; the Stripe webhook refuses unsigned calls', async () => {
  assert.equal((await app.call('POST', '/api/smoke', {})).status, 401);
  const ok = await app.call('POST', '/api/smoke', { headers: { Authorization: 'Bearer cron-secret' } }); assert.equal(ok.status, 200); assert.ok(ok.body.ok, JSON.stringify(ok.body.checks)); assert.deepEqual(ok.body.checks.map(c => c.name), ['Storage', 'Systems', 'Monthly PDF', 'Public race data', 'Static pages']); assert.ok(ok.body.ok);
  const tok = await app.login('owner'); await app.post('/api/mail/settings', { perHour: 40 }, { token: tok });
  const a = await app.get('/api/audit', { token: tok }); assert.equal(a.status, 200); assert.ok(a.body.entries.some(e => e.action === 'POST /api/mail/settings'));
  assert.equal((await app.get('/api/audit', { token: await app.login('mod') })).status, 403, 'only admins read the audit trail');
  const w = await fetch(`${app.base}/api/stripe/webhook`, { method: 'POST', body: '{}' }); assert.equal(w.status, 400);
});

test('housekeeping removes only finished, old things, runs once on a Sunday morning, and reports what it did', async () => {
  const createHousekeeping = require('../lib/housekeeping'), { db, redis } = mem(), t = Date.parse('2026-11-15T04:00:00Z'), ago = d => new Date(t - d * 86400000).toISOString();
  db['cg:mail:campaigns'] = { old: JSON.stringify({ status: 'sent', sentAt: ago(100) }), ancient: JSON.stringify({ status: 'sent', sentAt: ago(400) }), recent: JSON.stringify({ status: 'sent', sentAt: ago(10) }), live: JSON.stringify({ status: 'sending', createdAt: ago(200) }) };
  for (const id of ['old', 'ancient', 'recent', 'live']) { db[`cg:mail:rcpt:${id}`] = '[]'; db[`cg:mail:prog:${id}`] = '{}'; }
  db['cg:join'] = { a: JSON.stringify({ status: 'welcomed', at: ago(300), decidedAt: ago(250) }), b: JSON.stringify({ status: 'declined', at: ago(30), decidedAt: ago(20) }), c: JSON.stringify({ status: 'open', at: ago(400) }) };
  db['cg:feedback'] = [JSON.stringify({ id: 'x', status: 'done', at: ago(100) }), JSON.stringify({ id: 'y', status: 'open', at: ago(100) }), JSON.stringify({ id: 'z', status: 'done', at: ago(5) })];
  db['cg:aiops:radio'] = { oldkey: ago(130), newkey: ago(5) }; db['cg:raceweek:done'] = { '0:t1:ask': ago(130), '1:t1:ask': ago(2) }; db['cg:stripe:events'] = { evt_old: ago(90), evt_new: ago(1) };
  const hk = createHousekeeping({ redis, now: () => t });
  assert.deepEqual(await hk.runSchedule(Date.parse('2026-11-14T04:00:00Z')), [], 'not on a Saturday'); assert.deepEqual(await hk.runSchedule(Date.parse('2026-11-15T01:00:00Z')), [], 'not before 3 in the morning');
  await hk.runSchedule(t); const l = await hk.last(); assert.deepEqual([l.removed.emailLists, l.removed.emailCampaigns, l.removed.joinRequests, l.removed.feedback, l.removed.radio, l.removed.raceWeek, l.removed.stripeEvents], [2, 1, 1, 1, 1, 1, 1]);
  assert.equal(db['cg:mail:rcpt:old'], undefined); assert.equal(db['cg:mail:rcpt:recent'], '[]', 'a recent send keeps its lists'); assert.equal(db['cg:mail:rcpt:live'], '[]', 'a send in progress is never touched'); assert.deepEqual(Object.keys(db['cg:mail:campaigns']).sort(), ['live', 'old', 'recent']);
  assert.deepEqual(Object.keys(db['cg:join']).sort(), ['b', 'c'], 'an open request stays however old'); assert.equal(db['cg:feedback'].length, 2); assert.deepEqual(Object.keys(db['cg:aiops:radio']), ['newkey']);
  const again = await hk.runSchedule(t + 3600000); assert.deepEqual(again, []); assert.equal((await hk.last()).at, new Date(t).toISOString(), 'once a week');
});
