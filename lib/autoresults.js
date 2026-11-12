'use strict';
// Automatic ZRL results. An administrator gives the address of a results table (a published Google Sheet as CSV, or any public CSV: columns Team, Position
// and/or Points). On race day and the day after, the scheduled job fetches it and, when its contents have changed since last time, enters the results the
// same way the "paste a table" import does (teams matched by name, only our teams read). A manual edit made after an automatic import stays until the
// source changes again. The radio, the team reports and the open race page all follow from the entered results.
const crypto = require('crypto');

module.exports = function createAutoResults({ redis, HttpError, requireRole, zrl, asStaff, fetchImpl = (...a) => fetch(...a), discord = async () => false, siteUrl = '' }) {
  const K = { settings: 'cg:autoresults:settings', hashes: 'cg:autoresults:hashes', last: 'cg:autoresults:last' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const DAY = 86400000, MAX = 500000;
  const weekDate = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * DAY).toISOString().slice(0, 10);
  const settings = async () => ({ on: false, url: '', ...(parse((await redis([['GET', K.settings]]))[0]) || {}) });
  const last = async () => parse((await redis([['GET', K.last]]))[0]);
  const note = (ok, text, extra = {}) => redis([['SET', K.last, JSON.stringify({ at: new Date().toISOString(), ok, note: String(text).slice(0, 240), ...extra })]]);

  // Only a public https address: no addresses that point inside a network, no logins in the address.
  function safeUrl(u) {
    let x; try { x = new URL(String(u || '').trim()); } catch (e) { throw new HttpError(400, 'That is not a web address.'); }
    const host = x.hostname.toLowerCase();
    if (x.protocol !== 'https:') throw new HttpError(400, 'The address must start with https://');
    if (x.username || x.password) throw new HttpError(400, 'Remove the login from the address.');
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) throw new HttpError(400, 'Use a public website address, not an internal one.');
    return x.toString();
  }
  // A web page with a results table (a published sheet page, a standings page): the first table that has a Team column and a Position or Points column.
  function htmlTableToCsv(html) {
    const clean = c => c.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    for (const t of String(html).match(/<table[\s\S]*?<\/table>/gi) || []) {
      const rows = (t.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(r => (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(clean)).filter(r => r.length);
      const head = rows.findIndex(r => r.some(c => /^(team|club|name)\b/i.test(c)) && r.some(c => /^(pos|position|rank|place|#|pts|points|score)/i.test(c)));
      if (head >= 0) return rows.slice(head).map(r => r.map(c => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(',')).join('\n');
    }
    return '';
  }
  async function fetchCsv(url) {
    let r; try { r = await fetchImpl(url, { headers: { Accept: 'text/csv,text/plain,*/*', 'User-Agent': 'cryogen-proxy/2.0' }, redirect: 'follow', signal: AbortSignal.timeout(15000) }); } catch (e) { throw new HttpError(502, 'The results address could not be reached.'); }
    if (!r.ok) throw new HttpError(502, `The results address answered HTTP ${r.status}.`);
    const text = await r.text(); if (text.length > MAX) throw new HttpError(502, 'That file is too big to be a results table.');
    if (/^\s*<(!doctype|html)/i.test(text)) { const csv = htmlTableToCsv(text); if (!csv) throw new HttpError(502, 'That address is a web page with no results table in it (for a Google Sheet use File → Share → Publish to web → CSV).'); return csv; }
    return text;
  }
  async function target(now) {
    const data = await zrl.load(); if (!data.round) return null;
    const today = new Date(now).toISOString().slice(0, 10), prev = new Date(now - DAY).toISOString().slice(0, 10);
    const week = Array.from({ length: data.round.weeks }, (_, i) => i).find(i => [today, prev].includes(weekDate(data.round, i)));
    return week === undefined ? null : { round: data.round, week };
  }
  async function pull(week, { apply, force = false } = {}) {
    const s = await settings(); if (!s.url) throw new HttpError(409, 'No results address is set.');
    const csv = await fetchCsv(safeUrl(s.url)), hash = crypto.createHash('sha256').update(csv).digest('hex').slice(0, 20), [seen] = await redis([['HGET', K.hashes, String(week)]]);
    if (apply && !force && seen === hash) return { unchanged: true };
    const res = await zrl.routes['POST /api/zrl/results-import'](asStaff(), { csv, week, apply: !!apply });
    if (apply) await redis([['HSET', K.hashes, String(week), hash]]);
    return res;
  }
  async function tick(now = Date.now()) {
    const s = await settings(); if (!s.on || !s.url) return [];
    const t = await target(now); if (!t) return [];
    try {
      const r = await pull(t.week, { apply: true });
      if (r.unchanged) return [];
      await note(true, `Race ${t.week + 1}: ${r.applied} team result${r.applied === 1 ? '' : 's'} entered${r.missing && r.missing.length ? `; not in the table: ${r.missing.join(', ')}` : ''}.`, { week: t.week });
      await discord('admin', { content: `📥 Results for race ${t.week + 1} were read automatically (${r.applied} team${r.applied === 1 ? '' : 's'}). Check them in ZRL → Results.` }).catch(() => {});
      return [`autoresults-${t.week}`];
    } catch (e) {
      const prev = await last(), msg = String(e.message || e);
      await note(false, msg, { week: t.week });
      if (!prev || prev.ok || prev.note !== msg) await discord('admin', { content: `⚠️ Automatic results could not be read: ${msg}` }).catch(() => {});
      return [];
    }
  }
  const routes = {
    'GET /api/autoresults': async req => { requireRole(req, ['admin', 'mod']); const t = await target(Date.now()); return { settings: await settings(), last: await last(), raceWindow: t ? { week: t.week, date: weekDate(t.round, t.week) } : null }; },
    'POST /api/autoresults/settings': async (req, body) => { requireRole(req, ['admin']); const n = { on: body.on === true, url: body.url ? safeUrl(body.url) : '' }; if (n.on && !n.url) throw new HttpError(400, 'Add the results address first.'); await redis([['SET', K.settings, JSON.stringify(n)]]); return { settings: n }; },
    // Reads the table now and shows what it would enter, without entering anything.
    'POST /api/autoresults/test': async (req, body) => { requireRole(req, ['admin']); const data = await zrl.load(); if (!data.round) throw new HttpError(409, 'There is no ZRL round.'); const t = await target(Date.now()), week = Number.isInteger(Number(body.week)) && body.week !== '' && body.week != null ? Number(body.week) : (t ? t.week : 0); return { week, preview: (await pull(week, { apply: false })).preview }; },
  };
  return { routes, tick, safeUrl, settings, htmlTableToCsv };
};
