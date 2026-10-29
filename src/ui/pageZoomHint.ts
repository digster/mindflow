/**
 * The note that tells the user how to get out of a zoomed page.
 *
 * It appears only while the page is zoomed, which on a touch device means a
 * pinch got past the guards in `input/pageZoom.ts`. By then the top bar and
 * the tool palette are off screen and the user sees nothing but board, with no
 * sign of what happened. While the page is zoomed, a pinch zooms the page again
 * rather than the board, and this note says so.
 *
 * Placing it is the hard part. `position: fixed` pins an element to the LAYOUT
 * viewport, most of which is off screen on a zoomed page. The note is pinned to
 * the layout viewport's corner and then moved onto the visible part, the visual
 * viewport, and shrunk by the page's scale so it shows at its normal size. That
 * is redone on every pan and zoom while it shows.
 *
 * It never takes a touch (`pointer-events: none` in `app.css`). It sits over
 * the board, and the board is where the fingers that get the user out will
 * land.
 */

import { ICONS } from './icons.ts';
import { el, icon } from './dom.ts';

/** The part of `window.visualViewport` the placement depends on. */
export interface VisualViewportBox {
  /** Left edge of the visible area, in CSS pixels from the layout viewport's. */
  readonly offsetLeft: number;
  /** Top edge of the visible area, likewise. */
  readonly offsetTop: number;
  /** Width of the visible area in CSS pixels. Shrinks as the page zooms in. */
  readonly width: number;
  /** Screen pixels per CSS pixel. */
  readonly scale: number;
}

/**
 * Where the note goes for a given visual viewport, as styles for its full-width
 * strip. The strip is pinned at the layout viewport's top-left corner, so this
 * is all relative to that.
 *
 * The strip is `width × scale` CSS pixels wide and is then scaled by
 * `1 / scale`, which makes it exactly as wide as the visible area. Inside it,
 * the pill is laid out at its normal size and centred by CSS. `translate` comes
 * first in the transform, so the offsets are applied in unscaled CSS pixels.
 */
export function hintPlacement(view: VisualViewportBox): { width: string; transform: string } {
  return {
    width: `${view.width * view.scale}px`,
    transform: `translate(${view.offsetLeft}px, ${view.offsetTop}px) scale(${1 / view.scale})`,
  };
}

export class PageZoomHint {
  readonly element: HTMLDivElement;
  private readonly message: HTMLSpanElement;
  private shown = false;

  constructor(private readonly viewport: VisualViewport) {
    this.message = el('span');
    this.element = el(
      'div',
      // A status rather than an alert. It is advice, and a screen reader should
      // read it out without breaking into what it is already saying.
      { class: 'mf-page-zoom-hint', role: 'status', hidden: true },
      el('div', { class: 'mf-page-zoom-hint-pill' }, icon(ICONS.zoomOut, 16), this.message),
    );
  }

  show(): void {
    if (this.shown) return;
    this.shown = true;
    this.place();
    this.element.hidden = false;
    // Set after the element shows. A live region announces a change to its
    // content, and text that was already there when it appeared may be missed.
    this.message.textContent = 'The page is zoomed in. Pinch to zoom out.';
    this.viewport.addEventListener('resize', this.place);
    this.viewport.addEventListener('scroll', this.place);
  }

  hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.element.hidden = true;
    this.message.textContent = '';
    this.viewport.removeEventListener('resize', this.place);
    this.viewport.removeEventListener('scroll', this.place);
  }

  private place = (): void => {
    const { width, transform } = hintPlacement(this.viewport);
    this.element.style.width = width;
    this.element.style.transform = transform;
  };
}
