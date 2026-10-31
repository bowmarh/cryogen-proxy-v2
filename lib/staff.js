'use strict';
// Personal staff accounts: a name, a role (administrator or moderator) and a password of their own, kept as a salted scrypt hash. The shared role
// passwords keep working; a personal login additionally puts the person's name in the session, so the change log shows who did what.
// An account that is removed or changed stops working at the next sign-in; a session already open lasts until it expires (twelve hours).
const crypto = require('crypto');

module.exports = function createStaff({ redis, HttpError, requireRole, text }) {
  const KEY = 'cg:staff:users';   // username (lower case) -> { name, role, salt, hash, at, by }
  const ROLES = ['admin', 'mod'];
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const hashOf = (password, salt) => crypto.scryptSync(String(password), salt, 32).toString('hex');
  const userKey = u => String(u || '').trim().toLowerCase();

  async function verify(username, password) {
    const [raw] = await redis([['HGET', KEY, userKey(username)]]), u = parse(raw);
    // Do the same work whether or not the account exists, so the answer does not show which usernames are real.
    const salt = u ? u.salt : 'x'.repeat(32), given = Buffer.from(hashOf(password, salt), 'hex');
    if (!u || !crypto.timingSafeEqual(given, Buffer.from(u.hash, 'hex'))) return null;
    return { username: userKey(username), name: u.name, role: u.role };
  }

  const routes = {
    'GET /api/staff': async req => {
      requireRole(req, ['admin']);
      const flat = (await redis([['HGETALL', KEY]]))[0] || [], users = [];
      for (let i = 0; i < flat.length; i += 2) { const u = parse(flat[i + 1]); if (u) users.push({ username: flat[i], name: u.name, role: u.role, at: u.at, by: u.by }); }
      return { users: users.sort((a, b) => a.name.localeCompare(b.name)) };
    },
    // Create an account, or change a name, role or password (leave the password out to keep it).
    'POST /api/staff': async (req, body) => {
      requireRole(req, ['admin']);
      const username = userKey(body.username);
      if (!/^[a-z0-9._-]{3,30}$/.test(username)) throw new HttpError(400, 'A username is 3 to 30 letters, numbers, dots, dashes or underscores.');
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'The role is admin or mod.');
      const name = text(body.name, 'name', 40).replace(/[^\p{L}\p{N} .'-]/gu, '').trim();
      if (!name) throw new HttpError(400, 'Give a name for the change log.');
      const [raw] = await redis([['HGET', KEY, username]]), old = parse(raw);
      let { salt, hash } = old || {};
      if (body.password !== undefined && body.password !== '') {
        if (String(body.password).length < 10) throw new HttpError(400, 'A password is at least 10 characters.');
        salt = crypto.randomBytes(16).toString('hex'); hash = hashOf(body.password, salt);
      } else if (!old) throw new HttpError(400, 'A new account needs a password.');
      await redis([['HSET', KEY, username, JSON.stringify({ name, role: body.role, salt, hash, at: new Date().toISOString(), by: 'admin' })]]);
      return { saved: username };
    },
    'POST /api/staff/remove': async (req, body) => {
      requireRole(req, ['admin']);
      const username = userKey(body.username), [n] = await redis([['HDEL', KEY, username]]);
      if (!n) throw new HttpError(404, 'There is no such account.');
      return { removed: username };
    },
  };
  return { routes, verify, KEY };
};
