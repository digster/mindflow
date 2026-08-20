/**
 * Tool palette and the top bar.
 *
 * Rebuilt only when the relevant slice of state changes — the store's change
 * `reason` is used to skip work, so panning at 60fps does not re-render buttons.
 */

import type { Store, ToolId } from '../store/store.ts';
import type { Actions } from '../app/actions.ts';
import { el, icon, MOD_KEY } from './dom.ts';
import { ICONS, type IconName } from './icons.ts';

interface ToolSpec {
  id: ToolId;
  icon: IconName;
  label: string;
  shortcut: string;
}

const TOOLS: ToolSpec[] = [
  { id: 'select', icon: 'select', label: 'Select', shortcut: 'V' },
  { id: 'pan', icon: 'pan', label: 'Pan', shortcut: 'H' },
  { id: 'rectangle', icon: 'rectangle', label: 'Rectangle', shortcut: 'R' },
  { id: 'ellipse', icon: 'ellipse', label: 'Ellipse', shortcut: 'O' },
  { id: 'diamond', icon: 'diamond', label: 'Diamond', shortcut: 'D' },
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
