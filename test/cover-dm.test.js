'use strict';
// Ride cover by direct message: three days out with no leader or sweeper, approved people are asked with a one-tap button; tapping it puts them down.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const h = require('./helpers');

h.setEnv();
let app, world, admin, privateKey, sid;
const D = z => `${z}`.padStart(18, '1');
before(async () => {
  const kp = crypto.generateKeyPairSync('ed25519'); privateKey = kp.privateKey;
  process.env.DISCORD_PUBLIC_KEY = kp.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'); process.env.DISCORD_BOT_TOKEN = 'bot';
  world = h.createWorld(); world.members = world.members.filter(m => m.status !== 'left');
  app = await h.startApp(world); admin = await app.login('admin');
});
after(() => { delete process.env.DISCORD_PUBLIC_KEY; delete process.env.DISCORD_BOT_TOKEN; return app.close(); });
const ukDow = days => new Date(Date.now() + days * 86400000).getUTCDay();
const tick = () => app.call('GET', '/api/cron/tick', { headers: { Authorization: 'Bearer cron-secret' } });
const tap = (user, customId) => {
  const body = { type: 3, user: { id: user }, data: { custom_id: customId }, message: { content: 'Can you cover?', components: [] } }, raw = JSON.stringify(body), ts = String(Date.now());
  return app.call('POST', '/api/discord/interactions', { body, headers: { 'X-Signature-Ed25519': crypto.sign(null, Buffer.from(ts + raw), privateKey).toString('hex'), 'X-Signature-Timestamp': ts } });
};
beforeEach(async () => {
  app.world.db = {}; world.dms = []; app.world.discord.length = 0;
  await app.post('/api/comms/auto', { nudge: true }, { token: admin });
  sid = (await app.post('/api/cover/series', { title: 'Tuesday Social Spin', dow: ukDow(2), time: '19:00', zone: 'Europe/London', pace: '2.0 w/kg', ownerName: 'Olive', ownerZwid: '2436518' }, { token: admin })).body.series[0].id;
  await app.post('/api/cover/approve', { zwid: '4378027', name: 'Ann Able', lead: true, sweep: true }, { token: admin });
  await app.post('/api/cover/approve', { zwid: '1002', name: 'Bob Baker', lead: true, sweep: false }, { token: admin });
  await app.post('/api/cover/approve', { zwid: '777', name: 'Cy Clark', lead: false, sweep: true }, { token: admin });
  for (const z of ['4378027', '1002', '777']) await app.post('/api/comms/link', { zwid: z, discordId: D(z) }, { token: admin });
});

test('approved leaders and sweepers are each asked once, with the right button, only for the role they can do', async () => {
  await tick();
  const to = z => world.dms.filter(d => d.userId === D(z));
  assert.equal(to('4378027').length, 2, 'Ann can do both: asked to lead and to sweep');
  assert.equal(to('1002').length, 1, 'Bob only leads'); assert.equal(to('777').length, 1, 'Cy only sweeps');
  const buttons = d => d.body.components[0].components[0].custom_id;
  assert.match(buttons(to('1002')[0]), new RegExp(`^rc\\|${sid.replace(/[|]/g, '\\|')}\\|\\d{4}-\\d{2}-\\d{2}\\|lead$`));
  assert.match(buttons(to('777')[0]), /\|sweep$/);
  const before = world.dms.length; await tick();
  assert.equal(world.dms.length, before, 'asking again on the next tick does nothing');
});

test('tapping the button puts the rider down, tells them, and stops asking others for that role', async () => {
  await tick();
  const dm = world.dms.find(d => d.userId === D('1002')), cid = dm.body.components[0].components[0].custom_id;
  const r = await tap(D('1002'), cid);
  assert.equal(r.status, 200); assert.equal(r.body.type, 7); assert.match(r.body.data.content, /Thank you: you're down as leader for Tuesday Social Spin/); assert.deepEqual(r.body.data.components, []);
  const v = (await app.get('/api/cover', { token: admin })).body, occ = v.series.find(s => s.id === sid).occurrences[0];
  assert.equal(occ.cover.leader.zwid, '1002');
  world.dms = []; app.world.db['cg:cover:sent'] = {}; await tick();
  assert.equal(world.dms.filter(d => /\|lead$/.test(d.body.components[0].components[0].custom_id)).length, 0, 'the leader place is filled, so nobody is asked to lead again');
});

test('someone who is not linked, or not approved, is told so privately', async () => {
  await tick();
  const cid = world.dms[0].body.components[0].components[0].custom_id;
  assert.match((await tap('999999999999999999', cid)).body.data.content, /Link your Discord/);
  await app.post('/api/cover/approve', { zwid: '1002', name: 'Bob Baker', lead: false, sweep: false }, { token: admin });
  assert.match((await tap(D('1002'), cid.replace(/\|(lead|sweep)$/, '|lead'))).body.data.content, /not approved you as a leader/);
});
