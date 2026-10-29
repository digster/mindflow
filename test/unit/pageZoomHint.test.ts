/**
 * Placing the note shown while the page is zoomed (`src/ui/pageZoomHint.ts`).
 *
 * The note is pinned to the layout viewport's corner and has to be moved onto
 * the visible part and shrunk back to its normal size. The e2e suite checks it
 * lands inside the view. This checks the arithmetic, at offsets and scales the
 * e2e suite does not reach.
 */

import { describe, expect, it } from 'vitest';

import { hintPlacement } from '../../src/ui/pageZoomHint.ts';

/** The strip's width on screen, in screen pixels, from its styles. */
function widthOnScreen(placement: { width: string; transform: string }, scale: number): number {
  const cssWidth = Number.parseFloat(placement.width);
  const shrink = Number(/scale\(([^)]+)\)/.exec(placement.transform)?.[1]);
  // CSS pixels after its own transform, then screen pixels at the page's scale.
  return cssWidth * shrink * scale;
}

describe('hintPlacement', () => {
  it('is a no-op on a page that is not zoomed', () => {
    expect(hintPlacement({ offsetLeft: 0, offsetTop: 0, width: 820, scale: 1 })).toEqual({
      width: '820px',
      transform: 'translate(0px, 0px) scale(1)',
    });
  });

  it('moves the strip to the visible area’s top-left corner', () => {
    const { transform } = hintPlacement({ offsetLeft: 300, offsetTop: 420, width: 205, scale: 4 });
    expect(transform).toMatch(/^translate\(300px, 420px\) /);
  });

  it('makes the strip exactly as wide as the screen at any scale', () => {
    // 820 screen pixels across, the width of an iPad in portrait.
    for (const scale of [1.5, 2, 4, 5]) {
      const placement = hintPlacement({ offsetLeft: 10, offsetTop: 10, width: 820 / scale, scale });
      expect(widthOnScreen(placement, scale)).toBeCloseTo(820, 6);
    }
  });

  it('cancels the page’s scale, so the note shows at its normal size', () => {
    const { transform } = hintPlacement({ offsetLeft: 0, offsetTop: 0, width: 205, scale: 4 });
    expect(transform).toMatch(/scale\(0\.25\)$/);
  });
});
