'use strict';
// The new-member welcome: the first time a new member signs in, a full-screen "Get set up" step they cannot skip puts the three club channels in front of them
// (Discord, the ZwiftPower team, the Facebook group); once those are done it shows every racing series the club promotes with a one-tap route into each.
//  - Discord is verified by the app (the member's linked account).
//  - ZwiftPower and Facebook cannot be checked from here, so the member confirms they have asked to join; a volunteer then marks the ZwiftPower request accepted
//    (staff see the waiting list), because ZwiftPower team requests are accepted by hand.
// Only members who are new (appeared after onboarding began, first 60 days) see it; the owner can switch it off, and the links live in settings, not code.
module.exports = function createWelcome({ redis, HttpError, requireRole, memberFromRequest, isStaff, verifiedLinks, nameOf = async z => z, env = process.env, discord = async () => false, siteUrl = '', now = () => Date.now() }) {
  const SET = 'cg:welcome:settings', STATE = 'cg:welcome:state', SEEN = 'cg:onboard:seen', DAY = 86400000, NEW_DAYS = 60;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const url = v => { const s = String(v || '').trim(); return /^https:\/\/[^\s<>"']{4,300}$/i.test(s) ? s : ''; };
  const need = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account first.'); return m; };
  async function settings() {
    const s = parse((await redis([['GET', SET]]))[0]) || {};
    const links = { discord: url((s.links || {}).discord) || url(env.CLUB_DISCORD_URL), zwiftpower: url((s.links || {}).zwiftpower) || url(env.CLUB_ZWIFTPOWER_URL), facebook: url((s.links || {}).facebook) || url(env.CLUB_FACEBOOK_URL) };
    return { on: s.on !== false, links };
  }
  // The racing the club promotes, in the order a new rider should meet it. `tab` is the dashboard page that signs them up.
  const SERIES = [
    { id: 'zrl', title: 'ZRL team racing', blurb: 'The Zwift Racing League: join a CRYO-GEN team and race the weekly rounds against other clubs.', tab: 'zrl', cta: 'Sign up for ZRL' },
    { id: 'ttt', title: 'Team time trials', blurb: 'Our weekly TTT: ride as a team, work together, post a time. Good first race.', tab: 'ttt', cta: 'See this week\'s TTT' },
    { id: 'drs', title: 'DIRT racing', blurb: 'The DIRT series: gravel and mixed-surface racing on Zwift.', tab: 'drs', cta: 'Join the DIRT series' },
    { id: 'ladder', title: 'The Ladder', blurb: 'Head-to-head club ladder matches: challenge someone near your level.', tab: 'ladder', cta: 'See the Ladder' },
    { id: 'rides', title: 'Social rides', blurb: 'Relaxed group rides with ride leaders. No pressure, just company.', tab: 'rides', cta: 'Find a social ride' },
    { id: 'events', title: 'Everything else', blurb: 'All the events and sign-ups in one place.', tab: 'events', cta: 'Browse events' },
  ];
  // New = recorded by the onboarding scan inside the last 60 days and not one of the members already in the club when it began. A member who appears after the first scan
  // and has not been recorded yet is recorded here, exactly as the scan would.
  async function isNew(zwid) {
    const [raw, n] = await redis([['HGET', SEEN, zwid], ['HLEN', SEEN]]); let s = parse(raw);
    if (!s) { if (!Number(n)) return false; s = { at: new Date(now()).toISOString(), seed: false }; await redis([['HSETNX', SEEN, zwid, JSON.stringify(s)]]); }
    return !s.seed && now() - Date.parse(s.at) <= NEW_DAYS * DAY;
  }
  const stateOf = async z => parse((await redis([['HGET', STATE, z]]))[0]) || {};
  async function view(req) {
    const m = need(req), z = String(m.zwid), cfg = await settings();
    if (!cfg.on || m.assoc === true || !(await isNew(z))) return { show: false };
    const st = await stateOf(z); if (st.done) return { show: false };
    const linked = (await verifiedLinks().catch(() => new Set())).has(z);
    const steps = [
      { id: 'discord', title: 'Join and link Discord', why: 'It is how captains, ride leaders and race-day reminders reach you.', url: cfg.links.discord, done: linked, auto: true, action: linked ? '' : 'Connect Discord' },
      cfg.links.zwiftpower && { id: 'zwiftpower', title: 'Join Team CRYO-GEN on ZwiftPower', why: 'Our races and results are tied to the ZwiftPower team. A volunteer accepts your request, usually within a day.', url: cfg.links.zwiftpower, done: !!st.zp, accepted: !!st.zpOk, action: 'Open the ZwiftPower team' },
      cfg.links.facebook && { id: 'facebook', title: 'Join the Facebook group', why: 'Where the club shares news, photos and plans.', url: cfg.links.facebook, done: !!st.fb, action: 'Open the Facebook group' },
    ].filter(Boolean);
    const stage = steps.every(s => s.done) ? 2 : 1;
    return { show: true, stage, steps, series: stage === 2 ? SERIES : [], name: m.name };
  }
  async function confirm(req, body) {
    const m = need(req), z = String(m.zwid), step = String(body.step || ''), cfg = await settings();
    if (!['zwiftpower', 'facebook'].includes(step) || !cfg.links[step]) throw new HttpError(400, 'That step cannot be confirmed here.');
    const st = await stateOf(z), key = step === 'zwiftpower' ? 'zp' : 'fb'; if (!st[key]) { st[key] = new Date(now()).toISOString(); await redis([['HSET', STATE, z, JSON.stringify(st)]]); if (step === 'zwiftpower') await discord('admin', { content: `🔔 **ZwiftPower team request:** ${m.name} (Zwift ID ${z}) says they have asked to join. Accept them on ZwiftPower, then mark them accepted: ${siteUrl}/ → Control room → Join requests.` }).catch(() => {}); }
    return view(req);
  }
  async function finish(req) {
    const v = await view(req); if (!v.show) return { ok: true };
    if (v.stage !== 2) throw new HttpError(409, 'Please finish the steps first.');
    const z = String(need(req).zwid), st = await stateOf(z); st.done = new Date(now()).toISOString(); await redis([['HSET', STATE, z, JSON.stringify(st)]]); return { ok: true };
  }
  async function queue() {
    const [raw] = await redis([['HGETALL', STATE]]), out = [];
    for (let i = 0; i < (raw || []).length; i += 2) { const s = parse(raw[i + 1]); if (s && s.zp && !s.zpOk) out.push({ zwid: raw[i], since: s.zp });
    for (const o of out) o.name = await nameOf(o.zwid).catch(() => o.zwid); }
    return out.sort((a, b) => a.since.localeCompare(b.since));
  }
  const routes = {
    'GET /api/me/welcome': async req => view(req),
    'POST /api/me/welcome/confirm': async (req, body) => confirm(req, body),
    'POST /api/me/welcome/finish': async req => finish(req),
    'GET /api/welcome/queue': async req => { requireRole(req, ['admin', 'mod']); return { settings: await settings(), waiting: await queue() }; },
    'POST /api/welcome/zp-accepted': async (req, body) => {
      requireRole(req, ['admin', 'mod']); const z = String(body.zwid || ''); if (!/^\d{1,12}$/.test(z)) throw new HttpError(400, 'Enter a Zwift ID.');
      const st = await stateOf(z); st.zp = st.zp || new Date(now()).toISOString(); st.zpOk = new Date(now()).toISOString(); await redis([['HSET', STATE, z, JSON.stringify(st)]]); return { ok: true };
    },
    'POST /api/welcome/settings': async (req, body) => {
      requireRole(req, ['admin']); const l = body.links || {}, n = { on: body.on !== false, links: { discord: url(l.discord), zwiftpower: url(l.zwiftpower), facebook: url(l.facebook) } };
      for (const k of ['discord', 'zwiftpower', 'facebook']) if (l[k] && !n.links[k]) throw new HttpError(400, `The ${k} link must be a full https:// address.`);
      await redis([['SET', SET, JSON.stringify(n)]]); return { settings: await settings() };
    },
  };
  return { routes, view, settings, SERIES };
};
