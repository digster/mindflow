/**
 * The on-screen marker for a text element with nothing visible to draw.
 *
 * A text box nobody typed into paints nothing, so before the marker existed it
 * was on the board, selectable and saved, and invisible. What is pinned here is
 * when the marker appears, and that it never reaches an export or sits under
 * the open editor. How it looks is checked in a browser by the e2e suite.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { getDefinition, type RenderContext } from '../../src/model/registry.ts';
import type { TextElement } from '../../src/model/types.ts';
import { TEXT_PLACEHOLDER, blankTextMarker } from '../../src/render/shapes/text.ts';

const text = getDefinition('text');

/** A text element as the text tool creates it, with `text` swapped in. */
function textElement(content = '', overrides: Partial<TextElement> = {}): TextElement {
  const created = text.create({ x: 0, y: 0, zIndex: 1 }) as TextElement;
  return { ...created, text: content, ...overrides };
}

const ON_SCREEN = { exporting: false, editingId: null } as const;

/**
 * A context that records what is drawn instead of drawing it. Node has no
 * canvas, and what these tests need is whether anything was painted at all.
 */
function recordingContext(): { ctx: CanvasRenderingContext2D; calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = [];
  const state: Record<string | symbol, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ name: String(key), args });
      };
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function draw(el: TextElement, options: Pick<RenderContext, 'exporting' | 'editingId'>) {
  const { ctx, calls } = recordingContext();
  text.draw(el, {
    ctx,
    zoom: 1,
    document: createDocument(),
    images: new Map(),
    ...options,
  });
  return calls;
}

describe('which text elements are marked', () => {
  it('marks an empty one', () => {
    expect(blankTextMarker(textElement(''), ON_SCREEN)).not.toBeNull();
  });

  it('marks one holding only whitespace, which paints nothing either', () => {
    for (const content of ['   ', '\n\n', '\t', ' \n ', ' ', '　']) {
      expect(blankTextMarker(textElement(content), ON_SCREEN), JSON.stringify(content)).not.toBeNull();
    }
  });

  it('does not mark text a viewer can see', () => {
    for (const content of ['a', ' a ', '\n.\n', '-']) {
      expect(blankTextMarker(textElement(content), ON_SCREEN), JSON.stringify(content)).toBeNull();
    }
  });

  it('never marks anything for export', () => {
    expect(blankTextMarker(textElement(''), { exporting: true, editingId: null })).toBeNull();
  });

  it('does not mark the element the editor is open on', () => {
    // The renderer blanks an edited element's text whatever has been typed, so
    // marking it would put the placeholder under the words being typed.
    const el = textElement('');
    expect(blankTextMarker(el, { exporting: false, editingId: el.id })).toBeNull();
  });

  it('still marks every other blank element while one is being edited', () => {
    expect(blankTextMarker(textElement(''), { exporting: false, editingId: 'el_other' })).not.toBeNull();
  });
});

describe('the placeholder word', () => {
  it('appears in a box the text tool just created', () => {
    const marker = blankTextMarker(textElement(''), ON_SCREEN);
    expect(marker?.word?.lines).toEqual([TEXT_PLACEHOLDER]);
  });

  it('is laid out in the element’s own typography', () => {
    const marker = blankTextMarker(textElement('', { fontSize: 10, lineHeight: 2 }), ON_SCREEN);
    expect(marker?.word?.lineHeightPx).toBe(20);
  });

  it('is left out of a box too narrow for it, leaving the outline alone', () => {
    // An auto-width box whose text was typed and then deleted shrinks to one em.
    const cleared = text.withText!(textElement('abc'), '') as TextElement;
    expect(cleared.width).toBe(cleared.fontSize);

    const marker = blankTextMarker(cleared, ON_SCREEN);
    expect(marker).not.toBeNull();
    expect(marker?.word).toBeNull();
  });

  it('is left out of a box shorter than one line', () => {
    const el = textElement('', { width: 400, height: 10 });
    expect(blankTextMarker(el, ON_SCREEN)?.word).toBeNull();
  });

  it('survives the two-decimal rounding a saved box goes through', () => {
    const exact = blankTextMarker(textElement(''), ON_SCREEN)!.word!;
    const el = textElement('', {
      width: Math.floor(exact.width * 100) / 100,
      height: Math.floor(exact.height * 100) / 100 - 0.01,
    });
    expect(blankTextMarker(el, ON_SCREEN)?.word).not.toBeNull();
  });
});

describe('drawing the marker', () => {
  it('draws a dashed outline of the box and the placeholder on screen', () => {
    const el = textElement('');
    const calls = draw(el, ON_SCREEN);

    const outline = calls.find((call) => call.name === 'strokeRect');
    expect(outline?.args).toEqual([0, 0, el.width, el.height]);
    const dashes = calls.filter((call) => call.name === 'setLineDash').map((call) => call.args[0]);
    expect(dashes[0]).toEqual([4, 4]);

    const words = calls.filter((call) => call.name === 'fillText').map((call) => call.args[0]);
    expect(words).toEqual([TEXT_PLACEHOLDER]);
  });

  it('keeps its dashes and hairline the same on screen at any zoom', () => {
    const { ctx, calls } = recordingContext();
    text.draw(textElement(''), {
      ctx,
      zoom: 4,
      document: createDocument(),
      images: new Map(),
      ...ON_SCREEN,
    });
    expect(calls.find((call) => call.name === 'setLineDash')?.args[0]).toEqual([1, 1]);
    expect((ctx as unknown as { lineWidth: number }).lineWidth).toBe(0.25);
  });

  it('paints nothing at all when exporting', () => {
    expect(draw(textElement(''), { exporting: true, editingId: null })).toEqual([]);
  });

  it('paints nothing under the open editor', () => {
    const el = textElement('');
    expect(draw(el, { exporting: false, editingId: el.id })).toEqual([]);
  });

  it('leaves visible text to draw exactly as before', () => {
    const calls = draw(textElement('Hello'), ON_SCREEN);
    expect(calls.some((call) => call.name === 'strokeRect' || call.name === 'setLineDash')).toBe(false);
    expect(calls.filter((call) => call.name === 'fillText').map((call) => call.args[0])).toEqual(['Hello']);
  });
});
