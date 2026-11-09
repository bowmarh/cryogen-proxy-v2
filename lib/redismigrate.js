'use strict';
// Copies every key from one Redis to another (Upstash REST or an ordinary Redis over TCP, on either side): used to move the club's database to a new
// one (for example one in an EU region) without losing anything. It only ever READS the source. Hashes, strings and lists (the types this app uses)
// are copied with their expiry times; any other type stops the run instead of being skipped silently. Run it with a dry run first, then for real,
// then verify. Nothing here prints a credential.
const { pipeline: tcpPipeline } = require('./redisclient');

// A connection is { restUrl, restToken } (Upstash REST) or { tcpUrl } (redis:// or rediss://). run(commands) answers one result per command.
function connect(c) {
  if (c.tcpUrl) return { label: 'TCP ' + new URL(c.tcpUrl).host, run: cmds => tcpPipeline(c.tcpUrl, cmds) };
  if (!c.restUrl || !c.restToken) throw new Error('A connection needs a REST URL and token, or a TCP URL.');
  const base = c.restUrl.replace(/\/$/, '');
  return {
    label: 'REST ' + new URL(base).hostname,
    async run(cmds) {
      const r = await fetch(`${base}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${c.restToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(`The storage service answered HTTP ${r.status}.`);
      const out = await r.json(), bad = out.find(x => x.error);
      if (bad) throw new Error(bad.error);
      return out.map(x => x.result);
    },
  };
}

const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const bytes = v => Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v));
// Splits a flat [field, value, field, value, ...] list into groups of whole pairs that stay under about 1 MB each.
function pairChunks(flat) {
  const out = []; let cur = [], size = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const add = bytes(flat[i]) + bytes(flat[i + 1]);
    if (cur.length && (size + add > 1000000 || cur.length >= 400)) { out.push(cur); cur = []; size = 0; }
    cur.push(flat[i], flat[i + 1]); size += add;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function listKeys(src, prefix) {
  const keys = []; let cursor = '0';
  do {
    const [res] = await src.run([['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', 500]]);
    cursor = String(res[0]); keys.push(...res[1]);
  } while (cursor !== '0');
  return [...new Set(keys)].sort();
}

async function describe(src, keys) {
  const out = [];
  for (const part of chunks(keys, 200)) {
    const res = await src.run(part.flatMap(k => [['TYPE', k], ['PTTL', k]]));
    part.forEach((k, i) => out.push({ key: k, type: res[2 * i], pttl: Number(res[2 * i + 1]) }));
  }
  return out;
}

// options: { src, dst (connections), prefix, dryRun, overwrite, log }. Returns counts and any problems; throws nothing for a refused key, it reports it.
async function copy({ src, dst, prefix = 'cg:', dryRun = false, overwrite = false, log = () => {} }) {
  const keys = await listKeys(src, prefix), info = await describe(src, keys), stats = { keys: keys.length, byType: {}, copied: 0, skippedExisting: 0, expiring: 0, problems: [] };
  for (const i of info) { stats.byType[i.type] = (stats.byType[i.type] || 0) + 1; if (i.pttl > 0) stats.expiring++; }
  const odd = info.filter(i => !['hash', 'string', 'list'].includes(i.type));
  if (odd.length) { stats.problems.push(`These keys have a type this tool does not copy: ${odd.slice(0, 5).map(i => `${i.key} (${i.type})`).join(', ')}${odd.length > 5 ? ` and ${odd.length - 5} more` : ''}.`); return stats; }
  const [existing] = await dst.run([['DBSIZE']]); stats.targetKeysBefore = Number(existing) || 0;
  if (dryRun) return stats;
  for (const part of chunks(info, 50)) {
    const present = await dst.run(part.map(i => ['EXISTS', i.key]));
    for (let n = 0; n < part.length; n++) {
      const { key, type, pttl } = part[n];
      if (present[n] && !overwrite) { stats.skippedExisting++; continue; }
      if (present[n]) await dst.run([['DEL', key]]);
      if (type === 'string') {
        const [v] = await src.run([['GET', key]]);
        if (v !== null) await dst.run([['SET', key, v]]);
      } else if (type === 'hash') {
        const [flat] = await src.run([['HGETALL', key]]);
        for (const c of pairChunks(flat || [])) await dst.run([['HSET', key, ...c]]);
      } else {
        const [items] = await src.run([['LRANGE', key, 0, -1]]);
        for (const c of chunks(items || [], 200)) await dst.run([['RPUSH', key, ...c]]);
      }
      if (pttl > 0) await dst.run([['PEXPIRE', key, pttl]]);
      stats.copied++;
    }
    log(`${Math.min(stats.copied + stats.skippedExisting, keys.length)} of ${keys.length} keys`);
  }
  return stats;
}

// Compares every key in the source with the target: same type, same contents. Returns the keys that differ.
async function verify({ src, dst, prefix = 'cg:' }) {
  const keys = await listKeys(src, prefix), differ = []; let same = 0;
  const norm = (type, v) => (type === 'hash' ? JSON.stringify(Object.entries(Object.fromEntries((() => { const o = []; for (let i = 0; i < (v || []).length; i += 2) o.push([v[i], v[i + 1]]); return o; })())).sort()) : JSON.stringify(v));
  for (const part of chunks(await describe(src, keys), 25)) {
    for (const { key, type } of part) {
      const read = c => c.run([[type === 'hash' ? 'HGETALL' : type === 'list' ? 'LRANGE' : 'GET', key, ...(type === 'list' ? [0, -1] : [])], ['TYPE', key]]);
      const [[a], [b, t]] = [await read(src), await read(dst)];
      if (t !== type || norm(type, a) !== norm(type, b)) differ.push(key); else same++;
    }
  }
  return { keys: keys.length, same, differ };
}

module.exports = { connect, copy, verify, listKeys };
