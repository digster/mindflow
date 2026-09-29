/**
 * A minimal PDF writer: one image per page, a bookmark per page and a document
 * title. Just enough PDF for "one page per frame", and nothing more.
 *
 * ---------------------------------------------------------------------------
 * Why hand-written
 * ---------------------------------------------------------------------------
 * The shipped page contains no third-party code (ARCHITECTURE.md,
 * "Dependencies"), and a general PDF library is tens of kilobytes of it. What
 * the export needs is small: a PDF is numbered objects, a table of their byte
 * offsets, and a trailer, and these pages hold one image each.
 *
 * ---------------------------------------------------------------------------
 * Why each page is an image
 * ---------------------------------------------------------------------------
 * A vector page would be a third renderer, after the canvas and the SVG
 * exporter, and one that could not match the other two. PDF text needs its
 * font's glyph widths, and a page cannot read the system fonts the canvas
 * measured with, so every wrapped line would come out a different width. A
 * raster painted by the shape modules matches the screen exactly, and at print
 * resolution it prints cleanly. The text is not selectable. That is the
 * accepted cost.
 *
 * The pixels are stored losslessly. JPEG would be smaller, but it blurs the
 * hard edges of text and lines that a board is made of. `CompressionStream`'s
 * `deflate` format is zlib, which is exactly what PDF's FlateDecode filter
 * reads, so the browser compresses natively and nothing is re-encoded.
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

export interface PdfPage {
  /** Page size in points (1/72 inch). */
  width: number;
  height: number;
  image: PdfImage;
  /** Where the image is drawn, in points from the page's TOP-left corner. */
  placement: { x: number; y: number; width: number; height: number };
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
    object(
      ids.page,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
        `/Resources << /XObject << /Im0 ${ids.image} 0 R >> >> /Contents ${ids.contents} 0 R >>`,
    );
    // An image paints the unit square, first row at the top, so scaling by
    // the placed size and translating to its bottom-left corner places it.
    // PDF's y axis points up from the bottom of the page, hence the flip.
    streamObject(
      ids.contents,
      '',
      encodeAscii(`q\n${num(width)} 0 0 ${num(height)} ${num(x)} ${num(page.height - y - height)} cm\n/Im0 Do\nQ\n`),
    );
    streamObject(
      ids.image,
      `/Type /XObject /Subtype /Image /Width ${page.image.width} /Height ${page.image.height} ` +
        '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode',
      page.image.data,
    );
  });

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
 * places. A thousandth of a point is far below anything a printer resolves.
 */
function num(value: number): string {
  const rounded = Number(value.toFixed(3));
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
