/**
 * Table geometry, structure and normalisation.
 *
 * The rules pinned here are the ones an external tool has to reimplement to read
 * or rewrite a board containing a table, so they are specified in
 * `docs/03-elements.md` and `docs/07-rendering.md` before they are tested here:
 * tracks as proportions, the exact cell grid, and structural edits that leave
 * every untouched track at the size it was.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { loadDocument, serializeDocument } from '../../src/model/document.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { searchableText } from '../../src/model/search.ts';
import type { TableElement } from '../../src/model/types.ts';
import {
  TABLE_MIN_TRACK,
  cellAt,
  cellBox,
  cellFontWeight,
  cellKey,
  columnEdges,
  insertColumn,
  insertRow,
  parseCellKey,
  removeColumn,
  removeRow,
  rowEdges,
  tableDefinition,
  trackSizes,
} from '../../src/render/shapes/table.ts';

function table(overrides: Partial<TableElement> = {}): TableElement {
  return {
    ...tableDefinition.create({ x: 0, y: 0, width: 300, height: 120, zIndex: 1000 }),
    ...overrides,
  };
}

/** Rendered column widths, which is what every assertion below is really about. */
function columnWidths(el: TableElement): number[] {
  return trackSizes(el.columns, el.width);
}

function rowHeights(el: TableElement): number[] {
  return trackSizes(el.rows, el.height);
}

describe('track sizing', () => {
  it('divides the box in proportion to the weights', () => {
    expect(trackSizes([1, 1, 1], 300)).toEqual([100, 100, 100]);
    expect(trackSizes([2, 1, 1], 400)).toEqual([200, 100, 100]);
  });

  it('is invariant to the scale of the weights', () => {
    // The property that makes tracks proportions rather than lengths: [1,1] and
    // [50,50] are the same table.
    expect(trackSizes([50, 50], 300)).toEqual(trackSizes([1, 1], 300));
  });

  it('divides evenly when the weights sum to zero', () => {
    // Normalisation prevents this, but a hand-written object can still reach the
    // renderer, and NaN geometry is far worse than an even split.
    expect(trackSizes([0, 0], 200)).toEqual([100, 100]);
  });

  it('pins the far edge to the box rather than accumulating to it', () => {
    // Three thirds of 100 do not sum to 100 in binary floating point. The right
    // border has to land exactly on the box or it leaves a hairline gap.
    const edges = columnEdges(table({ columns: [1, 1, 1], width: 100 }));
    expect(edges[3]).toBe(100);
  });
});

describe('cell geometry', () => {
  const el = table({ columns: [2, 1, 1], rows: [1, 1], width: 400, height: 100 });

  it('tiles the box exactly', () => {
    expect(cellBox(el, 0, 0)).toEqual({ x: 0, y: 0, width: 200, height: 50 });
    expect(cellBox(el, 1, 2)).toEqual({ x: 300, y: 50, width: 100, height: 50 });
  });

  it('resolves a local point to a cell', () => {
    expect(cellAt(el, { x: 10, y: 10 })).toEqual({ row: 0, column: 0 });
    expect(cellAt(el, { x: 250, y: 75 })).toEqual({ row: 1, column: 1 });
  });

  it('returns null outside the box', () => {
    expect(cellAt(el, { x: -1, y: 10 })).toBeNull();
    expect(cellAt(el, { x: 10, y: 101 })).toBeNull();
  });

  it('round-trips a cell key', () => {
    expect(parseCellKey(cellKey(3, 7))).toEqual({ row: 3, column: 7 });
    expect(parseCellKey('nonsense')).toBeNull();
  });
});

describe('structural edits', () => {
  it('inserting a row keeps every existing row at its rendered height', () => {
    const before = table({ rows: [1, 1, 1], height: 120 });
    expect(rowHeights(before)).toEqual([40, 40, 40]);

    const after = insertRow(before, 1);
    expect(after.rows).toHaveLength(4);
    expect(rowHeights(after)).toEqual([40, 40, 40, 40]);
    // The table grew rather than the existing rows shrinking.
    expect(after.height).toBeCloseTo(160, 6);
  });

  it('inserting takes the neighbouring track weight, not a fixed default', () => {
    const before = table({ columns: [2, 1], width: 300 });
    const after = insertColumn(before, 0);
    // Inserted next to the wide column, so it matches the wide column.
    expect(columnWidths(after)[0]).toBeCloseTo(200, 6);
    expect(columnWidths(after)).toEqual([200, 200, 100]);
  });

  it('inserting a row adds an empty row of cells at the right index', () => {
    const before = table({
      rows: [1, 1],
      cells: [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
      ],
    });
    expect(insertRow(before, 1).cells).toEqual([
      ['a', 'b', 'c'],
      ['', '', ''],
      ['d', 'e', 'f'],
    ]);
  });

  it('inserting a column adds an empty cell to every row', () => {
    const before = table({
      columns: [1, 1],
      cells: [
        ['a', 'b'],
        ['c', 'd'],
      ],
    });
    expect(insertColumn(before, 2).cells).toEqual([
      ['a', 'b', ''],
      ['c', 'd', ''],
    ]);
  });

  it('removing a row keeps the survivors at their rendered height', () => {
    const before = table({ rows: [1, 1, 1], height: 120 });
    const after = removeRow(before, 0);
    expect(rowHeights(after)).toEqual([40, 40]);
    expect(after.height).toBeCloseTo(80, 6);
  });

  it('removing a column drops that cell from every row', () => {
    const before = table({
      columns: [1, 1, 1],
      cells: [
        ['a', 'b', 'c'],
        ['d', 'e', 'f'],
      ],
    });
    const after = removeColumn(before, 1);
    expect(after.cells).toEqual([
      ['a', 'c'],
      ['d', 'f'],
    ]);
  });

  it('refuses to remove the last row or column', () => {
    // A table with no cells has no way back, so the last one stays.
    const single = table({ columns: [1], rows: [1], cells: [['only']] });
    expect(removeRow(single, 0)).toEqual(single);
    expect(removeColumn(single, 0)).toEqual(single);
  });

  it('keeps cells rectangular through a sequence of edits', () => {
    let el = table();
    el = insertRow(el, 0);
    el = insertColumn(el, 2);
    el = removeRow(el, 1);
    el = removeColumn(el, 0);
    expect(el.cells).toHaveLength(el.rows.length);
    for (const row of el.cells) expect(row).toHaveLength(el.columns.length);
  });
});

describe('normalisation', () => {
  const normalize = (raw: Record<string, unknown>) =>
    getDefinition<TableElement>('table').normalize(raw, {
      ...table(),
      type: 'table',
    }) as TableElement;

  it('pads short rows and truncates long ones', () => {
    const el = normalize({
      columns: [1, 1],
      rows: [1, 1],
      cells: [['a'], ['b', 'c', 'd']],
    });
    expect(el.cells).toEqual([
      ['a', ''],
      ['b', 'c'],
    ]);
  });

  it('stringifies numeric and boolean cells rather than blanking them', () => {
    // The single most common thing a generator puts in a cell.
    const el = normalize({ columns: [1, 1, 1], rows: [1], cells: [[3, true, null]] });
    expect(el.cells).toEqual([['3', 'true', '']]);
  });

  it('infers the grid shape from cells when the tracks are missing', () => {
    const el = normalize({ cells: [['a', 'b'], ['c', 'd'], ['e', 'f']] });
    expect(el.columns).toHaveLength(2);
    expect(el.rows).toHaveLength(3);
  });

  it('repairs a non-positive track instead of dropping it', () => {
    // Dropping one would shift every cell after it into the wrong column, which
    // is a far worse outcome than one oddly-sized track.
    const el = normalize({ columns: [1, 0, -4, 'x'], rows: [1], cells: [['a', 'b', 'c', 'd']] });
    expect(el.columns).toEqual([1, 1, 1, 1]);
    expect(el.cells[0]).toEqual(['a', 'b', 'c', 'd']);
  });

  it('falls back to a default grid for a table with nothing in it', () => {
    const el = normalize({});
    expect(el.columns).toHaveLength(3);
    expect(el.rows).toHaveLength(3);
    expect(el.cells).toEqual([
      ['', '', ''],
      ['', '', ''],
      ['', '', ''],
    ]);
  });
});

describe('text regions', () => {
  const el = table({
    columns: [1, 1],
    rows: [1, 1],
    cells: [
      ['A', 'B'],
      ['C', 'D'],
    ],
    headerRow: true,
  });

  it('lists one region per cell, in row-major tab order', () => {
    const regions = tableDefinition.textRegions?.(el) ?? [];
    expect(regions.map((region) => region.text)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('reports the header weight only where it differs', () => {
    const regions = tableDefinition.textRegions?.(el) ?? [];
    expect(regions[0]?.fontWeight).toBe(600);
    expect(regions[2]?.fontWeight).toBeUndefined();
  });

  it('never draws a header lighter than the table itself', () => {
    expect(cellFontWeight(table({ fontWeight: 700, headerRow: true }), 0)).toBe(700);
    expect(cellFontWeight(table({ fontWeight: 400, headerRow: true }), 0)).toBe(600);
    expect(cellFontWeight(table({ fontWeight: 400, headerRow: false }), 0)).toBe(400);
  });

  it('resolves a local point to a region key', () => {
    expect(tableDefinition.textRegionAt?.(el, { x: 5, y: 5 })).toBe(cellKey(0, 0));
  });

  it('writes one cell without disturbing the others', () => {
    const next = tableDefinition.withRegionText?.(el, cellKey(1, 0), 'changed') as TableElement;
    expect(next.cells).toEqual([
      ['A', 'B'],
      ['changed', 'D'],
    ]);
  });

  it('ignores a key outside the grid', () => {
    expect(tableDefinition.withRegionText?.(el, cellKey(9, 9), 'x')).toEqual(el);
  });
});

describe('interior handles', () => {
  const el = table({ columns: [1, 1, 1], rows: [1, 1], width: 300, height: 100 });

  it('offers only the interior dividers, never the outer edges', () => {
    // The outer edges are the element's own resize handles; two gestures on one
    // pixel would be a coin toss.
    const handles = tableDefinition.interiorHandles?.(el) ?? [];
    expect(handles.map((handle) => handle.position)).toEqual([100, 200, 50]);
    expect(handles.map((handle) => handle.axis)).toEqual(['x', 'x', 'y']);
  });

  it('resizes the track left of the divider and leaves the rest alone', () => {
    const next = tableDefinition.dragInteriorHandle?.(el, 'c1', { x: 150, y: 0 }) as TableElement;
    expect(columnWidths(next)).toEqual([150, 100, 100]);
    expect(next.width).toBeCloseTo(350, 6);
  });

  it('clamps to the minimum track size', () => {
    const next = tableDefinition.dragInteriorHandle?.(el, 'c1', { x: -50, y: 0 }) as TableElement;
    expect(columnWidths(next)[0]).toBeCloseTo(TABLE_MIN_TRACK, 6);
  });

  it('drags a row divider on the vertical axis', () => {
    const next = tableDefinition.dragInteriorHandle?.(el, 'r1', { x: 0, y: 70 }) as TableElement;
    expect(rowHeights(next)).toEqual([70, 50]);
  });
});

describe('document round trip', () => {
  it('survives load → save → load unchanged', () => {
    const document = createDocument();
    document.elements.push(
      table({
        columns: [2, 1],
        rows: [1, 1],
        cells: [
          ['Name', 'Qty'],
          ['Apples', '3'],
        ],
      }),
    );

    const { document: reloaded } = loadDocument(serializeDocument(document));
    const loaded = reloaded.elements[0] as TableElement;
    expect(loaded.type).toBe('table');
    expect(loaded.columns).toEqual([2, 1]);
    expect(loaded.cells).toEqual([
      ['Name', 'Qty'],
      ['Apples', '3'],
    ]);
  });

  it('is found by board search, cell by cell', () => {
    const el = table({
      columns: [1, 1],
      rows: [1],
      cells: [['Milestone', 'Owner']],
    });
    expect(searchableText(el)).toBe('Milestone\nOwner');
    // Joined with a newline so a query cannot match across a cell boundary.
    expect(searchableText(el)).not.toContain('MilestoneOwner');
  });
});
