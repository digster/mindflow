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

import type { AABB, FontFamily, MindflowDocument, MindflowElement } from '../model/types.ts';
import { frameContents } from '../model/frames.ts';
import { elementWorldAABB } from '../model/geometry.ts';
import { isFrame } from '../model/registry.ts';
import { paintElements } from './export.ts';
import { bundledFace, bundledFontsReady, type BundledFace } from './fonts.ts';
import {
  fitToPage,
  pageContentBox,
  pageSizeById,
  rasterSize,
  readingOrder,
  type PageOrientation,
  type PageSizeId,
} from './pdfLayout.ts';
import { composeMatrix, parseCanvasColor, planText, type Matrix, type Rect } from './pdfText.ts';
import { buildPdf, deflate, rgbaToRgb, type PdfFont, type PdfPage, type PdfTextBlock } from './pdfWriter.ts';
import { hasStroke, setTextSink, type TextSink } from './shapes/shared.ts';

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
 *
 * Shapes are painted into the page's picture. Text becomes real PDF text in
 * the bundled fonts wherever `planText` finds that safe, and invisible text
 * over the picture elsewhere. Without the bundled fonts (they failed to load),
 * the canvas measured with system fonts the PDF cannot embed, so every page is
 * a picture only.
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
  const withText = bundledFontsReady();
  const pdfFonts = new Map<BundledFace, PdfFont>();
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

      // Scene to picture pixels, and picture pixels to the page in points
      // with y up, which is how PDF places the text.
      const toPixels = (box: AABB): Rect => ({
        minX: (box.minX - content.x) * scaleX,
        minY: (box.minY - content.y) * scaleY,
        maxX: (box.maxX - content.x) * scaleX,
        maxY: (box.maxY - content.y) * scaleY,
      });
      const pixelToPage: Matrix = [
        layout.width / pixels.width,
        0,
        0,
        -layout.height / pixels.height,
        layout.x,
        layout.pageHeight - layout.y,
      ];

      const text: PdfTextBlock[] = [];
      let painting = 0;
      if (withText) {
        const frameBox = toPixels(elementWorldAABB(frame));
        const boxes = onPage.map((element) => (element.visible ? toPixels(elementWorldAABB(element)) : null));
        const sink: TextSink = (block, context) => {
          const face = bundledFace(block.fontFamily, block.fontWeight);
          const color = parseCanvasColor(String(context.fillStyle));
          if (!face || !color) return false;
          const alpha = context.globalAlpha * color.alpha;
          const m = context.getTransform();
          const plan = planText(block, face.font, [m.a, m.b, m.c, m.d, m.e, m.f], frameBox, boxes.slice(painting + 1));
          if (!plan || alpha <= 0) return false;
          text.push({
            font: pdfFontFor(face, pdfFonts),
            size: block.fontSize,
            matrix: composeMatrix(pixelToPage, [m.a, m.b, m.c, m.d, m.e, m.f]),
            color: color.rgb,
            alpha,
            invisible: plan.mode === 'hidden',
            lines: plan.lines,
          });
          // Taken as text only when it is not also painted.
          return plan.mode === 'text';
        };
        setTextSink(ctx, sink);
      }
      try {
        paintElements(
          onPage,
          { ctx, zoom: Math.min(scaleX, scaleY), document, images, exporting: true, editingId: null },
          (_, at) => {
            painting = at;
          },
        );
      } finally {
        setTextSink(ctx, null);
      }

      const { data } = ctx.getImageData(0, 0, pixels.width, pixels.height);
      pages.push({
        width: layout.pageWidth,
        height: layout.pageHeight,
        image: { width: pixels.width, height: pixels.height, data: await deflate(rgbaToRgb(data)) },
        placement: layout,
        text,
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

/** FontDescriptor flags by family: non-symbolic, plus fixed pitch, serif or script. */
const FONT_FLAGS: Record<FontFamily, number> = { sans: 32, serif: 32 | 2, mono: 32 | 1, hand: 32 | 8 };

/** A bundled face as the PDF writer embeds it, made once per export. */
function pdfFontFor(face: BundledFace, cache: Map<BundledFace, PdfFont>): PdfFont {
  let font = cache.get(face);
  if (!font) {
    const { font: ttf } = face;
    font = {
      postScriptName: ttf.postScriptName,
      deflated: face.deflated,
      length: face.bytes.length,
      unitsPerEm: ttf.unitsPerEm,
      bbox: ttf.bbox,
      ascender: ttf.ascender,
      descender: ttf.descender,
      capHeight: ttf.capHeight,
      italicAngle: ttf.italicAngle,
      flags: FONT_FLAGS[face.family],
      // Only a hint for viewers that synthesise glyphs; the real ones are embedded.
      stemV: face.role === 'bold' ? 120 : 80,
      advance: (glyph) => ttf.advance(glyph),
    };
    cache.set(face, font);
  }
  return font;
}
