'use strict';
// Web push: a signed, encrypted message to a rider's device when they have no Discord; checked by decrypting what is sent the way a browser would.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

h.setEnv();
let app, world, admin, keys;
before(async () => {
  world = h.createWorld({ riders: [{ riderId: 2000, name: 'Lad 0', country: 'gb', zpCategory: 'B', race: { current: { rating: 2000, mixed: { category: 'Ruby' } } } }] });
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT']) delete process.env[k]; return app.close(); });
const A = { get token() { return admin; } };
const b64 = b => Buffer.from(b).toString('base64url'), unb64 = s => Buffer.from(s, 'base64url');
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
beforeEach(() => { app.world.db = {}; world.pushes = []; world.pushStatus = {}; for (const k of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']) delete process.env[k]; });

// A browser: its own key pair and auth secret, and the decryption a browser does (RFC 8291).
function browser(path = '/send/abc') {
  const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const sub = { endpoint: `https://push.test${path}`, keys: { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) } };
  const decrypt = body => {
    const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), cipher = body.subarray(21 + idlen);
    const secret = ecdh.computeSecret(asPublic), ua = ecdh.getPublicKey();
    const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua, asPublic]), 32));
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)), nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(cipher.subarray(cipher.length - 16));
    const plain = Buffer.concat([d.update(cipher.subarray(0, cipher.length - 16)), d.final()]);
    return plain.subarray(0, plain.lastIndexOf(2)).toString();
  };
  return { sub, decrypt };
}
const setup = async () => {
  keys = (await app.post('/api/push/generate-keys', {}, A)).body;
  process.env.VAPID_PUBLIC_KEY = keys.publicKey; process.env.VAPID_PRIVATE_KEY = keys.privateKey; process.env.VAPID_SUBJECT = 'mailto:club@example.com';
};

test('only an administrator makes keys; without keys push is off; riders subscribe with a valid subscription and can remove it', async () => {
  assert.equal((await app.post('/api/push/generate-keys', {}, { token: await app.login('mod') })).status, 403);
  const rider = await app.memberSession('2000', { name: 'Lad 0' });
  assert.deepEqual((await app.get('/api/push/status', { token: rider })).body, { configured: false, publicKey: '', devices: 0 });
  assert.equal((await app.post('/api/push/subscribe', browser().sub, { token: rider })).status, 409);
  await setup();
  assert.equal(unb64(keys.publicKey).length, 65);
  assert.equal((await app.get('/api/push/status', { token: rider })).body.publicKey, keys.publicKey);
  assert.equal((await app.get('/api/push/status')).status, 401);
  assert.equal((await app.post('/api/push/subscribe', { endpoint: 'http://insecure', keys: {} }, { token: rider })).status, 400);
  const b = browser();
  assert.equal((await app.post('/api/push/subscribe', b.sub, { token: rider })).body.devices, 1);
  assert.equal((await app.post('/api/push/subscribe', b.sub, { token: rider })).body.devices, 1, 'the same device twice is one');
  assert.equal((await app.post('/api/push/unsubscribe', { endpoint: b.sub.endpoint }, { token: rider })).body.devices, 0);
});

test('an automatic message with no Discord goes to the device, encrypted so only that browser can read it, signed with the club\'s VAPID key', async () => {
  await setup();
  const rider = await app.memberSession('2000', { name: 'Lad 0' }), b = browser();
  await app.post('/api/push/subscribe', b.sub, { token: rider });
  assert.equal((await app.post('/api/comms/auto', { nudge: true }, A)).status, 200, 'automatic messages can be switched on with push alone');
  // an event the automatic tick messages about: a Ladder match a day away that the rider has not answered
  await app.post('/api/ladder/roster', { zwid: '2000' }, A);
  const t = new Date(Date.now() + 20 * 3600000), p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  await app.post('/api/ladder/match', { opponent: 'Rocket', challenger: 'us', date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, eventLink: 'https://www.zwift.com/events/view/5' }, A);
  await tick();
  assert.equal(world.pushes.length, 1);
  const got = world.pushes[0];
  assert.equal(got.headers['Content-Encoding'], 'aes128gcm');
  const msg = JSON.parse(b.decrypt(got.body));
  assert.equal(msg.title, 'CRYO-GEN: can you race?'); assert.match(msg.body, /can you ride the Ladder match/);
  assert.ok(!got.body.toString('latin1').includes('can you ride'), 'the text is not in the clear');
  // the VAPID header: a signature over the audience by the club's key
  const [, t64, k] = /^vapid t=([^,]+), k=(.+)$/.exec(got.headers.Authorization);
  assert.equal(k, keys.publicKey);
  const [h64, c64, s64] = t64.split('.'), claims = JSON.parse(unb64(c64).toString());
  assert.equal(claims.aud, 'https://push.test'); assert.equal(claims.sub, 'mailto:club@example.com'); assert.ok(claims.exp > Date.now() / 1000);
  const pubKey = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(unb64(k).subarray(1, 33)), y: b64(unb64(k).subarray(33, 65)) }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h64}.${c64}`), { key: pubKey, dsaEncoding: 'ieee-p1363' }, unb64(s64)), 'the signature checks out');
  await tick();
  assert.equal(world.pushes.length, 1, 'once per rider and match');
});

test('a device the push service says is gone is forgotten; a rider who opted out of messages gets none', async () => {
  await setup();
  const rider = await app.memberSession('2000', { name: 'Lad 0' }), b = browser('/gone');
  await app.post('/api/push/subscribe', b.sub, { token: rider });
  world.pushStatus['/gone'] = 410;
  await app.post('/api/comms/auto', { nudge: true }, A);
  await app.post('/api/ladder/roster', { zwid: '2000' }, A);
  const t = new Date(Date.now() + 20 * 3600000), p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map(x => [x.type, x.value]));
  await app.post('/api/ladder/match', { opponent: 'Rocket', challenger: 'us', date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, eventLink: 'https://www.zwift.com/events/view/5' }, A);
  await tick();
  assert.equal((await app.get('/api/push/status', { token: rider })).body.devices, 0, 'the gone device was dropped');
  // opting out: a saved link with messages off blocks push too
  await app.post('/api/push/subscribe', browser('/ok').sub, { token: rider });
  await app.post('/api/comms/link', { zwid: '2000', discordId: '123456789012345678' }, A);
  await app.post('/api/me/discord/prefs', { dm: false }, { token: rider });
  world.pushes = [];
  await tick();
  assert.equal(world.pushes.length, 0);
});
