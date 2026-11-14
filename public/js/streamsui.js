'use strict';
// "Who's streaming": riders who stream their races add one link, and the ZRL page lists them grouped by team so anyone can watch. A rider can remove theirs any time.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hdr = () => (typeof tttHeaders === 'function' ? tttHeaders() : {});
  let d = null, loading = false, msg = '';
  async function load() {
    if (loading) return; loading = true;
    try { const r = await fetch('/api/streams', { headers: hdr() }); if (r.ok) d = await r.json(); } catch (e) { /* the card stays out */ }
    loading = false; draw();
  }
  const link = s => `<a href="${E(s.url)}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);font-weight:600;text-decoration:none">${E(s.name)}</a> <span style="font-size:11px;color:#8b95a5">${E(s.platform)} ↗</span>`;
  function draw() {
    const page = document.getElementById('page-zrl'); if (!page || !d) return;
    let box = document.getElementById('zrl-streams');
    if (!d.streams.length && !d.canAdd) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'zrl-streams'; box.className = 'card'; box.style.cssText = 'padding:12px 16px;margin:0 0 12px'; const prev = document.getElementById('zrl-links') || page.querySelector(':scope > .pagehelp'); prev ? prev.after(box) : page.prepend(box); }
    const groups = {}; for (const s of d.streams) { const ts = s.teams.length ? s.teams : ['Other riders']; for (const t of ts) (groups[t] = groups[t] || []).push(s); }
    const names = Object.keys(groups).sort((a, b) => (a === 'Other riders') - (b === 'Other riders') || a.localeCompare(b));
    const mine = d.mine;
    box.innerHTML = `<div style="font-weight:800;font-size:13px;margin-bottom:6px">📺 Who's streaming</div>`
      + (names.length ? names.map(t => `<div style="margin:6px 0;font-size:13px"><span style="font-size:11px;font-weight:700;text-transform:uppercase;color:#8b95a5">${E(t)}</span><div style="display:flex;gap:6px 16px;flex-wrap:wrap;margin-top:2px">${groups[t].map(link).join('')}</div></div>`).join('') : '<div style="font-size:12px;color:#9aa3b2">Nobody has added a stream yet.</div>')
      + (d.canAdd ? `<div style="margin-top:10px;border-top:1px solid rgba(255,255,255,.08);padding-top:8px"><label class="lbl" for="st-url" style="font-size:11px">${mine ? 'Your stream' : 'Stream your races? Add your link'} (Twitch, YouTube, Kick or Facebook)</label><div style="display:flex;gap:6px;flex-wrap:wrap"><input id="st-url" class="inp" type="url" placeholder="https://twitch.tv/yourname" value="${E(mine ? mine.url : '')}" style="flex:1;min-width:200px"><button type="button" class="btn-cyan" style="width:auto;padding:6px 14px" onclick="streamSave()">Save</button>${mine ? '<button type="button" onclick="streamRemove()" style="padding:6px 12px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:none;color:#9ca3af;cursor:pointer">Remove</button>' : ''}</div><div id="st-msg" role="status" style="font-size:12px;margin-top:4px;color:#9aa3b2">${E(msg)}</div></div>` : '');
  }
  async function post(url) {
    try { const r = await fetch('/api/me/stream', { method: 'POST', headers: { ...hdr(), 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Could not save.'); msg = url ? 'Saved.' : 'Removed.'; await load(); } catch (e) { msg = e.message; draw(); }
  }
  window.streamSave = () => post((document.getElementById('st-url') || {}).value || '');
  window.streamRemove = () => post('');
  function start() {
    const m = document.getElementById('main'); if (!m) return; let was = false;
    const check = () => { const on = !!document.querySelector('#page-zrl.active'); if (on && !was) load(); was = on; };
    new MutationObserver(check).observe(m, { attributes: true, subtree: true, attributeFilter: ['class'] }); check();
  }
  window.addEventListener('load', () => setTimeout(start, 800));
  window.Streams = { load, draw };
})();
