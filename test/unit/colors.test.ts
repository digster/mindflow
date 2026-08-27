/**
 * Colour picking.
 *
 * Two halves, both of which were bugs waiting to happen rather than obvious
 * behaviour:
 *
 *   1. `normalizeColor` is what makes a swatch able to say "I am the current
 *      colour". Compare raw strings instead and `#FFF`, `#fff` and `#ffffff`
 *      are three different colours as far as the UI is concerned.
 *
 *   2. Live colour dragging must collapse into ONE undo step. A native colour
 *      input fires `input` on every frame, and before `coalesce` was threaded
 *      through `restyle` each frame became its own history entry — so `Cmd`+`Z`
 *      after picking a colour appeared to do nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { Actions } from '../../src/app/actions.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { getDefinition } from '../../src/model/registry.ts';
import type { MindflowElement } from '../../src/model/types.ts';
import { Store } from '../../src/store/store.ts';
import {
  clearRecentColors,
  normalizeColor,
  recentColors,
  rememberColor,
} from '../../src/ui/colorPicker.ts';

// ---------------------------------------------------------------------------
// normalizeColor
// ---------------------------------------------------------------------------

describe('normalizeColor', () => {
  it('expands three- and four-digit shorthand', () => {
    expect(normalizeColor('#f00')).toBe('#ff0000');
    expect(normalizeColor('#0a3')).toBe('#00aa33');
    // The fourth digit is alpha, and expands the same way.
    expect(normalizeColor('#f008')).toBe('#ff000088');
  });

  it('accepts six- and eight-digit hex unchanged but lower-cased', () => {
    expect(normalizeColor('#1E1E1E')).toBe('#1e1e1e');
    expect(normalizeColor('#A5D8FFCC')).toBe('#a5d8ffcc');
  });

  it('does not require the leading hash', () => {
    expect(normalizeColor('1971c2')).toBe('#1971c2');
    expect(normalizeColor('f0a')).toBe('#ff00aa');
  });

  it('tolerates surrounding whitespace, as pasted values often carry it', () => {
    expect(normalizeColor('  #2f9e44 ')).toBe('#2f9e44');
  });

  it('passes the transparent keyword through', () => {
    expect(normalizeColor('transparent')).toBe('transparent');
    expect(normalizeColor('  TRANSPARENT ')).toBe('transparent');
  });

  it('rejects anything that is not a colour', () => {
    for (const input of ['', '   ', '#', '#ff', '#fffff', '#1234567', 'rebeccapurple', 'rgb(1,2,3)', '#gggggg', 'null']) {
      expect(normalizeColor(input), `expected ${JSON.stringify(input)} to be rejected`).toBeNull();
    }
  });

  it('makes equal colours compare equal, which is what marks a swatch active', () => {
    expect(normalizeColor('#FFF')).toBe(normalizeColor('#ffffff'));
  });
});

// ---------------------------------------------------------------------------
// Recent colours
// ---------------------------------------------------------------------------

/** Minimal in-memory `localStorage`. Node has none unless a flag is passed. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, String(value)),
      removeItem: (key: string) => void store.delete(key),
    },
  });
  return store;
}

function removeStorage(): void {
  Reflect.deleteProperty(globalThis, 'localStorage');
}

describe('recent colours', () => {
  beforeEach(() => {
    installStorage();
    clearRecentColors();
  });
  afterEach(removeStorage);

  it('remembers most-recent first', () => {
    rememberColor('#e03131');
    rememberColor('#1971c2');
    expect(recentColors()).toEqual(['#1971c2', '#e03131']);
  });

  it('moves a repeat to the front rather than duplicating it', () => {
    rememberColor('#e03131');
    rememberColor('#1971c2');
    rememberColor('#e03131');
    expect(recentColors()).toEqual(['#e03131', '#1971c2']);
  });

  it('de-duplicates across notations, not just exact strings', () => {
    rememberColor('#ff0000');
    rememberColor('#F00');
    expect(recentColors()).toEqual(['#ff0000']);
  });

  it('caps the list at eight', () => {
    for (const digit of '0123456789ab') rememberColor(`#${digit.repeat(6)}`);
    expect(recentColors()).toHaveLength(8);
    // The oldest fell off the end, the newest is at the front.
    expect(recentColors()[0]).toBe('#bbbbbb');
    expect(recentColors()).not.toContain('#000000');
  });

  it('never spends a slot on transparent, which every palette already offers', () => {
    rememberColor('transparent');
    expect(recentColors()).toEqual([]);
  });

  it('ignores values that are not colours', () => {
    rememberColor('not a colour');
    expect(recentColors()).toEqual([]);
  });

  it('survives corrupt stored data', () => {
    const store = installStorage();
    store.set('mindflow.recentColors', '{not json');
    expect(recentColors()).toEqual([]);

    store.set('mindflow.recentColors', '{"nope":true}');
    expect(recentColors()).toEqual([]);

    store.set('mindflow.recentColors', '["#ff0000", 42, null, "garbage"]');
    expect(recentColors()).toEqual(['#ff0000']);
  });
});

describe('recent colours without storage', () => {
  // No `localStorage` at all — a private window, or a browser set to block site
  // data. Reading it there can throw rather than return null, and a colour
  // picker must not take the application down with it.
  beforeEach(removeStorage);

  it('degrades to an empty list instead of throwing', () => {
    expect(() => rememberColor('#ff0000')).not.toThrow();
    expect(recentColors()).toEqual([]);
    expect(() => clearRecentColors()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Undo behaviour
// ---------------------------------------------------------------------------

function boardWithRect() {
  const document = createDocument();
  const rect = getDefinition('rectangle').create({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    zIndex: 1000,
  }) as MindflowElement;
  document.elements.push(rect);

  const store = new Store(document);
  store.setSelection([rect.id]);
  const actions = new Actions({ store, getViewportSize: () => ({ width: 800, height: 600 }), notify: () => {} });
  return { store, actions, id: rect.id };
}

const strokeOf = (store: Store, id: string) =>
  store.document.elements.find((element) => element.id === id)?.style.stroke;

describe('colour changes and undo', () => {
  it('collapses a live drag into a single undo step', () => {
    const { store, actions, id } = boardWithRect();
    const before = strokeOf(store, id);

    // What a drag inside the system colour picker looks like: many `input`
    // events and then a `change`, every one of which the picker routes through
    // the coalescing path.
    for (const color of ['#e03131', '#e05131', '#e07131', '#e09131']) {
      actions.restyle({ stroke: color }, 'Change stroke', true);
    }

    expect(strokeOf(store, id)).toBe('#e09131');

    store.undo();
    // One undo, all the way back to where the drag started — not to some
    // intermediate frame.
    expect(strokeOf(store, id)).toBe(before);
  });

  it('keeps two separate swatch clicks as two undo steps', () => {
    const { store, actions, id } = boardWithRect();
    const before = strokeOf(store, id);

    actions.restyle({ stroke: '#e03131' }, 'Change stroke');
    actions.restyle({ stroke: '#1971c2' }, 'Change stroke');

    store.undo();
    expect(strokeOf(store, id)).toBe('#e03131');
    store.undo();
    expect(strokeOf(store, id)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Text colour
// ---------------------------------------------------------------------------

describe('text colour', () => {
  it('writes `color` directly on a type that owns its text', () => {
    const document = createDocument();
    const sticky = getDefinition('sticky').create({ x: 0, y: 0, zIndex: 1000 }) as MindflowElement;
    document.elements.push(sticky);

    const store = new Store(document);
    store.setSelection([sticky.id]);
    const actions = new Actions({ store, getViewportSize: () => ({ width: 800, height: 600 }), notify: () => {} });

    actions.setTextProperty({ color: '#e03131' });
    const updated = store.document.elements[0] as MindflowElement & { color: string };
    expect(updated.color).toBe('#e03131');
  });

  it('writes into `label` for a labelled shape, and skips one with no label', () => {
    const document = createDocument();
    const labelled = getDefinition('rectangle').create({ x: 0, y: 0, zIndex: 1000 }) as MindflowElement;
    labelled.label = {
      text: 'hello',
      fontFamily: 'sans',
      fontSize: 20,
      fontWeight: 400,
      lineHeight: 1.25,
      color: '#1e1e1e',
      textAlign: 'center',
      verticalAlign: 'middle',
      padding: 8,
    };
    const bare = getDefinition('rectangle').create({ x: 200, y: 0, zIndex: 2000 }) as MindflowElement;
    document.elements.push(labelled, bare);

    const store = new Store(document);
    store.setSelection([labelled.id, bare.id]);
    const actions = new Actions({ store, getViewportSize: () => ({ width: 800, height: 600 }), notify: () => {} });

    actions.setTextProperty({ color: '#1971c2' });

    // The labelled one changed; the one with no label was skipped rather than
    // the whole edit being refused.
    expect(store.document.elements[0]?.label?.color).toBe('#1971c2');
    expect(store.document.elements[1]?.label).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-type palettes
// ---------------------------------------------------------------------------

describe('per-type palettes', () => {
  it('a sticky offers the paper tones it is actually created with', () => {
    const palette = getDefinition('sticky').palette?.fill;
    expect(palette).toBeDefined();

    const created = getDefinition('sticky').create({ x: 0, y: 0, zIndex: 1000 });
    // The whole point of the override: the note's own default colour is one of
    // the colours the panel offers.
    expect(palette).toContain(created.style.fill);
  });

  it('types without an override fall through to the shared defaults', () => {
    expect(getDefinition('rectangle').palette).toBeUndefined();
  });
});
