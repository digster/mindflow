/**
 * Workspaces in the file (format 2.0.0): loading, the 1.x upgrade, the
 * repairs, and writing every workspace back.
 *
 * The rules under test are in `docs/02-document-format.md#workspaces`. The
 * pure helpers in `model/workspaces.ts` are tested at the end.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { createDocument } from '../../src/model/defaults.ts';
import type { LinearElement, MindflowElement } from '../../src/model/types.ts';
import { loadDocument, serializeBoard, serializeDocument } from '../../src/model/document.ts';
import { isNewerMajor } from '../../src/model/migrate.ts';
import {
  LEGACY_WORKSPACE_ID,
  boardElementCount,
  cloneElements,
  clonePreserved,
  nextWorkspaceName,
  remapElementIds,
  resolveWorkspaces,
  singleWorkspaceBoard,
} from '../../src/model/workspaces.ts';

/** A rectangle as a writer would put it in a file. */
const rect = (id: string, extra: Record<string, unknown> = {}) => ({
  ...getDefinition('rectangle').create({ x: 0, y: 0, width: 100, height: 60, zIndex: 1000 }),
  id,
  ...extra,
});

/** A raw 2.0.0 workspace. */
const workspace = (id: string, elements: unknown[], extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  canvas: { background: '#ffffff', grid: { visible: false, size: 20, snap: false } },
  viewport: { x: 0, y: 0, zoom: 1 },
  elements,
  meta: {},
  ...extra,
});

/** A raw 2.0.0 board. */
const board = (workspaces: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'mindflow.board',
  schemaVersion: '2.0.0',
  id: 'brd_test',
  meta: { name: 'Test', createdAt: '2026-11-10T09:00:00.000Z', updatedAt: '2026-11-10T09:00:00.000Z' },
  workspaces,
  files: {},
  ...extra,
});

/** What a save writes, parsed. */
const saved = (input: unknown) =>
  JSON.parse(serializeBoard(loadDocument(input))) as {
    activeWorkspaceId: string;
    workspaces: { id: string; name: string; elements: { id: string; type: string }[]; [key: string]: unknown }[];
    files: Record<string, unknown>;
    [key: string]: unknown;
  };

const warningAt = (input: unknown, path: string) =>
  loadDocument(input).warnings.find((warning) => warning.path === path);

describe('a 1.x board', () => {
  const old = {
    type: 'mindflow.board',
    schemaVersion: '1.6.3',
    $schema: 'https://digster.github.io/mindflow/docs/schema/mindflow-1.6.3.schema.json',
    id: 'brd_old',
    meta: { name: 'Old', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-02T08:00:00.000Z' },
    canvas: { background: '#fff9db', grid: { visible: true, size: 10, snap: true } },
    viewport: { x: 40, y: -20, zoom: 2 },
    elements: [rect('el_a'), rect('el_b', { zIndex: 2000 })],
    files: {},
  };

  it('becomes one workspace, "Workspace 1", on stage', () => {
    const result = loadDocument(old);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]).toMatchObject({ id: LEGACY_WORKSPACE_ID, name: 'Workspace 1', parked: null });
    expect(result.activeWorkspaceId).toBe(LEGACY_WORKSPACE_ID);
    expect(result.document.elements.map((element) => element.id)).toEqual(['el_a', 'el_b']);
    expect(result.document.canvas.background).toBe('#fff9db');
    expect(result.document.viewport).toEqual({ x: 40, y: -20, zoom: 2 });
    expect(result.sourceVersion).toBe('1.6.3');
  });

  it('is saved in the 2.0.0 shape, pointing at the 2.0.0 schema', () => {
    const output = saved(old);
    expect(output.schemaVersion).toBe('2.0.0');
    expect(output.$schema).toContain('mindflow-2.0.0.schema.json');
    expect('elements' in output).toBe(false);
    expect('canvas' in output).toBe(false);
    expect(output.workspaces[0]?.elements.map((element) => element.id)).toEqual(['el_a', 'el_b']);
  });

  it('loads the same way twice, and saves byte-stably', () => {
    const first = serializeBoard(loadDocument(old));
    expect(serializeBoard(loadDocument(old))).toBe(first);
    expect(serializeBoard(loadDocument(first))).toBe(first);
  });
});

describe('reading the workspaces', () => {
  it('stages the active workspace and parks the rest', () => {
    const result = loadDocument(
      board([workspace('ws_a', [rect('el_a')]), workspace('ws_b', [rect('el_b')])], { activeWorkspaceId: 'ws_b' }),
    );
    expect(result.activeWorkspaceId).toBe('ws_b');
    expect(result.document.elements.map((element) => element.id)).toEqual(['el_b']);
    expect(result.workspaces[0]?.parked?.elements.map((element) => element.id)).toEqual(['el_a']);
    expect(result.workspaces[1]?.parked).toBeNull();
  });

  it('shows the first workspace when activeWorkspaceId is missing, without a warning', () => {
    const input = board([workspace('ws_a', []), workspace('ws_b', [])]);
    expect(loadDocument(input).activeWorkspaceId).toBe('ws_a');
    expect(warningAt(input, 'activeWorkspaceId')).toBeUndefined();
  });

  it('shows the first workspace, with a warning, when activeWorkspaceId names nothing', () => {
    const input = board([workspace('ws_a', []), workspace('ws_b', [])], { activeWorkspaceId: 'ws_gone' });
    expect(loadDocument(input).activeWorkspaceId).toBe('ws_a');
    expect(warningAt(input, 'activeWorkspaceId')?.level).toBe('warning');
  });

  it('creates one empty workspace when there are none', () => {
    for (const workspaces of [[], undefined]) {
      const input = board([], { workspaces });
      const result = loadDocument(input);
      expect(result.workspaces).toHaveLength(1);
      expect(result.document.elements).toEqual([]);
      expect(warningAt(input, 'workspaces')?.level).toBe('warning');
    }
  });

  it('drops an entry that is not an object, with a warning', () => {
    const input = board([42, workspace('ws_a', [rect('el_a')])]);
    expect(loadDocument(input).workspaces.map((entry) => entry.id)).toEqual(['ws_a']);
    expect(warningAt(input, 'workspaces[0]')?.level).toBe('warning');
  });

  it('names a workspace with no name by its position', () => {
    const result = loadDocument(board([workspace('ws_a', []), { id: 'ws_b', elements: [] }]));
    expect(result.workspaces[1]?.name).toBe('Workspace 2');
  });

  it('reassigns a duplicate workspace id', () => {
    const input = board([workspace('ws_a', []), workspace('ws_a', [])]);
    const ids = loadDocument(input).workspaces.map((entry) => entry.id);
    expect(ids[0]).toBe('ws_a');
    expect(ids[1]).not.toBe('ws_a');
    expect(warningAt(input, 'workspaces[1].id')?.level).toBe('warning');
  });

  it('keeps each workspace its own background and camera', () => {
    const output = saved(
      board([
        workspace('ws_a', [], { viewport: { x: 1, y: 2, zoom: 3 } }),
        workspace('ws_b', [], { canvas: { background: '#1e1e1e', grid: { visible: true, size: 40, snap: false } } }),
      ]),
    );
    expect(output.workspaces[0]?.viewport).toEqual({ x: 1, y: 2, zoom: 3 });
    expect(output.workspaces[1]?.canvas).toEqual({ background: '#1e1e1e', grid: { visible: true, size: 40, snap: false } });
  });
});

describe('the 1.x shape in a 2.x file', () => {
  it('reads top-level elements as the one workspace, with a note', () => {
    const input = { type: 'mindflow.board', schemaVersion: '2.0.0', elements: [rect('el_a')] };
    const result = loadDocument(input);
    expect(result.workspaces).toHaveLength(1);
    expect(result.document.elements.map((element) => element.id)).toEqual(['el_a']);
    expect(warningAt(input, 'workspaces')?.level).toBe('info');
  });

  it('keeps warning paths on the top-level elements', () => {
    const input = { type: 'mindflow.board', schemaVersion: '2.0.0', elements: ['not an element'] };
    expect(warningAt(input, 'elements[0]')?.level).toBe('warning');
  });

  it('adds top-level elements beside a workspaces list as a last workspace, rather than dropping them', () => {
    const input = { ...board([workspace('ws_a', [rect('el_a')])]), elements: [rect('el_top')] };
    const result = loadDocument(input);
    expect(result.workspaces).toHaveLength(2);
    expect(result.workspaces[1]?.parked?.elements.map((element) => element.id)).toEqual(['el_top']);
    expect(warningAt(input, 'elements')?.level).toBe('warning');
  });
});

describe('element ids across workspaces', () => {
  const arrow = (id: string, from: string, to: string) => ({
    ...getDefinition('arrow').create({ x: 0, y: 0, width: 100, height: 1, zIndex: 3000 }),
    id,
    startBinding: { elementId: from, anchor: { mode: 'auto' }, gap: 4 },
    endBinding: { elementId: to, anchor: { mode: 'auto' }, gap: 4 },
  });
  const frame = (id: string) => ({
    ...getDefinition('frame').create({ x: -50, y: -50, width: 400, height: 400, zIndex: 500 }),
    id,
  });
  // Two workspaces made by copying one block of JSON: same ids, same references.
  const copy = () => [frame('el_f'), rect('el_a', { frameId: 'el_f' }), rect('el_b', { zIndex: 2000 }), arrow('el_c', 'el_a', 'el_b')];
  const input = board([workspace('ws_a', copy()), workspace('ws_b', copy())]);

  it('gives a later workspace new ids, and its references follow them', () => {
    const result = loadDocument(input);
    const first = result.document.elements;
    const second = result.workspaces[1]?.parked?.elements ?? [];
    const ids = new Set(first.map((element) => element.id));
    for (const element of second) expect(ids.has(element.id)).toBe(false);

    const byOldPosition = (index: number) => second[index] as MindflowElement;
    const linked = second.find((element) => element.type === 'arrow') as LinearElement;
    expect(linked.startBinding?.elementId).toBe(byOldPosition(1).id);
    expect(linked.endBinding?.elementId).toBe(byOldPosition(2).id);
    expect(byOldPosition(1).frameId).toBe(byOldPosition(0).id);
  });

  it('leaves the first workspace as written, and reports no dangling references', () => {
    const result = loadDocument(input);
    expect(result.document.elements.map((element) => element.id)).toEqual(['el_f', 'el_a', 'el_b', 'el_c']);
    expect(result.warnings.filter((warning) => warning.level === 'error')).toEqual([]);
    expect(warningAt(input, 'workspaces[1].elements')?.message).toMatch(/earlier workspace/);
  });

  it('reports a binding into another workspace as dangling', () => {
    const result = loadDocument(board([workspace('ws_a', [rect('el_a')]), workspace('ws_b', [arrow('el_c', 'el_a', 'el_a')])]));
    expect(result.warnings.some((warning) => warning.path.startsWith('workspaces[1].elements[0]') && warning.level === 'error')).toBe(true);
  });
});

describe('what a save carries', () => {
  const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const image = (id: string) => ({
    ...getDefinition('image').create({ x: 0, y: 0, width: 10, height: 10, zIndex: 1000 }),
    id,
    fileId: 'f1',
    naturalWidth: 1,
    naturalHeight: 1,
  });
  const withImage = board([workspace('ws_a', []), workspace('ws_b', [image('el_img')])], {
    activeWorkspaceId: 'ws_a',
    files: { f1: { mimeType: 'image/png', dataUri: pixel, byteLength: 70, createdAt: '2026-11-10T09:00:00.000Z' } },
  });

  it('counts an image used only in a parked workspace as used', () => {
    expect(loadDocument(withImage).warnings.find((warning) => warning.path === 'files.f1')).toBeUndefined();
  });

  it('writes that image back', () => {
    expect(Object.keys(saved(withImage).files)).toEqual(['f1']);
  });

  it('writes a parked workspace’s unknown element types back into that workspace', () => {
    const future = { id: 'el_future', type: 'hologram', zIndex: 500 };
    const output = saved(board([workspace('ws_a', [rect('el_a')]), workspace('ws_b', [rect('el_b'), future])]));
    expect(output.workspaces[1]?.elements.map((element) => element.id)).toEqual(['el_future', 'el_b']);
    expect(output.workspaces[0]?.elements.map((element) => element.id)).toEqual(['el_a']);
  });

  it('keeps fields this version does not know, after the known ones', () => {
    const output = saved(
      board([workspace('ws_a', [], { color: 'blue' })], { comments: [{ text: 'hi' }], futureFlag: true }),
    );
    const keys = Object.keys(output);
    expect(keys.slice(-2)).toEqual(['comments', 'futureFlag']);
    expect(output.comments).toEqual([{ text: 'hi' }]);
    expect(output.workspaces[0]?.color).toBe('blue');
    expect(Object.keys(output.workspaces[0] ?? {}).at(-1)).toBe('color');
  });

  it('notes each unknown top-level field, as information only', () => {
    const warning = warningAt(board([workspace('ws_a', [])], { comments: [] }), 'comments');
    expect(warning?.level).toBe('info');
  });

  it('preserves a workspace’s third-party meta verbatim', () => {
    const output = saved(board([workspace('ws_a', [], { meta: { myTool: { column: 'ideas' } } })]));
    expect(output.workspaces[0]?.meta).toEqual({ myTool: { column: 'ideas' } });
  });

  it('writes the board name, times and active workspace once, at the top', () => {
    const output = saved(board([workspace('ws_a', []), workspace('ws_b', [])], { activeWorkspaceId: 'ws_b' }));
    expect(output.activeWorkspaceId).toBe('ws_b');
    expect(output.meta).toMatchObject({ name: 'Test', updatedAt: '2026-11-10T09:00:00.000Z' });
  });
});

describe('versions', () => {
  it('reports the version a file declared', () => {
    expect(loadDocument(board([])).sourceVersion).toBe('2.0.0');
    expect(loadDocument({ type: 'mindflow.board' }).sourceVersion).toBe('0.0.0');
  });

  it('knows a later major version when it sees one', () => {
    expect(isNewerMajor('3.0.0')).toBe(true);
    expect(isNewerMajor('2.9.1')).toBe(false);
    expect(isNewerMajor('1.6.3')).toBe(false);
  });
});

describe('model/workspaces.ts', () => {
  it('names a new workspace with the lowest free number', () => {
    expect(nextWorkspaceName([])).toBe('Workspace 1');
    expect(nextWorkspaceName(['Workspace 1', 'Workspace 3'])).toBe('Workspace 2');
    expect(nextWorkspaceName(['Workspace 1', 'Brainstorm', ' Workspace 2 '])).toBe('Workspace 3');
  });

  it('copies elements with fresh ids, and groups, bindings and frames follow them', () => {
    const frame = { ...getDefinition('frame').create({ x: 0, y: 0, width: 300, height: 300, zIndex: 500 }), id: 'el_f' };
    const a = { ...rect('el_a'), frameId: 'el_f', groupId: 'grp_1' } as MindflowElement;
    const b = { ...rect('el_b'), groupId: 'grp_1' } as MindflowElement;
    const arrow = {
      ...getDefinition('arrow').create({ x: 0, y: 0, width: 10, height: 1, zIndex: 3000 }),
      id: 'el_c',
      startBinding: { elementId: 'el_a', anchor: { mode: 'auto' as const }, gap: 4 },
      endBinding: { elementId: 'el_b', anchor: { mode: 'auto' as const }, gap: 4 },
    } as MindflowElement;
    const originals = [frame as MindflowElement, a, b, arrow];
    const copies = cloneElements(originals);

    const ids = copies.map((element) => element.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(['el_f', 'el_a', 'el_b', 'el_c']).not.toContain(id);
    expect(copies[1]?.frameId).toBe(copies[0]?.id);
    expect(copies[1]?.groupId).toBe(copies[2]?.groupId);
    expect(copies[1]?.groupId).not.toBe('grp_1');
    const copiedArrow = copies[3] as LinearElement;
    expect(copiedArrow.startBinding?.elementId).toBe(copies[1]?.id);
    expect(copiedArrow.endBinding?.elementId).toBe(copies[2]?.id);
    // Positions and paint order are the originals'.
    expect(copies.map((element) => element.zIndex)).toEqual(originals.map((element) => element.zIndex));
    // Nothing nested is shared with the workspace copied from.
    expect(copies[1]?.style).not.toBe(a.style);
  });

  it('leaves ids the map does not name alone when remapping', () => {
    const [element] = remapElementIds([{ ...rect('el_a'), frameId: 'el_f' } as MindflowElement], new Map([['el_x', 'el_y']]));
    expect(element?.id).toBe('el_a');
    expect(element?.frameId).toBe('el_f');
  });

  it('gives copied unknown elements new ids when they have one', () => {
    const [withId, withoutId] = clonePreserved([{ id: 'el_q', type: 'hologram' }, { type: 'hologram' }]) as {
      id?: string;
    }[];
    expect(withId?.id).not.toBe('el_q');
    expect(withId?.id).toMatch(/^el_/);
    expect(withoutId?.id).toBeUndefined();
  });

  it('counts the elements of every workspace, staged and parked', () => {
    const result = loadDocument(
      board([workspace('ws_a', [rect('el_a')]), workspace('ws_b', [rect('el_b'), rect('el_c'), { id: 'el_q', type: 'hologram' }])]),
    );
    expect(boardElementCount(result)).toBe(4);
    expect(resolveWorkspaces(result).map((entry) => entry.staged)).toEqual([true, false]);
  });

  it('wraps a lone document as a board of one workspace', () => {
    const document = createDocument('Solo');
    const one = singleWorkspaceBoard(document);
    expect(one.workspaces).toHaveLength(1);
    expect(one.activeWorkspaceId).toBe(one.workspaces[0]?.id);
    expect(JSON.parse(serializeDocument(document)).workspaces).toHaveLength(1);
  });
});
