'use strict';
// Administrator only: riders' requests to have their data erased. Preview shows what would go and what staff hold; Erase removes the personal stores.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const btn = 'padding:5px 12px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  const out = () => document.getElementById('privacy-out');
  async function mount(el) {
    if (!el || typeof role === 'undefined' || role !== 'admin') return;
    try {
      const d = await api('/api/staff/privacy');
      const rows = d.requests.map(r => `<tr><td>${E(r.name)} <span style="color:#8b95a5">(${E(r.zwid)})</span></td><td>${E((r.at || '').slice(0, 10))}</td><td>${E(r.status)}${r.doneBy ? ' · ' + E(r.doneBy) : ''}</td><td>${r.status === 'open' ? `<button type="button" style="${btn}" onclick="privacyPreview('${E(r.zwid)}')">Preview</button>` : ''}</td></tr>`).join('');
      el.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">Privacy requests (administrators only)</div>
        ${d.requests.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Rider</th><th>Asked</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p style="font-size:12px;color:#8b95a5;margin:4px 0">No requests.</p>'}
        <div id="privacy-out" role="status" style="margin-top:8px;font-size:12px;color:#d1d5db"></div></div>`;
    } catch (e) { el.innerHTML = `<div class="card" style="padding:12px 16px;margin-bottom:14px;color:#f87171">${E(e.message)}</div>`; }
  }
  window.privacyPreview = async zwid => {
    try {
      const d = await api('/api/staff/privacy/erase', { zwid, preview: true });
      out().innerHTML = `<b>Would erase:</b> ${d.removed.length ? d.removed.map(r => `${E(r.label)} (${r.count})`).join(', ') : 'nothing found'}.<br/>${d.staffHeld.length ? `<b>Staff hold, not erased:</b> ${d.staffHeld.map(r => `${E(r.label)} (${r.count})`).join(', ')}.<br/>` : ''}<span style="color:#8b95a5">${E(d.note)}</span><br/><button type="button" style="${btn};color:#f87171;margin-top:6px" onclick="privacyErase('${E(zwid)}')">Erase now</button>`;
    } catch (e) { out().textContent = e.message; }
  };
  window.privacyErase = async zwid => {
    if (!confirm('Erase this rider\'s personal records? This cannot be undone.')) return;
    try { const d = await api('/api/staff/privacy/erase', { zwid, preview: false }); out().textContent = `Erased ${d.removed.reduce((n, r) => n + r.count, 0)} entries from ${d.removed.length} stores.`; setTimeout(() => mount(document.getElementById('privacy-box')), 1200); }
    catch (e) { out().textContent = e.message; }
  };
  window.PrivacyUI = { mount };
})();
