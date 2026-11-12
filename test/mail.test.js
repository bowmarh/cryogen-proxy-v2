'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const createMail = require('../lib/mail');

h.setEnv({ HOSTINGER_MAIL_TOKEN: 'mail-token', HOSTINGER_MAIL_MAILBOX_ID: 'mbx_1' });

// ── The module on its own, with stand-ins for everything it talks to ──
const MEMBERS = [['1', 'Ann Lee'], ['2', 'Bo Dunn'], ['3', 'Cy Ray'], ['4', 'Di Fox'], ['5', 'Ed Pike'], ['6', 'Flo Gray'], ['7', 'Gus Hill (CRYO-GEN)'], ['8', 'Hal Roe']].map(([z, n]) => ({ zwift_id: z, name: n, status: 'active' }));
const USERS = [['Ann Lee', 'ann@x.test'], ['Bo Dunn', 'bo@x.test'], ['Cy Ray', 'cy@x.test'], ['Di Fox', 'di@x.test'], ['Ed Pike', 'ed@x.test'], ['Flo Gray', 'flo@x.test'], ['Gus Hill', 'gus@x.test'], ['Hal Roe', 'hal1@x.test'], ['Hal Roe', 'hal2@x.test']].map(([name, email], id) => ({ id, name, email }));
function kit({ ai = null, segments = {}, onboarding = null, lifecycle = null, configured = true } = {}) {
  const db = {}, sent = [], posts = [], state = { fail: null, failFor: new Set() };
  const redis = async cmds => cmds.map(c => h.redisRun(db, c));
  const mailer = { status: () => ({ configured, provider: 'hostinger' }), send: async m => {
    if (state.fail) throw Object.assign(new Error('The email service refused it (HTTP 503)'), { status: 503, retryable: true });
    if (state.failFor.has(m.to)) throw Object.assign(new Error('invalid recipient'), { status: 422, retryable: false });
    sent.push(m); return { ok: true };
  } };
  const stubAi = ai || { enabled: () => false, complete: async () => { throw new Error('off'); }, json: t => { try { return JSON.parse(t); } catch (e) { return null; } } };
  const m = createMail({ redis, HttpError: class extends Error { constructor(s, msg) { super(msg); this.status = s; } }, requireRole() { return 'admin'; }, staffNameOf: () => 'Ricks', mailer, ai: stubAi,
    fetchRoster: async () => ({ members: MEMBERS, riders: [] }), activeMembers: async () => MEMBERS.map(x => x.zwift_id), wpUsers: async () => USERS, segmentsOf: async n => new Set(segments[n] || []),
    publicClub: async () => ({ next: [{ series: 'ZRL', title: 'Round 2 · race 3', date: '2026-11-17' }], podium: [{ division: 'Div 1', top: [{ rank: 1, team: 'Alpha', points: 90 }] }] }),
    lifecycle, onboarding, discord: async (ch, b) => { posts.push([ch, b.content]); return true; }, secret: () => 'test-secret', siteUrl: 'https://club.test' });
  return { m, db, sent, posts, state };
}
const admin = {}, NOW = Date.parse('2026-11-04T10:00:00Z');
const run = async (m, route, body, query) => m.routes[route](admin, body, query);
const enable = (k, extra = {}) => run(k.m, 'POST /api/mail/settings', { enabled: true, perHour: 3, perDay: 100, ...extra });
async function approved(k, { subject = 'Hello', body = 'Hi {first},\n\nSee [the app](https://club.test).', category = 'news', audience = { type: 'all' } } = {}) {
  const { campaign } = await run(k.m, 'POST /api/mail/save', { subject, body, category, audience }); await run(k.m, 'POST /api/mail/check', { id: campaign.id });
  return (await run(k.m, 'POST /api/mail/approve', { id: campaign.id })).campaign;
}

test('addresses come from WordPress users matched to members by name: only unique matches, hand-set ones win, and the rest are listed', async () => {
  const k = kit(); await enable(k);
  const d = await k.m.directory(true);
  assert.equal(d.byZwid.get('1').email, 'ann@x.test'); assert.equal(d.byZwid.get('7').email, 'gus@x.test', 'a "(CRYO-GEN)" suffix does not stop the match');
  assert.deepEqual(d.ambiguous.map(x => x.zwid), ['8'], 'two WordPress users with that name: never guess'); assert.equal(d.byZwid.has('8'), false);
  await run(k.m, 'POST /api/mail/address', { zwid: '8', email: 'Hal@Club.test' });
  assert.equal((await k.m.directory()).byZwid.get('8').email, 'hal@club.test');
  await assert.rejects(() => run(k.m, 'POST /api/mail/address', { zwid: '8', email: 'nope' }), /not an email address/);
});

test('the fixed checks catch placeholders that will not be filled, insecure links and spammy wording; the message is rendered safely', () => {
  const k = kit(), r = k.m.rules('FREE MONEY!!', 'Hi {first} {team}, click here http://evil.test/x', 'news');
  assert.ok(r.some(i => i.level === 'error' && /\{team\}/.test(i.text)) && r.some(i => i.level === 'error' && /not a secure link/.test(i.text)) && r.some(i => /spam phrase/.test(i.text)));
  const out = k.m.render('Hi {first},\n\n**Big** news <script>alert(1)</script> [site](https://ok.test) [bad](javascript:alert(1))\n\n- one\n- two', { first: 'Ann' });
  assert.match(out.html, /<b>Big<\/b>/); assert.match(out.html, /&lt;script&gt;/); assert.ok(!out.html.includes('<script>')); assert.match(out.html, /<a href="https:\/\/ok\.test"/);
  assert.ok(!/href="javascript/.test(out.html), 'only https links become links'); assert.match(out.html, /<li[^>]*>one<\/li>/); assert.match(out.text, /Hi Ann,/);
});

test('an email must be checked on its current wording before it can be approved, and a failed check blocks it', async () => {
  const k = kit(); await enable(k);
  const { campaign: c } = await run(k.m, 'POST /api/mail/save', { subject: 'Hello', body: 'Hi {first}', category: 'news', audience: { type: 'all' } });
  await assert.rejects(() => run(k.m, 'POST /api/mail/approve', { id: c.id }), /Run the check/);
  const ck = (await run(k.m, 'POST /api/mail/check', { id: c.id })).check; assert.equal(ck.ok, true); assert.equal(ck.ai.ran, false); assert.match(ck.ai.note, /only the fixed rules/);
  await run(k.m, 'POST /api/mail/save', { id: c.id, subject: 'Hello', body: 'Hi {first}, click {here}', category: 'news', audience: { type: 'all' } });
  await assert.rejects(() => run(k.m, 'POST /api/mail/approve', { id: c.id }), /Run the check/, 'editing clears the check');
  assert.equal((await run(k.m, 'POST /api/mail/check', { id: c.id })).check.ok, false);
  await assert.rejects(() => run(k.m, 'POST /api/mail/approve', { id: c.id }), /must be fixed/);
});

test('the AI drafts with {first} (no names go in), and its check adds its own findings; an AI failure never blocks the fixed rules', async () => {
  const seen = [];
  const ai = { enabled: () => true, json: t => JSON.parse(t), complete: async o => { seen.push(o); return o.kind === 'maildraft' ? '{"subject":"Race week","body":"Hi {first},\\n\\nThree races this week."}' : '{"verdict":"fix","issues":[{"level":"warn","text":"The tone is a bit stern."}],"suggestion":"Soften the second line."}'; } };
  const k = kit({ ai }); await enable(k);
  const d = await run(k.m, 'POST /api/mail/draft', { brief: 'Remind riders about the three races', facts: ['ZRL race 3 is on 17 Nov'] });
  assert.equal(d.subject, 'Race week'); assert.match(seen[0].user, /ZRL race 3 is on 17 Nov/); assert.ok(!/Ann Lee|Bo Dunn/.test(JSON.stringify(seen)), 'no member names were sent to the AI');
  const { campaign } = await run(k.m, 'POST /api/mail/save', { ...d, category: 'news', audience: { type: 'all' } }), ck = (await run(k.m, 'POST /api/mail/check', { id: campaign.id })).check;
  assert.equal(ck.ai.ran, true); assert.equal(ck.ai.verdict, 'fix'); assert.ok(ck.issues.some(i => /stern/.test(i.text))); assert.equal(ck.ok, true, 'a warning does not block');
  const bad = kit({ ai: { ...ai, complete: async () => { throw new Error('AI down'); } } }); await enable(bad);
  const c2 = (await run(bad.m, 'POST /api/mail/save', { subject: 'x', body: 'Hi {first}', category: 'news', audience: { type: 'all' } })).campaign, ck2 = (await run(bad.m, 'POST /api/mail/check', { id: c2.id })).check;
  assert.equal(ck2.ai.ran, false); assert.match(ck2.ai.note, /could not run/);
});

test('sending is spread over the hours to stay inside the mailbox limit, personalised, with an unsubscribe link, and a refused address does not stop the rest', async () => {
  const k = kit(); await enable(k, { perHour: 3, perDay: 100 }); k.state.failFor.add('cy@x.test');
  const c = await approved(k); assert.equal(c.status, 'sending'); assert.equal(c.counts.total, 7, 'eight members; one has two possible addresses and is left out');
  await k.m.runSchedule(NOW); assert.equal(k.sent.length, 2, 'three allowed this hour; one of the three was refused (it counts, it was tried)');
  assert.equal((await k.m.runSchedule(NOW + 60000)).length, 0, 'nothing more in the same hour');
  await k.m.runSchedule(NOW + 3600000); await k.m.runSchedule(NOW + 7200000);
  assert.equal(k.sent.length, 6); assert.equal((await run(k.m, 'GET /api/mail/campaign', {}, { id: c.id })).campaign.status, 'sent');
  const ann = k.sent.find(m => m.to === 'ann@x.test'); assert.match(ann.html, /Hi Ann,/); assert.match(ann.html, /Unsubscribe or manage emails/); assert.match(ann.text, /\/api\/mail\/unsubscribe\?t=/);
  assert.equal(ann.fromName, 'CRYO-GEN'); assert.ok(k.sent.every(m => m.subject === 'Hello'));
  const full = (await run(k.m, 'GET /api/mail/campaign', {}, { id: c.id })).campaign; assert.equal(full.counts.failed, 1); assert.ok(k.posts.some(p => /Email sent/.test(p[1])));
});

test('a full day limit stops sending until the next day; scheduled emails wait for their time', async () => {
  const k = kit(); await enable(k, { perHour: 50, perDay: 4 }); await approved(k);
  await k.m.runSchedule(NOW); await k.m.runSchedule(NOW + 3600000); assert.equal(k.sent.length, 4, 'four a day, however many hours pass');
  await k.m.runSchedule(NOW + 86400000 + 3600000); assert.equal(k.sent.length, 7, 'the next day carries on');
  const s = kit(); await enable(s); const { campaign } = await run(s.m, 'POST /api/mail/save', { subject: 'Later', body: 'Hi {first}', category: 'news', audience: { type: 'all' } }); await run(s.m, 'POST /api/mail/check', { id: campaign.id });
  const at = new Date(NOW + 5 * 3600000).toISOString(); assert.equal((await run(s.m, 'POST /api/mail/approve', { id: campaign.id, sendAt: at })).campaign.status, 'scheduled');
  await s.m.runSchedule(NOW + 3600000); assert.equal(s.sent.length, 0); await s.m.runSchedule(NOW + 6 * 3600000); assert.ok(s.sent.length > 0);
});

test('if the email service keeps refusing, the send pauses and the admin channel is told; it resumes where it stopped', async () => {
  const k = kit(); await enable(k, { perHour: 50 }); const c = await approved(k); k.state.fail = true;
  await k.m.runSchedule(NOW); const p = (await run(k.m, 'GET /api/mail/campaign', {}, { id: c.id })).campaign;
  assert.equal(p.status, 'paused'); assert.match(p.error, /HTTP 503/); assert.ok(k.posts.some(x => x[0] === 'admin' && /Email paused/.test(x[1]))); assert.equal(k.sent.length, 0);
  k.state.fail = false; await run(k.m, 'POST /api/mail/resume', { id: c.id }); await k.m.runSchedule(NOW + 3600000);
  assert.equal(k.sent.length, 7); assert.equal((await run(k.m, 'GET /api/mail/campaign', {}, { id: c.id })).campaign.status, 'sent');
});

test('unsubscribing stops newsletters but not service emails, "stop all" stops both, and a forged or damaged link does nothing', async () => {
  const k = kit(); await enable(k, { perHour: 50 });
  const tok = k.m.tokenFor('2', 'bo@x.test'); assert.deepEqual(k.m.readToken(tok), { zwid: '2', hash: k.m.readToken(tok).hash });
  assert.equal(k.m.readToken(tok.slice(0, -2) + 'xx'), null); assert.equal(k.m.readToken('garbage'), null); await assert.rejects(() => k.m.unsubscribe('garbage', 'news'), /not valid/);
  assert.match(k.m.unsubscribePage(tok), /Stop newsletters and club news/); assert.match(k.m.unsubscribePage('bad'), /Link not valid/);
  await k.m.unsubscribe(tok, 'news');
  assert.equal((await run(k.m, 'POST /api/mail/audience', { audience: { type: 'all' }, category: 'news' })).optedOut, 1);
  assert.equal((await run(k.m, 'POST /api/mail/audience', { audience: { type: 'all' }, category: 'service' })).optedOut, 0, 'service emails still reach them');
  await k.m.unsubscribe(tok, 'all');
  assert.equal((await run(k.m, 'POST /api/mail/audience', { audience: { type: 'all' }, category: 'service' })).optedOut, 1);
});

test('groups combine club segments and hand-picked riders; an individual email goes to one rider and respects opt-outs and limits', async () => {
  const k = kit({ segments: { captains: ['1', '3'], zrl: ['3', '4'] } }); await enable(k, { perHour: 1 });
  const { group } = await run(k.m, 'POST /api/mail/group', { name: 'Captains and Ed', segments: ['captains'], zwids: ['5'] });
  assert.equal((await run(k.m, 'POST /api/mail/audience', { audience: { type: 'group', group: group.id }, category: 'news' })).count, 3);
  assert.equal((await run(k.m, 'POST /api/mail/audience', { audience: { type: 'people', zwids: ['2', '99'] }, category: 'news' })).count, 1, 'only members who exist and have an address');
  await run(k.m, 'POST /api/mail/send-one', { zwid: '2', subject: 'Your team', body: 'Hi {first}, welcome to the team.' }); assert.equal(k.sent.at(-1).to, 'bo@x.test');
  await assert.rejects(() => run(k.m, 'POST /api/mail/send-one', { zwid: '3', subject: 'x', body: 'y' }), /limit/);
  await assert.rejects(() => run(k.m, 'POST /api/mail/send-one', { zwid: '8', subject: 'x', body: 'y' }), /no email address/);
});

test('the weekly newsletter is drafted once each Monday morning (UK), approved automatically only when it passes every check and the admin chose that', async () => {
  const MON = Date.parse('2026-11-09T09:00:00Z'), k = kit(); await enable(k, { automations: { newsletter: { on: true, mode: 'approve' } } });
  assert.deepEqual(await k.m.runSchedule(Date.parse('2026-11-04T09:00:00Z')), [], 'not on a Wednesday');
  assert.deepEqual(await k.m.runSchedule(MON), ['email-newsletter']); assert.deepEqual(await k.m.runSchedule(MON + 3600000), [], 'once a week');
  let list = (await run(k.m, 'GET /api/mail')).campaigns; assert.equal(list.length, 1); assert.equal(list[0].status, 'draft'); assert.equal(list[0].createdBy, 'automatic');
  assert.ok(k.posts.some(p => /newsletter draft is ready/.test(p[1])));
  const a = kit(); await enable(a, { automations: { newsletter: { on: true, mode: 'auto' } } }); await a.m.runSchedule(MON);
  list = (await run(a.m, 'GET /api/mail')).campaigns; assert.equal(list[0].status, 'sending'); assert.ok(a.posts.some(p => /approved automatically/.test(p[1])));
});

test('welcome and win-back emails go once per person, the win-back only to quiet members and at most ten a run', async () => {
  const onb = { scan: async () => [{ zwid: '1', name: 'Ann Lee', days: 0 }, { zwid: '2', name: 'Bo Dunn', days: 5 }] }, life = { quiet: async () => MEMBERS.map(x => ({ zwid: x.zwift_id, name: x.name })) };
  const k = kit({ onboarding: onb, lifecycle: life }); await enable(k, { perHour: 100, automations: { welcome: { on: true }, quiet: { on: true } } });
  await k.m.runSchedule(NOW); assert.ok(k.sent.some(m => m.to === 'ann@x.test' && m.subject === 'Welcome to CRYO-GEN')); assert.ok(!k.sent.some(m => m.to === 'bo@x.test' && m.subject === 'Welcome to CRYO-GEN'), 'only people who joined in the last day');
  const quiet = k.sent.filter(m => m.subject === 'We miss you on the road'); assert.ok(quiet.length >= 6 && quiet.length <= 10);
  const before = k.sent.length; await k.m.runSchedule(NOW + 3600000); assert.equal(k.sent.length, before, 'nobody is emailed twice');
});

test('nothing is sent while email is switched off or no service is set up', async () => {
  const off = kit(); await approved(off).catch(() => {}); assert.deepEqual(await off.m.runSchedule(NOW), []); assert.equal(off.sent.length, 0);
  const none = kit({ configured: false }); await enable(none); const { campaign } = await run(none.m, 'POST /api/mail/save', { subject: 'x', body: 'Hi {first}', category: 'news', audience: { type: 'all' } }); await run(none.m, 'POST /api/mail/check', { id: campaign.id });
  await assert.rejects(() => run(none.m, 'POST /api/mail/approve', { id: campaign.id }), /No email service/);
});

// ── Through the whole app, with fake WordPress and a fake Hostinger Mail API ──
let app, world, adminTok;
before(async () => {
  world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left');
  world.wpUsers = [{ id: 1, name: 'Rick DB', email: 'rick@example.com' }, { id: 2, name: 'Rider Two', email: 'two@example.com' }];
  app = await h.startApp(world); adminTok = await app.login('admin');
});
after(() => app.close());
beforeEach(() => { app.world.db = {}; world.mails = []; world.mailFail = 0; world.wpUsersStatus = 0; });
const post = (p, b, t = adminTok) => app.post('/api/mail/' + p, b, { token: t });

test('through the app: only staff see Email, only an administrator changes settings or sends, and WordPress refusing to list users says why', async () => {
  assert.equal((await app.get('/api/mail')).status, 401);
  assert.equal((await app.get('/api/mail', { token: await app.memberSession('1002') })).status, 401);
  const mod = await app.login('mod');
  assert.equal((await app.get('/api/mail', { token: mod })).status, 200); assert.equal((await post('settings', { enabled: true }, mod)).status, 403); assert.equal((await post('approve', { id: 'x' }, mod)).status, 403);
  assert.equal((await post('settings', { perHour: 0 })).status, 400); assert.equal((await post('settings', { replyTo: 'nope' })).status, 400);
  world.wpUsersStatus = 403; const r = await app.get('/api/mail/addresses', { token: adminTok }); assert.equal(r.status, 409); assert.match(r.body.error, /not allowed to list users/);
});

test('through the app: write, check, approve, send; the email arrives at the right address with a working unsubscribe link that removes them from the next send', async () => {
  assert.equal((await post('settings', { enabled: true, perHour: 50, perDay: 500 })).status, 200);
  const status = (await app.get('/api/mail', { token: adminTok })).body; assert.equal(status.configured, true); assert.ok(status.addresses.withEmail >= 2);
  const saved = (await post('save', { subject: 'Club news', body: 'Hi {first},\n\nThanks for riding with us.', category: 'news', audience: { type: 'all' } })).body.campaign;
  assert.equal((await post('check', { id: saved.id })).body.check.ok, true); assert.equal((await post('approve', { id: saved.id })).status, 200);
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  const to = world.mails.map(m => m.to[0]); assert.ok(to.includes('two@example.com') && to.includes('rick@example.com'));
  const mail = world.mails.find(m => m.to[0] === 'two@example.com'); assert.equal(mail.mailbox, 'mbx_1'); assert.match(mail.html, /Hi Rider,/); assert.equal(mail.displayName, 'CRYO-GEN');
  const url = new URL(/(https?:\/\/\S+\/api\/mail\/unsubscribe\?t=[\w.-]+)/.exec(mail.text)[1]), t = url.searchParams.get('t');
  const page = await app.call('GET', `/api/mail/unsubscribe?t=${t}`); assert.equal(page.status, 200); assert.match(page.body, /Stop newsletters/); assert.match(page.headers['content-type'], /text\/html/);
  const done = await app.call('POST', '/api/mail/unsubscribe', { body: undefined, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal(done.status, 200, 'the page answers even with no token: it just shows the link-not-valid page');
  const res = await fetch(`${app.base}/api/mail/unsubscribe`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${encodeURIComponent(t)}&scope=news` });
  assert.equal(res.status, 200); assert.match(await res.text(), /will not get newsletters/);
  assert.equal((await post('audience', { audience: { type: 'all' }, category: 'news' })).body.optedOut, 1);
});

test('through the app: a test send goes only where the administrator says and a refusing service gives a clear message', async () => {
  await post('settings', { enabled: true });
  assert.equal((await post('test', { to: 'me@example.com', subject: 'Try', body: 'Hello' })).status, 200); assert.equal(world.mails.at(-1).to[0], 'me@example.com'); assert.match(world.mails.at(-1).subject, /^\[Test\]/);
  assert.equal((await post('test', { to: 'nope' })).status, 400); world.mailFail = 503;
  const r = await post('test', { to: 'me@example.com' }); assert.equal(r.status, 502); assert.match(r.body.error, /HTTP 503/);
});

test('through the app: when WordPress blocks the standard users list, the site-owned user-emails endpoint is used instead', async () => {
  world.wpUsersStatus = 403; world.wpCustomUsers = [{ id: 1, name: 'Rick DB', email: 'rick@example.com' }];
  try { const r = await app.get('/api/mail/addresses', { token: adminTok }); assert.equal(r.status, 200); assert.ok(r.body.withEmail >= 1); }
  finally { delete world.wpCustomUsers; }
});
