'use strict';
// A small QR code encoder (byte mode, error correction level M, versions 1 to 10: up to 213 bytes), enough for an authenticator-app setup link. It is built
// here so the secret in that link is never sent to an outside QR service. Returns the module matrix, or an SVG. Checked against the reference `segno`
// library for every mask (see test/qr.test.js).
const EC = { 1: [10, [[1, 16]]], 2: [16, [[1, 28]]], 3: [26, [[1, 44]]], 4: [18, [[2, 32]]], 5: [24, [[2, 43]]], 6: [16, [[4, 27]]], 7: [18, [[4, 31]]], 8: [22, [[2, 38], [2, 39]]], 9: [22, [[3, 36], [2, 37]]], 10: [26, [[4, 43], [1, 44]]] };
const ALIGN = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const VERSION_INFO = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 };
const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

// GF(256) arithmetic and Reed-Solomon
const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11D; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function generator(n) { let g = [1]; for (let i = 0; i < n; i++) { const next = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); } g = next; } return g; }
function remainder(data, n) { const g = generator(n), res = new Array(n).fill(0); for (const b of data) { const f = b ^ res.shift(); res.push(0); if (f) for (let i = 0; i < n; i++) res[i] ^= mul(g[i + 1], f); } return res; }

function bytesOf(text) { return [...Buffer.from(String(text), 'utf8')]; }
function pickVersion(len) { for (let v = 1; v <= 10; v++) { const data = EC[v][1].reduce((n, [c, d]) => n + c * d, 0), head = v < 10 ? 2 : 3; if (len + head <= data) return v; } throw new Error('That is too long for the QR code (213 bytes at most).'); }
function codewords(bytes, v) {
  const total = EC[v][1].reduce((n, [c, d]) => n + c * d, 0), bits = []; const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
  push(4, 4); push(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => push(b, 8)); push(0, Math.min(4, total * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2)); for (let p = 0xEC; data.length < total; p = p === 0xEC ? 0x11 : 0xEC) data.push(p);
  const [ecLen, groups] = EC[v], blocks = []; let at = 0; for (const [count, size] of groups) for (let i = 0; i < count; i++) { blocks.push(data.slice(at, at + size)); at += size; }
  const ecs = blocks.map(b => remainder(b, ecLen)), out = [], max = Math.max(...blocks.map(b => b.length));
  for (let i = 0; i < max; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
  return out;
}
function bch(value, poly, bitsLen, shift) { let r = value << shift; const top = bitsLen; for (let i = bitsLen + shift - 1; i >= shift + 0 && i >= top - 1 + 0; i--) { /* handled below */ } return r; }
function formatBits(mask) { const data = (0 << 3) | mask; let rem = data << 10; for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10); return ((data << 10) | rem) ^ 0x5412; }

function build(bytes, v, forcedMask) {
  const n = 17 + 4 * v, M = Array.from({ length: n }, () => new Array(n).fill(null)), reserved = Array.from({ length: n }, () => new Array(n).fill(false));
  const set = (r, c, val, res = true) => { if (r < 0 || c < 0 || r >= n || c >= n) return; M[r][c] = val; if (res) reserved[r][c] = true; };
  const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const on = i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4)); set(r + i, c + j, on); } };
  finder(0, 0); finder(0, n - 7); finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const pos = ALIGN[v] || []; for (const r of pos) for (const c of pos) { if ((r === 6 && c === 6) || (r === 6 && c === pos[pos.length - 1]) || (r === pos[pos.length - 1] && c === 6)) continue; for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1); }
  set(n - 8, 8, true);   // the always-dark module
  for (let i = 0; i < 9; i++) { reserved[8][i] = true; reserved[i][8] = true; } for (let i = 0; i < 8; i++) { reserved[8][n - 1 - i] = true; reserved[n - 1 - i][8] = true; }
  if (v >= 7) for (let i = 0; i < 6; i++) for (let j = 0; j < 3; j++) { reserved[i][n - 11 + j] = true; reserved[n - 11 + j][i] = true; }
  // data, zigzag from the bottom right in two-column strips (the timing column is skipped)
  const cw = codewords(bytes, v), bits = []; cw.forEach(b => { for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1); }); for (let i = 0; i < REMAINDER[v]; i++) bits.push(0);
  let k = 0, up = true; for (let c = n - 1; c > 0; c -= 2) { if (c === 6) c = 5; for (let i = 0; i < n; i++) { const r = up ? n - 1 - i : i; for (const cc of [c, c - 1]) if (!reserved[r][cc]) { M[r][cc] = bits[k++] === 1; } } up = !up; }
  const masks = [(r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0, (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
  const apply = m => { const out = M.map(row => row.slice()); for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (!reserved[r][c] && masks[m](r, c)) out[r][c] = !out[r][c];
    const f = formatBits(m); for (let i = 0; i < 15; i++) { const bit = ((f >> i) & 1) === 1; if (i < 6) out[i][8] = bit; else if (i < 8) out[i + 1][8] = bit; else out[n - 15 + i][8] = bit; if (i < 8) out[8][n - 1 - i] = bit; else if (i < 9) out[8][15 - i] = bit; else out[8][14 - i] = bit; }
    out[n - 8][8] = true;
    if (v >= 7) { const vi = VERSION_INFO[v]; for (let i = 0; i < 18; i++) { const bit = ((vi >> i) & 1) === 1, a = Math.floor(i / 3), b = i % 3; out[a][n - 11 + b] = bit; out[n - 11 + b][a] = bit; } }
    return out; };
  const penalty = g => { let p = 0; const N = g.length;
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < N; i++) { let run = 1; for (let j = 1; j < N; j++) { const a = pass ? g[j][i] : g[i][j], b = pass ? g[j - 1][i] : g[i][j - 1]; if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } }
    for (let i = 0; i < N - 1; i++) for (let j = 0; j < N - 1; j++) if (g[i][j] === g[i + 1][j] && g[i][j] === g[i][j + 1] && g[i][j] === g[i + 1][j + 1]) p += 3;
    const pat = [true, false, true, true, true, false, true, false, false, false, false], rev = pat.slice().reverse();
    for (let pass = 0; pass < 2; pass++) for (let i = 0; i < N; i++) for (let j = 0; j <= N - 11; j++) { const line = Array.from({ length: 11 }, (_, x) => (pass ? g[j + x][i] : g[i][j + x])); if (line.every((x, y) => x === pat[y]) || line.every((x, y) => x === rev[y])) p += 40; }
    const dark = g.flat().filter(Boolean).length; p += Math.floor(Math.abs(dark * 20 - N * N * 10) / (N * N)) * 10; return p; };
  if (forcedMask !== undefined) return apply(forcedMask);
  let best = null, bestScore = Infinity; for (let m = 0; m < 8; m++) { const g = apply(m), s = penalty(g); if (s < bestScore) { best = g; bestScore = s; } } return best;
}
function matrix(text, opts = {}) { const bytes = bytesOf(text), v = opts.version || pickVersion(bytes.length); return build(bytes, v, opts.mask); }
function svg(text, { size = 220, dark = '#000', light = '#fff', quiet = 4 } = {}) {
  const g = matrix(text), n = g.length, total = n + quiet * 2; let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (g[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${total}" height="${total}" fill="${light}"/><path d="${path}" fill="${dark}"/></svg>`;
}
module.exports = { matrix, svg, pickVersion };
