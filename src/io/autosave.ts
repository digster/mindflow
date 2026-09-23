/**
 * Autosave and the recent-boards list, backed by IndexedDB.
 *
 * ---------------------------------------------------------------------------
 * Why IndexedDB and not localStorage
 * ---------------------------------------------------------------------------
 * localStorage caps out around 5 MB and stores strings synchronously on the main
 * thread. A board with two pasted photos exceeds that immediately, and the write
 * would jank the canvas every time it fired. IndexedDB has a quota in the
 * hundreds of megabytes and writes asynchronously.
 *
 * ---------------------------------------------------------------------------
 * One copy per board, not one in total
 * ---------------------------------------------------------------------------
 * Every board worked on in this browser keeps its latest state here, and that
 * set is what the recent-boards menu lists. Saving to a file or to Drive does
 * not delete a board's copy; it clears the copy's `unsaved` flag. Leaving a
 * board for another does not delete it either. The list is capped, and trimmed
 * oldest-saved-first — see `pickEvictions`.
 *
 * Three object stores, split by how they are read:
 *
 *   - `autosave`  board id → the serialised board. Large, since images are
 *                 embedded as data URIs, so it is read only when a board is
 *                 actually opened.
 *   - `recent`    board id → a small summary. The menu reads only this, so
 *                 opening it never deserialises megabytes of image data.
 *   - `session`   which board was open most recently. Startup offers back that
 *                 board's unsaved work and nothing older, which is what stops a
 *                 board the user already walked away from being offered on
 *                 every launch.
 *
 * This is still NOT a substitute for saving a file. The browser can evict site
 * data, the user can clear it, and it never leaves this machine. The UI says so.
 */

import type { MindflowDocument } from '../model/types.ts';
import { serializeDocument } from '../model/document.ts';

const DB_NAME = 'mindflow';
/** 1: a single record under {@link LEGACY_KEY}. 2: one record per board. */
const DB_VERSION = 2;
const CONTENTS_STORE = 'autosave';
const RECENT_STORE = 'recent';
const SESSION_STORE = 'session';
/** The one key version 1 wrote to, migrated away on upgrade. */
const LEGACY_KEY = 'current';
const LAST_OPEN_KEY = 'lastOpen';

/** Debounce after the last edit. Long enough to batch a burst of typing. */
const AUTOSAVE_DELAY_MS = 1200;

/**
 * How many boards the recent list keeps.
 *
 * Bounded because each copy can run to megabytes. Ten covers "the boards I am
 * working on this week" without letting a year of scratch boards fill the quota.
 */
export const MAX_RECENT_BOARDS = 10;

/** One row of the recent-boards menu. Deliberately small: no board contents. */
export interface RecentBoard {
  boardId: string;
  name: string;
  /** ISO time of the last write. Orders the menu, newest first. */
  savedAt: string;
  elementCount: number;
  /** True when the copy holds changes that were never saved to a file or to Drive. */
  unsaved: boolean;
}

/** What gets written: the board, plus whether it has changes not saved elsewhere. */
export interface BoardSnapshot {
  document: MindflowDocument;
  /** Unknown-type elements carried through from load; see `LoadResult.preserved`. */
  preserved: readonly unknown[];
  unsaved: boolean;
}

interface ContentsRecord {
  key: string;
  /** Serialised document — stored as text so a corrupt record cannot break the schema. */
  contents: string;
}

/** The shape version 1 stored under {@link LEGACY_KEY}. */
interface LegacyRecord {
  key: string;
  contents: string;
  boardId: string;
  name: string;
  savedAt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests, which run without IndexedDB
// ---------------------------------------------------------------------------

/**
 * Which boards to drop to bring the list back down to `max`.
 *
 * Boards whose copy is already saved elsewhere go first, oldest first, because
 * dropping one loses nothing that is not also in a file or on Drive. Only when
 * there are more than `max` boards with unsaved work does the oldest of those
 * go. The board being written (`keep`) is never evicted — it is the one in use.
 */
export function pickEvictions(boards: readonly RecentBoard[], keep: string, max: number): string[] {
  const excess = boards.length - max;
  if (excess <= 0) return [];
  return boards
    .filter((board) => board.boardId !== keep)
    .sort(
      (a, b) =>
        Number(a.unsaved) - Number(b.unsaved) ||
        // ISO-8601 in UTC sorts lexically in time order.
        a.savedAt.localeCompare(b.savedAt),
    )
    .slice(0, excess)
    .map((board) => board.boardId);
}

/** Newest first, which is the order the menu shows. */
export function sortRecentBoards(boards: readonly RecentBoard[]): RecentBoard[] {
  return [...boards].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

// ---------------------------------------------------------------------------
// Database access
// ---------------------------------------------------------------------------

/** One shared connection. See `openDatabase` for why it is not per-operation. */
let connection: Promise<IDBDatabase> | null = null;

/**
 * Opens (once) and caches the database connection.
 *
 * One connection rather than one per operation, because IndexedDB orders
 * transactions reliably only within a connection. The flush that saves the
 * board being left and the read of the board being opened must not overtake
 * each other.
 *
 * The connection closes itself when another tab asks to upgrade the schema.
 * Without that, a tab still running an older build would block the upgrade for
 * as long as it stayed open.
 */
function openDatabase(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((resolve, reject) => {
    // `indexedDB` itself can throw on access when the browser blocks site data;
    // inside the executor that becomes a rejection like any other failure.
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      if (request.transaction) upgrade(request.result, request.transaction, event.oldVersion);
    };
    request.onsuccess = () => {
      const db = request.result;
      const forget = () => {
        db.close();
        connection = null;
      };
      db.onversionchange = forget;
      // Fires when the browser closes the connection itself, e.g. because the
      // user cleared site data while the page was open.
      db.onclose = () => {
        connection = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'));
  }).catch((error: unknown) => {
    // Do not cache a failure. Storage that was blocked at startup can become
    // available later, e.g. after the user changes a site-data setting.
    connection = null;
    throw error;
  });
  return connection;
}

/**
 * Creates the stores, and carries a version-1 database forward.
 *
 * Version 1 kept one record under the fixed key `current`. It is re-keyed under
 * its board id and given a summary, so upgrading does not lose the one board a
 * version-1 page was holding. It is marked unsaved and as the last open board,
 * which makes startup offer it back exactly as version 1 would have.
 */
function upgrade(db: IDBDatabase, transaction: IDBTransaction, oldVersion: number): void {
  if (!db.objectStoreNames.contains(CONTENTS_STORE)) {
    db.createObjectStore(CONTENTS_STORE, { keyPath: 'key' });
  }
  if (!db.objectStoreNames.contains(RECENT_STORE)) {
    db.createObjectStore(RECENT_STORE, { keyPath: 'boardId' });
  }
  if (!db.objectStoreNames.contains(SESSION_STORE)) {
    db.createObjectStore(SESSION_STORE, { keyPath: 'key' });
  }

  if (oldVersion !== 1) return;

  const contents = transaction.objectStore(CONTENTS_STORE);
  const legacy = contents.get(LEGACY_KEY);
  legacy.onsuccess = () => {
    const record = legacy.result as LegacyRecord | undefined;
    if (!record) return;
    contents.delete(LEGACY_KEY);
    if (typeof record.boardId !== 'string' || typeof record.contents !== 'string') return;

    contents.put({ key: record.boardId, contents: record.contents } satisfies ContentsRecord);
    transaction.objectStore(RECENT_STORE).put({
      boardId: record.boardId,
      name: typeof record.name === 'string' ? record.name : 'Untitled board',
      savedAt: typeof record.savedAt === 'string' ? record.savedAt : new Date().toISOString(),
      elementCount: countElements(record.contents),
      unsaved: true,
    } satisfies RecentBoard);
    transaction.objectStore(SESSION_STORE).put({ key: LAST_OPEN_KEY, boardId: record.boardId });
  };
}

/** Element count of a serialised board, for a summary built without loading it. */
function countElements(contents: string): number {
  try {
    const parsed = JSON.parse(contents) as { elements?: unknown };
    return Array.isArray(parsed.elements) ? parsed.elements.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Runs one transaction and resolves once it has COMMITTED.
 *
 * `body` issues requests and returns a getter for the value to resolve with,
 * read after the commit. Resolving on `complete` rather than on a request's own
 * `success` matters for writes: a write is durable only once its transaction
 * commits, and reporting success before that could be a lie.
 *
 * Callbacks rather than awaited promises inside the transaction, because a
 * transaction auto-commits as soon as control returns to the event loop with no
 * request pending, and chaining through promises makes that easy to trip over.
 */
async function transact<T>(
  stores: readonly string[],
  mode: IDBTransactionMode,
  body: (transaction: IDBTransaction) => () => T,
): Promise<T> {
  const db = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const result = body(transaction);
    transaction.oncomplete = () => resolve(result());
    // A failed request aborts its transaction by default, so this one handler
    // covers request errors, quota errors and explicit aborts alike.
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('A local database transaction was aborted.'));
  });
}

/** Writes a board's summary (and its contents, unless `null`), then trims the list. */
function putBoard(summary: RecentBoard, contents: string | null): Promise<void> {
  return transact([CONTENTS_STORE, RECENT_STORE], 'readwrite', (transaction) => {
    const contentsStore = transaction.objectStore(CONTENTS_STORE);
    const recentStore = transaction.objectStore(RECENT_STORE);

    if (contents !== null) {
      contentsStore.put({ key: summary.boardId, contents } satisfies ContentsRecord);
    }
    recentStore.put(summary);

    // Trimmed in the same transaction, so no reader can ever see the list over
    // its cap, and a failure leaves neither half applied.
    const all = recentStore.getAll();
    all.onsuccess = () => {
      for (const boardId of pickEvictions(all.result as RecentBoard[], summary.boardId, MAX_RECENT_BOARDS)) {
        recentStore.delete(boardId);
        contentsStore.delete(boardId);
      }
    };
    return () => undefined;
  });
}

function deleteBoard(boardId: string): Promise<void> {
  return transact([CONTENTS_STORE, RECENT_STORE], 'readwrite', (transaction) => {
    transaction.objectStore(CONTENTS_STORE).delete(boardId);
    transaction.objectStore(RECENT_STORE).delete(boardId);
    return () => undefined;
  });
}

// ---------------------------------------------------------------------------
// The autosave writer and the recent-boards reader
// ---------------------------------------------------------------------------

export class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The newest snapshot not yet written. */
  private pending: BoardSnapshot | null = null;
  /** What was last written, so identical writes can be skipped. */
  private last: { boardId: string; contents: string; unsaved: boolean } | null = null;
  /**
   * Writes run one at a time, in call order. Two overlapping writes for one
   * board could otherwise commit out of order and leave the older state stored.
   */
  private queue: Promise<void> = Promise.resolve();
  /** Turns itself off after a failure so a full quota does not error on every edit. */
  private disabled = false;

  constructor(private readonly onError?: (error: unknown) => void) {}

  /** False once storage has failed. The UI stops promising a copy is kept. */
  get available(): boolean {
    return !this.disabled;
  }

  /** Schedules a write. Repeated calls within the debounce window collapse into one. */
  schedule(snapshot: BoardSnapshot): void {
    if (this.disabled) return;
    // A snapshot of a DIFFERENT board means the user is switching boards. The
    // one being left gets written now; letting the new snapshot replace it
    // would silently drop the last second of edits to the old board.
    if (this.pending && this.pending.document.id !== snapshot.document.id) void this.flush();
    this.pending = snapshot;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_DELAY_MS);
  }

  /** Writes immediately, e.g. right after an explicit save flips `unsaved` off. */
  saveNow(snapshot: BoardSnapshot): Promise<void> {
    this.schedule(snapshot);
    return this.flush();
  }

  /** Writes whatever is pending now, e.g. when the page is being hidden. */
  flush(): Promise<void> {
    this.cancel();
    const snapshot = this.pending;
    this.pending = null;
    if (snapshot && !this.disabled) {
      this.queue = this.queue.then(() => this.write(snapshot));
    }
    return this.queue;
  }

  /** Cancels a scheduled write without performing it, e.g. on teardown. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async write(snapshot: BoardSnapshot): Promise<void> {
    if (this.disabled) return;
    const { document, preserved, unsaved } = snapshot;

    try {
      const contents = serializeDocument(document, preserved);
      const last = this.last;
      const sameContents = last?.boardId === document.id && last.contents === contents;
      // Skip identical writes: undo/redo round trips and no-op edits otherwise
      // rewrite several megabytes for nothing.
      if (sameContents && last.unsaved === unsaved) return;

      // Preserved elements count: a board of types this build cannot draw is
      // still a board worth keeping.
      const elementCount = document.elements.length + preserved.length;
      if (elementCount === 0) {
        // A blank board is not worth listing, and a board emptied by deleting
        // everything should not linger as an empty row.
        await deleteBoard(document.id);
      } else {
        await putBoard(
          { boardId: document.id, name: document.meta.name, savedAt: new Date().toISOString(), elementCount, unsaved },
          // Saving flips only the flag; the stored contents are already right,
          // and are left alone rather than rewritten.
          sameContents ? null : contents,
        );
      }
      this.last = { boardId: document.id, contents, unsaved };
    } catch (error) {
      // Quota exceeded, private-browsing restrictions, or a blocked upgrade.
      // Autosave is a convenience, so degrade quietly rather than interrupting.
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    if (this.disabled) return;
    this.disabled = true;
    this.pending = null;
    this.cancel();
    this.onError?.(error);
  }

  /**
   * Every stored board, newest first, or `null` when storage is unavailable.
   *
   * Pending edits are written first, so the board on screen is listed as it is
   * now rather than as it was a second ago — or missing, if it is brand new.
   */
  async recentBoards(): Promise<RecentBoard[] | null> {
    await this.flush();
    if (this.disabled) return null;
    try {
      const boards = await transact([RECENT_STORE], 'readonly', (transaction) => {
        const request = transaction.objectStore(RECENT_STORE).getAll();
        return () => request.result as RecentBoard[];
      });
      return sortRecentBoards(boards);
    } catch {
      return null;
    }
  }

  /** A stored board's serialised contents, or `null` when it is no longer there. */
  async readBoard(boardId: string): Promise<string | null> {
    const record = await transact([CONTENTS_STORE], 'readonly', (transaction) => {
      const request = transaction.objectStore(CONTENTS_STORE).get(boardId);
      return () => request.result as ContentsRecord | undefined;
    });
    return typeof record?.contents === 'string' ? record.contents : null;
  }

  /** Deletes a board's copy from this browser. Its file or Drive copy is untouched. */
  async remove(boardId: string): Promise<void> {
    // Forget it was written, or reopening the same board unchanged would be
    // skipped as an identical write and the board would never come back.
    if (this.last?.boardId === boardId) this.last = null;
    await deleteBoard(boardId);
  }

  /**
   * The board that was open when the previous session ended — but only if it
   * was left with unsaved changes, since that is the only case worth asking
   * about on startup.
   *
   * Also the startup probe: if storage cannot even be read, autosave is turned
   * off here and reported once, rather than on the user's first edit.
   */
  async unsavedFromLastSession(): Promise<RecentBoard | null> {
    try {
      const board = await transact([SESSION_STORE, RECENT_STORE], 'readonly', (transaction) => {
        let found: RecentBoard | undefined;
        const marker = transaction.objectStore(SESSION_STORE).get(LAST_OPEN_KEY);
        marker.onsuccess = () => {
          const boardId = (marker.result as { boardId?: unknown } | undefined)?.boardId;
          if (typeof boardId !== 'string') return;
          const summary = transaction.objectStore(RECENT_STORE).get(boardId);
          summary.onsuccess = () => {
            found = summary.result as RecentBoard | undefined;
          };
        };
        return () => found;
      });
      return board?.unsaved ? board : null;
    } catch (error) {
      this.fail(error);
      return null;
    }
  }

  /** Records which board is on screen, for `unsavedFromLastSession`. */
  async markOpen(boardId: string): Promise<void> {
    if (this.disabled) return;
    try {
      await transact([SESSION_STORE], 'readwrite', (transaction) => {
        transaction.objectStore(SESSION_STORE).put({ key: LAST_OPEN_KEY, boardId });
        return () => undefined;
      });
    } catch {
      // Only a hint for the next startup. Losing it means at worst one missed
      // or one extra recovery prompt, which is not worth a word to the user.
    }
  }
}
