'use strict';
// The staff "This week" page: one place for what needs attention and what is coming up in the next seven days, across the TTT, ZRL, social
// rides and ride cover, the Ladder, the DIRT Series and associate requests. It reads from the modules (and the health checks) and holds nothing
// of its own. Each source is read on its own, so one failing never hides the rest.
module.exports = function createWeek({ onboarding, requireRole, healthChecks, loadTtt, loadState, zrl, cover, ladder, drs, assocList }) {
  const DAY = 86400000;
  const WINDOW_DAYS = 7;
  const LEVEL = { fail: 0, warn: 1, todo: 2 };
  // Which tab each health row belongs to; anything else is the platform itself (Admin → Health).
  const GO = { week: 'ttt', zrl: 'zrl', cover: 'rides', ladder: 'ladder', drs: 'drs', assoc: 'members' };

  const dayMs = (date, time) => Date.parse(`${date}T${/^\d{2}:\d{2}$/.test(time || '') ? time : '12:00'}:00Z`);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  async function safe(label, fn, problems) {
    try { return await fn(); } catch (e) { problems.push(`${label}: ${e.message || 'could not be read'}`); return null; }
  }

  async function build(req, now = Date.now(), role = 'admin') {
    const until = now + WINDOW_DAYS * DAY;
    const problems = [], attention = [], upcoming = [];
    const inWindow = ms => Number.isFinite(ms) && ms >= now - 3 * 3600000 && ms <= until;
    const ahead = (atMs, date, kind, title, note, level, go, timed = false) => upcoming.push({ atMs, date, kind, title, note, level: level || 'ok', go, timed });   // timed: the start time is known (otherwise only the day)

    const [checks, ttt, state, zdata, cvr, lad, drsData, asc, newbies] = await Promise.all([
      safe('Health checks', () => healthChecks(), problems),
      safe('TTT', () => loadTtt(), problems),
      safe('Rides', () => loadState(), problems),
      safe('ZRL', async () => { const d = await zrl.load(); return { ...d, weekly: await zrl.loadWeekly() }; }, problems),
      safe('Ride cover', async () => cover.view(await cover.load(), req, now), problems),
      safe('Ladder', () => ladder.allMatches(req, now), problems),
      safe('DIRT Series', () => drs.allStages(req, now), problems),
      safe('Associates', () => assocList(req), problems),
      onboarding ? safe('Onboarding', () => onboarding.scan(now), problems) : null,
    ]);

    // What needs attention: anything the health checks flag, the ZRL checklist, and associate requests.
    for (const c of checks || []) {
      if (c.status !== 'fail' && c.status !== 'warn') continue;
      if (!GO[c.id] && role !== 'admin') continue;   // platform problems are for admins (the Health panel is admin-only too)
      attention.push({ id: `health:${c.id}`, level: c.status, title: c.label, detail: c.detail, go: GO[c.id] || 'admin' });
    }
    if (zdata && zdata.round && zdata.round.teams.length) {
      const r = zrl.readiness(zdata, now);
      const soon = r.daysToFirstRace <= 7;
      for (const i of r.items) if (i.state === 'todo') attention.push({ id: `zrl:${i.id}`, level: soon ? 'warn' : 'todo', title: `ZRL · ${i.title}`, detail: i.detail, go: 'zrl' });
    }
    if (asc) {
      const waiting = (asc.rows || []).filter(x => x.request && x.request.status === 'pending');
      if (waiting.length) attention.push({ id: 'assoc:requests', level: 'warn', title: `${plural(waiting.length, 'associate asks', 'associates ask')} for full membership`, detail: waiting.map(x => x.name).slice(0, 8).join(', '), go: 'members' });
    }
    const stuck = (newbies || []).filter(m => !m.complete && m.days >= 3);
    if (stuck.length) attention.push({ id: 'onboarding', level: 'todo', title: `${plural(stuck.length, 'new member has', 'new members have')} not finished getting started`, detail: stuck.slice(0, 6).map(m => `${m.name} (${m.done} of ${m.total})`).join(', '), go: 'members' });
    attention.sort((a, b) => LEVEL[a.level] - LEVEL[b.level]);

    // What is coming up in the next seven days.
    if (ttt && ttt.week && ttt.week.date) {
      const ms = dayMs(ttt.week.date), n = ttt.signups.filter(s => s.available !== false).length;
      if (inWindow(ms)) ahead(ms, ttt.week.date, 'TTT', ttt.week.title || 'Weekly TTT', `${plural(n, 'rider', 'riders')} signed up${ttt.week.open ? ', sign-ups open' : ''}${ttt.week.published ? ', line-ups published' : ', line-ups not published'}`, ttt.week.published || !ttt.week.open ? 'ok' : 'todo', 'ttt');
    }
    if (zdata && zdata.round) {
      const { round, signups, assign, weekly } = zdata;
      const playing = round.teams.filter(t => signups.some(x => x.in && (assign[x.key] || []).includes(t.id)));
      for (let i = 0; i < round.weeks; i++) {
        const date = new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * DAY).toISOString().slice(0, 10), ms = dayMs(date);
        if (!inWindow(ms)) continue;
        const open = playing.filter(t => ((weekly.lineup || {})[`${i}:${t.id}`] || []).length < round.racing);
        ahead(ms, date, 'ZRL', `${round.name} · race ${i + 1}`, playing.length ? `${plural(playing.length, 'team races', 'teams race')}${open.length ? `; ${plural(open.length, 'line-up', 'line-ups')} not full` : '; every line-up is full'}` : 'no team has riders yet', open.length || !playing.length ? 'warn' : 'ok', 'zrl');
      }
    }
    if (state) for (const ride of state.rides || []) {
      const ms = dayMs(ride.date, ride.time);
      if (inWindow(ms)) ahead(ms, ride.date, 'Ride', ride.title || 'Social ride', plural((state.rsvps[ride.id] || []).length, 'RSVP', 'RSVPs'), 'ok', 'rides', !!ride.time);
    }
    if (cvr) for (const s of cvr.series || []) for (const o of s.occurrences || []) {
      if (o.cancelled || !inWindow(o.startMs)) continue;
      const need = (o.gaps || []).filter(g => g === 'leader' || g === 'sweeper');
      ahead(o.startMs, o.date, 'Ride cover', s.title, need.length ? `needs ${need.join(' and ')}` : 'leader and sweeper covered', need.length ? 'warn' : 'ok', 'rides', true);
    }
    if (lad) for (const m of lad) {
      if (!m.at || !inWindow(m.at) || m.status === 'played' || m.status === 'cancelled') continue;
      const set = (m.lineup || []).length > 0, clash = (m.clashes || []).length > 0;
      ahead(m.at, new Date(m.at).toISOString().slice(0, 10), 'Ladder', `${m.teamName} v ${m.opponent}`, clash ? `${m.clashes.map(c => c.name).join(', ')} also in ${m.clashes[0].team}'s line-up at the same time` : set ? `line-up of ${(m.lineup || []).length} set` : 'line-up not set', set && !clash ? 'ok' : 'warn', 'ladder', true);
    }
    if (drsData) for (const st of drsData) {
      if (st.status !== 'upcoming' || !inWindow(st.startMs)) continue;
      const clash = (st.clashes || []).length > 0;
      ahead(st.startMs, st.date, 'DIRT Series', `${st.teamName} · stage ${st.n}${st.route ? ' · ' + st.route : ''}`, clash ? `${st.clashes.map(c => c.name).join(', ')} also in ${st.clashes[0].team}'s squad at the same time` : st.time ? `starts ${st.time}` : 'start time not set', st.time && !clash ? 'ok' : 'warn', 'drs', !!st.time);
    }
    upcoming.sort((a, b) => a.atMs - b.atMs);

    // One line per series: everything fine, or the one thing that is next. Built from what was read above.
    const days = ms => { const d = Math.ceil((ms - now) / DAY); return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`; };
    const series = [];
    if (zdata && zdata.round && zdata.round.teams.length) {
      const r = zrl.readiness(zdata, now), left = r.items.filter(i => i.state === 'todo'), fixable = left.filter(i => i.fix).length;
      series.push({ id: 'zrl', label: 'ZRL', go: 'zrl', state: r.ready ? 'ok' : r.daysToFirstRace <= 7 ? 'warn' : 'todo',
        text: r.ready ? `${zdata.round.name} is ready to race.` : `${plural(left.length, 'thing', 'things')} to do for ${zdata.round.name}${fixable ? `, ${fixable} can be fixed in one click` : ''}. First race ${r.daysToFirstRace > 0 ? `in ${r.daysToFirstRace} days` : 'now'}.` });
    } else series.push({ id: 'zrl', label: 'ZRL', go: 'zrl', state: 'idle', text: zdata && zdata.round ? 'Add the teams.' : 'No round yet.' });
    if (ttt && ttt.week) {
      const avail = ttt.signups.filter(s => s.available !== false), free = avail.filter(s => !(ttt.assign[s.name.toLowerCase()] || []).length).length;
      series.push({ id: 'ttt', label: 'TTT', go: 'ttt', state: ttt.week.published && !free ? 'ok' : ttt.week.open ? 'todo' : 'warn',
        text: ttt.week.open ? `Sign-ups open, ${plural(avail.length, 'rider', 'riders')} in.` : ttt.week.published ? (free ? `Line-ups out, ${plural(free, 'rider', 'riders')} on the waitlist.` : 'Line-ups are out.') : `Sign-ups closed: ${free ? `${plural(free, 'rider has', 'riders have')} no team, then publish.` : 'check the teams and publish.'}` });
    } else series.push({ id: 'ttt', label: 'TTT', go: 'ttt', state: 'idle', text: 'No week started.' });
    const nextLad = (lad || []).filter(m => m.status === 'scheduled' && m.at && m.at > now).sort((a, b) => a.at - b.at)[0];
    series.push(nextLad
      ? { id: 'ladder', label: 'Ladder', go: 'ladder', state: nextLad.lineupCheck && nextLad.lineupCheck.ok && nextLad.lineupCheck.complete ? 'ok' : (nextLad.at - now < 3 * DAY ? 'warn' : 'todo'),
        text: `${nextLad.teamName} v ${nextLad.opponent} ${days(nextLad.at)}: ${nextLad.lineupCheck && nextLad.lineupCheck.ok && nextLad.lineupCheck.complete ? `line-up set${nextLad.reserveInfo ? ' with a reserve' : ''}` : `no legal line-up yet (${nextLad.counts.yes} yes so far)`}.` }
      : { id: 'ladder', label: 'Ladder', go: 'ladder', state: 'idle', text: 'No match scheduled.' });
    const nextStage = (drsData || []).filter(x => x.status === 'upcoming' && x.startMs > now).sort((a, b) => a.startMs - b.startMs)[0];
    series.push(nextStage
      ? { id: 'drs', label: 'DIRT', go: 'drs', state: nextStage.dnqRisk ? 'warn' : Object.keys(nextStage.roles || {}).length ? 'ok' : (nextStage.startMs - now < 2 * DAY ? 'warn' : 'todo'),
        text: `${nextStage.teamName} stage ${nextStage.n} ${days(nextStage.startMs)}: ${nextStage.dnqRisk ? 'too few can race to score' : Object.keys(nextStage.roles || {}).length ? 'scoring four set' : 'scoring four not set'} (${nextStage.counts.yes} yes · ${nextStage.counts.no} no · ${nextStage.counts.none} unanswered).` }
      : { id: 'drs', label: 'DIRT', go: 'drs', state: 'idle', text: 'No stage coming up.' });
    return { generated: new Date(now).toISOString(), windowDays: WINDOW_DAYS, newMembers: newbies || [], series, attention, upcoming, problems };
  }

  const routes = {
    'GET /api/week': async req => {
      const role = requireRole(req, ['admin', 'mod']);
      return build(req, Date.now(), role);
    },
  };
  return { routes, build };
};
