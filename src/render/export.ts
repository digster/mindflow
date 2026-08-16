/**
 * PNG and SVG export.
 *
 * ---------------------------------------------------------------------------
 * Why SVG needs its own serialiser
 * ---------------------------------------------------------------------------
 * PNG export can reuse the shape modules directly: it is the same Canvas 2D
 * drawing code pointed at an offscreen canvas.
 *
 * SVG cannot. A `draw()` that issues canvas calls produces pixels, not markup,
 * so there is no way to derive SVG from it. The choices are to embed a raster
 * image inside an SVG wrapper (which defeats the point of vector export) or to
 * write a second renderer that emits elements. This does the latter.
 *
 * That means shape geometry is expressed twice, and the two can drift. The
 * mitigation is that both are driven from the same documented geometry rules in
 * `docs/07-rendering.md` — the smoothing and routing algorithms are imported
 * from shared modules rather than re-derived, so only the *output syntax*
 * differs, not the maths.
 */

import type {
  DrawElement,
  ImageElement,
  LinearElement,
  MindflowDocument,
  MindflowElement,
  RectangleElement,
  StickyElement,
  TextElement,
} from '../model/types.ts';
import type { RenderContext } from '../model/registry.ts';
import { drawElement } from '../model/registry.ts';
import { clamp, degToRad, unionAABB } from '../model/geometry.ts';
import { roughOutlineFor } from './rough.ts';
import {
  BASELINE_RATIO,
  FONT_STACKS,
  dashPattern,
  hasFill,
  hasStroke,
  layoutText,
} from './shapes/shared.ts';

export interface ExportOptions {
  /** Export only these elements. Defaults to everything visible. */
  elements?: readonly MindflowElement[];
  /** Padding around the content, in scene units. */
  padding?: number;
  /** Pixel scale for raster output. 2 gives a retina-quality file. */
  scale?: number;
  /** Paint the board background, or leave it transparent. */
  background?: boolean;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Content bounds plus padding, or null when there is nothing to export. */
function exportBounds(elements: readonly MindflowElement[], padding: number): Bounds | null {
  const visible = elements.filter((element) => element.visible);
  const box = unionAABB(visible);
  if (!box) return null;
  return {
    x: box.minX - padding,
    y: box.minY - padding,
    width: Math.max(box.maxX - box.minX + padding * 2, 1),
    height: Math.max(box.maxY - box.minY + padding * 2, 1),
  };
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

/**
 * Renders to a PNG blob.
 *
 * Reuses the shape modules, so PNG output is pixel-identical to what is on
 * screen. `scale` is capped so that a huge board at 4x cannot request a canvas
 * larger than browsers will allocate — most cap around 16384px per side, and
 * exceeding it fails silently with a blank image rather than an error.
 */
export async function exportToPNG(
  document: MindflowDocument,
  images: Map<string, CanvasImageSource>,
  options: ExportOptions = {},
): Promise<Blob> {
  const elements = options.elements ?? document.elements;
  const padding = options.padding ?? 24;
  const bounds = exportBounds(elements, padding);
  if (!bounds) throw new Error('There is nothing on this board to export.');

  const MAX_DIMENSION = 16000;
  const requested = options.scale ?? 2;
  const scale = Math.min(requested, MAX_DIMENSION / bounds.width, MAX_DIMENSION / bounds.height);

  const canvas = window.document.createElement('canvas');
  canvas.width = Math.max(Math.round(bounds.width * scale), 1);
  canvas.height = Math.max(Math.round(bounds.height * scale), 1);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a canvas for export.');

  if (options.background !== false) {
    ctx.fillStyle = document.canvas.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.scale(scale, scale);
  ctx.translate(-bounds.x, -bounds.y);

  const render: RenderContext = { ctx, zoom: scale, document, images, exporting: true };

  for (const element of elements) {
    if (!element.visible) continue;
    ctx.save();
    ctx.globalAlpha = element.opacity;
    ctx.translate(element.x + element.width / 2, element.y + element.height / 2);
    if (element.angle !== 0) ctx.rotate(degToRad(element.angle));
    ctx.translate(-element.width / 2, -element.height / 2);
    try {
      drawElement(element, render);
    } catch (error) {
      console.error(`[mindflow] export skipped element ${element.id}`, error);
    }
    ctx.restore();
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The browser could not encode the PNG.'))),
      'image/png',
    );
  });
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

/** Escapes text for inclusion in XML content or an attribute value. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Shared presentation attributes derived from an element's style. */
function styleAttributes(element: MindflowElement): string {
  const parts: string[] = [];
  parts.push(`fill="${hasFill(element.style) ? escapeXml(element.style.fill) : 'none'}"`);

  if (hasStroke(element.style)) {
    parts.push(`stroke="${escapeXml(element.style.stroke)}"`);
    parts.push(`stroke-width="${round(element.style.strokeWidth)}"`);
    parts.push('stroke-linejoin="round"');
    const dashes = dashPattern(element.style);
    if (dashes.length > 0) parts.push(`stroke-dasharray="${dashes.map(round).join(' ')}"`);
  } else {
    parts.push('stroke="none"');
  }

  if (element.opacity < 1) parts.push(`opacity="${round(element.opacity)}"`);
  return parts.join(' ');
}

/**
 * The element transform, matching the renderer's:
 * translate to centre, rotate, translate back to the local origin.
 */
function transformAttribute(element: MindflowElement): string {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  if (element.angle === 0) return `translate(${round(element.x)} ${round(element.y)})`;
  return (
    `translate(${round(cx)} ${round(cy)}) rotate(${round(element.angle)}) ` +
    `translate(${round(-element.width / 2)} ${round(-element.height / 2)})`
  );
}

/** Renders a text block as a `<text>` with one `<tspan>` per wrapped line. */
function textToSvg(
  text: string,
  box: { width: number; height: number; padding: number },
  style: {
    fontFamily: keyof typeof FONT_STACKS;
    fontSize: number;
    fontWeight: number;
    lineHeight: number;
    color: string;
    textAlign: 'left' | 'center' | 'right';
    verticalAlign: 'top' | 'middle' | 'bottom';
  },
): string {
  if (text === '') return '';

  const innerWidth = Math.max(box.width - box.padding * 2, 1);
  const metrics = layoutText(text, {
    maxWidth: innerWidth,
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    lineHeight: style.lineHeight,
  });

  const anchor =
    style.textAlign === 'center' ? 'middle' : style.textAlign === 'right' ? 'end' : 'start';
  const x =
    style.textAlign === 'center'
      ? box.width / 2
      : style.textAlign === 'right'
        ? box.width - box.padding
        : box.padding;

  const blockHeight = metrics.lines.length * metrics.lineHeightPx;
  const available = box.height - box.padding * 2;
  const offset =
    style.verticalAlign === 'middle'
      ? (available - blockHeight) / 2
      : style.verticalAlign === 'bottom'
        ? available - blockHeight
        : 0;

  const spans = metrics.lines
    .map((line, index) => {
      // The same baseline offset the canvas renderer uses, so exported text sits
      // exactly where it does on screen.
      const y =
        box.padding + offset + index * metrics.lineHeightPx + style.fontSize * BASELINE_RATIO;
      return `<tspan x="${round(x)}" y="${round(y)}">${escapeXml(line)}</tspan>`;
    })
    .join('');

  return (
    `<text font-family="${escapeXml(FONT_STACKS[style.fontFamily])}" ` +
    `font-size="${round(style.fontSize)}" font-weight="${style.fontWeight}" ` +
    `fill="${escapeXml(style.color)}" text-anchor="${anchor}">${spans}</text>`
  );
}

/** The element's `label`, if any, as SVG. */
function labelToSvg(element: MindflowElement): string {
  if (!element.label || element.label.text === '') return '';
  return textToSvg(
    element.label.text,
    { width: element.width, height: element.height, padding: element.label.padding },
    element.label,
  );
}

function pointsToPath(element: LinearElement | DrawElement, smooth: boolean): string {
  const points = element.points;
  const first = points[0];
  if (!first) return '';

  let path = `M ${round(first[0])} ${round(first[1])}`;

  // Quadratic smoothing through midpoints — the algorithm documented in
  // `docs/07-rendering.md` and implemented for canvas in `shapes/shared.ts`.
  if (smooth && points.length > 2) {
    for (let i = 1; i < points.length - 1; i++) {
      const current = points[i];
      const next = points[i + 1];
      if (!current || !next) continue;
      path += ` Q ${round(current[0])} ${round(current[1])} ${round((current[0] + next[0]) / 2)} ${round((current[1] + next[1]) / 2)}`;
    }
    const last = points[points.length - 1];
    if (last) path += ` L ${round(last[0])} ${round(last[1])}`;
    return path;
  }

  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (p) path += ` L ${round(p[0])} ${round(p[1])}`;
  }
  return path;
}

/** Arrowhead marker geometry, matching `shapes/linear.ts`. */
function arrowheadToSvg(element: LinearElement, atEnd: boolean): string {
  const kind = atEnd ? element.endArrowhead : element.startArrowhead;
  if (kind === 'none') return '';

  const points = element.points;
  const tip = atEnd ? points[points.length - 1] : points[0];
  const from = atEnd ? points[points.length - 2] : points[1];
  if (!tip || !from) return '';

  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const size = Math.max(element.style.strokeWidth * 4, 10);
  const spread = Math.PI / 7;
  const color = escapeXml(element.style.stroke);
  const width = round(element.style.strokeWidth);

  const ax = tip[0] - size * Math.cos(angle - spread);
  const ay = tip[1] - size * Math.sin(angle - spread);
  const bx = tip[0] - size * Math.cos(angle + spread);
  const by = tip[1] - size * Math.sin(angle + spread);

  switch (kind) {
    case 'arrow':
      return `<polyline points="${round(ax)},${round(ay)} ${round(tip[0])},${round(tip[1])} ${round(bx)},${round(by)}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'triangle':
      return `<polygon points="${round(tip[0])},${round(tip[1])} ${round(ax)},${round(ay)} ${round(bx)},${round(by)}" fill="${color}"/>`;
    case 'dot':
      return `<circle cx="${round(tip[0])}" cy="${round(tip[1])}" r="${round(Math.max(element.style.strokeWidth * 1.6, 4))}" fill="${color}"/>`;
    case 'bar': {
      const half = size / 2;
      const px = Math.cos(angle - Math.PI / 2) * half;
      const py = Math.sin(angle - Math.PI / 2) * half;
      return `<line x1="${round(tip[0] - px)}" y1="${round(tip[1] - py)}" x2="${round(tip[0] + px)}" y2="${round(tip[1] + py)}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
    }
    default:
      return '';
  }
}

/** Serialises one element's inner markup, in its local coordinate space. */
function elementToSvg(element: MindflowElement, document: MindflowDocument): string {
  const style = styleAttributes(element);

  // A rough shape is a polygon in both renderers, generated from the same seeded
  // stream. SVG is a second renderer and cannot be otherwise (see LEARNINGS.md),
  // so the only way it and the canvas can agree is to consume identical points
  // rather than each approximating the outline its own way.
  const rough = roughOutlineFor(element);
  if (rough) {
    const serialised = rough.map((point) => `${round(point.x)},${round(point.y)}`).join(' ');
    return `<polygon points="${serialised}" ${style}/>${labelToSvg(element)}`;
  }

  switch (element.type) {
    case 'rectangle': {
      const rect = element as RectangleElement;
      const r = round(clamp(rect.cornerRadius, 0, Math.min(rect.width, rect.height) / 2));
      return `<rect width="${round(rect.width)}" height="${round(rect.height)}" rx="${r}" ry="${r}" ${style}/>${labelToSvg(element)}`;
    }

    case 'ellipse':
      return `<ellipse cx="${round(element.width / 2)}" cy="${round(element.height / 2)}" rx="${round(element.width / 2)}" ry="${round(element.height / 2)}" ${style}/>${labelToSvg(element)}`;

    case 'diamond': {
      // Vertices are the midpoints of the box's edges, clockwise from the top —
      // the same four points `render/shapes/diamond.ts` draws.
      const w = round(element.width);
      const h = round(element.height);
      const points = `${round(w / 2)},0 ${w},${round(h / 2)} ${round(w / 2)},${h} 0,${round(h / 2)}`;
      return `<polygon points="${points}" ${style}/>${labelToSvg(element)}`;
    }

    case 'line':
    case 'arrow': {
      const linear = element as LinearElement;
      const path = pointsToPath(linear, linear.curve === 'curved');
      const stroke = hasStroke(linear.style)
        ? `<path d="${path}" fill="none" stroke="${escapeXml(linear.style.stroke)}" stroke-width="${round(linear.style.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"${dashPattern(linear.style).length ? ` stroke-dasharray="${dashPattern(linear.style).map(round).join(' ')}"` : ''}/>`
        : '';
      return stroke + arrowheadToSvg(linear, false) + arrowheadToSvg(linear, true) + labelToSvg(element);
    }

    case 'draw': {
      const stroke = element as DrawElement;
      if (!hasStroke(stroke.style)) return '';
      return `<path d="${pointsToPath(stroke, true)}" fill="none" stroke="${escapeXml(stroke.style.stroke)}" stroke-width="${round(stroke.style.strokeWidth)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }

    case 'text': {
      const text = element as TextElement;
      return textToSvg(text.text, { width: text.width, height: text.height, padding: 0 }, text);
    }

    case 'sticky': {
      const sticky = element as StickyElement;
      const box = `<rect width="${round(sticky.width)}" height="${round(sticky.height)}" rx="4" ry="4" ${style}/>`;
      return (
        box +
        textToSvg(
          sticky.text,
          { width: sticky.width, height: sticky.height, padding: sticky.padding },
          sticky,
        )
      );
    }

    case 'image': {
      const image = element as ImageElement;
      const file = document.files[image.fileId];
      if (!file) return '';
      // `preserveAspectRatio` is SVG's equivalent of CSS object-fit.
      const preserve =
        image.objectFit === 'fill'
          ? 'none'
          : image.objectFit === 'cover'
            ? 'xMidYMid slice'
            : 'xMidYMid meet';
      return `<image width="${round(image.width)}" height="${round(image.height)}" preserveAspectRatio="${preserve}" href="${escapeXml(file.dataUri)}"/>${labelToSvg(element)}`;
    }

    default:
      return '';
  }
}

/**
 * Renders the board as a standalone SVG document.
 *
 * Self-contained: images are inlined as data URIs, so the file can be opened
 * anywhere without accompanying assets.
 */
export function exportToSVG(document: MindflowDocument, options: ExportOptions = {}): string {
  const elements = options.elements ?? document.elements;
  const padding = options.padding ?? 24;
  const bounds = exportBounds(elements, padding);
  if (!bounds) throw new Error('There is nothing on this board to export.');

  const body = elements
    .filter((element) => element.visible)
    .map((element) => {
      const inner = elementToSvg(element, document);
      if (inner === '') return '';
      return `<g transform="${transformAttribute(element)}">${inner}</g>`;
    })
    .filter(Boolean)
    .join('\n    ');

  const background =
    options.background === false
      ? ''
      : `<rect x="${round(bounds.x)}" y="${round(bounds.y)}" width="${round(bounds.width)}" height="${round(bounds.height)}" fill="${escapeXml(document.canvas.background)}"/>\n    `;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"
     width="${round(bounds.width)}" height="${round(bounds.height)}"
     viewBox="${round(bounds.x)} ${round(bounds.y)} ${round(bounds.width)} ${round(bounds.height)}">
  <title>${escapeXml(document.meta.name)}</title>
  <desc>Exported from MindFlow. Source format: mindflow.board ${document.schemaVersion}</desc>
  <g>
    ${background}${body}
  </g>
</svg>
`;
}
