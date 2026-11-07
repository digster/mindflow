/**
 * Human-readable times, shared by the recent-boards menu and the top bar.
 *
 * Three things are pinned here: the wording, when the wording next changes
 * (which drives the top bar label's timer), and what the label says about a
 * board's stamps. The label's DOM side is covered in `board.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import { describeLastEdit, formatRelativeTime, relativeTimeChangesIn } from '../../src/ui/time.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const now = Date.parse('2026-09-23T12:00:00.000Z');
const ago = (ms: number) => new Date(now - ms).toISOString();

describe('formatRelativeTime', () => {
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

describe('relativeTimeChangesIn', () => {
  it('is the next unit boundary of the elapsed time', () => {
    expect(relativeTimeChangesIn(ago(0), now)).toBe(MINUTE);
    expect(relativeTimeChangesIn(ago(20_000), now)).toBe(40_000);
    // In minutes: the next minute mark, not a minute from now.
    expect(relativeTimeChangesIn(ago(5 * MINUTE + 15_000), now)).toBe(45_000);
    expect(relativeTimeChangesIn(ago(59 * MINUTE), now)).toBe(MINUTE);
    // In hours, then days.
    expect(relativeTimeChangesIn(ago(3 * HOUR + 10 * MINUTE), now)).toBe(50 * MINUTE);
    expect(relativeTimeChangesIn(ago(2 * DAY + 5 * HOUR), now)).toBe(19 * HOUR);
  });

  it('waits until a minute after a time in the future', () => {
    expect(relativeTimeChangesIn(ago(-5 * MINUTE), now)).toBe(6 * MINUTE);
  });

  it('is null once the wording is a date, and for a malformed timestamp', () => {
    expect(relativeTimeChangesIn(ago(7 * DAY), now)).toBeNull();
    expect(relativeTimeChangesIn(ago(400 * DAY), now)).toBeNull();
    expect(relativeTimeChangesIn('not a date', now)).toBeNull();
  });

  // The property the top bar's timer relies on: the wording holds right up to
  // the moment returned, and changes exactly then. Checked across every
  // bucket, at and either side of each boundary.
  it('agrees with formatRelativeTime: same wording until then, different at it', () => {
    const elapsedValues = [
      0, 1, 30_000, MINUTE - 1, MINUTE, MINUTE + 1, 5 * MINUTE + 15_000, HOUR - 1, HOUR, HOUR + 1,
      5 * HOUR + 59 * MINUTE, DAY - 1, DAY, DAY + 1, 3 * DAY + 7 * HOUR, 7 * DAY - 1,
    ];
    for (const elapsed of elapsedValues) {
      const iso = ago(elapsed);
      const delay = relativeTimeChangesIn(iso, now);
      expect(delay, `elapsed ${elapsed}`).not.toBeNull();
      const before = formatRelativeTime(iso, now, 'en');
      expect(formatRelativeTime(iso, now + delay! - 1, 'en'), `elapsed ${elapsed}`).toBe(before);
      expect(formatRelativeTime(iso, now + delay!, 'en'), `elapsed ${elapsed}`).not.toBe(before);
    }
  });
});

describe('describeLastEdit', () => {
  const createdAt = '2026-09-01T09:00:00.000Z';
  const absolute = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  it('reports the last edit for a board edited after it was created', () => {
    const updatedAt = ago(5 * MINUTE);
    const label = describeLastEdit({ createdAt, updatedAt }, now, 'en-GB');
    expect(label.text).toBe('Edited 5 minutes ago');
    expect(label.title).toBe(`Last edited ${absolute(updatedAt)}`);
    expect(label.iso).toBe(updatedAt);
  });

  it('says "Created" for a board never edited, rather than claiming an edit', () => {
    // `createDocument` stamps both with the same instant.
    const stamp = ago(30_000);
    const label = describeLastEdit({ createdAt: stamp, updatedAt: stamp }, now, 'en-GB');
    expect(label.text).toBe('Created just now');
    expect(label.title).toBe(`Created ${absolute(stamp)}`);
    expect(label.iso).toBe(stamp);
  });

  it('treats an updatedAt before createdAt as never edited, and shows createdAt', () => {
    const label = describeLastEdit({ createdAt, updatedAt: '2026-08-01T09:00:00.000Z' }, now, 'en-GB');
    expect(label.iso).toBe(createdAt);
    // "Sep" or "Sept" depending on the ICU build Node ships with.
    expect(label.text).toMatch(/^Created 1 Sept?$/);
  });

  it('dates an old edit rather than counting days', () => {
    const label = describeLastEdit({ createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-12-24T12:00:00.000Z' }, now, 'en-GB');
    expect(label.text).toBe('Edited 24 Dec 2025');
  });

  it('does not throw on a malformed stamp', () => {
    const label = describeLastEdit({ createdAt, updatedAt: 'not a date' }, now, 'en-GB');
    expect(label.text).toBe('Edited unknown time');
    expect(label.title).toBe('Last edited at an unknown time');
  });
});
