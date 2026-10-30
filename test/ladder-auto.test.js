'use strict';
// Ladder automation: the line-up and a reserve picked from the riders' answers, a starter who says no replaced at once, and the scheduled watch
// (autopick three days out, challenges with no date, results not entered, zombie teams).
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby', 'Emerald', 'Emerald', 'Emerald', 'Sapphire'];
const RATINGS = [2300, 2250, 2100, 2050, 2000, 1900, 1850, 1800, 1700];
before(async () => {
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: RATINGS[i], mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

const post = (path, body) => app.post(`/api/ladder/${path}`, body, { token: admin });
const ID = i => String(2000 + i);
const view = async team => (await app.get(`/api/ladder${team ? '?team=' + team : ''}`, { token: admin })).body;
const addAll = async n => { for (let i = 0; i < n; i++) await post('roster', { zwid: ID(i) }); };
const ukParts = ms => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
const inHours = hrs => { const p = ukParts(Date.now() + hrs * 3600000); return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` }; };
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const adminPosts = () => app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content);
const match = async (hrs, extra = {}) => (await post('match', { opponent: 'Team Rocket', challenger: 'us', routeName: 'Bologna TT', routeKm: 20, routeMinutes: 45, eventLink: 'https://www.zwift.com/events/view/5', ...inHours(hrs), ...extra })).body.matches.find(m => m.opponent === (extra.opponent || 'Team Rocket'));
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

test('the suggestion prefers riders who said yes, names a reserve, and the auto-lineup saves both in one click', async () => {
  await addAll(9);
  const m = await match(100);
  await post('availability', { match: m.id, zwid: ID(0), status: 'no' });
  await post('availability', { match: m.id, zwid: ID(1), status: 'maybe' });
  for (const i of [2, 3, 4, 5, 6, 7]) await post('availability', { match: m.id, zwid: ID(i), status: 'yes' });
  const s = (await app.get(`/api/ladder/suggest?match=${m.id}`, { token: admin })).body;
  assert.ok(!s.zwids.includes(ID(0)), 'said no');
  assert.ok(s.reserve && !s.zwids.includes(s.reserve));
  const v = (await post('auto-lineup', { match: m.id })).body.matches[0];
  assert.deepEqual(v.lineup.slice().sort(), s.zwids.slice().sort());
  assert.equal(v.reserve, s.reserve);
  assert.equal(v.reserveInfo.name.startsWith('Lad'), true);
  assert.equal(v.lineupCheck.ok, true);
});

test('a starter who says no is replaced by the reserve, the admin channel is told, and it can be switched off', async () => {
  await addAll(8);
  const m = await match(100);
  await post('auto-lineup', { match: m.id });
  let v = (await view()).matches[0];
  const gone = v.lineup[0], reserve = v.reserve;
  app.world.discord.length = 0;
  await post('availability', { match: m.id, zwid: gone, status: 'no' });
  v = (await view()).matches[0];
  assert.ok(!v.lineup.includes(gone) && v.lineup.includes(reserve) && v.lineup.length === 5);
  assert.notEqual(v.reserve, reserve, 'a new reserve is named');
  assert.match(adminPosts().join('\n'), /can't ride, so .* \(the reserve\) takes the place/);
  // the team's automatic picking off: the answer is just recorded
  await post('meta', { auto: false });
  const other = v.lineup[0];
  app.world.discord.length = 0;
  await post('availability', { match: m.id, zwid: other, status: 'no' });
  assert.ok((await view()).matches[0].lineup.includes(other));
  assert.equal(adminPosts().length, 0);
  assert.equal((await view()).meta.auto, false);
});

test('three days out with no line-up the tick picks one (reserve too) and tells the admin channel once; it warns when no five fit', async () => {
  await addAll(6);
  const m = await match(50);
  const ran = await tick();
  assert.ok(ran.includes('ladder-autopick'), JSON.stringify(ran));
  const v = (await view()).matches[0];
  assert.equal(v.lineup.length, 5); assert.ok(v.reserve); assert.equal(v.id, m.id);
  assert.ok(adminPosts().some(t => /picked automatically/.test(t) && /Reserve:/.test(t)));
  assert.ok(!adminPosts().some(t => /no legal line-up yet/.test(t)));
  app.world.discord.length = 0;
  assert.ok(!(await tick()).includes('ladder-autopick'), 'once');

  app.world.db = {}; app.world.discord.length = 0;
  await addAll(3);
  await match(50);
  assert.ok((await tick()).includes('ladder-incomplete'), 'not enough riders: the staff are warned instead');
});

test('a challenge with no date is chased, a played match with no result is chased, and a quiet team gets the zombie warnings', async () => {
  await addAll(5);
  const c = (await post('match', { opponent: 'Late Lads', challenger: 'them' })).body.matches.find(x => x.opponent === 'Late Lads');
  const stored = JSON.parse(app.world.db['cg:ladder:matches'][c.id]);
  app.world.db['cg:ladder:matches'][c.id] = JSON.stringify({ ...stored, createdAt: new Date(Date.now() - 3 * 86400000).toISOString() });
  assert.ok((await tick()).includes('ladder-chase'));
  assert.match(adminPosts().join('\n'), /Late Lads.* still has no date/);
  assert.ok(!(await tick()).includes('ladder-chase'), 'once for those days');

  app.world.db = {}; app.world.discord.length = 0;
  const m = await match(-3, { opponent: 'Gone By' });
  assert.ok((await tick()).includes('ladder-result-due'));
  assert.match(adminPosts().join('\n'), /Gone By.* has been run.*#race-committee within 24 hours/s);

  // a team whose last race was 15 days ago is a warning, and 21 days a zombie
  const raw = JSON.parse(app.world.db['cg:ladder:matches'][m.id]);
  app.world.db['cg:ladder:matches'][m.id] = JSON.stringify({ ...raw, at: Date.now() - 15 * 86400000, status: 'played', result: { positions: {}, ourPoints: 0, theirPoints: 55, won: false, at: new Date().toISOString() } });
  app.world.discord.length = 0;
  assert.ok((await tick()).includes('ladder-z14'));
  assert.match(adminPosts().join('\n'), /has not raced for 14 days/);
  app.world.db['cg:ladder:matches'][m.id] = JSON.stringify({ ...raw, at: Date.now() - 22 * 86400000, status: 'played', result: { positions: {}, ourPoints: 0, theirPoints: 55, won: false, at: new Date().toISOString() } });
  assert.ok((await tick()).includes('ladder-z21'));
  const act = (await view()).activity;
  assert.equal(act.state, 'zombie');
});

test('route guidance, one race a day, power-ups, the challenge range and riders on two ladder teams are all shown', async () => {
  await addAll(5);
  const m = await match(100, { routeKm: 40, routeMinutes: 70, powerUps: 'Feather, Draft Boost' });
  assert.equal(m.routeWarnings.length, 2);
  assert.equal(m.powerUps, 'Feather, Draft Boost');
  const t = inHours(100);
  const twin = await post('match', { opponent: 'Other', challenger: 'us', date: t.date, time: t.time });
  assert.equal(twin.status, 409);
  assert.match(twin.body.error, /one race a team a day/);
  assert.equal((await post('match', { opponent: 'Other', challenger: 'us', date: t.date, time: t.time, force: true })).status, 200);
  await post('meta', { rung: 12 });
  assert.deepEqual((await view()).challengeRange, { from: 5, to: 11, note: (await view()).challengeRange.note });
  await post('meta', { auto: false });
  assert.equal((await view()).meta.rung, 12, 'the rung survives a settings change');
  const other = (await post('team', { name: 'Second' })).body.team.id;
  await post('roster', { zwid: ID(0), team: other });
  assert.deepEqual((await view()).shared.map(x => x.zwid), [ID(0)]);
});
