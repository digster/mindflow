/**
 * Drawing helpers shared by every shape module.
 *
 * The text layout functions here are load-bearing for the format's promise of
 * external interpretability: line breaking is a *computed* property, so a file
 * that stores only `"text": "a long sentence"` cannot be rendered identically by
 * another tool unless the wrapping algorithm is specified. It is, both in
 * {@link wrapText} below and in `docs/07-rendering.md`.
 */

import type { ElementLabel, ElementStyle, FontFamily, MindflowElement, Point } from '../../model/types.ts';
import { clamp } from '../../model/geometry.ts';
import { labelBoxOf } from '../../model/registry.ts';

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
 * Distance from the top of a line box down to that line's baseline, in ems.
 *
 * Deliberately a constant rather than the font's real ascent: `docs/07-rendering.md`
 * publishes this number, and a renderer on another machine must be able to place
 * the baseline without knowing which typeface `sans` happened to resolve to.
 *
 * The DOM text editor does not get this for free — CSS places a baseline at
 * `half-leading + ascent`, which is font-specific — so it measures the CSS
 * baseline and corrects itself onto this value. See `ui/textEditor.ts`.
 */
export const BASELINE_RATIO = 0.8;

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
 * `text` with every tab, form feed and carriage return replaced by one space.
 *
 * This is what a canvas does anyway — the HTML text preparation algorithm turns
 * all ASCII whitespace into U+0020 before drawing — so it changes nothing about
 * how MindFlow renders. It is done explicitly for the two readers that would
 * otherwise disagree with the canvas:
 *
 *   - the DOM text editor, where a `<textarea>` advances a tab to the next
 *     8-space tab stop, so every tab-indented line jumped sideways the moment
 *     editing began; and
 *   - the SVG exporter, whose output is laid out by whatever reads the file.
 *
 * One character for one keeps any caret or selection offset into the text valid
 * across the replacement, which the editor relies on.
 */
export function whitespaceAsDrawn(text: string): string {
  return text.replace(/[\t\f\r]/g, ' ');
}

/**
 * What may follow a hyphen-minus with no line break between them: closing
 * brackets and clause punctuation, so `a-.` or `x-)` never splits.
 *
 * This is the set Blink applies to ASCII text, measured in Chromium 152. Its
 * tables come from WebKit, so Safari should agree, though that has not been
 * measured. It matters because the DOM text editor is laid out by the browser's own
 * line breaker, and every place this rule differs from it is a place where a
 * note re-flows the moment editing starts.
 */
const NO_BREAK_AFTER_HYPHEN = new Set('!$),./:;?]}');

/**
 * Whether a line may break between a hyphen-minus and `after`, the character
 * that follows it in the same word.
 *
 * `before`, the character in front of the hyphen, decides two cases:
 *
 *   - A DIGIT. `2024-09` and `ABCD-12` may break, but `-5`, `(-5)` and `x -5`
 *     may not: a hyphen with no letter or digit before it reads as a minus sign.
 *     Only ASCII letters and digits count, as in the browser.
 *   - A NON-ASCII CHARACTER. A letter in any script may start the next line
 *     (`état-` | `major`), unless the hyphen opens its word. Anything else stays
 *     attached, such as a quotation mark, an ellipsis or a non-ASCII digit.
 *
 * A paragraph indent is glued onto the first word, so `before` can be a space.
 * It is treated as no character at all, which is what it means there.
 */
function breaksAfterHyphen(before: string | undefined, after: string): boolean {
  if (NO_BREAK_AFTER_HYPHEN.has(after)) return false;
  const opensWord = before === undefined || before === ' ';
  if (after >= '0' && after <= '9') return !opensWord && /[0-9A-Za-z]/.test(before);
  if (after > '\u007f') return !opensWord && /\p{L}/u.test(after);
  return true;
}

/**
 * Splits one word at every hyphen a line may break after, keeping each hyphen
 * on the part before it: `well-known` becomes `well-` and `known`.
 */
function hyphenParts(word: string): string[] {
  if (!word.includes('-')) return [word];

  const parts: string[] = [];
  let start = 0;
  // Stops one short of the end: a hyphen that ends its word has nothing after
  // it to break before, and the space that follows is a break already.
  for (let index = 0; index < word.length - 1; index++) {
    if (word[index] !== '-') continue;
    // A code point, not a code unit, so an astral letter is tested whole.
    const after = String.fromCodePoint(word.codePointAt(index + 1) ?? 0);
    if (breaksAfterHyphen(word[index - 1], after)) {
      parts.push(word.slice(start, index + 1));
      start = index + 1;
    }
  }
  parts.push(word.slice(start));
  return parts;
}

/**
 * Breaks `text` into rendered lines.
 *
 * THE ALGORITHM — specified here and mirrored in `docs/07-rendering.md`, because
 * an external renderer must reproduce it exactly to match MindFlow's output:
 *
 *   0. Replace every tab, form feed and carriage return with a single space —
 *      see {@link whitespaceAsDrawn}.
 *   1. Split on `\n` into paragraphs. Explicit breaks are always honoured, and
 *      an empty paragraph produces an empty line rather than being collapsed.
 *   2. Within a paragraph, split on single spaces into words. Spaces that
 *      open a paragraph are indentation and are kept.
 *   3. Split each word after every hyphen a line may break after — see
 *      {@link breaksAfterHyphen} — into parts, keeping each hyphen on the part
 *      before it.
 *   4. Greedily append parts to the current line while the measured width of
 *      the result is <= `maxWidth`, joining a word's first part with a space
 *      and its later parts with nothing. Otherwise start a new line. (Greedy,
 *      not Knuth–Plass: simpler, faster, and what every browser and canvas tool
 *      does.)
 *   5. A single part wider than `maxWidth` is broken character by character,
 *      filling each line as far as it fits. This is what prevents a long URL
 *      from overflowing its shape.
 *   6. Trailing spaces are not measured and do not affect breaking.
 *
 * `maxWidth <= 0` disables wrapping entirely; only rules 0 and 1 apply.
 */
export function wrapText(text: string, maxWidth: number, font: string, fontSize: number): string[] {
  const paragraphs = whitespaceAsDrawn(text).split('\n');
  if (maxWidth <= 0) return paragraphs;

  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    // A paragraph's leading spaces are glued onto its first word. The loop below
    // reads an empty `line` as "no word placed yet", so on their own they would
    // be taken for nothing and dropped — which is how an indented note used to
    // lose its indent on the canvas while the DOM editor, like any textarea,
    // kept it. Spaces at a soft wrap are still swallowed, as they are in CSS.
    const indent = /^ */.exec(paragraph)?.[0] ?? '';
    const words = paragraph.slice(indent.length).split(' ');
    words[0] = indent + (words[0] ?? '');
    let line = '';

    for (const word of words) {
      for (const [index, part] of hyphenParts(word).entries()) {
        // A word rejoins the line with the space it was split on; the rest of a
        // hyphenated word rejoins its own first part directly.
        const joiner = index === 0 ? ' ' : '';
        const candidate = line === '' ? part : `${line}${joiner}${part}`;
        if (measureTextWidth(candidate, font, fontSize) <= maxWidth) {
          line = candidate;
          continue;
        }

        // The candidate does not fit. Flush what we have, then deal with the part
        // on its own — it may itself be too wide for a whole line.
        if (line !== '') {
          lines.push(line);
          line = '';
        }

        if (measureTextWidth(part, font, fontSize) <= maxWidth) {
          line = part;
          continue;
        }

        let chunk = '';
        for (const character of part) {
          if (chunk !== '' && measureTextWidth(chunk + character, font, fontSize) > maxWidth) {
            lines.push(chunk);
            chunk = character;
          } else {
            chunk += character;
          }
        }
        line = chunk;
      }
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
    const baseline = originY + index * metrics.lineHeightPx + options.fontSize * BASELINE_RATIO;
    ctx.fillText(line, originX, baseline);
  }

  ctx.restore();
}

/**
 * Draws an element's `label`, if it has one, centred in its label box.
 *
 * The box is usually the element's own, but a type may inset it — a solid puts
 * its label on the front face. `labelBoxOf` is the one reader of that hook, and
 * the DOM text editor consults the same function, which is what keeps the two
 * layout engines agreeing.
 */
export function drawLabel(ctx: CanvasRenderingContext2D, el: MindflowElement): void {
  const label: ElementLabel | null = el.label;
  if (!label || label.text === '') return;

  const box = labelBoxOf(el);
  const innerWidth = Math.max(box.width - label.padding * 2, 1);
  const innerHeight = Math.max(box.height - label.padding * 2, 1);
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
    {
      x: box.x + label.padding,
      y: box.y + label.padding,
      width: innerWidth,
      height: innerHeight,
    },
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
 * Fills the current path with an explicit colour, then strokes it with the
 * element's own stroke. The painting primitive for one face of a solid: the
 * faces differ only in tone, and every edge between them is the same stroke the
 * silhouette uses, so a solid reads as one object rather than three shapes.
 *
 * `fill` of `null` skips the fill, which is how an unfilled solid stays
 * see-through instead of quietly gaining a white interior.
 */
export function paintFace(
  ctx: CanvasRenderingContext2D,
  style: ElementStyle,
  fill: string | null,
): void {
  if (fill !== null) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (hasStroke(style)) {
    applyStroke(ctx, style);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ---------------------------------------------------------------------------
// Face shading
// ---------------------------------------------------------------------------

/**
 * How far a lit or shaded face moves from the element's own fill, 0..1.
 *
 * Published in `docs/07-rendering.md`: the tones are COMPUTED, so a reader
 * given only `"fill": "#a5d8ff"` cannot reproduce a cube without this constant
 * and the formulas in {@link shadeColor}.
 */
export const FACE_SHADE = 0.15;

/**
 * Mixes a hex colour towards white (`amount > 0`) or black (`amount < 0`).
 *
 * Returns the input untouched for anything it cannot parse — `transparent`, a
 * CSS keyword, `rgb()`, a gradient a future version might allow. That is a
 * deliberate fallback rather than an oversight: guessing a tone for an unknown
 * colour space would make MindFlow and an external renderer disagree, whereas
 * "all faces share the fill and the stroke carries the form" is reproducible by
 * anyone. MindFlow itself always writes hex, so the fallback is rare in practice.
 */
export function shadeColor(color: string, amount: number): string {
  const parsed = parseHex(color);
  if (!parsed) return color;

  const mix = (channel: number): number =>
    amount >= 0
      ? Math.round(channel + (255 - channel) * amount)
      : Math.round(channel * (1 + amount));

  const hex = (value: number): string => clamp(mix(value), 0, 255).toString(16).padStart(2, '0');
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}${parsed.a}`;
}

/** `#rgb`, `#rgba`, `#rrggbb` and `#rrggbbaa`, the four forms MindFlow writes. */
function parseHex(color: string): { r: number; g: number; b: number; a: string } | null {
  const value = color.trim();
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return null;

  const body = value.slice(1);
  const short = body.length <= 4;
  const at = (index: number): number => {
    const digits = short ? body[index]!.repeat(2) : body.slice(index * 2, index * 2 + 2);
    return parseInt(digits, 16);
  };

  // Alpha is carried through as text rather than re-emitted, so a fill that
  // arrived as `#rrggbbaa` keeps exactly the transparency it was given.
  const alpha = short
    ? (body[3] ?? '') && body[3]!.repeat(2)
    : body.slice(6, 8);

  return { r: at(0), g: at(1), b: at(2), a: alpha || '' };
}

/**
 * Traces a polyline as the current path.
 *
 * The single entry point for hand-drawn rendering: a shape hands over the points
 * of its clean outline and this decides whether to displace them, so no shape
 * module carries a roughness branch of its own.
 */
export function tracePoints(
  ctx: CanvasRenderingContext2D,
  points: readonly Point[],
  closed: boolean,
): void {
  ctx.beginPath();
  const first = points[0];
  if (!first) return;
  ctx.moveTo(first.x, first.y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  if (closed) ctx.closePath();
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
