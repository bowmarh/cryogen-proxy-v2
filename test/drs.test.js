'use strict';
// DIRT Racing Series: a squad of eight in a vELO division, a fixed calendar, only the best four finishers score, the 35-point buffer above the
// division threshold, and the reminders before the 24-hour lock.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
// threshold 1500, buffer 35, so the cap is 1535
const RATINGS = [1400, 1450, 1500, 1520, 1530, 1540, 1600, 1380, 1390, 1410, 0];
before(async () => {
  world = h.createWorld({ riders: RATINGS.map((r, i) => ({ riderId: 3000 + i, name: `Dirt ${i}`, country: 'gb', zpCategory: 'B', race: { current: r ? { rating: r, mixed: { category: 'Platinum' } } : undefined } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

const A = () => ({ token: admin });
const ID = i => String(3000 + i);
const get = (token = admin) => app.get('/api/drs', { token });
const post = (path, body, token = admin) => app.post(`/api/drs/${path}`, body, { token });
const ukParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const inHours = hrs => { const p = ukParts(Date.now() + hrs * 3600000); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
const SEASON = { name: 'DRS Autumn', division: 'Platinum', threshold: 1500, slot: 'Tuesday EU', time: '19:30', tz: 'Europe/London' };
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
const adminPosts = () => app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content);
const publicPosts = () => app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content);
async function setup(riders = [0, 1, 2, 3], season = SEASON) {
  await post('season', season);
  for (const i of riders) await post('squad', { zwid: ID(i), force: true });   // some test riders sit above the threshold on purpose
}
const stage = async (extra = {}) => (await post('stage', { type: 'scratch', route: 'Dirt Loop', km: 28, ...extra })).body.stages.slice(-1)[0];

beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

test('signed-in riders and staff see the series; only staff change it', async () => {
  assert.equal((await get(null)).status, 401);
  assert.equal((await post('season', SEASON, null)).status, 401);
  assert.equal((await post('season', SEASON, await app.memberSession('1002'))).status, 401);
  assert.equal((await get(await app.memberSession('1002'))).body.season, null, 'nothing set up yet');
  assert.equal((await post('squad', { zwid: ID(0) })).status, 409, 'the season comes first');
});

test('the season is validated and the cap is the threshold plus the buffer', async () => {
  assert.equal((await post('season', { ...SEASON, threshold: 'high' })).status, 400);
  assert.equal((await post('season', { ...SEASON, time: '7pm' })).status, 400);
  assert.equal((await post('season', { ...SEASON, tz: 'Mars/Base' })).status, 400);
  const s = (await post('season', SEASON)).body.season;
  assert.deepEqual([s.threshold, s.buffer, s.cap, s.squadMax, s.scorers, s.alertWithin, s.spikeLimit], [1500, 35, 1535, 8, 4, 10, 50]);
});

test('the squad holds eight, and a rider above the threshold cannot be nominated before their first race ', async () => {
  await post('season', SEASON);
  for (const i of [0, 1, 2, 7, 8, 9]) assert.equal((await post('squad', { zwid: ID(i) })).status, 200);
  const over = await post('squad', { zwid: ID(5) });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /rated 1540, above the Platinum threshold of 1500/);
  assert.equal((await post('squad', { zwid: ID(5), force: true })).status, 200, 'staff can force it');
  assert.equal((await post('squad', { zwid: ID(3), force: true })).status, 200);
  assert.equal((await post('squad', { zwid: ID(1) })).status, 200, 'already in: nothing changes');
  const full = await post('squad', { zwid: ID(10), name: 'Nobody' });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /full \(8 riders\)/);
  assert.equal((await post('squad', { zwid: '999999' })).status, 404, 'unknown riders are refused before the size check');
  await post('squad', { zwid: ID(9), remove: true });
  assert.equal((await post('squad', { zwid: 'x' })).status, 400);
});

test('a rider who has raced may use the buffer: ok, buffer, danger (within 10 of the cap) or breach', async () => {
  await setup([0, 1, 2, 3, 4]);
  await post('squad', { zwid: ID(5), force: true }); await post('squad', { zwid: ID(6), force: true });
  const st = await stage({ date: '2026-11-03' });
  const before = (await get()).body.squad;
  assert.equal(before.find(r => r.zwid === ID(6)).state, 'entry-over', 'above the threshold and not yet raced');
  assert.equal(before.find(r => r.zwid === ID(0)).state, 'ok');
  // everyone races once; now the buffer applies
  await post('result', { stage: st.id, results: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((i, k) => [ID(i), { pos: k + 1, pts: 0 }])) });
  const states = Object.fromEntries((await get()).body.squad.map(r => [r.name, [r.state, r.remaining]]));
  assert.deepEqual(states['Dirt 0'], ['ok', 135]);
  assert.deepEqual(states['Dirt 3'], ['buffer', 15], '1520: above 1500, 15 below the cap');
  assert.deepEqual(states['Dirt 4'], ['danger', 5], '1530: within 10 of the cap');
  assert.deepEqual(states['Dirt 5'], ['breach', -5], '1540: past the cap of 1535');
  assert.equal(states['Dirt 6'][0], 'breach');
});

test('a stage has a type, a route and a private link that only staff and squad riders see; the calendar can be pasted', async () => {
  await setup([0, 1, 2, 3]);
  assert.equal((await post('stage', { type: 'sprint', date: '2026-11-03' })).status, 400);
  assert.equal((await post('stage', { type: 'ttt', date: 'soon' })).status, 400);
  assert.equal((await post('stage', { type: 'ttt', date: '2026-11-03', eventLink: 'javascript:1' })).status, 400);
  const st = await stage({ date: '2026-11-03', type: 'ttt', eventLink: 'https://www.zwift.com/events/view/9?eventSecret=dd' });
  assert.equal(st.n, 1);
  const cal = (await post('calendar', { lines: '2026-11-10 | points | Rolling | 30\n2026-11-17 | Individual Time Trial | TT course | 12\n2026-11-24 | team time trial | Flat | 25' })).body.stages;
  assert.deepEqual(cal.map(s => [s.n, s.type]), [[1, 'ttt'], [2, 'points'], [3, 'itt'], [4, 'ttt']]);
  assert.equal((await post('calendar', { lines: '2026-11-10 | sprint | x' })).status, 400);
  assert.equal((await post('stage', { type: 'scratch', date: '2026-12-01', n: 2 })).status, 409, 'stage 2 exists');
  const link = async token => (await get(token)).body.stages[0].eventLink;
  assert.match(await link(admin), /eventSecret=dd/);
  assert.match(await link(await app.memberSession(ID(0), { name: 'Dirt 0' })), /eventSecret=dd/);
  assert.equal(await link(await app.memberSession('1002')), 'hidden');
});

test('only the best four of our finishers score, and the standings follow', async () => {
  await setup([0, 1, 2, 3, 7, 8, 9]);
  const st = await stage({ date: '2026-11-03' });
  const bad = (results) => post('result', { stage: st.id, results });
  assert.equal((await bad({})).status, 400);
  assert.equal((await bad({ [ID(0)]: { pos: 5, pts: 10 }, [ID(1)]: { pos: 5, pts: 9 } })).status, 400, 'a position twice');
  assert.equal((await bad({ [ID(5)]: { pos: 5, pts: 10 } })).status, 400, 'not in the squad');
  const r = (await bad({ [ID(0)]: { pos: 3, pts: 21 }, [ID(1)]: { pos: 8, pts: 14 }, [ID(2)]: { pos: 5, pts: 18 }, [ID(3)]: { pos: 12, pts: 10 }, [ID(7)]: { pos: 9, pts: 12 }, [ID(8)]: { pos: 20, pts: 1 }, [ID(9)]: { pos: 0, pts: 0 } })).body;
  const res = r.stages[0].result;
  assert.deepEqual(res.scorers, [ID(0), ID(2), ID(1), ID(7)], 'positions 3, 5, 8, 9');
  assert.equal(res.teamPoints, 21 + 18 + 14 + 12, 'the other riders are support and add nothing');
  assert.equal(r.stages[0].status, 'played');
  assert.equal(r.record.teamPoints, 65);
  const top = r.record.riders[0];
  assert.deepEqual([top.name, top.points, top.scored], ['Dirt 0', 21, 1]);
  assert.equal(r.record.riders.find(x => x.zwid === ID(3)).points, 0, 'a finisher outside the four scored nothing');
});

test('the scoring four can be named for a stage; everyone else is support', async () => {
  await setup([0, 1, 2, 3, 7]);
  const st = await stage({ date: '2026-11-03' });
  assert.equal((await post('roles', { stage: st.id, scorers: [0, 1, 2, 3, 7].map(ID) })).status, 400, 'at most four');
  assert.equal((await post('roles', { stage: st.id, scorers: [ID(5)] })).status, 400, 'squad riders only');
  const roles = (await post('roles', { stage: st.id, scorers: [0, 1, 2, 3].map(ID) })).body.stages[0].roles;
  assert.deepEqual([roles[ID(0)], roles[ID(7)]], ['scorer', 'support']);
  const s = (await get()).body.stages[0];
  assert.equal(s.suggestedScorers.length, 4, 'a suggestion: the four highest-rated');
  assert.equal(s.suggestedScorers[0], ID(3), 'highest vELO first');
});

test('posting a stage puts the time, private link, plan and squad in the DRS channel', async () => {
  await setup([0, 1, 2, 3, 7]);
  const st = await stage({ date: '2026-11-03', eventLink: 'https://www.zwift.com/events/view/9?eventSecret=dd' });
  await post('roles', { stage: st.id, scorers: [0, 1, 2, 3].map(ID) });
  app.world.discord.length = 0;
  assert.equal((await post('post', { stage: st.id })).status, 200);
  const t = publicPosts().join('\n');
  assert.match(t, /DRS stage\*\* 1: Scratch race — Dirt Loop \(28 km\)/);
  assert.match(t, /Tue 3 Nov, 19:30 GMT/);
  assert.match(t, /Private event link:\*\* https:\/\/www\.zwift\.com\/events\/view\/9\?eventSecret=dd/);
  assert.match(t, /Scoring four:\*\* Dirt 3, Dirt 2, Dirt 1, Dirt 0/);
  assert.match(t, /Support:\*\* Dirt 7/);
  assert.match(t, /No PowerUps/);
  assert.equal((await post('post', { stage: st.id })).status, 429);
});

test('the tick speaks only about trouble: danger and breach once a week, a jump in rating once, nothing when all is well', async () => {
  await setup([0, 1]);
  await tick();
  assert.deepEqual(adminPosts().filter(t => /vELO alert/.test(t)), [], 'quiet when nobody is near the cap');
  await post('squad', { zwid: ID(4), force: true });   // 1530: within 10 of the cap
  const st = await stage({ date: '2026-11-03' });
  await post('result', { stage: st.id, results: { [ID(4)]: { pos: 1, pts: 5 }, [ID(0)]: { pos: 2, pts: 4 } } });
  app.world.discord.length = 0;
  await tick();
  const alert = adminPosts().filter(t => /vELO alert/.test(t));
  assert.equal(alert.length, 1);
  assert.match(alert[0], /Dirt 4\*\*: 1530\. Only 5 points below the cap of 1535/);
  assert.ok(!/Dirt 0/.test(alert[0]), 'riders in the clear are not mentioned');
  app.world.discord.length = 0;
  await tick();
  assert.deepEqual(adminPosts().filter(t => /vELO alert/.test(t)), [], 'not again this week');
  // a rider whose rating jumped since the last look (history says 1400, now 1450)
  app.world.db['cg:drs:ratings'][ID(1)] = JSON.stringify({ history: [{ r: 1380, at: 1 }] });
  app.world.discord.length = 0;
  await tick();
  const spike = adminPosts().filter(t => /jumped 70 points to 1450/.test(t));
  assert.equal(spike.length, 1, 'a rise of more than 50 is called out');
});

test('stage reminders: a pre-check, a finalise reminder before the lock, then the stage a day and two hours before, each once', async () => {
  await setup([0, 1]);   // two riders: fewer than the four needed to score
  const a = inHours(60);
  const far = await stage({ date: a.date, time: a.time });
  await tick();
  assert.equal(adminPosts().filter(t => /DRS stage 1/.test(t) && /only 2 riders/.test(t)).length, 1, 'three days out with too few riders');
  app.world.discord.length = 0;
  await tick();
  assert.deepEqual(adminPosts(), [], 'once only');
  await post('stage-remove', { id: far.id });
  const b = inHours(30);
  const near = await stage({ date: b.date, time: b.time });
  app.world.discord.length = 0;
  await tick();
  assert.equal(adminPosts().filter(t => new RegExp(`Finalise the DRS squad for stage ${near.n}\\b`).test(t)).length, 1, 'between 36 and 24 hours before the lock');
  const c = inHours(20);
  await post('stage', { id: (await get()).body.stages[0].id, type: 'scratch', date: c.date, time: c.time });
  app.world.discord.length = 0;
  await tick();
  assert.equal(publicPosts().filter(t => /DRS stage tomorrow/.test(t)).length, 1);
  app.world.discord.length = 0;
  await tick();
  assert.deepEqual(publicPosts().filter(t => /DRS stage/.test(t)), [], 'once only');
});

test('the health panel reports the series', async () => {
  const row = async () => (await app.get('/api/health', { token: await app.login('admin') })).body.checks.find(c => c.id === 'drs');
  assert.equal((await row()).status, 'info');
  await setup([0, 1, 7, 8]);
  assert.equal((await row()).status, 'ok');
  await post('squad', { zwid: ID(5), force: true });
  assert.equal((await row()).status, 'warn', 'a rider at or past the limit');
});

test('resetting archives the season and clears the squad, calendar and ratings (admin, typed confirmation)', async () => {
  await setup([0, 1]);
  await stage({ date: '2026-11-03' });
  assert.equal((await post('reset', { confirm: 'no' })).status, 400);
  assert.equal((await post('reset', { confirm: 'RESET' }, await app.login('mod'))).status, 403);
  const r = (await post('reset', { confirm: 'RESET' })).body;
  assert.equal(r.season, null);
  assert.equal(Object.keys(app.world.db['cg:drs:archive'] || {}).length, 1, 'the old season is kept');
  assert.equal(app.world.db['cg:drs:squad'], undefined);
});
