// Central converter registry.
//
// A "converter" is a plugin that declares which input extensions it accepts
// and which output extensions it can produce, plus a convert() function.
//
// Adding a new format is literally one registerConverter({...}) call — see
// src/converters/ for examples.

/**
 * @typedef {Object} Converter
 * @property {string}   id          Stable ID (used in UI + logs).
 * @property {string}   name        Human-friendly name.
 * @property {string[]} from        Lowercase source extensions (e.g. ['png','jpg']).
 * @property {string[]} to          Lowercase target extensions.
 * @property {boolean}  [heavy]     True if the converter pulls in a big dependency (e.g. ffmpeg).
 *                                  Heavy converters get a warning badge and load lazily.
 * @property {string}   [notes]     Shown in the supported-formats panel.
 * @property {(file: File, targetExt: string, opts?: {onProgress?: (n:number)=>void}) => Promise<Blob>} convert
 */

/** @type {Converter[]} */
const converters = [];

/**
 * Register a converter. Call this at the top of a converter module.
 * @param {Converter} c
 */
export function registerConverter(c) {
  if (!c || !c.id || !c.from?.length || !c.to?.length || typeof c.convert !== 'function') {
    throw new Error(`registerConverter: invalid converter ${JSON.stringify(c?.id)}`);
  }
  c.from = c.from.map(x => x.toLowerCase());
  c.to = c.to.map(x => x.toLowerCase());
  converters.push(c);
}

/** Normalize an extension (strip leading dot, lowercase). */
export function normExt(ext) {
  if (!ext) return '';
  return String(ext).toLowerCase().replace(/^\./, '').trim();
}

/** Get the extension from a filename. */
export function extOf(filename) {
  const m = /\.([^./\\]+)$/.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

/** List every registered converter. */
export function listConverters() {
  return [...converters];
}

/** Find the first converter that can go from→to. */
export function findConverter(fromExt, toExt) {
  const f = normExt(fromExt), t = normExt(toExt);
  return converters.find(c => c.from.includes(f) && c.to.includes(t));
}

/** All target extensions reachable from this source ext (deduped). */
export function targetsFor(fromExt) {
  const f = normExt(fromExt);
  const out = new Set();
  for (const c of converters) {
    if (c.from.includes(f)) c.to.forEach(t => out.add(t));
  }
  // Don't let users convert to the same format (no-op).
  out.delete(f);
  return [...out].sort();
}

/** Convenience: run a conversion by picking the right converter. */
export async function convert(file, fromExt, toExt, opts) {
  const c = findConverter(fromExt, toExt);
  if (!c) throw new Error(`No converter registered for ${fromExt} → ${toExt}`);
  return c.convert(file, normExt(toExt), opts);
}
