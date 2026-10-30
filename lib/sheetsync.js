'use strict';
// Keeps the club's Google Sheets and the app side by side while both are in use. Two directions, per race series (TTT and ZRL for now):
//  - pull: the sheet wins. The published teams on the sheet's TEAM LIST tab are read into the app (the series' own import does the work).
//  - push: the app writes its teams to a mirror tab it owns ("CRYO-GEN App TTT" / "CRYO-GEN App ZRL"), replaced each time. The club's own tabs are never written.
// Writing needs a Google service account that the sheet has been shared with as an Editor (lib/gsheets.js). Everything is off until an administrator turns it
// on, and a run never overlaps another. Vercel's cron runs once a day, so a run also happens, at most every ten minutes, when staff open a series' page.
const crypto = require('crypto');

module.exports = function createSheetSync({ redis, HttpError, requireRole, roleFromRequest, gsheets, series, now = () => Date.now() }) {
  const KEYS = { settings: 'cg:sync:settings', state: 'cg:sync:state' };
  const AUTO_EVERY_MS = 10 * 60000;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const ids = Object.keys(series);
  const stamp = () => new Date(now()).toISOString();

  async function load() {
    const [sRaw, tRaw] = await redis([['GET', KEYS.settings], ['GET', KEYS.state]]);
    const st = parse(sRaw) || {}, state = parse(tRaw) || {};
    const settings = Object.fromEntries(ids.map(id => [id, { pull: !!(series[id].pull && st[id] && st[id].pull), push: !!(st[id] && st[id].push), sheetId: String((st[id] && st[id].sheetId) || '') }]));
    return { settings, state };
  }
  const save = async ({ settings, state }) => { await redis([['SET', KEYS.settings, JSON.stringify(settings)], ['SET', KEYS.state, JSON.stringify(state)]]); };
  const sheetOf = (id, settings) => settings[id].sheetId || series[id].sheetId();

  // Writes the series' rows to its mirror tab, unless nothing changed since the last write.
  async function push(id, ctx, { force = false } = {}) {
    const s = series[id], sheetId = sheetOf(id, ctx.settings);
    const rows = await s.rows();
    const table = [[`CRYO-GEN app · ${s.label} · this tab is written by the app and replaced each time: change the club's own tabs instead`, '', '', `Updated ${stamp()}`], [], ...rows];
    const checksum = crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex');
    const last = (ctx.state[id] || {}).push || {};
    if (!force && last.ok && last.checksum === checksum && last.sheetId === sheetId) return { skipped: true, rows: rows.length };
    const out = await gsheets.writeTab(sheetId, s.mirrorTab, table);
    ctx.state[id] = { ...(ctx.state[id] || {}), push: { at: stamp(), ok: true, rows: rows.length, checksum, sheetId } };
    return { rows: rows.length, created: out.created };
  }
  async function pull(id, ctx) {
    const summary = await series[id].pull(sheetOf(id, ctx.settings));
    ctx.state[id] = { ...(ctx.state[id] || {}), pull: { at: stamp(), ok: true, summary } };
    return summary;
  }
  const fail = (id, ctx, dir, e) => { ctx.state[id] = { ...(ctx.state[id] || {}), [dir]: { at: stamp(), ok: false, error: String((e && e.message) || e).slice(0, 300) } }; };

  // One run: pull then push, each only if asked for. A failure in one direction is recorded and does not stop the other.
  async function run(id, directions, opts = {}) {
    if (!series[id]) throw new HttpError(404, 'Unknown series.');
    const [locked] = await redis([['SET', `cg:sync:lock:${id}`, '1', 'NX', 'EX', '60']]);
    if (!locked) throw new HttpError(409, 'A sync of that series is already running. Try again in a minute.');
    const ctx = await load(), out = {};
    try {
      for (const dir of directions) {
        try {
          if (dir === 'pull') out.pull = await pull(id, ctx);
          else out.push = await push(id, ctx, opts);
        } catch (e) { fail(id, ctx, dir, e); out[dir] = { error: ctx.state[id][dir].error }; }
      }
      await save(ctx);
    } finally { await redis([['DEL', `cg:sync:lock:${id}`]]); }
    return out;
  }

  async function view(req) {
    const { settings, state } = await load();
    return { google: gsheets.status(), canChange: roleFromRequest(req) === 'admin', series: Object.fromEntries(ids.map(id => [id, {
      canPull: !!series[id].pull, label: series[id].label, mirrorTab: series[id].mirrorTab, pullTab: series[id].pullTab, sheetId: sheetOf(id, settings), customSheet: !!settings[id].sheetId, settings: { pull: settings[id].pull, push: settings[id].push }, state: state[id] || {} }])) };
  }
  const check = id => { if (!series[id]) throw new HttpError(404, 'Unknown series.'); return id; };

  const routes = {
    'GET /api/sync': async req => { requireRole(req, ['admin', 'mod']); return view(req); },
    'POST /api/sync/settings': async (req, body) => {
      requireRole(req, ['admin']);
      const id = check(String(body.series || '')), ctx = await load();
      if (body.pull !== undefined) { if (body.pull === true && !series[id].pull) throw new HttpError(400, `${series[id].label} is published to the sheet only: the sheet cannot change the app yet.`); ctx.settings[id].pull = body.pull === true; }
      if (body.push !== undefined) ctx.settings[id].push = body.push === true;
      if (body.sheetId !== undefined) {
        const v = String(body.sheetId || '').trim(), m = /\/d\/([A-Za-z0-9_-]{20,})/.exec(v), sid = m ? m[1] : v;
        if (sid && !/^[A-Za-z0-9_-]{20,}$/.test(sid)) throw new HttpError(400, 'That is not a Google Sheet link or ID.');
        ctx.settings[id].sheetId = sid === series[id].sheetId() ? '' : sid;
      }
      // Turning publishing on is allowed before the Google key exists: it is remembered, and nothing is written until the key is added.
      await save(ctx);
      return view(req);
    },
    'POST /api/sync/run': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const id = check(String(body.series || ''));
      const dir = String(body.direction || 'both'), directions = (dir === 'pull' ? ['pull'] : dir === 'push' ? ['push'] : ['pull', 'push']).filter(d => d === 'push' || series[id].pull);
      if (!directions.length) throw new HttpError(400, `${series[id].label} is published to the sheet only.`);
      if (directions.includes('push') && !gsheets.status().configured) throw new HttpError(409, 'Add the Google service account first (GOOGLE_SERVICE_ACCOUNT_JSON): publishing to the sheet needs it.');
      const result = await run(id, directions, { force: body.force === true });
      return { result, ...(await view(req)) };
    },
    // Runs what is switched on for the series, if the last run was more than ten minutes ago: called when staff open the series' page.
    'POST /api/sync/auto': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const id = check(String(body.series || '')), { settings, state } = await load(), s = settings[id], st = state[id] || {};
      const lastAt = Math.max(Date.parse((st.pull || {}).at || 0) || 0, Date.parse((st.push || {}).at || 0) || 0);
      const directions = [s.pull && series[id].pull && 'pull', s.push && gsheets.status().configured && 'push'].filter(Boolean);
      if (!directions.length || now() - lastAt < AUTO_EVERY_MS) return { ran: [] };
      try { return { ran: directions, result: await run(id, directions) }; } catch (e) { return { ran: [], busy: true }; }
    },
  };

  // The daily cron: write what is switched on (a push is skipped when nothing changed).
  async function runSchedule() {
    const done = [];
    for (const id of ids) {
      const { settings } = await load(), s = settings[id];
      const directions = [s.pull && 'pull', s.push && gsheets.status().configured && 'push'].filter(Boolean);
      if (!directions.length) continue;
      try { await run(id, directions); done.push(`${id}:${directions.join('+')}`); } catch (e) { /* recorded in the state, or busy */ }
    }
    return done;
  }

  async function healthRow() {
    const { settings, state } = await load(), on = ids.filter(id => settings[id].pull || settings[id].push);
    if (!on.length) return ['info', 'Sheet sync is off. Turn it on in Admin when the Google service account is set up.'];
    const bad = on.map(id => ({ id, e: [(state[id] || {}).pull, (state[id] || {}).push].find(x => x && x.ok === false) })).filter(x => x.e);
    if (bad.length) return ['warn', bad.map(b => `${series[b.id].label}: ${b.e.error}`).join(' · ')];
    return ['ok', `On for ${on.map(id => series[id].label).join(' and ')}.`];
  }
  return { routes, run, runSchedule, healthRow, KEYS, load };
};
