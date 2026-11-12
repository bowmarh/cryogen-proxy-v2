'use strict';
// Standings on the club's WordPress website, automatically. Off until the owner switches it on. When every team has a result for a race, one post is made:
// "<round>: standings after race N", a table per division (team, races, points) and that race's results. It is a DRAFT unless the owner has also chosen
// to publish straight away, so a person can read it first. Team names and points only: no riders, no personal details. Each race is posted once.
module.exports = function createSiteFeed({ redis, HttpError, requireRole, zrl, wpPost, discord = async () => false, siteUrl = '' }) {
  const K = { settings: 'cg:sitefeed:settings', done: 'cg:sitefeed:done', last: 'cg:sitefeed:last' };
  const parse = v => { try { return JSON.parse(v); } catch (e) { return null; } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
  const settings = async () => ({ on: false, publish: false, ...(parse((await redis([['GET', K.settings]]))[0]) || {}) });
  const has = r => r && (r.pos || (r.pts !== undefined && r.pts !== null));
  async function state() { const d = await zrl.load(); if (!d.round) return null; const results = await zrl.loadResults(); return { round: d.round, results, stand: zrl.standingsOf(d.round, results, false) }; }
  const latestComplete = st => { for (let w = st.round.weeks - 1; w >= 0; w--) if (st.round.teams.length && st.round.teams.every(t => has(st.results[`${w}:${t.id}`]))) return w; return -1; };
  function build(st, week) {
    const title = `${st.round.name}: standings after race ${week + 1}`;
    const tables = st.stand.groups.map(g => `<h3>${esc(g.name)}</h3><table><thead><tr><th>#</th><th>Team</th><th>Races</th><th>Points</th></tr></thead><tbody>${g.teams.map(t => `<tr><td>${t.rank}</td><td>${esc(t.name)}</td><td>${t.races}</td><td>${esc(t.total)}</td></tr>`).join('')}</tbody></table>`).join('');
    const rows = st.round.teams.map(t => ({ name: t.name, r: st.results[`${week}:${t.id}`] })).filter(x => has(x.r));
    const race = `<h3>Race ${week + 1} results</h3><ul>${rows.map(x => `<li>${esc(x.name)}: ${x.r.pos ? ord(x.r.pos) : 'result in'}${x.r.pts !== undefined && x.r.pts !== null ? `, ${esc(x.r.pts)} points` : ''}</li>`).join('')}</ul>`;
    return { title, content: `<p>The latest ZRL standings for Team CRYO-GEN.</p>${tables}${race}<p><em>Posted automatically from the club app.</em></p>` };
  }
  async function post(st, week, { force = false } = {}) {
    const s = await settings(), key = `${st.round.name}:${week}`, [fresh] = await redis([['HSETNX', K.done, key, new Date().toISOString()]]);
    if (!fresh && !force) return { skipped: 'already posted' };
    const p = build(st, week);
    try {
      const made = await wpPost({ title: p.title, content: p.content, status: s.publish ? 'publish' : 'draft' });
      const rec = { at: new Date().toISOString(), week, title: p.title, status: s.publish ? 'publish' : 'draft', link: made.link || '', id: made.id || null }; await redis([['SET', K.last, JSON.stringify(rec)]]);
      await discord('admin', { content: `📰 ${s.publish ? 'Posted to the website' : 'A draft is ready on the website'}: "${p.title}". ${made.link || siteUrl}` }).catch(() => {});
      return { posted: true, ...rec };
    } catch (e) { await redis([['HDEL', K.done, key]]); await redis([['SET', K.last, JSON.stringify({ at: new Date().toISOString(), week, error: String(e.message).slice(0, 200) })]]); throw e; }
  }
  async function tick() {
    const s = await settings(); if (!s.on) return [];
    const st = await state(); if (!st) return []; const w = latestComplete(st); if (w < 0) return [];
    try { const r = await post(st, w); return r.posted ? [`sitefeed-${w}`] : []; } catch (e) { console.error('Site feed:', e.message); return []; }
  }
  const routes = {
    'GET /api/sitefeed': async req => { requireRole(req, ['admin', 'mod']); return { settings: await settings(), last: parse((await redis([['GET', K.last]]))[0]) }; },
    'POST /api/sitefeed/settings': async (req, body) => { requireRole(req, ['admin']); const n = { on: body.on === true, publish: body.publish === true }; await redis([['SET', K.settings, JSON.stringify(n)]]); return { settings: n }; },
    'POST /api/sitefeed/preview': async req => { requireRole(req, ['admin', 'mod']); const st = await state(); if (!st) throw new HttpError(409, 'There is no ZRL round.'); const w = latestComplete(st); if (w < 0) throw new HttpError(409, 'No race has results for every team yet.'); return { week: w, ...build(st, w) }; },
    'POST /api/sitefeed/post-now': async (req, body) => { requireRole(req, ['admin']); const st = await state(); if (!st) throw new HttpError(409, 'There is no ZRL round.'); const w = latestComplete(st); if (w < 0) throw new HttpError(409, 'No race has results for every team yet.'); return post(st, w, { force: body.force === true }); },
  };
  return { routes, tick, build, settings };
};
