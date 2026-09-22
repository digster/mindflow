/**
 * Two-finger pan and pinch-to-zoom.
 *
 * Kept out of `controller.ts` and free of any DOM so it can be unit-tested in
 * the node environment. Playwright can drive two simultaneous touches only
 * through raw CDP, so the arithmetic that actually decides where the board ends
 * up is worth being able to test directly.
 *
 * The rule the rest of the controller follows applies here too: a gesture
 * recomputes from the state captured when it began, never from the previous
 * frame. For a pinch that matters more than usual — accumulating per-frame zoom
 * ratios drifts visibly within a second or two of continuous pinching, and the
 * board never quite returns to where it started when the fingers do.
 */

import type { Point, Viewport } from '../model/types.ts';
import { clamp, screenToScene } from '../model/geometry.ts';
import { MAX_ZOOM, MIN_ZOOM } from '../model/defaults.ts';

/** The two touch points of a pinch, in screen coordinates. */
export type PinchPair = readonly [Point, Point];

export function midpoint([a, b]: PinchPair): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export function spread([a, b]: PinchPair): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * The viewport a pinch produces, given where it started and where the fingers
 * are now.
 *
 * Zoom is the ratio of the current finger spread to the starting spread, so
 * doubling the gap doubles the zoom regardless of how the gesture got there.
 * The scene point under the starting midpoint is then placed back under the
 * current midpoint, which is what makes the board feel stuck to the fingers:
 * one expression covers the pan and the zoom together, rather than composing a
 * zoom about an anchor with a separate translation.
 *
 * A spread of zero (both fingers reported at the same place, which a flaky
 * digitiser will do) keeps the starting zoom rather than dividing by it, so the
 * gesture degrades to a two-finger pan instead of exploding.
 */
export function pinchViewport(
  startViewport: Viewport,
  start: PinchPair,
  current: PinchPair,
): Viewport {
  const startSpread = spread(start);
  const ratio = startSpread === 0 ? 1 : spread(current) / startSpread;
  const zoom = clamp(startViewport.zoom * ratio, MIN_ZOOM, MAX_ZOOM);

  // The scene point the gesture grabbed, resolved in the viewport it started
  // from — not in the live one, which this function is in the middle of
  // replacing.
  const anchor = screenToScene(midpoint(start), startViewport);
  const to = midpoint(current);

  return {
    zoom,
    x: anchor.x - to.x / zoom,
    y: anchor.y - to.y / zoom,
  };
}
