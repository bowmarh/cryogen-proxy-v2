'use strict';
// Discord slash commands: /week, /recap, /badges and /answer, only for a linked rider, only shown to them, and /answer saves through the same route as the dashboard.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

h.setEnv();
let app, world, admin, privateKey;
const ID = '2000', DISCORD = '111111111111111111';
before(async () => {
  const kp = crypto.generateKeyPairSync('ed25519'); privateKey = kp.privateKey;
  process.env.DISCORD_PUBLIC_KEY = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'); process.env.DISCORD_BOT_TOKEN = 'bot'; process.env.DISCORD_CLIENT_ID = '999';
  world = h.createWorld({ riders: [0, 1, 2, 3, 4].map(i => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { finishes: 12, wins: 1, podiums: 2, current: { rating: 2300 - i * 50, mixed: { category: 'Diamond' } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { for (const k of ['DISCORD_PUBLIC_KEY', 'DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID']) delete process.env[k]; return app.close(); });
beforeEach(() => { app.world.db = {}; world.slashCommands = null; world.commandsRefused = false; });

const command = (name, options, user = DISCORD) => {
  const body = { type: 2, member: { user: { id: user } }, data: { name, options } }, raw = JSON.stringify(body), ts = String(Date.now());
  return app.call('POST', '/api/discord/interactions', { body, headers: { 'X-Signature-Ed25519': crypto.sign(null, Buffer.from(ts + raw), privateKey).toString('hex'), 'X-Signature-Timestamp': ts } });
};
const link = () => app.post('/api/comms/link', { zwid: ID, discordId: DISCORD }, { token: admin });
const text = r => r.body.data.content;

test('every command answers privately, and someone who has not linked their Discord is told how', async () => {
  const r = await command('week');
  assert.equal(r.body.type, 4); assert.equal(r.body.data.flags, 64);
  assert.match(text(r), /Link your Discord in My Profile/);
  await link();
  for (const name of ['week', 'recap', 'badges']) { const x = await command(name); assert.equal(x.body.data.flags, 64, `${name} is only shown to the rider`); assert.ok(text(x).length > 5); }
  assert.match(text(await command('nonsense')), /do not know that command/);
});

test('/badges lists what the rider has earned and /recap their numbers', async () => {
  await link();
  const b = text(await command('badges')); assert.match(b, /Your badges \(\d+\)/); assert.match(b, /10 races/);
  assert.match(text(await command('recap')), /vELO 2300/);
});

test('/answer saves for the next request that is waiting, as the rider, and says so when nothing is waiting', async () => {
  await link();
  assert.match(text(await command('answer', [{ name: 'status', value: 'yes' }])), /Nothing is waiting for an answer/);
  assert.match(text(await command('answer', [{ name: 'status', value: 'perhaps' }])), /Choose yes, maybe or no/);
});

test('/answer saves a real waiting request through the same route as the dashboard, and /week shows it answered', async () => {
  for (let i = 0; i < 5; i++) await app.post('/api/ladder/roster', { zwid: String(2000 + i) }, { token: admin });
  const t = new Date(Date.now() + 20 * 3600000), p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  const m = (await app.post('/api/ladder/match', { opponent: 'Rocket', challenger: 'us', date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, eventLink: 'https://www.zwift.com/events/view/5' }, { token: admin })).body.matches[0];
  await app.post('/api/comms/link', { zwid: '2001', discordId: '222222222222222222' }, { token: admin });
  const r = await command('answer', [{ name: 'status', value: 'yes' }], '222222222222222222');
  assert.match(text(r), /You said \*\*✅ Yes\*\* for .*Rocket/);
  assert.equal((await app.get('/api/ladder', { token: admin })).body.matches.find(x => x.id === m.id).availability['2001'], 'yes');
  assert.match(text(await command('week', undefined, '222222222222222222')), /Rocket/);
});

test('an administrator registers the commands with Discord; riders and the signed-out cannot', async () => {
  assert.equal((await app.post('/api/discord/register-commands', {})).status, 401);
  assert.equal((await app.post('/api/discord/register-commands', {}, { token: await app.memberSession('1002') })).status, 401);
  const r = await app.post('/api/discord/register-commands', {}, { token: admin });
  assert.equal(r.status, 200); assert.equal(r.body.registered, 4);
  assert.deepEqual(world.slashCommands.map(c => c.name), ['week', 'recap', 'badges', 'answer']);
  assert.deepEqual(world.slashCommands[3].options[0].choices.map(c => c.value), ['yes', 'maybe', 'no']);
  world.commandsRefused = true;
  const bad = await app.post('/api/discord/register-commands', {}, { token: admin });
  assert.equal(bad.status, 502); assert.match(bad.body.error, /refused the commands/);
});
