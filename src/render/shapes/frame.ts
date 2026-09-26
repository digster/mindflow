/**
 * Frame element — a named region that clips and moves its contents.
 *
 * Three decisions worth stating, because each rules out something that looks
 * obvious:
 *
 * 1. **Not rotatable.** A rotated clipping region means clipping to a rotated
 *    polygon in both renderers, and a rotated name tab, for a feature nobody
 *    reaches for. `capabilities.rotatable` is false and the box stays
 *    axis-aligned, which is also what lets the clip be a plain rectangle.
 *
 * 2. **The interior is click-through.** A frame that swallowed clicks would make
 *    everything inside it unselectable. It is grabbed by its border (within the
 *    usual hit tolerance) — the same rule an unfilled rectangle already follows,
 *    so it needs no new concept.
 *
 * 3. **The name is drawn OUTSIDE the box**, above the top-left corner, where it
 *    does not cover content. It is not part of the hit region, because extending
 *    the hit region above the element's own bounding box would put `hitTest` at
 *    odds with the AABB pre-rejection every caller relies on. So a click on the
 *    name does not select or drag the frame. A double-click on it does rename
 *    it: `frameNameAt` in `input/hitTest.ts` picks the tab separately, from
 *    {@link frameNameBox}, and only the double-click path asks.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, FrameElement, Point } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { distanceToPolyline } from '../../model/geometry.ts';
import { BASELINE_RATIO, fontString, measureTextWidth, paintPath, stringOr } from './shared.ts';

/** Gap between the frame's top edge and the baseline of its name, in scene units. */
export const FRAME_NAME_GAP = 6;
export const FRAME_NAME_SIZE = 13;
export const FRAME_NAME_WEIGHT = 600;
export const FRAME_NAME_COLOR = '#6b7280';
/** The name's canvas font. Always `sans`: a frame has no typography fields. */
export const FRAME_NAME_FONT = fontString('sans', FRAME_NAME_SIZE, FRAME_NAME_WEIGHT);

/**
 * Where the name tab sits, in the frame's LOCAL frame: left-aligned to the
 * frame's left edge, one line of `FRAME_NAME_SIZE` whose baseline is
 * `FRAME_NAME_GAP` above the top edge, and as wide as the name measures.
 *
 * The line's top is `BASELINE_RATIO` em above the baseline, the rule every
 * other text block uses, so the box covers the glyphs without depending on
 * which typeface `sans` resolved to. An empty name draws nothing and has no
 * width.
 *
 * The one description of where the name is. The canvas draws at its baseline,
 * a double-click is tested against it, and the name editor overlays it. Those
 * are separate readers, and reading one box is what keeps the name from
 * jumping when editing starts (see "Three renderers read a label's box" in
 * LEARNINGS.md). The SVG exporter shares the constants.
 */
export function frameNameBox(frame: FrameElement): { x: number; y: number; width: number; height: number } {
  return {
    x: 0,
    y: -FRAME_NAME_GAP - FRAME_NAME_SIZE * BASELINE_RATIO,
    width: frame.name === '' ? 0 : measureTextWidth(frame.name, FRAME_NAME_FONT, FRAME_NAME_SIZE),
    height: FRAME_NAME_SIZE,
  };
}

export const frameDefinition: ElementDefinition<FrameElement> = {
  type: 'frame',
  title: 'Frame',

  capabilities: {
    label: false,
    path: false,
    text: false,
    resizable: true,
    // See the header: a rotated clip region is a large amount of subtle geometry
    // for very little, and the axis-aligned box is what keeps the clip a rect.
    rotatable: false,
    bindable: true,
    connector: false,
    // The only module that sets this. Membership, clipping, moving and deleting
    // with members, the name row in the style panel and renaming on the canvas
    // all ask `isFrame`.
    frame: true,
    file: false,
    fillable: true,
  },

  create(init: ElementInit): FrameElement {
    return {
      id: newElementId(),
      type: 'frame',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? 400, 1),
      height: Math.max(init.height ?? 300, 1),
      angle: 0,
      zIndex: init.zIndex,
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      frameId: null,
      style: {
        ...DEFAULT_STYLE,
        stroke: '#adb5bd',
        fill: '#ffffff',
        fillStyle: 'solid',
        ...(init.style as object | undefined),
      },
      label: null,
      meta: {},
      name: stringOr(init.name, 'Frame'),
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): FrameElement {
    return {
      ...base,
      type: 'frame',
      // Frames do not nest. Enforced on read as well as on write, since a file
      // can be hand-authored or generated.
      frameId: null,
      name: stringOr(raw.name, ''),
    };
  },

  draw(el: FrameElement, { ctx }: RenderContext): void {
    ctx.beginPath();
    ctx.rect(0, 0, el.width, el.height);
    paintPath(ctx, el.style);

    if (el.name === '') return;
    ctx.save();
    ctx.fillStyle = FRAME_NAME_COLOR;
    ctx.font = FRAME_NAME_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(el.name, 0, -FRAME_NAME_GAP);
    ctx.restore();
  },

  hitTest(el: FrameElement, local: Point, tolerance: number): boolean {
    // Border only, even when filled — a frame's whole job is to sit behind its
    // contents, and a solid hit region would make them unreachable.
    const outline: Point[] = [
      { x: 0, y: 0 },
      { x: el.width, y: 0 },
      { x: el.width, y: el.height },
      { x: 0, y: el.height },
      { x: 0, y: 0 },
    ];
    return distanceToPolyline(local, outline) <= tolerance + el.style.strokeWidth / 2;
  },
};

registerElement(frameDefinition);
