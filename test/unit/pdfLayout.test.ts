/**
 * PDF page layout: which frame lands on which page, and where on it.
 *
 * These rules are published in `docs/07-rendering.md#pdf`, so a script can
 * predict the page a frame lands on and the scale it is drawn at. Pure
 * geometry, so every case is pinned here rather than in the browser suite.
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_RASTER_AREA,
  MAX_RASTER_SIDE,
  PAGE_MARGIN,
  PAGE_SIZES,
  fitToPage,
  pageContentBox,
  pageSizeById,
  rasterSize,
  readingOrder,
} from '../../src/render/pdfLayout.ts';

const A4 = pageSizeById('a4');

function box(name: string, x: number, y: number, width = 100, height = 100) {
  return { name, x, y, width, height };
}

const names = (boxes: { name: string }[]) => boxes.map((item) => item.name);

describe('page sizes', () => {
  it('are portrait, in points', () => {
    for (const size of PAGE_SIZES) expect(size.height).toBeGreaterThan(size.width);
    // 210 × 297 mm at 72 points to the inch.
    expect(A4.width).toBeCloseTo((210 / 25.4) * 72, 1);
    expect(A4.height).toBeCloseTo((297 / 25.4) * 72, 1);
    expect(pageSizeById('letter')).toMatchObject({ width: 612, height: 792 });
  });

  it('fall back to A4 for an unknown id', () => {
    expect(pageSizeById('tabloid' as never)).toBe(A4);
  });
});

describe('readingOrder', () => {
  it('reads a grid row by row, left to right', () => {
    const grid = [
      box('d', 200, 200),
      box('b', 200, 0),
      box('c', 0, 200),
      box('a', 0, 0),
    ];
    expect(names(readingOrder(grid))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps a row together when its frames are not quite aligned', () => {
    // Hand-placed frames are never pixel-aligned. `b` starts 30 units lower
    // than `a` but plainly sits beside it, so it must come before `c`, which
    // sits under `a` even though its x is smaller than `b`'s.
    const frames = [box('c', 0, 150), box('b', 150, 30), box('a', 20, 0)];
    expect(names(readingOrder(frames))).toEqual(['a', 'b', 'c']);
  });

  it('starts a new row at the first frame whose top is below the row’s midline', () => {
    // The row is anchored by its topmost frame, `a`, whose midline is y = 50.
    // `b` starts at 49 and joins the row; `c` starts at 50 and does not.
    const frames = [box('c', 0, 50), box('b', 300, 49), box('a', 150, 0)];
    expect(names(readingOrder(frames))).toEqual(['a', 'b', 'c']);
    const leftOfRow = [box('c', 0, 50), box('b', 100, 49), box('a', 150, 0)];
    expect(names(readingOrder(leftOfRow))).toEqual(['b', 'a', 'c']);
  });

  it('reads a tall frame beside two short ones as one row, then the next', () => {
    const frames = [box('tall', 0, 0, 100, 1000), box('top', 200, 0, 100, 400), box('bottom', 200, 600, 100, 400)];
    expect(names(readingOrder(frames))).toEqual(['tall', 'top', 'bottom']);
  });

  it('reads a column top to bottom', () => {
    const frames = [box('c', 0, 400), box('a', 0, 0), box('b', 0, 200)];
    expect(names(readingOrder(frames))).toEqual(['a', 'b', 'c']);
  });

  it('keeps the input order for frames at the same position', () => {
    const frames = [box('first', 0, 0), box('second', 0, 0)];
    expect(names(readingOrder(frames))).toEqual(['first', 'second']);
  });

  it('does not reorder its input', () => {
    const frames = [box('b', 200, 0), box('a', 0, 0)];
    readingOrder(frames);
    expect(names(frames)).toEqual(['b', 'a']);
  });

  it('returns nothing for nothing', () => {
    expect(readingOrder([])).toEqual([]);
  });
});

describe('pageContentBox', () => {
  it('grows the frame by half its stroke, so the border is not cut in half', () => {
    expect(pageContentBox({ x: 10, y: 20, width: 300, height: 200 }, 4)).toEqual({
      x: 8,
      y: 18,
      width: 304,
      height: 204,
    });
  });

  it('is the frame itself without a stroke', () => {
    expect(pageContentBox({ x: 10, y: 20, width: 300, height: 200 }, 0)).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
  });
});

describe('fitToPage', () => {
  const printableWidth = A4.width - PAGE_MARGIN * 2;
  const printableHeight = A4.height - PAGE_MARGIN * 2;

  it('turns the page to landscape for a wide frame', () => {
    const layout = fitToPage({ width: 1600, height: 900 }, A4, 'auto');
    expect(layout.orientation).toBe('landscape');
    expect(layout.pageWidth).toBeCloseTo(A4.height);
    expect(layout.pageHeight).toBeCloseTo(A4.width);
  });

  it('keeps the page portrait for a tall frame', () => {
    const layout = fitToPage({ width: 600, height: 900 }, A4, 'auto');
    expect(layout.orientation).toBe('portrait');
    expect(layout.pageWidth).toBeCloseTo(A4.width);
  });

  it('picks portrait for a square frame, where both fit equally', () => {
    expect(fitToPage({ width: 500, height: 500 }, A4, 'auto').orientation).toBe('portrait');
  });

  it('turns the page for a frame only barely wider than tall', () => {
    // Auto picks whichever orientation draws the frame larger. Portrait fits
    // this one at 523 / 1050 of a point per unit (the printable width), and
    // landscape at 523 / 1000 (the printable height), so landscape wins. With
    // equal margins all round that is always the orientation matching the
    // frame's shape, however slight the difference.
    const wide = fitToPage({ width: 1050, height: 1000 }, A4, 'auto');
    const portrait = fitToPage({ width: 1050, height: 1000 }, A4, 'portrait');
    expect(wide.orientation).toBe('landscape');
    expect(wide.scale).toBeGreaterThan(portrait.scale);
  });

  it('honours a forced orientation', () => {
    expect(fitToPage({ width: 1600, height: 900 }, A4, 'portrait').orientation).toBe('portrait');
    expect(fitToPage({ width: 600, height: 900 }, A4, 'landscape').orientation).toBe('landscape');
  });

  it('scales uniformly to touch the margins on the limiting side, and centres the other', () => {
    const layout = fitToPage({ width: 600, height: 900 }, A4, 'portrait');
    const scale = Math.min(printableWidth / 600, printableHeight / 900);
    expect(layout.scale).toBeCloseTo(scale);
    expect(layout.width).toBeCloseTo(600 * scale);
    expect(layout.height).toBeCloseTo(900 * scale);
    // Height is the limiting side here, so it runs margin to margin…
    expect(layout.y).toBeCloseTo(PAGE_MARGIN);
    expect(layout.y + layout.height).toBeCloseTo(A4.height - PAGE_MARGIN);
    // …and the width is centred.
    expect(layout.x).toBeCloseTo((A4.width - layout.width) / 2);
  });

  it('keeps the frame’s aspect ratio', () => {
    const layout = fitToPage({ width: 1234, height: 567 }, A4, 'auto');
    expect(layout.width / layout.height).toBeCloseTo(1234 / 567, 6);
  });

  it('scales a small frame up to fill the page', () => {
    const layout = fitToPage({ width: 40, height: 30 }, A4, 'auto');
    expect(layout.scale).toBeGreaterThan(1);
    // 4 : 3 is squarer than landscape A4's printable area, so the height is
    // the side that reaches the margins.
    expect(layout.orientation).toBe('landscape');
    expect(layout.height).toBeCloseTo(A4.width - PAGE_MARGIN * 2);
  });

  it('scales a huge frame down to fit', () => {
    const layout = fitToPage({ width: 20000, height: 10000 }, A4, 'auto');
    expect(layout.scale).toBeLessThan(0.1);
    expect(layout.x).toBeGreaterThanOrEqual(PAGE_MARGIN - 1e-9);
    expect(layout.x + layout.width).toBeLessThanOrEqual(layout.pageWidth - PAGE_MARGIN + 1e-9);
  });
});

describe('rasterSize', () => {
  it('is the placed size at the requested resolution', () => {
    // A 4 × 3 inch area at 150 dpi.
    expect(rasterSize({ width: 288, height: 216 }, 150)).toEqual({ width: 600, height: 450 });
  });

  it('stays within the canvas area every browser will allocate', () => {
    // A3 at 300 dpi is about 17.4 million pixels, over iOS Safari's limit.
    const size = rasterSize({ width: 841.89, height: 1190.55 }, 300);
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_RASTER_AREA);
    // …and still nearly the resolution asked for, with the aspect ratio kept.
    expect(size.width).toBeGreaterThan((841.89 / 72) * 290);
    expect(size.width / size.height).toBeCloseTo(841.89 / 1190.55, 2);
  });

  it('stays within the longest side a canvas can have', () => {
    const size = rasterSize({ width: 14000, height: 10 }, 300);
    expect(size.width).toBeLessThanOrEqual(MAX_RASTER_SIDE);
  });

  it('never asks for an empty canvas', () => {
    expect(rasterSize({ width: 0.1, height: 0.1 }, 72)).toEqual({ width: 1, height: 1 });
  });
});
