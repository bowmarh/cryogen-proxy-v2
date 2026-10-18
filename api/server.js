const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public'); // local dev only; Vercel serves public/ itself

// ── Google Sheets ──────────────────────────────────────────
// Sheets are read through the gviz endpoint, so the sheet must be shared as
// "Anyone with the link can view". Override the ID with the SHEET_ID env var.
const SHEET_ID = process.env.SHEET_ID || '1HvE7eyOYaWYdJL8zj1GoZIxVa5Qhlx1UTdSHcC0VIbw';
const SHEET_TABS = {
  rides: process.env.SHEET_TAB_RIDES || 'Social Rides',
  'ttt-sheet': process.env.SHEET_TAB_TTT || 'TEAM LIST',
};

// ── Shared data ────────────────────────────────────────────
const SERIES_MAX = { ttt: 40, ladder: 30, zrl: 24, dirt: 20, herd: 30 };
const CATS = ['A+', 'A', 'B', 'C', 'D'];
const KEYS = {
  signups: 'cg:signups', // field "<series>|<lowercase name>"
  locks: 'cg:locks',     // field "<series>" -> "1"
  rides: 'cg:rides',     // field "<ride id>" -> ride JSON
  rsvps: 'cg:rsvps',     // field "<ride id>|<lowercase name>"
};

const ROLE_PASSWORD_ENV = { admin: 'ADMIN_PASSWORD', mod: 'MOD_PASSWORD' };
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

class HttpError extends Error {
  constructor(status, message){ super(message); this.status = status; }
}

function sendJSON(res, statusCode, obj){
  const s = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(s),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(s);
}

function readJSONBody(req){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 20000){ reject(new HttpError(413, 'request too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Auth ───────────────────────────────────────────────────
function passwordMatches(given, expected){
  // Compare hashes so the comparison is constant-time regardless of input length.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

function tokenSecret(){
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Derived from the passwords, so changing a password also signs everyone out.
  return crypto.createHash('sha256')
    .update(`cg-session|${process.env.ADMIN_PASSWORD || ''}|${process.env.MOD_PASSWORD || ''}`)
    .digest('hex');
}

function signToken(role){
  const payload = Buffer.from(JSON.stringify({ role, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function roleFromRequest(req){
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const { role, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return exp > Date.now() && ROLE_PASSWORD_ENV[role] ? role : null;
  } catch (e) { return null; }
}

function requireRole(req, roles){
  const role = roleFromRequest(req);
  if (!role) throw new HttpError(401, 'Please log in again.');
  if (!roles.includes(role)) throw new HttpError(403, 'Not allowed for your role.');
  return role;
}

async function handleLogin(req, res){
  const payload = await readJSONBody(req);
  const envName = ROLE_PASSWORD_ENV[payload.role];
  if (!envName) throw new HttpError(400, 'unknown role');
  const expected = process.env[envName];
  if (!expected) return sendJSON(res, 503, { error: 'login not configured', missing: envName });
  if (typeof payload.password === 'string' && passwordMatches(payload.password, expected)){
    return sendJSON(res, 200, { role: payload.role, token: signToken(payload.role) });
  }
  sendJSON(res, 401, { error: 'incorrect password' });
}

// ── Redis (Upstash REST API, as added through the Vercel Marketplace) ──
function redisConfig(){
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return base && token ? { base: base.replace(/\/$/, ''), token } : null;
}

async function redis(commands){
  const cfg = redisConfig();
  if (!cfg) throw new HttpError(503, 'Shared storage is not set up yet.');
  const r = await fetch(`${cfg.base}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new HttpError(502, `storage error (${r.status})`);
  const out = await r.json();
  const failed = out.find(x => x.error);
  if (failed) throw new HttpError(502, `storage error: ${failed.error}`);
  return out.map(x => x.result);
}

// HGETALL comes back as a flat [field, value, field, value, ...] array.
function pairs(flat){
  const out = [];
  for (let i = 0; i < (flat || []).length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

async function loadState(){
  const [signups, locks, rides, rsvps] = await redis([
    ['HGETALL', KEYS.signups], ['HGETALL', KEYS.locks], ['HGETALL', KEYS.rides], ['HGETALL', KEYS.rsvps],
  ]);
  const state = { signups: {}, locks: {}, rides: [], rsvps: {} };
  for (const s of Object.keys(SERIES_MAX)) state.signups[s] = [];
  for (const [field, value] of pairs(signups)){
    const series = field.split('|')[0];
    if (state.signups[series]) state.signups[series].push(JSON.parse(value));
  }
  for (const [series, value] of pairs(locks)) state.locks[series] = value === '1';
  for (const [, value] of pairs(rides)) state.rides.push(JSON.parse(value));
  for (const [field, value] of pairs(rsvps)){
    const rideId = field.slice(0, field.indexOf('|'));
    (state.rsvps[rideId] = state.rsvps[rideId] || []).push(JSON.parse(value));
  }
  for (const list of Object.values(state.signups)) list.sort((a, b) => a.ts.localeCompare(b.ts));
  for (const list of Object.values(state.rsvps)) list.sort((a, b) => a.ts.localeCompare(b.ts));
  return state;
}

// ── Input validation ───────────────────────────────────────
function text(value, field, max, required = true){
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s && required) throw new HttpError(400, `Please enter a ${field}.`);
  if (s.length > max) throw new HttpError(400, `The ${field} is too long (max ${max} characters).`);
  return s;
}

function series(value){
  if (!Object.prototype.hasOwnProperty.call(SERIES_MAX, value)) throw new HttpError(400, 'unknown series');
  return value;
}

function rideId(value){
  const s = String(value == null ? '' : value);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(s)) throw new HttpError(400, 'invalid ride id');
  return s;
}

function linkOrEmpty(value){
  const s = text(value, 'link', 500, false);
  if (s && !/^https?:\/\//i.test(s)) throw new HttpError(400, 'The link must start with http:// or https://');
  return s;
}

// ── Shared-data routes ─────────────────────────────────────
// Every write returns the full, fresh state so the page can re-render from it.
const DATA_ROUTES = {
  'GET /api/state': async () => loadState(),

  'POST /api/signups': async (req, body) => {
    const s = series(body.series);
    const name = text(body.name, 'name', 60);
    const cat = CATS.includes(body.cat) ? body.cat : 'B';
    const zwid = /^\d{1,12}$/.test(String(body.zwid || '')) ? String(body.zwid) : '';
    const [locked, all] = await redis([['HGET', KEYS.locks, s], ['HKEYS', KEYS.signups]]);
    if (locked === '1') throw new HttpError(409, 'Sign-ups are locked.');
    if (all.filter(f => f.startsWith(`${s}|`)).length >= SERIES_MAX[s]) throw new HttpError(409, 'Event is full.');
    const entry = { name, cat, zwid, ts: new Date().toISOString() };
    const [added] = await redis([['HSETNX', KEYS.signups, `${s}|${name.toLowerCase()}`, JSON.stringify(entry)]]);
    if (!added) throw new HttpError(409, 'Already signed up!');
  },

  'POST /api/signups/remove': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    await redis([['HDEL', KEYS.signups, `${series(body.series)}|${text(body.name, 'name', 60).toLowerCase()}`]]);
  },

  'POST /api/signups/clear': async (req) => {
    requireRole(req, ['admin']);
    await redis([['DEL', KEYS.signups]]);
  },

  'POST /api/locks': async (req, body) => {
    requireRole(req, ['admin']);
    const s = series(body.series);
    await redis([body.locked ? ['HSET', KEYS.locks, s, '1'] : ['HDEL', KEYS.locks, s]]);
  },

  'POST /api/rides': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const date = text(body.date, 'date', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'The date must be YYYY-MM-DD.');
    const ride = {
      id: String(Date.now()),
      title: text(body.title, 'title', 100),
      date,
      time: text(body.time, 'time', 20, false),
      route: text(body.route, 'route', 100, false),
      dist: text(body.dist, 'distance', 30, false),
      pace: text(body.pace, 'pace', 30, false),
      desc: text(body.desc, 'description', 500, false),
      link: linkOrEmpty(body.link),
      max: Math.min(Math.max(parseInt(body.max, 10) || 25, 1), 500),
      cat: text(body.cat, 'category', 20, false) || 'All',
    };
    await redis([['HSET', KEYS.rides, ride.id, JSON.stringify(ride)]]);
  },

  'POST /api/rides/remove': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const id = rideId(body.id);
    const [fields] = await redis([['HKEYS', KEYS.rsvps]]);
    const rsvpFields = fields.filter(f => f.startsWith(`${id}|`));
    await redis([['HDEL', KEYS.rides, id], ...(rsvpFields.length ? [['HDEL', KEYS.rsvps, ...rsvpFields]] : [])]);
  },

  'POST /api/rsvps': async (req, body) => {
    const id = rideId(body.rideId);
    const name = text(body.name, 'name', 60);
    const entry = { name, ts: new Date().toISOString() };
    const [added] = await redis([['HSETNX', KEYS.rsvps, `${id}|${name.toLowerCase()}`, JSON.stringify(entry)]]);
    if (!added) throw new HttpError(409, "Already RSVP'd!");
  },

  'POST /api/rsvps/cancel': async (req, body) => {
    await redis([['HDEL', KEYS.rsvps, `${rideId(body.rideId)}|${text(body.name, 'name', 60).toLowerCase()}`]]);
  },
};

// ── TTT week ───────────────────────────────────────────────
// One "current week" plus an archive of past weeks. Riders sign up, staff assign
// them to teams, then publish the line-ups for everyone to see.
const TTT_KEYS = {
  week: 'cg:ttt:week',         // JSON {id, title, date, open, published, teams:[{id,name,level,zone,max}]}
  signups: 'cg:ttt:signups',   // field "<lowercase name>" -> signup JSON
  assign: 'cg:ttt:assign',     // field "<lowercase name>" -> JSON array of team ids
  archive: 'cg:ttt:archive',   // field "<week id>" -> snapshot JSON
};
const TTT_STYLES = ['race', 'casual'];
// Starting teams, taken from the club's TEAM LIST sheet. Staff can edit them in the dashboard.
const DEFAULT_TTT_TEAMS = [
  ['Hawks', 'Latte', 'Zone 22'], ['Magpies', 'Latte+', 'Zone 22'], ['Kites', 'Mocha', 'Zone 22'],
  ['Buzzards', 'Frappe', 'Zone 15'], ['Kestrels', 'Frappe', 'Zone 9'], ['Kawaus', 'Latte+', 'Zone 9'],
  ['Snow Geese', 'Latte+', 'Zone 8'], ['Owls', 'Mocha', 'Zone 8'], ['Crows', 'Latte', 'Zone 30'],
].map(([name, level, zone]) => ({ id: teamId(name), name, level, zone, max: 8 }));

function teamId(name){
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'team';
}

function parseTeams(list){
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Add at least one team.');
  if (list.length > 40) throw new HttpError(400, 'Too many teams (max 40).');
  const seen = new Set();
  return list.map(t => {
    const name = text(t && t.name, 'team name', 40);
    const id = teamId(name);
    if (seen.has(id)) throw new HttpError(400, `Two teams are called "${name}".`);
    seen.add(id);
    return {
      id, name,
      level: text(t.level, 'team level', 30, false),
      zone: text(t.zone, 'team zone', 30, false),
      max: Math.min(Math.max(parseInt(t.max, 10) || 8, 1), 20),
    };
  });
}

async function loadTtt(){
  const [week, signups, assign, archiveIds] = await redis([
    ['GET', TTT_KEYS.week], ['HGETALL', TTT_KEYS.signups], ['HGETALL', TTT_KEYS.assign], ['HKEYS', TTT_KEYS.archive],
  ]);
  return {
    week: week ? JSON.parse(week) : null,
    signups: pairs(signups).map(([, v]) => JSON.parse(v)).sort((a, b) => a.ts.localeCompare(b.ts)),
    assign: Object.fromEntries(pairs(assign).map(([k, v]) => [k, JSON.parse(v)])),
    archive: archiveIds.sort().reverse(),
  };
}

// What a given role may see: comments are staff-only, and line-ups stay hidden until published.
function tttView(data, role){
  const staff = role === 'admin' || role === 'mod';
  const showLineups = staff || (data.week && data.week.published);
  return {
    week: data.week,
    signups: data.signups.map(s => (staff ? s : { ...s, comments: undefined })),
    assign: showLineups ? data.assign : {},
    archive: data.archive,
    role: role || null,
  };
}

async function requireWeek(){
  const data = await loadTtt();
  if (!data.week) throw new HttpError(409, 'No TTT week has been started yet.');
  return data;
}

async function weekWith(changes){
  const data = await requireWeek();
  const week = { ...data.week, ...changes };
  await redis([['SET', TTT_KEYS.week, JSON.stringify(week)]]);
}

const TTT_ROUTES = {
  'GET /api/ttt': async () => {},

  'GET /api/ttt/archive': async (req) => {
    const id = String(url.parse(req.url, true).query.id || '');
    const [snap] = await redis([['HGET', TTT_KEYS.archive, id]]);
    if (!snap) throw new HttpError(404, 'That week is not in the archive.');
    const data = JSON.parse(snap);
    return tttView({ ...data, archive: [] }, roleFromRequest(req));
  },

  'POST /api/ttt/signup': async (req, body) => {
    const { week } = await requireWeek();
    if (!week.open) throw new HttpError(409, 'TTT sign-ups are closed for this week.');
    const name = text(body.name, 'name', 60);
    const teamIds = new Set(week.teams.map(t => t.id));
    const preferred = (Array.isArray(body.preferred) ? body.preferred : []).filter(id => teamIds.has(id)).slice(0, 5);
    const entry = {
      name,
      zwid: /^\d{1,12}$/.test(String(body.zwid || '')) ? String(body.zwid) : '',
      cat: CATS.includes(body.cat) ? body.cat : '',
      available: body.available !== false,
      style: TTT_STYLES.includes(body.style) ? body.style : 'casual',
      doubleUp: body.doubleUp === true,
      preferred,
      comments: text(body.comments, 'comment', 300, false),
      ts: new Date().toISOString(),
    };
    // Signing up again with the same name updates the entry.
    await redis([['HSET', TTT_KEYS.signups, name.toLowerCase(), JSON.stringify(entry)]]);
  },

  'POST /api/ttt/withdraw': async (req, body) => {
    const key = text(body.name, 'name', 60).toLowerCase();
    await redis([['HDEL', TTT_KEYS.signups, key], ['HDEL', TTT_KEYS.assign, key]]);
  },

  'POST /api/ttt/assign': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const { week, signups } = await requireWeek();
    const key = text(body.name, 'name', 60).toLowerCase();
    if (!signups.some(s => s.name.toLowerCase() === key)) throw new HttpError(404, 'That rider has not signed up.');
    const ids = [...new Set(Array.isArray(body.teams) ? body.teams : [])].filter(Boolean);
    const valid = new Set(week.teams.map(t => t.id));
    if (ids.some(id => !valid.has(id))) throw new HttpError(400, 'Unknown team.');
    if (ids.length > 2) throw new HttpError(400, 'A rider can be in at most 2 teams.');
    await redis([ids.length ? ['HSET', TTT_KEYS.assign, key, JSON.stringify(ids)] : ['HDEL', TTT_KEYS.assign, key]]);
  },

  'POST /api/ttt/auto-assign': async (req) => {
    requireRole(req, ['admin', 'mod']);
    const { week, signups, assign } = await requireWeek();
    const count = Object.fromEntries(week.teams.map(t => [t.id, 0]));
    for (const ids of Object.values(assign)) for (const id of ids) if (id in count) count[id]++;
    const max = Object.fromEntries(week.teams.map(t => [t.id, t.max]));
    const commands = [];
    // Earliest sign-ups get their preference first. Only riders not yet placed are touched.
    for (const s of [...signups].sort((a, b) => a.ts.localeCompare(b.ts))){
      const key = s.name.toLowerCase();
      if (!s.available || assign[key]) continue;
      const want = s.doubleUp ? 2 : 1;
      const picked = s.preferred.filter(id => id in count && count[id] < max[id]).slice(0, want);
      if (!picked.length) continue;
      picked.forEach(id => count[id]++);
      commands.push(['HSET', TTT_KEYS.assign, key, JSON.stringify(picked)]);
    }
    if (commands.length) await redis(commands);
  },

  'POST /api/ttt/status': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const changes = {};
    if (typeof body.open === 'boolean') changes.open = body.open;
    if (typeof body.published === 'boolean') changes.published = body.published;
    await weekWith(changes);
  },

  'POST /api/ttt/teams': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const teams = parseTeams(body.teams);
    const { assign } = await requireWeek();
    await weekWith({ teams });
    // Drop assignments to teams that no longer exist.
    const valid = new Set(teams.map(t => t.id));
    const commands = [];
    for (const [key, ids] of Object.entries(assign)){
      const kept = ids.filter(id => valid.has(id));
      if (kept.length !== ids.length) commands.push(kept.length ? ['HSET', TTT_KEYS.assign, key, JSON.stringify(kept)] : ['HDEL', TTT_KEYS.assign, key]);
    }
    if (commands.length) await redis(commands);
  },

  'POST /api/ttt/new-week': async (req, body) => {
    requireRole(req, ['admin', 'mod']);
    const date = text(body.date, 'date', 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'The date must be YYYY-MM-DD.');
    const title = text(body.title, 'title', 80, false) || `TTT ${date}`;
    const current = await loadTtt();
    if (current.week && current.week.id === date) throw new HttpError(409, 'A week with that date is already running.');
    const commands = [];
    if (current.week){
      // Archive the finished week (with its line-ups) before starting the new one.
      const snapshot = { week: { ...current.week, published: true, open: false }, signups: current.signups, assign: current.assign };
      commands.push(['HSET', TTT_KEYS.archive, current.week.id, JSON.stringify(snapshot)]);
    }
    const teams = current.week ? current.week.teams : DEFAULT_TTT_TEAMS;
    const week = { id: date, title, date, open: true, published: false, teams };
    commands.push(['SET', TTT_KEYS.week, JSON.stringify(week)], ['DEL', TTT_KEYS.signups], ['DEL', TTT_KEYS.assign]);
    await redis(commands);
  },
};

async function handleTtt(tttRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await tttRoute(req, body);
  sendJSON(res, 200, result || tttView(await loadTtt(), roleFromRequest(req)));
}

async function handleData(dataRoute, req, res){
  const body = req.method === 'POST' ? await readJSONBody(req) : {};
  const result = await dataRoute(req, body);
  sendJSON(res, 200, result || await loadState());
}

// ── Sheet proxy ────────────────────────────────────────────
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

function gvizCell(cell){
  if (!cell || cell.v == null) return '';
  // Dates arrive as "Date(2026,9,16)" with a zero-based month; return YYYY-MM-DD.
  const d = typeof cell.v === 'string' && /^Date\((\d+),(\d+),(\d+)\)$/.exec(cell.v);
  if (d) return `${d[1]}-${String(+d[2] + 1).padStart(2, '0')}-${String(d[3]).padStart(2, '0')}`;
  return cell.f != null ? String(cell.f) : String(cell.v);
}

function parseGviz(textBody){
  const start = textBody.indexOf('{');
  const end = textBody.lastIndexOf('}');
  if (start < 0 || end < start) throw new HttpError(502, 'Unexpected response from Google Sheets.');
  const data = JSON.parse(textBody.slice(start, end + 1));
  if (data.status === 'error'){
    const msg = (data.errors || []).map(e => e.detailed_message || e.message).join('; ');
    throw new HttpError(502, `Google Sheets: ${msg || 'error'}`);
  }
  const cols = data.table.cols;
  let rows = data.table.rows.map(r => cols.map((c, i) => gvizCell((r.c || [])[i])));
  let headers = cols.map(c => (c.label || '').trim().replace(/^#(REF!|N\/A|VALUE!|NAME\?|ERROR!)$/, ''));
  // If Google didn't detect a usable header row (e.g. a laid-out sheet with titles a few rows
  // down and other blocks further right), take the leftmost block of filled columns, use its
  // first row with at least 3 filled cells as the headers, and keep only those columns.
  if (headers.filter(Boolean).length < 2 && rows.length){
    const used = cols.map((c, i) => rows.some(r => r[i] !== ''));
    const start = used.indexOf(true);
    let end = start;
    while (end + 1 < used.length && used[end + 1]) end++;
    const inBlock = i => i >= start && i <= end;
    const at = start < 0 ? -1 : rows.findIndex(r => r.filter((v, i) => inBlock(i) && v !== '').length >= 3);
    if (at >= 0){
      const keepCols = rows[at].map((v, i) => (inBlock(i) && v !== '' ? i : -1)).filter(i => i >= 0);
      headers = keepCols.map(i => rows[at][i]);
      rows = rows.slice(at + 1).map(r => keepCols.map(i => r[i]));
    }
  }
  headers = headers.map((h, i) => h || `Column ${i + 1}`);
  // This data is public, so never pass on email columns or email-looking values.
  const keep = headers.map((h, i) => !/e-?mail/i.test(h) && !rows.some(r => EMAIL_RE.test(r[i])));
  headers = headers.filter((h, i) => keep[i]);
  rows = rows
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(r.filter((v, i) => keep[i]).map((v, i) => [headers[i], v])));
  return { headers, rows };
}

async function fetchTab(tab){
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(tab)}`;
  const r = await fetch(sheetUrl, { headers: { 'User-Agent': 'cryogen-proxy/2.0' } });
  const body = await r.text();
  if (!r.ok) throw new HttpError(502, `Google Sheets returned ${r.status} for tab "${tab}".`);
  if (/^\s*</.test(body)) throw new HttpError(502, 'The Google Sheet is not shared publicly ("Anyone with the link can view").');
  return body;
}

async function handleSheet(endpoint, res){
  const tab = SHEET_TABS[endpoint];
  // Google silently returns the first tab when the named one doesn't exist. Detect that by
  // comparing with what a tab name that can't exist returns.
  const [body, fallback] = await Promise.all([fetchTab(tab), fetchTab(`__no_such_tab_${Date.now()}`)]);
  const columns = b => JSON.stringify(JSON.parse(b.slice(b.indexOf('{'), b.lastIndexOf('}') + 1)).table?.cols || null);
  const cols = columns(body);
  if (cols !== 'null' && cols === columns(fallback)){
    throw new HttpError(404, `The Google Sheet has no tab named "${tab}".`);
  }
  const { headers, rows } = parseGviz(body);
  // Google silently falls back to the first tab when the named tab doesn't exist,
  // so make sure this really looks like a rides tab before showing it as rides.
  if (endpoint === 'rides' && !headers.some(h => /^(title|date)$/i.test(h))){
    throw new HttpError(404, `No "${tab}" tab with Title and Date columns was found in the Google Sheet.`);
  }
  const updated = new Date().toISOString();
  sendJSON(res, 200, endpoint === 'rides' ? { rides: rows, headers, updated } : { headers, rows, updated });
}

// ── Static files (local dev) ───────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg' };

function serveStatic(res, reqPath){
  const filePath = path.join(PUBLIC_DIR, path.normalize(reqPath === '/' ? '/index.html' : reqPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()){
    return sendJSON(res, 404, { error: 'Not found' });
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

// ── Router ─────────────────────────────────────────────────
async function route(req, res){
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  if (req.method === 'OPTIONS'){
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization'
    });
    return res.end();
  }

  if (pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);

  const dataRoute = DATA_ROUTES[`${req.method} ${pathname}`];
  if (dataRoute) return handleData(dataRoute, req, res);

  const tttRoute = TTT_ROUTES[`${req.method} ${pathname}`];
  if (tttRoute) return handleTtt(tttRoute, req, res);

  if (pathname === '/api/proxy'){
    // Only named sheet tabs are allowed, so the proxy can't be used to fetch arbitrary URLs.
    const endpoint = parsed.query.endpoint;
    if (!Object.prototype.hasOwnProperty.call(SHEET_TABS, endpoint)){
      return sendJSON(res, 400, { error: 'unknown endpoint', endpoint: endpoint || null });
    }
    return handleSheet(endpoint, res);
  }

  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Not found' });
  serveStatic(res, pathname);
}

function handler(req, res){
  route(req, res).catch(err => {
    if (!err.status) console.error(err);
    if (res.headersSent) return res.end();
    sendJSON(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
  });
}

// Vercel calls the exported handler; `npm start` runs a local server.
module.exports = handler;

if (require.main === module){
  http.createServer(handler).listen(PORT, () => console.log(`cryogen-proxy server listening on http://localhost:${PORT}`));
}
