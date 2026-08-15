/**
 * Crash-recovery autosave, backed by IndexedDB.
 *
 * ---------------------------------------------------------------------------
 * Why IndexedDB and not localStorage
 * ---------------------------------------------------------------------------
 * localStorage caps out around 5 MB and stores strings synchronously on the main
 * thread. A board with two pasted photos exceeds that immediately, and the write
 * would jank the canvas every time it fired. IndexedDB has a quota in the
 * hundreds of megabytes and writes asynchronously.
 *
 * This is explicitly NOT a substitute for saving a file. It exists so that a
 * crashed tab, a closed laptop or an accidental navigation does not lose work.
 * The UI is careful to describe it as recovery, not as a save.
 */

import type { MindflowDocument } from '../model/types.ts';
import { serializeDocument } from '../model/document.ts';

const DB_NAME = 'mindflow';
const DB_VERSION = 1;
const STORE_NAME = 'autosave';
const CURRENT_KEY = 'current';

/** Debounce after the last edit. Long enough to batch a burst of typing. */
const AUTOSAVE_DELAY_MS = 1200;

export interface AutosaveRecord {
  key: string;
  /** Serialised document — stored as text so a corrupt record cannot break the schema. */
  contents: string;
  boardId: string;
  name: string;
  savedAt: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open the local database.'));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Local database request failed.'));
    });
  } finally {
    db.close();
  }
}

export class Autosave {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastContents: string | null = null;
  /** Turns itself off after a failure so a full quota does not error on every edit. */
  private disabled = false;

  constructor(private readonly onError?: (error: unknown) => void) {}

  /** Schedules a save. Repeated calls within the debounce window collapse into one. */
  schedule(document: MindflowDocument, preserved: readonly unknown[]): void {
    if (this.disabled) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.saveNow(document, preserved), AUTOSAVE_DELAY_MS);
  }

  async saveNow(document: MindflowDocument, preserved: readonly unknown[]): Promise<void> {
    if (this.disabled) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      const contents = serializeDocument(document, preserved);
      // Skip identical writes: undo/redo round trips and no-op edits otherwise
      // rewrite several megabytes for nothing.
      if (contents === this.lastContents) return;

      const record: AutosaveRecord = {
        key: CURRENT_KEY,
        contents,
        boardId: document.id,
        name: document.meta.name,
        savedAt: new Date().toISOString(),
      };
      await withStore('readwrite', (store) => store.put(record));
      this.lastContents = contents;
    } catch (error) {
      // Quota exceeded, private-browsing restrictions, or a blocked upgrade.
      // Autosave is a convenience, so degrade quietly rather than interrupting.
      this.disabled = true;
      this.onError?.(error);
    }
  }

  /** The most recent autosave, or null. */
  async recover(): Promise<AutosaveRecord | null> {
    try {
      const record = await withStore<AutosaveRecord | undefined>('readonly', (store) =>
        store.get(CURRENT_KEY),
      );
      return record ?? null;
    } catch {
      return null;
    }
  }

  /** Clears the recovery record. Called after an explicit save. */
  async clear(): Promise<void> {
    this.lastContents = null;
    try {
      await withStore('readwrite', (store) => store.delete(CURRENT_KEY));
    } catch {
      // Nothing to do — the record simply stays until it is overwritten.
    }
  }

  /** Cancels any pending write, e.g. while unloading the page. */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
