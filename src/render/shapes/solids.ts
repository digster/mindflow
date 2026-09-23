/**
 * Solids: cube, cylinder, cone and pyramid.
 *
 * MindFlow draws on a 2D canvas, so these are 2.5D: a fixed oblique projection
 * of a solid, not a camera looking at a model. That choice is what keeps them
 * ordinary elements — a cube resizes, rotates, snaps, groups, binds connectors
 * and round-trips through the file format exactly as a rectangle does, and no
 * code outside this module learns that anything three-dimensional exists.
 *
 * ---------------------------------------------------------------------------
 * The projection
 * ---------------------------------------------------------------------------
 * One number drives every solid:
 *
 *     d = DEPTH_RATIO * min(width, height)
 *
 * and depth runs up and to the right. `d` is COMPUTED, never stored. A stored
 * depth would be a second description of how big the shape is, and would then
 * have to be kept in step with `width`/`height` on every resize — which means a
 * type-specific branch in `input/transform.ts`, the one module forbidden from
 * knowing what a cube is. Computing it makes a solid's geometry a pure function
 * of the box, which is the whole reason these types cost the rest of the app
 * nothing. The algorithm is published in `docs/07-rendering.md`.
 *
 * All visible geometry is INSCRIBED in the box: a cube's front face is inset by
 * `d` and its top face rises to `y = 0`, rather than the front face filling the
 * box and the projection hanging outside it. `x`/`y`/`width`/`height` therefore
 * remain a truthful bounding box, which viewport culling, marquee selection and
 * the AABB pre-rejection in hit-testing all rely on. `frame.ts` documents what
 * happens when that is knowingly broken; nothing here breaks it.
 *
 * ---------------------------------------------------------------------------
 * Faces
 * ---------------------------------------------------------------------------
 * A solid is a list of faces painted back to front, each carrying a TONE rather
 * than a colour: the element still has exactly one `fill`, and the lit and
 * shaded tones are derived from it by {@link shadeColor}. Storing three colours
 * per solid would have meant three colour pickers in the style panel and three
 * fields in the format, for a shape that is conceptually one object in one
 * colour with light falling on it.
 *
 * Curves are sampled to polylines here rather than drawn as arcs, because the
 * SVG exporter is a second, independent renderer: handing both the same points
 * is the only thing that makes them agree. It is the same reasoning that makes
 * `roughOutline` return sampled points.
 *
 * Solids deliberately implement no `roughOutline`. A hand-drawn outline is one
 * closed polygon — `export.ts` collapses a rough element to a single
 * `<polygon>` — which cannot express a cube's three faces without losing the
 * edges between them. They render cleanly whatever `roughness` says, as `frame`,
 * `table` and `image` already do, and the style panel hides the slider for them
 * with no extra code.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type {
  BaseElement,
  ConeElement,
  CubeElement,
  CylinderElement,
  MindflowElement,
  Point,
  PyramidElement,
} from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import {
  distanceToPolyline,
  pointInPolygon,
  polygonOutlineIntersect,
} from '../../model/geometry.ts';
import {
  FACE_SHADE,
  drawLabel,
  hasFill,
  paintFace,
  shadeColor,
  tracePoints,
} from './shared.ts';

/** The four types this module registers. */
export type SolidType = 'cube' | 'cylinder' | 'cone' | 'pyramid';

type SolidElement = CubeElement | CylinderElement | ConeElement | PyramidElement;

/** Depth offset as a fraction of the box's shorter side. */
export const DEPTH_RATIO = 0.25;

/** The projection offset for one element. */
export function depthOf(width: number, height: number): number {
  return DEPTH_RATIO * Math.min(width, height);
}

/** Which derived tone fills a face. */
export type FaceTone = 'base' | 'lit' | 'shaded';

/** One painted face of a solid, in the element's LOCAL frame. */
export interface SolidFace {
  /** Closed outline, curves already sampled. */
  points: Point[];
  tone: FaceTone;
}

/** The colour a tone resolves to for a given fill. */
export function toneColor(fill: string, tone: FaceTone): string {
  if (tone === 'lit') return shadeColor(fill, FACE_SHADE);
  if (tone === 'shaded') return shadeColor(fill, -FACE_SHADE);
  return fill;
}

// ---------------------------------------------------------------------------
// Curve sampling
// ---------------------------------------------------------------------------

/**
 * Points along an elliptical arc, inclusive of both ends.
 *
 * Spacing follows the curve's own size, so a small cylinder does not carry 64
 * vertices and a large one does not look faceted.
 *
 * The segment count is rounded up to a multiple of four, which is not
 * cosmetic: it guarantees a sample lands on the arc's midpoint and, for a full
 * ellipse, on all four quadrant points. Those are exactly the tangent points
 * where a curve touches the element's box, so without this a cylinder's
 * silhouette would fall a fraction of a unit short of its own bounding box —
 * and the box is what culling, marquee selection and snapping all trust.
 */
function arcPoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
): Point[] {
  const sweep = Math.abs(to - from);
  // Ramanujan's approximation, the same one `rough.ts` uses for a full ellipse.
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const spaced = Math.ceil(((sweep / (Math.PI * 2)) * perimeter) / 12);
  const segments = Math.max(4, Math.min(64, Math.ceil(spaced / 4) * 4));

  const points: Point[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = from + ((to - from) * i) / segments;
    points.push({ x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  }
  return points;
}

/** A closed ellipse, as a polygon. */
function ellipseLoop(cx: number, cy: number, rx: number, ry: number): Point[] {
  // The final point would duplicate the first, so it is dropped: every consumer
  // here treats its input as a closed ring.
  return arcPoints(cx, cy, rx, ry, 0, Math.PI * 2).slice(0, -1);
}

// ---------------------------------------------------------------------------
// Per-type geometry
// ---------------------------------------------------------------------------

/**
 * A solid's visible faces, ordered back to front.
 *
 * Exported for the SVG exporter, which consumes these points rather than
 * re-deriving the projection — the `table` precedent, and the only way two
 * renderers stay in agreement.
 */
export function solidFaces(type: SolidType, w: number, h: number): SolidFace[] {
  const d = depthOf(w, h);

  switch (type) {
    case 'cube': {
      // Depth runs up and right, so the top and right faces are visible and the
      // front face is inset by `d` on those two sides.
      return [
        {
          tone: 'lit',
          points: [
            { x: 0, y: d },
            { x: d, y: 0 },
            { x: w, y: 0 },
            { x: w - d, y: d },
          ],
        },
        {
          tone: 'shaded',
          points: [
            { x: w - d, y: d },
            { x: w, y: 0 },
            { x: w, y: h - d },
            { x: w - d, y: h },
          ],
        },
        {
          tone: 'base',
          points: [
            { x: 0, y: d },
            { x: w - d, y: d },
            { x: w - d, y: h },
            { x: 0, y: h },
          ],
        },
      ];
    }

    case 'cylinder': {
      const ry = d / 2;
      const body = [
        { x: 0, y: ry },
        ...arcPoints(w / 2, h - ry, w / 2, ry, Math.PI, 0), // front of the base
        { x: w, y: ry },
        ...arcPoints(w / 2, ry, w / 2, ry, 0, -Math.PI), // back of the top rim
      ];
      return [
        { tone: 'base', points: body },
        { tone: 'lit', points: ellipseLoop(w / 2, ry, w / 2, ry) },
      ];
    }

    case 'cone': {
      const ry = d / 2;
      return [
        {
          tone: 'base',
          points: [
            { x: w / 2, y: 0 },
            { x: w, y: h - ry },
            ...arcPoints(w / 2, h - ry, w / 2, ry, 0, Math.PI), // front of the base
          ],
        },
      ];
    }

    case 'pyramid': {
      const ry = d / 2;
      const apex = { x: w / 2, y: 0 };
      const front = { x: w / 2, y: h };
      // The base is a rhombus in projection; only the two faces meeting at the
      // near corner are visible.
      return [
        { tone: 'base', points: [apex, { x: 0, y: h - ry }, front] },
        { tone: 'shaded', points: [apex, front, { x: w, y: h - ry }] },
      ];
    }
  }
}

/**
 * The solid's outline as a closed polygon — what a click is tested against and
 * where a bound connector attaches.
 *
 * Derived from the same face geometry rather than written a second time, so a
 * change to the projection cannot leave the hit region describing the old shape.
 * For a convex solid the union of the faces IS the silhouette; the outline is
 * recovered by walking the outermost face boundary, which for the flat-faced
 * solids is the convex hull of every face vertex.
 */
export function solidSilhouette(type: SolidType, w: number, h: number): Point[] {
  // A curved solid's first face already runs along its whole outline, exactly;
  // a hull of sampled points would only approximate it from the inside,
  // shrinking the hit region slightly.
  if (type === 'cylinder' || type === 'cone') {
    return solidFaces(type, w, h)[0]!.points;
  }
  return convexHull(solidFaces(type, w, h).flatMap((face) => face.points));
}

/** Andrew's monotone chain. Small inputs — the faces above are at most four points each. */
function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (sorted.length < 3) return sorted;

  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const half = (input: Point[]): Point[] => {
    const out: Point[] = [];
    for (const p of input) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };

  return [...half(sorted), ...half([...sorted].reverse())];
}

/**
 * Where a solid draws its label.
 *
 * On the face the viewer is looking at, not across the whole box: a label
 * centred in a cube's bounding box straddles the projected top and side and
 * reads as floating in front of the shape rather than written on it. Tapering
 * solids get a box inscribed in their lower half, where there is room for it.
 */
export function solidLabelBox(
  type: SolidType,
  w: number,
  h: number,
): { x: number; y: number; width: number; height: number } {
  const d = depthOf(w, h);

  switch (type) {
    case 'cube':
      return { x: 0, y: d, width: Math.max(w - d, 1), height: Math.max(h - d, 1) };
    case 'cylinder':
      return { x: 0, y: d / 2, width: w, height: Math.max(h - d, 1) };
    case 'cone':
    case 'pyramid':
      return { x: w / 4, y: h / 2, width: w / 2, height: Math.max(h / 2 - d / 2, 1) };
  }
}

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

const DEFAULT_SIZES: Record<SolidType, { width: number; height: number }> = {
  cube: { width: 120, height: 110 },
  cylinder: { width: 110, height: 130 },
  cone: { width: 110, height: 130 },
  pyramid: { width: 120, height: 110 },
};

export function isSolidType(type: string): type is SolidType {
  return type in DEFAULT_SIZES;
}

function silhouetteOf(el: MindflowElement): Point[] {
  return solidSilhouette(el.type as SolidType, el.width, el.height);
}

/**
 * Builds one solid's definition. The cast mirrors `polygons.ts`: `type` is a
 * literal parameter, which TypeScript cannot use to narrow `T` by itself.
 */
function defineSolid<T extends SolidElement>(type: T['type'], title: string): ElementDefinition<T> {
  const size = DEFAULT_SIZES[type];

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
      frame: false,
      file: false,
      fillable: true,
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
        // Solids default to a filled look. An unfilled cube is three outlines
        // with nothing to tell the faces apart, which reads as a wireframe
        // rather than an object — so unlike the flat shapes, these start solid.
        style: {
          ...DEFAULT_STYLE,
          fill: '#ffffff',
          fillStyle: 'solid',
          ...(init.style as object | undefined),
        },
        label: null,
        meta: {},
      } as T;
    },

    normalize(_raw: Record<string, unknown>, base: BaseElement): T {
      return { ...base, type } as T;
    },

    labelBox(el: T) {
      return solidLabelBox(type, el.width, el.height);
    },

    draw(el: T, { ctx }: RenderContext): void {
      const fill = hasFill(el.style) ? el.style.fill : null;
      for (const face of solidFaces(type, el.width, el.height)) {
        tracePoints(ctx, face.points, true);
        paintFace(ctx, el.style, fill === null ? null : toneColor(fill, face.tone));
      }
      drawLabel(ctx, el);
    },

    hitTest(el: T, local: Point, tolerance: number): boolean {
      const outline = silhouetteOf(el);
      const solid = hasFill(el.style) || (el.label && el.label.text !== '');

      if (solid && pointInPolygon(local, outline)) return true;

      return distanceToPolyline(local, [...outline, outline[0]!]) <= tolerance;
    },

    outlineIntersect(el: T, direction: Point, origin: Point): Point | null {
      return polygonOutlineIntersect(silhouetteOf(el), origin, direction);
    },
  };
}

export const cubeDefinition = defineSolid<CubeElement>('cube', 'Cube');
export const cylinderDefinition = defineSolid<CylinderElement>('cylinder', 'Cylinder');
export const coneDefinition = defineSolid<ConeElement>('cone', 'Cone');
export const pyramidDefinition = defineSolid<PyramidElement>('pyramid', 'Pyramid');

registerElement(cubeDefinition);
registerElement(cylinderDefinition);
registerElement(coneDefinition);
registerElement(pyramidDefinition);
