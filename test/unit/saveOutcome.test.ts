/**
 * What a save records when it lands.
 *
 * A save takes a ticket when it snapshots the board, and it may land seconds
 * later: a Drive round trip. By then the user may have kept editing, or moved
 * to another board. The store used to mark whatever was on screen as saved.
 * That cleared the dirty flag over edits the file did not contain, and gave a
 * newly opened board the old board's file, so its next save overwrote it.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { createDocument } from '../../src/model/defaults.ts';
import type { MindflowElement } from '../../src/model/types.ts';
import { addElements } from '../../src/store/commands.ts';
import { Store, type BoardOrigin, type ChangeReason } from '../../src/store/store.ts';

const FILE: BoardOrigin = { kind: 'drive', fileId: 'file-1', name: 'Plan.mindflow.json' };

function makeRect(zIndex = 1000): MindflowElement {
  return getDefinition('rectangle').create({ x: 0, y: 0, zIndex }) as MindflowElement;
}

/** A store holding one unsaved rectangle: a board someone is about to save. */
function unsavedBoard() {
  const store = new Store();
  store.execute(addElements([makeRect()]));
  const reasons: ChangeReason[] = [];
  store.subscribe((_state, reason) => reasons.push(reason));
  return { store, reasons };
}

function openOther(store: Store, id = 'other-board'): void {
  store.load({ document: { ...createDocument('Other'), id }, warnings: [], preserved: [] }, { kind: 'new' });
}

describe('Store.completeSave', () => {
  describe('with the saved board still on screen', () => {
    it('marks it saved when nothing changed while saving', () => {
      const { store, reasons } = unsavedBoard();
      const ticket = store.saveTicket();

      expect(store.completeSave(ticket, FILE)).toBe('clean');

      expect(store.getState().dirty).toBe(false);
      expect(store.getState().origin).toEqual(FILE);
      expect(reasons).toEqual(['saved']);
    });

    it('does not count a pan as a change', () => {
      // Panning is not an edit, and the viewport is folded in at save time.
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      store.setViewport({ x: 40, y: 40, zoom: 2 });

      expect(store.completeSave(ticket, FILE)).toBe('clean');
      expect(store.getState().dirty).toBe(false);
    });

    it('keeps edits made while saving unsaved, but remembers the file', () => {
      // The file does not contain the new rectangle, so the board must stay
      // dirty. It must still learn where it was saved: for a first save to
      // Drive, forgetting the new file id would create a second file next time.
      const { store, reasons } = unsavedBoard();
      const ticket = store.saveTicket();
      store.execute(addElements([makeRect(2000)]));
      reasons.length = 0;

      expect(store.completeSave(ticket, FILE)).toBe('edited');

      expect(store.getState().dirty).toBe(true);
      expect(store.getState().origin).toEqual(FILE);
      expect(reasons).toEqual(['origin']);
    });

    it('counts a live gesture preview as a change', () => {
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      store.execute(addElements([makeRect(2000)]), true);

      expect(store.completeSave(ticket, FILE)).toBe('edited');
    });

    it('counts undo and redo as changes', () => {
      const { store } = unsavedBoard();

      let ticket = store.saveTicket();
      store.undo();
      expect(store.completeSave(ticket, FILE)).toBe('edited');

      ticket = store.saveTicket();
      store.redo();
      expect(store.completeSave(ticket, FILE)).toBe('edited');
    });

    it('counts an added image file as a change', () => {
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      store.addFiles({
        abc: { mimeType: 'image/png', dataUri: 'data:image/png;base64,AA==', byteLength: 1, createdAt: '2026-01-01T00:00:00.000Z' },
      });

      expect(store.completeSave(ticket, FILE)).toBe('edited');
    });

    it('counts markDirty as a change even when the board was already dirty', () => {
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      store.markDirty();

      expect(store.completeSave(ticket, FILE)).toBe('edited');
    });

    it('lets the follow-up save finish the job', () => {
      const { store } = unsavedBoard();
      const first = store.saveTicket();
      store.execute(addElements([makeRect(2000)]));
      const second = store.saveTicket();

      expect(store.completeSave(first, FILE)).toBe('edited');
      expect(store.completeSave(second, FILE)).toBe('clean');
      expect(store.getState().dirty).toBe(false);
    });
  });

  describe('after the user moved to another board', () => {
    it('leaves the new board alone', () => {
      const { store, reasons } = unsavedBoard();
      const ticket = store.saveTicket();
      openOther(store);
      const before = store.getState();
      const document = before.document;
      reasons.length = 0;

      store.completeSave(ticket, FILE);

      expect(store.getState().origin).toEqual({ kind: 'new' });
      expect(store.getState().dirty).toBe(false);
      expect(store.document).toBe(document);
      expect(reasons).toEqual([]);
    });

    it('reports a board left exactly as it was saved', () => {
      // Its recent-boards copy was written when it was left, as unsaved. That
      // copy holds exactly what the save wrote, so the app can clear the flag.
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      openOther(store);

      expect(store.completeSave(ticket, FILE)).toBe('left-as-saved');
    });

    it('treats New board like any other switch', () => {
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      store.reset();

      expect(store.completeSave(ticket, FILE)).toBe('left-as-saved');
      expect(store.getState().origin).toEqual({ kind: 'new' });
    });

    it('reports a board edited after the save began, then left', () => {
      // Its copy holds edits the file does not, so it must stay unsaved.
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      store.execute(addElements([makeRect(2000)]));
      openOther(store);

      expect(store.completeSave(ticket, FILE)).toBe('left');
    });

    it('does not trust a board reopened under the same id', () => {
      // A board reopened from the recent list comes back with no file behind
      // it on purpose, so a late save must not attach one. Its recent-boards
      // copy now belongs to the board on screen, which may hold newer edits,
      // so the app must not rewrite that copy either.
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      const id = store.document.id;
      openOther(store, id);

      expect(store.completeSave(ticket, FILE)).toBe('left');
      expect(store.getState().origin).toEqual({ kind: 'new' });
    });

    it('cannot vouch for the copy after more than one switch', () => {
      // Only the most recent departure is remembered. Saying less is safe:
      // the copy just keeps its "unsaved" tag.
      const { store } = unsavedBoard();
      const ticket = store.saveTicket();
      openOther(store, 'second');
      openOther(store, 'third');

      expect(store.completeSave(ticket, FILE)).toBe('left');
    });
  });
});
