/**
 * Element picking.
 *
 * Two operations: find the topmost element under a point (clicking), and find
 * every element within a rectangle (marquee).
 */

import type { AABB, ElementId, MindflowDocument, MindflowElement, Point } from '../model/types.ts';
import { hitTestElement } from '../model/registry.ts';
import {
  aabbContains,
  aabbIntersects,
  elementWorldAABB,
  expandAABB,
  worldToLocal,
} from '../model/geometry.ts';

/**
 * Base click tolerance in SCREEN pixels.
 *
 * Divided by zoom to become a scene-space tolerance, which is what keeps a
 * hairline just as easy to click at 10% zoom as at 400%. Expressing tolerance in
 * scene units instead would make thin shapes nearly unclickable when zoomed out.
 */
export const HIT_TOLERANCE_PX = 8;

export function toleranceFor(zoom: number): number {
  return HIT_TOLERANCE_PX / zoom;
}

/**
 * The topmost element at `world`, or null.
 *
 * Iterates back to front because `elements` is sorted ascending by `zIndex` and
 * the visually topmost element is the last one painted — the first hit walking
 * backwards is the one the user believes they clicked.
 *
 * Locked and hidden elements are skipped: a locked element is scenery, and
 * clicking it should reach whatever is behind.
 */
export function elementAt(
  document: MindflowDocument,
  world: Point,
  zoom: number,
  options: { includeLocked?: boolean } = {},
): MindflowElement | null {
  const tolerance = toleranceFor(zoom);

  for (let i = document.elements.length - 1; i >= 0; i--) {
    const element = document.elements[i];
    if (!element) continue;
    if (!element.visible) continue;
    if (element.locked && !options.includeLocked) continue;

    // Cheap AABB rejection before the expensive per-shape test. On a large board
    // this skips almost everything.
    if (!aabbIntersects(expandAABB(elementWorldAABB(element), tolerance), {
      minX: world.x,
      minY: world.y,
      maxX: world.x,
      maxY: world.y,
    })) {
      continue;
    }

    // Pull the pointer into the element's local frame; the shape module then
    // only deals with an axis-aligned box. See `geometry.ts`.
    const local = worldToLocal(element, world);
    if (hitTestElement(element, local, tolerance)) return element;
  }

  return null;
}

/** All elements under a point, topmost first. Used for alt-click "pick through". */
export function elementsAt(
  document: MindflowDocument,
  world: Point,
  zoom: number,
): MindflowElement[] {
  const tolerance = toleranceFor(zoom);
  const hits: MindflowElement[] = [];

  for (let i = document.elements.length - 1; i >= 0; i--) {
    const element = document.elements[i];
    if (!element || !element.visible || element.locked) continue;
    const local = worldToLocal(element, world);
    if (hitTestElement(element, local, tolerance)) hits.push(element);
  }
  return hits;
}

export type MarqueeMode = 'contain' | 'intersect';

/**
 * Elements selected by a rubber-band rectangle.
 *
 * `contain` (the default) requires the element to sit entirely inside the box,
 * which is what makes dragging across a dense board feel precise. `intersect`
 * takes anything the box touches.
 */
export function elementsInBox(
  document: MindflowDocument,
  box: AABB,
  mode: MarqueeMode = 'contain',
): MindflowElement[] {
  return document.elements.filter((element) => {
    if (!element.visible || element.locked) return false;
    const bounds = elementWorldAABB(element);
    return mode === 'contain' ? aabbContains(box, bounds) : aabbIntersects(box, bounds);
  });
}

/** Normalises a drag between two corners into a positive-extent box. */
export function boxFromPoints(a: Point, b: Point): AABB {
  return {
    minX: Math.min(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxX: Math.max(a.x, b.x),
    maxY: Math.max(a.y, b.y),
  };
}

export function elementsByIds(
  document: MindflowDocument,
  ids: Iterable<ElementId>,
): MindflowElement[] {
  const wanted = new Set(ids);
  return document.elements.filter((element) => wanted.has(element.id));
}
