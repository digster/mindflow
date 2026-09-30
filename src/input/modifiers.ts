/**
 * Modifier-key conventions for pointer gestures.
 *
 * Kept apart from the controller so the platform rules can be tested without a
 * DOM: which key means what differs between a Mac and everything else, and the
 * difference is easy to get subtly wrong.
 */

/** The modifier flags a pointer event carries, and all this module reads. */
export interface ModifierState {
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
}

/**
 * Whether a select-tool press should add to the selection rather than replace
 * it: toggling the clicked element in or out, or making a marquee add what it
 * contains.
 *
 * `Shift` on every platform, and also the platform's primary modifier: `Cmd`
 * on a Mac, `Ctrl` elsewhere. That second one is the multi-select chord
 * people bring from file managers and most other canvas tools.
 *
 * `Ctrl` on a Mac is left out on purpose. There, `Ctrl`-click is the secondary
 * click: the browser reports it as a primary-button press *and then* opens the
 * context menu. Counting it as additive would toggle the clicked element out of
 * the selection the menu was about to act on.
 *
 * `isMac` is a parameter rather than read here so the input layer never touches
 * `navigator`; the app passes `IS_MAC` in.
 */
export function isAdditiveSelect(event: ModifierState, isMac: boolean): boolean {
  return event.shiftKey || (isMac ? event.metaKey : event.ctrlKey);
}
