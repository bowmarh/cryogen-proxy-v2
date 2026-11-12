'use strict';
// A "Something wrong?" button for everyone who is signed in. It sends what was typed, the page the person was on and the last script error (if any).
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let lastError = '';
  window.addEventListener('error', e => { lastError = String(e.message || '').slice(0, 200); });
  window.addEventListener('unhandledrejection', e => { lastError = String((e.reason && e.reason.message) || e.reason || '').slice(0, 200); });
  function signedIn() { try { return !!sessionStorage.getItem('token'); } catch (e) { return false; } }
  function currentPage() { const p = document.querySelector('.page.active'); return p ? p.id.replace(/^page-/, '') : ''; }
  function ensure() {
    if (!signedIn() || document.getElementById('fb-btn')) return;
    const b = document.createElement('button'); b.id = 'fb-btn'; b.type = 'button'; b.textContent = '💬 Something wrong?';
    b.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:50;padding:8px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.25);background:#0f1623;color:#e5e7eb;font-size:12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.4)';
    b.onclick = open; document.body.appendChild(b);
  }
  function open() {
    if (document.getElementById('fb-modal')) return;
    const m = document.createElement('div'); m.id = 'fb-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Send feedback');
    m.style.cssText = 'position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
    m.innerHTML = `<div style="background:#0f1623;border:1px solid rgba(255,255,255,.15);border-radius:12px;padding:18px;max-width:440px;width:100%;color:#e5e7eb"><div style="font-weight:800;margin-bottom:6px">💬 Something wrong, or an idea?</div><div style="font-size:12px;color:#9ca3af;margin-bottom:8px">Tell us what happened or what you would like. We see the page you are on${lastError ? ' and the last error' : ''}.</div><textarea id="fb-text" class="inp" rows="5" maxlength="1000" style="width:100%;font-family:inherit" aria-label="What happened"></textarea><div id="fb-msg" role="status" style="font-size:13px;margin-top:6px"></div><div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px"><button type="button" id="fb-cancel" style="padding:6px 14px;border-radius:6px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#e5e7eb;cursor:pointer">Cancel</button><button type="button" id="fb-send" class="btn-cyan" style="width:auto;padding:6px 18px">Send</button></div></div>`;
    document.body.appendChild(m); const t = document.getElementById('fb-text'); t.focus();
    const close = () => m.remove(); document.getElementById('fb-cancel').onclick = close; m.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    document.getElementById('fb-send').onclick = async () => {
      const msg = document.getElementById('fb-msg'); msg.style.color = '#9ca3af'; msg.textContent = 'Sending…';
      try {
        const r = await fetch('/api/feedback', { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t.value, page: currentPage(), error: lastError }) });
        const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
        msg.style.color = '#6ee7b7'; msg.textContent = 'Thank you! We have it.'; setTimeout(close, 1200);
      } catch (e) { msg.style.color = '#fca5a5'; msg.textContent = e.message; }
    };
  }
  setInterval(ensure, 2000); ensure();
})();
