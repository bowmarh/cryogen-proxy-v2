'use strict';
// Ready-made reminders for the Comms tab. Each says who it is for (worked out from the live data) and what to send, so staff only review and press
// send. {name} and the other {words} in the text are filled in for each member when it is sent. Nothing here sends anything.
// Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createCommsTemplates({ zrl, tttCandidates, ladder, drs, assocList, activeMembers, reach, siteUrl, maxMembers = 50 }) {
  const DAY = 86400000;
  const dayLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const todayKey = now => new Date(now).toISOString().slice(0, 10);
  const weekDate = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * DAY).toISOString().slice(0, 10);
  const nice = n => String(n).replace(/^CRYO-GEN\s+/, '');
  const list = names => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

  async function safe(fn) { try { return await fn(); } catch (e) { return null; } }

  async function build(req, now = Date.now()) {
    const out = [];
    const add = t => out.push({ audience: 'members', recipients: [], note: '', ...t });

    // ZRL: the next race, and who has not said whether they can race it, or whose line-up is short.
    const z = await safe(async () => { const d = await zrl.load(); return d.round ? { ...d, weekly: await zrl.loadWeekly() } : null; });
    if (z) {
      const { round, signups, assign, weekly } = z, today = todayKey(now);
      let next = -1;
      for (let i = 0; i < round.weeks; i++) if (weekDate(round, i) >= today) { next = i; break; }
      const teamsOf = x => round.teams.filter(t => (assign[x.key] || []).includes(t.id));
      if (next >= 0) {
        const date = dayLabel(weekDate(round, next));
        const silent = [];
        for (const x of signups) {
          if (!x.in || !x.zwid) continue;
          const open = teamsOf(x).filter(t => !zrl.availOf(weekly, next, x.zwid, t.id));
          if (open.length) silent.push({ zwid: x.zwid, vars: { teams: list(open.map(t => nice(t.name))) } });
        }
        add({ id: 'zrl-availability', title: 'ZRL: say if you can race', hint: `Riders who have not answered for race ${next + 1}`, recipients: silent,
          text: `Hi {name}, can you race ZRL ${round.name} race ${next + 1} on ${date} for {teams}? Open the dashboard, go to My week and tap Yes, Maybe or No so your captain can plan the line-up. Thank you!`,
          note: round.published ? '' : 'The rosters are not published yet, so riders cannot see their team to answer. Publish them first.' });
        const short = new Map();
        for (const t of round.teams) {
          if (!t.captain || !signups.some(x => x.in && (assign[x.key] || []).includes(t.id))) continue;
          if (((weekly.lineup || {})[`${next}:${t.id}`] || []).length < round.racing) short.set(t.captain, [...(short.get(t.captain) || []), nice(t.name)]);
        }
        add({ id: 'zrl-lineups', title: 'ZRL: captains, pick your line-up', hint: `Captains whose team has no full line-up for race ${next + 1}`, recipients: [...short].map(([zwid, names]) => ({ zwid, vars: { teams: list(names) } })),
          text: `Hi {name}, {teams} still needs a full line-up of ${round.racing} for ZRL race ${next + 1} on ${date}. Pick it in the dashboard: ZRL, then Weeks, then Save line-up. Thank you!` });
      }
      if (round.open) {
        const have = new Set(signups.map(x => x.zwid).filter(Boolean));
        const rest = (await safe(activeMembers) || []).filter(id => !have.has(id));
        const closes = round.closesAt ? ` Sign-ups close ${new Date(round.closesAt).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })} UK.` : '';
        const text = `Hi {name}, ZRL ${round.name} sign-ups are open.${closes} Tap ZRL in the dashboard to sign up, or tell us if you are sitting this one out.`;
        const tooMany = rest.length > maxMembers;
        add({ id: 'zrl-signup', title: 'ZRL: sign-ups are open', hint: 'Members who have not signed up for the round', audience: tooMany ? 'all' : 'members', recipients: tooMany ? [] : rest.map(zwid => ({ zwid })),
          text: tooMany ? text.replace('Hi {name}, ', '') : text, note: tooMany ? `${rest.length} members have not signed up: too many to message one by one, so this goes to the whole club channel.` : '' });
      }
    }

    // TTT: last week's riders who have not signed up this week.
    const t = await safe(tttCandidates);
    if (t && t.open) {
      add({ id: 'ttt-signup', title: 'TTT: sign-ups are open', hint: 'Riders who rode last time and have not signed up yet', recipients: t.zwids.map(zwid => ({ zwid })),
        text: `Hi {name}, TTT sign-ups are open for ${t.title}. Tap TTT Week in the dashboard (or Run it back to repeat your last settings).` });
    }

    // Ladder: riders who have not answered for a coming match.
    const lad = await safe(() => ladder.allMatches(req, now));
    if (lad) {
      const seen = new Map();
      for (const m of lad.filter(x => x.status === 'scheduled' && x.at && x.at > now && x.at < now + 14 * DAY).sort((a, b) => a.at - b.at))
        for (const [zwid, status] of Object.entries(m.availability || {})) if (!status && !seen.has(zwid)) seen.set(zwid, { match: `${m.teamName} v ${m.opponent}`, date: dayLabel(new Date(m.at).toISOString().slice(0, 10)) });
      add({ id: 'ladder-availability', title: 'Ladder: can you ride?', hint: 'Roster riders who have not answered for a match in the next two weeks', recipients: [...seen].map(([zwid, vars]) => ({ zwid, vars })),
        text: 'Hi {name}, can you ride the Ladder match {match} on {date}? Open Ladder in the dashboard and tap Yes, Maybe or No. Thank you!' });
    }

    // DIRT Series: each squad rider, before their team's next stage.
    const dr = await safe(async () => {
      const base = await drs.load(), rows = new Map();
      for (const team of base.teams) {
        const d = await drs.load(team.id);
        if (!d.season) continue;
        const next = d.stages.filter(s => s.status === 'upcoming' && s.date >= todayKey(now) && s.date <= todayKey(now + 8 * DAY)).sort((a, b) => a.n - b.n)[0];
        if (next) for (const zwid of Object.keys(d.squad)) if (!rows.has(zwid)) rows.set(zwid, { stage: `${team.name} stage ${next.n}`, date: dayLabel(next.date) });
      }
      return rows;
    });
    if (dr) add({ id: 'drs-stage', title: 'DIRT Series: stage coming up', hint: 'Squad riders with a stage in the next week', recipients: [...dr].map(([zwid, vars]) => ({ zwid, vars })),
      text: 'Hi {name}, {stage} is on {date}. Check the plan and your role in the dashboard under DIRT Series, and let us know if anything stops you racing.' });

    // Associates who have done everything and not yet asked.
    const asc = await safe(() => assocList(req));
    if (asc) add({ id: 'assoc-ready', title: 'Associates: you can ask to join', hint: 'Associates who finished the checklist and have not asked yet',
      recipients: (asc.rows || []).filter(r => r.complete && !(r.request && ['pending', 'approved'].includes(r.request.status))).map(r => ({ zwid: r.zwid })),
      text: 'Hi {name}, you have finished the checklist for becoming a full CRYO-GEN member. Open Become a member in the dashboard and press Request full membership. Well done!' });

    // Everyone: connect Discord.
    const r = await safe(reach);
    add({ id: 'link-discord', title: 'Everyone: add your Discord ID', hint: 'Posted in the club channel', audience: 'all',
      text: `Add your Discord ID in the dashboard (My Profile, then Discord) so the club can message you directly with reminders and line-ups. It takes a minute, a code is sent to your Discord to confirm it, and you can switch messages off whenever you like. ${siteUrl}`,
      note: r ? `${r.linked} of ${r.members} members have added one so far (${r.verified} verified).` : '' });
    return out;
  }
  return { build };
};
