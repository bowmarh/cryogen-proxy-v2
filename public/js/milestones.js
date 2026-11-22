'use strict';
// Badges, a weekly goal ring and a season recap on Home, from the member's own race results (the Duolingo / Apple Fitness / Spotify Wrapped ideas).
// Everything is worked out on this device from /api/me/results; the weekly goal is kept in this browser only.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const place = r => (r.catPos != null ? r.catPos : r.pos);
  const weekOf = t => Math.floor((t * 1000 - 4 * 864e5) / (7 * 864e5));
  const seasonFrom = (now = Date.now()) => { const d = new Date(now); return Date.UTC(d.getUTCMonth() >= 8 ? d.getUTCFullYear() : d.getUTCFullYear() - 1, 8, 1) / 1000; };
  const BADGES = [
    { id: 'first', icon: '🚴', name: 'First race', test: s => s.races >= 1 },
    { id: 'ten', icon: '🔟', name: '10 races', test: s => s.races >= 10 },
    { id: 'fifty', icon: '🏅', name: '50 races', test: s => s.races >= 50 },
    { id: 'podium', icon: '🥉', name: 'First podium', test: s => s.podiums >= 1 },
    { id: 'win', icon: '🥇', name: 'First win', test: s => s.wins >= 1 },
    { id: 'top10', icon: '⭐', name: 'Top-10 finish', test: s => s.best !== null && s.best <= 10 },
    { id: 'streak4', icon: '🔥', name: '4-week streak', test: s => s.bestStreak >= 4 },
    { id: 'streak12', icon: '🌋', name: '12-week streak', test: s => s.bestStreak >= 12 },
  ];
  function stats(list, now = Date.now()) {
    const done = (list || []).filter(r => r.time), ps = done.map(place).filter(p => p != null), weeks = [...new Set(done.map(r => weekOf(r.time)))].sort((a, b) => a - b);
    let best = 0, run = 0, prev = null; for (const w of weeks) { run = prev !== null && w === prev + 1 ? run + 1 : 1; best = Math.max(best, run); prev = w; }
    return { races: done.length, podiums: ps.filter(p => p <= 3).length, wins: ps.filter(p => p === 1).length, best: ps.length ? Math.min(...ps) : null, bestStreak: best,
      thisWeek: done.filter(r => weekOf(r.time) === weekOf(now / 1000)).length };
  }
  function recap(list, now = Date.now()) {
    const from = seasonFrom(now), mine = (list || []).filter(r => r.time && r.time >= from), ps = mine.map(place).filter(p => p != null), st = stats(mine, now);
    const byMonth = {}; mine.forEach(r => { const m = new Date(r.time * 1000).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' }); byMonth[m] = (byMonth[m] || 0) + 1; });
    const busiest = Object.entries(byMonth).sort((a, b) => b[1] - a[1])[0];
    return { races: mine.length, podiums: st.podiums, wins: st.wins, best: st.best, streak: st.bestStreak, busiest: busiest ? { month: busiest[0], races: busiest[1] } : null, avg: ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length) : null };
  }
  const getGoal = () => { try { const n = parseInt(localStorage.getItem('cg:goal:week'), 10); return n > 0 && n <= 14 ? n : 0; } catch (e) { return 0; } };
  const setGoal = n => { try { localStorage.setItem('cg:goal:week', String(n)); } catch (e) { /* kept for this visit only */ } };
  function ring(done, goal) {
    const r = 26, c = 2 * Math.PI * r, f = goal ? Math.min(1, done / goal) : 0;
    return `<svg width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${done} of ${goal} races this week"><circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="7"/><circle cx="32" cy="32" r="${r}" fill="none" stroke="${f >= 1 ? '#22c55e' : 'var(--accent)'}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/><text x="32" y="37" text-anchor="middle" font-size="15" font-weight="800" fill="currentColor">${done}/${goal || '–'}</text></svg>`;
  }
  let last = null, showRecap = false;
  function render(list) {
    if (list) last = list;
    const el = document.getElementById('milestones-card'); if (!el) return;
    if ((window.role || sessionStorage.getItem('role')) !== 'member' || !last || !last.length) { el.innerHTML = ''; return; }
    const s = stats(last), got = BADGES.filter(b => b.test(s)), goal = getGoal(), rc = recap(last);
    const badges = BADGES.map(b => { const on = b.test(s); return `<span title="${E(b.name)}${on ? '' : ' (not yet)'}" style="display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:3px 9px;border-radius:12px;border:1px solid ${on ? 'rgba(var(--accent-rgb),0.5)' : 'rgba(255,255,255,0.1)'};opacity:${on ? 1 : 0.4}"><span aria-hidden="true">${b.icon}</span>${E(b.name)}</span>`; }).join(' ');
    el.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
      <div style="text-align:center">${ring(s.thisWeek, goal)}</div>
      <div style="flex:1;min-width:180px"><div style="font-weight:800">🎯 Weekly goal</div><div style="font-size:12px;color:#8b95a5;margin:2px 0 6px">${goal ? (s.thisWeek >= goal ? 'Goal reached. Nice week.' : `${goal - s.thisWeek} more race${goal - s.thisWeek === 1 ? '' : 's'} to fill the ring.`) : 'Pick how many races you want each week.'}</div>
        <div role="group" aria-label="Races a week goal">${[1, 2, 3, 4].map(n => `<button type="button" class="goal-btn" data-n="${n}" aria-pressed="${goal === n}" style="font-size:12px;padding:2px 10px;margin-right:4px;border-radius:10px;border:1px solid ${goal === n ? 'var(--accent)' : 'rgba(255,255,255,0.15)'};background:${goal === n ? 'rgba(var(--accent-rgb),0.15)' : 'transparent'};color:inherit;cursor:pointer">${n}</button>`).join('')}</div></div></div>
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#8b95a5;margin-bottom:6px">Badges · ${got.length} of ${BADGES.length}</div><div style="display:flex;flex-wrap:wrap;gap:6px">${badges}</div>
      <div style="margin-top:10px"><button type="button" id="recap-toggle" class="btn" style="font-size:12px;padding:4px 12px">${showRecap ? 'Hide' : '📊 My season so far'}</button></div>
      ${showRecap ? `<div style="margin-top:10px;font-size:13px;line-height:1.6">${rc.races ? `This season: <b>${rc.races}</b> race${rc.races === 1 ? '' : 's'}, <b>${rc.podiums}</b> podium${rc.podiums === 1 ? '' : 's'}, <b>${rc.wins}</b> win${rc.wins === 1 ? '' : 's'}${rc.best !== null ? `, best finish <b>#${rc.best}</b>` : ''}${rc.avg !== null ? `, average place <b>#${rc.avg}</b>` : ''}. ${rc.busiest ? `Busiest month: <b>${E(rc.busiest.month)}</b> (${rc.busiest.races}). ` : ''}${rc.streak >= 2 ? `Longest streak: <b>${rc.streak} weeks</b>.` : ''}` : 'No races yet this season. Your first one starts the story.'}</div>` : ''}</div>`;
    el.querySelectorAll('.goal-btn').forEach(b => b.addEventListener('click', () => { setGoal(Number(b.dataset.n)); render(); }));
    const t = document.getElementById('recap-toggle'); if (t) t.addEventListener('click', () => { showRecap = !showRecap; render(); });
  }
  window.Milestones = { render, stats, recap, BADGES };
})();
