/**
 * Free-standing text element.
 *
 * Distinct from an element's `label`, which is text drawn *inside* another
 * shape. A `text` element stands on its own and owns its geometry.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, Point, TextElement } from '../../model/types.ts';
import { FONT_FAMILIES, TEXT_ALIGNS, VERTICAL_ALIGNS } from '../../model/types.ts';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_STYLE,
  DEFAULT_TEXT_COLOR,
  newElementId,
} from '../../model/defaults.ts';
import { clamp } from '../../model/geometry.ts';
import { booleanOr, drawTextBlock, enumOr, layoutText, numberOr, stringOr } from './shared.ts';

/**
 * Recomputes the box a text element needs.
 *
 * Called after every edit. With `autoWidth` the box grows to the widest line;
 * without it the width is fixed by the user and only the height follows the
 * wrapped line count.
 */
export function measureTextElement(el: TextElement): { width: number; height: number } {
  const metrics = layoutText(el.text, {
    maxWidth: el.autoWidth ? 0 : el.width,
    fontFamily: el.fontFamily,
    fontSize: el.fontSize,
    fontWeight: el.fontWeight,
    lineHeight: el.lineHeight,
  });
  return {
    width: el.autoWidth ? Math.max(metrics.width, el.fontSize) : el.width,
    height: Math.max(metrics.height, el.fontSize * el.lineHeight),
  };
}

export const textDefinition: ElementDefinition<TextElement> = {
  type: 'text',
  title: 'Text',

  capabilities: {
    label: false, // Text elements *are* text; a nested label would be redundant.
    path: false,
    text: true,
    resizable: true,
    rotatable: true,
    bindable: true,
  },

  create(init: ElementInit): TextElement {
    const fontSize = numberOr(init.fontSize, DEFAULT_FONT_SIZE);
    return {
      id: newElementId(),
      type: 'text',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? fontSize * 6, 1),
      height: Math.max(init.height ?? fontSize * DEFAULT_LINE_HEIGHT, 1),
      angle: 0,
      zIndex: init.zIndex,
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      frameId: null,
      // Text draws with its own `color`; the shared stroke/fill are unused, so
      // they are set to inert values rather than left to inherit a visible box.
      style: { ...DEFAULT_STYLE, stroke: 'transparent', fill: 'transparent', fillStyle: 'none' },
      label: null,
      meta: {},
      text: stringOr(init.text, ''),
      fontFamily: enumOr(init.fontFamily, FONT_FAMILIES, DEFAULT_FONT_FAMILY),
      fontSize,
      fontWeight: numberOr(init.fontWeight, DEFAULT_FONT_WEIGHT),
      lineHeight: numberOr(init.lineHeight, DEFAULT_LINE_HEIGHT),
      color: stringOr(init.color, DEFAULT_TEXT_COLOR),
      textAlign: enumOr(init.textAlign, TEXT_ALIGNS, 'left'),
      verticalAlign: enumOr(init.verticalAlign, VERTICAL_ALIGNS, 'top'),
      autoWidth: booleanOr(init.autoWidth, true),
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): TextElement {
    return {
      ...base,
      type: 'text',
      text: stringOr(raw.text, ''),
      fontFamily: enumOr(raw.fontFamily, FONT_FAMILIES, DEFAULT_FONT_FAMILY),
      fontSize: Math.max(1, numberOr(raw.fontSize, DEFAULT_FONT_SIZE)),
      fontWeight: clamp(numberOr(raw.fontWeight, DEFAULT_FONT_WEIGHT), 100, 900),
      lineHeight: Math.max(0.5, numberOr(raw.lineHeight, DEFAULT_LINE_HEIGHT)),
      color: stringOr(raw.color, DEFAULT_TEXT_COLOR),
      textAlign: enumOr(raw.textAlign, TEXT_ALIGNS, 'left'),
      verticalAlign: enumOr(raw.verticalAlign, VERTICAL_ALIGNS, 'top'),
      autoWidth: booleanOr(raw.autoWidth, true),
    };
  },

  draw(el: TextElement, { ctx }: RenderContext): void {
    if (el.text === '') return;
    const metrics = layoutText(el.text, {
      maxWidth: el.autoWidth ? 0 : el.width,
      fontFamily: el.fontFamily,
      fontSize: el.fontSize,
      fontWeight: el.fontWeight,
      lineHeight: el.lineHeight,
    });
    drawTextBlock(
      ctx,
      metrics,
      { x: 0, y: 0, width: el.width, height: el.height },
      {
        color: el.color,
        textAlign: el.textAlign,
        verticalAlign: el.verticalAlign,
        fontFamily: el.fontFamily,
        fontSize: el.fontSize,
        fontWeight: el.fontWeight,
      },
    );
  },

  /** Text is solid to the pointer across its whole box — there is no hollow interior. */
  hitTest(el: TextElement, local: Point, tolerance: number): boolean {
    return (
      local.x >= -tolerance &&
      local.y >= -tolerance &&
      local.x <= el.width + tolerance &&
      local.y <= el.height + tolerance
    );
  },
};

registerElement(textDefinition);
