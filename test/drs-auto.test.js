'use strict';
// DIRT automation: availability for each stage, the scoring four picked from answers and the vELO buffer, the squad lock-in, and the scheduled survey, audit and result chase.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, admin;
// threshold 1500, buffer 35: the cap is 1535
const RATINGS = [1400, 1450, 1500, 1520, 1530, 1380, 1390, 1410];
before(async () => {
  const world = h.createWorld({ riders: RATINGS.map((r, i) => ({ riderId: 3000 + i, name: `Dirt ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: r, mixed: { category: 'Platinum' } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => app.close());

const ID = i => String(3000 + i);
const post = (path, body, token = admin) => app.post(`/api/drs/${path}`, body, { token });
const get = (token = admin) => app.get('/api/drs', { token });
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } }).then(r => r.body.ran);
const adminPosts = () => app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content);
const publicPosts = () => app.world.discord.filter(p => p.channel === 'public').map(p => p.body.content);
const SEASON = { name: 'DRS Autumn', division: 'Platinum', threshold: 1500, time: '12:00', tz: 'UTC' };
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; });

// A season, eight riders in the squad, and one stage starting `hours` from now (12:00 UTC on the day, so the date is chosen to land within the hour).
async function setup(hours, n = 8) {
  const start = Date.now() + hours * 3600000, time = new Date(start).toISOString().slice(11, 16);
  await post('season', { ...SEASON, time });
  for (let i = 0; i < n; i++) await post('squad', { zwid: ID(i), force: true });
  const st = (await post('stage', { type: 'scratch', route: 'Dirt Loop', km: 28, date: ymd(start) })).body.stages[0];
  return st;
}

test('squad riders say whether they can race; staff can answer for them; others cannot', async () => {
  const st = await setup(200);
  assert.equal((await post('availability', { stage: st.id, zwid: ID(0), status: 'maybe' })).status, 200);
  assert.equal((await post('availability', { stage: st.id, zwid: ID(1), status: 'no' })).body.stages[0].counts.no, 1);
  assert.equal((await post('availability', { stage: st.id, zwid: ID(1), status: 'later' })).status, 400);
  const outsider = await app.memberSession('1002', { name: 'Rider Two' });
  assert.equal((await post('availability', { stage: st.id, status: 'yes' }, outsider)).status, 403);
  const rider = await app.memberSession(ID(2), { name: 'Dirt 2' });
  const v = (await post('availability', { stage: st.id, status: 'yes' }, rider)).body.stages[0];
  assert.equal(v.myAvailability, 'yes');
  assert.equal(v.counts.yes, 1);
  assert.equal(v.availability, undefined, 'only staff see who said what');
  assert.equal((await post('availability', { stage: st.id, status: 'yes' }, null)).status, 401);
});

test('the scoring four come from the answers and keep riders near the cap out of the scoring four; auto roles save them', async () => {
  const st = await setup(200);
  await post('availability', { stage: st.id, zwid: ID(2), status: 'no' });
  const v = (await post('roles', { stage: st.id, auto: true })).body.stages[0];
  const scorers = Object.entries(v.roles).filter(([, r]) => r === 'scorer').map(([z]) => z);
  assert.equal(scorers.length, 4);
  assert.ok(!scorers.includes(ID(2)), 'said no');
  assert.ok(!scorers.includes(ID(4)) && !scorers.includes(ID(3)), 'at 1530 and 1520 they are within ten of the cap and kept for support');
  assert.deepEqual(v.suggestedScorers.slice().sort(), scorers.slice().sort());
});

test('a rider who has raced is locked into the squad, and the squad cannot change in the last 24 hours without force', async () => {
  const st = await setup(200);
  await post('result', { stage: st.id, results: { [ID(0)]: { pos: 3, pts: 108 } } });
  const out = await post('squad', { zwid: ID(0), remove: true });
  assert.equal(out.status, 409); assert.match(out.body.error, /locked into this squad/);
  assert.equal((await post('squad', { zwid: ID(0), remove: true, force: true })).status, 200);
  app.world.db = {};
  const near = await setup(10, 3);
  const late = await post('squad', { zwid: ID(6) });
  assert.equal(late.status, 409); assert.match(late.body.error, /locked: stage 1 starts within 24 hours/);
  assert.equal((await post('squad', { zwid: ID(6), force: true })).status, 200);
  void near;
});

test('five days out the squad is asked; two days out the audit lists answers and buffer and picks the scoring four; later the result is chased, each once', async () => {
  const st = await setup(100);
  const ran = await tick();
  assert.ok(ran.includes('drs-avail'), JSON.stringify(ran));
  assert.match(publicPosts().join('\n'), /can you race\?/);
  assert.ok(!ran.includes('drs-audit'));
  // 40 hours out: the audit and the automatic four
  app.world.discord.length = 0;
  const raw = JSON.parse(app.world.db['cg:drs:stages'][st.id]);
  const start = Date.now() + 40 * 3600000;
  app.world.db['cg:drs:stages'][st.id] = JSON.stringify({ ...raw, date: ymd(start), time: new Date(start).toISOString().slice(11, 16) });
  await post('availability', { stage: st.id, zwid: ID(5), status: 'no' });
  const ran2 = await tick();
  assert.ok(ran2.includes('drs-audit'));
  const audit = adminPosts().find(t => /audit/.test(t));
  assert.match(audit, /1 no · 0 maybe|0 yes · 0 maybe · 1 no/);
  assert.match(audit, /Scoring four picked automatically/);
  assert.match(audit, /Dirt 4 1530 \(5 to the cap\)/);
  const roles = (await get()).body.stages[0].roles;
  assert.equal(Object.values(roles).filter(r => r === 'scorer').length, 4);
  assert.ok(!(await tick()).includes('drs-audit'), 'once');
  // the race has been run and nobody entered the result
  const past = Date.now() - 4 * 3600000;
  app.world.db['cg:drs:stages'][st.id] = JSON.stringify({ ...raw, date: ymd(past), time: new Date(past).toISOString().slice(11, 16) });
  app.world.discord.length = 0;
  assert.ok((await tick()).includes('drs-result-due'));
  assert.match(adminPosts().join('\n'), /has been run. Enter how the squad finished/);
  assert.ok(!(await tick()).includes('drs-result-due'));
});

test('switching automatic roles off keeps the four for the staff; the season edit keeps that choice', async () => {
  const st = await setup(100);
  assert.equal((await post('auto', { on: false })).body.season.autoRoles, false);
  await post('season', { ...SEASON, time: '12:00' });
  assert.equal((await get()).body.season.autoRoles, false);
  const raw = JSON.parse(app.world.db['cg:drs:stages'][st.id]);
  const start = Date.now() + 40 * 3600000;
  app.world.db['cg:drs:stages'][st.id] = JSON.stringify({ ...raw, date: ymd(start), time: new Date(start).toISOString().slice(11, 16) });
  await tick();
  assert.deepEqual((await get()).body.stages[0].roles, {}, 'no roles set');
  assert.ok(adminPosts().some(t => /audit/.test(t) && !/picked automatically/.test(t)));
});

test('a scoring rider who says no is replaced in the four at once, the newcomer is told, and the plan is logged', async () => {
  const st = await setup(100);
  const roles = (await post('roles', { stage: st.id, auto: true })).body.stages[0].roles;
  const scorer = Object.keys(roles).find(z => roles[z] === 'scorer'), support = Object.keys(roles).filter(z => roles[z] === 'support');
  app.world.discord.length = 0;
  const after = (await post('availability', { stage: st.id, zwid: scorer, status: 'no' })).body.stages[0].roles;
  assert.equal(after[scorer], 'support');
  assert.equal(Object.values(after).filter(r => r === 'scorer').length, 4);
  assert.ok(support.some(z => after[z] === 'scorer'), 'a support rider comes in');
  assert.match(adminPosts().join('\n'), /can't race, so the scoring four were picked again/);
  const log = (await app.get('/api/auto', { token: admin })).body.entries;
  assert.ok(log.some(e => /scoring four picked again/.test(e.summary)));
});

test('My week offers the Ladder and DIRT answers inline', async () => {
  const st = await setup(60);
  const rider = await app.memberSession(ID(2), { name: 'Dirt 2' });
  const w = (await app.get('/api/me/week', { token: rider })).body.items.find(i => i.kind === 'DIRT Series');
  assert.deepEqual([w.state, w.avail.series, w.avail.id, w.avail.mine], ['todo', 'drs', st.id, '']);
  await post('availability', { stage: st.id, status: 'yes' }, rider);
  const w2 = (await app.get('/api/me/week', { token: rider })).body.items.find(i => i.kind === 'DIRT Series');
  assert.deepEqual([w2.state, w2.avail.mine], ['in', 'yes']);
});
