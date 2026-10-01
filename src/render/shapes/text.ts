/**
 * Free-standing text element.
 *
 * Distinct from an element's `label`, which is text drawn *inside* another
 * shape. A `text` element stands on its own and owns its geometry.
 *
 * It has no fill or stroke of its own, so when its text is empty or only
 * whitespace it paints nothing at all. The text editor deletes one that an edit
 * leaves blank (see `isBlank`), but a blank one can still arrive in an opened
 * file, a paste or an undo. On screen it is drawn as a marker instead (see
 * {@link blankTextMarker}), so it can be found, clicked and filled in. The
 * marker is not part of the format. It is never exported, and an external
 * renderer draws nothing for it.
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
import type { TextBlockMetrics } from './shared.ts';
import { booleanOr, drawTextBlock, enumOr, layoutText, numberOr, stringOr } from './shared.ts';

/** The word a blank text element shows on screen, where it fits. */
export const TEXT_PLACEHOLDER = 'Text';

/**
 * How strongly the blank-text marker is drawn, as a fraction of the element's
 * own opacity. Faint enough to read as a placeholder rather than content, the
 * way a form field's placeholder does.
 */
const MARKER_ALPHA = 0.4;

/** Length of each dash, and of each gap, in the marker's outline. Screen pixels. */
const MARKER_DASH = 4;

/**
 * Slack, in scene units, when deciding whether the placeholder fits. Stored
 * geometry is rounded to two decimals on save, so a box measured for exactly
 * one line can reload a hair smaller than that line.
 */
const MARKER_FIT_SLACK = 0.5;

/**
 * Whether `text` paints nothing: it is empty, or only spaces and line breaks.
 *
 * A regex rather than `trim() === ''`, which would copy every text element's
 * string on every frame. `\S` stops at the first visible character, and it
 * matches exactly the characters `trim` keeps.
 */
export function isBlankText(text: string): boolean {
  return !/\S/.test(text);
}

/**
 * How a text element is marked on screen when it has nothing visible to draw,
 * or `null` when it is not marked.
 *
 * Without this, a blank text element is invisible, but still there. It still
 * selects, saves and exports, and nothing on screen shows it. Editing never
 * leaves one behind, since closing the editor on a blank text element deletes
 * it. One can still come from a file (hand-written or generated), a paste, or
 * undoing that deletion. The marker is a dashed outline of the box, plus
 * {@link TEXT_PLACEHOLDER} in the element's own typography where the word fits
 * the box.
 *
 * Not marked:
 *
 * - **When exporting.** The marker is editor chrome, not content.
 * - **While the element is being edited.** The DOM editor is open on it, with
 *   its own outline and caret. Its absence here is not optional. The renderer
 *   paints an edited element with its text removed, so a shape that marked
 *   every blank-looking element would draw the placeholder under the text
 *   being typed.
 *
 * The word is left out rather than squeezed or clipped when the box is too
 * small for it, such as an auto-width box with no text, which measures one em
 * wide. The outline alone still marks it.
 */
export function blankTextMarker(
  el: TextElement,
  render: Pick<RenderContext, 'exporting' | 'editingId'>,
): { word: TextBlockMetrics | null } | null {
  if (!isBlankText(el.text) || render.exporting || render.editingId === el.id) return null;

  const word = layoutText(TEXT_PLACEHOLDER, {
    maxWidth: 0, // One line, never wrapped. A wrapped "Te/xt" would not read as a placeholder.
    fontFamily: el.fontFamily,
    fontSize: el.fontSize,
    fontWeight: el.fontWeight,
    lineHeight: el.lineHeight,
  });
  const fits =
    word.width <= el.width + MARKER_FIT_SLACK && word.height <= el.height + MARKER_FIT_SLACK;
  return { word: fits ? word : null };
}

/** Paints a {@link blankTextMarker} in the element's local frame. */
function drawBlankTextMarker(
  el: TextElement,
  marker: { word: TextBlockMetrics | null },
  { ctx, zoom }: RenderContext,
): void {
  ctx.save();
  // Multiplied, not assigned: the renderer has already applied `opacity`.
  ctx.globalAlpha *= MARKER_ALPHA;

  // In the text's own colour, which is the colour the user picked to stand out
  // against this board's background. A hairline in screen pixels, like the rest
  // of the canvas chrome. It sits on the box edge, so a selection frame covers
  // it exactly.
  ctx.strokeStyle = el.color;
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([MARKER_DASH / zoom, MARKER_DASH / zoom]);
  ctx.strokeRect(0, 0, el.width, el.height);
  ctx.setLineDash([]);

  // Laid out exactly as typed text would be, in the element's own font, size
  // and alignment, so it previews the text that goes there.
  if (marker.word) {
    drawTextBlock(
      ctx,
      marker.word,
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
  }
  ctx.restore();
}

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
    connector: false,
    frame: false,
    file: false,
    fillable: false,
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

  draw(el: TextElement, render: RenderContext): void {
    const marker = blankTextMarker(el, render);
    if (marker) {
      drawBlankTextMarker(el, marker, render);
      return;
    }
    if (el.text === '') return;
    const { ctx } = render;
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

  /** A text element's box is derived from its content, so every edit re-measures it. */
  withText(el: TextElement, text: string): TextElement {
    const next = { ...el, text };
    const { width, height } = measureTextElement(next);
    return { ...next, width: Math.max(width, 1), height: Math.max(height, 1) };
  },

  /** The same rule `draw` and `measureTextElement` apply: `maxWidth: 0` with `autoWidth`. */
  wrapsText(el: TextElement): boolean {
    return !el.autoWidth;
  },

  /** A text element is its text. With none visible, there is nothing left to keep. */
  isBlank(el: TextElement): boolean {
    return isBlankText(el.text);
  },
};

registerElement(textDefinition);
