'use strict';
// Member cards on the dashboard: the first-race checklist for new members and the rider's own race recap (with a picture they can save, and a share
// button that posts to the club channel only when pressed).
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, post) {
    const r = await fetch(path, post ? { method: 'POST', headers: hdr(), body: '{}' } : { headers: tttHeaders() });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const btn = 'padding:6px 14px;font-size:12px;font-weight:700;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.06);color:#e5e7eb;cursor:pointer';
  let recap = null;

  // ── First-race checklist ──
  function onboardHtml(d) {
    const pct = Math.round(d.done / d.total * 100), next = d.steps.find(x => x.id === d.next);
    return `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div style="font-weight:800">🚦 Your first race: ${d.done} of ${d.total} done</div><div style="font-size:12px;color:#8b95a5">Welcome to CRYO-GEN!</div></div>
      <div style="height:6px;border-radius:3px;background:rgba(255,255,255,.08);margin:8px 0 10px" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div style="height:6px;border-radius:3px;width:${pct}%;background:var(--accent,#22d3ee)"></div></div>
      ${d.steps.map(s => `<div style="display:flex;gap:8px;align-items:flex-start;padding:3px 0;font-size:13px;opacity:${s.done ? .65 : 1}"><span aria-hidden="true">${s.done ? '✅' : '⬜'}</span><span>${E(s.label)}</span></div>`).join('')}
      ${next ? `<div style="margin-top:10px;padding:8px 10px;border-radius:8px;background:rgba(var(--accent-rgb,34,211,238),0.08);font-size:12px;color:#d1d5db"><b>Next:</b> ${E(next.label)}. ${E(next.hint)} ${next.ack ? `<button type="button" style="${btn};margin-left:6px" onclick="onboardAck()">I've read it</button>` : ''}${next.tab ? `<button type="button" style="${btn};margin-left:6px" onclick="showTab('${next.tab}',document.getElementById('nav-${next.tab}')||this)">Open</button>` : ''}</div>` : ''}</div>`;
  }
  async function loadOnboard() {
    const el = document.getElementById('onboard-card'); if (!el) return;
    try { const d = await api('/api/onboarding/me'); el.innerHTML = d.show ? onboardHtml(d) : ''; } catch (e) { el.innerHTML = ''; }
  }
  window.onboardAck = async () => { const el = document.getElementById('onboard-card'); try { const d = await api('/api/onboarding/ack', true); el.innerHTML = d.show ? onboardHtml(d) : ''; } catch (e) { alert(e.message); } };

  // ── Race recap ──
  function recapHtml(r) {
    return `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="font-weight:800;margin-bottom:4px">⭐ ${E(r.headline)}</div>
      ${r.lines.map(l => `<div style="font-size:13px;color:#d1d5db;padding:2px 0">${E(l)}</div>`).join('')}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><button type="button" style="${btn}" onclick="recapImage()">Save as picture</button><button type="button" style="${btn}" onclick="recapShare()">Share to the club channel</button><span id="recap-msg" role="status" style="font-size:12px;color:#8b95a5;align-self:center"></span></div>
      <div style="font-size:11px;color:#8b95a5;margin-top:6px">Only you see this unless you press share.</div></div>`;
  }
  async function loadRecap() {
    const el = document.getElementById('recap-card'); if (!el) return;
    try { recap = await api('/api/me/recap'); el.innerHTML = recap.empty ? '' : recapHtml(recap); } catch (e) { el.innerHTML = ''; }
  }
  window.recapImage = async () => {
    const m = document.getElementById('recap-msg');
    try {
      const b64 = await uiPostCardPng(recap.headline, recap.lines), a = document.createElement('a');
      a.href = 'data:image/png;base64,' + b64; a.download = 'cryogen-recap.png'; document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { m.textContent = e.message; }
  };
  window.recapShare = async () => {
    const m = document.getElementById('recap-msg'); m.textContent = 'Sharing…';
    try { await api('/api/me/recap/share', true); m.textContent = 'Shared. Nice one!'; } catch (e) { m.textContent = e.message; }
  };
  // ── Badges ──
  async function loadBadges() {
    const el = document.getElementById('badges-card'); if (!el) return;
    try {
      const d = await api('/api/me/badges');
      if (!d.earned.length && !d.next) { el.innerHTML = ''; return; }
      const chip = b => `<span title="${E(b.label)}" style="display:inline-flex;gap:6px;align-items:center;padding:4px 10px;margin:3px 4px 3px 0;border-radius:99px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);font-size:12px"><span aria-hidden="true">${b.icon}</span>${E(b.label)}</span>`;
      el.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="font-weight:800;margin-bottom:6px">🏅 Your badges (${d.earned.length})</div>${d.earned.map(chip).join('') || '<div style="font-size:12px;color:#8b95a5">None yet: your first race earns one.</div>'}${d.next ? `<div style="font-size:12px;color:#8b95a5;margin-top:6px">${E(d.next.text)}</div>` : ''}</div>`;
    } catch (e) { el.innerHTML = ''; }
  }
  // ── Captain's cockpit ──
  const names = (l, c) => (l && l.length ? `<span style="color:${c}">${l.map(E).join(', ')}</span>` : '<span style="color:#8b95a5">nobody</span>');
  function cockpitHtml(d) {
    return d.teams.map(t => {
      const n = t.next;
      if (!n) return `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="font-weight:800">🎖️ Captain's cockpit · ${E(t.name)}</div><div style="font-size:12px;color:#8b95a5;margin-top:4px">No race coming up.</div></div>`;
      return `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="font-weight:800">🎖️ Captain's cockpit · ${E(t.name)} · race ${n.week}, ${E(n.date)}</div>
        <div style="font-size:13px;line-height:1.7;margin-top:6px"><div>✅ Yes (${n.yes.length} of ${n.racing} needed): ${names(n.yes, '#34d399')}</div><div>🤔 Maybe: ${names(n.maybe, '#FBBF24')}</div><div>❌ No: ${names(n.no, '#f87171')}</div><div>⏳ Not answered: ${names(n.pending, '#e5e7eb')}</div>${n.inPen.length ? `<div>🏁 In the pen: ${names(n.inPen, '#22d3ee')}</div>` : ''}</div>
        ${n.lineupSet ? `<div style="font-size:12px;color:#8b95a5;margin-top:6px">Line-up set: ${n.lineup.map(E).join(', ')}</div>` : n.suggestion.length ? `<div style="font-size:12px;color:#d1d5db;margin-top:6px"><b>Suggested line-up</b> (yes first, then maybe, strongest vELO first): ${n.suggestion.map(E).join(', ')}${n.short ? `. Still ${n.short} short on yeses.` : ''}</div>` : ''}
        ${n.pending.length ? `<div style="margin-top:10px"><button type="button" style="${btn}" onclick="cockpitNudge('${E(t.id)}',${n.weekIndex},this)">Ask the ${n.pending.length} who haven't answered</button> <span class="cockpit-msg" role="status" style="font-size:12px;color:#8b95a5"></span></div>` : ''}</div>`;
    }).join('');
  }
  async function loadCockpit() {
    const el = document.getElementById('cockpit-card'); if (!el) return;
    try { const d = await api('/api/me/cockpit'); el.innerHTML = d.captain ? cockpitHtml(d) : ''; } catch (e) { el.innerHTML = ''; }
  }
  window.cockpitNudge = async (team, week, b) => {
    const m = b.parentElement.querySelector('.cockpit-msg'); m.textContent = 'Asking…'; b.disabled = true;
    try {
      const r = await fetch('/api/me/cockpit/nudge', { method: 'POST', headers: hdr(), body: JSON.stringify({ team, week }) }); const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); m.textContent = d.note;
    } catch (e) { m.textContent = e.message; b.disabled = false; }
  };
  window.MemberCards = { load: () => { loadOnboard(); loadRecap(); loadBadges(); loadCockpit(); } };
})();
