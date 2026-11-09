'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const http = require('node:http');
const h = require('./helpers');
const { parseReply } = require('../lib/redisclient');
const { connect, copy, verify } = require('../lib/redismigrate');

// Two stand-in Redis servers over TCP (one source, one target) and one over the Upstash REST shape, all on the fake database the other tests use.
const enc = v => (v === null || v === undefined ? '$-1\r\n' : typeof v === 'number' ? `:${v}\r\n` : Array.isArray(v) ? `*${v.length}\r\n${v.map(enc).join('')}` : v === 'OK' ? '+OK\r\n' : `$${Buffer.byteLength(String(v))}\r\n${v}\r\n`);
function tcpServer(db) {
  const server = net.createServer(sock => {
    let buf = Buffer.alloc(0); sock.on('error', () => {});
    sock.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const r = parseReply(buf, 0); if (!r) break; buf = buf.subarray(r[1]); let out; try { out = String(r[0][0]).toUpperCase() === 'AUTH' ? '+OK\r\n' : enc(h.redisRun(db, r[0])); } catch (e) { out = `-ERR ${e.message}\r\n`; } sock.write(out); } });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `redis://:pw@127.0.0.1:${server.address().port}`, close: () => new Promise(x => server.close(x)) })));
}
function restServer(db) {
  const server = http.createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(JSON.parse(b).map(c => { try { return { result: h.redisRun(db, c) }; } catch (e) { return { error: e.message }; } })));
  }); });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(x => server.close(x)) })));
}
const data = () => ({
  'cg:plain': 'héllo ✓', 'cg:signups': { 'ann lee': '{"name":"Ann Lee"}', 'bo': '{"name":"Bo"}' }, 'cg:big': Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`f${i}`, 'x'.repeat(2000)])),
  'cg:log': ['one', 'two', 'three'], 'other:thing': 'not ours', __ttl: { 'cg:plain': 5000 },
});

test('everything under the prefix is copied, with its expiry, over TCP; keys outside the prefix are left alone', async () => {
  const src = data(), dst = {}, a = await tcpServer(src), b = await tcpServer(dst);
  try {
    const s = await copy({ src: connect({ tcpUrl: a.url }), dst: connect({ tcpUrl: b.url }) });
    assert.equal(s.keys, 4); assert.deepEqual(s.byType, { string: 1, hash: 2, list: 1 }); assert.equal(s.copied, 4); assert.equal(s.expiring, 1);
    assert.equal(dst['cg:plain'], 'héllo ✓'); assert.deepEqual(dst['cg:log'], ['one', 'two', 'three']); assert.equal(dst['cg:signups']['bo'], '{"name":"Bo"}');
    assert.equal(Object.keys(dst['cg:big']).length, 1000, 'a hash bigger than one request is copied in pieces'); assert.equal(dst.__ttl['cg:plain'], 5000, 'the expiry came with it');
    assert.equal(dst['other:thing'], undefined);
    const v = await verify({ src: connect({ tcpUrl: a.url }), dst: connect({ tcpUrl: b.url }) });
    assert.deepEqual([v.keys, v.same, v.differ], [4, 4, []]);
  } finally { await a.close(); await b.close(); }
});

test('the Upstash REST shape works on either side, a dry run writes nothing, and the source is never changed', async () => {
  const src = data(), dst = {}, a = await restServer(src), b = await restServer(dst), before = JSON.stringify(src);
  try {
    const S = connect({ restUrl: a.url, restToken: 'tok' }), D = connect({ restUrl: b.url, restToken: 'tok' });
    const dry = await copy({ src: S, dst: D, dryRun: true });
    assert.equal(dry.keys, 4); assert.equal(Object.keys(dst).length, 0, 'nothing written');
    await copy({ src: S, dst: D });
    assert.equal(JSON.stringify(src), before, 'the source is untouched'); assert.equal(dst['cg:plain'], 'héllo ✓');
    assert.equal((await verify({ src: S, dst: D })).differ.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('keys the target already has are left unless asked to overwrite; verify finds a difference and the overwrite fixes it', async () => {
  const src = data(), dst = {}, a = await tcpServer(src), b = await tcpServer(dst);
  try {
    const S = connect({ tcpUrl: a.url }), D = connect({ tcpUrl: b.url });
    await copy({ src: S, dst: D });
    src['cg:plain'] = 'changed on the old database'; src['cg:log'].push('four');
    const again = await copy({ src: S, dst: D });
    assert.equal(again.copied, 0); assert.equal(again.skippedExisting, 4); assert.equal(dst['cg:plain'], 'héllo ✓');
    assert.deepEqual((await verify({ src: S, dst: D })).differ.sort(), ['cg:log', 'cg:plain']);
    await copy({ src: S, dst: D, overwrite: true });
    assert.equal(dst['cg:plain'], 'changed on the old database'); assert.deepEqual(dst['cg:log'], ['one', 'two', 'three', 'four']);
    assert.equal((await verify({ src: S, dst: D })).differ.length, 0);
  } finally { await a.close(); await b.close(); }
});

test('a key of a type the tool does not copy stops the run before anything is written, and says which', async () => {
  const src = { 'cg:ok': 'x' }, dst = {}, a = await tcpServer(src), b = await tcpServer(dst);
  const real = h.redisRun;
  try {
    const S = connect({ tcpUrl: a.url }), D = connect({ tcpUrl: b.url });
    src['cg:set'] = { __isSet: true };   // looks like a hash to the fake, so ask the source's type directly:
    const wrapped = { label: S.label, run: async cmds => (await S.run(cmds)).map((r, i) => (cmds[i][0] === 'TYPE' && cmds[i][1] === 'cg:set' ? 'set' : r)) };
    const s = await copy({ src: wrapped, dst: D });
    assert.match(s.problems[0], /cg:set \(set\)/); assert.equal(Object.keys(dst).length, 0, 'nothing was copied');
  } finally { await a.close(); await b.close(); assert.equal(h.redisRun, real); }
});

test('a connection needs credentials, and a wrong token is a clear error', async () => {
  assert.throws(() => connect({}), /REST URL and token/);
  const a = await restServer({});
  try { await assert.rejects(() => connect({ restUrl: a.url, restToken: 'wrong' }).run([['GET', 'x']]), /HTTP 401/); } finally { await a.close(); }
});
