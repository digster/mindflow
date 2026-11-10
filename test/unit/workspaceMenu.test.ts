/**
 * The workspace list's wording. The list itself needs a browser and is
 * covered by `test/e2e/workspaces.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import { describeDeletion, describeWorkspace } from '../../src/ui/workspaceMenu.ts';
import { SHORTCUT_REFERENCE } from '../../src/input/keyboard.ts';

describe('describeWorkspace', () => {
  it('counts the elements, and calls an empty workspace empty', () => {
    expect(describeWorkspace({ elementCount: 0 })).toBe('Empty');
    expect(describeWorkspace({ elementCount: 1 })).toBe('1 element');
    expect(describeWorkspace({ elementCount: 17 })).toBe('17 elements');
  });
});

describe('describeDeletion', () => {
  it('names the workspace and what goes with it, and says it cannot be undone', () => {
    expect(describeDeletion({ name: 'Brainstorm', elementCount: 17 })).toBe(
      '"Brainstorm" and its 17 elements will be deleted. This cannot be undone.',
    );
    expect(describeDeletion({ name: 'One', elementCount: 1 })).toContain('its 1 element will');
  });
});

describe('the shortcut reference', () => {
  it('lists the workspace keys', () => {
    const workspaces = SHORTCUT_REFERENCE.find((group) => group.group === 'Workspaces');
    expect(workspaces?.items.map(([keys]) => keys)).toEqual(['Page Down', 'Page Up', 'F2']);
  });
});
