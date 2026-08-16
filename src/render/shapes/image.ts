/**
 * Image element.
 *
 * The pixels themselves live in the document's `files` map as a data URI, keyed
 * by content hash; the element only holds a `fileId` reference. See the note on
 * `EmbeddedFile` in `model/types.ts` for why the bytes are kept out of the
 * element array.
 *
 * Decoding happens outside the render path — `render/images.ts` maintains the
 * `fileId → CanvasImageSource` cache that arrives on the {@link RenderContext}.
 * Drawing must stay synchronous, so an image that has not finished decoding
 * renders as a placeholder for a frame or two rather than blocking.
 */

import type { ElementDefinition, ElementInit, RenderContext } from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, ImageElement, Point } from '../../model/types.ts';
import { OBJECT_FITS } from '../../model/types.ts';
import { DEFAULT_STYLE, newElementId } from '../../model/defaults.ts';
import { enumOr, hasStroke, applyStroke, numberOr, stringOr } from './shared.ts';

/**
 * Computes the source and destination rectangles that implement CSS-style
 * `object-fit`, so an image never stretches unless the author asked it to.
 *
 *   fill     stretch to the box, ignoring aspect ratio
 *   contain  scale to fit entirely inside the box, letterboxing the remainder
 *   cover    scale to fill the box, cropping the overflow symmetrically
 */
function fitRects(
  el: ImageElement,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } {
  const { naturalWidth: nw, naturalHeight: nh, width: bw, height: bh } = el;

  if (el.objectFit === 'fill' || nw <= 0 || nh <= 0) {
    return { sx: 0, sy: 0, sw: nw || 1, sh: nh || 1, dx: 0, dy: 0, dw: bw, dh: bh };
  }

  if (el.objectFit === 'contain') {
    const scale = Math.min(bw / nw, bh / nh);
    const dw = nw * scale;
    const dh = nh * scale;
    return { sx: 0, sy: 0, sw: nw, sh: nh, dx: (bw - dw) / 2, dy: (bh - dh) / 2, dw, dh };
  }

  // cover: crop the source instead of scaling past the box.
  const scale = Math.max(bw / nw, bh / nh);
  const sw = bw / scale;
  const sh = bh / scale;
  return { sx: (nw - sw) / 2, sy: (nh - sh) / 2, sw, sh, dx: 0, dy: 0, dw: bw, dh: bh };
}

/** Drawn while an image is still decoding, or when its `fileId` does not resolve. */
function drawPlaceholder(ctx: CanvasRenderingContext2D, el: ImageElement, missing: boolean): void {
  ctx.save();
  ctx.fillStyle = missing ? '#fff5f5' : '#f1f3f5';
  ctx.fillRect(0, 0, el.width, el.height);
  ctx.strokeStyle = missing ? '#ffa8a8' : '#dee2e6';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(0.5, 0.5, el.width - 1, el.height - 1);

  const size = Math.min(el.width, el.height) * 0.3;
  if (size > 8) {
    ctx.setLineDash([]);
    ctx.strokeStyle = missing ? '#e03131' : '#adb5bd';
    ctx.lineWidth = Math.max(size * 0.08, 1);
    const cx = el.width / 2;
    const cy = el.height / 2;
    if (missing) {
      // A cross: this image is gone and will not appear.
      ctx.beginPath();
      ctx.moveTo(cx - size / 3, cy - size / 3);
      ctx.lineTo(cx + size / 3, cy + size / 3);
      ctx.moveTo(cx + size / 3, cy - size / 3);
      ctx.lineTo(cx - size / 3, cy + size / 3);
      ctx.stroke();
    } else {
      // A circle: still loading.
      ctx.beginPath();
      ctx.arc(cx, cy, size / 3, 0, Math.PI * 1.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export const imageDefinition: ElementDefinition<ImageElement> = {
  type: 'image',
  title: 'Image',

  capabilities: {
    label: true,
    path: false,
    text: false,
    resizable: true,
    rotatable: true,
    bindable: true,
  },

  create(init: ElementInit): ImageElement {
    const naturalWidth = numberOr(init.naturalWidth, 100);
    const naturalHeight = numberOr(init.naturalHeight, 100);
    return {
      id: newElementId(),
      type: 'image',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? naturalWidth, 1),
      height: Math.max(init.height ?? naturalHeight, 1),
      angle: 0,
      zIndex: init.zIndex,
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      frameId: null,
      style: { ...DEFAULT_STYLE, stroke: 'transparent', strokeWidth: 0, fillStyle: 'none' },
      label: null,
      meta: {},
      fileId: stringOr(init.fileId, ''),
      naturalWidth,
      naturalHeight,
      objectFit: enumOr(init.objectFit, OBJECT_FITS, 'fill'),
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): ImageElement {
    return {
      ...base,
      type: 'image',
      fileId: stringOr(raw.fileId, ''),
      naturalWidth: Math.max(1, numberOr(raw.naturalWidth, base.width)),
      naturalHeight: Math.max(1, numberOr(raw.naturalHeight, base.height)),
      objectFit: enumOr(raw.objectFit, OBJECT_FITS, 'fill'),
    };
  },

  draw(el: ImageElement, { ctx, document: doc, images }: RenderContext): void {
    const source = images.get(el.fileId);

    if (!source) {
      drawPlaceholder(ctx, el, !doc.files[el.fileId]);
      return;
    }

    const { sx, sy, sw, sh, dx, dy, dw, dh } = fitRects(el);
    ctx.save();
    // `contain` can leave the box partly empty and `cover` overflows it; clipping
    // guarantees the element never paints outside its declared bounds, which the
    // culling and hit-testing both assume.
    ctx.beginPath();
    ctx.rect(0, 0, el.width, el.height);
    ctx.clip();
    try {
      ctx.drawImage(source, sx, sy, sw, sh, dx, dy, dw, dh);
    } catch {
      // A decoded-but-broken bitmap throws here. Fail to a placeholder rather
      // than taking down the whole frame's render loop.
      drawPlaceholder(ctx, el, true);
    }
    ctx.restore();

    if (hasStroke(el.style)) {
      applyStroke(ctx, el.style);
      ctx.strokeRect(0, 0, el.width, el.height);
      ctx.setLineDash([]);
    }
  },

  hitTest(el: ImageElement, local: Point, tolerance: number): boolean {
    return (
      local.x >= -tolerance &&
      local.y >= -tolerance &&
      local.x <= el.width + tolerance &&
      local.y <= el.height + tolerance
    );
  },
};

registerElement(imageDefinition);
