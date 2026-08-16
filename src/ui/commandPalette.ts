/**
 * Command palette.
 *
 * Renders `buildCommands()` and nothing else — the palette owns no behaviour of
 * its own, so a command cannot drift from what the toolbar and keyboard do.
 *
 * One non-obvious constraint shapes the keyboard handling: the palette's filter
 * is an `<input>`, and `installKeyboardShortcuts` deliberately ignores every key
 * while a text field is focused (otherwise typing "v" while renaming a board
 * would switch tools). That guard is what keeps canvas shortcuts quiet here, but
 * it also means the global handler never sees `Cmd+K` again — so the palette has
 * to close itself.
 */

import type { Command } from '../app/commands.ts';
import { matchCommand } from '../app/commands.ts';
import { clear, el } from './dom.ts';
import { Popover, installListNavigation } from './popover.ts';

export function showCommandPalette(commands: Command[]): void {
  const input = el('input', {
    class: 'mf-palette-input',
    type: 'text',
    placeholder: 'Type a command…',
    spellcheck: 'false',
    'aria-label': 'Command',
  }) as HTMLInputElement;

  const list = el('div', { class: 'mf-palette-list', role: 'listbox' });

  const popover = new Popover({
    // Anchored near the top of the viewport rather than centred: a palette that
    // grows downward from a fixed point does not jump as the list is filtered.
    at: { x: window.innerWidth / 2, y: Math.round(window.innerHeight * 0.16) },
    align: 'center',
    className: 'mf-palette',
    label: 'Command palette',
  });
  popover.element.append(input, list);

  let buttons: HTMLButtonElement[] = [];
  let activeIndex = 0;

  function setIndex(index: number): void {
    buttons[activeIndex]?.classList.remove('is-active');
    buttons[activeIndex]?.setAttribute('aria-selected', 'false');
    activeIndex = index;
    const button = buttons[index];
    button?.classList.add('is-active');
    button?.setAttribute('aria-selected', 'true');
    // Keep the highlighted row visible without stealing focus from the input,
    // which must keep receiving keystrokes.
    button?.scrollIntoView({ block: 'nearest' });
  }

  function render(): void {
    clear(list);
    buttons = [];
    activeIndex = 0;

    const query = input.value;
    const matches = commands
      .map((command) => ({ command, score: matchCommand(command, query) }))
      .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
      // Stable within a score so the unfiltered list keeps its authored order,
      // which is what makes the palette learnable.
      .sort((a, b) => b.score - a.score);

    if (matches.length === 0) {
      list.append(el('div', { class: 'mf-palette-empty', text: 'No matching command' }));
      return;
    }

    let lastGroup = '';
    for (const { command } of matches) {
      // Group headings only make sense while the list is in its authored order;
      // once results are ranked they would interleave meaninglessly.
      if (query.trim() === '' && command.group !== lastGroup) {
        lastGroup = command.group;
        list.append(el('div', { class: 'mf-palette-group', text: command.group }));
      }

      const enabled = command.enabled();
      const button = el(
        'button',
        {
          class: 'mf-menu-item',
          type: 'button',
          role: 'option',
          'aria-selected': 'false',
          disabled: !enabled,
          onclick: () => {
            popover.close();
            command.run();
          },
        },
        el('span', { text: command.title }),
        command.shortcut ? el('span', { class: 'mf-menu-shortcut', text: command.shortcut }) : null,
      );

      if (enabled) buttons.push(button);
      list.append(button);
    }

    setIndex(0);
  }

  input.addEventListener('input', render);

  installListNavigation({
    target: input,
    items: () => buttons,
    getIndex: () => activeIndex,
    setIndex,
    activate: (index) => buttons[index]?.click(),
  });

  render();
  input.focus();
}
