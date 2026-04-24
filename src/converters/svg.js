// SVG converters:
//   - SVG → PNG / JPG / WebP    (render to canvas)
//   - SVG → DXF                 (AutoCAD R12 ASCII DXF, openable by every CAD tool)
//
// Note on "SVG → DWG": real DWG is a proprietary binary format and there's no
// pure-frontend writer for it. DXF is the universally-accepted open CAD
// exchange format — every DWG tool (AutoCAD, LibreCAD, Fusion, DraftSight, …)
// opens it. Most free "SVG to DWG" tools actually produce DXF under the hood.

import { registerConverter } from '../registry.js';

// ---------- helpers ----------

async function loadSvgDocument(file) {
  const text = await file.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error('Invalid SVG file');
  const svg = doc.documentElement;
  if (svg.tagName.toLowerCase() !== 'svg') throw new Error('Root element is not <svg>');
  return { text, svg };
}

function getSvgSize(svg) {
  // Try width/height attrs, fall back to viewBox.
  let w = parseFloat(svg.getAttribute('width'));
  let h = parseFloat(svg.getAttribute('height'));
  const vb = svg.getAttribute('viewBox');
  if ((!w || !h) && vb) {
    const [, , vw, vh] = vb.split(/[\s,]+/).map(parseFloat);
    w = w || vw; h = h || vh;
  }
  if (!w) w = 300;
  if (!h) h = 150;
  return { width: Math.round(w), height: Math.round(h) };
}

async function rasterizeSvg(file, targetExt, { scale = 1 } = {}) {
  const text = await file.text();
  const { svg } = await loadSvgDocument(file);
  const { width, height } = getSvgSize(svg);

  const blob = new Blob([text], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Failed to load SVG as image'));
      i.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext('2d');
    if (targetExt === 'jpg' || targetExt === 'jpeg') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const mime = targetExt === 'png' ? 'image/png'
               : targetExt === 'webp' ? 'image/webp'
               : 'image/jpeg';
    return await new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), mime, 0.95);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---------- SVG → raster ----------

registerConverter({
  id: 'svg-raster',
  name: 'SVG → raster',
  from: ['svg'],
  to: ['png', 'jpg', 'jpeg', 'webp'],
  notes: 'Rendered via <img> + Canvas. Upscale by editing the scale option in src/converters/svg.js.',
  async convert(file, targetExt, { onProgress } = {}) {
    onProgress?.(0.2);
    const blob = await rasterizeSvg(file, targetExt, { scale: 2 });
    onProgress?.(1);
    return blob;
  }
});

// ---------- SVG → DXF ----------
//
// Strategy: put a live SVG in the DOM so we can use getCTM(), getTotalLength(),
// and getPointAtLength() to resolve every transform and sample any path. Then
// emit DXF ASCII (R12 / AC1009 — the most compatible flavor).

const DXF = {
  // Group code helpers — DXF is "code\nvalue" pairs separated by newlines.
  pair(code, value) { return `${code}\n${value}\n`; },
};

function dxfHeader() {
  return (
    DXF.pair(0, 'SECTION') +
    DXF.pair(2, 'HEADER') +
    DXF.pair(9, '$ACADVER') + DXF.pair(1, 'AC1009') +
    DXF.pair(9, '$INSUNITS') + DXF.pair(70, 0) + // unitless
    DXF.pair(0, 'ENDSEC')
  );
}

function dxfTables() {
  // Minimal tables section with just a LAYER table (layer "0").
  return (
    DXF.pair(0, 'SECTION') +
    DXF.pair(2, 'TABLES') +
      DXF.pair(0, 'TABLE') +
      DXF.pair(2, 'LAYER') +
      DXF.pair(70, 1) +
        DXF.pair(0, 'LAYER') +
        DXF.pair(2, '0') +
        DXF.pair(70, 0) +
        DXF.pair(62, 7) +   // color: white
        DXF.pair(6, 'CONTINUOUS') +
      DXF.pair(0, 'ENDTAB') +
    DXF.pair(0, 'ENDSEC')
  );
}

function dxfFooter() {
  return DXF.pair(0, 'EOF');
}

function dxfLine(x1, y1, x2, y2) {
  return (
    DXF.pair(0, 'LINE') +
    DXF.pair(8, '0') +
    DXF.pair(10, x1.toFixed(6)) + DXF.pair(20, y1.toFixed(6)) + DXF.pair(30, '0.0') +
    DXF.pair(11, x2.toFixed(6)) + DXF.pair(21, y2.toFixed(6)) + DXF.pair(31, '0.0')
  );
}

function dxfCircle(cx, cy, r) {
  return (
    DXF.pair(0, 'CIRCLE') +
    DXF.pair(8, '0') +
    DXF.pair(10, cx.toFixed(6)) + DXF.pair(20, cy.toFixed(6)) + DXF.pair(30, '0.0') +
    DXF.pair(40, r.toFixed(6))
  );
}

function dxfPolyline(points, closed = false) {
  // Use the legacy POLYLINE/VERTEX entities — universally supported (R12).
  let out =
    DXF.pair(0, 'POLYLINE') +
    DXF.pair(8, '0') +
    DXF.pair(66, 1) +         // "vertices follow" flag
    DXF.pair(10, '0.0') + DXF.pair(20, '0.0') + DXF.pair(30, '0.0') +
    DXF.pair(70, closed ? 1 : 0);
  for (const [x, y] of points) {
    out +=
      DXF.pair(0, 'VERTEX') +
      DXF.pair(8, '0') +
      DXF.pair(10, x.toFixed(6)) +
      DXF.pair(20, y.toFixed(6)) +
      DXF.pair(30, '0.0');
  }
  out += DXF.pair(0, 'SEQEND') + DXF.pair(8, '0');
  return out;
}

// Apply an SVGMatrix to a point.
function mapPoint(m, x, y) {
  if (!m) return [x, y];
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

// Decide how densely to sample a curve. Long paths get more segments.
function sampleCount(lengthUserUnits) {
  const n = Math.ceil(lengthUserUnits / 1.5); // ~1.5 user-units per segment
  return Math.min(Math.max(n, 8), 4000);
}

function elementToDxf(el, svgHeight, pts, lines, circles) {
  const tag = el.tagName.toLowerCase();
  // getCTM gives user -> SVG root coordinates (with all ancestor transforms baked in).
  const ctm = el.getCTM?.() || null;

  const flipY = (x, y) => [x, svgHeight - y];

  const push = (x, y) => {
    const [mx, my] = mapPoint(ctm, x, y);
    return flipY(mx, my);
  };

  switch (tag) {
    case 'line': {
      const x1 = parseFloat(el.getAttribute('x1')) || 0;
      const y1 = parseFloat(el.getAttribute('y1')) || 0;
      const x2 = parseFloat(el.getAttribute('x2')) || 0;
      const y2 = parseFloat(el.getAttribute('y2')) || 0;
      const [ax, ay] = push(x1, y1);
      const [bx, by] = push(x2, y2);
      lines.push([ax, ay, bx, by]);
      return;
    }
    case 'rect': {
      const x = parseFloat(el.getAttribute('x')) || 0;
      const y = parseFloat(el.getAttribute('y')) || 0;
      const w = parseFloat(el.getAttribute('width')) || 0;
      const h = parseFloat(el.getAttribute('height')) || 0;
      if (!w || !h) return;
      const corners = [[x,y],[x+w,y],[x+w,y+h],[x,y+h]].map(([px,py]) => push(px,py));
      pts.push({ points: corners, closed: true });
      return;
    }
    case 'circle': {
      // If there's a uniform scale in the CTM, we can still emit a CIRCLE.
      const cx = parseFloat(el.getAttribute('cx')) || 0;
      const cy = parseFloat(el.getAttribute('cy')) || 0;
      const r  = parseFloat(el.getAttribute('r')) || 0;
      if (!r) return;
      const scaleX = ctm ? Math.hypot(ctm.a, ctm.b) : 1;
      const scaleY = ctm ? Math.hypot(ctm.c, ctm.d) : 1;
      if (Math.abs(scaleX - scaleY) < 1e-4 && Math.abs(ctm?.b || 0) < 1e-4 && Math.abs(ctm?.c || 0) < 1e-4) {
        const [mcx, mcy] = push(cx, cy);
        circles.push([mcx, mcy, r * scaleX]);
        return;
      }
      // Non-uniform: fall through to path sampling below.
      break;
    }
    case 'polyline':
    case 'polygon': {
      const raw = (el.getAttribute('points') || '').trim();
      if (!raw) return;
      const nums = raw.split(/[\s,]+/).map(parseFloat);
      const ring = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        ring.push(push(nums[i], nums[i+1]));
      }
      if (ring.length >= 2) pts.push({ points: ring, closed: tag === 'polygon' });
      return;
    }
  }

  // Fallback: path / ellipse / anything else with geometry — sample along length.
  if (typeof el.getTotalLength === 'function') {
    let total;
    try { total = el.getTotalLength(); } catch { total = 0; }
    if (!total || !isFinite(total)) return;
    const n = sampleCount(total);
    const ring = [];
    for (let i = 0; i <= n; i++) {
      const p = el.getPointAtLength((i / n) * total);
      ring.push(push(p.x, p.y));
    }
    // A path is "closed" if it ends where it started (within a hair).
    let closed = false;
    if (ring.length >= 3) {
      const [sx, sy] = ring[0], [ex, ey] = ring[ring.length - 1];
      if (Math.hypot(sx - ex, sy - ey) < 0.01) closed = true;
    }
    pts.push({ points: ring, closed });
  }
}

async function svgToDxf(file, { onProgress } = {}) {
  const { text } = await loadSvgDocument(file);

  // Mount a live SVG off-screen so getCTM/getTotalLength actually work.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden;';
  host.innerHTML = text;
  const svg = host.querySelector('svg');
  if (!svg) throw new Error('SVG parse failed');
  document.body.appendChild(host);

  try {
    const { width, height } = getSvgSize(svg);
    onProgress?.(0.2);

    // Collect every geometry-bearing descendant.
    const selector = 'line, rect, circle, ellipse, polyline, polygon, path';
    const elements = Array.from(svg.querySelectorAll(selector));

    const lines = [];       // [x1,y1,x2,y2]
    const circles = [];     // [cx,cy,r]
    const pts = [];         // [{ points:[[x,y],...], closed:bool }]

    for (let i = 0; i < elements.length; i++) {
      elementToDxf(elements[i], height, pts, lines, circles);
      if (i % 32 === 0) onProgress?.(0.2 + 0.6 * (i / elements.length));
    }
    onProgress?.(0.85);

    // Assemble DXF text.
    let entities = DXF.pair(0, 'SECTION') + DXF.pair(2, 'ENTITIES');
    for (const [x1, y1, x2, y2] of lines) entities += dxfLine(x1, y1, x2, y2);
    for (const [cx, cy, r] of circles)    entities += dxfCircle(cx, cy, r);
    for (const { points, closed } of pts) if (points.length >= 2) entities += dxfPolyline(points, closed);
    entities += DXF.pair(0, 'ENDSEC');

    const dxf = dxfHeader() + dxfTables() + entities + dxfFooter();
    onProgress?.(1);

    return new Blob([dxf], { type: 'application/dxf' });
  } finally {
    host.remove();
  }
}

registerConverter({
  id: 'svg-dxf',
  name: 'SVG → DXF (CAD)',
  from: ['svg'],
  to: ['dxf'],
  notes: 'Emits AutoCAD R12 DXF — opens in AutoCAD, LibreCAD, Fusion 360, DraftSight, etc. DWG itself is a closed binary format; DXF is the universally-read CAD exchange format.',
  async convert(file, _targetExt, opts) {
    return svgToDxf(file, opts);
  }
});
