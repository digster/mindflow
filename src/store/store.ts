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
 *
 * ---------------------------------------------------------------------------
 * Workspaces
 * ---------------------------------------------------------------------------
 * A board holds several workspaces (format 2.0.0). The one on screen is *on
 * stage*: it is `state.document`, the same flat document every module has
 * always read, so none of them knows workspaces exist. The others are *parked*
 * in their entries of `state.workspaces`. A workspace's content is in exactly
 * one of those places; switching moves it, and nothing copies it. See
 * `model/workspaces.ts`.
 *
 * Each workspace has its own undo history, so Undo only ever changes the
 * workspace on screen. `history` always names the staged workspace's.
 *
 * Switching is like panning: it changes what is on screen, not the board, so
 * it neither dirties the board nor moves its edit time. Adding, renaming,
 * reordering, duplicating and deleting workspaces are edits, but none of them
 * goes on an undo stack: an undo stack belongs to one workspace, and these
 * change the list the stacks hang from. Deleting asks first in the app.
 */

import type {
  ElementId,
  EmbeddedFile,
  FileId,
  MindflowDocument,
  MindflowElement,
  Viewport,
  WorkspaceId,
} from '../model/types.ts';
import { DEFAULT_VIEWPORT, createDocument, newWorkspaceId } from '../model/defaults.ts';
import {
  cloneElements,
  clonePreserved,
  nextWorkspaceName,
  workspaceName,
  type StagedBoard,
  type WorkspaceContent,
  type WorkspaceEntry,
} from '../model/workspaces.ts';
import type { Command } from './commands.ts';
import { applyCommand, expandSelectionToGroups, needsReindex, reindexZ } from './commands.ts';
import { History } from './history.ts';

/**
 * The shape family: creation tools that drag out a box and produce a plain
 * closed shape.
 *
 * Every id is also an element type, which is what lets `beginBoxCreate` pass a
 * tool straight to `getDefinition`. Declaring the family ONCE matters more now
 * than it did with three shapes: the toolbar's flyout, the command palette and
 * the controller all derive from this array, so adding a type cannot leave one
 * of them behind. `app/commands.ts` carries a comment about exactly that drift —
 * `diamond` and `frame` were in the toolbar and the keyboard map but missing
 * from the palette for two releases.
 *
 * Order is the order the flyout presents them: flat shapes, then solids.
 */
export const SHAPE_TOOLS = [
  'rectangle',
  'ellipse',
  'diamond',
  'triangle',
  'pentagon',
  'hexagon',
  'star',
  'parallelogram',
  'cube',
  'cylinder',
  'cone',
  'pyramid',
] as const;

export type ShapeToolId = (typeof SHAPE_TOOLS)[number];

/** How many of {@link SHAPE_TOOLS} are flat; the rest are solids. */
export const FLAT_SHAPE_COUNT = 8;

export function isShapeTool(tool: string): tool is ShapeToolId {
  return (SHAPE_TOOLS as readonly string[]).includes(tool);
}

export type ToolId =
  | 'select'
  | 'pan'
  | ShapeToolId
  | 'line'
  | 'arrow'
  | 'draw'
  | 'text'
  | 'sticky'
  | 'image'
  | 'frame'
  | 'table'
  | 'eraser';

/** Where the current board came from, so "Save" can mean "save back to there". */
export type BoardOrigin =
  | { kind: 'new' }
  | { kind: 'local'; name: string; handle?: unknown }
  | { kind: 'drive'; fileId: string; name: string };

export interface AppState {
  /** The board, seen through the workspace on stage. */
  document: MindflowDocument;
  /** The staged workspace's unknown-type elements; see `LoadResult.preserved`. */
  preserved: readonly unknown[];
  /**
   * Every workspace of the board, in order. The staged one's entry has
   * `parked: null`; its content is `document`. Replaced, never mutated.
   */
  workspaces: readonly WorkspaceEntry[];
  /** The workspace on stage. */
  activeWorkspaceId: WorkspaceId;
  selection: Set<ElementId>;
  activeTool: ToolId;
  /** Element currently open in the text editor overlay, if any. */
  editingId: ElementId | null;
  viewport: Viewport;
  /** True when there are unsaved changes. */
  dirty: boolean;
  origin: BoardOrigin;
}

/**
 * Which board state a save is writing. Taken at the moment the save snapshots
 * the board, and handed back to {@link Store.completeSave} when it lands.
 */
export interface SaveTicket {
  readonly boardId: string;
  /**
   * Which *instance* of a board was on screen. Every load and every new board
   * starts a new one, even when the same board id is reopened.
   */
  readonly generation: number;
  /** Counts every change that makes the board dirty. */
  readonly revision: number;
}

/**
 * The unsaved-changes flag and the edit time at one moment, for
 * {@link Store.restoreDirty}. Only the store reads the fields.
 */
export interface DirtyCheckpoint {
  readonly dirty: boolean;
  /** `meta.updatedAt`, which every command moves, transient ones included. */
  readonly updatedAt: string;
  readonly generation: number;
  readonly settled: number;
}

/**
 * What a landed save recorded. See {@link Store.completeSave}.
 *
 * - `clean`: the board on screen is exactly what was written, and is now saved.
 * - `edited`: the board on screen changed while the save ran. It keeps its
 *   unsaved changes but now saves back to where the file was written.
 * - `left-as-saved`: the user moved to another board, which was not touched.
 *   The board that was written was left exactly as written.
 * - `left`: the user moved to another board, which was not touched. The board
 *   that was written may have changed before it was left, or it cannot be told.
 */
export type SaveOutcome = 'clean' | 'edited' | 'left-as-saved' | 'left';

/** One row of the workspace list, as the switcher shows it. */
export interface WorkspaceSummary {
  id: WorkspaceId;
  name: string;
  /** Elements in the workspace, unknown types included. */
  elementCount: number;
  /** True for the workspace on screen. */
  active: boolean;
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
  | 'saved'
  /** A different workspace is on stage: switched to, added, duplicated, or the staged one deleted. */
  | 'workspace';

export class Store {
  private state: AppState;
  private listeners = new Set<StoreListener>();
  /** One undo history per workspace. See {@link history}. */
  private histories = new Map<WorkspaceId, History>();
  /** Top-level fields this version does not know, held for the next save. */
  private extra: Record<string, unknown> = {};

  // Save bookkeeping, for `completeSave`. Nothing renders these counters, so
  // they stay out of `AppState`. The generation never repeats, so a ticket can
  // never be mistaken for a later board instance.
  private generation = 0;
  private revision = 0;
  /** The board most recently replaced by a load or a new board, as it was then. */
  private departed: SaveTicket | null = null;
  /**
   * Counts everything the dirty flag answers for *except* transient edits:
   * recorded commands, undo, redo, saves and an explicit `markDirty`. A
   * {@link DirtyCheckpoint} holds only while this is unchanged.
   */
  private settled = 0;

  constructor(document: MindflowDocument = createDocument()) {
    const workspace = firstWorkspace();
    this.state = {
      document,
      preserved: [],
      workspaces: [workspace],
      activeWorkspaceId: workspace.id,
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

  /**
   * The undo history of the workspace on stage.
   *
   * A getter, so the toolbar, the command palette and the controller keep
   * calling `store.history` as they always have and always reach the history
   * of what is on screen. Created on first use, which is also how a workspace
   * that was never staged costs nothing.
   */
  get history(): History {
    const id = this.state.activeWorkspaceId;
    let history = this.histories.get(id);
    if (!history) {
      history = new History();
      this.histories.set(id, history);
    }
    return history;
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
    if (!transient) {
      this.history.push(command);
      this.settled++;
    }
    this.markEdited();

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
    this.settled++;
    this.markEdited();
    this.pruneSelection();
    this.emit('document');
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.state.document);
    if (!next) return false;
    this.state.document = next;
    this.settled++;
    this.markEdited();
    this.pruneSelection();
    this.emit('document');
    return true;
  }

  /**
   * Records an edit: the board is dirty, and any save already in flight is
   * now writing an older version of it.
   */
  private markEdited(): void {
    this.state.dirty = true;
    this.revision++;
  }

  /** Captures the unsaved-changes flag and the edit time, for {@link restoreDirty}. */
  dirtyCheckpoint(): DirtyCheckpoint {
    return {
      dirty: this.state.dirty,
      updatedAt: this.state.document.meta.updatedAt,
      generation: this.generation,
      settled: this.settled,
    };
  }

  /**
   * Puts the unsaved-changes flag back as it was at `checkpoint`, after an edit
   * that was only ever applied transiently has been rewound completely.
   *
   * A transient command marks the board dirty like any other, which is right
   * for a gesture still in progress. An edit rewound without ever reaching the
   * undo stack leaves the board as it was, though, and a dirty flag left behind
   * would ask "Discard unsaved changes?" about nothing. The text editor uses
   * this for a new text box closed without typing.
   *
   * `meta.updatedAt` goes back too, for the same reason: the top bar's
   * "Edited …" label would otherwise report an edit that left nothing behind,
   * and autosave would keep that time in the board's copy.
   *
   * Refused, returning false, when anything the flag answers for happened since
   * the checkpoint: a recorded command, an undo or redo, a save, or another
   * board. The flag then describes a real change and stays. Rewinding the
   * transient edits is the caller's job, and must come first.
   */
  restoreDirty(checkpoint: DirtyCheckpoint): boolean {
    if (checkpoint.generation !== this.generation || checkpoint.settled !== this.settled) return false;

    let changed = false;
    if (this.state.dirty !== checkpoint.dirty) {
      this.state.dirty = checkpoint.dirty;
      changed = true;
    }
    const { meta } = this.state.document;
    if (meta.updatedAt !== checkpoint.updatedAt) {
      // Replaced rather than mutated, like every other document change, so a
      // subscriber comparing by identity sees it. Only `meta` changes:
      // `elements` stays the same array, which nothing outside the commands
      // may touch.
      this.state.document = { ...this.state.document, meta: { ...meta, updatedAt: checkpoint.updatedAt } };
      changed = true;
    }
    // `document`, as `markDirty` uses, so the Save button, the "Edited" label
    // and the recent-boards copy all pick up the change. Once, for both.
    if (changed) this.emit('document');
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

  /** Replaces the whole board, e.g. after opening a file. */
  load(board: StagedBoard, origin: BoardOrigin): void {
    this.replaceBoard();
    this.state.document = board.document;
    this.state.preserved = board.preserved;
    this.state.workspaces = board.workspaces;
    this.state.activeWorkspaceId = board.activeWorkspaceId;
    this.extra = board.extra;
    this.state.selection = new Set();
    this.state.editingId = null;
    this.state.viewport = { ...board.document.viewport };
    this.state.dirty = false;
    this.state.origin = origin;
    this.histories.clear();
    this.emit('load');
  }

  reset(name?: string): void {
    const document = createDocument(name);
    const workspace = firstWorkspace();
    this.replaceBoard();
    this.state.document = document;
    this.state.preserved = [];
    this.state.workspaces = [workspace];
    this.state.activeWorkspaceId = workspace.id;
    this.extra = {};
    this.state.selection = new Set();
    this.state.editingId = null;
    this.state.viewport = { ...DEFAULT_VIEWPORT };
    this.state.dirty = false;
    this.state.origin = { kind: 'new' };
    this.histories.clear();
    this.emit('load');
  }

  setOrigin(origin: BoardOrigin): void {
    this.state.origin = origin;
    this.settled++;
    this.emit('origin');
  }

  /**
   * Remembers the board being replaced, then starts a new board instance.
   * Called before the state changes, so it records the board as it was left.
   */
  private replaceBoard(): void {
    this.departed = this.saveTicket();
    this.generation++;
  }

  /** Flags unsaved changes without going through a command. */
  markDirty(): void {
    // Counted even when already dirty: whatever prompted the call may differ
    // from what a save in flight is writing.
    this.revision++;
    this.settled++;
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
    this.markEdited();
    this.emit('document');
  }

  /**
   * Marks the board on screen saved. Folds the live viewport into the document.
   *
   * A save that awaits anything must go through `completeSave` instead, since
   * the board on screen may no longer be the one it wrote.
   */
  markSaved(origin?: BoardOrigin): void {
    this.state.document = { ...this.state.document, viewport: { ...this.state.viewport } };
    this.state.dirty = false;
    this.settled++;
    if (origin) this.state.origin = origin;
    this.emit('saved');
  }

  /**
   * Identifies the board a save is about to write. Take it in the same
   * synchronous step as `documentForSave`, so the two describe the same state.
   */
  saveTicket(): SaveTicket {
    return { boardId: this.state.document.id, generation: this.generation, revision: this.revision };
  }

  /**
   * Records a save that has just landed, written to `origin`.
   *
   * A save can land long after it took its ticket: a Drive round trip takes
   * seconds, and the Save button's spinner invites working on meanwhile.
   * Marking whatever is on screen as saved was wrong in two ways. Edits made
   * during the save lost their dirty flag although the file did not contain
   * them. And a board opened during the save took the old board's origin, so
   * its next save overwrote the old board's file. So:
   *
   * - The same board instance, unchanged: saved as usual (`clean`).
   * - The same instance, edited since: the origin is recorded, because the
   *   file now exists there. For a first save to Drive, forgetting the new file
   *   id would make the next save create a second file. The board stays dirty
   *   (`edited`), and emits `origin`, not `saved`.
   * - A different instance (another board, a new board, or the same board
   *   reopened): nothing on screen is touched. The result says whether the
   *   board was left exactly as written, which is when its recent-boards copy
   *   matches the file (`left-as-saved`). That is only knowable when it was the
   *   most recent board left and no board with its id is open again.
   */
  completeSave(ticket: SaveTicket, origin: BoardOrigin): SaveOutcome {
    if (ticket.generation !== this.generation) {
      const departed = this.departed;
      const leftAsWritten =
        departed !== null &&
        departed.generation === ticket.generation &&
        departed.revision === ticket.revision &&
        this.state.document.id !== ticket.boardId;
      return leftAsWritten ? 'left-as-saved' : 'left';
    }
    if (ticket.revision !== this.revision) {
      this.setOrigin(origin);
      return 'edited';
    }
    this.markSaved(origin);
    return 'clean';
  }

  /**
   * The staged workspace as it should be exported, with the live viewport
   * folded in. One workspace only: saving goes through {@link boardForSave}.
   */
  documentForSave(): MindflowDocument {
    return { ...this.state.document, viewport: { ...this.state.viewport } };
  }

  /**
   * The whole board as it should be written to disk, every workspace
   * included, with the live viewport folded into the staged one.
   *
   * Anything that must see the whole board (saving, autosave, counting
   * elements, deciding which images are used) goes through this, never through
   * `state.document`, which only ever holds one workspace.
   */
  boardForSave(): StagedBoard {
    return {
      document: this.documentForSave(),
      preserved: this.state.preserved,
      workspaces: this.state.workspaces,
      activeWorkspaceId: this.state.activeWorkspaceId,
      extra: this.extra,
    };
  }

  // -------------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------------

  /** The workspace list as the switcher shows it, in order. */
  workspaceSummaries(): WorkspaceSummary[] {
    const { document, preserved, workspaces } = this.state;
    return workspaces.map((entry) => ({
      id: entry.id,
      name: entry.name,
      elementCount: entry.parked
        ? entry.parked.elements.length + entry.parked.preserved.length
        : document.elements.length + preserved.length,
      active: entry.parked === null,
    }));
  }

  /**
   * Puts the workspace `id` on stage, parking the one there now.
   *
   * Not an edit. The caller must first end anything in flight that writes to
   * the stage: an open text editor and a pointer gesture, whose transient
   * edits would otherwise be parked half-done or replayed into the wrong
   * workspace. Returns false when `id` is already on stage or unknown.
   */
  switchWorkspace(id: WorkspaceId): boolean {
    if (id === this.state.activeWorkspaceId) return false;
    const target = this.state.workspaces.find((entry) => entry.id === id);
    if (!target?.parked) return false;

    const parked = this.stagedContent();
    this.state.workspaces = this.state.workspaces.map((entry) => {
      if (entry.id === this.state.activeWorkspaceId) return { ...entry, parked };
      if (entry.id === id) return { ...entry, parked: null };
      return entry;
    });
    this.stage(id, target.parked);
    this.emit('workspace');
    return true;
  }

  /**
   * Adds an empty workspace at the end of the list and puts it on stage. It
   * takes the staged workspace's background and grid, the default camera, and
   * the lowest free "Workspace N". Returns its id.
   */
  addWorkspace(): WorkspaceId {
    const { document } = this.state;
    const entry: WorkspaceEntry = {
      id: newWorkspaceId(),
      name: nextWorkspaceName(this.state.workspaces.map((workspace) => workspace.name)),
      meta: {},
      extra: {},
      parked: {
        canvas: structuredClone(document.canvas),
        viewport: { ...DEFAULT_VIEWPORT },
        elements: [],
        preserved: [],
      },
    };
    this.insertAndStage(entry, this.state.workspaces.length);
    return entry.id;
  }

  /**
   * Copies a workspace (its elements with fresh ids, its background, camera
   * and `meta`) into a new one right after it, named "<name> copy", and puts
   * the copy on stage. Returns its id, or null for an unknown id.
   */
  duplicateWorkspace(id: WorkspaceId): WorkspaceId | null {
    const index = this.state.workspaces.findIndex((entry) => entry.id === id);
    const source = this.state.workspaces[index];
    if (!source) return null;

    const content = source.parked ?? this.stagedContent();
    const entry: WorkspaceEntry = {
      id: newWorkspaceId(),
      name: `${source.name} copy`,
      meta: structuredClone(source.meta),
      extra: structuredClone(source.extra),
      parked: {
        canvas: structuredClone(content.canvas),
        viewport: { ...content.viewport },
        elements: cloneElements(content.elements),
        preserved: clonePreserved(content.preserved),
      },
    };
    this.insertAndStage(entry, index + 1);
    return entry.id;
  }

  /**
   * Renames a workspace. Leading and trailing space is dropped, and a blank
   * name becomes the workspace's default, "Workspace N" for its position.
   * Returns false when nothing changed.
   */
  renameWorkspace(id: WorkspaceId, name: string): boolean {
    const index = this.state.workspaces.findIndex((entry) => entry.id === id);
    const entry = this.state.workspaces[index];
    if (!entry) return false;
    const trimmed = name.trim();
    const next = trimmed === '' ? workspaceName(index + 1) : trimmed;
    if (next === entry.name) return false;

    this.state.workspaces = this.state.workspaces.map((candidate) =>
      candidate.id === id ? { ...candidate, name: next } : candidate,
    );
    this.markStructuralEdit();
    this.emit('document');
    return true;
  }

  /** Moves a workspace to `index` in the list (clamped). Returns false when it did not move. */
  moveWorkspace(id: WorkspaceId, index: number): boolean {
    const from = this.state.workspaces.findIndex((entry) => entry.id === id);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(this.state.workspaces.length - 1, Math.round(index)));
    if (to === from) return false;

    const workspaces = [...this.state.workspaces];
    const [entry] = workspaces.splice(from, 1);
    workspaces.splice(to, 0, entry as WorkspaceEntry);
    this.state.workspaces = workspaces;
    this.markStructuralEdit();
    this.emit('document');
    return true;
  }

  /**
   * Deletes a workspace and its undo history. Refused, returning false, for
   * the last one, since a board always has at least one. Deleting the
   * workspace on stage puts the next one there, or the previous one when it
   * was last. Not undoable; the app asks first when there is content.
   */
  deleteWorkspace(id: WorkspaceId): boolean {
    const { workspaces } = this.state;
    const index = workspaces.findIndex((entry) => entry.id === id);
    if (index === -1 || workspaces.length < 2) return false;

    const staged = id === this.state.activeWorkspaceId;
    const neighbour = workspaces[index + 1] ?? workspaces[index - 1];
    this.state.workspaces = workspaces
      .filter((entry) => entry.id !== id)
      .map((entry) => (staged && entry.id === neighbour?.id ? { ...entry, parked: null } : entry));
    this.histories.delete(id);
    if (staged && neighbour?.parked) this.stage(neighbour.id, neighbour.parked);
    this.markStructuralEdit();
    this.emit(staged ? 'workspace' : 'document');
    return true;
  }

  /** The staged workspace's content, with the live camera, ready to park. */
  private stagedContent(): WorkspaceContent {
    const { document, preserved, viewport } = this.state;
    return {
      canvas: document.canvas,
      viewport: { ...viewport },
      elements: document.elements,
      preserved: [...preserved],
    };
  }

  /**
   * Puts parked `content` on stage as workspace `id`. The entry list must
   * already say so (`parked: null` on `id`).
   *
   * The document is replaced rather than mutated, like every document change,
   * and keeps the board's own fields: id, name, timestamps and images. The
   * selection and any editing id belonged to the workspace left behind.
   */
  private stage(id: WorkspaceId, content: WorkspaceContent): void {
    this.state.document = {
      ...this.state.document,
      canvas: content.canvas,
      viewport: { ...content.viewport },
      elements: content.elements,
    };
    this.state.preserved = content.preserved;
    this.state.viewport = { ...content.viewport };
    this.state.activeWorkspaceId = id;
    this.state.selection = new Set();
    this.state.editingId = null;
    // Counted like a save or an undo: a dirty checkpoint taken before the
    // switch describes another workspace's transient edits, and must not be
    // restored over this one.
    this.settled++;
  }

  /** Inserts a parked workspace at `index` and puts it on stage. An edit. */
  private insertAndStage(entry: WorkspaceEntry, index: number): void {
    const content = entry.parked as WorkspaceContent;
    const parked = this.stagedContent();
    const workspaces = this.state.workspaces.map((candidate) =>
      candidate.id === this.state.activeWorkspaceId ? { ...candidate, parked } : candidate,
    );
    workspaces.splice(index, 0, { ...entry, parked: null });
    this.state.workspaces = workspaces;
    this.stage(entry.id, content);
    this.markStructuralEdit();
    this.emit('workspace');
  }

  /**
   * Records an edit to the workspace list. It dirties the board and moves
   * its edit time like any command, so a save in flight lands as `edited`
   * and the top bar's "Edited" label moves.
   */
  private markStructuralEdit(): void {
    this.markEdited();
    this.settled++;
    this.state.document = {
      ...this.state.document,
      meta: { ...this.state.document.meta, updatedAt: new Date().toISOString() },
    };
  }
}

/** The one workspace of a new board. */
function firstWorkspace(): WorkspaceEntry {
  return { id: newWorkspaceId(), name: workspaceName(1), meta: {}, extra: {}, parked: null };
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}
