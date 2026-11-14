'use strict';
// Staff: the Email page. Write (or have the AI draft) an email, run the check, pick who gets it, preview, approve (admins). Settings, groups,
// address matching and the automatic emails live under the same page. Every action goes through /api/mail/*; nothing is stored in the browser.
(function () {
  let names = {}, findTimer = null, st = null, cur = null, check = null, aud = null, prev = null, view = 'write', addr = null, busy = '', note = '';
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const root = () => document.getElementById('mail-content');
  const isAdmin = () => typeof role !== 'undefined' && role === 'admin';
  const isOwner = () => isAdmin() && sessionStorage.getItem('owner') === '1';
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  const say = (m, bad) => { note = m ? `<div role="status" style="margin:8px 0;padding:8px 12px;border-radius:8px;font-size:13px;background:${bad ? 'rgba(248,113,113,.12);color:#fca5a5' : 'rgba(52,211,153,.12);color:#6ee7b7'}">${E(m)}</div>` : ''; };
  // Keeps what is typed in the write form (so a redraw does not wipe it) and starts the action BEFORE the page is redrawn: the action reads the
  // form fields in its first lines, and a redraw first would reset them to what was last saved.
  function capture() { if (view === 'write' && document.getElementById('mail-subject') && !(cur && cur.status && cur.status !== 'draft')) cur = { ...(cur || { status: 'draft' }), subject: val('mail-subject'), body: val('mail-body'), category: val('mail-cat') || 'news', audience: audFromForm() }; }
  async function act(label, fn) {
    capture(); let p; try { p = fn(); } catch (e) { p = Promise.reject(e); }
    busy = label; render(); try { await p; } catch (e) { say(e.message, true); } busy = ''; render();
  }

  async function open() {
    const el = root(); if (!el) return;
    try { st = await api('/api/mail'); } catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; return; }
    render();
  }
  const draftFromForm = () => ({ id: cur && cur.id, subject: val('mail-subject'), body: val('mail-body'), category: val('mail-cat') || 'news', audience: audFromForm() });
  function audFromForm() {
    const t = val('mail-aud') || 'all';
    if (t === 'all') return { type: 'all' };
    if (t.startsWith('group:')) return { type: 'group', group: t.slice(6) };
    return { type: 'people', zwids: val('mail-people').split(/[\s,;]+/).filter(Boolean) };
  }
  async function saveDraft() { const r = await api('/api/mail/save', draftFromForm()); cur = r.campaign; return cur; }

  function status() {
    const a = st.addresses || {}, s = st.settings;
    const warn = !st.configured ? `<div class="card" style="padding:12px 16px;margin-bottom:10px;border-left:3px solid #f59e0b">No email service is connected yet. See <b>docs/EMAIL-SETUP.md</b>: an administrator adds the Hostinger mail token and mailbox ID in Vercel.</div>` : '';
    const off = st.configured && !s.enabled ? `<div class="card" style="padding:12px 16px;margin-bottom:10px;border-left:3px solid #f59e0b">Email is switched <b>off</b>. Nothing is sent until an administrator turns it on under Settings.</div>` : '';
    const ad = a.error ? `<div style="color:#fca5a5;font-size:12px">${E(a.error)}</div>` : `<div style="font-size:12px;color:#9ca3af">${a.withEmail} of ${a.members} members have an address${a.ambiguous ? ` · ${a.ambiguous} need checking` : ''}${a.unmatched ? ` · ${a.unmatched} not found in WordPress` : ''}</div>`;
    return warn + off + ad;
  }
  function tabs() {
    return `<div role="tablist" style="display:flex;gap:6px;flex-wrap:wrap;margin:10px 0">${[['write', '✍️ Write'], ['sent', '📬 Sent'], ['groups', '👥 Groups'], ['auto', '⚙️ Settings & automatic']].map(([k, l]) => `<button type="button" role="tab" aria-selected="${view === k}" style="${btn};${view === k ? 'border-color:var(--accent,#22d3ee);color:#fff' : ''}" onclick="mailView('${k}')">${l}</button>`).join('')}</div>`;
  }
  function audienceSelect() {
    const a = cur && cur.audience || { type: 'all' }, v = a.type === 'group' ? 'group:' + a.group : a.type;
    return `<select id="mail-aud" class="inp" aria-label="Who gets it" onchange="mailAudChange()">${`<option value="all" ${v === 'all' ? 'selected' : ''}>Everyone with an address</option>`}${st.groups.map(g => `<option value="group:${E(g.id)}" ${v === 'group:' + g.id ? 'selected' : ''}>👥 ${E(g.name)}</option>`).join('')}<option value="people" ${v === 'people' ? 'selected' : ''}>Chosen riders (Zwift IDs)</option></select>`;
  }
  const chosenText = ids => ids.length ? 'Sending to: ' + ids.map(z => E(names[z] ? `${names[z]} (${z})` : z)).join(', ') : '';
  function writeView() {
    const c = cur || { subject: '', body: '', category: 'news', audience: { type: 'all' }, status: 'draft' }, locked = c.status && c.status !== 'draft';
    const a = c.audience || {}, issues = check && check.issues ? check.issues : [];
    const ck = check ? `<div class="card" style="padding:12px 16px;margin-top:10px"><b>${check.ok ? '✅ Passed the check' : '⛔ Fix these before sending'}</b>${check.ai && check.ai.ran ? ` <span style="font-size:12px;color:#9ca3af">· AI says: ${E(check.ai.verdict || '')}</span>` : `<div style="font-size:12px;color:#9ca3af;margin-top:4px">${E(check.ai ? check.ai.note : '')}</div>`}
      <ul style="margin:6px 0 0 18px;font-size:13px">${issues.map(i => `<li style="color:${i.level === 'error' ? '#fca5a5' : '#fcd34d'}">${E(i.text)}</li>`).join('') || '<li style="color:#9ca3af">No problems found.</li>'}</ul>${check.ai && check.ai.suggestion ? `<div style="font-size:13px;margin-top:6px"><b>Suggestion:</b> ${E(check.ai.suggestion)}</div>` : ''}</div>` : '';
    const au = aud ? `<div style="font-size:13px;margin-top:8px"><b>${aud.count}</b> will get it${aud.optedOut ? ` · ${aud.optedOut} opted out` : ''}${aud.noEmail ? ` · ${aud.noEmail} have no address` : ''}${aud.estimate ? ` · ${E(typeof aud.estimate === 'string' ? aud.estimate : (aud.estimate.days <= 1 ? 'goes out in one go' : `takes about ${aud.estimate.days} days (limit ${aud.estimate.perDay}/day, ${aud.estimate.perHour}/hour)`))}` : ''}</div>` : '';
    const state = c.id ? `<div style="font-size:12px;color:#9ca3af;margin-bottom:6px">Status: <b>${E(c.status)}</b>${c.counts ? ` · ${c.counts.sent || 0} of ${c.counts.total || 0} sent${c.counts.failed ? ` · ${c.counts.failed} failed` : ''}` : ''}${c.error ? ` · ${E(c.error)}` : ''}</div>` : '';
    return `${state}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><input id="mail-brief" class="inp" maxlength="1500" style="flex:1;min-width:200px" aria-label="What should the email be about" placeholder="Ask the AI to draft it: e.g. remind everyone about race week"/><button type="button" style="${btn}" ${busy || locked ? 'disabled' : ''} onclick="mailDraft()">${busy === 'draft' ? 'Drafting…' : '✨ Draft with AI'}</button></div>
      <label class="lbl" for="mail-subject">Subject</label><input id="mail-subject" class="inp" maxlength="200" value="${E(c.subject)}" ${locked ? 'disabled' : ''}/>
      <label class="lbl" for="mail-body" style="margin-top:8px">Message <span style="font-weight:400;color:#8b95a5">(use {first} for their first name; **bold**, [text](https://link), "- " for lists)</span></label>
      <textarea id="mail-body" class="inp" rows="12" maxlength="8000" style="width:100%;font-family:inherit" ${locked ? 'disabled' : ''}>${E(c.body)}</textarea>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"><div><label class="lbl" for="mail-cat">Type</label><select id="mail-cat" class="inp" ${locked ? 'disabled' : ''}><option value="news" ${c.category !== 'service' ? 'selected' : ''}>Club news (can unsubscribe)</option><option value="service" ${c.category === 'service' ? 'selected' : ''}>Service (reminders, race info)</option></select></div>
        <div><label class="lbl" for="mail-aud">Who</label>${audienceSelect()}</div></div>
      <div id="mail-people-row" style="${a.type === 'people' ? '' : 'display:none;'}margin-top:6px"><label class="lbl" for="mail-find">Find riders by name or Zwift ID</label><input id="mail-find" class="inp" autocomplete="off" oninput="mailFind()" placeholder="Start typing a name or an ID" ${locked ? 'disabled' : ''}/><div id="mail-find-res" style="margin:4px 0"></div>
        <label class="lbl" for="mail-people">Chosen riders (Zwift IDs; you can also type or paste IDs here)</label><input id="mail-people" class="inp" oninput="mailChosen()" value="${E((a.zwids || []).join(' '))}" ${locked ? 'disabled' : ''}/><div id="mail-chosen" style="font-size:12px;color:#9ca3af;margin-top:4px">${chosenText((a.zwids || []).map(String))}</div></div>
      ${au}${ck}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
        <button type="button" style="${btn}" ${busy || locked ? 'disabled' : ''} onclick="mailSave()">💾 Save draft</button>
        <button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="mailAudience()">👥 Count recipients</button>
        <button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="mailPreview()">👁️ Preview</button>
        <button type="button" style="${btn}" ${busy || locked ? 'disabled' : ''} onclick="mailCheck()">🔍 Check</button>
        ${isAdmin() ? `<button type="button" style="${btn}" ${busy ? 'disabled' : ''} onclick="mailTest()">📨 Send me a test</button>` : ''}
        ${isAdmin() && !locked ? `<button type="button" class="btn-cyan" style="width:auto;padding:6px 16px;font-size:13px" ${busy ? 'disabled' : ''} onclick="mailApprove()">✅ Approve &amp; send</button>` : ''}
        ${isAdmin() && ['scheduled', 'sending', 'paused'].includes(c.status) ? `<button type="button" style="${btn}" onclick="mailCancel()">Stop</button>` : ''}${isAdmin() && c.status === 'paused' ? `<button type="button" style="${btn}" onclick="mailResume()">Resume</button>` : ''}
        ${c.id ? `<button type="button" style="${btn}" onclick="mailNew()">New email</button>` : ''}</div>
      ${isAdmin() ? '' : '<div style="font-size:12px;color:#8b95a5;margin-top:6px">Moderators can draft and check. An administrator approves and sends.</div>'}
      ${prev ? `<div class="card" style="padding:12px 16px;margin-top:10px"><b>${E(prev.subject)}</b>${prev.as ? ` <span style="font-size:12px;color:#9ca3af">· previewed as ${E(prev.as)}</span>` : ' <span style="font-size:12px;color:#9ca3af">· sample name</span>'}<iframe title="Email preview" sandbox="" srcdoc="${E(prev.html)}" style="width:100%;height:360px;border:0;background:#fff;margin-top:8px;border-radius:6px"></iframe></div>` : ''}`;
  }
  function sentView() {
    const rows = st.campaigns.map(c => `<tr><td style="padding:6px 8px"><a href="#" onclick="mailOpen('${E(c.id)}');return false">${E(c.subject || '(no subject)')}</a></td><td>${E(c.status)}</td><td>${(c.counts && c.counts.sent) || 0}/${(c.counts && c.counts.total) || 0}</td><td style="color:#8b95a5">${E((c.createdAt || '').slice(0, 10))}</td></tr>`).join('');
    return `<div class="card" style="padding:10px 12px;overflow:auto"><table style="width:100%;font-size:13px"><thead><tr style="text-align:left;color:#8b95a5"><th style="padding:6px 8px">Email</th><th>Status</th><th>Sent</th><th>Created</th></tr></thead><tbody>${rows || '<tr><td colspan="4" style="padding:12px;color:#8b95a5">Nothing yet.</td></tr>'}</tbody></table></div>`;
  }
  function groupsView() {
    const g = st.groups.map(x => `<div class="card" style="padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;gap:8px;align-items:center"><div><b>${E(x.name)}</b><div style="font-size:12px;color:#9ca3af">${E((x.segments || []).map(s => (st.segments.find(l => l[0] === s) || [0, s])[1]).join(', '))}${x.zwids && x.zwids.length ? ` · ${x.zwids.length} chosen riders` : ''}</div></div>${isAdmin() ? `<button type="button" style="${btn}" onclick="mailGroupDelete('${E(x.id)}')">Delete</button>` : ''}</div>`).join('');
    const form = isAdmin() ? `<div class="card" style="padding:14px 16px"><b>New group</b><label class="lbl" for="g-name">Name</label><input id="g-name" class="inp" maxlength="60"/>
      <div class="lbl" style="margin-top:8px">Include these club groups</div><div style="display:flex;flex-wrap:wrap;gap:8px 14px;font-size:13px">${st.segments.map(([k, l]) => `<label><input type="checkbox" class="g-seg" value="${E(k)}"/> ${E(l)}</label>`).join('')}</div>
      <label class="lbl" for="g-ids" style="margin-top:8px">Plus these riders (Zwift IDs)</label><input id="g-ids" class="inp"/><button type="button" class="btn-cyan" style="width:auto;padding:6px 16px;margin-top:10px" onclick="mailGroupSave()">Save group</button></div>` : '';
    return (g || '<div style="color:#8b95a5;font-size:13px;margin-bottom:8px">No groups yet.</div>') + form;
  }
  function autoView() {
    const s = st.settings, au = s.automations || {}, dis = isOwner() ? '' : 'disabled';
    const addrBlock = addr ? `<div class="card" style="padding:12px 16px;margin-top:10px"><b>Address matching</b><div style="font-size:12px;color:#9ca3af;margin:4px 0">${addr.withEmail} matched · ${addr.wpUsers} WordPress users</div>
      ${addr.ambiguous.length ? `<div style="font-size:13px;margin-top:6px"><b>Needs a decision</b> (more than one WordPress user has that name)</div><div data-filterable>${addr.ambiguous.map(x => `<div style="font-size:12px;margin:4px 0">${E(x.name || x.zwid)} · ${E(x.zwid)} <input class="inp" style="width:220px" id="am-${E(x.zwid)}" placeholder="email" aria-label="Email for ${E(x.name || x.zwid)}"/> <button type="button" style="${btn}" onclick="mailAddress('${E(x.zwid)}')">Set</button></div>`).join('')}</div>` : ''}
      ${addr.unmatched.length ? `<div style="font-size:13px;margin-top:6px"><b>Not found</b></div><div data-filterable>${addr.unmatched.slice(0, 50).map(x => `<div style="font-size:12px;margin:4px 0">${E(x.name || x.zwid)} · ${E(x.zwid)} <input class="inp" style="width:220px" id="am-${E(x.zwid)}" placeholder="email" aria-label="Email for ${E(x.name || x.zwid)}"/> <button type="button" style="${btn}" onclick="mailAddress('${E(x.zwid)}')">Set</button></div>`).join('')}</div>` : ''}</div>` : '';
    const log = (st.log || []).map(l => l && `<div style="font-size:12px;color:#9ca3af">${E(l.at ? l.at.slice(0, 16).replace('T', ' ') : '')} · ${E(l.text || l.subject || l.event || JSON.stringify(l))}</div>`).join('');
    return `<div class="card" style="padding:14px 16px"><b>Settings</b>
      <label style="display:block;margin:8px 0;font-size:13px"><input type="checkbox" id="s-enabled" ${s.enabled ? 'checked' : ''} ${dis}/> Email is on${st.provider ? ` (sending through ${E(st.provider)})` : ''}</label>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><div><label class="lbl" for="s-from">Sender name</label><input id="s-from" class="inp" maxlength="60" value="${E(s.fromName)}" ${dis}/></div><div><label class="lbl" for="s-reply">Reply-to</label><input id="s-reply" class="inp" value="${E(s.replyTo || '')}" ${dis}/></div>
        <div><label class="lbl" for="s-hour">Per hour</label><input id="s-hour" class="inp" type="number" min="1" max="5000" style="width:90px" value="${s.perHour}" ${dis}/></div><div><label class="lbl" for="s-day">Per day</label><input id="s-day" class="inp" type="number" min="1" max="5000" style="width:90px" value="${s.perDay}" ${dis}/></div></div>
      <label class="lbl" for="s-footer" style="margin-top:8px">Footer line</label><input id="s-footer" class="inp" maxlength="240" value="${E(s.footer || '')}" ${dis}/>
      <div style="margin-top:12px"><b style="font-size:13px">Automatic emails</b></div>
      <label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox" id="a-news" ${au.newsletter && au.newsletter.on ? 'checked' : ''} ${dis}/> Weekly newsletter drafted every Monday morning · <select id="a-mode" class="inp" style="width:auto" ${dis}><option value="approve" ${au.newsletter && au.newsletter.mode !== 'auto' ? 'selected' : ''}>an admin approves it</option><option value="auto" ${au.newsletter && au.newsletter.mode === 'auto' ? 'selected' : ''}>sends itself if it passes every check</option></select></label>
      <label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox" id="a-welcome" ${au.welcome && au.welcome.on ? 'checked' : ''} ${dis}/> Welcome email to new members</label>
      <label style="display:block;margin:6px 0;font-size:13px"><input type="checkbox" id="a-quiet" ${au.quiet && au.quiet.on ? 'checked' : ''} ${dis}/> Gentle win-back note to quiet members (at most once every 60 days each)</label>
      ${isOwner() ? `<button type="button" class="btn-cyan" style="width:auto;padding:6px 16px;margin-top:8px" onclick="mailSettings()">Save settings</button> <button type="button" style="${btn}" onclick="mailAddresses()">Review addresses</button>` : `<div style="font-size:12px;color:#8b95a5">Only the owner can change these.</div>${isAdmin() ? `<button type="button" style="${btn};margin-top:6px" onclick="mailAddresses()">Review addresses</button>` : ''}`}</div>${addrBlock}
      <div class="card" style="padding:12px 16px;margin-top:10px"><b style="font-size:13px">Recent activity</b>${log || '<div style="font-size:12px;color:#8b95a5">Nothing yet.</div>'}</div>`;
  }
  function render() {
    const el = root(); if (!el || !st) return;
    const body = view === 'sent' ? sentView() : view === 'groups' ? groupsView() : view === 'auto' ? autoView() : writeView();
    el.innerHTML = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">✉️ Email</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:6px">Write or AI-draft, check, then send to everyone, a group or one rider.</p>${status()}${tabs()}${note}${body}`;
    if (view === 'write') setTimeout(() => window.mailChosen && window.mailChosen(), 0);
  }

  window.mailLoad = open;
  window.mailView = v => { view = v; say(''); render(); };
  window.mailAudChange = () => { const r = document.getElementById('mail-people-row'); if (r) r.style.display = val('mail-aud') === 'people' ? '' : 'none'; aud = null; };
  // Picking riders by name or ID: results are drawn straight into the page (no redraw), so what is typed stays put.
  window.mailFind = () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(async () => {
      const box = document.getElementById('mail-find-res'), q = val('mail-find').trim(); if (!box) return; if (q.length < 2) { box.innerHTML = ''; return; }
      try {
        const r = (await api('/api/mail/find?q=' + encodeURIComponent(q))).matches;
        box.innerHTML = r.length ? r.map(m => { names[m.zwid] = m.name; return `<button type="button" style="${btn};margin:2px 4px 2px 0" onclick="mailPick('${E(m.zwid)}')">${E(m.name)} · ${E(m.zwid)}${m.hasEmail ? '' : ' (no email)'}</button>`; }).join('') : '<span style="font-size:12px;color:#8b95a5">No one found.</span>';
      } catch (e) { box.innerHTML = `<span style="font-size:12px;color:#fca5a5">${E(e.message)}</span>`; }
    }, 250);
  };
  window.mailPick = z => { const ids = val('mail-people').split(/[\s,;]+/).filter(Boolean); if (!ids.includes(z)) ids.push(z); document.getElementById('mail-people').value = ids.join(' '); document.getElementById('mail-find').value = ''; document.getElementById('mail-find-res').innerHTML = ''; aud = null; window.mailChosen(); };
  window.mailChosen = async () => {
    const ids = val('mail-people').split(/[\s,;]+/).filter(Boolean), el = () => document.getElementById('mail-chosen'); if (el()) el().innerHTML = chosenText(ids);
    for (const z of ids.filter(x => !names[x] && /^\d{2,}$/.test(x))) { try { const m = (await api('/api/mail/find?q=' + z)).matches.find(x => x.zwid === z); if (m) names[z] = m.name; } catch (e) { /* the ID shows on its own */ } }
    if (el()) el().innerHTML = chosenText(val('mail-people').split(/[\s,;]+/).filter(Boolean));
  };
  window.mailNew = () => { cur = null; prev = null; check = null; aud = null; say(''); render(); };
  window.mailOpen = async id => { try { cur = (await api('/api/mail/campaign?id=' + encodeURIComponent(id))).campaign; check = cur.check || null; aud = null; view = 'write'; say(''); render(); } catch (e) { say(e.message, true); render(); } };
  window.mailDraft = () => act('draft', async () => {
    const r = await api('/api/mail/draft', { brief: val('mail-brief') });
    cur = { ...(cur || {}), id: undefined, subject: r.subject, body: r.body, category: val('mail-cat') || 'news', audience: audFromForm(), status: 'draft' }; check = null; say('Draft ready. Read it, edit it, then run the check.');
  });
  window.mailSave = () => act('save', async () => { await saveDraft(); say('Saved.'); });
  window.mailCheck = () => act('check', async () => { await saveDraft(); check = (await api('/api/mail/check', { id: cur.id })).check; say(check.ok ? 'Passed the check.' : 'The check found problems.', !check.ok); });
  window.mailAudience = () => act('aud', async () => { aud = await api('/api/mail/audience', { audience: audFromForm(), category: val('mail-cat') || 'news' }); });
  window.mailPreview = () => act('prev', async () => { prev = await api('/api/mail/preview', { subject: val('mail-subject'), body: val('mail-body'), category: val('mail-cat') || 'news', audience: audFromForm() }); });
  window.mailTest = () => { let last = ''; try { last = localStorage.getItem('cg:mail:testto') || ''; } catch (e) { /* not kept */ } const to = (prompt('Send a test to which address? (use a personal inbox, not the club sending mailbox)', last) || '').trim(); if (!to) return; act('test', async () => { await api('/api/mail/test', { to, subject: val('mail-subject'), body: val('mail-body') }); try { localStorage.setItem('cg:mail:testto', to); } catch (e) { /* not kept */ } say('Test sent to ' + to + '.'); }); };
  window.mailApprove = () => act('approve', async () => {
    await saveDraft(); check = (await api('/api/mail/check', { id: cur.id })).check; if (!check.ok) { say('Fix the problems first.', true); return; }
    aud = await api('/api/mail/audience', { audience: cur.audience, category: cur.category });
    if (!confirm(`Send "${cur.subject}" to ${aud.count} people?\n\n${aud.estimate ? 'Estimate: ' + (typeof aud.estimate === 'string' ? aud.estimate : JSON.stringify(aud.estimate)) : ''}`)) { say('Not sent.'); return; }
    cur = (await api('/api/mail/approve', { id: cur.id })).campaign; say('Approved: sending will run over the next hours within your limits.'); st = await api('/api/mail');
  });
  window.mailCancel = () => act('cancel', async () => { cur = (await api('/api/mail/cancel', { id: cur.id })).campaign || cur; say('Stopped.'); st = await api('/api/mail'); });
  window.mailResume = () => act('resume', async () => { await api('/api/mail/resume', { id: cur.id }); cur = (await api('/api/mail/campaign?id=' + encodeURIComponent(cur.id))).campaign; say('Resumed.'); });
  window.mailGroupSave = () => act('group', async () => {
    const g = (await api('/api/mail/group', { name: val('g-name'), segments: [...document.querySelectorAll('.g-seg:checked')].map(c => c.value), zwids: val('g-ids').split(/[\s,;]+/).filter(Boolean) })).group; st.groups = st.groups.filter(x => x.id !== g.id).concat(g); say('Group saved.');
  });
  window.mailGroupDelete = id => { if (!confirm('Delete this group?')) return; act('group', async () => { await api('/api/mail/group-delete', { id }); st.groups = st.groups.filter(x => x.id !== id); say('Group deleted.'); }); };
  window.mailSettings = () => act('settings', async () => {
    const saved = await api('/api/mail/settings', { enabled: document.getElementById('s-enabled').checked, fromName: val('s-from'), replyTo: val('s-reply'), footer: val('s-footer'), perHour: Number(val('s-hour')), perDay: Number(val('s-day')),
      automations: { newsletter: { on: document.getElementById('a-news').checked, mode: val('a-mode') }, welcome: { on: document.getElementById('a-welcome').checked }, quiet: { on: document.getElementById('a-quiet').checked } } });
    st.settings = saved.settings; say('Settings saved.');   // the answer to the save, not a fresh read: a read can come from a server that has not seen the save yet
  });
  window.mailAddresses = () => act('addr', async () => { addr = await api('/api/mail/addresses'); });
  window.mailAddress = z => act('addr', async () => { await api('/api/mail/address', { zwid: z, email: val('am-' + z) }); addr = await api('/api/mail/addresses'); st = await api('/api/mail'); say('Address saved.'); });
})();
