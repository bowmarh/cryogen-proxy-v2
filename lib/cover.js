'use strict';
// Ride cover: the weekly social rides need a leader and a sweeper, each with a back-up. Staff set up each regular ride once (a "series":
// weekday, time, owner) and the next weeks are created automatically. Approved leaders and sweepers offer for a date, or once for "most weeks";
// the scheduled tick calls out the gaps, chases them, alerts the ride owner and confirms the cover the day before. Messages go to a webhook
// (RIDE_COVER_WEBHOOK_URL: Zapier, Make or Twilio turn it into WhatsApp) and fall back to Discord when it is not set or does not answer.
// Lives outside api/ on purpose (every file in api/ becomes a public function).
module.exports = function createCover({ redis, HttpError, text, requireRole, roleFromRequest, memberFromRequest, discord, discordEscape, teamId, siteUrl }) {
  const KEYS = {
    series: 'cg:cover:series',        // series id -> JSON
    slots: 'cg:cover:slots',          // "<series>|<date>|<role>" -> {zwid, name, at}
    approved: 'cg:cover:approved',    // zwid -> {zwid, name, lead, sweep, at}
    standing: 'cg:cover:standing',    // "<series>|<zwid>" -> {zwid, name, lead, sweep, at}: "most weeks"
    cancelled: 'cg:cover:cancelled',  // "<series>|<date>" -> ISO time
    optout: 'cg:cover:optout',        // "<series>|<date>|<zwid>" -> ISO time: withdrew, so a standing offer must not put them back
    sent: 'cg:cover:sent',            // notice keys -> ISO time, so each is sent once
  };
  const ROLES = ['leader', 'leader2', 'sweeper', 'sweeper2'];
  const LABEL = { leader: 'Leader', leader2: 'Leader back-up', sweeper: 'Sweeper', sweeper2: 'Sweeper back-up' };
  const KIND = { leader: 'lead', leader2: 'lead', sweeper: 'sweep', sweeper2: 'sweep' };
  const BACKUP = { leader: 'leader2', sweeper: 'sweeper2' };
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_MS = 86400000;
  const DEFAULT_ZONE = 'Europe/London';
  const WINDOW_WEEKS = 4;

  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const isStaff = req => ['admin', 'mod'].includes(roleFromRequest(req));
  const pad = n => String(n).padStart(2, '0');

  // ── Time: a ride is "weekday + local time in a zone", so it follows daylight saving ──
  const partsIn = (zone, ms) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    .formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const offsetMin = (zone, ms) => { const p = partsIn(zone, ms); return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ms / 60000) * 60000) / 60000); };
  const localToMs = (date, time, zone) => {
    const [y, m, d] = date.split('-').map(Number), [hh, mm] = time.split(':').map(Number), guess = Date.UTC(y, m - 1, d, hh, mm);
    let ms = guess - offsetMin(zone, guess) * 60000;
    ms = guess - offsetMin(zone, ms) * 60000;
    return ms;
  };
  const localDate = (zone, ms) => { const p = partsIn(zone, ms); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
  const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
  const dowOf = date => new Date(`${date}T12:00:00Z`).getUTCDay();
  const validZone = zone => { try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch (e) { return false; } };
  const whenLabel = (o, zone) => `${new Date(o.startMs).toLocaleString('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
  // The ISO week of a UK date, e.g. "2026-W45", so a weekly notice goes out once a week.
  const isoWeek = ms => {
    const d = new Date(`${localDate(DEFAULT_ZONE, ms)}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const y = d.getUTCFullYear();
    return `${y}-W${pad(Math.ceil(((d - Date.UTC(y, 0, 1)) / DAY_MS + 1) / 7))}`;
  };

  // The coming dates of one series, newest rides still in progress included.
  function occurrencesOf(series, now, weeks = WINDOW_WEEKS) {
    const out = [], base = localDate(series.zone, now), last = now + weeks * 7 * DAY_MS;
    for (let k = -1; k <= weeks * 7; k++) {
      const date = addDays(base, k);
      if (dowOf(date) !== series.dow) continue;
      const startMs = localToMs(date, series.time, series.zone);
      if (startMs >= now - 2 * 3600000 && startMs <= last) out.push({ series: series.id, date, startMs, id: `${series.id}|${date}` });
    }
    return out;
  }

  // ── Storage ──
  async function load() {
    const [series, slots, approved, standing, cancelled, optout] = await redis(['series', 'slots', 'approved', 'standing', 'cancelled', 'optout'].map(k => ['HGETALL', KEYS[k]]));
    const obj = raw => Object.fromEntries(pairs(raw).map(([f, v]) => [f, parse(v)]).filter(([, v]) => v));
    return {
      series: Object.values(obj(series)).filter(s => s.id).sort((a, b) => a.dow - b.dow || a.time.localeCompare(b.time) || a.title.localeCompare(b.title)),
      slots: obj(slots), approved: obj(approved), standing: obj(standing),
      cancelled: new Set(pairs(cancelled).map(([f]) => f)), optout: new Set(pairs(optout).map(([f]) => f)),
    };
  }
  const slotOf = (data, occ, role) => data.slots[`${occ.id}|${role}`] || null;
  const coverOf = (data, occ) => Object.fromEntries(ROLES.map(r => [r, slotOf(data, occ, r)]));
  const gapsOf = (data, occ) => ROLES.filter(r => !slotOf(data, occ, r));
  const needsPrimary = (data, occ) => ['leader', 'sweeper'].filter(r => !slotOf(data, occ, r));
  const gapText = roles => roles.map(r => LABEL[r].toLowerCase()).join(', ');

  // A back-up moves up when its primary is empty. Returns the commands that make it so (and updates data).
  function promotions(data, occ) {
    const cmds = [];
    for (const primary of ['leader', 'sweeper']) {
      const backup = BACKUP[primary];
      if (!slotOf(data, occ, primary) && slotOf(data, occ, backup)) {
        const s = slotOf(data, occ, backup);
        data.slots[`${occ.id}|${primary}`] = s; delete data.slots[`${occ.id}|${backup}`];
        cmds.push(['HSET', KEYS.slots, `${occ.id}|${primary}`, JSON.stringify(s)], ['HDEL', KEYS.slots, `${occ.id}|${backup}`]);
      }
    }
    return cmds;
  }

  // ── Messages: webhook first (WhatsApp via Zapier/Make/Twilio), Discord when that is not set up or does not answer ──
  async function notify(channel, content, extra = {}) {
    const msg = String(content).slice(0, 1900);
    const url = process.env.RIDE_COVER_WEBHOOK_URL;
    if (url && /^https:\/\//i.test(url)) {
      try {
        const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'cryogen-ride-cover', channel, text: msg, ...extra }), signal: AbortSignal.timeout(5000) });
        if (r.ok) return 'webhook';
        console.error(`Ride cover webhook returned ${r.status}`);
      } catch (e) { console.error('Ride cover webhook failed:', e.message); }
    }
    return (await discord(channel === 'admin' ? 'admin' : 'public', { content: msg })) ? 'discord' : '';
  }

  const fullLine = (series, o, data) => {
    const cover = coverOf(data, o), line = ROLES.filter(r => cover[r]).map(r => `${LABEL[r]} ${discordEscape(cover[r].name)}`);
    const gaps = gapsOf(data, o);
    return `• ${whenLabel(o, series.zone)}: ${discordEscape(series.title)}${line.length ? ` — ${line.join(', ')}` : ''}${gaps.length ? ` — ⚠️ still needed: ${gapText(gaps)}` : ' — ✅ fully covered'}`;
  };

  function calloutText(data, now, days = 14) {
    const lines = [];
    for (const s of data.series.filter(x => x.active !== false)) for (const o of occurrencesOf(s, now, Math.ceil(days / 7))) {
      if (data.cancelled.has(o.id) || o.startMs > now + days * DAY_MS) continue;
      const gaps = gapsOf(data, o);
      if (gaps.length) lines.push(`• ${whenLabel(o, s.zone)}: ${discordEscape(s.title)}${s.pace ? ` (${discordEscape(s.pace)})` : ''} needs ${gapText(gaps)}`);
    }
    if (!lines.length) return null;
    return `🚴 **Ride cover needed (next ${days === 14 ? '2 weeks' : `${days} days`})**\n${lines.slice(0, 20).join('\n')}${lines.length > 20 ? `\n…and ${lines.length - 20} more` : ''}\nApproved leaders and sweepers: offer at ${siteUrl} → 🚴 Social Rides → Ride cover. A back-up for each role means a ride never runs without cover.`;
  }

  // ── The view ──
  function view(data, req, now = Date.now()) {
    const staff = isStaff(req), member = memberFromRequest(req);
    const me = member ? { zwid: member.zwid, name: member.name, approved: data.approved[member.zwid] ? { lead: !!data.approved[member.zwid].lead, sweep: !!data.approved[member.zwid].sweep } : null,
      standing: Object.fromEntries(data.series.map(s => [s.id, data.standing[`${s.id}|${member.zwid}`] ? { lead: !!data.standing[`${s.id}|${member.zwid}`].lead, sweep: !!data.standing[`${s.id}|${member.zwid}`].sweep } : null]).filter(([, v]) => v)) } : null;
    return {
      roles: ROLES.map(r => ({ id: r, label: LABEL[r], kind: KIND[r] })),
      series: data.series.map(s => ({
        ...s, canManage: staff || !!(member && s.ownerZwid && s.ownerZwid === member.zwid),
        occurrences: occurrencesOf(s, now).map(o => ({ date: o.date, startMs: o.startMs, cancelled: data.cancelled.has(o.id), cover: coverOf(data, o), gaps: gapsOf(data, o) })),
      })),
      me, staff,
      approved: staff ? Object.values(data.approved).sort((a, b) => a.name.localeCompare(b.name)) : undefined,
      webhook: staff ? !!process.env.RIDE_COVER_WEBHOOK_URL : undefined,
    };
  }

  // ── Who may do what ──
  const seriesOr404 = (data, id) => { const s = data.series.find(x => x.id === String(id || '')); if (!s) throw new HttpError(404, 'That ride does not exist.'); return s; };
  function occurrenceOf(data, body, now) {
    const s = seriesOr404(data, body.series), date = String(body.date || '');
    const occ = occurrencesOf(s, now).find(o => o.date === date);
    if (!occ) throw new HttpError(404, 'That date is not one of the coming rides.');
    return { s, occ };
  }
  const canManage = (req, s) => { const m = memberFromRequest(req); return isStaff(req) || !!(m && s.ownerZwid && s.ownerZwid === m.zwid); };
  const roleOf = body => { const r = String(body.role || ''); if (!ROLES.includes(r)) throw new HttpError(400, 'Choose leader, leader back-up, sweeper or sweeper back-up.'); return r; };
  const requireMember = req => { const m = memberFromRequest(req); if (!m) throw new HttpError(401, 'Sign in with your cryogen.team account.'); return m; };
  const requireSignedIn = req => { if (!isStaff(req) && !memberFromRequest(req)) throw new HttpError(401, 'Sign in with your cryogen.team account.'); };

  // The person currently in any slot of an occurrence, if any.
  const slotHeldBy = (data, occ, zwid) => ROLES.find(r => slotOf(data, occ, r) && slotOf(data, occ, r).zwid === zwid && zwid);

  async function writeSlot(data, occ, role, person) {
    // Someone never holds two slots on one ride.
    const cmds = [];
    const held = person.zwid ? slotHeldBy(data, occ, person.zwid) : null;
    if (held && held !== role) { cmds.push(['HDEL', KEYS.slots, `${occ.id}|${held}`]); delete data.slots[`${occ.id}|${held}`]; }
    const value = { zwid: person.zwid || '', name: person.name, at: new Date().toISOString() };
    data.slots[`${occ.id}|${role}`] = value;
    cmds.push(['HSET', KEYS.slots, `${occ.id}|${role}`, JSON.stringify(value)]);
    cmds.push(...promotions(data, occ));
    await redis(cmds);
  }

  // ── Standing offers ("I can sweep most weeks") fill empty slots up to three weeks ahead, and never put back someone who withdrew ──
  async function fillStanding(data, now) {
    const offers = Object.values(data.standing).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const cmds = [];
    for (const s of data.series.filter(x => x.active !== false)) {
      for (const o of occurrencesOf(s, now, 3)) {
        if (data.cancelled.has(o.id)) continue;
        for (const offer of offers.filter(x => x.series === s.id)) {
          if (data.optout.has(`${o.id}|${offer.zwid}`) || slotHeldBy(data, o, offer.zwid)) continue;
          const order = ['leader', 'sweeper', 'leader2', 'sweeper2'].filter(r => (KIND[r] === 'lead' ? offer.lead : offer.sweep));
          const free = order.find(r => !slotOf(data, o, r));
          if (!free) continue;
          const value = { zwid: offer.zwid, name: offer.name, at: new Date().toISOString(), standing: true };
          data.slots[`${o.id}|${free}`] = value;
          cmds.push(['HSET', KEYS.slots, `${o.id}|${free}`, JSON.stringify(value)]);
        }
        cmds.push(...promotions(data, o));
      }
    }
    if (cmds.length) await redis(cmds);
    return cmds.length > 0;
  }

  // ── The routes ──
  const getView = async req => view(await load(), req);
  const routes = {
    'GET /api/cover': async req => { requireSignedIn(req); return getView(req); },

    'GET /api/cover/callout': async req => {
      requireSignedIn(req);
      const t = calloutText(await load(), Date.now());
      return { text: t ? t.replace(/\*\*/g, '*').replace(/\\([*_~`|>[\]\\])/g, '$1') : null };   // WhatsApp bold is a single asterisk
    },

    'POST /api/cover/series': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const title = text(body.title, 'ride name', 80);
      const dow = Number(body.dow);
      if (!(Number.isInteger(dow) && dow >= 0 && dow <= 6)) throw new HttpError(400, 'Choose the day of the week.');
      const time = String(body.time || '');
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new HttpError(400, 'The start time looks like 19:00.');
      const zone = String(body.zone || DEFAULT_ZONE);
      if (!validZone(zone)) throw new HttpError(400, 'That time zone is not known (for example Europe/London).');
      const ownerZwid = /^\d{1,12}$/.test(String(body.ownerZwid || '')) ? String(body.ownerZwid) : '';
      const data = await load();
      const id = body.id ? String(body.id) : `${teamId(title)}-${DOW[dow].toLowerCase()}${time.replace(':', '')}`;
      if (!body.id && data.series.some(s => s.id === id)) throw new HttpError(409, 'That ride is already set up.');
      if (body.id && !data.series.some(s => s.id === id)) throw new HttpError(404, 'That ride does not exist.');
      const series = { id, title, dow, time, zone, pace: text(body.pace, 'pace', 40, false), cat: text(body.cat, 'category', 20, false),
        ownerName: text(body.ownerName, 'owner', 60, false), ownerZwid, active: body.active !== false, source: body.source === 'ical' ? 'ical' : 'dashboard' };
      await redis([['HSET', KEYS.series, id, JSON.stringify(series)]]);
      return getView(req);
    },

    'POST /api/cover/series-remove': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const data = await load(), s = seriesOr404(data, body.id);
      const stale = [...Object.keys(data.slots), ...Object.keys(data.standing), ...data.cancelled, ...data.optout].filter(f => f.startsWith(`${s.id}|`));
      await redis([['HDEL', KEYS.series, s.id], ...stale.flatMap(f => [['HDEL', KEYS.slots, f], ['HDEL', KEYS.standing, f], ['HDEL', KEYS.cancelled, f], ['HDEL', KEYS.optout, f]])]);
      return getView(req);
    },

    // Staff: who may lead and sweep. Neither ticked removes the person.
    'POST /api/cover/approve': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const zwid = String(body.zwid || '');
      if (!/^\d{1,12}$/.test(zwid)) throw new HttpError(400, 'A Zwift ID is needed (numbers only).');
      const lead = !!body.lead, sweep = !!body.sweep;
      if (!lead && !sweep) await redis([['HDEL', KEYS.approved, zwid]]);
      else await redis([['HSET', KEYS.approved, zwid, JSON.stringify({ zwid, name: text(body.name, 'name', 60), lead, sweep, at: new Date().toISOString() })]]);
      return getView(req);
    },

    // An approved member offers for one date: the primary role if free, otherwise its back-up.
    'POST /api/cover/volunteer': async (req, body) => {
      const m = requireMember(req);
      const data = await load(), now = Date.now(), { occ } = occurrenceOf(data, body, now);
      const role = roleOf(body), kind = KIND[role], base = role.replace('2', '');
      const ok = data.approved[m.zwid];
      if (!ok || !ok[kind]) throw new HttpError(403, `The ride owners have not approved you as a ${kind === 'lead' ? 'leader' : 'sweeper'} yet. Ask in Discord.`);
      if (data.cancelled.has(occ.id)) throw new HttpError(409, 'That ride is cancelled.');
      if (slotHeldBy(data, occ, m.zwid)) throw new HttpError(409, 'You are already covering that ride.');
      const target = !slotOf(data, occ, base) ? base : !slotOf(data, occ, BACKUP[base]) ? BACKUP[base] : null;
      if (!target) throw new HttpError(409, `The ${LABEL[base].toLowerCase()} and its back-up are both taken.`);
      await writeSlot(data, occ, target, m);
      await redis([['HDEL', KEYS.optout, `${occ.id}|${m.zwid}`]]);
      return getView(req);
    },

    // Take yourself off a ride (staff and the ride's owner can take anyone off). A back-up moves up and the owner is told.
    'POST /api/cover/withdraw': async (req, body) => {
      requireSignedIn(req);
      const data = await load(), now = Date.now(), { s, occ } = occurrenceOf(data, body, now);
      const role = roleOf(body), cur = slotOf(data, occ, role), me = memberFromRequest(req);
      if (!cur) throw new HttpError(409, 'Nobody is in that slot.');
      if (!canManage(req, s) && !(me && cur.zwid === me.zwid)) throw new HttpError(403, 'You can only take yourself off a ride.');
      delete data.slots[`${occ.id}|${role}`];
      const cmds = [['HDEL', KEYS.slots, `${occ.id}|${role}`]];
      if (cur.zwid) cmds.push(['HSET', KEYS.optout, `${occ.id}|${cur.zwid}`, new Date().toISOString()]);
      cmds.push(...promotions(data, occ));
      await redis(cmds);
      if (occ.startMs - now < 14 * DAY_MS && me && cur.zwid === me.zwid) {
        const left = needsPrimary(data, occ), now1 = slotOf(data, occ, role.replace('2', ''));
        const moved = role === role.replace('2', '') && now1 ? ` ${discordEscape(now1.name)} has moved up from back-up.` : '';
        await notify('admin', `⚠️ ${discordEscape(cur.name)} is off ${discordEscape(s.title)} on ${whenLabel(occ, s.zone)} (${LABEL[role].toLowerCase()}).${moved}${left.length ? ` Still no ${gapText(left)}.` : ''}${s.ownerName ? ` Owner: ${discordEscape(s.ownerName)}.` : ''} ${siteUrl} → 🚴 Social Rides.`, { kind: 'withdraw', series: s.id, date: occ.date });
      }
      return getView(req);
    },

    // The ride's owner (or staff) puts a named person in a slot.
    'POST /api/cover/assign': async (req, body) => {
      const data = await load(), now = Date.now(), { s, occ } = occurrenceOf(data, body, now);
      if (!canManage(req, s)) throw new HttpError(403, 'Only the ride owner or the staff can assign cover.');
      const role = roleOf(body);
      const zwid = /^\d{1,12}$/.test(String(body.zwid || '')) ? String(body.zwid) : '';
      await writeSlot(data, occ, role, { zwid, name: text(body.name, 'name', 60) });
      return getView(req);
    },

    'POST /api/cover/cancel-date': async (req, body) => {
      const data = await load(), { s, occ } = occurrenceOf(data, body, Date.now());
      if (!canManage(req, s)) throw new HttpError(403, 'Only the ride owner or the staff can cancel a ride.');
      await redis([body.cancelled === false ? ['HDEL', KEYS.cancelled, occ.id] : ['HSET', KEYS.cancelled, occ.id, new Date().toISOString()]]);
      return getView(req);
    },

    // "I can lead / sweep most weeks": filled in by the scheduled tick (and straight away) for the coming dates.
    'POST /api/cover/standing': async (req, body) => {
      const m = requireMember(req);
      const data = await load(), s = seriesOr404(data, body.series), ok = data.approved[m.zwid];
      const lead = !!body.lead && !!ok && !!ok.lead, sweep = !!body.sweep && !!ok && !!ok.sweep;
      if ((body.lead || body.sweep) && !lead && !sweep) throw new HttpError(403, 'The ride owners have not approved you for that role yet.');
      const field = `${s.id}|${m.zwid}`;
      if (!lead && !sweep) { await redis([['HDEL', KEYS.standing, field]]); delete data.standing[field]; }
      else {
        const offer = { series: s.id, zwid: m.zwid, name: m.name, lead, sweep, at: new Date().toISOString() };
        await redis([['HSET', KEYS.standing, field, JSON.stringify(offer)]]); data.standing[field] = offer;
        await fillStanding(data, Date.now());
      }
      return getView(req);
    },

    'POST /api/cover/send': async (req) => {
      requireRole(req, ['admin', 'mod']);
      const msg = calloutText(await load(), Date.now());
      if (!msg) throw new HttpError(409, 'Every ride in the next two weeks is fully covered: nothing to call out.');
      const [claimed] = await redis([['HSETNX', KEYS.sent, `manual:${Math.floor(Date.now() / 300000)}`, new Date().toISOString()]]);
      if (!claimed) throw new HttpError(429, 'The call-out was sent a moment ago.');
      return { sent: await notify('public', msg, { kind: 'callout' }) || 'nowhere (no webhook or Discord channel is set)' };
    },

    // Admin: read a calendar (iCal) link and turn its repeating events into ride series. Preview first, then apply.
    'POST /api/cover/import-ical': async (req, body) => {
      requireRole(req, ['admin']);
      const found = await readIcal(body.url);
      if (!body.apply) return { preview: found };
      const data = await load(), cmds = [];
      for (const f of found) {
        const id = `${teamId(f.title)}-${DOW[f.dow].toLowerCase()}${f.time.replace(':', '')}`;
        if (data.series.some(s => s.id === id)) continue;
        cmds.push(['HSET', KEYS.series, id, JSON.stringify({ id, title: f.title.slice(0, 80), dow: f.dow, time: f.time, zone: f.zone, pace: '', cat: '', ownerName: '', ownerZwid: '', active: true, source: 'ical' })]);
      }
      if (cmds.length) await redis(cmds);
      return { added: cmds.length, ...(await getView(req)) };
    },
  };

  // ── iCal import ──
  const unfold = raw => String(raw).replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  function icalWhen(line) {
    const m = /^DTSTART([^:]*):(\d{8})T(\d{6})(Z?)/.exec(line);
    if (!m) return null;
    const tz = /TZID=([^;:]+)/.exec(m[1]), date = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}`, time = `${m[3].slice(0, 2)}:${m[3].slice(2, 4)}`;
    if (m[4]) { const ms = Date.parse(`${date}T${time}:00Z`); return { date: localDate(DEFAULT_ZONE, ms), time: `${pad(+partsIn(DEFAULT_ZONE, ms).hour)}:${pad(+partsIn(DEFAULT_ZONE, ms).minute)}`, zone: DEFAULT_ZONE }; }
    return { date, time, zone: tz && validZone(tz[1]) ? tz[1] : DEFAULT_ZONE };
  }
  function parseIcal(raw) {
    const events = [];
    let cur = null;
    for (const line of unfold(raw)) {
      if (line === 'BEGIN:VEVENT') cur = {};
      else if (line === 'END:VEVENT') { if (cur && cur.title && cur.when) events.push(cur); cur = null; }
      else if (cur) {
        if (/^SUMMARY[:;]/.test(line)) cur.title = line.replace(/^SUMMARY[^:]*:/, '').replace(/\\([,;nN\\])/g, (_, c) => (/[nN]/.test(c) ? ' ' : c)).trim();
        else if (/^DTSTART/.test(line)) cur.when = icalWhen(line);
      }
    }
    // Events that repeat on the same weekday and time are one series.
    const groups = new Map();
    for (const e of events) {
      const dow = dowOf(e.when.date), key = `${e.title}|${dow}|${e.when.time}|${e.when.zone}`;
      if (!groups.has(key)) groups.set(key, { title: e.title, dow, time: e.when.time, zone: e.when.zone, count: 0 });
      groups.get(key).count++;
    }
    return [...groups.values()].sort((a, b) => a.dow - b.dow || a.time.localeCompare(b.time)).slice(0, 40);
  }
  async function readIcal(url) {
    let u;
    try { u = new URL(String(url || '').replace(/^webcal:/i, 'https:')); } catch (e) { throw new HttpError(400, 'Paste the calendar link (it starts with https:// or webcal://).'); }
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || /^[\d.]+$/.test(u.hostname) || u.hostname.includes(':') || /(^|\.)(localhost|local|internal)$/i.test(u.hostname)) throw new HttpError(400, 'Use a public https calendar link.');
    let r, raw;
    try { r = await fetch(u.href, { signal: AbortSignal.timeout(8000), redirect: 'error' }); raw = (await r.text()).slice(0, 1000000); }
    catch (e) { throw new HttpError(502, 'That calendar could not be read. Check the link opens in a browser.'); }
    if (!r.ok) throw new HttpError(502, `That calendar answered ${r.status}.`);
    if (!/BEGIN:VCALENDAR/.test(raw)) throw new HttpError(422, 'That link is not an iCal calendar (no BEGIN:VCALENDAR). Look for a "subscribe" or "export .ics" link.');
    const found = parseIcal(raw);
    if (!found.length) throw new HttpError(422, 'No rides were found in that calendar.');
    return found;
  }

  // ── The scheduled tick: stand-by cover, then call-outs, chases, owner alerts and confirmations (each sent once) ──
  async function runSchedule(now = Date.now()) {
    const data = await load(), done = [];
    if (!data.series.length) return done;
    if (await fillStanding(data, now)) done.push('cover-fill');
    const claim = async key => (await redis([['HSETNX', KEYS.sent, key, new Date(now).toISOString()]]))[0];

    // Monday 08:00 (UK) or the first run after: one call-out for the next two weeks, gaps only.
    const mondayStart = localToMs(addDays(localDate(DEFAULT_ZONE, now), -((dowOf(localDate(DEFAULT_ZONE, now)) + 6) % 7)), '08:00', DEFAULT_ZONE);
    if (now >= mondayStart && (await claim(`digest:${isoWeek(now)}`))) {
      const msg = calloutText(data, now);
      if (msg) { await notify('public', msg, { kind: 'callout' }); done.push('cover-callout'); }
    }

    const chase = [], alerts = [], confirm = [];
    for (const s of data.series.filter(x => x.active !== false)) for (const o of occurrencesOf(s, now, 2)) {
      if (data.cancelled.has(o.id) || o.startMs <= now) continue;
      const hours = (o.startMs - now) / 3600000, gaps = gapsOf(data, o);
      if (hours <= 7 * 24 && gaps.length && await claim(`${o.id}:d7`)) chase.push(`• ${whenLabel(o, s.zone)}: ${discordEscape(s.title)} needs ${gapText(gaps)}`);
      if (hours <= 72 && needsPrimary(data, o).length && await claim(`${o.id}:d3`)) alerts.push(`• ${whenLabel(o, s.zone)}: ${discordEscape(s.title)} has no ${gapText(needsPrimary(data, o))}${s.ownerName ? ` (owner ${discordEscape(s.ownerName)})` : ''}`);
      if (hours <= 24 && await claim(`${o.id}:d1`)) confirm.push(fullLine(s, o, data));
    }
    if (chase.length) { await notify('public', `⏰ **Rides this week still needing cover**\n${chase.join('\n')}\nApproved leaders and sweepers: ${siteUrl} → 🚴 Social Rides → Ride cover.`, { kind: 'chase' }); done.push('cover-chase'); }
    if (alerts.length) { await notify('admin', `🚨 **Rides in the next 3 days with no leader or sweeper**\n${alerts.join('\n')}\nFind cover from the approved list or cancel the ride: ${siteUrl} → 🚴 Social Rides.`, { kind: 'owner-alert' }); done.push('cover-alert'); }
    if (confirm.length) { await notify('public', `✅ **Ride cover for the next 24 hours**\n${confirm.join('\n')}`, { kind: 'confirm' }); done.push('cover-confirm'); }
    return done;
  }

  // One row for the admin health panel.
  function healthRow(data, now = Date.now()) {
    if (!data.series.length) return ['info', 'No ride series yet. Add the weekly rides in the Social Rides tab so leaders and sweepers can offer.'];
    const sink = process.env.RIDE_COVER_WEBHOOK_URL ? 'Call-outs go to the webhook (WhatsApp), Discord if it fails.' : 'No RIDE_COVER_WEBHOOK_URL set: call-outs go to Discord only.';
    const bare = [];
    for (const s of data.series.filter(x => x.active !== false)) for (const o of occurrencesOf(s, now, 1)) {
      if (!data.cancelled.has(o.id) && o.startMs > now && o.startMs - now < 7 * DAY_MS && needsPrimary(data, o).length) bare.push(`${s.title} (${whenLabel(o, s.zone)})`);
    }
    const approved = Object.keys(data.approved).length;
    if (bare.length) return ['warn', `${bare.length} ride${bare.length === 1 ? '' : 's'} in the next 7 days without a leader or sweeper: ${bare.slice(0, 3).join('; ')}${bare.length > 3 ? '…' : ''}. ${sink}`];
    return ['ok', `${data.series.length} ride series, ${approved} approved leader${approved === 1 ? '' : 's'}/sweepers; every ride in the next 7 days has a leader and sweeper. ${sink}`];
  }

  return { routes, runSchedule, load, healthRow, view, parseIcal, KEYS, ROLES };
};
