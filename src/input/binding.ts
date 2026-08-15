/**
 * Connector bindings — arrows that stay attached to shapes.
 *
 * This is the feature that separates a flow-diagramming tool from a drawing
 * program: drag a box and every arrow touching it re-routes, instead of the
 * diagram quietly falling apart.
 *
 * ---------------------------------------------------------------------------
 * Why the algorithms here are part of the published contract
 * ---------------------------------------------------------------------------
 * A saved connector with `"anchor": {"mode": "auto"}` does NOT store where its
 * endpoint actually lands — that position is computed from the target's current
 * geometry. Any tool that wants to render such a file correctly must reproduce
 * this computation exactly. It is therefore specified in `docs/07-rendering.md`,
 * and this module is its reference implementation.
 */

import type {
  Binding,
  ElementId,
  LinearElement,
  MindflowDocument,
  MindflowElement,
  Point,
  PointTuple,
} from '../model/types.ts';
import { capabilitiesOf } from '../model/registry.ts';
import {
  elementCenter,
  elementWorldAABB,
  expandAABB,
  localToWorld,
  normalizePathBounds,
  pointInAABB,
  rayIntersectElementOutline,
  worldToLocal,
} from '../model/geometry.ts';

/**
 * How close a connector endpoint must come to a shape to bind to it, in scene
 * units. Generous on purpose: binding is the desired outcome far more often than
 * not, and an unwanted binding is trivially undone by dragging the end away.
 */
export const BIND_DISTANCE = 12;

/** Default clearance between a shape's outline and a connector tip. */
export const DEFAULT_BIND_GAP = 4;

/**
 * The shape a connector endpoint at `world` should bind to, or null.
 *
 * Searches topmost-first so that dropping an arrow on overlapping shapes binds
 * to the one visually on top. Connectors themselves are excluded via the
 * `bindable` capability — binding arrows to arrows would create chains with no
 * stable layout solution.
 */
export function findBindTarget(
  document: MindflowDocument,
  world: Point,
  excludeIds: ReadonlySet<ElementId>,
): MindflowElement | null {
  for (let i = document.elements.length - 1; i >= 0; i--) {
    const element = document.elements[i];
    if (!element || !element.visible || element.locked) continue;
    if (excludeIds.has(element.id)) continue;
    if (!capabilitiesOf(element).bindable) continue;

    if (pointInAABB(expandAABB(elementWorldAABB(element), BIND_DISTANCE), world)) return element;
  }
  return null;
}

/**
 * Creates a binding from a drop position.
 *
 * Dropping inside a shape produces an `auto` anchor, which tracks the other end
 * and always attaches to the nearest edge — the behaviour people expect by
 * default. Dropping precisely on the outline produces a `fixed` anchor pinned to
 * that spot, for when a specific attachment point matters.
 */
export function createBinding(target: MindflowElement, world: Point): Binding {
  const local = worldToLocal(target, world);
  const u = target.width === 0 ? 0.5 : local.x / target.width;
  const v = target.height === 0 ? 0.5 : local.y / target.height;

  // Comfortably inside → auto. Near or beyond the outline → pin it.
  const inside = u > 0.15 && u < 0.85 && v > 0.15 && v < 0.85;

  return {
    elementId: target.id,
    anchor: inside
      ? { mode: 'auto' }
      : { mode: 'fixed', u: Math.min(Math.max(u, 0), 1), v: Math.min(Math.max(v, 0), 1) },
    gap: DEFAULT_BIND_GAP,
  };
}

/**
 * Resolves a binding to a world-space point.
 *
 * THE ALGORITHM — mirrored in `docs/07-rendering.md`:
 *
 *   FIXED anchor
 *     1. Take the local point (u × width, v × height) on the target's unrotated
 *        box.
 *     2. Transform it to world space through the target's rotation.
 *     3. Push it `gap` units further along the direction away from the target's
 *        centre.
 *
 *   AUTO anchor
 *     1. Cast a ray from the target's centre toward `reference` (the connector's
 *        other end).
 *     2. Take where that ray crosses the target's outline — an exact solve for
 *        ellipses, an edge-intersection for every other shape. See
 *        `rayIntersectElementOutline` in `model/geometry.ts`.
 *     3. Push the result `gap` units further along the same ray.
 *
 * The gap is applied identically in both cases, which is why an arrow never
 * touches the shape it points at.
 */
export function resolveBindingPoint(
  target: MindflowElement,
  binding: Binding,
  reference: Point,
): Point {
  const center = elementCenter(target);

  let attachment: Point;
  if (binding.anchor.mode === 'fixed') {
    attachment = localToWorld(target, {
      x: binding.anchor.u * target.width,
      y: binding.anchor.v * target.height,
    });
  } else {
    attachment = rayIntersectElementOutline(target, reference);
  }

  if (binding.gap <= 0) return attachment;

  // Direction to push the tip outward. For a fixed anchor that is away from the
  // centre; for an auto anchor it is the ray direction, which is the same thing.
  const dx = attachment.x - center.x;
  const dy = attachment.y - center.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return attachment;

  return {
    x: attachment.x + (dx / length) * binding.gap,
    y: attachment.y + (dy / length) * binding.gap,
  };
}

/**
 * Recomputes a connector's endpoints from its bindings.
 *
 * Returns the same object when nothing moved, so callers can cheaply skip
 * emitting a no-op command.
 *
 * The reference point for an auto anchor is the OTHER end of the connector. When
 * both ends are bound, each uses the other target's centre — resolving them
 * against each other would be a mutual dependency with no closed-form solution,
 * and iterating to a fixed point is not worth the complexity for the pixel or
 * two of difference it would make.
 */
export function refreshConnector(
  document: MindflowDocument,
  connector: LinearElement,
): LinearElement {
  if (!connector.startBinding && !connector.endBinding) return connector;

  const byId = new Map(document.elements.map((el) => [el.id, el]));
  const startTarget = connector.startBinding ? byId.get(connector.startBinding.elementId) : undefined;
  const endTarget = connector.endBinding ? byId.get(connector.endBinding.elementId) : undefined;

  const points = connector.points;
  const firstTuple = points[0];
  const lastTuple = points[points.length - 1];
  if (!firstTuple || !lastTuple) return connector;

  const currentStart = localToWorld(connector, { x: firstTuple[0], y: firstTuple[1] });
  const currentEnd = localToWorld(connector, { x: lastTuple[0], y: lastTuple[1] });

  // Reference points: a bound end aims at the other target's centre, an unbound
  // end aims at wherever it currently sits.
  const startReference = endTarget ? elementCenter(endTarget) : currentEnd;
  const endReference = startTarget ? elementCenter(startTarget) : currentStart;

  let nextStart = currentStart;
  let nextEnd = currentEnd;

  if (connector.startBinding && startTarget) {
    nextStart = resolveBindingPoint(startTarget, connector.startBinding, startReference);
  }
  if (connector.endBinding && endTarget) {
    nextEnd = resolveBindingPoint(endTarget, connector.endBinding, endReference);
  }

  const startMoved = !samePoint(nextStart, currentStart);
  const endMoved = !samePoint(nextEnd, currentEnd);
  if (!startMoved && !endMoved) return connector;

  const nextPoints: PointTuple[] = [...points];
  if (startMoved) {
    const local = worldToLocal(connector, nextStart);
    nextPoints[0] = [local.x, local.y];
  }
  if (endMoved) {
    const local = worldToLocal(connector, nextEnd);
    nextPoints[nextPoints.length - 1] = [local.x, local.y];
  }

  // The endpoints just moved, so the element's box no longer wraps its points.
  // Re-deriving it here is what keeps the "width and height describe the real
  // extent" invariant true after every re-route.
  return normalizePathBounds({ ...connector, points: nextPoints });
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}

/**
 * Every connector that needs re-routing because one of `movedIds` moved.
 *
 * Called after any geometry change. Returns only connectors whose endpoints
 * actually shifted, so a move that does not disturb a binding produces no patch.
 */
export function connectorsToRefresh(
  document: MindflowDocument,
  movedIds: ReadonlySet<ElementId>,
): LinearElement[] {
  const updated: LinearElement[] = [];

  for (const element of document.elements) {
    if (element.type !== 'line' && element.type !== 'arrow') continue;
    // A connector being dragged itself is handled by the drag, not here.
    if (movedIds.has(element.id)) continue;

    const touchesStart = element.startBinding && movedIds.has(element.startBinding.elementId);
    const touchesEnd = element.endBinding && movedIds.has(element.endBinding.elementId);
    if (!touchesStart && !touchesEnd) continue;

    const refreshed = refreshConnector(document, element);
    if (refreshed !== element) updated.push(refreshed);
  }

  return updated;
}

/** All connectors bound to any of the given elements, for highlighting. */
export function connectorsBoundTo(
  document: MindflowDocument,
  ids: ReadonlySet<ElementId>,
): LinearElement[] {
  return document.elements.filter(
    (el): el is LinearElement =>
      (el.type === 'line' || el.type === 'arrow') &&
      Boolean(
        (el.startBinding && ids.has(el.startBinding.elementId)) ||
          (el.endBinding && ids.has(el.endBinding.elementId)),
      ),
  );
}
