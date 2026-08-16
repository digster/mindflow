/**
 * Locking tests.
 *
 * A lock has to do two opposite things at once: make an element invisible to
 * ordinary picking, so a locked background behaves like scenery, *and* leave it
 * reachable somehow, or it can never be unlocked again. These tests pin both
 * halves, because getting only the first one right is exactly the trap this
 * suite exists to catch.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { createDocument } from '../../src/model/defaults.ts';
import type { MindflowDocument, MindflowElement } from '../../src/model/types.ts';
import { elementAt, elementsAt, elementsInBox } from '../../src/input/hitTest.ts';
import { canTransform } from '../../src/render/overlay.ts';

function makeRect(overrides: Partial<MindflowElement> = {}): MindflowElement {
  const base = getDefinition('rectangle').create({ x: 0, y: 0, width: 100, height: 100, zIndex: 1 });
  // A solid fill, so the interior is hit-testable — unfilled shapes are hollow
  // to clicks by design and would make these tests pass for the wrong reason.
  return {
    ...base,
    style: { ...base.style, fill: '#ffffff', fillStyle: 'solid' },
    ...overrides,
  } as MindflowElement;
}

function documentWith(...elements: MindflowElement[]): MindflowDocument {
  return { ...createDocument(), elements };
}

const CENTRE = { x: 50, y: 50 };
const AROUND = { minX: -50, minY: -50, maxX: 200, maxY: 200 };

describe('picking a locked element', () => {
  it('is skipped by an ordinary click, so the click reaches what is behind', () => {
    const doc = documentWith(makeRect({ locked: true }));
    expect(elementAt(doc, CENTRE, 1)).toBeNull();
  });

  it('lets a click through to an unlocked element underneath', () => {
    const behind = makeRect({ id: 'behind', zIndex: 1 });
    const front = makeRect({ id: 'front', zIndex: 2, locked: true });
    const doc = documentWith(behind, front);
    expect(elementAt(doc, CENTRE, 1)?.id).toBe('behind');
  });

  it('is returned when the caller opts in — the route back to unlocking it', () => {
    const doc = documentWith(makeRect({ id: 'locked', locked: true }));
    expect(elementAt(doc, CENTRE, 1, { includeLocked: true })?.id).toBe('locked');
  });

  it('is skipped by the marquee and by pick-through', () => {
    const doc = documentWith(makeRect({ locked: true }));
    expect(elementsInBox(doc, AROUND)).toHaveLength(0);
    expect(elementsAt(doc, CENTRE, 1)).toHaveLength(0);
  });

  it('is still skipped when hidden as well as locked', () => {
    const doc = documentWith(makeRect({ locked: true, visible: false }));
    expect(elementAt(doc, CENTRE, 1, { includeLocked: true })).toBeNull();
  });
});

describe('canTransform', () => {
  it('is false for an empty selection', () => {
    expect(canTransform([])).toBe(false);
  });

  it('is true when nothing in the selection is locked', () => {
    expect(canTransform([makeRect(), makeRect()])).toBe(true);
  });

  it('is false when any single member is locked', () => {
    expect(canTransform([makeRect(), makeRect({ locked: true })])).toBe(false);
  });
});
