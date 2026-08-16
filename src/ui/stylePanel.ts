/**
 * Contextual style panel.
 *
 * Appears when something is selected and shows only the controls that apply to
 * that selection — a freehand stroke has no fill, an arrow has arrowheads, a
 * sticky note has typography. The set of controls is derived from the registry's
 * capability flags rather than from a hard-coded per-type table, so a new
 * element type gets a correct panel for free.
 */

import type { MindflowElement } from '../model/types.ts';
import { ARROWHEADS, CURVE_STYLES, FILL_STYLES, FONT_FAMILIES, STROKE_STYLES } from '../model/types.ts';
import type { Store } from '../store/store.ts';
import type { Actions } from '../app/actions.ts';
import { capabilitiesOf } from '../model/registry.ts';
import { PALETTE } from '../model/defaults.ts';
import { updateElements } from '../store/commands.ts';
import { clear, el, icon } from './dom.ts';
import { ICONS } from './icons.ts';

const STROKE_WIDTHS: [string, number][] = [
  ['Thin', 1],
  ['Medium', 2],
  ['Bold', 4],
  ['Heavy', 8],
];

const FONT_SIZES: [string, number][] = [
  ['S', 14],
  ['M', 20],
  ['L', 28],
  ['XL', 40],
];

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

    this.element.append(
      this.swatchRow('Stroke', PALETTE.stroke, first.style.stroke, (color) =>
        this.actions.restyle({ stroke: color }, 'Change stroke'),
      ),
    );

    if (anyFillable) {
      this.element.append(
        this.swatchRow('Fill', PALETTE.fill, first.style.fill, (color) =>
          this.actions.restyle(
            // Choosing "transparent" must also switch fillStyle off, or the
            // shape would render an invisible-but-present fill and still swallow
            // clicks through its interior.
            color === 'transparent'
              ? { fill: color, fillStyle: 'none' }
              : { fill: color, fillStyle: 'solid' },
            'Change fill',
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
          'Align',
          (['left', 'center', 'right'] as const).map((align) => ({
            label: align[0]?.toUpperCase() + align.slice(1),
            active: false,
            onSelect: () => this.actions.setTextProperty({ textAlign: align }),
          })),
        ),
      );
    }

    this.element.append(this.opacityRow(first.opacity));
    this.element.append(this.arrangeRow(selected));
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

  private swatchRow(
    label: string,
    colors: readonly string[],
    current: string,
    onSelect: (color: string) => void,
  ): HTMLElement {
    const swatches = colors.map((color) =>
      el('button', {
        class: `mf-swatch${color === current ? ' is-active' : ''}${color === 'transparent' ? ' is-transparent' : ''}`,
        type: 'button',
        title: color,
        'aria-label': `${label} ${color}`,
        style: color === 'transparent' ? '' : `background:${color}`,
        onclick: () => onSelect(color),
      }),
    );

    // A native color input as the escape hatch beyond the curated palette.
    const custom = el('input', {
      class: 'mf-color-input',
      type: 'color',
      title: 'Custom colour',
      'aria-label': `Custom ${label.toLowerCase()} colour`,
      value: current.startsWith('#') ? current.slice(0, 7) : '#000000',
      oninput: (event: Event) => onSelect((event.target as HTMLInputElement).value),
    });

    return this.section(label, ...swatches, custom);
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
