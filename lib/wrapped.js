'use strict';
// "Wrapped": a rider's own season in a few numbers and a few plain sentences, for them to save as a picture or share. It uses what the club already
// holds about them (their roster record, their season, their vELO line, their badges), is shown only to them, and goes to the club channel only when
// they press the share button (once a day).
module.exports = function createWrapped({ redis, HttpError, memberFromRequest, season, fetchRoster, badgesFrom, discord = async () => false, discordEscape = s => String(s) }) {
  const VELO = 'cg:rider:velo', SHARED = 'cg:wrapped:shared';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const n = v => Number(v) || 0;
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;

  async function build(member) {
    const z = String(member.zwid);
    const [s, roster, [veloRaw]] = await Promise.all([season(member).catch(() => null), fetchRoster().catch(() => ({ riders: [] })), redis([['HGET', VELO, z]])]);
    const rider = (roster.riders || []).find(r => String(r.riderId) === z) || null, race = (rider && rider.race) || {};
    const line = (parse(veloRaw) || []).filter(p => Array.isArray(p) && p[1] > 0);
    const velo = rider && race.current && race.current.rating ? { now: Math.round(race.current.rating), from: line.length ? line[0][1] : null, since: line.length ? line[0][0] : null } : null;
    if (velo && velo.from != null) velo.change = velo.now - velo.from;
    const b = badgesFrom(s, rider), zr = (s && s.zrl) || {}, tt = (s && s.ttt) || {}, rd = (s && s.rides) || {}, cv = (s && s.cover) || {};
    const stats = [];
    const add = (icon, label, value) => { if (value) stats.push({ icon, label, value: String(value) }); };
    add('🏁', 'Races finished', n(race.finishes));
    add('🥇', 'Wins', n(race.wins));
    add('🏆', 'Podiums', Math.max(n(race.podiums), n(zr.podiums) + n(tt.podiums)));
    add('🚀', 'ZRL races you were picked for', zr.placed ? `${n(zr.picked)} of ${n(zr.races)}` : '');
    add('⏱️', 'TTT weeks raced', n(tt.weeks));
    add('☕', 'Social rides', n(rd.attended));
    add('🧭', 'Rides led or swept', n(cv.led) + n(cv.swept));
    if (velo && velo.change) add('📈', `vELO since ${velo.since}`, `${velo.change > 0 ? '+' : ''}${velo.change} (now ${velo.now})`); else if (velo) add('📈', 'vELO', velo.now);
    const p5 = n(rider && rider.power && rider.power.wkg300), p20 = n(rider && rider.power && rider.power.wkg1200);
    if (p5 || p20) add('⚡', 'W/kg', [p5 && `${p5.toFixed(2)} (5 min)`, p20 && `${p20.toFixed(2)} (20 min)`].filter(Boolean).join(' · '));
    add('🏅', 'Badges earned', b.earned.length);
    const first = String(member.name || (rider && rider.name) || 'rider').split(/\s+/)[0];
    const lines = [];
    if (n(race.finishes)) lines.push(`${plural(n(race.finishes), 'race', 'races')} finished${n(race.wins) ? `, ${plural(n(race.wins), 'win', 'wins')}` : ''}${Math.max(n(race.podiums), n(zr.podiums) + n(tt.podiums)) ? `, ${plural(Math.max(n(race.podiums), n(zr.podiums) + n(tt.podiums)), 'podium', 'podiums')}` : ''}`);
    if (velo && velo.change > 0) lines.push(`vELO up ${velo.change} to ${velo.now}`);
    if (n(rd.attended)) lines.push(`${plural(n(rd.attended), 'social ride', 'social rides')} with the club`);
    if (b.earned.length) lines.push(`${plural(b.earned.length, 'badge', 'badges')}: ${b.earned.slice(0, 4).map(x => x.label).join(', ')}`);
    return { name: member.name || (rider && rider.name) || '', title: `${first}'s season`, season: (tt && tt.season) || (zr && zr.round) || '', stats, lines, badges: b.earned.map(x => ({ icon: x.icon, label: x.label })), empty: stats.length < 2 };
  }

  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  return { build, routes: {
    'GET /api/me/wrapped': async req => build(need(req)),
    'POST /api/me/wrapped/share': async req => {
      const m = need(req);
      if (!process.env.DISCORD_WEBHOOK_PUBLIC) throw new HttpError(409, 'The club channel is not set up yet.');
      const w = await build(m); if (w.empty) throw new HttpError(409, 'There is not enough to share yet: race or ride with the club first.');
      const [fresh] = await redis([['HSETNX', SHARED, `${m.zwid}:${new Date().toISOString().slice(0, 10)}`, '1']]);
      if (!fresh) throw new HttpError(429, 'You already shared your season today.');
      return { ok: await discord('public', { content: `🎁 **${discordEscape(w.title)}**${w.season ? ` (${discordEscape(w.season)})` : ''}\n${w.lines.map(discordEscape).join('\n')}` }) };
    },
  } };
};
