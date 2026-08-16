/**
 * Keyboard shortcuts.
 *
 * A single delegated listener on `window`, dispatching to {@link Actions}. The
 * full list is documented in `docs/05-interactions.md`; this file is its
 * implementation and the two must be kept in step.
 *
 * Two rules govern everything here:
 *
 *   1. Never steal a keystroke from a focused text field. A user renaming a
 *      board must be able to type "v" without switching to the select tool.
 *   2. Never override a browser shortcut the user relies on (Cmd+R, Cmd+T,
 *      Cmd+W, Cmd+L). Shortcuts we do claim call `preventDefault`; shortcuts we
 *      do not claim fall through untouched.
 */

import type { Actions } from '../app/actions.ts';
import type { Store, ToolId } from '../store/store.ts';

/** Tool shortcuts, matching the toolbar's left-to-right order. */
const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select',
  h: 'pan',
  r: 'rectangle',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  p: 'draw',
  t: 'text',
  n: 'sticky',
  d: 'diamond',
  e: 'eraser',
};

export interface KeyboardOptions {
  store: Store;
  actions: Actions;
  onSave: () => void;
  onSaveAs: () => void;
  onOpen: () => void;
  onNew: () => void;
  onExport: () => void;
  onSpaceChange: (held: boolean) => void;
  onCommandPalette: () => void;
  onFind: () => void;
}

/**
 * True when the event came from somewhere the user is typing.
 *
 * `isContentEditable` matters as much as the tag check — the text editor overlay
 * is a contenteditable div, and without this every keystroke in it would also
 * fire a canvas shortcut.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function installKeyboardShortcuts(options: KeyboardOptions): () => void {
  const { store, actions } = options;

  const onKeyDown = (event: KeyboardEvent): void => {
    // The platform's primary modifier: Cmd on macOS, Ctrl elsewhere.
    const primary = event.metaKey || event.ctrlKey;

    if (event.code === 'Space' && !isTypingTarget(event.target)) {
      // Space-to-pan. Also suppress the page scroll it would otherwise cause.
      if (!event.repeat) options.onSpaceChange(true);
      event.preventDefault();
      return;
    }

    if (isTypingTarget(event.target)) {
      // Escape still gets through, so a text editor can be dismissed.
      if (event.key === 'Escape') (event.target as HTMLElement).blur();
      return;
    }

    const key = event.key.toLowerCase();

    // ---- File -------------------------------------------------------------
    if (primary && key === 's') {
      event.preventDefault();
      if (event.shiftKey) options.onSaveAs();
      else options.onSave();
      return;
    }
    if (primary && key === 'o') {
      event.preventDefault();
      options.onOpen();
      return;
    }
    if (primary && event.shiftKey && key === 'e') {
      event.preventDefault();
      options.onExport();
      return;
    }
    // Kept for standalone/installed windows, where the browser does hand this
    // keydown to the page. In an ordinary tab it never arrives — Cmd/Ctrl+N is
    // reserved for "new window" — which is why the toolbar carries a New button.
    if (primary && key === 'n') {
      event.preventDefault();
      options.onNew();
      return;
    }

    // ---- History ----------------------------------------------------------
    if (primary && key === 'z') {
      event.preventDefault();
      // Cmd+Shift+Z and Cmd+Y are both idiomatic redo, depending on platform.
      if (event.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (primary && key === 'y') {
      event.preventDefault();
      store.redo();
      return;
    }

    // ---- Overlays ---------------------------------------------------------
    // Cmd+K is unclaimed by browsers. Cmd+F is not, and taking it is deliberate:
    // the browser's find searches the DOM, and canvas text is painted pixels, so
    // its dialog could never match anything on the board.
    if (primary && key === 'k') {
      event.preventDefault();
      options.onCommandPalette();
      return;
    }
    if (primary && key === 'f') {
      event.preventDefault();
      options.onFind();
      return;
    }

    // ---- Style clipboard --------------------------------------------------
    // Checked BEFORE the element clipboard below, and the element clipboard now
    // tests `!event.altKey` — otherwise Cmd+Alt+C would match the plain Cmd+C
    // branch first and copy the elements instead of their appearance.
    if (primary && event.altKey && key === 'c') {
      event.preventDefault();
      actions.copyStyle();
      return;
    }
    if (primary && event.altKey && key === 'v') {
      event.preventDefault();
      actions.pasteStyle();
      return;
    }

    // ---- Clipboard --------------------------------------------------------
    // Note: copy/cut/paste are ALSO wired to the native clipboard events in
    // `main.ts`. These handlers cover browsers that do not deliver those events
    // to a canvas, and are harmless duplicates where they do.
    if (primary && !event.altKey && key === 'c') {
      void actions.copy();
      return;
    }
    if (primary && !event.altKey && key === 'x') {
      void actions.cut();
      return;
    }
    if (primary && !event.altKey && key === 'v') {
      void actions.paste();
      return;
    }
    if (primary && key === 'd') {
      event.preventDefault();
      actions.duplicate();
      return;
    }
    if (primary && key === 'a') {
      event.preventDefault();
      actions.selectAll();
      return;
    }

    // ---- Arrangement ------------------------------------------------------
    if (primary && key === 'g') {
      event.preventDefault();
      if (event.shiftKey) actions.ungroup();
      else actions.group();
      return;
    }
    if (primary && key === ']') {
      event.preventDefault();
      actions.reorder(event.shiftKey ? 'front' : 'forward');
      return;
    }
    if (primary && key === '[') {
      event.preventDefault();
      actions.reorder(event.shiftKey ? 'back' : 'backward');
      return;
    }

    // ---- Zoom -------------------------------------------------------------
    // `=` is the unshifted key on the `+` cap, so both are accepted.
    if (primary && (key === '=' || key === '+')) {
      event.preventDefault();
      actions.zoomBy(1.2);
      return;
    }
    if (primary && key === '-') {
      event.preventDefault();
      actions.zoomBy(1 / 1.2);
      return;
    }
    if (primary && key === '0') {
      event.preventDefault();
      actions.resetZoom();
      return;
    }
    if (primary && key === '1') {
      event.preventDefault();
      actions.zoomToFit();
      return;
    }

    if (primary) return; // Any other modified key belongs to the browser.

    // ---- Unmodified keys --------------------------------------------------
    if (key === 'delete' || key === 'backspace') {
      event.preventDefault();
      actions.deleteSelection();
      return;
    }

    if (key === 'escape') {
      store.setEditing(null);
      store.clearSelection();
      store.setTool('select');
      return;
    }

    if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      const large = event.shiftKey;
      switch (event.key) {
        case 'ArrowUp':
          actions.nudge(0, -1, large);
          break;
        case 'ArrowDown':
          actions.nudge(0, 1, large);
          break;
        case 'ArrowLeft':
          actions.nudge(-1, 0, large);
          break;
        case 'ArrowRight':
          actions.nudge(1, 0, large);
          break;
      }
      return;
    }

    const tool = TOOL_KEYS[key];
    if (tool) {
      event.preventDefault();
      store.setTool(tool);
    }
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Space') options.onSpaceChange(false);
  };

  /**
   * Releasing space is not delivered if the window loses focus mid-press (for
   * instance when Cmd+Tab happens while panning). Without this the app would
   * stay stuck in pan mode until space was pressed and released again.
   */
  const onBlur = (): void => options.onSpaceChange(false);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}

/** The shortcut table, for the help dialog and for `docs/05-interactions.md`. */
export const SHORTCUT_REFERENCE: { group: string; items: [string, string][] }[] = [
  {
    group: 'Tools',
    items: [
      ['V', 'Select'],
      ['H', 'Pan'],
      ['R', 'Rectangle'],
      ['O', 'Ellipse'],
      ['L', 'Line'],
      ['A', 'Arrow'],
      ['P', 'Draw'],
      ['T', 'Text'],
      ['N', 'Sticky note'],
      ['E', 'Eraser'],
    ],
  },
  {
    group: 'Edit',
    items: [
      ['Cmd/Ctrl + Z', 'Undo'],
      ['Cmd/Ctrl + Shift + Z', 'Redo'],
      ['Cmd/Ctrl + C / X / V', 'Copy / Cut / Paste'],
      ['Cmd/Ctrl + Alt + C / V', 'Copy / paste style'],
      ['Cmd/Ctrl + D', 'Duplicate'],
      ['Cmd/Ctrl + A', 'Select all'],
      ['Delete', 'Delete selection'],
      ['Arrow keys', 'Nudge 1px (Shift: 10px)'],
    ],
  },
  {
    group: 'Arrange',
    items: [
      ['Cmd/Ctrl + G', 'Group'],
      ['Cmd/Ctrl + Shift + G', 'Ungroup'],
      ['Cmd/Ctrl + ]', 'Bring forward (Shift: to front)'],
      ['Cmd/Ctrl + [', 'Send backward (Shift: to back)'],
    ],
  },
  {
    group: 'Find and run',
    items: [
      ['Cmd/Ctrl + K', 'Command palette'],
      ['Cmd/Ctrl + F', 'Find on board'],
      ['Right-click', 'Context menu'],
    ],
  },
  {
    group: 'View',
    items: [
      ['Space + drag', 'Pan'],
      ['Cmd/Ctrl + scroll', 'Zoom'],
      ['Cmd/Ctrl + +/-', 'Zoom in / out'],
      ['Cmd/Ctrl + 0', 'Reset zoom'],
      ['Cmd/Ctrl + 1', 'Zoom to fit'],
    ],
  },
  {
    group: 'File',
    items: [
      ['Cmd/Ctrl + S', 'Save'],
      ['Cmd/Ctrl + Shift + S', 'Save as'],
      ['Cmd/Ctrl + O', 'Open'],
      ['Cmd/Ctrl + N', 'New board — if the browser allows it; use the toolbar otherwise'],
      ['Cmd/Ctrl + Shift + E', 'Export'],
    ],
  },
  {
    group: 'While dragging',
    items: [
      ['Shift', 'Constrain (axis / ratio / 45°)'],
      ['Alt/Option', 'From centre, or disable snapping'],
      ['Shift + click', 'Add to selection'],
      ['Right-click', 'Select a locked element to unlock it'],
    ],
  },
];
