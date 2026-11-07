/**
 * Putting the unsaved-changes flag back after a provisional edit.
 *
 * A new text box is added transiently and removed again if it is closed
 * blank. Transient commands mark the board dirty, so without this the board
 * asked "Discard unsaved changes?" about a box that never existed. The flag may
 * only be put back when nothing it answers for happened in between, or it would
 * hide a real change.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { createDocument } from '../../src/model/defaults.ts';
import type { MindflowElement } from '../../src/model/types.ts';
import { addElements, deleteElements } from '../../src/store/commands.ts';
import { Store, type ChangeReason } from '../../src/store/store.ts';

function makeText(): MindflowElement {
  return getDefinition('text').create({ x: 0, y: 0, zIndex: 1000 }) as MindflowElement;
}

function makeRect(): MindflowElement {
  return getDefinition('rectangle').create({ x: 200, y: 0, zIndex: 500 }) as MindflowElement;
}

/** Adds an element transiently and takes it back off, as an abandoned text box does. */
function addAndRewind(store: Store, element = makeText()): void {
  store.execute(addElements([element]), true);
  store.execute(deleteElements(store.document, [element.id]), true);
}

describe('Store.restoreDirty', () => {
  it('puts a clean board back to clean after a rewound transient edit', () => {
    const store = new Store();
    const checkpoint = store.dirtyCheckpoint();
    addAndRewind(store);
    expect(store.getState().dirty).toBe(true);

    const reasons: ChangeReason[] = [];
    store.subscribe((_state, reason) => reasons.push(reason));
    expect(store.restoreDirty(checkpoint)).toBe(true);

    expect(store.getState().dirty).toBe(false);
    // Emitted, so the Save button and the recent-boards copy see it.
    expect(reasons).toEqual(['document']);
    expect(store.history.canUndo()).toBe(false);
  });

  it('leaves a board that was already unsaved unsaved', () => {
    const store = new Store();
    store.execute(addElements([makeRect()]));
    const checkpoint = store.dirtyCheckpoint();
    addAndRewind(store);

    store.restoreDirty(checkpoint);
    expect(store.getState().dirty).toBe(true);
  });

  // `meta.updatedAt` drives the top bar's "Edited …" label and is kept in the
  // autosave copy. Every command moves it, transient ones included, so time is
  // faked to make that movement certain rather than a matter of milliseconds.
  describe('the edit time', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse('2026-11-07T10:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('goes back to before the rewound edit, with one notification for both', () => {
      const store = new Store();
      store.execute(addElements([makeRect()]));
      store.markSaved();
      const editedAt = store.document.meta.updatedAt;
      const checkpoint = store.dirtyCheckpoint();

      vi.setSystemTime(Date.parse('2026-11-07T10:05:00.000Z'));
      addAndRewind(store);
      expect(store.document.meta.updatedAt).not.toBe(editedAt);

      const reasons: ChangeReason[] = [];
      store.subscribe((_state, reason) => reasons.push(reason));
      const before = store.document;
      expect(store.restoreDirty(checkpoint)).toBe(true);

      expect(store.document.meta.updatedAt).toBe(editedAt);
      expect(store.getState().dirty).toBe(false);
      expect(reasons).toEqual(['document']);
      // Replaced, not mutated, and the elements untouched.
      expect(store.document).not.toBe(before);
      expect(store.document.elements).toBe(before.elements);
    });

    it('goes back on a board that stays unsaved, which notifies for the time alone', () => {
      const store = new Store();
      store.execute(addElements([makeRect()]));
      const editedAt = store.document.meta.updatedAt;
      const checkpoint = store.dirtyCheckpoint();

      vi.setSystemTime(Date.parse('2026-11-07T10:05:00.000Z'));
      addAndRewind(store);

      const reasons: ChangeReason[] = [];
      store.subscribe((_state, reason) => reasons.push(reason));
      expect(store.restoreDirty(checkpoint)).toBe(true);

      expect(store.document.meta.updatedAt).toBe(editedAt);
      expect(store.getState().dirty).toBe(true);
      expect(reasons).toEqual(['document']);
    });

    it('stays when the restore is refused, because the edit was real', () => {
      const store = new Store();
      const checkpoint = store.dirtyCheckpoint();

      vi.setSystemTime(Date.parse('2026-11-07T10:05:00.000Z'));
      store.execute(addElements([makeRect()]));
      addAndRewind(store);

      expect(store.restoreDirty(checkpoint)).toBe(false);
      expect(store.document.meta.updatedAt).toBe('2026-11-07T10:05:00.000Z');
    });

    it('notifies nothing when neither the flag nor the time moved', () => {
      const store = new Store();
      const checkpoint = store.dirtyCheckpoint();
      const reasons: ChangeReason[] = [];
      store.subscribe((_state, reason) => reasons.push(reason));

      expect(store.restoreDirty(checkpoint)).toBe(true);
      expect(reasons).toEqual([]);
    });
  });

  describe('refuses, keeping the board unsaved, when since the checkpoint', () => {
    it('a command reached the undo stack', () => {
      const store = new Store();
      const checkpoint = store.dirtyCheckpoint();
      store.execute(addElements([makeRect()]));
      addAndRewind(store);

      expect(store.restoreDirty(checkpoint)).toBe(false);
      expect(store.getState().dirty).toBe(true);
    });

    it('something was undone', () => {
      const store = new Store();
      store.execute(addElements([makeRect()]));
      store.markSaved();
      const checkpoint = store.dirtyCheckpoint();
      store.undo();

      // The rectangle the saved file holds is gone from the board.
      expect(store.restoreDirty(checkpoint)).toBe(false);
      expect(store.getState().dirty).toBe(true);
    });

    it('something was redone', () => {
      const store = new Store();
      store.execute(addElements([makeRect()]));
      store.undo();
      store.markSaved();
      const checkpoint = store.dirtyCheckpoint();
      store.redo();

      expect(store.restoreDirty(checkpoint)).toBe(false);
      expect(store.getState().dirty).toBe(true);
    });

    it('the board was saved mid-edit, so the file holds the provisional element', () => {
      const store = new Store();
      const checkpoint = store.dirtyCheckpoint();
      const element = makeText();
      store.execute(addElements([element]), true);
      store.markSaved();
      store.execute(deleteElements(store.document, [element.id]), true);

      expect(store.restoreDirty(checkpoint)).toBe(false);
      expect(store.getState().dirty).toBe(true);
    });

    it('a save landed on an edited board and recorded where it went', () => {
      const store = new Store();
      const checkpoint = store.dirtyCheckpoint();
      store.setOrigin({ kind: 'local', name: 'board.mindflow.json' });
      addAndRewind(store);

      expect(store.restoreDirty(checkpoint)).toBe(false);
    });

    it('the board was flagged unsaved directly', () => {
      const store = new Store();
      const checkpoint = store.dirtyCheckpoint();
      store.markDirty();
      addAndRewind(store);

      expect(store.restoreDirty(checkpoint)).toBe(false);
      expect(store.getState().dirty).toBe(true);
    });

    it('another board was opened', () => {
      const store = new Store();
      store.execute(addElements([makeRect()]));
      const checkpoint = store.dirtyCheckpoint();
      store.load({ document: createDocument('Other'), warnings: [], preserved: [] }, { kind: 'new' });
      store.markDirty();

      // Its flag is its own, whatever the old board's was.
      expect(store.restoreDirty(checkpoint)).toBe(false);
      expect(store.getState().dirty).toBe(true);
    });

    it('a new board was started', () => {
      const store = new Store();
      const checkpoint = store.dirtyCheckpoint();
      store.reset();
      addAndRewind(store);

      expect(store.restoreDirty(checkpoint)).toBe(false);
    });
  });

  it('is not disturbed by a pan or a selection, which are not edits', () => {
    const store = new Store();
    const checkpoint = store.dirtyCheckpoint();
    const element = makeText();
    store.execute(addElements([element]), true);
    store.setSelection([element.id]);
    store.setViewport({ x: 40, y: 40, zoom: 2 });
    store.execute(deleteElements(store.document, [element.id]), true);

    expect(store.restoreDirty(checkpoint)).toBe(true);
    expect(store.getState().dirty).toBe(false);
  });
});
