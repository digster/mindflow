/**
 * Image decode cache.
 *
 * Drawing to a canvas is synchronous, but decoding an image is not. This cache
 * bridges the two: it kicks off decodes in the background and hands the renderer
 * a plain `Map` it can read without awaiting anything. An element whose bitmap
 * has not arrived yet draws a placeholder for a frame or two, then appears when
 * the decode completes and triggers a redraw.
 *
 * Entries are keyed by `fileId` (a content hash), so the same image pasted into
 * a board ten times decodes once.
 */

import type { MindflowDocument } from '../model/types.ts';

export class ImageCache {
  private decoded = new Map<string, CanvasImageSource>();
  private pending = new Set<string>();
  private failed = new Set<string>();

  constructor(private readonly onDecoded: () => void) {}

  /** The map handed to shape modules via `RenderContext.images`. */
  get images(): Map<string, CanvasImageSource> {
    return this.decoded;
  }

  /**
   * Ensures every image referenced by the document is decoded or in flight.
   *
   * Safe to call on every document change: already-decoded and already-failed
   * IDs are skipped, so the common case costs one set lookup per image.
   */
  sync(document: MindflowDocument): void {
    for (const element of document.elements) {
      if (element.type !== 'image') continue;
      const { fileId } = element;
      if (this.decoded.has(fileId) || this.pending.has(fileId) || this.failed.has(fileId)) continue;

      const file = document.files[fileId];
      if (!file) {
        // Dangling reference. Validation already reported it; mark it failed so
        // we do not retry on every frame.
        this.failed.add(fileId);
        continue;
      }

      this.pending.add(fileId);
      void this.decode(fileId, file.dataUri);
    }
  }

  private async decode(fileId: string, dataUri: string): Promise<void> {
    try {
      // `createImageBitmap` is faster and, crucially, decodes off the main
      // thread — pasting a large photo does not freeze the canvas.
      if (typeof createImageBitmap === 'function') {
        const response = await fetch(dataUri);
        const blob = await response.blob();
        this.decoded.set(fileId, await createImageBitmap(blob));
      } else {
        this.decoded.set(fileId, await decodeViaImageElement(dataUri));
      }
      this.onDecoded();
    } catch {
      this.failed.add(fileId);
      // Still repaint: the element should switch from "loading" to "missing".
      this.onDecoded();
    } finally {
      this.pending.delete(fileId);
    }
  }

  /** Drops bitmaps no longer referenced, releasing their memory. */
  prune(document: MindflowDocument): void {
    const live = new Set(
      document.elements.filter((el) => el.type === 'image').map((el) => el.fileId),
    );
    for (const [fileId, image] of this.decoded) {
      if (live.has(fileId)) continue;
      // ImageBitmap holds GPU-side memory that is not reclaimed by GC alone.
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
      this.decoded.delete(fileId);
    }
    for (const fileId of this.failed) if (!live.has(fileId)) this.failed.delete(fileId);
  }

  clear(): void {
    for (const image of this.decoded.values()) {
      if (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) image.close();
    }
    this.decoded.clear();
    this.pending.clear();
    this.failed.clear();
  }
}

function decodeViaImageElement(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Image failed to decode'));
    image.src = dataUri;
  });
}
