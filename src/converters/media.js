// Audio / video conversion via ffmpeg.wasm — the big one (~30 MB of WASM).
//
// FFmpeg files are loaded from /vendor/ffmpeg/ (same-origin), NOT from a CDN.
// This avoids two production headaches that bite hard on GitHub Pages:
//   1. esm.sh/jsdelivr serving raw .wasm sometimes hangs or 404s.
//   2. FFmpeg.wasm spawns Web Workers; cross-origin workers without proper
//      COOP/COEP headers (which GH Pages doesn't let you set) frequently
//      stall on "loading" forever.
//
// Run scripts/fetch-vendor.sh once (or scripts/fetch-vendor.mjs on Windows)
// to populate vendor/ffmpeg/ before deploying.
//
// Loading is lazy: nothing in this file fetches FFmpeg until a media
// conversion actually runs.

import { registerConverter } from '../registry.js';

// Resolve vendor/ffmpeg/ relative to *this file*. Works regardless of the
// page's URL (so the app keeps working under a GH Pages subpath like
// https://you.github.io/FrontendConverter/).
const VENDOR_BASE = new URL('../../vendor/ffmpeg/', import.meta.url).href;

let ffmpegInstance;       // cached, reused across conversions
let ffmpegLoading;        // de-dupe concurrent loads

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[data-vendor="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.dataset.vendor = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(
      `Failed to load ${src}.\n` +
      `Did you run scripts/fetch-vendor.sh? See README → "Deploying to GitHub Pages".`
    ));
    document.head.appendChild(s);
  });
}

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;

  ffmpegLoading = (async () => {
    onProgress?.(0.05, 'Loading FFmpeg…');
    // UMD bundles export to globals (window.FFmpegWASM, window.FFmpegUtil).
    // The bundle inlines the inner Worker so we don't have a cross-origin
    // worker URL to fight.
    await loadScriptOnce(`${VENDOR_BASE}ffmpeg.js`);
    await loadScriptOnce(`${VENDOR_BASE}util.js`);

    const FFmpegWASM = self.FFmpegWASM;
    const FFmpegUtil = self.FFmpegUtil;
    if (!FFmpegWASM?.FFmpeg || !FFmpegUtil?.toBlobURL) {
      throw new Error(
        'FFmpeg vendor files loaded but did not register expected globals.\n' +
        'Re-run scripts/fetch-vendor.sh — versions may have drifted.'
      );
    }
    const { FFmpeg } = FFmpegWASM;
    const { toBlobURL } = FFmpegUtil;

    const ff = new FFmpeg();
    ff.on('progress', ({ progress }) => {
      if (typeof progress === 'number' && isFinite(progress)) {
        onProgress?.(0.4 + Math.min(Math.max(progress, 0), 1) * 0.55);
      }
    });

    onProgress?.(0.15, 'Fetching FFmpeg core…');
    await ff.load({
      coreURL: await toBlobURL(`${VENDOR_BASE}ffmpeg-core.js`,   'text/javascript'),
      wasmURL: await toBlobURL(`${VENDOR_BASE}ffmpeg-core.wasm`, 'application/wasm'),
    });

    onProgress?.(0.4, 'FFmpeg ready');
    ffmpegInstance = ff;
    return ff;
  })();

  try { return await ffmpegLoading; } finally { ffmpegLoading = null; }
}

async function runFFmpeg(file, targetExt, args, { onProgress } = {}) {
  const ff = await getFFmpeg(onProgress);
  const inputName = `in.${file.name.split('.').pop()?.toLowerCase() || 'bin'}`;
  const outputName = `out.${targetExt}`;

  const buf = new Uint8Array(await file.arrayBuffer());
  await ff.writeFile(inputName, buf);

  const fullArgs = ['-i', inputName, ...args, outputName];
  await ff.exec(fullArgs);

  const data = await ff.readFile(outputName);
  // Clean up the virtual filesystem so repeat runs don't collide.
  try { await ff.deleteFile(inputName); } catch {}
  try { await ff.deleteFile(outputName); } catch {}

  onProgress?.(1);
  return new Blob([data.buffer ? data.buffer : data], { type: mimeFor(targetExt) });
}

function mimeFor(ext) {
  return ({
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
    mp4: 'video/mp4',
    webm: 'video/webm',
    gif: 'image/gif',
  })[ext] || 'application/octet-stream';
}

// ----- audio -----

registerConverter({
  id: 'audio-ffmpeg',
  name: 'Audio transcode',
  from: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'],
  to:   ['mp3', 'wav', 'ogg'],
  heavy: true,
  notes: 'Uses FFmpeg.wasm (vendored locally). First run loads ~30 MB; subsequent runs are instant.',
  async convert(file, targetExt, opts) {
    const argMap = {
      mp3: ['-codec:a', 'libmp3lame', '-b:a', '192k'],
      ogg: ['-codec:a', 'libvorbis', '-q:a', '5'],
      wav: ['-codec:a', 'pcm_s16le'],
    };
    return runFFmpeg(file, targetExt, argMap[targetExt] || [], opts);
  }
});

// ----- video -----

registerConverter({
  id: 'video-ffmpeg',
  name: 'Video transcode / extract',
  from: ['mp4', 'mov', 'webm', 'mkv', 'avi'],
  to:   ['mp4', 'webm', 'gif', 'mp3'],
  heavy: true,
  notes: 'Uses FFmpeg.wasm (vendored locally). MP4→MP3 extracts audio. Video→GIF makes a 480px, 12fps clip.',
  async convert(file, targetExt, opts) {
    if (targetExt === 'mp3') {
      return runFFmpeg(file, 'mp3', ['-vn', '-codec:a', 'libmp3lame', '-b:a', '192k'], opts);
    }
    if (targetExt === 'gif') {
      return runFFmpeg(file, 'gif', ['-vf', 'fps=12,scale=480:-1:flags=lanczos', '-loop', '0'], opts);
    }
    if (targetExt === 'webm') {
      return runFFmpeg(file, 'webm', ['-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libvorbis'], opts);
    }
    // mp4
    return runFFmpeg(file, 'mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac'], opts);
  }
});
