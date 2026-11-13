'use strict';
// Club results, automatically. ZwiftPower and ZwiftRacing.app's club results pages need a login, but ZwiftRacing.app's results API (the key in
// ZWIFTRACING_API_KEY) gives every finisher of one event. So the app keeps a queue of event IDs, fetches each one after the race, keeps only
// CRYO-GEN riders (the club roster) and stores the result. Events come from:
//   - staff: paste a Zwift, ZwiftPower or ZwiftRacing.app event link (or the bare ID) on the Results page,
//   - the app's own calendar: Ladder matches and DIRT stages that have a Zwift event link are queued by themselves.
// The API allows one results request a minute, so the scheduled job fetches one event per run, oldest first. An event without results yet is tried
// again on later runs for three days, then dropped. Optionally a short summary is posted to the club's Discord channel when a new result arrives.
module.exports = function createClubResults({ redis, HttpError, requireRole, roleFromRequest, memberFromRequest, fetchZrResults, clubRiders, discord = async () => false, discordEscape = s => String(s), siteUrl = '' }) {
  const K = { events: 'cg:results:events', queue: 'cg:results:queue', settings: 'cg:results:settings' };
  const DAY = 86400000, GIVE_UP_MS = 3 * DAY, KEEP = 60;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const settings = async () => ({ post: false, ...(parse((await redis([['GET', K.settings]]))[0]) || {}) });

  // An event ID from any of the usual links, or a bare number.
  function eventIdOf(input) {
    const s = String(input || '').trim();
    if (/^\d{4,12}$/.test(s)) return s;
    const m = /zwift\.com\/(?:[a-z]{2}\/)?events\/view\/(\d+)/i.exec(s) || /zwiftpower\.com\/events\.php\?[^#]*\bzid=(\d+)/i.exec(s) || /zwiftracing\.app\/events\/(\d+)/i.exec(s) || /[?&](?:eventId|zid|id)=(\d{4,12})\b/i.exec(s);
    return m ? m[1] : '';
  }

  async function queue(id, source, dueMs = Date.now()) {
    const [have] = await redis([['HGET', K.events, id]]);
    if (have) return false;
    const [added] = await redis([['HSETNX', K.queue, id, JSON.stringify({ source, due: dueMs, added: Date.now(), tries: 0 })]]);
    return !!Number(added);
  }

  // Ladder matches and DIRT stages with a Zwift event link go in the queue for after their start (results take a while to settle).
  async function discover(now = Date.now()) {
    const [ladder, drs] = await redis([['HGETALL', 'cg:ladder:matches'], ['HGETALL', 'cg:drs:stages']]);
    let n = 0;
    for (const [, v] of [...pairs(ladder), ...pairs(drs)]) {
      const x = parse(v); if (!x) continue;
      const id = eventIdOf(x.eventLink), start = Date.parse(x.at || (x.date ? `${x.date}T${x.time || '18:00'}:00Z` : ''));
      if (!id || !Number.isFinite(start) || start > now || now - start > GIVE_UP_MS) continue;
      if (await queue(id, x.teamName ? 'Ladder' : 'DIRT', start + 90 * 60000)) n++;
    }
    return n;
  }

  // Fetch one event and keep our riders.
  async function fetchOne(id) {
    const data = await fetchZrResults(id), ours = await clubRiders();
    const riders = data.results.filter(x => ours.has(String(x.riderId))).map(x => ({ zwid: String(x.riderId), name: ours.get(String(x.riderId)) || x.name || '', pos: x.position ?? null, catPos: x.positionInCategory ?? null, cat: x.category || '', time: x.time ?? null, gap: x.gap ?? null }))
      .sort((a, b) => (a.pos ?? 9999) - (b.pos ?? 9999));
    return { id: String(id), title: String(data.title || `Event ${id}`).slice(0, 160), time: Number(data.time) || null, type: data.type || '', subType: data.subType || '', distance: data.distance || null, field: data.results.length, riders, at: new Date().toISOString() };
  }

  async function store(ev) {
    await redis([['HSET', K.events, ev.id, JSON.stringify(ev)], ['HDEL', K.queue, ev.id]]);
    // Keep the newest KEEP events.
    const all = await list(1000); for (const old of all.slice(KEEP)) await redis([['HDEL', K.events, old.id]]);
    if (ev.riders.length && (await settings()).post) {
      const top = ev.riders.slice(0, 5).map(r => `${r.catPos ? `#${r.catPos} in ${r.cat || 'cat'}` : r.pos ? `#${r.pos}` : 'finished'} · ${discordEscape(r.name)}`).join('\n');
      await discord('public', { content: `🏁 **${discordEscape(ev.title)}**: ${ev.riders.length} CRYO-GEN rider${ev.riders.length === 1 ? '' : 's'}\n${top}${ev.riders.length > 5 ? `\n…and ${ev.riders.length - 5} more` : ''}\nAll results: ${siteUrl}` }).catch(() => {});
    }
  }

  async function list(limit = 30) {
    const [raw] = await redis([['HGETALL', K.events]]);
    return pairs(raw).map(([, v]) => parse(v)).filter(Boolean).sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, limit);
  }

  // One event per run (the API's one-a-minute limit), oldest due first; not-yet-ready events are retried for three days.
  async function runSchedule(now = Date.now()) {
    if (!process.env.ZWIFTRACING_API_KEY) return [];
    await discover(now).catch(() => 0);
    const [raw] = await redis([['HGETALL', K.queue]]);
    const due = pairs(raw).map(([id, v]) => ({ id, ...(parse(v) || {}) })).filter(q => (q.due || 0) <= now).sort((a, b) => (a.due || 0) - (b.due || 0));
    for (const q of due) {
      if (now - (q.due || now) > GIVE_UP_MS) { await redis([['HDEL', K.queue, q.id]]); continue; }
      try { const ev = await fetchOne(q.id); await store(ev); return [`Results: ${ev.title} (${ev.riders.length} of ours)`]; }
      catch (e) {
        if (e.status === 429) return [];   // the minute is used: try on the next run
        await redis([['HSET', K.queue, q.id, JSON.stringify({ ...q, id: undefined, tries: (q.tries || 0) + 1, due: now + 2 * 3600000, last: e.message })]]);
        return [];
      }
    }
    return [];
  }

  const signedIn = req => !!(roleFromRequest(req) || memberFromRequest(req));
  const routes = {
    // Members and staff: the latest club results.
    'GET /api/results': async req => {
      if (!signedIn(req)) throw new HttpError(401, 'Sign in to see club results.');
      const staff = ['admin', 'mod'].includes(roleFromRequest(req));
      const [raw] = staff ? await redis([['HGETALL', K.queue]]) : [[]];
      return { events: await list(30), queue: staff ? pairs(raw).map(([id, v]) => ({ id, ...(parse(v) || {}) })) : undefined, settings: staff ? await settings() : undefined, keySet: !!process.env.ZWIFTRACING_API_KEY };
    },
    // Staff: add an event by link or ID. It is fetched straight away when possible; otherwise it waits in the queue.
    'POST /api/results/add': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const id = eventIdOf(body.event); if (!id) throw new HttpError(400, 'Paste a Zwift, ZwiftPower or ZwiftRacing.app event link, or the event number.');
      try { const ev = await fetchOne(id); await store(ev); return { event: ev, fetched: true }; }
      catch (e) {
        if (e.status === 503 || e.status === 400) throw e;
        await redis([['HSET', K.queue, id, JSON.stringify({ source: 'staff', due: Date.now() + 5 * 60000, added: Date.now(), tries: 0, last: e.message })]]);
        return { fetched: false, queued: true, note: `${e.message} It is in the queue and will be fetched automatically.` };
      }
    },
    'POST /api/results/remove': async (req, body) => { requireRole(req, ['admin', 'mod']); const id = eventIdOf(body.event); await redis([['HDEL', K.events, id], ['HDEL', K.queue, id]]); return { removed: id }; },
    'POST /api/results/settings': async (req, body) => { requireRole(req, ['admin']); const s = { post: body.post === true }; await redis([['SET', K.settings, JSON.stringify(s)]]); return { settings: s }; },
  };
  return { routes, runSchedule, eventIdOf, discover, list };
};
