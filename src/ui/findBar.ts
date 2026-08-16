/**
 * Find on board.
 *
 * The browser's own find cannot help here: canvas text is painted pixels, not
 * DOM, so `Cmd`/`Ctrl` + `F` would open a dialog that can never match anything
 * on the board. Overriding it is the rare case where taking a browser chord is
 * the honest choice rather than a land grab.
 *
 * Matching lives in `src/model/search.ts` so it stays testable without a DOM.
 * This file is the shell: an input, a match counter, and the navigation that
 * centres the viewport on each hit.
 */

import type { Actions } from '../app/actions.ts';
import type { Store } from '../store/store.ts';
import { elementCenter } from '../model/geometry.ts';
import { findElements, type SearchMatch } from '../model/search.ts';
import { el } from './dom.ts';
import { Popover } from './popover.ts';

export function showFindBar(store: Store, actions: Actions): void {
  const input = el('input', {
    class: 'mf-palette-input',
    type: 'text',
    placeholder: 'Find on board…',
    spellcheck: 'false',
    'aria-label': 'Find text',
  }) as HTMLInputElement;

  const status = el('div', { class: 'mf-find-status', role: 'status', 'aria-live': 'polite' });

  const popover = new Popover({
    at: { x: window.innerWidth / 2, y: Math.round(window.innerHeight * 0.16) },
    align: 'center',
    className: 'mf-palette mf-find',
    label: 'Find on board',
  });
  popover.element.append(input, status);

  let matches: SearchMatch[] = [];
  let index = 0;

  function reveal(): void {
    const match = matches[index];
    if (!match) return;
    // Select as well as centre: the selection is what makes the hit visible on
    // a busy board, and it leaves the element ready to act on once found.
    store.setSelection([match.element.id]);
    actions.centerOn(elementCenter(match.element));
    status.textContent = `${index + 1} of ${matches.length}`;
  }

  function search(): void {
    matches = findElements(store.document, input.value);
    index = 0;

    if (input.value.trim() === '') {
      status.textContent = 'Type to search sticky notes, text and labels.';
      return;
    }
    if (matches.length === 0) {
      status.textContent = 'No matches';
      return;
    }
    reveal();
  }

  function step(delta: number): void {
    if (matches.length === 0) return;
    index = (index + delta + matches.length) % matches.length;
    reveal();
  }

  input.addEventListener('input', search);
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    step(event.shiftKey ? -1 : 1);
  });

  // Deliberately no cleanup on close: the found element stays selected, because
  // the point of finding something is almost always to then do something to it.
  search();
  input.focus();
}
