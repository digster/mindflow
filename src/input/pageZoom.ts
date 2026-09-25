/**
 * Keeps a pinch from zooming the page on a touch device, so the only thing a
 * pinch can zoom is the board.
 *
 * Page zoom is blocked in three layers, one per way a browser decides it. This
 * module is the third:
 *
 *   1. `user-scalable=no, maximum-scale=1` in the viewport meta. Honoured by
 *      mobile Chromium and Firefox. Desktop browsers ignore the viewport meta
 *      entirely. iOS Safari has ignored it for a user's pinch since iOS 10. It
 *      still applies the limits to the zoom Safari starts by itself when a
 *      field with small text takes focus.
 *   2. `touch-action: pan-x pan-y` on the page (`styles/app.css`). This stops
 *      pinch and double-tap zoom in every engine that implements `touch-action`,
 *      including a touchscreen laptop, which the meta cannot reach. The canvas
 *      narrows it to `none` and does its own pan and pinch.
 *   3. Cancelling WebKit's `gesture*` events, here. iOS Safari reports a pinch
 *      as these events, and cancelling them is the one thing it honours
 *      everywhere on the page. It is the backstop for where layer 2 is thinner
 *      in WebKit: WebKit resolves `touch-action` only up to the nearest
 *      scrolling container, so a pinch inside a scrolling panel would otherwise
 *      zoom the page.
 *
 * The board's own pinch is untouched, because it is built on pointer events
 * (`input/pinch.ts`). Cancelling a gesture event stops the browser's zoom. It
 * does not stop the pointer events underneath it.
 *
 * Only on a touch device. macOS Safari sends the same events for a trackpad
 * pinch, and blocking the page zoom there would be a desktop behaviour change
 * nobody asked for. An iPad reports touch points even when it is driven with
 * a trackpad, so it is still covered.
 *
 * Takes its target and the device test as arguments, so it runs in the unit
 * suite. Chromium has no gesture events, so Playwright cannot reach this path.
 */

/** WebKit's non-standard pinch events. Cancelling the first stops the zoom. */
export const PAGE_ZOOM_GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

/**
 * Cancels page zoom gestures on `target` (normally `document`) when
 * `touchDevice` is true, and does nothing otherwise. Returns a function that
 * removes the listeners.
 */
export function blockPageZoom(target: EventTarget, touchDevice: boolean): () => void {
  if (!touchDevice) return () => {};

  const cancel = (event: Event): void => event.preventDefault();
  // `passive: false` makes the intent explicit. WebKit makes document-level
  // touch listeners passive by default, and a passive listener cannot cancel.
  for (const type of PAGE_ZOOM_GESTURE_EVENTS) {
    target.addEventListener(type, cancel, { passive: false });
  }
  return () => {
    for (const type of PAGE_ZOOM_GESTURE_EVENTS) target.removeEventListener(type, cancel);
  };
}
