/**
 * Geometry primitives shared by the renderer, the hit-tester and the tools.
 *
 * Everything here is pure: no DOM, no canvas, no state. That is what makes this
 * module directly unit-testable, and it is where the trickiest correctness bugs
 * in a canvas app live, so it earns the tests.
 *
 * The single most important concept in this file is the distinction between an
 * element's LOCAL frame and the WORLD (scene) frame:
 *
 *   LOCAL  Axis-aligned, origin at the element's top-left (`x`, `y`), rotation
 *          not yet applied. All stored geometry (`width`, `height`, `points`)
 *          lives here, which is why moving an element never rewrites its points.
 *
 *   WORLD  The scene. Obtained by rotating the local frame by `angle` degrees
 *          clockwise about the element's centre.
 *
 * Hit-testing works by pulling the pointer back into local space rather than
 * pushing the shape forward into world space — one inverse rotation instead of
 * transforming every vertex, and every shape then only needs simple
 * axis-aligned math. See {@link worldToLocal}.
 */

import type { AABB, MindflowElement, PathElement, Point, PointTuple, Viewport } from './types.ts';
// Value import, and deliberately one-way: the registry imports only types, so
// this does not form a cycle. It is what lets outline resolution be per-shape
// without this module knowing which shapes exist.
import { findDefinition } from './registry.ts';

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;

export function degToRad(degrees: number): number {
  return degrees * DEG_TO_RAD;
}

export function radToDeg(radians: number): number {
  return radians * RAD_TO_DEG;
}

/** Wraps any angle into the canonical [0, 360) range used throughout the format. */
export function normalizeAngle(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

// ---------------------------------------------------------------------------
// Scalars and points
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Rounds to a fixed number of decimals to keep serialised output stable.
 *
 * Without this, floating-point drift turns a no-op round trip into a noisy diff:
 * dragging a shape one pixel and back can leave `x: 100.00000000000001`. Two
 * decimals is far finer than any display can resolve at sane zoom levels, and it
 * makes save files byte-comparable, which is what the round-trip test relies on.
 */
export function roundCoord(value: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function point(x: number, y: number): Point {
  return { x, y };
}

export function pointFromTuple(tuple: PointTuple): Point {
  return { x: tuple[0], y: tuple[1] };
}

export function pressureOf(tuple: PointTuple): number {
  return tuple.length > 2 ? (tuple[2] as number) : 0.5;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function distanceSquared(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return dx * dx + dy * dy;
}

/** Rotates `p` about `origin` by `degrees` clockwise. */
export function rotatePoint(p: Point, origin: Point, degrees: number): Point {
  if (degrees === 0) return { x: p.x, y: p.y };
  const radians = degToRad(degrees);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  // Standard rotation matrix. Because +y points down on a canvas, a positive
  // angle with this matrix reads as clockwise on screen, which is what the
  // format specifies.
  return {
    x: origin.x + dx * cos - dy * sin,
    y: origin.y + dx * sin + dy * cos,
  };
}

// ---------------------------------------------------------------------------
// Element frames
// ---------------------------------------------------------------------------

/** Centre of the element's unrotated box, in world coordinates. Rotation pivot. */
export function elementCenter(el: MindflowElement): Point {
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

/**
 * Converts a point from world space into the element's local, unrotated frame.
 * The returned point is relative to the element's top-left corner.
 */
export function worldToLocal(el: MindflowElement, worldPoint: Point): Point {
  const center = elementCenter(el);
  const unrotated = rotatePoint(worldPoint, center, -el.angle);
  return { x: unrotated.x - el.x, y: unrotated.y - el.y };
}

/** Converts a point from an element's local frame into world space. */
export function localToWorld(el: MindflowElement, localPoint: Point): Point {
  const absolute = { x: el.x + localPoint.x, y: el.y + localPoint.y };
  return rotatePoint(absolute, elementCenter(el), el.angle);
}

/** The four corners of an element's box in world space, clockwise from top-left. */
export function elementCorners(el: MindflowElement): [Point, Point, Point, Point] {
  return [
    localToWorld(el, { x: 0, y: 0 }),
    localToWorld(el, { x: el.width, y: 0 }),
    localToWorld(el, { x: el.width, y: el.height }),
    localToWorld(el, { x: 0, y: el.height }),
  ];
}

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

export function aabbFromPoints(points: readonly Point[]): AABB {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * The element's world-space AABB, accounting for rotation.
 *
 * For a rotated element this is strictly larger than `width` x `height` — it is
 * the box that contains the rotated box. Used for viewport culling and for the
 * bounds of a multi-element selection.
 */
export function elementWorldAABB(el: MindflowElement): AABB {
  if (el.angle === 0) {
    return { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height };
  }
  return aabbFromPoints(elementCorners(el));
}

/** Union of several elements' world AABBs, or `null` for an empty list. */
export function unionAABB(elements: readonly MindflowElement[]): AABB | null {
  if (elements.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const box = elementWorldAABB(el);
    if (box.minX < minX) minX = box.minX;
    if (box.minY < minY) minY = box.minY;
    if (box.maxX > maxX) maxX = box.maxX;
    if (box.maxY > maxY) maxY = box.maxY;
  }
  return { minX, minY, maxX, maxY };
}

export function aabbIntersects(a: AABB, b: AABB): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}

/** True when `inner` lies entirely within `outer`. */
export function aabbContains(outer: AABB, inner: AABB): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  );
}

export function pointInAABB(box: AABB, p: Point): boolean {
  return p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
}

export function expandAABB(box: AABB, amount: number): AABB {
  return {
    minX: box.minX - amount,
    minY: box.minY - amount,
    maxX: box.maxX + amount,
    maxY: box.maxY + amount,
  };
}

export function aabbWidth(box: AABB): number {
  return box.maxX - box.minX;
}

export function aabbHeight(box: AABB): number {
  return box.maxY - box.minY;
}

// ---------------------------------------------------------------------------
// Viewport transforms
// ---------------------------------------------------------------------------

export function sceneToScreen(p: Point, viewport: Viewport): Point {
  return {
    x: (p.x - viewport.x) * viewport.zoom,
    y: (p.y - viewport.y) * viewport.zoom,
  };
}

export function screenToScene(p: Point, viewport: Viewport): Point {
  return {
    x: p.x / viewport.zoom + viewport.x,
    y: p.y / viewport.zoom + viewport.y,
  };
}

/** The region of the scene currently visible in a canvas of the given CSS size. */
export function visibleSceneBounds(viewport: Viewport, screenWidth: number, screenHeight: number): AABB {
  const topLeft = screenToScene({ x: 0, y: 0 }, viewport);
  const bottomRight = screenToScene({ x: screenWidth, y: screenHeight }, viewport);
  return { minX: topLeft.x, minY: topLeft.y, maxX: bottomRight.x, maxY: bottomRight.y };
}

// ---------------------------------------------------------------------------
// Shape intersection helpers
// ---------------------------------------------------------------------------

/**
 * Shortest distance from `p` to the segment `a`–`b`.
 *
 * Projects the point onto the infinite line, clamps the parameter to [0,1] so it
 * stays on the segment, and measures from there. The degenerate zero-length case
 * falls out naturally as the distance to `a`.
 */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest distance from `p` to a polyline. `Infinity` if fewer than two points. */
export function distanceToPolyline(p: Point, points: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const d = distanceToSegment(p, a, b);
    if (d < best) best = d;
  }
  return best;
}

/** True when `p` is inside the ellipse inscribed in the local box `w` x `h`. */
export function pointInEllipse(p: Point, w: number, h: number): boolean {
  if (w <= 0 || h <= 0) return false;
  const rx = w / 2;
  const ry = h / 2;
  const nx = (p.x - rx) / rx;
  const ny = (p.y - ry) / ry;
  return nx * nx + ny * ny <= 1;
}

/** Shortest distance from a local point to the outline of that ellipse. */
export function distanceToEllipseOutline(p: Point, w: number, h: number): number {
  const rx = w / 2;
  const ry = h / 2;
  if (rx <= 0 || ry <= 0) return Infinity;
  const dx = p.x - rx;
  const dy = p.y - ry;
  const angle = Math.atan2(dy / ry, dx / rx);
  // Closest point on the ellipse, approximated by the same parametric angle.
  // Exact only for circles, but well within hit-test tolerance for real shapes.
  const onCurve = { x: rx + rx * Math.cos(angle), y: ry + ry * Math.sin(angle) };
  return distance(p, onCurve);
}

/**
 * Even-odd point-in-polygon test (ray casting).
 *
 * Walks each edge and counts how many cross a horizontal ray extending right
 * from the point; an odd count means inside.
 */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (!a || !b) continue;
    const straddles = a.y > p.y !== b.y > p.y;
    if (straddles && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Where the ray from the centre of `el` toward `target` crosses the element's
 * outline, in world coordinates.
 *
 * This is the core of `mode: "auto"` connector bindings, and it is specified in
 * `docs/07-rendering.md` so that external renderers can reproduce it exactly.
 *
 * The ray is computed in the element's LOCAL frame (so the shape is axis-aligned
 * and the math is closed-form), then the result is rotated back out to world.
 */
export function rayIntersectElementOutline(el: MindflowElement, target: Point): Point {
  const local = worldToLocal(el, target);
  const cx = el.width / 2;
  const cy = el.height / 2;
  const dx = local.x - cx;
  const dy = local.y - cy;

  if (dx === 0 && dy === 0) return elementCenter(el);

  // A shape that knows its own outline says so through the registry; everything
  // else is treated as its bounding rectangle. That default is why most types
  // implement nothing, and why this function no longer branches on `el.type` —
  // which no code outside `render/shapes/` is allowed to do.
  const direction = { x: dx, y: dy };
  const definition = findDefinition(el.type);
  const crossing = definition?.outlineIntersect?.(el, direction) ?? rectOutlineIntersect(el, direction);

  return localToWorld(el, crossing);
}

/**
 * The rectangular-outline case, and the default for any type that does not
 * implement `outlineIntersect`.
 *
 * The ray exits through whichever pair of edges it reaches first, which is the
 * smaller of the two axis-wise scale factors.
 */
export function rectOutlineIntersect(
  el: { width: number; height: number },
  direction: Point,
): Point {
  const cx = el.width / 2;
  const cy = el.height / 2;
  const tx = direction.x === 0 ? Infinity : Math.abs(cx / direction.x);
  const ty = direction.y === 0 ? Infinity : Math.abs(cy / direction.y);
  const t = Math.min(tx, ty);
  return { x: cx + direction.x * t, y: cy + direction.y * t };
}

// ---------------------------------------------------------------------------
// Path elements
// ---------------------------------------------------------------------------

/** A path element's points converted from element-relative tuples to world points. */
export function pathWorldPoints(el: PathElement): Point[] {
  return el.points.map((tuple) => localToWorld(el, { x: tuple[0], y: tuple[1] }));
}

/**
 * Recomputes `x`/`y`/`width`/`height` so the box tightly wraps the points, and
 * rebases the points to stay visually put.
 *
 * Path editing constantly invalidates the box — dragging a vertex, adding a
 * point, or re-routing a bound connector all change the extent. Centralising the
 * fix-up here is what keeps the "width and height are always positive and always
 * describe the real extent" invariant true across the whole app.
 */
export function normalizePathBounds<T extends PathElement>(el: T): T {
  if (el.points.length === 0) return el;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of el.points) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }

  // A perfectly horizontal or vertical line has zero extent on one axis. The
  // format requires positive dimensions, so we floor at 1 scene unit rather than
  // letting a zero propagate into divisions elsewhere.
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);

  const shifted: PointTuple[] = el.points.map((p) =>
    p.length > 2
      ? ([roundCoord(p[0] - minX), roundCoord(p[1] - minY), p[2]] as PointTuple)
      : ([roundCoord(p[0] - minX), roundCoord(p[1] - minY)] as PointTuple),
  );

  return {
    ...el,
    x: roundCoord(el.x + minX),
    y: roundCoord(el.y + minY),
    width: roundCoord(width),
    height: roundCoord(height),
    points: shifted,
  };
}

/**
 * Douglas–Peucker simplification, used to thin freehand strokes.
 *
 * A pointer emits events far faster than the resulting curve needs points —
 * a two-second stroke can produce hundreds. Simplifying keeps files small and
 * rendering fast while staying visually identical within `tolerance`.
 */
export function simplifyPoints(points: readonly PointTuple[], tolerance = 0.8): PointTuple[] {
  if (points.length <= 2) return [...points];

  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return [...points];

  let maxDistance = 0;
  let index = 0;
  const a = { x: first[0], y: first[1] };
  const b = { x: last[0], y: last[1] };

  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    if (!p) continue;
    const d = distanceToSegment({ x: p[0], y: p[1] }, a, b);
    if (d > maxDistance) {
      maxDistance = d;
      index = i;
    }
  }

  // Far enough off the chord to matter: keep that point and recurse on both
  // halves. Otherwise the whole run collapses to its endpoints.
  if (maxDistance > tolerance) {
    const left = simplifyPoints(points.slice(0, index + 1), tolerance);
    const right = simplifyPoints(points.slice(index), tolerance);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}
