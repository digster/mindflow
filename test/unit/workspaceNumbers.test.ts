/**
 * The quick-switch numbers' rules: which workspaces get a number, how many fit,
 * and what each is called. The strip itself, and its fit in a real top bar,
 * need a browser and are covered by `test/e2e/workspaces.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_QUICK_SWITCH,
  numbersThatFit,
  quickSwitchLabel,
  quickSwitchTargets,
} from '../../src/ui/workspaceNumbers.ts';

const board = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `ws_${index + 1}`, name: `Workspace ${index + 1}` }));

describe('quickSwitchTargets', () => {
  it('offers nothing for a board with one workspace', () => {
    expect(quickSwitchTargets(board(1), 'ws_1')).toEqual([]);
    expect(quickSwitchTargets([], 'ws_1')).toEqual([]);
  });

  it('numbers every workspace from 1, in list order, marking the one on screen', () => {
    const workspaces = [
      { id: 'b', name: 'Second made, listed first' },
      { id: 'a', name: 'Sketches' },
      { id: 'c', name: 'Notes' },
    ];
    expect(quickSwitchTargets(workspaces, 'a')).toEqual([
      { id: 'b', number: 1, name: 'Second made, listed first', active: false },
      { id: 'a', number: 2, name: 'Sketches', active: true },
      { id: 'c', number: 3, name: 'Notes', active: false },
    ]);
  });

  it('stops at nine, the single digits', () => {
    expect(MAX_QUICK_SWITCH).toBe(9);
    const targets = quickSwitchTargets(board(12), 'ws_11');
    expect(targets.map((target) => target.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // The workspace on screen is past the strip, so no number is marked.
    expect(targets.some((target) => target.active)).toBe(false);
  });
});

describe('numbersThatFit', () => {
  it('keeps every number when nothing overflows', () => {
    expect(numbersThatFit(5, 0, 27)).toBe(5);
    expect(numbersThatFit(5, -40, 27)).toBe(5);
  });

  it('takes away just enough numbers to cover the overflow', () => {
    expect(numbersThatFit(9, 1, 27)).toBe(8);
    expect(numbersThatFit(9, 27, 27)).toBe(8);
    expect(numbersThatFit(9, 28, 27)).toBe(7);
    expect(numbersThatFit(9, 100, 27)).toBe(5);
  });

  it('shows none rather than a lone number', () => {
    expect(numbersThatFit(3, 28, 27)).toBe(0);
    expect(numbersThatFit(2, 1, 27)).toBe(0);
    expect(numbersThatFit(3, 27, 27)).toBe(2);
  });

  it('shows none for fewer than two, and when the step cannot be measured', () => {
    expect(numbersThatFit(1, 0, 27)).toBe(0);
    expect(numbersThatFit(0, 0, 27)).toBe(0);
    expect(numbersThatFit(4, 10, 0)).toBe(0);
    expect(numbersThatFit(4, 10, Number.NaN)).toBe(0);
  });
});

describe('quickSwitchLabel', () => {
  it('starts with the digit on the button, so a voice command can name it', () => {
    expect(quickSwitchLabel({ number: 2, name: 'Sketches' })).toBe('2: Sketches');
  });
});
