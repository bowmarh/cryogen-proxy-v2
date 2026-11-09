'use strict';
// Who the club can message directly: a rider with a verified Discord link, or a phone registered for notifications. Reach is what makes reminders,
// captain nudges and the Discord commands work, so it is counted, shown to staff, and each rider is shown how to join in. Counts only: no list of names
// goes to anyone but a captain, and then only for their own team.
module.exports = function createReach({ redis, HttpError, memberFromRequest, activeMembers, verifiedLinks, pushKey, discord = async () => false, siteUrl = '' }) {
  const SENT = 'cg:reach:sent';
  const month = ms => new Date(ms).toISOString().slice(0, 7);

  async function sets() {
    const [linked, [subs]] = await Promise.all([verifiedLinks().catch(() => new Set()), redis([['HKEYS', pushKey]]).catch(() => [[]])]);
    return { discord: new Set([...linked].map(String)), push: new Set((subs || []).map(String)) };
  }

  async function stats() {
    const [ids, s] = await Promise.all([activeMembers().catch(() => []), sets()]), total = ids.length;
    const both = ids.filter(z => s.discord.has(String(z)) || s.push.has(String(z))).length;
    const d = ids.filter(z => s.discord.has(String(z))).length, p = ids.filter(z => s.push.has(String(z))).length;
    return { total, reachable: both, discord: d, push: p, pct: total ? Math.round(both / total * 100) : 0, unreachable: total - both };
  }

  // Of these riders, who cannot be messaged (for a captain's own team).
  async function unreachable(zwids) { const s = await sets(); return (zwids || []).map(String).filter(z => !s.discord.has(z) && !s.push.has(z)); }

  async function mine(zwid) { const s = await sets(), z = String(zwid); return { reachable: s.discord.has(z) || s.push.has(z), discord: s.discord.has(z), push: s.push.has(z) }; }

  // Once a month, one line to the admin channel: how far the club's reach has come.
  async function runSchedule(now = Date.now()) {
    if (process.env.REACH_SUMMARY_AUTO === '0') return [];   // lets tests that count Discord posts ignore the monthly line
    const [claimed] = await redis([['HSETNX', SENT, month(now), new Date(now).toISOString()]]);
    if (!claimed) return [];
    const s = await stats(); if (!s.total) return [];
    await discord('admin', { content: `📣 **Reach this month:** ${s.reachable} of ${s.total} active members (${s.pct}%) can be messaged directly (${s.discord} on Discord, ${s.push} with notifications). ${s.unreachable} cannot: asking them to link their Discord is the quickest way to improve every reminder. Details: ${siteUrl}/ → Club health.` }).catch(() => {});
    return ['reach-summary'];
  }

  const routes = { 'GET /api/me/reach': async req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return mine(m.zwid); } };
  return { routes, stats, mine, unreachable, runSchedule };
};
