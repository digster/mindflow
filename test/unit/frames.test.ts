/**
 * Frame containment.
 *
 * These are the rules an external tool has to reimplement to rewrite a board
 * consistently, so they are specified in `docs/03-elements.md` and pinned here:
 * membership by centre, frames never nesting, move and delete acting on whole
 * frames, and dangling references degrading to `null` rather than to an
 * invisible element.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { loadDocument, serializeDocument } from '../../src/model/document.ts';
import {
  danglingFrameRefs,
  frameFor,
  membersOf,
  reassignFrames,
  withFrameMembers,
} from '../../src/model/frames.ts';
import { getDefinition } from '../../src/model/registry.ts';
import type { MindflowDocument, MindflowElement } from '../../src/model/types.ts';
import { applyCommand, deleteElements } from '../../src/store/commands.ts';

function frame(x: number, y: number, w: number, h: number, overrides: Partial<MindflowElement> = {}) {
  return {
    ...getDefinition('frame').create({ x, y, width: w, height: h, zIndex: 1000 }),
    ...overrides,
  } as MindflowElement;
}

function rect(x: number, y: number, overrides: Partial<MindflowElement> = {}) {
  return {
    ...getDefinition('rectangle').create({ x, y, width: 100, height: 80, zIndex: 5000 }),
    ...overrides,
  } as MindflowElement;
}

function docWith(...elements: MindflowElement[]): MindflowDocument {
  return { ...createDocument(), elements: [...elements].sort((a, b) => a.zIndex - b.zIndex) };
}

describe('frameFor', () => {
  it('claims an element whose centre is inside', () => {
    const f = frame(0, 0, 400, 300);
    const inside = rect(100, 100);
    expect(frameFor(docWith(f, inside), inside)?.id).toBe(f.id);
  });

  it('does not claim one whose centre is outside, even when they overlap', () => {
    // Centre containment, not overlap: an element straddling the border needs
    // exactly one answer, and this is it.
    const f = frame(0, 0, 200, 200);
    const straddling = rect(160, 60); // centre at x = 210, past the right edge
    expect(frameFor(docWith(f, straddling), straddling)).toBeNull();
  });

  it('never claims another frame — frames do not nest', () => {
    const outer = frame(0, 0, 600, 600, { zIndex: 1000 });
    const inner = frame(100, 100, 200, 200, { zIndex: 2000 });
    expect(frameFor(docWith(outer, inner), inner)).toBeNull();
  });

  it('gives the topmost frame when two overlap', () => {
    const lower = frame(0, 0, 400, 400, { zIndex: 1000 });
    const upper = frame(0, 0, 400, 400, { zIndex: 2000 });
    const inside = rect(100, 100);
    expect(frameFor(docWith(lower, upper, inside), inside)?.id).toBe(upper.id);
  });

  it('ignores a hidden frame', () => {
    const hidden = frame(0, 0, 400, 300, { visible: false });
    const inside = rect(100, 100);
    expect(frameFor(docWith(hidden, inside), inside)).toBeNull();
  });
});

describe('reassignFrames', () => {
  it('assigns membership when an element lands inside', () => {
    const f = frame(0, 0, 400, 300);
    const moved = rect(100, 100);
    const changed = reassignFrames(docWith(f, moved), new Set([moved.id]));
    expect(changed[0]?.frameId).toBe(f.id);
  });

  it('clears membership when an element leaves', () => {
    const f = frame(0, 0, 200, 200);
    const gone = rect(900, 900, { frameId: f.id });
    const changed = reassignFrames(docWith(f, gone), new Set([gone.id]));
    expect(changed[0]?.frameId).toBeNull();
  });

  it('produces nothing when membership did not change', () => {
    // A drag that stays inside one frame must not generate a patch.
    const f = frame(0, 0, 400, 300);
    const staying = rect(100, 100, { frameId: f.id });
    expect(reassignFrames(docWith(f, staying), new Set([staying.id]))).toEqual([]);
  });

  it('leaves frames themselves alone', () => {
    // Dragging a frame across another must not enrol it as a child.
    const host = frame(0, 0, 600, 600, { zIndex: 1000 });
    const dragged = frame(100, 100, 100, 100, { zIndex: 2000 });
    expect(reassignFrames(docWith(host, dragged), new Set([dragged.id]))).toEqual([]);
  });
});

describe('withFrameMembers', () => {
  it('expands a frame to include its contents', () => {
    const f = frame(0, 0, 400, 300);
    const member = rect(100, 100, { frameId: f.id });
    const outside = rect(900, 900);
    const expanded = withFrameMembers(docWith(f, member, outside), [f.id]);
    expect(expanded.has(member.id)).toBe(true);
    expect(expanded.has(outside.id)).toBe(false);
  });

  it('leaves a plain selection untouched', () => {
    const solo = rect(0, 0);
    expect([...withFrameMembers(docWith(solo), [solo.id])]).toEqual([solo.id]);
  });
});

describe('deleting a frame', () => {
  it('takes its contents with it', () => {
    const f = frame(0, 0, 400, 300);
    const member = rect(100, 100, { frameId: f.id });
    const outside = rect(900, 900);
    const document = docWith(f, member, outside);

    const next = applyCommand(document, deleteElements(document, [f.id]));

    expect(next.elements).toHaveLength(1);
    expect(next.elements[0]?.id).toBe(outside.id);
  });

  it('is one undo step', () => {
    const f = frame(0, 0, 400, 300);
    const member = rect(100, 100, { frameId: f.id });
    const document = docWith(f, member);
    const command = deleteElements(document, [f.id]);
    // Both removals belong to the same command, which is what makes undo bring
    // the frame and its contents back together.
    expect(command.patches).toHaveLength(2);
  });
});

describe('membersOf', () => {
  it('finds the elements pointing at a frame', () => {
    const f = frame(0, 0, 400, 300);
    const a = rect(10, 10, { frameId: f.id });
    const b = rect(20, 20, { frameId: f.id });
    const c = rect(900, 900);
    expect(membersOf(docWith(f, a, b, c), f.id).map((el) => el.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
  });
});

describe('dangling references', () => {
  it('are reported', () => {
    const orphan = rect(0, 0, { frameId: 'el_NoSuchFrame' });
    expect(danglingFrameRefs(docWith(orphan))).toHaveLength(1);
  });

  it('are repaired on load rather than clipping to nothing', () => {
    const orphan = rect(0, 0, { frameId: 'el_NoSuchFrame' });
    const raw = JSON.parse(serializeDocument(docWith(orphan))) as Record<string, unknown>;

    const { document, warnings } = loadDocument(raw);

    expect(document.elements[0]?.frameId).toBeNull();
    expect(warnings.some((warning) => warning.level === 'warning')).toBe(true);
  });

  it('does not fire for a reference that resolves', () => {
    const f = frame(0, 0, 400, 300);
    const member = rect(100, 100, { frameId: f.id });
    expect(danglingFrameRefs(docWith(f, member))).toEqual([]);
  });
});

describe('frame normalisation', () => {
  it('forces a frame’s own frameId to null', () => {
    // Frames do not nest, and a file can be hand-authored, so this is enforced
    // on read as well as on write.
    const nested = frame(0, 0, 100, 100, { frameId: 'el_SomeFrame1' } as Partial<MindflowElement>);
    const raw = JSON.parse(serializeDocument(docWith(nested))) as Record<string, unknown>;
    const { document } = loadDocument(raw);
    expect(document.elements[0]?.frameId).toBeNull();
  });

  it('round-trips a named frame', () => {
    const named = frame(0, 0, 400, 300, { name: 'Sprint 12' } as Partial<MindflowElement>);
    const raw = JSON.parse(serializeDocument(docWith(named))) as Record<string, unknown>;
    const { document } = loadDocument(raw);
    expect((document.elements[0] as { name: string }).name).toBe('Sprint 12');
  });
});
