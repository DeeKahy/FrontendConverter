#!/usr/bin/env node
// Cross-platform equivalent of fetch-vendor.sh — same job, runs on any OS
// that has Node 18+.
//
//   node scripts/fetch-vendor.mjs

import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const FFMPEG_VER = '0.12.10';
const UTIL_VER   = '0.12.1';
const CORE_VER   = '0.12.6';

const VENDOR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'vendor', 'ffmpeg');

const files = [
  ['ffmpeg.js',          `https://unpkg.com/@ffmpeg/ffmpeg@${FFMPEG_VER}/dist/umd/ffmpeg.js`],
  ['util.js',            `https://unpkg.com/@ffmpeg/util@${UTIL_VER}/dist/umd/index.js`],
  ['ffmpeg-core.js',     `https://unpkg.com/@ffmpeg/core@${CORE_VER}/dist/umd/ffmpeg-core.js`],
  ['ffmpeg-core.wasm',   `https://unpkg.com/@ffmpeg/core@${CORE_VER}/dist/umd/ffmpeg-core.wasm`],
];

await mkdir(VENDOR, { recursive: true });

console.log(`Fetching FFmpeg vendor files into ${VENDOR}/ …`);
for (const [name, url] of files) {
  process.stdout.write(`  ${name.padEnd(20)}`);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) {
    console.error(` FAILED ${r.status} ${r.statusText}`);
    process.exit(1);
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  await writeFile(path.join(VENDOR, name), buf);
  console.log(`  ${(buf.byteLength / 1024).toFixed(0)} KB`);
}

await writeFile(path.join(VENDOR, 'MANIFEST.json'), JSON.stringify({
  '@ffmpeg/ffmpeg': FFMPEG_VER,
  '@ffmpeg/util':   UTIL_VER,
  '@ffmpeg/core':   CORE_VER,
  fetched_at: new Date().toISOString(),
}, null, 2));

const total = (await Promise.all(files.map(([n]) => stat(path.join(VENDOR, n)))))
  .reduce((sum, s) => sum + s.size, 0);
console.log(`\nDone. Total: ${(total / 1024 / 1024).toFixed(1)} MB`);
console.log(`Next: git add vendor/ && git commit -m 'vendor ffmpeg' && git push`);
