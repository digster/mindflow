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

import type { AABB, ElementId, MindflowElement, Point, Viewport } from '../model/types.ts';
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

/**
 * Typography fields carried by the style clipboard.
 *
 * `color` is included but `text` is not: pasting a style must never overwrite
 * what an element says.
 */
const TYPOGRAPHY_KEYS = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'color',
  'textAlign',
  'verticalAlign',
] as const;

interface StyleClipboard {
  style: MindflowElement['style'];
  opacity: number;
  /** Null when the source element carried no text of its own. */
  typography: Record<string, unknown> | null;
}

export interface ActionsOptions {
  store: Store;
  /** Canvas size in CSS pixels, for zoom-to-fit and centring. */
  getViewportSize: () => { width: number; height: number };
  notify: (message: string, level?: 'info' | 'error') => void;
}

export class Actions {
  /**
   * Session-only style clipboard; see `copyStyle`.
   *
   * Instance state rather than module state, unlike `internalClipboard` above.
   * The element clipboard is deliberately shared so a copy survives a board
   * being replaced, but a style clipboard has no such requirement, and instance
   * scope means two `Actions` cannot silently share one — which is exactly the
   * cross-contamination a test suite would hit first.
   */
  private styleClipboard: StyleClipboard | null = null;

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

  /**
   * The editable selection, bucketed into the units that alignment moves.
   *
   * A group is one unit. `Store.setSelection` expands a click on any member to
   * the whole group, so treating members individually would align them onto each
   * other and tear the group apart — never what "align these" is asked to mean.
   *
   * Each unit carries its ROTATED world box. `element.x`/`width` describe the
   * unrotated box (see `types.ts`), so a rotated element's visual left edge is
   * not `element.x`; aligning on the stored fields would leave it visibly proud
   * of its neighbours by the rotation overhang.
   */
  private alignmentUnits(): { elements: MindflowElement[]; box: AABB }[] {
    const units = new Map<string, MindflowElement[]>();
    for (const element of this.editableSelection()) {
      // Ungrouped elements each key on their own id, which cannot collide with a
      // group id — both are prefixed, `el_` and `grp_`.
      const key = element.groupId ?? element.id;
      const bucket = units.get(key);
      if (bucket) bucket.push(element);
      else units.set(key, [element]);
    }

    const result: { elements: MindflowElement[]; box: AABB }[] = [];
    for (const elements of units.values()) {
      const box = unionAABB(elements);
      if (box) result.push({ elements, box });
    }
    return result;
  }

  /**
   * Moves whole units by a delta rather than assigning coordinates.
   *
   * Translating by a delta is what makes rotation and grouping fall out for
   * free: the world box moves with the element whatever its angle, and every
   * member of a group receives the same shift.
   */
  private translateUnits(
    moves: { elements: MindflowElement[]; dx: number; dy: number }[],
    label: string,
  ): void {
    const deltas = new Map<ElementId, { dx: number; dy: number }>();
    for (const move of moves) {
      if (move.dx === 0 && move.dy === 0) continue;
      for (const element of move.elements) deltas.set(element.id, { dx: move.dx, dy: move.dy });
    }
    if (deltas.size === 0) return;

    this.store.execute(
      updateElements(
        this.store.document,
        [...deltas.keys()],
        (element) => {
          const delta = deltas.get(element.id);
          if (!delta) return null;
          return { ...element, x: element.x + delta.dx, y: element.y + delta.dy };
        },
        label,
      ),
    );
    this.refreshBoundConnectors(new Set(deltas.keys()));
  }

  align(edge: 'left' | 'centerX' | 'right' | 'top' | 'centerY' | 'bottom'): void {
    const units = this.alignmentUnits();
    if (units.length < 2) return;
    const bounds = unionAABB(units.flatMap((unit) => unit.elements));
    if (!bounds) return;

    const moves = units.map(({ elements, box }) => {
      switch (edge) {
        case 'left':
          return { elements, dx: bounds.minX - box.minX, dy: 0 };
        case 'right':
          return { elements, dx: bounds.maxX - box.maxX, dy: 0 };
        case 'centerX':
          return {
            elements,
            dx: (bounds.minX + bounds.maxX) / 2 - (box.minX + box.maxX) / 2,
            dy: 0,
          };
        case 'top':
          return { elements, dx: 0, dy: bounds.minY - box.minY };
        case 'bottom':
          return { elements, dx: 0, dy: bounds.maxY - box.maxY };
        case 'centerY':
          return {
            elements,
            dx: 0,
            dy: (bounds.minY + bounds.maxY) / 2 - (box.minY + box.maxY) / 2,
          };
      }
    });

    this.translateUnits(moves, 'Align');
  }

  /**
   * Spaces units evenly along one axis, holding the two extremes in place.
   *
   * The gaps between boxes are equalised rather than the centres, which is what
   * looks right when the elements are different sizes — evenly spaced centres
   * leave visibly uneven whitespace as soon as one box is wider than the rest.
   */
  distribute(axis: 'horizontal' | 'vertical'): void {
    const units = this.alignmentUnits();
    // Two units are already evenly distributed by definition; there is no
    // interior to space out until there is a third.
    if (units.length < 3) return;

    const horizontal = axis === 'horizontal';
    const min = (box: AABB) => (horizontal ? box.minX : box.minY);
    const max = (box: AABB) => (horizontal ? box.maxX : box.maxY);

    const ordered = [...units].sort((a, b) => min(a.box) - min(b.box));
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    if (!first || !last) return;

    const span = max(last.box) - min(first.box);
    const occupied = ordered.reduce((total, unit) => total + (max(unit.box) - min(unit.box)), 0);
    // May be negative when the elements overlap; the spacing is still even.
    const gap = (span - occupied) / (ordered.length - 1);

    const moves: { elements: MindflowElement[]; dx: number; dy: number }[] = [];
    let cursor = max(first.box);
    for (let i = 1; i < ordered.length - 1; i += 1) {
      const unit = ordered[i];
      if (!unit) continue;
      const target = cursor + gap;
      const delta = target - min(unit.box);
      moves.push({
        elements: unit.elements,
        dx: horizontal ? delta : 0,
        dy: horizontal ? 0 : delta,
      });
      cursor = target + (max(unit.box) - min(unit.box));
    }

    this.translateUnits(moves, 'Distribute');
  }

  // -------------------------------------------------------------------------
  // Styling
  // -------------------------------------------------------------------------

  /**
   * Copies the appearance of the first selected element.
   *
   * Session-only and deliberately not part of the document: a style clipboard is
   * a working convenience, not board content, and persisting it would be one
   * more thing to migrate for no gain.
   *
   * Typography is captured separately from `style` because it lives in two
   * different places depending on the element — directly on a `text` or `sticky`,
   * inside `label` on everything else. Reading it here and re-routing it in
   * `pasteStyle` is what lets a sticky's font be pasted onto a rectangle's label.
   */
  copyStyle(): void {
    const source = this.store.selectedElements()[0];
    if (!source) return;

    const capabilities = getDefinition(source.type).capabilities;
    const typographySource = capabilities.text
      ? (source as unknown as Record<string, unknown>)
      : capabilities.label && source.label
        ? (source.label as unknown as Record<string, unknown>)
        : null;

    this.styleClipboard = {
      style: { ...source.style },
      opacity: source.opacity,
      typography: typographySource
        ? Object.fromEntries(
            TYPOGRAPHY_KEYS.filter((key) => key in typographySource).map((key) => [
              key,
              typographySource[key],
            ]),
          )
        : null,
    };

    this.notify('Style copied.');
  }

  /** Whether there is a copied style available to paste. */
  get hasCopiedStyle(): boolean {
    return this.styleClipboard !== null;
  }

  /**
   * Applies the copied appearance to the selection.
   *
   * One command, so a paste onto twenty elements is one undo step. The label is
   * its own — reusing `'Change style'` would let it coalesce into a preceding
   * restyle and stop being separately undoable.
   */
  pasteStyle(): void {
    const clipboard = this.styleClipboard;
    if (!clipboard) return;
    const ids = this.editableSelection().map((element) => element.id);
    if (ids.length === 0) return;

    this.store.execute(
      updateElements(
        this.store.document,
        ids,
        (element) => {
          const next = {
            ...element,
            style: { ...element.style, ...clipboard.style },
            opacity: clipboard.opacity,
          } as MindflowElement;

          if (!clipboard.typography) return next;

          const capabilities = getDefinition(element.type).capabilities;
          if (capabilities.text) return { ...next, ...clipboard.typography } as MindflowElement;
          if (capabilities.label && next.label) {
            return { ...next, label: { ...next.label, ...clipboard.typography } } as MindflowElement;
          }
          return next;
        },
        'Paste style',
      ),
    );
  }

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
