'use strict';
// Riders: "Invite a friend". A personal link to the join page; how many people have asked to join through it.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  window.referralLoad = async () => {
    const page = document.getElementById('page-profile'); if (!page) return;
    try {
      const r = await fetch('/api/me/referral', { headers: tttHeaders() }); if (!r.ok) return; const d = await r.json();
      let el = document.getElementById('referral-card'); if (!el) { el = document.createElement('div'); el.id = 'referral-card'; el.className = 'card'; el.style.cssText = 'padding:14px 16px;margin-top:16px'; page.appendChild(el); }
      el.innerHTML = `<div style="font-weight:800;margin-bottom:6px">🤝 Invite a friend</div><div style="font-size:12px;color:#9ca3af;margin-bottom:6px">Share your own link. People who ask to join through it are counted for you.</div><input class="inp" readonly aria-label="Your invitation link" value="${E(d.link)}" style="width:100%" onfocus="this.select()"/><div style="margin-top:6px;display:flex;gap:8px;align-items:center"><button type="button" class="btn-cyan" style="width:auto;padding:5px 14px;font-size:12px" onclick="referralCopy('${E(d.link)}')">Copy link</button><span style="font-size:12px;color:#9ca3af">${d.requests} asked to join · ${d.welcomed} welcomed</span></div>`;
    } catch (e) { /* not available */ }
  };
  window.referralCopy = async l => { try { await navigator.clipboard.writeText(l); alert('Link copied.'); } catch (e) { prompt('Copy your link:', l); } };
})();
