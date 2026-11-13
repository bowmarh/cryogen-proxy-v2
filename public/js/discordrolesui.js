'use strict';
// Staff: Discord Full / Associate roles follow the membership level on cryogen.team. Preview, apply (administrators) and the automatic switch.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const btn = 'padding:6px 12px;font-size:12px;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#e5e7eb;cursor:pointer';
  const admin = () => sessionStorage.getItem('role') === 'admin';
  function html(d) {
    const head = '<div class="lbl">Discord roles: Full and Associate follow cryogen.team</div>';
    if (!d.configured) return `<div class="card" style="padding:14px 16px;margin:14px 0">${head}<p style="font-size:13px;margin-top:6px">Not set up yet. Add these in Vercel → Settings → Environment Variables, then redeploy: <b>${d.missing.map(E).join(', ')}</b>.</p>
      <ol style="font-size:12px;color:#8b95a5;margin:6px 0 0 18px;line-height:1.6"><li>In Discord turn on Developer Mode (User Settings → Advanced).</li><li>Server Settings → Roles: right-click the Full member role → Copy Role ID → <code>DISCORD_ROLE_FULL</code>; the same for the Associate role → <code>DISCORD_ROLE_ASSOCIATE</code>.</li><li>Give the bot's role <b>Manage Roles</b> and drag it <b>above</b> both roles.</li></ol></div>`;
    const rows = d.changes.map(c => `<tr><td>${E(c.name)}</td><td>${E(c.status)} · ${E(c.tier)}</td><td><b>${E(c.summary)}</b></td></tr>`).join('');
    const last = d.last ? `Last run ${E(d.last.at.slice(0, 16).replace('T', ' '))} (${E(d.last.by)}): ${d.last.done} updated${d.last.failed.length ? `, <span style="color:#f87171">${d.last.failed.length} failed: ${E(d.last.failed[0].error)}</span>` : ''}.` : 'Not run yet.';
    return `<div class="card" style="padding:14px 16px;margin:14px 0">${head}
      <p style="font-size:12px;color:#8b95a5;margin:4px 0 8px">Active full members get the Full role, active associates the Associate role, and people who left or are suspended lose both. Only riders with a verified Discord link are touched, and no other role is changed. ${d.linked} verified link${d.linked === 1 ? '' : 's'}${d.notInServer.length ? `; ${d.notInServer.length} linked rider${d.notInServer.length === 1 ? ' is' : 's are'} not in the Discord server` : ''}. ${last}</p>
      ${d.changes.length ? `<div style="overflow-x:auto;max-height:360px"><table><thead><tr><th>Member</th><th>On cryogen.team</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p style="font-size:13px">Everyone\'s roles already match. ✅</p>'}
      ${admin() ? `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:10px">${d.changes.length ? `<button style="${btn}" onclick="dRolesApply(this)">Apply ${d.changes.length} change${d.changes.length === 1 ? '' : 's'}</button>` : ''}
        <label style="font-size:12px"><input type="checkbox" ${d.settings.auto ? 'checked' : ''} onchange="dRolesAuto(this.checked)"> Keep roles in step automatically (daily, and whenever cryogen.team reports a change)</label><span class="dr-msg" style="font-size:12px;color:#8b95a5"></span></div>` : '<p style="font-size:12px;color:#8b95a5">An administrator applies the changes.</p>'}</div>`;
  }
  async function call(path, body) { const r = await fetch(path, body ? { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { headers: tttHeaders() }); const d = await r.json(); if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }
  async function load() {
    const el = document.getElementById('droles-content'); if (!el) return;
    try { el.innerHTML = html(await call('/api/discord/roles')); } catch (e) { el.innerHTML = `<div class="card" style="padding:14px 16px;margin:14px 0;color:#f87171">Discord roles: ${E(e.message)}</div>`; }
  }
  window.dRolesApply = async b => { if (!confirm('Apply these Discord role changes now?')) return; b.disabled = true; try { const r = await call('/api/discord/roles/apply', {}); await load(); const m = document.querySelector('#droles-content .dr-msg'); if (m) m.textContent = `${r.done} updated${r.failed.length ? `, ${r.failed.length} failed` : ''}${r.left ? `; ${r.left} more on the next run` : ''}.`; } catch (e) { alert(e.message); b.disabled = false; } };
  window.dRolesAuto = async on => { try { await call('/api/discord/roles/settings', { auto: on }); } catch (e) { alert(e.message); } load(); };
  window.DiscordRolesUI = { load };
})();
