/**
 * Action tests.
 *
 * `Actions` is the layer every invocation route funnels through — keyboard,
 * toolbar, style panel, context menu, command palette — so a bug here is a bug
 * everywhere at once. It had no test file until align and distribute were given
 * user-facing controls.
 *
 * The align tests are deliberately built from cases that a naive implementation
 * gets wrong: a locked member, a group, and a rotated element. All three passed
 * silently while `align` had no caller.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { Actions } from '../../src/app/actions.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { elementWorldAABB } from '../../src/model/geometry.ts';
import { getDefinition } from '../../src/model/registry.ts';
import type { MindflowDocument, MindflowElement } from '../../src/model/types.ts';
import { Store } from '../../src/store/store.ts';

function makeRect(
  x: number,
  y: number,
  zIndex: number,
  overrides: Partial<MindflowElement> = {},
): MindflowElement {
  return {
    ...getDefinition('rectangle').create({ x, y, width: 100, height: 80, zIndex }),
    ...overrides,
  } as MindflowElement;
}

function docWith(...elements: MindflowElement[]): MindflowDocument {
  return { ...createDocument(), elements: [...elements].sort((a, b) => a.zIndex - b.zIndex) };
}

function setup(...elements: MindflowElement[]): { store: Store; actions: Actions } {
  const store = new Store(docWith(...elements));
  const actions = new Actions({
    store,
    getViewportSize: () => ({ width: 1000, height: 800 }),
    notify: () => {},
  });
  return { store, actions };
}

/** Looks an element up by id in the store's CURRENT document. */
function byId(store: Store, id: string): MindflowElement {
  const found = store.document.elements.find((element) => element.id === id);
  if (!found) throw new Error(`element ${id} is missing`);
  return found;
}

describe('align', () => {
  it('moves every unlocked element to the leading edge', () => {
    const a = makeRect(0, 0, 1000);
    const b = makeRect(50, 100, 2000);
    const c = makeRect(120, 200, 3000);
    const { store, actions } = setup(a, b, c);
    store.setSelection([a.id, b.id, c.id]);

    actions.align('left');

    expect(byId(store, a.id).x).toBe(0);
    expect(byId(store, b.id).x).toBe(0);
    expect(byId(store, c.id).x).toBe(0);
  });

  it('does nothing below two elements', () => {
    const a = makeRect(30, 0, 1000);
    const { store, actions } = setup(a);
    store.setSelection([a.id]);

    actions.align('left');

    expect(byId(store, a.id).x).toBe(30);
    expect(store.history.canUndo()).toBe(false);
  });

  it('is one undo step', () => {
    const a = makeRect(0, 0, 1000);
    const b = makeRect(50, 100, 2000);
    const { store, actions } = setup(a, b);
    store.setSelection([a.id, b.id]);

    actions.align('left');
    store.undo();

    expect(byId(store, b.id).x).toBe(50);
  });

  /**
   * A locked element can be in the selection — right-clicking one is how it is
   * reached in order to unlock it — so align has to exclude it the way delete
   * and nudge do.
   */
  it('leaves a locked element where it is', () => {
    const a = makeRect(0, 0, 1000);
    const locked = makeRect(300, 100, 2000, { locked: true });
    const c = makeRect(120, 200, 3000);
    const { store, actions } = setup(a, locked, c);
    store.setSelection([a.id, locked.id, c.id]);

    actions.align('left');

    expect(byId(store, locked.id).x).toBe(300);
    // …and the locked element does not drag the bounds out with it: the
    // remaining two align to their own leftmost edge, not to x = 300.
    expect(byId(store, a.id).x).toBe(0);
    expect(byId(store, c.id).x).toBe(0);
  });

  /**
   * Selecting any group member expands the selection to the whole group, so
   * aligning members individually would stack them on top of each other. A group
   * moves as one box.
   */
  it('moves a group as a single unit, preserving its internal layout', () => {
    const solo = makeRect(0, 0, 1000);
    const left = makeRect(400, 100, 2000, { groupId: 'grp_Pair000001' });
    const right = makeRect(520, 100, 3000, { groupId: 'grp_Pair000001' });
    const { store, actions } = setup(solo, left, right);
    store.setSelection([solo.id, left.id]);

    actions.align('left');

    // The group's leading edge lands on 0; the offset between members survives.
    expect(byId(store, left.id).x).toBe(0);
    expect(byId(store, right.id).x).toBe(120);
  });

  /**
   * `x`/`width` describe the UNROTATED box. A 45°-rotated square sticks out past
   * `element.x` by the rotation overhang, so assigning `x = bounds.minX` leaves
   * it visibly proud of its neighbours. What must line up is the world box.
   */
  it('aligns a rotated element by its visual edge, not its stored x', () => {
    const plain = makeRect(0, 0, 1000);
    const rotated = makeRect(200, 200, 2000, { angle: 45 });
    const { store, actions } = setup(plain, rotated);
    store.setSelection([plain.id, rotated.id]);

    actions.align('left');

    const plainBox = elementWorldAABB(byId(store, plain.id));
    const rotatedBox = elementWorldAABB(byId(store, rotated.id));
    expect(rotatedBox.minX).toBeCloseTo(plainBox.minX, 6);
    // The stored x is NOT the aligned value — that is the whole point.
    expect(byId(store, rotated.id).x).not.toBeCloseTo(plainBox.minX, 6);
  });

  it('centres on the midpoint of the whole selection', () => {
    const a = makeRect(0, 0, 1000);
    const b = makeRect(200, 100, 2000);
    const { store, actions } = setup(a, b);
    store.setSelection([a.id, b.id]);

    actions.align('centerX');

    // Both boxes are 100 wide across a span of 0..300, so both centre on 150.
    expect(byId(store, a.id).x).toBe(100);
    expect(byId(store, b.id).x).toBe(100);
  });
});

describe('distribute', () => {
  it('equalises the gaps between three elements', () => {
    const a = makeRect(0, 0, 1000);
    const b = makeRect(130, 0, 2000);
    const c = makeRect(400, 0, 3000);
    const { store, actions } = setup(a, b, c);
    store.setSelection([a.id, b.id, c.id]);

    actions.distribute('horizontal');

    // Span 0..500 holds 300 of boxes, leaving 200 across two gaps.
    expect(byId(store, a.id).x).toBe(0);
    expect(byId(store, b.id).x).toBe(200);
    expect(byId(store, c.id).x).toBe(400);
  });

  it('equalises gaps rather than centres when sizes differ', () => {
    const a = makeRect(0, 0, 1000);
    const wide = makeRect(150, 0, 2000, { width: 200 });
    const c = makeRect(500, 0, 3000);
    const { store, actions } = setup(a, wide, c);
    store.setSelection([a.id, wide.id, c.id]);

    actions.distribute('horizontal');

    // Span 0..600 holds 400 of boxes, leaving 200 across two gaps of 100.
    expect(byId(store, wide.id).x).toBe(200);
    // Centre-based spacing would have put it at 250 — assert we did not do that.
    expect(byId(store, wide.id).x).not.toBe(250);
  });

  it('does nothing below three elements', () => {
    const a = makeRect(0, 0, 1000);
    const b = makeRect(130, 0, 2000);
    const { store, actions } = setup(a, b);
    store.setSelection([a.id, b.id]);

    actions.distribute('horizontal');

    expect(byId(store, b.id).x).toBe(130);
    expect(store.history.canUndo()).toBe(false);
  });

  it('holds the two extremes in place', () => {
    const a = makeRect(0, 0, 1000);
    const b = makeRect(130, 0, 2000);
    const c = makeRect(400, 0, 3000);
    const { store, actions } = setup(a, b, c);
    store.setSelection([a.id, b.id, c.id]);

    actions.distribute('horizontal');

    expect(byId(store, a.id).x).toBe(0);
    expect(byId(store, c.id).x).toBe(400);
  });

  it('excludes locked elements from the spacing', () => {
    const a = makeRect(0, 0, 1000);
    const locked = makeRect(130, 0, 2000, { locked: true });
    const c = makeRect(400, 0, 3000);
    const { store, actions } = setup(a, locked, c);
    store.setSelection([a.id, locked.id, c.id]);

    actions.distribute('horizontal');

    // Only two editable units remain, which is below the threshold.
    expect(byId(store, locked.id).x).toBe(130);
    expect(byId(store, a.id).x).toBe(0);
    expect(byId(store, c.id).x).toBe(400);
  });

  it('distributes vertically on the other axis', () => {
    const a = makeRect(0, 0, 1000);
    const b = makeRect(0, 100, 2000);
    const c = makeRect(0, 400, 3000);
    const { store, actions } = setup(a, b, c);
    store.setSelection([a.id, b.id, c.id]);

    actions.distribute('vertical');

    // Span 0..480 holds 240 of boxes, leaving 240 across two gaps of 120.
    expect(byId(store, b.id).y).toBe(200);
    expect(byId(store, a.id).x).toBe(0);
  });
});
