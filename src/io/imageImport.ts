/**
 * Bringing images into a board.
 *
 * Images are stored as data URIs in the document's `files` map, keyed by the
 * SHA-256 of their bytes. Content addressing gives automatic deduplication —
 * pasting the same screenshot into ten boards, or ten times into one board,
 * stores exactly one copy — and makes it verifiable that a `fileId` really
 * identifies its content.
 */

import type { EmbeddedFile, ImageElement, MindflowDocument, Point } from '../model/types.ts';
import { getDefinition } from '../model/registry.ts';
import { topZIndex } from '../store/commands.ts';

/**
 * Largest image accepted, in bytes.
 *
 * Base64 inflates by about a third, and the whole board is serialised into a
 * single JSON file that has to be parsed in one go. A 12 MB source becomes
 * roughly 16 MB of text, which is already an unpleasant file to open.
 */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Largest pixel dimension before an image is downscaled on import. */
const MAX_IMAGE_DIMENSION = 2400;

/** Default on-canvas size for an imported image, in scene units. */
const DEFAULT_IMPORT_SIZE = 400;

export class ImageImportError extends Error {
  override readonly name = 'ImageImportError';
}

/**
 * SHA-256 of the given bytes, hex-encoded.
 *
 * `crypto.subtle` requires a secure context. `file://` qualifies in Chrome but
 * not universally, so a non-cryptographic fallback keeps image import working
 * everywhere. The hash is only used for deduplication and identity within one
 * document, never for security, so the weaker fallback is acceptable — and it is
 * marked in the key so the difference is never invisible.
 */
async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // FNV-1a over the bytes, plus the length. Collision-resistant enough to
  // distinguish the handful of images in one document.
  const view = new Uint8Array(bytes);
  let hash = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    hash ^= view[i] as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv-${hash.toString(16)}-${view.length.toString(16)}`;
}

interface DecodedImage {
  dataUri: string;
  mimeType: string;
  byteLength: number;
  naturalWidth: number;
  naturalHeight: number;
}

/**
 * Decodes a file, downscaling it if it exceeds {@link MAX_IMAGE_DIMENSION}.
 *
 * Downscaling on import rather than on render is deliberate: a 6000px photo
 * displayed in a 300px box would otherwise cost its full memory footprint
 * forever, and be embedded at full size in every saved copy of the board.
 *
 * SVG is passed through untouched — it is already resolution-independent, and
 * rasterising it would destroy the reason to use it.
 */
async function decodeImage(file: File): Promise<DecodedImage> {
  if (file.size > MAX_IMAGE_BYTES) {
    throw new ImageImportError(
      `That image is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB, because images are embedded directly in the board file.`,
    );
  }

  const buffer = await file.arrayBuffer();
  const originalDataUri = await blobToDataUri(file);

  if (file.type === 'image/svg+xml') {
    const size = await measureImage(originalDataUri);
    return {
      dataUri: originalDataUri,
      mimeType: file.type,
      byteLength: buffer.byteLength,
      naturalWidth: size.width,
      naturalHeight: size.height,
    };
  }

  const size = await measureImage(originalDataUri);
  const longest = Math.max(size.width, size.height);

  if (longest <= MAX_IMAGE_DIMENSION) {
    return {
      dataUri: originalDataUri,
      mimeType: file.type || 'image/png',
      byteLength: buffer.byteLength,
      naturalWidth: size.width,
      naturalHeight: size.height,
    };
  }

  const scale = MAX_IMAGE_DIMENSION / longest;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(size.width * scale);
  canvas.height = Math.round(size.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageImportError('Could not process the image.');

  const bitmap = await createImageBitmap(file);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  // PNG for anything with transparency, JPEG otherwise — re-encoding a photo as
  // PNG can easily quadruple its size.
  const keepAlpha = file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/gif';
  const mimeType = keepAlpha ? 'image/png' : 'image/jpeg';
  const dataUri = canvas.toDataURL(mimeType, 0.9);

  return {
    dataUri,
    mimeType,
    byteLength: Math.round((dataUri.length * 3) / 4),
    naturalWidth: canvas.width,
    naturalHeight: canvas.height,
  };
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new ImageImportError('Could not read the image file.'));
    reader.readAsDataURL(blob);
  });
}

function measureImage(dataUri: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () =>
      // An SVG without intrinsic dimensions reports 0; fall back to a sane box.
      resolve({ width: image.naturalWidth || 300, height: image.naturalHeight || 300 });
    image.onerror = () => reject(new ImageImportError('That file is not an image this browser can read.'));
    image.src = dataUri;
  });
}

export interface ImportedImage {
  element: ImageElement;
  fileId: string;
  file: EmbeddedFile;
  /** True when an identical image was already embedded and was reused. */
  deduplicated: boolean;
}

/**
 * Prepares an image for insertion at `at`, centred on that point.
 *
 * Returns the element and the file entry; the caller executes the command, so
 * insertion stays a single undoable step alongside any other changes.
 */
export async function prepareImageImport(
  document: MindflowDocument,
  file: File,
  at: Point,
): Promise<ImportedImage> {
  const decoded = await decodeImage(file);
  const bytes = await (await fetch(decoded.dataUri)).arrayBuffer();
  const fileId = await hashBytes(bytes);

  const existing = document.files[fileId];
  const embedded: EmbeddedFile = existing ?? {
    mimeType: decoded.mimeType,
    dataUri: decoded.dataUri,
    byteLength: decoded.byteLength,
    createdAt: new Date().toISOString(),
  };

  // Fit into a sensible default box while preserving aspect ratio.
  const aspect = decoded.naturalWidth / Math.max(decoded.naturalHeight, 1);
  let width = DEFAULT_IMPORT_SIZE;
  let height = DEFAULT_IMPORT_SIZE / aspect;
  if (height > DEFAULT_IMPORT_SIZE) {
    height = DEFAULT_IMPORT_SIZE;
    width = DEFAULT_IMPORT_SIZE * aspect;
  }

  const element = getDefinition<ImageElement>('image').create({
    x: at.x - width / 2,
    y: at.y - height / 2,
    width,
    height,
    zIndex: topZIndex(document),
    fileId,
    naturalWidth: decoded.naturalWidth,
    naturalHeight: decoded.naturalHeight,
    objectFit: 'fill',
  });

  return { element, fileId, file: embedded, deduplicated: Boolean(existing) };
}

/** Picks the first image out of a clipboard or drag-drop payload. */
export function findImageFile(items: DataTransferItemList | FileList | null): File | null {
  if (!items) return null;

  if (items instanceof FileList) {
    for (const file of items) if (file.type.startsWith('image/')) return file;
    return null;
  }

  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}
