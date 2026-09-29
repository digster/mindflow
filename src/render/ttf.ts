/**
 * Reads the few TrueType tables MindFlow needs from the fonts it ships.
 *
 * Two readers need more than a browser exposes. The PDF writer embeds a font
 * and must declare each glyph's width and which character it stands for, so a
 * viewer can place the text and copy or search it. And the tests check the
 * canvas measures strings as the sum of these advance widths, the rule
 * `docs/07-rendering.md` publishes.
 *
 * Deliberately small: `cmap` (formats 4 and 12), `hmtx`, and the metrics in
 * `head`, `hhea`, `maxp`, `OS/2`, `post` and `name`. The shipped fonts have no
 * layout tables, since `scripts/build-fonts.py` removes them, so a string's
 * width really is the sum of its advances. DOM-free and synchronous.
 */

export interface TrueTypeFont {
  /** Font units per em. Every other metric here is in font units. */
  unitsPerEm: number;
  /** The PostScript name (`name` ID 6), as PDF names the font. */
  postScriptName: string;
  numGlyphs: number;
  /** `[xMin, yMin, xMax, yMax]` over every glyph. */
  bbox: [number, number, number, number];
  /** Typographic ascender and descender from `hhea`; the descender is negative. */
  ascender: number;
  descender: number;
  capHeight: number;
  weightClass: number;
  /** Degrees counter-clockwise from vertical; 0 for an upright face. */
  italicAngle: number;
  fixedPitch: boolean;
  /** The glyph for a Unicode code point, or 0 (`.notdef`) when the face lacks it. */
  glyphFor(codePoint: number): number;
  /** A glyph's advance width. */
  advance(glyph: number): number;
}

/**
 * The width of `text` at `fontSize`, in the same units as `fontSize`, or `null`
 * when the face lacks one of its characters. A browser would draw that one
 * from a fallback font, whose width this face cannot tell.
 */
export function textAdvance(font: TrueTypeFont, text: string, fontSize: number): number | null {
  let units = 0;
  for (const character of text) {
    const glyph = font.glyphFor(character.codePointAt(0) ?? 0);
    if (glyph === 0) return null;
    units += font.advance(glyph);
  }
  return (units * fontSize) / font.unitsPerEm;
}

export function parseTrueType(bytes: Uint8Array): TrueTypeFont {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  // 0x00010000 is TrueType outlines; 'true' is the old Apple tag for the same.
  if (version !== 0x00010000 && version !== 0x74727565) {
    throw new Error('Not a TrueType font.');
  }

  const tables = new Map<string, { offset: number; length: number }>();
  const count = view.getUint16(4);
  for (let index = 0; index < count; index++) {
    const record = 12 + index * 16;
    const tag = String.fromCharCode(
      view.getUint8(record),
      view.getUint8(record + 1),
      view.getUint8(record + 2),
      view.getUint8(record + 3),
    );
    tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
  }
  const table = (tag: string) => {
    const found = tables.get(tag);
    if (!found) throw new Error(`The font has no ${tag} table.`);
    return found.offset;
  };

  const head = table('head');
  const unitsPerEm = view.getUint16(head + 18);
  const bbox: [number, number, number, number] = [
    view.getInt16(head + 36),
    view.getInt16(head + 38),
    view.getInt16(head + 40),
    view.getInt16(head + 42),
  ];

  const hhea = table('hhea');
  const ascender = view.getInt16(hhea + 4);
  const descender = view.getInt16(hhea + 6);
  const numberOfHMetrics = view.getUint16(hhea + 34);

  const numGlyphs = view.getUint16(table('maxp') + 4);

  const os2 = tables.get('OS/2')?.offset;
  const weightClass = os2 === undefined ? 400 : view.getUint16(os2 + 4);
  // `sCapHeight` exists from version 2. Older faces get the usual estimate.
  const capHeight =
    os2 !== undefined && view.getUint16(os2) >= 2 ? view.getInt16(os2 + 88) : Math.round(ascender * 0.7);

  const post = table('post');
  const italicAngle = view.getInt32(post + 4) / 65536;
  const fixedPitch = view.getUint32(post + 12) !== 0;

  const hmtx = table('hmtx');
  const lastAdvance = view.getUint16(hmtx + (numberOfHMetrics - 1) * 4);
  // Glyphs past `numberOfHMetrics` share the last advance: the table stores
  // only side bearings for them.
  const advance = (glyph: number) =>
    glyph < numberOfHMetrics ? view.getUint16(hmtx + glyph * 4) : lastAdvance;

  return {
    unitsPerEm,
    postScriptName: readPostScriptName(view, tables.get('name')?.offset) ?? 'MindFlowFont',
    numGlyphs,
    bbox,
    ascender,
    descender,
    capHeight,
    weightClass,
    italicAngle,
    fixedPitch,
    glyphFor: readCmap(view, table('cmap')),
    advance,
  };
}

/**
 * Builds the character-to-glyph lookup from the best Unicode subtable: format
 * 12 (every plane) if there is one, else format 4 (the Basic Multilingual
 * Plane), as fontTools' `getBestCmap` would choose.
 */
function readCmap(view: DataView, cmap: number): (codePoint: number) => number {
  const count = view.getUint16(cmap + 2);
  let format4: number | null = null;
  let format12: number | null = null;
  for (let index = 0; index < count; index++) {
    const record = cmap + 4 + index * 8;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const subtable = cmap + view.getUint32(record + 4);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    const format = view.getUint16(subtable);
    if (format === 12) format12 ??= subtable;
    else if (format === 4) format4 ??= subtable;
  }

  const map = new Map<number, number>();
  if (format12 !== null) {
    const groups = view.getUint32(format12 + 12);
    for (let index = 0; index < groups; index++) {
      const group = format12 + 16 + index * 12;
      const start = view.getUint32(group);
      const end = view.getUint32(group + 4);
      const first = view.getUint32(group + 8);
      for (let code = start; code <= end; code++) map.set(code, first + code - start);
    }
  } else if (format4 !== null) {
    const segments = view.getUint16(format4 + 6) / 2;
    const ends = format4 + 14;
    const starts = ends + segments * 2 + 2;
    const deltas = starts + segments * 2;
    const rangeOffsets = deltas + segments * 2;
    for (let segment = 0; segment < segments; segment++) {
      const start = view.getUint16(starts + segment * 2);
      const end = view.getUint16(ends + segment * 2);
      const delta = view.getInt16(deltas + segment * 2);
      const rangeOffsetAt = rangeOffsets + segment * 2;
      const rangeOffset = view.getUint16(rangeOffsetAt);
      for (let code = start; code <= end && code !== 0xffff; code++) {
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (code + delta) & 0xffff;
        } else {
          // The offset is relative to its own position in the table.
          const at = rangeOffsetAt + rangeOffset + (code - start) * 2;
          const raw = view.getUint16(at);
          glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
        }
        if (glyph !== 0) map.set(code, glyph);
      }
    }
  } else {
    throw new Error('The font has no Unicode cmap.');
  }

  return (codePoint) => map.get(codePoint) ?? 0;
}

/** Name ID 6, from a Windows Unicode record (UTF-16BE) or a Mac Roman one. */
function readPostScriptName(view: DataView, name: number | undefined): string | null {
  if (name === undefined) return null;
  const count = view.getUint16(name + 2);
  const strings = name + view.getUint16(name + 4);
  for (let index = 0; index < count; index++) {
    const record = name + 6 + index * 12;
    if (view.getUint16(record + 6) !== 6) continue;
    const platform = view.getUint16(record);
    const length = view.getUint16(record + 8);
    const start = strings + view.getUint16(record + 10);
    let value = '';
    if (platform === 3 || platform === 0) {
      for (let at = 0; at + 1 < length; at += 2) value += String.fromCharCode(view.getUint16(start + at));
    } else {
      for (let at = 0; at < length; at++) value += String.fromCharCode(view.getUint8(start + at));
    }
    if (value !== '') return value;
  }
  return null;
}
