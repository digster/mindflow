/**
 * Commands — the only way document state is ever changed.
 *
 * ---------------------------------------------------------------------------
 * Why every mutation is a command
 * ---------------------------------------------------------------------------
 * The obvious way to build undo is to snapshot the whole document before each
 * edit. That is simple and always correct, but a board with a few embedded
 * images is several megabytes, and fifty snapshots of it is not something to
 * keep in memory.
 *
 * The alternative is for every mutation to know how to reverse itself. Rather
 * than hand-writing an inverse per operation — which is where undo bugs are
 * born — a command here records a `before` and `after` snapshot of *only the
 * elements it touches*. Inverting is then a matter of swapping those two fields,
 * which is correct by construction for every operation: create, delete, update,
 * restyle and reorder all reduce to the same shape.
 *
 * The second payoff is that undo, autosave and dirty-tracking all observe one
 * seam. They cannot drift out of sync, because there is nowhere else to look.
 *
 * The rule this buys, and the rule that must hold: NOTHING outside this module
 * may mutate `document.elements`.
 */

import type {
  CanvasSettings,
  ElementId,
  MindflowDocument,
  MindflowElement,
} from '../model/types.ts';
import { Z_INDEX_STEP, newGroupId } from '../model/defaults.ts';

/**
 * The change to one element.
 *
 * `before: null` means the element did not exist (a creation).
 * `after: null` means it ceases to exist (a deletion).
 */
export interface ElementPatch {
  id: ElementId;
  before: MindflowElement | null;
  after: MindflowElement | null;
}

/** Document-level fields that can change outside the element array. */
export interface DocumentPatch {
  canvas?: CanvasSettings;
  name?: string;
}

export interface Command {
  /** Shown in the UI, e.g. in an undo tooltip. Imperative and human-readable. */
  label: string;
  patches: ElementPatch[];
  docBefore?: DocumentPatch;
  docAfter?: DocumentPatch;
  /**
   * When true, this command may absorb the immediately-following command with
   * the same label. Used for continuous gestures — dragging a shape emits a
   * command per pointer-move, and fifty of those should be one undo step, not
   * fifty. See `history.ts`.
   */
  coalesce?: boolean;
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Applies a command, returning a new document.
 *
 * The document object is replaced rather than mutated so that subscribers can
 * detect change by identity, but untouched elements keep their original object
 * identity — which lets the renderer skip work for elements that did not move.
 */
export function applyCommand(document: MindflowDocument, command: Command): MindflowDocument {
  if (command.patches.length === 0 && !command.docAfter) return document;

  const byId = new Map(document.elements.map((el) => [el.id, el]));

  for (const patch of command.patches) {
    if (patch.after === null) byId.delete(patch.id);
    else byId.set(patch.id, patch.after);
  }

  // `zIndex` is the contract's source of truth for paint order, so the array is
  // re-sorted after every command rather than trusted to stay ordered.
  const elements = [...byId.values()].sort((a, b) => a.zIndex - b.zIndex);

  return {
    ...document,
    elements,
    canvas: command.docAfter?.canvas ?? document.canvas,
    meta: {
      ...document.meta,
      name: command.docAfter?.name ?? document.meta.name,
      updatedAt: new Date().toISOString(),
    },
  };
}

/** Produces the command that exactly undoes `command`. */
export function invertCommand(command: Command): Command {
  return {
    label: command.label,
    patches: command.patches.map((patch) => ({
      id: patch.id,
      before: patch.after,
      after: patch.before,
    })),
    docBefore: command.docAfter,
    docAfter: command.docBefore,
  };
}

/** True when the command would not change anything. */
export function isNoopCommand(command: Command): boolean {
  if (command.docAfter) return false;
  return command.patches.every((patch) => patch.before === patch.after);
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export function addElements(elements: readonly MindflowElement[], label = 'Add'): Command {
  return {
    label,
    patches: elements.map((el) => ({ id: el.id, before: null, after: el })),
  };
}

export function deleteElements(
  document: MindflowDocument,
  ids: readonly ElementId[],
  label = 'Delete',
): Command {
  const targets = new Set(ids);
  const patches: ElementPatch[] = [];

  for (const el of document.elements) {
    if (targets.has(el.id)) {
      patches.push({ id: el.id, before: el, after: null });
      continue;
    }

    // Deleting a shape must not leave connectors pointing at a ghost. Any
    // binding aimed at a doomed element is cleared in the same command, so undo
    // restores both the shape and its connections in one step.
    if (el.type === 'line' || el.type === 'arrow') {
      const startDangles = el.startBinding && targets.has(el.startBinding.elementId);
      const endDangles = el.endBinding && targets.has(el.endBinding.elementId);
      if (startDangles || endDangles) {
        patches.push({
          id: el.id,
          before: el,
          after: {
            ...el,
            startBinding: startDangles ? null : el.startBinding,
            endBinding: endDangles ? null : el.endBinding,
          },
        });
      }
    }
  }

  return { label, patches };
}

/**
 * Builds a command from a per-element transform.
 *
 * The updater returns `null` to leave an element untouched, which keeps patches
 * minimal — important, because patch size is what bounds undo memory.
 */
export function updateElements(
  document: MindflowDocument,
  ids: readonly ElementId[],
  updater: (el: MindflowElement) => MindflowElement | null,
  label = 'Update',
  coalesce = false,
): Command {
  const targets = new Set(ids);
  const patches: ElementPatch[] = [];

  for (const el of document.elements) {
    if (!targets.has(el.id)) continue;
    const next = updater(el);
    if (next && next !== el) patches.push({ id: el.id, before: el, after: next });
  }

  return { label, patches, coalesce };
}

/** Replaces specific elements wholesale, given the pre-edit document for `before`. */
export function replaceElements(
  document: MindflowDocument,
  replacements: readonly MindflowElement[],
  label = 'Update',
  coalesce = false,
): Command {
  const byId = new Map(document.elements.map((el) => [el.id, el]));
  const patches: ElementPatch[] = replacements
    .map((el) => ({ id: el.id, before: byId.get(el.id) ?? null, after: el }))
    .filter((patch) => patch.before !== patch.after);
  return { label, patches, coalesce };
}

export function setCanvasSettings(
  document: MindflowDocument,
  canvas: CanvasSettings,
  label = 'Canvas settings',
): Command {
  return { label, patches: [], docBefore: { canvas: document.canvas }, docAfter: { canvas } };
}

export function renameBoard(document: MindflowDocument, name: string): Command {
  return {
    label: 'Rename board',
    patches: [],
    docBefore: { name: document.meta.name },
    docAfter: { name },
  };
}

// ---------------------------------------------------------------------------
// Z-order
// ---------------------------------------------------------------------------

/** Next free z-index above everything currently in the document. */
export function topZIndex(document: MindflowDocument): number {
  const last = document.elements[document.elements.length - 1];
  return last ? last.zIndex + Z_INDEX_STEP : Z_INDEX_STEP;
}

export function bottomZIndex(document: MindflowDocument): number {
  const first = document.elements[0];
  return first ? first.zIndex - Z_INDEX_STEP : Z_INDEX_STEP;
}

export type ReorderMode = 'front' | 'back' | 'forward' | 'backward';

/**
 * Changes paint order.
 *
 * `front`/`back` jump past every other element. `forward`/`backward` swap with
 * the nearest neighbour, which is what makes repeated presses walk an element
 * through a stack one layer at a time.
 *
 * Fractional indices mean a move usually rewrites one element's `zIndex` and
 * nothing else, keeping the patch — and therefore the undo entry — tiny.
 */
export function reorderElements(
  document: MindflowDocument,
  ids: readonly ElementId[],
  mode: ReorderMode,
): Command {
  const targets = new Set(ids);
  const selected = document.elements.filter((el) => targets.has(el.id));
  if (selected.length === 0) return { label: 'Reorder', patches: [] };

  const others = document.elements.filter((el) => !targets.has(el.id));
  const patches: ElementPatch[] = [];

  if (mode === 'front' || mode === 'back') {
    const start = mode === 'front' ? topZIndex(document) : bottomZIndex(document) - selected.length * Z_INDEX_STEP;
    selected.forEach((el, index) => {
      const zIndex = start + index * Z_INDEX_STEP;
      if (zIndex !== el.zIndex) patches.push({ id: el.id, before: el, after: { ...el, zIndex } });
    });
    return { label: mode === 'front' ? 'Bring to front' : 'Send to back', patches };
  }

  const forward = mode === 'forward';
  for (const el of selected) {
    // Nearest unselected neighbour in the direction of travel.
    const neighbours = others.filter((other) =>
      forward ? other.zIndex > el.zIndex : other.zIndex < el.zIndex,
    );
    if (neighbours.length === 0) continue;

    const neighbour = forward
      ? neighbours.reduce((a, b) => (b.zIndex < a.zIndex ? b : a))
      : neighbours.reduce((a, b) => (b.zIndex > a.zIndex ? b : a));

    // Land just past the neighbour. Half a step keeps us clear of anything
    // sitting exactly on the neighbour's index.
    const zIndex = forward
      ? neighbour.zIndex + Z_INDEX_STEP / 2
      : neighbour.zIndex - Z_INDEX_STEP / 2;
    patches.push({ id: el.id, before: el, after: { ...el, zIndex } });
  }

  return { label: forward ? 'Bring forward' : 'Send backward', patches };
}

/**
 * Renormalises every `zIndex` back onto clean multiples of {@link Z_INDEX_STEP}.
 *
 * Fractional indexing halves the gap on each insertion between the same pair, so
 * about ten repeated inserts in one spot exhausts float precision. This is the
 * escape hatch; it is cheap and almost never needed, but without it a
 * pathological editing session eventually produces two elements with equal
 * indices and non-deterministic paint order.
 */
export function reindexZ(document: MindflowDocument): Command {
  const patches: ElementPatch[] = [];
  document.elements.forEach((el, index) => {
    const zIndex = (index + 1) * Z_INDEX_STEP;
    if (zIndex !== el.zIndex) patches.push({ id: el.id, before: el, after: { ...el, zIndex } });
  });
  return { label: 'Normalise layer order', patches };
}

/** True when indices have drifted close enough together to warrant reindexing. */
export function needsReindex(document: MindflowDocument): boolean {
  for (let i = 1; i < document.elements.length; i++) {
    const previous = document.elements[i - 1];
    const current = document.elements[i];
    if (!previous || !current) continue;
    if (current.zIndex - previous.zIndex < 0.001) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export function groupElements(document: MindflowDocument, ids: readonly ElementId[]): Command {
  if (ids.length < 2) return { label: 'Group', patches: [] };
  const groupId = newGroupId();
  return updateElements(document, ids, (el) => ({ ...el, groupId }), 'Group');
}

export function ungroupElements(document: MindflowDocument, ids: readonly ElementId[]): Command {
  // Ungrouping one member ungroups the whole group — selecting a member always
  // selects its siblings, so any other behaviour would be surprising.
  const groupIds = new Set(
    document.elements.filter((el) => ids.includes(el.id) && el.groupId).map((el) => el.groupId),
  );
  const affected = document.elements
    .filter((el) => el.groupId && groupIds.has(el.groupId))
    .map((el) => el.id);
  return updateElements(document, affected, (el) => ({ ...el, groupId: null }), 'Ungroup');
}

/**
 * Expands a selection to include every sibling of any grouped member.
 *
 * Called on every selection change, which is what makes a group behave as one
 * object without groups needing to exist as objects themselves.
 */
export function expandSelectionToGroups(
  document: MindflowDocument,
  ids: Iterable<ElementId>,
): Set<ElementId> {
  const result = new Set(ids);
  const groupIds = new Set<string>();

  for (const el of document.elements) {
    if (result.has(el.id) && el.groupId) groupIds.add(el.groupId);
  }
  if (groupIds.size === 0) return result;

  for (const el of document.elements) {
    if (el.groupId && groupIds.has(el.groupId)) result.add(el.id);
  }
  return result;
}
