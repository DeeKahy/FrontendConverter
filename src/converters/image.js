// Raster image conversions via the built-in Canvas API.
// No external libraries needed — the browser already speaks PNG, JPEG, WebP.

import { registerConverter } from '../registry.js';

const MIME = {
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

async function fileToImageBitmap(file) {
  // ImageBitmap is faster + doesn't need DOM attachment.
  if (self.createImageBitmap) {
    try { return await createImageBitmap(file); } catch (_) { /* fall through */ }
  }
  // Fallback for older browsers / certain formats.
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function canvasToBlob(canvas, mime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => b ? resolve(b) : reject(new Error(`toBlob failed for ${mime}`)), mime, quality);
  });
}

registerConverter({
  id: 'canvas-raster',
  name: 'Canvas raster converter',
  from: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'],
  to:   ['png', 'jpg', 'jpeg', 'webp'],
  notes: 'Built-in Canvas API. JPEG adds a white background (JPEG has no alpha).',
  options: [
    { id: 'quality', label: 'Quality (JPEG/WebP)', type: 'range',
      min: 0.3, max: 1, step: 0.01, default: 0.92,
      format: v => `${Math.round(v * 100)}%` },
    { id: 'scale', label: 'Scale', type: 'range',
      min: 0.1, max: 4, step: 0.1, default: 1, format: v => `${v}×` },
  ],
  async convert(file, targetExt, { onProgress, options } = {}) {
    const quality = clamp(options?.quality ?? 0.92, 0.05, 1);
    const scale   = clamp(options?.scale ?? 1, 0.05, 8);
    onProgress?.(0.1);
    const bitmap = await fileToImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');

    if (targetExt === 'jpg' || targetExt === 'jpeg') {
      // JPEG has no alpha channel — flatten onto white to avoid black bg.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    onProgress?.(0.6);

    const mime = MIME[targetExt] || MIME.png;
    const q = (targetExt === 'jpg' || targetExt === 'jpeg' || targetExt === 'webp') ? quality : undefined;
    const blob = await canvasToBlob(canvas, mime, q);
    onProgress?.(1);
    if (bitmap.close) bitmap.close();
    return blob;
  }
});

function clamp(n, lo, hi) {
  n = Number(n);
  if (!isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
