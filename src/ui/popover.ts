/**
 * Floating, non-modal overlay: the substrate for the context menu, the command
 * palette and the find bar.
 *
 * Every dialog in `dialogs.ts` is a native `<dialog>` opened with `showModal()`,
 * which supplies focus trapping, Escape and a backdrop for free. None of that is
 * right here. A context menu has to appear *at the pointer*, and a palette or
 * find bar must leave the board visible and the selection intact behind it, so
 * the dismissal behaviour a modal gives away has to be written out once:
 *
 *   - dismiss on outside `pointerdown`, on `Escape`, and when the window blurs;
 *   - restore focus to whatever had it before opening;
 *   - keep exactly one popover open at a time;
 *   - flip and clamp so the panel is never placed off-screen.
 *
 * Writing it once is the point. Three bespoke copies of dismissal logic is how
 * you end up with a menu that survives a click it should not have.
 */

import { el } from './dom.ts';

/** The popover currently on screen, if any. At most one exists. */
let current: Popover | null = null;

export interface PopoverOptions {
  /** Where to put it, in viewport (client) coordinates. */
  at: { x: number; y: number };
  /**
   * Horizontal placement relative to `at.x`. `start` puts the left edge there —
   * right for a context menu, which should open away from the pointer. `center`
   * centres on it, which is what a palette or find bar wants.
   */
  align?: 'start' | 'center';
  /** Extra class on the root, for per-consumer styling. */
  className?: string;
  /** Accessible name, since a popover is not labelled by surrounding content. */
  label: string;
  /** Called after the popover has been removed, however it was dismissed. */
  onClose?: () => void;
}

/** Margin kept between the popover and the viewport edge when clamping. */
const VIEWPORT_MARGIN = 8;

export class Popover {
  readonly element: HTMLElement;

  private readonly onClose: (() => void) | undefined;
  private readonly previouslyFocused: Element | null;
  private disposed = false;

  constructor(options: PopoverOptions) {
    // Opening a second popover closes the first. Without this, Cmd+K over an
    // open context menu would leave the menu orphaned on screen with no way to
    // dismiss it, since its outside-click listener would fire on the palette.
    current?.close();

    this.onClose = options.onClose;
    this.previouslyFocused = document.activeElement;

    this.element = el('div', {
      class: `mf-popover${options.className ? ` ${options.className}` : ''}`,
      role: 'dialog',
      'aria-label': options.label,
    });

    // Canvas gestures listen on the canvas itself, which is underneath. Without
    // this the pointerdown that lands on a menu item also starts a marquee.
    this.element.addEventListener('pointerdown', (event) => event.stopPropagation());

    document.body.append(this.element);
    this.position(options.at, options.align ?? 'start');

    window.addEventListener('pointerdown', this.onWindowPointerDown, true);
    window.addEventListener('keydown', this.onWindowKeyDown, true);
    window.addEventListener('blur', this.onWindowBlur);
    window.addEventListener('resize', this.onWindowResize);

    current = this;
  }

  /**
   * Places the panel, flipping it back inside the viewport rather than letting
   * it hang off an edge.
   *
   * Measured after mounting because the size depends on content that only exists
   * once appended — a menu's width is whatever its longest label needs.
   */
  private position(at: { x: number; y: number }, align: 'start' | 'center'): void {
    const { offsetWidth: width, offsetHeight: height } = this.element;
    const maxX = window.innerWidth - width - VIEWPORT_MARGIN;
    const maxY = window.innerHeight - height - VIEWPORT_MARGIN;

    let x = align === 'center' ? at.x - width / 2 : at.x;
    let y = at.y;

    // Near the right or bottom edge, flip to the other side of the anchor so the
    // panel does not cover the point it refers to. Clamp afterwards for the case
    // where flipping is not enough (a panel taller than the viewport).
    if (align === 'start' && x > maxX) x = at.x - width;
    if (y > maxY) y = at.y - height;

    this.element.style.left = `${Math.round(Math.max(VIEWPORT_MARGIN, Math.min(x, maxX)))}px`;
    this.element.style.top = `${Math.round(Math.max(VIEWPORT_MARGIN, Math.min(y, maxY)))}px`;
  }

  private onWindowPointerDown = (event: PointerEvent): void => {
    if (!this.element.contains(event.target as Node)) this.close();
  };

  private onWindowKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    // Stop the app's global Escape handler from also clearing the selection —
    // dismissing the popover is the whole of what Escape means right now.
    event.preventDefault();
    event.stopPropagation();
    this.close();
  };

  private onWindowBlur = (): void => this.close();

  private onWindowResize = (): void => this.close();

  close(): void {
    if (this.disposed) return;
    this.disposed = true;

    window.removeEventListener('pointerdown', this.onWindowPointerDown, true);
    window.removeEventListener('keydown', this.onWindowKeyDown, true);
    window.removeEventListener('blur', this.onWindowBlur);
    window.removeEventListener('resize', this.onWindowResize);

    this.element.remove();
    if (current === this) current = null;

    // Focus goes back where it came from, or the canvas is left unfocusable and
    // keyboard shortcuts stop working after a menu closes.
    if (this.previouslyFocused instanceof HTMLElement) this.previouslyFocused.focus();

    this.onClose?.();
  }
}

/** Closes whatever popover is open, if any. */
export function closePopover(): void {
  current?.close();
}

/** Whether a popover is currently on screen. */
export function isPopoverOpen(): boolean {
  return current !== null;
}

/**
 * Wires roving keyboard navigation over a list of items.
 *
 * Shared because all three consumers present a vertical list that responds to
 * the same four keys, and because the "wrap around at the ends" detail is easy
 * to get subtly wrong twice.
 */
export function installListNavigation(options: {
  /** The element that receives the key events — the panel, or a search input. */
  target: HTMLElement;
  /** Current items, re-read on each keypress so a filtered list stays correct. */
  items: () => HTMLElement[];
  /** Index of the highlighted item, or -1. */
  getIndex: () => number;
  setIndex: (index: number) => void;
  /** Invoked on Enter, with the highlighted index. */
  activate: (index: number) => void;
}): void {
  options.target.addEventListener('keydown', (event) => {
    const items = options.items();
    if (items.length === 0) return;

    const index = options.getIndex();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      options.setIndex((index + 1) % items.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      options.setIndex((index - 1 + items.length) % items.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      options.setIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      options.setIndex(items.length - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      options.activate(index);
    }
  });
}
