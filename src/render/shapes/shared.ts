/**
 * Drawing helpers shared by every shape module.
 *
 * The text layout functions here are load-bearing for the format's promise of
 * external interpretability: line breaking is a *computed* property, so a file
 * that stores only `"text": "a long sentence"` cannot be rendered identically by
 * another tool unless the wrapping algorithm is specified. It is, both in
 * {@link wrapText} below and in `docs/07-rendering.md`.
 */

import type { ElementLabel, ElementStyle, FontFamily, MindflowElement } from '../../model/types.ts';
import { clamp } from '../../model/geometry.ts';

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/**
 * Logical font family → concrete CSS font stack.
 *
 * Documents store the logical name, never the resolved stack. A board authored
 * on a machine with different fonts installed still renders sensibly elsewhere,
 * and the stacks can be improved later without rewriting existing files.
 */
export const FONT_STACKS: Record<FontFamily, string> = {
  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  hand: '"Segoe Print", "Bradley Hand", Chilanka, "Comic Sans MS", cursive',
};

export function fontString(family: FontFamily, size: number, weight: number): string {
  return `${weight} ${size}px ${FONT_STACKS[family]}`;
}

/**
 * A canvas used only for text measurement.
 *
 * Measuring needs a 2D context but not a visible canvas, and creating one per
 * call is expensive enough to show up while typing. One shared 1x1 context is
 * reused for the life of the page.
 */
let measureContext: CanvasRenderingContext2D | null = null;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureContext) return measureContext;
  if (typeof document === 'undefined') return null; // Node, under unit test.
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  measureContext = canvas.getContext('2d');
  return measureContext;
}

/**
 * Width of `text` in scene units for the given font.
 *
 * Falls back to a crude per-character estimate when no canvas is available, so
 * that layout code remains callable from unit tests running under Node. The
 * estimate is never used in the browser.
 */
export function measureTextWidth(text: string, font: string, fontSize: number): number {
  const ctx = getMeasureContext();
  if (!ctx) return text.length * fontSize * 0.55;
  ctx.font = font;
  return ctx.measureText(text).width;
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

/**
 * Breaks `text` into rendered lines.
 *
 * THE ALGORITHM — specified here and mirrored in `docs/07-rendering.md`, because
 * an external renderer must reproduce it exactly to match MindFlow's output:
 *
 *   1. Split on `\n` into paragraphs. Explicit breaks are always honoured, and
 *      an empty paragraph produces an empty line rather than being collapsed.
 *   2. Within a paragraph, split on single spaces into words.
 *   3. Greedily append words to the current line while the measured width of the
 *      line plus a space plus the word is <= `maxWidth`. Otherwise start a new
 *      line. (Greedy, not Knuth–Plass: simpler, faster, and what every browser
 *      and canvas tool does.)
 *   4. A single word wider than `maxWidth` is broken character by character,
 *      filling each line as far as it fits. This is what prevents a long URL
 *      from overflowing its shape.
 *   5. Trailing spaces are not measured and do not affect breaking.
 *
 * `maxWidth <= 0` disables wrapping entirely; only rule 1 applies.
 */
export function wrapText(text: string, maxWidth: number, font: string, fontSize: number): string[] {
  const paragraphs = text.split('\n');
  if (maxWidth <= 0) return paragraphs;

  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let line = '';

    for (const word of words) {
      const candidate = line === '' ? word : `${line} ${word}`;
      if (measureTextWidth(candidate, font, fontSize) <= maxWidth) {
        line = candidate;
        continue;
      }

      // The candidate does not fit. Flush what we have, then deal with the word
      // on its own — it may itself be too wide for a whole line.
      if (line !== '') {
        lines.push(line);
        line = '';
      }

      if (measureTextWidth(word, font, fontSize) <= maxWidth) {
        line = word;
        continue;
      }

      let chunk = '';
      for (const character of word) {
        if (chunk !== '' && measureTextWidth(chunk + character, font, fontSize) > maxWidth) {
          lines.push(chunk);
          chunk = character;
        } else {
          chunk += character;
        }
      }
      line = chunk;
    }

    lines.push(line);
  }

  return lines;
}

export interface TextBlockMetrics {
  lines: string[];
  lineHeightPx: number;
  width: number;
  height: number;
}

/** Lays out a block of text and reports the box it occupies. */
export function layoutText(
  text: string,
  options: { maxWidth: number; fontFamily: FontFamily; fontSize: number; fontWeight: number; lineHeight: number },
): TextBlockMetrics {
  const font = fontString(options.fontFamily, options.fontSize, options.fontWeight);
  const lines = wrapText(text, options.maxWidth, font, options.fontSize);
  const lineHeightPx = options.fontSize * options.lineHeight;
  let width = 0;
  for (const line of lines) {
    const w = measureTextWidth(line, font, options.fontSize);
    if (w > width) width = w;
  }
  return { lines, lineHeightPx, width, height: Math.max(lines.length, 1) * lineHeightPx };
}

/**
 * Draws laid-out text into a box in local coordinates.
 *
 * Vertical placement uses the `alphabetic` baseline plus a fixed 0.8 em offset
 * rather than `textBaseline = 'middle'`, because `middle` is defined against
 * font-specific metrics and drifts noticeably between typefaces — which would
 * make the canvas render and the DOM text editor disagree.
 */
export function drawTextBlock(
  ctx: CanvasRenderingContext2D,
  metrics: TextBlockMetrics,
  box: { x: number; y: number; width: number; height: number },
  options: {
    color: string;
    textAlign: 'left' | 'center' | 'right';
    verticalAlign: 'top' | 'middle' | 'bottom';
    fontFamily: FontFamily;
    fontSize: number;
    fontWeight: number;
  },
): void {
  ctx.save();
  ctx.font = fontString(options.fontFamily, options.fontSize, options.fontWeight);
  ctx.fillStyle = options.color;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = options.textAlign === 'center' ? 'center' : options.textAlign === 'right' ? 'right' : 'left';

  const blockHeight = metrics.lines.length * metrics.lineHeightPx;
  let originY: number;
  switch (options.verticalAlign) {
    case 'top':
      originY = box.y;
      break;
    case 'bottom':
      originY = box.y + box.height - blockHeight;
      break;
    default:
      originY = box.y + (box.height - blockHeight) / 2;
  }

  let originX: number;
  switch (options.textAlign) {
    case 'center':
      originX = box.x + box.width / 2;
      break;
    case 'right':
      originX = box.x + box.width;
      break;
    default:
      originX = box.x;
  }

  for (const [index, line] of metrics.lines.entries()) {
    // 0.8em approximates the cap-height baseline offset across the stacks we
    // ship, and is stable regardless of which font actually resolves.
    const baseline = originY + index * metrics.lineHeightPx + options.fontSize * 0.8;
    ctx.fillText(line, originX, baseline);
  }

  ctx.restore();
}

/** Draws an element's `label`, if it has one, centred in its local box. */
export function drawLabel(ctx: CanvasRenderingContext2D, el: MindflowElement): void {
  const label: ElementLabel | null = el.label;
  if (!label || label.text === '') return;

  const innerWidth = Math.max(el.width - label.padding * 2, 1);
  const innerHeight = Math.max(el.height - label.padding * 2, 1);
  const metrics = layoutText(label.text, {
    maxWidth: innerWidth,
    fontFamily: label.fontFamily,
    fontSize: label.fontSize,
    fontWeight: label.fontWeight,
    lineHeight: label.lineHeight,
  });

  drawTextBlock(
    ctx,
    metrics,
    { x: label.padding, y: label.padding, width: innerWidth, height: innerHeight },
    {
      color: label.color,
      textAlign: label.textAlign,
      verticalAlign: label.verticalAlign,
      fontFamily: label.fontFamily,
      fontSize: label.fontSize,
      fontWeight: label.fontWeight,
    },
  );
}

// ---------------------------------------------------------------------------
// Stroke and fill
// ---------------------------------------------------------------------------

/**
 * Dash pattern for a stroke style, scaled by width so a thick dashed line looks
 * proportionate rather than finely stippled.
 */
export function dashPattern(style: ElementStyle): number[] {
  const w = Math.max(style.strokeWidth, 1);
  switch (style.strokeStyle) {
    case 'dashed':
      return [w * 4, w * 3];
    case 'dotted':
      return [w * 0.1, w * 2.5];
    default:
      return [];
  }
}

export function hasFill(style: ElementStyle): boolean {
  return style.fillStyle !== 'none' && style.fill !== 'transparent' && style.fill !== '';
}

export function hasStroke(style: ElementStyle): boolean {
  return style.strokeWidth > 0 && style.stroke !== 'transparent' && style.stroke !== '';
}

/** Applies stroke properties to the context, ready for a `stroke()` call. */
export function applyStroke(ctx: CanvasRenderingContext2D, style: ElementStyle): void {
  ctx.strokeStyle = style.stroke;
  ctx.lineWidth = style.strokeWidth;
  ctx.lineCap = style.strokeStyle === 'dotted' ? 'round' : 'butt';
  ctx.lineJoin = 'round';
  ctx.setLineDash(dashPattern(style));
}

/** Fills then strokes the current path, honouring the style's on/off switches. */
export function paintPath(ctx: CanvasRenderingContext2D, style: ElementStyle): void {
  if (hasFill(style)) {
    ctx.fillStyle = style.fill;
    ctx.fill();
  }
  if (hasStroke(style)) {
    applyStroke(ctx, style);
    ctx.stroke();
    ctx.setLineDash([]); // Leave the context clean for the next element.
  }
}

/**
 * Builds a rounded-rectangle path in local coordinates.
 *
 * The radius is clamped to half the shorter side, which is what turns an
 * absurdly large `cornerRadius` into a stadium instead of invalid geometry —
 * behaviour promised in `docs/03-elements.md`.
 */
export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  radius: number,
): void {
  const r = clamp(radius, 0, Math.min(width, height) / 2);
  ctx.beginPath();
  if (r <= 0) {
    ctx.rect(0, 0, width, height);
    return;
  }
  ctx.moveTo(r, 0);
  ctx.lineTo(width - r, 0);
  ctx.arcTo(width, 0, width, r, r);
  ctx.lineTo(width, height - r);
  ctx.arcTo(width, height, width - r, height, r);
  ctx.lineTo(r, height);
  ctx.arcTo(0, height, 0, height - r, r);
  ctx.lineTo(0, r);
  ctx.arcTo(0, 0, r, 0, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Shared normalisation
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function numberOr(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

export function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function enumOr<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Coerces a loosely-typed points array into valid {@link PointTuple}s.
 *
 * Accepts both `[x, y]` tuples and `{x, y}` objects on input, because both are
 * natural things for an external generator to produce. Output is always tuples.
 */
export function normalizePoints(value: unknown): [number, number][] | [number, number, number][] {
  if (!Array.isArray(value)) return [];
  const out: number[][] = [];
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const x = numberOr(entry[0], 0);
      const y = numberOr(entry[1], 0);
      if (entry.length > 2 && typeof entry[2] === 'number') {
        out.push([x, y, clamp(entry[2], 0, 1)]);
      } else {
        out.push([x, y]);
      }
    } else if (isRecord(entry)) {
      out.push([numberOr(entry.x, 0), numberOr(entry.y, 0)]);
    }
  }
  return out as [number, number][];
}
