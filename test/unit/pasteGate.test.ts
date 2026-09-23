/**
 * One paste per keypress.
 *
 * The gate exists because the order and timing of a Cmd+V keydown and its
 * native `paste` event differ by browser, and Playwright's Chromium only ever
 * produces one of those orders — the native event synchronously after the
 * keydown. Every other arrival pattern is exercised here with fake timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPasteGate, LATE_NATIVE_PASTE_MS, NATIVE_PASTE_GRACE_MS } from '../../src/input/pasteGate.ts';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  const fallback = vi.fn();
  return { fallback, gate: createPasteGate({ fallback }) };
}

describe('createPasteGate', () => {
  it('lets a native paste that follows the keydown take the press', () => {
    const { fallback, gate } = setup();

    gate.shortcut();
    expect(gate.native()).toBe(true);
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS * 10);

    expect(fallback).not.toHaveBeenCalled();
  });

  it('accepts a native paste arriving late but inside the grace period', () => {
    // Chrome on macOS: the paste comes back from the menu as a separate message.
    const { fallback, gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS - 1);
    expect(gate.native()).toBe(true);
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS);

    expect(fallback).not.toHaveBeenCalled();
  });

  it('pastes through the fallback once when no native paste arrives', () => {
    // WebKit outside an editable field: the keydown is all there is.
    const { fallback, gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS - 1);
    expect(fallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fallback).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(LATE_NATIVE_PASTE_MS * 10);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('discards a native paste that arrives after the fallback already pasted', () => {
    const { fallback, gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS);
    expect(fallback).toHaveBeenCalledTimes(1);

    expect(gate.native()).toBe(false);
  });

  it('discards only one late native paste per press', () => {
    const { gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS);

    expect(gate.native()).toBe(false);
    expect(gate.native()).toBe(true);
  });

  it('stops attributing a native paste to the press once the late window closes', () => {
    const { gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS + LATE_NATIVE_PASTE_MS);

    expect(gate.native()).toBe(true);
  });

  it('handles a native paste with no keydown before it', () => {
    // Edit > Paste from the browser menu.
    const { fallback, gate } = setup();

    expect(gate.native()).toBe(true);
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS * 10);

    expect(fallback).not.toHaveBeenCalled();
  });

  it('pastes once for a second press inside the grace period', () => {
    // Key repeat, or a very fast double tap: the later press supersedes.
    const { fallback, gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS / 2);
    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS * 10);

    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('pastes once per press for presses outside each other’s grace period', () => {
    const { fallback, gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS);
    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS);

    expect(fallback).toHaveBeenCalledTimes(2);
  });

  it('re-arms after a press whose fallback fired', () => {
    // A new press must not inherit the previous press's "already pasted" state,
    // or its own native event would be thrown away.
    const { fallback, gate } = setup();

    gate.shortcut();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS);
    gate.shortcut();

    expect(gate.native()).toBe(true);
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS * 10);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending fallback on dispose', () => {
    const { fallback, gate } = setup();

    gate.shortcut();
    gate.dispose();
    vi.advanceTimersByTime(NATIVE_PASTE_GRACE_MS * 10);

    expect(fallback).not.toHaveBeenCalled();
  });
});
