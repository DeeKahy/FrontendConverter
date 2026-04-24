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
  async convert(file, targetExt, { onProgress } = {}) {
    onProgress?.(0.1);
    const bitmap = await fileToImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');

    if (targetExt === 'jpg' || targetExt === 'jpeg') {
      // JPEG has no alpha channel — flatten onto white to avoid black bg.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(bitmap, 0, 0);
    onProgress?.(0.6);

    const mime = MIME[targetExt] || MIME.png;
    const quality = (targetExt === 'jpg' || targetExt === 'jpeg' || targetExt === 'webp') ? 0.92 : undefined;
    const blob = await canvasToBlob(canvas, mime, quality);
    onProgress?.(1);
    if (bitmap.close) bitmap.close();
    return blob;
  }
});
