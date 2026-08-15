/**
 * Document loading, validation, serialisation and migration.
 *
 * The theme running through these tests is the format's central asymmetry:
 * **reading is lenient, writing is strict**. Boards are expected to be authored
 * by other programs — scripts, exporters, language models — which get details
 * wrong. The loader must cope; the writer must not perpetuate the mess.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { CURRENT_SCHEMA_VERSION } from '../../src/model/types.ts';
import type { LinearElement, MindflowElement, TextElement } from '../../src/model/types.ts';
import {
  DocumentLoadError,
  loadDocument,
  serializeDocument,
  validateDocument,
} from '../../src/model/document.ts';
import { compareVersions, migrateDocument, parseVersion } from '../../src/model/migrate.ts';

/** The smallest thing that is legally a board. */
const MINIMAL = { type: 'mindflow.board', schemaVersion: '1.0.0', elements: [] };

describe('rejecting non-boards', () => {
  it('rejects invalid JSON', () => {
    expect(() => loadDocument('{ not json')).toThrow(DocumentLoadError);
  });

  it('rejects a non-object', () => {
    expect(() => loadDocument('[]')).toThrow(DocumentLoadError);
    expect(() => loadDocument('42')).toThrow(DocumentLoadError);
  });

  it('rejects a wrong or missing discriminator', () => {
    expect(() => loadDocument(JSON.stringify({ type: 'something.else' }))).toThrow(DocumentLoadError);
    expect(() => loadDocument(JSON.stringify({ elements: [] }))).toThrow(DocumentLoadError);
  });

  it('names the offending value in the message', () => {
    expect(() => loadDocument(JSON.stringify({ type: 'excalidraw' }))).toThrow(/excalidraw/);
  });
});

describe('lenient loading', () => {
  it('fills every missing top-level section', () => {
    const { document } = loadDocument(JSON.stringify(MINIMAL));
    expect(document.meta.name).toBe('Untitled board');
    expect(document.canvas.background).toBe('#ffffff');
    expect(document.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    expect(document.files).toEqual({});
    expect(document.id).toBeTruthy();
  });

  it('fills every missing element field', () => {
    const { document } = loadDocument(
      JSON.stringify({ ...MINIMAL, elements: [{ type: 'rectangle', x: 10, y: 20 }] }),
    );
    const element = document.elements[0] as MindflowElement;
    expect(element.id).toBeTruthy();
    expect(element.width).toBeGreaterThan(0);
    expect(element.angle).toBe(0);
    expect(element.opacity).toBe(1);
    expect(element.visible).toBe(true);
    expect(element.style.stroke).toBe('#1e1e1e');
    expect(element.meta).toEqual({});
  });

  it('coerces numeric strings', () => {
    // A very common shape for machine-generated JSON.
    const { document } = loadDocument(
      JSON.stringify({ ...MINIMAL, elements: [{ type: 'rectangle', x: '100', y: '50', width: '30', height: '40' }] }),
    );
    expect(document.elements[0]).toMatchObject({ x: 100, y: 50, width: 30, height: 40 });
  });

  it('accepts {x, y} point objects and writes tuples', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [{ type: 'arrow', x: 0, y: 0, width: 10, height: 10, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }],
      }),
    );
    expect((document.elements[0] as LinearElement).points).toEqual([[0, 0], [10, 10]]);
  });

  it('clamps out-of-range values', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [{ type: 'rectangle', x: 0, y: 0, width: -50, height: 0, opacity: 5, angle: 450 }],
      }),
    );
    const element = document.elements[0] as MindflowElement;
    expect(element.width).toBe(50); // Absolute value taken; dimensions stay positive.
    expect(element.height).toBe(1); // Floored.
    expect(element.opacity).toBe(1);
    expect(element.angle).toBe(90);
  });

  it('falls back to defaults for invalid enum values', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [{ type: 'rectangle', x: 0, y: 0, width: 10, height: 10, style: { strokeStyle: 'wavy', fillStyle: 'hatched' } }],
      }),
    );
    expect(document.elements[0]?.style.strokeStyle).toBe('solid');
    expect(document.elements[0]?.style.fillStyle).toBe('none');
  });

  it('reassigns duplicate ids and warns', () => {
    // Two elements sharing an id break selection, bindings and undo in ways that
    // are miserable to debug, so it is repaired at the door.
    const { document, warnings } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [
          { id: 'same', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 },
          { id: 'same', type: 'ellipse', x: 0, y: 0, width: 10, height: 10 },
        ],
      }),
    );
    const ids = document.elements.map((element) => element.id);
    expect(new Set(ids).size).toBe(2);
    expect(warnings.some((warning) => /[Dd]uplicate/.test(warning.message))).toBe(true);
  });

  it('drops non-object entries in the elements array', () => {
    const { document, warnings } = loadDocument(
      JSON.stringify({ ...MINIMAL, elements: [null, 'nope', 42, { type: 'rectangle', x: 0, y: 0, width: 5, height: 5 }] }),
    );
    expect(document.elements).toHaveLength(1);
    expect(warnings.filter((warning) => warning.level === 'warning').length).toBeGreaterThan(0);
  });

  it('sorts by zIndex regardless of array order', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [
          { id: 'c', type: 'rectangle', x: 0, y: 0, width: 5, height: 5, zIndex: 3000 },
          { id: 'a', type: 'rectangle', x: 0, y: 0, width: 5, height: 5, zIndex: 1000 },
          { id: 'b', type: 'rectangle', x: 0, y: 0, width: 5, height: 5, zIndex: 2000 },
        ],
      }),
    );
    expect(document.elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
  });

  it('preserves third-party meta verbatim', () => {
    const meta = { myTool: { ticket: 'PROJ-1', nested: { deep: [1, 2, 3] } } };
    const { document } = loadDocument(
      JSON.stringify({ ...MINIMAL, elements: [{ type: 'rectangle', x: 0, y: 0, width: 5, height: 5, meta }] }),
    );
    expect(document.elements[0]?.meta).toEqual(meta);
  });
});

describe('unknown element types', () => {
  const withUnknown = JSON.stringify({
    ...MINIMAL,
    elements: [
      { id: 'known', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, zIndex: 1000 },
      { id: 'future', type: 'hexagram', x: 50, y: 50, width: 20, height: 20, zIndex: 2000, sides: 6 },
    ],
  });

  it('sets them aside rather than loading them', () => {
    const { document, preserved } = loadDocument(withUnknown);
    expect(document.elements).toHaveLength(1);
    expect(preserved).toHaveLength(1);
    expect((preserved[0] as { type: string }).type).toBe('hexagram');
  });

  it('reports them as info, not as an error', () => {
    const { warnings } = loadDocument(withUnknown);
    const relevant = warnings.filter((warning) => warning.message.includes('hexagram'));
    expect(relevant).toHaveLength(1);
    expect(relevant[0]?.level).toBe('info');
  });

  it('writes them back verbatim, in z-order', () => {
    // Opening a board that uses a newer element type and saving must not
    // silently destroy that element.
    const { document, preserved } = loadDocument(withUnknown);
    const output = JSON.parse(serializeDocument(document, preserved)) as { elements: { id: string; sides?: number }[] };

    expect(output.elements.map((element) => element.id)).toEqual(['known', 'future']);
    expect(output.elements[1]?.sides).toBe(6); // Unknown fields survive too.
  });
});

describe('validation', () => {
  it('reports a dangling binding without deleting it', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [{
          id: 'arrow', type: 'arrow', x: 0, y: 0, width: 10, height: 10,
          points: [[0, 0], [10, 10]],
          endBinding: { elementId: 'does-not-exist', anchor: { mode: 'auto' }, gap: 4 },
        }],
      }),
    );

    const issues = validateDocument(document);
    expect(issues.some((issue) => issue.level === 'error' && issue.message.includes('does-not-exist'))).toBe(true);
    // Reported, not repaired — a document assembled in pieces may be fixed up later.
    expect((document.elements[0] as LinearElement).endBinding).not.toBeNull();
  });

  it('rejects a self-binding', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [{
          id: 'self', type: 'arrow', x: 0, y: 0, width: 10, height: 10,
          points: [[0, 0], [10, 10]],
          endBinding: { elementId: 'self', anchor: { mode: 'auto' }, gap: 0 },
        }],
      }),
    );
    expect(validateDocument(document).some((issue) => issue.message.includes('cannot bind to itself'))).toBe(true);
  });

  it('reports a missing image file', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [{ id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'absent' }],
      }),
    );
    expect(validateDocument(document).some((issue) => issue.level === 'error' && issue.message.includes('absent'))).toBe(true);
  });

  it('reports a one-member group', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        elements: [{ id: 'lonely', type: 'rectangle', x: 0, y: 0, width: 5, height: 5, groupId: 'grp_x' }],
      }),
    );
    expect(validateDocument(document).some((issue) => issue.message.includes('only one member'))).toBe(true);
  });

  it('reports unreferenced files as info', () => {
    const { document } = loadDocument(
      JSON.stringify({
        ...MINIMAL,
        files: { orphan: { mimeType: 'image/png', dataUri: 'data:image/png;base64,AA==', byteLength: 1, createdAt: '2026-01-01T00:00:00.000Z' } },
      }),
    );
    const issue = validateDocument(document).find((candidate) => candidate.path === 'files.orphan');
    expect(issue?.level).toBe('info');
  });

  it('passes a clean document', () => {
    expect(validateDocument(createDocument())).toEqual([]);
  });
});

describe('serialisation', () => {
  it('is idempotent', () => {
    // The property the round-trip test in contract.test.ts depends on.
    const doc = createDocument('Round trip');
    doc.elements.push(getDefinition('rectangle').create({ x: 10.5, y: 20.25, zIndex: 1000 }));

    const once = serializeDocument(doc);
    const twice = serializeDocument(loadDocument(once).document);

    expect(stripUpdatedAt(twice)).toEqual(stripUpdatedAt(once));
  });

  it('rounds coordinates so saves are byte-stable', () => {
    const doc = createDocument();
    doc.elements.push(
      getDefinition('rectangle').create({ x: 100.00000000000001, y: 1 / 3, zIndex: 1000 }),
    );
    const output = JSON.parse(serializeDocument(doc)) as { elements: { x: number; y: number }[] };
    expect(output.elements[0]?.x).toBe(100);
    expect(output.elements[0]?.y).toBe(0.33);
  });

  it('emits keys in a fixed order', () => {
    const keys = Object.keys(JSON.parse(serializeDocument(createDocument())));
    expect(keys).toEqual(['$schema', 'type', 'schemaVersion', 'id', 'meta', 'canvas', 'viewport', 'elements', 'files']);
  });

  it('is pretty-printed with a trailing newline', () => {
    const output = serializeDocument(createDocument());
    expect(output).toContain('\n  "type"');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('preserves createdAt but refreshes updatedAt', () => {
    const doc = createDocument();
    doc.meta.createdAt = '2020-01-01T00:00:00.000Z';
    const output = JSON.parse(serializeDocument(doc)) as { meta: { createdAt: string; updatedAt: string } };
    expect(output.meta.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(output.meta.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('always writes the current schema version', () => {
    const output = JSON.parse(serializeDocument(createDocument())) as { schemaVersion: string };
    expect(output.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('round-trips a text element with newlines', () => {
    const doc = createDocument();
    const text = getDefinition<TextElement>('text').create({ x: 0, y: 0, zIndex: 1000, text: 'line one\nline two' });
    doc.elements.push(text);
    const reloaded = loadDocument(serializeDocument(doc)).document;
    expect((reloaded.elements[0] as TextElement).text).toBe('line one\nline two');
  });
});

describe('version handling', () => {
  it('parses and compares semver', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3]);
    expect(parseVersion('nonsense')).toEqual([0, 0, 0]);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.1', '1.0.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.1.0')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('warns but still loads a newer schema version', () => {
    // The file was written by a future build. We cannot know what changed, so we
    // warn and load anyway — unknown types survive via `preserved`.
    const { warnings, document } = loadDocument(
      JSON.stringify({ ...MINIMAL, schemaVersion: '99.0.0', elements: [{ type: 'rectangle', x: 0, y: 0, width: 5, height: 5 }] }),
    );
    expect(warnings.some((warning) => warning.message.includes('newer'))).toBe(true);
    expect(document.elements).toHaveLength(1);
  });

  it('warns when no migration path exists from an older version', () => {
    const { warnings } = loadDocument(JSON.stringify({ ...MINIMAL, schemaVersion: '0.1.0' }));
    expect(warnings.some((warning) => warning.message.includes('No migration'))).toBe(true);
  });

  it('leaves a current-version document untouched', () => {
    const result = migrateDocument({ ...MINIMAL }, CURRENT_SCHEMA_VERSION);
    expect(result.warnings).toEqual([]);
  });

  it('always stamps the current version on output', () => {
    const { document } = loadDocument(JSON.stringify({ ...MINIMAL, schemaVersion: '0.1.0' }));
    expect(document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });
});

function stripUpdatedAt(json: string): unknown {
  const parsed = JSON.parse(json) as { meta: { updatedAt?: string } };
  delete parsed.meta.updatedAt;
  return parsed;
}
