/**
 * In-place renaming of a frame, on the name tab above its top-left corner.
 *
 * A separate, much smaller editor than `TextEditor`, because a frame's name is
 * a different kind of text:
 *
 *   - It is ONE LINE. A frame's name is drawn with `fillText` and never wraps,
 *     so an `<input>` is the right control. Enter can finish the edit, and no
 *     newline can reach the document.
 *   - It has FIXED TYPOGRAPHY. A frame has no font fields. The name is always
 *     `FRAME_NAME_FONT` in `FRAME_NAME_COLOR`, which is all the editor needs.
 *   - It is SIZED BY ITS TEXT. The tab is as wide as the name, so the input is
 *     resized as it is typed into. An input narrower than its text scrolls it
 *     sideways, away from where the canvas drew it.
 *   - It is written ONCE. Nothing reads the name while it is being typed (the
 *     canvas is not drawing it, see below), so there are no transient edits to
 *     rewind. Committing writes one "Rename frame" command, or none if the name
 *     did not change.
 *
 * What it shares with `TextEditor` is the part that took debugging to get
 * right, and it follows the same rules:
 *
 *   - ONLY ONE ENGINE DRAWS THE TEXT. While the editor is open, the renderer
 *     paints the frame through {@link FrameNameEditor.displayed}, without its
 *     name. See "Never let both engines draw the same text" in LEARNINGS.md.
 *   - THE BASELINE IS MEASURED. The input is placed so that its text's
 *     baseline lands on the canvas's. See {@link inputBaselineOffset} for why
 *     the text editor's probe could not be reused.
 *   - FONT SIZE IN SCENE UNITS, ZOOM AS A TRANSFORM, so both engines lay out
 *     at the same nominal size.
 *   - IT CLOSES ITSELF on a press outside it, not only on blur, and it sets the
 *     store's `editingId`, so the controller treats a press on the canvas as
 *     "finish editing" exactly as it does for the text editor.
 */

import type { FrameElement, MindflowElement } from '../model/types.ts';
import type { Store } from '../store/store.ts';
import { isFrame } from '../model/registry.ts';
import { localToWorld, sceneToScreen } from '../model/geometry.ts';
import { updateElements } from '../store/commands.ts';
import { FONT_STACKS, measureTextWidth, whitespaceAsDrawn } from '../render/shapes/shared.ts';
import {
  FRAME_NAME_COLOR,
  FRAME_NAME_FONT,
  FRAME_NAME_GAP,
  FRAME_NAME_SIZE,
  FRAME_NAME_WEIGHT,
  frameNameBox,
} from '../render/shapes/frame.ts';
import { IS_COARSE_POINTER, el, listenForOutsidePress } from './dom.ts';

/**
 * Horizontal room around the text, in scene units, so the focus ring does not
 * touch the glyphs. The input is moved left by the same amount, which keeps
 * the text where the canvas drew it.
 */
const PADDING_X = 3;

/**
 * Extra width beyond the measured text, in scene units. The canvas measures
 * and the input lays out separately, and they can disagree by a fraction of a
 * pixel. The caret needs room too. Too little, and the input scrolls its text
 * sideways by that much.
 */
const SLACK = 2;

/** Shown when the name is empty, which is also how the tab reads on the canvas. */
const PLACEHOLDER = 'Frame name';

/**
 * Gives `input` the name's typography. Shared by the editor and its baseline
 * probe, which must lay out identically.
 *
 * `line-height: normal` and no set height, on purpose. Chromium lays an
 * input's text out at the font's normal line height whatever `line-height`
 * says, and centres that line in the box. Any other height leaves a fractional
 * centring offset, which painting then rounds to a whole pixel the
 * measurement cannot see: at `1.25` the text drew 0.375px below where it was
 * measured. With nothing to centre, the baseline is the font's ascent, a whole
 * number, and measuring it is exact.
 */
function applyTypography(input: HTMLInputElement): void {
  const css = input.style;
  css.fontFamily = FONT_STACKS.sans;
  css.fontSize = `${FRAME_NAME_SIZE}px`;
  css.fontWeight = String(FRAME_NAME_WEIGHT);
  css.lineHeight = 'normal';
  css.padding = `0 ${PADDING_X}px`;
  css.border = 'none';
  css.boxSizing = 'content-box';
}

/**
 * Distance from the top of the editor's box down to its text's baseline, in
 * scene units. Measured once, since the typography never changes.
 *
 * Measured on an `<input>`, not borrowed from the text editor's
 * `cssBaselineOffset`. That one measures a `<div>` line box, and an input
 * places its line by its own rules (see {@link applyTypography}). Borrowed,
 * it put the text a whole pixel low at 13px, and the name visibly dropped when
 * editing started.
 *
 * An inline-block input sits on its line by its text's baseline, which every
 * engine does, so a zero-sized marker beside it lands on that baseline.
 */
let measuredBaseline: number | null = null;

function inputBaselineOffset(): number {
  if (measuredBaseline !== null) return measuredBaseline;

  const probe = el('div', { 'aria-hidden': 'true' });
  probe.style.cssText =
    'position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;white-space:pre;';
  const input = el('input', { type: 'text', value: 'x', tabindex: '-1' });
  applyTypography(input);
  input.style.margin = '0';
  input.style.verticalAlign = 'baseline';
  const marker = el('span');
  marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
  probe.append(input, marker);

  document.body.append(probe);
  measuredBaseline = marker.getBoundingClientRect().top - input.getBoundingClientRect().top;
  probe.remove();
  return measuredBaseline;
}

export class FrameNameEditor {
  readonly element: HTMLInputElement;
  /** The frame being renamed, or null when the editor is closed. */
  private frameId: string | null = null;
  /**
   * Whether the user changed anything this session. Comparing names alone is
   * not enough: the input shows the name through `whitespaceAsDrawn`, so an
   * untouched name holding a tab would compare unequal and be rewritten.
   */
  private touched = false;
  /** Stops the outside-press listener; see `listenForOutsidePress`. */
  private stopDismissal: (() => void) | null = null;

  constructor(private readonly store: Store) {
    this.element = el('input', {
      class: 'mf-frame-name-editor',
      type: 'text',
      spellcheck: 'false',
      autocapitalize: 'off',
      autocomplete: 'off',
      placeholder: PLACEHOLDER,
      'aria-label': 'Frame name',
      hidden: true,
    });

    applyTypography(this.element);
    this.element.style.color = FRAME_NAME_COLOR;

    this.element.addEventListener('input', () => this.onInput());
    this.element.addEventListener('blur', () => this.commit());
    this.element.addEventListener('keydown', (event) => this.onKeyDown(event));
    // A press inside the editor places the caret. It must not reach the canvas
    // or the outside-press listener, both of which would end the edit.
    this.element.addEventListener('pointerdown', (event) => event.stopPropagation());
  }

  get isEditing(): boolean {
    return this.frameId !== null;
  }

  /** Opens the editor on `frame`'s name, with the name selected. */
  open(frame: FrameElement): void {
    if (this.frameId !== null) this.commit();

    this.frameId = frame.id;
    this.touched = false;
    this.store.setEditing(frame.id);

    this.element.hidden = false;
    // Shown as the canvas draws it. Only shown: it is written back only if the
    // user types, so opening a name is never an edit.
    this.element.value = whitespaceAsDrawn(frame.name);
    this.position(frame);
    this.stopDismissal = listenForOutsidePress(this.element, () => this.commit());

    // Synchronously, inside the gesture that opened the editor, because iOS
    // raises the soft keyboard only for a focus that happens there.
    // `preventScroll` because the canvas wrapper clips its overflow, and a
    // name near the edge of the view would otherwise scroll the whole board
    // area to reveal it.
    this.element.focus({ preventScroll: true });
    if (IS_COARSE_POINTER) {
      // As in the text editor: select-all brings up iOS's selection callout
      // over the board, and a caret at the end is what tapping into a field
      // does everywhere else on a touch device.
      const end = this.element.value.length;
      this.element.setSelectionRange(end, end);
    } else {
      this.element.select();
    }
  }

  /** Repositions the editor after a pan or zoom. */
  reposition(): void {
    const frame = this.editingFrame();
    if (frame) this.position(frame);
  }

  /**
   * `element` as the canvas should paint it: the frame being renamed without
   * its name, anything else untouched. Called for every element on every
   * frame, so the common case is one id comparison.
   */
  displayed(element: MindflowElement): MindflowElement {
    if (element.id !== this.frameId || !isFrame(element)) return element;
    return { ...element, name: '' };
  }

  /** Closes the editor, writing the name as one undoable command if it changed. */
  commit(): void {
    const id = this.frameId;
    if (id === null) return;

    const name = whitespaceAsDrawn(this.element.value);
    const touched = this.touched;
    // Cleared first: the blur below fires `commit` again, and must find
    // nothing to do.
    this.frameId = null;
    this.touched = false;
    this.stopDismissal?.();
    this.stopDismissal = null;
    // Blur before hiding, or iOS keeps the soft keyboard up for a field that
    // is no longer there.
    this.element.blur();
    this.element.hidden = true;
    this.element.value = '';
    this.store.setEditing(null);

    const frame = this.store.document.elements.find((element) => element.id === id);
    if (!frame || !isFrame(frame)) return;
    // Opening and closing again is not an edit, and neither is typing the
    // same name back. Either would otherwise mark the board dirty and push an
    // undo step that does nothing.
    if (!touched || name === frame.name) return;

    this.store.execute(
      updateElements(
        this.store.document,
        [id],
        (element) => ({ ...element, name }) as MindflowElement,
        'Rename frame',
      ),
    );
  }

  private editingFrame(): FrameElement | null {
    if (this.frameId === null) return null;
    const element = this.store.document.elements.find((candidate) => candidate.id === this.frameId);
    return element && isFrame(element) ? element : null;
  }

  private onInput(): void {
    this.touched = true;
    const frame = this.editingFrame();
    if (frame) this.position(frame);
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Keys typed here are the name, never board shortcuts.
    event.stopPropagation();
    // Enter during IME composition picks a candidate. It does not finish the name.
    if (event.isComposing) return;

    // Enter finishes. Escape does too and keeps what was typed, as it does in
    // the text editor: Escape means "stop editing", and undo takes the rename
    // back as one step.
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault();
      this.commit();
    }
  }

  /**
   * Places the input over the name tab, with its text's baseline on the
   * canvas's.
   *
   * The input's text baseline is `inputBaselineOffset` below its top, and the
   * canvas's is `FRAME_NAME_GAP` above the frame's top edge. The difference is
   * where the input's top goes.
   *
   * Positioned by its top-left corner, with `transform-origin` there too, so
   * the width can change on every keystroke without moving the text. A frame
   * is never rotated, but the angle is applied anyway so that a hand-written
   * file with one still gets an editor on its name.
   */
  private position(frame: FrameElement): void {
    const viewport = this.store.viewport;
    const css = this.element.style;

    const baseline = inputBaselineOffset();
    const box = frameNameBox(frame);
    const corner = sceneToScreen(
      localToWorld(frame, { x: box.x - PADDING_X, y: -FRAME_NAME_GAP - baseline }),
      viewport,
    );

    // The name as it is being typed, or the placeholder when it is empty.
    const text = this.element.value === '' ? PLACEHOLDER : this.element.value;
    const width = measureTextWidth(text, FRAME_NAME_FONT, FRAME_NAME_SIZE) + SLACK;
    css.width = `${width}px`;
    css.transform = `translate(${corner.x}px, ${corner.y}px) rotate(${frame.angle}deg) scale(${viewport.zoom})`;
    // Wide enough now, but the browser may already have scrolled to keep the
    // caret in view while the input was still narrower.
    this.element.scrollLeft = 0;
  }
}
