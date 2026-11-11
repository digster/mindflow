/**
 * The workspace list, opened from the switcher beside the board name.
 *
 * Built like the recent-boards menu, and deliberately so: the same popover,
 * the same rows, the same "Current" tag and the same arrow-key navigation, so
 * the two lists hanging off the left of the top bar behave alike. *New
 * workspace* comes first, then every workspace in order. Clicking a row
 * switches to it.
 *
 * Each row has a "⋯" button for its own actions: Rename, Duplicate, Move up,
 * Move down and Delete. Those open as a small menu INSIDE this popover rather
 * than as a second popover, because only one popover may be open at a time
 * (`popover.ts`), and a second would close the list it belongs to. Escape
 * steps back one layer: out of a rename, then out of the row menu, then out of
 * the list.
 *
 * The module only renders. What each action does (asking before a delete,
 * ending an edit in progress before the stage changes) belongs to the app, so
 * the command palette and the keyboard cannot drift from this menu.
 */

import type { WorkspaceId } from '../model/types.ts';
import type { WorkspaceSummary } from '../store/store.ts';
import { el, icon, IS_COARSE_POINTER } from './dom.ts';
import { ICONS } from './icons.ts';
import { Popover, installListNavigation } from './popover.ts';

/** What the workspace list, the palette and the keyboard can ask the app to do. */
export interface WorkspaceCallbacks {
  /** Puts a workspace on screen. */
  onSwitch: (id: WorkspaceId) => void;
  /** Adds an empty workspace and puts it on screen. */
  onAdd: () => void;
  onRename: (id: WorkspaceId, name: string) => void;
  /** Copies a workspace into a new one after it, and puts the copy on screen. */
  onDuplicate: (id: WorkspaceId) => void;
  onMove: (id: WorkspaceId, index: number) => void;
  /** Deletes a workspace, asking first when it has content. */
  onDelete: (id: WorkspaceId) => void;
}

export interface WorkspaceMenuOptions extends WorkspaceCallbacks {
  /** The element the list hangs from: the switcher button. */
  anchor: HTMLElement;
  /** Re-read after every change made from the list, so it shows what the board holds now. */
  workspaces: () => WorkspaceSummary[];
  /** Opens with this workspace's name already being edited. */
  renaming?: WorkspaceId;
  /** Called once the list has closed, however it was dismissed. */
  onClose?: () => void;
}

/** "12 elements", "1 element" or "Empty". Exported for the unit tests. */
export function describeWorkspace(summary: Pick<WorkspaceSummary, 'elementCount'>): string {
  const count = summary.elementCount;
  if (count === 0) return 'Empty';
  return `${count} ${count === 1 ? 'element' : 'elements'}`;
}

/** The menu's message for a delete that will take content with it. Exported for the unit tests. */
export function describeDeletion(summary: Pick<WorkspaceSummary, 'name' | 'elementCount'>): string {
  const count = summary.elementCount;
  return `"${summary.name}" and its ${count} ${count === 1 ? 'element' : 'elements'} will be deleted. This cannot be undone.`;
}

/** Margin kept between the row menu and the window edge. */
const EDGE = 8;

export function showWorkspaceMenu(options: WorkspaceMenuOptions): Popover {
  const anchor = options.anchor.getBoundingClientRect();

  /** The row menu on screen, and the "⋯" button it hangs from. */
  let actions: { menu: HTMLElement; button: HTMLButtonElement; id: WorkspaceId } | null = null;
  /** The rename in progress. */
  let renaming: { id: WorkspaceId; input: HTMLInputElement } | null = null;

  const popover = new Popover({
    at: { x: anchor.left, y: anchor.bottom + 6 },
    align: 'start',
    className: 'mf-recent mf-workspaces',
    label: 'Workspaces',
    onEscape: () => {
      if (renaming) {
        cancelRename();
        return true;
      }
      if (actions) {
        closeActions(true);
        return true;
      }
      return false;
    },
    // A press outside the list closes it, and a rename in progress keeps
    // what was typed, as the board name and the frame name do.
    onClose: () => {
      if (renaming) commitRename(false);
      options.onClose?.();
    },
  });

  const newButton = el(
    'button',
    {
      class: 'mf-menu-item mf-recent-new',
      type: 'button',
      title: 'Add an empty workspace to this board',
      onclick: () => {
        popover.close();
        options.onAdd();
      },
    },
    icon(ICONS.plus, 16),
    el('span', { text: 'New workspace' }),
  ) as HTMLButtonElement;

  const list = el('div', { class: 'mf-recent-list mf-workspace-list', role: 'list' });
  popover.element.append(
    newButton,
    el('div', { class: 'mf-menu-separator', role: 'separator' }),
    el('div', { class: 'mf-recent-heading', text: 'Workspaces' }),
    list,
  );
  // A shortcut hint is only advice where there is a keyboard to take it.
  if (!IS_COARSE_POINTER) {
    popover.element.append(el('p', { class: 'mf-recent-note', text: 'Page Up and Page Down switch workspaces.' }));
  }

  // Arrow keys step through New workspace and the rows, as in every list in
  // the app; Tab still reaches each row's "⋯" button in between. The index
  // follows focus, and Enter presses whatever is focused, for the reason the
  // recent-boards menu gives.
  let items: HTMLButtonElement[] = [];
  let index = 0;
  popover.element.addEventListener('focusin', (event) => {
    const focused = items.indexOf(event.target as HTMLButtonElement);
    if (focused !== -1) index = focused;
  });
  installListNavigation({
    target: popover.element,
    items: () => items,
    getIndex: () => index,
    setIndex: (next) => items[next]?.focus(),
    activate: () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLButtonElement && popover.element.contains(focused)) focused.click();
    },
  });

  // A press anywhere in the list but the row menu closes that menu. A press on
  // the "⋯" that opened it is left to its click, which toggles it shut.
  popover.element.addEventListener(
    'pointerdown',
    (event) => {
      if (!actions) return;
      const target = event.target as Node;
      if (actions.menu.contains(target) || actions.button.contains(target)) return;
      closeActions(false);
    },
    true,
  );
  // The row menu is placed against its button, which a scroll would move.
  list.addEventListener('scroll', () => closeActions(false));

  /** Rebuilds the rows from the board, then focuses `focusId`'s row (or its "⋯"). */
  function render(focusId?: WorkspaceId, focusMore = false): void {
    closeActions(false);
    const summaries = options.workspaces();
    list.replaceChildren(...summaries.map((summary, position) => row(summary, position, summaries.length)));
    items = [newButton, ...list.querySelectorAll<HTMLButtonElement>('.mf-workspace-open')];
    if (focusId) rowPart(focusId, focusMore ? '.mf-workspace-more' : '.mf-workspace-open')?.focus();
  }

  function rowPart<T extends HTMLElement>(id: WorkspaceId, selector: string): T | null {
    const rowElement = [...list.children].find((child) => (child as HTMLElement).dataset.workspaceId === id);
    return (rowElement?.querySelector<T>(selector) as T | null) ?? null;
  }

  function row(summary: WorkspaceSummary, position: number, count: number): HTMLElement {
    const renameOnF2 = (event: Event) => {
      if ((event as KeyboardEvent).key !== 'F2') return;
      event.preventDefault();
      startRename(summary.id);
    };

    const open = el(
      'button',
      {
        class: 'mf-recent-open mf-workspace-open',
        type: 'button',
        // The workspace on screen is listed, and focusable so it can be
        // renamed from the keyboard, but choosing it only closes the list.
        'aria-current': summary.active ? 'true' : undefined,
        onclick: () => {
          popover.close();
          if (!summary.active) options.onSwitch(summary.id);
        },
        onkeydown: renameOnF2,
      },
      el(
        'span',
        { class: 'mf-recent-title' },
        el('span', { class: 'mf-recent-name', text: summary.name }),
        summary.active ? el('span', { class: 'mf-recent-tag mf-recent-tag--current', text: 'Current' }) : null,
      ),
      el('span', { class: 'mf-recent-meta', text: describeWorkspace(summary) }),
    ) as HTMLButtonElement;

    const more = el(
      'button',
      {
        class: 'mf-icon-button mf-icon-button--small mf-workspace-more',
        type: 'button',
        title: `Options for "${summary.name}"`,
        'aria-label': `Options for ${summary.name}`,
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        onclick: () => {
          if (actions?.id === summary.id) closeActions(true);
          else openActions(summary, position, count, more);
        },
        onkeydown: renameOnF2,
      },
      icon(ICONS.more, 16),
    ) as HTMLButtonElement;

    return el(
      'div',
      {
        class: `mf-recent-item mf-workspace-item${summary.active ? ' is-current' : ''}`,
        role: 'listitem',
        'data-workspace-id': summary.id,
      },
      open,
      more,
    );
  }

  /** Opens a row's own menu beside its "⋯" button. */
  function openActions(summary: WorkspaceSummary, position: number, count: number, button: HTMLButtonElement): void {
    closeActions(false);

    const item = (label: string, run: () => void, enabled: boolean, extra: { shortcut?: string; danger?: boolean } = {}) =>
      el(
        'button',
        {
          class: `mf-menu-item${extra.danger ? ' mf-menu-item--danger' : ''}`,
          type: 'button',
          role: 'menuitem',
          disabled: !enabled,
          onclick: run,
        },
        el('span', { text: label }),
        extra.shortcut ? el('span', { class: 'mf-menu-shortcut', text: extra.shortcut }) : null,
      ) as HTMLButtonElement;

    const move = (delta: number) => {
      options.onMove(summary.id, position + delta);
      render(summary.id, true);
    };

    const menu = el(
      'div',
      { class: 'mf-menu mf-workspace-actions', role: 'menu', 'aria-label': `Options for ${summary.name}` },
      item('Rename', () => startRename(summary.id), true, { shortcut: 'F2' }),
      item('Duplicate', () => {
        popover.close();
        options.onDuplicate(summary.id);
      }, true),
      item('Move up', () => move(-1), position > 0),
      item('Move down', () => move(1), position < count - 1),
      el('div', { class: 'mf-menu-separator', role: 'separator' }),
      // A board always has a workspace, so the last one cannot go. Shown
      // disabled rather than hidden, as the context menu does, so the menu
      // keeps its shape.
      item('Delete', () => {
        popover.close();
        options.onDelete(summary.id);
      }, count > 1, { danger: true }),
    );

    // Its own arrow keys, kept from the list's navigation on the popover root,
    // which would otherwise move focus back out to the rows. Enter is left to
    // the focused button's own activation.
    menu.addEventListener('keydown', (event) => {
      const enabled = [...menu.querySelectorAll<HTMLButtonElement>('.mf-menu-item:not(:disabled)')];
      const at = enabled.indexOf(document.activeElement as HTMLButtonElement);
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (step !== undefined) {
        event.preventDefault();
        enabled[(at + step + enabled.length) % enabled.length]?.focus();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        (event.key === 'Home' ? enabled[0] : enabled.at(-1))?.focus();
      }
      event.stopPropagation();
    });

    popover.element.append(menu);
    placeActions(menu, button);
    button.setAttribute('aria-expanded', 'true');
    actions = { menu, button, id: summary.id };
    menu.querySelector<HTMLButtonElement>('.mf-menu-item:not(:disabled)')?.focus();
  }

  /**
   * Beside the "⋯" button, to its right, as a submenu opens. Where the window
   * has no room there (a phone, a list near the right edge), it drops below
   * the button instead, right-aligned to it. The popover is `position: fixed`,
   * so the menu is placed relative to it.
   */
  function placeActions(menu: HTMLElement, button: HTMLElement): void {
    const host = popover.element.getBoundingClientRect();
    const at = button.getBoundingClientRect();
    const { width, height } = menu.getBoundingClientRect();

    let left = at.right + 4;
    let top = at.top;
    if (left + width > window.innerWidth - EDGE) {
      left = at.right - width;
      top = at.bottom + 4;
    }
    left = Math.max(EDGE, Math.min(left, window.innerWidth - EDGE - width));
    top = Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - height));
    menu.style.left = `${Math.round(left - host.left)}px`;
    menu.style.top = `${Math.round(top - host.top)}px`;
  }

  function closeActions(restoreFocus: boolean): void {
    if (!actions) return;
    const { menu, button } = actions;
    actions = null;
    menu.remove();
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }

  /** Turns a row's name into a text field, with the name selected. */
  function startRename(id: WorkspaceId): void {
    if (renaming) commitRename(true);
    closeActions(false);
    const summary = options.workspaces().find((candidate) => candidate.id === id);
    const open = rowPart<HTMLButtonElement>(id, '.mf-workspace-open');
    if (!summary || !open) return;

    const input = el('input', {
      class: 'mf-workspace-rename',
      type: 'text',
      value: summary.name,
      'aria-label': 'Workspace name',
      spellcheck: 'false',
      autocomplete: 'off',
      onkeydown: (event: Event) => {
        const key = (event as KeyboardEvent).key;
        if (key === 'Enter') {
          event.preventDefault();
          commitRename(true);
        }
        // Every other key is the field's: the list's arrow keys, Home and End
        // would otherwise move focus out of it. Escape never gets here; the
        // popover takes it in the capture phase and hands it to `onEscape`.
        event.stopPropagation();
      },
      onblur: () => {
        if (renaming?.input === input) commitRename(true);
      },
    }) as HTMLInputElement;

    open.hidden = true;
    open.before(input);
    renaming = { id, input };
    input.focus();
    input.select();
  }

  /** Writes the rename. `rerender` is false when the list is already gone. */
  function commitRename(rerender: boolean): void {
    const current = renaming;
    if (!current) return;
    renaming = null;
    options.onRename(current.id, current.input.value);
    if (rerender) render(current.id);
  }

  function cancelRename(): void {
    const current = renaming;
    if (!current) return;
    renaming = null;
    render(current.id);
  }

  // Focus starts on the workspace on screen: the list is opened to go
  // somewhere else, and the neighbours are one arrow key away.
  const current = options.workspaces().find((summary) => summary.active);
  render(current?.id);
  if (options.renaming) startRename(options.renaming);

  return popover;
}
