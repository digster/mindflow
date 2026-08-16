/**
 * Application state.
 *
 * A deliberately small observable store: one state object, a set of listeners,
 * and a single `execute()` entry point for document changes. No framework, no
 * reactivity system — at this size those would add more concepts than they
 * remove.
 *
 * ---------------------------------------------------------------------------
 * What lives here versus in the document
 * ---------------------------------------------------------------------------
 * The document is what gets saved. Everything else is session state: which
 * elements are selected, which tool is active, where the camera is. Keeping the
 * two apart is what stops a pan gesture from marking the board dirty or landing
 * on the undo stack.
 *
 * The viewport is the interesting case. It is *stored* in the file (so a board
 * reopens where you left it) but it is not *document state* (panning is not an
 * edit). It therefore lives in the store and is copied into the document only at
 * save time.
 */

import type {
  ElementId,
  EmbeddedFile,
  FileId,
  MindflowDocument,
  MindflowElement,
  Viewport,
} from '../model/types.ts';
import { DEFAULT_VIEWPORT, createDocument } from '../model/defaults.ts';
import type { LoadResult } from '../model/document.ts';
import type { Command } from './commands.ts';
import { applyCommand, expandSelectionToGroups, needsReindex, reindexZ } from './commands.ts';
import { History } from './history.ts';

export type ToolId =
  | 'select'
  | 'pan'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'draw'
  | 'text'
  | 'sticky'
  | 'image'
  | 'diamond'
  | 'eraser';

/** Where the current board came from, so "Save" can mean "save back to there". */
export type BoardOrigin =
  | { kind: 'new' }
  | { kind: 'local'; name: string; handle?: unknown }
  | { kind: 'drive'; fileId: string; name: string };

export interface AppState {
  document: MindflowDocument;
  /** Unknown-type elements carried through from load; see `LoadResult.preserved`. */
  preserved: unknown[];
  selection: Set<ElementId>;
  activeTool: ToolId;
  /** Element currently open in the text editor overlay, if any. */
  editingId: ElementId | null;
  viewport: Viewport;
  /** True when there are unsaved changes. */
  dirty: boolean;
  origin: BoardOrigin;
}

export type StoreListener = (state: AppState, reason: ChangeReason) => void;

/**
 * Why the state changed.
 *
 * Subscribers care about different reasons: the renderer redraws on almost
 * anything, autosave only on `document`, and the toolbar only on `selection`
 * or `tool`. Passing the reason avoids waking every subscriber for every mouse
 * move during a pan.
 */
export type ChangeReason =
  | 'document'
  | 'selection'
  | 'tool'
  | 'viewport'
  | 'editing'
  | 'load'
  | 'origin'
  | 'saved';

export class Store {
  private state: AppState;
  private listeners = new Set<StoreListener>();
  readonly history = new History();

  constructor(document: MindflowDocument = createDocument()) {
    this.state = {
      document,
      preserved: [],
      selection: new Set(),
      activeTool: 'select',
      editingId: null,
      viewport: { ...document.viewport },
      dirty: false,
      origin: { kind: 'new' },
    };
  }

  getState(): Readonly<AppState> {
    return this.state;
  }

  get document(): MindflowDocument {
    return this.state.document;
  }

  get viewport(): Viewport {
    return this.state.viewport;
  }

  subscribe(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(reason: ChangeReason): void {
    // Iterate a copy: a listener that unsubscribes during dispatch would
    // otherwise mutate the set mid-iteration.
    for (const listener of [...this.listeners]) listener(this.state, reason);
  }

  // -------------------------------------------------------------------------
  // Document mutation
  // -------------------------------------------------------------------------

  /**
   * The single entry point for changing the document.
   *
   * Applies the command, records it for undo, marks the board dirty and
   * notifies. Returns false when the command was a no-op.
   *
   * `transient` applies the change without recording history — used for live
   * previews during a gesture, where only the final state should be undoable.
   */
  execute(command: Command, transient = false): boolean {
    const next = applyCommand(this.state.document, command);
    if (next === this.state.document) return false;

    this.state.document = next;
    if (!transient) this.history.push(command);
    this.state.dirty = true;

    // Fractional z-indices can converge after enough insertions in one spot.
    // Checking here means the repair happens automatically, off the hot path of
    // any individual reorder.
    if (needsReindex(next)) {
      const repair = reindexZ(next);
      if (repair.patches.length > 0) {
        this.state.document = applyCommand(this.state.document, repair);
      }
    }

    this.emit('document');
    return true;
  }

  undo(): boolean {
    const next = this.history.undo(this.state.document);
    if (!next) return false;
    this.state.document = next;
    this.state.dirty = true;
    this.pruneSelection();
    this.emit('document');
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.state.document);
    if (!next) return false;
    this.state.document = next;
    this.state.dirty = true;
    this.pruneSelection();
    this.emit('document');
    return true;
  }

  /**
   * Drops selected IDs that no longer exist.
   *
   * Undoing a creation removes the element while it is still selected; without
   * this, the selection outline would be drawn around a phantom.
   */
  private pruneSelection(): void {
    const ids = new Set(this.state.document.elements.map((el) => el.id));
    for (const id of this.state.selection) {
      if (!ids.has(id)) this.state.selection.delete(id);
    }
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * Replaces the selection.
   *
   * Always expanded to whole groups: selecting any member selects its siblings,
   * which is what makes grouping behave like a single object even though no
   * group object exists.
   */
  setSelection(ids: Iterable<ElementId>): void {
    const expanded = expandSelectionToGroups(this.state.document, ids);
    if (sameSet(expanded, this.state.selection)) return;
    this.state.selection = expanded;
    this.emit('selection');
  }

  addToSelection(ids: Iterable<ElementId>): void {
    this.setSelection([...this.state.selection, ...ids]);
  }

  toggleSelection(id: ElementId): void {
    const next = new Set(this.state.selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.setSelection(next);
  }

  clearSelection(): void {
    if (this.state.selection.size === 0) return;
    this.state.selection = new Set();
    this.emit('selection');
  }

  isSelected(id: ElementId): boolean {
    return this.state.selection.has(id);
  }

  /** Selected elements, in paint order. */
  selectedElements(): MindflowElement[] {
    return this.state.document.elements.filter((el) => this.state.selection.has(el.id));
  }

  selectedIds(): ElementId[] {
    return [...this.state.selection];
  }

  // -------------------------------------------------------------------------
  // Tool, editing, viewport
  // -------------------------------------------------------------------------

  setTool(tool: ToolId): void {
    if (this.state.activeTool === tool) return;
    this.state.activeTool = tool;
    // Switching tools ends any gesture, so the next edit starts a fresh undo step.
    this.history.breakCoalescing();
    this.emit('tool');
  }

  setEditing(id: ElementId | null): void {
    if (this.state.editingId === id) return;
    this.state.editingId = id;
    this.emit('editing');
  }

  setViewport(viewport: Viewport): void {
    const current = this.state.viewport;
    if (current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) {
      return;
    }
    this.state.viewport = viewport;
    // Note: no `dirty` flag. Panning and zooming are not edits.
    this.emit('viewport');
  }

  // -------------------------------------------------------------------------
  // Document lifecycle
  // -------------------------------------------------------------------------

  /** Replaces the whole document, e.g. after opening a file. */
  load(result: LoadResult, origin: BoardOrigin): void {
    this.state.document = result.document;
    this.state.preserved = result.preserved;
    this.state.selection = new Set();
    this.state.editingId = null;
    this.state.viewport = { ...result.document.viewport };
    this.state.dirty = false;
    this.state.origin = origin;
    this.history.clear();
    this.emit('load');
  }

  reset(name?: string): void {
    const document = createDocument(name);
    this.state.document = document;
    this.state.preserved = [];
    this.state.selection = new Set();
    this.state.editingId = null;
    this.state.viewport = { ...DEFAULT_VIEWPORT };
    this.state.dirty = false;
    this.state.origin = { kind: 'new' };
    this.history.clear();
    this.emit('load');
  }

  setOrigin(origin: BoardOrigin): void {
    this.state.origin = origin;
    this.emit('origin');
  }

  /** Flags unsaved changes without going through a command. */
  markDirty(): void {
    if (this.state.dirty) return;
    this.state.dirty = true;
    this.emit('document');
  }

  /**
   * Adds embedded assets to the document.
   *
   * Outside the command/undo system on purpose. The `files` map is
   * content-addressed and append-only: an entry is only ever added, never
   * modified or removed by an edit, so there is nothing for undo to reverse.
   * Keeping multi-megabyte data URIs out of undo patches also keeps history
   * cheap. Unreferenced entries are reported by `validateDocument` and dropped
   * on the next explicit save-as rather than being garbage-collected mid-edit.
   */
  addFiles(files: Record<FileId, EmbeddedFile>): void {
    const entries = Object.entries(files).filter(([id]) => !this.state.document.files[id]);
    if (entries.length === 0) return;

    this.state.document = {
      ...this.state.document,
      files: { ...this.state.document.files, ...Object.fromEntries(entries) },
    };
    this.state.dirty = true;
    this.emit('document');
  }

  /** Called after a successful save. Folds the live viewport into the document. */
  markSaved(origin?: BoardOrigin): void {
    this.state.document = { ...this.state.document, viewport: { ...this.state.viewport } };
    this.state.dirty = false;
    if (origin) this.state.origin = origin;
    this.emit('saved');
  }

  /** The document as it should be written to disk, with the live viewport folded in. */
  documentForSave(): MindflowDocument {
    return { ...this.state.document, viewport: { ...this.state.viewport } };
  }
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
