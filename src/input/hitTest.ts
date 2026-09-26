/**
 * Element picking.
 *
 * Two operations: find the topmost element under a point (clicking), and find
 * every element within a rectangle (marquee). A third, narrower one finds the
 * frame a double-click renames, because a frame's name is drawn where neither
 * of the first two looks.
 */

import type {
  AABB,
  ElementId,
  FrameElement,
  MindflowDocument,
  MindflowElement,
  Point,
} from '../model/types.ts';
import { hitTestElement, isFrame } from '../model/registry.ts';
import { frameNameBox } from '../render/shapes/frame.ts';
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

/**
 * Click tolerance for a finger, in SCREEN pixels.
 *
 * 8px is tuned for a cursor whose hot spot is one pixel. A fingertip covers
 * something closer to 40px and the user cannot see what is under it, so the same
 * tolerance makes a thin shape feel like it is dodging the tap. Larger than this
 * and a tap starts claiming elements it is visibly nowhere near.
 */
export const TOUCH_HIT_TOLERANCE_PX = 16;

export function toleranceFor(zoom: number, tolerancePx: number = HIT_TOLERANCE_PX): number {
  return tolerancePx / zoom;
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
  options: { includeLocked?: boolean; tolerancePx?: number } = {},
): MindflowElement | null {
  const tolerance = toleranceFor(zoom, options.tolerancePx);

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
  tolerancePx?: number,
): MindflowElement[] {
  const tolerance = toleranceFor(zoom, tolerancePx);
  const hits: MindflowElement[] = [];

  for (let i = document.elements.length - 1; i >= 0; i--) {
    const element = document.elements[i];
    if (!element || !element.visible || element.locked) continue;
    const local = worldToLocal(element, world);
    if (hitTestElement(element, local, tolerance)) hits.push(element);
  }
  return hits;
}

/**
 * The topmost frame whose name tab is under `world`, or null.
 *
 * The tab is drawn above the frame's box, so `elementAt` never reports it, and
 * on purpose: making it part of `hitTest` would put the hit region outside the
 * bounds that culling and every AABB pre-rejection rely on. It is picked here
 * instead, against {@link frameNameBox}, and only the double-click path asks.
 *
 * The same rules as `elementAt` otherwise: back to front, the screen-relative
 * tolerance around the text, and locked or hidden frames skipped. A frame with
 * an empty name draws no tab and so has none to find.
 */
export function frameNameAt(
  document: MindflowDocument,
  world: Point,
  zoom: number,
  options: { tolerancePx?: number } = {},
): FrameElement | null {
  const tolerance = toleranceFor(zoom, options.tolerancePx);

  for (let i = document.elements.length - 1; i >= 0; i--) {
    const element = document.elements[i];
    if (!element || !element.visible || element.locked || !isFrame(element)) continue;
    if (element.name === '') continue;

    const box = frameNameBox(element);
    const local = worldToLocal(element, world);
    if (
      local.x >= box.x - tolerance &&
      local.x <= box.x + box.width + tolerance &&
      local.y >= box.y - tolerance &&
      local.y <= box.y + box.height + tolerance
    ) {
      return element;
    }
  }
  return null;
}

/**
 * The frame a double-click at `world` renames, or null when it should edit
 * something else (or nothing).
 *
 * Two ways to point at a frame's name. One is the name tab itself. The other
 * is the frame's border, which is the only way to name a frame whose name is
 * empty, since that frame draws no tab.
 *
 * When the tab and an element are both under the pointer, the one painted
 * later is on top and wins. The exception is one of the frame's own members.
 * Hit-testing ignores clipping, but a member is clipped to the frame's box and
 * the tab is outside it, so the member cannot be what the user sees there.
 */
export function frameToRename(
  document: MindflowDocument,
  world: Point,
  zoom: number,
  options: { tolerancePx?: number } = {},
): FrameElement | null {
  const hit = elementAt(document, world, zoom, options);
  const named = frameNameAt(document, world, zoom, options);

  if (named) {
    const covered =
      hit !== null &&
      hit.id !== named.id &&
      hit.frameId !== named.id &&
      document.elements.indexOf(hit) > document.elements.indexOf(named);
    if (!covered) return named;
  }
  return hit && isFrame(hit) ? hit : null;
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
