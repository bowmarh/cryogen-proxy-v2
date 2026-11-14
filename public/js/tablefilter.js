'use strict';
// A filter box for every long list. A table with MIN or more rows gets "Filter…" above it; typing hides the rows that do not contain every word typed. It matches
// anything in the row: names, Zwift IDs (also the ID behind a rider name), teams, status, dates. Tables that already have their own search are left alone, and
// so is anything marked data-nofilter. A list made of cards instead of a table opts in with data-filterable (its direct children are the items). When the app
// redraws a list the box is kept and re-applied, so what was typed is not lost. Pure display: nothing is sent anywhere.
// Also here: click a column heading to sort (tables whose headings already do something are left alone), "Download CSV" of what is shown (staff only: these lists
// can hold personal details), and saved views (a filter and a sort kept under a name, on this device).
(function () {
  const MIN = 8, SORT_MIN = 5, kept = new Map(), keptSort = new Map(), VIEWS_KEY = 'cg:tf:views:v1';
  const isStaff = () => ['admin', 'mod'].includes(sessionStorage.getItem('role'));
  const norm = s => String(s == null ? '' : s).toLowerCase();
  const ownSearch = scope => !!scope && [...scope.querySelectorAll('input')].some(i => !i.classList.contains('tf-input') && /search|filter/i.test(i.placeholder || '') );
  const hay = el => norm(el.textContent) + ' ' + [...el.querySelectorAll('[data-rid],[data-rkey],[title]')].map(x => (x.dataset.rid || '') + ' ' + (x.dataset.rkey || '') + ' ' + (x.getAttribute('title') || '')).join(' ').toLowerCase();

  function makeBox(sig, kind) {
    const box = document.createElement('div'); box.className = 'tf-box'; box.dataset.sig = sig;
    box.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0 8px';
    const tb = 'padding:6px 10px;font-size:12px;border-radius:8px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);color:#cbd5e1;cursor:pointer';
    box.innerHTML = `<input type="search" class="inp tf-input" aria-label="Filter this ${kind}" placeholder="🔎 Filter: name, Zwift ID, anything…" title="Tip: type score&gt;10 or name:ann to filter one column" autocomplete="off" style="width:100%;max-width:320px;font-size:13px"><span class="tf-count" aria-live="polite" style="font-size:11px;color:#8b95a5"></span>
      <select class="inp tf-views" aria-label="Saved views" style="width:auto;max-width:170px;font-size:12px"></select><button type="button" class="tf-save" style="${tb}" title="Save the current filter and sort as a view on this device">💾 Save view</button><button type="button" class="tf-del" style="${tb};display:none" aria-label="Delete this saved view">🗑</button>${isStaff() ? `<button type="button" class="tf-csv" style="${tb}" title="Download what is shown as a spreadsheet file">⬇ CSV</button>` : ''}`;
    return box;
  }
  const items = target => target.tagName === 'TABLE' ? [...target.querySelectorAll('tr')].filter(r => r.querySelector('td')) : [...target.children].filter(c => !c.classList.contains('tf-box'));
  // ── Saved views: a filter text and a sort, by name, per list, kept in this browser ──
  const loadViews = () => { try { return JSON.parse(localStorage.getItem(VIEWS_KEY) || '{}') || {}; } catch (e) { return {}; } };
  const saveViews = v => { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(v)); } catch (e) { /* private mode: not kept */ } };
  // Staff also keep their views on the server, so they follow them between devices; this browser copy still works offline or if the call fails.
  let pulled = false;
  const syncPush = sig => { if (!isStaff() || typeof tttHeaders !== 'function') return; try { fetch('/api/tableviews', { method: 'POST', headers: { ...tttHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ sig, views: loadViews()[sig] || [] }) }).catch(() => {}); } catch (e) { /* offline: the local copy stays */ } };
  function syncPull() {
    if (pulled || !isStaff() || typeof tttHeaders !== 'function') return; pulled = true;
    fetch('/api/tableviews', { headers: tttHeaders() }).then(r => r.ok ? r.json() : null).then(d => {
      if (!d || !d.views) return; const all = loadViews(); let changed = false;
      for (const sig of Object.keys(d.views)) { if (JSON.stringify(all[sig]) !== JSON.stringify(d.views[sig])) { all[sig] = d.views[sig]; changed = true; } }
      if (changed) { saveViews(all); document.querySelectorAll('.tf-box').forEach(b => fillViews(b, null)); }
    }).catch(() => { pulled = false; });
  }
  function fillViews(box, selected) {
    const sel = box.querySelector('.tf-views'), list = loadViews()[box.dataset.sig] || [];
    sel.innerHTML = `<option value="">⭐ Views${list.length ? ` (${list.length})` : ''}</option>` + list.map((v, i) => `<option value="${i}">${v.name.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</option>`).join('');
    sel.style.display = list.length ? '' : 'none'; sel.value = selected == null ? '' : String(selected); box.querySelector('.tf-del').style.display = sel.value === '' ? 'none' : '';
  }
  function currentView(box) { const so = keptSort.get(box.dataset.sig); return { q: box.querySelector('.tf-input').value, sort: so ? { col: so.col, dir: so.dir } : null }; }

  // ── CSV of what is shown (hidden rows left out, in the order on screen) ──
  const csvCell = v => { v = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); if (/^[=+\-@\t\r]/.test(v) && !/^[-+]?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  function downloadCsv(name, rows) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportBox(box) {
    const t = box.__target; if (!t) return; const page = t.closest('.page'), h2 = page && page.querySelector('h2'), stamp = new Date().toISOString().slice(0, 10);
    const base = ((h2 ? h2.textContent : page ? page.id : 'list').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'list');
    const vis = items(t).filter(r => !r.hidden && !(t.tagName === 'TABLE' && r.cells.length === 1 && (r.cells[0].colSpan || 1) > 1));
    let rows;
    if (t.tagName === 'TABLE') {
      const heads = [...(t.tHead ? t.tHead.rows[0].cells : t.rows[0].cells)].map((c, i) => c.textContent.replace(/[▲▼]/g, '').trim() || `Column ${i + 1}`), withId = vis.some(r => r.querySelector('[data-rid]'));
      rows = [withId ? [...heads, 'Zwift ID'] : heads, ...vis.map(r => { const cells = [...r.cells].map(c => c.textContent); const rid = r.querySelector('[data-rid]'); return withId ? [...cells, rid ? rid.dataset.rid : ''] : cells; })];
    } else rows = [['Item'], ...vis.map(r => [r.textContent])];
    downloadCsv(`cryogen-${base}-${stamp}.csv`, rows);
  }

  // ── Sorting: click a heading (again to reverse, a third time for the original order) ──
  const num = s => { const t = String(s).replace(/[,%£$\s]/g, ''); return /^[-+]?\d+(\.\d+)?$/.test(t) ? parseFloat(t) : NaN; };
  const when = s => /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(s) : NaN;
  const cellKey = (row, col) => { const c = row.cells[col]; return c ? (c.dataset.sort != null ? c.dataset.sort : c.textContent.replace(/\s+/g, ' ').trim()) : ''; };
  function sortTable(t, col, dir) {
    for (const body of t.tBodies) {
      const units = []; let cur = null, i = 0;
      for (const r of [...body.rows]) {
        if (r.__ti == null) r.__ti = i; i++;
        const detail = r.cells.length === 1 && (r.cells[0].colSpan || 1) > 1;
        if (detail && cur) cur.rows.push(r); else { cur = { rows: [r], ti: r.__ti }; units.push(cur); }
      }
      units.sort((a, b) => {
        if (dir === 0) return a.ti - b.ti;
        const x = cellKey(a.rows[0], col), y = cellKey(b.rows[0], col);
        if (x === '' || y === '') return x === y ? a.ti - b.ti : x === '' ? 1 : -1;   // empty cells go last either way
        const nx = num(x), ny = num(y), dx = when(x), dy = when(y);
        const c = !isNaN(nx) && !isNaN(ny) ? nx - ny : !isNaN(dx) && !isNaN(dy) ? dx - dy : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
        return (c * dir) || a.ti - b.ti;
      });
      for (const u of units) for (const r of u.rows) body.appendChild(r);
    }
    [...t.querySelectorAll('th')].forEach((th, i) => { const arrow = th.querySelector('.tf-arrow'); if (arrow) arrow.textContent = i === col && dir ? (dir > 0 ? '▲' : '▼') : ''; th.setAttribute('aria-sort', i === col && dir ? (dir > 0 ? 'ascending' : 'descending') : 'none'); });
  }
  function enableSort(t, sig) {
    const head = t.tHead ? t.tHead.rows[0] : t.rows[0]; if (!head || !head.cells.length) return;
    const ths = [...head.cells]; if (!ths.every(c => c.tagName === 'TH') || ths.some(c => (c.colSpan || 1) > 1 || c.hasAttribute('onclick') || c.querySelector('.sortarrow,[onclick]'))) return;
    t.dataset.tsort = '1';
    ths.forEach((th, i) => {
      th.style.cursor = 'pointer'; th.style.userSelect = 'none'; th.tabIndex = 0; th.setAttribute('aria-sort', 'none'); th.title = 'Click to sort';
      if (!th.querySelector('.tf-arrow')) { const a = document.createElement('span'); a.className = 'tf-arrow'; a.setAttribute('aria-hidden', 'true'); a.style.cssText = 'margin-left:4px;font-size:10px;opacity:.8'; th.appendChild(a); }
      const go = () => { const prev = keptSort.get(sig), dir = prev && prev.col === i ? (prev.dir === 1 ? -1 : prev.dir === -1 ? 0 : 1) : 1; keptSort.set(sig, dir ? { col: i, dir } : null); sortTable(t, i, dir); };
      th.addEventListener('click', go); th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
    });
    const was = keptSort.get(sig); if (was) sortTable(t, was.col, was.dir);   // the app redrew the list: keep the sort
  }
  const sigOf = (t, kind) => { const page = t.closest('.page'), heads = t.tagName === 'TABLE' ? [...t.querySelectorAll('th')].map(h => h.textContent.replace(/[▲▼]/g, '').trim()).join('|') : (t.id || t.className || ''); return `${page ? page.id : ''}|${kind}|${heads}`.slice(0, 200); };

  function apply(box) {
    const t = box.__target; if (!t || !t.isConnected) return;
    const all = norm(box.querySelector('input').value).split(/\s+/).filter(Boolean), rows = items(t); let shown = 0, last = true;
    // Column filters on tables: "cat:b", "ftp>250", "wkg<3.5". The heading only has to start with the letters typed; anything that names no column is an ordinary word.
    const heads = t.tagName === 'TABLE' ? [...t.querySelectorAll('thead th')].map(th => norm(th.textContent).replace(/[^a-z0-9]/g, '')) : [];
    const colTests = [], q = [];
    for (const w of all) {
      const m = /^([a-z0-9]+)(:|>|<)(.+)$/.exec(w), ci = m && heads.findIndex(h => h && h.startsWith(m[1]));
      if (m && ci >= 0) colTests.push({ ci, op: m[2], v: m[3] }); else q.push(w);
    }
    const colOk = r => colTests.every(({ ci, op, v }) => { const txt = norm(cellKey(r, ci)); if (op === ':') return txt.includes(v); const a = num(txt), b = num(v); return !isNaN(a) && !isNaN(b) && (op === '>' ? a > b : a < b); });
    for (const r of rows) {
      const detail = t.tagName === 'TABLE' && r.cells.length === 1 && (r.cells[0].colSpan || 1) > 1;   // an expanding detail row follows its parent row
      const ok = detail ? last : colOk(r) && q.every(w => hay(r).includes(w));
      r.hidden = !ok; if (!detail) { last = ok; if (ok) shown++; }
    }
    box.querySelector('.tf-count').textContent = all.length ? `${shown} of ${rows.filter(r => !(t.tagName === 'TABLE' && r.cells.length === 1 && (r.cells[0].colSpan || 1) > 1)).length}` : '';
    kept.set(box.dataset.sig, box.querySelector('input').value);
  }
  function attach(target, kind) {
    let anchor = target;
    if (target.tagName === 'TABLE' && target.parentElement && /overflow/.test(target.parentElement.getAttribute('style') || '') && target.parentElement.children.length === 1) anchor = target.parentElement;
    if (!anchor.parentNode) return;
    const sig = sigOf(target, kind);
    let box = anchor.previousElementSibling && anchor.previousElementSibling.classList.contains('tf-box') ? anchor.previousElementSibling : null;   // the app redrew the list: keep the box
    if (!box) {
      box = makeBox(sig, kind); anchor.parentNode.insertBefore(box, anchor); const input = box.querySelector('.tf-input'); input.addEventListener('input', () => { apply(box); fillViews(box, null); });
      const was = kept.get(sig); if (was) input.value = was; fillViews(box, null);
      box.querySelector('.tf-views').addEventListener('change', e => {
        const v = (loadViews()[box.dataset.sig] || [])[Number(e.target.value)]; if (e.target.value === '' || !v) return fillViews(box, null);
        input.value = v.q; apply(box); const t = box.__target; if (t && t.tagName === 'TABLE') { keptSort.set(box.dataset.sig, v.sort); if (t.dataset.tsort) sortTable(t, v.sort ? v.sort.col : 0, v.sort ? v.sort.dir : 0); }
        fillViews(box, e.target.value);
      });
      box.querySelector('.tf-save').addEventListener('click', () => {
        const cur = currentView(box); if (!cur.q.trim() && !cur.sort) { alert('Type a filter or sort a column first, then save it as a view.'); return; }
        const name = (prompt('Name this view:', cur.q.trim().slice(0, 30)) || '').trim().slice(0, 40); if (!name) return;
        const all = loadViews(), list = (all[box.dataset.sig] || []).filter(v => v.name !== name); list.push({ name, ...cur }); all[box.dataset.sig] = list.slice(-12); saveViews(all); syncPush(box.dataset.sig);
        fillViews(box, all[box.dataset.sig].findIndex(v => v.name === name));
      });
      box.querySelector('.tf-del').addEventListener('click', () => {
        const sel = box.querySelector('.tf-views'), all = loadViews(), list = all[box.dataset.sig] || [], v = list[Number(sel.value)]; if (!v || !confirm(`Delete the view "${v.name}"?`)) return;
        list.splice(Number(sel.value), 1); all[box.dataset.sig] = list; saveViews(all); syncPush(box.dataset.sig); fillViews(box, null);
      });
      const csv = box.querySelector('.tf-csv'); if (csv) csv.addEventListener('click', () => exportBox(box));
    }
    box.__target = target; target.dataset.tf = '1'; if (target.tagName === 'TABLE') enableSort(target, sig); apply(box);
  }
  function scan() {
    syncPull();
    for (const t of document.querySelectorAll('table:not([data-tf])')) {
      if (t.closest('[data-nofilter],[role=dialog],.modal,#login-screen,.tf-box')) continue;
      if (items(t).length < MIN) continue;
      const scope = t.closest('.card,.page'); if (ownSearch(scope)) { t.dataset.tf = 'own'; enableSort(t, sigOf(t, 'own')); continue; }
      attach(t, 'list');
    }
    for (const c of document.querySelectorAll('[data-filterable]:not([data-tf])')) { if (items(c).length >= MIN || c.dataset.filterable === 'always') attach(c, 'list'); }
    for (const b of document.querySelectorAll('.tf-box')) if (!b.__target || !b.__target.isConnected) b.remove();   // its list was replaced and no new one took the box
  }
  // Long dropdowns (a rider to pick, a time zone): a box above narrows the choices as you type. The chosen value is kept, and nothing is sent until the app's own
  // onchange fires. Short dropdowns (under SELECT_MIN choices) and multi-selects are left alone.
  const SELECT_MIN = 25;
  function enhanceSelect(sel) {
    sel.dataset.sf = '1';
    const original = sel.innerHTML, clones = [...sel.options].map(o => o.cloneNode(true));
    const box = document.createElement('input'); box.type = 'search'; box.className = 'inp sf-input'; box.autocomplete = 'off'; box.placeholder = '🔎 Type to narrow the list…';
    box.setAttribute('aria-label', 'Narrow the choices in the list below'); box.style.cssText = 'display:block;width:100%;max-width:' + (sel.style.maxWidth || '320px') + ';font-size:12px;margin:0 0 4px';
    box.__sel = sel; sel.parentNode.insertBefore(box, sel);
    box.addEventListener('input', () => {
      const q = norm(box.value).split(/\s+/).filter(Boolean), cur = sel.value;
      if (!q.length) { sel.innerHTML = original; sel.value = cur; return; }
      const keep = clones.filter(o => o.value === cur || q.every(w => norm(o.textContent + ' ' + o.value).includes(w)));
      sel.innerHTML = ''; for (const o of keep) sel.appendChild(o.cloneNode(true)); sel.value = cur;
    });
  }
  function scanSelects() {
    for (const sel of document.querySelectorAll('select:not([data-sf]):not([multiple])')) { if (sel.options.length >= SELECT_MIN && !sel.closest('[data-nofilter]') && sel.parentNode) enhanceSelect(sel); }
    for (const b of document.querySelectorAll('.sf-input')) if (!b.__sel || !b.__sel.isConnected) b.remove();
  }

  let timer = null; const later = () => { clearTimeout(timer); timer = setTimeout(() => { scan(); scanSelects(); }, 120); };
  const start = () => { scan(); scanSelects(); new MutationObserver(later).observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.TableFilter = { scan, downloadCsv, sortTable };
})();
