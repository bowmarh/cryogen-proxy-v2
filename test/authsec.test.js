'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const totp = require('../lib/totp');

h.setEnv({ HOSTINGER_MAIL_TOKEN: 'mail-token', HOSTINGER_MAIL_MAILBOX_ID: 'mbx_1' });
let app, world, owner;
before(async () => { world = h.createWorld(); app = await h.startApp(world); });
after(() => { Date.now = realNow; return app.close(); });
beforeEach(async () => { app.world.db = {}; world.mails = []; world.mailFail = 0; delete process.env.OWNER_2FA_OFF; owner = (await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).body.token; });
const post = (p, b, t) => app.post(p, b, { token: t });
const secretOf = s => s.replace(/\s/g, '');
const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;   // each call moves the clock one step on so a code is never the same as the last one used
const nextCode = secret => { skew += 30000; return totp.code(secret, Date.now()); };

async function enrol(token, challenge) {
  const body = challenge ? { challenge } : {}, setup = await post('/api/auth/totp/setup', body, challenge ? undefined : token); assert.equal(setup.status, 200, JSON.stringify(setup.body));
  const secret = secretOf(setup.body.secret); const en = await post('/api/auth/totp/enable', { ...body, code: totp.code(secret, Date.now()) }, challenge ? undefined : token); assert.equal(en.status, 200, JSON.stringify(en.body));
  return { secret, setup: setup.body, enabled: en.body };
}

test('the owner turns on an authenticator: a QR code and typed key, a confirming code, ten recovery codes once; the next sign-in needs a code', async () => {
  const sec = await app.get('/api/auth/security', { token: owner }); assert.deepEqual([sec.body.level, sec.body.kind, sec.body.totp.enabled], ['Owner', 'owner', false]);
  const { secret, setup, enabled } = await enrol(owner); assert.match(setup.svg, /^<svg/); assert.match(setup.otpauth, /^otpauth:\/\/totp\/CRYO-GEN%20Owner:Owner\?secret=[A-Z2-7]{32}&issuer=CRYO-GEN%20Owner/); assert.match(setup.secret, /^([A-Z2-7]{4} ){7}[A-Z2-7]{4}$/); assert.equal(enabled.recoveryCodes.length, 10); assert.match(enabled.recoveryCodes[0], /^[0-9a-f]{4}-[0-9a-f]{4}$/);
  assert.equal((await post('/api/auth/totp/setup', {}, owner)).status, 409, 'it is already on');
  const step1 = await app.post('/api/login', { role: 'owner', password: 'owner-pw' }); assert.equal(step1.status, 200); assert.equal(step1.body.twoFactor, true); assert.equal(step1.body.token, undefined, 'the password alone gives no session'); assert.ok(step1.body.challenge);
  assert.equal((await app.get('/api/access/me', { token: step1.body.challenge })).status, 401, 'a sign-in challenge is not a session');
  assert.equal((await post('/api/auth/2fa', { challenge: step1.body.challenge, code: '000000' })).status, 401); assert.equal((await post('/api/auth/2fa', { challenge: 'garbage', code: '1' })).status, 401);
  assert.equal((await post('/api/auth/2fa', { challenge: step1.body.challenge, code: totp.code(secret, Date.now()) })).status, 401, 'the code used to turn it on cannot be used again');
  const ok = await post('/api/auth/2fa', { challenge: step1.body.challenge, code: nextCode(secret) }); assert.equal(ok.status, 200); assert.deepEqual([ok.body.role, ok.body.owner], ['admin', true]); assert.equal((await app.get('/api/access/me', { token: ok.body.token })).body.level, 'Owner');
  assert.equal((await app.get('/api/auth/security', { token: ok.body.token })).body.totp.recoveryLeft, 10);
});

test('a recovery code signs in once and is then gone; the break-glass setting lets the owner in without a code; turning it off needs a code', async () => {
  const { secret, enabled } = await enrol(owner), rc = enabled.recoveryCodes[0];
  const c1 = (await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).body.challenge; const r1 = await post('/api/auth/2fa', { challenge: c1, code: rc }); assert.equal(r1.status, 200); assert.equal(r1.body.recoveryLeft, 9);
  const c2 = (await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).body.challenge; assert.equal((await post('/api/auth/2fa', { challenge: c2, code: rc })).status, 401, 'a recovery code works once');
  process.env.OWNER_2FA_OFF = '1'; const bypass = await app.post('/api/login', { role: 'owner', password: 'owner-pw' }); assert.ok(bypass.body.token, 'break-glass: password only'); assert.equal((await app.get('/api/auth/security', { token: bypass.body.token })).body.owner2faBypass, true); delete process.env.OWNER_2FA_OFF;
  assert.equal((await post('/api/auth/totp/disable', { code: '111111' }, owner)).status, 401); assert.equal((await post('/api/auth/totp/disable', { code: nextCode(secret) }, owner)).status, 200); assert.equal((await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).body.twoFactor, undefined);
  const again = await enrol(owner); const rec = await post('/api/auth/totp/recovery', { code: nextCode(again.secret) }, owner); assert.equal(rec.body.recoveryCodes.length, 10); assert.notDeepEqual(rec.body.recoveryCodes, again.enabled.recoveryCodes, 'new codes replace the old ones');
});

test('wrong codes are limited, and the stored secret is encrypted (never the plain key)', async () => {
  const { secret } = await enrol(owner), c = (await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).body.challenge; let last = 0;
  for (let i = 0; i < 10; i++) last = (await post('/api/auth/2fa', { challenge: c, code: String(100000 + i) })).status; assert.equal(last, 429, 'too many wrong codes');
  const stored = JSON.stringify(world.db['cg:auth:twofa']); assert.ok(!stored.includes(secret) && !stored.includes(secret.slice(0, 12)), 'the secret is not stored in the clear'); assert.ok(world.db['cg:auth:key'], 'an encryption key was made once');
  assert.equal((await post('/api/auth/2fa', { challenge: c, code: nextCode(secret) })).status, 429, 'and a locked account stays locked for the window');
});

test('personal accounts: a new one must choose its own password; the owner can require an authenticator and set it up at sign-in; the shared passwords can be switched off', async () => {
  assert.equal((await post('/api/staff', { username: 'ann', name: 'Ann Lee', role: 'admin', password: 'start-pass-123' }, owner)).status, 200);
  const first = await app.post('/api/login', { username: 'ann', password: 'start-pass-123' }); assert.equal(first.body.mustChange, true); assert.equal((await app.get('/api/week', { token: first.body.token })).body.mustChange, true);
  assert.equal((await post('/api/auth/password', { current: 'wrong', next: 'chosen-pass-456' }, first.body.token)).status, 401); assert.equal((await post('/api/auth/password', { current: 'start-pass-123', next: 'start-pass-123' }, first.body.token)).status, 400); assert.equal((await post('/api/auth/password', { current: 'start-pass-123', next: 'ann-pass-1234' }, first.body.token)).status, 400, 'not the username');
  const ch = await post('/api/auth/password', { current: 'start-pass-123', next: 'chosen-pass-456' }, first.body.token); assert.equal(ch.status, 200); assert.equal((await app.get('/api/week', { token: ch.body.token })).status, 200, 'usable once the password is chosen');
  assert.equal((await post('/api/auth/settings', { requireStaff2fa: true }, ch.body.token)).status, 403, 'only the owner changes the sign-in rules'); assert.equal((await post('/api/auth/settings', { requireStaff2fa: true }, owner)).status, 200);
  const l = await app.post('/api/login', { username: 'ann', password: 'chosen-pass-456' }); assert.equal(l.body.needsSetup, true); assert.equal(l.body.token, undefined);
  assert.equal((await app.get('/api/week', { token: l.body.challenge })).status, 401);
  const { enabled } = await enrol(null, l.body.challenge); assert.ok(enabled.token, 'finishing the setup signs them in'); assert.equal((await app.get('/api/week', { token: enabled.token })).status, 200); assert.equal(enabled.recoveryCodes.length, 10);
  assert.equal((await post('/api/auth/totp/disable', { code: '123456' }, enabled.token)).status, 409, 'cannot be turned off while it is required');
  assert.equal((await app.post('/api/login', { role: 'admin', password: 'admin-pw' })).status, 200, 'the shared password still works'); assert.equal((await post('/api/auth/settings', { blockShared: { admin: true } }, owner)).status, 200);
  const blocked = await app.post('/api/login', { role: 'admin', password: 'admin-pw' }); assert.equal(blocked.status, 403); assert.match(blocked.body.error, /switched off/); assert.equal((await app.post('/api/login', { role: 'mod', password: 'mod-pw' })).status, 200, 'only the one that was switched off');
  const solo = await app.post('/api/login', { role: 'owner', password: 'owner-pw' }); assert.ok(solo.body.token || solo.body.challenge);
});

test('the owner cannot switch off the shared passwords before a personal Administrator exists', async () => { assert.equal((await post('/api/auth/settings', { blockShared: { admin: true } }, owner)).status, 409); });

test('forgotten staff password: an emailed single-use link (30 minutes), the same answer for unknown accounts, and a code is still needed if there is an authenticator', async () => {
  assert.equal((await post('/api/mail/settings', { enabled: true }, owner)).status, 200);
  await post('/api/staff', { username: 'bob', name: 'Bo Dunn', role: 'mod', password: 'start-pass-123' }, owner); assert.equal((await post('/api/auth/admin/email', { username: 'bob', email: 'Bo@Example.com' }, owner)).status, 200); assert.equal((await post('/api/auth/admin/email', { username: 'bob', email: 'nope' }, owner)).status, 400);
  const unknown = await post('/api/auth/forgot', { username: 'nobody' }), known = await post('/api/auth/forgot', { username: 'BOB' }); assert.deepEqual(unknown.body, known.body, 'the answer does not show which accounts exist'); assert.equal(world.mails.length, 1); assert.equal(world.mails[0].to[0], 'bo@example.com');
  const link = /\?reset=([\w-]+)/.exec(world.mails[0].text)[1]; assert.match(world.mails[0].text, /works once and for 30 minutes/);
  assert.equal((await post('/api/auth/reset', { token: 'wrong-token', password: 'brand-new-pass-1' })).status, 400); assert.equal((await post('/api/auth/reset', { token: link, password: 'short' })).status, 400, 'too short'); assert.equal((await post('/api/auth/reset', { token: link, password: 'bob-secret-pass' })).status, 400, 'not the username');
  const done = await post('/api/auth/reset', { token: link, password: 'brand-new-pass-1' }); assert.equal(done.status, 200); assert.equal((await app.post('/api/login', { username: 'bob', password: 'brand-new-pass-1' })).body.mustChange, false, 'they chose it themselves'); assert.equal((await app.post('/api/login', { username: 'bob', password: 'start-pass-123' })).status, 401);
  assert.equal((await post('/api/auth/reset', { token: link, password: 'another-pass-77' })).status, 400, 'the link works once');
  const bo = (await app.post('/api/login', { username: 'bob', password: 'brand-new-pass-1' })).body.token, { secret } = await enrol(bo); world.mails.length = 0; await post('/api/auth/forgot', { username: 'bob' }); const link2 = /\?reset=([\w-]+)/.exec(world.mails[0].text)[1];
  assert.equal((await post('/api/auth/reset', { token: link2, password: 'second-new-pass-2' })).status, 401, 'with an authenticator the code is needed as well'); assert.equal((await post('/api/auth/reset', { token: link2, password: 'second-new-pass-2', code: nextCode(secret) })).status, 200);
  await post('/api/staff', { username: 'noemail', name: 'No Email', role: 'mod', password: 'start-pass-123' }, owner); world.mails.length = 0; await post('/api/auth/forgot', { username: 'noemail' }); assert.equal(world.mails.length, 0, 'no address on file: nothing is sent, the owner resets it');
  let limited = 0; for (let i = 0; i < 8; i++) limited = (await post('/api/auth/forgot', { username: 'bob' })).status; assert.equal(limited, 429);
});

test('the owner resets a password (a temporary one that must be changed) and an authenticator for someone who lost theirs; nobody else can', async () => {
  await post('/api/staff', { username: 'cyd', name: 'Cy Ray', role: 'mod', password: 'start-pass-123' }, owner); const cy = (await app.post('/api/login', { username: 'cyd', password: 'start-pass-123' })).body.token;
  const mine = await post('/api/auth/password', { current: 'start-pass-123', next: 'cy-chosen-pass-9' }, cy), cyTok = mine.body.token, { secret } = await enrol(cyTok); assert.equal((await app.post('/api/login', { username: 'cyd', password: 'cy-chosen-pass-9' })).body.twoFactor, true);
  assert.equal((await post('/api/auth/admin/reset-password', { username: 'cyd' }, cyTok)).status, 403); assert.equal((await post('/api/auth/admin/reset-password', { username: 'cyd' }, await app.login('admin'))).status, 403, 'an administrator is not the owner'); assert.equal((await post('/api/auth/admin/reset-password', { username: 'ghost' }, owner)).status, 404);
  const ov = await app.get('/api/auth/overview', { token: owner }); assert.deepEqual(ov.body.users.map(u => [u.username, u.twofa]), [['cyd', true]]); assert.equal((await app.get('/api/auth/overview', { token: cyTok })).status, 403);
  const reset = await post('/api/auth/admin/reset-password', { username: 'cyd' }, owner); assert.equal(reset.status, 200); assert.ok(reset.body.temporaryPassword.length >= 12); assert.equal((await app.post('/api/login', { username: 'cyd', password: 'cy-chosen-pass-9' })).status, 401, 'the old password stopped working');
  assert.equal((await post('/api/auth/admin/reset-2fa', { username: 'cyd' }, owner)).status, 200); const back = await app.post('/api/login', { username: 'cyd', password: reset.body.temporaryPassword }); assert.equal(back.body.mustChange, true); assert.equal(back.body.twoFactor, undefined, 'the authenticator was reset: no code is asked for');
  assert.equal((await post('/api/auth/admin/reset-2fa', { username: 'ghost' }, owner)).status, 404); assert.equal((await post('/api/auth/admin/reset-2fa', { username: 'owner' }, owner)).status, 200);
  const sharedSec = (await app.get('/api/auth/security', { token: await app.login('admin') })); assert.equal(sharedSec.body.kind, 'shared'); assert.equal(sharedSec.body.canChangePassword, false); assert.equal((await post('/api/auth/password', { current: 'x', next: 'y-long-enough-1' }, await app.login('admin'))).status, 409, 'the shared password is changed in Vercel');
  assert.equal((await app.get('/api/auth/security', { token: await app.memberSession('1002') })).status, 401, 'members have no staff security page');
});

test('the sign-in events are in the audit trail, members are pointed to WordPress for their password, and the sign-in page offers the lost-password link', async () => {
  await enrol(owner); const c = (await app.post('/api/login', { role: 'owner', password: 'owner-pw' })).body.challenge; await post('/api/auth/2fa', { challenge: c, code: '000000' });
  const trail = (await app.get('/api/audit', { token: owner })).body.entries.map(e => e.action); assert.ok(trail.includes('AUTH authenticator turned on'), trail.join('|')); assert.ok(trail.includes('AUTH wrong authenticator code'));
  const rider = await app.memberSession('1002'); const d = await app.get('/api/me/details', { token: rider }); assert.match(d.body.security.lostPasswordUrl, /\/wp-login\.php\?action=lostpassword$/); assert.match(d.body.security.profileUrl, /wp-admin\/profile\.php$/);
  assert.match((await app.get('/api/auth/status')).body.lostPasswordUrl, /action=lostpassword/);
});
