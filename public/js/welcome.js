'use strict';
// The new-member "Get set up" screen. It covers the app until the club channels are done (Discord, the ZwiftPower team, the Facebook group), then shows
// every racing series with a button into each. The server decides who sees it; a signed-in member who is not new gets nothing here.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let v = null, busy = false;
  const hdr = () => { const h = { 'Content-Type': 'application/json' }, t = sessionStorage.getItem('token'); if (t) h.Authorization = 'Bearer ' + t; return h; };
  async function call(path, body) { const r = await fetch(path, body === undefined ? { headers: hdr() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) }), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Something went wrong.'); return j; }
  const box = () => document.getElementById('welcome-gate');
  function ensure() {
    let b = box(); if (b) return b;
    b = document.createElement('div'); b.id = 'welcome-gate'; b.setAttribute('role', 'dialog'); b.setAttribute('aria-modal', 'true'); b.setAttribute('aria-labelledby', 'welcome-title');
    b.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(6,10,20,.97);overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:24px 16px';
    document.body.appendChild(b); return b;
  }
  const stepCard = (s, i) => `<div class="card" style="padding:14px 16px;margin-bottom:10px;border:1px solid ${s.done ? 'rgba(52,211,153,.4)' : 'rgba(255,255,255,.12)'}"><div style="display:flex;gap:10px;align-items:flex-start"><div aria-hidden="true" style="font-size:20px">${s.done ? '✅' : (i + 1) + '️⃣'}</div><div style="flex:1"><div style="font-weight:800">${E(s.title)}</div><div style="font-size:12px;color:#9ca3af;margin:2px 0 8px">${E(s.why)}</div>${s.done ? (s.id === 'zwiftpower' ? `<div style="font-size:12px;color:#6ee7b7">${s.accepted ? 'You are in the team.' : 'Request noted. A volunteer will accept you on ZwiftPower, usually within a day.'}</div>` : '<div style="font-size:12px;color:#6ee7b7">Done</div>') : stepAction(s)}</div></div></div>`;
  function stepAction(s) {
    if (s.id === 'discord') return `<button type="button" class="btn-cyan" style="width:auto;padding:8px 18px" onclick="welcomeDiscord()">Connect Discord</button>${s.url ? ` <a href="${E(s.url)}" target="_blank" rel="noopener" style="font-size:12px;color:#22d3ee;margin-left:8px">New to our Discord? Join here first</a>` : ''}`;
    return `<a href="${E(s.url)}" target="_blank" rel="noopener" class="btn-cyan" style="display:inline-block;width:auto;padding:8px 18px;text-decoration:none">${E(s.action)} ↗</a> <button type="button" style="padding:8px 14px;background:rgba(255,255,255,.06);color:#e5e7eb;border:1px solid rgba(255,255,255,.2);border-radius:8px;margin-left:6px" onclick="welcomeConfirm('${E(s.id)}')">I have asked to join</button>`;
  }
  function draw() {
    if (!v || !v.show) { const b = box(); if (b) b.remove(); document.body.style.overflow = ''; return; }
    const b = ensure(); document.body.style.overflow = 'hidden';
    const left = v.steps.filter(s => !s.done).length;
    const inner = v.stage === 1
      ? `<h1 id="welcome-title" style="font-size:22px;font-weight:900;margin:0 0 4px">Welcome to Team CRYO-GEN${v.name ? ', ' + E(String(v.name).split(' ')[0]) : ''} 👋</h1><p style="font-size:13px;color:#9ca3af;margin:0 0 14px">Three quick things first, so you do not miss any of the club. ${left} to go.</p>${v.steps.map(stepCard).join('')}<div style="font-size:11px;color:#8b95a5;margin-top:10px">Stuck? Ask in the Discord welcome channel, or reply to your welcome email.</div>`
      : `<h1 id="welcome-title" style="font-size:22px;font-weight:900;margin:0 0 4px">You are in. Now, what would you like to race? 🏁</h1><p style="font-size:13px;color:#9ca3af;margin:0 0 14px">This is everything the club runs. Pick one to start: you can sign up for the others any time from the menu.</p>${v.series.map(x => `<div class="card" style="padding:14px 16px;margin-bottom:10px"><div style="font-weight:800">${E(x.title)}</div><div style="font-size:12px;color:#9ca3af;margin:2px 0 8px">${E(x.blurb)}</div><button type="button" class="btn-cyan" style="width:auto;padding:7px 16px" onclick="welcomeGo('${E(x.tab)}')">${E(x.cta)}</button></div>`).join('')}<div style="margin-top:12px"><button type="button" style="padding:8px 16px;background:rgba(255,255,255,.06);color:#e5e7eb;border:1px solid rgba(255,255,255,.2);border-radius:8px" onclick="welcomeFinish()">Take me to the dashboard</button></div>`;
    b.innerHTML = `<div style="width:100%;max-width:560px">${inner}<div style="margin-top:18px;font-size:11px"><a href="#" onclick="doLogout();return false" style="color:#8b95a5">Sign out</a></div></div>`;
  }
  async function refresh() { try { v = await call('/api/me/welcome'); } catch (e) { v = null; } draw(); }
  window.welcomeCheck = () => { if (typeof role !== 'undefined' && role === 'member') refresh(); };
  window.welcomeDiscord = () => { if (typeof dcConnect === 'function') dcConnect(); else alert('Open My profile and use the Discord section to link your account.'); };
  window.welcomeConfirm = async id => { if (busy) return; busy = true; try { v = await call('/api/me/welcome/confirm', { step: id }); } catch (e) { alert(e.message); } busy = false; draw(); };
  window.welcomeFinish = async () => { try { await call('/api/me/welcome/finish', {}); v = { show: false }; } catch (e) { alert(e.message); } draw(); };
  window.welcomeGo = async tab => { await window.welcomeFinish(); const btn = document.querySelector(`[onclick*="showTab('${tab}'"]`); if (btn && typeof showTab === 'function') showTab(tab, btn); };
  window.addEventListener('focus', () => { if (v && v.show) refresh(); });   // back from Discord or another tab: pick up what changed
})();
