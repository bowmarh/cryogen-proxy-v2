'use strict';
// Race day: what is on within a day, who is in the pen, and the message twenty minutes before a start.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald'];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
const A = { get token() { return admin; } };
const ID = i => String(2000 + i);
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
const ukParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const when = mins => { const p = ukParts(Date.now() + mins * 60000); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; world.dms = []; world.dmFail = new Set(); process.env.DISCORD_BOT_TOKEN = 'bot'; });

async function ladderMatch(mins) {
  for (let i = 0; i < 6; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  const m = (await app.post('/api/ladder/match', { opponent: 'Team Rocket', challenger: 'us', ...when(mins), eventLink: 'https://www.zwift.com/events/view/5' }, A)).body.matches[0];
  await app.post('/api/ladder/auto-lineup', { match: m.id }, A);
  return (await app.get('/api/ladder', A)).body.matches[0];
}

test('staff see what is on in the next day with the line-up, answers and who is in the pen; a match two days away is not listed', async () => {
  const m = await ladderMatch(90);
  const ev = (await app.get('/api/live', A)).body.events;
  assert.equal(ev.length, 1);
  assert.deepEqual([ev[0].kind, ev[0].id, ev[0].need, ev[0].ready, ev[0].status], ['ladder', m.id, 5, 0, 'later']);
  assert.equal(ev[0].riders.filter(r => r.role === 'starter').length, 5);
  assert.equal(ev[0].riders.filter(r => r.role === 'reserve').length, 1);
  assert.equal((await app.get('/api/live')).status, 401);
  assert.equal((await app.get('/api/live', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 401);
  app.world.db = {};
  await ladderMatch(2 * 24 * 60);
  assert.equal((await app.get('/api/live', A)).body.events.length, 0);
});

test('a rider says they are in the pen for their own race only; staff can do it for anyone; it can be undone', async () => {
  const m = await ladderMatch(25);
  const starter = m.lineup[0], outsider = ID(5);
  const rider = await app.memberSession(starter, { name: 'Starter' });
  assert.equal((await app.post('/api/live/checkin', { kind: 'ladder', id: m.id }, { token: rider })).status, 200);
  let ev = (await app.get('/api/live', A)).body.events[0];
  assert.equal(ev.ready, 1); assert.equal(ev.status, 'soon'); assert.equal(ev.late.length, 4);
  const notRacing = m.lineup.includes(outsider) || m.reserve === outsider ? null : await app.memberSession(outsider, { name: 'Bench' });
  if (notRacing) assert.equal((await app.post('/api/live/checkin', { kind: 'ladder', id: m.id }, { token: notRacing })).status, 403);
  assert.equal((await app.post('/api/live/checkin', { kind: 'ladder', id: m.id, zwid: m.lineup[1] }, A)).status, 200);
  assert.equal((await app.post('/api/live/checkin', { kind: 'ladder', id: m.id, zwid: m.lineup[1], in: false }, A)).status, 200);
  assert.equal((await app.post('/api/live/checkin', { kind: 'ladder', id: 'nope' }, A)).status, 404);
  assert.equal((await app.post('/api/live/checkin', { kind: 'chess', id: m.id }, A)).status, 400);
  assert.equal((await app.post('/api/live/checkin', { kind: 'ladder', id: m.id }, { token: null })).status, 401);
  ev = (await app.get('/api/live', A)).body.events[0];
  assert.equal(ev.ready, 1);
  assert.ok(ev.riders.find(r => r.zwid === starter).inPen);
});

test('twenty minutes before a start the riders who are not in the pen get one message; those who are, said no, or are reserve do not', async () => {
  const m = await ladderMatch(20);
  for (let i = 0; i < 6; i++) await app.post('/api/comms/link', { zwid: ID(i), discordId: `${1000 + i}`.padStart(18, '1') }, A);
  await app.post('/api/comms/auto', { nudge: true }, A);
  await app.post('/api/live/checkin', { kind: 'ladder', id: m.id, zwid: m.lineup[0] }, A);
  world.dms = [];
  await tick();
  const pens = world.dms.filter(d => /starts in about \d+ minutes/.test(d.body.content));
  assert.equal(pens.length, 4, 'five starters, one already in the pen');
  assert.match(pens[0].body.content, /tap "I'm in the pen"/);
  assert.match(pens[0].body.content, /Private event: https:\/\/www\.zwift\.com\/events\/view\/5/);
  const before = world.dms.length;
  await tick();
  assert.equal(world.dms.length, before, 'once each');
});

test('My week offers the pen button for a race an hour or less away', async () => {
  const m = await ladderMatch(30);
  const starter = m.lineup[0];
  const w = (await app.get('/api/me/week', { token: await app.memberSession(starter, { name: 'Starter' }) })).body.items.find(i => i.kind === 'Ladder');
  assert.deepEqual(w.pen, { kind: 'ladder', id: m.id });
});

test('ten minutes out, starters who are not in the pen are reported once and the reserve is asked to be ready; staff can swap the reserve in', async () => {
  const m = await ladderMatch(10);
  for (let i = 0; i < 6; i++) await app.post('/api/comms/link', { zwid: ID(i), discordId: `${1000 + i}`.padStart(18, '1') }, A);
  await app.post('/api/comms/auto', { nudge: true }, A);
  await app.post('/api/live/checkin', { kind: 'ladder', id: m.id, zwid: m.lineup[0] }, A);
  app.world.discord.length = 0; world.dms = [];
  await tick();
  const warn = app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content).find(t => /not in the pen yet/.test(t));
  assert.ok(warn, 'the admin channel is told');
  assert.match(warn, /has been asked to be ready/);
  assert.equal(world.dms.filter(d => /Please be ready to step in/.test(d.body.content)).length, 1, 'the reserve gets one message');
  app.world.discord.length = 0;
  await tick();
  assert.ok(!app.world.discord.some(p => /not in the pen yet/.test(p.body.content)), 'once');

  const ev = (await app.get('/api/live', A)).body.events[0];
  assert.equal(ev.lateIds.length, 4); assert.equal(ev.bench.length, 1);
  const out = ev.lateIds[0], inn = ev.bench[0].zwid;
  assert.equal((await app.post('/api/live/swap', { kind: 'ladder', id: m.id, out, in: ev.lateIds[1] }, A)).status, 400, 'only someone on the bench can step in');
  assert.equal((await app.post('/api/live/swap', { kind: 'ladder', id: m.id, out, in: inn }, { token: await app.memberSession(ID(0), { name: 'x' }) })).status, 401);
  assert.equal((await app.post('/api/live/swap', { kind: 'ladder', id: m.id, out, in: inn }, A)).status, 200);
  const after = (await app.get('/api/ladder', A)).body.matches[0];
  assert.ok(after.lineup.includes(inn) && !after.lineup.includes(out));
});

test('a rider racing sees who of the line-up is in the pen (names and a tick only); a rider who is not racing cannot', async () => {
  const m = await ladderMatch(50);
  const [a, b] = m.lineup, outsider = '1002';   // not on the ladder roster
  await app.post('/api/live/checkin', { kind: 'ladder', id: m.id }, { token: await app.memberSession(a, { name: 'First' }) });
  const me = { token: await app.memberSession(b, { name: 'Second' }) };
  const pen = await app.get(`/api/live/pen?kind=ladder&id=${encodeURIComponent(m.id)}`, me);
  assert.equal(pen.status, 200, JSON.stringify(pen.body));
  assert.equal(pen.body.riders.length, 5, 'the reserve is not listed');
  assert.equal(pen.body.riders.filter(r => r.inPen).length, 1);
  assert.equal(pen.body.riders.filter(r => r.me).length, 1);
  assert.ok(!JSON.stringify(pen.body).match(/"zwid"/), 'no Zwift IDs');
  assert.equal((await app.get(`/api/live/pen?kind=ladder&id=${encodeURIComponent(m.id)}`, { token: await app.memberSession(outsider, { name: 'Outsider' }) })).status, 403);
  assert.equal((await app.get(`/api/live/pen?kind=ladder&id=${encodeURIComponent(m.id)}`)).status, 401);
});
