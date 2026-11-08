'use strict';
// Administrator only: the case log on the Investigations page. A short factual record of what was looked at and how it ended. No file contents or
// power data are ever stored here, and members never see it.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let data = null, msg = '';
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const btn = 'padding:5px 12px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';

  function html() {
    const d = data, opts = Object.entries(d.outcomes).map(([k, v]) => `<option value="${k}">${E(v)}</option>`).join('');
    const checks = Object.entries(d.indicators).map(([k, v]) => `<label style="font-size:12px;display:flex;gap:6px;align-items:center"><input type="checkbox" name="cl-ind" value="${k}"/> ${E(v)}</label>`).join('');
    const rows = d.entries.map(e => `<tr><td style="white-space:nowrap">${E(e.event_date)}</td><td>${E(e.event_name)}</td><td>${E(e.rider_name || '')} <span style="color:#8b95a5">(${E(e.zwift_id)})</span></td><td style="font-size:12px">${e.indicators.map(c => E(d.indicators[c] || c)).join('; ') || '-'}</td><td>${E(d.outcomes[e.outcome] || e.outcome)}${e.escalated ? ' · escalated' : ''}</td><td style="font-size:12px;max-width:260px">${E(e.note)}</td><td style="font-size:12px;white-space:nowrap">${E(e.created_by)}<br/>${E(e.created_at.slice(0, 10))}</td><td><button type="button" style="${btn};color:#f87171" onclick="caseLogDelete('${E(e.id)}')">Delete</button></td></tr>`).join('');
    return `<div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">Case log (administrators only)</div>
      <p style="font-size:12px;color:#8b95a5;margin:0 0 8px">Record evidence and outcome, not accusations. Only the Zwift ID, event, indicators, outcome and a short note are kept: never file contents or power data.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="cl-zid" class="inp" inputmode="numeric" placeholder="Zwift ID" style="width:130px"/><input id="cl-event" class="inp" placeholder="Event name" style="flex:1;min-width:180px"/><input id="cl-date" class="inp" type="date" style="width:160px"/>
        <select id="cl-outcome" class="inp" style="width:190px">${opts}</select></div>
      <div style="display:flex;gap:6px 18px;flex-wrap:wrap;margin:8px 0">${checks}</div>
      <label style="font-size:12px;display:flex;gap:6px;align-items:center;margin-bottom:6px"><input type="checkbox" id="cl-esc"/> Escalated</label>
      <textarea id="cl-note" class="inp" rows="2" maxlength="${d.maxNote}" placeholder="Short factual note (max ${d.maxNote} characters). Record evidence and outcome, not accusations."></textarea>
      <div style="margin-top:8px"><button type="button" class="btn-cyan" style="width:auto;padding:8px 18px;font-size:13px" onclick="caseLogAdd()">Add to log</button> <span id="cl-msg" role="status" style="font-size:12px;color:#8b95a5">${E(msg)}</span></div>
      ${d.entries.length ? `<div style="overflow-x:auto;margin-top:10px"><table><thead><tr><th>Event date</th><th>Event</th><th>Rider</th><th>Indicators</th><th>Outcome</th><th>Note</th><th>Logged</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p style="font-size:12px;color:#8b95a5;margin-top:10px">No entries yet.</p>'}
      <div style="margin-top:10px;font-size:12px;color:#8b95a5">Entries are deleted automatically after <input id="cl-ret" class="inp" type="number" min="1" max="120" value="${d.retentionMonths}" style="width:70px;display:inline-block"/> months. <button type="button" style="${btn}" onclick="caseLogRetention()">Save</button> <button type="button" style="${btn}" onclick="caseLogPurge()">Purge now</button></div></div>`;
  }
  async function mount(el) {
    if (!el || typeof role === 'undefined' || role !== 'admin') return;
    try { data = await api('/api/caselog'); el.innerHTML = html(); } catch (e) { el.innerHTML = `<div class="card" style="padding:12px 16px;margin-bottom:14px;color:#f87171">${E(e.message)}</div>`; }
  }
  const redraw = async (m) => { msg = m || ''; await mount(document.getElementById('caselog-box')); };
  window.caseLogAdd = async () => {
    const v = id => document.getElementById(id);
    try {
      await api('/api/caselog/add', { zwift_id: v('cl-zid').value, event_name: v('cl-event').value, event_date: v('cl-date').value, outcome: v('cl-outcome').value, escalated: v('cl-esc').checked, note: v('cl-note').value, indicators: [...document.querySelectorAll('input[name=cl-ind]:checked')].map(x => x.value) });
      await redraw('Added.');
    } catch (e) { v('cl-msg').style.color = '#f87171'; v('cl-msg').textContent = e.message; }
  };
  window.caseLogDelete = async id => { if (!confirm('Delete this log entry? This cannot be undone.')) return; try { await api('/api/caselog/delete', { id }); await redraw('Deleted.'); } catch (e) { alert(e.message); } };
  window.caseLogRetention = async () => { try { const r = await api('/api/caselog/settings', { retentionMonths: Number(document.getElementById('cl-ret').value) }); await redraw(`Saved. ${r.purged} old entr${r.purged === 1 ? 'y' : 'ies'} removed.`); } catch (e) { alert(e.message); } };
  window.caseLogPurge = async () => { if (!confirm('Delete every entry older than the retention period?')) return; try { const r = await api('/api/caselog/purge', {}); await redraw(`${r.purged} old entr${r.purged === 1 ? 'y' : 'ies'} removed.`); } catch (e) { alert(e.message); } };
  window.CaseLogUI = { mount };
})();
