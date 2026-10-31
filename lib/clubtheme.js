'use strict';
// The club's look, set once by an administrator: an accent colour, a welcome line and a logo address. Everyone sees it; a rider's own accent choice wins.
module.exports = function createClubTheme({ redis, HttpError, requireRole }) {
  const KEY = 'cg:club:theme';
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const clean = t => ({
    accent: /^#[0-9a-f]{6}$/i.test(String(t.accent || '')) ? String(t.accent).toLowerCase() : '',
    welcome: String(t.welcome || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 140),
    logo: /^https:\/\/[^\s"'<>]{4,290}$/.test(String(t.logo || '')) ? String(t.logo) : '',
  });
  const get = async () => clean(parse((await redis([['GET', KEY]]))[0]) || {});
  const routes = {
    'GET /api/club/theme': async () => get(),
    'POST /api/club/theme': async (req, body) => {
      requireRole(req, ['admin']);
      if (body.logo && !/^https:\/\//.test(String(body.logo))) throw new HttpError(400, 'The logo must be an https:// address.');
      if (body.accent && !/^#[0-9a-f]{6}$/i.test(String(body.accent))) throw new HttpError(400, 'The accent colour must look like #00d4ff.');
      const t = clean(body);
      await redis([['SET', KEY, JSON.stringify(t)]]);
      return t;
    },
  };
  return { routes, get, clean, KEY };
};
