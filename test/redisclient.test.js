'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const h = require('./helpers');
const { pipeline, parseReply } = require('../lib/redisclient');

// A stand-in Redis server: speaks RESP over TCP and runs the commands against the same fake database the other tests use.
function mockRedis({ password = 'pw', fragment = false } = {}) {
  const db = {}, log = [];
  const enc = v => {
    if (v === null || v === undefined) return '$-1\r\n';
    if (typeof v === 'number') return `:${v}\r\n`;
    if (Array.isArray(v)) return `*${v.length}\r\n${v.map(enc).join('')}`;
    if (v === 'OK') return '+OK\r\n';
    return `$${Buffer.byteLength(String(v))}\r\n${v}\r\n`;
  };
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0), authed = false;
    sock.on('error', () => {});
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = parseReply(buf, 0); if (!r) break;
        const args = r[0]; buf = buf.subarray(r[1]); log.push(args);
        let out;
        if (String(args[0]).toUpperCase() === 'AUTH') { authed = args[args.length - 1] === password; out = authed ? '+OK\r\n' : '-WRONGPASS invalid password\r\n'; }
        else if (!authed) out = '-NOAUTH Authentication required.\r\n';
        else { try { out = enc(h.redisRun(db, args)); } catch (e) { out = `-ERR ${e.message}\r\n`; } }
        if (fragment) { for (const ch of Buffer.from(out)) sock.write(Buffer.from([ch])); } else sock.write(out);
      }
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, db, log, close: () => new Promise(x => server.close(x)) })));
}

test('a pipeline comes back as one result per command, in the shape the REST service gives', async () => {
  const m = await mockRedis();
  try {
    const url = `redis://default:pw@127.0.0.1:${m.port}`;
    const out = await pipeline(url, [['SET', 'a', 'héllo'], ['GET', 'a'], ['GET', 'missing'], ['HSET', 'h', 'f1', 'v1'], ['HSET', 'h', 'f2', 'v2'], ['HGETALL', 'h'], ['INCR', 'n'], ['HLEN', 'h']]);
    assert.deepEqual(out, ['OK', 'héllo', null, 1, 1, ['f1', 'v1', 'f2', 'v2'], 1, 2]);
    assert.deepEqual(m.log[0], ['AUTH', 'pw'], 'it signs in first');
  } finally { await m.close(); }
});

test('replies that arrive a byte at a time are still read whole, and values with new lines survive', async () => {
  const m = await mockRedis({ fragment: true });
  try {
    const url = `redis://:pw@127.0.0.1:${m.port}`, text = 'line one\r\nline two ✓';
    assert.deepEqual(await pipeline(url, [['SET', 'k', text], ['GET', 'k']]), ['OK', text]);
  } finally { await m.close(); }
});

test('a wrong password or a refused command is an error, and so is a server that is not there', async () => {
  const m = await mockRedis();
  try {
    await assert.rejects(() => pipeline(`redis://:nope@127.0.0.1:${m.port}`, [['GET', 'a']]), /WRONGPASS/);
    await assert.rejects(() => pipeline(`redis://:pw@127.0.0.1:${m.port}`, [['NOSUCHCOMMAND', 'x']]), /ERR unsupported redis command/);
  } finally { await m.close(); }
  await assert.rejects(() => pipeline('redis://127.0.0.1:1', [['GET', 'a']], { timeoutMs: 1000 }));
});

let app, mock;
before(async () => {
  mock = await mockRedis(); h.setEnv({ REDIS_URL: `redis://:pw@127.0.0.1:${mock.port}`, REDIS_PREFER_TCP: '1' });
  const world = h.createWorld(); world.db = mock.db;
  app = await h.startApp(world);
});
after(async () => { process.env.REDIS_URL = ''; process.env.REDIS_PREFER_TCP = ''; await app.close(); await mock.close(); });

test('the whole app runs on REDIS_URL: an admin adds and lists a case-log entry, and the data is in the TCP Redis, not the REST one', async () => {
  const admin = await app.login('admin');
  const calls = app.world.redisCalls;
  const add = await app.post('/api/caselog/add', { zwift_id: '1001', event_name: 'ZRL round 3', event_date: '2026-10-20', outcome: 'resolved', indicators: [], note: 'ok' }, { token: admin });
  assert.equal(add.status, 200);
  const list = (await app.get('/api/caselog', { token: admin })).body;
  assert.equal(list.entries.length, 1);
  assert.ok(mock.db['cg:cases:log'], 'stored in the TCP Redis');
  assert.equal(app.world.redisCalls, calls, 'no request went to the REST service');
});

test('REDIS_URL alone never takes over: with the Upstash REST settings present, the REST service is used (the Vercel integration adds a REDIS_URL of its own)', async () => {
  const saved = [process.env.REDIS_URL, process.env.REDIS_PREFER_TCP];
  process.env.REDIS_URL = 'redis://:pw@127.0.0.1:1'; process.env.REDIS_PREFER_TCP = '';   // a TCP address that would fail if it were used
  try {
    const admin = await app.login('admin'), calls = app.world.redisCalls;
    const r = await app.get('/api/caselog', { token: admin });
    assert.equal(r.status, 200); assert.ok(app.world.redisCalls > calls, 'the request went to the REST service');
  } finally { [process.env.REDIS_URL, process.env.REDIS_PREFER_TCP] = saved; }
});
