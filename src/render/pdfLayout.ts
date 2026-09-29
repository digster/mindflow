/**
 * Page geometry for PDF export: which frame goes on which page, and where on
 * that page it lands.
 *
 * Free of the DOM and of rendering, like `model/frames.ts`, because these rules
 * are published in `docs/07-rendering.md#pdf`. A script that generates a board
 * can predict from them which page a frame lands on and at what scale, and the
 * unit suite pins every case. `exportPdf.ts` only paints what this module has
 * already laid out.
 *
 * Units: frame boxes are in scene units, page geometry in PDF points (1/72
 * inch), and `scale` converts one to the other.
 */

/** PDF's unit: 72 points to the inch. */
export const POINTS_PER_INCH = 72;

/**
 * White space kept clear on every side of the page, in points: half an inch,
 * which is inside every desktop printer's unprintable edge.
 */
export const PAGE_MARGIN = 36;

/**
 * The longest side, in pixels, a page's raster may have. Most browsers cap a
 * canvas near 16,384px and fail silently beyond it, so this matches the PNG
 * exporter's cap (see "Canvas has a maximum size" in LEARNINGS.md).
 */
export const MAX_RASTER_SIDE = 16_000;

/**
 * The most pixels a page's raster may have: 4096², iOS Safari's limit on a
 * canvas's area. It is the tightest in any current browser, and like the side
 * limit, exceeding it gives a blank canvas rather than an error.
 */
export const MAX_RASTER_AREA = 4096 * 4096;

export type PageSizeId = 'a4' | 'a3' | 'letter' | 'legal';

/** `auto` turns each page to suit its frame; the others fix every page. */
export type PageOrientation = 'auto' | 'portrait' | 'landscape';

export interface PageSize {
  id: PageSizeId;
  label: string;
  /** Portrait width, in points. */
  width: number;
  /** Portrait height, in points. */
  height: number;
}

/** The sizes offered, in the order the export dialog lists them. */
export const PAGE_SIZES: readonly PageSize[] = [
  // ISO 216 sizes are defined in millimetres: 210 × 297 and 297 × 420.
  { id: 'a4', label: 'A4', width: 595.28, height: 841.89 },
  { id: 'a3', label: 'A3', width: 841.89, height: 1190.55 },
  { id: 'letter', label: 'US Letter', width: 612, height: 792 },
  { id: 'legal', label: 'US Legal', width: 612, height: 1008 },
];

/**
 * Raster resolutions the export dialog offers, in pixels per inch of the
 * printed page. The last is the default: 300 is what print expects, and a
 * board's flat colours compress well enough that the file stays small.
 */
export const PDF_RESOLUTIONS = [
  { dpi: 150, label: '150 dpi — smaller file' },
  { dpi: 300, label: '300 dpi — print' },
] as const;

/** Looks a size up by id. An unknown id gets A4 rather than an error. */
export function pageSizeById(id: PageSizeId): PageSize {
  return PAGE_SIZES.find((size) => size.id === id) ?? (PAGE_SIZES[0] as PageSize);
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Orders frames the way a page of text is read: rows from top to bottom, and
 * left to right within a row.
 *
 * Frames are placed by hand, so the frames of one visual row are never exactly
 * level. The rule that groups them: frames are taken in order of their top
 * edge (then left edge), and the first frame of a row anchors it. A later
 * frame joins the row if its top edge is above the anchor's vertical midline,
 * and otherwise starts the next row, anchoring that one. Each row is then read
 * by left edge (then top edge).
 *
 * The sorts are stable, so frames at the same position keep their input
 * order, which for the exporter is paint order. The input is not modified.
 */
export function readingOrder<T extends Box>(boxes: readonly T[]): T[] {
  const byTop = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);

  const rows: T[][] = [];
  let midline = -Infinity;
  for (const box of byTop) {
    const row = rows[rows.length - 1];
    if (row && box.y < midline) {
      row.push(box);
    } else {
      rows.push([box]);
      midline = box.y + box.height / 2;
    }
  }

  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || a.y - b.y));
}

/**
 * The region of the board a frame's page shows: the frame's box, grown by half
 * its stroke width on every side.
 *
 * A stroke is centred on the edge it strokes, so half of the frame's border
 * lies outside its box. Cropping to the box would print the border at half its
 * width. `strokeWidth` is 0 for a frame drawn without a stroke.
 */
export function pageContentBox(frame: Box, strokeWidth: number): Box {
  const bleed = Math.max(strokeWidth, 0) / 2;
  return {
    x: frame.x - bleed,
    y: frame.y - bleed,
    width: frame.width + bleed * 2,
    height: frame.height + bleed * 2,
  };
}

export interface PageLayout {
  /** The page after orientation, in points. */
  pageWidth: number;
  pageHeight: number;
  orientation: 'portrait' | 'landscape';
  /** Where the content lands, in points from the page's top-left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Points per scene unit. The same on both axes, so shapes keep their proportions. */
  scale: number;
}

/**
 * Fits content onto a page: the largest uniform scale at which it fits inside
 * the margins, centred on the page. Content smaller than the page is scaled
 * up, so every frame fills its page whatever size it is on the board.
 *
 * With `auto`, both orientations are tried and the one that draws the content
 * larger wins, which with equal margins all round is the one matching the
 * content's shape. A square is a tie, and a tie keeps portrait.
 */
export function fitToPage(
  content: { width: number; height: number },
  size: PageSize,
  orientation: PageOrientation,
  margin = PAGE_MARGIN,
): PageLayout {
  const portrait = place(content, size.width, size.height, margin, 'portrait');
  if (orientation === 'portrait') return portrait;
  const landscape = place(content, size.height, size.width, margin, 'landscape');
  if (orientation === 'landscape') return landscape;
  return landscape.scale > portrait.scale ? landscape : portrait;
}

function place(
  content: { width: number; height: number },
  pageWidth: number,
  pageHeight: number,
  margin: number,
  orientation: 'portrait' | 'landscape',
): PageLayout {
  // Both guards are for impossible input: elements are strictly positive, and
  // no page size is smaller than its margins. Either would otherwise produce
  // an infinite or negative scale.
  const contentWidth = Math.max(content.width, 1e-6);
  const contentHeight = Math.max(content.height, 1e-6);
  const availableWidth = Math.max(pageWidth - margin * 2, 1);
  const availableHeight = Math.max(pageHeight - margin * 2, 1);

  const scale = Math.min(availableWidth / contentWidth, availableHeight / contentHeight);
  const width = contentWidth * scale;
  const height = contentHeight * scale;
  return {
    pageWidth,
    pageHeight,
    orientation,
    x: (pageWidth - width) / 2,
    y: (pageHeight - height) / 2,
    width,
    height,
    scale,
  };
}

/**
 * The pixel size of the raster for an area of the page, at `dpi` pixels per
 * inch, reduced uniformly if that would exceed {@link MAX_RASTER_SIDE} or
 * {@link MAX_RASTER_AREA}.
 *
 * Rounded down, so the limits hold after rounding, and never below one pixel.
 */
export function rasterSize(area: { width: number; height: number }, dpi: number): { width: number; height: number } {
  const pixelsPerPoint = Math.min(
    dpi / POINTS_PER_INCH,
    MAX_RASTER_SIDE / area.width,
    MAX_RASTER_SIDE / area.height,
    Math.sqrt(MAX_RASTER_AREA / (area.width * area.height)),
  );
  return {
    width: Math.max(Math.floor(area.width * pixelsPerPoint), 1),
    height: Math.max(Math.floor(area.height * pixelsPerPoint), 1),
  };
}
