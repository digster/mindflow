/**
 * One paste per keypress.
 *
 * Cmd/Ctrl+V reaches the app by two routes, and some browsers use both:
 *
 *   1. The `keydown`, which every browser delivers.
 *   2. The native `paste` event the browser fires as the chord's default
 *      action — but only where it considers pasting possible. Chrome and
 *      Firefox fire it on a focused canvas; WebKit enables Paste outside an
 *      editable field only when a `beforepaste` listener cancels it, so Safari
 *      (and an iPad with a hardware keyboard) can deliver the keydown alone.
 *
 * Handling both produced two copies from one press. Handling only the keydown
 * would lose pasted screenshots, since image data exists solely on the native
 * event; handling only the native event would make Cmd+V dead in WebKit.
 *
 * So the native event is preferred and the keydown is a fallback that waits a
 * short grace period for it. The wait is unavoidable: at keydown time nothing
 * says whether a native event will follow, and in Chrome on macOS it arrives
 * as a separate message after the menu has handled the key equivalent, not in
 * the same task.
 *
 * If the native event is late — past the grace period, so the fallback has
 * already pasted — it is recognised as belonging to the same press and
 * dropped. That turns the grace period from a correctness bet into a latency
 * tradeoff: a short one costs at worst a screenshot pasting as the board
 * clipboard, never a second copy.
 *
 * Free of any DOM so it can be unit-tested: in Playwright's Chromium the native
 * event always follows the keydown synchronously, so the late-arrival path is
 * reachable only with fake timers.
 */

/**
 * How long a Cmd+V keydown waits for its native `paste` event before pasting on
 * its own. Long enough to cover the keydown → menu → paste round trip on a busy
 * main thread; short enough to be imperceptible in browsers that never send it.
 */
export const NATIVE_PASTE_GRACE_MS = 100;

/**
 * How long after the fallback fires a native `paste` is still attributed to the
 * same press. Nothing legitimate produces a second, separate paste inside this
 * window in a browser that needed the fallback in the first place.
 */
export const LATE_NATIVE_PASTE_MS = 1000;

export interface PasteGate {
  /** The paste chord was pressed on the board. */
  shortcut(): void;
  /**
   * A native `paste` event reached the board. Returns whether the caller should
   * handle it; `false` means the fallback has already pasted for this press, and
   * the event should be claimed and discarded.
   */
  native(): boolean;
  /** Cancels any pending fallback. */
  dispose(): void;
}

export interface PasteGateOptions {
  /** Pastes from the keyboard route, which has no clipboard payload of its own. */
  fallback: () => void;
  graceMs?: number;
  lateMs?: number;
}

export function createPasteGate({
  fallback,
  graceMs = NATIVE_PASTE_GRACE_MS,
  lateMs = LATE_NATIVE_PASTE_MS,
}: PasteGateOptions): PasteGate {
  /**
   * `armed`: a press is waiting for its native event.
   * `fired`: the fallback pasted; a native event now would be a duplicate.
   * Both carry the timer that ends the state, so leaving it always clears it.
   */
  let state: { kind: 'idle' } | { kind: 'armed' | 'fired'; timer: ReturnType<typeof setTimeout> } = {
    kind: 'idle',
  };

  const reset = (): void => {
    if (state.kind !== 'idle') clearTimeout(state.timer);
    state = { kind: 'idle' };
  };

  return {
    shortcut() {
      // A press while one is still armed supersedes it rather than queueing a
      // second paste. Only key repeat or a double tap inside the grace period
      // gets here, and in a browser that does send native events the earlier
      // press's event may still be in flight — queueing would double it.
      reset();
      state = {
        kind: 'armed',
        timer: setTimeout(() => {
          state = { kind: 'fired', timer: setTimeout(reset, lateMs) };
          fallback();
        }, graceMs),
      };
    },

    native() {
      const duplicate = state.kind === 'fired';
      reset();
      return !duplicate;
    },

    dispose: reset,
  };
}
