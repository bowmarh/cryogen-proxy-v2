'use strict';
// Reads pasted or uploaded tables (CSV, TSV or semicolons; quoted cells) into rows of text, and finds a column by the words in its heading.
function parseTable(input) {
  const src = String(input || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const first = src.split('\n').find(l => l.trim()) || '';
  const delim = [',', '\t', ';'].map(d => [d, (first.match(new RegExp(d === '\t' ? '\\t' : d, 'g')) || []).length]).sort((a, b) => b[1] - a[1])[0];
  const d = delim[1] ? delim[0] : ',', rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) { if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === d) { row.push(cell.trim()); cell = ''; }
    else if (c === '\n') { row.push(cell.trim()); cell = ''; if (row.some(x => x !== '')) rows.push(row); row = []; }
    else cell += c;
  }
  row.push(cell.trim()); if (row.some(x => x !== '')) rows.push(row);
  return rows;
}
// The first row that names columns, and the index of the first column whose heading matches each pattern (-1 when none does).
function columns(rows, patterns) {
  for (let r = 0; r < Math.min(rows.length, 6); r++) {
    const idx = Object.fromEntries(Object.entries(patterns).map(([k, re]) => [k, rows[r].findIndex(h => re.test(String(h || '').trim()))]));
    if (Object.values(idx).filter(i => i >= 0).length >= 2) return { header: r, idx };
  }
  return null;
}
module.exports = { parseTable, columns };
