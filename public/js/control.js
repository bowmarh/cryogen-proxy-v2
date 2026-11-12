'use strict';
// Staff: the control room. Race day at a glance (per team: answers, line-up, result), the radio's recent posts, whether every system is healthy,
// and the queue of join requests. It refreshes itself every 30 seconds while it is on screen.
(function () {
  let data = null, view = 'now', joins = null, busy = false, timer = null, note = '';
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const root = () => document.getElementById('control-content');
  const isAdmin = () => typeof role !== 'undefined' && role === 'admin';
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const col = l => ({ bad: '#fca5a5', warn: '#fcd34d', ok: '#6ee7b7', off: '#9ca3af' }[l] || '#9ca3af');
  const dot = l => ({ bad: '🔴', warn: '🟡', ok: '🟢', off: '⚪' }[l] || '⚪');
  async function load(quiet) {
    const el = root(); if (!el) return;
    try { data = await api('/api/control'); if (view === 'join') joins = (await api('/api/join')).requests; } catch (e) { if (!quiet) el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; return; }
    render();
  }
  function nowView() {
    const r = data.race, bad = data.systems.filter(s => s.level === 'bad' || s.level === 'warn');
    const attention = bad.length ? `<div class="card" style="padding:12px 16px;margin-bottom:10px;border-left:3px solid #f59e0b"><b>Needs attention</b>${bad.map(s => `<div style="font-size:13px;margin-top:4px">${dot(s.level)} <b>${E(s.name)}</b>: ${E(s.detail)}</div>`).join('')}</div>` : '<div class="card" style="padding:12px 16px;margin-bottom:10px;border-left:3px solid #10b981">🟢 Everything is healthy.</div>';
    const teams = !r || !r.round ? '<div class="card" style="padding:14px 16px">No ZRL round is running.</div>' : `<div class="card" style="padding:12px 14px;overflow:auto"><b>${E(r.round)} · race ${r.week + 1} · ${E(r.date)}</b> <span style="font-size:12px;color:#9ca3af">(${r.racing} race per team)</span>
      <table style="width:100%;font-size:13px;margin-top:8px"><thead><tr style="text-align:left;color:#8b95a5"><th>Team</th><th>Yes</th><th>Maybe</th><th>No</th><th>Line-up</th><th>Result</th></tr></thead><tbody>${r.teams.map(t => `<tr><td style="padding:4px 0">${E(t.name)}</td><td>${t.yes}</td><td>${t.maybe}</td><td>${t.no}</td><td style="color:${t.short ? '#fcd34d' : '#6ee7b7'}">${t.picked}/${r.racing}${t.short ? ` (${t.short} short)` : ' ✓'}</td><td>${t.result ? `${t.result.pos ? E(t.result.pos) + (['st', 'nd', 'rd'][t.result.pos - 1] || 'th') : 'in'}${t.result.pts !== null ? ` · ${E(t.result.pts)} pts` : ''}` : '<span style="color:#8b95a5">waiting</span>'}</td></tr>`).join('')}</tbody></table></div>`;
    const feed = `<div class="card" style="padding:12px 16px;margin-top:10px"><b>📻 Radio</b>${data.feed.length ? data.feed.map(f => `<div style="font-size:13px;margin-top:6px">${E(f.text)}</div>`).join('') : '<div style="font-size:12px;color:#8b95a5;margin-top:4px">Nothing posted yet. Switch the radio on in AI desk → Radio &amp; reports.</div>'}</div>`;
    const sys = `<div class="card" style="padding:12px 16px;margin-top:10px"><b>Systems</b>${data.systems.map(s => `<div style="font-size:13px;margin-top:4px">${dot(s.level)} <b>${E(s.name)}</b> <span style="color:${col(s.level)}">${E(s.detail)}</span></div>`).join('')}</div>`;
    return attention + teams + feed + sys;
  }
  function joinView() {
    if (!joins) return '<div class="card" style="padding:14px 16px">Loading…</div>';
    const rows = joins.map(j => `<div style="padding:8px 0;border-top:1px solid rgba(255,255,255,.06);font-size:13px"><div><b>${E(j.name)}</b> · ${E(j.email)}${j.zwid ? ` · Zwift ID ${E(j.zwid)}` : ''} · <span style="color:#8b95a5">${E((j.at || '').slice(0, 10))}</span> · <b style="color:${j.status === 'open' ? '#fcd34d' : '#9ca3af'}">${E(j.status)}</b></div>${j.note ? `<div style="color:#d1d5db">${E(j.note)}</div>` : ''}${j.status === 'open' && isAdmin() ? `<div style="margin-top:4px"><button type="button" class="btn-cyan" style="width:auto;padding:5px 14px;font-size:12px" onclick="controlDecide('${E(j.id)}','welcome')">Send welcome email</button> <button type="button" style="${btn}" onclick="controlDecide('${E(j.id)}','decline')">Decline</button></div>` : ''}</div>`).join('');
    return `<div class="card" style="padding:14px 16px"><b>Join requests</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 6px">From the public page <b>/join.html</b>. Sending the welcome email does not create an account: add them in WordPress too.</div>${rows || '<div style="font-size:13px;color:#8b95a5">No requests yet.</div>'}</div>`;
  }
  function render() {
    const el = root(); if (!el || !data) return;
    const tab = (k, l) => `<button type="button" role="tab" aria-selected="${view === k}" style="${btn};${view === k ? 'border-color:var(--accent,#22d3ee);color:#fff' : ''}" onclick="controlView('${k}')">${l}</button>`;
    el.innerHTML = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">🛰️ Control room</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:6px">Race day and system health in one place. Updated ${E((data.generated || '').slice(11, 19))} UTC.</p><div role="tablist" style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">${tab('now', '🏁 Now')}${tab('join', `🙋 Join requests${data.joinOpen ? ' (' + data.joinOpen + ')' : ''}`)}</div><button type="button" style="${btn}" onclick="controlLoad()">↻ Refresh</button>${note}${view === 'join' ? joinView() : nowView()}`;
  }
  window.controlLoad = async () => { await load(false); clearInterval(timer); timer = setInterval(() => { const p = document.getElementById('page-control'); if (p && p.classList.contains('active')) load(true); else { clearInterval(timer); timer = null; } }, 30000); };
  window.controlView = async v => { view = v; note = ''; if (v === 'join') { try { joins = (await api('/api/join')).requests; } catch (e) { note = `<div style="color:#fca5a5;font-size:13px">${E(e.message)}</div>`; } } render(); };
  window.controlDecide = async (id, action) => { if (action === 'welcome' && !confirm('Send the welcome email?')) return; try { await api('/api/join/decide', { id, action }); joins = (await api('/api/join')).requests; data = await api('/api/control'); note = '<div role="status" style="margin:8px 0;padding:8px 12px;border-radius:8px;font-size:13px;background:rgba(52,211,153,.12);color:#6ee7b7">Done.</div>'; } catch (e) { note = `<div role="status" style="margin:8px 0;padding:8px 12px;border-radius:8px;font-size:13px;background:rgba(248,113,113,.12);color:#fca5a5">${E(e.message)}</div>`; } render(); };
})();
