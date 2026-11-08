'use strict';
// Staff: FIT pair comparator card on the Investigations page. Both files are read in this browser tab with the vendored Garmin FIT SDK and compared by
// js/pairfit.js. Nothing is uploaded, stored or sent anywhere: the files and the results live in this page until it is closed.
(function () {
  const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let sdk = null, state = { zwift: null, second: null, result: null, error: '', busy: false };
  const fmt = v => (v == null || v === '' ? '<span style="color:#6b7280">not in file</span>' : E(v));
  const when = v => (v == null ? null : new Date(v * 1000).toISOString().replace('.000Z', 'Z'));

  async function decode(file) {
    if (!sdk) sdk = await import('/vendor/fitsdk/src/index.js');
    const bytes = new Uint8Array(await file.arrayBuffer()), d = new sdk.Decoder(sdk.Stream.fromByteArray(bytes));
    if (!d.isFIT()) throw new Error(file.name + ' is not a FIT file.');
    const { messages, errors } = d.read();
    if (!messages.recordMesgs || !messages.recordMesgs.length) throw new Error(file.name + (errors && errors.length ? ' could not be read: ' + errors[0].message : ' has no recorded data.'));
    return PairFit.extract(messages);
  }

  const idRows = (z, s) => {
    const row = (label, a, b) => `<tr><td style="color:#8b95a5">${label}</td><td>${fmt(a)}</td><td>${fmt(b)}</td></tr>`;
    const zi = z.fileId, si = s.fileId;
    let h = row('Manufacturer', zi.manufacturer, si.manufacturer) + row('Product', zi.product, si.product) + row('Product name', zi.productName, si.productName) + row('Serial number', zi.serial, si.serial)
      + row('Created', when(zi.timeCreated), when(si.timeCreated)) + row('Software version (creator)', z.creator.softwareVersion, s.creator.softwareVersion) + row('Hardware version (creator)', z.creator.hardwareVersion, s.creator.hardwareVersion);
    const n = Math.max(z.powerSensors.length, s.powerSensors.length);
    for (let i = 0; i < n; i++) {
      const a = z.powerSensors[i], b = s.powerSensors[i], line = x => (x ? `${E(x.manufacturer == null ? '?' : x.manufacturer)} / product ${E(x.product == null ? '?' : x.product)} / serial ${E(x.serial == null ? 'none' : x.serial)} / device no. ${E(x.antNumber == null ? 'none' : x.antNumber)} / software ${E(x.softwareVersion == null ? 'none' : x.softwareVersion)}` : '<span style="color:#6b7280">none listed</span>');
      h += `<tr><td style="color:#8b95a5">Power sensor ${i + 1}</td><td>${line(a)}</td><td>${line(b)}</td></tr>`;
    }
    if (!n) h += '<tr><td style="color:#8b95a5">Power sensor</td><td><span style="color:#6b7280">none listed</span></td><td><span style="color:#6b7280">none listed</span></td></tr>';
    return h;
  };

  function resultHtml(r) {
    const st = r.stats, pct = x => (x == null ? 'n/a' : (x * 100).toFixed(2) + '%');
    const nums = st.aligned
      ? `<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0">${[['Alignment', (st.lagSeconds > 0 ? '+' : '') + st.lagSeconds + ' s'], ['Overlap', Math.round(st.overlapSeconds / 60) + ' min'], ['Correlation (r)', st.r.toFixed(4)], ['Mean ratio (second ÷ Zwift)', st.meanRatio == null ? 'n/a' : st.meanRatio.toFixed(3)], ['Ratio CV (60 s windows)', pct(st.ratioCv)]].map(([k, v]) => `<div class="card" style="padding:8px 12px"><div style="font-size:11px;color:#8b95a5">${k}</div><div style="font-size:16px;font-weight:800">${v}</div></div>`).join('')}</div>`
      : '<p style="font-size:13px;color:#FBBF24;margin:10px 0">There is not enough overlapping power data to compare these two files.</p>';
    const ind = r.indicators.map(i => `<div class="card" style="padding:10px 14px;margin-bottom:8px;border-left:3px solid ${i.code === 'none' ? '#34d399' : '#FBBF24'}"><b>${E(i.label)}</b>${i.evidence ? `<div style="font-size:12px;color:#d1d5db;margin-top:3px">${E(i.evidence)}</div>` : ''}<div style="font-size:12px;color:#8b95a5;margin-top:4px">${E(i.explanation)}</div></div>`).join('');
    return `${nums}${ind}
      <div style="overflow-x:auto;margin-top:10px"><table><thead><tr><th></th><th>Zwift file</th><th>Second-source file</th></tr></thead><tbody>${idRows(r.identity.zwift, r.identity.second)}</tbody></table></div>
      <p style="font-size:12px;color:#8b95a5;margin-top:8px">${E(r.note)} The thresholds behind these indicators are untuned starting points.</p>`;
  }

  function mount(el) {
    if (!el) return;
    el.innerHTML = `<div class="card" style="padding:14px 16px;margin-bottom:14px"><div class="lbl">FIT pair comparator</div>
      <p style="font-size:12px;color:#8b95a5;margin:0 0 8px">Compare a Zwift recording with a second-source recording of the same ride. Both files are read in this browser and are never uploaded, stored or sent to the server.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
        <label style="font-size:12px;flex:1;min-width:200px">Zwift file<input id="pair-z" type="file" accept=".fit" class="inp" style="margin-top:4px"/></label>
        <label style="font-size:12px;flex:1;min-width:200px">Second-source file<input id="pair-s" type="file" accept=".fit" class="inp" style="margin-top:4px"/></label>
        <button type="button" class="btn-cyan" id="pair-go" style="width:auto;padding:8px 18px;font-size:13px">Compare</button></div>
      <div id="pair-out" role="status" style="margin-top:8px;font-size:13px"></div></div>`;
    const out = el.querySelector('#pair-out');
    if (state.result) out.innerHTML = resultHtml(state.result);
    el.querySelector('#pair-go').onclick = async () => {
      const z = el.querySelector('#pair-z').files[0], s = el.querySelector('#pair-s').files[0];
      if (!z || !s) { out.innerHTML = '<span style="color:#FBBF24">Choose both files first.</span>'; return; }
      out.textContent = 'Reading both files…';
      try { state.result = PairFit.compare(await decode(z), await decode(s)); out.innerHTML = resultHtml(state.result); }
      catch (e) { state.result = null; out.innerHTML = `<span style="color:#f87171">${E(e.message)}</span>`; }
    };
  }
  window.PairUI = { mount };
})();
