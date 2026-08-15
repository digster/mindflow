/**
 * Connector binding and transform tests.
 *
 * Binding is the feature that makes MindFlow a flow-diagramming tool rather than
 * a drawing program, and its algorithms are part of the published contract — an
 * external renderer must reproduce them exactly. These tests pin the behaviour
 * that `docs/07-rendering.md#binding-resolution` describes.
 *
 * The transform tests pin the one invariant that makes rotated resizing correct:
 * the anchor handle must not move.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { createDocument } from '../../src/model/defaults.ts';
import type {
  EllipseElement,
  LinearElement,
  MindflowDocument,
  MindflowElement,
  RectangleElement,
} from '../../src/model/types.ts';
import {
  connectorsToRefresh,
  createBinding,
  findBindTarget,
  refreshConnector,
  resolveBindingPoint,
} from '../../src/input/binding.ts';
import {
  applyFrameToElements,
  resizeFrame,
  rotateElements,
  rotationForPointer,
  translateElements,
} from '../../src/input/transform.ts';
import { frameLocalToWorld, selectionFrame } from '../../src/render/overlay.ts';
import { elementCenter } from '../../src/model/geometry.ts';

const closeTo = (actual: number, expected: number, precision = 4) =>
  expect(actual).toBeCloseTo(expected, precision);

function rect(x: number, y: number, w = 100, h = 100, zIndex = 1000): RectangleElement {
  return getDefinition<RectangleElement>('rectangle').create({ x, y, width: w, height: h, zIndex });
}

function ellipse(x: number, y: number, w = 100, h = 100, zIndex = 1000): EllipseElement {
  return getDefinition<EllipseElement>('ellipse').create({ x, y, width: w, height: h, zIndex });
}

function arrow(from: { x: number; y: number }, to: { x: number; y: number }, zIndex = 3000): LinearElement {
  return getDefinition<LinearElement>('arrow').create({
    x: from.x,
    y: from.y,
    width: Math.max(Math.abs(to.x - from.x), 1),
    height: Math.max(Math.abs(to.y - from.y), 1),
    zIndex,
    points: [[0, 0], [to.x - from.x, to.y - from.y]],
  });
}

function doc(...elements: MindflowElement[]): MindflowDocument {
  return { ...createDocument(), elements: [...elements].sort((a, b) => a.zIndex - b.zIndex) };
}

describe('createBinding', () => {
  it('produces an auto anchor when dropped well inside', () => {
    const target = rect(0, 0, 100, 100);
    expect(createBinding(target, { x: 50, y: 50 }).anchor.mode).toBe('auto');
  });

  it('produces a fixed anchor when dropped near the outline', () => {
    const target = rect(0, 0, 100, 100);
    const binding = createBinding(target, { x: 100, y: 50 });
    expect(binding.anchor.mode).toBe('fixed');
    if (binding.anchor.mode === 'fixed') {
      closeTo(binding.anchor.u, 1);
      closeTo(binding.anchor.v, 0.5);
    }
  });

  it('clamps normalised coordinates dropped outside the box', () => {
    const binding = createBinding(rect(0, 0, 100, 100), { x: 140, y: -30 });
    if (binding.anchor.mode === 'fixed') {
      expect(binding.anchor.u).toBeLessThanOrEqual(1);
      expect(binding.anchor.v).toBeGreaterThanOrEqual(0);
    }
  });

  it('accounts for the target rotation', () => {
    // Dropping at the visually-right point of a shape rotated 90 degrees should
    // give the normalised coordinates of its LOCAL bottom edge.
    const target = { ...rect(0, 0, 100, 100), angle: 90 };
    const binding = createBinding(target, { x: 50, y: 100 });
    if (binding.anchor.mode === 'fixed') {
      closeTo(binding.anchor.u, 1, 3);
      closeTo(binding.anchor.v, 0.5, 3);
    }
  });
});

describe('resolveBindingPoint', () => {
  it('resolves a fixed anchor through the target rotation', () => {
    const target = rect(0, 0, 100, 100);
    const point = resolveBindingPoint(
      target,
      { elementId: target.id, anchor: { mode: 'fixed', u: 1, v: 0.5 }, gap: 0 },
      { x: 500, y: 50 },
    );
    closeTo(point.x, 100);
    closeTo(point.y, 50);
  });

  it('resolves an auto anchor to the edge facing the reference point', () => {
    const target = rect(0, 0, 100, 100);
    const binding = { elementId: target.id, anchor: { mode: 'auto' } as const, gap: 0 };

    const right = resolveBindingPoint(target, binding, { x: 500, y: 50 });
    closeTo(right.x, 100);

    const left = resolveBindingPoint(target, binding, { x: -500, y: 50 });
    closeTo(left.x, 0);

    const below = resolveBindingPoint(target, binding, { x: 50, y: 500 });
    closeTo(below.y, 100);
  });

  it('resolves an auto anchor on an ellipse to its curve, not its box', () => {
    const target = ellipse(0, 0, 100, 100);
    const binding = { elementId: target.id, anchor: { mode: 'auto' } as const, gap: 0 };

    // Aiming diagonally: on a circle of radius 50 the crossing is at
    // 50 + 50/sqrt(2) on both axes, which is inside the box corner.
    const diagonal = resolveBindingPoint(target, binding, { x: 500, y: 500 });
    closeTo(diagonal.x, 50 + 50 / Math.SQRT2, 3);
    closeTo(diagonal.y, 50 + 50 / Math.SQRT2, 3);
  });

  it('pushes the tip outward by the gap', () => {
    // This is why an arrow never quite touches the shape it points at.
    const target = rect(0, 0, 100, 100);
    const point = resolveBindingPoint(
      target,
      { elementId: target.id, anchor: { mode: 'auto' }, gap: 10 },
      { x: 500, y: 50 },
    );
    closeTo(point.x, 110);
  });

  it('applies the gap identically for fixed anchors', () => {
    const target = rect(0, 0, 100, 100);
    const point = resolveBindingPoint(
      target,
      { elementId: target.id, anchor: { mode: 'fixed', u: 1, v: 0.5 }, gap: 10 },
      { x: 500, y: 50 },
    );
    closeTo(point.x, 110);
  });

  it('returns the centre when the reference is the centre', () => {
    const target = rect(0, 0, 100, 100);
    const point = resolveBindingPoint(target, { elementId: target.id, anchor: { mode: 'auto' }, gap: 0 }, { x: 50, y: 50 });
    expect(point).toEqual(elementCenter(target));
  });
});

describe('refreshConnector', () => {
  it('re-routes both endpoints onto the targets’ outlines', () => {
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(300, 0, 100, 100, 2000);
    const connector = { ...arrow({ x: 50, y: 50 }, { x: 350, y: 50 }) };
    connector.startBinding = { elementId: a.id, anchor: { mode: 'auto' }, gap: 0 };
    connector.endBinding = { elementId: b.id, anchor: { mode: 'auto' }, gap: 0 };

    const refreshed = refreshConnector(doc(a, b, connector), connector);
    const start = { x: refreshed.x + (refreshed.points[0]?.[0] ?? 0), y: refreshed.y + (refreshed.points[0]?.[1] ?? 0) };
    const last = refreshed.points[refreshed.points.length - 1];
    const end = { x: refreshed.x + (last?.[0] ?? 0), y: refreshed.y + (last?.[1] ?? 0) };

    closeTo(start.x, 100, 1); // right edge of A
    closeTo(end.x, 300, 1);   // left edge of B
  });

  it('follows a target that moves', () => {
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(300, 0, 100, 100, 2000);
    const connector = { ...arrow({ x: 50, y: 50 }, { x: 350, y: 50 }) };
    connector.endBinding = { elementId: b.id, anchor: { mode: 'auto' }, gap: 0 };

    const before = refreshConnector(doc(a, b, connector), connector);
    const movedB = { ...b, y: 400 };
    const after = refreshConnector(doc(a, movedB, before), before);

    const lastBefore = before.points[before.points.length - 1];
    const lastAfter = after.points[after.points.length - 1];
    const endBefore = before.y + (lastBefore?.[1] ?? 0);
    const endAfter = after.y + (lastAfter?.[1] ?? 0);
    expect(endAfter).toBeGreaterThan(endBefore);
  });

  it('re-derives the bounding box after re-routing', () => {
    // Skipping this leaves width/height describing the old extent, which breaks
    // culling and hit-testing.
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(500, 400, 100, 100, 2000);
    const connector = { ...arrow({ x: 50, y: 50 }, { x: 550, y: 450 }) };
    connector.startBinding = { elementId: a.id, anchor: { mode: 'auto' }, gap: 0 };
    connector.endBinding = { elementId: b.id, anchor: { mode: 'auto' }, gap: 0 };

    const refreshed = refreshConnector(doc(a, b, connector), connector);
    const xs = refreshed.points.map((point) => point[0]);
    const ys = refreshed.points.map((point) => point[1]);

    closeTo(Math.min(...xs), 0, 6);
    closeTo(Math.min(...ys), 0, 6);
    closeTo(refreshed.width, Math.max(...xs), 1);
    closeTo(refreshed.height, Math.max(...ys), 1);
  });

  it('returns the same object when nothing moved', () => {
    // Lets callers cheaply skip emitting a no-op command.
    const a = rect(0, 0, 100, 100, 1000);
    const connector = { ...arrow({ x: 50, y: 50 }, { x: 350, y: 50 }) };
    connector.startBinding = { elementId: a.id, anchor: { mode: 'auto' }, gap: 0 };

    const once = refreshConnector(doc(a, connector), connector);
    expect(refreshConnector(doc(a, once), once)).toBe(once);
  });

  it('is a no-op for an unbound connector', () => {
    const connector = arrow({ x: 0, y: 0 }, { x: 100, y: 100 });
    expect(refreshConnector(doc(connector), connector)).toBe(connector);
  });

  it('uses the other target’s centre when both ends are bound', () => {
    // Resolving two auto anchors against each other would be a mutual dependency
    // with no closed-form solution.
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(0, 300, 100, 100, 2000);
    const connector = { ...arrow({ x: 50, y: 50 }, { x: 50, y: 350 }) };
    connector.startBinding = { elementId: a.id, anchor: { mode: 'auto' }, gap: 0 };
    connector.endBinding = { elementId: b.id, anchor: { mode: 'auto' }, gap: 0 };

    const refreshed = refreshConnector(doc(a, b, connector), connector);
    // A is above B, so the connector should leave A's bottom edge.
    closeTo(refreshed.y, 100, 1);
  });
});

describe('connectorsToRefresh', () => {
  it('finds connectors bound to a moved element', () => {
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(300, 0, 100, 100, 2000);
    let connector = { ...arrow({ x: 50, y: 50 }, { x: 350, y: 50 }) };
    connector.endBinding = { elementId: b.id, anchor: { mode: 'auto' }, gap: 0 };
    connector = refreshConnector(doc(a, b, connector), connector);

    const moved = { ...b, x: 800 };
    expect(connectorsToRefresh(doc(a, moved, connector), new Set([b.id]))).toHaveLength(1);
  });

  it('ignores connectors bound to elements that did not move', () => {
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(300, 0, 100, 100, 2000);
    const connector = { ...arrow({ x: 50, y: 50 }, { x: 350, y: 50 }) };
    connector.endBinding = { elementId: b.id, anchor: { mode: 'auto' }, gap: 0 };

    expect(connectorsToRefresh(doc(a, b, connector), new Set([a.id]))).toHaveLength(0);
  });

  it('skips a connector that is itself being dragged', () => {
    const b = rect(300, 0, 100, 100, 2000);
    const connector = { ...arrow({ x: 50, y: 50 }, { x: 350, y: 50 }) };
    connector.endBinding = { elementId: b.id, anchor: { mode: 'auto' }, gap: 0 };

    expect(connectorsToRefresh(doc(b, connector), new Set([b.id, connector.id]))).toHaveLength(0);
  });
});

describe('findBindTarget', () => {
  it('finds a shape near the point', () => {
    const target = rect(0, 0, 100, 100);
    expect(findBindTarget(doc(target), { x: 50, y: 50 }, new Set())?.id).toBe(target.id);
  });

  it('returns null when nothing is close', () => {
    expect(findBindTarget(doc(rect(0, 0, 100, 100)), { x: 900, y: 900 }, new Set())).toBeNull();
  });

  it('never binds to another connector', () => {
    // Binding arrows to arrows creates chains with no stable layout fixed point.
    const connector = arrow({ x: 0, y: 0 }, { x: 100, y: 100 }, 1000);
    expect(findBindTarget(doc(connector), { x: 50, y: 50 }, new Set())).toBeNull();
  });

  it('prefers the topmost overlapping shape', () => {
    const below = rect(0, 0, 100, 100, 1000);
    const above = rect(0, 0, 100, 100, 5000);
    expect(findBindTarget(doc(below, above), { x: 50, y: 50 }, new Set())?.id).toBe(above.id);
  });

  it('respects the exclusion set', () => {
    const target = rect(0, 0, 100, 100);
    expect(findBindTarget(doc(target), { x: 50, y: 50 }, new Set([target.id]))).toBeNull();
  });

  it('skips locked elements', () => {
    const locked = { ...rect(0, 0, 100, 100), locked: true };
    expect(findBindTarget(doc(locked), { x: 50, y: 50 }, new Set())).toBeNull();
  });
});

describe('resizeFrame', () => {
  it('keeps the opposite corner fixed when unrotated', () => {
    const frame = selectionFrame([rect(0, 0, 100, 100)]);
    const resized = resizeFrame(frame!, 'se', { x: 200, y: 150 }, { lockAspect: false, fromCenter: false });
    expect(resized.x).toBe(0);
    expect(resized.y).toBe(0);
    expect(resized.width).toBe(200);
    expect(resized.height).toBe(150);
  });

  it('keeps the anchor fixed at EVERY angle', () => {
    // The invariant that makes rotated resizing correct. Naive implementations
    // drift sideways as the shape grows because the anchor quietly moves.
    for (const angle of [0, 30, 45, 90, 137, 180, 271, 359]) {
      const element = { ...rect(100, 100, 200, 120), angle };
      const frame = selectionFrame([element])!;
      const anchorBefore = frameLocalToWorld(frame, { x: 0, y: 0 }); // nw, opposite of se

      const resized = resizeFrame(frame, 'se', { x: 400, y: 380 }, { lockAspect: false, fromCenter: false });
      const anchorAfter = frameLocalToWorld(resized, { x: 0, y: 0 });

      closeTo(anchorAfter.x, anchorBefore.x, 4);
      closeTo(anchorAfter.y, anchorBefore.y, 4);
    }
  });

  it('holds the anchor for every handle', () => {
    const opposites = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' } as const;
    const local = (handle: string, w: number, h: number) =>
      ({ nw: { x: 0, y: 0 }, n: { x: w / 2, y: 0 }, ne: { x: w, y: 0 }, e: { x: w, y: h / 2 },
         se: { x: w, y: h }, s: { x: w / 2, y: h }, sw: { x: 0, y: h }, w: { x: 0, y: h / 2 } })[handle]!;

    for (const [handle, anchor] of Object.entries(opposites)) {
      const element = { ...rect(50, 50, 200, 100), angle: 25 };
      const frame = selectionFrame([element])!;
      const before = frameLocalToWorld(frame, local(anchor, frame.width, frame.height));

      const resized = resizeFrame(frame, handle as 'se', { x: 320, y: 260 }, { lockAspect: false, fromCenter: false });
      const after = frameLocalToWorld(resized, local(anchor, resized.width, resized.height));

      closeTo(after.x, before.x, 3);
      closeTo(after.y, before.y, 3);
    }
  });

  it('preserves aspect ratio when locked', () => {
    const frame = selectionFrame([rect(0, 0, 200, 100)])!;
    const resized = resizeFrame(frame, 'se', { x: 400, y: 110 }, { lockAspect: true, fromCenter: false });
    closeTo(resized.width / resized.height, 2, 3);
  });

  it('resizes about the centre when asked', () => {
    const frame = selectionFrame([rect(0, 0, 100, 100)])!;
    const resized = resizeFrame(frame, 'se', { x: 100, y: 100 }, { lockAspect: false, fromCenter: true });
    closeTo(resized.x + resized.width / 2, 50);
    closeTo(resized.y + resized.height / 2, 50);
  });

  it('clamps rather than flipping past the anchor', () => {
    // The format guarantees positive dimensions, and mirroring mid-drag is a
    // surprising interaction no whiteboard offers.
    const frame = selectionFrame([rect(0, 0, 100, 100)])!;
    const resized = resizeFrame(frame, 'se', { x: -500, y: -500 }, { lockAspect: false, fromCenter: false });
    expect(resized.width).toBeGreaterThan(0);
    expect(resized.height).toBeGreaterThan(0);
  });
});

describe('applyFrameToElements', () => {
  it('maps a single-element frame exactly', () => {
    const element = rect(0, 0, 100, 100);
    const before = selectionFrame([element])!;
    const after = { ...before, x: 10, y: 20, width: 200, height: 50 };

    const [result] = applyFrameToElements([element], before, after);
    expect(result).toMatchObject({ x: 10, y: 20, width: 200, height: 50 });
  });

  it('scales path points with the element', () => {
    const connector = arrow({ x: 0, y: 0 }, { x: 100, y: 100 });
    const before = selectionFrame([connector])!;
    const after = { ...before, width: before.width * 2, height: before.height };

    const [result] = applyFrameToElements([connector], before, after) as [LinearElement];
    expect(result.points[1]?.[0]).toBeCloseTo(200, 1);
    expect(result.points[1]?.[1]).toBeCloseTo(100, 1);
  });

  it('scales members proportionally in a multi-selection', () => {
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(200, 0, 100, 100, 2000);
    const before = selectionFrame([a, b])!;   // 0..300 wide
    const after = { ...before, width: 600 };  // doubled

    const [scaledA, scaledB] = applyFrameToElements([a, b], before, after);
    expect(scaledA?.x).toBe(0);
    expect(scaledA?.width).toBe(200);
    expect(scaledB?.x).toBe(400);
  });
});

describe('rotateElements', () => {
  it('swings centres about the pivot as a rigid body', () => {
    // Rotating only the angles would spin each element in place instead of
    // turning the group.
    const a = rect(0, 0, 100, 100, 1000);
    const b = rect(200, 0, 100, 100, 2000);
    const pivot = { x: 150, y: 50 };

    const [rotatedA, rotatedB] = rotateElements([a, b], pivot, 180);
    closeTo(elementCenter(rotatedA!).x, 250, 3);
    closeTo(elementCenter(rotatedB!).x, 50, 3);
    expect(rotatedA?.angle).toBe(180);
  });

  it('normalises the resulting angle', () => {
    const [rotated] = rotateElements([{ ...rect(0, 0, 100, 100), angle: 350 }], { x: 50, y: 50 }, 20);
    expect(rotated?.angle).toBeCloseTo(10, 6);
  });
});

describe('rotationForPointer', () => {
  it('reads zero when the pointer is directly above the centre', () => {
    // The rotate handle sits above the shape, so that position must mean 0.
    const frame = selectionFrame([rect(0, 0, 100, 100)])!;
    closeTo(rotationForPointer(frame, { x: 50, y: -100 }), 0, 6);
  });

  it('reads 90 degrees when the pointer is to the right', () => {
    const frame = selectionFrame([rect(0, 0, 100, 100)])!;
    closeTo(rotationForPointer(frame, { x: 500, y: 50 }), 90, 6);
  });
});

describe('translateElements', () => {
  it('returns a copy when the delta is zero', () => {
    const element = rect(10, 10);
    const [result] = translateElements([element], 0, 0);
    expect(result).toEqual(element);
  });

  it('shifts every element', () => {
    const [a, b] = translateElements([rect(0, 0), rect(100, 100)], 5, -5);
    expect(a).toMatchObject({ x: 5, y: -5 });
    expect(b).toMatchObject({ x: 105, y: 95 });
  });
});

describe('selectionFrame', () => {
  it('uses the element’s own rotated frame for a single selection', () => {
    const element = { ...rect(10, 20, 100, 50), angle: 30 };
    expect(selectionFrame([element])).toMatchObject({ x: 10, y: 20, width: 100, height: 50, angle: 30, single: true });
  });

  it('uses an axis-aligned union for a multi-selection', () => {
    // There is no meaningful shared rotation, and inventing one makes group
    // resizing behave unpredictably.
    const frame = selectionFrame([{ ...rect(0, 0, 100, 100), angle: 45 }, rect(200, 0, 100, 100)]);
    expect(frame?.angle).toBe(0);
    expect(frame?.single).toBe(false);
  });

  it('returns null for an empty selection', () => {
    expect(selectionFrame([])).toBeNull();
  });
});
