'use strict';
// Case log: a short, factual record of what staff looked at and how it ended. Administrator only, on every route. It holds the rider's Zwift ID
// (the name is looked up from the roster only when staff open the log), the event, which indicators were noted, the outcome and a short note.
// It never holds file contents or power data, and nothing here is served to members. Entries are purged after a retention period (default 12 months).
module.exports = function createCaseLog({ redis, HttpError, requireRole, staffNameOf = () => '', fetchRoster = async () => ({ riders: [] }) }) {
  const LOG = 'cg:cases:log', SETTINGS = 'cg:cases:settings', DEFAULT_MONTHS = 12, MAX_NOTE = 300;
  const OUTCOMES = { no_action: 'No action', clarified: 'Rider clarified', escalated_zwift: 'Escalated to Zwift', resolved: 'Resolved' };
  const INDICATORS = {
    same_meter: 'Same meter likely paired to both devices', constant_offset: 'Constant percentage offset', creator_identity: "Second file creator identity doesn't match a separate device",
    weight_drop: 'Weight drop', wkg_spike: 'W/kg above their best', velo_jump: 'vELO jump',
  };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
  const admin = req => requireRole(req, ['admin']);

  async function months() { const [raw] = await redis([['HGET', SETTINGS, 'retentionMonths']]); const n = Number(raw); return Number.isInteger(n) && n >= 1 && n <= 120 ? n : DEFAULT_MONTHS; }
  const cutoff = (m, now) => { const d = new Date(now); d.setUTCMonth(d.getUTCMonth() - m); return d.toISOString(); };

  // Remove entries older than the retention period. Returns how many went.
  async function purge(now = Date.now()) {
    const [raw, m] = await Promise.all([redis([['HGETALL', LOG]]).then(r => r[0]), months()]);
    const old = cutoff(m, now), gone = pairs(raw).filter(([, v]) => { const e = parse(v); return !e || String(e.created_at || '') < old; }).map(([id]) => id);
    if (gone.length) await redis([['HDEL', LOG, ...gone]]);
    return gone.length;
  }

  const routes = {
    'GET /api/caselog': async req => {
      admin(req);
      const [raw, m, roster] = await Promise.all([redis([['HGETALL', LOG]]).then(r => r[0]), months(), fetchRoster().catch(() => ({ riders: [] }))]);
      const names = new Map(((roster && roster.riders) || []).map(r => [String(r.riderId), r.name]));
      const entries = pairs(raw).map(([, v]) => parse(v)).filter(Boolean).map(e => ({ ...e, rider_name: names.get(e.zwift_id) || '' })).sort((a, b) => b.created_at.localeCompare(a.created_at));
      return { entries, retentionMonths: m, outcomes: OUTCOMES, indicators: INDICATORS, maxNote: MAX_NOTE };
    },
    'POST /api/caselog/add': async (req, body) => {
      admin(req);
      const zwift_id = String(body.zwift_id || '').trim();
      if (!/^\d{1,10}$/.test(zwift_id)) throw new HttpError(400, 'Enter the rider\'s Zwift ID (numbers only).');
      const event_date = String(body.event_date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(event_date) || Number.isNaN(Date.parse(event_date + 'T00:00:00Z'))) throw new HttpError(400, 'Enter the event date as YYYY-MM-DD.');
      const event_name = clean(body.event_name, 120);
      if (!event_name) throw new HttpError(400, 'Enter the event name.');
      const outcome = String(body.outcome || '');
      if (!OUTCOMES[outcome]) throw new HttpError(400, 'Choose an outcome.');
      const codes = Array.isArray(body.indicators) ? [...new Set(body.indicators.map(String))] : [];
      if (codes.some(c => !INDICATORS[c])) throw new HttpError(400, 'One of the indicator codes is not recognised.');
      const note = clean(body.note, 1000);
      if (note.length > MAX_NOTE) throw new HttpError(400, `Keep the note to ${MAX_NOTE} characters: record evidence and outcome, not accusations.`);
      const entry = {
        id: `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, zwift_id, event_name, event_date, indicators: codes, outcome,
        escalated: body.escalated === true || outcome === 'escalated_zwift', note, created_by: staffNameOf(req) || 'staff', created_at: new Date().toISOString(),
      };
      await redis([['HSET', LOG, entry.id, JSON.stringify(entry)]]);
      return { entry };
    },
    'POST /api/caselog/delete': async (req, body) => {
      admin(req);
      const n = (await redis([['HDEL', LOG, String(body.id || '')]]))[0];
      if (!n) throw new HttpError(404, 'That entry is not there any more.');
      return { ok: true };
    },
    'POST /api/caselog/settings': async (req, body) => {
      admin(req);
      const m = Number(body.retentionMonths);
      if (!Number.isInteger(m) || m < 1 || m > 120) throw new HttpError(400, 'Retention must be a whole number of months from 1 to 120.');
      await redis([['HSET', SETTINGS, 'retentionMonths', String(m)]]);
      return { retentionMonths: m, purged: await purge() };
    },
    'POST /api/caselog/purge': async req => { admin(req); return { purged: await purge() }; },
  };
  return { routes, purge, runSchedule: async now => { await purge(now).catch(e => console.error('Case log purge:', e.message)); return []; }, OUTCOMES, INDICATORS };
};
