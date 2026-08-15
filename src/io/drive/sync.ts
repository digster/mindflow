/**
 * Drive board storage.
 *
 * Sits above `api.ts` and implements the actual workflow: find (or create) the
 * MindFlow folder, remember it, and list, open and save boards inside it.
 *
 * ---------------------------------------------------------------------------
 * Folder resolution
 * ---------------------------------------------------------------------------
 * The folder ID is cached in localStorage so the app returns to the same place
 * every session — the "single folder we last used" the design calls for. But a
 * cached ID can go stale: the user may have deleted or trashed the folder, or
 * revoked access. So the ID is always verified before use, and resolution walks
 * a fallback chain:
 *
 *   1. Stored ID, if it still resolves and is not trashed.
 *   2. A folder of the right name that this app previously created. (Under
 *      `drive.file` the search can only ever see our own folders, which is
 *      exactly the recovery we want and no more.)
 *   3. Create a new one.
 *
 * Step 2 is what stops a cleared browser profile from scattering duplicate
 * "MindFlow" folders across someone's Drive.
 */

import type { MindflowDocument } from '../../model/types.ts';
import { CURRENT_SCHEMA_VERSION, FILE_EXTENSION } from '../../model/types.ts';
import type { LoadResult } from '../../model/document.ts';
import { loadDocument, serializeDocument } from '../../model/document.ts';
import { toFileName } from '../localFile.ts';
import type { DriveFile } from './api.ts';
import {
  createFile,
  createFolder,
  downloadFile,
  findAppFolder,
  getFileMetadata,
  listFilesInFolder,
  trashFile,
  updateFile,
} from './api.ts';

declare const __DRIVE_FOLDER_NAME__: string;

const FOLDER_ID_STORAGE_KEY = 'mindflow.drive.folderId';
const FOLDER_NAME_STORAGE_KEY = 'mindflow.drive.folderName';

/** App-private metadata attached to every board we upload. */
const APP_PROPERTY_KEYS = {
  schemaVersion: 'mindflowSchemaVersion',
  boardId: 'mindflowBoardId',
} as const;

export function defaultFolderName(): string {
  return typeof __DRIVE_FOLDER_NAME__ === 'string' ? __DRIVE_FOLDER_NAME__ : 'MindFlow';
}

export interface DriveFolder {
  id: string;
  name: string;
  /** True when this call created the folder, so the UI can say where it went. */
  created: boolean;
}

/** The remembered folder, without contacting Drive. */
export function getStoredFolder(): { id: string; name: string } | null {
  const id = localStorage.getItem(FOLDER_ID_STORAGE_KEY);
  if (!id) return null;
  return { id, name: localStorage.getItem(FOLDER_NAME_STORAGE_KEY) ?? defaultFolderName() };
}

function rememberFolder(folder: DriveFile): void {
  localStorage.setItem(FOLDER_ID_STORAGE_KEY, folder.id);
  localStorage.setItem(FOLDER_NAME_STORAGE_KEY, folder.name);
}

export function forgetFolder(): void {
  localStorage.removeItem(FOLDER_ID_STORAGE_KEY);
  localStorage.removeItem(FOLDER_NAME_STORAGE_KEY);
}

/**
 * Resolves the working folder, creating it if necessary.
 *
 * See the fallback chain at the top of this file.
 */
export async function resolveFolder(name = defaultFolderName()): Promise<DriveFolder> {
  const stored = getStoredFolder();

  if (stored) {
    const metadata = await getFileMetadata(stored.id);
    if (metadata && !metadata.trashed) {
      // Pick up a rename the user made in Drive rather than fighting it.
      if (metadata.name !== stored.name) rememberFolder(metadata);
      return { id: metadata.id, name: metadata.name, created: false };
    }
    // Gone, trashed, or no longer ours.
    forgetFolder();
  }

  const existing = await findAppFolder(name);
  if (existing) {
    rememberFolder(existing);
    return { id: existing.id, name: existing.name, created: false };
  }

  const created = await createFolder(name);
  rememberFolder(created);
  return { id: created.id, name: created.name, created: true };
}

export interface DriveBoard {
  id: string;
  name: string;
  modifiedTime: string | null;
  /** Bytes, when Drive reported a size. */
  size: number | null;
  /** True when the file carries MindFlow's own app metadata. */
  isMindflowBoard: boolean;
}

/**
 * Lists boards in the folder.
 *
 * Filters to plausible board files rather than showing everything: the folder
 * may contain other things the user put there, and offering to open a PDF as a
 * board would be unhelpful. Sub-folders are excluded outright.
 */
export async function listBoards(folderId: string): Promise<DriveBoard[]> {
  const files = await listFilesInFolder(folderId);

  return files
    .filter((file) => {
      if (file.mimeType === 'application/vnd.google-apps.folder') return false;
      const tagged = Boolean(file.appProperties?.[APP_PROPERTY_KEYS.schemaVersion]);
      const named = file.name.endsWith(FILE_EXTENSION) || file.name.endsWith('.json');
      return tagged || named;
    })
    .map((file) => ({
      id: file.id,
      name: file.name,
      modifiedTime: file.modifiedTime ?? null,
      size: file.size ? Number(file.size) : null,
      isMindflowBoard: Boolean(file.appProperties?.[APP_PROPERTY_KEYS.schemaVersion]),
    }));
}

export interface OpenedBoard {
  result: LoadResult;
  fileId: string;
  name: string;
}

export async function openBoard(fileId: string, name: string): Promise<OpenedBoard> {
  const contents = await downloadFile(fileId);
  return { result: loadDocument(contents), fileId, name };
}

export interface SavedBoard {
  fileId: string;
  name: string;
  /** True when this created a new file rather than overwriting one. */
  created: boolean;
}

/**
 * Saves a board to Drive.
 *
 * With a `fileId` this overwrites in place, which is what makes Cmd+S on a
 * Drive-backed board behave like a normal save. Without one it creates a new
 * file in the folder.
 *
 * A stale `fileId` — the user deleted the board from Drive in another tab —
 * falls back to creating a new file rather than failing, so work is never lost
 * to a vanished target.
 */
export async function saveBoard(
  document: MindflowDocument,
  preserved: readonly unknown[],
  options: { folderId: string; fileId?: string; name?: string },
): Promise<SavedBoard> {
  const contents = serializeDocument(document, preserved);
  const name = options.name ?? toFileName(document.meta.name);
  const appProperties = {
    [APP_PROPERTY_KEYS.schemaVersion]: CURRENT_SCHEMA_VERSION,
    [APP_PROPERTY_KEYS.boardId]: document.id,
  };

  if (options.fileId) {
    const existing = await getFileMetadata(options.fileId);
    if (existing && !existing.trashed) {
      const updated = await updateFile(options.fileId, contents, { name, appProperties });
      return { fileId: updated.id, name: updated.name, created: false };
    }
  }

  const created = await createFile({
    name,
    contents,
    folderId: options.folderId,
    appProperties,
  });
  return { fileId: created.id, name: created.name, created: true };
}

/** Moves a board to Drive's trash. Recoverable by the user from Drive itself. */
export async function deleteBoard(fileId: string): Promise<void> {
  await trashFile(fileId);
}

/** A `https://drive.google.com` link to the folder, for the UI to offer. */
export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}
