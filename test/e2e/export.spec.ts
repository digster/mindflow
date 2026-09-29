/**
 * Export, through the dialog, down to the bytes of the downloaded file.
 *
 * The PDF tests read the file back in Node: the page tree, each page's size,
 * where its image is placed and the image's pixels. That is what shows a frame
 * really landed on its own page, turned and scaled to fit it, rather than that
 * a download merely happened. The layout rules themselves are pinned by
 * `test/unit/pdfLayout.test.ts`; these check the built app follows them.
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const APP_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'index.html')).href;

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  (page as unknown as { __errors: string[] }).__errors = errors;

  await page.goto(APP_URL);
  await page.waitForFunction(() => 'mindflow' in window);
});

test.afterEach(async ({ page }) => {
  const errors = (page as unknown as { __errors: string[] }).__errors ?? [];
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FrameSpec extends Box {
  id: string;
  name: string;
}

interface RectSpec extends Box {
  id: string;
  frameId: string | null;
  fill: string;
}

/** The default frame stroke is 2 wide, so a page shows 1 unit past each edge. */
const FRAME_STROKE = 2;

/**
 * Puts frames and filled, unstroked rectangles on the board through the store,
 * the way the performance test seeds its board. Everything goes on top of what
 * is already there, and the frames below the rectangles, as drawing them first
 * would put them.
 */
async function seed(page: Page, frames: FrameSpec[], rects: RectSpec[]) {
  await page.evaluate(
    ({ frames, rects, stroke }) => {
      const mf = (
        window as unknown as {
          mindflow: { store: { execute(command: unknown): void; document: { elements: { zIndex: number }[] } } };
        }
      ).mindflow;
      const bottom = Math.max(0, ...mf.store.document.elements.map((element) => element.zIndex));
      const base = {
        angle: 0,
        opacity: 1,
        locked: false,
        visible: true,
        groupId: null,
        label: null,
        meta: {},
      };
      const elements = [
        ...frames.map((frame, index) => ({
          ...base,
          ...frame,
          type: 'frame',
          zIndex: bottom + (index + 1) * 1000,
          frameId: null,
          style: { stroke: '#adb5bd', strokeWidth: stroke, strokeStyle: 'solid', fill: '#ffffff', fillStyle: 'solid', roughness: 0 },
        })),
        ...rects.map((rect, index) => ({
          ...base,
          ...rect,
          type: 'rectangle',
          zIndex: bottom + (frames.length + index + 1) * 1000,
          cornerRadius: 0,
          style: { stroke: 'transparent', strokeWidth: 0, strokeStyle: 'solid', fill: rect.fill, fillStyle: 'solid', roughness: 0 },
        })),
      ];
      mf.store.execute({
        label: 'seed',
        patches: elements.map((element) => ({ id: element.id, before: null, after: element })),
      });
    },
    { frames, rects, stroke: FRAME_STROKE },
  );
}

/**
 * Three frames: two side by side, the right one a little lower, and one under
 * the first. In reading order that is Wide, Tall, then the unnamed one.
 */
const WIDE: FrameSpec = { id: 'fr_wide', name: 'Wide', x: 0, y: 0, width: 800, height: 450 };
const TALL: FrameSpec = { id: 'fr_tall', name: 'Tall', x: 1000, y: 30, width: 300, height: 600 };
const SQUARE: FrameSpec = { id: 'fr_square', name: '', x: 0, y: 700, width: 400, height: 400 };

const RED = '#e03131';
const BLUE = '#1971c2';
const GREEN = '#2f9e44';
const BLACK = '#000000';

const MEMBERS: RectSpec[] = [
  { id: 'el_red', frameId: WIDE.id, fill: RED, x: 100, y: 100, width: 200, height: 200 },
  { id: 'el_blue', frameId: TALL.id, fill: BLUE, x: 1050, y: 100, width: 200, height: 200 },
  { id: 'el_green', frameId: SQUARE.id, fill: GREEN, x: 50, y: 750, width: 300, height: 300 },
  // In no frame, but with its centre inside Wide, as an arrow or text drawn
  // there is: it belongs on Wide's page.
  { id: 'el_loose', frameId: null, fill: BLACK, x: 600, y: 300, width: 100, height: 100 },
  // In no frame and overlapping Wide's bottom edge, but centred below it: not
  // on Wide's page.
  { id: 'el_below', frameId: null, fill: BLACK, x: 450, y: 410, width: 100, height: 100 },
];

interface StickySpec extends Box {
  id: string;
  frameId: string | null;
  text: string;
}

/** Adds sticky notes on top of whatever is on the board, with their text. */
async function seedStickies(page: Page, stickies: StickySpec[]) {
  await page.evaluate((stickies) => {
    const mf = (
      window as unknown as { mindflow: { store: { execute(command: unknown): void; document: { elements: { zIndex: number }[] } } } }
    ).mindflow;
    let zIndex = Math.max(0, ...mf.store.document.elements.map((element) => element.zIndex));
    const elements = stickies.map((sticky) => ({
      ...sticky,
      type: 'sticky',
      angle: 0,
      zIndex: (zIndex += 1000),
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      label: null,
      meta: {},
      style: { stroke: 'transparent', strokeWidth: 0, strokeStyle: 'solid', fill: '#ffec99', fillStyle: 'solid', roughness: 0 },
      fontFamily: 'sans',
      fontSize: 20,
      fontWeight: 400,
      lineHeight: 1.25,
      color: '#1e1e1e',
      textAlign: 'left',
      verticalAlign: 'top',
      padding: 12,
    }));
    mf.store.execute({ label: 'seed', patches: elements.map((element) => ({ id: element.id, before: null, after: element })) });
  }, stickies);
}

async function seedFramedBoard(page: Page) {
  // In an order that is not reading order, so the page order is the
  // exporter's doing and not the array's.
  await seed(page, [SQUARE, TALL, WIDE], MEMBERS);
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

const DIALOG = 'dialog.mf-dialog[aria-label="Export"]';

async function openExport(page: Page, format?: string) {
  await page.keyboard.press('ControlOrMeta+Shift+E');
  await expect(page.locator(DIALOG)).toBeVisible();
  if (format) await page.locator(`${DIALOG} select[aria-label="Format"]`).selectOption(format);
}

/** Clicks Export and returns the downloaded file's name and bytes. */
async function exportAndDownload(page: Page) {
  const download = page.waitForEvent('download');
  await page.locator(DIALOG).getByRole('button', { name: 'Export' }).click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: readFileSync((await file.path())!) };
}

// ---------------------------------------------------------------------------
// Reading a PDF back
// ---------------------------------------------------------------------------

interface PdfPageRead {
  width: number;
  height: number;
  /** Where the image is drawn, in points from the page's top-left corner. */
  placement: Box;
  image: { width: number; height: number; pixels: Buffer };
  /**
   * Each line of text on the page, decoded through its font's ToUnicode map,
   * as a viewer's search and copy would read it.
   */
  text: { text: string; invisible: boolean; font: string }[];
  bookmark: string | undefined;
}

/**
 * Reads MindFlow's PDFs: every object through the xref table, each dictionary
 * on one line (the writer's layout), streams by their `/Length`.
 */
function readPdf(buffer: Buffer): { title: string; pages: PdfPageRead[] } {
  const text = buffer.toString('latin1');
  expect(text.startsWith('%PDF-')).toBe(true);

  const xref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  const count = Number(/^xref\n0 (\d+)\n/.exec(text.slice(xref))![1]);
  const entries = xref + `xref\n0 ${count}\n`.length;

  const objects = new Map<number, { dict: string; stream: Buffer | null }>();
  for (let id = 1; id < count; id++) {
    const offset = Number(text.slice(entries + id * 20, entries + id * 20 + 10));
    expect(text.startsWith(`${id} 0 obj\n`, offset)).toBe(true);
    const dictStart = text.indexOf('\n', offset) + 1;
    const dictEnd = text.indexOf('\n', dictStart);
    const dict = text.slice(dictStart, dictEnd);
    const length = /\/Length (\d+) >>$/.exec(dict);
    const streamStart = dictEnd + '\nstream\n'.length;
    objects.set(id, {
      dict,
      stream: length ? buffer.subarray(streamStart, streamStart + Number(length[1])) : null,
    });
  }

  const ref = (source: string, key: string) => Number(new RegExp(`/${key} (\\d+) 0 R`).exec(source)![1]);
  const decode = (hex: string) =>
    String.fromCharCode(...(hex.slice(4).match(/.{4}/g) ?? []).map((unit) => parseInt(unit, 16)));
  const titleOf = (dict: string) => decode(/\/Title <([0-9A-F]+)>/.exec(dict)![1]!);

  const trailer = text.slice(text.lastIndexOf('trailer'));
  const catalog = objects.get(ref(trailer, 'Root'))!.dict;
  const tree = objects.get(ref(catalog, 'Pages'))!.dict;
  const kids = [.../\/Kids \[([^\]]*)\]/.exec(tree)![1]!.matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));

  const bookmarks = new Map<number, string>();
  if (catalog.includes('/Outlines')) {
    let item: string | undefined = objects.get(ref(objects.get(ref(catalog, 'Outlines'))!.dict, 'First'))!.dict;
    while (item) {
      bookmarks.set(Number(/\/Dest \[(\d+) 0 R/.exec(item)![1]), titleOf(item));
      item = item.includes('/Next') ? objects.get(ref(item, 'Next'))!.dict : undefined;
    }
  }

  const pages = kids.map((id) => {
    const page = objects.get(id)!.dict;
    const [, width, height] = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(page)!.map(Number) as number[];
    const contents = objects.get(ref(page, 'Contents'))!.stream!.toString('latin1');
    const [, w, h, x, bottom] = /([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(contents)!.map(Number) as number[];
    const image = objects.get(ref(page, 'Im0'))!;
    expect(image.dict).toContain('/ColorSpace /DeviceRGB');

    // Each resource name's BaseFont and glyph-to-character map.
    const fonts = new Map<string, { name: string; unicode: Map<string, string> }>();
    for (const [, name, id] of /\/Font << ([^>]*) >>/.exec(page)?.[1]?.matchAll(/\/(F\d+) (\d+) 0 R/g) ?? []) {
      const type0 = objects.get(Number(id))!.dict;
      const cmap = objects.get(ref(type0, 'ToUnicode'))!.stream!.toString('latin1');
      const unicode = new Map([...cmap.matchAll(/<([0-9A-F]{4})> <([0-9A-F]+)>/g)].map(([, glyph, code]) => [glyph!, code!]));
      fonts.set(name!, { name: /\/BaseFont \/(\S+)/.exec(type0)![1]!, unicode });
    }
    const text: PdfPageRead['text'] = [];
    for (const block of contents.split('q\n').slice(2)) {
      const font = fonts.get(/\/(F\d+) [\d.]+ Tf/.exec(block)![1]!)!;
      for (const [, hex] of block.matchAll(/<([0-9A-F]+)> Tj/g)) {
        const characters = hex!.match(/.{4}/g)!.map((glyph) => String.fromCodePoint(parseInt(font.unicode.get(glyph)!, 16)));
        text.push({ text: characters.join(''), invisible: block.includes('\n3 Tr\n'), font: font.name });
      }
    }

    return {
      width: width!,
      height: height!,
      placement: { x: x!, y: height! - bottom! - h!, width: w!, height: h! },
      image: {
        width: Number(/\/Width (\d+)/.exec(image.dict)![1]),
        height: Number(/\/Height (\d+)/.exec(image.dict)![1]),
        pixels: inflateSync(image.stream!),
      },
      text,
      bookmark: bookmarks.get(id),
    };
  });

  return { title: titleOf(objects.get(ref(trailer, 'Info'))!.dict), pages };
}

/**
 * The colour a page shows at a scene point of `frame`, sampled from its image.
 * The image covers the frame plus half its stroke on each side.
 */
function colourAt(page: PdfPageRead, frame: Box, [x, y]: [number, number]): string {
  const bleed = FRAME_STROKE / 2;
  const fx = (x - frame.x + bleed) / (frame.width + bleed * 2);
  const fy = (y - frame.y + bleed) / (frame.height + bleed * 2);
  const px = Math.min(Math.floor(fx * page.image.width), page.image.width - 1);
  const py = Math.min(Math.floor(fy * page.image.height), page.image.height - 1);
  const index = (py * page.image.width + px) * 3;
  const hex = (value: number) => value.toString(16).padStart(2, '0');
  return `#${hex(page.image.pixels[index]!)}${hex(page.image.pixels[index + 1]!)}${hex(page.image.pixels[index + 2]!)}`;
}

const A4 = { short: 595.28, long: 841.89 };
const MARGIN = 36;

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

test.describe('PDF export', () => {
  test('puts each frame on its own page, in reading order, named by its bookmark', async ({ page }) => {
    await seedFramedBoard(page);
    await openExport(page, 'pdf');
    await expect(page.locator(DIALOG)).toContainText('3 frames → 3 pages');

    const { name, bytes } = await exportAndDownload(page);
    expect(name).toBe('Untitled board.pdf');
    const pdf = readPdf(bytes);

    expect(pdf.title).toBe('Untitled board');
    // An unnamed frame is bookmarked by its page number.
    expect(pdf.pages.map((p) => p.bookmark)).toEqual(['Wide', 'Tall', 'Page 3']);
    await expect(page.locator('.mf-toast', { hasText: 'Exported 3 pages.' })).toBeVisible();
  });

  test('turns each page to suit its frame and scales the frame to fill it', async ({ page }) => {
    await seedFramedBoard(page);
    await openExport(page, 'pdf');
    const [wide, tall, square] = readPdf((await exportAndDownload(page)).bytes).pages;

    // A4 by default. Wide is landscape; Tall and the square stay portrait.
    expect([wide!.width, wide!.height]).toEqual([A4.long, A4.short]);
    expect([tall!.width, tall!.height]).toEqual([A4.short, A4.long]);
    expect([square!.width, square!.height]).toEqual([A4.short, A4.long]);

    for (const [read, frame] of [
      [wide!, WIDE],
      [tall!, TALL],
      [square!, SQUARE],
    ] as const) {
      const content = { width: frame.width + FRAME_STROKE, height: frame.height + FRAME_STROKE };
      const { placement } = read;
      // Proportions kept…
      expect(placement.width / placement.height).toBeCloseTo(content.width / content.height, 2);
      // …scaled until one side meets the margins…
      const touchesSides = Math.abs(placement.x - MARGIN) < 0.01;
      const touchesTop = Math.abs(placement.y - MARGIN) < 0.01;
      expect(touchesSides || touchesTop).toBe(true);
      expect(placement.x).toBeGreaterThanOrEqual(MARGIN - 0.01);
      expect(placement.y).toBeGreaterThanOrEqual(MARGIN - 0.01);
      // …and centred.
      expect(placement.x * 2 + placement.width).toBeCloseTo(read.width, 1);
      expect(placement.y * 2 + placement.height).toBeCloseTo(read.height, 1);
      // At 300 dpi by default.
      expect(read.image.width).toBe(Math.floor((placement.width / 72) * 300));
    }
  });

  test('shows what is inside the frame, and nothing else', async ({ page }) => {
    await seedFramedBoard(page);
    await openExport(page, 'pdf');
    const [wide, tall, square] = readPdf((await exportAndDownload(page)).bytes).pages;

    expect(colourAt(wide!, WIDE, [200, 200])).toBe(RED);
    expect(colourAt(tall!, TALL, [1150, 200])).toBe(BLUE);
    expect(colourAt(square!, SQUARE, [200, 900])).toBe(GREEN);

    // An element in no frame shows on the page of the frame its centre is in…
    expect(colourAt(wide!, WIDE, [650, 350])).toBe(BLACK);
    // …and not on one it only overlaps: the frame's white fill shows there.
    expect(colourAt(wide!, WIDE, [500, 430])).toBe('#ffffff');
    // Nor do other frames' members appear.
    expect(colourAt(wide!, WIDE, [750, 50])).toBe('#ffffff');
  });

  test('honours the page size, orientation and resolution chosen', async ({ page }) => {
    await seedFramedBoard(page);
    await openExport(page, 'pdf');
    await page.locator(`${DIALOG} select[aria-label="Page size"]`).selectOption('letter');
    await page.locator(`${DIALOG} select[aria-label="Orientation"]`).selectOption('portrait');
    await page.locator(`${DIALOG} select[aria-label="PDF resolution"]`).selectOption('150');

    const pages = readPdf((await exportAndDownload(page)).bytes).pages;
    for (const read of pages) {
      expect([read.width, read.height]).toEqual([612, 792]);
      expect(read.image.width).toBe(Math.floor((read.placement.width / 72) * 150));
    }
  });

  test('exports only the selected frames with "Selection only"', async ({ page }) => {
    await seedFramedBoard(page);
    await page.evaluate(
      (ids) =>
        (window as unknown as { mindflow: { store: { setSelection(ids: string[]): void } } }).mindflow.store.setSelection(ids),
      [TALL.id, 'el_red'],
    );
    await openExport(page, 'pdf');
    // A selected member does not bring its frame along; only frames count.
    await expect(page.locator('#mf-export-selection')).toBeChecked();
    await expect(page.locator(DIALOG)).toContainText('1 frame → 1 page');

    const pdf = readPdf((await exportAndDownload(page)).bytes);
    expect(pdf.pages.map((p) => p.bookmark)).toEqual(['Tall']);
    await expect(page.locator('.mf-toast', { hasText: 'Exported 1 page.' })).toBeVisible();
  });

  test('does not offer "Selection only" when no frame is selected', async ({ page }) => {
    await seedFramedBoard(page);
    await page.evaluate(
      () =>
        (window as unknown as { mindflow: { store: { setSelection(ids: string[]): void } } }).mindflow.store.setSelection([
          'el_red',
        ]),
    );
    await openExport(page, 'png');
    const selectionOnly = page.locator('#mf-export-selection');
    await expect(selectionOnly).toBeChecked();

    await page.locator(`${DIALOG} select[aria-label="Format"]`).selectOption('pdf');
    await expect(selectionOnly).toBeDisabled();
    await expect(selectionOnly).not.toBeChecked();
    await expect(page.locator(DIALOG)).toContainText('no frames selected');
    await expect(page.locator(DIALOG)).toContainText('3 frames → 3 pages');

    // The choice comes back for a format that can use it.
    await page.locator(`${DIALOG} select[aria-label="Format"]`).selectOption('png');
    await expect(selectionOnly).toBeChecked();
  });

  test('explains, and cannot export, when the board has no frames', async ({ page }) => {
    await seed(page, [], [{ id: 'el_only', frameId: null, fill: RED, x: 0, y: 0, width: 100, height: 100 }]);
    await openExport(page, 'pdf');

    await expect(page.locator(DIALOG)).toContainText('This board has no frames');
    await expect(page.locator(DIALOG).getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  test('shows only the options that apply to the chosen format', async ({ page }) => {
    await openExport(page);
    const pngResolution = page.locator(`${DIALOG} select[aria-label="Resolution"]`);
    const pageSize = page.locator(`${DIALOG} select[aria-label="Page size"]`);
    const transparent = page.locator('#mf-export-transparent');

    await expect(pngResolution).toBeVisible();
    await expect(pageSize).toBeHidden();

    await page.locator(`${DIALOG} select[aria-label="Format"]`).selectOption('svg');
    await expect(pngResolution).toBeHidden();
    await expect(pageSize).toBeHidden();

    await page.locator(`${DIALOG} select[aria-label="Format"]`).selectOption('pdf');
    await expect(pngResolution).toBeHidden();
    await expect(pageSize).toBeVisible();
    await expect(page.locator(`${DIALOG} select[aria-label="Orientation"]`)).toBeVisible();
    await expect(transparent).toBeVisible();

    await page.locator(`${DIALOG} select[aria-label="Format"]`).selectOption('json');
    await expect(pageSize).toBeHidden();
    await expect(transparent).toBeHidden();
  });

  test('leaves the paper white behind an unfilled frame with "Transparent background"', async ({ page }) => {
    await seed(page, [WIDE], [MEMBERS[0]!]);
    // An unfilled frame on a coloured board, so the board background is
    // what shows inside it.
    await page.evaluate(() => {
      const mf = (
        window as unknown as {
          mindflow: {
            store: {
              document: { canvas: Record<string, unknown>; elements: Record<string, unknown>[] };
              load(result: unknown, origin: unknown): void;
            };
          };
        }
      ).mindflow;
      const document = structuredClone(mf.store.document);
      document.canvas.background = '#fff9db';
      const frame = document.elements.find((element) => element.type === 'frame')!;
      frame.style = { ...(frame.style as object), fill: 'transparent', fillStyle: 'none' };
      mf.store.load({ document, warnings: [], preserved: [] }, { kind: 'local', name: 'board.mindflow.json' });
    });

    await openExport(page, 'pdf');
    let [read] = readPdf((await exportAndDownload(page)).bytes).pages;
    expect(colourAt(read!, WIDE, [600, 350])).toBe('#fff9db');

    await openExport(page, 'pdf');
    await page.locator('#mf-export-transparent').check();
    [read] = readPdf((await exportAndDownload(page)).bytes).pages;
    expect(colourAt(read!, WIDE, [600, 350])).toBe('#ffffff');
    expect(colourAt(read!, WIDE, [200, 200])).toBe(RED);
  });

  test('can be started from the command palette', async ({ page }) => {
    await seedFramedBoard(page);
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('pdf');
    await expect(page.locator('.mf-palette').getByRole('option', { name: /Export frames as PDF/ })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(page.locator(`${DIALOG} select[aria-label="Format"]`)).toHaveValue('pdf');
  });

  test('explains the failure in a browser that cannot compress', async ({ page }) => {
    await seedFramedBoard(page);
    await page.evaluate(() => {
      delete (window as unknown as { CompressionStream?: unknown }).CompressionStream;
    });
    await openExport(page, 'pdf');
    await page.locator(DIALOG).getByRole('button', { name: 'Export' }).click();

    await expect(page.locator('.mf-toast--error', { hasText: 'cannot create PDF files' })).toBeVisible();
  });
});

test.describe('PDF text', () => {
  const FRAME: FrameSpec = { id: 'fr_text', name: 'Text', x: 0, y: 0, width: 800, height: 450 };

  test('writes text as real text in the bundled font, so it can be searched and copied', async ({ page }) => {
    await seed(page, [FRAME], []);
    await seedStickies(page, [
      { id: 'el_note', frameId: FRAME.id, text: 'Ship the café plan — today', x: 50, y: 50, width: 300, height: 200 },
    ]);
    await openExport(page, 'pdf');
    const [read] = readPdf((await exportAndDownload(page)).bytes).pages;

    expect(read!.text).toEqual([{ text: 'Ship the café plan — today', invisible: false, font: 'Inter-Regular' }]);
    // Drawn as text, so not also painted into the picture: the note is bare
    // paper where its first letters would be.
    expect(colourAt(read!, FRAME, [66, 72])).toBe('#ffec99');
  });

  test('keeps text that something covers in the picture, with an invisible copy to find it by', async ({ page }) => {
    await seed(page, [FRAME], []);
    await seedStickies(page, [{ id: 'el_note', frameId: FRAME.id, text: 'Under a shape', x: 50, y: 50, width: 300, height: 200 }]);
    // A rectangle painted after the note, across its text.
    await seed(page, [], [{ id: 'el_cover', frameId: FRAME.id, fill: BLUE, x: 100, y: 55, width: 60, height: 40 }]);

    await openExport(page, 'pdf');
    const [read] = readPdf((await exportAndDownload(page)).bytes).pages;
    expect(read!.text).toEqual([{ text: 'Under a shape', invisible: true, font: 'Inter-Regular' }]);
    expect(colourAt(read!, FRAME, [130, 75])).toBe(BLUE);
  });

  test('leaves text the bundled fonts cannot draw in the picture only', async ({ page }) => {
    await seed(page, [FRAME], []);
    await seedStickies(page, [{ id: 'el_note', frameId: FRAME.id, text: 'Привет', x: 50, y: 50, width: 300, height: 200 }]);
    await openExport(page, 'pdf');
    const [read] = readPdf((await exportAndDownload(page)).bytes).pages;
    expect(read!.text).toEqual([]);
  });

  test('is only pictures when the bundled fonts could not be installed', async ({ page }) => {
    // Text measured in a system font the PDF cannot embed would be misplaced.
    await page.addInitScript(() => {
      delete (window as unknown as { DecompressionStream?: unknown }).DecompressionStream;
    });
    await page.reload();
    await page.waitForFunction(() => 'mindflow' in window);
    await seed(page, [FRAME], []);
    await seedStickies(page, [{ id: 'el_note', frameId: FRAME.id, text: 'System font', x: 50, y: 50, width: 300, height: 200 }]);
    await openExport(page, 'pdf');
    const [read] = readPdf((await exportAndDownload(page)).bytes).pages;
    expect(read!.text).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

test.describe('PNG export', () => {
  test('clips a frame’s members to the frame, as the canvas does', async ({ page }) => {
    // The red member hangs 100 units past the frame's right edge. The canvas
    // and the SVG exporter cut it at the edge; the PNG exporter used not to.
    await seed(
      page,
      [{ id: 'fr_clip', name: 'Clip', x: 0, y: 0, width: 400, height: 300 }],
      [{ id: 'el_over', frameId: 'fr_clip', fill: RED, x: 300, y: 100, width: 200, height: 100 }],
    );
    await openExport(page, 'png');
    await page.locator(`${DIALOG} select[aria-label="Resolution"]`).selectOption('1');
    const { bytes } = await exportAndDownload(page);

    // PNG bounds are the union of everything visible plus 24 of padding, so
    // scene (x, y) is pixel (x + 24, y + 24) at 1×.
    const [inside, outside] = await page.evaluate(async (base64) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const at = (x: number, y: number) => [...ctx.getImageData(x + 24, y + 24, 1, 1).data.slice(0, 3)];
      return [at(350, 150), at(450, 150)];
    }, bytes.toString('base64'));

    expect(inside).toEqual([0xe0, 0x31, 0x31]);
    expect(outside).toEqual([255, 255, 255]);
  });
});
