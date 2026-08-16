/**
 * Sticky note element.
 *
 * A filled rounded box with text inside — visually close to a rectangle carrying
 * a label, but modelled as its own type on purpose. See the note on
 * `StickyElement` in `model/types.ts`: keeping it distinct means a program
 * reading a board can answer "what are the sticky notes here?" from the data
 * rather than by guessing from styling.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, Point, StickyElement } from '../../model/types.ts';
import { FONT_FAMILIES, TEXT_ALIGNS, VERTICAL_ALIGNS } from '../../model/types.ts';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_STYLE,
  DEFAULT_TEXT_COLOR,
  PALETTE,
  newElementId,
} from '../../model/defaults.ts';
import { clamp } from '../../model/geometry.ts';
import {
  drawTextBlock,
  enumOr,
  hasStroke,
  layoutText,
  numberOr,
  paintPath,
  roundedRectPath,
  stringOr,
} from './shared.ts';

export const STICKY_DEFAULT_SIZE = 160;
const STICKY_FONT_SIZE = 16;
const STICKY_PADDING = 12;
const STICKY_CORNER_RADIUS = 4;

export const stickyDefinition: ElementDefinition<StickyElement> = {
  type: 'sticky',
  title: 'Sticky note',

  capabilities: {
    label: false, // A sticky owns its text directly via `text`.
    path: false,
    text: true,
    resizable: true,
    rotatable: true,
    bindable: true,
  },

  create(init: ElementInit): StickyElement {
    return {
      id: newElementId(),
      type: 'sticky',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? STICKY_DEFAULT_SIZE, 1),
      height: Math.max(init.height ?? STICKY_DEFAULT_SIZE, 1),
      angle: 0,
      zIndex: init.zIndex,
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      frameId: null,
      style: {
        ...DEFAULT_STYLE,
        // Notes read as paper, not as outlined boxes, so the default has a fill
        // and no stroke — the inverse of every other shape's default.
        fill: stringOr(init.fill, PALETTE.sticky[0]),
        fillStyle: 'solid',
        stroke: 'transparent',
        strokeWidth: 0,
        ...(init.style as object | undefined),
      },
      label: null,
      meta: {},
      text: stringOr(init.text, ''),
      fontFamily: enumOr(init.fontFamily, FONT_FAMILIES, DEFAULT_FONT_FAMILY),
      fontSize: numberOr(init.fontSize, STICKY_FONT_SIZE),
      fontWeight: numberOr(init.fontWeight, DEFAULT_FONT_WEIGHT),
      lineHeight: numberOr(init.lineHeight, DEFAULT_LINE_HEIGHT),
      color: stringOr(init.color, DEFAULT_TEXT_COLOR),
      textAlign: enumOr(init.textAlign, TEXT_ALIGNS, 'left'),
      verticalAlign: enumOr(init.verticalAlign, VERTICAL_ALIGNS, 'top'),
      padding: numberOr(init.padding, STICKY_PADDING),
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): StickyElement {
    return {
      ...base,
      type: 'sticky',
      text: stringOr(raw.text, ''),
      fontFamily: enumOr(raw.fontFamily, FONT_FAMILIES, DEFAULT_FONT_FAMILY),
      fontSize: Math.max(1, numberOr(raw.fontSize, STICKY_FONT_SIZE)),
      fontWeight: clamp(numberOr(raw.fontWeight, DEFAULT_FONT_WEIGHT), 100, 900),
      lineHeight: Math.max(0.5, numberOr(raw.lineHeight, DEFAULT_LINE_HEIGHT)),
      color: stringOr(raw.color, DEFAULT_TEXT_COLOR),
      textAlign: enumOr(raw.textAlign, TEXT_ALIGNS, 'left'),
      verticalAlign: enumOr(raw.verticalAlign, VERTICAL_ALIGNS, 'top'),
      padding: Math.max(0, numberOr(raw.padding, STICKY_PADDING)),
    };
  },

  draw(el: StickyElement, { ctx }: RenderContext): void {
    // A soft drop shadow is what sells "piece of paper" rather than "filled
    // rectangle". It is skipped when a stroke is present, since an outlined note
    // reads as a deliberate box and the shadow then just muddies the edge.
    const shadow = !hasStroke(el.style);
    ctx.save();
    if (shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.16)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetY = 2;
    }
    roundedRectPath(ctx, el.width, el.height, STICKY_CORNER_RADIUS);
    paintPath(ctx, el.style);
    ctx.restore();

    if (el.text === '') return;

    const innerWidth = Math.max(el.width - el.padding * 2, 1);
    const innerHeight = Math.max(el.height - el.padding * 2, 1);
    const metrics = layoutText(el.text, {
      maxWidth: innerWidth,
      fontFamily: el.fontFamily,
      fontSize: el.fontSize,
      fontWeight: el.fontWeight,
      lineHeight: el.lineHeight,
    });

    // Text is clipped to the note: an overlong note should look full, not spill
    // its words across the canvas.
    ctx.save();
    roundedRectPath(ctx, el.width, el.height, STICKY_CORNER_RADIUS);
    ctx.clip();
    drawTextBlock(
      ctx,
      metrics,
      { x: el.padding, y: el.padding, width: innerWidth, height: innerHeight },
      {
        color: el.color,
        textAlign: el.textAlign,
        verticalAlign: el.verticalAlign,
        fontFamily: el.fontFamily,
        fontSize: el.fontSize,
        fontWeight: el.fontWeight,
      },
    );
    ctx.restore();
  },

  hitTest(el: StickyElement, local: Point, tolerance: number): boolean {
    return (
      local.x >= -tolerance &&
      local.y >= -tolerance &&
      local.x <= el.width + tolerance &&
      local.y <= el.height + tolerance
    );
  },
};

registerElement(stickyDefinition);
