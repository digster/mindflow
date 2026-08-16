/**
 * Hand-drawn jitter for `style.roughness`.
 *
 * The field has existed since 1.0.0, reserved and always written as `0`. What
 * kept it unimplemented was not the drawing but the *specification*: jitter needs
 * a seed, and an unspecified seed means two conforming renderers disagree about a
 * file that validates perfectly — precisely the failure this format exists to
 * prevent.
 *
 * Two decisions follow from that, and both are published in
 * `docs/07-rendering.md`:
 *
 * 1. **The seed is derived from the element's `id`,** not stored. Ids are already
 *    in the file, already stable across a save/load round trip, and already
 *    re-minted when an element is duplicated — so a copy gets its own squiggle,
 *    which is the behaviour you want anyway. Storing a seed field would have been
 *    a structural change to every element for a value that can be computed.
 *
 * 2. **This module produces POINTS, not paint.** The canvas renderer and the SVG
 *    exporter are two independent renderers (see LEARNINGS.md), and the only way
 *    to guarantee they draw the same squiggle is to have them consume the same
 *    generated geometry. It also makes the whole thing testable in the node
 *    environment, with no DOM.
 *
 * The algorithm is deliberately simple and fully specified. It is not trying to
 * reproduce any particular library's aesthetic; it is trying to be reproducible.
 */

import type { MindflowElement, Point } from '../model/types.ts';
import { findDefinition } from '../model/registry.ts';

/** Roughness values at or below this render as clean geometry. */
export const ROUGHNESS_EPSILON = 0.001;

/** Scene units of displacement at `roughness = 1`, before length scaling. */
const BASE_AMPLITUDE = 1.6;

/** Target spacing between generated samples along an edge, in scene units. */
const SAMPLE_SPACING = 24;

/** Samples per edge stay within these bounds regardless of its length. */
const MIN_SAMPLES = 2;
const MAX_SAMPLES = 32;

/**
 * FNV-1a, 32-bit. Chosen because it is short enough to restate in the docs in
 * full, which a reader needs in order to reproduce the output exactly.
 */
export function hashSeed(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    // hash * 16777619, kept in 32 bits without relying on float precision.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Mulberry32. A tiny, well-distributed PRNG whose constants fit in the spec.
 *
 * Returns a generator of values in `[0, 1)`.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** How many samples an edge of the given length gets. */
function sampleCount(length: number): number {
  return Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(length / SAMPLE_SPACING) + 1));
}

/**
 * Displaces a polyline, returning a new point list.
 *
 * Each edge is subdivided into evenly spaced samples, and every sample except
 * the shared endpoints is pushed perpendicular to the edge by a random amount in
 * `[−amplitude, +amplitude]`. Endpoints are held so that corners stay corners
 * and closed shapes stay closed — a rectangle drawn this way still reads as a
 * rectangle, which is the difference between "hand-drawn" and "damaged".
 *
 * `random` is passed in rather than seeded here so that one element's whole
 * outline is drawn from a single stream: two edges of the same shape must not
 * accidentally share a sequence.
 */
export function roughPolyline(
  points: readonly Point[],
  roughness: number,
  random: () => number,
  closed = false,
): Point[] {
  if (points.length < 2) return [...points];

  const amplitude = BASE_AMPLITUDE * roughness;
  const result: Point[] = [];
  const last = closed ? points.length : points.length - 1;

  for (let i = 0; i < last; i += 1) {
    const from = points[i] as Point;
    const to = points[(i + 1) % points.length] as Point;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
      result.push({ ...from });
      continue;
    }

    // Unit normal, for displacing across the edge rather than along it.
    const nx = -dy / length;
    const ny = dx / length;

    const samples = sampleCount(length);
    // The final sample of each edge is the next edge's first, so it is emitted
    // by that edge instead — otherwise every vertex would appear twice.
    for (let s = 0; s < samples; s += 1) {
      const t = s / (samples - 1);
      const onEdge = { x: from.x + dx * t, y: from.y + dy * t };

      // Vertices are never displaced: they are where two edges meet, and moving
      // one would tear the outline open.
      if (s === 0) {
        result.push(onEdge);
        continue;
      }
      if (s === samples - 1) {
        if (!closed && i === last - 1) result.push(onEdge);
        continue;
      }

      const offset = (random() * 2 - 1) * amplitude;
      result.push({ x: onEdge.x + nx * offset, y: onEdge.y + ny * offset });
    }
  }

  if (closed && result.length > 0) result.push({ ...(result[0] as Point) });
  return result;
}

/**
 * A closed polygon approximating an ellipse.
 *
 * Curves are sampled to a polyline before any displacement, so that exactly one
 * jitter rule exists. A renderer that approximated the ellipse differently would
 * produce a different outline, so the sample count is fixed by the same spacing
 * rule as any other edge, applied to the perimeter.
 */
export function ellipsePoints(width: number, height: number): Point[] {
  const rx = width / 2;
  const ry = height / 2;
  // Ramanujan's first approximation — close enough at these scales, and cheap.
  const perimeter = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)));
  const segments = Math.max(8, Math.min(64, Math.ceil(perimeter / SAMPLE_SPACING)));

  const points: Point[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push({ x: rx + Math.cos(angle) * rx, y: ry + Math.sin(angle) * ry });
  }
  return points;
}

/**
 * A closed polygon tracing a rounded rectangle's outline.
 *
 * Corner arcs are sampled rather than kept as arcs, for the same reason the
 * ellipse is: one displacement rule, applied to polylines, is reproducible by
 * any reader. `radius` is clamped to half the shorter side, matching
 * `roundedRectPath`.
 */
export function roundedRectPoints(width: number, height: number, radius: number): Point[] {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  if (r <= 0) {
    return [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
  }

  // Four samples per quarter-turn keeps a corner recognisably round without
  // burying the straight edges in vertices.
  const perCorner = 4;
  const corners: { cx: number; cy: number; from: number }[] = [
    { cx: width - r, cy: r, from: -Math.PI / 2 },
    { cx: width - r, cy: height - r, from: 0 },
    { cx: r, cy: height - r, from: Math.PI / 2 },
    { cx: r, cy: r, from: Math.PI },
  ];

  const points: Point[] = [];
  for (const { cx, cy, from } of corners) {
    for (let i = 0; i <= perCorner; i += 1) {
      const angle = from + (i / perCorner) * (Math.PI / 2);
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
  }
  return points;
}

/** True when this style asks for hand-drawn rendering. */
export function isRough(roughness: number): boolean {
  return roughness > ROUGHNESS_EPSILON;
}

/** The PRNG stream for one element, seeded from its id. */
export function elementRandom(id: string): () => number {
  return mulberry32(hashSeed(id));
}

/**
 * The displaced outline for an element, or `null` when its type has no
 * hand-drawn form.
 *
 * The single place jitter is applied. Both renderers call this, which is what
 * makes "the PNG and the SVG show the same squiggle" true by construction rather
 * than by two implementations happening to agree.
 */
export function roughOutlineFor(el: MindflowElement): Point[] | null {
  if (!isRough(el.style.roughness)) return null;
  const clean = findDefinition(el.type)?.roughOutline?.(el);
  if (!clean) return null;
  return roughPolyline(clean, el.style.roughness, elementRandom(el.id), true);
}
