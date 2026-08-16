/**
 * Hand-drawn rendering.
 *
 * The claim these tests defend is not "it looks hand-drawn" — that is a matter
 * of taste and no test can hold it. It is that **the same file produces the same
 * outline**, in this renderer and in any other that follows
 * `docs/07-rendering.md`. Without that, a rough board is a board only MindFlow
 * can draw, which is the one thing this format exists to prevent.
 *
 * The constants are pinned deliberately. They are published, so changing one is
 * a format change and should fail here first.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { getDefinition } from '../../src/model/registry.ts';
import {
  ROUGHNESS_EPSILON,
  ellipsePoints,
  hashSeed,
  isRough,
  mulberry32,
  roughOutlineFor,
  roughPolyline,
  roundedRectPoints,
} from '../../src/render/rough.ts';
import type { MindflowElement, Point } from '../../src/model/types.ts';

function rect(overrides: Partial<MindflowElement> = {}): MindflowElement {
  const base = getDefinition('rectangle').create({ x: 0, y: 0, width: 200, height: 120, zIndex: 1000 });
  return { ...base, ...overrides } as MindflowElement;
}

/** Sets `roughness` on a copy of `element`. */
function withRoughness(element: MindflowElement, roughness: number): MindflowElement {
  return { ...element, style: { ...element.style, roughness } } as MindflowElement;
}

describe('hashSeed', () => {
  it('is deterministic', () => {
    expect(hashSeed('el_q2WikW58Aw')).toBe(hashSeed('el_q2WikW58Aw'));
  });

  it('separates ids that differ by one character', () => {
    expect(hashSeed('el_aaaaaaaaaa')).not.toBe(hashSeed('el_aaaaaaaaab'));
  });

  it('is a 32-bit unsigned integer', () => {
    const seed = hashSeed('el_q2WikW58Aw');
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThanOrEqual(0xffffffff);
  });

  it('matches the reference values published in docs/07-rendering.md', () => {
    // The docs quote these so an external implementer can check their hash and
    // PRNG in isolation, before trying to render anything. Changing either
    // number is a format change and must fail here first.
    expect(hashSeed('')).toBe(0x811c9dc5);
    expect(hashSeed('el_q2WikW58Aw')).toBe(3578049225);
  });
});

describe('mulberry32', () => {
  it('produces the same stream from the same seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it('matches the reference stream published in docs/07-rendering.md', () => {
    const random = mulberry32(hashSeed('el_q2WikW58Aw'));
    expect([random(), random(), random()].map((v) => Number(v.toFixed(10)))).toEqual([
      0.8391014873, 0.2622082005, 0.6914683564,
    ]);
  });

  it('stays within [0, 1)', () => {
    const random = mulberry32(hashSeed('el_sample0001'));
    for (let i = 0; i < 1000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe('isRough', () => {
  it('treats zero as clean', () => {
    expect(isRough(0)).toBe(false);
  });

  it('ignores a value below the epsilon', () => {
    expect(isRough(ROUGHNESS_EPSILON / 2)).toBe(false);
  });

  it('accepts an ordinary value', () => {
    expect(isRough(1)).toBe(true);
  });
});

describe('roughPolyline', () => {
  const square: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
  ];

  it('keeps the original vertices exactly', () => {
    // Displacing a corner would tear the outline open where two edges meet.
    const result = roughPolyline(square, 1, mulberry32(1), true);
    for (const vertex of square) {
      expect(result.some((p) => p.x === vertex.x && p.y === vertex.y)).toBe(true);
    }
  });

  it('closes a closed polyline', () => {
    const result = roughPolyline(square, 1, mulberry32(1), true);
    expect(result[0]).toEqual(result[result.length - 1]);
  });

  it('displaces the interior samples', () => {
    const result = roughPolyline(square, 1, mulberry32(1), true);
    expect(result.length).toBeGreaterThan(square.length);
  });

  it('displaces further as roughness increases', () => {
    const spread = (roughness: number) => {
      const points = roughPolyline(square, roughness, mulberry32(7), true);
      // Distance of the worst sample from the top edge, which lies at y = 0.
      return Math.max(...points.slice(0, 5).map((p) => Math.abs(p.y)));
    };
    expect(spread(2)).toBeGreaterThan(spread(0.5));
  });

  it('is degenerate-safe', () => {
    expect(roughPolyline([], 1, mulberry32(1), true)).toEqual([]);
    expect(roughPolyline([{ x: 1, y: 2 }], 1, mulberry32(1), true)).toEqual([{ x: 1, y: 2 }]);
    // A zero-length edge must not divide by zero.
    const degenerate = roughPolyline(
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
      1,
      mulberry32(1),
      false,
    );
    expect(degenerate.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
  });
});

describe('roundedRectPoints', () => {
  it('is a plain rectangle at radius 0', () => {
    expect(roundedRectPoints(100, 60, 0)).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 60 },
      { x: 0, y: 60 },
    ]);
  });

  it('clamps the radius to half the shorter side', () => {
    // Matches roundedRectPath: an absurd radius yields a stadium, not garbage.
    const points = roundedRectPoints(100, 60, 999);
    expect(points.every((p) => p.x >= -0.001 && p.x <= 100.001)).toBe(true);
    expect(points.every((p) => p.y >= -0.001 && p.y <= 60.001)).toBe(true);
  });
});

describe('ellipsePoints', () => {
  it('stays inside the box', () => {
    const points = ellipsePoints(200, 100);
    expect(points.every((p) => p.x >= -0.001 && p.x <= 200.001)).toBe(true);
    expect(points.every((p) => p.y >= -0.001 && p.y <= 100.001)).toBe(true);
  });

  it('uses more segments for a larger ellipse', () => {
    expect(ellipsePoints(800, 800).length).toBeGreaterThan(ellipsePoints(40, 40).length);
  });
});

describe('roughOutlineFor', () => {
  it('returns null for a clean element', () => {
    expect(roughOutlineFor(rect())).toBeNull();
  });

  /**
   * The load-bearing test. The seed comes from the element id, so the same saved
   * element must draw identically on every open — and, crucially, identically in
   * the canvas renderer and the SVG exporter, which both call this.
   */
  it('is reproducible from the element id alone', () => {
    const element = withRoughness(rect({ id: 'el_Reproduce01' } as Partial<MindflowElement>), 1.5);
    expect(roughOutlineFor(element)).toEqual(roughOutlineFor({ ...element }));
  });

  it('gives two elements different outlines', () => {
    const a = withRoughness(rect({ id: 'el_FirstShape1' } as Partial<MindflowElement>), 1.5);
    const b = withRoughness(rect({ id: 'el_SecondShape' } as Partial<MindflowElement>), 1.5);
    expect(roughOutlineFor(a)).not.toEqual(roughOutlineFor(b));
  });

  it('survives a JSON round trip', () => {
    // The seed must depend on nothing that serialisation drops.
    const element = withRoughness(rect({ id: 'el_RoundTrip01' } as Partial<MindflowElement>), 1);
    const reloaded = JSON.parse(JSON.stringify(element)) as MindflowElement;
    expect(roughOutlineFor(reloaded)).toEqual(roughOutlineFor(element));
  });

  it('returns null for a type with no hand-drawn form', () => {
    // Content containers render cleanly whatever roughness says.
    const sticky = getDefinition('sticky').create({ x: 0, y: 0, zIndex: 1000 }) as MindflowElement;
    expect(roughOutlineFor(withRoughness(sticky, 2))).toBeNull();
  });

  it('covers every shape that declares an outline', () => {
    for (const type of ['rectangle', 'ellipse', 'diamond']) {
      const element = getDefinition(type).create({ x: 0, y: 0, zIndex: 1000 }) as MindflowElement;
      const outline = roughOutlineFor(withRoughness(element, 1));
      expect(outline, `${type} should have a rough outline`).not.toBeNull();
      expect(outline!.length).toBeGreaterThan(3);
    }
  });

  it('does not depend on document state', () => {
    // Nothing about the board may leak into the seed, or two boards containing
    // the same element would draw it differently.
    createDocument();
    const element = withRoughness(rect({ id: 'el_Isolated001' } as Partial<MindflowElement>), 1);
    const first = roughOutlineFor(element);
    createDocument();
    expect(roughOutlineFor(element)).toEqual(first);
  });
});
