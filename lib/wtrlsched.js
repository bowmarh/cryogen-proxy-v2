'use strict';
// WTRL's public race schedule (its results are behind a login, its schedule is not): for each league colour, the weekday and UTC time its races start. The ZRL setup checklist uses it
// to say when a team's race time in the app differs from WTRL's, so a wrong time is caught before race day. Read at most every six hours, kept in storage, and every failure is
// quiet: no schedule just means no check.
const KEY = 'cg:zrl:wtrltimes', DAY = 86400000, STALE_MS = 6 * 3600000, BASE = 'https://www.wtrl.racing/api/zrl/eventtimes/';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };

module.exports = function createWtrlSched({ redis, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  // "Mint League" → "mint"; { mint: "Tue 18:15 UTC", ... } from the events list.
  function slotsOf(payload) {
    const out = {};
    for (const e of (payload && payload.events) || []) {
      const colour = String(e.leagueName || '').replace(/\s*league\s*$/i, '').trim().toLowerCase(), t = Date.parse(e.eventStartUTC);
      if (!colour || Number.isNaN(t)) continue;
      const d = new Date(t); out[colour] = `${DOW[d.getUTCDay()]} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
    }
    return out;
  }
  async function season(id) {
    try {
      const r = await fetchImpl(BASE + id, { headers: { 'User-Agent': 'cryogen-proxy/2.0' }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) return null; const j = await r.json(); return j && j.success && j.payload && (j.payload.events || []).length ? j.payload : null;
    } catch (e) { return null; }
  }
  // The newest season whose first race is between two weeks ago and two months ahead.
  async function find(startId) {
    const t = now();
    for (let id = startId + 2; id >= Math.max(1, startId - 4); id--) {
      const p = await season(id); if (!p) continue;
      const times = p.events.map(e => Date.parse(e.eventStartUTC)).filter(Number.isFinite);
      if (times.length && Math.min(...times) >= t - 14 * DAY && Math.min(...times) <= t + 60 * DAY) return { id, payload: p };
    }
    return null;
  }
  async function cached() { const raw = (await redis([['GET', KEY]]))[0], c = parse(raw); return c && c.slots && Object.keys(c.slots).length ? c : null; }
  async function refreshIfStale(force = false) {
    const have = await cached().catch(() => null);
    if (!force && have && now() - have.at < STALE_MS) return have;
    const found = await find(have ? have.season : 21);
    if (!found) { if (have) await redis([['SET', KEY, JSON.stringify({ ...have, at: now() })]]); return have; }   // try again in six hours
    const c = { at: now(), season: found.id, round: found.payload.round || null, slots: slotsOf(found.payload) };
    await redis([['SET', KEY, JSON.stringify(c)]]); return c;
  }
  return { cached, refreshIfStale, slotsOf, find };
};
