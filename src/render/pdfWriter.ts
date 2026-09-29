/**
 * A minimal PDF writer: per page one picture plus text, a bookmark per page,
 * embedded fonts and a document title. Just enough PDF for "one page per
 * frame", and nothing more.
 *
 * ---------------------------------------------------------------------------
 * Why hand-written
 * ---------------------------------------------------------------------------
 * The shipped page contains no third-party code (ARCHITECTURE.md,
 * "Dependencies"), and a general PDF library is tens of kilobytes of it. What
 * the export needs is small: a PDF is numbered objects, a table of their byte
 * offsets, and a trailer.
 *
 * ---------------------------------------------------------------------------
 * Pictures for shapes, real text for text
 * ---------------------------------------------------------------------------
 * Each page carries one picture of its frame, painted by the shape modules, so
 * shapes look exactly as they do on screen. Text goes on top as real PDF text
 * in the fonts MindFlow ships, embedded here, so it can be selected, copied
 * and searched and stays sharp at any zoom. That only works because the fonts
 * are bundled and have no kerning: a line is exactly as wide as the sum of its
 * glyphs' advances, in the canvas and in a PDF viewer alike, so text written
 * here lands where the canvas would have drawn it. `exportPdf.ts` decides which
 * blocks become text and which stay in the picture (as invisible text, still
 * searchable).
 *
 * The pixels are stored losslessly. JPEG would be smaller, but it blurs the
 * hard edges of lines that a board is made of. `CompressionStream`'s
 * `deflate` format is zlib, which is exactly what PDF's FlateDecode filter
 * reads, so the browser compresses natively and nothing is re-encoded. The
 * fonts arrive already compressed the same way (`build.mjs`).
 *
 * DOM-free, so the unit suite reads the output the way a PDF reader would.
 */

/**
 * Bytes backed by a plain `ArrayBuffer`, which is what `Blob` accepts. Every
 * array this module creates is one; the alias says so to the type checker.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface PdfImage {
  /** Size in pixels. */
  width: number;
  height: number;
  /** 8-bit RGB rows, top row first, compressed with {@link deflate}. */
  data: Bytes;
}

/**
 * A TrueType font to embed. It is written as a Type 0 font with Identity-H
 * encoding over a CIDFontType2, so text is written as glyph ids (two bytes
 * each) and any glyph in the font can be used. A ToUnicode map, built from the
 * characters the text blocks name, lets viewers copy and search it.
 */
export interface PdfFont {
  postScriptName: string;
  /** The TTF, zlib-compressed. Embedded as it is, with `FlateDecode`. */
  deflated: Bytes;
  /** The TTF's length before compression. */
  length: number;
  unitsPerEm: number;
  bbox: [number, number, number, number];
  ascender: number;
  descender: number;
  capHeight: number;
  italicAngle: number;
  /** FontDescriptor flags: 32 (non-symbolic), plus 1 fixed pitch, 2 serif, 8 script. */
  flags: number;
  /** Dominant vertical stem width, in the 1000-unit glyph space. */
  stemV: number;
  /** A glyph's advance width, in font units. */
  advance(glyph: number): number;
}

/** One block of text: lines in one font, size and colour, in one coordinate space. */
export interface PdfTextBlock {
  font: PdfFont;
  /** Font size, in the block's units. */
  size: number;
  /**
   * Maps the block's space, where y points DOWN (as on the canvas), to the
   * page in points with y up: PDF's `a b c d e f`.
   */
  matrix: [number, number, number, number, number, number];
  /** Fill colour, each channel 0 to 1. */
  color: [number, number, number];
  /** 0 to 1. */
  alpha: number;
  /**
   * Written with render mode 3: nothing is painted, but the text can be
   * selected and searched. For text the page already shows as pixels.
   */
  invisible: boolean;
  /**
   * Each line's left end and baseline, in the block's space, with its glyph ids
   * and the characters they draw, one code point per glyph.
   */
  lines: { x: number; y: number; glyphs: number[]; text: string }[];
}

export interface PdfPage {
  /** Page size in points (1/72 inch). */
  width: number;
  height: number;
  image: PdfImage;
  /** Where the image is drawn, in points from the page's TOP-left corner. */
  placement: { x: number; y: number; width: number; height: number };
  /** Text over the image, in paint order. */
  text?: readonly PdfTextBlock[];
  /** The page's entry in the viewer's bookmarks. Empty for none. */
  bookmark: string;
}

export interface PdfInfo {
  /** The document title, shown in the viewer's title bar. */
  title: string;
  /** When the file was made. Defaults to now; tests pass a fixed date. */
  created?: Date;
}

/**
 * Serialises pages into a PDF 1.4 file.
 *
 * Returns the file as a list of chunks in order, so the caller can hand them
 * straight to a `Blob` without first copying every page's image into one
 * array.
 */
export function buildPdf(pages: readonly PdfPage[], info: PdfInfo): Bytes[] {
  if (pages.length === 0) throw new Error('A PDF needs at least one page.');

  // Object numbers are allocated up front, because objects refer to each other
  // in both directions: a page names its parent, and the parent lists its
  // pages.
  let next = 1;
  const catalogId = next++;
  const pagesId = next++;
  const infoId = next++;
  const pageIds = pages.map(() => ({ page: next++, contents: next++, image: next++ }));
  const bookmarked = pages
    .map((page, index) => ({ title: page.bookmark.trim(), index }))
    .filter((entry) => entry.title !== '');
  const outlinesId = bookmarked.length > 0 ? next++ : 0;
  const bookmarkIds = bookmarked.map(() => next++);

  // Fonts and opacities are shared by every page that uses them, so they are
  // collected across the whole document first. Resource names are the same on
  // every page: /F0 is always the same font.
  const fonts = new Map<PdfFont, EmbeddedFont>();
  const alphas = new Map<string, { name: string; id: number }>();
  for (const page of pages) {
    for (const block of page.text ?? []) {
      let embedded = fonts.get(block.font);
      if (!embedded) {
        embedded = {
          name: `F${fonts.size}`,
          ids: { type0: next++, cidFont: next++, descriptor: next++, file: next++, toUnicode: next++ },
          glyphs: new Map(),
        };
        fonts.set(block.font, embedded);
      }
      for (const line of block.lines) {
        const characters = [...line.text];
        line.glyphs.forEach((glyph, index) => {
          if (!embedded.glyphs.has(glyph)) embedded.glyphs.set(glyph, characters[index] ?? '');
        });
      }
      const alpha = num(block.alpha);
      if (alpha !== '1' && !alphas.has(alpha)) alphas.set(alpha, { name: `GS${alphas.size}`, id: next++ });
    }
  }

  const out = new ByteSink();
  const offsets: number[] = [];

  const object = (id: number, body: string) => {
    offsets[id] = out.length;
    out.text(`${id} 0 obj\n${body}\nendobj\n`);
  };
  const streamObject = (id: number, dictionary: string, data: Bytes) => {
    offsets[id] = out.length;
    out.text(`${id} 0 obj\n<< ${dictionary ? `${dictionary} ` : ''}/Length ${data.length} >>\nstream\n`);
    out.bytes(data);
    out.text('\nendstream\nendobj\n');
  };

  out.text('%PDF-1.4\n');
  // A comment of bytes above 127, as the specification recommends, so tools
  // that sniff the first lines treat the file as binary rather than text.
  out.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  object(
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R` +
      (outlinesId ? ` /Outlines ${outlinesId} 0 R` : '') +
      // Title bars show the board name rather than the file name.
      ' /ViewerPreferences << /DisplayDocTitle true >> >>',
  );
  object(
    pagesId,
    `<< /Type /Pages /Kids [${pageIds.map((ids) => `${ids.page} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  );
  object(
    infoId,
    `<< /Title ${pdfTextString(info.title)} /Producer (MindFlow) /CreationDate (${pdfDate(info.created ?? new Date())}) >>`,
  );

  pages.forEach((page, index) => {
    const ids = pageIds[index]!;
    const { x, y, width, height } = page.placement;
    const blocks = page.text ?? [];

    const usedFonts = new Set(blocks.map((block) => fonts.get(block.font)!));
    const usedAlphas = new Set(blocks.map((block) => alphas.get(num(block.alpha))).filter((entry) => entry !== undefined));
    const resources =
      `/XObject << /Im0 ${ids.image} 0 R >>` +
      (usedFonts.size ? ` /Font << ${[...usedFonts].map((font) => `/${font.name} ${font.ids.type0} 0 R`).join(' ')} >>` : '') +
      (usedAlphas.size ? ` /ExtGState << ${[...usedAlphas].map((alpha) => `/${alpha.name} ${alpha.id} 0 R`).join(' ')} >>` : '');
    object(
      ids.page,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << ${resources} >> /Contents ${ids.contents} 0 R >>`,
    );

    // An image paints the unit square, first row at the top, so scaling by
    // the placed size and translating to its bottom-left corner places it.
    // PDF's y axis points up from the bottom of the page, hence the flip.
    let contents = `q\n${num(width)} 0 0 ${num(height)} ${num(x)} ${num(page.height - y - height)} cm\n/Im0 Do\nQ\n`;
    for (const block of blocks) contents += textOperators(block, fonts.get(block.font)!, alphas.get(num(block.alpha)));
    streamObject(ids.contents, '', encodeAscii(contents));
    streamObject(
      ids.image,
      `/Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode',
      page.image.data,
    );
  });

  for (const [font, embedded] of fonts) writeFont(object, streamObject, font, embedded);
  for (const [alpha, state] of alphas) object(state.id, `<< /Type /ExtGState /ca ${alpha} >>`);

  if (outlinesId) {
    object(
      outlinesId,
      `<< /Type /Outlines /First ${bookmarkIds[0]} 0 R /Last ${bookmarkIds[bookmarkIds.length - 1]} 0 R ` +
        `/Count ${bookmarked.length} >>`,
    );
    bookmarked.forEach((entry, index) => {
      const previous = bookmarkIds[index - 1];
      const following = bookmarkIds[index + 1];
      object(
        bookmarkIds[index]!,
        `<< /Title ${pdfTextString(entry.title)} /Parent ${outlinesId} 0 R` +
          (previous ? ` /Prev ${previous} 0 R` : '') +
          (following ? ` /Next ${following} 0 R` : '') +
          // `/Fit` shows the whole page, whatever the viewer's zoom was.
          ` /Dest [${pageIds[entry.index]!.page} 0 R /Fit] >>`,
      );
    });
  }

  // The cross-reference table. Every entry is exactly 20 bytes, its two-byte
  // end-of-line included, because readers find entry N by seeking to
  // `start + N * 20` rather than by parsing lines.
  const xrefOffset = out.length;
  let xref = `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let id = 1; id < next; id++) {
    xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  }
  out.text(xref);
  out.text(`trailer\n<< /Size ${next} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return out.chunks;
}

interface EmbeddedFont {
  /** Its resource name on every page, e.g. `F0`. */
  name: string;
  ids: { type0: number; cidFont: number; descriptor: number; file: number; toUnicode: number };
  /** Every glyph the document uses, with the character it draws. */
  glyphs: Map<number, string>;
}

/**
 * One block's content-stream operators.
 *
 * `cm` puts the block's own coordinates in place, y-down as on the canvas.
 * The text matrix of each line flips y back (`1 0 0 -1`), which is what stands
 * the glyphs upright again, and places the line's baseline.
 */
function textOperators(
  block: PdfTextBlock,
  font: EmbeddedFont,
  alpha: { name: string } | undefined,
): string {
  const [a, b, c, d, e, f] = block.matrix.map((value) => num(value, 5));
  let out = 'q\n';
  if (alpha) out += `/${alpha.name} gs\n`;
  out += `${block.color.map((channel) => num(channel)).join(' ')} rg\n${a} ${b} ${c} ${d} ${e} ${f} cm\nBT\n`;
  out += `/${font.name} ${num(block.size, 5)} Tf\n`;
  if (block.invisible) out += '3 Tr\n';
  for (const line of block.lines) {
    if (line.glyphs.length === 0) continue;
    const hex = line.glyphs.map(hex4).join('');
    out += `1 0 0 -1 ${num(line.x, 5)} ${num(line.y, 5)} Tm <${hex}> Tj\n`;
  }
  return `${out}ET\nQ\n`;
}

/** The five objects that embed one font. */
function writeFont(
  object: (id: number, body: string) => void,
  streamObject: (id: number, dictionary: string, data: Bytes) => void,
  font: PdfFont,
  embedded: EmbeddedFont,
): void {
  const { ids } = embedded;
  // PDF font metrics are in a 1000-unit glyph space, whatever the font's own em.
  const toPdf = (units: number) => (units * 1000) / font.unitsPerEm;
  const name = `/${font.postScriptName.replace(/[^A-Za-z0-9._-]/g, '') || 'MindFlowFont'}`;
  const used = [...embedded.glyphs.keys()].sort((x, y) => x - y);

  object(
    ids.type0,
    `<< /Type /Font /Subtype /Type0 /BaseFont ${name} /Encoding /Identity-H ` +
      `/DescendantFonts [${ids.cidFont} 0 R] /ToUnicode ${ids.toUnicode} 0 R >>`,
  );
  // CID = glyph id (`/CIDToGIDMap /Identity`), so the widths are listed by
  // glyph id. Only the glyphs the document uses need one.
  object(
    ids.cidFont,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${name} ` +
      '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
      `/FontDescriptor ${ids.descriptor} 0 R /CIDToGIDMap /Identity ` +
      `/W [ ${used.map((glyph) => `${glyph} [${num(toPdf(font.advance(glyph)))}]`).join(' ')} ] >>`,
  );
  object(
    ids.descriptor,
    `<< /Type /FontDescriptor /FontName ${name} /Flags ${font.flags} ` +
      `/FontBBox [${font.bbox.map((value) => Math.round(toPdf(value))).join(' ')}] ` +
      `/ItalicAngle ${num(font.italicAngle)} /Ascent ${Math.round(toPdf(font.ascender))} ` +
      `/Descent ${Math.round(toPdf(font.descender))} /CapHeight ${Math.round(toPdf(font.capHeight))} ` +
      `/StemV ${Math.round(font.stemV)} /FontFile2 ${ids.file} 0 R >>`,
  );
  streamObject(ids.file, `/Length1 ${font.length} /Filter /FlateDecode`, font.deflated);
  streamObject(ids.toUnicode, '', encodeAscii(toUnicodeCMap(embedded.glyphs)));
}

/**
 * The CMap that maps each glyph id back to its character, which is what lets
 * a viewer copy and search text written as glyph ids. At most 100 entries per
 * `bfchar` section, as the CMap format requires.
 */
function toUnicodeCMap(glyphs: Map<number, string>): string {
  const entries = [...glyphs]
    .filter(([, character]) => character !== '')
    .sort(([x], [y]) => x - y)
    .map(([glyph, character]) => `<${hex4(glyph)}> <${[...character].map((unit) => utf16Hex(unit)).join('')}>`);
  let sections = '';
  for (let start = 0; start < entries.length; start += 100) {
    const chunk = entries.slice(start, start + 100);
    sections += `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar\n`;
  }
  return (
    '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n' +
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
    '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n' +
    '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n' +
    sections +
    'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'
  );
}

/** A glyph id as the four hex digits Identity-H text is written in. */
function hex4(value: number): string {
  return value.toString(16).toUpperCase().padStart(4, '0');
}

/** A character as UTF-16BE hex: four digits, or eight for a surrogate pair. */
function utf16Hex(character: string): string {
  let out = '';
  for (let index = 0; index < character.length; index++) out += hex4(character.charCodeAt(index));
  return out;
}

/**
 * A PDF text string: UTF-16BE behind a byte-order mark, written in hex.
 *
 * UTF-16BE is the one encoding PDF text strings accept that covers any board
 * or frame name. Hex form needs no escaping, so parentheses and backslashes in
 * a name cannot end the string early. A JS string is already UTF-16 code
 * units, so characters outside the Basic Multilingual Plane are emitted as the
 * surrogate pairs PDF expects.
 */
export function pdfTextString(value: string): string {
  let hex = 'FEFF';
  for (let index = 0; index < value.length; index++) {
    hex += value.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0');
  }
  return `<${hex}>`;
}

/**
 * Drops the alpha channel from canvas pixels.
 *
 * The exporter paints every page onto an opaque canvas, so alpha is 255
 * throughout and dropping it loses nothing. PDF would otherwise need the alpha
 * as a separate soft-mask image.
 */
export function rgbaToRgb(rgba: Uint8ClampedArray | Uint8Array): Bytes {
  const rgb = new Uint8Array((rgba.length / 4) * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source]!;
    rgb[target + 1] = rgba[source + 1]!;
    rgb[target + 2] = rgba[source + 2]!;
  }
  return rgb;
}

/**
 * Compresses bytes into a zlib stream, the format FlateDecode reads.
 *
 * `CompressionStream` is native in every current browser, and in Node, which
 * is what lets the unit suite run it too.
 */
export async function deflate(data: Bytes): Promise<Bytes> {
  const stream = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A number as PDF writes it: plain decimal, never exponent notation, to three
 * places by default. A thousandth of a point is far below anything a printer
 * resolves. Matrix entries get five, because a small scale multiplies every
 * coordinate it applies to.
 */
function num(value: number, places = 3): string {
  const rounded = Number(value.toFixed(places));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** A PDF date string, in UTC: `D:YYYYMMDDHHmmSSZ`. */
function pdfDate(date: Date): string {
  const two = (value: number) => String(value).padStart(2, '0');
  return (
    `D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`
  );
}

const encoder = new TextEncoder();

/**
 * Encodes PDF syntax. Everything the writer emits as text is ASCII, since
 * names and titles go through {@link pdfTextString}, so its UTF-8 bytes are
 * its characters and string lengths are byte offsets.
 */
function encodeAscii(value: string): Bytes {
  return encoder.encode(value);
}

/** Collects the file's bytes in order, tracking the offset the next one lands at. */
class ByteSink {
  readonly chunks: Bytes[] = [];
  length = 0;

  text(value: string): void {
    this.bytes(encodeAscii(value));
  }

  bytes(value: Bytes): void {
    this.chunks.push(value);
    this.length += value.length;
  }
}
