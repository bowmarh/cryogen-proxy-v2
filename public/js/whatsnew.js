'use strict';
// "What's new": a small dismissible card shown once per release on each device, after sign-in. Add a note at the TOP of NOTES when something members or staff will notice ships;
// the id is the key that remembers it was seen. Nothing is sent anywhere.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const KEY = 'cg:whatsnew:seen';
  const NOTES = [
    { id: '2026-11-14', title: "What's new", all: ['Quicker sign-in: stay signed in with a passcode or Face ID / fingerprint.', 'Search boxes on most lists: type a name, a Zwift ID or a category.'],
      staff: ['Click a column heading to sort. Staff can also download any list as a spreadsheet file.', 'Type name:ann or score>20 in a list filter to filter one column.', 'Quick views on Members (for example Associates, Not on ZwiftPower). Saved views follow you between devices.'] },
  ];
  const staff = () => ['admin', 'mod'].includes(window.role || sessionStorage.getItem('role'));
  const seen = () => { try { return localStorage.getItem(KEY) || ''; } catch (e) { return NOTES[0].id; } };
  const mark = id => { try { localStorage.setItem(KEY, id); } catch (e) { /* not kept: it shows again next time */ } };
  function show() {
    const n = NOTES[0]; if (!n || seen() === n.id || document.getElementById('whatsnew')) return;
    const first = seen() === '';   // a brand-new device: remember the current note without showing it, so a new member is not greeted by a change list
    if (first) { mark(n.id); return; }
    const items = [...n.all, ...(staff() ? n.staff : [])];
    const host = document.querySelector('.page.active') || document.body;
    const d = document.createElement('div'); d.id = 'whatsnew'; d.setAttribute('role', 'status');
    d.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:60;max-width:440px;width:calc(100% - 32px);background:#0f1a2e;border:1px solid rgba(0,212,255,.35);border-radius:12px;padding:12px 14px;color:#e5e7eb;font-size:13px;box-shadow:0 8px 30px rgba(0,0,0,.5)';
    d.innerHTML = `<div style="display:flex;justify-content:space-between;gap:10px;align-items:center"><b>✨ ${E(n.title)}</b><button type="button" id="whatsnew-x" aria-label="Dismiss" style="background:none;border:0;color:#9ca3af;font-size:18px;cursor:pointer">×</button></div><ul style="margin:8px 0 0 18px;padding:0;line-height:1.5">${items.map(i => `<li>${E(i)}</li>`).join('')}</ul>`;
    (host === document.body ? host : document.body).appendChild(d);
    document.getElementById('whatsnew-x').onclick = () => { mark(n.id); d.remove(); };
  }
  window.WhatsNew = { show, NOTES };
  // Shown a few seconds after the app opens (the sign-in screen has gone by then).
  const tick = () => { const ls = document.getElementById('login-screen'); if (ls && ls.offsetParent !== null) return setTimeout(tick, 3000); show(); };
  window.addEventListener('load', () => setTimeout(tick, 4000));
})();
