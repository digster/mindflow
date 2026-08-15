/**
 * Geometry tests.
 *
 * This is where the subtlest correctness bugs in a canvas app live — rotation
 * sign conventions, inverse transforms that are not quite inverses, bounding
 * boxes that forget rotation. The module is pure, so it earns thorough tests.
 */

import { describe, expect, it } from 'vitest';

import {
  aabbContains,
  aabbIntersects,
  distanceToSegment,
  elementCenter,
  elementWorldAABB,
  localToWorld,
  normalizeAngle,
  normalizePathBounds,
  pointInEllipse,
  pointInPolygon,
  rayIntersectElementOutline,
  rotatePoint,
  roundCoord,
  screenToScene,
  sceneToScreen,
  simplifyPoints,
  unionAABB,
  worldToLocal,
} from '../../src/model/geometry.ts';
import type { DrawElement, MindflowElement, PointTuple } from '../../src/model/types.ts';

/** Builds a bare element for geometry tests; style fields are irrelevant here. */
function box(
  overrides: Partial<MindflowElement> & { x: number; y: number; width: number; height: number },
): MindflowElement {
  return {
    id: 'el_test',
    type: 'rectangle',
    angle: 0,
    zIndex: 1000,
    opacity: 1,
    locked: false,
    visible: true,
    groupId: null,
    style: {
      stroke: '#000',
      strokeWidth: 1,
      strokeStyle: 'solid',
      fill: 'transparent',
      fillStyle: 'none',
      roughness: 0,
    },
    label: null,
    meta: {},
    cornerRadius: 0,
    ...overrides,
  } as MindflowElement;
}

const closeTo = (actual: number, expected: number, precision = 6) =>
  expect(actual).toBeCloseTo(expected, precision);

describe('normalizeAngle', () => {
  it('wraps into [0, 360)', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(370)).toBe(10);
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-450)).toBe(270);
  });
});

describe('rotatePoint', () => {
  it('is a no-op at 0 degrees', () => {
    expect(rotatePoint({ x: 5, y: 7 }, { x: 0, y: 0 }, 0)).toEqual({ x: 5, y: 7 });
  });

  it('rotates clockwise on screen, where +y points down', () => {
    // A point to the right of the origin, rotated 90 degrees, should end up
    // BELOW it. That is clockwise as seen on screen, which is what the format
    // specifies — and getting this sign wrong is the classic mistake.
    const result = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, 90);
    closeTo(result.x, 0);
    closeTo(result.y, 10);
  });

  it('leaves the origin fixed', () => {
    expect(rotatePoint({ x: 3, y: 3 }, { x: 3, y: 3 }, 137)).toEqual({ x: 3, y: 3 });
  });
});

describe('worldToLocal / localToWorld', () => {
  it('round-trips at every angle', () => {
    for (const angle of [0, 15, 45, 90, 180, 270, 359]) {
      const el = box({ x: 100, y: 50, width: 80, height: 40, angle });
      const original = { x: 137.5, y: 61.25 };
      const back = localToWorld(el, worldToLocal(el, original));
      closeTo(back.x, original.x);
      closeTo(back.y, original.y);
    }
  });

  it('maps the local origin to the element position when unrotated', () => {
    const el = box({ x: 100, y: 50, width: 80, height: 40 });
    expect(localToWorld(el, { x: 0, y: 0 })).toEqual({ x: 100, y: 50 });
  });

  it('keeps the centre fixed under rotation', () => {
    const el = box({ x: 0, y: 0, width: 100, height: 60, angle: 37 });
    const centre = elementCenter(el);
    const mapped = localToWorld(el, { x: 50, y: 30 });
    closeTo(mapped.x, centre.x);
    closeTo(mapped.y, centre.y);
  });
});

describe('elementWorldAABB', () => {
  it('equals the box when unrotated', () => {
    expect(elementWorldAABB(box({ x: 10, y: 20, width: 30, height: 40 }))).toEqual({
      minX: 10,
      minY: 20,
      maxX: 40,
      maxY: 60,
    });
  });

  it('grows when rotated', () => {
    // A 100x20 bar rotated 45 degrees needs a much taller box than 20.
    const rotated = elementWorldAABB(box({ x: 0, y: 0, width: 100, height: 20, angle: 45 }));
    expect(rotated.maxY - rotated.minY).toBeGreaterThan(20);
    expect(rotated.maxX - rotated.minX).toBeGreaterThan(20);
  });

  it('is unchanged by a 180 degree rotation of a centred box', () => {
    const upright = elementWorldAABB(box({ x: -50, y: -25, width: 100, height: 50 }));
    const flipped = elementWorldAABB(box({ x: -50, y: -25, width: 100, height: 50, angle: 180 }));
    for (const key of ['minX', 'minY', 'maxX', 'maxY'] as const) {
      closeTo(flipped[key], upright[key], 6);
    }
  });
});

describe('AABB predicates', () => {
  const outer = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it('detects containment', () => {
    expect(aabbContains(outer, { minX: 10, minY: 10, maxX: 20, maxY: 20 })).toBe(true);
    expect(aabbContains(outer, { minX: -1, minY: 10, maxX: 20, maxY: 20 })).toBe(false);
  });

  it('detects intersection, including edge contact', () => {
    expect(aabbIntersects(outer, { minX: 50, minY: 50, maxX: 150, maxY: 150 })).toBe(true);
    expect(aabbIntersects(outer, { minX: 100, minY: 0, maxX: 200, maxY: 100 })).toBe(true);
    expect(aabbIntersects(outer, { minX: 101, minY: 0, maxX: 200, maxY: 100 })).toBe(false);
  });

  it('unions several elements', () => {
    const result = unionAABB([
      box({ x: 0, y: 0, width: 10, height: 10 }),
      box({ x: 90, y: 40, width: 10, height: 60 }),
    ]);
    expect(result).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
  });

  it('returns null for an empty list', () => {
    expect(unionAABB([])).toBeNull();
  });
});

describe('viewport transforms', () => {
  it('round-trips scene → screen → scene', () => {
    const viewport = { x: -37.5, y: 210, zoom: 2.75 };
    const scene = { x: 123.5, y: -44.25 };
    const back = screenToScene(sceneToScreen(scene, viewport), viewport);
    closeTo(back.x, scene.x);
    closeTo(back.y, scene.y);
  });

  it('places the viewport origin at the screen origin', () => {
    const viewport = { x: 100, y: 200, zoom: 3 };
    expect(sceneToScreen({ x: 100, y: 200 }, viewport)).toEqual({ x: 0, y: 0 });
  });
});

describe('distanceToSegment', () => {
  it('measures perpendicular distance when the projection lands on the segment', () => {
    closeTo(distanceToSegment({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  });

  it('clamps to the nearer endpoint when the projection falls outside', () => {
    closeTo(distanceToSegment({ x: -4, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 4);
    closeTo(distanceToSegment({ x: 14, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 4);
  });

  it('handles a zero-length segment', () => {
    closeTo(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);
  });
});

describe('pointInEllipse', () => {
  it('accepts the centre and rejects the box corner', () => {
    expect(pointInEllipse({ x: 50, y: 25 }, 100, 50)).toBe(true);
    // The corner of the bounding box lies outside the inscribed ellipse.
    expect(pointInEllipse({ x: 0, y: 0 }, 100, 50)).toBe(false);
  });

  it('accepts points exactly on the outline', () => {
    expect(pointInEllipse({ x: 0, y: 25 }, 100, 50)).toBe(true);
  });

  it('rejects a degenerate ellipse', () => {
    expect(pointInEllipse({ x: 0, y: 0 }, 0, 50)).toBe(false);
  });
});

describe('pointInPolygon', () => {
  const diamond = [
    { x: 50, y: 0 },
    { x: 100, y: 50 },
    { x: 50, y: 100 },
    { x: 0, y: 50 },
  ];

  it('accepts the interior and rejects the corners of the bounding box', () => {
    expect(pointInPolygon({ x: 50, y: 50 }, diamond)).toBe(true);
    expect(pointInPolygon({ x: 5, y: 5 }, diamond)).toBe(false);
  });
});

describe('rayIntersectElementOutline', () => {
  it('exits a rectangle through the edge facing the target', () => {
    const rect = box({ x: 0, y: 0, width: 100, height: 100 });
    const point = rayIntersectElementOutline(rect, { x: 500, y: 50 });
    closeTo(point.x, 100);
    closeTo(point.y, 50);
  });

  it('exits an ellipse on its curve', () => {
    const ellipse = box({ x: 0, y: 0, width: 100, height: 100, type: 'ellipse' });
    const point = rayIntersectElementOutline(ellipse, { x: 500, y: 50 });
    closeTo(point.x, 100);
    closeTo(point.y, 50);
  });

  it('follows the element through its rotation', () => {
    // Rotated 90 degrees clockwise, what was the right edge now faces down.
    const rect = box({ x: 0, y: 0, width: 100, height: 100, angle: 90 });
    const point = rayIntersectElementOutline(rect, { x: 50, y: 500 });
    closeTo(point.y, 100, 4);
  });

  it('returns the centre when the target is the centre', () => {
    const rect = box({ x: 0, y: 0, width: 100, height: 100 });
    expect(rayIntersectElementOutline(rect, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
  });
});

describe('normalizePathBounds', () => {
  const path = (points: PointTuple[], x = 0, y = 0): DrawElement =>
    box({ x, y, width: 1, height: 1, type: 'draw', points, pressureSensitive: false } as never) as DrawElement;

  it('tightly wraps the points and rebases them', () => {
    const result = normalizePathBounds(path([[10, 20], [50, 60]], 100, 100));
    expect(result.x).toBe(110);
    expect(result.y).toBe(120);
    expect(result.width).toBe(40);
    expect(result.height).toBe(40);
    expect(result.points).toEqual([[0, 0], [40, 40]]);
  });

  it('keeps the path visually in place', () => {
    const before = path([[10, 20], [50, 60]], 100, 100);
    const after = normalizePathBounds(before);
    // Absolute position of the first point must not move.
    expect(after.x + (after.points[0]?.[0] ?? 0)).toBe(before.x + (before.points[0]?.[0] ?? 0));
    expect(after.y + (after.points[0]?.[1] ?? 0)).toBe(before.y + (before.points[0]?.[1] ?? 0));
  });

  it('floors a degenerate axis at 1 so dimensions stay positive', () => {
    // A perfectly horizontal line has zero vertical extent, but the format
    // guarantees positive dimensions.
    const result = normalizePathBounds(path([[0, 5], [100, 5]]));
    expect(result.height).toBe(1);
    expect(result.width).toBe(100);
  });

  it('preserves pressure values', () => {
    const result = normalizePathBounds(path([[0, 0, 0.25], [10, 10, 0.75]]));
    expect(result.points[0]).toHaveLength(3);
    expect(result.points[1]?.[2]).toBe(0.75);
  });
});

describe('simplifyPoints', () => {
  it('collapses a straight run to its endpoints', () => {
    const straight: PointTuple[] = Array.from({ length: 20 }, (_, i) => [i * 5, 0]);
    expect(simplifyPoints(straight)).toEqual([[0, 0], [95, 0]]);
  });

  it('keeps points that carry the shape', () => {
    const zigzag: PointTuple[] = [[0, 0], [10, 40], [20, 0], [30, 40], [40, 0]];
    expect(simplifyPoints(zigzag).length).toBeGreaterThan(2);
  });

  it('passes through short inputs untouched', () => {
    expect(simplifyPoints([[0, 0]])).toEqual([[0, 0]]);
    expect(simplifyPoints([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]]);
  });

  it('always keeps the first and last point', () => {
    const wobble: PointTuple[] = Array.from({ length: 50 }, (_, i) => [i, Math.sin(i / 4) * 10]);
    const simplified = simplifyPoints(wobble);
    expect(simplified[0]).toEqual(wobble[0]);
    expect(simplified[simplified.length - 1]).toEqual(wobble[wobble.length - 1]);
  });
});

describe('roundCoord', () => {
  it('stabilises floating-point drift', () => {
    // Without this, dragging a shape one pixel and back leaves a noisy diff.
    expect(roundCoord(100.00000000000001)).toBe(100);
    expect(roundCoord(1 / 3)).toBe(0.33);
    expect(roundCoord(1 / 3, 4)).toBe(0.3333);
  });

  it('is idempotent', () => {
    const once = roundCoord(123.456789);
    expect(roundCoord(once)).toBe(once);
  });
});
