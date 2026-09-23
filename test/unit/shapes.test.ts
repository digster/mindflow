/**
 * Flat polygons and solids.
 *
 * What is pinned here is what an external tool must reimplement to render one of
 * these types from a file: the vertex fractions, the depth formula, the face
 * geometry and the tone derivation. All four are published in
 * `docs/03-elements.md` and `docs/07-rendering.md` — so a change that breaks one
 * of these tests is a change to a published contract, and should be made with
 * the documentation in the same commit.
 *
 * The one thing deliberately NOT asserted is that any of it looks like a cube.
 * That is a matter of taste and no test can hold it; reproducibility is what the
 * format promises, and reproducibility is testable.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { loadDocument, serializeDocument } from '../../src/model/document.ts';
import { getDefinition, isRegistered, labelBoxOf } from '../../src/model/registry.ts';
import { polygonOutlineIntersect } from '../../src/model/geometry.ts';
import type { MindflowElement, Point } from '../../src/model/types.ts';
import {
  PARALLELOGRAM_SLANT,
  STAR_INNER_RATIO,
  polygonVertices,
  type PolygonType,
} from '../../src/render/shapes/polygons.ts';
import {
  DEPTH_RATIO,
  depthOf,
  solidFaces,
  solidLabelBox,
  solidSilhouette,
  toneColor,
  type SolidType,
} from '../../src/render/shapes/solids.ts';
import { FACE_SHADE, shadeColor } from '../../src/render/shapes/shared.ts';

const POLYGONS: PolygonType[] = ['triangle', 'pentagon', 'hexagon', 'star', 'parallelogram'];
const SOLIDS: SolidType[] = ['cube', 'cylinder', 'cone', 'pyramid'];

/** Solids 1.4.0 introduced and 1.5.0 retired; see `migrate.ts`. */
const RETIRED_SOLIDS = ['sphere', 'prism', 'torus', 'capsule'];

/** A few aspect ratios, including the two where `min(w, h)` switches sides. */
const SIZES: [number, number][] = [
  [120, 80],
  [80, 120],
  [100, 100],
  [300, 60],
  [40, 260],
];

function make(type: string, width: number, height: number): MindflowElement {
  return getDefinition(type).create({ x: 0, y: 0, width, height, zIndex: 1000 });
}

function bounds(points: readonly Point[]) {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
}

describe('flat polygons', () => {
  it('fill their box exactly', () => {
    // The fit-to-box normalisation is the whole reason a pentagon does not
    // float inside its circumscribed circle. Without it the bounding box would
    // be narrower than the element, and every snap and alignment would be off.
    for (const type of POLYGONS) {
      for (const [w, h] of SIZES) {
        const box = bounds(polygonVertices(type, w, h));
        expect(box.minX, type).toBeCloseTo(0, 6);
        expect(box.minY, type).toBeCloseTo(0, 6);
        expect(box.maxX, type).toBeCloseTo(w, 6);
        expect(box.maxY, type).toBeCloseTo(h, 6);
      }
    }
  });

  it('places a triangle at the published vertices', () => {
    expect(polygonVertices('triangle', 100, 60)).toEqual([
      { x: 50, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ]);
  });

  it('leans a parallelogram by a quarter of its width', () => {
    expect(PARALLELOGRAM_SLANT).toBe(0.25);
    expect(polygonVertices('parallelogram', 100, 60)).toEqual([
      { x: 25, y: 0 },
      { x: 100, y: 0 },
      { x: 75, y: 60 },
      { x: 0, y: 60 },
    ]);
  });

  it('matches the vertex fractions published in docs/03-elements.md', () => {
    const fractions = (type: PolygonType) =>
      polygonVertices(type, 1, 1).map((p) => [
        Number(p.x.toFixed(3)),
        Number(p.y.toFixed(3)),
      ]);

    expect(fractions('pentagon')).toEqual([
      [0.5, 0],
      [1, 0.382],
      [0.809, 1],
      [0.191, 1],
      [0, 0.382],
    ]);
    expect(fractions('hexagon')).toEqual([
      [0.5, 0],
      [1, 0.25],
      [1, 0.75],
      [0.5, 1],
      [0, 0.75],
      [0, 0.25],
    ]);
    expect(STAR_INNER_RATIO).toBe(0.382);
    expect(fractions('star')).toHaveLength(10);
    expect(fractions('star')[0]).toEqual([0.5, 0]);
  });

  it('stretches with the box rather than staying regular', () => {
    // Stated in the docs as a deliberate choice, so it is worth a test: a
    // pentagon in a wide box is wide.
    const wide = polygonVertices('pentagon', 300, 60);
    const tall = polygonVertices('pentagon', 60, 300);
    expect(bounds(wide).maxX).toBeCloseTo(300, 6);
    expect(bounds(tall).maxY).toBeCloseTo(300, 6);
  });

  it('roughens, unlike the solids', () => {
    for (const type of POLYGONS) {
      expect(getDefinition(type).roughOutline, type).toBeTypeOf('function');
    }
  });
});

describe('the depth offset', () => {
  it('is a quarter of the shorter side', () => {
    expect(DEPTH_RATIO).toBe(0.25);
    expect(depthOf(120, 80)).toBe(20);
    expect(depthOf(80, 120)).toBe(20);
    expect(depthOf(40, 260)).toBe(10);
  });
});

describe('solids', () => {
  it('draws a cube at the published vertices', () => {
    // w=120, h=80 → d=20. These three faces are the table in docs/03-elements.md.
    const [top, right, front] = solidFaces('cube', 120, 80);
    expect(top?.tone).toBe('lit');
    expect(top?.points).toEqual([
      { x: 0, y: 20 },
      { x: 20, y: 0 },
      { x: 120, y: 0 },
      { x: 100, y: 20 },
    ]);
    expect(right?.tone).toBe('shaded');
    expect(right?.points).toEqual([
      { x: 100, y: 20 },
      { x: 120, y: 0 },
      { x: 120, y: 60 },
      { x: 100, y: 80 },
    ]);
    expect(front?.tone).toBe('base');
    expect(front?.points).toEqual([
      { x: 0, y: 20 },
      { x: 100, y: 20 },
      { x: 100, y: 80 },
      { x: 0, y: 80 },
    ]);
  });

  it('keeps every face inside the element box', () => {
    // The invariant the whole projection is built around: `width`/`height` stay
    // a truthful bounding box, because culling, marquee selection and the AABB
    // pre-rejection in hit-testing all trust them.
    for (const type of SOLIDS) {
      for (const [w, h] of SIZES) {
        for (const face of solidFaces(type, w, h)) {
          for (const point of face.points) {
            expect(point.x, `${type} ${w}x${h}`).toBeGreaterThanOrEqual(-1e-9);
            expect(point.y, `${type} ${w}x${h}`).toBeGreaterThanOrEqual(-1e-9);
            expect(point.x, `${type} ${w}x${h}`).toBeLessThanOrEqual(w + 1e-9);
            expect(point.y, `${type} ${w}x${h}`).toBeLessThanOrEqual(h + 1e-9);
          }
        }
      }
    }
  });

  it('gives every solid a closed silhouette that spans its box', () => {
    for (const type of SOLIDS) {
      for (const [w, h] of SIZES) {
        const outline = solidSilhouette(type, w, h);
        expect(outline.length, type).toBeGreaterThanOrEqual(3);
        const box = bounds(outline);
        // Touching all four sides is what makes the box honest in both
        // directions — a silhouette that stopped short would leave dead space
        // inside the selection frame.
        expect(box.minX, `${type} ${w}x${h}`).toBeCloseTo(0, 6);
        expect(box.minY, `${type} ${w}x${h}`).toBeCloseTo(0, 6);
        expect(box.maxX, `${type} ${w}x${h}`).toBeCloseTo(w, 6);
        expect(box.maxY, `${type} ${w}x${h}`).toBeCloseTo(h, 6);
      }
    }
  });

  it('does not roughen', () => {
    // Not an omission: a hand-drawn outline is one closed polygon, and a cube's
    // interior edges cannot survive that. Documented, so it is asserted.
    for (const type of SOLIDS) {
      expect(getDefinition(type).roughOutline, type).toBeUndefined();
    }
  });

  it('no longer registers the solids 1.5.0 retired', () => {
    // A board that still holds one is converted on load (see `document.test.ts`);
    // a type left registered here would be one the schema no longer allows.
    for (const type of RETIRED_SOLIDS) {
      expect(isRegistered(type), type).toBe(false);
    }
  });
});

describe('face tones', () => {
  it('lightens and darkens by the published amount', () => {
    expect(FACE_SHADE).toBe(0.15);
    // 128 + (255-128)*0.15 = 147.05 → 147 = 0x93; 128*0.85 = 108.8 → 109 = 0x6d
    expect(shadeColor('#808080', FACE_SHADE)).toBe('#939393');
    expect(shadeColor('#808080', -FACE_SHADE)).toBe('#6d6d6d');
  });

  it('expands short hex and preserves alpha', () => {
    expect(shadeColor('#fff', -FACE_SHADE)).toBe('#d9d9d9');
    expect(shadeColor('#80808080', FACE_SHADE)).toBe('#93939380');
  });

  it('passes through anything it cannot parse', () => {
    // The documented fallback. Guessing a tone in an unknown colour space is
    // how two renderers come to disagree about the same file.
    for (const colour of ['transparent', 'rebeccapurple', 'rgb(10 20 30)', '']) {
      expect(shadeColor(colour, FACE_SHADE)).toBe(colour);
    }
  });

  it('leaves the base tone alone', () => {
    expect(toneColor('#a5d8ff', 'base')).toBe('#a5d8ff');
    expect(toneColor('#a5d8ff', 'lit')).not.toBe('#a5d8ff');
  });
});

describe('connector anchoring', () => {
  it('crosses a polygon outline rather than its bounding box', () => {
    // Straight up from the centre of a triangle is the apex, which sits on the
    // box's top edge; straight right leaves through the sloped side, well
    // inside it.
    const triangle = polygonVertices('triangle', 100, 100);
    const centre = { x: 50, y: 50 };
    expect(polygonOutlineIntersect(triangle, centre, { x: 0, y: -1 }).y).toBeCloseTo(0, 6);
    expect(polygonOutlineIntersect(triangle, centre, { x: 1, y: 0 }).x).toBeLessThan(100);
  });

  it('takes the outermost crossing, so a star anchors to a point', () => {
    // The notch between two points is nearer the centre than the tip. Taking
    // the first crossing would stop an arrow inside the star's own outline.
    const star = polygonVertices('star', 100, 100);
    const centre = { x: 50, y: 50 };
    const up = polygonOutlineIntersect(star, centre, { x: 0, y: -1 });
    expect(up.y).toBeCloseTo(0, 6);
  });

  it('anchors a solid to its silhouette', () => {
    const cube = make('cube', 120, 80);
    const crossing = getDefinition('cube').outlineIntersect?.(cube as never, { x: 1, y: 0 });
    expect(crossing).toBeDefined();
    expect(crossing!.x).toBeCloseTo(120, 6);
    expect(crossing!.y).toBeCloseTo(40, 6);
  });
});

describe('hit testing', () => {
  const filled = (type: string, w: number, h: number) => {
    const element = make(type, w, h);
    return {
      ...element,
      style: { ...element.style, fill: '#ffffff', fillStyle: 'solid' as const },
    };
  };

  it('treats a filled solid as solid', () => {
    for (const type of SOLIDS) {
      const element = filled(type, 120, 100);
      const definition = getDefinition(type);
      expect(definition.hitTest(element as never, { x: 60, y: 50 }, 8), type).toBe(true);
    }
  });

  it('lets a click through the middle of an unfilled polygon', () => {
    const element = make('hexagon', 120, 100);
    expect(getDefinition('hexagon').hitTest(element as never, { x: 60, y: 50 }, 8)).toBe(false);
  });

  it('misses outside the box for every new type', () => {
    for (const type of [...POLYGONS, ...SOLIDS]) {
      const element = filled(type, 120, 100);
      expect(getDefinition(type).hitTest(element as never, { x: 200, y: 200 }, 8), type).toBe(
        false,
      );
    }
  });
});

describe('labels', () => {
  it('puts a cube’s label on its front face', () => {
    const cube = make('cube', 120, 80);
    expect(labelBoxOf(cube)).toEqual({ x: 0, y: 20, width: 100, height: 60 });
  });

  it('defaults to the whole box for a flat polygon', () => {
    const hexagon = make('hexagon', 120, 80);
    expect(labelBoxOf(hexagon)).toEqual({ x: 0, y: 0, width: 120, height: 80 });
  });

  it('keeps every solid’s label box inside its element box', () => {
    for (const type of SOLIDS) {
      for (const [w, h] of SIZES) {
        const box = solidLabelBox(type, w, h);
        expect(box.x, type).toBeGreaterThanOrEqual(0);
        expect(box.y, type).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${type} ${w}x${h}`).toBeLessThanOrEqual(w + 1e-9);
        expect(box.y + box.height, `${type} ${w}x${h}`).toBeLessThanOrEqual(h + 1e-9);
      }
    }
  });
});

describe('the document format', () => {
  it('round-trips every new type', () => {
    const document = createDocument();
    for (const [index, type] of [...POLYGONS, ...SOLIDS].entries()) {
      document.elements.push(
        getDefinition(type).create({ x: index * 20, y: 0, zIndex: 1000 + index }),
      );
    }

    const { document: reloaded, warnings } = loadDocument(serializeDocument(document));
    expect(warnings.filter((warning) => warning.level === 'error')).toEqual([]);
    expect(reloaded.elements.map((element) => element.type)).toEqual([...POLYGONS, ...SOLIDS]);
  });

  it('adds no fields of its own', () => {
    // The claim the changelog makes: one of these is a base element with a
    // different `type`, which is what lets a reader that knows only the base
    // fields place it correctly.
    const base = Object.keys(make('rectangle', 10, 10)).filter((key) => key !== 'cornerRadius');
    for (const type of [...POLYGONS, ...SOLIDS]) {
      expect(Object.keys(make(type, 10, 10)).sort(), type).toEqual(base.sort());
    }
  });

  it('defaults a solid to filled and a polygon to unfilled', () => {
    // An unfilled cube is three outlines with nothing to tell the faces apart.
    expect(make('cube', 10, 10).style.fillStyle).toBe('solid');
    expect(make('hexagon', 10, 10).style.fillStyle).toBe('none');
  });
});
