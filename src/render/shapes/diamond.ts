/**
 * Diamond element.
 *
 * A rhombus inscribed in the element's box, for flowchart decision nodes. Like
 * the ellipse it carries no fields of its own: the four vertices are the
 * midpoints of the box's edges, so the box is the whole geometry.
 *
 * It implements `outlineIntersect`, which matters more than it looks. Without
 * it a bound connector would stop at the bounding box, leaving a gap of up to
 * half the box's shorter side where the arrow points at a corner — the diamond's
 * whole silhouette is the part a rectangle gets wrong.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, DiamondElement, Point } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { distanceToPolyline, pointInPolygon, polygonOutlineIntersect } from '../../model/geometry.ts';
import { drawLabel, hasFill, paintPath, tracePoints } from './shared.ts';
import { roughOutlineFor } from '../rough.ts';

/** The four vertices, in local coordinates, clockwise from the top. */
function vertices(el: { width: number; height: number }): Point[] {
  const { width: w, height: h } = el;
  return [
    { x: w / 2, y: 0 },
    { x: w, y: h / 2 },
    { x: w / 2, y: h },
    { x: 0, y: h / 2 },
  ];
}

export const diamondDefinition: ElementDefinition<DiamondElement> = {
  type: 'diamond',
  title: 'Diamond',

  capabilities: {
    label: true,
    path: false,
    text: false,
    resizable: true,
    rotatable: true,
    bindable: true,
  },

  create(init: ElementInit): DiamondElement {
    return {
      id: newElementId(),
      type: 'diamond',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? 120, 1),
      height: Math.max(init.height ?? 80, 1),
      angle: 0,
      zIndex: init.zIndex,
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      frameId: null,
      style: { ...DEFAULT_STYLE, ...(init.style as object | undefined) },
      label: null,
      meta: {},
    };
  },

  normalize(_raw: Record<string, unknown>, base: BaseElement): DiamondElement {
    return { ...base, type: 'diamond' };
  },

  roughOutline(el: DiamondElement) {
    return vertices(el);
  },

  draw(el: DiamondElement, { ctx }: RenderContext): void {
    tracePoints(ctx, roughOutlineFor(el) ?? vertices(el), true);
    paintPath(ctx, el.style);
    drawLabel(ctx, el);
  },

  hitTest(el: DiamondElement, local: Point, tolerance: number): boolean {
    const points = vertices(el);
    // Filled (or labelled) shapes are solid to a click; unfilled ones are hit
    // only near the outline, so you can click through the hollow middle. Same
    // rule as every other closed shape — see docs/03-elements.md.
    if (hasFill(el.style) || (el.label && el.label.text !== '')) {
      if (pointInPolygon(local, points)) return true;
    }
    // The polyline helper treats its input as open, so the first vertex is
    // repeated to close the rhombus.
    return distanceToPolyline(local, [...points, points[0]!]) <= tolerance;
  },

  /**
   * Where a ray last crosses one of the four edges.
   *
   * From the centre there is a closed form — substituting `(t·dx, t·dy)` into the
   * rhombus `|x|/a + |y|/b = 1` gives `t = 1 / (|dx|/a + |dy|/b)` — and 1.5.0
   * and earlier used it. A `focus` anchor casts from an arbitrary point, where
   * the absolute values no longer collapse to one case, so the diamond now uses
   * the per-edge solver the flat polygons share. From the centre the two agree
   * to floating-point precision, so no existing `auto` connector moves.
   */
  outlineIntersect(el: DiamondElement, direction: Point, origin: Point): Point | null {
    return polygonOutlineIntersect(vertices(el), origin, direction);
  },
};

registerElement(diamondDefinition);
