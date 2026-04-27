// Audio / video conversion via ffmpeg.wasm — the big one (~30 MB of WASM).
//
// The heavy lifting is gated behind getFFmpeg() so nothing FFmpeg-related is
// fetched until the user actually runs a media conversion.
//
// If the CDN fails to load, the converter surfaces a clear error instead of
// silently hanging.

import { registerConverter } from '../registry.js';

// Keep these aligned with one another — 0.12.x of @ffmpeg/ffmpeg uses the
// multi-threaded core by default. umd builds exist but we want ESM.
const FFMPEG_URL = 'https://esm.sh/@ffmpeg/ffmpeg@0.12.10';
const UTIL_URL   = 'https://esm.sh/@ffmpeg/util@0.12.1';
const CORE_URL   = 'https://esm.sh/@ffmpeg/core@0.12.6/dist/esm';

let ffmpegInstance;           // cached instance, reused between conversions
let ffmpegLoading;            // de-dupe concurrent loads

async function getFFmpeg(onProgress) {
  if (ffmpegInstance) return ffmpegInstance;
  if (ffmpegLoading) return ffmpegLoading;
  ffmpegLoading = (async () => {
    onProgress?.(0.02, 'Downloading FFmpeg (~30 MB, one-time)…');
    const [{ FFmpeg }, util] = await Promise.all([
      import(/* @vite-ignore */ FFMPEG_URL),
      import(/* @vite-ignore */ UTIL_URL),
    ]);
    const ff = new FFmpeg();
    ff.on('progress', ({ progress }) => {
      // FFmpeg reports per-conversion progress in 0..1.
      if (typeof progress === 'number' && isFinite(progress)) {
        onProgress?.(0.4 + Math.min(Math.max(progress, 0), 1) * 0.55);
      }
    });
    onProgress?.(0.1, 'Fetching FFmpeg core…');
    await ff.load({
      coreURL:   await util.toBlobURL(`${CORE_URL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL:   await util.toBlobURL(`${CORE_URL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    onProgress?.(0.38, 'FFmpeg ready');
    ffmpegInstance = ff;
    return ff;
  })();
  try { return await ffmpegLoading; } finally { ffmpegLoading = null; }
}

async function runFFmpeg(file, targetExt, args, { onProgress } = {}) {
  const ff = await getFFmpeg(onProgress);
  const inputName = `in.${file.name.split('.').pop()?.toLowerCase() || 'bin'}`;
  const outputName = `out.${targetExt}`;

  // Write input.
  const buf = new Uint8Array(await file.arrayBuffer());
  await ff.writeFile(inputName, buf);

  // Build args: -i <input> ...user... <output>
  const fullArgs = ['-i', inputName, ...args, outputName];
  await ff.exec(fullArgs);

  const data = await ff.readFile(outputName);
  // Clean up the virtual filesystem so repeat runs don't collide.
  try { await ff.deleteFile(inputName); } catch {}
  try { await ff.deleteFile(outputName); } catch {}

  onProgress?.(1);
  const mime = mimeFor(targetExt);
  return new Blob([data.buffer ? data.buffer : data], { type: mime });
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
  notes: 'Uses FFmpeg.wasm. First run downloads ~30 MB; subsequent runs are instant.',
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
  notes: 'Uses FFmpeg.wasm. MP4→MP3 extracts audio. MP4→GIF produces a 480px, 12fps clip.',
  async convert(file, targetExt, opts) {
    if (targetExt === 'mp3') {
      return runFFmpeg(file, 'mp3', ['-vn', '-codec:a', 'libmp3lame', '-b:a', '192k'], opts);
    }
    if (targetExt === 'gif') {
      // Palette-free single-pass GIF — good enough for short clips.
      return runFFmpeg(file, 'gif', ['-vf', 'fps=12,scale=480:-1:flags=lanczos', '-loop', '0'], opts);
    }
    if (targetExt === 'webm') {
      return runFFmpeg(file, 'webm', ['-c:v', 'libvpx', '-b:v', '1M', '-c:a', 'libvorbis'], opts);
    }
    // mp4
    return runFFmpeg(file, 'mp4', ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac'], opts);
  }
});
