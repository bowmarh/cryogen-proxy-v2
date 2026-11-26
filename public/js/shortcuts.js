'use strict';
// Keyboard shortcuts (the Gmail / GitHub / Linear idea): press ? for the list, "g" then a letter to go to a page, as in "g z" for ZRL. They only fire when you are
// not typing in a box and are signed in, and "g" waits a second and a half for the letter. They click the same menu buttons a mouse would, so a page that is not
// in your menu is simply not reachable by key either.
(function () {
  const MAP = { h: ['dashboard', 'Home'], w: ['week', 'This week'], z: ['zrl', 'ZRL'], r: ['racing', 'Racing'], t: ['ttt', 'TTT Week'], l: ['ladder', 'Ladder'], d: ['drs', 'DIRT Series'],
    e: ['events', 'Events & Sign-Up'], m: ['members', 'Members'], p: ['profile', 'My Profile'], s: ['season', 'My season'] };
  let armed = 0;
  const signedIn = () => !!(window.role || sessionStorage.getItem('role'));
  const typing = e => /^(input|textarea|select)$/i.test(e.target.tagName || '') || e.target.isContentEditable;
  const button = id => [...document.querySelectorAll('#main-nav button.navbtn, .tabbar button')].find(b => b.style.display !== 'none' && b.offsetParent !== null && new RegExp(`showTab\\('${id}'`).test(b.getAttribute('onclick') || ''));
  function go(key) {
    const m = MAP[key]; if (!m) return false;
    const b = button(m[0]); if (!b) return false;
    b.click(); return true;
  }
  function help() {
    const old = document.getElementById('kbd-help'); if (old) { old.remove(); return; }
    const rows = Object.entries(MAP).filter(([, m]) => button(m[0])).map(([k, m]) => `<div style="display:flex;justify-content:space-between;gap:16px;padding:3px 0"><span>${m[1]}</span><span><kbd>g</kbd> <kbd>${k}</kbd></span></div>`).join('');
    const d = document.createElement('div'); d.id = 'kbd-help'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', 'Keyboard shortcuts');
    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
    d.innerHTML = `<div style="background:var(--card-bg,#111827);color:inherit;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:18px 20px;max-width:340px;width:100%;font-size:13px">
      <div style="font-weight:800;margin-bottom:8px">⌨️ Keyboard shortcuts</div>
      <div style="display:flex;justify-content:space-between;padding:3px 0"><span>Find anything</span><span><kbd>/</kbd> or <kbd>Ctrl</kbd> <kbd>K</kbd></span></div>
      <div style="display:flex;justify-content:space-between;padding:3px 0"><span>This list</span><span><kbd>?</kbd></span></div>
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:#8b95a5;margin:10px 0 2px">Go to (press g, then…)</div>${rows}
      <button type="button" class="btn" style="margin-top:12px;width:100%" id="kbd-close">Close</button></div>`;
    d.addEventListener('click', e => { if (e.target === d || e.target.id === 'kbd-close') d.remove(); });
    document.body.appendChild(d); const c = document.getElementById('kbd-close'); if (c) c.focus();
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { const d = document.getElementById('kbd-help'); if (d) d.remove(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || typing(e) || !signedIn()) return;
    const login = document.getElementById('login-screen'); if (login && login.offsetParent !== null) return;
    if (e.key === '?') { e.preventDefault(); help(); return; }
    if (armed && Date.now() - armed < 1500) { armed = 0; if (go(e.key.toLowerCase())) e.preventDefault(); return; }
    armed = e.key === 'g' ? Date.now() : 0;
  });
  window.Shortcuts = { help, go, MAP };
})();
