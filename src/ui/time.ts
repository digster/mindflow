/**
 * Human-readable times for the chrome: "just now", "5 minutes ago", "3 Mar".
 *
 * Shared by the recent-boards menu and the top bar's "Edited …" label, so one
 * board can never read "5 minutes ago" in one place and "4 minutes ago" in the
 * other. Pure and DOM-free, so both the wording and the refresh schedule are
 * unit-tested in node (`test/unit/time.test.ts`).
 */

import type { DocumentMeta } from '../model/types.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Relative wording stops here and a date takes over. */
const RELATIVE_FOR = 7 * DAY;

/**
 * A short, human time: "just now", "5 minutes ago", "yesterday", then a date.
 *
 * Relative for the first week, because "which board was I on this morning" is
 * the question the recent-boards menu answers. Beyond that a date reads better
 * than "23 days ago". A time in the future, from a clock that moved backwards,
 * reads as "just now" rather than "in 3 minutes".
 */
export function formatRelativeTime(iso: string, now: number = Date.now(), locale?: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'unknown time';

  const elapsed = Math.max(0, now - then);
  if (elapsed < MINUTE) return 'just now';

  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (elapsed < HOUR) return relative.format(-Math.floor(elapsed / MINUTE), 'minute');
  if (elapsed < DAY) return relative.format(-Math.floor(elapsed / HOUR), 'hour');
  if (elapsed < RELATIVE_FOR) return relative.format(-Math.floor(elapsed / DAY), 'day');

  const date = new Date(then);
  return date.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    // The year only when it is not this one; "3 Mar" is enough on its own.
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric',
  });
}

/**
 * Milliseconds until {@link formatRelativeTime} could next read differently
 * for `iso`, or `null` once it has settled on a date.
 *
 * The answer is the next unit boundary of the elapsed time: the minute mark
 * while it reads "just now" or in minutes, the hour mark while in hours, the
 * day mark while in days. A label that refreshes on this schedule changes from
 * "just now" to "1 minute ago" at the moment it becomes true, where a fixed
 * one-minute interval could leave "just now" up for almost two minutes. A
 * future time reads "just now" until a minute after it, so its delay is longer
 * than a minute.
 *
 * `null` for a date is not quite "never": "3 Mar" becomes "3 Mar 2026" when the
 * year turns. Callers that stay open that long recheck on their own schedule.
 */
export function relativeTimeChangesIn(iso: string, now: number = Date.now()): number | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;

  // Not clamped, unlike `formatRelativeTime`: a future time's "just now" lasts
  // until a minute after it, which `MINUTE - elapsed` gives exactly.
  const elapsed = now - then;
  if (elapsed < MINUTE) return MINUTE - elapsed;
  if (elapsed < HOUR) return MINUTE - (elapsed % MINUTE);
  if (elapsed < DAY) return HOUR - (elapsed % HOUR);
  if (elapsed < RELATIVE_FOR) return DAY - (elapsed % DAY);
  return null;
}

/** What the top bar says about when the board last changed. */
export interface LastEditLabel {
  /** "Edited 5 minutes ago", or "Created just now" for a board never edited. */
  text: string;
  /** The full local date and time, for the tooltip. */
  title: string;
  /** The instant the text describes, for `<time datetime>` and for scheduling. */
  iso: string;
}

/**
 * The top bar's "Edited 5 minutes ago" label for a board.
 *
 * The time is `meta.updatedAt`, which every edit moves (`applyCommand`). A
 * board whose `updatedAt` is not after its `createdAt` has never been edited:
 * `createDocument` stamps both with the same instant. It reads "Created …"
 * instead, because "Edited just now" on a blank board claims an edit that never
 * happened. A file saved by another program with equal stamps reads the same
 * way, which is what those stamps say about it.
 *
 * An unreadable stamp compares as not-earlier, so it falls through to
 * "Edited unknown time" rather than throwing. The loader normalises both
 * stamps (`asIsoDate`), so a loaded board never gets there.
 */
export function describeLastEdit(
  meta: Pick<DocumentMeta, 'createdAt' | 'updatedAt'>,
  now: number = Date.now(),
  locale?: string,
): LastEditLabel {
  const neverEdited = Date.parse(meta.updatedAt) <= Date.parse(meta.createdAt);
  const iso = neverEdited ? meta.createdAt : meta.updatedAt;
  const then = Date.parse(iso);
  const absolute = Number.isNaN(then)
    ? 'at an unknown time'
    : new Date(then).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return {
    text: `${neverEdited ? 'Created' : 'Edited'} ${formatRelativeTime(iso, now, locale)}`,
    title: `${neverEdited ? 'Created' : 'Last edited'} ${absolute}`,
    iso,
  };
}
