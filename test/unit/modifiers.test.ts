/**
 * The multi-select modifier, per platform.
 *
 * The e2e suite runs Chromium on Linux, where only the non-Mac mapping is real;
 * it covers the Mac one by faking `navigator.platform`. This pins the rule
 * itself, on both platforms, without a browser.
 */

import { describe, expect, it } from 'vitest';

import { isAdditiveSelect, type ModifierState } from '../../src/input/modifiers.ts';

const NONE: ModifierState = { shiftKey: false, metaKey: false, ctrlKey: false };
const SHIFT: ModifierState = { ...NONE, shiftKey: true };
const META: ModifierState = { ...NONE, metaKey: true };
const CTRL: ModifierState = { ...NONE, ctrlKey: true };

describe('isAdditiveSelect', () => {
  it('replaces the selection on a plain click, on any platform', () => {
    expect(isAdditiveSelect(NONE, true)).toBe(false);
    expect(isAdditiveSelect(NONE, false)).toBe(false);
  });

  it('adds with Shift on any platform', () => {
    expect(isAdditiveSelect(SHIFT, true)).toBe(true);
    expect(isAdditiveSelect(SHIFT, false)).toBe(true);
  });

  it('adds with Cmd on a Mac', () => {
    expect(isAdditiveSelect(META, true)).toBe(true);
  });

  it('adds with Ctrl off a Mac', () => {
    expect(isAdditiveSelect(CTRL, false)).toBe(true);
  });

  it('does not add with Ctrl on a Mac, where Ctrl-click is the secondary click', () => {
    expect(isAdditiveSelect(CTRL, true)).toBe(false);
  });

  it('does not add with the Windows or Super key off a Mac', () => {
    // The OS or the window manager usually owns that chord, and no desktop
    // convention uses it to extend a selection.
    expect(isAdditiveSelect(META, false)).toBe(false);
  });

  it('adds when Shift is combined with either modifier', () => {
    expect(isAdditiveSelect({ ...SHIFT, ctrlKey: true }, true)).toBe(true);
    expect(isAdditiveSelect({ ...SHIFT, metaKey: true }, false)).toBe(true);
  });
});
