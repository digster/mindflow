/**
 * Linear elements: `line` and `arrow`.
 *
 * These share one implementation and differ only in their default arrowheads.
 * An `arrow` whose arrowheads are both `"none"` is visually identical to a
 * `line`, which is intentional — the type records what the author *meant*, and
 * the arrowhead fields record what is actually drawn.
 *
 * This is also where connector *binding* lives, the feature that makes the tool
 * a flow-diagramming tool rather than a drawing program: an endpoint attached to
 * a shape re-routes automatically whenever that shape moves.
 *
 * Every computed geometry decision in this file — curve smoothing, elbow
 * routing, arrowhead orientation — is mirrored in `docs/07-rendering.md`. A file
 * containing a curved, bound arrow cannot be drawn correctly by an external tool
 * without those algorithms, so they are part of the published contract rather
 * than an implementation detail.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type {
  Arrowhead,
  BaseElement,
  Binding,
  LinearElement,
  Point,
  PointTuple,
} from '../../model/types.ts';
import { ARROWHEADS, CURVE_STYLES } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { distanceToPolyline } from '../../model/geometry.ts';
import {
  applyStroke,
  drawLabel,
  enumOr,
  hasStroke,
  isRecord,
  normalizePoints,
  numberOr,
  stringOr,
} from './shared.ts';

/** Arrowhead size relative to stroke width, with a floor so hairlines stay visible. */
function arrowheadSize(strokeWidth: number): number {
  return Math.max(strokeWidth * 4, 10);
}

function toPoints(tuples: readonly PointTuple[]): Point[] {
  return tuples.map((t) => ({ x: t[0], y: t[1] }));
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Expands the stored vertices into the polyline that is actually drawn.
 *
 * ELBOW ROUTING — specified, not incidental:
 * For each consecutive pair of vertices, one intermediate corner is inserted.
 * The leg with the larger absolute delta is travelled first, so the elbow turns
 * late rather than early:
 *
 *   |dx| >= |dy|  →  horizontal first, corner at (b.x, a.y)
 *   |dx| <  |dy|  →  vertical first,   corner at (a.x, b.y)
 *
 * A pair that is already axis-aligned inserts no corner.
 */
function routedPoints(el: LinearElement): Point[] {
  const points = toPoints(el.points);
  if (el.curve !== 'elbow' || points.length < 2) return points;

  const routed: Point[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (!a || !b) continue;
    routed.push(a);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx !== 0 && dy !== 0) {
      routed.push(Math.abs(dx) >= Math.abs(dy) ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    }
  }
  const last = points[points.length - 1];
  if (last) routed.push(last);
  return routed;
}

/**
 * Traces the connector's path into the canvas context.
 *
 * CURVE SMOOTHING — specified, not incidental:
 * For `curve: "curved"` with three or more vertices, the path starts at the
 * first vertex, then draws a quadratic Bézier for each interior vertex `p[i]`
 * using `p[i]` as the control point and the midpoint of `p[i]`–`p[i+1]` as the
 * end point, finishing with a straight segment to the last vertex. The curve
 * therefore passes through the midpoints and is merely *pulled toward* the
 * interior vertices, which is what keeps it smooth at every joint.
 *
 * With exactly two vertices there is no interior vertex, so a curved connector
 * is drawn as a straight line.
 */
function tracePath(ctx: CanvasRenderingContext2D, el: LinearElement, points: Point[]): void {
  ctx.beginPath();
  const first = points[0];
  if (!first) return;
  ctx.moveTo(first.x, first.y);

  if (el.curve === 'curved' && points.length > 2) {
    for (let i = 1; i < points.length - 1; i++) {
      const current = points[i];
      const next = points[i + 1];
      if (!current || !next) continue;
      ctx.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    const last = points[points.length - 1];
    if (last) ctx.lineTo(last.x, last.y);
    return;
  }

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p) ctx.lineTo(p.x, p.y);
  }
}

/**
 * Draws one arrowhead at `tip`, pointing away from `from`.
 *
 * The direction is taken from the straight line between the last two routed
 * vertices. On a curved connector that is an approximation of the true tangent,
 * but the error is imperceptible at realistic curvatures and it keeps the
 * algorithm trivially reproducible by other tools.
 */
function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  kind: Arrowhead,
  tip: Point,
  from: Point,
  strokeWidth: number,
  color: string,
): void {
  if (kind === 'none') return;

  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const size = arrowheadSize(strokeWidth);
  const spread = Math.PI / 7; // ~26°, a visually standard arrow.

  ctx.save();
  ctx.setLineDash([]); // Arrowheads are never dashed, even on a dashed line.
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const wingA = { x: tip.x - size * Math.cos(angle - spread), y: tip.y - size * Math.sin(angle - spread) };
  const wingB = { x: tip.x - size * Math.cos(angle + spread), y: tip.y - size * Math.sin(angle + spread) };

  switch (kind) {
    case 'arrow': {
      // Two open strokes — the classic line arrow.
      ctx.beginPath();
      ctx.moveTo(wingA.x, wingA.y);
      ctx.lineTo(tip.x, tip.y);
      ctx.lineTo(wingB.x, wingB.y);
      ctx.stroke();
      break;
    }
    case 'triangle': {
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(wingA.x, wingA.y);
      ctx.lineTo(wingB.x, wingB.y);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case 'dot': {
      ctx.beginPath();
      ctx.arc(tip.x, tip.y, Math.max(strokeWidth * 1.6, 4), 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case 'bar': {
      const half = size / 2;
      ctx.beginPath();
      ctx.moveTo(tip.x - half * Math.cos(angle - Math.PI / 2), tip.y - half * Math.sin(angle - Math.PI / 2));
      ctx.lineTo(tip.x + half * Math.cos(angle - Math.PI / 2), tip.y + half * Math.sin(angle - Math.PI / 2));
      ctx.stroke();
      break;
    }
  }
  ctx.restore();
}

function normalizeBinding(raw: unknown): Binding | null {
  if (!isRecord(raw)) return null;
  const elementId = stringOr(raw.elementId, '');
  if (elementId === '') return null;

  const anchor = isRecord(raw.anchor) ? raw.anchor : {};
  const mode = anchor.mode === 'fixed' ? 'fixed' : 'auto';

  return {
    elementId,
    anchor:
      mode === 'fixed'
        ? { mode: 'fixed', u: numberOr(anchor.u, 0.5), v: numberOr(anchor.v, 0.5) }
        : { mode: 'auto' },
    gap: Math.max(0, numberOr(raw.gap, 0)),
  };
}

export const linearDefinition = (type: 'line' | 'arrow'): ElementDefinition<LinearElement> => ({
  type,
  title: type === 'arrow' ? 'Arrow' : 'Line',

  capabilities: {
    label: true,
    path: true,
    text: false,
    resizable: true,
    rotatable: true,
    // A connector cannot be the target of another connector. Permitting it would
    // create binding chains whose layout has no stable fixed point.
    bindable: false,
  },

  create(init: ElementInit): LinearElement {
    const points = (init.points as PointTuple[] | undefined) ?? [
      [0, 0],
      [init.width ?? 100, init.height ?? 0],
    ];
    return {
      id: newElementId(),
      type,
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? 100, 1),
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
      points,
      startArrowhead: 'none',
      endArrowhead: type === 'arrow' ? 'arrow' : 'none',
      curve: 'straight',
      startBinding: null,
      endBinding: null,
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): LinearElement {
    let points = normalizePoints(raw.points) as PointTuple[];
    // A connector needs two endpoints to exist at all. Rather than reject the
    // element, synthesise a degenerate one spanning its declared box — the
    // author's intent is recoverable, and validation reports the problem.
    if (points.length < 2) {
      points = [
        [0, 0],
        [base.width, base.height],
      ];
    }
    return {
      ...base,
      type,
      points,
      startArrowhead: enumOr(raw.startArrowhead, ARROWHEADS, 'none'),
      endArrowhead: enumOr(raw.endArrowhead, ARROWHEADS, type === 'arrow' ? 'arrow' : 'none'),
      curve: enumOr(raw.curve, CURVE_STYLES, 'straight'),
      startBinding: normalizeBinding(raw.startBinding),
      endBinding: normalizeBinding(raw.endBinding),
    };
  },

  draw(el: LinearElement, { ctx }: RenderContext): void {
    const points = routedPoints(el);
    if (points.length < 2) return;

    if (hasStroke(el.style)) {
      applyStroke(ctx, el.style);
      ctx.lineCap = 'round';
      tracePath(ctx, el, points);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const first = points[0];
    const second = points[1];
    const last = points[points.length - 1];
    const penultimate = points[points.length - 2];

    if (first && second) {
      drawArrowhead(ctx, el.startArrowhead, first, second, el.style.strokeWidth, el.style.stroke);
    }
    if (last && penultimate) {
      drawArrowhead(ctx, el.endArrowhead, last, penultimate, el.style.strokeWidth, el.style.stroke);
    }

    drawLabel(ctx, el);
  },

  /**
   * A connector is a thin thing to click. The tolerance passed in is already
   * zoom-compensated, and we widen it further by half the stroke width so thick
   * lines are grabbable across their full painted area.
   */
  hitTest(el: LinearElement, local: Point, tolerance: number): boolean {
    const points = routedPoints(el);
    if (points.length < 2) return false;
    return distanceToPolyline(local, points) <= tolerance + el.style.strokeWidth / 2;
  },
});

registerElement(linearDefinition('line'));
registerElement(linearDefinition('arrow'));
