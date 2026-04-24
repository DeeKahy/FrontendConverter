// PDF converters. Libraries are dynamically imported from a CDN the first
// time a PDF conversion runs, so users who never touch PDFs pay nothing.
//
//   - Image → PDF    (jsPDF)
//   - PDF   → PNG    (pdfjs-dist, renders page 1 — extend as needed)

import { registerConverter } from '../registry.js';

// esm.sh bundles npm packages as ES modules usable directly in the browser.
// Pinning versions keeps the app reproducible.
const JSPDF_URL  = 'https://esm.sh/jspdf@2.5.2';
const PDFJS_URL  = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.mjs';
const PDFJS_WRKR = 'https://esm.sh/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

let jsPDFPromise;
function loadJsPDF() {
  jsPDFPromise ??= import(/* @vite-ignore */ JSPDF_URL).then(m => m.jsPDF || m.default?.jsPDF || m.default);
  return jsPDFPromise;
}

let pdfjsPromise;
function loadPdfJs() {
  pdfjsPromise ??= import(/* @vite-ignore */ PDFJS_URL).then(mod => {
    // pdf.js needs a worker URL.
    if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = PDFJS_WRKR;
    return mod;
  });
  return pdfjsPromise;
}

async function imageToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function getImageSize(dataUrl) {
  return await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = dataUrl;
  });
}

registerConverter({
  id: 'image-pdf',
  name: 'Image → PDF',
  from: ['png', 'jpg', 'jpeg', 'webp'],
  to: ['pdf'],
  heavy: false,
  notes: 'Uses jsPDF (loaded from CDN on first use). Page size matches the image.',
  async convert(file, _targetExt, { onProgress } = {}) {
    onProgress?.(0.05);
    const JsPdfCtor = await loadJsPDF();
    onProgress?.(0.4);

    const dataUrl = await imageToDataUrl(file);
    const { width, height } = await getImageSize(dataUrl);

    const orientation = width >= height ? 'l' : 'p';
    const pdf = new JsPdfCtor({ orientation, unit: 'pt', format: [width, height] });
    const fmt = /^data:image\/(png|jpeg|jpg|webp)/i.exec(dataUrl)?.[1]?.toUpperCase() || 'PNG';
    pdf.addImage(dataUrl, fmt === 'JPG' ? 'JPEG' : fmt, 0, 0, width, height);
    onProgress?.(0.95);
    const blob = pdf.output('blob');
    onProgress?.(1);
    return blob;
  }
});

registerConverter({
  id: 'pdf-image',
  name: 'PDF → PNG (page 1)',
  from: ['pdf'],
  to: ['png', 'jpg', 'jpeg', 'webp'],
  heavy: false,
  notes: 'Renders page 1 at 2× scale via pdf.js. Extend to multi-page by looping pdf.numPages.',
  async convert(file, targetExt, { onProgress } = {}) {
    onProgress?.(0.05);
    const pdfjs = await loadPdfJs();
    onProgress?.(0.3);

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 2 });

    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');

    if (targetExt === 'jpg' || targetExt === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    await page.render({ canvasContext: ctx, viewport }).promise;
    onProgress?.(0.85);

    const mime = targetExt === 'png' ? 'image/png'
               : targetExt === 'webp' ? 'image/webp'
               : 'image/jpeg';
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), mime, 0.95);
    });
    onProgress?.(1);
    return blob;
  }
});
