'use strict';
// Message kinds a rider can switch off, "Sign in with Discord", and the optional automatic reminder.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv();
let app, world, admin, mod;
before(async () => { world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left'); app = await h.startApp(world); admin = await app.login('admin'); mod = await app.login('mod'); });
after(() => { for (const k of ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']) delete process.env[k]; return app.close(); });
beforeEach(() => { app.world.db = {}; app.world.discord.length = 0; world.dms = []; world.dmFail = new Set(); world.oauthUser = null; world.oauthFail = false; world.oauthCalls = []; for (const k of ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']) delete process.env[k]; });

const D1 = '123456789012345678', D2 = '223456789012345678';
const rider = () => app.memberSession('1002', { name: 'Rider Two' });
const mePost = (path, body, t) => app.post(`/api/me/discord${path}`, body, { token: t });
const send = (body, token = admin) => app.post('/api/comms/send', body, { token });
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
const linkStaff = (zwid, id) => app.post('/api/comms/link', { zwid, discordId: id }, { token: admin });

test('a rider picks which kinds of message they get; staff sends respect it, by kind', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot';
  await linkStaff('1002', D1);
  const t = await rider();
  const r = await mePost('/prefs', { kinds: { race: false } }, t);
  assert.deepEqual(r.body.prefs, { race: false, rides: true, club: true });
  const race = await send({ audience: 'members', zwids: ['1002'], message: 'Race note', kind: 'race' });
  assert.match(race.body.results[0].error, /Turned off race reminders/);
  assert.equal((await send({ audience: 'members', zwids: ['1002'], message: 'News', kind: 'club' })).body.sent, 1, 'club news still arrives');
  assert.equal((await send({ audience: 'members', zwids: ['1002'], message: 'Free text' })).body.sent, 1, 'a message with no kind is club news');
  const staffView = (await app.get('/api/comms', { token: admin })).body.links['1002'];
  assert.deepEqual(staffView.off, ['race']);
  assert.equal((await mePost('/prefs', { kinds: { race: true } }, t)).body.prefs.race, true);
  assert.equal((await send({ audience: 'members', zwids: ['1002'], message: 'Race note', kind: 'race' })).body.sent, 1);
});

test('Sign in with Discord: off until the club sets it up, then it links a verified account', async () => {
  const t = await rider();
  assert.equal((await app.get('/api/me/discord/start', { token: t })).status, 409);
  process.env.DISCORD_CLIENT_ID = '999'; process.env.DISCORD_CLIENT_SECRET = 'shh';
  assert.equal((await app.get('/api/me/discord', { token: t })).body.oauth, true);
  const start = (await app.get('/api/me/discord/start', { token: t })).body.url;
  const u = new URL(start);
  assert.equal(u.host, 'discord.com');
  assert.deepEqual([u.searchParams.get('client_id'), u.searchParams.get('scope'), u.searchParams.get('response_type')], ['999', 'identify', 'code']);
  assert.match(u.searchParams.get('redirect_uri'), /\/api\/discord\/callback$/);
  const state = u.searchParams.get('state');
  world.oauthUser = { id: D1, username: 'ricky', global_name: 'Ricky B' };
  const back = await app.call('GET', `/api/discord/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(back.status, 302);
  assert.equal(back.location, '/#discord=linked');
  assert.match(world.oauthCalls[0], /code=abc/);
  const me = (await app.get('/api/me/discord', { token: t })).body;
  assert.deepEqual([me.id, me.verified, me.tag, me.dm], [D1, true, 'Ricky B', true]);
  // the link works only once
  const again = await app.call('GET', `/api/discord/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(again.location, '/#discord=expired');
});

test('Sign in with Discord refuses a made-up state, a refusal, and a failed exchange', async () => {
  process.env.DISCORD_CLIENT_ID = '999'; process.env.DISCORD_CLIENT_SECRET = 'shh';
  assert.equal((await app.call('GET', '/api/discord/callback?code=abc&state=forged.token')).location, '/#discord=expired');
  const t = await rider();
  const state = new URL((await app.get('/api/me/discord/start', { token: t })).body.url).searchParams.get('state');
  assert.equal((await app.call('GET', `/api/discord/callback?error=access_denied&state=${encodeURIComponent(state)}`)).location, '/#discord=denied');
  world.oauthFail = true; world.oauthUser = { id: D1, username: 'x' };
  const state2 = new URL((await app.get('/api/me/discord/start', { token: t })).body.url).searchParams.get('state');
  assert.equal((await app.call('GET', `/api/discord/callback?code=bad&state=${encodeURIComponent(state2)}`)).location, '/#discord=failed');
  assert.equal((await app.get('/api/me/discord', { token: t })).body.linked, false);
  // a staff token is not a state
  assert.equal((await app.call('GET', `/api/discord/callback?code=abc&state=${encodeURIComponent(admin)}`)).location, '/#discord=expired');
});

test('the automatic reminder is off by default, administrators only, and needs the bot', async () => {
  assert.equal((await app.get('/api/comms', { token: admin })).body.auto.nudge, false);
  assert.equal((await app.post('/api/comms/auto', { nudge: true }, { token: mod })).status, 403, 'a moderator cannot change it');
  assert.equal((await app.post('/api/comms/auto', { nudge: true }, { token: admin })).status, 409, 'no bot yet');
  process.env.DISCORD_BOT_TOKEN = 'bot';
  assert.equal((await app.post('/api/comms/auto', { nudge: true }, { token: admin })).status, 200);
  assert.deepEqual((await app.get('/api/comms', { token: mod })).body.auto, { nudge: true, canChange: false });
});

test('with it on, a rider who has not answered a race starting tomorrow gets one DM, once, and opt-outs are respected', async () => {
  process.env.DISCORD_BOT_TOKEN = 'bot';
  const post = (path, body) => app.post(path, body, { token: admin });
  // a race about 20 hours away: the slot is that weekday and hour in UTC
  const start = new Date(Date.now() + 20 * 3600000), day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][start.getUTCDay()], hhmm = `${String(start.getUTCHours()).padStart(2, '0')}:${String(start.getUTCMinutes()).padStart(2, '0')}`;
  await post('/api/zrl/round', { name: 'Round 2', start: start.toISOString().slice(0, 10), closes: h.ymd(10), weeks: 2 });
  await post('/api/zrl/teams', { teams: [{ name: 'CRYO-GEN Alpha', region: 'eu', slot: `${day} ${hhmm} UTC` }] });
  await post('/api/zrl/team-slot', { team: 'cryo-gen-alpha', slot: `${day} ${hhmm} UTC` });
  for (const [z, n] of [['1002', 'Rider Two'], ['1000', 'Rick DB']]) { await post('/api/zrl/signup-edit', { name: n, zwid: z, regions: ['eu'], cat: 'C' }); await post('/api/zrl/assign', { key: z, team: 'cryo-gen-alpha' }); await linkStaff(z, z === '1002' ? D1 : D2); }
  await post('/api/zrl/status', { published: true });
  await tick();
  assert.equal(world.dms.length, 0, 'off by default');
  await post('/api/comms/auto', { nudge: true });
  await app.post('/api/me/discord/prefs', { dm: false }, { token: await app.memberSession('1000', { name: 'Rick DB' }) });
  await tick();
  assert.deepEqual(world.dms.map(d => d.userId), [D1], 'only the rider who can be messaged');
  assert.match(world.dms[0].body.content, /^Hi Rider, can you race ZRL Round 2 race 1 for Alpha\?/);
  assert.match(world.dms[0].body.content, /automatic reminder/);
  await tick();
  assert.equal(world.dms.length, 1, 'once per rider per race');
  const log = (await app.get('/api/comms', { token: admin })).body.log[0];
  assert.deepEqual([log.by, log.count, log.ok], ['auto', 1, 1]);
  // answering stops it for the other team of a doubled-up rider only when they answered that team
  const health = (await app.get('/api/health', { token: admin })).body.checks.find(c => c.id === 'comms');
  assert.match(health.detail, /automatic reminders on/);
});
