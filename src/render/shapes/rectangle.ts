/**
 * Rectangle element.
 *
 * The simplest shape, and therefore the one worth reading first when learning
 * how a shape module is put together. Every other module follows this shape:
 * `create` for new elements, `normalize` for loading, `draw` and `hitTest` in
 * local coordinates, and a capability descriptor.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, Point, RectangleElement } from '../../model/types.ts';
import { DEFAULT_STYLE } from '../../model/defaults.ts';
import { newElementId } from '../../model/defaults.ts';
import { clamp } from '../../model/geometry.ts';
import { drawLabel, hasFill, numberOr, paintPath, roundedRectPath, tracePoints } from './shared.ts';
import { roughOutlineFor, roundedRectPoints } from '../rough.ts';

const DEFAULT_CORNER_RADIUS = 8;

export const rectangleDefinition: ElementDefinition<RectangleElement> = {
  type: 'rectangle',
  title: 'Rectangle',

  capabilities: {
    label: true,
    path: false,
    text: false,
    resizable: true,
    rotatable: true,
    bindable: true,
  },

  create(init: ElementInit): RectangleElement {
    return {
      id: newElementId(),
      type: 'rectangle',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? 100, 1),
      height: Math.max(init.height ?? 80, 1),
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
      cornerRadius: numberOr(init.cornerRadius, DEFAULT_CORNER_RADIUS),
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): RectangleElement {
    return {
      ...base,
      type: 'rectangle',
      cornerRadius: Math.max(0, numberOr(raw.cornerRadius, DEFAULT_CORNER_RADIUS)),
    };
  },

  roughOutline(el: RectangleElement) {
    return roundedRectPoints(el.width, el.height, el.cornerRadius);
  },

  draw(el: RectangleElement, { ctx }: RenderContext): void {
    const rough = roughOutlineFor(el);
    if (rough) tracePoints(ctx, rough, true);
    else roundedRectPath(ctx, el.width, el.height, el.cornerRadius);
    paintPath(ctx, el.style);
    drawLabel(ctx, el);
  },

  /**
   * A filled rectangle is hit anywhere inside it; an unfilled one only near its
   * outline, so you can click "through" the hollow middle to reach whatever sits
   * behind. This matches how every drawing tool behaves and is the single most
   * important detail in making selection feel right.
   */
  hitTest(el: RectangleElement, local: Point, tolerance: number): boolean {
    const inside =
      local.x >= -tolerance &&
      local.y >= -tolerance &&
      local.x <= el.width + tolerance &&
      local.y <= el.height + tolerance;

    if (!inside) return false;
    if (hasFill(el.style) || (el.label && el.label.text !== '')) return true;

    const r = clamp(el.cornerRadius, 0, Math.min(el.width, el.height) / 2);
    const nearOutline =
      local.x <= tolerance + r ||
      local.y <= tolerance + r ||
      local.x >= el.width - tolerance - r ||
      local.y >= el.height - tolerance - r;

    return nearOutline;
  },
};

registerElement(rectangleDefinition);
