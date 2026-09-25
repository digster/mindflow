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
    // Exact, because the noun now comes from the definition's title rather than
    // a literal: `hasFile` replaced a `type === 'image'` branch.
    expect(validateDocument(document)).toContainEqual({
      level: 'error',
      path: 'elements[0].fileId',
      message: 'Image references file "absent", which is not present in the files map.',
    });
  });

  it("reports a freehand stroke with no points, through draw's own validate", () => {
    const stroke = (points: [number, number][]) =>
      ({ ...getDefinition('draw').create({ x: 0, y: 0, zIndex: 1000 }), points }) as MindflowElement;
    const pointless = { ...getDefinition('line').create({ x: 0, y: 0, zIndex: 2000 }), points: [] } as MindflowElement;
    const document = { ...createDocument(), elements: [stroke([]), stroke([[0, 0]]), pointless] };

    const issues = validateDocument(document);
    expect(issues.filter((issue) => issue.path === 'elements[0]')).toEqual([
      { level: 'error', path: 'elements[0]', message: 'A freehand stroke needs at least one point.' },
    ]);
    // One point is a dot, which is a valid stroke.
    expect(issues.filter((issue) => issue.path === 'elements[1]')).toEqual([]);
    // The rule is draw's alone: a connector with no points gets its own
    // stricter message, never the freehand one as well.
    expect(issues.filter((issue) => issue.path === 'elements[2]').map((issue) => issue.message)).toEqual([
      'A connector needs at least two points.',
    ]);
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

/**
 * 1.5.0 retired four of the solids 1.4.0 introduced. An unrecognised type is
 * preserved but never drawn, so without the migration a board holding one
 * would lose the shape from the canvas while still carrying it in the file.
 */
describe('1.4.0 → 1.5.0: retired solids', () => {
  /** A fully-populated element as a 1.4.0 build wrote it. */
  const written = (id: string, type: string, extra: Record<string, unknown> = {}) => ({
    id,
    type,
    x: 40,
    y: 60,
    width: 90,
    height: 140,
    angle: 15,
    zIndex: 1000,
    opacity: 0.8,
    locked: false,
    visible: true,
    groupId: null,
    frameId: null,
    style: {
      stroke: '#1e1e1e',
      strokeWidth: 2,
      strokeStyle: 'dashed',
      fill: '#a5d8ff',
      fillStyle: 'solid',
      // Stored by a paste-style onto a solid, which never drew it.
      roughness: 1.4,
    },
    label: { text: 'Kept', fontFamily: 'sans', fontSize: 20, fontWeight: 400, color: '#1e1e1e', textAlign: 'center', verticalAlign: 'middle' },
    meta: { source: 'third-party' },
    ...extra,
  });

  const board = (...elements: unknown[]) =>
    JSON.stringify({ type: 'mindflow.board', schemaVersion: '1.4.0', elements });

  const loaded = (...elements: unknown[]) => loadDocument(board(...elements));

  it('turns each one into the flat shape of its outline', () => {
    const { document, preserved } = loaded(
      written('el_sphere', 'sphere'),
      written('el_torus', 'torus'),
      written('el_prism', 'prism'),
      written('el_capsule', 'capsule'),
    );

    expect(document.elements.map((element) => [element.id, element.type])).toEqual([
      ['el_sphere', 'ellipse'],
      ['el_torus', 'ellipse'],
      ['el_prism', 'triangle'],
      ['el_capsule', 'rectangle'],
    ]);
    // Nothing fell through to the unknown-type path, where it would not be drawn.
    expect(preserved).toEqual([]);
  });

  it('carries everything but the type across untouched', () => {
    const { document } = loaded(
      written('el_sphere', 'sphere', { groupId: 'grp_pair' }),
      written('el_cube', 'cube', { groupId: 'grp_pair', x: 400 }),
    );
    const element = document.elements[0] as MindflowElement;

    expect(element).toMatchObject({
      id: 'el_sphere',
      x: 40,
      y: 60,
      width: 90,
      height: 140,
      angle: 15,
      zIndex: 1000,
      opacity: 0.8,
      groupId: 'grp_pair',
      meta: { source: 'third-party' },
    });
    expect(element.style).toMatchObject({ stroke: '#1e1e1e', strokeStyle: 'dashed', fill: '#a5d8ff' });
    expect(element.label?.text).toBe('Kept');
  });

  it('makes a capsule a rectangle rounded into a pill, whichever way it lies', () => {
    const { document } = loaded(
      written('el_upright', 'capsule', { width: 90, height: 140 }),
      written('el_lying', 'capsule', { width: 200, height: 60 }),
    );
    const radii = document.elements.map((element) => (element as MindflowElement & { cornerRadius: number }).cornerRadius);
    expect(radii).toEqual([45, 30]);
  });

  it('zeroes the roughness a solid stored but never drew', () => {
    // Every shape a solid can become has a hand-drawn form, so carrying the value
    // across would make it turn sketchy on upgrade.
    const { document } = loaded(written('el_prism', 'prism'));
    expect(document.elements[0]?.style.roughness).toBe(0);
  });

  it('leaves every other type alone, including the solids that stayed', () => {
    const { document } = loaded(
      written('el_cube', 'cube'),
      written('el_rect', 'rectangle', { cornerRadius: 8 }),
    );
    expect(document.elements.map((element) => element.type)).toEqual(['cube', 'rectangle']);
    // Roughness is only reset on a converted element; a rectangle drew its own.
    expect(document.elements.map((element) => element.style.roughness)).toEqual([1.4, 1.4]);
  });

  it('keeps a connector bound to a converted shape', () => {
    const { document, warnings } = loaded(
      written('el_capsule', 'capsule'),
      written('el_cube', 'cube', { x: 400 }),
      {
        id: 'el_arrow',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        points: [[0, 0], [10, 10]],
        startBinding: { elementId: 'el_capsule', anchor: { mode: 'auto' }, gap: 6 },
        endBinding: { elementId: 'el_cube', anchor: { mode: 'auto' }, gap: 6 },
      },
    );

    const arrow = document.elements.find((element) => element.id === 'el_arrow') as LinearElement;
    expect(arrow.startBinding?.elementId).toBe('el_capsule');
    expect(warnings.filter((warning) => warning.level === 'error')).toEqual([]);
  });

  it('reports the upgrade quietly, as every other migration does', () => {
    const { warnings } = loaded(written('el_torus', 'torus'));
    const upgrade = warnings.find((warning) => warning.message.includes('1.4.0 → 1.5.0'));
    expect(upgrade?.level).toBe('info');
    expect(warnings.filter((warning) => warning.level !== 'info')).toEqual([]);
  });

  it('copes with a capsule whose box it cannot read', () => {
    // Reading is lenient: the loader repairs the box, and the rectangle keeps its
    // default radius rather than one computed from garbage.
    const { document } = loaded(written('el_capsule', 'capsule', { width: 'wide', height: null }));
    const element = document.elements[0] as MindflowElement & { cornerRadius: number };
    expect(element.type).toBe('rectangle');
    expect(Number.isFinite(element.cornerRadius)).toBe(true);
  });

  it('also upgrades a board from before the solids existed', () => {
    // The chain runs 1.3.0 → 1.4.0 → 1.5.0, so a hand-written board that used a
    // type ahead of its declared version still lands on a drawable shape.
    const { document } = loadDocument(
      JSON.stringify({ type: 'mindflow.board', schemaVersion: '1.3.0', elements: [written('el_sphere', 'sphere')] }),
    );
    expect(document.elements[0]?.type).toBe('ellipse');
  });

  it('does not rewrite a board that already claims 1.5.0', () => {
    // A current-version board naming a retired type was not written by MindFlow.
    // It gets the ordinary unknown-type treatment — preserved verbatim, not
    // reinterpreted — exactly as a type from a future version would.
    const { document, preserved } = loadDocument(
      JSON.stringify({ type: 'mindflow.board', schemaVersion: '1.5.0', elements: [written('el_sphere', 'sphere')] }),
    );
    expect(document.elements).toEqual([]);
    expect(preserved).toHaveLength(1);
  });
});

/**
 * 1.6.0 adds the `focus` anchor mode: an arrow end dropped inside a shape
 * remembers where, instead of collapsing to an `auto` anchor.
 */
describe('1.5.0 → 1.6.0: focus anchors', () => {
  const connectorWith = (anchor: unknown) => ({
    type: 'mindflow.board',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    elements: [
      { id: 'el_box', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 },
      {
        id: 'el_arrow',
        type: 'arrow',
        x: 0,
        y: 0,
        width: 200,
        height: 1,
        points: [[0, 0], [200, 0]],
        startBinding: { elementId: 'el_box', anchor, gap: 4 },
      },
    ],
  });
  const startAnchor = (json: unknown) =>
    (loadDocument(JSON.stringify(json)).document.elements.find((el) => el.id === 'el_arrow') as LinearElement)
      .startBinding?.anchor;

  it('upgrades a 1.5.0 board quietly and leaves its bindings alone', () => {
    const board = { ...connectorWith({ mode: 'fixed', u: 1, v: 0.5 }), schemaVersion: '1.5.0' };
    const { document, warnings } = loadDocument(JSON.stringify(board));
    expect(warnings.find((warning) => warning.message.includes('1.5.0 → 1.6.0'))?.level).toBe('info');
    expect(warnings.filter((warning) => warning.level !== 'info')).toEqual([]);
    // The rest of the chain runs too, so the board lands on the current version.
    expect(document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect((document.elements[1] as LinearElement).startBinding?.anchor).toEqual({ mode: 'fixed', u: 1, v: 0.5 });
  });

  it('round-trips a focus anchor', () => {
    const first = serializeDocument(loadDocument(JSON.stringify(connectorWith({ mode: 'focus', u: 0.25, v: 0.7 }))).document);
    expect(startAnchor(JSON.parse(first))).toEqual({ mode: 'focus', u: 0.25, v: 0.7 });
  });

  it('clamps a focus point into the box, since rays are cast from it', () => {
    expect(startAnchor(connectorWith({ mode: 'focus', u: 1.4, v: -0.2 }))).toEqual({ mode: 'focus', u: 1, v: 0 });
  });

  it('fills a focus point it cannot read with the centre', () => {
    expect(startAnchor(connectorWith({ mode: 'focus', u: 'left' }))).toEqual({ mode: 'focus', u: 0.5, v: 0.5 });
  });

  it('reads an unknown mode as auto', () => {
    expect(startAnchor(connectorWith({ mode: 'magnetic', u: 0.2, v: 0.2 }))).toEqual({ mode: 'auto' });
  });
});

/**
 * 1.6.1 changes only how text wraps (it now also breaks after a hyphen).
 * Wrapped lines are never stored, so a 1.6.0 board must come through with its
 * text exactly as written — the new rule applies when it is drawn.
 */
describe('1.6.0 → 1.6.1: hyphen wrapping', () => {
  it('upgrades a 1.6.0 board quietly and leaves its text alone', () => {
    const text = 'a well-known, hyphen-heavy note from 2024-09-24';
    const board = {
      type: 'mindflow.board',
      schemaVersion: '1.6.0',
      elements: [{ id: 'el_note', type: 'sticky', x: 0, y: 0, width: 120, height: 120, text }],
    };
    const { document, warnings } = loadDocument(JSON.stringify(board));
    expect(warnings.find((warning) => warning.message.includes('1.6.0 → 1.6.1'))?.level).toBe('info');
    expect(warnings.filter((warning) => warning.level !== 'info')).toEqual([]);
    expect(document.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect((document.elements[0] as { text: string }).text).toBe(text);
  });
});

function stripUpdatedAt(json: string): unknown {
  const parsed = JSON.parse(json) as { meta: { updatedAt?: string } };
  delete parsed.meta.updatedAt;
  return parsed;
}
