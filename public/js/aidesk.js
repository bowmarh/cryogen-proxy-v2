'use strict';
// Staff: the AI desk. Race radio and team reports (settings and one-off), smart line-ups, ask the club, churn radar, reply triage.
// Everything here is a suggestion or a draft; sending an email or changing a switch is an admin's button.
(function () {
  let st = null, view = 'radio', round = null, busy = '', note = '', out = {}, churn = null, triage = null;
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const root = () => document.getElementById('aidesk-content');
  const isAdmin = () => typeof role !== 'undefined' && role === 'admin';
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const say = (m, bad) => { note = m ? `<div role="status" style="margin:8px 0;padding:8px 12px;border-radius:8px;font-size:13px;background:${bad ? 'rgba(248,113,113,.12);color:#fca5a5' : 'rgba(52,211,153,.12);color:#6ee7b7'}">${E(m)}</div>` : ''; };
  // The action is started before the page is redrawn: it reads the form fields in its first lines, and a redraw first would reset them.
  async function act(label, fn) {
    let p; try { p = fn(); } catch (e) { p = Promise.reject(e); }
    busy = label; render(); try { await p; } catch (e) { say(e.message, true); } busy = ''; render();
  }
  async function open() {
    const el = root(); if (!el) return;
    try { st = await api('/api/aiops'); try { round = (await api('/api/zrl')).round || null; } catch (e) { round = null; } } catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; return; }
    render();
  }
  const teamSel = id => round ? `<select id="${id}" class="inp" aria-label="Team" style="width:auto">${round.teams.map(t => `<option value="${E(t.id)}">${E(t.name)}</option>`).join('')}</select> <select id="${id}-w" class="inp" aria-label="Race" style="width:auto">${Array.from({ length: round.weeks }, (_, i) => `<option value="${i}">Race ${i + 1}</option>`).join('')}</select>` : '<span style="color:#8b95a5;font-size:13px">No ZRL round is set up.</span>';
  const tabs = () => `<div role="tablist" style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">${[['radio', '📻 Radio & reports'], ['lineup', '🧩 Line-ups'], ['ask', '💬 Ask the club'], ['churn', '📉 Churn radar'], ['replies', `📥 Replies${st.triage ? ' (' + st.triage + ')' : ''}`]].map(([k, l]) => `<button type="button" role="tab" aria-selected="${view === k}" style="${btn};${view === k ? 'border-color:var(--accent,#22d3ee);color:#fff' : ''}" onclick="aideskView('${k}')">${l}</button>`).join('')}</div>`;
  const ta = (id, v, rows) => `<textarea id="${id}" class="inp" rows="${rows || 6}" style="width:100%;font-family:inherit" aria-label="${E(id)}">${E(v || '')}</textarea>`;

  function radioView() {
    const s = st.settings, dis = isAdmin() ? '' : 'disabled', r = out.report;
    return `<div class="card" style="padding:14px 16px"><b>Race-day radio</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 8px">When a team's result is entered, a short update is posted to the club Discord${st.aiOn ? '' : ' (plain wording: the AI is off)'}.</div>
      <label style="display:block;font-size:13px;margin:4px 0"><input type="checkbox" id="r-on" ${s.radio.on ? 'checked' : ''} ${dis}/> Post results to Discord as they are entered</label>
      <label style="display:block;font-size:13px;margin:4px 0"><input type="checkbox" id="r-auto" ${s.reports.auto ? 'checked' : ''} ${dis}/> Also email each team its report automatically (needs Email switched on)</label>
      ${isAdmin() ? `<button type="button" class="btn-cyan" style="width:auto;padding:6px 16px;margin-top:8px" onclick="aideskRadioSave()">Save</button>` : '<div style="font-size:12px;color:#8b95a5">Only an administrator can change these.</div>'}</div>
      <div class="card" style="padding:14px 16px;margin-top:10px"><b>Team report</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 8px">A recap for one team and race, emailed to its line-up and captain.</div>${teamSel('tr')} <button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="aideskReport(false)">Preview</button>
      ${r ? `<div style="margin-top:8px"><div style="font-size:12px;color:#9ca3af">To ${r.recipients} people · <b>${E(r.subject)}</b></div><pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;margin:6px 0">${E(r.body)}</pre>${isAdmin() ? `<button type="button" class="btn-cyan" style="width:auto;padding:6px 16px" ${busy ? 'disabled' : ''} onclick="aideskReport(true)">Email it to the team</button>` : ''}${r.sent === false ? `<div style="color:#fca5a5;font-size:12px;margin-top:6px">Not sent: ${E(r.why || '')}</div>` : r.sent ? '<div style="color:#6ee7b7;font-size:12px;margin-top:6px">Sent through the Email feature.</div>' : ''}</div>` : ''}</div>`;
  }
  function lineupView() {
    const r = out.lineup;
    return `<div class="card" style="padding:14px 16px"><b>Smart line-up</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 8px">Yes first, then maybe, then by vELO. Nothing is changed: set the line-up in ZRL when you agree.</div>${teamSel('lu')} <button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="aideskLineup()">${busy === 'lu' ? 'Working…' : 'Suggest'}</button>
      ${r ? `<div style="margin-top:10px"><b>${E(r.team)}, race ${r.week + 1}</b>${r.short ? ` <span style="color:#fcd34d;font-size:12px">· ${r.short} short</span>` : ''}<ol style="margin:6px 0 6px 18px;font-size:13px">${r.picks.map(p => `<li>${E(p.name)} <span style="color:#9ca3af">· ${E(p.why)}</span></li>`).join('')}</ol>${r.bench.length ? `<div style="font-size:12px;color:#9ca3af">Bench: ${r.bench.map(p => E(p.name)).join(', ')}</div>` : ''}${r.explanation ? `<p style="font-size:13px;margin-top:6px">${E(r.explanation)}</p>` : ''}</div>` : ''}</div>`;
  }
  function askView() {
    return `<div class="card" style="padding:14px 16px"><b>Ask the club</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 8px">Answers from the club's numbers. Riders you name are shown to the AI as "Rider 1", never by name.</div>
      <div style="display:flex;gap:8px"><input id="ask-q" class="inp" maxlength="500" style="flex:1" aria-label="Your question" placeholder="e.g. Which teams are short of riders this week?" onkeydown="if(event.key==='Enter')aideskAsk()"/><button type="button" class="btn-cyan" style="width:auto;padding:0 18px" ${busy ? 'disabled' : ''} onclick="aideskAsk()">${busy === 'ask' ? 'Thinking…' : 'Ask'}</button></div>
      ${out.ask ? `<div style="margin-top:10px;font-size:13px;white-space:pre-wrap">${E(out.ask)}</div>` : ''}</div>`;
  }
  function churnView() {
    if (!churn) return '<div class="card" style="padding:14px 16px">Loading…</div>';
    const rows = churn.members.map(m => `<div style="padding:6px 0;border-top:1px solid rgba(255,255,255,.06)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13px"><span>${E(m.name)} <span style="color:#8b95a5">· ${Math.round(m.days / 7)} weeks since a race · </span><span style="color:${m.level === 'high' ? '#fca5a5' : m.level === 'medium' ? '#fcd34d' : '#9ca3af'}">${E(m.level)}</span></span><button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="aideskChurnDraft('${E(m.zwid)}')">Draft a note</button></div>${out.churn && out.churn.zwid === m.zwid ? churnDraftBox() : ''}</div>`).join('');
    return `<div class="card" style="padding:14px 16px"><b>Churn radar</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 6px">${E(churn.note)}</div>${rows || '<div style="font-size:13px;color:#8b95a5">Nobody is drifting right now.</div>'}</div>`;
  }
  function churnDraftBox() {
    const d = out.churn;
    return `<div style="margin-top:6px"><input id="cd-subject" class="inp" aria-label="Subject" value="${E(d.subject)}"/>${ta('cd-body', d.body, 6)}<div style="font-size:11px;color:#8b95a5;margin:4px 0">{first} becomes their first name. ${isAdmin() ? '' : 'An administrator approves and sends.'}</div>${isAdmin() ? `<button type="button" class="btn-cyan" style="width:auto;padding:6px 16px" ${busy ? 'disabled' : ''} onclick="aideskChurnSend('${E(d.zwid)}')">Approve &amp; email</button>` : ''}</div>`;
  }
  function repliesView() {
    if (!triage) return '<div class="card" style="padding:14px 16px">Loading…</div>';
    const items = triage.map(i => `<div style="padding:8px 0;border-top:1px solid rgba(255,255,255,.06);font-size:13px"><div><b style="color:${i.kind === 'complaint' ? '#fca5a5' : i.kind === 'optout' ? '#9ca3af' : '#6ee7b7'}">${E(i.kind)}</b> · ${E(i.from)} · <span style="color:#8b95a5">${E((i.at || '').slice(0, 10))}</span>${i.status === 'done' ? ' · ✅' : ''}</div><div>${E(i.summary)}</div>${i.handled ? `<div style="color:#9ca3af;font-size:12px">${E(i.handled)}</div>` : ''}${i.suggested ? `<div style="margin-top:4px;color:#d1d5db"><i>Suggested reply:</i> ${E(i.suggested)}</div>` : ''}${i.status === 'open' ? `<button type="button" style="${btn};margin-top:4px" onclick="aideskDone('${E(i.id)}')">Mark done</button>` : ''}</div>`).join('');
    return `<div class="card" style="padding:14px 16px"><b>Replies to club emails</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 8px">Paste a reply to sort it. Opt-outs unsubscribe the sender straight away; complaints alert the admin channel. Replies can also arrive automatically: see docs/EMAIL-SETUP.md.</div>
      <input id="tr-from" class="inp" aria-label="From address" placeholder="From (email address)"/><input id="tr-sub" class="inp" aria-label="Subject" placeholder="Subject" style="margin-top:6px"/>${ta('tr-text', '', 4)}<button type="button" class="btn-cyan" style="width:auto;padding:6px 16px;margin-top:6px" ${busy ? 'disabled' : ''} onclick="aideskTriage()">Sort it</button>${items}</div>`;
  }
  function render() {
    const el = root(); if (!el || !st) return;
    const body = view === 'lineup' ? lineupView() : view === 'ask' ? askView() : view === 'churn' ? churnView() : view === 'replies' ? repliesView() : radioView();
    el.innerHTML = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">🤖 AI desk</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:6px">Drafts and suggestions from the club's own data. You decide what goes out.${st.aiOn ? '' : ' <span style="color:#fcd34d">The AI is off (no ANTHROPIC_API_KEY): plain wording is used where it can be.</span>'}</p>${tabs()}${note}${body}`;
  }
  window.aideskLoad = open;
  window.aideskView = async v => {
    view = v; say(''); render();
    try { if (v === 'churn' && !churn) { churn = await api('/api/aiops/churn'); } if (v === 'replies') { triage = (await api('/api/aiops/triage')).items; } } catch (e) { say(e.message, true); } render();
  };
  window.aideskRadioSave = () => act('save', async () => { st.settings = (await api('/api/aiops/settings', { radio: { on: document.getElementById('r-on').checked }, reports: { auto: document.getElementById('r-auto').checked } })).settings; say('Saved.'); });
  window.aideskReport = send => act('report', async () => { out.report = await api('/api/aiops/team-report', { team: val('tr'), week: Number(val('tr-w')), send }); if (send) say(out.report.sent ? 'Emailed.' : 'Not sent: ' + (out.report.why || ''), !out.report.sent); });
  window.aideskLineup = () => act('lu', async () => { out.lineup = await api('/api/aiops/lineup', { team: val('lu'), week: Number(val('lu-w')) }); });
  window.aideskAsk = () => act('ask', async () => { out.ask = (await api('/api/aiops/ask', { question: val('ask-q') })).answer; });
  window.aideskChurnDraft = z => act('cd', async () => { out.churn = await api('/api/aiops/churn-draft', { zwid: z }); });
  window.aideskChurnSend = z => { if (!confirm('Email this note?')) return; act('cs', async () => { await api('/api/aiops/churn-send', { zwid: z, subject: val('cd-subject'), body: val('cd-body') }); out.churn = null; say('Emailed.'); }); };
  window.aideskTriage = () => act('tr', async () => { await api('/api/aiops/triage', { from: val('tr-from'), subject: val('tr-sub'), text: val('tr-text') }); triage = (await api('/api/aiops/triage')).items; st = await api('/api/aiops'); say('Sorted.'); });
  window.aideskDone = id => act('done', async () => { await api('/api/aiops/triage-done', { id }); triage = (await api('/api/aiops/triage')).items; st = await api('/api/aiops'); });
})();
