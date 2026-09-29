/**
 * PDF export: one page per frame, each frame scaled to fit its page.
 *
 * The pieces live apart so that most of this is testable without a browser:
 *
 * - `pdfLayout.ts` decides the page order and where each frame lands (pure,
 *   and published in `docs/07-rendering.md#pdf`).
 * - `export.ts`'s `paintElements` paints a frame and its members with the same
 *   shape modules the screen uses.
 * - `pdfWriter.ts` wraps the painted pages in a PDF file (pure).
 *
 * This module is only the glue: one offscreen canvas, painted and read back
 * once per page.
 */

import type { MindflowDocument, MindflowElement } from '../model/types.ts';
import { frameContents } from '../model/frames.ts';
import { isFrame } from '../model/registry.ts';
import { paintElements } from './export.ts';
import {
  fitToPage,
  pageContentBox,
  pageSizeById,
  rasterSize,
  readingOrder,
  type PageOrientation,
  type PageSizeId,
} from './pdfLayout.ts';
import { buildPdf, deflate, rgbaToRgb, type PdfPage } from './pdfWriter.ts';
import { hasStroke } from './shapes/shared.ts';

export interface PdfExportOptions {
  /**
   * The frames to export, one page each. Anything in the list that is not a
   * visible frame is ignored. Defaults to every frame on the board.
   */
  frames?: readonly MindflowElement[];
  pageSize: PageSizeId;
  orientation: PageOrientation;
  /** Raster resolution, in pixels per inch of the printed page. */
  dpi: number;
  /** Paint the board background behind each frame, or leave the paper white. */
  background?: boolean;
}

/** The paper: what shows through wherever nothing on the board is painted. */
const PAPER = '#ffffff';

/**
 * Renders every visible frame (or the given ones) to a page of a PDF.
 *
 * Each page shows what `frameContents` lists for its frame: the frame, its
 * members, and any element in no frame whose centre is inside it, cropped to
 * the frame. Other frames' members that merely overlap it are not on it. The
 * frame's name is not drawn, since it sits outside the box; it becomes the
 * page's bookmark instead.
 */
export async function exportToPDF(
  document: MindflowDocument,
  images: Map<string, CanvasImageSource>,
  options: PdfExportOptions,
): Promise<Blob> {
  // Checked first, so a browser without it fails before painting anything.
  // Baseline since 2023; `deflate` in `pdfWriter.ts` explains why it is used.
  if (typeof CompressionStream !== 'function') {
    throw new Error('This browser cannot create PDF files. Update it, or export a PNG instead.');
  }

  const frames = (options.frames ?? document.elements).filter(isFrame).filter((frame) => frame.visible);
  if (frames.length === 0) {
    throw new Error('There are no frames to export. Each frame becomes one page of the PDF.');
  }

  const size = pageSizeById(options.pageSize);
  const contents = frameContents(document);
  const canvas = window.document.createElement('canvas');
  // Opaque, because PDF has no use for the alpha channel (see `rgbaToRgb`).
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not create a canvas for export.');

  const pages: PdfPage[] = [];
  try {
    for (const [index, frame] of readingOrder(frames).entries()) {
      const content = pageContentBox(frame, hasStroke(frame.style) ? frame.style.strokeWidth : 0);
      const layout = fitToPage(content, size, options.orientation);
      const pixels = rasterSize(layout, options.dpi);

      // Resizing clears the canvas and resets its whole state, the transform
      // and clip included, so every page starts from nothing.
      canvas.width = pixels.width;
      canvas.height = pixels.height;
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, pixels.width, pixels.height);
      if (options.background !== false) {
        ctx.fillStyle = document.canvas.background;
        ctx.fillRect(0, 0, pixels.width, pixels.height);
      }

      // The two axes differ only by the rounding of the pixel size, so the
      // raster fills the canvas exactly rather than leaving a sliver of paper.
      const scaleX = pixels.width / content.width;
      const scaleY = pixels.height / content.height;
      ctx.scale(scaleX, scaleY);
      ctx.translate(-content.x, -content.y);

      // In paint order, so a member below the frame stays below it here too.
      const onPage = contents.get(frame.id) ?? [frame];
      paintElements(onPage, { ctx, zoom: Math.min(scaleX, scaleY), document, images, exporting: true });

      const { data } = ctx.getImageData(0, 0, pixels.width, pixels.height);
      pages.push({
        width: layout.pageWidth,
        height: layout.pageHeight,
        image: { width: pixels.width, height: pixels.height, data: await deflate(rgbaToRgb(data)) },
        placement: layout,
        bookmark: frame.name.trim() || `Page ${index + 1}`,
      });
    }
  } finally {
    // Browsers keep a canvas's backing store until it is collected, and iOS
    // Safari counts it against a small total. Shrinking it frees it now.
    canvas.width = 0;
    canvas.height = 0;
  }

  return new Blob(buildPdf(pages, { title: document.meta.name }), { type: 'application/pdf' });
}
