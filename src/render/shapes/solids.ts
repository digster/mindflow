/**
 * Solids: cube, cylinder, cone, pyramid, sphere, prism, torus and capsule.
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
  CapsuleElement,
  ConeElement,
  CubeElement,
  CylinderElement,
  MindflowElement,
  Point,
  PrismElement,
  PyramidElement,
  SphereElement,
  TorusElement,
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

/** The eight types this module registers. */
export type SolidType =
  | 'cube'
  | 'cylinder'
  | 'cone'
  | 'pyramid'
  | 'sphere'
  | 'prism'
  | 'torus'
  | 'capsule';

type SolidElement =
  | CubeElement
  | CylinderElement
  | ConeElement
  | PyramidElement
  | SphereElement
  | PrismElement
  | TorusElement
  | CapsuleElement;

/** Depth offset as a fraction of the box's shorter side. */
export const DEPTH_RATIO = 0.25;

/** How flat a torus's hole is, as a fraction of the box. */
export const TORUS_HOLE = { x: 0.42, y: 0.3 } as const;

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
  /**
   * A second contour subtracted from `points` under the even-odd rule. Only a
   * torus has one, and it is what makes the hole a hole rather than a disc
   * painted in the same colour as the ring.
   */
  hole?: Point[];
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

    case 'sphere': {
      const ry = d / 2;
      // The lens between the equator's near half and the lower outline reads as
      // the shaded underside; the equator itself is the boundary between them,
      // so no separate seam has to be stroked.
      const equator = arcPoints(w / 2, h / 2, w / 2, ry, Math.PI, 0);
      const lower = arcPoints(w / 2, h / 2, w / 2, h / 2, 0, Math.PI);
      return [
        { tone: 'base', points: ellipseLoop(w / 2, h / 2, w / 2, h / 2) },
        { tone: 'shaded', points: [...equator, ...lower.slice(1)] },
      ];
    }

    case 'prism': {
      // A triangular prism on its rectangular face. The back triangle is the
      // front one translated by (+d, -d); only the right-hand roof face and the
      // front triangle survive the projection.
      const apex = { x: (w - d) / 2, y: d };
      const left = { x: 0, y: h };
      const right = { x: w - d, y: h };
      const backApex = { x: (w + d) / 2, y: 0 };
      const backRight = { x: w, y: h - d };
      return [
        { tone: 'lit', points: [apex, backApex, backRight, right] },
        { tone: 'base', points: [apex, right, left] },
      ];
    }

    case 'torus': {
      return [
        {
          tone: 'base',
          points: ellipseLoop(w / 2, h / 2, w / 2, h / 2),
          hole: ellipseLoop(w / 2, h / 2, (w / 2) * TORUS_HOLE.x, (h / 2) * TORUS_HOLE.y),
        },
      ];
    }

    case 'capsule': {
      const vertical = h >= w;
      const r = vertical ? w / 2 : h / 2;
      const body = capsuleOutline(w, h, r, vertical);
      // The seam sits one cap in from the near end; everything beyond it is the
      // dome, which catches the light.
      const cap = vertical
        ? [
            ...arcPoints(w / 2, r, w / 2, d / 2, Math.PI, 0),
            ...arcPoints(w / 2, r, r, r, 0, Math.PI).slice(1),
          ]
        : [
            ...arcPoints(r, h / 2, d / 2, h / 2, -Math.PI / 2, Math.PI / 2),
            ...arcPoints(r, h / 2, r, r, Math.PI / 2, (Math.PI * 3) / 2).slice(1),
          ];
      return [
        { tone: 'base', points: body },
        { tone: 'lit', points: cap },
      ];
    }
  }
}

/** A stadium: two semicircular caps on the box's longer axis. */
function capsuleOutline(w: number, h: number, r: number, vertical: boolean): Point[] {
  if (vertical) {
    return [
      ...arcPoints(w / 2, r, r, r, Math.PI, Math.PI * 2), // top cap
      ...arcPoints(w / 2, h - r, r, r, 0, Math.PI), // bottom cap
    ];
  }
  return [
    ...arcPoints(r, h / 2, r, r, Math.PI / 2, (Math.PI * 3) / 2), // left cap
    ...arcPoints(w - r, h / 2, r, r, -Math.PI / 2, Math.PI / 2), // right cap
  ];
}

/**
 * The solid's outline as a closed polygon — what a click is tested against and
 * where a bound connector attaches.
 *
 * Derived from the same face geometry rather than written a second time, so a
 * change to the projection cannot leave the hit region describing the old shape.
 * For a convex solid the union of the faces IS the silhouette; the outline is
 * recovered by walking the outermost face boundary, which for these eight shapes
 * is the convex hull of every face vertex.
 */
export function solidSilhouette(type: SolidType, w: number, h: number): Point[] {
  // Curved solids have an exact outline that a hull of sampled points would only
  // approximate from the inside, shrinking the hit region slightly.
  if (type === 'sphere' || type === 'torus') return ellipseLoop(w / 2, h / 2, w / 2, h / 2);
  if (type === 'capsule') {
    const vertical = h >= w;
    return capsuleOutline(w, h, vertical ? w / 2 : h / 2, vertical);
  }
  if (type === 'cylinder' || type === 'cone') {
    return solidFaces(type, w, h)[0]!.points;
  }
  return convexHull(solidFaces(type, w, h).flatMap((face) => face.points));
}

/** Andrew's monotone chain. Small inputs — the eight faces above are at most six points each. */
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
    case 'prism':
      return {
        x: (w - d) * 0.25,
        y: d + (h - d) * 0.5,
        width: Math.max((w - d) * 0.5, 1),
        height: Math.max((h - d) * 0.5, 1),
      };
    case 'sphere':
      // Above the equator, which would otherwise strike through the text.
      return { x: w * 0.15, y: h * 0.15, width: w * 0.7, height: h * 0.35 };
    default:
      // A torus's hole and a capsule's waist are both centred, so the whole box
      // is already right.
      return { x: 0, y: 0, width: w, height: h };
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
  sphere: { width: 110, height: 110 },
  prism: { width: 130, height: 110 },
  torus: { width: 130, height: 110 },
  capsule: { width: 90, height: 140 },
};

export function isSolidType(type: string): type is SolidType {
  return type in DEFAULT_SIZES;
}

/** Traces a face, including its hole, as the current path. */
function traceFace(ctx: CanvasRenderingContext2D, face: SolidFace): void {
  tracePoints(ctx, face.points, true);
  if (!face.hole) return;
  const [first, ...rest] = face.hole;
  if (!first) return;
  ctx.moveTo(first.x, first.y);
  for (const point of rest) ctx.lineTo(point.x, point.y);
  ctx.closePath();
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
        traceFace(ctx, face);
        paintFace(
          ctx,
          el.style,
          fill === null ? null : toneColor(fill, face.tone),
          face.hole ? 'evenodd' : 'nonzero',
        );
      }
      drawLabel(ctx, el);
    },

    hitTest(el: T, local: Point, tolerance: number): boolean {
      const outline = silhouetteOf(el);
      const solid = hasFill(el.style) || (el.label && el.label.text !== '');

      if (solid && pointInPolygon(local, outline)) {
        // A torus is a ring: the hole is genuinely empty, so a click there must
        // reach whatever is behind it.
        if (type === 'torus') {
          const hole = solidFaces(type, el.width, el.height)[0]?.hole;
          if (!hole || !pointInPolygon(local, hole)) return true;
        } else {
          return true;
        }
      }

      return distanceToPolyline(local, [...outline, outline[0]!]) <= tolerance;
    },

    outlineIntersect(el: T, direction: Point): Point {
      return polygonOutlineIntersect(
        silhouetteOf(el),
        { x: el.width / 2, y: el.height / 2 },
        direction,
      );
    },
  };
}

export const cubeDefinition = defineSolid<CubeElement>('cube', 'Cube');
export const cylinderDefinition = defineSolid<CylinderElement>('cylinder', 'Cylinder');
export const coneDefinition = defineSolid<ConeElement>('cone', 'Cone');
export const pyramidDefinition = defineSolid<PyramidElement>('pyramid', 'Pyramid');
export const sphereDefinition = defineSolid<SphereElement>('sphere', 'Sphere');
export const prismDefinition = defineSolid<PrismElement>('prism', 'Prism');
export const torusDefinition = defineSolid<TorusElement>('torus', 'Torus');
export const capsuleDefinition = defineSolid<CapsuleElement>('capsule', 'Capsule');

registerElement(cubeDefinition);
registerElement(cylinderDefinition);
registerElement(coneDefinition);
registerElement(pyramidDefinition);
registerElement(sphereDefinition);
registerElement(prismDefinition);
registerElement(torusDefinition);
registerElement(capsuleDefinition);
