#!/usr/bin/env node
// Download FFmpeg.wasm and friends into ./vendor/ so the app serves them
// same-origin. Run this once before deploying (e.g. to GitHub Pages):
//
//     node tools/vendor-ffmpeg.mjs
//
// then commit the vendor/ directory.
//
// Why: browsers refuse to instantiate Web Workers from cross-origin URLs.
// FFmpeg's class internally does `new Worker('./worker.js')` — if that worker
// lives on a CDN like esm.sh while your page is on github.io, the browser
// blocks it ("Security Error: Content at … may not load data from …").
// Serving the files from the same origin as the page avoids the issue.
//
// Total download is ~31 MB (most of it the FFmpeg WASM core). It only needs
// to happen once.

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(new URL('..', import.meta.url)));
const OUT  = join(ROOT, 'vendor');

// Pinned versions — keep these in sync with src/converters/media.js.
const FFMPEG_VER = '0.12.10';
const UTIL_VER   = '0.12.1';
const CORE_VER   = '0.12.6';

// unpkg serves raw NPM tarball contents under /dist/esm — the same files
// you'd find in node_modules. Imports inside these files use ./relative
// paths, so once they're all in one folder they resolve to each other.
const BASE = 'https://unpkg.com';

const FILES = [
  // @ffmpeg/ffmpeg — class wrapper + the worker that loads core
  ['ffmpeg/index.js',     `${BASE}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/index.js`],
  ['ffmpeg/classes.js',   `${BASE}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/classes.js`],
  ['ffmpeg/const.js',     `${BASE}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/const.js`],
  ['ffmpeg/errors.js',    `${BASE}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/errors.js`],
  ['ffmpeg/types.js',     `${BASE}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/types.js`],
  ['ffmpeg/utils.js',     `${BASE}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/utils.js`],
  ['ffmpeg/worker.js',    `${BASE}/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/esm/worker.js`],

  // @ffmpeg/util — toBlobURL, fetchFile, etc.
  ['util/index.js',       `${BASE}/@ffmpeg/util@${UTIL_VER}/dist/esm/index.js`],
  ['util/const.js',       `${BASE}/@ffmpeg/util@${UTIL_VER}/dist/esm/const.js`],
  ['util/errors.js',      `${BASE}/@ffmpeg/util@${UTIL_VER}/dist/esm/errors.js`],
  ['util/types.js',       `${BASE}/@ffmpeg/util@${UTIL_VER}/dist/esm/types.js`],

  // @ffmpeg/core — the FFmpeg WASM (the big one)
  ['core/ffmpeg-core.js',   `${BASE}/@ffmpeg/core@${CORE_VER}/dist/esm/ffmpeg-core.js`],
  ['core/ffmpeg-core.wasm', `${BASE}/@ffmpeg/core@${CORE_VER}/dist/esm/ffmpeg-core.wasm`],
];

async function fetchToFile(url, outPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, buf);
  return buf.length;
}

async function alreadyDownloaded(outPath, minBytes) {
  try {
    const s = await stat(outPath);
    return s.size >= minBytes;
  } catch { return false; }
}

const args = new Set(process.argv.slice(2));
const force = args.has('--force') || args.has('-f');

let totalBytes = 0, fetched = 0, skipped = 0;
for (const [rel, url] of FILES) {
  const out = join(OUT, rel);
  // Skip if already there and non-trivial size (lets the script be re-run cheaply).
  if (!force && await alreadyDownloaded(out, 100)) {
    skipped++;
    continue;
  }
  process.stdout.write(`  fetch ${rel} … `);
  try {
    const n = await fetchToFile(url, out);
    totalBytes += n;
    fetched++;
    console.log(`${(n / 1024).toFixed(1)} KB`);
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  }
}

console.log(`\nVendored ${fetched} file(s) (${(totalBytes / 1024 / 1024).toFixed(1)} MB), skipped ${skipped} already present.`);
console.log(`Output: ${OUT}/`);
console.log(`\nNext: commit the vendor/ directory and deploy.`);
