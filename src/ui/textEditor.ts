/**
 * In-place text editing.
 *
 * Canvas has no text input, so editing happens in a real `<textarea>` positioned
 * and transformed to sit exactly on top of where the canvas draws the text. The
 * element being edited is hidden from the canvas render for the duration, so the
 * user sees one piece of text, not two slightly-offset copies.
 *
 * What is being edited is an element *and optionally a region within it* — a
 * table cell. Everything below works from a local-frame box rather than the
 * element's own box, and an element with no regions simply supplies its whole
 * box, so the two cases are one code path rather than two.
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
import type { TextRegion } from '../model/registry.ts';
import { getDefinition } from '../model/registry.ts';
import { BASELINE_RATIO, FONT_STACKS, layoutText } from '../render/shapes/shared.ts';
import { measureTextElement } from '../render/shapes/text.ts';
import { defaultLabel } from '../model/defaults.ts';
import { localToWorld, sceneToScreen } from '../model/geometry.ts';
import { replaceElements } from '../store/commands.ts';
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

/**
 * The element's own text inset, or 0 for types that have none.
 *
 * Read structurally rather than by type: a sticky note and a table both carry
 * `padding`, a text element does not, and `ui/` may not branch on `type`.
 */
function paddingOf(element: MindflowElement): number {
  const value = (element as unknown as { padding?: unknown }).padding;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The region being edited, when the element has addressable regions. */
function regionOf(element: MindflowElement, regionKey: string | null): TextRegion | null {
  const definition = getDefinition(element.type);
  if (!regionKey || !definition.textRegions) return null;
  return definition.textRegions(element as never).find((region) => region.key === regionKey) ?? null;
}

function editingStyleOf(element: MindflowElement, regionKey: string | null): EditingStyle | null {
  const capabilities = getDefinition(element.type).capabilities;

  if (capabilities.text) {
    const textual = element as TextElement | StickyElement;
    const region = regionOf(element, regionKey);
    return {
      // A region's text wins when there is one; `?? ''` covers a type whose text
      // lives ONLY in regions, so it has no `text` field to fall back to.
      text: region ? region.text : (textual.text ?? ''),
      fontFamily: textual.fontFamily,
      fontSize: textual.fontSize,
      // A table's header cells are drawn heavier than the rest of the table, and
      // the overlay has to match or the text visibly thins as editing starts.
      fontWeight: region?.fontWeight ?? textual.fontWeight,
      lineHeight: textual.lineHeight,
      color: textual.color,
      textAlign: textual.textAlign,
      verticalAlign: textual.verticalAlign,
      padding: paddingOf(element),
    };
  }

  if (capabilities.label) {
    const label = element.label ?? defaultLabel();
    return { ...label };
  }

  return null;
}

/** The local-frame box the editor covers: a region's, or the whole element's. */
function editBox(
  element: MindflowElement,
  regionKey: string | null,
): { x: number; y: number; width: number; height: number } {
  const region = regionOf(element, regionKey);
  if (region) return region.box;
  return { x: 0, y: 0, width: element.width, height: element.height };
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
  /** Which text region of that element is open, for types that have regions. */
  private regionKey: string | null = null;
  /**
   * The element exactly as it was when the editor opened.
   *
   * Held because `commit` has to rewind the transient per-keystroke edits before
   * writing the session as one command, and by then the document no longer holds
   * the pre-edit state to rewind *to*. Reading it back at commit time — which is
   * what this used to do — yields the already-typed element, making both the
   * rewind and the resulting undo step no-ops. See LEARNINGS.md.
   */
  private original: MindflowElement | null = null;
  private committed = false;
  /**
   * Whether any keystroke actually reached the document this session.
   *
   * `commit` cannot infer this by comparing text: `onInput` has already written
   * every keystroke into the document transiently, so by commit time the live
   * element always matches what is in the textarea.
   */
  private touched = false;

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

  /**
   * Opens the editor on an element, optionally on one region within it.
   *
   * An element with regions always ends up on one: an unknown or absent key
   * falls back to the first, so a caller that knows nothing about cells can
   * still open a table and land somewhere sensible.
   */
  open(element: MindflowElement, regionKey?: string | null): void {
    const definition = getDefinition(element.type);
    const regions = definition.textRegions?.(element as never) ?? [];
    this.regionKey =
      regions.length === 0
        ? null
        : (regions.find((region) => region.key === regionKey)?.key ?? regions[0]?.key ?? null);

    const style = editingStyleOf(element, this.regionKey);
    if (!style) return;

    this.editingId = element.id;
    this.original = element;
    this.committed = false;
    this.touched = false;
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
    const box = editBox(element, this.regionKey);

    // The box's centre, taken through the element's transform rather than by
    // adding x/y. For a whole-element box the two agree; for a table cell they
    // do not, because rotation is about the ELEMENT's centre and not the cell's.
    const centerWorld = localToWorld(element, {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
    });
    const centerScreen = sceneToScreen(centerWorld, viewport);

    css.width = `${box.width}px`;
    css.height = `${box.height}px`;
    css.transformOrigin = `${box.width / 2}px ${box.height / 2}px`;

    // Whatever part of the vertical offset padding cannot express is applied as
    // a translation, appended AFTER the scale so that it is read in the
    // element's own unscaled, unrotated axes — i.e. in scene units.
    const residual = this.applyTextOffset(element, box);
    css.transform =
      `translate(${centerScreen.x - box.width / 2}px, ${centerScreen.y - box.height / 2}px) ` +
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
  private applyTextOffset(
    element: MindflowElement,
    box: { width: number; height: number },
  ): number {
    const style = editingStyleOf(element, this.regionKey);
    if (!style) return 0;

    // Mirror the canvas: an autoWidth text element never wraps, so it must be
    // measured unwrapped here too or the line count — and with it the block
    // height this offset is derived from — comes out different.
    const noWrap = element.type === 'text' && (element as TextElement).autoWidth;
    const metrics = layoutText(this.element.value, {
      maxWidth: noWrap ? 0 : Math.max(box.width - style.padding * 2, 1),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
    });

    const available = box.height - style.padding * 2;
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

    const next = this.withText(element, this.element.value, this.regionKey);
    this.store.execute(replaceElements(this.store.document, [next], 'Edit text', true), true);
    this.touched = true;
    this.position(next);
  }

  /** Returns a copy of `element` carrying `text`, resized if it grows. */
  private withText(
    element: MindflowElement,
    text: string,
    regionKey: string | null,
  ): MindflowElement {
    const definition = getDefinition(element.type);
    const capabilities = definition.capabilities;

    // A region write never changes the element's geometry: a table cell wraps to
    // the column it is in rather than growing to fit, the way a text element does.
    if (regionKey !== null && definition.withRegionText) {
      return definition.withRegionText(element as never, regionKey, text) as MindflowElement;
    }

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

    // Tab walks the element's regions — cell to cell across a table row, then on
    // to the next row. It stops at the ends rather than wrapping: wrapping from
    // the last cell back to the first silently discards the "I am done here"
    // reading of a final Tab, and there is no visual cue that it happened.
    if (event.key === 'Tab' && this.regionKey !== null) {
      event.preventDefault();
      event.stopPropagation();
      this.moveRegion(event.shiftKey ? -1 : 1);
      return;
    }

    // Keep every other keystroke inside the editor so canvas shortcuts do not
    // fire while typing.
    event.stopPropagation();
  }

  /**
   * Commits the current region and opens the one `delta` places away.
   *
   * Committing first is deliberate: each cell becomes its own undo step, which
   * is what a person tabbing through a table expects — undo should walk back
   * cell by cell, not erase the whole pass in one go.
   */
  private moveRegion(delta: number): void {
    const id = this.editingId;
    const key = this.regionKey;
    if (!id || !key) return;

    const element = this.store.document.elements.find((candidate) => candidate.id === id);
    if (!element) return;

    const regions = getDefinition(element.type).textRegions?.(element as never) ?? [];
    const index = regions.findIndex((region) => region.key === key);
    const target = index === -1 ? undefined : regions[index + delta];
    if (!target) return;

    this.commit();

    // Re-read: the commit above replaced the element with a new object.
    const committed = this.store.document.elements.find((candidate) => candidate.id === id);
    if (committed) this.open(committed, target.key);
  }

  /** Closes the editor and writes one undoable command. */
  commit(): void {
    if (!this.editingId || this.committed) return;
    this.committed = true;

    const id = this.editingId;
    const text = this.element.value;
    const regionKey = this.regionKey;
    const original = this.original;
    this.editingId = null;
    this.regionKey = null;
    this.original = null;
    this.element.hidden = true;
    this.element.value = '';

    const element = this.store.document.elements.find((candidate) => candidate.id === id);
    this.store.setEditing(null);
    if (!element) return;

    // Opening an editor and closing it again is not an edit. The write-back
    // below always builds a fresh object, and `Store.execute` can only detect a
    // no-op by reference — so an untouched element still marks the board dirty
    // and pushes a phantom "Edit text" onto the undo stack. That surfaces as a
    // "Discard unsaved changes?" prompt after merely double-clicking a shape.
    if (!this.touched) return;

    const next = this.withText(element, text, regionKey);

    // Rewind the transient typing edits, then apply the final text as a single
    // command — one undo step for the whole session.
    //
    // The rewind MUST target the element captured at `open`. `onInput` has
    // already written every keystroke into the live document, so rewinding to
    // whatever the document currently holds restores the typed state to itself:
    // the command's `before` and `after` then carry identical content and undo
    // silently does nothing.
    if (original) {
      this.store.execute(replaceElements(this.store.document, [original], 'Edit text'), true);
    }
    this.store.execute(replaceElements(this.store.document, [next], 'Edit text'));
  }

  cancel(): void {
    this.commit();
  }
}
