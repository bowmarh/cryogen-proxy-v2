'use strict';
// Creating a WordPress account for a person who asked to join. Off until the owner switches it on; then, for a join request, an administrator can
// PREVIEW what would be created and press a button to create it. It uses the standard WordPress users endpoint with the same login the member
// records use, makes a "subscriber" account with a long random password nobody sees (the person sets their own with "Lost your password?"), and reads
// the account back to check it exists. It does not set the member plugin's own fields (Zwift ID, tier): staff do that in WordPress, because the plugin's
// fields are not documented. Nothing is ever deleted or changed on an existing account.
const crypto = require('crypto');

module.exports = function createWpSync({ redis, HttpError, requireRole, join, wpSite, wpAuth, discord = async () => false, fetchImpl = (...a) => fetch(...a) }) {
  const SETTINGS = 'cg:wpsync:settings';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const settings = async () => ({ on: false, ...(parse((await redis([['GET', SETTINGS]]))[0]) || {}) });
  const hdr = () => ({ Authorization: `Basic ${Buffer.from(wpAuth()).toString('base64')}`, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cryogen-proxy/2.0' });
  const slug = n => String(n || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 30) || 'member';
  async function wp(path, opts = {}) {
    if (!wpAuth()) throw new HttpError(409, 'WordPress is not connected (WP_API_USER / WP_API_APP_PASSWORD).');
    let r, d; try { r = await fetchImpl(`${wpSite()}/wp-json/wp/v2${path}`, { ...opts, headers: hdr(), signal: AbortSignal.timeout(20000) }); d = await r.json().catch(() => ({})); } catch (e) { throw new HttpError(502, 'WordPress could not be reached.'); }
    if (!r.ok) throw new HttpError(502, `WordPress refused it (${r.status}${d.code ? ', ' + d.code : ''}${d.message ? ': ' + String(d.message).slice(0, 120) : ''}).`);
    return d;
  }
  async function find(email) { const list = await wp(`/users?context=edit&search=${encodeURIComponent(email)}&_fields=id,username,email,name`); return (Array.isArray(list) ? list : []).find(u => String(u.email).toLowerCase() === String(email).toLowerCase()) || null; }
  async function request(id) { const r = (await join.list()).find(x => x.id === String(id)); if (!r) throw new HttpError(404, 'That join request is not there.'); return r; }
  async function plan(id) {
    const r = await request(id), existing = await find(r.email); let username = slug(r.name);
    if (!existing) { for (let i = 0; i < 20; i++) { const probe = i ? `${username}${i + 1}` : username; const hit = await wp(`/users?context=edit&search=${encodeURIComponent(probe)}&_fields=id,username`); if (!(Array.isArray(hit) ? hit : []).some(u => String(u.username).toLowerCase() === probe)) { username = probe; break; } } }
    return { request: { id: r.id, name: r.name, email: r.email }, exists: !!existing, existingId: existing ? existing.id : null, username: existing ? existing.username : username, role: 'subscriber', note: existing ? 'A WordPress account with this email already exists: nothing will be created.' : 'A WordPress account will be created. The person sets their own password with "Lost your password?" on cryogen.team. Add their Zwift ID and tier in WordPress afterwards.' };
  }
  async function create(id) {
    if (!(await settings()).on) throw new HttpError(409, 'WordPress account creation is switched off (the owner can turn it on).');
    const p = await plan(id); if (p.exists) { await join.update(id, { wpUserId: p.existingId, wpLinked: true }); return { created: false, linked: true, userId: p.existingId }; }
    const made = await wp('/users', { method: 'POST', body: JSON.stringify({ username: p.username, email: p.request.email, name: p.request.name, password: crypto.randomBytes(24).toString('base64url'), roles: ['subscriber'] }) });
    const back = await find(p.request.email); if (!back) throw new HttpError(502, 'WordPress said it created the account but it cannot be found: check WordPress before trying again.');
    await join.update(id, { wpUserId: back.id, wpCreatedAt: new Date().toISOString() });
    await discord('admin', { content: `🧩 A WordPress account was created for ${p.request.name} (${p.username}). Add their Zwift ID and tier in WordPress.` }).catch(() => {});
    return { created: true, userId: back.id, username: p.username };
  }
  const routes = {
    'GET /api/wpsync': async req => { requireRole(req, ['admin', 'mod']); return { settings: await settings(), connected: !!wpAuth() }; },
    'POST /api/wpsync/settings': async (req, body) => { requireRole(req, ['admin']); const n = { on: body.on === true }; await redis([['SET', SETTINGS, JSON.stringify(n)]]); return { settings: n }; },
    'POST /api/wpsync/plan': async (req, body) => { requireRole(req, ['admin']); return plan(String(body.id || '')); },
    'POST /api/wpsync/create': async (req, body) => { requireRole(req, ['admin']); return create(String(body.id || '')); },
  };
  return { routes, plan, create, settings };
};
