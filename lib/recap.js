'use strict';
// A rider's own race recap: their latest scored ZRL race (position, points, team), how their vELO has moved over the last week or two and their
// 5 and 20 minute W/kg, in a few warm lines. It is built from data the rider can already see about themselves. It is shown only to them; it goes to
// the club channel only when they press the share button (once a day).
module.exports = function createRecap({ redis, HttpError, memberFromRequest, fetchRoster, zrl, discord = async () => false, discordEscape = s => String(s) }) {
  const SNAP = 'cg:fair:snap', SHARED = 'cg:recap:shared', DAY = 86400000;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  const ordinal = n => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };

  async function build(member, now = Date.now()) {
    const z = String(member.zwid), today = iso(now);
    const [[snapRaw], roster] = await Promise.all([redis([['HGET', SNAP, z]]), fetchRoster().catch(() => ({ riders: [] }))]);
    const rider = (roster.riders || []).find(r => String(r.riderId) === z) || null;
    const hist = (parse(snapRaw) || []).filter(x => x && x.d).sort((a, b) => a.d.localeCompare(b.d));
    const nowV = Math.round(Number(rider && rider.race && rider.race.current && rider.race.current.rating) || 0);
    const p5 = Number(rider && rider.power && rider.power.wkg300) || 0, p20 = Number(rider && rider.power && rider.power.wkg1200) || 0;

    // vELO movement: against the reading closest to a week ago, within the last two weeks (the daily Fair play check keeps these).
    let velo = nowV ? { now: nowV, change: null, days: null } : null;
    if (nowV) {
      const target = now - 7 * DAY, pool = hist.filter(x => x.v && x.d < today && Date.parse(x.d + 'T12:00:00Z') >= now - 15 * DAY);
      const then = pool.sort((a, b) => Math.abs(Date.parse(a.d + 'T12:00:00Z') - target) - Math.abs(Date.parse(b.d + 'T12:00:00Z') - target))[0];
      if (then) velo = { now: nowV, change: nowV - then.v, days: Math.max(1, Math.round((now - Date.parse(then.d + 'T12:00:00Z')) / DAY)) };
    }

    // The latest ZRL race this rider was picked for that has a result.
    let race = null;
    try {
      const data = await zrl.load();
      if (data.round) {
        const my = zrl.myZrl(data, member, data.weekly, await zrl.loadResults());
        const w = my.weeks.filter(x => x.date <= today && x.picked && x.result && (x.result.pos || x.result.pts != null)).pop();
        if (w) race = { round: data.round.name, week: w.i + 1, date: w.date, pos: w.result.pos, pts: w.result.pts, team: my.team ? my.team.name : '' };
      }
    } catch (e) { /* the recap still works without a ZRL result */ }

    const lines = [];
    if (race) lines.push(`🚀 ZRL ${race.round}, race ${race.week}: ${race.pos ? ordinal(race.pos) : 'finished'}${race.pts != null ? `, ${race.pts} points` : ''}${race.team ? ` with ${race.team}` : ''}`);
    if (velo) lines.push(`📈 vELO ${velo.now}${velo.change ? ` (${velo.change > 0 ? '+' : ''}${velo.change} in ${velo.days} days)` : ''}`);
    if (p5 || p20) lines.push(`⚡ ${[p5 && `5 min ${p5.toFixed(2)} W/kg`, p20 && `20 min ${p20.toFixed(2)} W/kg`].filter(Boolean).join(' · ')}`);
    const first = String(member.name || (rider && rider.name) || 'rider').split(/\s+/)[0];
    const headline = race && race.pos && race.pos <= 3 ? `Podium, ${first}! 🏆` : velo && velo.change > 0 ? `Nice climb, ${first}!` : `Your latest recap, ${first}`;
    return { name: member.name || (rider && rider.name) || '', headline, race, velo, wkg: { five: p5 || null, twenty: p20 || null }, lines, empty: !lines.length };
  }

  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  const routes = {
    'GET /api/me/recap': async req => build(need(req)),
    // Posted to the club channel only when the rider presses the button, and at most once a day.
    'POST /api/me/recap/share': async req => {
      const m = need(req);
      if (!process.env.DISCORD_WEBHOOK_PUBLIC) throw new HttpError(409, 'The club channel is not set up yet.');
      const r = await build(m);
      if (r.empty) throw new HttpError(409, 'There is nothing to share yet.');
      const [fresh] = await redis([['HSETNX', SHARED, `${m.zwid}:${iso(Date.now())}`, '1']]);
      if (!fresh) throw new HttpError(429, 'You already shared a recap today.');
      const ok = await discord('public', { content: `⭐ **${discordEscape(r.name)}**\n${r.lines.map(discordEscape).join('\n')}` });
      return { ok };
    },
  };
  return { routes, build };
};
