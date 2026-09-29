/**
 * Decides how each block of text goes into a PDF page. Pure, so the rules are
 * unit-tested; `exportPdf.ts` feeds it the blocks as the canvas draws them.
 *
 * A page is a picture of its frame with text on top. A block written as real
 * text is left out of the picture, so the rules exist to keep the page looking
 * exactly like the picture would have:
 *
 * 1. **Every character must be in the bundled face.** A character it lacks
 *    was drawn from a system font, whose glyphs and widths the PDF cannot
 *    have. Such a block stays as pixels only.
 * 2. **Nothing painted after it may overlap it.** Text on top of the picture
 *    would show through a shape that covers it on the board. Overlap is
 *    tested between bounding boxes, which can only err towards pixels.
 * 3. **It must fit its own layout box.** A sticky note and a table cell clip
 *    text that overflows, and the canvas knows those clips but the PDF
 *    does not. Text that fits its box is never clipped by its own element.
 * 4. **It must lie inside its frame**, which clips the page's contents.
 *
 * A block that fails 2, 3 or 4 stays in the picture, and is also written as
 * invisible text (render mode 3) over it, so it can still be selected and
 * searched. Only a block that fails 1 has no text in the PDF at all.
 */

import type { TextBlockDraw } from './shapes/shared.ts';
import type { TrueTypeFont } from './ttf.ts';

/** An affine matrix as canvas and PDF both write it: `[a, b, c, d, e, f]`. */
export type Matrix = [number, number, number, number, number, number];

/** An axis-aligned box, in the page's pixels. */
export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TextPlan {
  /** `text` is drawn as PDF text; `hidden` stays in the picture, as invisible text over it. */
  mode: 'text' | 'hidden';
  /** The non-empty lines, each with its glyph ids, one per character. */
  lines: { x: number; y: number; glyphs: number[]; text: string }[];
}

/** Rounding in layout and in transforms is far below this, in either unit. */
const EPSILON = 0.5;

/**
 * How `block` goes into the page, or `null` when it cannot be text at all.
 *
 * @param toPixels  the block's LOCAL frame to the page picture's pixels: the
 *                  canvas transform when the block was drawn
 * @param frame     the page's frame, in pixels
 * @param later     every element painted after this one, in pixels, or null
 *                  for one that is not painted
 */
export function planText(
  block: TextBlockDraw,
  font: TrueTypeFont,
  toPixels: Matrix,
  frame: Rect,
  later: readonly (Rect | null)[],
): TextPlan | null {
  const lines: TextPlan['lines'] = [];
  for (const line of block.lines) {
    if (line.text === '') continue;
    const glyphs: number[] = [];
    for (const character of line.text) {
      const glyph = font.glyphFor(character.codePointAt(0) ?? 0);
      if (glyph === 0) return null; // Rule 1.
      glyphs.push(glyph);
    }
    lines.push({ x: line.x, y: line.baseline, glyphs, text: line.text });
  }
  if (lines.length === 0) return null;

  const drawn = block.lines.filter((line) => line.text !== '');
  const left = Math.min(...drawn.map((line) => line.x));
  const right = Math.max(...drawn.map((line) => line.x + line.width));

  // Rule 3, on the line boxes, which is what the layout fitted to the box.
  const { box } = block;
  const fits =
    left >= box.x - EPSILON &&
    right <= box.x + box.width + EPSILON &&
    block.top >= box.y - EPSILON &&
    block.bottom <= box.y + box.height + EPSILON;

  // Rules 2 and 4 on the ink instead, from the font's ascender to its
  // descender, since a frame cuts glyphs, not line boxes.
  const scale = block.fontSize / font.unitsPerEm;
  const ink = transformBox(toPixels, {
    minX: left,
    maxX: right,
    minY: Math.min(...drawn.map((line) => line.baseline)) - font.ascender * scale,
    maxY: Math.max(...drawn.map((line) => line.baseline)) - font.descender * scale,
  });
  const inFrame =
    ink.minX >= frame.minX - EPSILON &&
    ink.maxX <= frame.maxX + EPSILON &&
    ink.minY >= frame.minY - EPSILON &&
    ink.maxY <= frame.maxY + EPSILON;
  const covered = later.some((other) => other !== null && overlaps(other, ink));

  return { mode: fits && inFrame && !covered ? 'text' : 'hidden', lines };
}

/** `outer` applied after `inner`: the matrix of `inner` then `outer`. */
export function composeMatrix(outer: Matrix, inner: Matrix): Matrix {
  const [a, b, c, d, e, f] = outer;
  const [a2, b2, c2, d2, e2, f2] = inner;
  return [
    a * a2 + c * b2,
    b * a2 + d * b2,
    a * c2 + c * d2,
    b * c2 + d * d2,
    a * e2 + c * f2 + e,
    b * e2 + d * f2 + f,
  ];
}

/**
 * A colour as a canvas reports its `fillStyle`: `#rrggbb` when opaque,
 * `rgba(r, g, b, a)` otherwise. Anything else (a wide-gamut colour, say) is
 * `null`, and that text stays in the picture.
 */
export function parseCanvasColor(value: string): { rgb: [number, number, number]; alpha: number } | null {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (hex) {
    return { rgb: [hex[1], hex[2], hex[3]].map((channel) => parseInt(channel!, 16) / 255) as [number, number, number], alpha: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
  if (rgba) {
    return {
      rgb: [rgba[1], rgba[2], rgba[3]].map((channel) => Number(channel) / 255) as [number, number, number],
      alpha: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }
  return null;
}

function transformBox(m: Matrix, box: Rect): Rect {
  const [a, b, c, d, e, f] = m;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [x, y] of [
    [box.minX, box.minY],
    [box.maxX, box.minY],
    [box.minX, box.maxY],
    [box.maxX, box.maxY],
  ] as const) {
    xs.push(a * x + c * y + e);
    ys.push(b * x + d * y + f);
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}
