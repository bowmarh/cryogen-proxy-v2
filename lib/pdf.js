'use strict';
// A tiny PDF writer for the club's one-page reports: text (Helvetica, regular and bold), filled rectangles for bars and boxes, A4 pages. No outside library:
// the file is built by hand (objects, a cross-reference table and a trailer) and only Latin-1 text is used, so anything else (emoji, say) becomes "?".
const A4 = [595, 842];
const latin = s => String(s == null ? '' : s).replace(/[^ -~ -ÿ]/g, '?');
const pdfText = s => latin(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const num = n => (Math.round(Number(n) * 100) / 100).toString();
// pages: [{ items: [{ t: 'text', x, y, size, bold, text, color:[r,g,b] } | { t: 'rect', x, y, w, h, color:[r,g,b] }] }]; y counts up from the bottom edge.
function buildPdf(pages) {
  const objs = [];   // 1-based object bodies
  const add = body => { objs.push(body); return objs.length; };
  const catalog = add(''), pagesObj = add(''), f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'), f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const kids = [];
  for (const pg of pages) {
    const ops = [];
    for (const it of pg.items) {
      const c = it.color || [0, 0, 0];
      if (it.t === 'rect') ops.push(`${num(c[0])} ${num(c[1])} ${num(c[2])} rg ${num(it.x)} ${num(it.y)} ${num(it.w)} ${num(it.h)} re f`);
      else if (it.t === 'text') ops.push(`BT /${it.bold ? 'F2' : 'F1'} ${num(it.size || 11)} Tf ${num(c[0])} ${num(c[1])} ${num(c[2])} rg ${num(it.x)} ${num(it.y)} Td (${pdfText(it.text)}) Tj ET`);
    }
    const stream = ops.join('\n'), content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((b, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${b}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
module.exports = { buildPdf, A4, latin };
