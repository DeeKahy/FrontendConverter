// PDF converters. Libraries are dynamically imported from a CDN the first
// time a PDF conversion runs, so users who never touch PDFs pay nothing.
//
//   - Image → PDF    (jsPDF)
//   - PDF   → PNG    (pdfjs-dist, renders page 1 — extend as needed)

import { registerConverter } from '../registry.js';

// We use unpkg (a raw npm-file CDN) rather than esm.sh.
// esm.sh is a module *transformer* — fine for cleaned ESM imports, but it's
// not reliable for raw assets like .wasm or worker scripts. unpkg serves the
// actual files from the npm registry, which is what we want for pdf.js's
// worker.
const JSPDF_URL  = 'https://unpkg.com/jspdf@2.5.2/dist/jspdf.es.min.js';
const PDFJS_URL  = 'https://unpkg.com/pdfjs-dist@4.0.379/build/pdf.mjs';
const PDFJS_WRKR = 'https://unpkg.com/pdfjs-dist@4.0.379/build/pdf.worker.mjs';

let jsPDFPromise;
function loadJsPDF() {
  jsPDFPromise ??= import(/* @vite-ignore */ JSPDF_URL).then(m => {
    // jsPDF's ESM build can expose the constructor at any of these paths
    // depending on how the bundler emitted it.
    return m.jsPDF || m.default?.jsPDF || m.default || self.jspdf?.jsPDF;
  });
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
  name: 'PDF → image (all pages)',
  from: ['pdf'],
  to: ['png', 'jpg', 'jpeg', 'webp'],
  heavy: false,
  notes: 'Renders every page at 2× scale via pdf.js. Multi-page PDFs produce one image per page with -p1/-p2/… suffixes.',
  async convert(file, targetExt, { onProgress } = {}) {
    onProgress?.(0.02, 'Loading PDF engine…');
    const pdfjs = await loadPdfJs();

    const data = new Uint8Array(await file.arrayBuffer());
    const pdf = await pdfjs.getDocument({ data }).promise;
    const pageCount = pdf.numPages;
    onProgress?.(0.1, `Rendering ${pageCount} page${pageCount === 1 ? '' : 's'}…`);

    const mime = targetExt === 'png' ? 'image/png'
               : targetExt === 'webp' ? 'image/webp'
               : 'image/jpeg';

    const baseName = file.name.replace(/\.[^./\\]+$/, '');
    const pad = String(pageCount).length;
    const outputs = [];

    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
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

      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), mime, 0.95);
      });

      // Single-page PDF → plain name (no suffix). Multi-page → zero-padded
      // -p01/-p02/… so files sort naturally in the user's file manager.
      const name = pageCount === 1
        ? `${baseName}.${targetExt}`
        : `${baseName}-p${String(i).padStart(pad, '0')}.${targetExt}`;

      outputs.push({ blob, name });
      onProgress?.(0.1 + 0.88 * (i / pageCount), `Rendered page ${i} of ${pageCount}`);

      // Free the page's resources so big PDFs don't blow up memory.
      page.cleanup();
    }

    onProgress?.(1);
    // Single-page → return a plain Blob (keeps the contract simple).
    return outputs.length === 1 ? outputs[0].blob : outputs;
  }
});
