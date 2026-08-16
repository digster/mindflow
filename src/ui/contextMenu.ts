/**
 * Right-click menu.
 *
 * `InteractionController.onContextMenu` has always suppressed the browser's own
 * menu, and its comment claimed "the app supplies its own menu" — which was not
 * true until this file existed. Everything here delegates to `Actions`, so a
 * command behaves identically however it was invoked.
 *
 * The menu deliberately shows disabled items rather than hiding them. A menu
 * whose contents change shape with the selection is one you have to read every
 * time; a stable menu with greyed-out entries can be used from muscle memory,
 * and it also teaches what is possible.
 */

import type { MindflowElement, Point } from '../model/types.ts';
import type { Store } from '../store/store.ts';
import type { Actions } from '../app/actions.ts';
import { el, MOD_KEY } from './dom.ts';
import { Popover, installListNavigation } from './popover.ts';

interface MenuItem {
  label: string;
  shortcut?: string;
  run: () => void;
  enabled: boolean;
  danger?: boolean;
}

type MenuEntry = MenuItem | 'separator';

export interface ContextMenuOptions {
  store: Store;
  actions: Actions;
  /** Where the right-click happened, in viewport coordinates. */
  screen: Point;
  /** The same point in scene coordinates, for "Paste here". */
  scene: Point;
  /** The element under the pointer, if any. */
  hit: MindflowElement | null;
}

export function showContextMenu(options: ContextMenuOptions): void {
  const { store, actions, hit } = options;
  const selected = store.selectedElements();
  const hasSelection = selected.length > 0;
  const locked = hasSelection && selected.every((element) => element.locked);
  const grouped = selected.some((element) => element.groupId !== null);

  const entries = locked
    ? // A locked element accepts exactly one edit. Offering the rest would be
      // dishonest — every other entry would silently do nothing — and this menu
      // is the only route back from locking in the first place.
      [{ label: 'Unlock', run: () => actions.unlock(), enabled: true }]
    : buildEntries();

  function buildEntries(): MenuEntry[] {
    if (!hasSelection) {
      return [
        { label: 'Paste here', shortcut: `${MOD_KEY}V`, run: () => void actions.paste(options.scene), enabled: true },
        'separator',
        { label: 'Select all', shortcut: `${MOD_KEY}A`, run: () => actions.selectAll(), enabled: true },
        { label: 'Zoom to fit', shortcut: `${MOD_KEY}1`, run: () => actions.zoomToFit(), enabled: true },
      ];
    }

    return [
      { label: 'Cut', shortcut: `${MOD_KEY}X`, run: () => void actions.cut(), enabled: true },
      { label: 'Copy', shortcut: `${MOD_KEY}C`, run: () => void actions.copy(), enabled: true },
      { label: 'Duplicate', shortcut: `${MOD_KEY}D`, run: () => actions.duplicate(), enabled: true },
      'separator',
      { label: 'Copy style', shortcut: `${MOD_KEY}⌥C`, run: () => actions.copyStyle(), enabled: true },
      { label: 'Paste style', shortcut: `${MOD_KEY}⌥V`, run: () => actions.pasteStyle(), enabled: actions.hasCopiedStyle },
      'separator',
      { label: 'Bring to front', shortcut: `${MOD_KEY}⇧]`, run: () => actions.reorder('front'), enabled: true },
      { label: 'Send to back', shortcut: `${MOD_KEY}⇧[`, run: () => actions.reorder('back'), enabled: true },
      'separator',
      {
        label: grouped ? 'Ungroup' : 'Group',
        shortcut: grouped ? `${MOD_KEY}⇧G` : `${MOD_KEY}G`,
        run: () => (grouped ? actions.ungroup() : actions.group()),
        enabled: grouped || selected.length > 1,
      },
      { label: 'Lock', run: () => actions.toggleLock(), enabled: true },
      'separator',
      { label: 'Delete', shortcut: 'Delete', run: () => actions.deleteSelection(), enabled: true, danger: true },
    ];
  }

  const popover = new Popover({
    at: options.screen,
    className: 'mf-menu',
    label: hit ? 'Element actions' : 'Board actions',
  });

  const buttons: HTMLButtonElement[] = [];
  let activeIndex = -1;

  for (const entry of entries) {
    if (entry === 'separator') {
      popover.element.append(el('div', { class: 'mf-menu-separator', role: 'separator' }));
      continue;
    }

    const button = el(
      'button',
      {
        class: `mf-menu-item${entry.danger ? ' mf-menu-item--danger' : ''}`,
        type: 'button',
        disabled: !entry.enabled,
        onclick: () => {
          popover.close();
          entry.run();
        },
      },
      el('span', { text: entry.label }),
      entry.shortcut ? el('span', { class: 'mf-menu-shortcut', text: entry.shortcut }) : null,
    );

    if (entry.enabled) buttons.push(button);
    popover.element.append(button);
  }

  const setIndex = (index: number) => {
    buttons[activeIndex]?.classList.remove('is-active');
    activeIndex = index;
    const button = buttons[index];
    button?.classList.add('is-active');
    button?.focus();
  };

  installListNavigation({
    target: popover.element,
    items: () => buttons,
    getIndex: () => activeIndex,
    setIndex,
    activate: (index) => {
      const button = buttons[index];
      if (button) button.click();
    },
  });

  // Focus the panel itself, not the first item: arrowing down should reach the
  // first entry, and pre-selecting it would make a stray Enter destructive.
  popover.element.tabIndex = -1;
  popover.element.focus();
}
