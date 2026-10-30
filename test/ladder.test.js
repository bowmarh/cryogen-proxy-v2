'use strict';
// Zwift Club Ladder: a roster of up to 15, five-rider line-ups inside three vELO ranks, a challenge with route, time and private link, the
// result (10 points for 1st down to 1 for 10th) and the notices in between.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald', 'Emerald', 'Emerald', 'Sapphire', 'Sapphire', 'Sapphire', 'Amethyst', 'Amethyst', 'Platinum', 'Gold', ''];
const RATINGS = [2300, 2250, 2100, 2050, 2000, 1900, 1850, 1800, 1700, 1650, 1600, 1450, 1400, 1300, 1100, 0];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: cat ? { rating: RATINGS[i], mixed: { category: cat } } : undefined } })) });
  app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod');
});
after(() => app.close());

const A = () => ({ token: admin });
const get = (token = admin) => app.get('/api/ladder', { token });
const post = (path, body, token = admin) => app.post(`/api/ladder/${path}`, body, { token });
const ID = i => String(2000 + i);
const addAll = async n => { for (let i = 0; i < n; i++) await post('roster', { zwid: ID(i) }); };
const ukParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const inHours = hrs => { const p = ukParts(Date.now() + hrs * 3600000); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
const newMatch = async (extra = {}) => { const body = { opponent: 'Team Rocket', challenger: 'us', routeName: 'Bologna TT', routeKm: 20, routeMinutes: 45, ...extra }; const r = await post('match', body); return r.body.matches.find(m => m.opponent === body.opponent && !m.result && !m.seen) ; };

beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

test('only signed-in riders and staff see the ladder; only staff change it', async () => {
  assert.equal((await get(null)).status, 401);
  assert.equal((await post('roster', { zwid: ID(0) }, null)).status, 401);
  assert.equal((await post('roster', { zwid: ID(0) }, await app.memberSession('1002'))).status, 401);
  assert.equal((await get(await app.memberSession('1002'))).status, 200);
});

test('the roster holds fifteen riders at most, takes names from the club roster and shows their vELO category', async () => {
  await addAll(15);
  const full = await post('roster', { zwid: ID(15) });
  assert.equal(full.status, 409);
  assert.match(full.body.error, /full \(15 riders\)/);
  assert.equal((await post('roster', { zwid: '999999' })).status, 404, 'not in the club roster');
  assert.equal((await post('roster', { zwid: 'abc' })).status, 400);
  const v = (await get()).body;
  assert.equal(v.roster.length, 15);
  assert.deepEqual(v.roster.slice(0, 2).map(r => [r.name, r.cat, r.rating]), [['Lad 0', 'Diamond', 2300], ['Lad 1', 'Diamond', 2250]], 'best category and rating first');
  await post('roster', { zwid: ID(14), remove: true });
  assert.equal((await post('roster', { zwid: ID(15) })).status, 200, 'a place opened up');
});

test('a line-up is at most five riders inside three consecutive vELO ranks', async () => {
  await addAll(15);
  const m = await newMatch();
  const set = (idx, extra = {}) => post('lineup', { match: m.id, zwids: idx.map(ID), ...extra });
  assert.equal((await set([0, 2, 5, 3, 6])).status, 200, 'Diamond, Ruby and Emerald');
  const bad = await set([0, 2, 5, 3, 8]);
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /spans 4 ranks \(Diamond to Sapphire\)/);
  assert.equal((await set([0, 1, 2, 3, 4, 5])).status, 400, 'six riders');
  assert.equal((await set([0, 0, 2])).status, 400, 'the same rider twice');
  assert.equal((await set([0, 15])).status, 400, 'a rider off the roster');
  assert.equal((await set([0, 2, 5, 3, 8], { force: true })).status, 200, 'staff can force an exception');
  assert.equal((await post('lineup', { match: m.id, zwids: [ID(0)] }, null)).status, 401);
  // a rider with no category cannot be checked
  await post('roster', { zwid: ID(15) }).catch(() => {});
});

test('the suggestion is the strongest legal five among riders who have not said no', async () => {
  await addAll(14);
  const m = await newMatch();
  const s1 = (await app.get(`/api/ladder/suggest?match=${m.id}`, A())).body;
  assert.deepEqual(s1.zwids.map(Number).sort(), [2000, 2001, 2002, 2003, 2004], 'top five: Diamond and Ruby');
  assert.equal(s1.window, 'Diamond to Emerald');
  for (const i of [0, 1, 2]) await post('availability', { match: m.id, zwid: ID(i), status: 'no' });
  const s2 = (await app.get(`/api/ladder/suggest?match=${m.id}`, A())).body;
  assert.ok(!s2.zwids.includes(ID(0)) && !s2.zwids.includes(ID(1)), 'those who said no are left out');
  assert.equal((await app.get(`/api/ladder/suggest?match=${m.id}`, { token: null })).status, 401);
  // when no window holds five, it says so
  app.world.db['cg:ladder:roster'] = Object.fromEntries([0, 5, 8, 11, 13].map(i => [ID(i), JSON.stringify({ zwid: ID(i), name: `Lad ${i}`, at: 'x' })]));
  assert.equal((await app.get(`/api/ladder/suggest?match=${m.id}`, A())).status, 409);
});

test('a challenge records who challenged, the route, the time (UK) and the private link, and is validated', async () => {
  assert.equal((await post('match', { opponent: '' })).status, 400);
  assert.equal((await post('match', { opponent: 'X', date: '2026-11-12' })).status, 400, 'a date needs a time');
  assert.equal((await post('match', { opponent: 'X', date: '2026-11-12', time: '7pm' })).status, 400);
  assert.equal((await post('match', { opponent: 'X', eventLink: 'javascript:alert(1)' })).status, 400, 'only https links');
  assert.equal((await post('match', { opponent: 'X', routeKm: 400 })).status, 400);
  const m = await newMatch({ date: '2026-11-12', time: '19:30', eventLink: 'https://www.zwift.com/events/view/123?eventSecret=abc' });
  assert.equal(m.status, 'scheduled', 'time and private link agreed: it is on');
  assert.equal((await newMatch({ opponent: 'Z' })).status, 'challenge', 'no time or link yet: still a challenge');
  assert.equal(m.at, Date.parse('2026-11-12T19:30:00Z'), 'GMT in November');
  const summer = await newMatch({ opponent: 'Y', date: '2026-07-02', time: '19:30' });
  assert.equal(summer.at, Date.parse('2026-07-02T18:30:00Z'), 'BST in July: UK 19:30 is 18:30 UTC');
  const edited = (await post('match', { id: m.id, opponent: 'Team Rocket', routeName: 'Watopia', date: '2026-11-12', time: '19:30', eventLink: 'https://www.zwift.com/events/view/123' })).body.matches.find(x => x.id === m.id);
  assert.equal(edited.route.name, 'Watopia');
  assert.equal((await post('match-remove', { id: m.id })).body.matches.some(x => x.id === m.id), false);
});

test('riders on the roster say whether they can ride; others cannot', async () => {
  await addAll(5);
  const m = await newMatch();
  const rider = await app.memberSession(ID(0), { name: 'Lad 0' });
  const outsider = await app.memberSession('1002');
  assert.equal((await post('availability', { match: m.id, status: 'yes' }, outsider)).status, 403);
  assert.equal((await post('availability', { match: m.id, status: 'yes' }, rider)).status, 200);
  assert.equal((await post('availability', { match: m.id, status: 'sure' }, rider)).status, 400);
  const v = (await get(rider)).body.matches[0];
  assert.deepEqual([v.myAvailability, v.counts.yes, v.availability], ['yes', 1, undefined], 'riders see their own answer and the count, not the list');
  assert.equal((await get()).body.matches[0].availability[ID(0)], 'yes', 'staff see who said what');
  assert.equal((await post('availability', { match: m.id, status: '' }, rider)).body.matches[0].myAvailability, '');
});

test('the result: 10 points for first down to 1 for tenth, the team total wins, and the record builds', async () => {
  await addAll(5);
  const m = await newMatch();
  await post('lineup', { match: m.id, zwids: [0, 1, 2, 3, 4].map(ID) });
  const res = (positions) => post('result', { match: m.id, positions });
  assert.equal((await res({ [ID(0)]: 1, [ID(1)]: 2 })).status, 400, 'all five riders');
  assert.equal((await res({ [ID(0)]: 1, [ID(1)]: 2, [ID(2)]: 3, [ID(3)]: 4, [ID(4)]: 4 })).status, 400, 'a position twice');
  assert.equal((await res({ [ID(0)]: 1, [ID(1)]: 2, [ID(2)]: 3, [ID(3)]: 4, [ID(4)]: 11 })).status, 400, 'a race of ten');
  const won = (await res({ [ID(0)]: 1, [ID(1)]: 3, [ID(2)]: 4, [ID(3)]: 6, [ID(4)]: 9 })).body;
  const r = won.matches[0].result;
  assert.deepEqual([r.ourPoints, r.theirPoints, r.won], [10 + 8 + 7 + 5 + 2, 55 - 32, true]);
  assert.equal(won.matches[0].status, 'played');
  const m2 = await newMatch({ opponent: 'Other' });
  await post('lineup', { match: m2.id, zwids: [0, 1, 2, 3, 4].map(ID) });
  const lost = (await post('result', { match: m2.id, positions: { [ID(0)]: 2, [ID(1)]: 5, [ID(2)]: 7, [ID(3)]: 8, [ID(4)]: 10 } })).body;
  assert.deepEqual([lost.record.played, lost.record.won, lost.record.lost, lost.record.pointsFor, lost.record.pointsAgainst], [2, 1, 1, 55, 55]);
  const top = lost.record.riders[0];
  assert.equal(top.name, 'Lad 0');
  assert.deepEqual([top.races, top.points, top.avg, top.best], [2, 10 + 9, 9.5, 1]);
});

test('posting goes to the ladder channel with the line-up and the private link, and not twice in five minutes', async () => {
  await addAll(5);
  const m = await newMatch({ date: '2026-11-12', time: '19:30', eventLink: 'https://www.zwift.com/events/view/9?eventSecret=zz' });
  assert.equal((await post('post', { match: m.id, kind: 'lineup' })).status, 409, 'pick the line-up first');
  await post('lineup', { match: m.id, zwids: [0, 1, 2, 3, 4].map(ID) });
  app.world.discord.length = 0;
  assert.equal((await post('post', { match: m.id, kind: 'lineup' })).status, 200);
  const text = app.world.discord.map(p => p.body.content).join('\n');
  assert.match(text, /Ladder line-up\*\*: CRYO-GEN v Team Rocket/);
  assert.match(text, /Private event link:\*\* https:\/\/www\.zwift\.com\/events\/view\/9\?eventSecret=zz/);
  assert.match(text, /• Lad 0 \(Diamond\)/);
  assert.match(text, /Thu 12 Nov, 19:30 UK/);
  assert.equal((await post('post', { match: m.id, kind: 'lineup' })).status, 429);
  assert.equal((await post('post', { match: m.id, kind: 'callout' })).status, 200);
  assert.match(app.world.discord.map(p => p.body.content).join('\n'), /Ladder challenge: CRYO-GEN v Team Rocket/);
});

test('the scheduled tick warns about a missing line-up, reminds the day before and two hours before, each once', async () => {
  await addAll(5);
  await post('meta', { auto: false });   // this test is about the warning; automatic picking has its own tests
  const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  const t = inHours(20);
  const m = await newMatch({ date: t.date, time: t.time, eventLink: 'https://www.zwift.com/events/view/5' });
  assert.equal(m.status, 'scheduled');
  await tick();
  const admin1 = app.world.discord.filter(p => p.channel === 'admin' && /no legal line-up yet/.test(p.body.content));
  assert.equal(admin1.length, 1, 'no line-up three days or less before');
  assert.ok(!app.world.discord.some(p => /Ladder race tomorrow/.test(p.body.content)));
  await post('lineup', { match: m.id, zwids: [0, 1, 2, 3, 4].map(ID) });
  app.world.discord.length = 0;
  await tick();
  assert.equal(app.world.discord.filter(p => /Ladder race tomorrow/.test(p.body.content)).length, 1);
  app.world.discord.length = 0;
  await tick();
  assert.deepEqual(app.world.discord.filter(p => /Ladder race/.test(p.body.content)), [], 'once only');
  // two hours before
  const near = inHours(1);
  await post('match', { id: m.id, opponent: 'Team Rocket', date: near.date, time: near.time });
  app.world.discord.length = 0;
  await tick();
  assert.equal(app.world.discord.filter(p => /Ladder race in about two hours/.test(p.body.content)).length, 1);
});

test('the health panel reports the ladder', async () => {
  const row = async () => (await app.get('/api/health', { token: await app.login('admin') })).body.checks.find(c => c.id === 'ladder');
  assert.equal((await row()).status, 'info');
  await addAll(5);
  const t = inHours(30);
  await newMatch({ date: t.date, time: t.time, eventLink: 'https://www.zwift.com/events/view/5' });
  assert.equal((await row()).status, 'warn', 'a match within three days with no line-up');
});

test('the private event link is shown only to staff and riders on the ladder roster', async () => {
  await addAll(3);
  await newMatch({ eventLink: 'https://www.zwift.com/events/view/77?eventSecret=s3cret' });
  const link = async token => (await get(token)).body.matches[0].eventLink;
  assert.match(await link(admin), /eventSecret=s3cret/);
  assert.match(await link(await app.memberSession(ID(0), { name: 'Lad 0' })), /eventSecret=s3cret/);
  assert.equal(await link(await app.memberSession('1002')), 'hidden', 'a club member not on the roster does not get it');
});
