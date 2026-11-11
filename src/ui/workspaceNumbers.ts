/**
 * The quick-switch numbers beside the workspace switcher: `1 2 3`, one press
 * to put any of the first nine workspaces on screen.
 *
 * Shown only when the board has more than one workspace. With one there is
 * nowhere to switch to, and the switcher alone is how a second is added.
 *
 * **Nine at most.** One digit each, so every button is the same square, and
 * the strip stays a glance rather than a second list. The list behind the
 * switcher holds every workspace, so a board with more loses nothing.
 *
 * **Room.** The numbers are fixed-size buttons, and a shrinking group of
 * fixed-size buttons overlaps rather than shrinks (LEARNINGS.md). So they never
 * shrink. When the top bar is short of room they drop from the end instead,
 * after the "Edited" label and the board name have given way and before the
 * switcher's own name does (the stylesheet keeps the switcher rigid while any
 * number shows). A single number is no quick switch, so below two none show.
 * Below 760px the bar scrolls sideways, nothing is short of room, and every
 * number stays.
 *
 * How many fit is measured rather than set by media queries, because what the
 * bar can spare depends on the workspace's name and the board's as much as on
 * the window. The measurement runs when the window resizes and when the list
 * changes, never on the store's 60 fps pan updates.
 *
 * The module only renders. Switching (ending an edit in progress first) is the
 * app's, exactly as for the list.
 */

import type { WorkspaceId } from '../model/types.ts';
import type { WorkspaceEntry } from '../model/workspaces.ts';
import { el } from './dom.ts';

/** The most numbers shown: the digits 1 to 9. */
export const MAX_QUICK_SWITCH = 9;

/** Fewer than this many numbers is no quick switch, so then none show. */
const MIN_SHOWN = 2;

/** One number in the strip. */
export interface QuickSwitchTarget {
  id: WorkspaceId;
  /** 1-based, as shown on the button. */
  number: number;
  name: string;
  active: boolean;
}

/**
 * What the strip offers: the first nine workspaces in list order, or nothing
 * for a board with a single workspace. Pure, for the unit tests.
 */
export function quickSwitchTargets(
  workspaces: readonly Pick<WorkspaceEntry, 'id' | 'name'>[],
  activeId: WorkspaceId,
): QuickSwitchTarget[] {
  if (workspaces.length < MIN_SHOWN) return [];
  return workspaces.slice(0, MAX_QUICK_SWITCH).map((workspace, index) => ({
    id: workspace.id,
    number: index + 1,
    name: workspace.name,
    active: workspace.id === activeId,
  }));
}

/**
 * How many of `count` numbers fit, given how far the bar's left group
 * overflowed with all of them shown, and the distance from one number to the
 * next (its width plus the gap).
 *
 * Exact rather than approximate: an overflowing group has already shrunk
 * everything that can shrink to its minimum, so each number taken away gives
 * back exactly one `step`, and nothing else moves until the overflow is gone.
 * Pure, for the unit tests.
 */
export function numbersThatFit(count: number, overflow: number, step: number): number {
  if (count < MIN_SHOWN) return 0;
  if (overflow <= 0) return count;
  if (!(step > 0)) return 0;
  const fit = count - Math.ceil(overflow / step);
  return fit >= MIN_SHOWN ? fit : 0;
}

/** The accessible name: the visible digit first, so "click 2" works by voice. */
export function quickSwitchLabel(target: Pick<QuickSwitchTarget, 'number' | 'name'>): string {
  return `${target.number}: ${target.name}`;
}

export class WorkspaceNumbers {
  /** The strip. The toolbar places it right after the switcher. */
  readonly element: HTMLElement;

  /**
   * One button per number, made on first need and then reused. Reusing them
   * rather than rebuilding on every switch is what keeps keyboard focus on the
   * number that was just pressed.
   */
  private readonly buttons: HTMLButtonElement[] = [];
  private targets: QuickSwitchTarget[] = [];
  /** The list and active id last rendered, compared by reference in `sync`. */
  private renderedList: readonly WorkspaceEntry[] | null = null;
  private renderedActive: WorkspaceId | null = null;
  private observer: ResizeObserver | null = null;

  constructor(private readonly onSwitch: (id: WorkspaceId) => void) {
    this.element = el('div', {
      class: 'mf-workspace-numbers',
      role: 'group',
      'aria-label': 'Go to workspace',
    });
    this.element.hidden = true;
  }

  /**
   * Shows `workspaces`, with `activeId` marked as the one on screen.
   *
   * Called from the toolbar's `sync`, which runs on every store change, pans
   * included. The store replaces its `workspaces` array whenever the list
   * changes (a switch, a rename, a move), so a reference check is enough to
   * skip everything else.
   */
  sync(workspaces: readonly WorkspaceEntry[], activeId: WorkspaceId): void {
    if (workspaces === this.renderedList && activeId === this.renderedActive) return;
    this.renderedList = workspaces;
    this.renderedActive = activeId;
    this.targets = quickSwitchTargets(workspaces, activeId);

    this.targets.forEach((target, index) => {
      const button = this.buttons[index] ?? this.addButton(index);
      // Compared first: writing identical text still invalidates layout.
      const digit = String(target.number);
      if (button.textContent !== digit) button.textContent = digit;
      button.title = target.active ? `${target.name} (current)` : target.name;
      button.setAttribute('aria-label', quickSwitchLabel(target));
      if (target.active) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      button.classList.toggle('is-current', target.active);
    });

    this.fit();
  }

  /** Refits the strip whenever `bar` changes size: a window resize, or a phone turned. */
  watch(bar: HTMLElement): void {
    // A browser without ResizeObserver still gets the strip, fitted on every
    // list change; only a resize goes unnoticed.
    if (typeof ResizeObserver === 'undefined') return;
    this.observer?.disconnect();
    // Safe from resize loops: the strip changes what is inside the bar, never
    // the bar's own size.
    this.observer = new ResizeObserver(() => this.fit());
    this.observer.observe(bar);
  }

  /**
   * Shows as many numbers as the bar has room for.
   *
   * Every fit starts from all of them shown, so the result depends only on the
   * bar as it is now and never on the last fit: there is no state to drift, and
   * nothing to flicker between. A strip that is not in the document yet
   * measures as having room, and the observer refits it once it is.
   */
  fit(): void {
    const count = this.targets.length;
    this.show(count);
    const group = this.element.parentElement;
    if (this.element.hidden || !group) return;

    const overflow = group.scrollWidth - group.clientWidth;
    if (overflow <= 0) return;
    const [first, second] = this.buttons;
    const step = second && first ? second.getBoundingClientRect().left - first.getBoundingClientRect().left : 0;
    this.show(numbersThatFit(count, overflow, step));
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
  }

  /** Shows the first `count` numbers, or the strip not at all below two. */
  private show(count: number): void {
    const visible = count >= MIN_SHOWN ? count : 0;
    this.element.hidden = visible === 0;
    this.buttons.forEach((button, index) => {
      const hidden = index >= visible;
      if (button.hidden !== hidden) button.hidden = hidden;
    });
  }

  private addButton(index: number): HTMLButtonElement {
    const button = el('button', {
      class: 'mf-workspace-number',
      type: 'button',
      // Read at click time, so a button reused for another workspace never
      // switches to the one it used to show.
      onclick: () => {
        const target = this.targets[index];
        if (target && !target.active) this.onSwitch(target.id);
      },
    }) as HTMLButtonElement;
    this.buttons[index] = button;
    this.element.append(button);
    return button;
  }
}
