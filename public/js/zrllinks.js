'use strict';
// ZRL league links: buttons to the league's RacePass, results and standings pages at the top of the ZRL page. An administrator pastes the three links once
// (the club does not guess them: league addresses change each season). Everyone signed in sees the ones that are set.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hdr = () => (typeof tttHeaders === 'function' ? tttHeaders() : {});
  let links = null, editing = false, loading = false;
  async function load() {
    if (loading) return; loading = true;
    try { const r = await fetch('/api/zrl/links', { headers: hdr() }); if (r.ok) links = await r.json(); } catch (e) { /* the card just stays out */ }
    loading = false; draw();
  }
  const btn = (href, label) => `<a href="${E(href)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:8px 14px;border-radius:8px;border:1px solid rgba(var(--accent-rgb),.5);background:rgba(var(--accent-rgb),.1);color:var(--accent);font-weight:700;font-size:13px;text-decoration:none">${label} ↗</a>`;
  function draw() {
    const page = document.getElementById('page-zrl'); if (!page || !links) return;
    let box = document.getElementById('zrl-links');
    const any = links.racepass || links.results || links.standings;
    if (!any && !links.canEdit) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'zrl-links'; box.className = 'card'; box.style.cssText = 'padding:12px 16px;margin:0 0 12px'; const help = page.querySelector(':scope > .pagehelp'); help ? help.after(box) : page.prepend(box); }
    const field = (id, label, v) => `<label class="lbl" for="${id}" style="margin-top:6px">${label}</label><input id="${id}" class="inp" type="url" placeholder="https://…" value="${E(v)}" style="margin-bottom:4px">`;
    box.innerHTML = `<div style="font-weight:800;font-size:13px;margin-bottom:8px">🔗 League links</div>`
      + (editing
        ? `${field('zl-rp', 'RacePass link', links.racepass)}${field('zl-res', 'Results link', links.results)}${field('zl-st', 'League standings link', links.standings)}<div style="margin-top:8px;display:flex;gap:8px"><button type="button" class="btn-cyan" style="width:auto;padding:7px 16px" onclick="zrlLinksSave()">Save</button><button type="button" onclick="zrlLinksEdit(false)" style="padding:7px 14px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:none;color:#e5e7eb;cursor:pointer">Cancel</button></div><div id="zl-err" role="alert" style="color:#f87171;font-size:12px;margin-top:6px"></div>`
        : `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${links.racepass ? btn(links.racepass, '🎟️ RacePass') : ''}${links.results ? btn(links.results, '📊 Results') : ''}${links.standings ? btn(links.standings, '🏆 League standings') : ''}${any ? '' : '<span style="font-size:12px;color:#9aa3b2">No links yet. Add the league\'s RacePass, results and standings pages so everyone can open them from here.</span>'}${links.canEdit ? `<button type="button" onclick="zrlLinksEdit(true)" style="margin-left:auto;padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:none;color:#9ca3af;cursor:pointer;font-size:12px">✏️ ${any ? 'Edit links' : 'Add links'}</button>` : ''}</div>`);
  }
  window.zrlLinksEdit = on => { editing = on; draw(); };
  window.zrlLinksSave = async () => {
    const v = id => (document.getElementById(id) || {}).value || '', err = document.getElementById('zl-err');
    try {
      const r = await fetch('/api/zrl/links', { method: 'POST', headers: { ...hdr(), 'Content-Type': 'application/json' }, body: JSON.stringify({ racepass: v('zl-rp'), results: v('zl-res'), standings: v('zl-st') }) });
      const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Could not save.');
      links = d; editing = false; draw();
    } catch (e) { if (err) err.textContent = e.message; }
  };
  function start() {
    const m = document.getElementById('main'); if (!m) return;
    let was = false;
    const check = () => { const on = !!document.querySelector('#page-zrl.active'); if (on && !was) load(); was = on; };
    new MutationObserver(check).observe(m, { attributes: true, subtree: true, attributeFilter: ['class'] }); check();
  }
  window.addEventListener('load', () => setTimeout(start, 700));
  window.ZrlLinks = { load, draw };
})();
