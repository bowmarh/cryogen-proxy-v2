'use strict';
// One-tap availability from an email: the link carries the rider's signed token (the same kind the unsubscribe link uses), the page shows the race and
// three buttons, and the answer is recorded only when a button is pressed (a POST), so mail scanners that open links cannot answer for anyone.
// The answer is written exactly where the ZRL page writes it (for all the rider's teams) and the captain sees it there.
module.exports = function createRsvp({ redis, zrl, readToken, siteUrl = '' }) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><meta name="robots" content="noindex"/><title>${esc(title)}</title><style>body{font-family:system-ui,Arial,sans-serif;background:#f3f4f6;color:#1f2937;margin:0}main{max-width:480px;margin:40px auto;background:#fff;border-radius:12px;padding:24px}h1{font-size:20px;margin:0 0 8px}button{font-size:16px;padding:12px 18px;margin:6px 6px 0 0;border:0;border-radius:8px;cursor:pointer;color:#fff}.y{background:#15803d}.m{background:#a16207}.n{background:#b91c1c}p{line-height:1.5}</style></head><body><main>${body}</main></body></html>`;
  const weekDate = (round, i) => new Date(Date.parse(`${round.start}T00:00:00Z`) + 7 * i * 86400000).toISOString().slice(0, 10);
  async function context(token, w) {
    const t = readToken(token); if (!t) return { error: 'That link is not valid. Please use the link in your latest email.' };
    const data = await zrl.load(); if (!data.round) return { error: 'There is no ZRL round running right now.' };
    const rider = data.signups.find(x => x.in && x.zwid === t.zwid), teams = rider ? data.round.teams.filter(x => (data.assign[rider.key] || []).includes(x.id)) : [];
    if (!rider || !teams.length) return { error: 'We could not find you on a ZRL team yet. Ask your captain.' };
    const today = new Date().toISOString().slice(0, 10), asked = Number.isInteger(Number(w)) && w !== '' && w != null ? Number(w) : null;
    let week = asked !== null && asked >= 0 && asked < data.round.weeks ? asked : Array.from({ length: data.round.weeks }, (_, i) => i).find(i => weekDate(data.round, i) >= today);
    if (week === undefined) week = data.round.weeks - 1;
    return { zwid: t.zwid, name: rider.name, week, date: weekDate(data.round, week), teams: teams.map(x => x.name), round: data.round.name };
  }
  async function show(token, w) {
    const c = await context(token, w); if (c.error) return page('Availability', `<h1>Availability</h1><p>${esc(c.error)}</p>`);
    const btn = (v, label, cls) => `<button class="${cls}" name="a" value="${v}">${label}</button>`;
    return page('Availability', `<h1>Can you race?</h1><p>${esc(c.round)}, race ${c.week + 1} on <b>${esc(c.date)}</b> for ${esc(c.teams.join(' and '))}.</p><form method="post"><input type="hidden" name="t" value="${esc(token)}"/><input type="hidden" name="w" value="${c.week}"/>${btn('yes', 'Yes, I can race', 'y')}${btn('maybe', 'Maybe', 'm')}${btn('no', 'No, I cannot', 'n')}</form><p style="font-size:13px;color:#6b7280">Your captain sees this straight away. You can change it later in the club app.</p>`);
  }
  async function answer(token, w, status) {
    if (!['yes', 'maybe', 'no'].includes(status)) return page('Availability', '<h1>Availability</h1><p>Please choose yes, maybe or no.</p>');
    const c = await context(token, w); if (c.error) return page('Availability', `<h1>Availability</h1><p>${esc(c.error)}</p>`);
    const data = await zrl.load(), teams = data.round.teams.filter(x => c.teams.includes(x.name));
    await redis([['HSET', zrl.KEYS.weekly, `a:${c.week}:${c.zwid}`, status], ...teams.map(x => ['HDEL', zrl.KEYS.weekly, `a:${c.week}:${c.zwid}:${x.id}`])]);
    return page('Thanks', `<h1>Thanks${c.name ? ', ' + esc(String(c.name).split(/\s+/)[0]) : ''}!</h1><p>Recorded: <b>${esc(status)}</b> for race ${c.week + 1} (${esc(c.date)}).</p><p><a href="${esc(siteUrl)}">Open the club app</a></p>`);
  }
  return { show, answer, context };
};
