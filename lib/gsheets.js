'use strict';
// A small Google Sheets client for a service account: sign in with a signed token, find or add a tab, and replace a tab's contents. It uses only the
// sheets the account has been shared on (as an editor), and only what is written here: the app writes its own mirror tabs, never the club's own tabs.
// The key comes from GOOGLE_SERVICE_ACCOUNT_JSON (the JSON key file as one line) or GOOGLE_SERVICE_ACCOUNT_JSON_B64 (the same, base64) and is never sent anywhere
// except to Google to sign in.
const crypto = require('crypto');

module.exports = function createGSheets({ fetchImpl = (...a) => fetch(...a), env = process.env } = {}) {
  const TOKEN_URL = 'https://oauth2.googleapis.com/token', API = 'https://sheets.googleapis.com/v4/spreadsheets';
  const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
  const MAX_CELLS = 400000;
  let cached = null;   // { token, exp }

  function credentials() {
    let raw = env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
    if (!raw && env.GOOGLE_SERVICE_ACCOUNT_JSON_B64) { try { raw = Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, 'base64').toString('utf8'); } catch (e) { raw = ''; } }
    if (!raw) return null;
    try {
      const j = JSON.parse(raw);
      const key = String(j.private_key || '').replace(/\\n/g, '\n');
      return j.client_email && key.includes('PRIVATE KEY') ? { email: String(j.client_email), key } : { error: 'The Google service account key is missing its client_email or private_key.' };
    } catch (e) { return { error: 'GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.' }; }
  }
  const status = () => { const c = credentials(); return c && !c.error ? { configured: true, email: c.email } : { configured: false, error: c && c.error || '' }; };
  const b64 = v => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

  async function accessToken() {
    const c = credentials();
    const fp = c && !c.error ? crypto.createHash('sha1').update(c.email + c.key).digest('hex') : '';
    if (cached && cached.fp === fp && cached.exp > Date.now() + 60000) return cached.token;
    if (!c || c.error) throw Object.assign(new Error(c && c.error || 'Google Sheets is not set up: add GOOGLE_SERVICE_ACCOUNT_JSON.'), { status: 409 });
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: c.email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 })}`;
    let jwt;
    try { jwt = `${unsigned}.${crypto.createSign('RSA-SHA256').update(unsigned).sign(c.key).toString('base64url')}`; }
    catch (e) { throw Object.assign(new Error('The Google service account key could not be used to sign in (is the private_key complete?).'), { status: 409 }); }
    const r = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`, signal: AbortSignal.timeout(5000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) throw Object.assign(new Error(`Google would not sign the service account in${d.error_description ? ': ' + d.error_description : ''}.`), { status: 502 });
    cached = { fp, token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 3600) * 1000 };
    return cached.token;
  }

  async function call(method, url, body, sheetId) {
    const token = await accessToken();
    const r = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (r.ok) return r.json().catch(() => ({}));
    const d = await r.json().catch(() => ({}));
    const msg = d.error && d.error.message ? d.error.message : '';
    const who = (credentials() || {}).email || 'the service account';
    if (r.status === 403) throw Object.assign(new Error(`Google refused access to that sheet. Share it with ${who} as an Editor.`), { status: 409 });
    if (r.status === 404) throw Object.assign(new Error('Google could not find that sheet. Check the sheet ID.'), { status: 409 });
    throw Object.assign(new Error(`Google Sheets answered ${r.status}${msg ? ': ' + msg : ''}`), { status: 502 });
  }

  const quote = t => `'${String(t).replace(/'/g, "''")}'`;
  async function ensureTab(sheetId, title) {
    const meta = await call('GET', `${API}/${encodeURIComponent(sheetId)}?fields=sheets.properties`, undefined, sheetId);
    if ((meta.sheets || []).some(s => s.properties && s.properties.title === title)) return false;
    await call('POST', `${API}/${encodeURIComponent(sheetId)}:batchUpdate`, { requests: [{ addSheet: { properties: { title, gridProperties: { frozenRowCount: 2 } } } }] }, sheetId);
    return true;
  }
  // Replaces everything in the tab with `rows` (arrays of text and numbers). The tab is created when it does not exist.
  async function writeTab(sheetId, title, rows) {
    if (rows.reduce((n, r) => n + r.length, 0) > MAX_CELLS) throw Object.assign(new Error('That is too much to write to a sheet in one go.'), { status: 400 });
    const created = await ensureTab(sheetId, title);
    await call('POST', `${API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(quote(title) + '!A:AZ')}:clear`, {}, sheetId);
    const out = await call('PUT', `${API}/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(quote(title) + '!A1')}?valueInputOption=RAW`, { range: `${quote(title)}!A1`, majorDimension: 'ROWS', values: rows }, sheetId);
    return { created, cells: out.updatedCells || 0, rows: rows.length };
  }
  return { status, accessToken, writeTab, ensureTab };
};
