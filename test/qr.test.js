'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const qr = require('../lib/qr'), totp = require('../lib/totp');

// These three matrices were decoded back to their text with an independent decoder (OpenCV) when they were made; the fingerprints stop a later change
// from quietly breaking the codes an authenticator app has to scan.
const FIXTURES = [
  ['otpauth://totp/CRYO-GEN:ricks?secret=JBSWY3DPEHPK3PXP&issuer=CRYO-GEN&algorithm=SHA1&digits=6&period=30', 6, 41, 'b3314906438aec63'],
  ['https://club.cryo-gen.team/', 3, 29, '1ee9b5f0c422e663'],
  ['otpauth://totp/CRYO-GEN%20Owner:Owner?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=CRYO-GEN%20Owner&algorithm=SHA1&digits=6&period=30', 8, 49, 'b42b3807d2577d2e'],
];
test('QR codes: the right version and size, the finder and timing patterns, and the verified fingerprints', () => {
  for (const [text, version, size, hash] of FIXTURES) {
    const g = qr.matrix(text); assert.equal(qr.pickVersion(Buffer.byteLength(text)), version); assert.equal(g.length, size);
    assert.equal(crypto.createHash('sha256').update(g.map(r => r.map(x => (x ? 1 : 0)).join('')).join('\n')).digest('hex').slice(0, 16), hash, text.slice(0, 30));
    for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) { for (let i = 0; i < 7; i++) { assert.ok(g[r][c + i] && g[r + 6][c + i] && g[r + i][c] && g[r + i][c + 6], 'a finder pattern edge'); } assert.equal(g[r + 3][c + 3], true); assert.equal(g[r + 1][c + 1], false); }
    for (let i = 8; i < size - 8; i++) assert.equal(g[6][i], i % 2 === 0, 'the timing row');
    assert.equal(g[size - 8][8], true, 'the dark module');
  }
  assert.throws(() => qr.matrix('x'.repeat(300)), /too long/); assert.match(qr.svg('hello'), /^<svg[^>]*viewBox="0 0 29 29"[\s\S]*<path d="M/);
});

test('authenticator codes match the RFC 6238 test vectors, accept one step of clock drift, and refuse a code that was already used', () => {
  const s = totp.b32encode(Buffer.from('12345678901234567890'));
  assert.deepEqual([totp.code(s, 59000), totp.code(s, 1111111109000), totp.code(s, 1234567890000)], ['287082', '081804', '005924']);
  assert.equal(totp.verify(s, '287082', 59000), 1); assert.equal(totp.verify(s, '287082', 59000 + 25000), 1, 'a little late'); assert.equal(totp.verify(s, '287082', 59000 + 95000), null, 'too old'); assert.equal(totp.verify(s, '287082', 59000, 1), null, 'already used'); assert.equal(totp.verify(s, '12345', 59000), null); assert.equal(totp.verify(s, 'abcdef', 59000), null);
  assert.equal(totp.b32decode(totp.b32encode(Buffer.from('hello'))).toString(), 'hello'); assert.equal(totp.newSecret().length, 32);
  assert.equal(totp.otpauth('Ricks', 'CRYO-GEN Staff', 'ABC234'), 'otpauth://totp/CRYO-GEN%20Staff:Ricks?secret=ABC234&issuer=CRYO-GEN%20Staff&algorithm=SHA1&digits=6&period=30');
});
