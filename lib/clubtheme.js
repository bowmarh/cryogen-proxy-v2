'use strict';
// The club's look, set once by an administrator: an accent colour, a welcome line and a logo address, plus up to four dated "seasonal" looks
// (for example Christmas) that take over the accent and welcome line between two dates each year. A rider's own accent choice wins over all of it.
module.exports = function createClubTheme({ redis, HttpError, requireRole }) {
  const KEY = 'cg:club:theme', MAX_SEASONS = 4;
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const md = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
  const hex = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toLowerCase() : '');
  const text = (v, n) => String(v || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n);
  const clean = t => ({
    accent: hex(t.accent),
    welcome: text(t.welcome, 140),
    logo: /^https:\/\/[^\s"'<>]{4,290}$/.test(String(t.logo || '')) ? String(t.logo) : '',
    seasons: (Array.isArray(t.seasons) ? t.seasons : []).filter(s => s && md.test(String(s.from)) && md.test(String(s.to))).slice(0, MAX_SEASONS)
      .map(s => ({ label: text(s.label, 30), from: String(s.from), to: String(s.to), accent: hex(s.accent), welcome: text(s.welcome, 140) })),
  });
  // A season runs from `from` to `to` (month-day), and may wrap over New Year.
  const within = (s, now) => { const d = new Date(now).toISOString().slice(5, 10); return s.from <= s.to ? d >= s.from && d <= s.to : d >= s.from || d <= s.to; };
  async function get(now = Date.now()) {
    const base = clean(parse((await redis([['GET', KEY]]))[0]) || {});
    const on = base.seasons.find(s => within(s, now));
    return { ...base, accent: (on && on.accent) || base.accent, welcome: (on && on.welcome) || base.welcome, active: on ? on.label : '', base: { accent: base.accent, welcome: base.welcome } };
  }
  const routes = {
    'GET /api/club/theme': async () => get(),
    'POST /api/club/theme': async (req, body) => {
      requireRole(req, ['admin']);
      if (body.logo && !/^https:\/\//.test(String(body.logo))) throw new HttpError(400, 'The logo must be an https:// address.');
      if (body.accent && !hex(body.accent)) throw new HttpError(400, 'The accent colour must look like #00d4ff.');
      for (const s of Array.isArray(body.seasons) ? body.seasons : []) if (!md.test(String(s.from)) || !md.test(String(s.to))) throw new HttpError(400, 'A seasonal look needs a start and an end date.');
      await redis([['SET', KEY, JSON.stringify(clean(body))]]);
      return get();
    },
  };
  return { routes, get, clean, within, KEY };
};
