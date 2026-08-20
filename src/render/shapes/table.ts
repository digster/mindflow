/**
 * Table element — a grid of independently editable text cells.
 *
 * ---------------------------------------------------------------------------
 * Tracks are proportions, not lengths
 * ---------------------------------------------------------------------------
 * `columns` and `rows` hold *relative* sizes. A track's rendered size is
 *
 *     track / Σ tracks × boxDimension
 *
 * so the element's `width`/`height` remain the single source of truth for how
 * much room the table occupies. The payoff is that resizing a table is the
 * ordinary base-geometry change every other type gets: nothing has to rewrite
 * the tracks, and there is no state in which the tracks and the box disagree.
 * Storing absolute lengths instead would need a type-specific resize path in
 * `input/transform.ts` — code that is forbidden from knowing what a table is.
 *
 * Everything that *does* change the structure (insert, delete, drag a divider)
 * therefore adjusts the box as well as the tracks, so that the tracks the user
 * did not touch keep their rendered size. See {@link insertTrack}.
 *
 * ---------------------------------------------------------------------------
 * Cells are addressed as text regions
 * ---------------------------------------------------------------------------
 * A table owns many independent blocks of text rather than one, so it
 * implements the registry's `textRegions` API: an opaque key plus a local-frame
 * box per cell. That is everything the text editor needs to place itself over a
 * cell and everything the search index needs to read the words, without either
 * of them knowing what a row or a column is.
 */

import type {
  ElementDefinition,
  ElementInit,
  InteriorHandle,
  RenderContext,
  TextRegion,
} from '../../model/registry.ts';
import { registerElement } from '../../model/registry.ts';
import type { BaseElement, Point, TableElement } from '../../model/types.ts';
import { FONT_FAMILIES, TEXT_ALIGNS, VERTICAL_ALIGNS } from '../../model/types.ts';
import {
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT,
  DEFAULT_STYLE,
  DEFAULT_TEXT_COLOR,
  newElementId,
} from '../../model/defaults.ts';
import { clamp } from '../../model/geometry.ts';
import {
  applyStroke,
  drawTextBlock,
  enumOr,
  hasFill,
  hasStroke,
  layoutText,
  numberOr,
  booleanOr,
  stringOr,
} from './shared.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TABLE_DEFAULT_COLUMNS = 3;
export const TABLE_DEFAULT_ROWS = 3;
/** Rendered size of one track in a table created by a click rather than a drag. */
export const TABLE_DEFAULT_COLUMN_WIDTH = 120;
export const TABLE_DEFAULT_ROW_HEIGHT = 40;

const TABLE_FONT_SIZE = 14;
const TABLE_PADDING = 8;
export const TABLE_HEADER_FILL = '#f1f3f5';

/**
 * Weight the header row is drawn at.
 *
 * `Math.max` rather than a flat value: a user who has already set the table's
 * own weight to 700 expects the header to be at least as heavy, not lighter.
 */
export const TABLE_HEADER_FONT_WEIGHT = 600;

/** Smallest rendered track size a divider drag will produce, in scene units. */
export const TABLE_MIN_TRACK = 16;

/**
 * Upper bound on rows and columns accepted from a file.
 *
 * Rendering is O(rows × columns) and a hand-authored or generated document can
 * name any number it likes. The cap is far above any table a person would draw
 * and far below a number that would lock up the renderer.
 */
const MAX_TRACKS = 200;

// ---------------------------------------------------------------------------
// Track geometry
// ---------------------------------------------------------------------------

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

/**
 * Rendered sizes of `tracks` laid across `total`.
 *
 * This is the whole layout rule, and it is published in `docs/07-rendering.md`.
 * A degenerate `tracks` (all zeroes, which normalisation prevents but a raw
 * object literal in a test does not) divides the space evenly rather than
 * producing NaN.
 */
export function trackSizes(tracks: readonly number[], total: number): number[] {
  const weight = sum(tracks);
  if (!(weight > 0)) {
    const even = total / Math.max(tracks.length, 1);
    return tracks.map(() => even);
  }
  return tracks.map((track) => (track * total) / weight);
}

/**
 * Cumulative track boundaries, in local coordinates.
 *
 * Length is `tracks.length + 1`: the first entry is always 0 and the last is
 * `total`. Accumulating rather than summing per index keeps a long track list
 * free of the drift that repeated partial sums would introduce.
 */
export function trackEdges(tracks: readonly number[], total: number): number[] {
  const sizes = trackSizes(tracks, total);
  const edges = [0];
  let position = 0;
  for (const size of sizes) {
    position += size;
    edges.push(position);
  }
  // Pin the far edge: floating-point accumulation can leave it a hair short of
  // `total`, which would show as a one-pixel gap at the right or bottom border.
  edges[edges.length - 1] = total;
  return edges;
}

export function columnEdges(el: TableElement): number[] {
  return trackEdges(el.columns, el.width);
}

export function rowEdges(el: TableElement): number[] {
  return trackEdges(el.rows, el.height);
}

export interface CellRef {
  row: number;
  column: number;
}

/** The local-frame box of one cell. */
export function cellBox(
  el: TableElement,
  row: number,
  column: number,
): { x: number; y: number; width: number; height: number } {
  const xs = columnEdges(el);
  const ys = rowEdges(el);
  const x = xs[column] ?? 0;
  const y = ys[row] ?? 0;
  return {
    x,
    y,
    width: Math.max((xs[column + 1] ?? x) - x, 0),
    height: Math.max((ys[row + 1] ?? y) - y, 0),
  };
}

/** The cell containing a point in the element's local frame, or `null`. */
export function cellAt(el: TableElement, local: Point): CellRef | null {
  if (local.x < 0 || local.y < 0 || local.x > el.width || local.y > el.height) return null;
  const column = trackIndexAt(columnEdges(el), local.x);
  const row = trackIndexAt(rowEdges(el), local.y);
  if (column === null || row === null) return null;
  return { row, column };
}

function trackIndexAt(edges: readonly number[], position: number): number | null {
  for (let index = 0; index + 1 < edges.length; index++) {
    if (position >= (edges[index] as number) && position <= (edges[index + 1] as number)) {
      return index;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Cell keys
// ---------------------------------------------------------------------------

/**
 * The opaque key the registry's text-region API passes around.
 *
 * `row:column` is human-readable in a debugger and trivially parseable, but
 * nothing outside this module may rely on that — the registry documents the key
 * as opaque, and treating it otherwise would put knowledge of cells back into
 * the callers this API exists to keep ignorant of them.
 */
export function cellKey(row: number, column: number): string {
  return `${row}:${column}`;
}

export function parseCellKey(key: string): CellRef | null {
  const [rowText, columnText] = key.split(':');
  const row = Number.parseInt(rowText ?? '', 10);
  const column = Number.parseInt(columnText ?? '', 10);
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null;
  return { row, column };
}

// ---------------------------------------------------------------------------
// Structural edits
// ---------------------------------------------------------------------------

/**
 * Inserts a track, growing the box so every existing track keeps its rendered
 * size.
 *
 * The algebra: rendered size is `w_j × total / Σ`, so leaving every existing
 * `w_j` alone and scaling `total` by `(Σ + w) / Σ` leaves `total / Σ` unchanged
 * and therefore every existing rendered size unchanged. The new track lands at
 * exactly the rendered size its weight describes.
 */
function insertTrack(
  tracks: readonly number[],
  total: number,
  at: number,
  weight: number,
): { tracks: number[]; total: number } {
  const weightSum = sum(tracks);
  const index = clamp(at, 0, tracks.length);
  const next = [...tracks];
  next.splice(index, 0, weight);
  if (!(weightSum > 0)) return { tracks: next, total };
  return { tracks: next, total: (total * (weightSum + weight)) / weightSum };
}

/** Removes a track, shrinking the box so the survivors keep their rendered size. */
function removeTrack(
  tracks: readonly number[],
  total: number,
  at: number,
): { tracks: number[]; total: number } {
  // A table with no columns has no cells and no way back; refuse rather than
  // producing an element the renderer would have to defend against.
  if (tracks.length <= 1 || at < 0 || at >= tracks.length) {
    return { tracks: [...tracks], total };
  }
  const weightSum = sum(tracks);
  const removed = tracks[at] as number;
  const next = tracks.filter((_, index) => index !== at);
  if (!(weightSum > 0) || weightSum - removed <= 0) return { tracks: next, total };
  return { tracks: next, total: (total * (weightSum - removed)) / weightSum };
}

/**
 * Sets one track's rendered size, leaving every other track's alone.
 *
 * Both the weight and the box change, in the ratio that keeps `total / Σ`
 * constant — the same invariant {@link insertTrack} relies on.
 */
function resizeTrack(
  tracks: readonly number[],
  total: number,
  at: number,
  size: number,
): { tracks: number[]; total: number } {
  const current = trackSizes(tracks, total)[at];
  const weight = tracks[at];
  if (current === undefined || weight === undefined || !(current > 0)) {
    return { tracks: [...tracks], total };
  }
  const wanted = Math.max(size, TABLE_MIN_TRACK);
  const next = [...tracks];
  next[at] = (weight * wanted) / current;
  return { tracks: next, total: total - current + wanted };
}

/** The weight a newly inserted track should take: its neighbour's, else the mean. */
function referenceWeight(tracks: readonly number[], at: number): number {
  const neighbour = tracks[clamp(at, 0, tracks.length - 1)];
  if (neighbour !== undefined && neighbour > 0) return neighbour;
  const mean = sum(tracks) / Math.max(tracks.length, 1);
  return mean > 0 ? mean : 1;
}

function emptyRow(length: number): string[] {
  return Array.from({ length }, () => '');
}

/** Inserts a row at `at` (0 = above the first row, `rows.length` = at the end). */
export function insertRow(el: TableElement, at: number): TableElement {
  if (el.rows.length >= MAX_TRACKS) return el;
  const index = clamp(Math.round(at), 0, el.rows.length);
  const { tracks, total } = insertTrack(el.rows, el.height, index, referenceWeight(el.rows, index));
  const cells = el.cells.map((row) => [...row]);
  cells.splice(index, 0, emptyRow(el.columns.length));
  return { ...el, rows: tracks, height: Math.max(total, 1), cells };
}

export function removeRow(el: TableElement, at: number): TableElement {
  if (el.rows.length <= 1) return el;
  const index = clamp(Math.round(at), 0, el.rows.length - 1);
  const { tracks, total } = removeTrack(el.rows, el.height, index);
  const cells = el.cells.filter((_, row) => row !== index).map((row) => [...row]);
  return { ...el, rows: tracks, height: Math.max(total, 1), cells };
}

/** Inserts a column at `at` (0 = left of the first, `columns.length` = at the end). */
export function insertColumn(el: TableElement, at: number): TableElement {
  if (el.columns.length >= MAX_TRACKS) return el;
  const index = clamp(Math.round(at), 0, el.columns.length);
  const { tracks, total } = insertTrack(
    el.columns,
    el.width,
    index,
    referenceWeight(el.columns, index),
  );
  const cells = el.cells.map((row) => {
    const next = [...row];
    next.splice(index, 0, '');
    return next;
  });
  return { ...el, columns: tracks, width: Math.max(total, 1), cells };
}

export function removeColumn(el: TableElement, at: number): TableElement {
  if (el.columns.length <= 1) return el;
  const index = clamp(Math.round(at), 0, el.columns.length - 1);
  const { tracks, total } = removeTrack(el.columns, el.width, index);
  const cells = el.cells.map((row) => row.filter((_, column) => column !== index));
  return { ...el, columns: tracks, width: Math.max(total, 1), cells };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Coerces a track array.
 *
 * A bad entry becomes `1` rather than being dropped: the track count decides
 * how `cells` is indexed, so silently losing one would shift every cell after
 * it into the wrong column — a far worse outcome than one oddly-sized track.
 */
function normalizeTracks(raw: unknown, fallbackCount: number): number[] {
  const source = Array.isArray(raw) ? raw : [];
  const out: number[] = [];
  for (const entry of source.slice(0, MAX_TRACKS)) {
    const value = numberOr(entry, 0);
    out.push(value > 0 && Number.isFinite(value) ? value : 1);
  }
  if (out.length === 0) for (let i = 0; i < fallbackCount; i++) out.push(1);
  return out;
}

/**
 * Coerces `cells` to exactly `rowCount × columnCount` strings.
 *
 * Padding and truncating here rather than defending at every read site is what
 * lets the renderer, the exporter and the text editor index `cells[r][c]`
 * without a bounds check. Numbers and booleans are stringified: they are the
 * single most common thing a generator puts in a cell, and blanking them would
 * lose data for no gain.
 */
function normalizeCells(raw: unknown, rowCount: number, columnCount: number): string[][] {
  const source = Array.isArray(raw) ? raw : [];
  const out: string[][] = [];
  for (let row = 0; row < rowCount; row++) {
    const rawRow = Array.isArray(source[row]) ? (source[row] as unknown[]) : [];
    const cells: string[] = [];
    for (let column = 0; column < columnCount; column++) {
      const value = rawRow[column];
      if (typeof value === 'string') cells.push(value);
      else if (typeof value === 'number' && Number.isFinite(value)) cells.push(String(value));
      else if (typeof value === 'boolean') cells.push(String(value));
      else cells.push('');
    }
    out.push(cells);
  }
  return out;
}

/** Track count implied by `cells` when `columns`/`rows` are missing entirely. */
function impliedColumnCount(rawCells: unknown): number {
  if (!Array.isArray(rawCells)) return TABLE_DEFAULT_COLUMNS;
  let widest = 0;
  for (const row of rawCells) if (Array.isArray(row) && row.length > widest) widest = row.length;
  return widest > 0 ? Math.min(widest, MAX_TRACKS) : TABLE_DEFAULT_COLUMNS;
}

function impliedRowCount(rawCells: unknown): number {
  if (!Array.isArray(rawCells) || rawCells.length === 0) return TABLE_DEFAULT_ROWS;
  return Math.min(rawCells.length, MAX_TRACKS);
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/**
 * Font weight a given row is drawn at.
 *
 * Exported because the SVG exporter is a second, independent renderer and has
 * to reach the same answer; a header that is bold on screen and regular in the
 * export is exactly the drift `docs/07-rendering.md` exists to prevent.
 */
export function cellFontWeight(el: TableElement, row: number): number {
  return el.headerRow && row === 0
    ? Math.max(el.fontWeight, TABLE_HEADER_FONT_WEIGHT)
    : el.fontWeight;
}

function drawCellText(el: TableElement, ctx: CanvasRenderingContext2D, row: number, column: number): void {
  const text = el.cells[row]?.[column] ?? '';
  if (text === '') return;

  const box = cellBox(el, row, column);
  const innerWidth = Math.max(box.width - el.padding * 2, 1);
  const innerHeight = Math.max(box.height - el.padding * 2, 1);
  const fontWeight = cellFontWeight(el, row);

  const metrics = layoutText(text, {
    maxWidth: innerWidth,
    fontFamily: el.fontFamily,
    fontSize: el.fontSize,
    fontWeight,
    lineHeight: el.lineHeight,
  });

  // Clipped to the cell, for the same reason a sticky note clips its text: an
  // overfull cell should look full rather than spill its words across the
  // neighbouring column.
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  drawTextBlock(
    ctx,
    metrics,
    { x: box.x + el.padding, y: box.y + el.padding, width: innerWidth, height: innerHeight },
    {
      color: el.color,
      textAlign: el.textAlign,
      verticalAlign: el.verticalAlign,
      fontFamily: el.fontFamily,
      fontSize: el.fontSize,
      fontWeight,
    },
  );
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

export const tableDefinition: ElementDefinition<TableElement> = {
  type: 'table',
  title: 'Table',

  capabilities: {
    // No `label`: a table's text lives in its cells, and a second block of text
    // floating over the middle of the grid would have nowhere sensible to go.
    label: false,
    path: false,
    // Owns its text directly — addressed per region rather than as one field.
    text: true,
    resizable: true,
    rotatable: true,
    bindable: true,
  },

  create(init: ElementInit): TableElement {
    const columnCount = Math.max(1, Math.round(numberOr(init.columnCount, TABLE_DEFAULT_COLUMNS)));
    const rowCount = Math.max(1, Math.round(numberOr(init.rowCount, TABLE_DEFAULT_ROWS)));
    return {
      id: newElementId(),
      type: 'table',
      x: init.x,
      y: init.y,
      width: Math.max(init.width ?? columnCount * TABLE_DEFAULT_COLUMN_WIDTH, 1),
      height: Math.max(init.height ?? rowCount * TABLE_DEFAULT_ROW_HEIGHT, 1),
      angle: 0,
      zIndex: init.zIndex,
      opacity: 1,
      locked: false,
      visible: true,
      groupId: null,
      frameId: null,
      style: {
        ...DEFAULT_STYLE,
        // A table reads as a document, not as a drawing: an opaque background so
        // the grid does not sit on top of whatever is behind it, and hairline
        // rules, since 2px gridlines at the shared default overwhelm 14px text.
        stroke: '#adb5bd',
        strokeWidth: 1,
        fill: '#ffffff',
        fillStyle: 'solid',
        ...(init.style as object | undefined),
      },
      label: null,
      meta: {},
      // Equal weights, written as 1s rather than as scene units: the numbers
      // stay meaningful after any resize, and `[2, 1, 1]` says "the first column
      // is twice as wide" far more directly than a pair of pixel counts.
      columns: Array.from({ length: columnCount }, () => 1),
      rows: Array.from({ length: rowCount }, () => 1),
      cells: Array.from({ length: rowCount }, () => emptyRow(columnCount)),
      headerRow: booleanOr(init.headerRow, true),
      headerFill: stringOr(init.headerFill, TABLE_HEADER_FILL),
      fontFamily: enumOr(init.fontFamily, FONT_FAMILIES, DEFAULT_FONT_FAMILY),
      fontSize: numberOr(init.fontSize, TABLE_FONT_SIZE),
      fontWeight: numberOr(init.fontWeight, DEFAULT_FONT_WEIGHT),
      lineHeight: numberOr(init.lineHeight, DEFAULT_LINE_HEIGHT),
      color: stringOr(init.color, DEFAULT_TEXT_COLOR),
      textAlign: enumOr(init.textAlign, TEXT_ALIGNS, 'left'),
      verticalAlign: enumOr(init.verticalAlign, VERTICAL_ALIGNS, 'middle'),
      padding: numberOr(init.padding, TABLE_PADDING),
    };
  },

  normalize(raw: Record<string, unknown>, base: BaseElement): TableElement {
    // `cells` decides the shape when the tracks are absent, so that a generator
    // can emit nothing but a grid of strings and get a sensible table back.
    const columns = normalizeTracks(raw.columns, impliedColumnCount(raw.cells));
    const rows = normalizeTracks(raw.rows, impliedRowCount(raw.cells));
    return {
      ...base,
      type: 'table',
      columns,
      rows,
      cells: normalizeCells(raw.cells, rows.length, columns.length),
      headerRow: booleanOr(raw.headerRow, false),
      headerFill: stringOr(raw.headerFill, TABLE_HEADER_FILL),
      fontFamily: enumOr(raw.fontFamily, FONT_FAMILIES, DEFAULT_FONT_FAMILY),
      fontSize: Math.max(1, numberOr(raw.fontSize, TABLE_FONT_SIZE)),
      fontWeight: clamp(numberOr(raw.fontWeight, DEFAULT_FONT_WEIGHT), 100, 900),
      lineHeight: Math.max(0.5, numberOr(raw.lineHeight, DEFAULT_LINE_HEIGHT)),
      color: stringOr(raw.color, DEFAULT_TEXT_COLOR),
      textAlign: enumOr(raw.textAlign, TEXT_ALIGNS, 'left'),
      verticalAlign: enumOr(raw.verticalAlign, VERTICAL_ALIGNS, 'middle'),
      padding: Math.max(0, numberOr(raw.padding, TABLE_PADDING)),
    };
  },

  draw(el: TableElement, { ctx }: RenderContext): void {
    const xs = columnEdges(el);
    const ys = rowEdges(el);

    if (hasFill(el.style)) {
      ctx.fillStyle = el.style.fill;
      ctx.fillRect(0, 0, el.width, el.height);
    }

    // The header band is painted over the body fill rather than instead of it,
    // so a translucent header colour composites the way the swatch suggests.
    if (el.headerRow && el.rows.length > 0) {
      ctx.fillStyle = el.headerFill;
      ctx.fillRect(0, 0, el.width, ys[1] ?? 0);
    }

    for (let row = 0; row < el.rows.length; row++) {
      for (let column = 0; column < el.columns.length; column++) {
        drawCellText(el, ctx, row, column);
      }
    }

    if (!hasStroke(el.style)) return;

    // Interior rules and the outer border share one path so the dash pattern
    // runs continuously and the whole grid costs a single stroke call.
    ctx.beginPath();
    for (let index = 1; index + 1 < xs.length; index++) {
      const x = xs[index] as number;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, el.height);
    }
    for (let index = 1; index + 1 < ys.length; index++) {
      const y = ys[index] as number;
      ctx.moveTo(0, y);
      ctx.lineTo(el.width, y);
    }
    ctx.rect(0, 0, el.width, el.height);
    applyStroke(ctx, el.style);
    ctx.stroke();
    ctx.setLineDash([]); // Leave the context clean for the next element.
  },

  /**
   * Solid: a table is a content container, like a sticky note or an image, and
   * clicking a cell to type in it must work whether or not that cell has a fill.
   */
  hitTest(el: TableElement, local: Point, tolerance: number): boolean {
    return (
      local.x >= -tolerance &&
      local.y >= -tolerance &&
      local.x <= el.width + tolerance &&
      local.y <= el.height + tolerance
    );
  },

  // -------------------------------------------------------------------------
  // Text regions — one per cell, in tab order
  // -------------------------------------------------------------------------

  textRegions(el: TableElement): TextRegion[] {
    const regions: TextRegion[] = [];
    for (let row = 0; row < el.rows.length; row++) {
      for (let column = 0; column < el.columns.length; column++) {
        const weight = cellFontWeight(el, row);
        regions.push({
          key: cellKey(row, column),
          box: cellBox(el, row, column),
          text: el.cells[row]?.[column] ?? '',
          // Only when it differs, so the editor's typography cache is not keyed
          // on a redundant value for every ordinary cell.
          ...(weight === el.fontWeight ? {} : { fontWeight: weight }),
        });
      }
    }
    return regions;
  },

  textRegionAt(el: TableElement, local: Point): string | null {
    const cell = cellAt(el, local);
    return cell ? cellKey(cell.row, cell.column) : null;
  },

  withRegionText(el: TableElement, key: string, text: string): TableElement {
    const cell = parseCellKey(key);
    if (!cell) return el;
    const { row, column } = cell;
    if (row < 0 || row >= el.rows.length || column < 0 || column >= el.columns.length) return el;
    const cells = el.cells.map((values, index) =>
      index === row ? values.map((value, at) => (at === column ? text : value)) : values,
    );
    return { ...el, cells };
  },

  // -------------------------------------------------------------------------
  // Interior dividers — drag to re-proportion a column or row
  // -------------------------------------------------------------------------

  interiorHandles(el: TableElement): InteriorHandle[] {
    const handles: InteriorHandle[] = [];
    const xs = columnEdges(el);
    const ys = rowEdges(el);
    // The outer edges are excluded: those are the element's own resize handles,
    // and offering two different gestures on the same pixel would be a coin toss.
    for (let index = 1; index + 1 < xs.length; index++) {
      handles.push({ id: `c${index}`, axis: 'x', position: xs[index] as number });
    }
    for (let index = 1; index + 1 < ys.length; index++) {
      handles.push({ id: `r${index}`, axis: 'y', position: ys[index] as number });
    }
    return handles;
  },

  dragInteriorHandle(el: TableElement, id: string, local: Point): TableElement {
    const index = Number.parseInt(id.slice(1), 10);
    if (!Number.isInteger(index) || index < 1) return el;

    if (id.startsWith('c')) {
      if (index >= el.columns.length) return el;
      // The divider belongs to the track on its left: dragging it sets that
      // track's size and pushes everything to its right along, which is what a
      // table user expects and what avoids fighting the neighbour's minimum.
      const edges = columnEdges(el);
      const size = local.x - (edges[index - 1] as number);
      const { tracks, total } = resizeTrack(el.columns, el.width, index - 1, size);
      return { ...el, columns: tracks, width: Math.max(total, 1) };
    }

    if (id.startsWith('r')) {
      if (index >= el.rows.length) return el;
      const edges = rowEdges(el);
      const size = local.y - (edges[index - 1] as number);
      const { tracks, total } = resizeTrack(el.rows, el.height, index - 1, size);
      return { ...el, rows: tracks, height: Math.max(total, 1) };
    }

    return el;
  },
};

registerElement(tableDefinition);
