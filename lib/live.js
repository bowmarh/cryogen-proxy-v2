'use strict';
// Race day: one list of what is on now or within a day (ZRL races, Ladder matches, DIRT stages), each with the riders who are racing, what they
// answered, and whether they have said they are in the pen. The app cannot see Zwift's pen, so "in the pen" is the rider's own tap (or a captain's or
// staff member's for them). Twenty minutes before a start, riders who have not tapped get one direct message (when automatic messages are on).
module.exports = function createLive({ adminReq, redis, HttpError, requireRole, roleFromRequest, memberFromRequest, ladder, drs, zrl, notify }) {
  const KEY = 'cg:live:checkins';   // "<kind>:<event id>|<zwid>" -> ISO time
  const DAY = 86400000, DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const isStaff = req => ['admin', 'mod'].includes(roleFromRequest(req));
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

  // "Sat 17:00 UTC" on the race week's date: the race is on that weekday nearest the date.
  function raceMoment(date, slot) {
    const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d\d):(\d\d)\s+UTC/i.exec(slot || '');
    if (!m) return null;
    const t = Date.parse(`${date}T${m[2]}:${m[3]}:00Z`);
    if (Number.isNaN(t)) return null;
    let diff = DOW.indexOf(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) - new Date(t).getUTCDay();
    if (diff > 3) diff -= 7; if (diff < -3) diff += 7;
    return t + diff * DAY;
  }

  // Everything starting from three hours ago to a day ahead, soonest first. `req` is a staff request (so the modules show everything): `adminReq()`.
  async function events(req, now = Date.now()) {
    const out = [], inWin = ms => Number.isFinite(ms) && ms >= now - 3 * 3600000 && ms <= now + DAY;
    try {
      for (const m of await ladder.allMatches(req, now)) {
        if (m.status !== 'scheduled' || !inWin(m.at)) continue;
        const ans = m.availability || {};
        out.push({ kind: 'ladder', id: m.id, title: `${m.teamName} v ${m.opponent}`, at: m.at, link: m.eventLink && m.eventLink !== 'hidden' ? m.eventLink : '', need: 5,
          riders: [...(m.lineupInfo || []).map(r => ({ zwid: r.zwid, name: r.name, role: 'starter', answer: ans[r.zwid] || '' })), ...(m.reserveInfo ? [{ zwid: m.reserveInfo.zwid, name: m.reserveInfo.name, role: 'reserve', answer: ans[m.reserveInfo.zwid] || '' }] : [])] });
      }
    } catch (e) { /* the other series still show */ }
    try {
      for (const st of await drs.allStages(req, now)) {
        if (st.status !== 'upcoming' || !inWin(st.startMs)) continue;
        const d = await drs.load(st.teamId), roles = st.roles || {};
        out.push({ kind: 'drs', id: st.id, title: `${st.teamName} · DIRT stage ${st.n}`, at: st.startMs, link: st.eventLink && st.eventLink !== 'hidden' ? st.eventLink : '', need: d.season ? d.season.scorers : 4,
          riders: Object.values(d.squad).map(r => ({ zwid: r.zwid, name: r.name, role: roles[r.zwid] || '', answer: (st.availability || {})[r.zwid] || '' })) });
      }
    } catch (e) { /* ditto */ }
    try {
      const data = await zrl.load();
      if (data.round && data.round.published) {
        const weekly = await zrl.loadWeekly();
        for (const t of data.round.teams) for (let i = 0; i < data.round.weeks; i++) {
          const date = new Date(Date.parse(`${data.round.start}T00:00:00Z`) + 7 * i * DAY).toISOString().slice(0, 10), at = raceMoment(date, t.slot);
          if (!inWin(at)) continue;
          const lineup = weekly.lineup[`${i}:${t.id}`] || [];
          out.push({ kind: 'zrl', id: `${i}:${t.id}`, title: `${t.name} · ZRL race ${i + 1}`, at, link: '', need: data.round.racing,
            riders: lineup.map(z => { const s = data.signups.find(x => x.zwid === z); return { zwid: z, name: s ? s.name : z, role: 'starter', answer: zrl.availOf(weekly, i, z, t.id) }; }) });
        }
      }
    } catch (e) { /* ditto */ }
    const marks = Object.fromEntries(pairs((await redis([['HGETALL', KEY]]))[0]));
    for (const e of out) {
      for (const r of e.riders) r.inPen = marks[`${e.kind}:${e.id}|${r.zwid}`] || '';
      const mins = Math.round((e.at - now) / 60000);
      e.minutes = mins;
      e.status = mins > 30 ? 'later' : mins > 0 ? 'soon' : 'started';
      e.ready = e.riders.filter(r => r.role !== 'reserve' && r.inPen).length;
      e.late = e.status !== 'later' && e.riders.filter(r => r.role !== 'reserve' && !r.inPen).map(r => r.name);
    }
    return out.sort((a, b) => a.at - b.at);
  }

  const routes = {
    'GET /api/live': async req => { requireRole(req, ['admin', 'mod']); return { generated: new Date().toISOString(), events: await events(adminReq()) }; },

    // A rider taps "I'm in the pen" for an event they are racing (the line-up, or the DIRT squad); a captain or staff can do it for them.
    'POST /api/live/checkin': async (req, body) => {
      const me = memberFromRequest(req), staff = isStaff(req);
      if (!me && !staff) throw new HttpError(401, 'Sign in with your cryogen.team account.');
      const kind = String(body.kind || ''), id = String(body.id || '');
      if (!['ladder', 'drs', 'zrl'].includes(kind) || !id) throw new HttpError(400, 'Say which race.');
      const zwid = staff && body.zwid ? String(body.zwid) : me && me.zwid;
      const ev = (await events(adminReq())).find(e => e.kind === kind && e.id === id);
      if (!ev) throw new HttpError(404, 'That race is not on in the next day.');
      if (!ev.riders.some(r => r.zwid === zwid)) throw new HttpError(403, 'Only the riders racing can say they are in the pen.');
      const field = `${kind}:${id}|${zwid}`;
      await redis([body.in === false ? ['HDEL', KEY, field] : ['HSET', KEY, field, new Date().toISOString()]]);
      return { ok: true };
    },
  };

  // Twenty minutes before a start: riders racing who have not said they are in the pen get one message.
  async function runSchedule(now = Date.now()) {
    const done = [];
    for (const e of await events(adminReq(), now)) {
      if (e.minutes < 12 || e.minutes > 28) continue;
      for (const r of e.riders) {
        if (r.role === 'reserve' || r.inPen || r.answer === 'no') continue;
        const sent = await notify(r.zwid, `Hi, ${e.title} starts in about ${Math.max(1, e.minutes)} minutes. Get into the pen, check your heart rate monitor and trainer, and tap "I'm in the pen" on My week.${e.link ? `\nPrivate event: ${e.link}` : ''}`, { key: `pen:${e.kind}:${e.id}:${r.zwid}` }).catch(() => false);
        if (sent) done.push(`pen-${r.zwid}`);
      }
    }
    return done;
  }
  return { routes, runSchedule, events, KEY };
};
