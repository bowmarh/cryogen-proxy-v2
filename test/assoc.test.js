'use strict';
// Associate members: signed in through cryogen.team but not yet full members. They get a limited view (TTT and ZRL sign-up, other race
// sign-ups, social-ride RSVPs) and a route to full membership: a checklist, a request, and approval by staff.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => app.close());

const A = () => ({ token: admin });
const nora = () => app.memberSession('5551', { name: 'Newbie Nora', associate: true });
const post = (path, body, token = admin) => app.post(path, body, { token });
const status = token => app.get('/api/assoc/status', { token }).then(r => r.body);
const adminPosts = () => app.world.discord.filter(p => p.channel === 'admin').map(p => p.body.content);
const DAY = 86400000;
const freshRoster = () => { delete app.world.db['cg:roster:riders']; return nora(); };   // the roster is cached in Redis and in memory; signing in as an associate drops both

beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; app.world.patches.length = 0; world.members = world.members.filter(m => !m.testRecord && !m.zwift_id.startsWith('55')); });

test('who is an associate: not in the roster and no record, a tier or pending record, or a staff mark; staff approval wins', async () => {
  const meOf = async t => (await app.get('/api/me', { token: t })).body;
  assert.equal((await meOf(await nora())).associate, true, 'not in the club roster, no member record');
  assert.equal((await meOf(await app.memberSession('1002', { name: 'Rider Two' }))).associate, false, 'a full member');
  world.members.push({ id: 51, zwift_id: '5552', name: 'Tier Tina', status: 'active', tier: 'associate' });
  world.members.push({ id: 52, zwift_id: '5553', name: 'Pending Pete', status: 'pending', tier: 'full' });
  world.members.push({ id: 53, zwift_id: '5554', name: 'Full Fred', status: 'active', tier: 'full' });
  for (const [z, n, want] of [['5552', 'Tier Tina', true], ['5553', 'Pending Pete', true], ['5554', 'Full Fred', false]]) {
    assert.equal((await meOf(await app.memberSession(z, { name: n, associate: true }))).associate, want, n);
  }
  // staff mark a rider who would otherwise be a member
  assert.equal((await post('/api/assoc/mark', { zwid: '1002', name: 'Rider Two' })).status, 200);
  assert.equal((await meOf(await app.memberSession('1002', { name: 'Rider Two' }))).associate, true, 'marked');
  assert.equal((await post('/api/assoc/approve', { zwid: '1002' })).status, 200);
  assert.equal((await meOf(await app.memberSession('1002', { name: 'Rider Two' }))).associate, false, 'approval wins and removes the mark');
});

test('an associate who later joins the club roster stays an associate until staff approve them', async () => {
  await nora();
  world.riders.push({ riderId: 5551, name: 'Newbie Nora', country: 'gb', zpCategory: 'D', race: {} });
  const t = await app.memberSession('5551', { name: 'Newbie Nora', associate: true });
  assert.equal((await app.get('/api/me', { token: t })).body.associate, true);
  world.riders.pop();
});

test('an associate can sign up for the TTT, ZRL and other races and RSVP to social rides, and nothing else', async () => {
  const t = await nora();
  await post('/api/ttt/new-week', { date: h.ymd(10) });
  await post('/api/zrl/round', { name: 'Round 2', start: h.ymd(20), closes: h.ymd(10), weeks: 2 });
  await post('/api/rides', { title: 'Sunday spin', date: h.ymd(3) });
  const rideId = Object.keys(app.world.db['cg:rides'])[0];
  const ok = async (method, path, body) => (await app.call(method, path, { token: t, body: method === 'GET' ? undefined : body })).status;
  assert.equal(await ok('POST', '/api/ttt/signup', { cat: 'D', available: true }), 200);
  assert.equal(await ok('GET', '/api/ttt/mine'), 200);
  assert.equal(await ok('POST', '/api/zrl/signup', { regions: ['eu'], cat: 'D' }), 200);
  assert.equal(await ok('GET', '/api/zrl/mine'), 200);
  assert.equal(await ok('POST', '/api/rsvps', { rideId }), 200);
  assert.equal(await ok('GET', '/api/roster'), 200);
  assert.equal(await ok('GET', '/api/state'), 200);
  for (const [m, p] of [['GET', '/api/cover'], ['GET', '/api/ladder'], ['GET', '/api/drs'], ['GET', '/api/me/season'], ['POST', '/api/cover/volunteer'], ['POST', '/api/zrl/captain'], ['POST', '/api/ttt/assign'], ['POST', '/api/ladder/availability']]) {
    const r = await app.call(m, p, { token: t, body: m === 'GET' ? undefined : {} });
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.associate, true);
    assert.match(r.body.error, /for full members/);
  }
  // a full member is not held back
  assert.notEqual((await app.call('GET', '/api/cover', { token: await app.memberSession('1002', { name: 'Rider Two' }) })).status, 403);
});

test('the checklist counts clubs, Discord, rides, team events and days; the request waits until it is complete', async () => {
  let t = await nora();
  let s = await status(t);
  assert.equal(s.associate, true);
  assert.deepEqual(s.items.map(i => [i.id, i.done]), [['club', false], ['discord', false], ['rides', false], ['team', false], ['time', false]]);
  assert.equal((await post('/api/assoc/request', {}, t)).status, 409, 'not yet');
  // do the things
  assert.equal((await post('/api/assoc/discord', { joined: true }, t)).status, 200);
  await post('/api/ttt/new-week', { date: h.ymd(10) });
  await post('/api/ttt/signup', { cat: 'D', available: true }, t);
  for (const d of [1, 2, 3]) { await post('/api/rides', { title: `Ride ${d}`, date: h.ymd(d) }); }
  for (const id of Object.keys(app.world.db['cg:rides'])) await post('/api/rsvps', { rideId: id }, t);
  world.riders.push({ riderId: 5551, name: 'Newbie Nora', country: 'gb', zpCategory: 'D', race: {} });   // joined the Zwift club
  t = await freshRoster();
  const first = JSON.parse(app.world.db['cg:assoc:first']['5551']); first.at = new Date(Date.now() - 20 * DAY).toISOString();
  app.world.db['cg:assoc:first']['5551'] = JSON.stringify(first);
  s = await status(t);
  assert.deepEqual(s.items.map(i => i.done), [true, true, true, true, true]);
  assert.equal(s.complete, true);
  app.world.discord.length = 0;
  const r = await post('/api/assoc/request', {}, t);
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'pending');
  assert.ok(adminPosts().some(x => /Newbie Nora/.test(x) && /asked to become a full member/.test(x)), 'staff are told');
  assert.equal((await post('/api/assoc/request', {}, t)).status, 409, 'once is enough');
  world.riders.pop();
  await freshRoster();
  assert.equal((await post('/api/assoc/discord', { joined: true }, await app.memberSession('1002', { name: 'Rider Two' }))).status, 403, 'a full member has no checklist');
});

test('staff see the pipeline, approve (which unlocks the rider at once) or decline with a note', async () => {
  const t = await nora();
  await status(t);   // first seen
  assert.equal((await app.get('/api/assoc/list', { token: t })).status, 403, 'associates cannot see the pipeline');
  assert.equal((await app.get('/api/assoc/list', { token: null })).status, 401);
  let list = (await app.get('/api/assoc/list', A())).body;
  assert.equal(list.rows.length, 1);
  assert.deepEqual([list.rows[0].name, list.rows[0].done, list.rows[0].total, list.rows[0].request], ['Newbie Nora', 0, 5, null]);
  assert.equal((await post('/api/assoc/decline', { zwid: '5551' })).status, 404, 'no request to decline');
  // she has no record yet; approving works for staff and for a moderator
  assert.equal((await app.call('GET', '/api/cover', { token: t })).status, 403);
  app.world.discord.length = 0;
  const ap = await post('/api/assoc/approve', { zwid: '5551' }, mod);
  assert.equal(ap.status, 200);
  assert.equal(ap.body.wordpress, 'no-record', 'there was no WordPress record to update');
  assert.ok(app.world.discord.some(p => p.channel === 'public' && /Welcome Newbie Nora as a full member/.test(p.body.content)));
  assert.notEqual((await app.call('GET', '/api/cover', { token: t })).status, 403, 'unlocked mid-session');
  assert.equal((await status(t)).associate, false);
  assert.equal((await app.get('/api/assoc/list', A())).body.rows.length, 0, 'no longer in the pipeline');
  assert.equal((await app.get('/api/me', { token: await app.memberSession('5551', { name: 'Newbie Nora', associate: true }) })).body.associate, false, 'and stays full at the next sign-in');
});

test('approving also sets the tier to full in WordPress when the rider has a record', async () => {
  world.members.push({ id: 61, zwift_id: '5561', name: 'Record Rhea', status: 'active', tier: 'associate', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0' });
  const t = await app.memberSession('5561', { name: 'Record Rhea' });
  assert.equal((await app.get('/api/me', { token: t })).body.associate, true);
  const ap = await post('/api/assoc/approve', { zwid: '5561' });
  assert.equal(ap.body.wordpress, 'saved');
  assert.deepEqual(app.world.patches.map(p => [p.id, p.body]), [['61', { tier: 'full' }]]);
});

test('a declined request keeps the note, and the weekly digest nudges staff about waiting and ready associates', async () => {
  const t = await nora();
  await status(t);
  app.world.db['cg:assoc:requests'] = { 5551: JSON.stringify({ zwid: '5551', name: 'Newbie Nora', at: new Date(Date.now() - 5 * DAY).toISOString(), status: 'pending' }) };
  app.world.discord.length = 0;
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  const d = adminPosts().filter(x => /Associate members/.test(x));
  assert.equal(d.length, 1);
  assert.match(d[0], /1 request waiting more than three days: Newbie Nora/);
  app.world.discord.length = 0;
  await app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
  assert.deepEqual(adminPosts().filter(x => /Associate members/.test(x)), [], 'once a week');
  const row = async () => (await app.get('/api/health', { token: await app.login('admin') })).body.checks.find(c => c.id === 'assoc');
  assert.equal((await row()).status, 'warn');
  assert.equal((await post('/api/assoc/decline', { zwid: '5551', note: 'Come back after two more rides' })).status, 200);
  assert.equal(JSON.parse(app.world.db['cg:assoc:requests']['5551']).note, 'Come back after two more rides');
  assert.equal((await status(t)).request.status, 'declined');
  assert.equal((await row()).status, 'ok');
});

test('half and associate are one membership: a record still saying half is an associate, in the roster, /api/me and the gate', async () => {
  world.members.push({ id: 62, zwift_id: '5562', name: 'Half Hana', status: 'active', tier: 'half', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0' });
  const t = await app.memberSession('5562', { name: 'Half Hana' });
  const me = (await app.get('/api/me', { token: t })).body;
  assert.equal(me.associate, true);
  assert.equal(me.tier, 'associate', 'shown as associate, never half');
  assert.equal((await app.call('GET', '/api/cover', { token: t })).status, 403, 'limited like any associate');
  const roster = (await app.get('/api/roster', { token: admin })).body.members.find(m => m.zwift_id === '5562');
  assert.equal(roster.tier, 'associate');
  // staff choosing the old "half" value saves associate
  const r = await app.post('/api/members/5562', { tier: 'half' }, { token: admin });
  assert.equal(r.status, 200);
  assert.deepEqual(app.world.patches.map(p => p.body), [{ tier: 'associate' }]);
});
