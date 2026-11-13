'use strict';
// Sign-in security screens: the authenticator code step, authenticator set-up (QR + typed key + recovery codes), forced password change,
// forgot/reset password, and the Control room "Security" tab. The server does the checking; these screens only collect and show.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const box = () => document.getElementById('login-form-auth');
  const err = m => { const el = document.getElementById('auth-err'); if (el) { el.textContent = m || ''; el.style.display = m ? 'block' : 'none'; } };
  const hdr = tok => ({ 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) });
  async function call(path, body, tok) {
    let r; try { r = await fetch(path, body === undefined ? { headers: hdr(tok) } : { method: 'POST', headers: hdr(tok), body: JSON.stringify(body) }); } catch (e) { throw new Error('Could not reach the server.'); }
    const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || ('Request failed (' + r.status + ')')); return d;
  }
  function show(html) {
    ['login-step1'].forEach(i => { const e = document.getElementById(i); if (e) e.style.display = 'none'; });
    document.getElementById('login-step2').style.display = 'block';
    ['owner', 'admin', 'mod', 'user', 'member'].forEach(t => { const e = document.getElementById('login-form-' + t); if (e) e.style.display = 'none'; });
    const b = box(); b.style.display = 'block'; b.innerHTML = html + '<div id="auth-err" role="alert" style="margin-top:10px;font-size:12px;color:#f87171;display:none"></div>';
    const le = document.getElementById('login-err'); if (le) le.style.display = 'none';
    const f = b.querySelector('input'); if (f) setTimeout(() => f.focus(), 30);
  }
  const lbl = t => `<label class="lbl">${t}</label>`, inp = (id, extra) => `<input id="${id}" class="inp" style="margin-bottom:10px" ${extra || ''}/>`;
  const done = (d, finish) => { window.authGate(d, finish); };

  // Entry point after the password step. `finish(d)` signs in (stores the token, opens the app).
  window.authGate = function (d, finish) {
    if (d.twoFactor) return codeStep(d.challenge, finish);
    if (d.needsSetup) return setupStep(d.challenge, finish);
    if (d.token && d.mustChange) return changeStep(d, finish);
    finish(d);
  };

  function codeStep(challenge, finish) {
    show(`<div style="font-size:15px;font-weight:800;margin-bottom:6px">Enter your authenticator code</div><div style="font-size:12px;color:#9ca3af;margin-bottom:12px">Open your authenticator app and type the 6 digits for CRYO-GEN. Lost your phone? Use one of your recovery codes instead.</div>${lbl('Code')}${inp('auth-code', 'inputmode="text" autocomplete="one-time-code" placeholder="123456"')}<button class="btn-cyan" id="auth-go">Continue</button>`);
    const go = async () => { err(''); try { const d = await call('/api/auth/2fa', { challenge, code: document.getElementById('auth-code').value.trim() }); if (d.recoveryLeft != null && d.recoveryLeft < 3) alert('You have ' + d.recoveryLeft + ' recovery code(s) left. Make new ones under Control room → Security.'); finish(d); } catch (e) { err(e.message); } };
    document.getElementById('auth-go').onclick = go; document.getElementById('auth-code').onkeydown = e => { if (e.key === 'Enter') go(); };
  }

  async function setupStep(challenge, finish) { enrol({ challenge }, finish, true); }

  // Shared set-up screen: used at sign-in (body = { challenge }) and from the Security tab (token).
  async function enrol(ctx, finish, atLogin, tok, into) {
    let s; try { s = await call('/api/auth/totp/setup', ctx.challenge ? { challenge: ctx.challenge } : {}, tok); } catch (e) { if (atLogin) { show('<div style="font-size:13px">Could not start set-up.</div>'); err(e.message); } else alert(e.message); return; }
    const html = `<div style="font-size:15px;font-weight:800;margin-bottom:6px">Set up your authenticator app</div><ol style="font-size:12px;color:#9ca3af;margin:0 0 10px 18px;line-height:1.6"><li>Install an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).</li><li>Scan this code, or type the key below.</li><li>Type the 6-digit code it shows.</li></ol><div style="background:#fff;border-radius:10px;padding:8px;width:200px;margin:0 auto 8px" role="img" aria-label="QR code for your authenticator app">${s.svg}</div><div style="text-align:center;font-family:monospace;font-size:13px;letter-spacing:1px;margin-bottom:12px;word-break:break-all" aria-label="Setup key">${E(s.secret)}</div>${lbl('6-digit code')}${inp('auth-code', 'inputmode="numeric" autocomplete="one-time-code" placeholder="123456"')}<button class="btn-cyan" id="auth-go">Turn on</button>`;
    if (atLogin) show(html); else into.innerHTML = html + '<div id="auth-err" role="alert" style="margin-top:10px;font-size:12px;color:#f87171;display:none"></div>';
    const go = async () => { err(''); try { const d = await call('/api/auth/totp/enable', { ...(ctx.challenge ? { challenge: ctx.challenge } : {}), code: document.getElementById('auth-code').value.trim() }, tok); recoveryStep(d, () => finish(d), atLogin, into); } catch (e) { err(e.message); } };
    document.getElementById('auth-go').onclick = go; document.getElementById('auth-code').onkeydown = e => { if (e.key === 'Enter') go(); };
  }
  function recoveryStep(d, next, atLogin, into) {
    const html = `<div style="font-size:15px;font-weight:800;margin-bottom:6px">Save your recovery codes</div><div style="font-size:12px;color:#9ca3af;margin-bottom:10px">Each code works once if you lose your phone. They are shown only now: store them somewhere safe (a password manager, or print them).</div><pre id="auth-rc" style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;font-size:14px;line-height:1.7;text-align:center;user-select:all">${(d.recoveryCodes || []).map(E).join('\n')}</pre><div style="display:flex;gap:8px"><button class="btn-cyan" id="auth-copy" style="flex:1">Copy</button><button class="btn-cyan" id="auth-ok" style="flex:1">I have saved them</button></div>`;
    if (atLogin) show(html); else into.innerHTML = html;
    document.getElementById('auth-copy').onclick = () => { try { navigator.clipboard.writeText((d.recoveryCodes || []).join('\n')); } catch (e) {} };
    document.getElementById('auth-ok').onclick = next;
  }

  function changeStep(d, finish) {
    show(`<div style="font-size:15px;font-weight:800;margin-bottom:6px">Choose your own password</div><div style="font-size:12px;color:#9ca3af;margin-bottom:12px">Your password was set by the owner. Pick a new one (at least 10 characters) before you continue.</div>${lbl('Current password')}${inp('auth-cur', 'type="password" autocomplete="current-password"')}${lbl('New password')}${inp('auth-new', 'type="password" autocomplete="new-password"')}<button class="btn-cyan" id="auth-go">Save and continue</button>`);
    document.getElementById('auth-go').onclick = async () => { err(''); try { const r = await call('/api/auth/password', { current: document.getElementById('auth-cur').value, next: document.getElementById('auth-new').value }, d.token); finish({ ...d, token: r.token || d.token, mustChange: false }); } catch (e) { err(e.message); } };
  }

  // Forgot / reset (staff with a personal login).
  window.authForgot = function () {
    show(`<div style="font-size:15px;font-weight:800;margin-bottom:6px">Forgot your password?</div><div style="font-size:12px;color:#9ca3af;margin-bottom:12px">Staff with a personal login: enter your username and we email a reset link to the address on your account. No address on file, or you use the shared Administrator or Moderator password? Ask the owner. The owner's password is changed in Vercel (OWNER_PASSWORD).</div>${lbl('Your staff username')}${inp('auth-user', 'autocomplete="username"')}<button class="btn-cyan" id="auth-go">Send reset link</button><a href="#" id="auth-back" style="display:block;margin-top:10px;font-size:12px;color:#8b95a5">← Back to sign in</a>`);
    document.getElementById('auth-back').onclick = e => { e.preventDefault(); location.href = location.pathname; };
    document.getElementById('auth-go').onclick = async () => { err(''); try { const r = await call('/api/auth/forgot', { username: document.getElementById('auth-user').value.trim() }); box().innerHTML = `<div style="font-size:13px;line-height:1.5">${E(r.message)}</div><a href="${location.pathname}" style="display:block;margin-top:12px;font-size:12px;color:#8b95a5">← Back to sign in</a>`; } catch (e) { err(e.message); } };
  };
  function resetStep(token) {
    show(`<div style="font-size:15px;font-weight:800;margin-bottom:6px">Choose a new password</div>${lbl('New password (at least 10 characters)')}${inp('auth-new', 'type="password" autocomplete="new-password"')}${lbl('Authenticator code (only if you use one)')}${inp('auth-code', 'inputmode="numeric" autocomplete="one-time-code"')}<button class="btn-cyan" id="auth-go">Save password</button>`);
    document.getElementById('auth-go').onclick = async () => { err(''); try { await call('/api/auth/reset', { token, password: document.getElementById('auth-new').value, code: document.getElementById('auth-code').value.trim() }); box().innerHTML = `<div style="font-size:13px;line-height:1.5">Your password is changed. You can sign in now.</div><a href="${location.pathname}" style="display:block;margin-top:12px;font-size:13px;color:#22d3ee">Go to sign in →</a>`; } catch (e) { err(e.message); } };
  }
  document.addEventListener('DOMContentLoaded', () => { const t = new URLSearchParams(location.search).get('reset'); if (t && box()) resetStep(t); });

  // ── Control room → Security (owner and staff see their own card; the owner also gets the accounts table and the rules) ──
  let sec = null, ov = null, st = null, panel = '', msg = '', recovery = null;
  const tok = () => sessionStorage.getItem('token');
  const btn = 'padding:6px 14px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  const isOwner = () => typeof role !== 'undefined' && role === 'admin' && sessionStorage.getItem('owner') === '1';
  const root = () => document.getElementById('sec-root');
  const say = (m, bad) => { msg = m ? `<div role="status" style="font-size:12px;margin:8px 0;color:${bad ? '#fca5a5' : '#6ee7b7'}">${E(m)}</div>` : ''; };
  async function load() { try { sec = await call('/api/auth/security', undefined, tok()); } catch (e) { sec = null; say(e.message, true); } if (isOwner()) { try { ov = await call('/api/auth/overview', undefined, tok()); } catch (e) { ov = null; } } draw(); }
  // Is it safe to retire the shared passwords? Says who still relies on them and what is missing, in plain words.
  function readiness(o) {
    const us = o.users || [], adm = us.filter(u => u.role === 'admin'), mod = us.filter(u => u.role === 'mod'), noMfa = us.filter(u => !u.twofa), noMail = us.filter(u => !u.email), must = us.filter(u => u.mustChange);
    const row = (ok, t) => `<div style="font-size:12px;margin:2px 0;color:${ok ? '#6ee7b7' : '#fcd34d'}">${ok ? '✅' : '⚠️'} ${t}</div>`;
    const sh = { admin: !((o.settings || {}).blockShared || {}).admin, mod: !((o.settings || {}).blockShared || {}).mod };
    return `<div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.04)"><b style="font-size:12px">Ready to retire the shared passwords?</b>${row(adm.length > 0, adm.length ? `${adm.length} personal Administrator account${adm.length === 1 ? '' : 's'}` : 'No personal Administrator account yet (add one under Access first)')}${row(!us.length || !noMfa.length, !us.length ? 'No personal accounts yet' : noMfa.length ? `${noMfa.length} account${noMfa.length === 1 ? '' : 's'} without an authenticator: ${noMfa.map(u => E(u.username)).join(', ')}` : 'Every personal account has an authenticator')}${row(!noMail.length, noMail.length ? `${noMail.length} without an email address, so they cannot use "Forgot your password?": ${noMail.map(u => E(u.username)).join(', ')}` : 'Every personal account has an email address')}${must.length ? row(false, `${must.length} still on the temporary password: ${must.map(u => E(u.username)).join(', ')}`) : ''}<div style="font-size:11px;color:#8b95a5;margin-top:4px">Shared passwords in use: Administrator ${sh.admin ? 'on' : 'off'}, Moderator ${sh.mod ? 'on' : 'off'}${mod.length ? ` · ${mod.length} personal moderator${mod.length === 1 ? '' : 's'}` : ''}. The owner password always works, so you cannot lock yourself out.</div></div>`;
  }
  function draw() {
    const el = root(); if (!el) return; if (!sec) { el.innerHTML = msg || 'Could not load.'; return; }
    const t = sec.totp || {};
    let h = `<div class="card" style="padding:14px 16px;margin-top:8px"><b>Your sign-in security</b> <span style="font-size:12px;color:#9ca3af">${E(sec.level)}${sec.username ? ' · ' + E(sec.username) : ''}</span>`;
    if (sec.kind === 'shared') h += `<div style="font-size:12px;color:#9ca3af;margin:6px 0">You sign in with the shared ${E(sec.level)} password, which cannot have an authenticator or be changed here (the owner changes it in Vercel). Ask the owner for a personal login to get both.</div>`;
    else {
      h += `<div style="font-size:13px;margin:8px 0">Authenticator app: <b style="color:${t.enabled ? '#6ee7b7' : '#fcd34d'}">${t.enabled ? 'on' : 'off'}</b>${t.enabled ? ` · ${t.recoveryLeft} recovery code(s) left` : ''}${sec.owner2faBypass ? ' · <span style="color:#fca5a5">break-glass is ON: codes are skipped (OWNER_2FA_OFF)</span>' : ''}</div>`;
      if (panel === 'setup') h += '<div id="sec-panel" style="max-width:360px"></div>';
      else if (recovery) h += `<pre style="background:rgba(255,255,255,0.05);border-radius:8px;padding:10px;font-size:14px;line-height:1.7;user-select:all;max-width:240px">${recovery.map(E).join('\n')}</pre><div style="font-size:12px;color:#9ca3af">Shown only now. Save them, then <a href="#" onclick="authSecDone();return false" style="color:#22d3ee">close</a>.</div>`;
      else if (!t.enabled) h += `<button type="button" style="${btn}" onclick="authSecSetup()">Set up an authenticator app</button>`;
      else h += `<input id="sec-code" class="inp" placeholder="Current 6-digit code" inputmode="numeric" style="max-width:200px;margin-bottom:8px"/><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" style="${btn}" onclick="authSecRecovery()">New recovery codes</button>${sec.require2fa ? '' : `<button type="button" style="${btn}" onclick="authSecDisable()">Turn off</button>`}</div>`;
      h += `<div style="margin-top:12px"><button type="button" style="${btn}" onclick="authSecSignOutAll()">Sign out everywhere</button> <span style="font-size:11px;color:#8b95a5">Ends every session of yours on every device, this one included.</span></div>`;
      if (sec.canChangePassword) h += `<div style="margin-top:14px;border-top:1px solid rgba(255,255,255,0.08);padding-top:10px"><b style="font-size:13px">Change my password</b><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><input id="sec-cur" type="password" class="inp" placeholder="Current" autocomplete="current-password" style="max-width:180px"/><input id="sec-new" type="password" class="inp" placeholder="New (10+ characters)" autocomplete="new-password" style="max-width:200px"/><button type="button" style="${btn}" onclick="authSecPassword()">Change</button></div></div>`;
    }
    h += '</div>';
    if (isOwner() && ov) {
      const s = ov.settings || {};
      h += `<div class="card" style="padding:14px 16px;margin-top:10px"><b>Sign-in rules</b> <span style="font-size:12px;color:#9ca3af">Owner only</span><div style="margin:8px 0;font-size:13px"><label style="display:block;margin-bottom:6px"><input type="checkbox" id="sec-req" ${s.requireStaff2fa ? 'checked' : ''} onchange="authSecRules()"/> Personal staff logins must use an authenticator app</label><label style="display:block;margin-bottom:6px"><input type="checkbox" id="sec-badm" ${s.blockShared && s.blockShared.admin ? 'checked' : ''} onchange="authSecRules()"/> Switch off the shared Administrator password</label><label style="display:block"><input type="checkbox" id="sec-bmod" ${s.blockShared && s.blockShared.mod ? 'checked' : ''} onchange="authSecRules()"/> Switch off the shared Moderator password</label></div>${readiness(ov)}<div style="font-size:11px;color:#8b95a5;margin-top:6px">Locked out as owner? Change OWNER_PASSWORD in Vercel (signs the owner out everywhere), or set OWNER_2FA_OFF=1 for one sign-in and remove it after.</div></div>`;
      h += `<div class="card" style="padding:14px 16px;margin-top:10px"><b>Staff accounts</b><div style="overflow-x:auto"><table style="width:100%;font-size:12px;border-collapse:collapse;margin-top:8px"><thead><tr style="text-align:left;color:#9ca3af"><th scope="col" style="padding:4px">Name</th><th scope="col">Role</th><th scope="col">Email</th><th scope="col">Authenticator</th><th scope="col">Actions</th></tr></thead><tbody>${(ov.users || []).map(u => `<tr style="border-top:1px solid rgba(255,255,255,0.06)"><td style="padding:6px 4px">${E(u.name)}<div style="color:#8b95a5">${E(u.username)}${u.mustChange ? ' · must change password' : ''}</div></td><td>${E(u.role)}</td><td><input aria-label="Email for ${E(u.username)}" class="inp" style="min-width:160px;padding:4px 6px;font-size:12px" value="${E(u.email)}" onchange="authSecEmail('${E(u.username)}',this.value)"/></td><td>${u.twofa ? '✅ on' : 'off'}</td><td style="white-space:nowrap"><button type="button" style="${btn}" onclick="authSecReset('${E(u.username)}')">Reset password</button> ${u.twofa ? `<button type="button" style="${btn}" onclick="authSecReset2fa('${E(u.username)}')">Reset authenticator</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" style="padding:8px;color:#9ca3af">No personal staff accounts yet. Add them under Control room → Access.</td></tr>'}</tbody></table></div></div>`;
    }
    el.innerHTML = h + msg; msg = '';
    if (panel === 'setup') enrol({}, () => { panel = ''; recovery = null; say('Authenticator turned on.'); load(); }, false, tok(), document.getElementById('sec-panel'));
  }
  const act = async (fn, ok) => { try { const r = await fn(); say(ok || 'Done.'); return r; } catch (e) { say(e.message, true); } finally { await load(); } };
  window.authSecurityMount = () => { load(); };
  window.authSecSetup = () => { panel = 'setup'; draw(); };
  window.authSecDone = () => { recovery = null; draw(); };
  window.authSecRecovery = () => act(async () => { const r = await call('/api/auth/totp/recovery', { code: document.getElementById('sec-code').value.trim() }, tok()); recovery = r.recoveryCodes; return r; }, 'New recovery codes made; the old ones no longer work.');
  window.authSecDisable = () => { if (!confirm('Turn the authenticator off for your account?')) return; act(() => call('/api/auth/totp/disable', { code: document.getElementById('sec-code').value.trim() }, tok()), 'Authenticator turned off.'); };
  window.authSecPassword = () => act(async () => { const r = await call('/api/auth/password', { current: document.getElementById('sec-cur').value, next: document.getElementById('sec-new').value }, tok()); if (r.token) sessionStorage.setItem('token', r.token); }, 'Password changed.');
  window.authSecSignOutAll = async () => { if (!confirm('Sign out of every device, including this one?')) return; try { await call('/api/auth/signout-all', {}, tok()); } catch (e) { say(e.message, true); draw(); return; } sessionStorage.clear(); location.reload(); };
  window.authSecRules = () => act(() => call('/api/auth/settings', { requireStaff2fa: document.getElementById('sec-req').checked, blockShared: { admin: document.getElementById('sec-badm').checked, mod: document.getElementById('sec-bmod').checked } }, tok()), 'Rules saved.');
  window.authSecEmail = (u, v) => act(() => call('/api/auth/admin/email', { username: u, email: v }, tok()), 'Email saved.');
  window.authSecReset = u => { if (!confirm('Reset the password for ' + u + '? They must choose a new one at their next sign-in.')) return; act(async () => { const r = await call('/api/auth/admin/reset-password', { username: u }, tok()); prompt('Temporary password for ' + u + ' (give it to them privately; shown once):', r.temporaryPassword); }, 'Password reset.'); };
  window.authSecReset2fa = u => { if (!confirm('Reset the authenticator for ' + u + '? They can set up a new one at their next sign-in.')) return; act(() => call('/api/auth/admin/reset-2fa', { username: u }, tok()), 'Authenticator reset.'); };
})();
