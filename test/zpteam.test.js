'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');

h.setEnv({ HOSTINGER_MAIL_TOKEN: 'mail-token', HOSTINGER_MAIL_MAILBOX_ID: 'mbx_1' });
let app, world, owner;
before(async () => {
  world = h.createWorld();
  // Ann has a Zwift ID but is not in the ZwiftPower team roster (the five fixture riders are 1000-1004).
  world.members.push({ id: 9, zwift_id: '2000', name: 'Ann Lee', status: 'active', tier: 'full', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0' });
  world.members.push({ id: 10, zwift_id: '2001', name: 'Gone Rider', status: 'left', tier: 'full', offboard_discord: '0', offboard_fb: '0', offboard_zp: '0' });
  world.wpUsers = [{ id: 1, name: 'Ann Lee', email: 'ann@example.com' }];
  app = await h.startApp(world); owner = await app.login('owner');
  assert.equal((await app.post('/api/mail/settings', { enabled: true, perHour: 50, perDay: 500 }, { token: owner })).status, 200);
});
after(() => app.close());

test('staff see active members who are not on the ZwiftPower team, with their profile link; riders and the public cannot', async () => {
  assert.equal((await app.get('/api/zpteam')).status, 401);
  assert.equal((await app.get('/api/zpteam', { token: await app.memberSession('1002') })).status, 401);
  const r = await app.get('/api/zpteam', { token: await app.login('mod') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.missing.map(m => m.zwid), ['2000'], 'members on the team, members who left and placeholder IDs are not listed');
  assert.equal(r.body.missing[0].profile, 'https://zwiftpower.com/profile.php?z=2000');
  assert.match(r.body.teamUrl, /zwiftpower\.com\/team\.php\?id=2740/);
});

test('a nudge emails the rider the join link, is recorded, and cannot be repeated within 14 days', async () => {
  world.mails = [];
  const r = await app.post('/api/zpteam/nudge', { zwids: ['2000', '1000'], via: ['email'] }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ann = r.body.results.find(x => x.zwid === '2000'), rick = r.body.results.find(x => x.zwid === '1000');
  assert.equal(ann.ok, true, JSON.stringify(ann)); assert.deepEqual(ann.sent, ['email']);
  assert.equal(rick.ok, false, 'already on the team: nobody is nudged by mistake');
  assert.equal(world.mails.length, 1); assert.match(JSON.stringify(world.mails[0]), /zwiftpower\.com\/team\.php\?id=2740/);
  const list = await app.get('/api/zpteam', { token: owner });
  assert.equal(list.body.missing[0].canNudge, false); assert.equal(list.body.missing[0].nudges, 1);
  const again = await app.post('/api/zpteam/nudge', { zwids: ['2000'], via: ['email'] }, { token: owner });
  assert.equal(again.body.results[0].ok, false); assert.match(again.body.results[0].error, /wait 14 days/);
  assert.equal(world.mails.length, 1, 'no second email');
});

test('bad requests are refused plainly', async () => {
  assert.equal((await app.post('/api/zpteam/nudge', { zwids: [] }, { token: owner })).status, 400);
  assert.equal((await app.post('/api/zpteam/nudge', { zwids: ['2000'], via: ['fax'] }, { token: owner })).status, 400);
  assert.equal((await app.post('/api/zpteam/nudge', { zwids: Array.from({ length: 51 }, (_, i) => String(3000 + i)) }, { token: owner })).status, 400);
});
