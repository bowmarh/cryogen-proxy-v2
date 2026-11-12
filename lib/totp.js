'use strict';
// Time-based one-time passwords (RFC 6238) for authenticator apps: SHA-1, six digits, thirty seconds, which every authenticator app understands.
const crypto = require('crypto');
const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const b32encode = buf => { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += A[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += A[(val << (5 - bits)) & 31]; return out; };
const b32decode = s => { let bits = 0, val = 0; const out = []; for (const ch of String(s).toUpperCase().replace(/[\s=-]/g, '')) { const i = A.indexOf(ch); if (i < 0) throw new Error('not base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); };
const newSecret = () => b32encode(crypto.randomBytes(20));
function hotp(secretBuf, counter) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter)); const h = crypto.createHmac('sha1', secretBuf).update(c).digest(), o = h[19] & 15;
  return String(((h[o] & 127) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1000000).padStart(6, '0');
}
const step = (now = Date.now()) => Math.floor(now / 30000);
const code = (secretB32, now = Date.now()) => hotp(b32decode(secretB32), step(now));
// Accepts the current code and one step either side (clock drift). Returns the matching step (to stop the same code being used twice), or null.
function verify(secretB32, given, now = Date.now(), lastStep = 0) {
  const g = String(given || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(g)) return null;
  const buf = b32decode(secretB32), s = step(now);
  for (const d of [0, -1, 1]) { const st = s + d; if (st <= lastStep) continue; const want = hotp(buf, st); if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(g))) return st; }
  return null;
}
const otpauth = (account, issuer, secretB32) => `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
module.exports = { newSecret, code, verify, otpauth, b32encode, b32decode, step };
