/**
 * The PDF writer behind "PDF — one page per frame".
 *
 * A PDF reader finds every object through byte offsets (the cross-reference
 * table), so an off-by-one in the writer is not a cosmetic bug: viewers either
 * refuse the file or silently "repair" it. These tests read the output the way
 * a reader does — through `startxref` and the xref table — rather than by
 * searching for strings.
 */

import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { buildPdf, deflate, pdfTextString, rgbaToRgb, type PdfPage } from '../../src/render/pdfWriter.ts';

/** The whole file as one byte array, as a Blob would hold it. */
function bytesOf(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Latin-1 keeps one character per byte, so string offsets are byte offsets. */
function textOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

interface Parsed {
  text: string;
  bytes: Uint8Array;
  /** Object number → the object's text, from `N 0 obj` to `endobj`. */
  objects: Map<number, string>;
  trailer: string;
}

/** Parses the file through its xref table, failing on any bad offset. */
function parse(chunks: Uint8Array[]): Parsed {
  const bytes = bytesOf(chunks);
  const text = textOf(bytes);

  const startxref = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  expect(startxref, 'the file ends with startxref and %%EOF').not.toBeNull();
  const xrefOffset = Number(startxref![1]);
  expect(text.startsWith('xref\n', xrefOffset), 'startxref points at the xref keyword').toBe(true);

  const header = /^xref\n0 (\d+)\n/.exec(text.slice(xrefOffset))!;
  const count = Number(header[1]);
  const entriesStart = xrefOffset + header[0].length;
  const objects = new Map<number, string>();

  for (let id = 0; id < count; id++) {
    // Every entry is exactly 20 bytes, end-of-line included. Readers seek to
    // `start + id * 20`, so one entry of 19 or 21 bytes misplaces the rest.
    const entry = text.slice(entriesStart + id * 20, entriesStart + (id + 1) * 20);
    expect(entry, `xref entry ${id}`).toMatch(/^\d{10} \d{5} [nf] \n$/);
    if (id === 0) {
      expect(entry).toBe('0000000000 65535 f \n');
      continue;
    }
    const offset = Number(entry.slice(0, 10));
    expect(text.startsWith(`${id} 0 obj\n`, offset), `object ${id} is where the xref says`).toBe(true);
    objects.set(id, text.slice(offset, text.indexOf('endobj\n', offset) + 'endobj'.length));
  }

  const trailer = text.slice(entriesStart + count * 20, text.lastIndexOf('startxref'));
  expect(trailer).toContain(`/Size ${count}`);
  return { text, bytes, objects, trailer };
}

/** Resolves an indirect reference such as `/Root 1 0 R`. */
function ref(source: string, key: string): number {
  const match = new RegExp(`/${key} (\\d+) 0 R`).exec(source);
  expect(match, `/${key} reference`).not.toBeNull();
  return Number(match![1]);
}

/** The raw bytes of a stream object, checked against its declared `/Length`. */
function streamOf(parsed: Parsed, id: number): Uint8Array {
  const object = parsed.objects.get(id)!;
  const length = Number(/\/Length (\d+)/.exec(object)![1]);
  const start = parsed.text.indexOf(object) + object.indexOf('stream\n') + 'stream\n'.length;
  // `/Length` must be exact: the reader takes that many bytes, then expects
  // the end-of-line and `endstream`.
  expect(parsed.text.startsWith('\nendstream', start + length)).toBe(true);
  return parsed.bytes.slice(start, start + length);
}

/** Decodes a `<FEFF…>` hex text string back into a JS string. */
function decodeTextString(hex: string): string {
  expect(hex.startsWith('FEFF')).toBe(true);
  let out = '';
  for (let index = 4; index < hex.length; index += 4) {
    out += String.fromCharCode(parseInt(hex.slice(index, index + 4), 16));
  }
  return out;
}

/** A solid-colour RGB image, deflated, ready to place on a page. */
async function solidImage(width: number, height: number, rgb: [number, number, number]) {
  const pixels = new Uint8Array(width * height * 3);
  for (let index = 0; index < pixels.length; index += 3) pixels.set(rgb, index);
  return { width, height, data: await deflate(pixels), pixels };
}

async function page(overrides: Partial<PdfPage> = {}): Promise<PdfPage> {
  const image = await solidImage(4, 2, [255, 0, 0]);
  return {
    width: 600,
    height: 800,
    image: { width: image.width, height: image.height, data: image.data },
    placement: { x: 50, y: 100, width: 400, height: 200 },
    bookmark: 'Overview',
    ...overrides,
  };
}

describe('buildPdf', () => {
  it('writes a header a reader recognises, with the binary marker', async () => {
    const bytes = bytesOf(buildPdf([await page()], { title: 'Board' }));
    expect(textOf(bytes.slice(0, 9))).toBe('%PDF-1.4\n');
    // A comment line of bytes above 127 tells transfer tools the file is binary.
    expect([...bytes.slice(9, 14)].every((byte, index) => index === 0 || byte > 127)).toBe(true);
  });

  it('has a cross-reference entry at the right offset for every object', async () => {
    const parsed = parse(buildPdf([await page(), await page(), await page()], { title: 'Board' }));
    // Catalog, pages, info, outline root, and per page: page, contents, image,
    // bookmark.
    expect(parsed.objects.size).toBe(4 + 3 * 4);
  });

  it('lists the pages in order, each with its own size', async () => {
    const pages = [await page({ width: 595.28, height: 841.89 }), await page({ width: 841.89, height: 595.28 })];
    const parsed = parse(buildPdf(pages, { title: 'Board' }));
    const catalog = parsed.objects.get(ref(parsed.trailer, 'Root'))!;
    const tree = parsed.objects.get(ref(catalog, 'Pages'))!;
    expect(tree).toContain('/Count 2');

    const kids = [.../\/Kids \[([^\]]*)\]/.exec(tree)![1]!.matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));
    expect(kids).toHaveLength(2);
    expect(parsed.objects.get(kids[0]!)).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(parsed.objects.get(kids[1]!)).toContain('/MediaBox [0 0 841.89 595.28]');
  });

  it('draws the image where the placement says, measured from the top-left', async () => {
    // PDF's origin is the bottom-left corner with y pointing up. The placement
    // is top-left based, like everything else in MindFlow, so the writer flips
    // it: bottom = pageHeight − y − height = 800 − 100 − 200 = 500.
    const parsed = parse(buildPdf([await page()], { title: 'Board' }));
    const pageObject = [...parsed.objects.values()].find((object) => object.includes('/Type /Page '))!;
    const contents = textOf(streamOf(parsed, ref(pageObject, 'Contents')));
    expect(contents).toBe('q\n400 0 0 200 50 500 cm\n/Im0 Do\nQ\n');
  });

  it('embeds the pixels losslessly, as 8-bit RGB through FlateDecode', async () => {
    const source = await solidImage(3, 2, [18, 52, 86]);
    const parsed = parse(
      buildPdf([await page({ image: { width: 3, height: 2, data: source.data } })], { title: 'Board' }),
    );
    const pageObject = [...parsed.objects.values()].find((object) => object.includes('/Type /Page '))!;
    const imageId = ref(pageObject, 'Im0');
    const image = parsed.objects.get(imageId)!;
    expect(image).toContain('/Subtype /Image');
    expect(image).toContain('/Width 3');
    expect(image).toContain('/Height 2');
    expect(image).toContain('/ColorSpace /DeviceRGB');
    expect(image).toContain('/BitsPerComponent 8');
    expect(image).toContain('/Filter /FlateDecode');
    expect([...inflateSync(streamOf(parsed, imageId))]).toEqual([...source.pixels]);
  });

  it('turns each bookmark into an outline entry pointing at its page', async () => {
    const pages = [await page({ bookmark: 'Intro' }), await page({ bookmark: 'Plan' })];
    const parsed = parse(buildPdf(pages, { title: 'Board' }));
    const catalog = parsed.objects.get(ref(parsed.trailer, 'Root'))!;
    const outlines = parsed.objects.get(ref(catalog, 'Outlines'))!;
    expect(outlines).toContain('/Type /Outlines');
    expect(outlines).toContain('/Count 2');

    const first = parsed.objects.get(ref(outlines, 'First'))!;
    const second = parsed.objects.get(ref(first, 'Next'))!;
    expect(ref(outlines, 'Last')).toBe(ref(first, 'Next'));
    expect(ref(second, 'Prev')).toBe(ref(outlines, 'First'));
    expect(decodeTextString(/\/Title <([0-9A-F]+)>/.exec(first)![1]!)).toBe('Intro');
    expect(decodeTextString(/\/Title <([0-9A-F]+)>/.exec(second)![1]!)).toBe('Plan');

    const tree = parsed.objects.get(ref(catalog, 'Pages'))!;
    const kids = [...tree.matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));
    expect(first).toContain(`/Dest [${kids[0]} 0 R /Fit]`);
    expect(second).toContain(`/Dest [${kids[1]} 0 R /Fit]`);
  });

  it('writes no outline when no page has a bookmark', async () => {
    const parsed = parse(buildPdf([await page({ bookmark: '' })], { title: 'Board' }));
    const catalog = parsed.objects.get(ref(parsed.trailer, 'Root'))!;
    expect(catalog).not.toContain('/Outlines');
  });

  it('records the board name as the document title, shown in the window title', async () => {
    const parsed = parse(
      buildPdf([await page()], { title: 'Q3 plan', created: new Date(Date.UTC(2026, 8, 29, 17, 4, 5)) }),
    );
    const info = parsed.objects.get(ref(parsed.trailer, 'Info'))!;
    expect(decodeTextString(/\/Title <([0-9A-F]+)>/.exec(info)![1]!)).toBe('Q3 plan');
    expect(info).toContain('/Producer (MindFlow)');
    expect(info).toContain("/CreationDate (D:20260929170405Z)");
    const catalog = parsed.objects.get(ref(parsed.trailer, 'Root'))!;
    expect(catalog).toContain('/DisplayDocTitle true');
  });

  it('rejects an empty document', () => {
    expect(() => buildPdf([], { title: 'Board' })).toThrow();
  });
});

describe('pdfTextString', () => {
  it('encodes as UTF-16BE with a byte-order mark, so any name survives', () => {
    expect(pdfTextString('Hi')).toBe('<FEFF00480069>');
    // Brackets, backslashes and non-Latin text need no escaping in hex form.
    expect(decodeTextString(pdfTextString('(a\\b) — 計画 🚀').slice(1, -1))).toBe('(a\\b) — 計画 🚀');
  });
});

describe('rgbaToRgb', () => {
  it('drops the alpha channel', () => {
    expect([...rgbaToRgb(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))]).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('deflate', () => {
  it('produces a zlib stream, which is exactly what FlateDecode expects', async () => {
    const data = new TextEncoder().encode('mindflow '.repeat(100));
    const compressed = await deflate(data);
    // A zlib header, not raw deflate or gzip: CMF 0x78.
    expect(compressed[0]).toBe(0x78);
    expect(compressed.length).toBeLessThan(data.length);
    expect(new TextDecoder().decode(inflateSync(compressed))).toBe('mindflow '.repeat(100));
  });
});
