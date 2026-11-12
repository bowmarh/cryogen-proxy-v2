'use strict';
// Signing in safely: authenticator-app codes (two-step sign-in), recovery codes, and forgotten-password handling for the staff levels.
//
//  Owner and personal staff accounts (Administrator, Moderator): password, then an authenticator-app code if they have turned that on (the owner can require
//    it for everyone). Lost phone: a recovery code. Forgot the password: a link emailed to the account's address (single use, 30 minutes), or the owner resets
//    it and hands over a temporary password that must be changed at the first sign-in. The owner's own password lives in Vercel (OWNER_PASSWORD).
//  The shared Administrator and Moderator passwords cannot have an authenticator (many people use one password); the owner can switch them off once everyone
//    has a personal account.
//  Members sign in through their cryogen.team account, so their password and any two-step sign-in are WordPress's: the app points them there.
// Secrets for authenticator apps are stored encrypted (AES-256-GCM). The key is AUTH_ENC_KEY if set in Vercel, otherwise one made once and kept in the
// database (set AUTH_ENC_KEY to keep the key apart from the data).
const crypto = require('crypto');
const totp = require('./totp'), qr = require('./qr');

module.exports = function createAuthSec({ redis, HttpError, requireRole, sessionFromRequest, signToken, staff, mail = null, audit = null, counter = async () => 0, peek = async () => 0, clientIp = () => '', siteUrl = '', env = process.env, now = () => Date.now() }) {
  const K = { twofa: 'cg:auth:twofa', settings: 'cg:auth:settings', key: 'cg:auth:key', reset: 'cg:auth:reset:' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
  const settings = async () => ({ requireStaff2fa: false, blockShared: { admin: false, mod: false }, ...(parse((await redis([['GET', K.settings]]))[0]) || {}) });
  const isOwnerSession = s => !!(s && s.role === 'admin' && s.owner === true && env.OWNER_PASSWORD);
  const log = (who, role, what) => (audit ? audit.record({ who, role, method: 'AUTH', path: what }).catch(() => {}) : null);

  // ── Encrypted secrets ──
  async function encKey() {
    if (env.AUTH_ENC_KEY) return crypto.createHash('sha256').update(String(env.AUTH_ENC_KEY)).digest();
    let [k] = await redis([['HGET', K.key, 'k']]); if (!k) { await redis([['HSETNX', K.key, 'k', crypto.randomBytes(32).toString('hex')]]); [k] = await redis([['HGET', K.key, 'k']]); }
    return Buffer.from(k, 'hex');
  }
  async function seal(text) { const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', await encKey(), iv), enc = Buffer.concat([c.update(text, 'utf8'), c.final()]); return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64'); }
  async function unseal(blob) { const b = Buffer.from(blob, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', await encKey(), b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'); }
  const load = async id => parse((await redis([['HGET', K.twofa, id]]))[0]);
  const save = (id, v) => redis([['HSET', K.twofa, id, JSON.stringify(v)]]);

  // Who is this? A signed-in owner or personal account, or someone holding a sign-in challenge from the password step.
  const idOf = s => (!s || !['admin', 'mod'].includes(s.role) ? '' : isOwnerSession(s) ? 'owner' : s.user ? `user:${s.user}` : '');   // never a challenge token
  const challenge = (id, kind, extra = {}) => signToken('challenge', { id, kind, cx: now() + 5 * 60000, ...extra });   // the account's role travels as "r": "role" is the token's own kind
  function readChallenge(token, kind) {
    const s = sessionFromRequest({ headers: { authorization: `Bearer ${token}` } }); if (!s || s.role !== 'challenge' || (kind && s.kind !== kind) || !(s.cx > now())) return null; return s;
  }
  function subject(req, body) {
    const s = sessionFromRequest(req); if (s && idOf(s)) return { id: idOf(s), s, label: s.owner ? 'Owner' : s.staffName || s.user };
    const c = body && body.challenge ? readChallenge(body.challenge) : null; if (c) return { id: c.id, s: c, label: c.label, viaChallenge: c.kind };
    throw new HttpError(401, 'Please sign in again.');
  }
  const sessionFor = c => (c.id === 'owner' ? signToken('admin', { owner: true, staffName: 'Owner', ov: sha(env.OWNER_PASSWORD).slice(0, 10), mfa: c.mfa ? 1 : 0 }) : signToken(c.r || c.role, { staffName: c.name, user: c.user, ...(c.mustChange ? { mc: 1 } : {}), mfa: c.mfa ? 1 : 0 }));
  const ownerBypass = () => env.OWNER_2FA_OFF === '1';

  // ── The step after a correct password ──
  // acct: { id: 'owner' | 'user:<name>', role, name, user, mustChange }. Returns { token } or { twoFactor, challenge } or { needsSetup, challenge }.
  async function afterPassword(acct) {
    let rec, s; try { rec = await load(acct.id); s = await settings(); } catch (e) { if (acct.id !== 'owner') throw e; await log(acct.name, acct.r || acct.role, 'owner sign-in while storage is down: two-step check skipped'); return { token: sessionFor(acct) }; }   // the owner can always reach the health page
    const bypass = acct.id === 'owner' && ownerBypass();
    if (rec && rec.enabled && !bypass) return { twoFactor: true, challenge: challenge(acct.id, 'login', { r: acct.role, name: acct.name, user: acct.user, mustChange: acct.mustChange, label: acct.name }) };
    if (s.requireStaff2fa && !bypass) return { needsSetup: true, challenge: challenge(acct.id, 'setup', { r: acct.role, name: acct.name, user: acct.user, mustChange: acct.mustChange, label: acct.name }) };
    await log(acct.name, acct.role, 'sign-in'); return { token: sessionFor(acct) };
  }
  // If storage is down the answer is "not blocked": the Administrator must still be able to sign in to see what is wrong.
  async function blockedShared(role) { try { const s = await settings(); return !!(s.blockShared && s.blockShared[role]); } catch (e) { return false; } }

  // ── Checking a code (or a recovery code) ──
  async function checkCode(id, given, { allowRecovery = true } = {}) {
    const key = `cg:rl:2fa:${id}`; if (await peek(key) >= 8) throw new HttpError(429, 'Too many wrong codes. Wait 15 minutes and try again.');
    const rec = await load(id); if (!rec || !rec.enabled) return { ok: true, none: true };
    const secret = await unseal(rec.enc), st = totp.verify(secret, given, now(), rec.last || 0);
    if (st) { rec.last = st; await save(id, rec); return { ok: true }; }
    const g = String(given || '').trim().toLowerCase();
    if (allowRecovery && /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(g)) { const h = sha(g), i = (rec.recovery || []).indexOf(h); if (i >= 0) { rec.recovery.splice(i, 1); await save(id, rec); return { ok: true, recovery: true, left: rec.recovery.length }; } }
    await counter(key, 900); throw new HttpError(401, 'That code is not right.');
  }
  const newRecovery = () => { const codes = Array.from({ length: 10 }, () => crypto.randomBytes(4).toString('hex').replace(/^(....)(....)$/, '$1-$2')); return { codes, hashes: codes.map(sha) }; };

  const routes = {
    // Step two of signing in: the code from the app (or a recovery code).
    'POST /api/auth/2fa': async (req, body) => {
      const ip = `cg:rl:2fa:ip:${clientIp(req)}`; if (await peek(ip) >= 20) throw new HttpError(429, 'Too many attempts from this connection. Try again in 15 minutes.');
      const c = readChallenge(body.challenge, 'login'); if (!c) throw new HttpError(401, 'That sign-in has timed out: enter your password again.');
      try { const r = await checkCode(c.id, body.code); await log(c.name, c.r, r.recovery ? 'sign-in with a recovery code' : 'sign-in with an authenticator code'); return { token: sessionFor({ ...c, mfa: true }), role: c.id === 'owner' ? 'admin' : c.r, owner: c.id === 'owner', name: c.name, recoveryLeft: r.left }; }
      catch (e) { await counter(ip, 900); if (e.status === 401) await log(c.name, c.r, 'wrong authenticator code'); throw e; }
    },
    'GET /api/auth/security': async req => {
      const s = sessionFromRequest(req), role = s && (s.role === 'admin' || s.role === 'mod') ? s.role : null; if (!role) throw new HttpError(401, 'Please sign in again.');
      const id = idOf(s), rec = id ? await load(id) : null, u = s.user ? await staff.get(s.user) : null, set = await settings();
      return { level: s.owner ? 'Owner' : role === 'admin' ? 'Administrator' : 'Moderator', kind: id === 'owner' ? 'owner' : id ? 'personal' : 'shared', username: s.user || '', email: u ? u.email || '' : '', totp: { enabled: !!(rec && rec.enabled), recoveryLeft: rec ? (rec.recovery || []).length : 0 }, canChangePassword: !!s.user, mustChange: s.mc === 1, require2fa: set.requireStaff2fa, owner2faBypass: id === 'owner' && ownerBypass() };
    },
    // Starts enrolling an authenticator app: a new secret (not yet active), as a link, a QR code and a typed-in key.
    'POST /api/auth/totp/setup': async (req, body) => {
      const sub = subject(req, body), rec = await load(sub.id); if (rec && rec.enabled && !(sub.viaChallenge === 'setup' && ownerBypass())) throw new HttpError(409, 'An authenticator is already set up. Turn it off first (you will need a code).');
      const secret = totp.newSecret(), issuer = sub.id === 'owner' ? 'CRYO-GEN Owner' : 'CRYO-GEN Staff', account = sub.id === 'owner' ? 'Owner' : sub.label || sub.id, url = totp.otpauth(account, issuer, secret);
      await save(sub.id, { enc: await seal(secret), enabled: false, pending: true, last: 0, recovery: [], at: new Date(now()).toISOString() });
      return { secret: secret.replace(/(.{4})/g, '$1 ').trim(), otpauth: url, svg: qr.svg(url, { size: 200 }) };
    },
    // Confirms the app is working (one code), turns it on, and shows ten recovery codes once.
    'POST /api/auth/totp/enable': async (req, body) => {
      const sub = subject(req, body), rec = await load(sub.id); if (!rec || !rec.pending) throw new HttpError(409, 'Start the setup first.');
      const st = totp.verify(await unseal(rec.enc), body.code, now(), 0); if (!st) { await counter(`cg:rl:2fa:${sub.id}`, 900); throw new HttpError(401, 'That code is not right. Check the app and try the new code.'); }
      const rc = newRecovery(); await save(sub.id, { ...rec, enabled: true, pending: false, last: st, recovery: rc.hashes });
      await log(sub.label, sub.s.r || sub.s.role, 'authenticator turned on');
      const out = { ok: true, recoveryCodes: rc.codes }; if (sub.viaChallenge) { out.token = sessionFor({ ...sub.s, mfa: true }); out.name = sub.s.name; out.role = sub.s.id === 'owner' ? 'admin' : sub.s.r || sub.s.role; out.owner = sub.s.id === 'owner'; } return out;
    },
    'POST /api/auth/totp/disable': async (req, body) => {
      const sub = subject(req, body); if ((await settings()).requireStaff2fa && !(sub.id === 'owner' && ownerBypass())) throw new HttpError(409, 'Two-step sign-in is required for staff, so it cannot be turned off.');
      await checkCode(sub.id, body.code); await redis([['HDEL', K.twofa, sub.id]]); await log(sub.label, 'staff', 'authenticator turned off'); return { ok: true };
    },
    'POST /api/auth/totp/recovery': async (req, body) => {
      const sub = subject(req, body); await checkCode(sub.id, body.code, { allowRecovery: false }); const rec = await load(sub.id), rc = newRecovery(); await save(sub.id, { ...rec, recovery: rc.hashes }); await log(sub.label, 'staff', 'recovery codes renewed'); return { recoveryCodes: rc.codes };
    },
    // A staff member changes their own password (personal accounts; the shared and owner passwords live in Vercel).
    'POST /api/auth/password': async (req, body) => {
      const s = sessionFromRequest(req); if (!s || !s.user) throw new HttpError(409, 'This sign-in uses a shared password: it is changed in Vercel by the owner. Ask the owner for a personal account.');
      const u = await staff.verify(s.user, String(body.current || '')); if (!u) throw new HttpError(401, 'Your current password is not right.');
      const next = String(body.next || ''); if (next === String(body.current)) throw new HttpError(400, 'Choose a different password.'); if (next.toLowerCase().includes(s.user)) throw new HttpError(400, 'The password should not contain your username.');
      const rec = await load(`user:${s.user}`); if (rec && rec.enabled) await checkCode(`user:${s.user}`, body.code);
      await staff.setPassword(s.user, next); await log(s.staffName, s.role, 'password changed'); return { ok: true, token: sessionFor({ id: `user:${s.user}`, role: s.role, name: s.staffName, user: s.user, mfa: s.mfa === 1 }) };
    },
    // "Forgot password": always the same answer (so it does not show which accounts exist); a link is emailed only when the account has an address.
    'POST /api/auth/forgot': async (req, body) => {
      const name = String(body.username || '').trim().toLowerCase(), key = `cg:rl:forgot:${clientIp(req)}`; if (await peek(key) >= 5) throw new HttpError(429, 'Too many requests. Try again in 15 minutes.'); await counter(key, 900);
      const generic = { ok: true, message: 'If that account has an email address on file, a reset link has been sent. If not, ask the owner to reset it.' }, u = name ? await staff.get(name) : null;
      if (!u || !u.email || !mail) return generic;
      const token = crypto.randomBytes(32).toString('base64url'); await redis([['SET', K.reset + sha(token), JSON.stringify({ user: u.username, exp: now() + 30 * 60000 }), 'EX', '1800']]);
      try { await mail.sendDirect({ to: u.email, name: u.name, subject: 'Reset your CRYO-GEN staff password', body: `Hi {first},\n\nSomeone (hopefully you) asked to reset the password for your CRYO-GEN staff account.\n\n[Choose a new password](${siteUrl}/?reset=${token})\n\nThe link works once and for 30 minutes. If you did not ask for this, ignore this email: your password has not changed.\n\nTeam CRYO-GEN` }); await log(u.name, u.role, 'password reset link sent'); } catch (e) { /* email off: the owner can reset it */ }
      return generic;
    },
    'POST /api/auth/reset': async (req, body) => {
      const key = `cg:rl:reset:${clientIp(req)}`; if (await peek(key) >= 10) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
      const h = K.reset + sha(String(body.token || '')), rec = parse((await redis([['GET', h]]))[0]); if (!rec || rec.exp < now()) { await counter(key, 900); throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.'); }
      const u = await staff.get(rec.user); if (!u) throw new HttpError(400, 'This account no longer exists.');
      const t = await load(`user:${rec.user}`); if (t && t.enabled) await checkCode(`user:${rec.user}`, body.code);
      const next = String(body.password || ''); if (next.toLowerCase().includes(rec.user)) throw new HttpError(400, 'The password should not contain your username.');
      await staff.setPassword(rec.user, next, { mustChange: false }); await redis([['DEL', h]]); await log(u.name, u.role, 'password reset with an emailed link'); return { ok: true };
    },
    // ── The owner looks after everyone else's access ──
    'GET /api/auth/overview': async req => {
      requireRole(req, ['admin']); const [twofa] = await redis([['HGETALL', K.twofa]]), on = new Set(); for (let i = 0; i < (twofa || []).length; i += 2) { const r = parse(twofa[i + 1]); if (r && r.enabled) on.add(twofa[i]); }
      const users = (await staff.list()).map(u => ({ username: u.username, name: u.name, role: u.role, email: u.email || '', mustChange: u.mustChange === true, twofa: on.has(`user:${u.username}`) })).sort((a, b) => a.name.localeCompare(b.name));
      return { settings: await settings(), owner: { twofa: on.has('owner'), bypass: ownerBypass() }, users, shared: { admin: !!env.ADMIN_PASSWORD, mod: !!env.MOD_PASSWORD }, mailOn: !!mail };
    },
    'POST /api/auth/settings': async (req, body) => {
      const cur = await settings(), n = { requireStaff2fa: body.requireStaff2fa === undefined ? cur.requireStaff2fa : body.requireStaff2fa === true, blockShared: { admin: body.blockShared ? body.blockShared.admin === true : cur.blockShared.admin, mod: body.blockShared ? body.blockShared.mod === true : cur.blockShared.mod } };
      if (n.blockShared.admin || n.blockShared.mod) { const users = await staff.list(); if (!users.some(u => u.role === 'admin')) throw new HttpError(409, 'Make a personal Administrator account first, or you would lock everyone out.'); }
      await redis([['SET', K.settings, JSON.stringify(n)]]); await log('Owner', 'admin', 'sign-in settings changed'); return { settings: n };
    },
    'POST /api/auth/admin/reset-password': async (req, body) => {
      const u = await staff.get(String(body.username || '')); if (!u) throw new HttpError(404, 'There is no such account.');
      const temp = crypto.randomBytes(9).toString('base64url'); await staff.setPassword(u.username, temp, { mustChange: true }); await log('Owner', 'admin', `reset the password of ${u.username}`); return { username: u.username, temporaryPassword: temp, note: 'Give this to them securely. It works once for signing in; they must choose their own password straight away.' };
    },
    'POST /api/auth/admin/reset-2fa': async (req, body) => {
      const id = body.username === 'owner' ? 'owner' : `user:${String(body.username || '').toLowerCase()}`; if (id !== 'owner' && !(await staff.get(id.slice(5)))) throw new HttpError(404, 'There is no such account.');
      await redis([['HDEL', K.twofa, id]]); await log('Owner', 'admin', `reset the authenticator of ${id.replace(/^user:/, '')}`); return { ok: true };
    },
    'POST /api/auth/admin/email': async (req, body) => {
      const email = String(body.email || '').trim().toLowerCase(); if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) throw new HttpError(400, 'That is not an email address.');
      await staff.patch(String(body.username || ''), { email }); await log('Owner', 'admin', `set the email of ${body.username}`); return { ok: true };
    },
  };
  return { routes, afterPassword, blockedShared, settings, checkCode, readChallenge };
};
