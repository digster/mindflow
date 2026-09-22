/**
 * Two-finger pan and pinch-to-zoom.
 *
 * The arithmetic lives in its own module precisely so it can be tested here:
 * Playwright can drive two simultaneous touches only through raw CDP, and the
 * property that matters — the board staying stuck to the fingers — is a
 * statement about numbers, not about pixels.
 */

import { describe, expect, it } from 'vitest';

import { MAX_ZOOM, MIN_ZOOM } from '../../src/model/defaults.ts';
import { screenToScene } from '../../src/model/geometry.ts';
import type { Viewport } from '../../src/model/types.ts';
import { midpoint, pinchViewport, spread, type PinchPair } from '../../src/input/pinch.ts';

const START: Viewport = { x: 100, y: 50, zoom: 1 };

/** Two fingers `gap` apart, centred on `at`. */
function pair(at: { x: number; y: number }, gap: number): PinchPair {
  return [
    { x: at.x - gap / 2, y: at.y },
    { x: at.x + gap / 2, y: at.y },
  ];
}

describe('midpoint and spread', () => {
  it('describe the two fingers', () => {
    const fingers = pair({ x: 300, y: 200 }, 100);
    expect(midpoint(fingers)).toEqual({ x: 300, y: 200 });
    expect(spread(fingers)).toBe(100);
  });
});

describe('pinchViewport', () => {
  it('scales zoom by the ratio of the finger spread', () => {
    const start = pair({ x: 400, y: 300 }, 100);
    expect(pinchViewport(START, start, pair({ x: 400, y: 300 }, 200)).zoom).toBeCloseTo(2, 6);
    expect(pinchViewport(START, start, pair({ x: 400, y: 300 }, 50)).zoom).toBeCloseTo(0.5, 6);
  });

  it('keeps the scene point under the fingers', () => {
    // The property the whole gesture is judged on: whatever was between the
    // fingers when they landed stays between them however they move.
    const start = pair({ x: 400, y: 300 }, 100);
    const grabbed = screenToScene(midpoint(start), START);

    for (const current of [
      pair({ x: 400, y: 300 }, 250), // zoom in, no pan
      pair({ x: 620, y: 140 }, 60), // zoom out while moving
      pair({ x: 100, y: 500 }, 100), // pure pan
    ]) {
      const next = pinchViewport(START, start, current);
      const under = screenToScene(midpoint(current), next);
      expect(under.x).toBeCloseTo(grabbed.x, 6);
      expect(under.y).toBeCloseTo(grabbed.y, 6);
    }
  });

  it('pans without zooming when the gap is unchanged', () => {
    const start = pair({ x: 400, y: 300 }, 120);
    const next = pinchViewport(START, start, pair({ x: 500, y: 300 }, 120));

    expect(next.zoom).toBeCloseTo(START.zoom, 6);
    // Moving the fingers 100px right at zoom 1 moves the board 100 scene units.
    expect(next.x).toBeCloseTo(START.x - 100, 6);
    expect(next.y).toBeCloseTo(START.y, 6);
  });

  it('returns to the starting viewport when the fingers do', () => {
    // Recomputing from the captured start rather than frame to frame is what
    // makes this exact; accumulating ratios drifts within seconds.
    const start = pair({ x: 400, y: 300 }, 140);
    const wandered = pinchViewport(START, start, pair({ x: 250, y: 420 }, 380));
    expect(wandered.zoom).not.toBeCloseTo(START.zoom, 2);

    const back = pinchViewport(START, start, start);
    expect(back).toEqual(START);
  });

  it('clamps to the app’s zoom limits', () => {
    const start = pair({ x: 400, y: 300 }, 10);
    expect(pinchViewport(START, start, pair({ x: 400, y: 300 }, 10000)).zoom).toBe(MAX_ZOOM);

    const wide = pair({ x: 400, y: 300 }, 1000);
    expect(pinchViewport(START, wide, pair({ x: 400, y: 300 }, 1)).zoom).toBe(MIN_ZOOM);
  });

  it('degrades to a pan when the fingers report the same point', () => {
    // A flaky digitiser can report both contacts at one spot. Dividing by that
    // spread would send the zoom to infinity.
    const coincident: PinchPair = [
      { x: 400, y: 300 },
      { x: 400, y: 300 },
    ];
    const next = pinchViewport(START, coincident, pair({ x: 500, y: 300 }, 0));
    expect(next.zoom).toBe(START.zoom);
    expect(next.x).toBeCloseTo(START.x - 100, 6);
  });
});
