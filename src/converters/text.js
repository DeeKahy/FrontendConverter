// Text / tabular conversions. No libraries needed.
//   - CSV / TSV ↔ JSON
//   - CSV ↔ TSV
//   - CSV / TSV / JSON → Markdown table
//   - TXT ↔ MD (passthrough re-encode)
//   - Text ↔ Base64

import { registerConverter } from '../registry.js';

// ---------- delimited-text (CSV/TSV) parsing ----------

// Minimal RFC-4180-style parser, parameterized by delimiter. Handles quoted
// fields, escaped quotes, and newlines inside quotes.
function parseDsv(text, delim) {
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
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
      else if (ch === '\r') { /* swallow \r, \n handles the split */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && !(r.length === 1 && r[0] === ''));
}

function dsvEscape(val, delim) {
  if (val == null) return '';
  const s = String(val);
  // Quote if the value contains the delimiter, a quote, or a newline.
  const needs = s.includes(delim) || /["\r\n]/.test(s);
  return needs ? `"${s.replace(/"/g, '""')}"` : s;
}

function toDsv(rows, delim) {
  return rows.map(r => r.map(v => dsvEscape(v, delim)).join(delim)).join('\r\n') + '\r\n';
}

// Flatten an array of objects into [header, ...rows]. Header is the union of
// all keys in first-seen order; nested values are JSON-stringified.
function jsonToRows(data) {
  if (!Array.isArray(data)) throw new Error('JSON must be an array of objects');
  const headerSet = new Map();
  for (const row of data) if (row && typeof row === 'object') {
    for (const k of Object.keys(row)) headerSet.set(k, true);
  }
  const header = [...headerSet.keys()];
  const cell = v => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v);
  const body = data.map(r => header.map(k => cell(r?.[k])));
  return [header, ...body];
}

function rowsToObjects(rows) {
  if (!rows.length) return [];
  const [header, ...data] = rows;
  return data.map(r => {
    const obj = {};
    header.forEach((key, i) => { obj[key] = r[i] ?? ''; });
    return obj;
  });
}

async function parseJsonFile(file) {
  const text = await file.text();
  try { return JSON.parse(text); }
  catch (e) { throw new Error('Not valid JSON: ' + e.message); }
}

// ---------- CSV / TSV ↔ JSON ----------

registerConverter({
  id: 'csv-json',
  name: 'CSV / TSV → JSON',
  from: ['csv', 'tsv'],
  to: ['json'],
  notes: 'First row is treated as the header. CSV uses commas, TSV uses tabs.',
  async convert(file) {
    const delim = file.name.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    const rows = parseDsv(await file.text(), delim);
    return new Blob([JSON.stringify(rowsToObjects(rows), null, 2)], { type: 'application/json' });
  }
});

registerConverter({
  id: 'json-tabular',
  name: 'JSON → CSV / TSV',
  from: ['json'],
  to: ['csv', 'tsv'],
  notes: 'Accepts an array of flat objects. Header is the union of all keys, in first-seen order.',
  async convert(file, targetExt) {
    const rows = jsonToRows(await parseJsonFile(file));
    const delim = targetExt === 'tsv' ? '\t' : ',';
    const mime = targetExt === 'tsv' ? 'text/tab-separated-values' : 'text/csv';
    return new Blob([toDsv(rows, delim)], { type: mime });
  }
});

// ---------- CSV ↔ TSV ----------

registerConverter({
  id: 'csv-tsv',
  name: 'CSV ↔ TSV',
  from: ['csv', 'tsv'],
  to: ['csv', 'tsv'],
  notes: 'Re-delimits between commas and tabs, preserving quoting where needed.',
  async convert(file, targetExt) {
    const fromTab = file.name.toLowerCase().endsWith('.tsv');
    const rows = parseDsv(await file.text(), fromTab ? '\t' : ',');
    const delim = targetExt === 'tsv' ? '\t' : ',';
    const mime = targetExt === 'tsv' ? 'text/tab-separated-values' : 'text/csv';
    return new Blob([toDsv(rows, delim)], { type: mime });
  }
});

// ---------- → Markdown table ----------

function rowsToMarkdown(rows) {
  if (!rows.length) return '';
  const esc = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const [header, ...body] = rows;
  const line = cells => `| ${cells.map(esc).join(' | ')} |`;
  const out = [line(header), `| ${header.map(() => '---').join(' | ')} |`];
  for (const r of body) {
    // Pad/truncate each row to the header width so the table stays valid.
    const cells = header.map((_, i) => r[i] ?? '');
    out.push(line(cells));
  }
  return out.join('\n') + '\n';
}

registerConverter({
  id: 'table-markdown',
  name: 'CSV / TSV / JSON → Markdown table',
  from: ['csv', 'tsv', 'json'],
  to: ['md'],
  notes: 'Renders tabular data as a GitHub-flavored Markdown table.',
  async convert(file) {
    const ext = file.name.toLowerCase();
    let rows;
    if (ext.endsWith('.json')) {
      rows = jsonToRows(await parseJsonFile(file));
    } else {
      rows = parseDsv(await file.text(), ext.endsWith('.tsv') ? '\t' : ',');
    }
    return new Blob([rowsToMarkdown(rows)], { type: 'text/markdown' });
  }
});

// ---------- TXT ↔ MD ----------

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

// ---------- Base64 ----------

registerConverter({
  id: 'text-base64',
  name: 'Text → Base64',
  from: ['txt', 'md', 'json', 'csv', 'tsv'],
  to: ['b64'],
  notes: 'Encodes UTF-8 text as a Base64 string.',
  async convert(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return new Blob([btoa(binary)], { type: 'text/plain' });
  }
});

registerConverter({
  id: 'base64-text',
  name: 'Base64 → Text',
  from: ['b64'],
  to: ['txt'],
  notes: 'Decodes a Base64 string back to UTF-8 text.',
  async convert(file) {
    const raw = (await file.text()).replace(/\s+/g, '');
    let binary;
    try { binary = atob(raw); }
    catch { throw new Error('Input is not valid Base64'); }
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new Blob([new TextDecoder().decode(bytes)], { type: 'text/plain' });
  }
});
