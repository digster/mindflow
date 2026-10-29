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
 *
 * ## When the page zooms anyway
 *
 * The layers are best-effort on iPad Safari, and something there still zooms
 * the page now and then. Reading WebKit's source shows two ways through: it
 * looks `touch-action` up once per finger, at touchdown, and a finger whose
 * lookup misses counts as `auto`. And once its own scroll view has started a
 * pan, touch events can no longer be cancelled, so neither can these gesture
 * events. Which one fires on a real iPad is not known yet.
 *
 * What follows is bad. At 4x the visible area is a small piece of the canvas,
 * the top bar and tool palette are off screen, and every pinch the user tries
 * lands on the canvas and zooms the board. Nothing on screen can undo it. A page
 * cannot set its own zoom either: WebKit keeps a zoom the user made, clamped
 * only to `max(maximum-scale, 5)`, until the next page load.
 *
 * So a zoomed page lets a pinch zoom it again. {@link watchPageZoom} reports
 * when the page is zoomed. The app then puts {@link PAGE_ZOOMED_CLASS} on
 * `<html>`, whose rules in `app.css` add `pinch-zoom` to every `touch-action`.
 * It stops cancelling the gesture events through the predicate passed to
 * {@link blockPageZoom}, has the controller leave a two-finger touch to the
 * browser, and shows `ui/pageZoomHint.ts`. Back at 1x, all of it is undone,
 * and a pinch zooms the board again.
 */

/** WebKit's non-standard pinch events. Cancelling the first stops the zoom. */
export const PAGE_ZOOM_GESTURE_EVENTS = ['gesturestart', 'gesturechange', 'gestureend'] as const;

/** Put on `<html>` while the page is zoomed. `app.css` keys the way out off it. */
export const PAGE_ZOOMED_CLASS = 'mf-page-zoomed';

/**
 * The page scale above which the page counts as zoomed.
 *
 * Just clear of float noise and no more. A browser reports exactly 1 at rest,
 * and a pinch out past the minimum clamps to exactly 1. A pinch that stops
 * short can leave 1.007, and a looser margin called that "back to normal". The
 * guards came back with a strip of the chrome still cut off and no way left to
 * zoom out. Below this, the strip is under a pixel.
 */
export const PAGE_ZOOMED_ABOVE = 1.001;

/**
 * Whether a page scale (`visualViewport.scale`) means the page is zoomed IN.
 * A scale below 1 is a browser shrinking a page to fit, which hides nothing.
 */
export function isPageZoomed(scale: number): boolean {
  return scale > PAGE_ZOOMED_ABOVE;
}

/**
 * Cancels page zoom gestures on `target` (normally `document`) when
 * `touchDevice` is true, and does nothing otherwise. Returns a function that
 * removes the listeners.
 *
 * A gesture that starts while `pageIsZoomed()` is true goes through, from
 * start to end, so a page that is already zoomed can be pinched back out. The
 * call is made once, at `gesturestart`. A pinch that brings the page back to
 * 1x then keeps working until the fingers lift, instead of freezing halfway.
 */
export function blockPageZoom(
  target: EventTarget,
  touchDevice: boolean,
  pageIsZoomed: () => boolean = () => false,
): () => void {
  if (!touchDevice) return () => {};

  let letThrough = false;
  const onGesture = (event: Event): void => {
    if (event.type === 'gesturestart') letThrough = pageIsZoomed();
    if (!letThrough) event.preventDefault();
  };
  // `passive: false` makes the intent explicit. WebKit makes document-level
  // touch listeners passive by default, and a passive listener cannot cancel.
  for (const type of PAGE_ZOOM_GESTURE_EVENTS) {
    target.addEventListener(type, onGesture, { passive: false });
  }
  return () => {
    for (const type of PAGE_ZOOM_GESTURE_EVENTS) target.removeEventListener(type, onGesture);
  };
}

/** What {@link watchPageZoom} needs from `window.visualViewport`. */
export interface PageScaleSource extends EventTarget {
  readonly scale: number;
}

/**
 * Calls `onChange` with whether the page is zoomed: once straight away, then
 * each time that changes. Returns a function that stops watching.
 *
 * `resize` is the event to watch. The visual viewport fires it for a change of
 * scale as well as of size, and a pan, which fires `scroll`, cannot change the
 * answer.
 */
export function watchPageZoom(
  viewport: PageScaleSource,
  onChange: (zoomed: boolean) => void,
): () => void {
  let zoomed = isPageZoomed(viewport.scale);
  onChange(zoomed);

  const update = (): void => {
    const next = isPageZoomed(viewport.scale);
    if (next === zoomed) return;
    zoomed = next;
    onChange(zoomed);
  };
  viewport.addEventListener('resize', update);
  return () => viewport.removeEventListener('resize', update);
}
