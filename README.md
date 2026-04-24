# Forge — frontend-only file converter

A zero-backend web app that converts files entirely in the browser. No uploads,
nothing leaves the machine. Heavy tooling (FFmpeg) lazy-loads only when a media
conversion is actually requested.

## Run it

ES modules don't load from `file://` in most browsers, so use any static
server:

```bash
# from this folder
python3 -m http.server 5173
# or
npx serve .
```

Then open http://localhost:5173.

## What's built in

| Converter | From → To | Library |
| --- | --- | --- |
| Canvas raster | png/jpg/webp/bmp/gif → png/jpg/webp | built-in Canvas API |
| SVG → raster | svg → png/jpg/webp | built-in |
| **SVG → DXF (CAD)** | svg → dxf | pure JS |
| CSV ↔ JSON | csv ↔ json | pure JS |
| Text ↔ Markdown | txt ↔ md | pure JS |
| Image → PDF | png/jpg/webp → pdf | [jsPDF](https://github.com/parallax/jsPDF) (CDN, lazy) |
| PDF → image (p. 1) | pdf → png/jpg/webp | [pdf.js](https://mozilla.github.io/pdf.js/) (CDN, lazy) |
| Audio transcode | mp3/wav/ogg/m4a/flac/aac → mp3/wav/ogg | [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (CDN, **lazy — ~30 MB**) |
| Video transcode / extract | mp4/mov/webm/mkv/avi → mp4/webm/gif/mp3 | ffmpeg.wasm (CDN, lazy) |

## On "SVG → DWG" specifically

DWG is a closed, proprietary binary format. No open-source JavaScript writer
for it exists, which means *any* browser-only tool that claims "SVG to DWG"
is really producing **DXF** (AutoCAD's open ASCII exchange format) — every DWG
tool opens DXF natively (AutoCAD, LibreCAD, Fusion 360, DraftSight, BricsCAD,
QCAD…). That's what this app does, and it says so on the tin.

If you genuinely need DWG bytes on disk, the only options are:

1. Emit DXF here, then let the user drag it into a CAD app and save-as DWG.
2. Run the [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter) locally
   after downloading the DXF.
3. Add a backend. (Out of scope for this project.)

The SVG→DXF converter handles:

- `<line>`, `<rect>`, `<circle>`, `<ellipse>`, `<polyline>`, `<polygon>`, `<path>`
- All transforms (flattened via `getCTM()`)
- Arbitrary path curves (sampled via `getTotalLength()` / `getPointAtLength()`)
- SVG's Y-down coordinates flipped to DXF's Y-up

## Adding a new format

Every conversion is a plugin. To add `xyz → abc`:

1. Create `src/converters/xyz.js`:

    ```js
    import { registerConverter } from '../registry.js';

    registerConverter({
      id: 'xyz-to-abc',
      name: 'XYZ → ABC',
      from: ['xyz'],
      to: ['abc'],
      heavy: false,                              // true if you pull in a big lib
      notes: 'Shown in the supported-formats panel.',
      async convert(file, targetExt, { onProgress } = {}) {
        onProgress?.(0.2);
        const text = await file.text();          // or file.arrayBuffer() / bitmap / ...
        const out = doYourConversion(text);
        onProgress?.(1);
        return new Blob([out], { type: 'application/abc' });
      }
    });
    ```

2. Add one line to `src/converters/index.js`:

    ```js
    import './xyz.js';
    ```

That's it. The UI automatically:

- offers `.abc` in the target dropdown whenever a `.xyz` file is dropped,
- shows the converter in the "Supported conversions" grid at the bottom,
- wires up progress + download links.

### Lazy-loading a heavy dependency

For large libraries (FFmpeg, ONNX runtime, etc.), do the `import()` *inside*
the `convert` function so it only fetches when first used — see
`src/converters/media.js` for the pattern:

```js
let heavyLibPromise;
function loadLib() {
  heavyLibPromise ??= import('https://esm.sh/some-huge-lib@1.0.0');
  return heavyLibPromise;
}

registerConverter({
  id: '…', heavy: true, /* … */
  async convert(file, targetExt, { onProgress } = {}) {
    onProgress?.(0.05, 'Downloading dependency…');
    const lib = await loadLib();
    /* … */
  }
});
```

`heavy: true` gets the converter a "Loads on demand" badge in the UI and a
hint next to the target format in the per-file dropdown.

## Project layout

```
index.html           — shell + drop zone + queue template
styles.css           — dark UI
src/
  app.js             — drag/drop, queue, conversion orchestration, support grid
  registry.js        — converter plugin API (registerConverter, findConverter, targetsFor)
  converters/
    index.js         — barrel import of every converter
    image.js         — Canvas raster conversions
    svg.js           — SVG → raster, SVG → DXF
    text.js          — JSON ↔ CSV, TXT ↔ MD
    pdf.js           — image ↔ PDF (jsPDF + pdf.js, lazy)
    media.js         — audio/video via FFmpeg.wasm (lazy)
```

## Privacy

No network calls except to fetch the JS dependencies from the CDN
(`esm.sh`). Your files never leave the browser. You can self-host the
libraries by swapping the CDN URLs in `pdf.js` / `media.js` for local copies.
