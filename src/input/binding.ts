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
 * A saved connector with an `auto` or `focus` anchor does NOT store where its
 * endpoint actually lands — that position is computed from the target's current
 * geometry. Any tool that wants to render such a file correctly must reproduce
 * this computation exactly. It is therefore specified in `docs/07-rendering.md`,
 * and this module is its reference implementation.
 */

import type {
  Binding,
  BindingAnchor,
  ElementId,
  LinearElement,
  MindflowDocument,
  MindflowElement,
  Point,
  PointTuple,
} from '../model/types.ts';
import { capabilitiesOf, isConnector } from '../model/registry.ts';
import {
  elementCenter,
  elementWorldAABB,
  expandAABB,
  localToWorld,
  normalizePathBounds,
  outlineCrossing,
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
 * Normalised distance from the centre, per axis, within which a drop aims at the
 * exact centre (`auto`) rather than being remembered as a `focus` point.
 *
 * Without it a drop a few pixels off-centre is kept faithfully, and an arrow
 * meant to be radial comes out visibly skewed once its shapes move. Normalised
 * rather than in scene units for the same reason as the outline band below: it
 * scales with the shape, so it is equally easy to hit on a small sticky and a
 * large frame.
 */
export const CENTRE_SNAP = 0.1;

/**
 * Normalised width of the band along the box edge where a drop pins a `fixed`
 * anchor. Inside it, and outside the centre zone, a drop becomes a `focus`.
 */
const OUTLINE_BAND = 0.15;

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
 * Three zones, from the middle outwards:
 *
 *   - **Near the centre** → `auto`. The connector aims through the exact centre,
 *     which is what someone dragging from the middle of a box means.
 *   - **Elsewhere inside** → `focus`, remembering the drop point. The tip lands
 *     where the line the user drew crosses the outline, and keeps aiming at
 *     that point as the shapes move — the connector respects where it was
 *     placed, instead of every drop inside a shape collapsing to one spot.
 *   - **Near or beyond the outline** → `fixed`, pinned to that exact spot, for
 *     when a specific attachment point matters.
 */
export function createBinding(target: MindflowElement, world: Point): Binding {
  const local = worldToLocal(target, world);
  const u = target.width === 0 ? 0.5 : local.x / target.width;
  const v = target.height === 0 ? 0.5 : local.y / target.height;
  return { elementId: target.id, anchor: anchorForDrop(u, v), gap: DEFAULT_BIND_GAP };
}

/**
 * The bindings for a connector drawn from `start` to `end`, both in world space.
 *
 * Each end binds to whatever shape it lands on, as {@link createBinding}
 * decides, with one exception. When both ends land on the SAME shape, only a
 * `fixed` end binds. An `auto` or `focus` end aims through its shape at the
 * other end, and that makes no sense when the other end is inside the same
 * shape. Two focus ends would each shoot out past the opposite edge, so the
 * arrow comes out reversed. Two auto ends (the only option before 1.6.0) both
 * aimed at the centre, so the arrow collapsed there. Leaving such an end free
 * keeps the arrow exactly as drawn, which is what an arrow sketched inside a
 * frame wants. Pinned ends aim at nothing, so an edge-to-edge loop still binds.
 */
export function bindConnectorEnds(
  document: MindflowDocument,
  start: Point,
  end: Point,
  excludeIds: ReadonlySet<ElementId>,
): { startBinding: Binding | null; endBinding: Binding | null } {
  const startTarget = findBindTarget(document, start, excludeIds);
  const endTarget = findBindTarget(document, end, excludeIds);
  const startBinding = startTarget ? createBinding(startTarget, start) : null;
  const endBinding = endTarget ? createBinding(endTarget, end) : null;

  if (!startTarget || startTarget !== endTarget) return { startBinding, endBinding };
  const pinnedOnly = (binding: Binding | null) => (binding?.anchor.mode === 'fixed' ? binding : null);
  return { startBinding: pinnedOnly(startBinding), endBinding: pinnedOnly(endBinding) };
}

/** The anchor a drop at normalised `(u, v)` on the target's box produces. */
function anchorForDrop(u: number, v: number): BindingAnchor {
  const inside =
    u > OUTLINE_BAND && u < 1 - OUTLINE_BAND && v > OUTLINE_BAND && v < 1 - OUTLINE_BAND;
  if (!inside) return { mode: 'fixed', u: clampUnit(u), v: clampUnit(v) };

  const nearCentre = Math.abs(u - 0.5) <= CENTRE_SNAP && Math.abs(v - 0.5) <= CENTRE_SNAP;
  return nearCentre ? { mode: 'auto' } : { mode: 'focus', u, v };
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

/**
 * The world point an anchor aims at: the target's centre for `auto`, and the
 * stored `(u, v)` spot for `focus` and `fixed`.
 *
 * This is what the OTHER end of a connector aims at when both ends are bound —
 * see {@link refreshConnector}. It depends only on the target and the stored
 * anchor, never on where either tip currently is, which is what keeps the
 * two-ended case closed-form.
 */
export function anchorAimPoint(target: MindflowElement, anchor: BindingAnchor): Point {
  if (anchor.mode === 'auto') return elementCenter(target);
  return localToWorld(target, { x: anchor.u * target.width, y: anchor.v * target.height });
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
 *   FOCUS anchor
 *     As AUTO, but the ray starts at the focus point (u × width, v × height)
 *     instead of the centre, and the attachment is its LAST crossing of the
 *     outline. If the ray has no crossing — a focus point outside the outline
 *     with the ray pointing away — or the reference coincides with the focus
 *     point, resolve as AUTO instead.
 *
 * The gap always pushes along the direction the tip is travelling away from the
 * shape, which is why an arrow never touches the shape it points at.
 */
export function resolveBindingPoint(
  target: MindflowElement,
  binding: Binding,
  reference: Point,
): Point {
  const { anchor } = binding;

  if (anchor.mode === 'focus') {
    const focus = { x: anchor.u * target.width, y: anchor.v * target.height };
    const attachment = outlineCrossing(target, focus, reference);
    // The ray leaves the focus point heading for the reference, so that is the
    // direction to push. The attachment minus the centre would NOT do: from an
    // off-centre focus it points somewhere else, and the tip would slide
    // sideways along the outline instead of backing away from it.
    if (attachment) return pushAway(attachment, localToWorld(target, focus), binding.gap);
  }

  const attachment =
    anchor.mode === 'fixed'
      ? localToWorld(target, { x: anchor.u * target.width, y: anchor.v * target.height })
      : rayIntersectElementOutline(target, reference);

  // For a fixed anchor the push is away from the centre. For an auto anchor it
  // is the ray direction, which from the centre is the same thing.
  return pushAway(attachment, elementCenter(target), binding.gap);
}

/**
 * Moves `point` `gap` units further along the direction from `from` through it.
 * Skipped when the two coincide, since there is then no direction to follow.
 */
function pushAway(point: Point, from: Point, gap: number): Point {
  if (gap <= 0) return point;
  const dx = point.x - from.x;
  const dy = point.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  return { x: point.x + (dx / length) * gap, y: point.y + (dy / length) * gap };
}

/**
 * Recomputes a connector's endpoints from its bindings.
 *
 * Returns the same object when nothing moved, so callers can cheaply skip
 * emitting a no-op command.
 *
 * The reference point for an auto or focus anchor is the OTHER end of the
 * connector. When both ends are bound, each aims at the other end's
 * {@link anchorAimPoint} rather than at its resolved tip — resolving the tips
 * against each other would be a mutual dependency with no closed-form solution,
 * and iterating to a fixed point is not worth the complexity for the pixel or
 * two of difference it would make.
 *
 * Aiming at the other end's anchor point, rather than always at its target's
 * centre (the rule until 1.6.0), is what keeps a connector on the line it was
 * drawn along: a drop remembered at some spot on the far shape is a spot this
 * end should point at too.
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

  // Reference points: toward a bound end, aim at its anchor; toward an unbound
  // end, at wherever it currently sits.
  const startReference =
    connector.endBinding && endTarget ? anchorAimPoint(endTarget, connector.endBinding.anchor) : currentEnd;
  const endReference =
    connector.startBinding && startTarget
      ? anchorAimPoint(startTarget, connector.startBinding.anchor)
      : currentStart;

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
    if (!isConnector(element)) continue;
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

/**
 * `ids` plus every connector bound to any of them — the set a move must keep
 * object snapping away from.
 *
 * A bound connector is not a stable neighbour while its target moves: it is
 * re-routed from the target's new position on every frame. Snapping the target
 * to it therefore feeds each frame's result into the next. The target runs ahead
 * of the pointer until the snap radius is exceeded, then lurches back, which on
 * screen is a shape vibrating as it is dragged.
 *
 * Every bound connector is excluded, not only those whose box happens to sit
 * near the target: whichever end is bound, its geometry depends on the drag.
 */
export function withBoundConnectors(
  document: MindflowDocument,
  ids: ReadonlySet<ElementId>,
): Set<ElementId> {
  const result = new Set(ids);
  for (const connector of connectorsBoundTo(document, ids)) result.add(connector.id);
  return result;
}

/** All connectors bound to any of the given elements, for highlighting. */
export function connectorsBoundTo(
  document: MindflowDocument,
  ids: ReadonlySet<ElementId>,
): LinearElement[] {
  return document.elements.filter(
    (el): el is LinearElement =>
      isConnector(el) &&
      Boolean(
        (el.startBinding && ids.has(el.startBinding.elementId)) ||
          (el.endBinding && ids.has(el.endBinding.elementId)),
      ),
  );
}
