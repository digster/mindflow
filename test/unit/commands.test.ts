/**
 * Command and history tests.
 *
 * The central claim of the command design is that undo is *correct by
 * construction*: because a command records `before` and `after` for the elements
 * it touches, inverting is a field swap, and that works uniformly for create,
 * delete, update and reorder.
 *
 * These tests hold that claim to account. The property test — apply, invert,
 * compare — is the one that matters most; it would catch any operation that
 * quietly fails to record what it changed.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { createDocument } from '../../src/model/defaults.ts';
import type { LinearElement, MindflowDocument, MindflowElement } from '../../src/model/types.ts';
import {
  addElements,
  applyCommand,
  deleteElements,
  expandSelectionToGroups,
  groupElements,
  invertCommand,
  isNoopCommand,
  needsReindex,
  reindexZ,
  reorderElements,
  replaceElements,
  topZIndex,
  ungroupElements,
  updateElements,
} from '../../src/store/commands.ts';
import { History } from '../../src/store/history.ts';
import { Store } from '../../src/store/store.ts';

function makeRect(zIndex: number, overrides: Partial<MindflowElement> = {}): MindflowElement {
  return { ...getDefinition('rectangle').create({ x: 0, y: 0, zIndex }), ...overrides } as MindflowElement;
}

function docWith(...elements: MindflowElement[]): MindflowDocument {
  return { ...createDocument(), elements: [...elements].sort((a, b) => a.zIndex - b.zIndex) };
}

describe('applyCommand / invertCommand', () => {
  it('adds elements', () => {
    const doc = createDocument();
    const rect = makeRect(1000);
    const next = applyCommand(doc, addElements([rect]));
    expect(next.elements).toHaveLength(1);
    expect(next.elements[0]?.id).toBe(rect.id);
  });

  it('does not mutate the input document', () => {
    const doc = createDocument();
    applyCommand(doc, addElements([makeRect(1000)]));
    expect(doc.elements).toHaveLength(0);
  });

  it('keeps elements sorted by zIndex regardless of patch order', () => {
    const doc = createDocument();
    const next = applyCommand(doc, addElements([makeRect(3000), makeRect(1000), makeRect(2000)]));
    expect(next.elements.map((element) => element.zIndex)).toEqual([1000, 2000, 3000]);
  });

  it('preserves object identity for untouched elements', () => {
    // This is what lets the renderer skip work for things that did not move.
    const untouched = makeRect(1000);
    const target = makeRect(2000);
    const doc = docWith(untouched, target);

    const next = applyCommand(doc, updateElements(doc, [target.id], (el) => ({ ...el, x: 50 })));
    expect(next.elements.find((el) => el.id === untouched.id)).toBe(untouched);
  });

  describe('apply → invert → identical', () => {
    // The core property. Every operation must round-trip exactly.
    const cases: [string, (doc: MindflowDocument, els: MindflowElement[]) => ReturnType<typeof addElements>][] = [
      ['add', () => addElements([makeRect(4000)])],
      ['delete', (doc, els) => deleteElements(doc, [els[0]!.id])],
      ['delete all', (doc, els) => deleteElements(doc, els.map((el) => el.id))],
      ['move', (doc, els) => updateElements(doc, [els[0]!.id], (el) => ({ ...el, x: el.x + 137 }))],
      ['restyle', (doc, els) =>
        updateElements(doc, els.map((el) => el.id), (el) => ({ ...el, style: { ...el.style, stroke: '#ff0000' } }))],
      ['reorder to front', (doc, els) => reorderElements(doc, [els[0]!.id], 'front')],
      ['reorder to back', (doc, els) => reorderElements(doc, [els[2]!.id], 'back')],
      ['reorder forward', (doc, els) => reorderElements(doc, [els[0]!.id], 'forward')],
      ['group', (doc, els) => groupElements(doc, els.map((el) => el.id))],
      ['reindex', (doc) => reindexZ(doc)],
    ];

    for (const [name, build] of cases) {
      it(name, () => {
        const elements = [makeRect(1000), makeRect(2000), makeRect(3000)];
        const doc = docWith(...elements);

        const command = build(doc, elements);
        const applied = applyCommand(doc, command);
        const reverted = applyCommand(applied, invertCommand(command));

        // `updatedAt` is rewritten on every apply, so compare only the elements.
        expect(reverted.elements).toEqual(doc.elements);
      });
    }
  });
});

describe('deleteElements', () => {
  it('clears bindings pointing at deleted elements, in the same command', () => {
    // Deleting a shape must not leave a connector pointing at a ghost — and undo
    // must restore both the shape and its connections in one step.
    const target = makeRect(1000);
    const arrow = getDefinition<LinearElement>('arrow').create({ x: 0, y: 0, zIndex: 2000 });
    arrow.endBinding = { elementId: target.id, anchor: { mode: 'auto' }, gap: 4 };

    const doc = docWith(target, arrow);
    const command = deleteElements(doc, [target.id]);
    const after = applyCommand(doc, command);

    const survivor = after.elements.find((el) => el.id === arrow.id) as LinearElement;
    expect(after.elements).toHaveLength(1);
    expect(survivor.endBinding).toBeNull();

    // And undo brings both back together.
    const reverted = applyCommand(after, invertCommand(command));
    expect(reverted.elements).toHaveLength(2);
    expect((reverted.elements.find((el) => el.id === arrow.id) as LinearElement).endBinding).not.toBeNull();
  });
});

describe('z-order', () => {
  it('brings an element in front of everything', () => {
    const elements = [makeRect(1000), makeRect(2000), makeRect(3000)];
    const doc = docWith(...elements);
    const after = applyCommand(doc, reorderElements(doc, [elements[0]!.id], 'front'));
    expect(after.elements[after.elements.length - 1]?.id).toBe(elements[0]!.id);
  });

  it('walks one layer at a time when stepping forward', () => {
    const elements = [makeRect(1000), makeRect(2000), makeRect(3000)];
    const doc = docWith(...elements);
    const after = applyCommand(doc, reorderElements(doc, [elements[0]!.id], 'forward'));
    // Was bottom; should now sit between the other two, not on top.
    expect(after.elements.map((el) => el.id)).toEqual([elements[1]!.id, elements[0]!.id, elements[2]!.id]);
  });

  it('is a no-op at the end of the stack', () => {
    const elements = [makeRect(1000), makeRect(2000)];
    const doc = docWith(...elements);
    expect(reorderElements(doc, [elements[1]!.id], 'forward').patches).toHaveLength(0);
  });

  it('detects and repairs converged indices', () => {
    // Fractional indexing halves the gap on each insertion between the same
    // pair. Enough repetitions and two elements collide.
    const doc = docWith(makeRect(1000), makeRect(1000.0000001), makeRect(2000));
    expect(needsReindex(doc)).toBe(true);

    const repaired = applyCommand(doc, reindexZ(doc));
    expect(needsReindex(repaired)).toBe(false);
    expect(repaired.elements.map((el) => el.zIndex)).toEqual([1000, 2000, 3000]);
  });

  it('preserves relative order when reindexing', () => {
    const doc = docWith(makeRect(1000), makeRect(1000.5), makeRect(9000));
    const before = doc.elements.map((el) => el.id);
    const repaired = applyCommand(doc, reindexZ(doc));
    expect(repaired.elements.map((el) => el.id)).toEqual(before);
  });

  it('topZIndex sits above everything', () => {
    const doc = docWith(makeRect(1000), makeRect(5000));
    expect(topZIndex(doc)).toBeGreaterThan(5000);
  });
});

describe('grouping', () => {
  it('refuses to group fewer than two elements', () => {
    const rect = makeRect(1000);
    expect(groupElements(docWith(rect), [rect.id]).patches).toHaveLength(0);
  });

  it('assigns one shared groupId', () => {
    const elements = [makeRect(1000), makeRect(2000)];
    const doc = docWith(...elements);
    const after = applyCommand(doc, groupElements(doc, elements.map((el) => el.id)));
    const ids = after.elements.map((el) => el.groupId);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
  });

  it('ungroups the whole group when any member is named', () => {
    const elements = [makeRect(1000), makeRect(2000), makeRect(3000)];
    let doc = docWith(...elements);
    doc = applyCommand(doc, groupElements(doc, elements.map((el) => el.id)));

    doc = applyCommand(doc, ungroupElements(doc, [elements[1]!.id]));
    expect(doc.elements.every((el) => el.groupId === null)).toBe(true);
  });

  it('expands a selection to whole groups', () => {
    const elements = [makeRect(1000), makeRect(2000), makeRect(3000)];
    let doc = docWith(...elements);
    doc = applyCommand(doc, groupElements(doc, [elements[0]!.id, elements[1]!.id]));

    const expanded = expandSelectionToGroups(doc, [elements[0]!.id]);
    expect(expanded).toEqual(new Set([elements[0]!.id, elements[1]!.id]));
  });

  it('leaves ungrouped selections alone', () => {
    const elements = [makeRect(1000), makeRect(2000)];
    const doc = docWith(...elements);
    expect(expandSelectionToGroups(doc, [elements[0]!.id])).toEqual(new Set([elements[0]!.id]));
  });
});

describe('isNoopCommand', () => {
  it('recognises an empty update', () => {
    const rect = makeRect(1000);
    const doc = docWith(rect);
    expect(isNoopCommand(updateElements(doc, [rect.id], () => null))).toBe(true);
  });
});

describe('History', () => {
  let history: History;
  let doc: MindflowDocument;
  let rect: MindflowElement;

  beforeEach(() => {
    history = new History();
    rect = makeRect(1000);
    doc = docWith(rect);
  });

  it('undoes and redoes a change', () => {
    const command = updateElements(doc, [rect.id], (el) => ({ ...el, x: 500 }));
    const moved = applyCommand(doc, command);
    history.push(command);

    const undone = history.undo(moved);
    expect(undone?.elements[0]?.x).toBe(rect.x);

    const redone = history.redo(undone as MindflowDocument);
    expect(redone?.elements[0]?.x).toBe(500);
  });

  it('returns null when there is nothing to undo', () => {
    expect(history.undo(doc)).toBeNull();
    expect(history.canUndo()).toBe(false);
  });

  it('drops no-op commands', () => {
    expect(history.push(updateElements(doc, [rect.id], () => null))).toBe(false);
    expect(history.canUndo()).toBe(false);
  });

  it('clears the redo stack on a new edit', () => {
    const first = updateElements(doc, [rect.id], (el) => ({ ...el, x: 100 }));
    history.push(first);
    history.undo(applyCommand(doc, first));
    expect(history.canRedo()).toBe(true);

    history.push(updateElements(doc, [rect.id], (el) => ({ ...el, y: 100 })));
    expect(history.canRedo()).toBe(false);
  });

  it('coalesces consecutive commands with the same label', () => {
    // A drag emits one command per pointer-move; the whole gesture should be a
    // single undo step.
    for (let i = 1; i <= 5; i++) {
      history.push(updateElements(doc, [rect.id], (el) => ({ ...el, x: i * 10 }), 'Move', true));
    }
    expect(history.size().undo).toBe(1);
  });

  it('keeps the original `before` when coalescing', () => {
    // Getting this backwards is the classic coalescing bug: undo would jump to a
    // point mid-gesture instead of to where the drag started.
    let current = doc;
    for (let i = 1; i <= 5; i++) {
      const command = updateElements(current, [rect.id], (el) => ({ ...el, x: i * 10 }), 'Move', true);
      current = applyCommand(current, command);
      history.push(command);
    }
    expect(current.elements[0]?.x).toBe(50);

    const undone = history.undo(current);
    expect(undone?.elements[0]?.x).toBe(rect.x);
  });

  it('does not coalesce across different labels', () => {
    history.push(updateElements(doc, [rect.id], (el) => ({ ...el, x: 10 }), 'Move', true));
    history.push(updateElements(doc, [rect.id], (el) => ({ ...el, angle: 45 }), 'Rotate', true));
    expect(history.size().undo).toBe(2);
  });

  it('breakCoalescing starts a fresh step', () => {
    history.push(updateElements(doc, [rect.id], (el) => ({ ...el, x: 10 }), 'Move', true));
    history.breakCoalescing();
    history.push(updateElements(doc, [rect.id], (el) => ({ ...el, x: 20 }), 'Move', true));
    expect(history.size().undo).toBe(2);
  });

  it('clears both stacks', () => {
    history.push(updateElements(doc, [rect.id], (el) => ({ ...el, x: 10 })));
    history.clear();
    expect(history.canUndo()).toBe(false);
    expect(history.canRedo()).toBe(false);
  });
});

describe('Store', () => {
  it('marks the board dirty on an edit but not on a pan', () => {
    const store = new Store();
    expect(store.getState().dirty).toBe(false);

    store.setViewport({ x: 100, y: 100, zoom: 2 });
    expect(store.getState().dirty).toBe(false); // Panning is not an edit.

    store.execute(addElements([makeRect(1000)]));
    expect(store.getState().dirty).toBe(true);
  });

  it('does not record transient commands in history', () => {
    const store = new Store();
    store.execute(addElements([makeRect(1000)]), true);
    expect(store.history.canUndo()).toBe(false);
    expect(store.document.elements).toHaveLength(1);
  });

  it('prunes selection after undoing a creation', () => {
    // Undo removes the element while it is still selected; without pruning, the
    // selection outline would be drawn around a phantom.
    const store = new Store();
    const rect = makeRect(1000);
    store.execute(addElements([rect]));
    store.setSelection([rect.id]);
    expect(store.selectedIds()).toEqual([rect.id]);

    store.undo();
    expect(store.selectedIds()).toEqual([]);
  });

  it('expands selection to groups automatically', () => {
    const store = new Store();
    const elements = [makeRect(1000), makeRect(2000)];
    store.execute(addElements(elements));
    store.execute(groupElements(store.document, elements.map((el) => el.id)));

    store.setSelection([elements[0]!.id]);
    expect(store.selectedIds()).toHaveLength(2);
  });

  it('folds the live viewport into the document at save time', () => {
    const store = new Store();
    store.setViewport({ x: 42, y: 84, zoom: 1.5 });
    expect(store.document.viewport.x).toBe(0);           // not yet folded in
    expect(store.documentForSave().viewport.x).toBe(42); // folded in on demand
  });

  it('adds files without touching history', () => {
    // The files map is content-addressed and append-only, so there is nothing
    // for undo to reverse — and keeping data URIs out of patches keeps undo cheap.
    const store = new Store();
    store.addFiles({ abc: { mimeType: 'image/png', dataUri: 'data:image/png;base64,AA==', byteLength: 1, createdAt: new Date().toISOString() } });
    expect(store.document.files.abc).toBeDefined();
    expect(store.history.canUndo()).toBe(false);
  });

  it('notifies subscribers with a reason', () => {
    const store = new Store();
    const reasons: string[] = [];
    store.subscribe((_state, reason) => reasons.push(reason));

    store.execute(addElements([makeRect(1000)]));
    store.setViewport({ x: 1, y: 1, zoom: 1 });
    store.setTool('ellipse');

    expect(reasons).toContain('document');
    expect(reasons).toContain('viewport');
    expect(reasons).toContain('tool');
  });
});

describe('replaceElements', () => {
  it('produces no patch when nothing changed', () => {
    const rect = makeRect(1000);
    const doc = docWith(rect);
    expect(replaceElements(doc, [rect]).patches).toHaveLength(0);
  });
});
