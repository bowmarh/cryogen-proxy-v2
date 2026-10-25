'use strict';
// The rider's "My week" card: their own next seven days across the TTT, ZRL, social rides, ride cover, the Ladder and the DIRT Series, with
// the things only they can answer marked as "to do". It holds nothing of its own and reads only what the signed-in rider may see. An
// associate member gets the part they can use (TTT, ZRL and social rides). Each source is read on its own, so one failing never hides the rest.
module.exports = function createMyWeek({ memberFromRequest, HttpError, loadTtt, myTttStatus, loadState, zrl, cover, ladder, drs, isAssociate }) {
  const DAY = 86400000;
  const WINDOW_DAYS = 7;
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayMs = (date, time) => Date.parse(`${date}T${/^\d{2}:\d{2}$/.test(time || '') ? time : '12:00'}:00Z`);

  // A ZRL slot reads "Sat 17:00 UTC": the race is on that weekday nearest the week's date.
  function raceMoment(date, slot) {
    const m = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(\d\d):(\d\d)\s+UTC/i.exec(slot || '');
    if (!m) return null;
    const t = Date.parse(`${date}T${m[2]}:${m[3]}:00Z`);
    if (Number.isNaN(t)) return null;
    let diff = DOW.indexOf(m[1][0].toUpperCase() + m[1].slice(1).toLowerCase()) - new Date(t).getUTCDay();
    if (diff > 3) diff -= 7;
    if (diff < -3) diff += 7;
    return t + diff * DAY;
  }

  async function safe(label, fn, problems) {
    try { return await fn(); } catch (e) { problems.push(label); return null; }
  }

  async function build(req, now = Date.now()) {
    const member = memberFromRequest(req);
    if (!member) throw new HttpError(401, 'Sign in with your cryogen.team account.');
    const associate = await isAssociate(member);
    const until = now + WINDOW_DAYS * DAY, problems = [], items = [];
    const inWindow = ms => Number.isFinite(ms) && ms >= now - 3 * 3600000 && ms <= until;
    // state: in (you are doing it), todo (needs your answer), info (on offer), out (you said no)
    const add = (atMs, date, timed, kind, title, note, state, go, extra) => items.push({ atMs, date, timed: !!timed, kind, title, note, state, go, ...extra });
    const me = member.name.toLowerCase();

    await Promise.all([
      safe('TTT', async () => {
        const data = await loadTtt();
        if (!data.week || !data.week.date) return;
        const ms = dayMs(data.week.date);
        if (!inWindow(ms)) return;
        const own = data.signups.find(s => s.zwid === member.zwid);
        const st = myTttStatus(data, (own ? own.name : member.name).toLowerCase(), []);
        if (st.teams.length) add(ms, data.week.date, false, 'TTT', st.week.title || 'Weekly TTT', `You ride ${st.teams.map(t => t.name).join(' and ')}${st.teams.some(t => t.iAmCaptain) ? ' (you are captain)' : ''}`, 'in', 'ttt');
        else if (st.signup && st.signup.available) add(ms, data.week.date, false, 'TTT', st.week.title || 'Weekly TTT', "You're signed up. Your team shows here once the line-ups are published.", 'in', 'ttt');
        else if (st.signup) add(ms, data.week.date, false, 'TTT', st.week.title || 'Weekly TTT', "You said you're not riding this week.", 'out', 'ttt');
        else if (data.week.open) add(ms, data.week.date, false, 'TTT', st.week.title || 'Weekly TTT', 'Sign-ups are open. Are you riding?', 'todo', 'ttt');
      }, problems),
      safe('ZRL', async () => {
        const data = await zrl.load();
        if (!data.round) return;
        const weekly = await zrl.loadWeekly();
        const my = zrl.myZrl({ ...data, weekly }, member, weekly, {});
        for (const t of my.teams || []) for (const w of t.weeks) {
          const at = raceMoment(w.date, t.slot), ms = at || dayMs(w.date);
          if (!inWindow(ms)) continue;
          const title = `${t.name} · race ${w.i + 1}`;
          if (w.picked) add(ms, w.date, !!at, 'ZRL', title, "You're in the line-up", 'in', 'zrl', { avail: { week: w.i, mine: w.mine, team: t.id } });
          else if (w.mine === 'no') add(ms, w.date, !!at, 'ZRL', title, "You said you can't race", 'out', 'zrl', { avail: { week: w.i, mine: w.mine, team: t.id } });
          else if (!w.mine) add(ms, w.date, !!at, 'ZRL', title, 'Tell your captain if you can race', 'todo', 'zrl', { avail: { week: w.i, mine: w.mine, team: t.id } });
          else add(ms, w.date, !!at, 'ZRL', title, `You said ${w.mine}. ${w.lineupSet ? 'The line-up is picked and you are not in it (yet).' : 'Your captain has not picked the line-up yet.'}`, 'in', 'zrl', { avail: { week: w.i, mine: w.mine, team: t.id } });
        }
      }, problems),
      safe('Rides', async () => {
        const state = await loadState();
        for (const ride of state.rides || []) {
          const ms = dayMs(ride.date, ride.time);
          if (!inWindow(ms)) continue;
          const going = (state.rsvps[ride.id] || []).some(x => String(x.name || '').toLowerCase() === me);
          add(ms, ride.date, !!ride.time, 'Ride', ride.title || 'Social ride', going ? "You're in" : 'RSVP if you would like to ride', going ? 'in' : 'info', 'rides');
        }
      }, problems),
      !associate && safe('Ride cover', async () => {
        const v = cover.view(await cover.load(), req, now);
        for (const s of v.series || []) for (const o of s.occurrences || []) {
          if (o.cancelled || !inWindow(o.startMs)) continue;
          const roles = Object.entries(o.cover || {}).filter(([, who]) => who && who.mine).map(([r]) => (r === 'sweeper' ? 'sweeping' : 'leading'));
          if (roles.length) add(o.startMs, o.date, true, 'Ride cover', s.title, `You're ${roles.join(' and ')}`, 'in', 'rides');
        }
      }, problems),
      !associate && safe('Ladder', async () => {
        for (const m of await ladder.allMatches(req, now)) {
          if (!m.onRoster || !m.at || !inWindow(m.at) || m.status === 'played' || m.status === 'cancelled') continue;
          const inLine = (m.lineup || []).includes(member.zwid);
          const note = inLine ? "You're in the line-up" : m.myAvailability === 'no' ? "You said you can't ride" : m.myAvailability ? `You said ${m.myAvailability}` : 'Can you ride? Tell the staff';
          add(m.at, new Date(m.at).toISOString().slice(0, 10), true, 'Ladder', `${m.teamName} v ${m.opponent}`, note, inLine ? 'in' : m.myAvailability === 'no' ? 'out' : m.myAvailability ? 'in' : 'todo', 'ladder');
        }
      }, problems),
      !associate && safe('DIRT Series', async () => {
        for (const st of await drs.allStages(req, now)) {
          if (!st.inSquad || st.status === 'played' || st.status === 'cancelled' || !inWindow(st.startMs)) continue;
          const role = (st.roles || {})[member.zwid];
          add(st.startMs, st.date, !!st.time, 'DIRT Series', `${st.teamName} · stage ${st.n}${st.route ? ' · ' + st.route : ''}`, role === 'scorer' ? "You're one of the scoring four" : role === 'support' ? "You're support" : "You're in the squad", 'in', 'drs');
        }
      }, problems),
    ].filter(Boolean));

    items.sort((a, b) => a.atMs - b.atMs);
    return { generated: new Date(now).toISOString(), windowDays: WINDOW_DAYS, name: member.name, associate, todo: items.filter(i => i.state === 'todo').length, items, problems };
  }

  const routes = { 'GET /api/me/week': async req => build(req) };
  return { routes, build };
};
