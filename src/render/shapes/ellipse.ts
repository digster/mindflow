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
    connector: false,
    frame: false,
    file: false,
    fillable: true,
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
   * Where the ray `origin + t·direction` leaves the ellipse rather than its
   * bounding box.
   *
   * With `p = origin − centre`, substituting the ray into
   * `(x/rx)² + (y/ry)² = 1` gives the quadratic `A·t² + B·t + C = 0`:
   *
   *     A = (dx/rx)² + (dy/ry)²
   *     B = 2·(px·dx/rx² + py·dy/ry²)
   *     C = (px/rx)² + (py/ry)² − 1
   *
   * The LARGER root is the exit. From the centre, `B = 0` and `C = −1`, which
   * reduces to the `1 / hypot(dx/rx, dy/ry)` that 1.5.0 and earlier specified.
   * No real root, or an exit behind the origin, means the ray misses: only
   * possible for a focus point in a corner of the box, outside the curve.
   *
   * This used to be a `type === 'ellipse'` branch inside `geometry.ts`, the one
   * place outside this directory that switched on an element type.
   */
  outlineIntersect(el: EllipseElement, direction: Point, origin: Point): Point | null {
    const rx = el.width / 2;
    const ry = el.height / 2;
    const px = origin.x - rx;
    const py = origin.y - ry;

    const a = (direction.x / rx) ** 2 + (direction.y / ry) ** 2;
    const b = 2 * ((px * direction.x) / (rx * rx) + (py * direction.y) / (ry * ry));
    const c = (px / rx) ** 2 + (py / ry) ** 2 - 1;
    const discriminant = b * b - 4 * a * c;
    if (a === 0 || discriminant < 0) return null;

    const t = (-b + Math.sqrt(discriminant)) / (2 * a);
    if (t < 0) return null;
    return { x: origin.x + direction.x * t, y: origin.y + direction.y * t };
  },
};

registerElement(ellipseDefinition);
