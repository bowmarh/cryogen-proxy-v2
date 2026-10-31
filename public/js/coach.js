'use strict';
// Members: the AI coach. A yes is asked for once; the conversation lives in this page only (the last few turns are sent with each question) and a
// FIT file of the rider's own ride is read here in the browser and explained, never stored.
(function () {
  let st = null, chat = [], busy = false, ride = null;
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const root = () => document.getElementById('coach-content');
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  // The coach writes plain text with short lists: shown safely, bullets as bullets.
  function pretty(t) {
    return E(t).split(/\n{2,}/).map(par => { const lines = par.split('\n'); return lines.every(l => /^\s*[-•*]\s+/.test(l)) ? `<ul style="margin:4px 0 4px 18px">${lines.map(l => `<li>${l.replace(/^\s*[-•*]\s+/, '')}</li>`).join('')}</ul>` : `<p style="margin:4px 0">${lines.join('<br>')}</p>`; }).join('');
  }
  async function open() {
    const el = root(); if (!el) return;
    try { st = await api('/api/coach/status'); } catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; return; }
    render();
  }
  function render() {
    const el = root(); if (!el || !st) return;
    const head = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">🧠 AI Coach</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:12px">Training, tactics and pacing from your own numbers.</p>`;
    if (!st.enabled) { el.innerHTML = head + (window.uiEmpty ? `<div class="card">${uiEmpty('🛠️', 'The coach is not switched on yet', 'A club admin needs to switch it on. Check back soon.', '', '')}</div>` : 'Not switched on yet.'); return; }
    if (!st.consent) {
      el.innerHTML = head + `<div class="card" style="padding:16px 18px"><b>Before you start</b><div style="font-size:13px;color:#d1d5db;margin-top:6px">To coach you, the coach reads your numbers from the club roster: your category, FTP, best power per kilo, vELO and the events in your week. It is an AI (Claude, by Anthropic), so these numbers are sent to Anthropic to write the answer.</div>
        <ul style="margin:8px 0 8px 18px;font-size:13px;color:#d1d5db"><li>It never gets your name, your weight or your contact details.</li><li>Your questions are not saved by the club. Only a count of how many you asked today is.</li><li>It is a coach, not a doctor. For pain, dizziness or anything medical, see a professional.</li><li>You can take your yes back at any time.</li></ul>
        <button type="button" class="btn-cyan" style="width:auto;padding:9px 20px;font-size:14px" onclick="coachConsent(true)">Yes, coach me</button></div>`; return;
    }
    const msgs = chat.map(m => `<div style="display:flex;justify-content:${m.role === 'user' ? 'flex-end' : 'flex-start'};margin:6px 0"><div style="max-width:90%;padding:8px 12px;border-radius:12px;font-size:13px;background:${m.role === 'user' ? 'rgba(var(--accent-rgb),.18)' : 'rgba(255,255,255,.06)'}">${m.role === 'user' ? E(m.content) : pretty(m.content)}</div></div>`).join('');
    const chips = ['Plan my week', 'How can I climb better?', 'Tactics for my next race', 'What should I eat before a race?'].map(q => `<button type="button" style="${btn}" onclick="coachAsk('${E(q)}')">${E(q)}</button>`).join(' ');
    const rd = ride ? `<div class="card" style="padding:14px 16px;margin-top:12px"><b>Your ride</b><div style="display:flex;gap:14px;flex-wrap:wrap;margin:8px 0;font-size:13px">${[['Time', ride.minutes + ' min'], ['Average', ride.avgPower + ' W'], ['NP', (ride.normalizedPower || '–') + ' W'], ['Variability', ride.variabilityIndex || '–'], ['20 min best', (ride.bestWatts['1200s'] || '–') + ' W'], ['Heart rate', ride.heartRate.avg ? ride.heartRate.avg + ' bpm' : 'none'], ['Drift', ride.heartRate.decouplingPercent == null ? '–' : ride.heartRate.decouplingPercent + '%']].map(([l, v]) => `<div><div class="lbl" style="margin:0">${l}</div><b>${E(v)}</b></div>`).join('')}</div>
      ${ride.minutesInZones ? `<div style="font-size:12px;color:#9ca3af">Minutes in zones: ${Object.entries(ride.minutesInZones).map(([k, v]) => `${E(k)} ${v}`).join(' · ')}</div>` : ''}</div>` : '';
    el.innerHTML = head + `<div class="card" style="padding:14px 16px"><div style="min-height:80px">${msgs || '<div style="font-size:13px;color:#8b95a5">Ask anything about your training or racing.</div>'}${busy ? '<div style="font-size:12px;color:#8b95a5;margin:6px 0">The coach is thinking…</div>' : ''}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">${chips}</div>
      <div style="display:flex;gap:8px"><input id="coach-q" class="inp" maxlength="700" placeholder="Ask your coach…" onkeydown="if(event.key==='Enter')coachSend()" style="flex:1" aria-label="Your question"/><button type="button" class="btn-cyan" style="width:auto;padding:0 18px" ${busy ? 'disabled' : ''} onclick="coachSend()">Ask</button></div>
      <div style="font-size:11px;color:#8b95a5;margin-top:6px">${st.remaining} of ${st.limit} questions left today · <a href="#" onclick="coachConsent(false);return false">Stop using my numbers</a></div></div>
      <div class="card" style="padding:14px 16px;margin-top:12px"><b>Explain my ride</b><div style="font-size:12px;color:#8b95a5;margin:4px 0 8px">Choose a FIT file from Zwift or your head unit. It is read here in your browser; only the recorded power and heart rate are sent to the coach, and nothing is kept. Counts as one question.</div><input type="file" accept=".fit,application/octet-stream" aria-label="Choose a FIT file" onchange="coachRide(this)"/><div id="coach-ride-msg" role="status" style="font-size:12px;color:#8b95a5;margin-top:6px"></div></div>${rd}`;
    const box = document.getElementById('coach-q'); if (box && !busy) box.focus();
  }
  async function ask(text) {
    if (busy || !text.trim()) return;
    const history = chat.slice(-6); chat.push({ role: 'user', content: text }); busy = true; render();
    try { const d = await api('/api/coach/chat', { message: text, history }); chat.push({ role: 'assistant', content: d.reply || '⚠️ The coach had no answer that time. Please ask again.' }); st = { ...st, remaining: d.remaining }; }
    catch (e) { chat.push({ role: 'assistant', content: '⚠️ ' + e.message }); }
    busy = false; render();
  }
  window.coachOpen = open;
  window.coachSend = () => { const b = document.getElementById('coach-q'); if (b) { const v = b.value; b.value = ''; ask(v); } };
  window.coachAsk = q => ask(q);
  window.coachConsent = async on => { try { st = await api('/api/coach/consent', { on }); if (!on) chat = []; render(); } catch (e) { alert(e.message); } };
  window.coachRide = async input => {
    const f = input.files[0], msg = document.getElementById('coach-ride-msg'); if (!f) return;
    try {
      msg.textContent = 'Reading the file…'; const p = FitParse.parse(await f.arrayBuffer());
      if (p.samples.t.length < 120) throw new Error('That ride is too short to look at.');
      msg.textContent = 'The coach is looking at it…'; busy = true;
      const d = await api('/api/coach/ride', { samples: p.samples, question: '' });
      ride = d.ride; chat.push({ role: 'assistant', content: d.reply }); st = { ...st, remaining: d.remaining };
    } catch (e) { chat.push({ role: 'assistant', content: '⚠️ ' + e.message }); }
    busy = false; render();
  };
})();
