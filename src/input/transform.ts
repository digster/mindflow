/**
 * Resize, rotate and move math.
 *
 * ---------------------------------------------------------------------------
 * The hard part: resizing a rotated element
 * ---------------------------------------------------------------------------
 * Dragging the south-east handle of an unrotated box is trivial. Dragging it on
 * a box rotated 30° is where naive implementations go wrong — the usual symptom
 * is the shape drifting sideways as it grows, because the corner you are *not*
 * dragging silently moved.
 *
 * The fix is to state the requirement precisely: the anchor (the handle
 * diagonally opposite the one being dragged) must stay at exactly the same WORLD
 * position throughout. Everything else follows.
 *
 * The derivation, which {@link frameOriginForAnchor} implements:
 *
 *   Let the new box have origin (x, y), size (w, h), rotation θ, and centre
 *   c = (x + w/2, y + h/2). For a point at local position `a`, its offset from
 *   the centre is d = (a.x − w/2, a.y − h/2) — note this depends only on the new
 *   SIZE, not on the unknown origin. Its world position is therefore:
 *
 *       world = c + R(θ)·d
 *
 *   Setting `world` to the anchor's known, fixed world position and solving:
 *
 *       x = anchorWorld.x − w/2 − (R(θ)·d).x
 *       y = anchorWorld.y − h/2 − (R(θ)·d).y
 *
 * Closed-form, exact, no iteration and no accumulated drift across a long drag.
 */

import type { MindflowElement, Point, PointTuple } from '../model/types.ts';
import type { HandleId, SelectionFrame } from '../render/overlay.ts';
import { frameLocalToWorld, frameWorldToLocal } from '../render/overlay.ts';
import { degToRad, normalizeAngle, radToDeg, rotatePoint } from '../model/geometry.ts';

/** Smallest box a resize will produce, in scene units. */
const MIN_SIZE = 4;

/** The handle diagonally opposite the one being dragged. */
const OPPOSITE: Record<Exclude<HandleId, 'rotate'>, Exclude<HandleId, 'rotate'>> = {
  nw: 'se',
  n: 's',
  ne: 'sw',
  e: 'w',
  se: 'nw',
  s: 'n',
  sw: 'ne',
  w: 'e',
};

/** A handle's position in the frame's local space, given a size. */
function handleLocal(handle: Exclude<HandleId, 'rotate'>, w: number, h: number): Point {
  switch (handle) {
    case 'nw':
      return { x: 0, y: 0 };
    case 'n':
      return { x: w / 2, y: 0 };
    case 'ne':
      return { x: w, y: 0 };
    case 'e':
      return { x: w, y: h / 2 };
    case 'se':
      return { x: w, y: h };
    case 's':
      return { x: w / 2, y: h };
    case 'sw':
      return { x: 0, y: h };
    case 'w':
      return { x: 0, y: h / 2 };
  }
}

/** Solves for the frame origin that pins `anchorLocal` to `anchorWorld`. */
function frameOriginForAnchor(
  anchorWorld: Point,
  anchorLocal: Point,
  width: number,
  height: number,
  angle: number,
): Point {
  const d = { x: anchorLocal.x - width / 2, y: anchorLocal.y - height / 2 };
  const rotated = angle === 0 ? d : rotatePoint(d, { x: 0, y: 0 }, angle);
  return { x: anchorWorld.x - width / 2 - rotated.x, y: anchorWorld.y - height / 2 - rotated.y };
}

export interface ResizeOptions {
  /** Preserve the original aspect ratio (Shift). */
  lockAspect: boolean;
  /** Resize about the centre instead of the opposite handle (Alt). */
  fromCenter: boolean;
}

/**
 * Computes the frame produced by dragging `handle` to `pointerWorld`.
 *
 * Works entirely in the frame's local space, then converts back — the same
 * "pull the pointer into local space" strategy the hit-tester uses, and for the
 * same reason: it turns a rotated problem into an axis-aligned one.
 */
export function resizeFrame(
  frame: SelectionFrame,
  handle: Exclude<HandleId, 'rotate'>,
  pointerWorld: Point,
  options: ResizeOptions,
): SelectionFrame {
  const anchorHandle = OPPOSITE[handle];
  const anchorLocalOld = handleLocal(anchorHandle, frame.width, frame.height);
  const anchorWorld = frameLocalToWorld(frame, anchorLocalOld);

  const pointerLocal = frameWorldToLocal(frame, pointerWorld);

  // Which axes this handle actually controls. Edge handles move one axis only.
  const movesX = handle !== 'n' && handle !== 's';
  const movesY = handle !== 'e' && handle !== 'w';
  const fromLeft = handle === 'nw' || handle === 'w' || handle === 'sw';
  const fromTop = handle === 'nw' || handle === 'n' || handle === 'ne';

  let width = frame.width;
  let height = frame.height;

  if (movesX) {
    width = fromLeft ? frame.width - pointerLocal.x : pointerLocal.x;
    if (options.fromCenter) {
      width = fromLeft
        ? frame.width / 2 + (frame.width / 2 - pointerLocal.x)
        : pointerLocal.x - frame.width / 2;
      width *= 2;
    }
  }
  if (movesY) {
    height = fromTop ? frame.height - pointerLocal.y : pointerLocal.y;
    if (options.fromCenter) {
      height = fromTop
        ? frame.height / 2 + (frame.height / 2 - pointerLocal.y)
        : pointerLocal.y - frame.height / 2;
      height *= 2;
    }
  }

  if (options.lockAspect && frame.width > 0 && frame.height > 0) {
    const ratio = frame.width / frame.height;
    if (movesX && movesY) {
      // Corner drag: take whichever axis the user pushed further, so the shape
      // tracks the pointer rather than fighting it.
      if (Math.abs(width / ratio) > Math.abs(height)) height = width / ratio;
      else width = height * ratio;
    } else if (movesX) {
      height = width / ratio;
    } else {
      width = height * ratio;
    }
  }

  // Flipping past the anchor is clamped rather than mirrored: the format
  // guarantees positive dimensions, and mirroring geometry mid-drag is a
  // surprising interaction that no whiteboard offers.
  width = Math.max(width, MIN_SIZE);
  height = Math.max(height, MIN_SIZE);

  if (options.fromCenter) {
    const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
    return {
      ...frame,
      x: center.x - width / 2,
      y: center.y - height / 2,
      width,
      height,
    };
  }

  const anchorLocalNew = handleLocal(anchorHandle, width, height);
  const origin = frameOriginForAnchor(anchorWorld, anchorLocalNew, width, height, frame.angle);

  return { ...frame, x: origin.x, y: origin.y, width, height };
}

/**
 * Angle, in degrees, from the frame's centre to the pointer.
 *
 * The 90° offset makes the rotate handle (which sits above the shape) read as
 * 0°, so dragging it left and right turns the shape the way you expect.
 */
export function rotationForPointer(frame: SelectionFrame, pointerWorld: Point): number {
  const center = { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
  const radians = Math.atan2(pointerWorld.y - center.y, pointerWorld.x - center.x);
  return normalizeAngle(radToDeg(radians) + 90);
}

/** Snap increment while rotating with Shift held. */
export const ROTATION_SNAP_DEGREES = 15;

// ---------------------------------------------------------------------------
// Applying a frame change to elements
// ---------------------------------------------------------------------------

function scalePoints(points: readonly PointTuple[], scaleX: number, scaleY: number): PointTuple[] {
  return points.map((p) =>
    p.length > 2
      ? ([p[0] * scaleX, p[1] * scaleY, p[2]] as PointTuple)
      : ([p[0] * scaleX, p[1] * scaleY] as PointTuple),
  );
}

/**
 * Maps a frame change onto the elements inside it.
 *
 * Single selection is exact: the element *is* the frame.
 *
 * Multi-selection scales each element's offset and size proportionally within
 * the (axis-aligned) frame. For rotated members this is an approximation — a
 * mathematically exact group resize would shear them, which requires a full
 * affine transform per element that the format deliberately does not store.
 * Every mainstream whiteboard makes the same trade; the visible effect is that a
 * rotated shape inside a stretched group keeps its own aspect distortion rather
 * than skewing.
 */
export function applyFrameToElements(
  elements: readonly MindflowElement[],
  before: SelectionFrame,
  after: SelectionFrame,
): MindflowElement[] {
  if (before.single && elements.length === 1) {
    const el = elements[0] as MindflowElement;
    const scaleX = before.width === 0 ? 1 : after.width / before.width;
    const scaleY = before.height === 0 ? 1 : after.height / before.height;
    const next = {
      ...el,
      x: after.x,
      y: after.y,
      width: after.width,
      height: after.height,
      angle: after.angle,
    } as MindflowElement;

    if (next.type === 'line' || next.type === 'arrow' || next.type === 'draw') {
      next.points = scalePoints(next.points, scaleX, scaleY);
    }
    return [next];
  }

  const scaleX = before.width === 0 ? 1 : after.width / before.width;
  const scaleY = before.height === 0 ? 1 : after.height / before.height;

  return elements.map((el) => {
    const next = {
      ...el,
      x: after.x + (el.x - before.x) * scaleX,
      y: after.y + (el.y - before.y) * scaleY,
      width: Math.max(el.width * scaleX, MIN_SIZE),
      height: Math.max(el.height * scaleY, MIN_SIZE),
    } as MindflowElement;

    if (next.type === 'line' || next.type === 'arrow' || next.type === 'draw') {
      next.points = scalePoints(next.points, scaleX, scaleY);
    }
    return next;
  });
}

/**
 * Rotates a set of elements about a shared pivot.
 *
 * Each element gains `delta` to its own angle AND has its centre swung around
 * the pivot. Rotating only the angles would spin every element in place instead
 * of turning the group as one rigid body.
 */
export function rotateElements(
  elements: readonly MindflowElement[],
  pivot: Point,
  delta: number,
): MindflowElement[] {
  return elements.map((el) => {
    const center = { x: el.x + el.width / 2, y: el.y + el.height / 2 };
    const moved = rotatePoint(center, pivot, delta);
    return {
      ...el,
      x: moved.x - el.width / 2,
      y: moved.y - el.height / 2,
      angle: normalizeAngle(el.angle + delta),
    } as MindflowElement;
  });
}

/** Translates elements by a scene-space delta. */
export function translateElements(
  elements: readonly MindflowElement[],
  dx: number,
  dy: number,
): MindflowElement[] {
  if (dx === 0 && dy === 0) return [...elements];
  return elements.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy }) as MindflowElement);
}

/** Local-space direction of an element's x axis, used when nudging with arrow keys. */
export function elementAxes(angle: number): { x: Point; y: Point } {
  const radians = degToRad(angle);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: { x: cos, y: sin }, y: { x: -sin, y: cos } };
}
