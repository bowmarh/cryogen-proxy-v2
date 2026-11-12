'use strict';
// Members: "My details". How the club emails them and what first name it uses (changed straight away), and requests for anything held in the club's
// records (changes to their details, or leaving), which a volunteer deals with.
(function () {
  let d = null, note = '', busy = false;
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const root = () => document.getElementById('mydetails-content');
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error(x.error || ('HTTP ' + r.status)); return x;
  }
  const say = (m, bad) => { note = m ? `<div role="status" style="margin:8px 0;padding:8px 12px;border-radius:8px;font-size:13px;background:${bad ? 'rgba(248,113,113,.12);color:#fca5a5' : 'rgba(52,211,153,.12);color:#6ee7b7'}">${E(m)}</div>` : ''; };
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  async function load() { const el = root(); if (!el) return; try { d = await api('/api/me/details'); } catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; return; } render(); }
  function render() {
    const el = root(); if (!el || !d) return;
    const e = d.email || {}, ch = e.choice || 'on', opt = (v, l) => `<label style="display:block;font-size:13px;margin:4px 0"><input type="radio" name="md-emails" value="${v}" ${ch === v ? 'checked' : ''} ${e.known ? '' : 'disabled'}/> ${l}</label>`;
    const open = type => (d.requests || []).some(r => r.type === type && r.status === 'open');
    el.innerHTML = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">🙋 My details</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:8px">${E(d.name)} · Zwift ID ${E(d.zwid)}${d.level ? ' · ' + E(d.level) + ' member' : ''}</p>${note}
      <div class="card" style="padding:14px 16px"><b>Emails from the club</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 6px">${e.known ? `We write to ${E(e.email)}.` : 'We have no email address for you yet.'} Changes take effect straight away.</div>${opt('on', 'Send me everything: club news and team emails')}${opt('news', 'Only emails I need as a member (no newsletters)')}${opt('all', 'No emails at all')}
        <label class="lbl" for="md-name" style="margin-top:8px">The first name we use in emails</label><input id="md-name" class="inp" maxlength="40" value="${E(d.preferredName)}" placeholder="${E(String(d.name || '').split(/\s+/)[0])}" style="width:240px"/>
        <div style="margin-top:8px"><button type="button" class="btn-cyan" style="width:auto;padding:6px 16px" ${busy ? 'disabled' : ''} onclick="myDetailsSave()">Save</button></div></div>
      <div class="card" style="padding:14px 16px;margin-top:12px"><b>Ask for a change</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 6px">Your name, email address and membership live in the club's website records. Tell us what to change and a volunteer will do it.</div>
        <textarea id="md-text" class="inp" rows="3" maxlength="500" style="width:100%;font-family:inherit" aria-label="What should we change?" placeholder="e.g. Please change my email address to…"></textarea>
        <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap"><button type="button" style="${btn}" ${busy || open('details') ? 'disabled' : ''} onclick="myDetailsAsk('details')">Send my change request</button><button type="button" style="${btn}" ${busy || open('leave') ? 'disabled' : ''} onclick="myDetailsAsk('leave')">I want to leave the club</button></div></div>
      ${(d.requests || []).length ? `<div class="card" style="padding:14px 16px;margin-top:12px"><b>Your requests</b>${d.requests.map(r => `<div style="font-size:13px;margin-top:6px">${E((r.at || '').slice(0, 10))} · ${r.type === 'leave' ? 'Leave the club' : 'Change of details'}: <b>${E({ open: 'waiting', done: 'done', applied: 'done', declined: 'declined' }[r.status] || r.status)}</b>${r.note ? ' · ' + E(r.note) : ''}</div>`).join('')}</div>` : ''}`;
  }
  window.mydetailsLoad = load;
  window.myDetailsSave = async () => { const sel = document.querySelector('input[name="md-emails"]:checked'), name = val('md-name'); busy = true; render(); try { d = await api('/api/me/prefs', { ...(sel && !sel.disabled ? { emails: sel.value } : {}), preferredName: name }); say('Saved.'); } catch (e) { say(e.message, true); } busy = false; render(); };   // the form is read BEFORE the redraw, which would reset it
  window.myDetailsAsk = async type => { if (type === 'leave' && !confirm('Ask to leave the club? A volunteer will deal with it.')) return; busy = true; const text = val('md-text'); render(); try { await api('/api/me/request', { type, text }); d = await api('/api/me/details'); say('Sent. A volunteer will deal with it.'); } catch (e) { say(e.message, true); } busy = false; render(); };
})();
