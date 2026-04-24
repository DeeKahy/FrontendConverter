// Text-based conversions. No libraries needed.
//   - JSON ↔ CSV
//   - TXT ↔ MD (effectively a rename, but we still re-encode cleanly)

import { registerConverter } from '../registry.js';

// Minimal RFC-4180 CSV parser — handles quoted fields, escaped quotes, newlines in quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else if (ch === '\r') { /* swallow \r, \n handles the split */ }
      else field += ch;
    }
  }
  // Last field/row if no trailing newline.
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return rows.map(r => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

registerConverter({
  id: 'csv-json',
  name: 'CSV → JSON',
  from: ['csv'],
  to: ['json'],
  notes: 'First CSV row is treated as the header.',
  async convert(file) {
    const text = await file.text();
    const rows = parseCsv(text).filter(r => r.length && !(r.length === 1 && r[0] === ''));
    if (!rows.length) return new Blob(['[]'], { type: 'application/json' });
    const [header, ...data] = rows;
    const out = data.map(r => {
      const obj = {};
      header.forEach((key, i) => { obj[key] = r[i] ?? ''; });
      return obj;
    });
    return new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  }
});

registerConverter({
  id: 'json-csv',
  name: 'JSON → CSV',
  from: ['json'],
  to: ['csv'],
  notes: 'Accepts an array of flat objects. Header is the union of all keys, in first-seen order.',
  async convert(file) {
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('Not valid JSON: ' + e.message); }
    if (!Array.isArray(data)) throw new Error('JSON must be an array of objects for CSV export');
    const headerSet = new Map();
    for (const row of data) if (row && typeof row === 'object') {
      for (const k of Object.keys(row)) if (!headerSet.has(k)) headerSet.set(k, true);
    }
    const header = [...headerSet.keys()];
    const rows = [header, ...data.map(r => header.map(k => {
      const v = r?.[k];
      if (v == null) return '';
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    }))];
    return new Blob([toCsv(rows)], { type: 'text/csv' });
  }
});

registerConverter({
  id: 'txt-md',
  name: 'Plain text ↔ Markdown',
  from: ['txt', 'md', 'markdown'],
  to:   ['txt', 'md'],
  notes: 'Passthrough — same content, different extension/MIME.',
  async convert(file, targetExt) {
    const text = await file.text();
    const mime = targetExt === 'md' ? 'text/markdown' : 'text/plain';
    return new Blob([text], { type: mime });
  }
});
