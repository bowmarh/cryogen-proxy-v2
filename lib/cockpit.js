'use strict';
// The captain's cockpit: for each ZRL team a rider captains, the next race with who has said yes, maybe or no, who has not answered, who is in the
// pen, and a suggested line-up (answered yes first, then maybe, strongest vELO first, up to the number who race). One button asks the riders who
// have not answered, by direct message through the club's normal automatic-message rules (a rider's Discord must be linked and they must not have
// switched these off). It is for captains only and shows nothing about riders who are not on their team.
module.exports = function createCockpit({ redis, HttpError, memberFromRequest, zrl, live, adminReq, fetchRoster, notify, reach = null, siteUrl = '' }) {
  const DAY = 86400000, NUDGE_EVERY_MS = 12 * 3600000;
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  const first = n => String(n || '').split(/\s+/)[0] || 'there';
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };

  async function mine(member, now = Date.now()) {
    const [data, weekly, results] = await Promise.all([zrl.load(), zrl.loadWeekly(), zrl.loadResults()]);
    if (!data.round) return { captain: false };
    const my = zrl.myZrl(data, member, weekly, results);
    if (!my.captainOf.length) return { captain: false };
    const today = iso(now), [roster, events] = await Promise.all([fetchRoster().catch(() => ({ riders: [] })), live.events(adminReq(), now).catch(() => [])]);
    const rating = new Map((roster.riders || []).map(r => [String(r.riderId), Number(r.race && r.race.current && r.race.current.rating) || 0]));
    const cant = reach ? new Set(await reach.unreachable(my.captainOf.flatMap(t => t.weeks.flatMap(w => w.riders.map(r => r.zwid))))) : new Set();   // riders on these teams who cannot be messaged
    const teams = my.captainOf.map(t => {
      const w = t.weeks.find(x => x.date >= today) || null;
      if (!w) return { id: t.id, name: t.name, next: null };
      const ev = events.find(e => e.kind === 'zrl' && e.id === `${w.i}:${t.id}`), pen = new Map((ev ? ev.riders : []).map(r => [String(r.zwid), r.inPen]));
      const riders = w.riders.map(r => ({ zwid: r.zwid, name: r.name, status: r.status || '', inPen: !!pen.get(String(r.zwid)), picked: (w.lineup || []).includes(r.zwid), rating: rating.get(String(r.zwid)) || 0 }));
      const by = s => riders.filter(r => r.status === s), want = data.round.racing || 0;
      const rank = list => [...list].sort((a, b) => b.rating - a.rating);
      const suggestion = [...rank(by('yes')), ...rank(by('maybe'))].slice(0, want).map(r => r.name);
      return { id: t.id, name: t.name, next: { week: w.i + 1, weekIndex: w.i, date: w.date, at: ev ? ev.at : null, racing: want, lineupSet: (w.lineup || []).length > 0,
        yes: by('yes').map(r => r.name), maybe: by('maybe').map(r => r.name), no: by('no').map(r => r.name), pending: riders.filter(r => !r.status).map(r => r.name),
        inPen: riders.filter(r => r.inPen).map(r => r.name), lineup: riders.filter(r => r.picked).map(r => r.name),
        unreachable: riders.filter(r => cant.has(String(r.zwid))).map(r => r.name),
        short: Math.max(0, want - by('yes').length), suggestion: (w.lineup || []).length ? [] : suggestion } };
    });
    return { captain: true, round: data.round.name, teams };
  }

  async function nudge(member, body, now = Date.now()) {
    const data = await zrl.load(), weekly = await zrl.loadWeekly();
    const my = zrl.myZrl(data, member, weekly, await zrl.loadResults()), t = my.captainOf.find(x => x.id === String(body.team || ''));
    if (!t) throw new HttpError(403, 'You can only ask riders on a team you captain.');
    const w = t.weeks.find(x => x.i === Number(body.week)); if (!w) throw new HttpError(404, 'That race is not on the calendar.');
    if (w.date < iso(now)) throw new HttpError(409, 'That race has already happened.');
    const pending = w.riders.filter(r => !r.status && r.zwid);
    if (!pending.length) return { sent: 0, pending: 0, note: 'Everyone has answered.' };
    const bucket = Math.floor(now / NUDGE_EVERY_MS); let sent = 0;
    for (const r of pending) {
      const text = `Hi ${first(r.name)}, ${first(member.name)} here (captain of ${t.name}): can you race ${w.date}? Please answer in My week: ${siteUrl}`;
      if (await notify(r.zwid, text, { kind: 'race', key: `cockpit:${t.id}:${w.i}:${r.zwid}:${bucket}` }).catch(() => false)) sent++;
    }
    return { sent, pending: pending.length, note: sent === pending.length ? `Asked ${sent} rider${sent === 1 ? '' : 's'}.` : `Asked ${sent} of ${pending.length}. The rest have no linked Discord, have these messages switched off, were asked in the last 12 hours, or automatic messages are off.` };
  }

  return { mine, nudge, routes: {
    'GET /api/me/cockpit': async req => mine(need(req)),
    'POST /api/me/cockpit/nudge': async (req, body) => nudge(need(req), body || {}),
  } };
};
