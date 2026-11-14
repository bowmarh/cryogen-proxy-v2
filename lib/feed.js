'use strict';
// The notification bell: a short list of the latest club news. Every post the app makes to a public Discord channel is also kept here (so the bell shows
// what the channel shows, such as "ZRL rosters are out"), and staff can post a line of their own. Nothing private goes in: admin channels are never added.
// Each person's "read up to here" mark lives in their own browser, so the server stores one shared list and no per-person state.
module.exports = function createFeed({ redis, HttpError, requireRole, memberFromRequest, roleFromRequest, keep = 60 }) {
  const KEY = 'cg:feed';
  const KINDS = { public: ['Club', 'dashboard'], 'zrl-public': ['ZRL', 'zrl'], ladder: ['Ladder', 'ladder'], drs: ['DIRT', 'drs'], news: ['News', 'dashboard'] };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  // Discord markdown and mentions out; first line only; short.
  const plain = t => String(t == null ? '' : t).replace(/<@[!&]?\d+>|<#\d+>|@everyone|@here/g, '').replace(/\\([\\*_~`|>\[\]])/g, '$1').replace(/[*_~`|>]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '';
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
  async function add(channel, payload) {
    const k = KINDS[channel]; if (!k) return false;   // admin and other private channels are never kept
    const p = payload || {}; const text = clip(plain(p.content || (p.embeds && p.embeds[0] && (p.embeds[0].title || p.embeds[0].description)) || ''), 180);
    if (!text) return false;
    const item = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), ts: Date.now(), kind: k[0], tab: k[1], text };
    const last = parse(((await redis([['LRANGE', KEY, 0, 0]]))[0] || [])[0]);
    if (last && last.text === text && item.ts - last.ts < 600000) return false;   // the same line twice in ten minutes is one item
    await redis([['LPUSH', KEY, JSON.stringify(item)], ['LTRIM', KEY, 0, keep - 1]]);
    return true;
  }
  const routes = {
    'GET /api/feed': async req => {
      if (!roleFromRequest(req) && !memberFromRequest(req)) throw new HttpError(401, 'Please sign in.');
      const rows = (await redis([['LRANGE', KEY, 0, 39]]))[0] || [];
      return { items: rows.map(parse).filter(Boolean), canPost: ['admin', 'mod'].includes(roleFromRequest(req)) };
    },
    'POST /api/feed': async (req, body) => {
      requireRole(req, ['admin', 'mod']);
      const text = clip(String((body && body.text) || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim(), 180);
      if (!text) throw new HttpError(400, 'Write a line first.');
      await add('news', { content: text });
      return { ok: true };
    },
  };
  return { routes, add, plain };
};
