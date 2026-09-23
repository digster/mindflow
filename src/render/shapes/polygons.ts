/**
 * Flat polygons: triangle, pentagon, hexagon, star and parallelogram.
 *
 * One module for five types rather than five near-identical files, on the same
 * reasoning that puts `line` and `arrow` together in `linear.ts`: they differ
 * only in a list of vertices. Everything else — how a filled shape is hit, how a
 * connector finds the outline, how the hand-drawn form is produced — is one
 * implementation shared by all of them, so there is one place to fix rather than
 * five places to keep in step.
 *
 * Every vertex is expressed as a FRACTION of the box, then multiplied by
 * `width`/`height`. Two things follow:
 *
 *   1. The box is the entire geometry, so resizing one of these is the ordinary
 *      base-geometry change every type gets and nothing type-specific runs.
 *   2. The polygon's bounding box is exactly the element's box, because the
 *      generated vertices are normalised to fill the unit square (see
 *      {@link fitToUnitBox}). A pentagon therefore fills the space you drag out,
 *      instead of floating inside it the way its circumscribed circle would.
 *
 * Regularity is deliberately NOT preserved. A pentagon in a 300x80 box is wide
 * and flat, exactly as an ellipse would be. Keeping angles regular would mean
 * either ignoring one dimension or refusing a free resize, and both make the
 * stored `width`/`height` a lie.
 *
 * The resulting fractions are published in `docs/03-elements.md`, so a reader
 * with only the file can reproduce the outline without re-deriving them.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type {
  BaseElement,
  HexagonElement,
  MindflowElement,
  ParallelogramElement,
  PentagonElement,
  Point,
  StarElement,
  TriangleElement,
} from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import {
  distanceToPolyline,
  pointInPolygon,
  polygonOutlineIntersect,
} from '../../model/geometry.ts';
import { drawLabel, hasFill, paintPath, tracePoints } from './shared.ts';
import { roughOutlineFor } from '../rough.ts';

/** The five types this module registers. */
export type PolygonType = 'triangle' | 'pentagon' | 'hexagon' | 'star' | 'parallelogram';

type PolygonElement =
  | TriangleElement
  | PentagonElement
  | HexagonElement
  | StarElement
  | ParallelogramElement;

/**
 * How far a star's inner vertices sit from the centre, as a fraction of the
 * outer radius. `1/phi^2`, the ratio a regular pentagram produces — anything
 * larger reads as a cog and anything smaller as a splat.
 */
export const STAR_INNER_RATIO = 0.382;

/** How far a parallelogram leans, as a fraction of its width. */
export const PARALLELOGRAM_SLANT = 0.25;

/**
 * Scales and translates a point set so its bounding box is exactly the unit
 * square. This is what makes a generated polygon fill its element box.
 */
function fitToUnitBox(points: Point[]): Point[] {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX;
  const spanY = Math.max(...ys) - minY;
  return points.map((p) => ({
    x: spanX === 0 ? 0.5 : (p.x - minX) / spanX,
    y: spanY === 0 ? 0.5 : (p.y - minY) / spanY,
  }));
}

/**
 * `count` vertices spaced evenly around a circle, starting at the top and
 * running clockwise, alternating between the outer radius and `innerRatio` when
 * one is given (which is what turns a pentagon into a five-pointed star).
 */
function radialVertices(count: number, innerRatio?: number): Point[] {
  const steps = innerRatio === undefined ? count : count * 2;
  const points: Point[] = [];
  for (let i = 0; i < steps; i += 1) {
    // -90 degrees puts the first vertex at the top; +y is down, so increasing
    // the angle runs clockwise, matching the direction angles turn everywhere
    // else in MindFlow.
    const angle = -Math.PI / 2 + (i / steps) * Math.PI * 2;
    const radius = innerRatio === undefined || i % 2 === 0 ? 1 : innerRatio;
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

/**
 * Vertices as fractions of the box, computed once at module load.
 *
 * Held as a constant rather than recomputed per frame: they never change, and
 * `draw` runs for every visible element of every repaint.
 */
const UNIT_VERTICES: Record<PolygonType, readonly Point[]> = {
  triangle: [
    { x: 0.5, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
  parallelogram: [
    { x: PARALLELOGRAM_SLANT, y: 0 },
    { x: 1, y: 0 },
    { x: 1 - PARALLELOGRAM_SLANT, y: 1 },
    { x: 0, y: 1 },
  ],
  pentagon: fitToUnitBox(radialVertices(5)),
  hexagon: fitToUnitBox(radialVertices(6)),
  star: fitToUnitBox(radialVertices(5, STAR_INNER_RATIO)),
};

/**
 * A polygon's vertices in the element's LOCAL frame.
 *
 * Exported because the SVG exporter is a second, independent renderer: having it
 * import this rather than re-derive the same numbers is the only thing that
 * keeps the two in agreement.
 */
export function polygonVertices(type: PolygonType, width: number, height: number): Point[] {
  return UNIT_VERTICES[type].map((p) => ({ x: p.x * width, y: p.y * height }));
}

/** True for the types this module owns, so callers can narrow safely. */
export function isPolygonType(type: string): type is PolygonType {
  return type in UNIT_VERTICES;
}

function verticesOf(el: MindflowElement): Point[] {
  return polygonVertices(el.type as PolygonType, el.width, el.height);
}

/**
 * Builds one type's definition. The cast on the returned element is the price of
 * sharing a factory across five members of a discriminated union: `type` is a
 * literal parameter here, which TypeScript cannot use to narrow `T` on its own.
 */
function definePolygon<T extends PolygonElement>(
  type: T['type'],
  title: string,
  size: { width: number; height: number },
): ElementDefinition<T> {
  return {
    type,
    title,

    capabilities: {
      label: true,
      path: false,
      text: false,
      resizable: true,
      rotatable: true,
      bindable: true,
      connector: false,
    },

    create(init: ElementInit): T {
      return {
        id: newElementId(),
        type,
        x: init.x,
        y: init.y,
        width: Math.max(init.width ?? size.width, 1),
        height: Math.max(init.height ?? size.height, 1),
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
      } as T;
    },

    normalize(_raw: Record<string, unknown>, base: BaseElement): T {
      return { ...base, type } as T;
    },

    roughOutline(el: T) {
      return verticesOf(el);
    },

    draw(el: T, { ctx }: RenderContext): void {
      tracePoints(ctx, roughOutlineFor(el) ?? verticesOf(el), true);
      paintPath(ctx, el.style);
      drawLabel(ctx, el);
    },

    hitTest(el: T, local: Point, tolerance: number): boolean {
      const points = verticesOf(el);
      // Filled (or labelled) shapes are solid to a click; unfilled ones are hit
      // only near the outline, so a click passes through the hollow middle. The
      // same rule every closed shape follows — see docs/03-elements.md.
      if (hasFill(el.style) || (el.label && el.label.text !== '')) {
        if (pointInPolygon(local, points)) return true;
      }
      // The polyline helper treats its input as open, so the first vertex is
      // repeated to close the outline.
      return distanceToPolyline(local, [...points, points[0]!]) <= tolerance;
    },

    /**
     * Anchors a bound connector to the real outline. Without it an arrow aimed
     * at a triangle's apex would stop at the bounding box, leaving a gap of up
     * to half the box — exactly the case `diamond` implements this hook for.
     */
    outlineIntersect(el: T, direction: Point, origin: Point): Point | null {
      return polygonOutlineIntersect(verticesOf(el), origin, direction);
    },
  };
}

export const triangleDefinition = definePolygon<TriangleElement>('triangle', 'Triangle', {
  width: 120,
  height: 100,
});
export const pentagonDefinition = definePolygon<PentagonElement>('pentagon', 'Pentagon', {
  width: 120,
  height: 110,
});
export const hexagonDefinition = definePolygon<HexagonElement>('hexagon', 'Hexagon', {
  width: 120,
  height: 110,
});
export const starDefinition = definePolygon<StarElement>('star', 'Star', {
  width: 120,
  height: 115,
});
export const parallelogramDefinition = definePolygon<ParallelogramElement>(
  'parallelogram',
  'Parallelogram',
  { width: 140, height: 90 },
);

registerElement(triangleDefinition);
registerElement(pentagonDefinition);
registerElement(hexagonDefinition);
registerElement(starDefinition);
registerElement(parallelogramDefinition);
