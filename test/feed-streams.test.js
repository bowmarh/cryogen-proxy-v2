'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createFeed = require('../lib/feed');
const createStreams = require('../lib/streams');

class HttpError extends Error { constructor(s, m) { super(m); this.status = s; } }
function fakeRedis() {
  const lists = {}, hashes = {};
  return async cmds => cmds.map(([c, k, ...a]) => {
    if (c === 'LPUSH') { (lists[k] = lists[k] || []).unshift(a[0]); return lists[k].length; }
    if (c === 'LTRIM') { lists[k] = (lists[k] || []).slice(a[0], a[1] + 1); return 'OK'; }
    if (c === 'LRANGE') return (lists[k] || []).slice(a[0], a[1] + 1);
    if (c === 'HSET') { (hashes[k] = hashes[k] || {})[a[0]] = a[1]; return 1; }
    if (c === 'HDEL') { delete (hashes[k] || {})[a[0]]; return 1; }
    if (c === 'HGETALL') return Object.entries(hashes[k] || {}).flat();
    return null;
  });
}
const asRole = role => ({ role }), roleOf = r => r.role || null, memberOf = r => r.member || null;
const requireRole = (req, roles) => { if (!roles.includes(req.role)) throw new HttpError(403, 'no'); };

test('the bell keeps public Discord posts as plain text, never admin ones, and merges a repeat', async () => {
  const f = createFeed({ redis: fakeRedis(), HttpError, requireRole, memberFromRequest: memberOf, roleFromRequest: roleOf });
  assert.equal(await f.add('zrl-admin', { content: 'secret admin note' }), false);
  assert.equal(await f.add('zrl-public', { content: '📣 **ZRL Round 1: the rosters are out!**\nTeams: A, B' }), true);
  assert.equal(await f.add('zrl-public', { content: '📣 **ZRL Round 1: the rosters are out!**\nmore' }), false, 'the same line twice in a row is one item');
  const r = await f.routes['GET /api/feed']({ role: 'admin' });
  assert.equal(r.items.length, 1); assert.equal(r.items[0].text, '📣 ZRL Round 1: the rosters are out!'); assert.equal(r.items[0].kind, 'ZRL'); assert.equal(r.items[0].tab, 'zrl');
  assert.equal(r.canPost, true);
});

test('mentions are removed from bell text; staff can post a line; riders cannot; signed-out people see nothing', async () => {
  const f = createFeed({ redis: fakeRedis(), HttpError, requireRole, memberFromRequest: memberOf, roleFromRequest: roleOf });
  await f.add('public', { content: '@everyone <@123> ride at 7 <#555>' });
  assert.equal((await f.routes['GET /api/feed']({ member: { zwid: '1' } })).items[0].text, 'ride at 7');
  await assert.rejects(f.routes['POST /api/feed']({ member: { zwid: '1' } }, { text: 'hi' }), { status: 403 });
  await f.routes['POST /api/feed']({ role: 'mod' }, { text: 'Roster for race 2 is up' });
  assert.equal((await f.routes['GET /api/feed']({ role: 'mod' })).items[0].kind, 'News');
  await assert.rejects(f.routes['GET /api/feed']({}), { status: 401 });
});

test('streams: a rider adds a link on a known platform; others are refused; the list is grouped by team and removal works', async () => {
  const s = createStreams({ redis: fakeRedis(), HttpError, memberFromRequest: memberOf, roleFromRequest: roleOf, teamsOf: async () => ({ 1002: ['Team Alpha'] }) });
  const me = { member: { zwid: 1002, name: 'Rider Two' } };
  await assert.rejects(s.routes['POST /api/me/stream'](me, { url: 'https://evil.example.com/x' }), { status: 400 });
  await assert.rejects(s.routes['POST /api/me/stream'](me, { url: 'http://twitch.tv/x' }), { status: 400 });
  await assert.rejects(s.routes['POST /api/me/stream'](me, { url: 'https://user:pw@twitch.tv/x' }), { status: 400 });
  assert.equal((await s.routes['POST /api/me/stream'](me, { url: 'twitch.tv/ridertwo' })).platform, 'Twitch');
  const l = await s.routes['GET /api/streams'](me);
  assert.equal(l.streams.length, 1); assert.deepEqual(l.streams[0].teams, ['Team Alpha']); assert.equal(l.streams[0].url, 'https://twitch.tv/ridertwo'); assert.equal(l.mine.name, 'Rider Two');
  await s.routes['POST /api/me/stream'](me, { url: '' });
  assert.equal((await s.routes['GET /api/streams'](me)).streams.length, 0);
  await assert.rejects(s.routes['POST /api/me/stream']({ role: 'admin' }, { url: 'https://twitch.tv/x' }), { status: 401 }, 'staff without a member record cannot add one');
});
