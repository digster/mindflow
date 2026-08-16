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
 *    does not cover content. It is decorative: it is not part of the hit region,
 *    because extending the hit region above the element's own bounding box would
 *    put `hitTest` at odds with the AABB pre-rejection every caller relies on.
 *    Renaming happens in the style panel instead.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, FrameElement, Point } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { distanceToPolyline } from '../../model/geometry.ts';
import { fontString, paintPath, stringOr } from './shared.ts';

/** Gap between the frame's top edge and the baseline of its name, in scene units. */
export const FRAME_NAME_GAP = 6;
export const FRAME_NAME_SIZE = 13;

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
    ctx.fillStyle = '#6b7280';
    ctx.font = fontString('sans', FRAME_NAME_SIZE, 600);
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
