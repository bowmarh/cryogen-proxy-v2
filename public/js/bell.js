'use strict';
// The notification bell: the latest club news (rosters out, results posted, a line from the staff), with a count of what is new since you last looked.
// "Read up to here" is kept in this browser only. It checks every few minutes while the page is open.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SEEN = 'cg:feed:seen', ICON = { ZRL: '🚀', Ladder: '🪜', DIRT: '🏜️', Club: '📣', News: '📰' };
  let items = [], canPost = false, btn = null, panel = null;
  const signedIn = () => !!(window.role || sessionStorage.getItem('role'));
  const seen = () => { try { return Number(localStorage.getItem(SEEN)) || 0; } catch (e) { return 0; } };
  const mark = () => { try { localStorage.setItem(SEEN, String(Date.now())); } catch (e) { /* not kept */ } };
  const unread = () => { const s = seen(); return s ? items.filter(i => i.ts > s).length : 0; };   // a brand-new device starts with nothing marked new
  const ago = ts => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : Math.round(m / 1440) + ' d ago'; };
  function ensureBtn() {
    if (btn && btn.isConnected) return btn;
    const find = document.getElementById('find-btn'); if (!find) return null;
    btn = document.createElement('button'); btn.type = 'button'; btn.id = 'bell-btn'; btn.setAttribute('aria-haspopup', 'dialog'); btn.setAttribute('aria-expanded', 'false');
    btn.style.cssText = 'position:relative;padding:5px 10px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:6px;color:#cbd5e1;font-size:13px;line-height:1;display:none;cursor:pointer';
    btn.onclick = toggle; find.before(btn); return btn;
  }
  function paintBtn() {
    const b = ensureBtn(); if (!b) return; b.style.display = signedIn() ? 'block' : 'none'; const n = unread();
    b.innerHTML = `🔔${n ? `<span style="position:absolute;top:-6px;right:-6px;min-width:16px;height:16px;border-radius:8px;background:#ef4444;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 3px">${n > 9 ? '9+' : n}</span>` : ''}`;
    b.setAttribute('aria-label', n ? `Notifications, ${n} new` : 'Notifications'); b.title = 'Latest club news';
  }
  let seq = 0;
  async function load() {
    if (!signedIn() || typeof tttHeaders !== 'function') return;
    const me = ++seq;   // only the newest answer counts: an older, slower one must not overwrite it
    try { const r = await fetch('/api/feed', { headers: tttHeaders() }); if (!r.ok) return; const d = await r.json(); if (me !== seq) return; items = d.items || []; canPost = !!d.canPost; if (!seen() && items.length === 0) { /* nothing yet */ } } catch (e) { return; }
    if (!seen()) mark();   // first visit on this device: everything already there counts as seen
    paintBtn(); if (panel) draw();
  }
  function close() { if (panel) { panel.remove(); panel = null; } if (btn) btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('keydown', onKey, true); document.removeEventListener('click', onDoc, true); }
  const onKey = e => { if (e.key === 'Escape') { close(); if (btn) btn.focus(); } };
  const onDoc = e => { if (!e.target.isConnected) return;   // the panel redrew under the click: not a click outside
    if (panel && !panel.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close(); };
  function draw() {
    if (!panel) return; const s = seen();
    // Nothing changed since the last drawing: leave the panel alone (redrawing under a click makes the click fizzle).
    const sig = JSON.stringify([items.map(i => i.id), s, canPost]); if (panel.dataset.sig === sig) return; panel.dataset.sig = sig;
    const typing = panel.querySelector('#bell-post'), typed = typing ? typing.value : '', hadFocus = typing && document.activeElement === typing;   // a refresh must not wipe a line being typed
    panel.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px"><b style="font-size:13px">Latest news</b><button type="button" id="bell-read" style="background:none;border:0;color:var(--accent);cursor:pointer;font-size:12px">Mark all as read</button></div>`
      + (items.length ? items.slice(0, 20).map(i => `<button type="button" data-tab="${E(i.tab)}" style="display:flex;gap:8px;align-items:flex-start;width:100%;text-align:left;background:${i.ts > s ? 'rgba(var(--accent-rgb),.08)' : 'none'};border:0;border-top:1px solid rgba(255,255,255,.06);padding:8px 4px;color:#e5e7eb;cursor:pointer;font-size:13px;line-height:1.4"><span aria-hidden="true">${ICON[i.kind] || '📣'}</span><span style="flex:1">${E(i.text)}<span style="display:block;font-size:11px;color:#8b95a5">${E(i.kind)} · ${ago(i.ts)}</span></span></button>`).join('') : '<div style="padding:10px 2px;font-size:13px;color:#9aa3b2">Nothing yet. News such as "rosters are out" and results will show here.</div>')
      + (canPost ? `<div style="margin-top:8px;border-top:1px solid rgba(255,255,255,.1);padding-top:8px"><label class="lbl" for="bell-post" style="font-size:11px">Post a line to everyone's bell</label><div style="display:flex;gap:6px"><input id="bell-post" class="inp" maxlength="180" placeholder="e.g. Roster for race 2 is up" style="flex:1"><button type="button" id="bell-send" class="btn-cyan" style="width:auto;padding:6px 14px">Post</button></div></div>` : '');
    panel.querySelector('#bell-read').onclick = () => { mark(); paintBtn(); draw(); };
    panel.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { const nb = [...document.querySelectorAll('#main-nav > button.navbtn')].find(x => !x.dataset.pin && new RegExp(`showTab\\('${b.dataset.tab}'`).test(x.getAttribute('onclick') || '')); close(); if (nb) nb.click(); });
    const again = panel.querySelector('#bell-post'); if (again && typed) { again.value = typed; if (hadFocus) again.focus(); }
    const send = panel.querySelector('#bell-send'); if (send) send.onclick = async () => {
      const inp = panel.querySelector('#bell-post'), text = inp.value.trim(); if (!text) return;
      try { const r = await fetch('/api/feed', { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not post.'); inp.value = ''; await load(); } catch (e) { alert(e.message); }
    };
  }
  function toggle() {
    if (panel) return close();
    panel = document.createElement('div'); panel.id = 'bell-panel'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'Latest club news');
    panel.style.cssText = 'position:fixed;top:60px;right:10px;z-index:9000;width:min(360px,calc(100vw - 20px));max-height:70vh;overflow:auto;background:#0f172a;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:10px 12px;box-shadow:0 10px 40px rgba(0,0,0,.6);color:#e5e7eb';
    document.body.appendChild(panel); btn.setAttribute('aria-expanded', 'true'); draw(); load();
    document.addEventListener('keydown', onKey, true); setTimeout(() => document.addEventListener('click', onDoc, true), 0);
  }
  // Every look costs the club's storage a few commands, so the bell checks sparingly: at start, every ten minutes while the page is on screen, when you come back to the
  // tab after at least five minutes away, and always when you open the panel.
  let lastLoad = 0;
  const loadOften = (minMs) => { if (!document.hidden && Date.now() - lastLoad >= minMs) { lastLoad = Date.now(); load(); } };
  function start() { paintBtn(); lastLoad = Date.now(); load(); setInterval(() => loadOften(540000), 600000); document.addEventListener('visibilitychange', () => loadOften(300000)); }
  window.addEventListener('load', () => setTimeout(start, 900));
  window.Bell = { load, paint: paintBtn, items: () => items };
})();
