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
  'ttt-sheet': process.env.SHEET_TAB_TTT || 'TTT',
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
  let headers = cols.map(c => (c.label || '').trim());
  // If Google didn't detect a header row, use the first row as headers.
  if (headers.every(h => !h) && rows.length){ headers = rows[0]; rows = rows.slice(1); }
  headers = headers.map((h, i) => h || `Column ${i + 1}`);
  // This data is public, so never pass on email columns or email-looking values.
  const keep = headers.map((h, i) => !/e-?mail/i.test(h) && !rows.some(r => EMAIL_RE.test(r[i])));
  headers = headers.filter((h, i) => keep[i]);
  rows = rows
    .filter(r => r.some(v => v !== ''))
    .map(r => Object.fromEntries(r.filter((v, i) => keep[i]).map((v, i) => [headers[i], v])));
  return { headers, rows };
}

async function handleSheet(endpoint, res){
  const tab = SHEET_TABS[endpoint];
  const sheetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(SHEET_ID)}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(tab)}`;
  const r = await fetch(sheetUrl, { headers: { 'User-Agent': 'cryogen-proxy/2.0' } });
  const body = await r.text();
  if (!r.ok) throw new HttpError(502, `Google Sheets returned ${r.status} for tab "${tab}".`);
  if (/^\s*</.test(body)) throw new HttpError(502, 'The Google Sheet is not shared publicly ("Anyone with the link can view").');
  const { headers, rows } = parseGviz(body);
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
