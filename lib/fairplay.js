'use strict';
// Fair play: a daily look at each active rider's own numbers for changes that a person should look at. It FLAGS, it never decides: a flag is a prompt
// for the staff to look, nothing is said to the rider, nothing is shown to members, and a person marks each one OK, confirmed or dismissed.
//
// What it can see: the club roster's registered weight, the 5 and 20 minute W/kg figures and the vELO rating, once a day. From that it flags
//   - weight_drop:  registered weight down by more than 2 kg inside 7 days (or an implausible weight);
//   - wkg_spike:    a 5 or 20 minute W/kg more than 5% above the rider's best over the previous 90 days;
//   - velo_jump:    a vELO rise of 150 or more inside 14 days.
// What it cannot see: heart rate and second-by-second power. The ZwiftRacing.app data the club receives has neither, so heart-rate decoupling and
// "sticky watts" (flat power, trainer drop-outs) cannot be checked from here; they need FIT files or a stream source, and nothing is guessed.
module.exports = function createFairPlay({ redis, HttpError, requireRole, staffNameOf = () => '', fetchRoster, activeMembers, discord = async () => {}, siteUrl = '' }) {
  const WEIGHTS = 'cg:fair:weights', SNAP = 'cg:fair:snap', FLAGS = 'cg:fair:flags', LAST = 'cg:fair:last', KEEP_DAYS = 100, DAY = 86400000;
  const STATUSES = ['open', 'ok', 'confirmed', 'dismissed'];
  const TYPES = { weight_drop: 'Weight drop', wkg_spike: 'W/kg above their best', velo_jump: 'vELO jump' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const day = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);
  const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  const r1 = x => Math.round(x * 10) / 10, r2 = x => Math.round(x * 100) / 100;
  const ago = (d, n) => day(Date.parse(d + 'T12:00:00Z') - n * DAY);

  // ── The detectors: pure, they take one rider's history ([{d, w, p5, p20, v}], oldest first) and say what stands out ──
  function detect(history) {
    const h = (history || []).filter(x => x && x.d).sort((a, b) => a.d.localeCompare(b.d));
    const out = [];
    if (!h.length) return out;
    const now = h[h.length - 1];

    // Weight: the heaviest registered weight in the last 7 days against today's.
    const win = h.filter(x => x.d >= ago(now.d, 7) && x.w);
    if (now.w && win.length >= 2) {
      const top = Math.max(...win.map(x => x.w)), drop = r1(top - now.w);
      if (drop > 2) out.push({ type: 'weight_drop', severity: drop > 5 ? 3 : drop > 3 ? 2 : 1, metric: `${top} kg → ${now.w} kg (−${drop} kg in 7 days)`, value: drop });
    }
    if (now.w && now.w < 40) out.push({ type: 'weight_drop', severity: 3, metric: `Registered weight ${now.w} kg is not plausible for an adult`, value: now.w });

    // 5 and 20 minute W/kg against the best of the earlier 90 days (at least four earlier readings, at least two weeks old).
    for (const [field, label] of [['p5', '5 min'], ['p20', '20 min']]) {
      if (!now[field]) continue;
      const base = h.filter(x => x[field] && x.d < ago(now.d, 14) && x.d >= ago(now.d, 104)).map(x => x[field]);
      if (base.length < 4) continue;
      const best = Math.max(...base), up = (now[field] - best) / best;
      if (up > 0.05) out.push({ type: 'wkg_spike', severity: up > 0.15 ? 3 : up > 0.1 ? 2 : 1, metric: `${label}: ${r2(now[field])} W/kg vs ${r2(best)} best over 90 days (+${r1(up * 100)}%)`, value: r1(up * 100), sub: field });
    }

    // vELO: a rise of 150 or more compared with the reading nearest 14 days ago.
    if (now.v) {
      const before = h.filter(x => x.v && x.d <= ago(now.d, 12) && x.d >= ago(now.d, 16)).pop();
      if (before && now.v - before.v >= 150) out.push({ type: 'velo_jump', severity: now.v - before.v >= 400 ? 3 : now.v - before.v >= 250 ? 2 : 1, metric: `vELO ${before.v} → ${now.v} (+${now.v - before.v} in 14 days)`, value: now.v - before.v });
    }
    return out;
  }

  // ── Daily run: one snapshot per rider, then the detectors ──
  async function run(now = Date.now(), force = false) {
    const today = day(now);
    const [last] = await redis([['GET', LAST]]);
    if (!force && last === today) return { ran: false, added: 0 };
    const [{ riders }, ids] = await Promise.all([fetchRoster(), activeMembers()]);
    const on = new Set(ids);
    const [rawSnap, rawFlags, rawWeights] = await redis([['HGETALL', SNAP], ['HGETALL', FLAGS], ['HGETALL', WEIGHTS]]);
    const weights = Object.fromEntries(pairs(rawWeights));   // written by the roster fetch; never served to members
    const snaps = Object.fromEntries(pairs(rawSnap).map(([z, v]) => [z, parse(v) || []]));
    const flags = Object.fromEntries(pairs(rawFlags).map(([id, v]) => [id, parse(v)]).filter(([, v]) => v));
    const cmds = [], fresh = [];
    for (const r of riders) {
      const z = String(r.riderId);
      if (!on.has(z)) continue;
      const entry = { d: today, w: r1(num(weights[z])), p5: r2(num(r.power && r.power.wkg300)), p20: r2(num(r.power && r.power.wkg1200)), v: Math.round(num(r.race && r.race.current && r.race.current.rating)) };
      if (!entry.w && !entry.p5 && !entry.p20 && !entry.v) continue;
      const hist = (snaps[z] || []).filter(x => x.d !== today && x.d >= day(now - KEEP_DAYS * DAY));
      hist.push(entry);
      cmds.push(['HSET', SNAP, z, JSON.stringify(hist)]);
      for (const f of detect(hist)) {
        const id = `${z}:${f.type}${f.sub ? ':' + f.sub : ''}`, old = flags[id];
        // A dismissed or cleared flag comes back only if it is clearly worse or a month has passed; an open one just refreshes.
        if (old && old.status !== 'open' && f.severity <= old.severity && Date.parse(old.reviewedAt || old.at) > now - 30 * DAY) continue;
        const next = old && old.status === 'open'
          ? { ...old, severity: Math.max(old.severity, f.severity), metric: f.metric, value: f.value, lastSeen: today }
          : { id, zwid: z, name: r.name || z, type: f.type, severity: f.severity, metric: f.metric, value: f.value, at: today, lastSeen: today, status: 'open', note: '' };
        cmds.push(['HSET', FLAGS, id, JSON.stringify(next)]);
        if (!old || old.status !== 'open') fresh.push(next);
      }
    }
    cmds.push(['SET', LAST, today]);
    if (cmds.length) await redis(cmds);
    if (fresh.length) {
      // Only a count goes to the admin channel: no names, no accusation.
      await discord('admin', { content: `🔎 **Fair play:** ${fresh.length} new item${fresh.length === 1 ? '' : 's'} for a person to look at${fresh.some(f => f.severity === 3) ? ' (some marked high)' : ''}. These are prompts, not findings: open ${siteUrl}/ → Fair play.` }).catch(() => {});
    }
    return { ran: true, added: fresh.length };
  }

  const routes = {
    'GET /api/fairplay': async req => {
      requireRole(req, ['admin', 'mod']);
      const [raw, last] = await redis([['HGETALL', FLAGS], ['GET', LAST]]);
      const flags = pairs(raw).map(([, v]) => parse(v)).filter(Boolean)
        .map(f => ({ ...f, typeLabel: TYPES[f.type] || f.type, profile: `https://www.zwiftracing.app/riders/${encodeURIComponent(f.zwid)}` }))
        .sort((a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || b.severity - a.severity || b.at.localeCompare(a.at));
      return { flags, open: flags.filter(f => f.status === 'open').length, lastRun: last || null, cannotSee: ['Heart rate', 'Second-by-second power (flat or "sticky" watts)'] };
    },
    'POST /api/fairplay/review': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const id = String(body.id || ''), status = String(body.status || '');
      if (!STATUSES.includes(status)) throw new HttpError(400, 'Choose open, ok, confirmed or dismissed.');
      const [raw] = await redis([['HGET', FLAGS, id]]);
      const f = parse(raw);
      if (!f) throw new HttpError(404, 'That item is not there any more.');
      const next = { ...f, status, note: String(body.note == null ? f.note : body.note).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500), reviewedBy: staffNameOf(req) || 'staff', reviewedAt: day() };
      await redis([['HSET', FLAGS, id, JSON.stringify(next)]]);
      return { flag: next };
    },
    'POST /api/fairplay/run': async req => { requireRole(req, ['admin']); return run(Date.now(), true); },
  };
  return { routes, detect, run, runSchedule: async now => { await run(now).catch(e => console.error('Fair play:', e.message)); return []; }, TYPES, SNAP, FLAGS };
};
