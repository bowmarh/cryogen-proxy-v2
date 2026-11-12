'use strict';
// Weekly tidy-up so the database does not grow without end and nobody has to do it by hand: old finished-email recipient lists, decided join requests,
// answered feedback, and the "already done" markers the autopilot, radio, reports and Stripe keep so they never repeat themselves. It only removes things
// that are finished and old; it never touches members, results, line-ups, settings or anything still open. The result is shown in the Control room.
module.exports = function createHousekeeping({ redis, now = () => Date.now() }) {
  const DAY = 86400000, LAST = 'cg:housekeeping:last', DONE = 'cg:housekeeping:weeks';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = a => { const o = []; for (let i = 0; i < (a || []).length; i += 2) o.push([a[i], a[i + 1]]); return o; };
  const week = ms => { const d = new Date(ms); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const y = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - y) / DAY + 1) / 7)).padStart(2, '0')}`; };
  const older = (iso, days, t) => { const x = Date.parse(iso); return Number.isFinite(x) && t - x > days * DAY; };
  async function pruneHash(key, days, t) {   // fields whose value is an ISO time
    const [raw] = await redis([['HGETALL', key]]), gone = pairs(raw).filter(([, v]) => older(v, days, t)).map(([f]) => f);
    for (let i = 0; i < gone.length; i += 200) await redis([['HDEL', key, ...gone.slice(i, i + 200)]]);
    return gone.length;
  }
  async function run(t = now()) {
    const out = {};
    // Email: recipient lists and progress of campaigns that finished long ago; the campaign record itself after a year.
    const [camps] = await redis([['HGETALL', 'cg:mail:campaigns']]); let n = 0, m = 0;
    for (const [id, v] of pairs(camps)) { const c = parse(v); if (!c || !['sent', 'cancelled'].includes(c.status)) continue; const at = c.sentAt || c.createdAt;
      if (older(at, 90, t)) { await redis([['DEL', `cg:mail:rcpt:${id}`], ['DEL', `cg:mail:prog:${id}`]]); n++; }
      if (older(at, 365, t)) { await redis([['HDEL', 'cg:mail:campaigns', id]]); m++; } }
    out.emailLists = n; out.emailCampaigns = m;
    // Join requests that were dealt with more than six months ago.
    const [joins] = await redis([['HGETALL', 'cg:join']]), oldJoins = pairs(joins).filter(([, v]) => { const r = parse(v); return r && r.status !== 'open' && older(r.decidedAt || r.at, 180, t); }).map(([f]) => f);
    if (oldJoins.length) await redis([['HDEL', 'cg:join', ...oldJoins]]); out.joinRequests = oldJoins.length;
    // Feedback that was marked done more than three months ago.
    const [fb] = await redis([['LRANGE', 'cg:feedback', 0, 299]]), items = (fb || []).map(parse).filter(Boolean), keep = items.filter(x => !(x.status === 'done' && older(x.at, 90, t)));
    if (keep.length !== items.length) await redis([['DEL', 'cg:feedback'], ...keep.slice().reverse().map(x => ['LPUSH', 'cg:feedback', JSON.stringify(x)])]); out.feedback = items.length - keep.length;
    // "Already done" markers (they only need to outlast the thing they guard).
    out.radio = await pruneHash('cg:aiops:radio', 120, t); out.raceWeek = await pruneHash('cg:raceweek:done', 120, t); out.reports = await pruneHash('cg:aiops:reports', 200, t);
    out.stripeEvents = await pruneHash('cg:stripe:events', 60, t); out.mailMarkers = await pruneHash('cg:mail:auto', 400, t);
    await redis([['SET', LAST, JSON.stringify({ at: new Date(t).toISOString(), removed: out })]]);
    return out;
  }
  // Scheduled: once a week, early on Sunday.
  async function runSchedule(t = now()) {
    const d = new Date(t); if (d.getUTCDay() !== 0 || d.getUTCHours() < 3) return [];
    const [first] = await redis([['HSETNX', DONE, week(t), new Date(t).toISOString()]]); if (!first) return [];
    await run(t).catch(e => console.error('Housekeeping:', e.message)); return [];   // quiet: not an event anyone needs to be told about
  }
  const last = async () => parse((await redis([['GET', LAST]]))[0]);
  return { run, runSchedule, last };
};
