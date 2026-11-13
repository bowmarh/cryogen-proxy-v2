'use strict';
// "Weeks I can't race": a rider ticks, once at the start of the round, the race weeks they cannot ride. The planner, line-up suggestions and the weekly
// availability asks treat those weeks as No, so they are not asked again each week. An answer given later for a week still wins.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let d = null, msg = '';
  const hdr = () => { const h = { 'Content-Type': 'application/json' }, t = sessionStorage.getItem('token'); if (t) h.Authorization = 'Bearer ' + t; return h; };
  async function call(path, body) { const r = await fetch(path, body === undefined ? { headers: hdr() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) }), j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Could not load.'); return j; }
  function draw() {
    const el = document.getElementById('myseason-body'); if (!el) return;
    if (!d) { el.textContent = msg || 'Loading…'; return; }
    if (!d.round) { el.innerHTML = '<div style="font-size:13px;color:#8b95a5">There is no ZRL round set up yet.</div>'; return; }
    const today = new Date().toISOString().slice(0, 10);
    el.innerHTML = `<div style="font-size:12px;color:#9ca3af;margin-bottom:6px">${E(d.round)}. Tick the weeks you cannot race and you will not be asked for them. You can still answer any week later.</div>${d.weeks.map(w => `<label style="display:block;font-size:13px;margin:3px 0"><input type="checkbox" class="mys" value="${w.i}" ${d.off.includes(w.i) ? 'checked' : ''} ${w.date < today ? 'disabled' : ''}/> Week ${w.i + 1} · ${E(w.date)}${w.date < today ? ' <span style="color:#8b95a5">(past)</span>' : ''}</label>`).join('')}<button type="button" class="btn-cyan" style="width:auto;padding:6px 16px;margin-top:8px" onclick="mySeasonSave()">Save</button>${msg ? `<div role="status" style="font-size:12px;margin-top:6px;color:#6ee7b7">${E(msg)}</div>` : ''}`;
  }
  window.mySeasonSave = async () => { const off = [...document.querySelectorAll('.mys')].filter(c => c.checked || c.disabled && d.off.includes(Number(c.value))).map(c => Number(c.value)); try { const r = await call('/api/me/weeksoff', { off }); d.off = r.off; msg = r.off.length ? `Saved: you are down as unavailable for ${r.off.length} week${r.off.length === 1 ? '' : 's'}.` : 'Saved: no weeks off.'; } catch (e) { msg = ''; alert(e.message); } draw(); };
  function mount() {
    const root = document.getElementById('zrl-root'); if (!root || document.getElementById('myseason')) return;
    const c = document.createElement('details'); c.id = 'myseason'; c.className = 'card'; c.style.cssText = 'padding:12px 16px;margin-top:12px';
    c.innerHTML = '<summary style="cursor:pointer;font-weight:700">📅 Weeks I can\'t race</summary><div id="myseason-body" style="margin-top:8px"></div>';
    c.addEventListener('toggle', async () => { if (!c.open) return; msg = ''; try { d = await call('/api/me/weeksoff'); } catch (e) { d = null; msg = 'Sign in with your cryogen.team account to use this.'; } draw(); });
    root.insertAdjacentElement('afterend', c);
  }
  document.addEventListener('DOMContentLoaded', mount);
})();
