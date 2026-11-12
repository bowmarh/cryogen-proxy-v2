'use strict';
// Who may do what. One place states the levels, and the server enforces the owner-only part in one spot (a list of routes), so the rules cannot drift.
//
//  Staff levels (sign in with a password):  Owner  >  Administrator  >  Moderator
//    - Owner: the one person who holds OWNER_PASSWORD. Everything an Administrator can do, plus the owner-only list below.
//    - Administrator: runs the club day to day (members, ZRL, email approval and sending, joins, line-ups, results).
//    - Moderator: helps run it (view everything, enter results, draft and check emails, triage feedback); cannot send emails, decide joins or change settings.
//  Members (sign in with a cryogen.team account), each with one type, worked out automatically (an Owner/Administrator can override it):
//    - Social: associates. The weekly TTT / ZRL sign-ups, social rides and their own upgrade page.
//    - Standard: full members who are not currently racing. Every member page and the AI coach.
//    - Racing: full members on a ZRL team or who have raced in the last 90 days. Standard, plus the racing messages (availability asks, line-up news, progress cards).
//    - Captain: any full member who captains a ZRL team gets the team page on top of their type.
const OWNER_ONLY = new Set([
  // Backups, restore and erasing a member's data
  'POST /api/admin/restore', 'POST /api/admin/backup-now', 'GET /api/admin/backup-download', 'POST /api/staff/privacy/erase',
  // Money and budgets (the supporter list, prices and the AI budget)
  'POST /api/support/settings', 'POST /api/support/add', 'POST /api/support/remove',
  // Who has access, and the record of what staff did
  'POST /api/staff', 'POST /api/staff/remove', 'GET /api/audit', 'POST /api/access/override',
  // The switches: email on/off and limits, the radio, the race autopilot, automatic results, progress cards
  'POST /api/mail/settings', 'POST /api/aiops/settings', 'POST /api/aiops/progress-settings', 'POST /api/raceweek/settings', 'POST /api/autoresults/settings',
  // Writing to the club's website and WordPress accounts
  'POST /api/wpsync/settings', 'POST /api/sitefeed/settings',
]);

const MATRIX = [
  // [what, social, standard, racing, captain, moderator, administrator, owner]
  ['See the dashboard, the weekly TTT and ZRL sign-ups and the social rides', 1, 1, 1, 1, 1, 1, 1],
  ['See Racing, TTT Season, Ladder, DIRT Series and the member list', 0, 1, 1, 1, 1, 1, 1],
  ['Use the AI coach and see their own season, calendar and badges', 0, 1, 1, 1, 1, 1, 1],
  ['Get racing messages (availability asks, line-up news, progress cards)', 0, 0, 1, 1, 0, 0, 0],
  ['Invite a friend, send feedback, download or ask to erase their own data', 1, 1, 1, 1, 1, 1, 1],
  ['My details: email choices, preferred first name, and ask for a change or to leave', 1, 1, 1, 1, 0, 0, 0],
  ['My plan: a season-long training plan from their own FTP', 0, 1, 1, 1, 0, 0, 0],
  ['Team page: see their team\'s answers, ask them, propose and set the line-up', 0, 0, 0, 1, 0, 1, 1],
  ['Control room: race day, systems, go-live check, feedback, usage', 0, 0, 0, 0, 1, 1, 1],
  ['Draft and check emails, use the AI desk, preview and download reports', 0, 0, 0, 0, 1, 1, 1],
  ['Enter ZRL results and line-ups, edit members, fair-play tools', 0, 0, 0, 0, 1, 1, 1],
  ['Approve and send emails, decide join requests, apply proposed line-ups, send team reports', 0, 0, 0, 0, 0, 1, 1],
  ['Create a WordPress account for a join request; apply a member\'s request to leave; post standings now', 0, 0, 0, 0, 0, 1, 1],
  ['Turn email, the radio, the race autopilot, automatic results, progress cards, WordPress account creation and website posts on or off; email limits', 0, 0, 0, 0, 0, 0, 1],
  ['Supporter list, prices, the AI budget and Stripe', 0, 0, 0, 0, 0, 0, 1],
  ['Backups: make, download and restore; erase a member\'s data', 0, 0, 0, 0, 0, 0, 1],
  ['Who has access: staff accounts, member type overrides, the audit trail', 0, 0, 0, 0, 0, 0, 1],
];
const LEVELS = ['Social', 'Standard', 'Racing', 'Captain', 'Moderator', 'Administrator', 'Owner'];

module.exports = function createAccess({ redis, HttpError, requireRole, sessionFromRequest, memberFromRequest, zrl, tidy, fetchRoster, now = () => Date.now() }) {
  const KEY = 'cg:access:overrides', TYPES = ['social', 'standard', 'racing'];
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const ownerVersion = () => require('crypto').createHash('sha256').update(String(process.env.OWNER_PASSWORD || '')).digest('hex').slice(0, 10);
  // With no OWNER_PASSWORD set yet, administrators keep the owner's powers (so nothing is locked out before the owner login exists); the Control room says so.
  const isOwner = req => { const s = sessionFromRequest(req); if (!s || s.role !== 'admin') return false; if (!process.env.OWNER_PASSWORD) return true; return s.owner === true && s.ov === ownerVersion(); };
  const ownerOnly = (method, path) => OWNER_ONLY.has(`${method} ${path}`);
  let cache = null;
  // Who counts as racing: on a ZRL team, or raced in the last 90 days (an hour's memory, it changes slowly).
  async function racing() {
    if (cache && now() - cache.at < 3600000) return cache;
    const set = new Set(); let team = new Set(), captains = new Set();
    try { const d = await zrl.load(); if (d.round) { for (const x of d.signups) if (x.in && x.zwid && (d.assign[x.key] || []).length) set.add(String(x.zwid)); captains = new Set(d.round.teams.map(t => String(t.captain || '')).filter(Boolean)); } } catch (e) { /* the team part is skipped */ }
    try {
      const [a, { riders }] = await Promise.all([tidy.analyse(now()), fetchRoster()]), stale = new Set((a.inactive || []).filter(m => m.daysSinceRace === null || m.daysSinceRace > 90).map(m => String(m.zwid)));
      for (const r of riders || []) if (!stale.has(String(r.riderId)) && !(a.inactive || []).some(m => String(m.zwid) === String(r.riderId) && m.daysSinceRace !== null && m.daysSinceRace > 90)) set.add(String(r.riderId));
    } catch (e) { /* the recent-racing part is skipped */ }
    cache = { at: now(), racing: set, captains }; return cache;
  }
  async function overrides() { const [raw] = await redis([['HGETALL', KEY]]), out = {}; for (let i = 0; i < (raw || []).length; i += 2) out[raw[i]] = raw[i + 1]; return out; }
  async function typeOf(zwid, associate) {
    const [o] = await redis([['HGET', KEY, String(zwid)]]); if (TYPES.includes(o)) return { type: o, by: 'override' };
    if (associate) return { type: 'social', by: 'associate' };
    const r = await racing(); return r.racing.has(String(zwid)) ? { type: 'racing', by: 'team or recent racing' } : { type: 'standard', by: 'full member' };
  }
  async function me(req) {
    const s = sessionFromRequest(req); if (!s) throw new HttpError(401, 'Please log in again.');
    if (s.role === 'admin' || s.role === 'mod') { const owner = isOwner(req) && !!process.env.OWNER_PASSWORD; return { level: owner ? 'Owner' : s.role === 'admin' ? 'Administrator' : 'Moderator', staff: true, owner, role: s.role }; }
    const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Please log in again.');
    const t = await typeOf(m.zwid, s.assoc === true), r = await racing(), captain = r.captains.has(String(m.zwid)) && t.type !== 'social';
    return { level: captain ? 'Captain' : t.type[0].toUpperCase() + t.type.slice(1), staff: false, owner: false, role: 'member', type: t.type, typeBy: t.by, captain };
  }
  const routes = {
    'GET /api/access/me': async req => me(req),
    'GET /api/access/matrix': async req => { requireRole(req, ['admin', 'mod']); return { levels: LEVELS, matrix: MATRIX.map(([what, ...v]) => ({ what, allowed: v.map(Boolean) })), ownerOnly: [...OWNER_ONLY] }; },
    // The members and the type each one gets (staff can see it; only the owner can change it).
    'GET /api/access/members': async (req, _b, q = {}) => {
      requireRole(req, ['admin', 'mod']); const term = String(q.q || '').trim().toLowerCase(), o = await overrides(), r = await racing(), { members } = await fetchRoster().catch(() => ({ members: [] })), out = [];
      for (const m of Array.isArray(members) ? members : []) {
        const z = String(m.zwift_id || ''); if (!/^\d+$/.test(z) || String(m.status || '').toLowerCase() === 'left') continue;
        if (term && !String(m.name).toLowerCase().includes(term) && !z.startsWith(term)) continue;
        const assoc = ['associate', 'half'].includes(String(m.tier || '').toLowerCase()), over = TYPES.includes(o[z]) ? o[z] : '';
        out.push({ zwid: z, name: String(m.name || z), type: over || (assoc ? 'social' : r.racing.has(z) ? 'racing' : 'standard'), by: over ? 'override' : assoc ? 'associate' : 'automatic', captain: r.captains.has(z) && (over || (assoc ? 'social' : 'x')) !== 'social' });
        if (out.length >= 60) break;
      }
      return { members: out, overrides: Object.keys(o).length };
    },
    'POST /api/access/override': async (req, body) => {
      if (!isOwner(req)) throw new HttpError(403, 'Only the owner can do this.');
      const z = String(body.zwid || '').replace(/\D/g, ''); if (!z) throw new HttpError(400, 'Choose the member.');
      if (!body.type) { await redis([['HDEL', KEY, z]]); return { ok: true, type: null }; }
      if (!TYPES.includes(body.type)) throw new HttpError(400, 'Choose social, standard or racing (or clear it).');
      await redis([['HSET', KEY, z, body.type]]); cache = null; return { ok: true, type: body.type };
    },
  };
  return { routes, isOwner, ownerOnly, ownerVersion, typeOf, racing, me, OWNER_ONLY, MATRIX, LEVELS };
};
module.exports.OWNER_ONLY = OWNER_ONLY; module.exports.MATRIX = MATRIX; module.exports.LEVELS = LEVELS;
