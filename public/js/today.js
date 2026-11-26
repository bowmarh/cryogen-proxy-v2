'use strict';
// A "Today" strip above My week (the calendar-app idea): only what is on for this member today, in time order, each with where they stand on it. It reads the
// same data My week already loaded, so it costs no extra request, and it stays out of the way (empty) on a day with nothing on.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICON = { in: '✅', todo: '🟡', info: '⚪', out: '➖' }, LABEL = { in: "You're in", todo: 'Needs your answer', info: '', out: "You're out" };
  const zone = () => (typeof tzZone === 'function' ? tzZone() : undefined);
  const dayKey = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: zone() });
  function todayItems(items, now = Date.now()) {
    const today = dayKey(now);
    return (items || []).filter(u => (u.timed ? dayKey(u.atMs) : u.date) === today).sort((a, b) => (a.timed ? a.atMs : 0) - (b.timed ? b.atMs : 0));
  }
  function html(items, now = Date.now()) {
    const list = todayItems(items, now); if (!list.length) return '';
    const rows = list.map(u => {
      const when = u.timed ? new Date(u.atMs).toLocaleTimeString('en-GB', { timeZone: zone(), hour: '2-digit', minute: '2-digit' }) : 'All day', past = u.timed && u.atMs < now - 45 * 60000;
      return `<div style="display:flex;gap:10px;align-items:baseline;padding:4px 0;${past ? 'opacity:.5' : ''}"><span style="min-width:46px;font-variant-numeric:tabular-nums;color:#8b95a5;font-size:12px">${E(when)}</span><span aria-hidden="true">${ICON[u.state] || '⚪'}</span><span style="flex:1;font-size:13px"><b>${E(u.kind)}</b> ${E(u.title)}</span><span style="font-size:11px;color:${u.state === 'todo' ? '#FBBF24' : '#8b95a5'}">${E(LABEL[u.state] || '')}</span></div>`;
    }).join('');
    return `<div class="card" style="padding:12px 16px;margin-bottom:12px"><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--accent);margin-bottom:4px">☀️ Today</div>${rows}</div>`;
  }
  function render() {
    const el = document.getElementById('today-card'); if (!el) return;
    if ((window.role || sessionStorage.getItem('role')) !== 'member') { el.innerHTML = ''; return; }
    let items = null; try { items = typeof myWeek !== 'undefined' && myWeek ? myWeek.items : null; } catch (e) { /* not loaded yet */ }
    const h = html(items); if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; }
  }
  function start() {
    const src = document.getElementById('myweek-card'); if (!src) return;
    new MutationObserver(render).observe(src, { childList: true }); render(); setInterval(render, 60000);
  }
  window.addEventListener('load', () => setTimeout(start, 900));
  window.Today = { render, html, todayItems };
})();
