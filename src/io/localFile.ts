/**
 * Local file save and open.
 *
 * ---------------------------------------------------------------------------
 * Two mechanisms, chosen by feature detection
 * ---------------------------------------------------------------------------
 * PREFERRED — File System Access API (`showSaveFilePicker`/`showOpenFilePicker`)
 *   Gives a real desktop-application experience: the browser hands back a
 *   persistent handle, so Cmd+S overwrites the same file silently instead of
 *   dropping another copy into Downloads. Chrome and Edge only, and it needs a
 *   secure context.
 *
 * FALLBACK — anchor download + file input
 *   Works everywhere, including Safari and Firefox. Every save produces a new
 *   file in the downloads folder, because the API deliberately gives web pages
 *   no way to write back to a chosen path.
 *
 * The difference is visible to the user, so the UI reports which one is in play
 * rather than pretending the fallback is a real save.
 */

import type { MindflowDocument } from '../model/types.ts';
import { FILE_EXTENSION, FILE_MIME_TYPE } from '../model/types.ts';
import type { LoadResult } from '../model/document.ts';
import { loadDocument, serializeDocument } from '../model/document.ts';

/**
 * Minimal shape of the File System Access handle we use.
 *
 * Declared locally rather than pulled from a `@types` package: the API is still
 * not in every TS DOM lib, and the surface we touch is three methods.
 */
interface FileSystemFileHandleLike {
  readonly name: string;
  createWritable(): Promise<{ write(data: string | Blob): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
}

interface FilePickerWindow {
  showSaveFilePicker?: (options: unknown) => Promise<FileSystemFileHandleLike>;
  showOpenFilePicker?: (options: unknown) => Promise<FileSystemFileHandleLike[]>;
}

/** True when the browser supports true in-place saving. */
export function supportsFileSystemAccess(): boolean {
  const w = window as unknown as FilePickerWindow;
  return typeof w.showSaveFilePicker === 'function' && typeof w.showOpenFilePicker === 'function';
}

/** Options passed to the pickers, describing the MindFlow file type. */
const PICKER_TYPES = [
  {
    description: 'MindFlow board',
    accept: { [FILE_MIME_TYPE]: [FILE_EXTENSION, '.json'] },
  },
];

/** Strips characters that are illegal in filenames on common platforms. */
export function toFileName(boardName: string): string {
  const safe = boardName
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safe === '' ? 'board' : safe}${FILE_EXTENSION}`;
}

export interface SaveResult {
  /** Handle for a subsequent silent save, when the platform supports it. */
  handle?: FileSystemFileHandleLike;
  name: string;
  /** True when the file went to the downloads folder rather than a chosen path. */
  viaDownload: boolean;
}

/**
 * Writes the document to disk.
 *
 * Reuses `existingHandle` when one is supplied and still writable, which is what
 * makes repeated Cmd+S silent. A revoked permission falls through to the picker
 * rather than failing.
 */
export async function saveToFile(
  document: MindflowDocument,
  preserved: readonly unknown[],
  options: { existingHandle?: unknown; saveAs?: boolean } = {},
): Promise<SaveResult> {
  const contents = serializeDocument(document, preserved);
  const suggestedName = toFileName(document.meta.name);

  if (supportsFileSystemAccess()) {
    const w = window as unknown as FilePickerWindow;
    let handle = options.saveAs ? undefined : (options.existingHandle as FileSystemFileHandleLike | undefined);

    if (handle) {
      // Permission can lapse between sessions or be revoked by the user.
      const state = await handle.queryPermission?.({ mode: 'readwrite' });
      if (state !== 'granted') {
        const requested = await handle.requestPermission?.({ mode: 'readwrite' });
        if (requested !== 'granted') handle = undefined;
      }
    }

    if (!handle) {
      handle = await w.showSaveFilePicker?.({ suggestedName, types: PICKER_TYPES });
    }
    if (!handle) throw new Error('No file was chosen.');

    const writable = await handle.createWritable();
    await writable.write(contents);
    await writable.close();

    return { handle, name: handle.name, viaDownload: false };
  }

  downloadBlob(new Blob([contents], { type: FILE_MIME_TYPE }), suggestedName);
  return { name: suggestedName, viaDownload: true };
}

/** Opens a board, returning null when the user cancels the picker. */
export async function openFromFile(): Promise<{ result: LoadResult; handle?: unknown; name: string } | null> {
  if (supportsFileSystemAccess()) {
    const w = window as unknown as FilePickerWindow;
    let handles: FileSystemFileHandleLike[] | undefined;
    try {
      handles = await w.showOpenFilePicker?.({ types: PICKER_TYPES, multiple: false });
    } catch (error) {
      // The picker throws AbortError when dismissed, which is not a failure.
      if ((error as Error).name === 'AbortError') return null;
      throw error;
    }
    const handle = handles?.[0];
    if (!handle) return null;

    const file = await handle.getFile();
    return { result: loadDocument(await file.text()), handle, name: file.name };
  }

  const file = await pickFileViaInput();
  if (!file) return null;
  return { result: loadDocument(await file.text()), name: file.name };
}

/** Reads a File (from drag-drop or an input) as a board. */
export async function readBoardFile(file: File): Promise<LoadResult> {
  return loadDocument(await file.text());
}

// ---------------------------------------------------------------------------
// Fallback plumbing
// ---------------------------------------------------------------------------

/**
 * Triggers a browser download.
 *
 * The object URL is revoked on a timer rather than immediately: revoking
 * synchronously after `click()` races the download in some browsers and produces
 * an empty file.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens a hidden `<input type="file">` and resolves with the chosen file. */
export function pickFileViaInput(accept = `${FILE_EXTENSION},.json,application/json`): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';

    let settled = false;
    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    // There is no cancel event for file inputs in most browsers; window focus
    // returning without a change event is the conventional proxy for it.
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(input.files?.[0] ?? null), 400),
      { once: true },
    );

    document.body.append(input);
    input.click();
  });
}

/** Prompts for an image file. Used by the image tool and the paste handler. */
export function pickImageFile(): Promise<File | null> {
  return pickFileViaInput('image/png,image/jpeg,image/gif,image/webp,image/svg+xml');
}
