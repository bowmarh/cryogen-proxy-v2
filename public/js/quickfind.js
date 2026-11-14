'use strict';
// Go to / quick find. Everyone: type a page name (events, ZRL, my details…) and jump there; with nothing typed it lists every page they can open. Staff can also type a name, a Zwift ID, a category, a tier or a status and jump to that rider's profile. It searches what the page already holds (the live club roster
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
  // Every page the signed-in person can see in the menu, so anyone can type "zrl" or "email" and jump there. Words in KEYWORDS are extra things people might type.
  const KEYWORDS = { dashboard: 'home start overview', week: 'this week upcoming plan', upgrade: 'join membership full become', profile: 'profile avatar my account', mydetails: 'details email password name phone settings', plan: 'plan training schedule', captain: 'team captain line-up lineup', coach: 'coach training advice ai', racing: 'results race leaderboard zwiftracing', zrl: 'zwift racing league teams availability', ttt: 'team time trial week', season: 'ttt season points table', ladder: 'ladder rankings', drs: 'dirt series', events: 'events sign up signup rsvp calendar', rides: 'social rides group ride', members: 'members riders roster list people', standard: 'fair play rules standards', comms: 'comms messages discord reminders', mail: 'email newsletter send message', studio: 'studio posts announcements', control: 'control room systems health errors', aidesk: 'ai assistant desk', clubstats: 'club health stats numbers', fair: 'fair play flags', inv: 'investigations cases', admin: 'admin settings passwords backup' };
  function pages() {
    const out = []; let group = '';
    for (const b of document.querySelectorAll('#main-nav > .navgroup, #main-nav > button.navbtn')) {
      if (b.classList.contains('navgroup')) { group = b.closest('#pinned-nav') ? '' : b.textContent.trim(); continue; }
      if (b.dataset.pin || b.style.display === 'none') continue;
      const m = /showTab\('([a-z]+)'/.exec(b.getAttribute('onclick') || ''); if (!m) continue;
      const label = [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').replace(/\s+/g, ' ').trim();
      out.push({ kind: 'page', id: m[1], label, group, words: norm(label + ' ' + (KEYWORDS[m[1]] || '')), el: b });
    }
    const ad = document.getElementById('nav-admin-btn'); if (ad && ad.style.display !== 'none') out.push({ kind: 'page', id: 'admin', label: '⚙️ Admin', group: 'Staff tools', words: norm('admin ' + KEYWORDS.admin), el: ad });
    return out;
  }
  const findPages = q => { const w = norm(q).split(/\s+/).filter(Boolean); return pages().filter(p => w.every(x => p.words.includes(x))); };
  function open() {
    close();
    const isStaff = staff();
    const d = document.createElement('div'); d.id = 'qf'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-modal', 'true'); d.setAttribute('aria-label', isStaff ? 'Go to a page or find a rider' : 'Go to a page');
    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,10,20,.8);display:flex;align-items:flex-start;justify-content:center;padding:12vh 12px 12px';
    d.innerHTML = `<div style="background:#0f172a;border:1px solid rgba(255,255,255,.14);border-radius:14px;padding:14px;max-width:520px;width:100%;color:#e5e7eb"><input id="qf-q" type="search" class="inp" autocomplete="off" placeholder="${isStaff ? 'Where to? A page, or a rider: name, Zwift ID…' : 'Where to? Type a page, e.g. events, ZRL, my details'}" aria-label="${isStaff ? 'Go to a page or find a rider' : 'Go to a page'}" style="font-size:15px"><div id="qf-r" role="listbox" aria-label="Matches" style="margin-top:8px;max-height:55vh;overflow:auto"></div><div id="qf-n" style="font-size:11px;color:#8b95a5;margin-top:6px">Enter opens the first match, Esc closes.${isStaff ? ` ${people().length} riders and members can be found too.` : ''}</div></div>`;
    document.body.appendChild(d); d.onclick = e => { if (e.target === d) close(); };
    const q = document.getElementById('qf-q'), out = document.getElementById('qf-r'); let hits = [];
    const go = h => { close(); if (h.kind === 'page') h.el.click(); else if (typeof openRider === 'function') openRider(String(h.p.id), ''); };
    const row = 'padding:8px 10px;border-radius:8px;cursor:pointer;display:flex;gap:10px;align-items:baseline;flex-wrap:wrap';
    const draw = () => {
      const t = q.value.trim(), pg = (t ? findPages(t) : pages()).map(p => ({ kind: 'page', ...p }));
      const rd = isStaff && t ? search(t).map(p => ({ kind: 'rider', p })) : [];
      hits = [...pg, ...rd];
      let lastGroup = null;
      out.innerHTML = hits.length ? hits.map((h, i) => h.kind === 'page'
        ? `${!t && h.group !== lastGroup && (lastGroup = h.group) !== null && h.group ? `<div style="font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9aa3b2;padding:10px 10px 2px">${E(h.group)}</div>` : ''}<div role="option" tabindex="0" data-i="${i}" style="${row}"><b>${E(h.label)}</b>${t ? '<span style="font-size:11px;color:#8b95a5">' + E(h.group || 'page') + '</span>' : ''}</div>`
        : `<div role="option" tabindex="0" data-i="${i}" style="${row}"><b>${E(h.p.name)}</b><span style="font-size:11px;color:#9ca3af">ID ${E(h.p.id)}</span><span style="font-size:11px;color:#8b95a5">${E(label(h.p))}</span></div>`).join('') : '<div style="padding:8px 10px;font-size:13px;color:#8b95a5">Nothing matches that. Try a shorter word.</div>';
    };
    q.addEventListener('input', draw); draw();
    out.addEventListener('click', e => { const r = e.target.closest('[data-i]'); if (r) go(hits[Number(r.dataset.i)]); });
    out.addEventListener('keydown', e => { if (e.key === 'Enter') { const r = e.target.closest('[data-i]'); if (r) go(hits[Number(r.dataset.i)]); } });
    q.addEventListener('keydown', e => { if (e.key === 'Enter' && hits[0]) go(hits[0]); if (e.key === 'ArrowDown') { const r = out.querySelector('[data-i]'); if (r) { e.preventDefault(); r.focus(); } } });
    q.focus();
  }
  function refresh() { const b = document.getElementById('find-btn'); if (b) b.style.display = (window.role || sessionStorage.getItem('role')) ? 'block' : 'none'; }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') return close();
    const typing = /^(input|textarea|select)$/i.test((e.target.tagName || '')) || e.target.isContentEditable;
    const signedIn = !!(window.role || sessionStorage.getItem('role')), login = document.getElementById('login-screen');
    if (signedIn && !(login && login.offsetParent !== null) && !typing && (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k'))) { e.preventDefault(); open(); }
  });
  window.QuickFind = { open, close, refresh, search, pages };
})();
