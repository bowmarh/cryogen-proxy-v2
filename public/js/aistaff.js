'use strict';
// Staff: the AI helpers on the This week page (weekly report, quiet-rider drafts, the club story) and the line-up review button.
// Everything it returns is a draft or a suggestion for a person to read; nothing is sent or changed from here.
(function () {
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const btn = 'padding:5px 12px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  let report = null, quiet = null, aiOn = false, story = '', drafts = {}, busy = '';
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d;
  }
  async function load(el) {
    if (!el) return;
    try { const [r, q] = await Promise.all([api('/api/ai/report'), api('/api/ai/drift')]); report = r.report; aiOn = r.aiOn; quiet = q.quiet; } catch (e) { el.innerHTML = ''; return; }
    render();
  }
  function render() {
    const el = document.getElementById('staff-ai'); if (!el) return;
    const rep = report ? `<div style="white-space:pre-wrap;font-size:13px;margin-top:6px">${E(report.text)}</div><div style="font-size:11px;color:#8b95a5;margin-top:3px">Written ${E(report.at.slice(0, 16).replace('T', ' '))} by ${E(report.by)}${report.via === 'plain' ? ' (a plain summary: the AI was off)' : ''}</div>` : '<div style="font-size:12px;color:#8b95a5;margin-top:6px">No report yet. One is written every Monday morning and posted to the admin channel.</div>';
    const q = (quiet || []).slice(0, 8).map(m => `<div style="padding:5px 0;border-top:1px solid rgba(255,255,255,.06)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13px"><span>${E(m.name)} <span style="color:#8b95a5">· ${Math.round(m.days / 7)} weeks since a race</span></span><button type="button" style="${btn}" ${aiOn && busy !== m.zwid ? '' : 'disabled'} onclick="aiDraft('${E(m.zwid)}')">${busy === m.zwid ? 'Writing…' : 'Draft a message'}</button></div>${drafts[m.zwid] ? `<textarea class="inp" rows="4" style="margin-top:6px" aria-label="Draft message for ${E(m.name)}">${E(drafts[m.zwid])}</textarea><div style="font-size:11px;color:#8b95a5">A draft: change it, then send it yourself.</div>` : ''}</div>`).join('');
    el.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:16px"><div style="font-weight:800;margin-bottom:6px">🤖 AI help for the staff <span style="font-size:11px;font-weight:600;color:#8b95a5">drafts and suggestions only</span></div>${aiOn ? '' : '<div style="font-size:12px;color:#FBBF24;margin-bottom:6px">The AI is off (no ANTHROPIC_API_KEY). The report still works as a plain summary.</div>'}
      <div class="lbl">Weekly report</div>${rep}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button type="button" style="${btn}" ${busy === 'report' ? 'disabled' : ''} onclick="aiReport(false)">${busy === 'report' ? 'Writing…' : 'Write it now'}</button><button type="button" style="${btn}" ${busy === 'report' ? 'disabled' : ''} onclick="aiReport(true)">Write it and post to Discord</button></div>
      <div class="lbl" style="margin-top:12px">Riders who have gone quiet</div>${q || '<div style="font-size:12px;color:#8b95a5">Nobody has gone quiet.</div>'}
      <div class="lbl" style="margin-top:12px">The club's story so far</div><button type="button" style="${btn}" ${aiOn && busy !== 'story' ? '' : 'disabled'} onclick="aiStory()">${busy === 'story' ? 'Writing…' : '📖 Write the story'}</button>${story ? `<textarea class="inp" rows="7" style="margin-top:6px" aria-label="The club story">${E(story)}</textarea>` : ''}</div>`;
  }
  window.uiStaffAi = load;
  window.aiReport = async post => { busy = 'report'; render(); try { report = (await api('/api/ai/report', { post })).report; } catch (e) { alert(e.message); } busy = ''; render(); };
  window.aiDraft = async z => { busy = z; render(); try { drafts[z] = (await api('/api/ai/drift', { zwid: z })).draft; } catch (e) { alert(e.message); } busy = ''; render(); };
  window.aiStory = async () => { busy = 'story'; render(); try { story = (await api('/api/ai/club-story', {})).text; } catch (e) { alert(e.message); } busy = ''; render(); };
  // A second opinion on one team's line-up for one race: shown under the line-up; nothing is changed.
  window.aiLineup = async (team, week, btnEl) => {
    const box = document.getElementById(`zl-ai-${team}-${week}`); if (!box) return;
    box.innerHTML = '<span style="font-size:12px;color:#8b95a5">Looking at the line-up…</span>'; if (btnEl) btnEl.disabled = true;
    try {
      const r = await api('/api/ai/lineup-review', { team, week });
      box.innerHTML = `<div style="font-size:12px;padding:8px 10px;border-radius:8px;background:rgba(var(--accent-rgb),.08);margin-top:6px"><b>🤖 Second opinion</b><div style="margin-top:4px">${E(r.explanation)}</div>${r.swaps.map(s => `<div style="margin-top:4px">↔ <b>${E(s.out)}</b> for <b>${E(s.in)}</b>: ${E(s.why)}</div>`).join('')}${r.risks.length ? `<div style="margin-top:4px;color:#FBBF24">Watch: ${r.risks.map(E).join(' · ')}</div>` : ''}<div style="margin-top:4px;color:#8b95a5">${E(r.note)}</div></div>`;
    } catch (e) { box.innerHTML = `<span style="font-size:12px;color:#f87171">${E(e.message)}</span>`; }
    if (btnEl) btnEl.disabled = false;
  };
})();
