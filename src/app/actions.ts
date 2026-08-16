/**
 * Application actions.
 *
 * Every user-invokable operation that is not a raw pointer gesture lives here:
 * delete, duplicate, group, copy/paste, zoom, align, reorder. Keyboard
 * shortcuts, toolbar buttons and the context menu all call into this one object
 * rather than reimplementing the operation.
 *
 * The payoff is consistency — "Duplicate" behaves identically however it was
 * invoked — and testability, since actions can be driven directly without
 * synthesising DOM events.
 */

import type { ElementId, MindflowElement, Point, Viewport } from '../model/types.ts';
import type { Store } from '../store/store.ts';
import { getDefinition } from '../model/registry.ts';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  Z_INDEX_STEP,
  newElementId,
  newGroupId,
} from '../model/defaults.ts';
import { clamp, unionAABB } from '../model/geometry.ts';
import {
  addElements,
  deleteElements,
  groupElements,
  replaceElements,
  reorderElements,
  topZIndex,
  ungroupElements,
  updateElements,
  type ReorderMode,
} from '../store/commands.ts';
import { connectorsToRefresh } from '../input/binding.ts';
import { zoomAbout } from '../input/controller.ts';

/** Offset applied to pasted and duplicated elements so they do not hide the original. */
const PASTE_OFFSET = 16;

/** Distance in scene units for a single arrow-key nudge. */
const NUDGE_STEP = 1;
const NUDGE_STEP_LARGE = 10;

/**
 * Internal clipboard.
 *
 * A module-level copy is kept alongside the system clipboard because reading the
 * system clipboard requires a permission prompt in some browsers and is
 * unavailable entirely in others. Copy writes to both; paste prefers the system
 * clipboard (so copying between two MindFlow tabs works) and falls back to this.
 */
let internalClipboard: MindflowElement[] = [];

/** MIME-ish marker written into the system clipboard so we can recognise our own payload. */
const CLIPBOARD_MARKER = 'application/x-mindflow-elements';

export interface ActionsOptions {
  store: Store;
  /** Canvas size in CSS pixels, for zoom-to-fit and centring. */
  getViewportSize: () => { width: number; height: number };
  notify: (message: string, level?: 'info' | 'error') => void;
}

export class Actions {
  constructor(private readonly options: ActionsOptions) {}

  private get store(): Store {
    return this.options.store;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  selectAll(): void {
    const selectable = this.store.document.elements.filter((el) => !el.locked && el.visible);
    this.store.setSelection(selectable.map((el) => el.id));
  }

  deselectAll(): void {
    this.store.clearSelection();
  }

  /**
   * The part of the selection that may still be edited.
   *
   * A locked element can be selected — right-clicking one is how it is reached
   * in order to unlock it — so every mutating action has to exclude it rather
   * than assume the selection is fair game.
   */
  private editableSelection(): MindflowElement[] {
    return this.store.selectedElements().filter((element) => !element.locked);
  }

  deleteSelection(): void {
    const ids = this.editableSelection().map((element) => element.id);
    if (ids.length === 0) return;
    this.store.execute(deleteElements(this.store.document, ids));
    this.store.clearSelection();
  }

  // -------------------------------------------------------------------------
  // Clipboard
  // -------------------------------------------------------------------------

  /**
   * Clones elements with fresh IDs.
   *
   * Group membership is remapped rather than copied: pasting two members of the
   * same group must produce a NEW group containing the copies, not silently
   * enrol them into the original. Bindings to elements outside the copied set
   * are dropped, since the copy would otherwise be tethered to the original's
   * neighbours.
   */
  private cloneElements(elements: readonly MindflowElement[], offset: number): MindflowElement[] {
    const idMap = new Map<ElementId, ElementId>();
    const groupMap = new Map<string, string>();
    for (const element of elements) idMap.set(element.id, newElementId());

    let zIndex = topZIndex(this.store.document);

    return elements.map((element) => {
      let groupId = element.groupId;
      if (groupId) {
        if (!groupMap.has(groupId)) groupMap.set(groupId, newGroupId());
        groupId = groupMap.get(groupId) as string;
      }

      const clone = {
        ...structuredClone(element),
        id: idMap.get(element.id) as ElementId,
        x: element.x + offset,
        y: element.y + offset,
        zIndex: (zIndex += Z_INDEX_STEP),
        groupId,
      } as MindflowElement;

      if (clone.type === 'line' || clone.type === 'arrow') {
        clone.startBinding = remapBinding(clone.startBinding, idMap);
        clone.endBinding = remapBinding(clone.endBinding, idMap);
      }
      return clone;
    });
  }

  async copy(): Promise<void> {
    const selected = this.store.selectedElements();
    if (selected.length === 0) return;
    internalClipboard = selected.map((element) => structuredClone(element));

    // Also write to the system clipboard so copy/paste works across tabs. The
    // files map is included so pasted images still resolve.
    try {
      const files: Record<string, unknown> = {};
      for (const element of selected) {
        if (element.type === 'image') {
          const file = this.store.document.files[element.fileId];
          if (file) files[element.fileId] = file;
        }
      }
      const payload = JSON.stringify({ [CLIPBOARD_MARKER]: true, elements: internalClipboard, files });
      await navigator.clipboard?.writeText(payload);
    } catch {
      // Clipboard permission denied or unavailable. The internal copy still works.
    }
  }

  async cut(): Promise<void> {
    await this.copy();
    this.deleteSelection();
  }

  async paste(at?: Point): Promise<void> {
    let elements = internalClipboard;
    let files: Record<string, unknown> = {};

    try {
      const text = await navigator.clipboard?.readText();
      if (text) {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed[CLIPBOARD_MARKER] && Array.isArray(parsed.elements)) {
          elements = parsed.elements as MindflowElement[];
          files = (parsed.files as Record<string, unknown>) ?? {};
        }
      }
    } catch {
      // Not JSON, not ours, or clipboard read refused — fall back to internal.
    }

    if (elements.length === 0) return;

    const clones = this.cloneElements(elements, at ? 0 : PASTE_OFFSET);

    // Paste centred on the pointer when a position was supplied.
    if (at) {
      const box = unionAABB(clones);
      if (box) {
        const dx = at.x - (box.minX + box.maxX) / 2;
        const dy = at.y - (box.minY + box.maxY) / 2;
        for (const clone of clones) {
          clone.x += dx;
          clone.y += dy;
        }
      }
    }

    // Merge any embedded images the copied elements depend on, so pasting an
    // image into a different board carries its pixels with it.
    if (Object.keys(files).length > 0) {
      this.store.addFiles(files as Parameters<Store['addFiles']>[0]);
    }

    this.store.execute(addElements(clones, 'Paste'));
    this.store.setSelection(clones.map((element) => element.id));
  }

  duplicate(): void {
    const selected = this.store.selectedElements();
    if (selected.length === 0) return;
    const clones = this.cloneElements(selected, PASTE_OFFSET);
    this.store.execute(addElements(clones, 'Duplicate'));
    this.store.setSelection(clones.map((element) => element.id));
  }

  // -------------------------------------------------------------------------
  // Arrangement
  // -------------------------------------------------------------------------

  reorder(mode: ReorderMode): void {
    const ids = this.store.selectedIds();
    if (ids.length === 0) return;
    this.store.execute(reorderElements(this.store.document, ids, mode));
  }

  group(): void {
    const ids = this.store.selectedIds();
    if (ids.length < 2) return;
    this.store.execute(groupElements(this.store.document, ids));
  }

  ungroup(): void {
    const ids = this.store.selectedIds();
    if (ids.length === 0) return;
    this.store.execute(ungroupElements(this.store.document, ids));
  }

  /** Moves the selection, re-routing any connectors bound to it. */
  nudge(dx: number, dy: number, large = false): void {
    const ids = this.editableSelection().map((element) => element.id);
    if (ids.length === 0) return;
    const step = large ? NUDGE_STEP_LARGE : NUDGE_STEP;

    this.store.execute(
      updateElements(
        this.store.document,
        ids,
        (element) => ({ ...element, x: element.x + dx * step, y: element.y + dy * step }),
        'Move',
        true, // Coalesce, so holding an arrow key is one undo step.
      ),
    );
    this.refreshBoundConnectors(new Set(ids));
  }

  /** Re-routes connectors after their targets moved. Safe to call redundantly. */
  refreshBoundConnectors(movedIds: ReadonlySet<ElementId>): void {
    const connectors = connectorsToRefresh(this.store.document, movedIds);
    if (connectors.length === 0) return;
    this.store.execute(replaceElements(this.store.document, connectors, 'Re-route connectors'), true);
  }

  toggleLock(): void {
    const selected = this.store.selectedElements();
    if (selected.length === 0) return;
    // Mixed selections all become locked — the intent of pressing "lock" with a
    // partial selection is to lock everything, not to invert each item.
    const lock = selected.some((element) => !element.locked);
    this.store.execute(
      updateElements(this.store.document, selected.map((el) => el.id), (element) => ({ ...element, locked: lock }), lock ? 'Lock' : 'Unlock'),
    );
    if (!lock) return;

    // Locking drops the selection, because a locked element is scenery and
    // clicking it goes straight through. That leaves right-click as the only way
    // back to it, which nothing on screen would otherwise reveal — so say so
    // once, at the exact moment the knowledge becomes necessary.
    this.store.clearSelection();
    this.options.notify('Locked — right-click to select it again and unlock.');
  }

  /**
   * Unlocks the selection.
   *
   * Separate from {@link toggleLock} because a mixed selection means opposite
   * things to the two: toggling locks everything, while the panel's Unlock
   * button must always unlock, whatever else is selected alongside.
   */
  unlock(): void {
    const ids = this.store
      .selectedElements()
      .filter((element) => element.locked)
      .map((element) => element.id);
    if (ids.length === 0) return;
    this.store.execute(
      updateElements(this.store.document, ids, (element) => ({ ...element, locked: false }), 'Unlock'),
    );
  }

  align(edge: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'): void {
    const selected = this.store.selectedElements();
    if (selected.length < 2) return;
    const box = unionAABB(selected);
    if (!box) return;

    this.store.execute(
      updateElements(
        this.store.document,
        selected.map((el) => el.id),
        (element) => {
          switch (edge) {
            case 'left':
              return { ...element, x: box.minX };
            case 'right':
              return { ...element, x: box.maxX - element.width };
            case 'centerX':
              return { ...element, x: (box.minX + box.maxX) / 2 - element.width / 2 };
            case 'top':
              return { ...element, y: box.minY };
            case 'bottom':
              return { ...element, y: box.maxY - element.height };
            case 'centerY':
              return { ...element, y: (box.minY + box.maxY) / 2 - element.height / 2 };
          }
        },
        'Align',
      ),
    );
    this.refreshBoundConnectors(new Set(selected.map((el) => el.id)));
  }

  // -------------------------------------------------------------------------
  // Styling
  // -------------------------------------------------------------------------

  /** Applies a style patch to every selected element. */
  restyle(patch: Partial<MindflowElement['style']>, label = 'Change style'): void {
    const ids = this.store.selectedIds();
    if (ids.length === 0) return;
    this.store.execute(
      updateElements(
        this.store.document,
        ids,
        (element) => ({ ...element, style: { ...element.style, ...patch } }),
        label,
      ),
    );
  }

  setOpacity(opacity: number): void {
    const ids = this.store.selectedIds();
    if (ids.length === 0) return;
    this.store.execute(
      updateElements(
        this.store.document,
        ids,
        (element) => ({ ...element, opacity: clamp(opacity, 0, 1) }),
        'Change opacity',
        true,
      ),
    );
  }

  /**
   * Applies a text property to whichever text-bearing field an element uses.
   *
   * A `text` or `sticky` element holds its typography directly; every other
   * shape holds it inside `label`. Hiding that split here keeps the style panel
   * from having to know about it.
   */
  setTextProperty(patch: Record<string, unknown>): void {
    const ids = this.store.selectedIds();
    if (ids.length === 0) return;

    this.store.execute(
      updateElements(
        this.store.document,
        ids,
        (element) => {
          const capabilities = getDefinition(element.type).capabilities;
          if (capabilities.text) return { ...element, ...patch } as MindflowElement;
          if (capabilities.label && element.label) {
            return { ...element, label: { ...element.label, ...patch } } as MindflowElement;
          }
          return null;
        },
        'Change text style',
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Viewport
  // -------------------------------------------------------------------------

  zoomBy(factor: number): void {
    const { width, height } = this.options.getViewportSize();
    const viewport = this.store.viewport;
    const zoom = clamp(viewport.zoom * factor, MIN_ZOOM, MAX_ZOOM);
    this.store.setViewport(zoomAbout(viewport, zoom, { x: width / 2, y: height / 2 }));
  }

  resetZoom(): void {
    const { width, height } = this.options.getViewportSize();
    const viewport = this.store.viewport;
    this.store.setViewport(zoomAbout(viewport, 1, { x: width / 2, y: height / 2 }));
  }

  /** Fits the selection, or the whole board when nothing is selected. */
  zoomToFit(padding = 64): void {
    const selected = this.store.selectedElements();
    const targets = selected.length > 0 ? selected : this.store.document.elements;
    const box = unionAABB(targets);
    const { width, height } = this.options.getViewportSize();

    if (!box || width === 0 || height === 0) {
      this.store.setViewport({ x: 0, y: 0, zoom: 1 });
      return;
    }

    const contentWidth = Math.max(box.maxX - box.minX, 1);
    const contentHeight = Math.max(box.maxY - box.minY, 1);
    const zoom = clamp(
      Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight),
      MIN_ZOOM,
      MAX_ZOOM,
    );

    this.store.setViewport({
      zoom,
      x: (box.minX + box.maxX) / 2 - width / 2 / zoom,
      y: (box.minY + box.maxY) / 2 - height / 2 / zoom,
    });
  }

  /** Centres the view on a scene point without changing zoom. */
  centerOn(point: Point): void {
    const { width, height } = this.options.getViewportSize();
    const { zoom } = this.store.viewport;
    this.store.setViewport({ zoom, x: point.x - width / 2 / zoom, y: point.y - height / 2 / zoom });
  }

  get viewport(): Viewport {
    return this.store.viewport;
  }

  notify(message: string, level: 'info' | 'error' = 'info'): void {
    this.options.notify(message, level);
  }
}

function remapBinding<T extends { elementId: ElementId } | null>(
  binding: T,
  idMap: Map<ElementId, ElementId>,
): T {
  if (!binding) return binding;
  const mapped = idMap.get(binding.elementId);
  // Dropped when the target was not part of the copy — see `cloneElements`.
  return (mapped ? { ...binding, elementId: mapped } : null) as T;
}
