/**
 * The pure parts of the recent-boards feature.
 *
 * The IndexedDB side is covered end to end in the Playwright suite, because the
 * unit environment is node and has no IndexedDB. What is left here is the logic
 * that decides things: which boards the cap evicts, the menu's order, and how a
 * row describes itself.
 */

import { describe, expect, it } from 'vitest';
import { MAX_RECENT_BOARDS, pickEvictions, sortRecentBoards, type RecentBoard } from '../../src/io/autosave.ts';
import { describeRecentBoard, formatRelativeTime } from '../../src/ui/recentBoards.ts';

function board(boardId: string, savedAt: string, unsaved = false): RecentBoard {
  return { boardId, name: boardId, savedAt, elementCount: 1, unsaved };
}

describe('pickEvictions', () => {
  it('evicts nothing at or under the cap', () => {
    const boards = [board('a', '2026-09-01T00:00:00.000Z'), board('b', '2026-09-02T00:00:00.000Z')];
    expect(pickEvictions(boards, 'a', 2)).toEqual([]);
    expect(pickEvictions(boards, 'a', 5)).toEqual([]);
  });

  it('evicts the oldest board first', () => {
    const boards = [
      board('new', '2026-09-03T00:00:00.000Z'),
      board('old', '2026-09-01T00:00:00.000Z'),
      board('mid', '2026-09-02T00:00:00.000Z'),
    ];
    expect(pickEvictions(boards, 'new', 2)).toEqual(['old']);
  });

  it('prefers boards already saved elsewhere, even when newer', () => {
    // Dropping a saved board loses nothing that is not also in a file. Dropping
    // an unsaved one loses work, so age alone must not decide.
    const boards = [
      board('writing', '2026-09-04T00:00:00.000Z', true),
      board('old-unsaved', '2026-09-01T00:00:00.000Z', true),
      board('newer-saved', '2026-09-03T00:00:00.000Z'),
    ];
    expect(pickEvictions(boards, 'writing', 2)).toEqual(['newer-saved']);
  });

  it('falls back to the oldest unsaved board once no saved board is left', () => {
    const boards = [
      board('writing', '2026-09-04T00:00:00.000Z', true),
      board('old-unsaved', '2026-09-01T00:00:00.000Z', true),
      board('mid-unsaved', '2026-09-02T00:00:00.000Z', true),
    ];
    expect(pickEvictions(boards, 'writing', 2)).toEqual(['old-unsaved']);
  });

  it('never evicts the board being written, even when it is the oldest', () => {
    // Its savedAt is only stale in the array the caller read; it is the board
    // in use, and evicting it would delete what was just saved.
    const boards = [
      board('writing', '2026-09-01T00:00:00.000Z'),
      board('b', '2026-09-02T00:00:00.000Z'),
      board('c', '2026-09-03T00:00:00.000Z'),
    ];
    expect(pickEvictions(boards, 'writing', 2)).toEqual(['b']);
  });

  it('evicts as many as it takes to reach the cap', () => {
    const boards = Array.from({ length: MAX_RECENT_BOARDS + 3 }, (_, index) =>
      board(`b${index}`, new Date(Date.UTC(2026, 8, 1 + index)).toISOString()),
    );
    expect(pickEvictions(boards, 'b0', MAX_RECENT_BOARDS)).toEqual(['b1', 'b2', 'b3']);
  });
});

describe('sortRecentBoards', () => {
  it('puts the newest first without mutating its input', () => {
    const boards = [
      board('old', '2026-09-01T00:00:00.000Z'),
      board('new', '2026-09-03T00:00:00.000Z'),
      board('mid', '2026-09-02T00:00:00.000Z'),
    ];
    expect(sortRecentBoards(boards).map((entry) => entry.boardId)).toEqual(['new', 'mid', 'old']);
    expect(boards[0]!.boardId).toBe('old');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  it('says "just now" under a minute, and for a clock that moved backwards', () => {
    expect(formatRelativeTime(ago(0), now, 'en')).toBe('just now');
    expect(formatRelativeTime(ago(59_000), now, 'en')).toBe('just now');
    expect(formatRelativeTime(ago(-5 * MINUTE), now, 'en')).toBe('just now');
  });

  it('counts minutes, hours and days for the first week', () => {
    expect(formatRelativeTime(ago(5 * MINUTE), now, 'en')).toBe('5 minutes ago');
    expect(formatRelativeTime(ago(3 * HOUR), now, 'en')).toBe('3 hours ago');
    expect(formatRelativeTime(ago(DAY + HOUR), now, 'en')).toBe('yesterday');
    expect(formatRelativeTime(ago(6 * DAY), now, 'en')).toBe('6 days ago');
  });

  it('switches to a date after a week, with the year only when it differs', () => {
    // "Sep" or "Sept" depending on the ICU build Node ships with.
    expect(formatRelativeTime('2026-09-01T12:00:00.000Z', now, 'en-GB')).toMatch(/^1 Sept?$/);
    expect(formatRelativeTime('2025-12-24T12:00:00.000Z', now, 'en-GB')).toBe('24 Dec 2025');
  });

  it('does not throw on a malformed timestamp', () => {
    expect(formatRelativeTime('not a date', now, 'en')).toBe('unknown time');
  });
});

describe('describeRecentBoard', () => {
  const now = Date.parse('2026-09-23T12:00:00.000Z');

  it('pluralises the element count', () => {
    expect(describeRecentBoard({ elementCount: 1, savedAt: '2026-09-23T11:55:00.000Z' }, now, 'en')).toBe(
      '1 element · 5 minutes ago',
    );
    expect(describeRecentBoard({ elementCount: 12, savedAt: '2026-09-23T11:55:00.000Z' }, now, 'en')).toBe(
      '12 elements · 5 minutes ago',
    );
  });
});
