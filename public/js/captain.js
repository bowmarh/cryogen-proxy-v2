'use strict';
// Captains: "My team". Availability and line-up for the next race for the teams this rider captains, with one-tap actions.
(function () {
  let data = null, busy = false, note = '', sug = null;
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const root = () => document.getElementById('captain-content');
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const ans = a => ({ yes: '✅ yes', maybe: '🤔 maybe', no: '❌ no' }[a] || '⚪ not yet');
  const say = (m, bad) => { note = m ? `<div role="status" style="margin:8px 0;padding:8px 12px;border-radius:8px;font-size:13px;background:${bad ? 'rgba(248,113,113,.12);color:#fca5a5' : 'rgba(52,211,153,.12);color:#6ee7b7'}">${E(m)}</div>` : ''; };
  async function load() {
    const el = root(); if (!el) return;
    try { data = await api('/api/captain'); } catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; return; }
    render();
  }
  function render() {
    const el = root(); if (!el || !data) return;
    if (!data.captain) { el.innerHTML = '<h2 style="font-size:20px;font-weight:900">🧢 My team</h2><div class="card" style="padding:14px 16px">You are not the captain of a ZRL team right now.</div>'; return; }
    el.innerHTML = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">🧢 My team</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:8px">${E(data.round)}: your team's availability and line-up for the next race.</p>${note}` + data.teams.map(t => `<div class="card" style="padding:14px 16px;margin-bottom:12px"><b>${E(t.name)}</b> <span style="font-size:12px;color:#9ca3af">race ${t.week + 1} · ${E(t.date)} · ${t.racing} race</span>
      <div style="font-size:13px;margin:6px 0">${t.yes} yes · ${t.maybe} maybe · ${t.no} no · ${t.none} not answered · line-up ${t.picked}/${t.racing}${t.result ? ` · result: ${t.result.pos ? E(t.result.pos) + (['st', 'nd', 'rd'][t.result.pos - 1] || 'th') : 'in'}${t.result.pts !== null ? ', ' + E(t.result.pts) + ' pts' : ''}` : ''}</div>
      <table style="width:100%;font-size:13px"><tbody>${t.riders.map(r => `<tr><td style="padding:3px 0">${E(r.name)}</td><td>${ans(r.answer)}</td><td>${r.picked ? '🏁 in the line-up' : ''}</td></tr>`).join('')}</tbody></table>
      <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="captainAsk('${E(t.id)}',${t.week})">Ask the unanswered on Discord</button><button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="captainSuggest('${E(t.id)}',${t.week})">Suggest a line-up</button></div>
      ${sug && sug.id === t.id ? `<div style="margin-top:8px;padding:10px 12px;border-radius:8px;background:rgba(255,255,255,.04)"><b>Proposed line-up</b><ol style="margin:6px 0 6px 18px;font-size:13px">${sug.picks.map(p => `<li>${E(p.name)} <span style="color:#9ca3af">· ${E(p.why)}</span></li>`).join('')}</ol><button type="button" class="btn-cyan" style="width:auto;padding:5px 14px;font-size:12px" onclick="captainApply()">Set this line-up</button></div>` : ''}</div>`).join('');
  }
  window.captainLoad = load;
  window.captainAsk = async (id, week) => { busy = true; render(); try { const r = await api('/api/captain/ask', { team: id, week }); say(`Asked ${r.reached} rider${r.reached === 1 ? '' : 's'}; ${r.answered} had already answered.${r.unreachable.length ? ' Not reachable on Discord: ' + r.unreachable.join(', ') + '.' : ''}`); } catch (e) { say(e.message, true); } busy = false; render(); };
  window.captainSuggest = async (id, week) => { busy = true; render(); try { sug = await api('/api/captain/suggest', { team: id, week }); sug.id = id; say(''); } catch (e) { say(e.message, true); } busy = false; render(); };
  window.captainApply = async () => { if (!sug) return; try { await api('/api/zrl/lineup', { team: sug.id, week: sug.week, zwids: sug.picks.map(p => p.zwid) }); sug = null; data = await api('/api/captain'); say('Line-up set.'); } catch (e) { say(e.message, true); } render(); };
  // Shows the menu button only to captains.
  window.captainInit = async () => { try { const d = await api('/api/captain'); const b = document.getElementById('nav-captain'); if (b && d.captain) b.style.display = 'flex'; } catch (e) { /* not a rider session */ } };
})();
