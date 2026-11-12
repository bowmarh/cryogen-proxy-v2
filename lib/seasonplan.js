'use strict';
// Season-long training plans, built from the rider's own FTP with no AI and no cost: a block of 4 to 16 weeks (base, build, peak, taper, with an easier
// week every fourth week), sized to the hours they say they have, ending on their goal race if they give a date. Each week lists the sessions with power
// targets. A rider who has a plan gets that week's sessions as a Monday message (the same messages the coach uses; they can switch these off in My Profile).
module.exports = function createSeasonPlan({ redis, HttpError, memberFromRequest, fetchRoster, notify, now = () => Date.now() }) {
  const K = { plan: 'cg:seasonplan', sent: 'cg:seasonplan:sent' };
  const DAY = 86400000, parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const mondayOf = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
  const w = (ftp, lo, hi) => `${Math.round(ftp * lo)} to ${Math.round(ftp * hi)} W`;
  const ZONES = { easy: [0.56, 0.75, 'Easy endurance (zone 2)'], tempo: [0.76, 0.9, 'Tempo'], threshold: [0.91, 1.05, 'Threshold'], vo2: [1.06, 1.2, 'VO2 max intervals'], sprint: [1.3, 2.0, 'Short hard efforts'] };
  const PHASES = [['Base', 0.5], ['Build', 0.3], ['Peak', 0.12], ['Race and taper', 0.08]];
  function phaseOf(i, n) { let end = 0; for (const [name, share] of PHASES) { end += share * n; if (i < Math.round(end)) return name; } return 'Race and taper'; }
  // The sessions for one week: how many, how long and what, from the phase, the hours and whether it is an easy week.
  function sessions(phase, hours, ftp, easy) {
    const total = Math.round(hours * 60 * (easy ? 0.7 : 1)), n = Math.max(2, Math.min(6, Math.round(hours / 1.25))), long = Math.round(total * 0.34), rest = total - long, each = Math.max(30, Math.round(rest / Math.max(1, n - 1)));
    const key = { Base: ['tempo', 'Tempo blocks: 2 x 15 min'], Build: ['threshold', 'Threshold intervals: 3 x 10 min'], Peak: ['vo2', 'VO2 max: 5 x 3 min hard, 3 min easy'], 'Race and taper': ['vo2', 'Openers: 3 x 2 min hard, then easy'] }[phase];
    const out = [{ day: 'Sat', name: 'Long ride', minutes: long, target: w(ftp, ...ZONES.easy.slice(0, 2)), note: ZONES.easy[2] }];
    if (n >= 2) out.push({ day: 'Tue', name: key[1], minutes: each, target: w(ftp, ...ZONES[key[0]].slice(0, 2)), note: ZONES[key[0]][2] });
    if (n >= 3) out.push({ day: 'Thu', name: phase === 'Base' ? 'Steady endurance' : 'Second quality session', minutes: each, target: w(ftp, ...(phase === 'Base' ? ZONES.easy : ZONES.tempo).slice(0, 2)), note: phase === 'Base' ? ZONES.easy[2] : 'Tempo' });
    if (n >= 4) out.push({ day: 'Sun', name: 'Easy spin', minutes: Math.max(30, Math.round(each * 0.8)), target: w(ftp, 0.5, 0.65), note: 'Recovery' });
    if (n >= 5) out.push({ day: 'Mon', name: 'Easy spin or rest', minutes: Math.max(30, Math.round(each * 0.7)), target: w(ftp, 0.5, 0.65), note: 'Recovery' });
    if (n >= 6) out.push({ day: 'Wed', name: 'Short sprints: 6 x 15 s', minutes: Math.max(30, Math.round(each * 0.7)), target: w(ftp, ...ZONES.sprint.slice(0, 2)), note: ZONES.sprint[2] });
    return out.sort((a, b) => ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(a.day) - ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(b.day));
  }
  function build({ ftp, hours, weeks, goalDate, start }) {
    ftp = Math.round(Number(ftp)); hours = Number(hours); weeks = Math.round(Number(weeks));
    if (!(ftp >= 80 && ftp <= 600)) throw new HttpError(400, 'We need your FTP (80 to 600 W). Set it in your Zwift profile or type it in.');
    if (!(hours >= 2 && hours <= 15)) throw new HttpError(400, 'Hours a week should be between 2 and 15.');
    if (goalDate) { const g = Date.parse(`${goalDate}T00:00:00Z`); if (!Number.isFinite(g)) throw new HttpError(400, 'The race date is not a date.'); weeks = Math.floor((g - Date.parse(`${mondayOf(start)}T00:00:00Z`)) / (7 * DAY)) + 1; }   // the race week is the last week of the plan
    if (!(weeks >= 4 && weeks <= 16)) throw new HttpError(400, goalDate ? 'The race should be between 4 and 16 weeks away.' : 'A plan is 4 to 16 weeks long.');
    const first = mondayOf(start), list = [];
    for (let i = 0; i < weeks; i++) {
      const phase = phaseOf(i, weeks), easy = (i + 1) % 4 === 0 && i < weeks - 1, ramp = phase === 'Base' ? 0.9 + 0.1 * (i / Math.max(1, weeks * 0.5)) : phase === 'Race and taper' ? 0.6 : 1;
      const hrs = Math.round(hours * ramp * 10) / 10, date = new Date(Date.parse(`${first}T00:00:00Z`) + i * 7 * DAY).toISOString().slice(0, 10);
      list.push({ week: i + 1, date, phase, easy, hours: easy ? Math.round(hrs * 0.7 * 10) / 10 : hrs, sessions: sessions(phase, hrs, ftp, easy) });
    }
    return { ftp, hours, weeks, goalDate: goalDate || '', start: first, list };
  }
  const text = (wk, ftp) => `Your plan this week (${wk.phase}${wk.easy ? ', an easier week' : ''}, about ${wk.hours} h):\n${wk.sessions.map(s => `- ${s.day}: ${s.name}, ${s.minutes} min at ${s.target}`).join('\n')}\n\nThese targets use your FTP of ${ftp} W.`;
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  async function load(zwid) { return parse((await redis([['HGET', K.plan, String(zwid)]]))[0]); }
  async function ftpOf(zwid) { try { const { riders } = await fetchRoster(); const r = (riders || []).find(x => String(x.riderId) === String(zwid)); return r ? Number(r.zpFTP) || 0 : 0; } catch (e) { return 0; } }
  const current = (p, t) => { const m = mondayOf(t); return p.list.find(x => x.date === m) || null; };
  const routes = {
    'GET /api/me/season-plan': async req => { const m = need(req), p = await load(m.zwid); return { plan: p, thisWeek: p ? current(p, now()) : null, ftpKnown: await ftpOf(m.zwid) }; },
    'POST /api/me/season-plan': async (req, body) => {
      const m = need(req), ftp = Number(body.ftp) || await ftpOf(m.zwid), p = build({ ftp, hours: body.hours, weeks: body.weeks || 12, goalDate: String(body.goalDate || ''), start: now() });
      const rec = { ...p, created: new Date(now()).toISOString() }; await redis([['HSET', K.plan, String(m.zwid), JSON.stringify(rec)]]); return { plan: rec, thisWeek: current(rec, now()) };
    },
    'POST /api/me/season-plan/delete': async req => { const m = need(req); await redis([['HDEL', K.plan, String(m.zwid)]]); return { ok: true }; },
  };
  // Scheduled: Monday morning (from 7), one message per rider with a plan, once a week.
  async function run(t = now()) {
    const d = new Date(t); if (d.getUTCDay() !== 1 || d.getUTCHours() < 7) return [];
    const [raw] = await redis([['HGETALL', K.plan]]), out = [];
    for (let i = 0; i < (raw || []).length && out.length < 25; i += 2) {
      const p = parse(raw[i + 1]), wk = p && current(p, t); if (!wk) continue;
      if (await notify(raw[i], text(wk, p.ftp), { kind: 'coach', key: `seasonplan:${wk.date}:${raw[i]}` }).catch(() => false)) out.push(`seasonplan-${raw[i]}`);
    }
    return out;
  }
  return { routes, build, run, text, current };
};
