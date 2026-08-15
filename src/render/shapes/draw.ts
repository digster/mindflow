/**
 * Freehand stroke element.
 *
 * Captured from pointer events, simplified on commit (see `simplifyPoints` in
 * `model/geometry.ts`), then rendered as a smoothed path.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, DrawElement, Point, PointTuple } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { distanceToPolyline, pressureOf } from '../../model/geometry.ts';
import { booleanOr, hasStroke, normalizePoints } from './shared.ts';

/**
 * Traces a stroke as a quadratic spline through the midpoints of consecutive
 * captured points.
 *
 * SMOOTHING — specified in `docs/07-rendering.md`:
 * Start at the first point. For each interior point `p[i]`, draw a quadratic
 * Bézier with `p[i]` as control point and the midpoint of `p[i]`–`p[i+1]` as
 * end point. Finish with a line to the final point.
 *
 * This is the same rule used for curved connectors. Using one smoothing
 * algorithm everywhere means an external renderer only has to implement it once.
 */
function traceStroke(ctx: CanvasRenderingContext2D, points: readonly PointTuple[]): void {
  const first = points[0];
  if (!first) return;

  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);

  if (points.length === 1) {
    // A single tap still deserves a mark: a zero-length line with a round cap
    // renders as a dot.
    ctx.lineTo(first[0], first[1]);
    return;
  }

  for (let i = 1; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];
    if (!current || !next) continue;
    ctx.quadraticCurveTo(
      current[0],
      current[1],
      (current[0] + next[0]) / 2,
      (current[1] + next[1]) / 2,
    );
  }

  const last = points[points.length - 1];
  if (last) ctx.lineTo(last[0], last[1]);
}

/**
 * Draws a pressure-varying stroke as a run of individually-stroked segments.
 *
 * Canvas has no variable-width stroke, so the usual alternatives are to build an
 * outline polygon (accurate, considerably more code) or to stroke short segments
 * at interpolated widths (approximate, very cheap). We take the second: with
 * round caps and joins the seams are invisible, and freehand ink is forgiving.
 */
function strokeWithPressure(
  ctx: CanvasRenderingContext2D,
  points: readonly PointTuple[],
  baseWidth: number,
): void {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    const pressure = (pressureOf(a) + pressureOf(b)) / 2;
    // Map pressure 0..1 onto 0.4x..1.4x of the nominal width, so a stroke never
    // vanishes entirely at low pressure.
    ctx.lineWidth = baseWidth * (0.4 + pressure);
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
    ctx.stroke();
  }
}

export const drawDefinition: ElementDefinition<DrawElement> = {
  type: 'draw',
  title: 'Draw',

  capabilities: {
    label: false,
    path: true,
    text: false,
    resizable: true,
    rotatable: true,
    bindable: false,
  },

  create(init: ElementInit): DrawElement {
    return {
      id: newElementId(),
      type: 'draw',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? 1, 1),
      height: Math.max(init.height ?? 1, 1),
      angle: 0,
      zIndex: init.zIndex,
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      style: { ...DEFAULT_STYLE, ...(init.style as object | undefined) },
      label: null,
      meta: {},
      points: (init.points as PointTuple[] | undefined) ?? [[0, 0]],
      pressureSensitive: booleanOr(init.pressureSensitive, false),
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): DrawElement {
    const points = normalizePoints(raw.points) as PointTuple[];
    return {
      ...base,
      type: 'draw',
      points: points.length > 0 ? points : [[0, 0]],
      pressureSensitive: booleanOr(raw.pressureSensitive, false),
    };
  },

  draw(el: DrawElement, { ctx }: RenderContext): void {
    if (!hasStroke(el.style)) return;

    ctx.save();
    ctx.strokeStyle = el.style.stroke;
    ctx.lineWidth = el.style.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]); // Freehand ink ignores strokeStyle dashes by design.

    if (el.pressureSensitive && el.points.length > 1) {
      strokeWithPressure(ctx, el.points, el.style.strokeWidth);
    } else {
      traceStroke(ctx, el.points);
      ctx.stroke();
    }

    ctx.restore();
  },

  hitTest(el: DrawElement, local: Point, tolerance: number): boolean {
    const points = el.points.map((p) => ({ x: p[0], y: p[1] }));
    if (points.length === 1) {
      const only = points[0];
      if (!only) return false;
      return Math.hypot(local.x - only.x, local.y - only.y) <= tolerance + el.style.strokeWidth;
    }
    return distanceToPolyline(local, points) <= tolerance + el.style.strokeWidth / 2;
  },
};

registerElement(drawDefinition);
