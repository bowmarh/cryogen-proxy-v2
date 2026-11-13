'use strict';
// Discord roles follow the membership level on cryogen.team. A verified Discord account (linked by the rider and confirmed by the bot) gets:
//   - the Full member role when the member record is active and full,
//   - the Associate role when it is active and associate ('half' in WordPress),
//   - neither role when the member has left or is suspended (the off-boarding "removed from Discord roles" step).
// Only these two roles are ever added or removed; every other role a person has is left alone, and nobody without a verified link is touched.
// Settings (Vercel): DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_ROLE_FULL, DISCORD_ROLE_ASSOCIATE (role IDs: Server Settings → Roles → right-click →
// Copy Role ID, with Developer Mode on). The bot needs "Manage Roles", and its own role must sit ABOVE both roles in the role list.
// Staff preview the changes, an administrator applies them; with "automatic" switched on they are applied on the scheduled run and right after
// cryogen.team reports a member change. At most MAX_CHANGES are made per run, so a large first sync spreads over a few runs.
module.exports = function createDiscordRoles({ redis, HttpError, requireRole, fetchRoster, uniqueMembers, normTier, comms, logChange = async () => {}, fetchImpl = (...a) => fetch(...a), discord = async () => false }) {
  const API = 'https://discord.com/api/v10', SETTINGS = 'cg:droles:settings', LAST = 'cg:droles:last', MAX_CHANGES = 40;
  const env = () => ({ bot: process.env.DISCORD_BOT_TOKEN || '', guild: process.env.DISCORD_GUILD_ID || '', full: process.env.DISCORD_ROLE_FULL || '', assoc: process.env.DISCORD_ROLE_ASSOCIATE || '' });
  const isId = v => /^\d{15,25}$/.test(String(v || ''));
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const settings = async () => ({ auto: false, ...(parse((await redis([['GET', SETTINGS]]))[0]) || {}) });
  function configured() {
    const e = env(), missing = [];
    if (!e.bot) missing.push('DISCORD_BOT_TOKEN'); if (!isId(e.guild)) missing.push('DISCORD_GUILD_ID');
    if (!isId(e.full)) missing.push('DISCORD_ROLE_FULL'); if (!isId(e.assoc)) missing.push('DISCORD_ROLE_ASSOCIATE');
    return { ok: !missing.length, missing };
  }
  const hdr = () => ({ Authorization: `Bot ${env().bot}`, 'User-Agent': 'cryogen-proxy/2.0', 'X-Audit-Log-Reason': 'CRYO-GEN club app: membership level sync' });

  async function guildRoles() {   // Discord user ID -> Set of role IDs, for everyone in the server
    const e = env(), out = new Map(); let after = '0';
    for (let page = 0; page < 5; page++) {
      const r = await fetchImpl(`${API}/guilds/${e.guild}/members?limit=1000&after=${after}`, { headers: hdr(), signal: AbortSignal.timeout(5000) });
      if (r.status === 403) throw new HttpError(409, 'Discord refused the member list: turn on Server Members Intent for the bot (Developer Portal → Bot) and check it is in the server.');
      if (!r.ok) throw new HttpError(502, `Discord answered ${r.status} for the member list.`);
      const list = await r.json();
      for (const m of list) if (m.user) out.set(String(m.user.id), new Set((m.roles || []).map(String)));
      if (list.length < 1000) break;
      after = String(list[list.length - 1].user.id);
    }
    return out;
  }

  // What should change: one row per verified, linked member whose roles do not match their membership.
  async function plan() {
    const c = configured(); if (!c.ok) throw new HttpError(409, `Discord role sync is not set up: add ${c.missing.join(', ')} in Vercel.`);
    const e = env();
    const [roster, links, inGuild] = await Promise.all([fetchRoster(), comms.verifiedDiscordIds(), guildRoles()]);
    if (!Array.isArray(roster.members)) throw new HttpError(503, 'Member records from cryogen.team are not available right now, so roles are left as they are.');
    const members = new Map(uniqueMembers(roster.members).map(m => [String(m.zwift_id), m]));
    const changes = [], notInServer = [];
    for (const [zwid, discordId] of links) {
      const m = members.get(zwid); if (!m) continue;   // a link without a member record: leave their roles alone
      const have = inGuild.get(discordId); if (!have) { notInServer.push({ zwid, name: m.name }); continue; }
      const active = m.status === 'active', tier = normTier(m.tier);
      const want = { [e.full]: active && tier === 'full', [e.assoc]: active && tier === 'associate' };
      const add = Object.keys(want).filter(r => want[r] && !have.has(r)), remove = Object.keys(want).filter(r => !want[r] && have.has(r));
      if (add.length || remove.length) changes.push({ zwid, name: m.name, discordId, status: m.status, tier, add, remove,
        summary: [...add.map(r => `+${r === e.full ? 'Full' : 'Associate'}`), ...remove.map(r => `−${r === e.full ? 'Full' : 'Associate'}`)].join(' ') });
    }
    return { changes, notInServer, linked: links.size, roles: { full: e.full, associate: e.assoc } };
  }

  async function apply(who = 'staff') {
    const p = await plan(), e = env(), done = [], failed = [];
    for (const ch of p.changes.slice(0, MAX_CHANGES)) {
      try {
        for (const r of ch.add) { const x = await fetchImpl(`${API}/guilds/${e.guild}/members/${ch.discordId}/roles/${r}`, { method: 'PUT', headers: hdr(), signal: AbortSignal.timeout(5000) }); if (!x.ok) throw new Error(x.status === 403 ? 'the bot needs Manage Roles and must sit above this role' : `Discord answered ${x.status}`); }
        for (const r of ch.remove) { const x = await fetchImpl(`${API}/guilds/${e.guild}/members/${ch.discordId}/roles/${r}`, { method: 'DELETE', headers: hdr(), signal: AbortSignal.timeout(5000) }); if (!x.ok && x.status !== 404) throw new Error(x.status === 403 ? 'the bot needs Manage Roles and must sit above this role' : `Discord answered ${x.status}`); }
        done.push({ zwid: ch.zwid, name: ch.name, summary: ch.summary });
      } catch (err) { failed.push({ zwid: ch.zwid, name: ch.name, summary: ch.summary, error: err.message }); }
    }
    const result = { at: new Date().toISOString(), by: who, done: done.length, failed, left: Math.max(0, p.changes.length - MAX_CHANGES) };
    await redis([['SET', LAST, JSON.stringify(result)]]).catch(() => {});
    if (failed.length) await discord('admin', { content: `⚠️ Discord role sync: ${failed.length} change${failed.length === 1 ? '' : 's'} failed (${failed[0].error}). See Comms → Discord roles.` }).catch(() => {});
    return { ...result, applied: done };
  }

  // Automatic runs: the scheduled job and right after cryogen.team reports a member change. Quiet when switched off or not set up.
  async function autoRun(reason) {
    if (!configured().ok || !(await settings()).auto) return [];
    const r = await apply(`auto (${reason})`);
    return r.done || r.failed.length ? [`Discord roles: ${r.done} updated${r.failed.length ? `, ${r.failed.length} failed` : ''}`] : [];
  }

  const routes = {
    'GET /api/discord/roles': async req => {
      requireRole(req, ['admin', 'mod']);
      const c = configured(), s = await settings(), last = parse((await redis([['GET', LAST]]))[0]);
      if (!c.ok) return { configured: false, missing: c.missing, settings: s, last };
      return { configured: true, settings: s, last, ...(await plan()) };
    },
    'POST /api/discord/roles/apply': async req => { requireRole(req, ['admin']); const r = await apply('admin'); await logChange(req, '/api/discord/roles/apply', { done: r.done, failed: r.failed.length }, { staffOnly: true }).catch(() => {}); return r; },
    'POST /api/discord/roles/settings': async (req, body) => { requireRole(req, ['admin']); const s = { auto: body.auto === true }; await redis([['SET', SETTINGS, JSON.stringify(s)]]); return { settings: s }; },
  };
  return { plan, apply, autoRun, configured, settings, routes };
};
