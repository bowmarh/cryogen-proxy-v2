'use strict';
// Finds the members that need tidying: records for the same person under more than one Zwift ID, records WordPress holds twice or with no usable
// Zwift ID, and members who look inactive (not in the Zwift club any more, never raced, or not raced for a long time). It only reads and reports: staff
// act on the result with the member tools that already exist (tier and status are saved to WordPress by Zwift ID). Staff only.
module.exports = function createTidy({ requireRole, fetchRoster, normTier }) {
  const DAY = 86400000;
  // Two spellings of one name compare equal: case, [CRYO-GEN] style tags, brackets and punctuation are ignored.
  const nameKey = n => String(n || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/cryo[\s-]*gen|\bcryo\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  const isId = v => /^\d{3,12}$/.test(String(v || '').trim());
  const raceMs = rider => { const d = rider && rider.race && rider.race.last && rider.race.last.date; if (!Number.isFinite(Number(d)) || !Number(d)) return null; return Number(d) > 1e12 ? Number(d) : Number(d) * 1000; };

  async function analyse(now = Date.now()) {
    const { riders, members, membersError } = await fetchRoster();
    const byRider = new Map(riders.map(r => [String(r.riderId), r]));
    const raw = Array.isArray(members) ? members : [];
    // WordPress records, split into usable ones and the ones that cannot be managed (no Zwift ID, or the same ID twice).
    const noId = [], seenId = new Map();
    for (const m of raw) {
      if (!isId(m.zwift_id)) { noId.push({ name: String(m.name || '').trim(), zwid: String(m.zwift_id || '').trim(), status: m.status || '', tier: normTier(m.tier) || '' }); continue; }
      const k = String(m.zwift_id).trim();
      (seenId.has(k) ? seenId.get(k) : seenId.set(k, []).get(k)).push(m);
    }
    const sameId = [...seenId].filter(([, list]) => list.length > 1).map(([zwid, list]) => ({ zwid, records: list.map(m => ({ name: String(m.name || '').trim(), status: m.status || '', tier: normTier(m.tier) || '' })) }));
    const wp = new Map([...seenId].map(([zwid, list]) => [zwid, list[list.length - 1]]));   // the record the app uses: the last one
    // Everyone: the WordPress records plus club riders who have none.
    const all = new Map();
    const entry = zwid => {
      const m = wp.get(zwid), r = byRider.get(zwid), last = raceMs(r);
      return { zwid, name: String((m && m.name) || (r && r.name) || zwid).trim(), status: (m && m.status) || (r ? 'no record' : ''), tier: m ? normTier(m.tier) || 'full' : '', hasRecord: !!m, inClub: !!r,
        lastRaced: last ? new Date(last).toISOString() : null, daysSinceRace: last ? Math.max(0, Math.floor((now - last) / DAY)) : null, finishes: r && r.race ? Number(r.race.finishes) || 0 : null };
    };
    for (const zwid of new Set([...wp.keys(), ...byRider.keys()])) all.set(zwid, entry(zwid));

    // The same name under more than one Zwift ID. A keep suggestion: in the club, active, a full member, raced lately.
    const byName = new Map();
    for (const e of all.values()) { const k = nameKey(e.name); if (k && k.includes(' ')) (byName.has(k) ? byName.get(k) : byName.set(k, []).get(k)).push(e); }
    const score = e => (e.inClub ? 4 : 0) + (e.status === 'active' ? 2 : 0) + (e.tier === 'full' ? 1 : 0) + (e.daysSinceRace !== null && e.daysSinceRace < 90 ? 2 : 0) + (e.hasRecord ? 1 : 0);
    const sameName = [...byName].filter(([, list]) => list.length > 1).map(([key, list]) => {
      const sorted = [...list].sort((a, b) => score(b) - score(a) || a.zwid.localeCompare(b.zwid));
      return { key, name: sorted[0].name, keep: sorted[0].zwid, members: sorted };
    }).sort((a, b) => a.name.localeCompare(b.name));

    // Members who look inactive: a WordPress record marked active that has not been in the club's data, or who has never raced. The page filters by days since the last race.
    const inactive = [];
    for (const e of all.values()) {
      if (!e.hasRecord || e.status !== 'active') continue;
      const reasons = [];
      if (!e.inClub && e.tier !== 'associate') reasons.push('not-in-club');
      if (e.inClub && e.finishes === 0) reasons.push('never-raced');
      if (e.inClub && e.daysSinceRace !== null) reasons.push('last-raced');   // a candidate by age; the page applies the number of days
      if (reasons.length) inactive.push({ ...e, reasons });
    }
    inactive.sort((a, b) => (b.daysSinceRace ?? 99999) - (a.daysSinceRace ?? 99999) || a.name.localeCompare(b.name));
    return { generated: new Date(now).toISOString(), membersError: membersError || null, hasMembers: Array.isArray(members), total: all.size,
      duplicates: { sameName, sameId, noId },
      inactive,
      counts: { sameName: sameName.length, sameId: sameId.length, noId: noId.length, notInClub: inactive.filter(i => i.reasons.includes('not-in-club')).length, neverRaced: inactive.filter(i => i.reasons.includes('never-raced')).length } };
  }

  const routes = {
    'GET /api/members/tidy': async req => { requireRole(req, ['admin', 'mod']); return analyse(); },
  };
  return { routes, analyse, nameKey };
};
