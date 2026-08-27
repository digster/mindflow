/**
 * Contextual style panel.
 *
 * Appears when something is selected and shows only the controls that apply to
 * that selection — a freehand stroke has no fill, an arrow has arrowheads, a
 * sticky note has typography. The set of controls is derived from the registry's
 * capability flags rather than from a hard-coded per-type table, so a new
 * element type gets a correct panel for free.
 */

import type { MindflowElement, TableElement } from '../model/types.ts';
import { ARROWHEADS, CURVE_STYLES, FILL_STYLES, FONT_FAMILIES, STROKE_STYLES } from '../model/types.ts';
import type { Store } from '../store/store.ts';
import type { Actions } from '../app/actions.ts';
import { capabilitiesOf, getDefinition } from '../model/registry.ts';
import { DEFAULT_TEXT_COLOR, PALETTE } from '../model/defaults.ts';
import { updateElements } from '../store/commands.ts';
import { insertColumn, insertRow, removeColumn, removeRow } from '../render/shapes/table.ts';
import { clear, el, icon } from './dom.ts';
import { colorTrigger, swatch } from './colorPicker.ts';
import { ICONS } from './icons.ts';

const STROKE_WIDTHS: [string, number][] = [
  ['Thin', 1],
  ['Medium', 2],
  ['Bold', 4],
  ['Heavy', 8],
];

/** Sketchiness presets. The format allows 0..2; these are the useful points. */
const ROUGHNESS_LEVELS: [string, number][] = [
  ['Clean', 0],
  ['Light', 0.6],
  ['Sketchy', 1.4],
];

const FONT_SIZES: [string, number][] = [
  ['S', 14],
  ['M', 20],
  ['L', 28],
  ['XL', 40],
];

/**
 * The ink colour an element is currently using.
 *
 * Two storage shapes, one question: a type with `capabilities.text` owns `color`
 * directly, while a labelled shape keeps it on `label`. `Actions.setTextProperty`
 * already writes to whichever applies, so this is only the read half of the same
 * split, and it stays out of the registry because it is a display concern — the
 * panel needs a value to mark a swatch active, nothing more.
 */
function textColorOf(element: MindflowElement): string {
  if ('color' in element && typeof element.color === 'string') return element.color;
  return element.label?.color ?? DEFAULT_TEXT_COLOR;
}

export class StylePanel {
  readonly element: HTMLElement;

  constructor(
    private readonly store: Store,
    private readonly actions: Actions,
  ) {
    this.element = el('aside', {
      class: 'mf-style-panel',
      'aria-label': 'Style options',
      hidden: true,
    });
    this.sync();
  }

  sync(): void {
    const selected = this.store.selectedElements();

    if (selected.length === 0) {
      this.element.hidden = true;
      clear(this.element);
      return;
    }

    this.element.hidden = false;
    clear(this.element);

    // A locked element accepts exactly one edit: being unlocked. Collapsing the
    // panel to that single action is both the honest UI — every other control
    // would silently do nothing — and the affordance that makes unlocking
    // findable at all, since a locked element has no handles to hint at it.
    if (selected.some((element) => element.locked)) {
      this.element.append(this.lockedNotice(selected.length));
      return;
    }

    // Union of capabilities: a control appears if ANY selected element can use
    // it, and the update simply skips elements that cannot.
    const capabilities = selected.map((element) => capabilitiesOf(element));
    const anyText = capabilities.some((capability) => capability.text || capability.label);
    const anyLinear = selected.some((element) => element.type === 'line' || element.type === 'arrow');
    const anyFillable = selected.some(
      (element) => element.type !== 'draw' && element.type !== 'line' && element.type !== 'arrow' && element.type !== 'text',
    );

    const first = selected[0] as MindflowElement;

    // A frame's name is edited here rather than on the canvas: the name is drawn
    // outside the frame's box, so it cannot be part of the hit region without
    // putting hitTest at odds with the AABB pre-rejection every caller relies on.
    const frames = selected.filter((element) => element.type === 'frame');
    if (frames.length === 1 && selected.length === 1) {
      this.element.append(this.nameRow(frames[0] as MindflowElement & { name: string }));
    }

    // Structure controls for a single table, alongside the frame name row above
    // and for the same reason: these are edits with nowhere else to live. The
    // per-cell versions (insert *here*, delete *this* row) are on the context
    // menu, where the click itself says which cell is meant.
    if (selected.length === 1 && first.type === 'table') {
      for (const row of this.tableRows(first as TableElement)) this.element.append(row);
    }

    // Palettes come from the type's definition where it declares one — a sticky
    // note offers its own paper tones — falling back to the shared defaults.
    // `first` decides for a mixed selection, matching how every other control in
    // this panel already reports state.
    const definition = getDefinition(first.type);

    this.element.append(
      this.swatchRow(
        'Stroke',
        definition.palette?.stroke ?? PALETTE.stroke,
        first.style.stroke,
        (color, live) => this.actions.restyle({ stroke: color }, 'Change stroke', live),
      ),
    );

    if (anyFillable) {
      this.element.append(
        this.swatchRow(
          'Fill',
          definition.palette?.fill ?? PALETTE.fill,
          first.style.fill,
          (color, live) =>
            this.actions.restyle(
              // Choosing "transparent" must also switch fillStyle off, or the
              // shape would render an invisible-but-present fill and still swallow
              // clicks through its interior.
              color === 'transparent'
                ? { fill: color, fillStyle: 'none' }
                : { fill: color, fillStyle: 'solid' },
              'Change fill',
              live,
            ),
        ),
      );
    }

    this.element.append(
      this.buttonRow(
        'Stroke width',
        STROKE_WIDTHS.map(([label, value]) => ({
          label,
          active: first.style.strokeWidth === value,
          onSelect: () => this.actions.restyle({ strokeWidth: value }, 'Change stroke width'),
        })),
      ),
      this.buttonRow(
        'Stroke style',
        STROKE_STYLES.map((style) => ({
          label: style[0]?.toUpperCase() + style.slice(1),
          active: first.style.strokeStyle === style,
          onSelect: () => this.actions.restyle({ strokeStyle: style }, 'Change stroke style'),
        })),
      ),
    );

    // Only offered when something in the selection actually has a hand-drawn
    // form — a sticky or an image would show a control that does nothing.
    if (selected.some((element) => Boolean(getDefinition(element.type).roughOutline))) {
      this.element.append(
        this.buttonRow(
          'Sketch',
          ROUGHNESS_LEVELS.map(([label, value]) => ({
            label,
            active: first.style.roughness === value,
            onSelect: () => this.actions.restyle({ roughness: value }, 'Change sketchiness'),
          })),
        ),
      );
    }

    if (anyFillable) {
      this.element.append(
        this.buttonRow(
          'Fill style',
          FILL_STYLES.map((style) => ({
            label: style === 'none' ? 'None' : 'Solid',
            active: first.style.fillStyle === style,
            onSelect: () => this.actions.restyle({ fillStyle: style }, 'Change fill style'),
          })),
        ),
      );
    }

    if (anyLinear) {
      const linear = selected.find(
        (element) => element.type === 'line' || element.type === 'arrow',
      ) as Extract<MindflowElement, { type: 'line' | 'arrow' }>;

      this.element.append(
        this.buttonRow(
          'Line shape',
          CURVE_STYLES.map((curve) => ({
            label: curve[0]?.toUpperCase() + curve.slice(1),
            active: linear.curve === curve,
            onSelect: () => this.updateLinear({ curve }),
          })),
        ),
        this.buttonRow(
          'End arrow',
          ARROWHEADS.map((head) => ({
            label: head === 'none' ? '—' : head[0]?.toUpperCase() + head.slice(1),
            active: linear.endArrowhead === head,
            onSelect: () => this.updateLinear({ endArrowhead: head }),
          })),
        ),
      );
    }

    if (anyText) {
      this.element.append(
        // Ink, not outline. `color` has been in the format since 1.0.0 on text,
        // sticky and table elements and on every `label`, but until now there
        // was no way to set it — a board could carry coloured text that
        // MindFlow rendered correctly and could not produce.
        this.swatchRow('Text colour', PALETTE.text, textColorOf(first), (color, live) =>
          this.actions.setTextProperty({ color }, live),
        ),
        this.buttonRow(
          'Font',
          FONT_FAMILIES.map((family) => ({
            label: family[0]?.toUpperCase() + family.slice(1),
            active: false,
            onSelect: () => this.actions.setTextProperty({ fontFamily: family }),
          })),
        ),
        this.buttonRow(
          'Font size',
          FONT_SIZES.map(([label, value]) => ({
            label,
            active: false,
            onSelect: () => this.actions.setTextProperty({ fontSize: value }),
          })),
        ),
        this.buttonRow(
          // "Text align" rather than "Align": the row below aligns the elements
          // themselves, and two rows both labelled "Align" would be a coin toss.
          'Text align',
          (['left', 'center', 'right'] as const).map((align) => ({
            label: align[0]?.toUpperCase() + align.slice(1),
            active: false,
            onSelect: () => this.actions.setTextProperty({ textAlign: align }),
          })),
        ),
      );
    }

    this.element.append(this.opacityRow(first.opacity));
    const alignRow = this.alignRow(selected);
    if (alignRow) this.element.append(alignRow);
    this.element.append(this.arrangeRow(selected));
  }

  /**
   * Table structure: the header toggle, and append/remove at the far edge.
   *
   * Deliberately the *last* row and column rather than a selected one — the
   * style panel has no notion of which cell you are looking at, and guessing
   * would be worse than being predictable.
   */
  private tableRows(table: TableElement): HTMLElement[] {
    const edit = (label: string, transform: (el: TableElement) => TableElement) => () => {
      this.store.execute(
        updateElements(
          this.store.document,
          [table.id],
          (element) => transform(element as TableElement) as MindflowElement,
          label,
        ),
      );
    };

    return [
      this.buttonRow('Table', [
        {
          label: 'Header row',
          active: table.headerRow,
          onSelect: edit('Toggle header row', (el) => ({ ...el, headerRow: !el.headerRow })),
        },
      ]),
      // Offered only with a header to fill. `headerFill` is specified as
      // "ignored entirely when headerRow is false", so showing it otherwise
      // would be a control that visibly does nothing.
      ...(table.headerRow
        ? [
            this.swatchRow('Header fill', PALETTE.header, table.headerFill, (color) => {
              this.store.execute(
                updateElements(
                  this.store.document,
                  [table.id],
                  (element) => ({ ...element, headerFill: color }) as MindflowElement,
                  'Change header fill',
                ),
              );
            }),
          ]
        : []),
      this.buttonRow('Rows', [
        { label: 'Add', active: false, onSelect: edit('Add row', (el) => insertRow(el, el.rows.length)) },
        {
          label: 'Remove',
          active: false,
          onSelect: edit('Remove row', (el) => removeRow(el, el.rows.length - 1)),
        },
      ]),
      this.buttonRow('Columns', [
        {
          label: 'Add',
          active: false,
          onSelect: edit('Add column', (el) => insertColumn(el, el.columns.length)),
        },
        {
          label: 'Remove',
          active: false,
          onSelect: edit('Remove column', (el) => removeColumn(el, el.columns.length - 1)),
        },
      ]),
    ];
  }

  /** Text field for a frame's name. */
  private nameRow(frame: MindflowElement & { name: string }): HTMLElement {
    const input = el('input', {
      class: 'mf-input',
      type: 'text',
      value: frame.name,
      spellcheck: 'false',
      'aria-label': 'Frame name',
      // On change, not on input: one undo step per rename rather than one per
      // keystroke, matching how the board name behaves.
      onchange: (event: Event) => {
        const name = (event.target as HTMLInputElement).value;
        this.store.execute(
          updateElements(
            this.store.document,
            [frame.id],
            (element) => ({ ...element, name }) as MindflowElement,
            'Rename frame',
          ),
        );
      },
      onkeydown: (event: Event) => {
        if ((event as KeyboardEvent).key === 'Enter') (event.target as HTMLInputElement).blur();
      },
    });
    return this.section('Name', input);
  }

  private updateLinear(patch: Record<string, unknown>): void {
    const ids = this.store
      .selectedElements()
      .filter((element) => element.type === 'line' || element.type === 'arrow')
      .map((element) => element.id);
    if (ids.length === 0) return;
    this.store.execute(
      updateElements(this.store.document, ids, (element) => ({ ...element, ...patch }) as MindflowElement, 'Change connector'),
    );
  }

  /** The whole panel when the selection is locked: an explanation and a way out. */
  private lockedNotice(count: number): HTMLElement {
    return this.section(
      'Locked',
      el('p', {
        class: 'mf-style-note',
        text:
          count > 1
            ? 'These elements are locked. Unlock them to move or restyle them.'
            : 'This element is locked. Unlock it to move or restyle it.',
      }),
      el(
        'button',
        {
          class: 'mf-button',
          type: 'button',
          onclick: () => this.actions.unlock(),
        },
        icon(ICONS.lock, 15),
        el('span', { text: 'Unlock' }),
      ),
    );
  }

  private section(label: string, ...children: HTMLElement[]): HTMLElement {
    return el(
      'div',
      { class: 'mf-style-section' },
      el('span', { class: 'mf-style-label', text: label }),
      el('div', { class: 'mf-style-controls' }, ...children),
    );
  }

  /**
   * A row of palette swatches plus the trigger for the full picker.
   *
   * `onSelect` receives a `live` flag that is true only while the user is
   * dragging inside the system colour picker. Callers pass it straight through
   * to the command layer as `coalesce`, so a drag collapses into one undo step
   * instead of one per frame. Clicking a swatch is never live.
   */
  private swatchRow(
    label: string,
    colors: readonly string[],
    current: string,
    onSelect: (color: string, live: boolean) => void,
  ): HTMLElement {
    const swatches = colors.map((color) =>
      swatch(color, { label, current, onSelect: (value) => onSelect(value, false) }),
    );

    const trigger = colorTrigger({
      label,
      current,
      palette: colors,
      onPreview: (color) => onSelect(color, true),
      onCommit: (color) => onSelect(color, false),
    });

    return this.section(label, ...swatches, trigger);
  }

  private buttonRow(
    label: string,
    options: { label: string; active: boolean; onSelect: () => void }[],
  ): HTMLElement {
    return this.section(
      label,
      ...options.map((option) =>
        el('button', {
          class: `mf-chip${option.active ? ' is-active' : ''}`,
          type: 'button',
          text: option.label,
          onclick: option.onSelect,
        }),
      ),
    );
  }

  private opacityRow(current: number): HTMLElement {
    return this.section(
      'Opacity',
      el('input', {
        class: 'mf-range',
        type: 'range',
        min: '0',
        max: '100',
        step: '5',
        value: String(Math.round(current * 100)),
        'aria-label': 'Opacity',
        oninput: (event: Event) =>
          this.actions.setOpacity(Number((event.target as HTMLInputElement).value) / 100),
      }),
    );
  }

  /**
   * Align and distribute, or `null` when the selection is too small to have a
   * meaningful arrangement.
   *
   * The unit count — not the element count — is what gates these, matching
   * `Actions.alignmentUnits`: a group moves as one box, so selecting a pair of
   * grouped shapes offers nothing to align them against.
   */
  private alignRow(selected: readonly MindflowElement[]): HTMLElement | null {
    const units = new Set(selected.map((element) => element.groupId ?? element.id));
    if (units.size < 2) return null;

    const button = (name: keyof typeof ICONS, title: string, onClick: () => void, disabled = false) =>
      el(
        'button',
        {
          class: 'mf-icon-button mf-icon-button--small',
          type: 'button',
          title,
          'aria-label': title,
          disabled,
          onclick: onClick,
        },
        icon(ICONS[name], 16),
      );

    // Distribution needs an interior to space out; with two units the extremes
    // are the whole selection and there is nothing between them to move.
    const noInterior = units.size < 3;

    return this.section(
      'Align',
      button('alignLeft', 'Align left', () => this.actions.align('left')),
      button('alignCenterX', 'Align horizontal centres', () => this.actions.align('centerX')),
      button('alignRight', 'Align right', () => this.actions.align('right')),
      button('alignTop', 'Align top', () => this.actions.align('top')),
      button('alignCenterY', 'Align vertical centres', () => this.actions.align('centerY')),
      button('alignBottom', 'Align bottom', () => this.actions.align('bottom')),
      button(
        'distributeH',
        'Distribute horizontally',
        () => this.actions.distribute('horizontal'),
        noInterior,
      ),
      button(
        'distributeV',
        'Distribute vertically',
        () => this.actions.distribute('vertical'),
        noInterior,
      ),
    );
  }

  private arrangeRow(selected: readonly MindflowElement[]): HTMLElement {
    const grouped = selected.some((element) => element.groupId !== null);
    const locked = selected.every((element) => element.locked);

    const button = (name: keyof typeof ICONS, title: string, onClick: () => void, disabled = false) =>
      el(
        'button',
        {
          class: 'mf-icon-button mf-icon-button--small',
          type: 'button',
          title,
          'aria-label': title,
          disabled,
          onclick: onClick,
        },
        icon(ICONS[name], 16),
      );

    return this.section(
      'Arrange',
      button('front', 'Bring to front', () => this.actions.reorder('front')),
      button('back', 'Send to back', () => this.actions.reorder('back')),
      button(
        'group',
        grouped ? 'Ungroup' : 'Group',
        () => (grouped ? this.actions.ungroup() : this.actions.group()),
        !grouped && selected.length < 2,
      ),
      button('lock', locked ? 'Unlock' : 'Lock', () => this.actions.toggleLock()),
      button('trash', 'Delete', () => this.actions.deleteSelection()),
    );
  }
}
