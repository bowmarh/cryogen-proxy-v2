'use strict';
// Members: "My plan". A season-long training plan built from the rider's own FTP: pick the hours a week and (optionally) a goal race date.
(function () {
  let st = null, note = '', busy = false;
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const root = () => document.getElementById('plan-content');
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const x = await r.json().catch(() => ({})); if (!r.ok) throw new Error(x.error || ('HTTP ' + r.status)); return x;
  }
  const say = (m, bad) => { note = m ? `<div role="status" style="margin:8px 0;padding:8px 12px;border-radius:8px;font-size:13px;background:${bad ? 'rgba(248,113,113,.12);color:#fca5a5' : 'rgba(52,211,153,.12);color:#6ee7b7'}">${E(m)}</div>` : ''; };
  const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
  async function load() { const el = root(); if (!el) return; try { st = await api('/api/me/season-plan'); } catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; return; } render(); }
  function weekCard(w, now) { return `<div class="card" style="padding:10px 14px;margin-bottom:8px;${now ? 'border-left:3px solid var(--accent,#22d3ee)' : ''}"><b>Week ${w.week}</b> · ${E(w.date)} · ${E(w.phase)}${w.easy ? ' (easier week)' : ''} · about ${w.hours} h${now ? ' <span style="color:var(--accent,#22d3ee)">· this week</span>' : ''}<div style="font-size:13px;margin-top:4px">${w.sessions.map(s => `<div>${E(s.day)}: ${E(s.name)}, ${s.minutes} min at ${E(s.target)}</div>`).join('')}</div></div>`; }
  function render() {
    const el = root(); if (!el || !st) return; const p = st.plan;
    const form = `<div class="card" style="padding:14px 16px"><b>${p ? 'Build a new plan' : 'Build my season plan'}</b><div style="font-size:12px;color:#9ca3af;margin:4px 0 8px">Targets come from your FTP${st.ftpKnown ? ` (${st.ftpKnown} W from your Zwift profile)` : ''}. A new plan replaces the old one.</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap"><div><label class="lbl" for="pl-ftp">FTP (W)</label><input id="pl-ftp" class="inp" type="number" min="80" max="600" style="width:100px" value="${st.ftpKnown || ''}"/></div><div><label class="lbl" for="pl-hours">Hours a week</label><input id="pl-hours" class="inp" type="number" min="2" max="15" step="0.5" style="width:100px" value="${p ? p.hours : 6}"/></div><div><label class="lbl" for="pl-weeks">Weeks</label><input id="pl-weeks" class="inp" type="number" min="4" max="16" style="width:90px" value="${p ? p.weeks : 12}"/></div><div><label class="lbl" for="pl-goal">Goal race (optional)</label><input id="pl-goal" class="inp" type="date" style="width:160px"/></div></div>
      <div style="margin-top:8px"><button type="button" class="btn-cyan" style="width:auto;padding:6px 16px" ${busy ? 'disabled' : ''} onclick="planBuild()">${busy ? 'Building…' : 'Build the plan'}</button> ${p ? `<button type="button" style="${btn}" onclick="planDelete()">Delete my plan</button>` : ''}</div></div>`;
    el.innerHTML = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">📅 My plan</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:8px">A season-long training plan from your own numbers. You also get each week's sessions as a Monday message.</p>${note}${form}${p ? `<div style="margin-top:12px"><div style="font-size:12px;color:#9ca3af;margin-bottom:6px">FTP ${p.ftp} W · ${p.weeks} weeks from ${E(p.start)}${p.goalDate ? ' · goal race ' + E(p.goalDate) : ''}</div>${p.list.map(w => weekCard(w, st.thisWeek && st.thisWeek.date === w.date)).join('')}</div>` : ''}`;
  }
  window.planLoad = load;
  window.planBuild = async () => { const goal = val('pl-goal'), ftp = Number(val('pl-ftp')), hours = Number(val('pl-hours')), weeks = Number(val('pl-weeks')); busy = true; render(); try { st = await api('/api/me/season-plan', { ftp: ftp || undefined, hours, weeks, goalDate: goal || undefined }); st.ftpKnown = ftp || st.ftpKnown; say('Your plan is ready.'); } catch (e) { say(e.message, true); } busy = false; render(); };   // read BEFORE the redraw
  window.planDelete = async () => { if (!confirm('Delete your plan?')) return; try { await api('/api/me/season-plan/delete', {}); st = await api('/api/me/season-plan'); say('Deleted.'); } catch (e) { say(e.message, true); } render(); };
})();
