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
/** @type {Map<string, {file: File, fromExt: string, el: HTMLElement}>} */
const queue = new Map();
let queueIdCounter = 0;

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
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) addFiles(files);
});
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
  for (const { el } of queue.values()) el.remove();
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
  }

  $('.qconvert', node).addEventListener('click', () => runOne(id));
  $('.qremove', node).addEventListener('click', () => {
    node.remove();
    queue.delete(id);
    if (queue.size === 0) queueEl.hidden = true;
  });

  queueList.appendChild(node);
  queue.set(id, { file, fromExt, el: node });
}

// ---------- running a conversion ----------
async function runOne(id) {
  const entry = queue.get(id);
  if (!entry) return;
  const { file, fromExt, el } = entry;

  const select  = $('.qtarget', el);
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

  btn.disabled = true; select.disabled = true;
  result.hidden = true; result.innerHTML = '';
  status.className = 'qstatus working';
  renderProgress(status, 0, conv.heavy ? 'Preparing heavy dependency…' : 'Converting…');

  try {
    const raw = await conv.convert(file, toExt, {
      onProgress(p, msg) { renderProgress(status, p, msg); }
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

    // One link per output.
    const links = [];
    for (const { blob, name } of outputs) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.textContent = `Download ${name}`;
      result.appendChild(a);
      links.push(a);
    }

    // "Download all" for multi-output conversions — clicks each link with a
    // small delay so browsers actually save them all instead of collapsing
    // the requests.
    if (outputs.length > 1) {
      const allBtn = document.createElement('button');
      allBtn.className = 'primary small';
      allBtn.textContent = `Download all (${outputs.length})`;
      allBtn.addEventListener('click', async () => {
        for (const a of links) {
          a.click();
          await new Promise(r => setTimeout(r, 120));
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
