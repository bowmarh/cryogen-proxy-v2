'use strict';
// Staff: the Comms Studio (read, change and approve the posts the club has drafted, then send them to the platforms). Riders: the "OK to feature me" choice.
(function () {
  const E = s => (typeof esc === 'function' ? esc(s) : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const btn = 'padding:5px 12px;font-size:12px;background:rgba(255,255,255,0.05);color:#e5e7eb;border:1px solid rgba(255,255,255,0.18);border-radius:6px;cursor:pointer';
  let d = null, busy = '', open = {};
  const hdr = () => ({ ...tttHeaders(), 'Content-Type': 'application/json' });
  async function api(path, body) {
    const r = await fetch(path, body === undefined ? { headers: tttHeaders() } : { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j;
  }
  const root = () => document.getElementById('studio-content');
  async function load() {
    const el = root(); if (!el) return;
    try { d = await api('/api/studio'); render(); } catch (e) { el.innerHTML = `<div class="card" style="padding:20px;color:#f87171">${E(e.message)}</div>`; }
  }
  const APP = ['discord', 'website', 'telegram', 'bluesky', 'facebook', 'instagram', 'hook'];
  const NAMES = { discord: 'Discord', website: 'Website', telegram: 'Telegram', bluesky: 'Bluesky', facebook: 'Facebook', instagram: 'Instagram', hook: 'Zapier / Make', whatsapp: 'WhatsApp', strava: 'Strava', email: 'Email' };
  const text = (p, c) => (c === 'website' ? p.variants.website.title + '\n\n' + p.variants.website.body : c === 'email' ? p.variants.email.subject + '\n\n' + p.variants.email.body : p.variants[c] || '');

  function settingsBox() {
    const s = d.settings, chk = (name, on, label) => `<label style="font-size:12px;margin-right:12px"><input type="checkbox" data-s="${name}" ${on ? 'checked' : ''}/> ${E(label)}</label>`;
    return `<details class="card" style="padding:10px 16px;margin-bottom:12px"><summary style="cursor:pointer;font-size:13px">⚙️ Settings ${s.paused ? '<b style="color:#FBBF24">· paused</b>' : !s.enabled ? '<b style="color:#FBBF24">· automatic drafting is off: open this and tick the first box to switch it on</b>' : ''}</summary>
      <div style="margin-top:8px;display:grid;gap:8px"><label style="font-size:12px;color:#9ca3af">The club's voice<textarea id="st-voice" class="inp" rows="2" maxlength="400">${E(s.voice)}</textarea></label>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px"><label style="font-size:12px;color:#9ca3af">Hashtags<input id="st-tags" class="inp" value="${E(s.hashtags)}"/></label><label style="font-size:12px;color:#9ca3af">Posts a day per platform<input id="st-limit" class="inp" type="number" min="1" max="20" value="${E(s.dailyLimit)}"/></label>
      <label style="font-size:12px;color:#9ca3af">Website posts are<select id="st-web" class="inp"><option value="draft" ${s.websiteStatus === 'draft' ? 'selected' : ''}>saved as a draft</option><option value="publish" ${s.websiteStatus === 'publish' ? 'selected' : ''}>published at once</option></select></label>
      <label style="font-size:12px;color:#9ca3af">Strava club address<input id="st-strava" class="inp" placeholder="https://www.strava.com/clubs/…" value="${E(s.stravaUrl)}"/></label></div>
      <div><div class="lbl">Post these kinds automatically, without approval</div>${d.kinds.map(k => chk('auto:' + k.id, s.autoKinds.includes(k.id), k.label)).join('')}</div>
      <div><div class="lbl">Platforms switched off</div>${d.channels.map(c => chk('off:' + c.id, s.disabled.includes(c.id), c.label)).join('')}</div>
      ${chk('enabled', s.enabled, 'Draft posts automatically from what happens in the club (results, Monday posts, milestones, the Thursday tip). Writing a post by hand always works.')}<br>
      ${chk('paused', s.paused, 'Pause everything (nothing is drafted or posted)')}
      <div><button type="button" style="${btn}" onclick="studioSave()">Save settings</button> <span id="st-msg" role="status" style="font-size:12px;color:#8b95a5"></span></div></div></details>`;
  }

  function variantEditor(p) {
    const ta = (c, rows) => `<label style="font-size:11px;color:#8b95a5;display:block;margin-top:6px">${NAMES[c]}${c === 'bluesky' ? ` · <span id="cnt-${p.id}">${p.variants.bluesky.length}</span>/300` : ''}<textarea class="inp" rows="${rows}" data-p="${E(p.id)}" data-c="${c}" ${c === 'bluesky' ? `oninput="document.getElementById('cnt-${E(p.id)}').textContent=this.value.length"` : ''}>${E(p.variants[c])}</textarea></label>`;
    return `<details ${open[p.id] ? 'open' : ''} ontoggle="studioOpen('${E(p.id)}',this.open)" style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:#9ca3af">Read and change the wording for each platform</summary>
      ${['discord', 'telegram', 'bluesky', 'facebook', 'instagram', 'hook', 'whatsapp', 'strava'].map(c => ta(c, c === 'bluesky' ? 3 : 4)).join('')}
      <label style="font-size:11px;color:#8b95a5;display:block;margin-top:6px">Website title<input class="inp" data-p="${E(p.id)}" data-c="website-title" value="${E(p.variants.website.title)}"/></label>${(() => `<label style="font-size:11px;color:#8b95a5;display:block;margin-top:6px">Website text<textarea class="inp" rows="6" data-p="${E(p.id)}" data-c="website-body">${E(p.variants.website.body)}</textarea></label>`)()}
      <label style="font-size:11px;color:#8b95a5;display:block;margin-top:6px">Email subject<input class="inp" data-p="${E(p.id)}" data-c="email-subject" value="${E(p.variants.email.subject)}"/></label><label style="font-size:11px;color:#8b95a5;display:block;margin-top:6px">Email text<textarea class="inp" rows="5" data-p="${E(p.id)}" data-c="email-body">${E(p.variants.email.body)}</textarea></label>
      <div style="margin-top:6px"><button type="button" style="${btn}" onclick="studioSaveEdits('${E(p.id)}')">Save my changes</button></div></details>`;
  }
  function manualRow(p, c) {
    const done = (p.results[c] || {}).ok, t = text(p, c), enc = encodeURIComponent(c === 'email' ? p.variants.email.body : t);
    const extra = c === 'whatsapp' ? `<a style="${btn};text-decoration:none" href="https://wa.me/?text=${enc}" target="_blank" rel="noopener">Open WhatsApp</a>` : c === 'strava' && d.stravaUrl ? `<a style="${btn};text-decoration:none" href="${E(d.stravaUrl)}" target="_blank" rel="noopener">Open the Strava club</a>` : c === 'email' ? `<a style="${btn};text-decoration:none" href="mailto:?subject=${encodeURIComponent(p.variants.email.subject)}&body=${enc}">Open an email</a>` : '';
    return `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px"><b style="font-size:12px;min-width:70px">${NAMES[c]}</b><button type="button" style="${btn}" data-copy="${E(p.id)}|${c}" onclick="studioCopy(this)">Copy the text</button>${extra}${done ? '<span style="font-size:12px;color:#34d399">✓ done</span>' : `<button type="button" style="${btn}" onclick="studioDone('${E(p.id)}','${c}')">I have posted it</button>`}</div>`;
  }
  function card(p) {
    const live = p.status === 'pending' || p.status === 'failed' || p.status === 'approved', apps = d.channels.filter(c => c.type === 'app' && c.configured && c.enabled && APP.includes(c.id) || (c.id === 'email' && c.type === 'app' && c.enabled));
    const res = Object.entries(p.results).filter(([, r]) => !r.manual).map(([c, r]) => `<span style="font-size:12px;margin-right:10px;color:${r.ok ? '#34d399' : '#f87171'}">${r.ok ? '✓' : '✗'} ${NAMES[c] || c}${r.url ? ` <a href="${E(r.url)}" target="_blank" rel="noopener">open</a>` : ''}${r.note ? ` (${E(r.note)})` : ''}${r.error ? `: ${E(r.error)}` : ''}</span>`).join('');
    const pick = live ? `<div style="margin-top:8px"><div class="lbl">Post to</div>${apps.length ? apps.map(c => `<label style="font-size:12px;margin-right:12px"><input type="checkbox" data-pick="${E(p.id)}" value="${c.id}" ${['discord', 'website', 'telegram', 'bluesky', 'hook'].includes(c.id) && !(p.results[c.id] || {}).ok ? 'checked' : ''}/> ${E(c.label)}</label>`).join('') : '<span style="font-size:12px;color:#FBBF24">No platform is connected yet: add the keys in Vercel (see below).</span>'}</div>` : '';
    const img = p.imageId ? `<img src="/api/studio/img/${E(p.imageId)}.png" alt="Picture for this post" style="max-width:160px;border-radius:8px;margin-top:8px;display:block"/>` : '';
    return `<div class="card" style="padding:14px 16px;margin-bottom:12px;opacity:${p.status === 'rejected' ? .5 : 1}"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div><b>${E(p.headline)}</b> <span class="badge" style="background:rgba(255,255,255,.08)">${E(p.status)}</span> <span style="font-size:11px;color:#8b95a5">${p.via === 'ai' ? '✨ written by AI' : 'plain draft'} · ${E(p.createdAt.slice(0, 16).replace('T', ' '))}${p.named.length ? ` · names: ${E(p.named.join(', '))} (they opted in)` : ' · no riders named'}</span></div></div>
      <div style="white-space:pre-wrap;font-size:13px;margin-top:8px;padding:8px 10px;border-radius:8px;background:rgba(255,255,255,.05)">${E(p.variants.discord)}</div>${img}${variantEditor(p)}${pick}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${live ? `<button type="button" class="btn-cyan" style="width:auto;padding:7px 16px;font-size:13px" ${busy === p.id ? 'disabled' : ''} onclick="studioApprove('${E(p.id)}')">${busy === p.id ? 'Posting…' : '✅ Approve and post'}</button><button type="button" style="${btn}" onclick="studioPicture('${E(p.id)}')">🖼️ ${p.imageId ? 'Make the picture again' : 'Make a picture card'}</button><button type="button" style="${btn}" onclick="studioReject('${E(p.id)}')">Reject</button>` : ''}</div>
      ${res ? `<div style="margin-top:8px">${res}</div>` : ''}<div style="margin-top:6px"><div class="lbl">By hand</div>${['whatsapp', 'strava', ...(d.channels.find(c => c.id === 'email').type === 'manual' ? ['email'] : [])].map(c => manualRow(p, c)).join('')}</div></div>`;
  }
  function render() {
    const el = root(); if (!el || !d) return;
    const chips = d.channels.map(c => `<span class="badge" style="background:${c.enabled ? 'rgba(16,185,129,.15)' : 'rgba(255,255,255,.07)'};color:${c.enabled ? '#34d399' : '#8b95a5'}">${c.type === 'manual' ? '✋' : c.enabled ? '✓' : '○'} ${E(c.label)}${c.type === 'manual' ? ' (by hand)' : c.enabled ? '' : c.configured ? ' (off)' : ' (not set up)'}</span>`).join(' ');
    el.innerHTML = `<h2 style="font-size:20px;font-weight:900;margin-bottom:4px">📣 Comms Studio</h2><p style="font-size:13px;color:#8b95a5;margin-bottom:10px">Posts the club has drafted from what is happening. Nothing goes out until you approve it, unless you switch a kind to automatic.</p>
      <div style="margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap">${chips}</div>
      ${role === 'admin' ? settingsBox() : ''}
      <div class="card" style="padding:12px 16px;margin-bottom:12px"><div class="lbl">Write a post</div><div style="display:flex;gap:6px;flex-wrap:wrap"><input id="st-title" class="inp" placeholder="Title (optional)" value="${E(typed.title)}" style="flex:1;min-width:160px"/><input id="st-brief" class="inp" placeholder="What is it about? e.g. Social ride Sunday 9am, all welcome" value="${E(typed.brief)}" style="flex:3;min-width:240px" onkeydown="if(event.key==='Enter')studioDraft()"/><button type="button" class="btn-cyan" style="width:auto;padding:0 16px" ${busy === 'draft' ? 'disabled' : ''} onclick="studioDraft()">${busy === 'draft' ? 'Writing…' : 'Draft it'}</button></div>${d.aiOn ? '' : '<div style="font-size:11px;color:#FBBF24;margin-top:4px">The AI is off, so drafts are plain.</div>'}</div>
      ${d.posts.length ? d.posts.map(card).join('') : (window.uiEmpty ? uiEmpty('📣', 'Nothing to approve yet', 'Posts appear here after a result is entered, every Monday morning, or when you write one above.', '', '') : 'Nothing yet.')}
      ${guideHtml()}`;
  }

  // ── The set-up guide, with a test button on each platform ──
  let tests = {}, openGuide = {};
  window.studioGuideOpen = (id, on) => { openGuide[id] = on; };
  function guideHtml() {
    const chan = id => d.channels.find(c => c.id === id) || {};
    const rows = (d.guide || []).map(g => {
      const c = chan(g.id), ok = g.id === 'whatsapp' || g.id === 'strava' ? null : g.missing.length === 0 && (g.env.length || c.configured);
      const badge = ok === null ? '<span class="badge" style="background:rgba(255,255,255,.07);color:#9ca3af">by hand</span>' : ok ? '<span class="badge" style="background:rgba(16,185,129,.15);color:#34d399">keys added</span>' : '<span class="badge" style="background:rgba(251,191,36,.15);color:#FBBF24">not set up</span>';
      const t = tests[g.id];
      return `<details class="card" ${openGuide[g.id] ? 'open' : ''} ontoggle="studioGuideOpen('${g.id}',this.open)" style="padding:10px 14px;margin-bottom:8px"><summary style="cursor:pointer;font-size:14px;font-weight:700">${E(g.title)} ${badge} <span style="font-size:11px;font-weight:500;color:#8b95a5">· ${E(g.how)}${g.minutes ? ` · about ${g.minutes} min` : ''}</span></summary>
        <div style="font-size:13px;color:#d1d5db;margin:8px 0">${E(g.summary)}</div>
        ${g.env.length ? `<div style="margin:6px 0"><div class="lbl">The values to add in Vercel (the Name, exactly)</div>${g.env.map(n => `<div style="display:flex;gap:6px;align-items:center;margin:3px 0"><code style="padding:3px 8px;background:rgba(255,255,255,.07);border-radius:6px;font-size:12px">${E(n)}</code>${g.missing.includes(n) ? '<span style="font-size:11px;color:#FBBF24">not set</span>' : '<span style="font-size:11px;color:#34d399">set ✓</span>'}<button type="button" style="${btn};padding:2px 8px" onclick="navigator.clipboard&&navigator.clipboard.writeText('${E(n)}')">Copy name</button></div>`).join('')}</div>` : ''}
        <ol style="margin:8px 0 8px 20px;font-size:13px;color:#e5e7eb;line-height:1.55">${g.steps.map(x => `<li style="margin-bottom:6px">${E(x)}</li>`).join('')}</ol>
        ${g.env.length ? `<details style="margin:6px 0"><summary style="cursor:pointer;font-size:12px;color:#9ca3af">How to add a value in Vercel (every key needs this)</summary><ol style="margin:6px 0 0 20px;font-size:12px;color:#d1d5db;line-height:1.5">${(d.vercel || []).map(x => `<li style="margin-bottom:4px">${E(x)}</li>`).join('')}</ol></details>` : ''}
        ${role === 'admin' && g.id !== 'whatsapp' && g.id !== 'strava' ? `<div style="margin-top:8px"><button type="button" class="btn-cyan" style="width:auto;padding:7px 16px;font-size:13px" ${t && t.busy ? 'disabled' : ''} onclick="studioTest('${g.id}')">${t && t.busy ? 'Testing…' : '🔌 Test the connection'}</button>${t && !t.busy ? `<div role="status" style="margin-top:8px;padding:8px 10px;border-radius:8px;font-size:13px;background:${t.ok ? 'rgba(16,185,129,.12)' : 'rgba(248,113,113,.12)'}"><b>${t.ok ? '✅ Working.' : '❌ Not working yet.'}</b> ${E(t.detail)}${t.hint ? `<div style="margin-top:4px;color:#FBBF24">${E(t.hint)}</div>` : ''}</div>` : ''}</div>` : ''}</details>`;
    }).join('');
    return `<div style="margin-top:16px"><h3 style="font-size:16px;font-weight:800;margin-bottom:4px">🧭 Set up each platform</h3><p style="font-size:12px;color:#8b95a5;margin-bottom:8px">Open a platform and follow the steps in order. Each has a Test button so you know it worked before you rely on it. Start with Telegram or Bluesky: they are the quickest.</p>${rows}</div>`;
  }
  window.studioTest = async id => {
    tests[id] = { busy: true }; render();
    try { tests[id] = await api('/api/studio/test', { channel: id }); } catch (e) { tests[id] = { ok: false, detail: e.message, hint: '' }; }
    render();
  };
  const collect = id => {
    const g = c => { const e = document.querySelector(`[data-p="${id}"][data-c="${c}"]`); return e ? e.value : ''; }, v = {};
    for (const c of ['discord', 'telegram', 'bluesky', 'facebook', 'instagram', 'hook', 'whatsapp', 'strava']) v[c] = g(c);
    v.website = { title: g('website-title'), body: g('website-body') }; v.email = { subject: g('email-subject'), body: g('email-body') }; return v;
  };
  const refresh = p => { d.posts = d.posts.map(x => (x.id === p.id ? p : x)); render(); };
  window.studioLoad = load;
  window.studioOpen = (id, on) => { open[id] = on; };
  // What was typed is read before the page is drawn again, or the boxes would be empty by the time they are sent.
  let typed = { title: '', brief: '' };
  window.studioDraft = async () => {
    const brief = document.getElementById('st-brief').value.trim(), title = document.getElementById('st-title').value.trim();
    if (!brief) { alert('Type what the post is about first, for example: Social ride Sunday 9am, all welcome.'); return; }
    typed = { title, brief }; busy = 'draft'; render();
    try { const p = (await api('/api/studio/draft', { brief, title })).post; d.posts.unshift(p); open[p.id] = true; typed = { title: '', brief: '' }; } catch (e) { alert(e.message); }
    busy = ''; render();
  };
  window.studioSaveEdits = async id => { try { refresh((await api('/api/studio/edit', { id, variants: collect(id) })).post); } catch (e) { alert(e.message); } };
  window.studioApprove = async id => {
    const chs = [...document.querySelectorAll(`[data-pick="${id}"]:checked`)].map(x => x.value);
    if (!chs.length) { alert('Tick at least one platform.'); return; }
    if (!confirm(`Post this to ${chs.length} platform${chs.length === 1 ? '' : 's'} now?`)) return;
    const variants = collect(id);   // read the boxes before the page is drawn again, or the changes would be lost
    busy = id; render();
    try { await api('/api/studio/edit', { id, variants }); refresh((await api('/api/studio/approve', { id, channels: chs })).post); } catch (e) { alert(e.message); }
    busy = ''; render();
  };
  window.studioReject = async id => { try { refresh((await api('/api/studio/reject', { id })).post); } catch (e) { alert(e.message); } };
  window.studioDone = async (id, channel) => { try { refresh((await api('/api/studio/done', { id, channel })).post); } catch (e) { alert(e.message); } };
  window.studioCopy = async b => { const [id, c] = b.dataset.copy.split('|'), p = d.posts.find(x => x.id === id); try { await navigator.clipboard.writeText(text(p, c)); b.textContent = 'Copied ✓'; } catch (e) { alert('Select and copy it from the box above.'); } };
  window.studioPicture = async id => {
    const p = d.posts.find(x => x.id === id); if (!p) return;
    try { const b64 = await uiPostCardPng(p.headline, p.variants.discord.split('\n').filter(Boolean).slice(0, 5)); refresh((await api('/api/studio/image', { id, png: b64 })).post); } catch (e) { alert(e.message); }
  };
  window.studioSave = async () => {
    const q = n => document.querySelector(`[data-s="${n}"]`), kinds = d.kinds.filter(k => q('auto:' + k.id).checked).map(k => k.id), off = d.channels.filter(c => q('off:' + c.id).checked).map(c => c.id);
    try { await api('/api/studio/settings', { voice: document.getElementById('st-voice').value, hashtags: document.getElementById('st-tags').value, dailyLimit: document.getElementById('st-limit').value, websiteStatus: document.getElementById('st-web').value, stravaUrl: document.getElementById('st-strava').value, autoKinds: kinds, disabled: off, paused: q('paused').checked, enabled: q('enabled').checked }); await load(); const m = document.getElementById('st-msg'); if (m) m.textContent = 'Saved.'; } catch (e) { document.getElementById('st-msg').textContent = e.message; }
  };
  // Riders: "OK to feature me".
  window.studioFeatureCard = async el => {
    if (!el) return;
    try {
      let on = (await api('/api/studio/feature')).on;
      const draw = () => { el.innerHTML = `<div class="card" style="padding:12px 16px;font-size:13px"><label><input type="checkbox" ${on ? 'checked' : ''} onchange="studioFeature(this.checked)"/> 📣 <b>OK to feature me by name</b> in club posts (results, shout-outs on Discord, the website and social media)</label><div style="font-size:11px;color:#8b95a5;margin-top:4px">Off by default. If you leave it off, posts only name teams. You can change your mind at any time.</div></div>`; };
      window.studioFeature = async v => { try { on = (await api('/api/studio/feature', { on: v })).on; } catch (e) { alert(e.message); } draw(); };
      draw();
    } catch (e) { el.innerHTML = ''; }
  };
})();
