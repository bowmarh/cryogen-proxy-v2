'use strict';
// Under the ZRL page: a rider asks to move to another team ("Ask to change team"); a captain (of either team) or staff sees waiting requests and approves or declines.
// Nothing moves until someone approves.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let mine = null, pending = null, msg = '';
  const hdr = () => { const h = { 'Content-Type': 'application/json' }, t = sessionStorage.getItem('token'); if (t) h.Authorization = 'Bearer ' + t; return h; };
  async function call(path, body) { const r = await fetch(path, body === undefined ? { headers: hdr() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) }), j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'Could not load.'); e.status = r.status; throw e; } return j; }
  const badge = s => `<b style="color:${s === 'approved' ? '#6ee7b7' : s === 'open' ? '#fcd34d' : '#9ca3af'}">${E(s)}</b>`;
  function draw() {
    const el = document.getElementById('teamchange-body'); if (!el) return;
    let h = msg ? `<div role="status" style="font-size:12px;margin-bottom:8px;color:#6ee7b7">${E(msg)}</div>` : '';
    if (mine && mine.round) {
      const open = (mine.requests || []).find(r => r.status === 'open');
      h += `<div style="font-size:13px;margin-bottom:6px">${mine.signedUp ? `You are on: <b>${(mine.current || []).map(t => E(t.name)).join(', ') || 'no team yet'}</b>` : 'Sign up for the round first, then you can ask to change team.'}</div>`;
      if (mine.signedUp && !open) h += `<label class="lbl" for="tc-to">Move to</label><select id="tc-to" class="inp" style="max-width:260px;margin-bottom:6px">${mine.teams.filter(t => !(mine.current || []).some(c => c.id === t.id)).map(t => `<option value="${E(t.id)}">${E(t.name)}</option>`).join('')}</select><label class="lbl" for="tc-note">Why (optional)</label><input id="tc-note" class="inp" maxlength="200" style="max-width:380px;margin-bottom:8px"/><button type="button" class="btn-cyan" style="width:auto;padding:6px 16px" onclick="teamChangeAsk()">Ask the captain</button>`;
      if (open) h += `<div style="font-size:13px">Waiting: your request to move to <b>${E((mine.teams.find(t => t.id === open.to) || {}).name || open.to)}</b>. <a href="#" onclick="teamChangeCancel('${E(open.id)}');return false" style="color:#22d3ee">Cancel it</a></div>`;
      const done = (mine.requests || []).filter(r => r.status !== 'open').slice(0, 2); if (done.length) h += `<div style="font-size:12px;color:#9ca3af;margin-top:6px">${done.map(r => `${E((r.decidedAt || r.at).slice(0, 10))}: ${E((mine.teams.find(t => t.id === r.to) || {}).name || r.to)} ${badge(r.status)}`).join(' · ')}</div>`;
    } else if (mine) h += '<div style="font-size:13px;color:#8b95a5">There is no ZRL round at the moment.</div>';
    else h += '<div style="font-size:13px;color:#8b95a5">Sign in with your cryogen.team account to ask for a team change.</div>';
    if (pending && pending.requests.length) h += `<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,.08)"><b style="font-size:13px">Waiting for your decision</b>${pending.requests.map(r => `<div style="font-size:13px;margin-top:6px"><b>${E(r.name)}</b> ${r.fromName ? `from ${E(r.fromName)} ` : ''}to <b>${E(r.toName)}</b>${r.note ? ` <span style="color:#9ca3af">"${E(r.note)}"</span>` : ''}<div style="margin-top:4px"><button type="button" class="btn-cyan" style="width:auto;padding:4px 12px;font-size:12px" onclick="teamChangeDecide('${E(r.id)}','approve')">Approve</button> <button type="button" style="padding:4px 12px;font-size:12px;background:rgba(255,255,255,.05);color:#e5e7eb;border:1px solid rgba(255,255,255,.18);border-radius:6px" onclick="teamChangeDecide('${E(r.id)}','decline')">Decline</button></div></div>`).join('')}</div>`;
    el.innerHTML = h;
  }
  async function load() {
    msg = '';
    try { mine = await call('/api/me/team-change'); } catch (e) { mine = null; }
    try { pending = await call('/api/team-changes'); } catch (e) { pending = null; }   // a rider who is not a captain gets a refusal: nothing to show
    draw();
  }
  window.teamChangeAsk = async () => { try { await call('/api/me/team-change', { to: document.getElementById('tc-to').value, note: document.getElementById('tc-note').value }); await load(); msg = 'Sent. The captain has been told; nothing changes until they approve.'; } catch (e) { alert(e.message); } draw(); };
  window.teamChangeCancel = async id => { try { await call('/api/me/team-change/cancel', { id }); await load(); msg = 'Request cancelled.'; } catch (e) { alert(e.message); } draw(); };
  window.teamChangeDecide = async (id, action) => { let reason = ''; if (action === 'decline') reason = prompt('Reason (the rider will see it, optional):') || ''; try { await call('/api/team-changes/decide', { id, action, reason }); await load(); msg = action === 'approve' ? 'Approved: the rider has been moved.' : 'Declined.'; } catch (e) { alert(e.message); } draw(); };
  function mount() {
    const root = document.getElementById('zrl-root'); if (!root || document.getElementById('teamchange')) return;
    const c = document.createElement('details'); c.id = 'teamchange'; c.className = 'card'; c.style.cssText = 'padding:12px 16px;margin-top:12px';
    c.innerHTML = '<summary style="cursor:pointer;font-weight:700">🔁 Ask to change team</summary><div id="teamchange-body" style="margin-top:8px">Loading…</div>';
    c.addEventListener('toggle', () => { if (c.open) load(); });
    root.insertAdjacentElement('afterend', c);
  }
  document.addEventListener('DOMContentLoaded', mount);
})();
