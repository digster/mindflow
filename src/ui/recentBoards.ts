/**
 * The recent-boards menu, opened from the logo at the left of the top bar.
 *
 * Lists every board that still has a copy in this browser (see `io/autosave.ts`)
 * and reopens one on click. Deliberately a popover rather than a modal: it is a
 * quick switcher, anchored to the thing that opened it, and should cost one
 * click to dismiss — the same weight as the shape flyout next door.
 *
 * The module only renders. Opening, removing and every confirmation belong to
 * the app, which owns the board lifecycle, so this menu cannot drift from what
 * New board or Open do.
 */

import type { RecentBoard } from '../io/autosave.ts';
import { el, icon } from './dom.ts';
import { ICONS } from './icons.ts';
import { Popover, installListNavigation } from './popover.ts';

export interface RecentBoardsMenuOptions {
  /** The element the menu hangs from — the logo button. */
  anchor: HTMLElement;
  /** Newest first. `null` means the browser refused local storage. */
  boards: readonly RecentBoard[] | null;
  /** The board on screen. Listed, but not reopenable or removable. */
  currentId: string;
  onOpen: (board: RecentBoard) => void;
  onRemove: (board: RecentBoard) => void;
}

export function showRecentBoardsMenu(options: RecentBoardsMenuOptions): Popover {
  const rect = options.anchor.getBoundingClientRect();
  const popover = new Popover({
    at: { x: rect.left, y: rect.bottom + 6 },
    align: 'start',
    className: 'mf-recent',
    label: 'Recent boards',
  });

  popover.element.append(el('div', { class: 'mf-recent-heading', text: 'Recent boards' }));

  const { boards } = options;
  if (boards === null || boards.length === 0) {
    popover.element.append(
      el('p', {
        class: 'mf-recent-empty',
        text:
          boards === null
            ? 'Recent boards are unavailable because this browser is refusing local storage.'
            : 'No recent boards yet. Boards you work on in this browser will appear here.',
      }),
    );
    return popover;
  }

  const openButtons: HTMLButtonElement[] = [];
  const list = el('div', { class: 'mf-recent-list', role: 'list' });

  for (const board of boards) {
    const current = board.boardId === options.currentId;
    const openButton = el(
      'button',
      {
        class: 'mf-recent-open',
        type: 'button',
        title: `Last changed ${new Date(board.savedAt).toLocaleString()}`,
        // The board on screen is listed so the menu reads as a complete picture
        // of what is stored, but "reopening" it would only reload what is
        // already there, so it is inert.
        disabled: current,
        'aria-current': current ? 'true' : undefined,
        onclick: () => {
          popover.close();
          options.onOpen(board);
        },
      },
      el(
        'span',
        { class: 'mf-recent-title' },
        el('span', { class: 'mf-recent-name', text: board.name }),
        current
          ? el('span', { class: 'mf-recent-tag mf-recent-tag--current', text: 'Open' })
          : null,
        board.unsaved
          ? el('span', {
              class: 'mf-recent-tag mf-recent-tag--unsaved',
              text: 'Unsaved',
              title: 'Has changes that were never saved to a file or to Drive',
            })
          : null,
      ),
      el('span', { class: 'mf-recent-meta', text: describeRecentBoard(board) }),
    ) as HTMLButtonElement;

    if (!current) openButtons.push(openButton);

    list.append(
      el(
        'div',
        {
          class: `mf-recent-item${current ? ' is-current' : ''}`,
          role: 'listitem',
          'data-board-id': board.boardId,
        },
        openButton,
        current
          ? null
          : el(
              'button',
              {
                class: 'mf-icon-button mf-icon-button--small mf-recent-remove',
                type: 'button',
                title: `Remove "${board.name}" from this browser`,
                'aria-label': `Remove ${board.name} from this browser`,
                onclick: () => options.onRemove(board),
              },
              icon(ICONS.trash, 15),
            ),
      ),
    );
  }

  popover.element.append(
    list,
    el('p', {
      class: 'mf-recent-note',
      text: 'Kept in this browser only. Save to a file or to Drive to keep a board safe.',
    }),
  );

  // Arrow keys step through the boards, the same as every other list in the
  // app; Tab still reaches the remove buttons in between.
  //
  // Unlike the palette, focus moves onto the rows themselves, and a remove
  // button can hold it. So the index follows focus rather than only the arrows,
  // and Enter presses whatever is focused — pressing "the highlighted board"
  // while a remove button is focused would open a board the user did not pick.
  let index = 0;
  // The app's shortcuts listen on `window`, further along the bubble path. With
  // focus in here an arrow key would also nudge the selection behind the menu,
  // Delete would delete it, a letter would switch tools and Space would start a
  // pan instead of pressing the focused button. Chords with a modifier still go
  // through, so Cmd+S saves as it does anywhere else. Escape never reaches this:
  // the popover takes it in the capture phase.
  popover.element.addEventListener('keydown', (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) event.stopPropagation();
  });
  popover.element.addEventListener('focusin', (event) => {
    const focused = openButtons.indexOf(event.target as HTMLButtonElement);
    if (focused !== -1) index = focused;
  });
  installListNavigation({
    target: popover.element,
    items: () => openButtons,
    getIndex: () => index,
    setIndex: (next) => openButtons[next]?.focus(),
    activate: () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLButtonElement && popover.element.contains(focused)) focused.click();
    },
  });
  openButtons[0]?.focus();

  return popover;
}

/** "12 elements · 5 minutes ago". Exported for the unit tests. */
export function describeRecentBoard(
  board: Pick<RecentBoard, 'elementCount' | 'savedAt'>,
  now: number = Date.now(),
  locale?: string,
): string {
  const count = `${board.elementCount} ${board.elementCount === 1 ? 'element' : 'elements'}`;
  return `${count} · ${formatRelativeTime(board.savedAt, now, locale)}`;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * A short, human time: "just now", "5 minutes ago", "yesterday", then a date.
 *
 * Relative for the first week, because "which board was I on this morning" is
 * the question the menu answers. Beyond that a date reads better than "23 days
 * ago". A time in the future — a clock that moved backwards — reads as "just now"
 * rather than "in 3 minutes".
 */
export function formatRelativeTime(iso: string, now: number = Date.now(), locale?: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown time';

  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return 'just now';

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < 7 * DAY) return relative.format(-Math.floor(elapsed / DAY), 'day');

  const date = new Date(then);
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    // The year only when it is not this one; "3 Mar" is enough on its own.
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
  });
}
