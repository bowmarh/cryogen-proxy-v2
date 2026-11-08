'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const createReadCache = require('../lib/rediscache');

// A tiny fake store that counts the commands it is actually sent.
function store() {
  const db = {}, sent = [];
  const raw = async cmds => cmds.map(c => {
    sent.push(c); const [cmd, k, ...a] = c;
    if (cmd === 'GET') return db[k] ?? null; if (cmd === 'SET') { db[k] = a[0]; return 'OK'; }
    if (cmd === 'HSET') { (db[k] = db[k] || {})[a[0]] = a[1]; return 1; } if (cmd === 'HGETALL') return Object.entries(db[k] || {}).flat();
    if (cmd === 'FLUSHDB') { for (const x of Object.keys(db)) delete db[x]; return 'OK'; } return null;
  });
  return { raw, sent, db };
}

test('the same read inside the window is answered from memory, and counts once', async () => {
  const s = store(); let t = 0; const r = createReadCache(s.raw, { ttlMs: 5000, now: () => t });
  await r([['SET', 'a', '1']]);
  assert.deepEqual(await r([['GET', 'a']]), ['1']);
  assert.deepEqual(await r([['GET', 'a'], ['GET', 'a']]), ['1', '1']);
  assert.equal(s.sent.filter(c => c[0] === 'GET').length, 1, 'one command reached the database, not three');
  t = 5001; await r([['GET', 'a']]);
  assert.equal(s.sent.filter(c => c[0] === 'GET').length, 2, 'after the window it asks again');
});

test('a write from this process drops the cached read of that key only', async () => {
  const s = store(), r = createReadCache(s.raw, { ttlMs: 5000, now: () => 0 });
  await r([['SET', 'a', '1']]); await r([['SET', 'b', '1']]);
  await r([['GET', 'a'], ['GET', 'b']]);
  await r([['SET', 'a', '2']]);
  assert.deepEqual(await r([['GET', 'a'], ['GET', 'b']]), ['2', '1'], 'the changed key is read fresh');
  assert.equal(s.sent.filter(c => c[0] === 'GET' && c[1] === 'b').length, 1, 'the untouched key was not asked for again');
});

test('a pipeline that mixes reads and writes goes straight through, and an unfamiliar command clears everything', async () => {
  const s = store(), r = createReadCache(s.raw, { ttlMs: 5000, now: () => 0 });
  await r([['SET', 'a', '1']]); await r([['GET', 'a']]);
  assert.deepEqual(await r([['GET', 'a'], ['SET', 'a', '9'], ['GET', 'a']]), ['1', 'OK', '9'], 'a read after a write in the same pipeline sees the write');
  await r([['GET', 'a']]); await r([['FLUSHDB']]);
  assert.deepEqual(await r([['GET', 'a']]), [null], 'nothing stale survives a command the cache does not understand');
});

test('results are copies: changing one does not change what the next caller gets; ttl 0 turns it off', async () => {
  const s = store(), r = createReadCache(s.raw, { ttlMs: 5000, now: () => 0 });
  await r([['HSET', 'h', 'f', 'v']]);
  const [first] = await r([['HGETALL', 'h']]); first.push('junk');
  assert.deepEqual((await r([['HGETALL', 'h']]))[0], ['f', 'v']);
  const off = createReadCache(s.raw, { ttlMs: 0 }); s.sent.length = 0;
  await off([['GET', 'a']]); await off([['GET', 'a']]);
  assert.equal(s.sent.length, 2);
});

test('an error from the database is passed on and nothing is cached from it', async () => {
  let fail = true;
  const r = createReadCache(async cmds => { if (fail) throw new Error('storage down'); return cmds.map(() => 'ok'); }, { ttlMs: 5000, now: () => 0 });
  await assert.rejects(() => r([['GET', 'a']]), /storage down/);
  fail = false; assert.deepEqual(await r([['GET', 'a']]), ['ok']);
});
