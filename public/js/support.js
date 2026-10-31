'use strict';
// Admin: supporters and what the AI costs. Nothing here takes a payment: a rider pays through the club's own link and the admin adds them.
(function () {
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const btn = 'padding:5px 12px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  let d = null;
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j;
  }
  async function load() {
    const el = document.getElementById('support-card'); if (!el) return;
    try { d = await api('/api/support'); render(); } catch (e) { el.innerHTML = `<span style="color:#f87171">${E(e.message)}</span>`; }
  }
  function render() {
    const el = document.getElementById('support-card'), s = d.settings, m = d.month, priced = m.cost !== null;
    const names = (typeof riders !== 'undefined' ? riders : []).filter(r => r.active).map(r => `<option value="${E(r.name)} (${E(r.id)})"></option>`).join('');
    const f = (id, label, val, extra = '') => `<label style="font-size:12px;color:#9ca3af;display:block">${label}<input id="${id}" class="inp" ${extra} value="${E(val)}" style="margin-top:2px"/></label>`;
    el.innerHTML = `<div style="font-size:12px;margin-bottom:8px">This month: <b>${E(m.answers)}</b> AI answers, ${E(m.tokensIn)} tokens in, ${E(m.tokensOut)} out${priced ? ` · about <b>£${E(m.cost)}</b>${s.budget ? ` of a £${E(s.budget)} budget` : ''}` : ' · <span style="color:#FBBF24">enter the token prices below to see the cost and use a budget</span>'}. Supporters: <b>${E(d.supporters.filter(x => x.active).length)}</b> · about <b>£${E(d.income)}</b> a month.</div>
      <details style="margin-bottom:8px"><summary style="cursor:pointer;font-size:12px;color:#9ca3af">Settings</summary><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:8px">
        ${f('sp-url', 'Payment link (https://…)', s.payUrl)}${f('sp-price', 'Supporter price per month (£)', s.price, 'type="number" min="0" step="0.5"')}${f('sp-free', 'Free questions a week', s.freeWeekly, 'type="number" min="0" max="50"')}${f('sp-sup', 'Supporter questions a day', s.supporterDaily, 'type="number" min="1" max="100"')}${f('sp-rides', 'Free rides explained a month', s.freeRides, 'type="number" min="0" max="10"')}
        ${f('sp-budget', 'Monthly AI budget (£, 0 = none)', s.budget, 'type="number" min="0" step="1"')}${f('sp-in', 'Price per million tokens in (£)', s.inPrice, 'type="number" min="0" step="0.01"')}${f('sp-out', 'Price per million tokens out (£)', s.outPrice, 'type="number" min="0" step="0.01"')}</div>
        <label style="font-size:12px;display:block;margin-top:8px"><input id="sp-share" type="checkbox" ${s.shareCost ? 'checked' : ''}/> Show members what the coach costs and what supporters give</label>
        <div style="font-size:11px;color:#8b95a5;margin-top:4px">Get the token prices from your Anthropic account for the model in use. Past the budget the free coach rests; at one and a half times the budget it rests for everyone, until next month.</div>
        <button type="button" style="${btn};margin-top:8px" onclick="supSave()">Save settings</button> <span id="sp-msg" role="status" style="font-size:12px;color:#8b95a5"></span></details>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"><input id="sp-rider" list="sp-riders" class="inp" placeholder="Add a supporter (type a name)" style="flex:1;min-width:180px"/><datalist id="sp-riders">${names}</datalist><input id="sp-until" type="date" class="inp" aria-label="Supporter until (optional)" style="width:auto"/><button type="button" style="${btn}" onclick="supAdd()">Add</button></div>
      ${d.supporters.length ? `<div style="font-size:12px">${d.supporters.map(x => `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-top:1px solid rgba(255,255,255,.06);opacity:${x.active ? 1 : .5}"><span>⭐ ${E(x.name)}${x.until ? ` · until ${E(x.until)}${x.active ? '' : ' (ended)'}` : ''}${x.note ? ` · ${E(x.note)}` : ''}</span><button type="button" style="${btn};padding:2px 8px" onclick="supRemove('${E(x.zwid)}')">Remove</button></div>`).join('')}</div>` : '<div style="font-size:12px;color:#8b95a5">No supporters yet. When someone pays through your link, add them here.</div>'}`;
  }
  const v = id => document.getElementById(id).value;
  window.supLoad = load;
  window.supSave = async () => {
    const msg = document.getElementById('sp-msg');
    try { await api('/api/support/settings', { payUrl: v('sp-url').trim(), price: v('sp-price'), freeWeekly: v('sp-free'), supporterDaily: v('sp-sup'), freeRides: v('sp-rides'), budget: v('sp-budget'), inPrice: v('sp-in'), outPrice: v('sp-out'), shareCost: document.getElementById('sp-share').checked }); await load(); const m2 = document.getElementById('sp-msg'); if (m2) m2.textContent = 'Saved.'; }
    catch (e) { msg.textContent = e.message; }
  };
  window.supAdd = async () => {
    const raw = v('sp-rider'), m = /\((\d+)\)\s*$/.exec(raw) || /^(\d+)$/.exec(raw.trim());
    if (!m) { alert('Choose a rider from the list.'); return; }
    try { await api('/api/support/add', { zwid: m[1], until: v('sp-until') }); await load(); } catch (e) { alert(e.message); }
  };
  window.supRemove = async z => { if (!confirm('Remove this supporter?')) return; try { await api('/api/support/remove', { zwid: z }); await load(); } catch (e) { alert(e.message); } };
})();
