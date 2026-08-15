/**
 * Thin wrapper over the Google Drive v3 REST API.
 *
 * Uses `fetch` against the REST endpoints directly rather than Google's
 * `gapi` client library. The library would be another script fetched from a CDN
 * — which the single-file, works-offline design specifically avoids — and the
 * handful of endpoints MindFlow needs are simple enough that a client library
 * adds indirection rather than convenience.
 *
 * Every call goes through {@link driveFetch}, which owns the one piece of shared
 * behaviour that matters: an expired token is refreshed and the request retried
 * exactly once, so a session crossing the hour boundary does not surface an
 * error to the user.
 */

import { DriveAuthError, getAccessToken, invalidateToken } from './auth.ts';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export class DriveApiError extends Error {
  override readonly name = 'DriveApiError';
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  createdTime?: string;
  size?: string;
  trashed?: boolean;
  /** Private per-application metadata. Invisible to other apps. */
  appProperties?: Record<string, string>;
}

/**
 * Performs an authorised Drive request.
 *
 * On 401 the cached token is dropped and the request is retried once with a
 * freshly-requested (silent, where possible) token.
 */
async function driveFetch(url: string, init: RequestInit = {}, retrying = false): Promise<Response> {
  const token = await getAccessToken(!retrying);

  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });

  if (response.status === 401 && !retrying) {
    invalidateToken();
    return driveFetch(url, init, true);
  }

  if (!response.ok) {
    let detail: unknown;
    let message = `Drive request failed (${response.status}).`;
    try {
      detail = await response.json();
      const error = (detail as { error?: { message?: string } }).error;
      if (error?.message) message = error.message;
    } catch {
      // Non-JSON error body; the status-derived message stands.
    }

    if (response.status === 403) {
      message = `${message} This usually means the Drive API is not enabled for your Google Cloud project, or the daily quota is exhausted.`;
    }
    throw new DriveApiError(message, response.status, detail);
  }

  return response;
}

/** Fields requested for board listings. Kept minimal to reduce payload size. */
const FILE_FIELDS = 'id,name,mimeType,modifiedTime,createdTime,size,trashed,appProperties';

/** Fetches a file's metadata, or null when it is gone. */
export async function getFileMetadata(fileId: string): Promise<DriveFile | null> {
  try {
    const response = await driveFetch(
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    );
    return (await response.json()) as DriveFile;
  } catch (error) {
    // 404 (deleted) and 403 (access lost, e.g. the grant was revoked) are both
    // "this file is no longer available to us", which callers handle the same way.
    if (error instanceof DriveApiError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

/**
 * Escapes a value for a Drive query string.
 *
 * Drive's query syntax uses single-quoted literals, so a folder or board name
 * containing an apostrophe would otherwise break the query — or, worse, alter
 * its meaning.
 */
function escapeQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** Lists non-trashed children of a folder, newest first. */
export async function listFilesInFolder(folderId: string, pageSize = 100): Promise<DriveFile[]> {
  const query = `'${escapeQueryValue(folderId)}' in parents and trashed = false`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}` +
    `&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}` +
    `&orderBy=modifiedTime desc&pageSize=${pageSize}&spaces=drive`;

  const response = await driveFetch(url);
  const data = (await response.json()) as { files?: DriveFile[] };
  return data.files ?? [];
}

/** Creates a folder and returns it. */
export async function createFolder(name: string, parentId?: string): Promise<DriveFile> {
  const body: Record<string, unknown> = { name, mimeType: FOLDER_MIME_TYPE };
  if (parentId) body.parents = [parentId];

  const response = await driveFetch(`${DRIVE_API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await response.json()) as DriveFile;
}

/**
 * Finds a folder this app created, by name.
 *
 * Under `drive.file` this only ever matches folders MindFlow itself created,
 * which is precisely the intent — it recovers our own folder after the stored ID
 * is lost, without being able to see anything else.
 */
export async function findAppFolder(name: string): Promise<DriveFile | null> {
  const query =
    `name = '${escapeQueryValue(name)}' and mimeType = '${FOLDER_MIME_TYPE}' and trashed = false`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}` +
    `&fields=${encodeURIComponent(`files(${FILE_FIELDS})`)}&pageSize=10&spaces=drive`;

  const response = await driveFetch(url);
  const data = (await response.json()) as { files?: DriveFile[] };
  return data.files?.[0] ?? null;
}

/**
 * Builds a multipart/related body: JSON metadata followed by the file content.
 *
 * Drive's `uploadType=multipart` requires this exact structure. It is assembled
 * by hand because `FormData` produces `multipart/form-data`, which Drive rejects.
 */
function buildMultipartBody(
  metadata: Record<string, unknown>,
  contents: string,
  contentType: string,
): { body: string; boundary: string } {
  const boundary = `mindflow-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${contentType}; charset=UTF-8\r\n\r\n` +
    `${contents}\r\n` +
    `--${boundary}--`;
  return { body, boundary };
}

export interface UploadOptions {
  name: string;
  contents: string;
  folderId: string;
  contentType?: string;
  /** Private app metadata, e.g. the schema version. */
  appProperties?: Record<string, string>;
}

/** Creates a new file in the folder. */
export async function createFile(options: UploadOptions): Promise<DriveFile> {
  const metadata: Record<string, unknown> = {
    name: options.name,
    parents: [options.folderId],
  };
  if (options.appProperties) metadata.appProperties = options.appProperties;

  const { body, boundary } = buildMultipartBody(
    metadata,
    options.contents,
    options.contentType ?? 'application/json',
  );

  const response = await driveFetch(
    `${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    },
  );
  return (await response.json()) as DriveFile;
}

/**
 * Overwrites an existing file's contents, and optionally renames it.
 *
 * Metadata and content are separate requests: `uploadType=media` replaces only
 * the bytes, and mixing a rename into it would require the multipart form again
 * for no benefit.
 */
export async function updateFile(
  fileId: string,
  contents: string,
  options: { name?: string; appProperties?: Record<string, string>; contentType?: string } = {},
): Promise<DriveFile> {
  if (options.name || options.appProperties) {
    const metadata: Record<string, unknown> = {};
    if (options.name) metadata.name = options.name;
    if (options.appProperties) metadata.appProperties = options.appProperties;

    await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
  }

  const response = await driveFetch(
    `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': `${options.contentType ?? 'application/json'}; charset=UTF-8` },
      body: contents,
    },
  );
  return (await response.json()) as DriveFile;
}

/** Downloads a file's contents as text. */
export async function downloadFile(fileId: string): Promise<string> {
  const response = await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`);
  return response.text();
}

/**
 * Moves a file to the trash.
 *
 * Trashing rather than deleting is deliberate: the user can recover the board
 * from Drive's own trash, and an app operating under a minimal permission grant
 * should not be able to destroy data irrecoverably.
 */
export async function trashFile(fileId: string): Promise<void> {
  await driveFetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

export { DriveAuthError };
