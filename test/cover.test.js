'use strict';
// Ride cover: weekly rides need a leader and a sweeper, each with a back-up. Approved members offer, owners assign, and the scheduled
// tick calls out gaps, chases them, alerts the owner and confirms cover the day before (webhook first, Discord as the back-up).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin, mod, ann, bob, cy, owner;
before(async () => {
  const world = h.createWorld();
  world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
  ann = await app.memberSession('4378027', { name: 'Ann Able' }); bob = await app.memberSession('1002', { name: 'Bob Baker' });
  cy = await app.memberSession('777', { name: 'Cy Clark' }); owner = await app.memberSession('2436518', { name: 'Olive Owner' });
});
after(() => { delete process.env.RIDE_COVER_WEBHOOK_URL; app.close(); });

const get = (token = admin) => app.get('/api/cover', { token });
const post = (path, body, token = admin) => app.post(`/api/cover/${path}`, body, { token });
const ukDow = days => new Date(Date.UTC(2000, 0, 1) && Date.now() + days * 86400000).getUTCDay();
const SERIES = (days = 2, extra = {}) => ({ title: 'Tuesday Social Spin', dow: ukDow(days), time: '19:00', zone: 'Europe/London', pace: '2.0 w/kg', ownerName: 'Olive Owner', ownerZwid: '2436518', ...extra });
let sid;
const next = async (token = admin) => (await get(token)).body.series.find(s => s.id === sid).occurrences[0];
const posts = () => app.world.discord.map(p => p.body.content);

beforeEach(async () => {
  app.world.db = {}; app.world.discord.length = 0; app.world.hooks = []; app.world.hookFail = false; delete process.env.RIDE_COVER_WEBHOOK_URL;
  const r = await post('series', SERIES());
  sid = r.body.series[0].id;
  await post('approve', { zwid: '4378027', name: 'Ann Able', lead: true, sweep: true });
  await post('approve', { zwid: '1002', name: 'Bob Baker', lead: true, sweep: false });
  await post('approve', { zwid: '777', name: 'Cy Clark', lead: false, sweep: true });
});

test('rides are set up by staff and validated; the view needs a sign-in', async () => {
  assert.equal((await get(null)).status, 401);
  assert.equal((await post('series', SERIES(), null)).status, 401);
  assert.equal((await post('series', SERIES(), ann)).status, 401, 'a member is not staff');
  assert.equal((await post('series', SERIES(3, { time: '7pm' }))).status, 400);
  assert.equal((await post('series', SERIES(3, { dow: 9 }))).status, 400);
  assert.equal((await post('series', SERIES(3, { zone: 'Mars/Base' }))).status, 400);
  assert.equal((await post('series', SERIES())).status, 409, 'the same ride twice');
  const v = (await get(ann)).body;
  assert.equal(v.series.length, 1);
  const o = v.series[0].occurrences;
  assert.ok(o.length >= 4 && o.length <= 5, 'the next four weeks');
  assert.deepEqual(o[0].gaps, ['leader', 'leader2', 'sweeper', 'sweeper2']);
  assert.equal(v.series[0].canManage, false);
  assert.equal(v.approved, undefined, 'the approved list is for staff');
  assert.equal((await get()).body.approved.length, 3);
  assert.equal((await post('series-remove', { id: sid })).status, 200);
  assert.equal((await get()).body.series.length, 0);
});

test('only approved members volunteer, the back-up takes the second place, and nobody holds two slots', async () => {
  const date = (await next()).date;
  assert.equal((await post('volunteer', { series: sid, date, role: 'leader' }, owner)).status, 403, 'not approved');
  assert.equal((await post('volunteer', { series: sid, date, role: 'sweeper' }, bob)).status, 403, 'approved to lead, not to sweep');
  assert.equal((await post('volunteer', { series: sid, date, role: 'leader' }, bob)).status, 200);
  let c = (await next()).cover;
  assert.equal(c.leader.name, 'Rider 2', 'the name comes from the signed-in account');
  assert.equal((await post('volunteer', { series: sid, date, role: 'leader' }, bob)).status, 409, 'already covering');
  await post('volunteer', { series: sid, date, role: 'leader' }, ann);
  c = (await next()).cover;
  assert.equal(c.leader2.name, 'Ann Able', 'the second volunteer is the back-up');
  await post('approve', { zwid: '2436518', name: 'Olive Owner', lead: true });
  assert.equal((await post('volunteer', { series: sid, date, role: 'leader' }, owner)).status, 409, 'leader and back-up are taken');
  assert.equal((await post('volunteer', { series: sid, date: '2020-01-07', role: 'leader' }, cy)).status, 404);
});

test('withdrawing moves the back-up up and tells the owner; only yourself, or an owner, can remove someone', async () => {
  const date = (await next()).date;
  await post('volunteer', { series: sid, date, role: 'leader' }, bob);
  await post('volunteer', { series: sid, date, role: 'leader' }, ann);
  assert.equal((await post('withdraw', { series: sid, date, role: 'leader' }, cy)).status, 403, 'not yours');
  app.world.discord.length = 0;
  assert.equal((await post('withdraw', { series: sid, date, role: 'leader' }, bob)).status, 200);
  const c = (await next()).cover;
  assert.equal(c.leader.name, 'Ann Able', 'the back-up moved up');
  assert.equal(c.leader2, null);
  assert.ok(posts().some(t => /Rider 2 is off Tuesday Social Spin/.test(t) && /Ann Able has moved up from back-up/.test(t)), 'the owner hears about it');
  // the ride's owner can remove and assign
  assert.equal((await post('withdraw', { series: sid, date, role: 'leader' }, owner)).status, 200);
  assert.equal((await post('assign', { series: sid, date, role: 'sweeper', zwid: '777', name: 'Cy Clark' }, owner)).status, 200);
  assert.equal((await post('assign', { series: sid, date, role: 'sweeper', zwid: '777', name: 'Cy Clark' }, ann)).status, 403);
  assert.equal((await next()).cover.sweeper.name, 'Cy Clark');
  assert.equal((await post('cancel-date', { series: sid, date }, owner)).status, 200);
  assert.equal((await next()).cancelled, true);
  assert.equal((await post('volunteer', { series: sid, date, role: 'sweeper' }, ann)).status, 409, 'cancelled');
});

test('"most weeks" offers fill the gaps, and a withdrawal is not put back', async () => {
  assert.equal((await post('standing', { series: sid, lead: true }, owner)).status, 403, 'not approved');
  assert.equal((await post('standing', { series: sid, lead: true, sweep: true }, ann)).status, 200);
  let o = await next();
  assert.equal(o.cover.leader.name, 'Ann Able', 'filled straight away');
  assert.equal(o.cover.sweeper, null, 'one place a ride per person');
  await post('withdraw', { series: sid, date: o.date, role: 'leader' }, ann);
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  o = await next();
  assert.equal(o.cover.leader, null, 'she said no to that date');
  assert.equal((await get(ann)).body.me.standing[sid].lead, true);
  assert.equal((await post('standing', { series: sid }, ann)).status, 200);
  assert.equal((await get(ann)).body.me.standing[sid], undefined);
});

test('the tick calls out gaps, alerts the owner for a ride in two days, confirms cover, and does not repeat', async () => {
  const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  await tick();
  const first = posts();
  const uk = new Date(Date.now()); // the weekly call-out waits for Monday 08:00 UK
  assert.ok(first.some(t => /Ride cover needed/.test(t)) || (uk.getUTCDay() === 1 && uk.getUTCHours() < 8), 'the weekly call-out');
  assert.ok(first.some(t => /Rides this week still needing cover/.test(t) && /Tuesday Social Spin/.test(t)), 'the seven-day chase');
  assert.ok(app.world.discord.some(p => p.channel === 'admin' && /no leader or sweeper/.test(p.body.content) && /Olive Owner/.test(p.body.content)), 'the owner alert goes to the admin channel');
  app.world.discord.length = 0;
  await tick();
  assert.deepEqual(posts(), [], 'each notice goes once');
  // cover the ride: tomorrow's confirmation names the cover
  const o = await next();
  const date = o.date;
  await post('assign', { series: sid, date, role: 'leader', zwid: '4378027', name: 'Ann Able' });
  const r = await post('series', SERIES(1, { id: undefined, title: 'Tomorrow Spin' }));
  const tomorrow = r.body.series.find(s => s.title === 'Tomorrow Spin');
  const t = tomorrow.occurrences[0];
  await post('assign', { series: tomorrow.id, date: t.date, role: 'leader', zwid: '1002', name: 'Bob Baker' });
  app.world.discord.length = 0;
  await tick();
  assert.ok(posts().some(x => /Ride cover for the next 24 hours/.test(x) && /Leader Bob Baker/.test(x) && /still needed: .*sweeper/.test(x)), 'tomorrow\'s confirmation');
});

test('messages go to the webhook for WhatsApp first and fall back to Discord when it fails', async () => {
  process.env.RIDE_COVER_WEBHOOK_URL = 'https://hooks.test/whatsapp';
  assert.equal((await post('send', {})).status, 200);
  assert.equal(app.world.hooks.length, 1);
  assert.equal(app.world.hooks[0].body.channel, 'public');
  assert.match(app.world.hooks[0].body.text, /Ride cover needed/);
  assert.deepEqual(posts(), [], 'nothing on Discord when the webhook worked');
  app.world.hookFail = true; app.world.db['cg:cover:sent'] = {};
  assert.equal((await post('send', {})).status, 200);
  assert.ok(posts().some(t => /Ride cover needed/.test(t)), 'Discord is the back-up');
  assert.equal((await post('send', {})).status, 429, 'not twice in five minutes');
  const co = (await app.get('/api/cover/callout', { token: ann })).body.text;
  assert.match(co, /\*Ride cover needed/);
  assert.ok(!co.includes('**'), 'WhatsApp bold is a single asterisk');
});

test('an iCal link becomes ride series: preview first, repeats are one series, bad links are explained', async () => {
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Thursday Tempo', 'DTSTART;TZID=Europe/London:20261105T190000', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Thursday Tempo', 'DTSTART;TZID=Europe/London:20261112T190000', 'END:VEVENT',
    'BEGIN:VEVENT', 'SUMMARY:Sunday Social', 'DTSTART:20261108T090000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  app.world.ical = ics;
  const imp = (body, token = admin) => post('import-ical', body, token);
  assert.equal((await imp({ url: 'https://cal.test/a.ics' }, mod)).status, 403, 'admin only');
  assert.equal((await imp({ url: 'http://127.0.0.1/x' })).status, 400);
  assert.equal((await imp({ url: 'https://10.0.0.1/x' })).status, 400);
  const p = (await imp({ url: 'webcal://cal.test/a.ics' })).body.preview;
  assert.deepEqual(p.map(x => [x.title, x.time, x.count]), [['Sunday Social', '09:00', 1], ['Thursday Tempo', '19:00', 2]]);
  assert.equal((await get()).body.series.length, 1, 'a preview changes nothing');
  const a = (await imp({ url: 'https://cal.test/a.ics', apply: true })).body;
  assert.equal(a.added, 2);
  assert.equal((await imp({ url: 'https://cal.test/a.ics', apply: true })).body.added, 0, 'no duplicates');
  app.world.ical = 'not a calendar';
  assert.equal((await imp({ url: 'https://cal.test/a.ics' })).status, 422);
});

test('the health panel flags a ride in the next week with no leader or sweeper', async () => {
  const row = async () => (await app.get('/api/health', { token: await app.login('admin') })).body.checks.find(c => c.id === 'cover');
  assert.equal((await row()).status, 'warn');
  const date = (await next()).date;
  for (const [role, who] of [['leader', ann], ['sweeper', cy]]) await post('volunteer', { series: sid, date, role }, who);
  const r = await row();
  assert.equal(r.status, 'ok');
  assert.match(r.detail, /Discord only/);
});
