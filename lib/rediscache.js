'use strict';
// A short read cache in front of the Redis client. Upstash bills every command in a pipeline, and a single page load or scheduled run often reads
// the same key several times within a second or two (each feature loads its own copy of the shared data). Identical reads inside a few seconds
// are answered from memory instead. Rules that keep it safe:
//  - only plain reads are cached, and only when the whole pipeline is reads (a pipeline with a write goes straight through, untouched);
//  - any write from this process drops the cached reads of the key it wrote (an unfamiliar command drops everything);
//  - the window is a few seconds, so another running copy of the app can be at most that far behind.
module.exports = function createReadCache(raw, { ttlMs = 5000, now = () => Date.now(), max = 500 } = {}) {
  const READS = new Set(['GET', 'HGET', 'HGETALL', 'HKEYS', 'HLEN', 'LRANGE', 'EXISTS', 'TYPE']);
  const WRITES_BY_KEY = new Set(['SET', 'DEL', 'INCR', 'INCRBY', 'EXPIRE', 'HSET', 'HINCRBY', 'HSETNX', 'HDEL', 'LPUSH', 'RPUSH', 'LTRIM', 'LSET', 'LPOP', 'RPOP', 'SADD', 'SREM', 'ZADD', 'ZREM', 'SETEX', 'DECR', 'DECRBY', 'APPEND', 'RENAME']);
  const hits = new Map();   // cache id -> { at, value, key }
  const stats = { sent: 0, served: 0 };
  const clone = v => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));
  const name = c => String(c[0]).toUpperCase();
  const idOf = c => JSON.stringify([name(c), ...c.slice(1)]);

  function forget(key) { for (const [id, e] of hits) if (e.key === key) hits.delete(id); }

  async function redis(commands) {
    if (!ttlMs || !commands.length) { stats.sent += commands.length; return raw(commands); }
    if (!commands.every(c => READS.has(name(c)))) {
      stats.sent += commands.length;
      const out = await raw(commands);
      for (const c of commands) { if (WRITES_BY_KEY.has(name(c)) && c.length > 1) forget(String(c[1])); else if (!READS.has(name(c))) { hits.clear(); break; } }
      return out;
    }
    const t = now(), out = new Array(commands.length), miss = [];
    commands.forEach((c, i) => {
      const e = hits.get(idOf(c));
      if (e && t - e.at < ttlMs) { out[i] = clone(e.value); stats.served++; } else miss.push(i);
    });
    if (miss.length) {
      stats.sent += miss.length;
      const got = await raw(miss.map(i => commands[i]));
      if (hits.size > max) hits.clear();
      miss.forEach((i, j) => { out[i] = got[j]; hits.set(idOf(commands[i]), { at: t, value: clone(got[j]), key: String(commands[i][1]) }); });
    }
    return out;
  }
  redis.stats = stats;
  redis.clear = () => hits.clear();
  return redis;
};
