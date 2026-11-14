'use strict';
// Saved table views for staff, kept on the server so they follow an admin or moderator between phone, iPad and laptop.
// One shared set for all staff: { "<list signature>": [{ name, q, sort }] }. Riders never read or write it.
module.exports = function createTableViews({ redis, HttpError, requireRole }) {
  const KEY = 'cg:tfviews:v1', MAX_LISTS = 80, MAX_VIEWS = 12;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const text = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  const cleanView = v => {
    if (!v || typeof v !== 'object') return null;
    const name = text(v.name, 40); if (!name) return null;
    const so = v.sort && Number.isInteger(v.sort.col) && v.sort.col >= 0 && v.sort.col < 60 && (v.sort.dir === 1 || v.sort.dir === -1) ? { col: v.sort.col, dir: v.sort.dir } : null;
    return { name, q: text(v.q, 200), sort: so };
  };
  const cleanList = l => { const seen = new Set(); return (Array.isArray(l) ? l : []).map(cleanView).filter(v => v && !seen.has(v.name) && seen.add(v.name)).slice(-MAX_VIEWS); };
  async function all() { const raw = parse((await redis([['GET', KEY]]))[0]); return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}; }
  const routes = {
    'GET /api/tableviews': async req => { requireRole(req, ['admin', 'mod']); return { views: await all() }; },
    // Replaces the views of one list. An empty list removes it.
    'POST /api/tableviews': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const sig = text(body && body.sig, 120); if (!sig) throw new HttpError(400, 'Which list are these views for?');
      const cur = await all(), list = cleanList(body.views);
      if (list.length) cur[sig] = list; else delete cur[sig];
      if (Object.keys(cur).length > MAX_LISTS) throw new HttpError(400, 'Too many lists have saved views.');
      await redis([['SET', KEY, JSON.stringify(cur)]]);
      return { views: cur };
    },
  };
  return { routes, cleanList, KEY };
};
