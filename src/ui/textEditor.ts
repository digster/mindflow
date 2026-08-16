/**
 * In-place text editing.
 *
 * Canvas has no text input, so editing happens in a real `<textarea>` positioned
 * and transformed to sit exactly on top of where the canvas draws the text. The
 * element being edited is hidden from the canvas render for the duration, so the
 * user sees one piece of text, not two slightly-offset copies.
 *
 * ---------------------------------------------------------------------------
 * Keeping the DOM and the canvas in agreement
 * ---------------------------------------------------------------------------
 * This is the highest-risk code in the app: two independent text layout engines
 * must produce identical line breaks and identical glyph positions, or text
 * visibly jumps at the moment you start or stop editing.
 *
 * Three decisions make them agree:
 *
 *   1. FONT SIZE IS IN SCENE UNITS, ZOOM IS A TRANSFORM. The textarea's
 *      `font-size` is the element's own `fontSize` — not `fontSize × zoom` — and
 *      the whole textarea is then scaled with a CSS transform. The canvas does
 *      exactly the same thing (context scale, font set in scene units). Both
 *      engines therefore lay out at the same nominal size and the scaling
 *      happens afterwards, identically. Multiplying the font size by zoom
 *      instead would let sub-pixel rounding differ between the two.
 *
 *   2. IDENTICAL FONT STACK. Both sides use `FONT_STACKS`, so the same typeface
 *      resolves in both.
 *
 *   3. ROTATION ABOUT THE BOX CENTRE. `transform-origin` is set to the box
 *      centre, matching the format's rotation rule, and the element is placed by
 *      its centre rather than its corner — see {@link position}.
 *
 *   4. THE BASELINE IS CORRECTED, NOT ASSUMED. The two engines place a baseline
 *      by different rules — CSS at `half-leading + font ascent`, the canvas at a
 *      flat `BASELINE_RATIO` ems — so the editor measures the CSS baseline and
 *      shifts itself onto the canvas's. See {@link applyTextOffset}.
 *
 * See `LEARNINGS.md` for the failure modes this replaced.
 */

import type { MindflowElement, StickyElement, TextElement } from '../model/types.ts';
import type { Store } from '../store/store.ts';
import { getDefinition } from '../model/registry.ts';
import { BASELINE_RATIO, FONT_STACKS, layoutText } from '../render/shapes/shared.ts';
import { measureTextElement } from '../render/shapes/text.ts';
import { defaultLabel } from '../model/defaults.ts';
import { sceneToScreen } from '../model/geometry.ts';
import { replaceElements, updateElements } from '../store/commands.ts';
import { el } from './dom.ts';

/** Typography for the element being edited, whether it lives in `text` or `label`. */
interface EditingStyle {
  text: string;
  fontFamily: keyof typeof FONT_STACKS;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  textAlign: 'left' | 'center' | 'right';
  verticalAlign: 'top' | 'middle' | 'bottom';
  padding: number;
}

function editingStyleOf(element: MindflowElement): EditingStyle | null {
  const capabilities = getDefinition(element.type).capabilities;

  if (capabilities.text) {
    const textual = element as TextElement | StickyElement;
    return {
      text: textual.text,
      fontFamily: textual.fontFamily,
      fontSize: textual.fontSize,
      fontWeight: textual.fontWeight,
      lineHeight: textual.lineHeight,
      color: textual.color,
      textAlign: textual.textAlign,
      verticalAlign: textual.verticalAlign,
      padding: element.type === 'sticky' ? (element as StickyElement).padding : 0,
    };
  }

  if (capabilities.label) {
    const label = element.label ?? defaultLabel();
    return { ...label };
  }

  return null;
}

/**
 * Distance from the top of a CSS line box down to its first baseline, in scene
 * units, keyed by the typography that produced it.
 *
 * There is no API that reports this, so it is measured: a zero-sized
 * `inline-block` with `vertical-align: baseline` sits exactly on the baseline,
 * and its offset from the top of the line box is the number.
 *
 * Measured rather than derived from canvas `fontBoundingBox*` metrics on
 * purpose. The value has to match what *this* browser's line-box algorithm
 * actually did with the font that actually resolved — predicting it would put
 * the correction one browser quirk away from being wrong, and being wrong here
 * is the bug this exists to fix.
 *
 * The cache matters: {@link TextEditor.position} runs on every keystroke, and a
 * probe forces synchronous layout. Distinct typographies are few.
 */
const baselineCache = new Map<string, number>();

function cssBaselineOffset(style: EditingStyle): number {
  const key = `${style.fontFamily}|${style.fontSize}|${style.fontWeight}|${style.lineHeight}`;
  const cached = baselineCache.get(key);
  if (cached !== undefined) return cached;

  const probe = el('div', { 'aria-hidden': 'true' });
  probe.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;white-space:pre;';
  probe.style.fontFamily = FONT_STACKS[style.fontFamily];
  probe.style.fontSize = `${style.fontSize}px`;
  probe.style.fontWeight = String(style.fontWeight);
  probe.style.lineHeight = String(style.lineHeight);

  const marker = el('span');
  marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
  // A character alongside the marker so the line box is the one a real line of
  // text would produce, not one shaped only by the strut.
  probe.append('x', marker);

  document.body.append(probe);
  const offset = marker.getBoundingClientRect().top - probe.getBoundingClientRect().top;
  probe.remove();

  baselineCache.set(key, offset);
  return offset;
}

export class TextEditor {
  readonly element: HTMLTextAreaElement;
  private editingId: string | null = null;
  private committed = false;

  constructor(private readonly store: Store) {
    this.element = el('textarea', {
      class: 'mf-text-editor',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      'aria-label': 'Edit text',
      hidden: true,
    });

    this.element.addEventListener('input', () => this.onInput());
    this.element.addEventListener('blur', () => this.commit());
    this.element.addEventListener('keydown', (event) => this.onKeyDown(event));
    // A click inside the editor must not reach the canvas and dismiss it.
    this.element.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  get isEditing(): boolean {
    return this.editingId !== null;
  }

  /** Opens the editor on an element. */
  open(element: MindflowElement): void {
    const style = editingStyleOf(element);
    if (!style) return;

    this.editingId = element.id;
    this.committed = false;
    this.store.setEditing(element.id);

    this.element.hidden = false;
    this.element.value = style.text;
    this.applyStyle(style, element);
    this.position(element);

    // Focus after layout so the browser does not scroll the page to reach a
    // still-unpositioned element.
    requestAnimationFrame(() => {
      this.element.focus();
      this.element.select();
    });
  }

  /** Repositions the editor after a pan or zoom. */
  reposition(): void {
    if (!this.editingId) return;
    const element = this.store.document.elements.find((candidate) => candidate.id === this.editingId);
    if (element) this.position(element);
  }

  private applyStyle(style: EditingStyle, element: MindflowElement): void {
    const css = this.element.style;

    // Font size in SCENE units — the zoom is applied by the transform in
    // `position()`. See the note at the top of this file.
    css.fontFamily = FONT_STACKS[style.fontFamily];
    css.fontSize = `${style.fontSize}px`;
    css.fontWeight = String(style.fontWeight);
    css.lineHeight = String(style.lineHeight);
    css.color = style.color;
    css.textAlign = style.textAlign;
    css.padding = `${style.padding}px`;

    // A `text` element with autoWidth never wraps; everything else wraps to the
    // element's width, matching `wrapText`'s `maxWidth` argument on the canvas.
    const noWrap = element.type === 'text' && (element as TextElement).autoWidth;
    css.whiteSpace = noWrap ? 'pre' : 'pre-wrap';
    css.overflowWrap = noWrap ? 'normal' : 'break-word';
  }

  /**
   * Places the editor over the element.
   *
   * The element is positioned by its CENTRE rather than its corner. With
   * `transform-origin` at the centre, `scale` and `rotate` leave the centre
   * fixed, so translating the centre to the right screen point is sufficient and
   * exact — no trigonometry, and no drift as the angle changes.
   */
  private position(element: MindflowElement): void {
    const viewport = this.store.viewport;
    const css = this.element.style;

    const centerScene = { x: element.x + element.width / 2, y: element.y + element.height / 2 };
    const centerScreen = sceneToScreen(centerScene, viewport);

    css.width = `${element.width}px`;
    css.height = `${element.height}px`;
    css.transformOrigin = `${element.width / 2}px ${element.height / 2}px`;

    // Whatever part of the vertical offset padding cannot express is applied as
    // a translation, appended AFTER the scale so that it is read in the
    // element's own unscaled, unrotated axes — i.e. in scene units.
    const residual = this.applyTextOffset(element);
    css.transform =
      `translate(${centerScreen.x - element.width / 2}px, ${centerScreen.y - element.height / 2}px) ` +
      `rotate(${element.angle}deg) scale(${viewport.zoom})` +
      (residual === 0 ? '' : ` translateY(${residual}px)`);
  }

  /**
   * Places the text block vertically, so the DOM's first baseline lands exactly
   * on the canvas's.
   *
   * Two corrections fold into one number:
   *
   *   1. VERTICAL ALIGNMENT. A `<textarea>` has no `vertical-align`, so the
   *      space above the block has to be padding. `drawTextBlock` computes the
   *      same offset.
   *   2. BASELINE. CSS puts the first baseline at `half-leading + ascent`, which
   *      is font-specific; the canvas puts it at a flat `BASELINE_RATIO` ems.
   *      Left alone the two disagree — by 4px for the default 20px sans, a fifth
   *      of the font size — and the text visibly drops the instant editing
   *      starts and jumps back when it ends.
   *
   * Returns the part that could not be expressed as padding. Padding cannot be
   * negative, and correcting the baseline usually means moving text *up*: for
   * top-aligned text with no padding there is no room above it to give back. The
   * caller translates the whole editor by the remainder instead, which shifts
   * its focus outline by the same fifth of an em — invisible on the tight box
   * around a text element, and the padded cases never reach this path.
   */
  private applyTextOffset(element: MindflowElement): number {
    const style = editingStyleOf(element);
    if (!style) return 0;

    // Mirror the canvas: an autoWidth text element never wraps, so it must be
    // measured unwrapped here too or the line count — and with it the block
    // height this offset is derived from — comes out different.
    const noWrap = element.type === 'text' && (element as TextElement).autoWidth;
    const metrics = layoutText(this.element.value, {
      maxWidth: noWrap ? 0 : Math.max(element.width - style.padding * 2, 1),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
    });

    const available = element.height - style.padding * 2;
    const free = Math.max(available - metrics.height, 0);
    const align =
      style.verticalAlign === 'middle' ? free / 2 : style.verticalAlign === 'bottom' ? free : 0;
    const baseline = style.fontSize * BASELINE_RATIO - cssBaselineOffset(style);

    const wanted = style.padding + align + baseline;
    this.element.style.paddingTop = `${Math.max(wanted, 0)}px`;
    return Math.min(wanted, 0);
  }

  /**
   * Live-updates the element as the user types.
   *
   * Transient, so an entire typing session collapses into one undo step when it
   * is committed rather than producing one per keystroke.
   */
  private onInput(): void {
    if (!this.editingId) return;
    const element = this.store.document.elements.find((candidate) => candidate.id === this.editingId);
    if (!element) return;

    const next = this.withText(element, this.element.value);
    this.store.execute(replaceElements(this.store.document, [next], 'Edit text', true), true);
    this.position(next);
  }

  /** Returns a copy of `element` carrying `text`, resized if it grows. */
  private withText(element: MindflowElement, text: string): MindflowElement {
    const capabilities = getDefinition(element.type).capabilities;

    if (capabilities.text) {
      const next = { ...element, text } as TextElement | StickyElement;
      if (next.type === 'text') {
        // A text element's box is derived from its content.
        const { width, height } = measureTextElement(next);
        return { ...next, width: Math.max(width, 1), height: Math.max(height, 1) };
      }
      return next;
    }

    const label = element.label ?? defaultLabel();
    return { ...element, label: { ...label, text } } as MindflowElement;
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Escape cancels editing but keeps what was typed — matching the behaviour
    // of every other canvas tool, where Escape means "stop editing", not "undo".
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.commit();
      return;
    }

    // Enter inserts a newline; Cmd/Ctrl+Enter finishes. Shift+Enter also
    // finishes, for people used to single-line label fields.
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      this.commit();
      return;
    }

    // Keep every other keystroke inside the editor so canvas shortcuts do not
    // fire while typing.
    event.stopPropagation();
  }

  /** Closes the editor and writes one undoable command. */
  commit(): void {
    if (!this.editingId || this.committed) return;
    this.committed = true;

    const id = this.editingId;
    const text = this.element.value;
    this.editingId = null;
    this.element.hidden = true;
    this.element.value = '';

    const element = this.store.document.elements.find((candidate) => candidate.id === id);
    this.store.setEditing(null);
    if (!element) return;

    const next = this.withText(element, text);

    // Rewind the transient typing edits, then apply the final text as a single
    // command — one undo step for the whole session.
    this.store.execute(
      updateElements(this.store.document, [id], () => element, 'Edit text'),
      true,
    );
    this.store.execute(replaceElements(this.store.document, [next], 'Edit text'));
  }

  cancel(): void {
    this.commit();
  }
}
