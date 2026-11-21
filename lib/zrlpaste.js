'use strict';
// Reads a results table that was copied straight off a web page (WTRL's standings, a team page, a spreadsheet) when it has no heading row, or its cells are
// separated by spaces or sit one per line, and its places look like "1st", "T2", "#3" or "▲2 4". It finds our teams by name, the place beside each one and how many
// teams are in the table, and hands back an ordinary table with a heading row: Team, Position, Teams started.
const csv = require('./csv');

// Arrows, movement marks and bracketed changes ("(+2)", "▲3") are decoration, not part of a cell.
const tidy = s => String(s == null ? '' : s).replace(/[▲▼△▽↑↓⬆⬇⇧⇩▴▾]\s*\d*/g, ' ').replace(/\(\s*[+\-–]?\s*\d+\s*\)/g, ' ').replace(/\s+/g, ' ').trim();
const asInt = s => { const m = /^[#T]?\s*(\d{1,4})\s*(?:st|nd|rd|th)?$/i.exec(tidy(s)); return m ? Number(m[1]) : null; };

// Cells from text: tabs, commas or semicolons first; else two or more spaces; else one cell per line grouped by a repeating pattern.
function rowsOf(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const t = csv.parseTable(src), wide = rows => rows.length && rows.filter(r => r.length >= 2).length >= Math.max(2, rows.length * 0.6);
  if (wide(t)) return t;
  const lines = src.split('\n').map(l => l.trim()).filter(Boolean);
  const spaced = lines.map(l => l.split(/\s{2,}/).map(x => x.trim()).filter(Boolean));
  if (wide(spaced)) return spaced;
  // One cell per line: the first cell of each group is a place that counts up (1, 2, 3 ...); find the group size that makes that true.
  for (let p = 2; p <= 10; p++) {
    const heads = []; for (let i = 0; i < lines.length; i += p) heads.push(asInt(lines[i]));
    const ok = heads.length >= 3 && heads.every((v, i) => v != null && (i === 0 || v >= heads[i - 1]));
    if (ok) { const out = []; for (let i = 0; i + p <= lines.length; i += p) out.push(lines.slice(i, i + p)); return out; }
  }
  return t;
}

// `isOurs(name)` says whether a cell names one of our teams. Returns a table with a heading row, or null when none of our teams is in the text.
function toTable(text, isOurs) {
  const rows = rowsOf(text).map(r => r.map(tidy));
  if (rows.length < 1) return null;
  const width = Math.max(...rows.map(r => r.length));
  let team = -1, best = 0;
  for (let c = 0; c < width; c++) { const n = rows.filter(r => r[c] && isOurs(r[c])).length; if (n > best) { best = n; team = c; } }
  if (team < 0) return null;
  // The name cell may carry the place or a club tag; use the cell that names our team, but as the whole cell text.
  // Place: the column (left of the team by preference) whose cells are whole numbers that never go down the page.
  const asc = c => { const v = rows.map(r => asInt(r[c])).filter(x => x != null); return v.length >= Math.max(2, rows.length * 0.6) && v.every((x, i) => i === 0 || x >= v[i - 1]); };
  const order = [...Array(width).keys()].filter(c => c !== team).sort((a, b) => (b < team) - (a < team) || Math.abs(a - team) - Math.abs(b - team));
  const pos = order.find(asc);
  const place = (r, i) => (pos != null ? asInt(r[pos]) : null) ?? i + 1;   // no place column: the row order is the place
  const positions = rows.map((r, i) => place(r, i)), field = Math.max(...positions);
  const out = [['Team', 'Position', 'Teams started']];
  rows.forEach((r, i) => { if (r[team]) out.push([r[team], String(positions[i]), String(field)]); });
  return out;
}
module.exports = { toTable, rowsOf, tidy, asInt };
