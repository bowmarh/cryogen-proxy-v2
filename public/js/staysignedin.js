'use strict';
// Stay signed in on this device, optionally behind a passcode or Face ID / fingerprint, and "trust this device" for the authenticator code.
//  - The server gives a 30-day renewal token (POST /api/auth/remember); it is swapped for a new one at each use (POST /api/auth/resume).
//  - With a passcode, the renewal token is kept encrypted with a key made from the passcode (PBKDF2 + AES-GCM): without the passcode it cannot be read.
//  - With Face ID / fingerprint, the phone's own lock (WebAuthn, user verification required) must succeed before the token is opened with a key that
//    cannot be copied out of this browser. This guards against someone picking up an unlocked phone; the passcode option adds encryption on top.
//  - Five wrong passcodes forget the saved sign-in. Signing out forgets it too.
(function () {
  const LS = { saved: 'cg:stay', trust: 'cg:trust', ask: 'cg:stay:ask' };
  const get = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
  const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf))), unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const post = async (path, body, tok) => { const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: JSON.stringify(body || {}) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || ('HTTP ' + r.status)), { status: r.status }); return d; };
  const subtle = window.crypto && window.crypto.subtle;

  // ── keys ──
  async function pinKey(pin, salt) { const base = await subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']); return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
  function idb() { return new Promise((ok, no) => { const r = indexedDB.open('cg-stay', 1); r.onupgradeneeded = () => r.result.createObjectStore('k'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
  async function deviceKey(create) {
    const db = await idb(); const read = () => new Promise(ok => { const q = db.transaction('k').objectStore('k').get('key'); q.onsuccess = () => ok(q.result); q.onerror = () => ok(null); });
    let k = await read(); if (k || !create) return k;
    k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);   // not extractable: it never leaves this browser
    await new Promise(ok => { const t = db.transaction('k', 'readwrite'); t.objectStore('k').put(k, 'key'); t.oncomplete = ok; }); return k;
  }
  async function seal(key, text) { const iv = crypto.getRandomValues(new Uint8Array(12)); return { iv: b64(iv), ct: b64(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text))) }; }
  async function open(key, box) { return new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct))); }

  // ── saved sign-in ──  { lock: 'none'|'pin'|'bio', role, owner, refresh? , box?, salt?, cred?, fails }
  const saved = () => { try { return JSON.parse(get(LS.saved) || 'null'); } catch (e) { return null; } };
  const save = s => set(LS.saved, s ? JSON.stringify(s) : null);
  async function store(refresh, meta, lock = (saved() || {}).lock || 'none', extra = {}) {
    const prev = saved() || {}, s = { lock, role: meta.role, owner: !!meta.owner, fails: 0, cred: prev.cred, salt: prev.salt, ...extra };
    if (lock === 'none') s.refresh = refresh;
    else if (lock === 'pin') { if (!extra.pin && !Stay._pin) throw new Error('passcode needed'); const salt = s.salt ? unb64(s.salt) : crypto.getRandomValues(new Uint8Array(16)); s.salt = b64(salt); s.box = await seal(await pinKey(extra.pin || Stay._pin, salt), refresh); delete s.pin; }
    else if (lock === 'bio') s.box = await seal(await deviceKey(true), refresh);
    delete s.pin; save(s);
  }
  async function bioAvailable() { try { return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); } catch (e) { return false; } }
  async function bioCheck(cred) {
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const a = await navigator.credentials.get({ publicKey: { challenge, allowCredentials: [{ type: 'public-key', id: unb64(cred) }], userVerification: 'required', timeout: 60000 } });
    if (!a) throw new Error('Face ID / fingerprint did not complete.');
  }
  async function bioEnrol() {
    const user = crypto.getRandomValues(new Uint8Array(16));
    const c = await navigator.credentials.create({ publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), rp: { name: 'CRYO-GEN', id: location.hostname }, user: { id: user, name: 'cryogen-device', displayName: 'CRYO-GEN on this device' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000 } });
    return b64(c.rawId);
  }

  // ── a small modal ──
  function modal(html) {
    let m = document.getElementById('stay-modal'); if (!m) { m = document.createElement('div'); m.id = 'stay-modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(5,10,20,.92);display:flex;align-items:center;justify-content:center;padding:16px'; document.body.appendChild(m); }
    m.innerHTML = `<div style="background:#0f172a;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:20px;max-width:360px;width:100%;color:#e5e7eb;font-size:14px">${html}</div>`; m.style.display = 'flex';
    const f = m.querySelector('input'); if (f) setTimeout(() => f.focus(), 30); return m;
  }
  // The offer after signing in: a card at the bottom of the screen that blocks nothing (the app stays usable underneath).
  function banner(html) {
    let b = document.getElementById('stay-banner'); if (!b) { b = document.createElement('div'); b.id = 'stay-banner'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Stay signed in'); b.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9998;max-width:420px;margin:0 auto;background:#0f172a;border:1px solid rgba(34,211,238,.4);border-radius:14px;padding:14px;color:#e5e7eb;font-size:13px;box-shadow:0 10px 30px rgba(0,0,0,.5)'; document.body.appendChild(b); }
    b.innerHTML = html; b.style.display = 'block';
  }
  const closeBanner = () => { const b = document.getElementById('stay-banner'); if (b) b.style.display = 'none'; };
  const close = () => { const m = document.getElementById('stay-modal'); if (m) m.style.display = 'none'; };
  const sbtn = 'padding:7px 11px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e5e7eb;font-size:13px;cursor:pointer';
  const btn = 'padding:9px 14px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:#e5e7eb;font-size:14px;cursor:pointer;width:100%;margin-top:8px';
  const askPin = (title, note) => new Promise(ok => { modal(`<div style="font-weight:800;font-size:16px;margin-bottom:6px">${title}</div><div style="font-size:12px;color:#9ca3af;margin-bottom:10px">${note}</div><input id="stay-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" class="inp" style="font-size:22px;letter-spacing:6px;text-align:center"/><div id="stay-err" style="color:#f87171;font-size:12px;margin-top:6px"></div><button style="${btn};background:#0891b2;border-color:#0891b2" id="stay-ok">OK</button><button style="${btn}" id="stay-cancel">Use my password instead</button>`);
    const done = v => { close(); ok(v); }; document.getElementById('stay-ok').onclick = () => done(document.getElementById('stay-pin').value); document.getElementById('stay-cancel').onclick = () => done(null);
    document.getElementById('stay-pin').onkeydown = e => { if (e.key === 'Enter') done(e.target.value); }; });

  // ── after a sign-in: offer to stay signed in (once per device until answered) ──
  async function offer(token, meta) {
    if (saved() || get(LS.ask) === 'no' || !subtle) return;
    const bio = await bioAvailable();
    banner(`<div style="font-weight:800;font-size:15px;margin-bottom:4px">Stay signed in on this device?</div><div style="font-size:12px;color:#9ca3af;margin-bottom:6px">For 30 days you won't need your password here. Choose how to unlock the app:</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">${bio ? `<button style="${sbtn};background:#0891b2;border-color:#0891b2" data-l="bio">🔐 Face ID / fingerprint</button>` : ''}<button style="${sbtn}" data-l="pin">🔢 Passcode</button><button style="${sbtn}" data-l="none">No lock</button><button style="${sbtn};background:transparent;border-color:transparent;color:#9ca3af" data-l="no">Not now</button></div>`);
    document.querySelectorAll('#stay-banner [data-l]').forEach(b => b.onclick = async () => {
      const l = b.dataset.l; closeBanner(); if (l === 'no') { set(LS.ask, 'no'); return; }
      try {
        let extra = {};
        if (l === 'pin') { const a = await askPin('Choose a passcode', '4 to 12 digits. You will type it to open the app on this device.'); if (!a) return; if (!/^\d{4,12}$/.test(a)) { alert('Use 4 to 12 digits.'); return; } const b2 = await askPin('Type it again', 'To make sure.'); if (b2 !== a) { alert('Those did not match.'); return; } extra = { pin: a }; }
        if (l === 'bio') extra = { cred: await bioEnrol() };
        const r = await post('/api/auth/remember', {}, token); await store(r.refresh, meta, l, extra);
      } catch (e) { close(); alert('Could not set that up: ' + e.message); }
    });
  }

  // ── on opening the app with no session: unlock and sign in ──
  async function resume(onSignedIn) {
    const s = saved(); if (!s) return false;
    let refresh;
    try {
      if (s.lock === 'none') refresh = s.refresh;
      else if (s.lock === 'bio') { await bioCheck(s.cred); refresh = await open(await deviceKey(false), s.box); }
      else if (s.lock === 'pin') {
        for (;;) { const p = await askPin('Enter your passcode', 'To open CRYO-GEN on this device.'); if (p === null) return false;
          try { refresh = await open(await pinKey(p, unb64(s.salt)), s.box); Stay._pin = p; break; }
          catch (e) { s.fails = (s.fails || 0) + 1; save(s); if (s.fails >= 5) { forget(); alert('Too many wrong passcodes: sign in with your password.'); return false; } alert(`Wrong passcode (${5 - s.fails} tries left).`); } }
      }
      const d = await post('/api/auth/resume', { refresh });
      await store(d.refresh, d, s.lock, s.lock === 'pin' ? { pin: Stay._pin } : {}); Stay._pin = null;
      onSignedIn(d); return true;
    } catch (e) { if (e.status === 401) forget(); return false; }
  }
  function forget() { const s = saved(); if (s && s.refresh) post('/api/auth/forget', { refresh: s.refresh }).catch(() => {}); save(null); }

  window.Stay = { offer, resume, forget, has: () => !!saved(), trust: () => get(LS.trust) || undefined, setTrust: t => set(LS.trust, t || null), lockType: () => (saved() || {}).lock || '', _pin: null,
    // "Forget this device" from My profile / Security: ends the saved sign-in and the trusted-device mark.
    forgetDevice: () => { forget(); const t = get(LS.trust); if (t) post('/api/auth/forget', { trust: t }).catch(() => {}); set(LS.trust, null); set(LS.ask, null); } };
})();
