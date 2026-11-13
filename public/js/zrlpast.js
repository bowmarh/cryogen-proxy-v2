'use strict';
// "Past rounds" under the ZRL page: the final table of every finished round, for any signed-in rider. Team level only; it loads when the card is opened.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let rounds = null, shown = null;
  const hdr = () => { const h = {}, t = sessionStorage.getItem('token'); if (t) h.Authorization = 'Bearer ' + t; return h; };
  async function get(path) { const r = await fetch(path, { headers: hdr() }), d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || 'Could not load.'); return d; }
  function draw() {
    const el = document.getElementById('zrl-past-body'); if (!el) return;
    if (!rounds) { el.textContent = 'Loading…'; return; }
    if (!rounds.length) { el.innerHTML = '<div style="font-size:13px;color:#8b95a5">No finished rounds are kept yet. When a round is archived it appears here.</div>'; return; }
    const table = shown ? `<div style="margin-top:10px"><b>${E(shown.name)}</b> <span style="font-size:12px;color:#9ca3af">${E(shown.start)} · ${shown.weeks} weeks</span>${(shown.standings.groups || []).map(g => `<div style="margin-top:8px"><div style="font-size:12px;color:#9ca3af">${E(g.name)}</div><table style="width:100%;font-size:13px;border-collapse:collapse"><thead><tr style="text-align:left;color:#9ca3af"><th scope="col" style="padding:3px 4px">#</th><th scope="col">Team</th><th scope="col" style="text-align:right">Points</th><th scope="col" style="text-align:right">Races</th></tr></thead><tbody>${g.teams.map(t => `<tr style="border-top:1px solid rgba(255,255,255,.06)"><td style="padding:4px">${t.rank}</td><td>${E(t.name)}</td><td style="text-align:right">${t.total}</td><td style="text-align:right">${t.races}</td></tr>`).join('')}</tbody></table></div>`).join('') || '<div style="font-size:13px;color:#8b95a5;margin-top:6px">No results were recorded for this round.</div>'}</div>` : '';
    el.innerHTML = `<label class="lbl" for="zrl-past-sel">Round</label><select id="zrl-past-sel" class="inp" style="max-width:320px" onchange="zrlPastShow(this.value)"><option value="">Choose a round…</option>${rounds.map(r => `<option value="${E(r.id)}" ${shown && shown.id === r.id ? 'selected' : ''}>${E(r.name)} (${E(r.start)})</option>`).join('')}</select>${table}`;
  }
  window.zrlPastShow = async id => { if (!id) { shown = null; draw(); return; } try { shown = await get('/api/zrl/past?id=' + encodeURIComponent(id)); } catch (e) { alert(e.message); } draw(); };
  function mount() {
    const root = document.getElementById('zrl-root'); if (!root || document.getElementById('zrl-past')) return;
    const d = document.createElement('details'); d.id = 'zrl-past'; d.className = 'card'; d.style.cssText = 'padding:12px 16px;margin-top:12px';
    d.innerHTML = '<summary style="cursor:pointer;font-weight:700">📚 Past rounds</summary><div id="zrl-past-body" style="margin-top:8px"></div>';
    d.addEventListener('toggle', async () => { if (!d.open || rounds) return; draw(); try { rounds = (await get('/api/zrl/past')).rounds; } catch (e) { rounds = []; } draw(); });
    root.insertAdjacentElement('afterend', d);
  }
  document.addEventListener('DOMContentLoaded', mount);
})();
