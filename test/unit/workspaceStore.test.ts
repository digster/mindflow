/**
 * Workspaces in the store: switching, the list operations, and undo per
 * workspace.
 *
 * The rules (docs/05-interactions.md#workspaces): switching is not an edit,
 * like a pan; editing the list is an edit but goes on no undo stack; and Undo
 * only ever changes the workspace on screen.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import type { MindflowElement } from '../../src/model/types.ts';
import { loadDocument, serializeBoard } from '../../src/model/document.ts';
import { addElements, deleteElements } from '../../src/store/commands.ts';
import { Store, type BoardOrigin, type ChangeReason } from '../../src/store/store.ts';

const FILE: BoardOrigin = { kind: 'local', name: 'Plan.mindflow.json' };

function rect(zIndex = 1000): MindflowElement {
  return getDefinition('rectangle').create({ x: 0, y: 0, zIndex }) as MindflowElement;
}

/** A saved board holding one rectangle in its one workspace. */
function savedBoard() {
  const store = new Store();
  const element = rect();
  store.execute(addElements([element]));
  store.markSaved(FILE);
  const reasons: ChangeReason[] = [];
  store.subscribe((_state, reason) => reasons.push(reason));
  return { store, element, reasons, first: store.getState().activeWorkspaceId };
}

const ids = (store: Store) => store.document.elements.map((element) => element.id);
const names = (store: Store) => store.getState().workspaces.map((entry) => entry.name);

afterEach(() => {
  vi.useRealTimers();
});

describe('a new board', () => {
  it('has one workspace, "Workspace 1", on stage', () => {
    const store = new Store();
    const { workspaces, activeWorkspaceId } = store.getState();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ id: activeWorkspaceId, name: 'Workspace 1', parked: null });
  });

  it('gets a fresh one on reset', () => {
    const store = new Store();
    store.addWorkspace();
    store.reset();
    expect(names(store)).toEqual(['Workspace 1']);
    expect(store.history.canUndo()).toBe(false);
  });
});

describe('adding a workspace', () => {
  it('puts a new, empty workspace on stage, with the lowest free name', () => {
    const { store, first } = savedBoard();
    const id = store.addWorkspace();

    expect(store.getState().activeWorkspaceId).toBe(id);
    expect(store.document.elements).toEqual([]);
    expect(names(store)).toEqual(['Workspace 1', 'Workspace 2']);
    expect(store.getState().workspaces[0]?.id).toBe(first);
  });

  it('takes the background and grid of the workspace left, and the default camera', () => {
    const store = new Store();
    store.execute({
      label: 'Canvas',
      patches: [],
      docBefore: { canvas: store.document.canvas },
      docAfter: { canvas: { background: '#1e1e1e', grid: { visible: true, size: 40, snap: true } } },
    });
    store.setViewport({ x: 300, y: 200, zoom: 3 });
    store.addWorkspace();

    expect(store.document.canvas).toEqual({ background: '#1e1e1e', grid: { visible: true, size: 40, snap: true } });
    expect(store.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('is an edit: the board is unsaved and its edit time moves', () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T09:00:00.000Z') });
    const { store } = savedBoard();
    vi.setSystemTime(new Date('2026-11-10T09:05:00.000Z'));
    store.addWorkspace();

    expect(store.getState().dirty).toBe(true);
    expect(store.document.meta.updatedAt).toBe('2026-11-10T09:05:00.000Z');
  });

  it('is not undoable, in either workspace', () => {
    const { store, first } = savedBoard();
    const undoBefore = store.history.size();
    store.addWorkspace();
    expect(store.history.canUndo()).toBe(false);
    store.switchWorkspace(first);
    expect(store.history.size()).toEqual(undoBefore);
  });

  it('emits "workspace"', () => {
    const { store, reasons } = savedBoard();
    store.addWorkspace();
    expect(reasons).toEqual(['workspace']);
  });
});

describe('switching', () => {
  it('parks the workspace on stage, and puts it back as it was left', () => {
    const { store, element, first } = savedBoard();
    store.setViewport({ x: 10, y: 20, zoom: 2 });
    store.setSelection([element.id]);
    const second = store.addWorkspace();
    store.execute(addElements([rect(5000)]));

    expect(store.switchWorkspace(first)).toBe(true);
    expect(ids(store)).toEqual([element.id]);
    expect(store.viewport).toEqual({ x: 10, y: 20, zoom: 2 });
    expect(store.getState().selection.size).toBe(0);

    store.switchWorkspace(second);
    expect(store.document.elements).toHaveLength(1);
    expect(store.document.elements[0]?.id).not.toBe(element.id);
  });

  it('is not an edit: a saved board stays saved, and its edit time stays', () => {
    const { store, first } = savedBoard();
    const second = store.addWorkspace();
    store.markSaved();
    const editedAt = store.document.meta.updatedAt;

    store.switchWorkspace(first);
    store.switchWorkspace(second);
    expect(store.getState().dirty).toBe(false);
    expect(store.document.meta.updatedAt).toBe(editedAt);
  });

  it('keeps the board’s name, id and images on stage', () => {
    const { store, first } = savedBoard();
    store.addFiles({ f1: { mimeType: 'image/png', dataUri: 'data:,', byteLength: 0, createdAt: '2026-11-10T09:00:00.000Z' } });
    const { id, meta } = store.document;
    store.addWorkspace();
    expect(store.document.id).toBe(id);
    expect(store.document.meta.name).toBe(meta.name);
    expect(store.document.files.f1).toBeDefined();
    store.switchWorkspace(first);
    expect(store.document.files.f1).toBeDefined();
  });

  it('does nothing for the workspace on stage, or an unknown id', () => {
    const { store, first, reasons } = savedBoard();
    expect(store.switchWorkspace(first)).toBe(false);
    expect(store.switchWorkspace('ws_nope')).toBe(false);
    expect(reasons).toEqual([]);
  });

  it('keeps exactly one workspace on stage', () => {
    const { store, first } = savedBoard();
    const second = store.addWorkspace();
    store.addWorkspace();
    store.switchWorkspace(first);
    store.switchWorkspace(second);
    const staged = store.getState().workspaces.filter((entry) => entry.parked === null);
    expect(staged.map((entry) => entry.id)).toEqual([second]);
  });

  it('refuses a dirty checkpoint taken in another workspace', () => {
    const { store, first } = savedBoard();
    store.addWorkspace();
    const checkpoint = store.dirtyCheckpoint();
    store.switchWorkspace(first);
    expect(store.restoreDirty(checkpoint)).toBe(false);
    expect(store.getState().dirty).toBe(true);
  });
});

describe('undo, per workspace', () => {
  it('only ever changes the workspace on stage', () => {
    const { store, element, first } = savedBoard();
    store.addWorkspace();
    const other = rect(9000);
    store.execute(addElements([other]));

    store.switchWorkspace(first);
    store.execute(deleteElements(store.document, [element.id]));
    expect(store.undo()).toBe(true);
    expect(ids(store)).toEqual([element.id]);
    expect(store.undo()).toBe(true); // The original add, in this workspace.
    expect(ids(store)).toEqual([]);
    expect(store.undo()).toBe(false);
  });

  it('comes back with its workspace', () => {
    const { store, first } = savedBoard();
    const second = store.addWorkspace();
    store.execute(addElements([rect(9000)]));
    store.switchWorkspace(first);
    store.switchWorkspace(second);

    expect(store.history.canUndo()).toBe(true);
    store.undo();
    expect(store.document.elements).toEqual([]);
  });
});

describe('renaming', () => {
  it('trims the name and is an edit', () => {
    const { store, first } = savedBoard();
    expect(store.renameWorkspace(first, '  User flow ')).toBe(true);
    expect(names(store)).toEqual(['User flow']);
    expect(store.getState().dirty).toBe(true);
  });

  it('gives a blank name the default for its position', () => {
    const { store } = savedBoard();
    const second = store.addWorkspace();
    store.renameWorkspace(second, 'Ideas');
    store.renameWorkspace(second, '   ');
    expect(names(store)[1]).toBe('Workspace 2');
  });

  it('does nothing, and emits nothing, for the same name', () => {
    const { store, first, reasons } = savedBoard();
    expect(store.renameWorkspace(first, 'Workspace 1')).toBe(false);
    expect(store.getState().dirty).toBe(false);
    expect(reasons).toEqual([]);
  });
});

describe('moving', () => {
  it('reorders the list, clamped to its ends, and leaves the stage alone', () => {
    const { store, first } = savedBoard();
    const second = store.addWorkspace();
    const third = store.addWorkspace();
    store.markSaved();

    expect(store.moveWorkspace(third, 0)).toBe(true);
    expect(store.getState().workspaces.map((entry) => entry.id)).toEqual([third, first, second]);
    expect(store.moveWorkspace(third, 99)).toBe(true);
    expect(store.getState().workspaces.map((entry) => entry.id)).toEqual([first, second, third]);
    expect(store.moveWorkspace(third, 5)).toBe(false);
    expect(store.getState().activeWorkspaceId).toBe(third);
    expect(store.getState().dirty).toBe(true);
  });
});

describe('duplicating', () => {
  it('copies the workspace right after it, with new ids, and puts the copy on stage', () => {
    const { store, element, first } = savedBoard();
    const second = store.addWorkspace();
    const copy = store.duplicateWorkspace(first);

    expect(store.getState().workspaces.map((entry) => entry.id)).toEqual([first, copy, second]);
    expect(store.getState().activeWorkspaceId).toBe(copy);
    expect(names(store)[1]).toBe('Workspace 1 copy');
    expect(store.document.elements).toHaveLength(1);
    expect(store.document.elements[0]?.id).not.toBe(element.id);
    expect(store.history.canUndo()).toBe(false);
  });

  it('copies the workspace on stage with its live camera', () => {
    const { store, first } = savedBoard();
    store.setViewport({ x: 5, y: 6, zoom: 1.5 });
    store.duplicateWorkspace(first);
    expect(store.viewport).toEqual({ x: 5, y: 6, zoom: 1.5 });
  });

  it('keeps element ids unique across the board', () => {
    const { store, first } = savedBoard();
    store.duplicateWorkspace(first);
    const saved = JSON.parse(serializeBoard(store.boardForSave())) as { workspaces: { elements: { id: string }[] }[] };
    const all = saved.workspaces.flatMap((workspace) => workspace.elements.map((element) => element.id));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('deleting', () => {
  it('refuses the last workspace', () => {
    const { store, first } = savedBoard();
    expect(store.deleteWorkspace(first)).toBe(false);
    expect(store.getState().workspaces).toHaveLength(1);
  });

  it('puts the next workspace on stage when the one on stage goes', () => {
    const { store, first } = savedBoard();
    const second = store.addWorkspace();
    const third = store.addWorkspace();
    store.switchWorkspace(second);
    expect(store.deleteWorkspace(second)).toBe(true);
    expect(store.getState().activeWorkspaceId).toBe(third);
    expect(store.getState().workspaces.map((entry) => entry.id)).toEqual([first, third]);
  });

  it('puts the previous one on stage when the last in the list goes', () => {
    const { store, element, first } = savedBoard();
    const second = store.addWorkspace();
    store.deleteWorkspace(second);
    expect(store.getState().activeWorkspaceId).toBe(first);
    expect(ids(store)).toEqual([element.id]);
  });

  it('leaves the stage alone, and emits "document", when a parked one goes', () => {
    const { store, first, reasons } = savedBoard();
    const second = store.addWorkspace();
    reasons.length = 0;
    store.deleteWorkspace(first);
    expect(store.getState().activeWorkspaceId).toBe(second);
    expect(reasons).toEqual(['document']);
    expect(store.getState().dirty).toBe(true);
  });

  it('forgets the deleted workspace’s undo history', () => {
    const { store, first } = savedBoard();
    const second = store.addWorkspace();
    store.execute(addElements([rect(9000)]));
    store.switchWorkspace(first);
    store.deleteWorkspace(second);
    const again = store.addWorkspace();
    expect(again).not.toBe(second);
    expect(store.history.canUndo()).toBe(false);
  });
});

describe('saving', () => {
  it('writes every workspace, with the live camera folded into the one on stage', () => {
    const { store } = savedBoard();
    store.addWorkspace();
    store.execute(addElements([rect(9000)]));
    store.setViewport({ x: 7, y: 8, zoom: 2 });

    const reloaded = loadDocument(serializeBoard(store.boardForSave()));
    expect(reloaded.workspaces).toHaveLength(2);
    expect(reloaded.activeWorkspaceId).toBe(store.getState().activeWorkspaceId);
    expect(reloaded.document.viewport).toEqual({ x: 7, y: 8, zoom: 2 });
    expect(reloaded.workspaces[0]?.parked?.elements).toHaveLength(1);
  });

  it('lands clean when the user only switched while it ran', () => {
    const { store, first } = savedBoard();
    const second = store.addWorkspace();
    const ticket = store.saveTicket();
    store.switchWorkspace(first);
    store.switchWorkspace(second);
    expect(store.completeSave(ticket, FILE)).toBe('clean');
    expect(store.getState().dirty).toBe(false);
  });

  it('lands as edited when a workspace was added or renamed while it ran', () => {
    const { store, first } = savedBoard();
    const ticket = store.saveTicket();
    store.renameWorkspace(first, 'Renamed');
    expect(store.completeSave(ticket, FILE)).toBe('edited');
    expect(store.getState().dirty).toBe(true);

    const second = store.saveTicket();
    store.addWorkspace();
    expect(store.completeSave(second, FILE)).toBe('edited');
  });

  it('opens a loaded board on its active workspace, with a fresh history for each', () => {
    const store = new Store();
    store.execute(addElements([rect()]));
    store.addWorkspace();
    const file = serializeBoard(store.boardForSave());

    const other = new Store();
    other.load(loadDocument(file), FILE);
    expect(other.getState().activeWorkspaceId).toBe(store.getState().activeWorkspaceId);
    expect(other.history.canUndo()).toBe(false);
    expect(other.workspaceSummaries().map((summary) => [summary.elementCount, summary.active])).toEqual([
      [1, false],
      [0, true],
    ]);
  });

  it('writes back top-level fields it does not know', () => {
    const store = new Store();
    const result = loadDocument({ type: 'mindflow.board', schemaVersion: '2.0.0', workspaces: [], comments: ['hi'] });
    store.load(result, FILE);
    expect(JSON.parse(serializeBoard(store.boardForSave())).comments).toEqual(['hi']);
    store.reset();
    expect(JSON.parse(serializeBoard(store.boardForSave())).comments).toBeUndefined();
  });
});
