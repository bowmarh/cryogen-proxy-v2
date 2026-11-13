'use strict';
// Staff quick find: type a name, a Zwift ID, a category, a tier or a status and jump to that rider's profile. It searches what the page already holds (the live club roster
// with the cryogen.team member records merged in, plus members who are not on the roster), so nothing extra is sent anywhere. Open with the 🔎 button, "/" or Ctrl/Cmd+K.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s == null ? '' : s).toLowerCase();
  const staff = () => ['admin', 'mod'].includes(window.role || sessionStorage.getItem('role'));
  const people = () => [...(typeof riders !== 'undefined' ? riders : []), ...(typeof wpOnly !== 'undefined' ? wpOnly : [])];
  const label = p => [p.cat && `cat ${p.cat}`, p.tier === 'half' || p.tier === 'associate' ? 'associate' : 'full', p.status, p.noZwift ? 'not on the club roster' : '', p.cc && p.cc.toUpperCase()].filter(Boolean).join(' · ');

  function search(q, max = 30) {
    const words = norm(q).split(/\s+/).filter(Boolean); if (!words.length) return [];
    const scored = [];
    for (const p of people()) {
      const name = norm(p.name), id = String(p.id || ''), hay = `${name} ${id} ${norm(label(p))}`;
      if (!words.every(w => hay.includes(w))) continue;
      const first = words[0], score = id === first ? 0 : name === norm(q).trim() ? 1 : name.startsWith(first) ? 2 : id.startsWith(first) ? 3 : name.split(/\s+/).some(w => w.startsWith(first)) ? 4 : 5;
      scored.push([score, name, p]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, max).map(x => x[2]);
  }

  function close() { const d = document.getElementById('qf'); if (d) d.remove(); }
  function open() {
    if (!staff()) return; close();
    const d = document.createElement('div'); d.id = 'qf'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', 'Find a rider');
    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,10,20,.8);display:flex;align-items:flex-start;justify-content:center;padding:12vh 12px 12px';
    d.innerHTML = `<div style="background:#0f172a;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:14px;max-width:520px;width:100%;color:#e5e7eb"><input id="qf-q" type="search" class="inp" autocomplete="off" placeholder="Find a rider: name, Zwift ID, category, status…" aria-label="Find a rider" style="font-size:15px"><div id="qf-r" role="listbox" aria-label="Matches" style="margin-top:8px;max-height:55vh;overflow:auto"></div><div id="qf-n" style="font-size:11px;color:#8b95a5;margin-top:6px">${people().length} riders and members. Enter opens the first match, Esc closes.</div></div>`;
    document.body.appendChild(d); d.onclick = e => { if (e.target === d) close(); };
    const q = document.getElementById('qf-q'), out = document.getElementById('qf-r'); let hits = [];
    const go = p => { close(); if (typeof openRider === 'function') openRider(String(p.id), ''); };
    q.addEventListener('input', () => {
      hits = search(q.value);
      out.innerHTML = hits.length ? hits.map((p, i) => `<div role="option" tabindex="0" data-i="${i}" style="padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap"><b>${E(p.name)}</b><span style="font-size:11px;color:#9ca3af">ID ${E(p.id)}</span><span style="font-size:11px;color:#8b95a5">${E(label(p))}</span></div>`).join('') : q.value.trim() ? '<div style="padding:8px 10px;font-size:13px;color:#8b95a5">No rider matches that.</div>' : '';
    });
    out.addEventListener('click', e => { const r = e.target.closest('[data-i]'); if (r) go(hits[Number(r.dataset.i)]); });
    out.addEventListener('keydown', e => { if (e.key === 'Enter') { const r = e.target.closest('[data-i]'); if (r) go(hits[Number(r.dataset.i)]); } });
    q.addEventListener('keydown', e => { if (e.key === 'Enter' && hits[0]) go(hits[0]); if (e.key === 'ArrowDown') { const r = out.querySelector('[data-i]'); if (r) { e.preventDefault(); r.focus(); } } });
    q.focus();
  }
  function refresh() { const b = document.getElementById('find-btn'); if (b) b.style.display = staff() ? 'block' : 'none'; }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') return close();
    const typing = /^(input|textarea|select)$/i.test((e.target.tagName || '')) || e.target.isContentEditable;
    if (staff() && !typing && (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) { e.preventDefault(); open(); }
  });
  window.QuickFind = { open, close, refresh, search };
})();
