'use strict';
// A small Redis client over a plain TCP or TLS connection (REDIS_URL, e.g. rediss://default:password@host:6379), for running the app on any ordinary
// Redis (Redis Cloud, a VPS) instead of Upstash's REST service. It sends a whole pipeline in one round trip and answers in the same shape the Upstash
// REST pipeline does: one result per command (strings, integers, flat arrays, null). One connection per call: a serverless function holds none open.
const net = require('node:net'), tls = require('node:tls');

const encode = args => {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) { const b = Buffer.from(String(a), 'utf8'); parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n')); }
  return Buffer.concat(parts);
};

// Reads one reply starting at `off`. Returns [value, nextOffset], or null if the buffer does not hold a whole reply yet.
function parseReply(buf, off) {
  const nl = buf.indexOf('\r\n', off); if (nl < 0) return null;
  const t = String.fromCharCode(buf[off]), line = buf.toString('utf8', off + 1, nl), next = nl + 2;
  switch (t) {
    case '+': return [line, next];
    case '-': return [{ redisError: line }, next];
    case ':': return [Number(line), next];
    case '$': { const n = Number(line); if (n < 0) return [null, next]; if (buf.length < next + n + 2) return null; return [buf.toString('utf8', next, next + n), next + n + 2]; }
    case '*': { const n = Number(line); if (n < 0) return [null, next]; const out = []; let o = next; for (let i = 0; i < n; i++) { const r = parseReply(buf, o); if (!r) return null; out.push(r[0]); o = r[1]; } return [out, o]; }
    default: throw new Error(`unexpected reply type ${t}`);
  }
}

function connect(url, timeoutMs) {
  const u = new URL(url), secure = u.protocol === 'rediss:', port = Number(u.port) || 6379;
  return new Promise((resolve, reject) => {
    const sock = (secure ? tls.connect : net.connect)({ host: u.hostname, port, servername: u.hostname });
    const timer = setTimeout(() => { sock.destroy(); reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })); }, timeoutMs);
    const onError = e => { clearTimeout(timer); reject(e); };
    sock.once('error', onError);
    sock.once(secure ? 'secureConnect' : 'connect', () => { clearTimeout(timer); sock.off('error', onError); resolve({ sock, u }); });
  });
}

// commands: [[name, ...args], ...] -> [result, ...]. Throws on a connection problem or when the server refuses a command (like the REST pipeline).
async function pipeline(url, commands, { timeoutMs = 8000 } = {}) {
  const { sock, u } = await connect(url, timeoutMs);
  const pre = [];
  if (u.password) pre.push(u.username && u.username !== 'default' ? ['AUTH', decodeURIComponent(u.username), decodeURIComponent(u.password)] : ['AUTH', decodeURIComponent(u.password)]);
  const db = Number((u.pathname || '').slice(1)); if (db) pre.push(['SELECT', db]);
  const all = [...pre, ...commands];
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), off = 0, done = false; const replies = [];
    const finish = (err, out) => { if (done) return; done = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(out); };
    const timer = setTimeout(() => finish(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), timeoutMs);
    sock.on('error', finish);
    sock.on('close', () => { if (replies.length < all.length) finish(new Error('connection closed early')); });
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]);
      try { while (replies.length < all.length) { const r = parseReply(buf, off); if (!r) break; replies.push(r[0]); off = r[1]; } } catch (e) { return finish(e); }
      if (replies.length === all.length) {
        const bad = replies.find(x => x && typeof x === 'object' && !Array.isArray(x) && x.redisError);
        if (bad) return finish(Object.assign(new Error(bad.redisError), { fromServer: true }));
        finish(null, replies.slice(pre.length));
      }
    });
    sock.write(Buffer.concat(all.map(encode)));
  });
}
module.exports = { pipeline, encode, parseReply };
