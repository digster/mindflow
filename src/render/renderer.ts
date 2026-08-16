/**
 * Canvas renderer.
 *
 * A single `<canvas>` repainted on demand. The loop is:
 *
 *   something changes → mark dirty → next animation frame → full repaint
 *
 * Repainting everything each frame sounds wasteful, and for a DOM-based renderer
 * it would be. For Canvas 2D it is the right default: the GPU-backed context
 * clears and refills a viewport-sized surface very quickly, and the alternative —
 * tracking damaged regions — is a large amount of subtle code that mostly buys
 * back what viewport culling already gives us.
 *
 * The scaling levers, if a board ever gets big enough to need them, are noted in
 * `ARCHITECTURE.md`. Culling is implemented; region damage and a separate
 * interaction canvas are deliberately not.
 *
 * ---------------------------------------------------------------------------
 * The transform stack
 * ---------------------------------------------------------------------------
 * Two transforms compose on every element:
 *
 *   1. VIEWPORT — device-pixel ratio, then zoom, then pan. Applied once per
 *      frame, so all element geometry can be expressed in plain scene units.
 *   2. ELEMENT — translate to the element's centre, rotate, translate back out
 *      to its top-left corner.
 *
 * After both, the origin sits at the element's unrotated top-left and the axes
 * are aligned with the element. That is the "local frame" every shape module is
 * written against, and it is why no shape module contains rotation code.
 */

import type { MindflowDocument, MindflowElement, Viewport } from '../model/types.ts';
import type { RenderContext } from '../model/registry.ts';
import { drawElement } from '../model/registry.ts';
import { aabbIntersects, degToRad, elementWorldAABB, visibleSceneBounds } from '../model/geometry.ts';

export interface RendererOptions {
  canvas: HTMLCanvasElement;
  /** Called after each frame, so overlays can draw on top in the same transform. */
  drawOverlay?: (render: RenderContext) => void;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly drawOverlay: ((render: RenderContext) => void) | undefined;

  private frameHandle = 0;
  private needsPaint = false;

  /** CSS pixel size of the canvas. */
  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;

  private document: MindflowDocument | null = null;
  private viewport: Viewport = { x: 0, y: 0, zoom: 1 };
  private images: Map<string, CanvasImageSource> = new Map();

  /** Elements drawn in the last frame — diagnostics for the perf check. */
  lastDrawnCount = 0;

  constructor(options: RendererOptions) {
    this.canvas = options.canvas;
    this.drawOverlay = options.drawOverlay;

    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('This browser does not support the Canvas 2D API.');
    this.ctx = ctx;
  }

  setScene(document: MindflowDocument, viewport: Viewport, images: Map<string, CanvasImageSource>): void {
    this.document = document;
    this.viewport = viewport;
    this.images = images;
    this.invalidate();
  }

  /** Requests a repaint on the next animation frame. Cheap to call repeatedly. */
  invalidate(): void {
    if (this.needsPaint) return;
    this.needsPaint = true;
    this.frameHandle = requestAnimationFrame(() => {
      this.needsPaint = false;
      this.paint();
    });
  }

  /**
   * Resizes the backing store to match the element's CSS size times the device
   * pixel ratio.
   *
   * Without the DPR multiplier everything looks soft on a high-density display;
   * without resetting the transform afterwards the scale would compound on every
   * resize. Both are classic canvas bugs, so both are handled in one place.
   */
  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(Math.round(rect.width), 1);
    const height = Math.max(Math.round(rect.height), 1);

    if (width === this.cssWidth && height === this.cssHeight && dpr === this.dpr) return;

    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;
    // Assigning width/height also clears the canvas and resets its transform.
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.invalidate();
  }

  get size(): { width: number; height: number } {
    return { width: this.cssWidth, height: this.cssHeight };
  }

  private paint(): void {
    const doc = this.document;
    if (!doc) return;

    const { ctx } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // `alpha: false` means the canvas has no transparency, so a fill is required
    // rather than a clear — and it is faster than clearRect on an opaque surface.
    ctx.fillStyle = doc.canvas.background;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    ctx.scale(this.dpr, this.dpr);
    ctx.translate(-this.viewport.x * this.viewport.zoom, -this.viewport.y * this.viewport.zoom);
    ctx.scale(this.viewport.zoom, this.viewport.zoom);
    // From here on, one unit is one scene unit.

    const visible = visibleSceneBounds(this.viewport, this.cssWidth, this.cssHeight);

    if (doc.canvas.grid.visible) this.paintGrid(visible, doc.canvas.grid.size);

    const render: RenderContext = {
      ctx,
      zoom: this.viewport.zoom,
      document: doc,
      images: this.images,
      exporting: false,
    };

    let drawn = 0;
    for (const element of doc.elements) {
      if (!element.visible) continue;
      // Culling: the dominant cost on a large board is drawing, not iterating,
      // so an AABB test per element pays for itself many times over.
      if (!aabbIntersects(elementWorldAABB(element), visible)) continue;
      this.paintElement(element, render);
      drawn++;
    }
    this.lastDrawnCount = drawn;

    this.drawOverlay?.(render);
  }

  /** Applies an element's transform and hands off to its registered `draw`. */
  private paintElement(element: MindflowElement, render: RenderContext): void {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = element.opacity;

    // Frame clipping. Applied BEFORE the element's own transform, so the clip
    // stays in scene space where the frame's box is defined — a frame is never
    // rotated, which is what keeps this a plain rectangle rather than a path.
    if (element.frameId !== null) {
      const frame = render.document.elements.find((candidate) => candidate.id === element.frameId);
      if (frame) {
        ctx.beginPath();
        ctx.rect(frame.x, frame.y, frame.width, frame.height);
        ctx.clip();
      }
    }

    const centerX = element.x + element.width / 2;
    const centerY = element.y + element.height / 2;
    ctx.translate(centerX, centerY);
    if (element.angle !== 0) ctx.rotate(degToRad(element.angle));
    ctx.translate(-element.width / 2, -element.height / 2);

    try {
      drawElement(element, render);
    } catch (error) {
      // One malformed element must not blank the entire board. Log and move on.
      console.error(`[mindflow] failed to draw element ${element.id}`, error);
    }

    ctx.restore();
  }

  /**
   * Draws the background grid.
   *
   * The grid coarsens automatically as you zoom out: below roughly 6 screen
   * pixels per cell the lines merge into a grey wash, so the spacing is doubled
   * until it is legible again. Without this, zooming out on a fine grid both
   * looks wrong and costs thousands of pointless line segments.
   */
  private paintGrid(visible: { minX: number; minY: number; maxX: number; maxY: number }, size: number): void {
    const { ctx } = this;
    let step = size;
    while (step * this.viewport.zoom < 6) step *= 2;

    const startX = Math.floor(visible.minX / step) * step;
    const startY = Math.floor(visible.minY / step) * step;

    ctx.save();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
    // A hairline regardless of zoom: dividing by zoom cancels the context scale.
    ctx.lineWidth = 1 / this.viewport.zoom;
    ctx.beginPath();
    for (let x = startX; x <= visible.maxX; x += step) {
      ctx.moveTo(x, visible.minY);
      ctx.lineTo(x, visible.maxY);
    }
    for (let y = startY; y <= visible.maxY; y += step) {
      ctx.moveTo(visible.minX, y);
      ctx.lineTo(visible.maxX, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  destroy(): void {
    cancelAnimationFrame(this.frameHandle);
  }
}
