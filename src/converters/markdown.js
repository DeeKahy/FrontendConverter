// Markdown → PDF. Renders (GitHub-flavored) Markdown to a styled HTML page in an
// off-screen container, then rasterizes it to a paginated PDF.
//
// Libraries load from a CDN on first use — same lazy pattern as pdf.js — so
// users who never touch Markdown pay nothing:
//   - marked      → Markdown to HTML
//   - html2pdf.js → HTML element to a multi-page PDF (wraps html2canvas + jsPDF)

import { registerConverter } from '../registry.js';

// esm.sh bundles npm packages as browser-ready ES modules. Pinning versions
// keeps the app reproducible.
const MARKED_URL   = 'https://esm.sh/marked@12.0.2';
const HTML2PDF_URL = 'https://esm.sh/html2pdf.js@0.10.2';

// These load from a CDN on first use. If the network is down or the CDN is
// blocked, the dynamic import() rejects with an opaque message — wrap it in
// something actionable (mirrors pdf.js / media.js).
function cdnError(lib, e) {
  return new Error(
    `Couldn't load ${lib} from the CDN — check your connection, or self-host ` +
    `it by editing the URL in src/converters/markdown.js. (${e?.message || e})`
  );
}

let markedPromise;
function loadMarked() {
  markedPromise ??= import(/* @vite-ignore */ MARKED_URL)
    .then(m => m.marked || m.default?.marked || m.default)
    .catch(e => { markedPromise = undefined; throw cdnError('marked', e); });
  return markedPromise;
}

let html2pdfPromise;
function loadHtml2Pdf() {
  html2pdfPromise ??= import(/* @vite-ignore */ HTML2PDF_URL)
    .then(m => m.default || m.html2pdf || m)
    .catch(e => { html2pdfPromise = undefined; throw cdnError('html2pdf.js', e); });
  return html2pdfPromise;
}

// Print stylesheet for the rendered document. Kept deliberately plain and
// light (PDFs are usually printed / read on white), scoped under .md-root so it
// can't leak into the app UI. html2pdf rasterizes exactly what it sees here.
const PRINT_CSS = `
.md-root {
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  color: #1a1a1a;
  background: #ffffff;
  box-sizing: border-box;
}
.md-root * { box-sizing: border-box; }
.md-root h1, .md-root h2, .md-root h3, .md-root h4, .md-root h5, .md-root h6 {
  line-height: 1.25; margin: 1.4em 0 0.6em; font-weight: 600;
}
.md-root h1 { font-size: 2em; border-bottom: 1px solid #e2e2e2; padding-bottom: .3em; }
.md-root h2 { font-size: 1.5em; border-bottom: 1px solid #ececec; padding-bottom: .3em; }
.md-root h3 { font-size: 1.25em; }
.md-root h4 { font-size: 1em; }
.md-root p, .md-root ul, .md-root ol, .md-root blockquote, .md-root table, .md-root pre { margin: 0 0 1em; }
.md-root ul, .md-root ol { padding-left: 1.6em; }
.md-root li { margin: .25em 0; }
.md-root a { color: #0b62c4; text-decoration: underline; }
.md-root blockquote {
  margin-left: 0; padding: .2em 1em; color: #555; border-left: 4px solid #dcdcdc;
}
.md-root code {
  font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: .88em; background: #f3f3f3; padding: .15em .35em; border-radius: 4px;
}
.md-root pre {
  background: #f6f8fa; padding: .9em 1em; border-radius: 6px; overflow: auto;
  page-break-inside: avoid;
}
.md-root pre code { background: none; padding: 0; font-size: .85em; }
.md-root table { border-collapse: collapse; width: 100%; }
.md-root th, .md-root td { border: 1px solid #d8d8d8; padding: .45em .7em; text-align: left; }
.md-root th { background: #f3f3f3; }
.md-root img { max-width: 100%; }
.md-root hr { border: 0; border-top: 1px solid #e2e2e2; margin: 1.6em 0; }
.md-root h1, .md-root h2, .md-root h3 { page-break-after: avoid; }
.md-root table, .md-root blockquote, .md-root img { page-break-inside: avoid; }
`;

registerConverter({
  id: 'markdown-pdf',
  name: 'Markdown → PDF',
  from: ['md', 'markdown'],
  to: ['pdf'],
  heavy: false,
  notes: 'Renders GitHub-flavored Markdown to a styled, paginated PDF. Uses marked + html2pdf.js (loaded from CDN on first use).',
  options: [
    { id: 'format', label: 'Page size', type: 'select', default: 'a4',
      choices: [{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }] },
    { id: 'margin', label: 'Page margin', type: 'range', min: 0, max: 30, step: 1,
      default: 12, format: v => `${v} mm` },
  ],
  async convert(file, _targetExt, { onProgress, options } = {}) {
    onProgress?.(0.05, 'Loading Markdown engine…');
    const marked = await loadMarked();
    const html2pdf = await loadHtml2Pdf();

    onProgress?.(0.4, 'Rendering Markdown…');
    const md = await file.text();
    const bodyHtml = marked.parse(md, { gfm: true, breaks: false });

    // Render into an off-screen, but laid-out, container. html2canvas (used by
    // html2pdf) needs the element actually in the DOM to measure/paint it, so
    // we can't use a detached node — park it off-screen and clean up after.
    const format = options?.format === 'letter' ? 'letter' : 'a4';
    const margin = Math.min(30, Math.max(0, Number(options?.margin ?? 12)));

    const style = document.createElement('style');
    style.textContent = PRINT_CSS;

    const host = document.createElement('div');
    host.className = 'md-root';
    // Fixed content width gives consistent line wrapping regardless of the
    // user's window size; html2pdf scales this to fit the page's content box.
    host.style.cssText =
      'position:fixed;left:-10000px;top:0;width:720px;padding:0;z-index:-1;';
    host.innerHTML = bodyHtml;

    document.body.appendChild(style);
    document.body.appendChild(host);

    try {
      onProgress?.(0.6, 'Laying out pages…');
      const opt = {
        margin,                                       // mm, applied to all sides
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
        jsPDF: { unit: 'mm', format, orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy', 'avoid-all'] },
      };
      const blob = await html2pdf().set(opt).from(host).outputPdf('blob');
      onProgress?.(1);
      return blob;
    } finally {
      host.remove();
      style.remove();
    }
  }
});
