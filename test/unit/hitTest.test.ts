/**
 * Picking, and the tolerance that makes it usable.
 *
 * The interesting part is not "a click inside a shape hits it" — it is the
 * margin around a shape that also counts, which is what makes a hairline
 * clickable at 10% zoom and a thin line tappable with a finger. Both of those
 * are stated in `docs/05-interactions.md`, so both are pinned here.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { getDefinition } from '../../src/model/registry.ts';
import type { MindflowDocument, MindflowElement } from '../../src/model/types.ts';
import {
  HIT_TOLERANCE_PX,
  TOUCH_HIT_TOLERANCE_PX,
  elementAt,
  toleranceFor,
} from '../../src/input/hitTest.ts';

/** A board holding one unfilled line from (100,100) to (300,100). */
function boardWithLine(): MindflowDocument {
  const document = createDocument();
  const line = getDefinition('line').create({
    x: 100,
    y: 100,
    width: 200,
    height: 1,
    zIndex: 1000,
    points: [
      [0, 0],
      [200, 0],
    ],
  }) as MindflowElement;
  document.elements.push(line);
  return document;
}

describe('toleranceFor', () => {
  it('converts screen pixels to scene units', () => {
    // Screen-relative, so a hairline is equally clickable at any zoom. Scene
    // units instead would make thin shapes nearly unclickable when zoomed out.
    expect(toleranceFor(1)).toBe(HIT_TOLERANCE_PX);
    expect(toleranceFor(2)).toBe(HIT_TOLERANCE_PX / 2);
    expect(toleranceFor(0.5)).toBe(HIT_TOLERANCE_PX * 2);
  });

  it('takes an explicit tolerance for a coarse pointer', () => {
    expect(toleranceFor(1, TOUCH_HIT_TOLERANCE_PX)).toBe(TOUCH_HIT_TOLERANCE_PX);
    expect(toleranceFor(2, TOUCH_HIT_TOLERANCE_PX)).toBe(TOUCH_HIT_TOLERANCE_PX / 2);
  });

  it('gives a finger a wider margin than a cursor', () => {
    // A cursor's hot spot is one pixel; a fingertip covers roughly forty and the
    // user cannot see what is under it.
    expect(TOUCH_HIT_TOLERANCE_PX).toBeGreaterThan(HIT_TOLERANCE_PX);
  });
});

describe('elementAt', () => {
  const document = boardWithLine();

  it('finds a line within the default tolerance', () => {
    expect(elementAt(document, { x: 200, y: 105 }, 1)).not.toBeNull();
  });

  it('misses it beyond the default tolerance', () => {
    expect(elementAt(document, { x: 200, y: 112 }, 1)).toBeNull();
  });

  it('finds it at the same distance with the touch tolerance', () => {
    // The gap this closes: 12px off a line is past a mouse's reach and well
    // inside a finger's, and at 8px a thin shape feels like it is dodging taps.
    expect(
      elementAt(document, { x: 200, y: 112 }, 1, { tolerancePx: TOUCH_HIT_TOLERANCE_PX }),
    ).not.toBeNull();
  });

  it('still misses something genuinely far away', () => {
    expect(
      elementAt(document, { x: 200, y: 200 }, 1, { tolerancePx: TOUCH_HIT_TOLERANCE_PX }),
    ).toBeNull();
  });

  it('scales the touch tolerance with zoom like every other one', () => {
    // At 2x, 12 scene units is 24 screen pixels — outside even a finger's reach.
    expect(
      elementAt(document, { x: 200, y: 112 }, 2, { tolerancePx: TOUCH_HIT_TOLERANCE_PX }),
    ).toBeNull();
  });
});
