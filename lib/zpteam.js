'use strict';
// ZwiftPower team check: which club members are not on the Team CRYO-GEN team on ZwiftPower, and a nudge asking them to join.
// ZwiftRacing.app builds the club roster (club 2740) from ZwiftPower team membership, so a member with a Zwift ID who is not in that roster has
// not joined (or has left) the ZwiftPower team. Staff see the list with each rider's ZwiftPower profile link and can send a short invitation by
// email (a service email: it reaches members who opted out of newsletters, because ZRL results need the ZwiftPower team) and/or a Discord direct
// message. Each rider is nudged at most once every NUDGE_GAP_DAYS, so repeated clicks never spam anyone. Every nudge is recorded.
module.exports = function createZpTeam({ redis, HttpError, requireRole, fetchRoster, uniqueMembers, normTier, mail, comms, logChange = async () => {}, teamId = process.env.ZWIFTPOWER_TEAM_ID || '2740' }) {
  const NUDGES = 'cg:zpteam:nudges', NUDGE_GAP_DAYS = 14, DAY = 86400000, MAX = 50;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const profileUrl = z => `https://zwiftpower.com/profile.php?z=${encodeURIComponent(z)}`;
  const teamUrl = `https://zwiftpower.com/team.php?id=${encodeURIComponent(teamId)}`;
  const pairs = flat => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = parse(flat[i + 1]); return o; };

  async function list() {
    const roster = await fetchRoster();
    if (!Array.isArray(roster.members)) throw new HttpError(503, 'Member records from cryogen.team are not available right now, so the check cannot run.');
    const onTeam = new Set(roster.riders.map(r => String(r.riderId)));
    const [raw] = await redis([['HGETALL', NUDGES]]); const nudged = pairs(raw);
    const missing = uniqueMembers(roster.members)
      .filter(m => m.status === 'active' && /^\d+$/.test(String(m.zwift_id)) && !onTeam.has(String(m.zwift_id)))
      .map(m => { const z = String(m.zwift_id), n = nudged[z] || null;
        return { zwid: z, name: m.name, tier: normTier(m.tier), profile: profileUrl(z), lastNudge: n && n.at || null, nudges: n && n.count || 0,
          canNudge: !n || Date.now() - Date.parse(n.at) >= NUDGE_GAP_DAYS * DAY };
      })
      .sort((a, b) => (a.tier === b.tier ? String(a.name).localeCompare(String(b.name)) : a.tier === 'full' ? -1 : 1));
    return { teamUrl, onTeam: onTeam.size, missing, rosterUpdatedAt: roster.ridersUpdatedAt ? new Date(roster.ridersUpdatedAt).toISOString() : null, stale: !!roster.ridersStale,
      note: 'Riders appear here when they have a Zwift ID on cryogen.team but are not in the ZwiftPower team list that ZwiftRacing.app reads. New joiners can take up to a day to show.' };
  }

  const message = name => ({
    subject: 'Please join Team CRYO-GEN on ZwiftPower',
    email: `Hi ${name || 'there'},\n\nYou're a CRYO-GEN member, but you're not on the Team CRYO-GEN team on ZwiftPower yet. Joining matters: your races count for the club, you show in our ZRL and league line-ups, and the club stats include you.\n\nIt takes a minute:\n1. Sign in at zwiftpower.com.\n2. Open ${teamUrl}\n3. Click "Join team" (or "Request to join") and we'll approve it.\n4. Also set CRYO-GEN as your club in the Zwift Companion app, so your name tag shows the club.\n\nAlready done it? Thanks: it can take a day for the change to reach us.\n\nRide on,\nCRYO-GEN`,
    discord: `👋 Hi ${name || 'there'}, you're not on **Team CRYO-GEN on ZwiftPower** yet. Please join so your races count for the club and you show in ZRL line-ups: sign in at zwiftpower.com, open ${teamUrl} and click "Join team". Already done? Thanks, it can take a day to reach us.`,
  });

  async function nudge(req, body) {
    requireRole(req, ['admin', 'mod']);
    const zwids = [...new Set((Array.isArray(body.zwids) ? body.zwids : []).map(String))].filter(z => /^\d+$/.test(z));
    if (!zwids.length) throw new HttpError(400, 'Pick at least one rider.');
    if (zwids.length > MAX) throw new HttpError(400, `Nudge at most ${MAX} riders at a time.`);
    const via = Array.isArray(body.via) ? body.via.filter(v => v === 'email' || v === 'discord') : ['email', 'discord'];
    if (!via.length) throw new HttpError(400, 'Choose email, Discord or both.');
    const { missing } = await list(), byId = new Map(missing.map(m => [m.zwid, m]));
    const results = [];
    for (const z of zwids) {
      const m = byId.get(z);
      if (!m) { results.push({ zwid: z, ok: false, error: 'already on the ZwiftPower team, or not an active member' }); continue; }
      if (!m.canNudge) { results.push({ zwid: z, name: m.name, ok: false, error: `already nudged on ${m.lastNudge.slice(0, 10)}; wait ${NUDGE_GAP_DAYS} days between nudges` }); continue; }
      const msg = message(m.name), sent = [], errors = [];
      if (via.includes('email')) { try { await mail.sendTo({ zwid: z, subject: msg.subject, body: msg.email, category: 'service' }); sent.push('email'); } catch (e) { errors.push(`email: ${e.message}`); } }
      if (via.includes('discord')) { try { if (await comms.notify(z, msg.discord, { kind: 'club', key: `zpteam:${z}:${new Date().toISOString().slice(0, 10)}` })) sent.push('discord'); else errors.push('discord: no verified Discord link, or they switched these messages off'); } catch (e) { errors.push(`discord: ${e.message}`); } }
      if (sent.length) await redis([['HSET', NUDGES, z, JSON.stringify({ at: new Date().toISOString(), count: m.nudges + 1, via: sent })]]);
      results.push({ zwid: z, name: m.name, ok: sent.length > 0, sent, error: errors.join('; ') || undefined });
    }
    await logChange(req, '/api/zpteam/nudge', { count: zwids.length, sent: results.filter(r => r.ok).length, via }, { staffOnly: true }).catch(() => {});
    return { results, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length };
  }

  return { list, nudge, teamUrl, routes: {
    'GET /api/zpteam': async req => { requireRole(req, ['admin', 'mod']); return list(); },
    'POST /api/zpteam/nudge': nudge,
  } };
};
