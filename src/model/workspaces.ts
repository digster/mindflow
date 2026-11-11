/**
 * Workspaces: several independent drawings in one board (format 2.0.0).
 *
 * ---------------------------------------------------------------------------
 * One workspace on stage, the rest parked
 * ---------------------------------------------------------------------------
 * About twenty modules read `document.elements`: the renderer, hit-testing,
 * snapping, binding, frames, search, the commands and every exporter. None of
 * them knows what a workspace is, and none should have to. So the app keeps
 * the workspace on screen *on stage*, as the same flat `MindflowDocument` those
 * modules have always read, and holds every other workspace's content to one
 * side, *parked* in its entry of the board's workspace list.
 *
 * The rule that makes this safe: a workspace's content is in exactly one place.
 * The staged workspace's entry has `parked: null`, and its content is the
 * document's `canvas`, `viewport` and `elements` (plus the store's `preserved`).
 * Switching moves content between the two; nothing ever copies it.
 *
 * Anything that needs the WHOLE board (saving, autosave, counting elements,
 * deciding which images are used) must therefore go through a
 * {@link StagedBoard} and {@link resolveWorkspaces}, never the document alone,
 * which only ever describes one workspace.
 *
 * Everything here is pure and DOM-free, so it is unit-tested in node.
 */

import type {
  CanvasSettings,
  ElementId,
  MindflowDocument,
  MindflowElement,
  Viewport,
  WorkspaceId,
} from './types.ts';
import { newElementId, newGroupId } from './defaults.ts';
import { isConnector } from './registry.ts';

/**
 * The id a 1.x board's only workspace is given when it is upgraded, and the id
 * used for a board read from the 1.x shape (top-level `elements`).
 *
 * Fixed rather than random, so that loading the same old file twice gives the
 * same board. Only the board's own workspaces must have distinct ids, and a
 * board read from the old shape has just this one.
 */
export const LEGACY_WORKSPACE_ID: WorkspaceId = 'ws_1';

/** "Workspace 3". The default name, and what a blank rename falls back to. */
export function workspaceName(n: number): string {
  return `Workspace ${n}`;
}

/**
 * The default name for a new workspace: `Workspace N` with the lowest N that no
 * workspace already uses. Deleting "Workspace 2" therefore makes the next new
 * one "Workspace 2" again rather than "Workspace 4", which is what a person
 * counting the list expects.
 */
export function nextWorkspaceName(names: Iterable<string>): string {
  const taken = new Set([...names].map((name) => name.trim()));
  let n = 1;
  while (taken.has(workspaceName(n))) n++;
  return workspaceName(n);
}

// ---------------------------------------------------------------------------
// The board in memory
// ---------------------------------------------------------------------------

/** What a workspace holds: the part that is on stage or parked. */
export interface WorkspaceContent {
  canvas: CanvasSettings;
  viewport: Viewport;
  elements: MindflowElement[];
  /** Elements of types this build does not know, held aside verbatim. */
  preserved: unknown[];
}

/** One entry of a board's workspace list, as the app holds it. */
export interface WorkspaceEntry {
  readonly id: WorkspaceId;
  readonly name: string;
  /** The workspace's third-party `meta`, preserved verbatim. */
  readonly meta: Record<string, unknown>;
  /**
   * Fields on the workspace object that this version does not know, written
   * back verbatim. What lets a later minor version add a workspace field
   * without this one dropping it on save.
   */
  readonly extra: Record<string, unknown>;
  /** The content while parked. `null` while this workspace is on stage. */
  readonly parked: WorkspaceContent | null;
}

/**
 * A board as the app holds it: one workspace on stage as a flat document, the
 * others parked in their entries. What the loader produces, what the store
 * keeps, and what the serialiser writes.
 */
export interface StagedBoard {
  /** The board, seen through the staged workspace. */
  document: MindflowDocument;
  /** The staged workspace's unknown-type elements. */
  preserved: readonly unknown[];
  /** Every workspace in order. Exactly one, the active one, has `parked: null`. */
  workspaces: readonly WorkspaceEntry[];
  activeWorkspaceId: WorkspaceId;
  /** Top-level fields this version does not know, written back verbatim. */
  extra: Record<string, unknown>;
}

/** A workspace together with its content, whichever side of the stage it is on. */
export interface ResolvedWorkspace {
  entry: WorkspaceEntry;
  content: WorkspaceContent;
  /** True for the staged workspace. */
  staged: boolean;
}

/** Every workspace of the board with its content, in order. */
export function resolveWorkspaces(board: StagedBoard): ResolvedWorkspace[] {
  return board.workspaces.map((entry) =>
    entry.parked
      ? { entry, content: entry.parked, staged: false }
      : {
          entry,
          staged: true,
          content: {
            canvas: board.document.canvas,
            viewport: board.document.viewport,
            elements: board.document.elements,
            preserved: [...board.preserved],
          },
        },
  );
}

/**
 * A board with one workspace, for a document that has no store around it: a
 * new board, a test fixture, or a caller that only ever had one drawing.
 */
export function singleWorkspaceBoard(
  document: MindflowDocument,
  preserved: readonly unknown[] = [],
  id: WorkspaceId = LEGACY_WORKSPACE_ID,
): StagedBoard {
  return {
    document,
    preserved,
    workspaces: [{ id, name: workspaceName(1), meta: {}, extra: {}, parked: null }],
    activeWorkspaceId: id,
    extra: {},
  };
}

/**
 * How many elements the whole board holds, unknown types included.
 *
 * This, not `document.elements.length`, is what decides whether a board is
 * worth keeping: right after "New workspace" the stage is empty while the
 * board is not.
 */
export function boardElementCount(board: StagedBoard): number {
  return resolveWorkspaces(board).reduce(
    (total, { content }) => total + content.elements.length + content.preserved.length,
    0,
  );
}

// ---------------------------------------------------------------------------
// Element ids
// ---------------------------------------------------------------------------

/**
 * Rewrites element ids through `idMap`, and every reference to them: connector
 * bindings and `frameId`. Ids and references that the map does not name are
 * left as they are. With `groupMap`, group ids are rewritten the same way.
 *
 * Used by the loader, to give a workspace's elements new ids when an earlier
 * workspace already used them, and by {@link cloneElements}.
 */
export function remapElementIds(
  elements: readonly MindflowElement[],
  idMap: ReadonlyMap<ElementId, ElementId>,
  groupMap?: ReadonlyMap<string, string>,
): MindflowElement[] {
  const remap = (id: ElementId) => idMap.get(id) ?? id;
  return elements.map((element) => {
    const next = { ...element, id: remap(element.id) } as MindflowElement;
    if (element.frameId !== null) next.frameId = remap(element.frameId);
    if (groupMap && element.groupId !== null) next.groupId = groupMap.get(element.groupId) ?? element.groupId;
    if (isConnector(next)) {
      if (next.startBinding) next.startBinding = { ...next.startBinding, elementId: remap(next.startBinding.elementId) };
      if (next.endBinding) next.endBinding = { ...next.endBinding, elementId: remap(next.endBinding.elementId) };
    }
    return next;
  });
}

/**
 * Copies a workspace's elements with fresh ids. Groups, connector bindings and
 * frame membership point at the copies; positions and paint order are the
 * originals'. What "Duplicate workspace" puts in the copy.
 *
 * Deep-copied, so the copy shares no nested object (a style, a point list)
 * with the original, which stays in another workspace.
 */
export function cloneElements(elements: readonly MindflowElement[]): MindflowElement[] {
  const idMap = new Map(elements.map((element) => [element.id, newElementId()] as const));
  const groupMap = new Map<string, string>();
  for (const element of elements) {
    if (element.groupId !== null && !groupMap.has(element.groupId)) groupMap.set(element.groupId, newGroupId());
  }
  return remapElementIds(structuredClone(elements as MindflowElement[]), idMap, groupMap);
}

/**
 * Copies elements of unknown types, giving each one that has a string `id` a
 * new one. Their own references cannot be remapped, because this build does
 * not know which of their fields are references; a later build that does will
 * report any that dangle.
 */
export function clonePreserved(preserved: readonly unknown[]): unknown[] {
  return preserved.map((raw) => {
    const copy = structuredClone(raw);
    if (typeof copy === 'object' && copy !== null && typeof (copy as { id?: unknown }).id === 'string') {
      (copy as { id: string }).id = newElementId();
    }
    return copy;
  });
}
