'use strict';
// Staff: investigation files. A FIT file is read here in the browser (js/fit.js) and only the recorded numbers are sent; the server describes what
// stands out and what could innocently explain it. Everything on this page is a prompt for a person, not a verdict.
(function () {
  let list = null, cur = null, aiOn = false, busy = '';
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const SEV = { 1: ['Low', '#FBBF24'], 2: ['Medium', '#FB923C'], 3: ['High', '#f87171'] };
  const btn = 'padding:5px 12px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  const root = () => document.getElementById('inv-content');
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const badge = n => n ? `<span class="badge" style="background:${SEV[n][1]}22;color:${SEV[n][1]};border:1px solid ${SEV[n][1]}55">${SEV[n][0]}</span>` : '<span class="badge" style="background:rgba(16,185,129,.15);color:#34d399">Nothing stood out</span>';

  async function load() {
    const el = root(); if (!el) return;
    try { const d = await api('/api/inv'); list = d.cases; aiOn = d.aiOn; if (cur) { const c = await api('/api/inv/case?id=' + encodeURIComponent(cur.id)); cur = c.case; } render(); }
    catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; }
  }

  function render() {
    const el = root(); if (!el) return;
    el.innerHTML = cur ? caseView(cur) : listView();
  }

  function listView() {
    const names = (typeof riders !== 'undefined' ? riders : []).filter(r => r.active).map(r => `<option value="${E(r.name)} (${E(r.id)})"></option>`).join('');
    const rows = (list || []).map(c => `<tr style="cursor:pointer;opacity:${c.status === 'open' ? 1 : .6}" onclick="invOpen('${E(c.id)}')"><td><b>${E(c.title)}</b></td><td>${E(c.name)}</td><td>${E(c.files)} file${c.files === 1 ? '' : 's'}</td><td>${badge(c.top)}</td><td>${E(c.status)}${c.ai ? ' · AI summary' : ''}</td><td style="white-space:nowrap">${E((c.updatedAt || '').slice(0, 10))}</td></tr>`).join('');
    return `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">🕵️ Investigations</h2>
      <p style="font-size:13px;color:#8b95a5;margin-bottom:12px">Open a file on a rider, add their FIT files and notes, and see what stands out and what could explain it.</p>
      <div class="card" style="padding:12px 16px;margin-bottom:14px;font-size:13px;color:#d1d5db">These are <b>prompts for a person to look</b>, not findings. Only staff see this page. The FIT file is read in your browser and only the recorded numbers are kept (no map, no locations, no file). Nothing is sent to the rider. The optional AI summary gets the numbers and your notes, never the rider's name.</div>
      <div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">New investigation</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><input id="inv-rider" list="inv-riders" class="inp" placeholder="Rider (type a name)" style="flex:1;min-width:200px"/><datalist id="inv-riders">${names}</datalist>
        <input id="inv-title" class="inp" placeholder="Title (e.g. Flat watts, round 3)" style="flex:1;min-width:200px"/></div>
        <textarea id="inv-notes" class="inp" rows="3" placeholder="Why this was opened, what was reported, what you already know" style="margin-top:8px"></textarea>
        <div style="margin-top:8px"><button type="button" class="btn-cyan" style="width:auto;padding:8px 18px;font-size:13px" onclick="invCreate()">Open the file</button> <span id="inv-msg" role="status" style="font-size:12px;color:#8b95a5"></span></div></div>
      ${(list || []).length ? `<div class="card" style="overflow-x:auto"><table><thead><tr><th>Case</th><th>Rider</th><th>Files</th><th>Strongest finding</th><th>Status</th><th>Updated</th></tr></thead><tbody>${rows}</tbody></table></div>` : (window.uiEmpty ? uiEmpty('🗂️', 'No investigations open', 'Start one above, or from a Fair play item.', '', '') : 'No cases yet.')}`;
  }

  function chart(series, flat) {
    const W = 640, H = 130, n = series.p.length; if (n < 2) return '';
    const pv = series.p.filter(v => v !== null), hv = series.hr.filter(v => v !== null), pmax = Math.max(...pv, 100), hmin = hv.length ? Math.min(...hv) : 0, hmax = hv.length ? Math.max(...hv, hmin + 20) : 1;
    const path = (arr, f) => arr.map((v, i) => v === null ? null : [Math.round(i / (n - 1) * W), Math.round(f(v))]).filter(Boolean).map((q, i) => (i ? 'L' : 'M') + q[0] + ' ' + q[1]).join(' ');
    const band = flat && flat.longestSeconds >= 30 ? `<rect x="${Math.round(flat.at / 10 / (n - 1) * W)}" y="0" width="${Math.max(3, Math.round(flat.longestSeconds / 10 / (n - 1) * W))}" height="${H}" fill="#f87171" opacity=".22"/>` : '';
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Power and heart rate over the ride">${band}<path d="${path(series.p, v => H - 6 - v / pmax * (H - 12))}" fill="none" stroke="var(--accent)" stroke-width="1.6"/>${hv.length ? `<path d="${path(series.hr, v => H - 6 - (v - hmin) / (hmax - hmin) * (H - 12))}" fill="none" stroke="#f87171" stroke-width="1.4"/>` : ''}</svg>
      <div style="font-size:11px;color:#8b95a5"><span style="color:var(--accent)">━</span> power (peak ${pmax} W) ${hv.length ? `· <span style="color:#f87171">━</span> heart rate (${hmin}–${hmax} bpm)` : '· no heart rate recorded'}${band ? ' · <span style="color:#f87171">red band</span> = the flat stretch' : ''}</div>`;
  }

  function fileCard(c, f) {
    const m = f.analysis.metrics, b = m.best, tile = (l, v) => `<div style="min-width:90px"><div class="lbl" style="margin:0">${l}</div><div style="font-weight:800">${v}</div></div>`;
    const bw = k => b[k] ? `${b[k].w} W${b[k].wkg ? ` <span style="font-size:11px;color:#8b95a5">${b[k].wkg} W/kg</span>` : ''}` : '–';
    const dev = (f.devices || []).map(d => `<span class="badge" style="background:rgba(255,255,255,.07)">${E([d.type, d.manufacturer, d.name].filter(Boolean).join(' · '))}</span>`).join(' ');
    const fi = f.analysis.findings.map(x => `<div style="padding:8px 0;border-top:1px solid rgba(255,255,255,.06)">${badge(x.severity)} <b>${E(x.label)}</b><div style="font-size:12px;color:#d1d5db;margin-top:3px">${E(x.detail)}</div><details style="margin-top:3px"><summary style="cursor:pointer;font-size:12px;color:#8b95a5">Ordinary explanations</summary><ul style="margin:4px 0 0 18px;font-size:12px;color:#9ca3af">${(x.innocent || []).map(i => `<li>${E(i)}</li>`).join('')}</ul></details></div>`).join('');
    return `<div class="card" style="padding:14px 16px;margin-bottom:12px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div><b>${E(f.name)}</b> <span style="font-size:12px;color:#8b95a5">${f.start ? E(new Date(f.start).toLocaleString()) : ''} · added by ${E(f.addedBy)}</span></div><button type="button" style="${btn}" onclick="invDeleteFile('${E(f.id)}')">Remove</button></div>
      <div style="margin:6px 0">${dev || '<span style="font-size:12px;color:#8b95a5">No device list in the file</span>'}</div>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin:8px 0">${tile('Time', Math.round(m.seconds / 60) + ' min')}${tile('Average', m.avgPower + ' W')}${tile('NP', (m.np || '–') + (m.np ? ' W' : ''))}${tile('Best 5 s', bw(5))}${tile('Best 1 min', bw(60))}${tile('Best 5 min', bw(300))}${tile('Best 20 min', bw(1200))}${tile('Heart rate', m.hr.avg ? m.hr.avg + ' bpm' : 'none')}${m.mass ? tile('Climbs fit', (m.mass.impliedRiderKg || m.mass.mass) + ' kg') : ''}</div>
      ${chart(f.analysis.series, m.flat)}
      <div style="margin-top:8px">${f.analysis.findings.length ? fi : '<div style="font-size:13px;color:#34d399;padding-top:6px">Nothing in this file stood out.</div>'}</div></div>`;
  }

  function aiBox(c) {
    const a = c.ai;
    const body = a ? `<div style="font-size:13px;margin-bottom:6px">${E(a.summary)}</div>
      ${[['What the data shows', a.whatTheDataShows], ['Ordinary explanations', a.ordinaryExplanations], ['Questions that could be asked, kindly', a.questionsForTheRider]].filter(x => x[1].length).map(([t, l]) => `<div class="lbl" style="margin-top:8px">${t}</div><ul style="margin:0 0 0 18px;font-size:13px">${l.map(i => `<li>${E(i)}</li>`).join('')}</ul>`).join('')}
      <div style="margin-top:8px;font-size:13px"><b>Suggested next step:</b> ${E(a.suggestedNextStep)}</div><div style="font-size:12px;color:#8b95a5;margin-top:4px">Confidence that this needs follow-up: <b>${E(a.confidence)}</b> · ${E(a.limits)}</div>
      <div style="font-size:11px;color:#8b95a5;margin-top:4px">Written ${E(a.at.slice(0, 16).replace('T', ' '))} by ${E(a.by)} with ${E(a.model)}. An AI can be wrong: check it against the numbers above.</div>` : '<div style="font-size:12px;color:#8b95a5">Not written yet. It reads the numbers above and your notes (never the rider\'s name) and writes a cautious summary, the ordinary explanations and kind questions to ask.</div>';
    return `<div class="card" style="padding:14px 16px;margin-bottom:12px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center"><div class="lbl" style="margin:0">AI summary</div>${aiOn ? `<button type="button" style="${btn}" ${busy === 'ai' ? 'disabled' : ''} onclick="invAi()">${busy === 'ai' ? 'Writing…' : a ? 'Write it again' : '✨ Write the AI summary'}</button>` : '<span style="font-size:12px;color:#8b95a5">Switch on ANTHROPIC_API_KEY to use this</span>'}</div>${body}</div>`;
  }

  function caseView(c) {
    const cross = (c.cross || []).map(x => `<div style="padding:6px 0">${badge(x.severity)} <b>${E(x.label)}</b><div style="font-size:12px;color:#d1d5db">${E(x.detail)}</div></div>`).join('');
    return `<button type="button" style="${btn};margin-bottom:10px" onclick="invBack()">← All investigations</button>
      <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:flex-start;margin-bottom:10px"><div><h2 style="font-size:20px;font-weight:900;margin-bottom:2px">${E(c.title)}</h2><div style="font-size:13px;color:#8b95a5">${typeof rn === 'function' ? rn(c.name, c.zwid, '') : E(c.name)} · ${E(c.status)} · opened ${E(c.createdAt.slice(0, 10))} by ${E(c.createdBy)}</div></div>
        <div style="display:flex;gap:6px;flex-wrap:wrap"><a href="https://www.zwiftracing.app/riders/${E(c.zwid)}" target="_blank" rel="noopener" style="${btn};text-decoration:none">Rider on ZwiftRacing ↗</a>${c.status === 'open' ? `<button type="button" style="${btn}" onclick="invStatus('closed')">Close</button>` : `<button type="button" style="${btn}" onclick="invStatus('open')">Reopen</button>`}${role === 'admin' ? `<button type="button" style="${btn};color:#f87171" onclick="invDelete()">Delete</button>` : ''}</div></div>
      ${c.outcome ? `<div class="card" style="padding:10px 14px;margin-bottom:10px;font-size:13px"><b>Outcome:</b> ${E(c.outcome)}</div>` : ''}
      <div class="card" style="padding:14px 16px;margin-bottom:12px"><div class="lbl">Notes (only staff see these)</div><textarea id="inv-n" class="inp" rows="4">${E(c.notes)}</textarea>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px"><label style="font-size:12px;color:#8b95a5">Weight to use (kg) <input id="inv-kg" class="inp" type="number" min="31" max="199" step="0.1" value="${c.declaredKg || ''}" style="width:90px;display:inline-block"/></label><button type="button" style="${btn}" onclick="invSaveNotes()">Save</button><span id="inv-msg" role="status" style="font-size:12px;color:#8b95a5"></span></div>
        <div style="font-size:11px;color:#8b95a5;margin-top:4px">The weight comes from the club roster. Correct it here if you know it is different and the W/kg figures and the weight check re-run.</div></div>
      <div class="card" style="padding:14px 16px;margin-bottom:12px"><div class="lbl">Add FIT files</div><input id="inv-file" type="file" accept=".fit,application/octet-stream" multiple aria-label="Choose FIT files" onchange="invUpload(this)"/><div id="inv-up" role="status" style="font-size:12px;color:#8b95a5;margin-top:6px">Zwift: Settings → Activity files, or Garmin Connect → Export original. Up to 12 files and six hours each.</div></div>
      ${(c.files || []).map(f => fileCard(c, f)).join('')}
      ${cross ? `<div class="card" style="padding:14px 16px;margin-bottom:12px"><div class="lbl">Across the rides</div>${cross}</div>` : ''}
      ${aiBox(c)}
      <details class="card" style="padding:10px 16px"><summary style="cursor:pointer;font-size:12px;color:#8b95a5">History</summary>${(c.history || []).slice().reverse().map(h => `<div style="font-size:12px;color:#9ca3af;padding:2px 0">${E(h.at.slice(0, 16).replace('T', ' '))} · ${E(h.by)} · ${E(h.what)}</div>`).join('')}</details>`;
  }

  const msg = t => { const m = document.getElementById('inv-msg'); if (m) m.textContent = t; };
  window.invLoad = load;
  window.invOpen = async id => { try { cur = (await api('/api/inv/case?id=' + encodeURIComponent(id))).case; render(); } catch (e) { alert(e.message); } };
  window.invBack = () => { cur = null; load(); };
  window.invCreate = async () => {
    const raw = document.getElementById('inv-rider').value, m = /\((\d+)\)\s*$/.exec(raw) || /^(\d+)$/.exec(raw.trim());
    const found = m ? m[1] : ((typeof riders !== 'undefined' ? riders : []).find(r => r.name.toLowerCase() === raw.trim().toLowerCase()) || {}).id;
    if (!found) { msg('Choose a rider from the list.'); return; }
    try { cur = (await api('/api/inv/create', { zwid: String(found), title: document.getElementById('inv-title').value, notes: document.getElementById('inv-notes').value })).case; render(); } catch (e) { msg(e.message); }
  };
  // From a Fair play item: opens a case for that rider with the numbers in the notes.
  window.invFromFlag = async (zwid, title, notes, flagId) => {
    try { cur = (await api('/api/inv/create', { zwid: String(zwid), title, notes, flagId })).case; const nav = document.getElementById('nav-inv'); if (nav) showTab('inv', nav); else render(); } catch (e) { alert(e.message); }
  };
  window.invSaveNotes = async () => {
    try { cur = (await api('/api/inv/note', { id: cur.id, notes: document.getElementById('inv-n').value, declaredKg: document.getElementById('inv-kg').value })).case; render(); msg('Saved.'); } catch (e) { msg(e.message); }
  };
  window.invStatus = async status => { const outcome = status === 'closed' ? prompt('How did it end? (optional, e.g. "Spoke to the rider: new trainer")', '') : ''; if (outcome === null) return; try { cur = (await api('/api/inv/status', { id: cur.id, status, outcome })).case; render(); } catch (e) { alert(e.message); } };
  window.invDelete = async () => { if (!confirm('Delete this whole investigation? This cannot be undone.')) return; try { await api('/api/inv/delete', { id: cur.id }); cur = null; load(); } catch (e) { alert(e.message); } };
  window.invDeleteFile = async fid => { if (!confirm('Remove this file from the case?')) return; try { cur = (await api('/api/inv/file-delete', { id: cur.id, fileId: fid })).case; render(); } catch (e) { alert(e.message); } };
  window.invAi = async () => { busy = 'ai'; render(); try { cur = (await api('/api/inv/ai', { id: cur.id })).case; } catch (e) { alert(e.message); } busy = ''; render(); };
  window.invUpload = async input => {
    const files = [...input.files], out = document.getElementById('inv-up'); if (!files.length) return;
    for (const f of files) {
      out.textContent = `Reading ${f.name}…`;
      try {
        const p = FitParse.parse(await f.arrayBuffer());
        if (p.samples.t.length < 120) throw new Error('has less than two minutes of data');
        out.textContent = `Looking at ${f.name}…`;
        cur = (await api('/api/inv/file', { id: cur.id, name: f.name, samples: p.samples, devices: p.devices, file: p.file, start: p.start })).case;
      } catch (e) { out.textContent = `${f.name}: ${e.message}`; await new Promise(r => setTimeout(r, 1800)); }
    }
    render();
  };
})();
