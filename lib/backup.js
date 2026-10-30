'use strict';
// Backups of everything the dashboard keeps in Redis for the ZRL and the TTT (rounds, sign-ups, teams, line-ups, results and
// the archives). A copy is taken once a day by the scheduled tick and kept in Redis (compressed), so a bad edit or a deleted
// round can be rolled back; admins can also download a copy as a file. Lives outside api/ on purpose.
const zlib = require('zlib');

module.exports = function createBackup({ redis, HttpError, requireRole, zrlKeys, tttKeys, ladderKeys = {}, coverKeys = {}, drsKeys = {}, assocKeys = {}, commsKeys = {}, calendarKeys = {}, profileKeys = {}, extraHashes = [], syncKeys = {} }) {
  const STORE = 'cg:backup';   // hash: "<kind>:<ISO time>" -> base64 gzip of the snapshot JSON
  const KEEP = { auto: 14, manual: 10, 'pre-restore': 5 };
  const STRINGS = [zrlKeys.round, tttKeys.week, ladderKeys.meta, drsKeys.season, commsKeys.settings, syncKeys.settings].filter(Boolean);
  const HASHES = [zrlKeys.signups, zrlKeys.assign, zrlKeys.weekly, zrlKeys.results, zrlKeys.archive, zrlKeys.sent,
    tttKeys.signups, tttKeys.assign, tttKeys.archive, tttKeys.sent, tttKeys.last,
    ladderKeys.roster, ladderKeys.matches, ladderKeys.archive, ladderKeys.standings, ladderKeys.avail, ladderKeys.sent, ladderKeys.teams, ladderKeys.teamMeta,
    assocKeys.first, assocKeys.marks, assocKeys.full, assocKeys.requests, assocKeys.checks, assocKeys.sent,
    commsKeys.links, commsKeys.sent, calendarKeys.tokens, calendarKeys.owners, profileKeys.details, profileKeys.tz,
    ...extraHashes, drsKeys.squad, drsKeys.stages, drsKeys.ratings, drsKeys.avail, drsKeys.sent, drsKeys.archive, drsKeys.teams, drsKeys.seasons,
    coverKeys.series, coverKeys.slots, coverKeys.approved, coverKeys.standing, coverKeys.cancelled, coverKeys.optout].filter(Boolean);
  const KEYS = [...STRINGS, ...HASHES];

  const pairs = flat => { const out = []; for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };
  const pack = obj => zlib.gzipSync(Buffer.from(JSON.stringify(obj))).toString('base64');
  const unpack = blob => JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString());

  async function snapshot(now = Date.now()) {
    const results = await redis(KEYS.map(k => (STRINGS.includes(k) ? ['GET', k] : ['HGETALL', k])));
    const data = {};
    KEYS.forEach((k, i) => { data[k] = STRINGS.includes(k) ? { t: 's', v: results[i] } : { t: 'h', v: Object.fromEntries(pairs(results[i])) }; });
    return { app: 'cryogen-proxy', at: new Date(now).toISOString(), data };
  }

  const fieldsOf = async () => (await redis([['HKEYS', STORE]]))[0] || [];

  async function save(kind, now = Date.now()) {
    const snap = await snapshot(now);
    const field = `${kind}:${snap.at}`;
    await redis([['HSET', STORE, field, pack(snap)]]);
    const same = (await fieldsOf()).filter(f => f.startsWith(`${kind}:`)).sort();
    const drop = same.slice(0, Math.max(0, same.length - KEEP[kind]));
    if (drop.length) await redis(drop.map(f => ['HDEL', STORE, f]));
    return field;
  }

  // One automatic copy per (UTC) day.
  async function runBackup(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    if ((await fieldsOf()).some(f => f.startsWith(`auto:${day}`))) return false;
    await save('auto', now);
    return true;
  }

  async function list() {
    const [raw] = await redis([['HGETALL', STORE]]);
    return pairs(raw).map(([id, blob]) => ({ id, kind: id.split(':')[0], at: id.slice(id.indexOf(':') + 1), kb: Math.max(1, Math.round(blob.length / 1024)) }))
      .sort((a, b) => b.at.localeCompare(a.at));
  }

  async function load(id) {
    const [blob] = await redis([['HGET', STORE, String(id || '')]]);
    if (!blob) throw new HttpError(404, 'There is no backup with that id.');
    return unpack(blob);
  }

  async function restore(id) {
    const snap = await load(id);
    const known = Object.keys(snap.data || {}).filter(k => KEYS.includes(k));
    if (!known.length) throw new HttpError(400, 'That backup holds nothing this dashboard restores.');
    const before = await save('pre-restore');   // a way back from the restore itself
    const commands = [];
    for (const k of KEYS) {
      commands.push(['DEL', k]);
      const e = snap.data[k];
      if (!e) continue;
      if (e.t === 's') { if (e.v !== null && e.v !== undefined) commands.push(['SET', k, e.v]); }
      else for (const [f, v] of Object.entries(e.v || {})) commands.push(['HSET', k, f, v]);
    }
    await redis(commands);
    return { restored: id, safety: before };
  }

  // A weekly restore test: the newest daily copy is unpacked and every command a restore would run is built (nothing is written), and its size
  // is compared with the live data, so a copy that is empty, damaged or missing a series is found long before it is needed.
  const VERIFY = 'cg:backup:verify';
  async function verify(now = Date.now(), force = false) {
    const [raw] = await redis([['GET', VERIFY]]);
    let last = null; try { last = raw ? JSON.parse(raw) : null; } catch (e) { /* run again */ }
    if (!force && last && now - Date.parse(last.at) < 7 * 86400000) return last;
    const autos = (await fieldsOf()).filter(f => f.startsWith('auto:')).sort();
    const res = { at: new Date(now).toISOString(), id: autos[autos.length - 1] || '', ok: false, problems: [] };
    if (!res.id) res.problems.push('There is no daily copy to test yet.');
    else {
      try {
        const snap = await load(res.id), live = await snapshot(now), count = s => Object.values(s.data || {}).reduce((n, e) => n + (e.t === 'h' ? Object.keys(e.v || {}).length : e.v ? 1 : 0), 0);
        const commands = [];
        for (const k of KEYS) { const e = (snap.data || {})[k]; if (!e) continue; if (e.t === 's') { if (e.v !== null && e.v !== undefined) commands.push(['SET', k, e.v]); } else for (const [f, v] of Object.entries(e.v || {})) { if (typeof v !== 'string') res.problems.push(`${k} holds a value that is not text.`); commands.push(['HSET', k, f, v]); } }
        res.backupItems = count(snap); res.liveItems = count(live); res.commands = commands.length;
        if (!Object.keys(snap.data || {}).some(k => KEYS.includes(k))) res.problems.push('The copy holds nothing this dashboard restores.');
        if (res.liveItems >= 20 && res.backupItems < res.liveItems * 0.5) res.problems.push(`The copy holds ${res.backupItems} items against ${res.liveItems} live: far fewer.`);
        res.missingKinds = KEYS.filter(k => !(snap.data || {})[k]).length;
      } catch (e) { res.problems.push(`The copy could not be read: ${e.message}`); }
      res.ok = !res.problems.length;
    }
    await redis([['SET', VERIFY, JSON.stringify(res)]]);
    return res;
  }
  const lastVerify = async () => { try { return JSON.parse((await redis([['GET', VERIFY]]))[0] || 'null'); } catch (e) { return null; } };

  // The health panel row: when the last automatic copy was taken.
  async function healthRow(now = Date.now()) {
    const autos = (await fieldsOf()).filter(f => f.startsWith('auto:')).sort();
    if (!autos.length) return ['warn', 'No backup yet. The first one is taken by the next scheduled run.'];
    const age = now - Date.parse(autos[autos.length - 1].slice(5));
    const hours = Math.round(age / 3600000), v = await lastVerify();
    const test = !v ? ' The weekly restore test has not run yet.' : v.ok ? ` Restore test passed ${Math.max(0, Math.round((now - Date.parse(v.at)) / 86400000))} day(s) ago.` : ` ⚠️ The restore test FAILED: ${v.problems.join(' ')}`;
    return [age > 36 * 3600000 || (v && !v.ok) ? 'warn' : 'ok', `${autos.length} daily cop${autos.length === 1 ? 'y' : 'ies'} kept; the last was ${hours < 1 ? 'under an hour' : hours < 48 ? `${hours} h` : `${Math.round(hours / 24)} days`} ago.${age > 36 * 3600000 ? ' The scheduled run may have stopped.' : ''}${test}`];
  }

  const routes = {
    'GET /api/admin/backups': async req => { requireRole(req, ['admin']); return { backups: await list() }; },
    'POST /api/admin/backup-verify': async req => { requireRole(req, ['admin']); return verify(Date.now(), true); },
    'POST /api/admin/backup-now': async req => { requireRole(req, ['admin']); return { id: await save('manual') }; },
    // A copy as it is right now, or a stored one with ?id=, to save as a file.
    'GET /api/admin/backup-download': async (req, _body, query = {}) => { requireRole(req, ['admin']); return query.id ? load(query.id) : snapshot(); },
    'POST /api/admin/restore': async (req, body) => {
      requireRole(req, ['admin']);
      if (String(body.confirm || '') !== 'RESTORE') throw new HttpError(400, 'Type RESTORE to confirm. This replaces the current ZRL and TTT data with the backup.');
      return restore(body.id);
    },
  };

  return { routes, runBackup, verify, save, snapshot, list, restore, healthRow, KEYS };
};
