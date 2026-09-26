/**
 * Renaming a frame from the canvas: where its name tab is, and when a
 * double-click is aimed at it.
 *
 * The tab is drawn OUTSIDE the frame's box, so `elementAt` never reports it.
 * These pin the separate picking that lets a double-click reach it, and the
 * paint-order rule that decides between the tab and whatever else is under
 * the pointer. Both are stated in `docs/05-interactions.md#frames`.
 *
 * Under Node there is no canvas to measure text with, so `measureTextWidth`
 * falls back to its per-character estimate. The tests read widths through the
 * same function rather than hard-coding them.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { getDefinition } from '../../src/model/registry.ts';
import type { FrameElement, MindflowDocument, MindflowElement } from '../../src/model/types.ts';
import { BASELINE_RATIO, measureTextWidth } from '../../src/render/shapes/shared.ts';
import {
  FRAME_NAME_FONT,
  FRAME_NAME_GAP,
  FRAME_NAME_SIZE,
  frameNameBox,
} from '../../src/render/shapes/frame.ts';
import { elementAt, frameNameAt, frameToRename } from '../../src/input/hitTest.ts';

function frame(overrides: Partial<FrameElement> = {}): FrameElement {
  return {
    ...(getDefinition('frame').create({ x: 100, y: 100, width: 400, height: 300, zIndex: 1000 }) as FrameElement),
    ...overrides,
  };
}

function sticky(x: number, y: number, zIndex: number, overrides: Partial<MindflowElement> = {}): MindflowElement {
  return {
    ...getDefinition('sticky').create({ x, y, width: 120, height: 120, zIndex }),
    ...overrides,
  } as MindflowElement;
}

/** A board holding `elements`, in paint order. */
function board(...elements: MindflowElement[]): MindflowDocument {
  const document = createDocument();
  document.elements.push(...elements);
  return document;
}

/** A point on the frame's name tab: a few units into the text, mid-height. */
const ON_TAB = { x: 110, y: 100 - FRAME_NAME_GAP - 4 };

describe('frameNameBox', () => {
  it('sits above the top-left corner, with its baseline where the name is drawn', () => {
    const box = frameNameBox(frame());

    expect(box.x).toBe(0);
    // The line box's top is BASELINE_RATIO em above the baseline, which the
    // canvas and the SVG exporter both put FRAME_NAME_GAP above the top edge.
    expect(box.y + FRAME_NAME_SIZE * BASELINE_RATIO).toBeCloseTo(-FRAME_NAME_GAP);
    expect(box.height).toBe(FRAME_NAME_SIZE);
    // Entirely outside the frame's own box, which is why hitTest cannot see it.
    expect(box.y + box.height).toBeLessThanOrEqual(0);
  });

  it('is as wide as the name measures', () => {
    const short = frameNameBox(frame({ name: 'Q3' }));
    const long = frameNameBox(frame({ name: 'Quarterly roadmap' }));

    expect(short.width).toBeCloseTo(measureTextWidth('Q3', FRAME_NAME_FONT, FRAME_NAME_SIZE));
    expect(long.width).toBeGreaterThan(short.width);
  });

  it('has no width when the name is empty, because nothing is drawn', () => {
    expect(frameNameBox(frame({ name: '' })).width).toBe(0);
  });
});

describe('frameNameAt', () => {
  it('finds the frame whose name tab is under the point', () => {
    const named = frame();
    expect(frameNameAt(board(named), ON_TAB, 1)?.id).toBe(named.id);
  });

  it('is invisible to elementAt, which still sees only the border', () => {
    // A regression guard for the decision in frame.ts: the tab is not part of
    // the hit region, so selecting, dragging and culling are unchanged.
    const high = { x: 110, y: 100 - FRAME_NAME_GAP - 9 };
    const document = board(frame());
    expect(elementAt(document, high, 1)).toBeNull();
    expect(frameNameAt(document, high, 1)).not.toBeNull();
  });

  it('covers only the text, not the whole strip above the frame', () => {
    const named = frame();
    const width = frameNameBox(named).width;
    const pastTheText = { x: 100 + width + 40, y: ON_TAB.y };
    expect(frameNameAt(board(named), pastTheText, 1)).toBeNull();
  });

  it('allows the usual screen-relative tolerance around the text', () => {
    // 4 units left of the tab: inside 8px of slop at zoom 1, outside the 2
    // units the same 8px becomes at zoom 4.
    const beside = { x: 96, y: ON_TAB.y };
    const document = board(frame());
    expect(frameNameAt(document, beside, 1)).not.toBeNull();
    expect(frameNameAt(document, beside, 4)).toBeNull();
  });

  it('ignores a frame with no name, since there is nothing drawn to point at', () => {
    expect(frameNameAt(board(frame({ name: '' })), ON_TAB, 1)).toBeNull();
  });

  it('skips locked and hidden frames, like every other pick', () => {
    expect(frameNameAt(board(frame({ locked: true })), ON_TAB, 1)).toBeNull();
    expect(frameNameAt(board(frame({ visible: false })), ON_TAB, 1)).toBeNull();
  });

  it('prefers the topmost frame when two tabs overlap', () => {
    const lower = frame({ zIndex: 1000 });
    const upper = frame({ zIndex: 2000 });
    expect(frameNameAt(board(lower, upper), ON_TAB, 1)?.id).toBe(upper.id);
  });
});

describe('frameToRename', () => {
  it('renames from the name tab', () => {
    const named = frame();
    expect(frameToRename(board(named), ON_TAB, 1)?.id).toBe(named.id);
  });

  it('renames from the border, which is the only way to name a frame that has none', () => {
    const unnamed = frame({ name: '' });
    const onBottomBorder = { x: 300, y: 400 };
    expect(frameToRename(board(unnamed), onBottomBorder, 1)?.id).toBe(unnamed.id);
  });

  it('leaves an element inside the frame to its own text editor', () => {
    const container = frame();
    const note = sticky(180, 180, 2000, { frameId: container.id });
    expect(frameToRename(board(container, note), { x: 240, y: 240 }, 1)).toBeNull();
  });

  it('does not reach through an element painted over the tab', () => {
    // Not a member, so not clipped: it really does cover the name.
    const container = frame();
    const cover = sticky(90, 60, 2000);
    expect(frameToRename(board(container, cover), ON_TAB, 1)).toBeNull();
  });

  it('reaches a tab painted over an element beneath it', () => {
    const under = sticky(90, 60, 500);
    const container = frame({ zIndex: 1000 });
    expect(frameToRename(board(under, container), ON_TAB, 1)?.id).toBe(container.id);
  });

  it('is not blocked by one of its own members, which is clipped away from the tab', () => {
    // Hit-testing ignores clipping, so this member is "under" the pointer
    // while none of it is visible there: members are clipped to the frame's
    // box and the tab is outside it.
    const container = frame();
    const member = sticky(90, 60, 2000, { frameId: container.id });
    expect(frameToRename(board(container, member), ON_TAB, 1)?.id).toBe(container.id);
  });

  it('finds nothing on empty canvas', () => {
    expect(frameToRename(board(frame()), { x: 900, y: 900 }, 1)).toBeNull();
  });
});
