// Minimal ZIP writer — "stored" (no compression), zero dependencies.
//
// Enough to bundle several output blobs into one .zip so multi-file
// conversions (e.g. PDF → one image per page) download as a single file
// instead of firing N separate downloads. Store-only keeps it tiny and fast;
// the inputs here (already-compressed PNG/JPEG/etc.) wouldn't shrink anyway.

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Build a ZIP blob from a list of files.
 * @param {Array<{name: string, blob: Blob}>} files
 * @returns {Promise<Blob>}
 */
export async function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];        // streamed in order: [local header, name, data] per file
  const central = [];      // central directory records, appended at the end
  let offset = 0;          // running byte offset of each local header

  for (const { name, blob } of files) {
    const data = new Uint8Array(await blob.arrayBuffer());
    const nameBytes = enc.encode(name);
    const crc = crc32(data);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);   // local file header signature
    lh.setUint16(4, 20, true);           // version needed
    lh.setUint16(6, 0, true);            // flags
    lh.setUint16(8, 0, true);            // method 0 = store
    lh.setUint16(10, 0, true);           // mod time
    lh.setUint16(12, 0x0021, true);      // mod date = 1980-01-01 (valid DOS date)
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); // compressed size
    lh.setUint32(22, data.length, true); // uncompressed size
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true);           // extra length
    parts.push(new Uint8Array(lh.buffer), nameBytes, data);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);   // central dir signature
    cd.setUint16(4, 20, true);           // version made by
    cd.setUint16(6, 20, true);           // version needed
    cd.setUint16(8, 0, true);            // flags
    cd.setUint16(10, 0, true);           // method
    cd.setUint16(12, 0, true);           // mod time
    cd.setUint16(14, 0x0021, true);      // mod date
    cd.setUint32(16, crc, true);
    cd.setUint32(20, data.length, true);
    cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameBytes.length, true);
    cd.setUint16(30, 0, true);           // extra length
    cd.setUint16(32, 0, true);           // comment length
    cd.setUint16(34, 0, true);           // disk number
    cd.setUint16(36, 0, true);           // internal attrs
    cd.setUint32(38, 0, true);           // external attrs
    cd.setUint32(42, offset, true);      // local header offset
    central.push(new Uint8Array(cd.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);   // end of central dir signature
  eocd.setUint16(8, files.length, true); // entries on this disk
  eocd.setUint16(10, files.length, true);// total entries
  eocd.setUint32(12, centralSize, true);
  eocd.setUint32(16, centralOffset, true);

  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], {
    type: 'application/zip',
  });
}
