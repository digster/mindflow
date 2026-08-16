/**
 * Ellipse element.
 *
 * Inscribed in the element's box, so a square box yields a circle. Carrying no
 * fields of its own, it is the minimal example of a shape module.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, EllipseElement, Point } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { distanceToEllipseOutline, pointInEllipse } from '../../model/geometry.ts';
import { drawLabel, hasFill, paintPath, tracePoints } from './shared.ts';
import { ellipsePoints, roughOutlineFor } from '../rough.ts';

export const ellipseDefinition: ElementDefinition<EllipseElement> = {
  type: 'ellipse',
  title: 'Ellipse',

  capabilities: {
    label: true,
    path: false,
    text: false,
    resizable: true,
    rotatable: true,
    bindable: true,
  },

  create(init: ElementInit): EllipseElement {
    return {
      id: newElementId(),
      type: 'ellipse',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? 100, 1),
      height: Math.max(init.height ?? 100, 1),
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
    };
  },

  normalize(_raw: Record<string, unknown>, base: BaseElement): EllipseElement {
    return { ...base, type: 'ellipse' };
  },

  roughOutline(el: EllipseElement) {
    // Sampled to a polygon first, so one displacement rule covers every shape.
    return ellipsePoints(el.width, el.height);
  },

  draw(el: EllipseElement, { ctx }: RenderContext): void {
    const rough = roughOutlineFor(el);
    if (rough) {
      tracePoints(ctx, rough, true);
    } else {
      ctx.beginPath();
      ctx.ellipse(el.width / 2, el.height / 2, el.width / 2, el.height / 2, 0, 0, Math.PI * 2);
    }
    paintPath(ctx, el.style);
    drawLabel(ctx, el);
  },

  hitTest(el: EllipseElement, local: Point, tolerance: number): boolean {
    if (hasFill(el.style) || (el.label && el.label.text !== '')) {
      // Grow the test ellipse by the tolerance so the edge stays grabbable.
      return pointInEllipse(
        { x: local.x + tolerance, y: local.y + tolerance },
        el.width + tolerance * 2,
        el.height + tolerance * 2,
      );
    }
    return distanceToEllipseOutline(local, el.width, el.height) <= tolerance;
  },

  /**
   * Solves `(t·dx/rx)² + (t·dy/ry)² = 1` for `t` — where the ray leaves the
   * ellipse rather than its bounding box.
   *
   * This used to be a `type === 'ellipse'` branch inside `geometry.ts`, the one
   * place outside this directory that switched on an element type.
   */
  outlineIntersect(el: EllipseElement, direction: Point): Point {
    const rx = el.width / 2;
    const ry = el.height / 2;
    const denominator = Math.hypot(direction.x / rx, direction.y / ry);
    const t = denominator === 0 ? 0 : 1 / denominator;
    return { x: rx + direction.x * t, y: ry + direction.y * t };
  },
};

registerElement(ellipseDefinition);
