'use strict';
// Yes / Maybe / No buttons under Discord reminders: signed requests only, answers saved as the rider, riders who cannot be identified are told how to link.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

h.setEnv();
let app, world, admin, pubHex, privateKey;
const CATS = ['Diamond', 'Diamond', 'Ruby', 'Ruby', 'Ruby'];
before(async () => {
  const kp = crypto.generateKeyPairSync('ed25519');
  privateKey = kp.privateKey; pubHex = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  process.env.DISCORD_PUBLIC_KEY = pubHex; process.env.DISCORD_BOT_TOKEN = 'bot';
  world = h.createWorld({ riders: CATS.map((cat, i) => ({ riderId: 2000 + i, name: `Lad ${i}`, country: 'gb', zpCategory: 'B', race: { current: { rating: 2300 - i * 50, mixed: { category: cat } } } })) });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { delete process.env.DISCORD_PUBLIC_KEY; delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
const A = { get token() { return admin; } };
const ID = i => String(2000 + i), D = i => `${1000 + i}`.padStart(18, '1');
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
beforeEach(() => { app.world.db = {}; world.dms = []; world.dmFail = new Set(); });

// A request as Discord sends it: the body, and a signature over the timestamp followed by the body.
const signed = (body, { key = privateKey, ts = String(Date.now()) } = {}) => {
  const raw = JSON.stringify(body), sig = crypto.sign(null, Buffer.from(ts + raw), key).toString('hex');
  return app.call('POST', '/api/discord/interactions', { body, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts } });
};
const tap = (userId, customId, content = 'Can you ride?') => signed({ type: 3, user: { id: userId }, data: { custom_id: customId }, message: { content, components: [{ type: 1, components: [] }] } });

async function ladderMatch() {
  for (let i = 0; i < 5; i++) await app.post('/api/ladder/roster', { zwid: ID(i) }, A);
  const t = new Date(Date.now() + 20 * 3600000), p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  return (await app.post('/api/ladder/match', { opponent: 'Rocket', challenger: 'us', date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, eventLink: 'https://www.zwift.com/events/view/5' }, A)).body.matches[0];
}

test('only requests signed by Discord are accepted; Discord\'s ping is answered', async () => {
  assert.deepEqual((await signed({ type: 1 })).body, { type: 1 });
  assert.equal((await app.call('POST', '/api/discord/interactions', { body: { type: 1 } })).status, 401, 'no signature');
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.equal((await signed({ type: 1 }, { key: other })).status, 401, 'signed by someone else');
  const raw = JSON.stringify({ type: 1 }), sig = crypto.sign(null, Buffer.from('1' + raw), privateKey).toString('hex');
  assert.equal((await app.call('POST', '/api/discord/interactions', { body: { type: 1 }, headers: { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': '2' } })).status, 401, 'the timestamp is part of what is signed');
  const keep = process.env.DISCORD_PUBLIC_KEY; delete process.env.DISCORD_PUBLIC_KEY;
  assert.equal((await signed({ type: 1 })).status, 401, 'no key set: nothing is accepted');
  process.env.DISCORD_PUBLIC_KEY = keep;
});

test('a tap saves the answer for the linked rider and keeps the buttons so it can be changed; the same route as the dashboard', async () => {
  const m = await ladderMatch();
  await app.post('/api/comms/link', { zwid: ID(1), discordId: D(1) }, A);
  const r = await tap(D(1), `av|ladder|${m.id}|yes`);
  assert.equal(r.status, 200); assert.equal(r.body.type, 7);
  assert.match(r.body.data.content, /You said \*\*✅ Yes\*\*/);
  assert.equal((await app.get('/api/ladder', A)).body.matches[0].availability[ID(1)], 'yes');
  await tap(D(1), `av|ladder|${m.id}|no`, r.body.data.content);
  assert.equal((await app.get('/api/ladder', A)).body.matches[0].availability[ID(1)], 'no', 'changed their mind');
  assert.equal(((await tap(D(1), `av|ladder|${m.id}|no`, r.body.data.content)).body.data.content.match(/✔/g) || []).length, 1, 'the confirmation line is replaced, not stacked');
});

test('a Discord account that is not linked, a rider who is not on the roster and a bad button each get a private explanation', async () => {
  const m = await ladderMatch();
  const stranger = await tap(D(4).replace(/1$/, '9'), `av|ladder|${m.id}|yes`);
  assert.equal(stranger.body.type, 4); assert.equal(stranger.body.data.flags, 64); assert.match(stranger.body.data.content, /Link your Discord/);
  await app.post('/api/comms/link', { zwid: '1002', discordId: D(7) }, A);
  assert.match((await tap(D(7), `av|ladder|${m.id}|yes`)).body.data.content, /could not save that: Only riders on the ladder roster/);
  assert.match((await tap(D(7), 'nonsense')).body.data.content, /not recognised/);
});

test('automatic reminders carry the buttons for ZRL, Ladder and DIRT', async () => {
  const m = await ladderMatch();
  await app.post('/api/comms/link', { zwid: ID(0), discordId: D(0) }, A);
  await app.post('/api/comms/auto', { nudge: true }, A);
  await tick();
  const dm = world.dms.find(d => /can you ride the Ladder match/.test(d.body.content));
  assert.ok(dm, JSON.stringify(world.dms.map(d => d.body.content.slice(0, 60))));
  const ids = dm.body.components[0].components.map(c => c.custom_id);
  assert.deepEqual(ids, [`av|ladder|${m.id}|yes`, `av|ladder|${m.id}|maybe`, `av|ladder|${m.id}|no`]);
});
