'use strict';
// Staff: Club health. Plain bars and plain sentences, built from the totals the app already holds. No names.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bar = (label, n, max, color) => `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:12px"><div style="width:190px;color:#d1d5db">${E(label)}</div><div style="flex:1;background:rgba(255,255,255,.06);border-radius:4px;height:14px"><div style="width:${max ? Math.round(n / max * 100) : 0}%;min-width:${n ? 3 : 0}px;height:14px;border-radius:4px;background:${color}"></div></div><div style="width:34px;text-align:right;font-weight:700">${n}</div></div>`;
  function html(d) {
    const a = d.activity, top = Math.max(1, ...a.buckets.map(b => b[1])), jmax = Math.max(1, ...d.joiners.map(j => j.n)), smax = Math.max(1, ...d.size.map(s => s.n));
    const colors = ['#34d399', '#86efac', '#FBBF24', '#FB923C', '#f87171'];
    return `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">📊 Club health</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:12px">Is the club growing, who is racing, and where it is leaking. Totals only: no names.</p>
      <div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">What the numbers say</div>${d.notes.length ? `<ul style="margin:6px 0 0 18px;font-size:13px;line-height:1.6;color:#e5e7eb">${d.notes.map(n => `<li>${E(n)}</li>`).join('')}</ul>` : '<div style="font-size:13px;color:#8b95a5">Not enough history yet.</div>'}</div>
      <div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">When members last raced (${a.total} members)</div>${a.buckets.map((b, i) => bar(b[0], b[1], top, colors[i])).join('')}</div>
      <div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">New members per month</div>${d.joiners.map(j => bar(j.month, j.n, jmax, 'var(--accent,#22d3ee)')).join('')}<div style="font-size:11px;color:#8b95a5;margin-top:6px">${E(d.joinersNote)}</div></div>
      ${d.size.length ? `<div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">Active riders, month by month</div>${d.size.map(s => bar(s.d.slice(0, 7) + (s.avg ? ` · avg vELO ${s.avg}` : ''), s.n, smax, '#a78bfa')).join('')}</div>` : ''}`;
  }
  // Browser errors reported by the pages (js/errors.js), most recent first.
  function brokenHtml(list) {
    const rows = list.map(e => `<tr><td style="font-size:12px;max-width:340px;word-break:break-word">${E(e.message)}<div style="color:#8b95a5">${E(e.file || '')}${e.line ? ':' + e.line : ''}</div></td><td>${e.count}</td><td style="font-size:12px">${E(Object.keys(e.browsers).join(', '))}</td><td style="font-size:12px">${E(Object.keys(e.pages).join(', '))}</td><td style="white-space:nowrap;font-size:12px">${E((e.last || '').slice(0, 16).replace('T', ' '))}</td>${role === 'admin' ? `<td><button type="button" style="padding:3px 8px;font-size:11px;border-radius:6px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#e5e7eb;cursor:pointer" onclick="clientErrClear('${E(e.sig)}')">Clear</button></td>` : '<td></td>'}</tr>`).join('');
    return `<div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">What broke (browser errors reported by the pages)</div>${list.length ? `<div style="overflow-x:auto"><table><thead><tr><th>Error</th><th>Times</th><th>Browsers</th><th>Page</th><th>Last seen</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p style="font-size:13px;color:#34d399;margin:4px 0">Nothing reported. 🎉</p>'}<div style="font-size:11px;color:#8b95a5;margin-top:6px">Nothing identifies the rider: no name, ID or address is kept.</div></div>`;
  }
  window.clientErrClear = async sig => { try { await fetch('/api/staff/client-errors/clear', { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sig }) }); load(); } catch (e) { alert(e.message); } };
  async function load() {
    const el = document.getElementById('clubstats-content'); if (!el) return;
    if (!el.innerHTML) el.innerHTML = '<div style="color:#8b95a5;padding:20px">Loading…</div>';
    try { const r = await fetch('/api/staff/clubstats', { headers: tttHeaders() }); const d = await r.json(); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); el.innerHTML = html(d); try { const er = await fetch('/api/staff/client-errors', { headers: tttHeaders() }); if (er.ok) el.insertAdjacentHTML('beforeend', brokenHtml((await er.json()).errors)); } catch (e) { /* the page still works without it */ } }
    catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; }
  }
  window.ClubStatsUI = { load };
})();
