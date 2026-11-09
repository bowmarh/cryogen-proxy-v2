'use strict';
// ZRL placement helper for staff: the riders who are racing but have no team yet (with the teams in their region that still have room, and whether they
// can be messaged), and the teams that have not been registered on WTRL before the deadline, with a button that reminds those teams' captains by direct
// message. It changes no sign-up and no team: placing riders stays with "Suggest teams" and the captains.
module.exports = function createZrlHelper({ HttpError, requireRole, zrl, reach = null, notify = async () => false, siteUrl = '' }) {
  const DAY = 86400000, EVERY_MS = 12 * 3600000;
  const inTeam = (list, id) => (list || []).includes(id);

  async function build(now = Date.now()) {
    const data = await zrl.load();
    if (!data.round) return { round: null };
    const round = data.round, racing = data.signups.filter(x => x.in), teams = round.teams || [], room = round.rosterSize || 0;
    const used = new Map(teams.map(t => [t.id, racing.filter(x => inTeam(data.assign[x.key], t.id)).length]));
    const placedIds = new Set(teams.map(t => t.id)), unplaced = racing.filter(x => !(data.assign[x.key] || []).some(id => placedIds.has(id)));
    const cant = new Set(reach ? await reach.unreachable(unplaced.map(x => x.key)) : []);
    const rows = unplaced.map(x => ({
      key: x.key, name: x.name, cat: x.cat || '', regions: x.regions || [], commit: x.commit || 'full', preferred: x.preferred || '', reachable: !cant.has(String(x.key)),
      options: teams.filter(t => (!t.region || !(x.regions || []).length || (x.regions || []).includes(t.region)) && room && (used.get(t.id) || 0) < room)
        .sort((a, b) => (used.get(a.id) || 0) - (used.get(b.id) || 0)).slice(0, 3).map(t => ({ id: t.id, name: t.name, free: room - (used.get(t.id) || 0) })),
    })).sort((a, b) => Number(a.reachable) - Number(b.reachable) || a.name.localeCompare(b.name));
    let wtrl = null;
    if (round.wtrlDeadline && data.weekly) {
      const deadline = Date.parse(round.wtrlDeadline), playing = teams.filter(t => used.get(t.id) > 0);
      wtrl = { deadline: round.wtrlDeadline, hoursLeft: Math.round((deadline - now) / 3600000), passed: deadline <= now,
        unregistered: playing.filter(t => !data.weekly.reg[t.id]).map(t => ({ id: t.id, name: t.name, captain: t.captain ? ((racing.find(x => x.key === t.captain) || {}).name || 'a captain') : '', hasCaptain: !!t.captain })) };
    }
    return { round: { name: round.name, open: !!round.open, published: !!round.published, rosterSize: room }, unplaced: rows, unreachable: rows.filter(r => !r.reachable).length, wtrl };
  }

  async function remind(now = Date.now()) {
    const d = await build(now), w = d.wtrl; if (!w || !w.unregistered.length) return { sent: 0, asked: 0, noCaptain: [], note: 'Every team that is racing is registered.' };
    const data = await zrl.load(), bucket = Math.floor(now / EVERY_MS); let sent = 0, asked = 0; const noCaptain = [];
    for (const t of w.unregistered) {
      const team = data.round.teams.find(x => x.id === t.id);
      if (!team || !team.captain) { noCaptain.push(t.name); continue; }
      asked++;
      const when = w.passed ? 'The WTRL registration deadline has passed' : w.hoursLeft <= 24 ? 'The WTRL registration deadline is within a day' : `The WTRL registration deadline is in ${Math.ceil(w.hoursLeft / 24)} days`;
      if (await notify(team.captain, `${when} and ${t.name} is not marked as registered. Please register the team on WTRL, then tick it as registered in your captain's view: ${siteUrl}`, { kind: 'race', key: `wtrl-remind:${t.id}:${bucket}` }).catch(() => false)) sent++;
    }
    return { sent, asked, noCaptain, note: `Reminded ${sent} of ${asked} captain${asked === 1 ? '' : 's'}.${noCaptain.length ? ` ${noCaptain.length} team${noCaptain.length === 1 ? ' has' : 's have'} no captain to ask.` : ''}` };
  }

  return { build, remind, routes: {
    'GET /api/staff/zrl-helper': async req => { requireRole(req, ['admin', 'mod']); return build(); },
    'POST /api/staff/zrl-helper/remind': async req => { requireRole(req, ['admin', 'mod']); return remind(); },
  } };
};
