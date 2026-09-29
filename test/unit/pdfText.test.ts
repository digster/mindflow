/**
 * Which text on a PDF page is real text and which stays in the picture.
 *
 * Real text is sharp at any zoom and is what a reader selects, copies and
 * searches. It goes on top of the page's picture, so it is only safe when
 * nothing in the picture would have covered or clipped it. Everything else
 * stays as pixels, with an invisible copy on top so it can still be found.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { composeMatrix, parseCanvasColor, planText, type Rect } from '../../src/render/pdfText.ts';
import type { TextBlockDraw } from '../../src/render/shapes/shared.ts';
import { parseTrueType } from '../../src/render/ttf.ts';

const INTER = parseTrueType(
  new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', 'src', 'fonts', 'sans-regular.ttf'))),
);

/** Two lines of 20px text laid out in a 200 × 100 box at the origin. */
function block(overrides: Partial<TextBlockDraw> = {}): TextBlockDraw {
  return {
    lines: [
      { text: 'Hello', x: 0, baseline: 16, width: 50 },
      { text: 'there', x: 0, baseline: 41, width: 48 },
    ],
    box: { x: 0, y: 0, width: 200, height: 100 },
    top: 0,
    bottom: 50,
    fontFamily: 'sans',
    fontSize: 20,
    fontWeight: 400,
    ...overrides,
  };
}

const IDENTITY: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
const FRAME: Rect = { minX: -100, minY: -100, maxX: 1000, maxY: 1000 };

describe('planText', () => {
  it('writes a block as text when nothing could cover or clip it', () => {
    const plan = planText(block(), INTER, IDENTITY, FRAME, []);
    expect(plan?.mode).toBe('text');
    expect(plan?.lines.map((line) => line.text)).toEqual(['Hello', 'there']);
    expect(plan?.lines[0]).toMatchObject({ x: 0, y: 16 });
    expect(plan?.lines[0]?.glyphs).toEqual([...'Hello'].map((character) => INTER.glyphFor(character.codePointAt(0)!)));
  });

  it('keeps a block in the picture when something painted later overlaps it', () => {
    // A later shape over the text would hide it in the picture, but text
    // written on top of the picture would show through.
    const plan = planText(block(), INTER, IDENTITY, FRAME, [{ minX: 20, minY: 20, maxX: 60, maxY: 60 }]);
    expect(plan?.mode).toBe('hidden');
  });

  it('ignores later elements that are elsewhere, and ones that are not painted', () => {
    const plan = planText(block(), INTER, IDENTITY, FRAME, [{ minX: 500, minY: 500, maxX: 600, maxY: 600 }, null]);
    expect(plan?.mode).toBe('text');
  });

  it('keeps a block that overflows its box in the picture, since its element may clip it', () => {
    // A sticky note cuts off text that does not fit. Two lines of 25 in a
    // box 30 high overflow it.
    const plan = planText(block({ box: { x: 0, y: 0, width: 200, height: 30 } }), INTER, IDENTITY, FRAME, []);
    expect(plan?.mode).toBe('hidden');
  });

  it('keeps a block that crosses its frame’s edge in the picture', () => {
    const plan = planText(block(), INTER, IDENTITY, { minX: 0, minY: 0, maxX: 30, maxY: 1000 }, []);
    expect(plan?.mode).toBe('hidden');
  });

  it('measures against the frame in pixels, through the element’s transform', () => {
    // The same block, scaled up 10×, now reaches past a frame it fitted before.
    const scaled: [number, number, number, number, number, number] = [10, 0, 0, 10, 0, 0];
    expect(planText(block(), INTER, IDENTITY, { minX: -50, minY: -50, maxX: 300, maxY: 300 }, [])?.mode).toBe('text');
    expect(planText(block(), INTER, scaled, { minX: -50, minY: -50, maxX: 300, maxY: 300 }, [])?.mode).toBe('hidden');
  });

  it('gives up on a block with a character the face lacks, which a fallback font drew', () => {
    const plan = planText(
      block({ lines: [{ text: 'Привет', x: 0, baseline: 16, width: 60 }] }),
      INTER,
      IDENTITY,
      FRAME,
      [],
    );
    expect(plan).toBeNull();
  });

  it('skips empty lines, and gives up on a block with no text', () => {
    const withBlank = planText(
      block({ lines: [{ text: '', x: 0, baseline: 16, width: 0 }, { text: 'x', x: 0, baseline: 41, width: 10 }] }),
      INTER,
      IDENTITY,
      FRAME,
      [],
    );
    expect(withBlank?.lines.map((line) => line.text)).toEqual(['x']);
    expect(planText(block({ lines: [{ text: '', x: 0, baseline: 16, width: 0 }] }), INTER, IDENTITY, FRAME, [])).toBeNull();
  });
});

describe('composeMatrix', () => {
  it('applies the inner matrix first, as PDF’s cm and the canvas do', () => {
    // Scale by 2, then translate by (10, 20): the point (1, 1) goes to (12, 22).
    const m = composeMatrix([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0]);
    const [a, b, c, d, e, f] = m;
    expect([a * 1 + c * 1 + e, b * 1 + d * 1 + f]).toEqual([12, 22]);
  });
});

describe('parseCanvasColor', () => {
  it('reads the two forms a canvas normalises a colour to', () => {
    expect(parseCanvasColor('#1e1e1e')).toEqual({ rgb: [30 / 255, 30 / 255, 30 / 255], alpha: 1 });
    expect(parseCanvasColor('rgba(255, 0, 128, 0.5)')).toEqual({ rgb: [1, 0, 128 / 255], alpha: 0.5 });
  });

  it('answers null for anything else', () => {
    expect(parseCanvasColor('color(display-p3 1 0 0)')).toBeNull();
    expect(parseCanvasColor('red')).toBeNull();
  });
});
