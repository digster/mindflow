/**
 * Tool palette and the top bar.
 *
 * Rebuilt only when the relevant slice of state changes — the store's change
 * `reason` is used to skip work, so panning at 60fps does not re-render buttons.
 */

import type { ShapeToolId, Store, ToolId } from '../store/store.ts';
import { FLAT_SHAPE_COUNT, SHAPE_TOOLS, isShapeTool } from '../store/store.ts';
import type { Actions } from '../app/actions.ts';
import { getDefinition } from '../model/registry.ts';
import { el, icon, MOD_KEY } from './dom.ts';
import { ICONS, type IconName } from './icons.ts';
import { Popover, closePopover } from './popover.ts';

interface ToolSpec {
  id: ToolId;
  icon: IconName;
  label: string;
  shortcut: string;
  /**
   * Marks the slot that also opens the shape flyout. The slot behaves like any
   * other tool button — it activates whichever shape it is currently showing —
   * and carries a second, smaller button that opens the full grid.
   */
  flyout?: boolean;
}

/** Where the flyout's last pick is remembered between sessions. */
const SHAPE_STORAGE_KEY = 'mindflow.shapeTool';

const TOOLS: ToolSpec[] = [
  { id: 'select', icon: 'select', label: 'Select', shortcut: 'V' },
  { id: 'pan', icon: 'pan', label: 'Pan', shortcut: 'H' },
  { id: 'rectangle', icon: 'rectangle', label: 'Rectangle', shortcut: 'R' },
  { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', shortcut: 'O' },
  // The shape slot. Sixteen shapes cannot each have a toolbar button without
  // turning the strip into a wall of icons, so all of them live in a flyout and
  // one slot shows the last one used. It starts on `diamond`, which is what the
  // slot replaced.
  { id: 'diamond', icon: 'diamond', label: 'Diamond', shortcut: 'D', flyout: true },
  { id: 'line', icon: 'line', label: 'Line', shortcut: 'L' },
  { id: 'arrow', icon: 'arrow', label: 'Arrow', shortcut: 'A' },
  { id: 'draw', icon: 'draw', label: 'Draw', shortcut: 'P' },
  { id: 'text', icon: 'text', label: 'Text', shortcut: 'T' },
  // B, not T: `text` already owns T, and B is the next letter in "table" that
  // no other tool has claimed.
  { id: 'table', icon: 'table', label: 'Table', shortcut: 'B' },
  { id: 'sticky', icon: 'sticky', label: 'Sticky note', shortcut: 'N' },
  { id: 'frame', icon: 'frame', label: 'Frame', shortcut: 'F' },
  { id: 'image', icon: 'image', label: 'Image', shortcut: '' },
  { id: 'eraser', icon: 'eraser', label: 'Eraser', shortcut: 'E' },
];

export interface ToolbarCallbacks {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
  onDrive: () => void;
  onHelp: () => void;
  onSettings: () => void;
  onToggleGrid: () => void;
  /** Opens the board background picker, anchored to the button that was clicked. */
  onBackground: (at: { x: number; y: number }) => void;
  onRename: (name: string) => void;
}

export class Toolbar {
  readonly toolbarElement: HTMLElement;
  readonly topBarElement: HTMLElement;

  private toolButtons = new Map<ToolId, HTMLButtonElement>();
  private nameInput!: HTMLInputElement;
  private zoomLabel!: HTMLButtonElement;
  private undoButton!: HTMLButtonElement;
  private redoButton!: HTMLButtonElement;
  private dirtyDot!: HTMLElement;
  /** The shape the flyout slot is currently showing. */
  private slotShape: ShapeToolId = 'diamond';
  private slotButton!: HTMLButtonElement;

  constructor(
    private readonly store: Store,
    private readonly actions: Actions,
    private readonly callbacks: ToolbarCallbacks,
  ) {
    this.toolbarElement = this.buildToolPalette();
    this.topBarElement = this.buildTopBar();
    this.sync();
  }

  private buildToolPalette(): HTMLElement {
    const container = el('div', {
      class: 'mf-tools',
      role: 'toolbar',
      'aria-label': 'Drawing tools',
    });

    for (const tool of TOOLS) {
      if (tool.flyout) {
        this.slotShape = rememberedShape(tool.id as ShapeToolId);
        container.append(this.buildShapeSlot());
        continue;
      }

      const title = tool.shortcut ? `${tool.label} — ${tool.shortcut}` : tool.label;
      const button = el(
        'button',
        {
          class: 'mf-tool',
          type: 'button',
          title,
          'aria-label': title,
          'aria-pressed': 'false',
          'data-tool': tool.id,
          onclick: () => this.store.setTool(tool.id),
        },
        icon(ICONS[tool.icon]),
      );
      this.toolButtons.set(tool.id, button);
      container.append(button);

      // Visual grouping: separate navigation tools from creation tools.
      if (tool.id === 'pan' || tool.id === 'sticky') {
        container.append(el('div', { class: 'mf-tool-divider' }));
      }
    }

    return container;
  }

  /**
   * The shape slot: a normal tool button showing the last shape used, plus a
   * small affordance that opens the full grid.
   *
   * Two buttons rather than one that opens on a second click, because "click to
   * activate, click again to open a menu" is a mode with no visible state — and
   * because the main button keeps the `data-tool` attribute every other tool
   * button has, so nothing else in the app (or in the e2e suite) has to know the
   * slot is special.
   */
  private buildShapeSlot(): HTMLElement {
    this.slotButton = el('button', {
      class: 'mf-tool',
      type: 'button',
      'aria-pressed': 'false',
      onclick: () => this.store.setTool(this.slotShape),
    }) as HTMLButtonElement;
    this.applySlotShape();

    const more = el(
      'button',
      {
        class: 'mf-tool-more',
        type: 'button',
        title: 'More shapes',
        'aria-label': 'More shapes',
        'aria-haspopup': 'dialog',
        onclick: (event: Event) => this.openShapeFlyout(event.currentTarget as HTMLElement),
      },
      el('span', { class: 'mf-caret', 'aria-hidden': 'true' }),
    );

    return el('div', { class: 'mf-tool-slot' }, this.slotButton, more);
  }

  /** Writes the slot's icon, label and `data-tool` for whatever shape it holds. */
  private applySlotShape(): void {
    const title = getDefinition(this.slotShape).title;
    this.slotButton.title = this.slotShape === 'diamond' ? `${title} — D` : title;
    this.slotButton.setAttribute('aria-label', this.slotButton.title);
    this.slotButton.setAttribute('data-tool', this.slotShape);
    this.slotButton.replaceChildren(icon(ICONS[this.slotShape as IconName]));
  }

  private setSlotShape(shape: ShapeToolId): void {
    if (this.slotShape === shape) return;
    this.slotShape = shape;
    this.applySlotShape();
    rememberShape(shape);
  }

  private openShapeFlyout(anchor: HTMLElement): void {
    const rect = anchor.getBoundingClientRect();
    // The palette is a vertical strip on the left at desktop widths and a
    // horizontal one along the bottom below 760px. Opening the flyout beside a
    // vertical strip and above a horizontal one keeps it off the buttons in
    // both — dropping it straight down covers half the toolbar.
    const strip = this.toolbarElement.getBoundingClientRect();
    const vertical = strip.height > strip.width;
    const popover = new Popover({
      at: vertical
        ? { x: strip.right + 8, y: rect.top - 8 }
        : { x: rect.left + rect.width / 2, y: strip.top - 8 },
      align: vertical ? 'start' : 'center',
      className: 'mf-shape-flyout',
      label: 'Shapes',
    });

    const section = (heading: string, tools: readonly ShapeToolId[]): HTMLElement =>
      el(
        'div',
        { class: 'mf-shape-section' },
        el('div', { class: 'mf-shape-heading', text: heading }),
        el(
          'div',
          { class: 'mf-shape-grid' },
          ...tools.map((tool) => {
            const title = getDefinition(tool).title;
            return el(
              'button',
              {
                class: 'mf-shape-option',
                type: 'button',
                title,
                'aria-label': title,
                'data-shape': tool,
                onclick: () => {
                  // Only shapes without a button of their own take over the
                  // slot: picking "Rectangle" here lights up the rectangle
                  // button, and two buttons showing as active at once would be
                  // a lie about which one is doing the work.
                  if (!this.toolButtons.has(tool)) this.setSlotShape(tool);
                  this.store.setTool(tool);
                  closePopover();
                },
              },
              icon(ICONS[tool as IconName]),
            );
          }),
        ),
      );

    popover.element.append(
      section('Flat', SHAPE_TOOLS.slice(0, FLAT_SHAPE_COUNT)),
      section('3D', SHAPE_TOOLS.slice(FLAT_SHAPE_COUNT)),
    );

    // Popover places its TOP at the point it is given, which cannot express
    // "sit above this". The height is only knowable once the content is in the
    // DOM, so the one case that needs it is corrected here.
    if (!vertical) {
      const height = popover.element.getBoundingClientRect().height;
      popover.element.style.top = `${Math.max(8, Math.round(strip.top - 8 - height))}px`;
    }
  }

  private buildTopBar(): HTMLElement {
    this.nameInput = el('input', {
      class: 'mf-board-name',
      type: 'text',
      'aria-label': 'Board name',
      spellcheck: 'false',
      onchange: (event: Event) => {
        const value = (event.target as HTMLInputElement).value.trim();
        this.callbacks.onRename(value === '' ? 'Untitled board' : value);
      },
      // Enter commits and returns focus to the canvas, so typing a name and
      // pressing Enter does not leave the field trapping subsequent shortcuts.
      onkeydown: (event: Event) => {
        if ((event as KeyboardEvent).key === 'Enter') (event.target as HTMLInputElement).blur();
      },
    });

    this.dirtyDot = el('span', {
      class: 'mf-dirty-dot',
      title: 'Unsaved changes',
      'aria-hidden': 'true',
    });

    this.undoButton = this.iconButton('undo', `Undo — ${MOD_KEY}Z`, () => this.store.undo());
    this.redoButton = this.iconButton('redo', `Redo — ${MOD_KEY}⇧Z`, () => this.store.redo());

    this.zoomLabel = el('button', {
      class: 'mf-zoom-label',
      type: 'button',
      title: `Reset zoom — ${MOD_KEY}0`,
      onclick: () => this.actions.resetZoom(),
    });

    return el(
      'header',
      { class: 'mf-topbar' },
      el(
        'div',
        { class: 'mf-topbar-group' },
        el('div', { class: 'mf-brand', title: 'MindFlow' }, icon(ICONS.sticky, 20)),
        this.nameInput,
        this.dirtyDot,
      ),
      el(
        'div',
        { class: 'mf-topbar-group' },
        this.undoButton,
        this.redoButton,
        el('div', { class: 'mf-tool-divider' }),
        this.iconButton('zoomOut', `Zoom out — ${MOD_KEY}−`, () => this.actions.zoomBy(1 / 1.2)),
        this.zoomLabel,
        this.iconButton('zoomIn', `Zoom in — ${MOD_KEY}+`, () => this.actions.zoomBy(1.2)),
        this.iconButton('fit', `Zoom to fit — ${MOD_KEY}1`, () => this.actions.zoomToFit()),
        this.iconButton('grid', 'Toggle grid', () => this.callbacks.onToggleGrid()),
        // Beside the grid toggle rather than in the style panel: both are
        // board-level appearance, and the panel is hidden whenever nothing is
        // selected — which is exactly when you reach for the background.
        this.backgroundButton(),
      ),
      el(
        'div',
        { class: 'mf-topbar-group' },
        // Deliberately the one file button with no shortcut in its tooltip.
        // Cmd/Ctrl+N is reserved by every major browser for "new window", so the
        // keydown usually never reaches the page and `preventDefault` never gets
        // a chance to run. The handler stays for the contexts where it does fire
        // (installed/standalone windows), but advertising a keystroke that most
        // users will watch open a browser window instead would be a lie.
        this.iconButton('newBoard', 'New board', this.callbacks.onNew),
        this.iconButton('open', `Open — ${MOD_KEY}O`, this.callbacks.onOpen),
        this.iconButton('save', `Save — ${MOD_KEY}S`, this.callbacks.onSave),
        this.iconButton('download', `Export — ${MOD_KEY}⇧E`, this.callbacks.onExport),
        this.iconButton('drive', 'Google Drive', this.callbacks.onDrive),
        el('div', { class: 'mf-tool-divider' }),
        this.iconButton('help', 'Keyboard shortcuts', this.callbacks.onHelp),
        this.iconButton('settings', 'Settings', this.callbacks.onSettings),
      ),
    );
  }

  /**
   * The background picker's trigger.
   *
   * Anchored by its own rect rather than by the pointer, so the popover lands in
   * the same place whether the button was clicked or activated from the
   * keyboard.
   */
  private backgroundButton(): HTMLButtonElement {
    const button = el(
      'button',
      {
        class: 'mf-icon-button',
        type: 'button',
        title: 'Board background',
        'aria-label': 'Board background',
        'aria-haspopup': 'dialog',
        'data-action': 'background',
        onclick: () => {
          const rect = button.getBoundingClientRect();
          this.callbacks.onBackground({ x: rect.left, y: rect.bottom + 6 });
        },
      },
      icon(ICONS.palette),
    ) as HTMLButtonElement;
    return button;
  }

  private iconButton(name: IconName, title: string, onClick: () => void): HTMLButtonElement {
    return el(
      'button',
      { class: 'mf-icon-button', type: 'button', title, 'aria-label': title, onclick: onClick },
      icon(ICONS[name]),
    );
  }

  /** Refreshes everything that depends on state. Cheap; safe to call often. */
  sync(): void {
    const state = this.store.getState();

    // A shape reached from the command palette rather than the flyout still has
    // to appear somewhere, so the slot adopts any active shape that has no
    // button of its own.
    const tool = state.activeTool;
    if (isShapeTool(tool) && !this.toolButtons.has(tool)) this.setSlotShape(tool);
    const slotActive = tool === this.slotShape && !this.toolButtons.has(tool);
    this.slotButton.classList.toggle('is-active', slotActive);
    this.slotButton.setAttribute('aria-pressed', String(slotActive));

    for (const [id, button] of this.toolButtons) {
      const active = state.activeTool === id;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    }

    // Only write the input when it is not focused, or the user's cursor position
    // would jump while they are typing.
    if (document.activeElement !== this.nameInput) {
      this.nameInput.value = state.document.meta.name;
    }

    this.dirtyDot.classList.toggle('is-visible', state.dirty);
    this.undoButton.disabled = !this.store.history.canUndo();
    this.redoButton.disabled = !this.store.history.canRedo();
    this.zoomLabel.textContent = `${Math.round(state.viewport.zoom * 100)}%`;
  }
}

/**
 * The shape the flyout slot should start on.
 *
 * Remembered per browser, like the colour picker's recent swatches, and for the
 * same reason: someone building a diagram out of cylinders should not have to
 * reopen the flyout after every reload. Storage failing is not worth a word to
 * the user — the slot simply starts on its default.
 */
function rememberedShape(fallback: ShapeToolId): ShapeToolId {
  try {
    const stored = localStorage.getItem(SHAPE_STORAGE_KEY);
    return stored !== null && isShapeTool(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

function rememberShape(shape: ShapeToolId): void {
  try {
    localStorage.setItem(SHAPE_STORAGE_KEY, shape);
  } catch {
    /* Full, or blocked. See above. */
  }
}
