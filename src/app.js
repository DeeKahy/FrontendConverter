// Main app: drag/drop, queue, conversion, download links, support grid.
//
// Everything extension-related goes through the registry — nothing in this
// file hardcodes a specific format.

import './converters/index.js'; // side-effect: registers every built-in converter
import {
  listConverters,
  findConverter,
  targetsFor,
  extOf,
  normExt,
} from './registry.js';
import { makeZip } from './zip.js';

// ---------- DOM helpers ----------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const dropzone  = $('#drop');
const fileInput = $('#file-input');
const queueEl   = $('#queue');
const queueList = $('#queue-list');
const convertAllBtn = $('#convert-all');
const clearAllBtn   = $('#clear-all');
const browseBtn     = $('#browse');
const tpl           = $('#queue-item-tpl');
const grid          = $('#support-grid');

// ---------- queue state ----------
/** @type {Map<string, {file: File, fromExt: string, el: HTMLElement, urls: string[]}>} */
const queue = new Map();
let queueIdCounter = 0;

// Revoke any object URLs an item is holding so converted blobs can be GC'd.
function releaseUrls(entry) {
  if (!entry?.urls) return;
  for (const u of entry.urls) URL.revokeObjectURL(u);
  entry.urls = [];
}

function dropEntry(id) {
  const entry = queue.get(id);
  if (!entry) return;
  releaseUrls(entry);
  entry.el.remove();
  queue.delete(id);
  if (queue.size === 0) queueEl.hidden = true;
}

// ---------- wiring ----------
dropzone.addEventListener('click', (e) => {
  if (e.target.closest('button,a,select')) return;
  fileInput.click();
});
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
browseBtn.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

['dragenter', 'dragover'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); })
);
['dragleave', 'drop'].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove('drag-over'); })
);
dropzone.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  // Detect folders: a dropped directory shows up as an item whose
  // webkitGetAsEntry() is a directory but contributes no File. Browsers
  // don't expand folders for us here, so flag it instead of silently
  // dropping everything.
  const items = dt?.items ? [...dt.items] : [];
  const hasDir = items.some(it => {
    const entry = it.webkitGetAsEntry?.();
    return entry && entry.isDirectory;
  });

  const files = [...(dt?.files || [])].filter(f => {
    // Folders sometimes appear as zero-byte, type-less File entries.
    if (hasDir && f.size === 0 && f.type === '') return false;
    return true;
  });

  if (files.length) addFiles(files);
  if (hasDir) {
    flashDropNote('Folders aren’t supported — drop individual files instead.');
  } else if (!files.length) {
    flashDropNote('No files found in that drop.');
  }
});

// Briefly show a hint inside the dropzone.
let dropNoteTimer;
function flashDropNote(msg) {
  let note = $('.drop-note', dropzone);
  if (!note) {
    note = document.createElement('p');
    note.className = 'drop-note small';
    $('.drop-inner', dropzone)?.appendChild(note);
  }
  note.textContent = msg;
  note.hidden = false;
  clearTimeout(dropNoteTimer);
  dropNoteTimer = setTimeout(() => { note.hidden = true; }, 4000);
}
fileInput.addEventListener('change', () => {
  if (fileInput.files?.length) addFiles([...fileInput.files]);
  fileInput.value = '';
});

convertAllBtn.addEventListener('click', async () => {
  for (const { el } of queue.values()) {
    const btn = el.querySelector('.qconvert');
    if (btn && !btn.disabled) btn.click();
    // Let the UI breathe between items.
    await new Promise(r => setTimeout(r, 0));
  }
});
clearAllBtn.addEventListener('click', () => {
  for (const entry of queue.values()) { releaseUrls(entry); entry.el.remove(); }
  queue.clear();
  queueEl.hidden = true;
});

// ---------- adding files ----------
function addFiles(files) {
  for (const file of files) addOne(file);
  queueEl.hidden = queue.size === 0;
}

function addOne(file) {
  const id = `q${++queueIdCounter}`;
  const fromExt = extOf(file.name);
  const node = tpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = id;

  $('.qname', node).textContent = file.name;
  $('.qmeta', node).textContent =
    `${humanSize(file.size)} · .${fromExt || '?'} · ${file.type || 'unknown type'}`;

  const select = $('.qtarget', node);
  const optionsEl = $('.qoptions', node);
  const targets = targetsFor(fromExt);
  if (!targets.length) {
    select.disabled = true;
    const opt = document.createElement('option');
    opt.textContent = fromExt ? `No converters for .${fromExt}` : 'Unknown file type';
    select.appendChild(opt);
    $('.qconvert', node).disabled = true;
  } else {
    for (const t of targets) {
      const opt = document.createElement('option');
      opt.value = t;
      const conv = findConverter(fromExt, t);
      opt.textContent = conv?.heavy ? `.${t}  (FFmpeg)` : `.${t}`;
      select.appendChild(opt);
    }
    // Options depend on the chosen converter, so (re)render them whenever the
    // target format changes — and once now for the default selection.
    const syncOptions = () =>
      renderOptions(optionsEl, findConverter(fromExt, normExt(select.value)));
    select.addEventListener('change', syncOptions);
    syncOptions();
  }

  $('.qconvert', node).addEventListener('click', () => runOne(id));
  $('.qremove', node).addEventListener('click', () => dropEntry(id));

  queueList.appendChild(node);
  queue.set(id, { file, fromExt, el: node, urls: [] });
}

// ---------- running a conversion ----------
async function runOne(id) {
  const entry = queue.get(id);
  if (!entry) return;
  const { file, fromExt, el } = entry;

  const select  = $('.qtarget', el);
  const optionsEl = $('.qoptions', el);
  const btn     = $('.qconvert', el);
  const status  = $('.qstatus', el);
  const result  = $('.qresult', el);
  const toExt   = normExt(select.value);

  if (!toExt) return;

  const conv = findConverter(fromExt, toExt);
  if (!conv) {
    status.textContent = `No converter from .${fromExt} to .${toExt}`;
    status.className = 'qstatus error';
    return;
  }

  // Re-converting: free the previous run's download URLs first.
  releaseUrls(entry);

  btn.disabled = true; select.disabled = true;
  result.hidden = true; result.innerHTML = '';
  status.className = 'qstatus working';
  renderProgress(status, 0, conv.heavy ? 'Preparing heavy dependency…' : 'Converting…');

  try {
    const raw = await conv.convert(file, toExt, {
      onProgress(p, msg) { renderProgress(status, p, msg); },
      options: readOptions(optionsEl),
    });

    // Normalize: converter may return a single Blob or [{blob,name}, ...].
    const outputs = Array.isArray(raw)
      ? raw
      : [{ blob: raw, name: swapExt(file.name, toExt) }];

    const totalSize = outputs.reduce((n, o) => n + o.blob.size, 0);

    status.className = 'qstatus ok';
    status.textContent = outputs.length === 1
      ? `Done · ${humanSize(totalSize)} · via ${conv.name}`
      : `Done · ${outputs.length} files · ${humanSize(totalSize)} · via ${conv.name}`;

    result.hidden = false;

    // One link per output. Track the URLs so they can be revoked later.
    for (const { blob, name } of outputs) {
      const url = URL.createObjectURL(blob);
      entry.urls.push(url);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.textContent = `Download ${name}`;
      result.appendChild(a);
    }

    // "Download all" for multi-output conversions: bundle into a single ZIP
    // so the browser saves one file instead of firing N downloads (which
    // triggers the "allow multiple downloads?" prompt and often drops files).
    if (outputs.length > 1) {
      const zipName = `${swapExt(file.name, '').replace(/\.$/, '')}.zip`;
      const allBtn = document.createElement('button');
      allBtn.className = 'primary small';
      allBtn.textContent = `Download all (${outputs.length}) as .zip`;
      allBtn.addEventListener('click', async () => {
        allBtn.disabled = true;
        const prev = allBtn.textContent;
        allBtn.textContent = 'Zipping…';
        try {
          const zip = await makeZip(outputs);
          const url = URL.createObjectURL(zip);
          entry.urls.push(url);
          const a = document.createElement('a');
          a.href = url;
          a.download = zipName;
          a.click();
        } finally {
          allBtn.disabled = false;
          allBtn.textContent = prev;
        }
      });
      result.prepend(allBtn);
    }
  } catch (err) {
    console.error(err);
    status.className = 'qstatus error';
    status.textContent = `Failed: ${err.message || err}`;
  } finally {
    btn.disabled = false; select.disabled = false;
  }
}

function renderProgress(container, p, msg) {
  container.innerHTML = '';
  const label = document.createElement('div');
  label.textContent = msg || `Working… ${Math.round((p || 0) * 100)}%`;
  container.appendChild(label);

  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('span');
  fill.style.width = `${Math.min(100, Math.max(0, (p || 0) * 100))}%`;
  bar.appendChild(fill);
  container.appendChild(bar);
}

// ---------- per-converter options ----------
// A converter may declare an `options` array; we render a small control for
// each one under the queue item. Shapes:
//   { id, label, type: 'range', min, max, step, default, format? }
//   { id, label, type: 'select', default, choices: [{value, label}] }
function renderOptions(container, conv) {
  container.innerHTML = '';
  const opts = conv?.options;
  if (!opts?.length) { container.hidden = true; return; }
  container.hidden = false;

  for (const opt of opts) {
    const wrap = document.createElement('label');
    wrap.className = 'qopt';

    const name = document.createElement('span');
    name.className = 'qopt-label';
    name.textContent = opt.label;
    wrap.appendChild(name);

    let input;
    if (opt.type === 'select') {
      input = document.createElement('select');
      for (const c of opt.choices) {
        const o = document.createElement('option');
        o.value = c.value;
        o.textContent = c.label;
        if (String(c.value) === String(opt.default)) o.selected = true;
        input.appendChild(o);
      }
    } else {
      input = document.createElement('input');
      input.type = opt.type === 'range' ? 'range' : 'number';
      if (opt.min != null)  input.min = opt.min;
      if (opt.max != null)  input.max = opt.max;
      if (opt.step != null) input.step = opt.step;
      input.value = opt.default;
    }
    input.dataset.optId = opt.id;
    input.dataset.optKind = opt.type === 'select' ? 'select' : 'number';
    wrap.appendChild(input);

    if (opt.type === 'range') {
      const val = document.createElement('span');
      val.className = 'qopt-val';
      const fmt = opt.format || (v => v);
      val.textContent = fmt(opt.default);
      input.addEventListener('input', () => { val.textContent = fmt(input.value); });
      wrap.appendChild(val);
    }

    container.appendChild(wrap);
  }
}

function readOptions(container) {
  const out = {};
  for (const input of $$('[data-opt-id]', container)) {
    const v = input.value;
    out[input.dataset.optId] = input.dataset.optKind === 'number' ? parseFloat(v) : v;
  }
  return out;
}

function swapExt(filename, newExt) {
  const base = filename.replace(/\.[^./\\]+$/, '');
  return `${base}.${newExt}`;
}

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------- supported formats grid (rendered from the registry) ----------
function renderSupportGrid() {
  grid.innerHTML = '';
  const list = listConverters().slice().sort((a, b) => {
    if (!!a.heavy === !!b.heavy) return a.name.localeCompare(b.name);
    return a.heavy ? 1 : -1; // heavy ones at the end
  });
  for (const c of list) {
    const card = document.createElement('div');
    card.className = 'support-card';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = c.name;
    const pairs = document.createElement('div');
    pairs.className = 'pairs';
    pairs.textContent = `${c.from.map(x => '.' + x).join(' / ')} → ${c.to.map(x => '.' + x).join(' / ')}`;
    card.appendChild(name);
    card.appendChild(pairs);
    if (c.notes) {
      const notes = document.createElement('div');
      notes.className = 'muted small';
      notes.style.marginTop = '6px';
      notes.textContent = c.notes;
      card.appendChild(notes);
    }
    if (c.heavy) {
      const badge = document.createElement('span');
      badge.className = 'heavy';
      badge.textContent = 'Loads on demand';
      card.appendChild(badge);
    }
    grid.appendChild(card);
  }
}
renderSupportGrid();
