/**
 * Pointer interaction controller.
 *
 * All canvas gestures live here as one explicit state machine. The alternative —
 * a separate class per tool — was rejected because the interesting gestures
 * *cross* tools: space-to-pan works while the rectangle tool is active, a
 * middle-drag pans during a freehand stroke, and Escape must cancel whatever is
 * in flight. Splitting those across tool classes means duplicating the shared
 * cases in every one of them.
 *
 * ---------------------------------------------------------------------------
 * The gesture lifecycle
 * ---------------------------------------------------------------------------
 *   pointerdown → decide which gesture starts, capture the "before" state
 *   pointermove → recompute from the ORIGINAL state, never incrementally
 *   pointerup   → commit one final, non-transient command
 *
 * The middle step is worth stating plainly: each move recomputes from the state
 * captured at pointerdown, rather than applying a delta to the previous frame.
 * Incremental application accumulates floating-point error across a long drag
 * and, worse, makes a dropped or coalesced event corrupt the result permanently.
 * Recomputing from the origin is both simpler and exactly correct.
 *
 * Moves apply their commands as `transient`, so the undo stack sees one entry
 * for the whole gesture rather than one per frame.
 */

import type {
  DrawElement,
  ElementId,
  LinearElement,
  MindflowElement,
  Point,
  PointTuple,
  Viewport,
} from '../model/types.ts';
import type { Store, ToolId } from '../store/store.ts';
import type { HandleId, SelectionFrame, SnapGuide } from '../render/overlay.ts';
import { getDefinition } from '../model/registry.ts';
import {
  handleAt,
  handleCursor,
  canRotate,
  canTransform,
  selectionFrame,
} from '../render/overlay.ts';
import {
  MAX_ZOOM,
  MIN_ZOOM,
  PALETTE,
  Z_INDEX_STEP,
} from '../model/defaults.ts';
import {
  clamp,
  normalizePathBounds,
  screenToScene,
  simplifyPoints,
} from '../model/geometry.ts';
import {
  addElements,
  deleteElements,
  replaceElements,
  topZIndex,
} from '../store/commands.ts';
import { boxFromPoints, elementAt, elementsInBox, elementsByIds } from './hitTest.ts';
import { computeSnap } from './snapping.ts';
import {
  BIND_DISTANCE,
  connectorsToRefresh,
  createBinding,
  findBindTarget,
  refreshConnector,
} from './binding.ts';
import {
  ROTATION_SNAP_DEGREES,
  applyFrameToElements,
  resizeFrame,
  rotateElements,
  rotationForPointer,
  translateElements,
} from './transform.ts';

/** Pointer travel, in screen pixels, before a press becomes a drag. */
const DRAG_THRESHOLD_PX = 3;

/** Default size for a shape created by a click rather than a drag. */
const CLICK_CREATE_SIZE = 120;

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; startScreen: Point; startViewport: Viewport }
  | { kind: 'marquee'; origin: Point; additive: boolean }
  | { kind: 'move'; origin: Point; originals: MindflowElement[] }
  | {
      kind: 'resize';
      handle: Exclude<HandleId, 'rotate'>;
      frameBefore: SelectionFrame;
      originals: MindflowElement[];
    }
  | {
      kind: 'rotate';
      frameBefore: SelectionFrame;
      originals: MindflowElement[];
      startAngle: number;
    }
  | { kind: 'createBox'; origin: Point; element: MindflowElement }
  | { kind: 'createLinear'; origin: Point; element: LinearElement }
  | { kind: 'freehand'; element: DrawElement; points: PointTuple[] }
  | { kind: 'erase' };

export interface ControllerOptions {
  canvas: HTMLCanvasElement;
  store: Store;
  /** Opens the DOM text editor for an element. */
  onEditText: (element: MindflowElement) => void;
  /** Called when the overlay needs redrawing (hover, marquee, guides). */
  onOverlayChange: () => void;
  /** Prompts for an image file, used by the image tool. */
  onRequestImage: (scenePoint: Point) => void;
  /**
   * Opens the context menu. `screen` is in viewport coordinates for placement,
   * `scene` in board coordinates for position-dependent actions like "Paste
   * here". `hit` is whatever was under the pointer, locked elements included.
   */
  onContextMenu?: (context: { scene: Point; screen: Point; hit: MindflowElement | null }) => void;
}

export class InteractionController {
  private gesture: Gesture = { kind: 'none' };
  private pointerDownScreen: Point | null = null;
  private movedPastThreshold = false;
  private spaceHeld = false;
  /** The pointer the canvas most recently captured; see `onContextMenu`. */
  private capturedPointerId: number | null = null;

  /** Live overlay state, read by the renderer each frame. */
  marquee: ReturnType<typeof boxFromPoints> | null = null;
  hovered: MindflowElement | null = null;
  guides: SnapGuide[] = [];
  bindingCandidates: MindflowElement[] = [];

  constructor(private readonly options: ControllerOptions) {
    const { canvas } = options;
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerCancel);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('contextmenu', this.onContextMenu);
    // `passive: false` so the wheel handler can preventDefault and stop the page
    // (or the browser's own pinch-zoom) from scrolling underneath the canvas.
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy(): void {
    const { canvas } = this.options;
    canvas.removeEventListener('pointerdown', this.onPointerDown);
    canvas.removeEventListener('pointermove', this.onPointerMove);
    canvas.removeEventListener('pointerup', this.onPointerUp);
    canvas.removeEventListener('pointercancel', this.onPointerCancel);
    canvas.removeEventListener('dblclick', this.onDoubleClick);
    canvas.removeEventListener('contextmenu', this.onContextMenu);
    canvas.removeEventListener('wheel', this.onWheel);
  }

  setSpaceHeld(held: boolean): void {
    this.spaceHeld = held;
    this.updateCursor();
  }

  // -------------------------------------------------------------------------
  // Coordinates
  // -------------------------------------------------------------------------

  private screenPoint(event: PointerEvent | WheelEvent | MouseEvent): Point {
    const rect = this.options.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private scenePoint(event: PointerEvent | WheelEvent | MouseEvent): Point {
    return screenToScene(this.screenPoint(event), this.options.store.viewport);
  }

  // -------------------------------------------------------------------------
  // Pointer down
  // -------------------------------------------------------------------------

  private onPointerDown = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    const { store } = this.options;

    // A text editor is open; clicking the canvas should commit it, and that
    // click should not also start a gesture.
    if (store.getState().editingId !== null) {
      store.setEditing(null);
      return;
    }

    this.options.canvas.setPointerCapture(event.pointerId);
    // Remembered so `onContextMenu` can release it. A `contextmenu` event is a
    // MouseEvent and carries no pointerId of its own.
    this.capturedPointerId = event.pointerId;
    this.pointerDownScreen = this.screenPoint(event);
    this.movedPastThreshold = false;

    const scene = this.scenePoint(event);
    const tool = store.getState().activeTool;

    // Panning takes priority over every tool: middle button, space held, or the
    // pan tool itself. Checked first so it works mid-anything.
    if (event.button === 1 || this.spaceHeld || tool === 'pan') {
      this.gesture = {
        kind: 'pan',
        startScreen: this.screenPoint(event),
        startViewport: { ...store.viewport },
      };
      this.updateCursor();
      return;
    }

    if (event.button === 2) return; // Right-click is handled by the context menu.

    switch (tool) {
      case 'select':
        this.beginSelectGesture(event, scene);
        break;
      case 'rectangle':
      case 'ellipse':
      case 'sticky':
        this.beginBoxCreate(tool, scene);
        break;
      case 'line':
      case 'arrow':
        this.beginLinearCreate(tool, scene);
        break;
      case 'draw':
        this.beginFreehand(event, scene);
        break;
      case 'text':
        this.createTextAt(scene);
        break;
      case 'image':
        this.options.onRequestImage(scene);
        store.setTool('select');
        break;
      case 'eraser':
        this.gesture = { kind: 'erase' };
        this.eraseAt(scene);
        break;
    }
  };

  /**
   * Decides what a press with the select tool means.
   *
   * Order matters and encodes the priority the user expects:
   *   1. a selection handle (resize/rotate) — always wins, even over elements
   *      sitting on top of it
   *   2. an element        — select and prepare to move
   *   3. empty canvas      — marquee
   *
   * A locked element can be selected (see {@link onContextMenu}) but never
   * transformed, so a selection containing one offers no handles and starts no
   * move — the only thing it accepts is being unlocked.
   */
  private beginSelectGesture(event: PointerEvent, scene: Point): void {
    const { store } = this.options;
    const { zoom } = store.viewport;
    const selected = store.selectedElements();
    const frame = canTransform(selected) ? selectionFrame(selected) : null;

    if (frame) {
      const handle = handleAt(frame, scene, zoom, canRotate(selected));
      if (handle === 'rotate') {
        this.gesture = {
          kind: 'rotate',
          frameBefore: frame,
          originals: selected.map((el) => ({ ...el })),
          startAngle: rotationForPointer(frame, scene),
        };
        return;
      }
      if (handle) {
        this.gesture = {
          kind: 'resize',
          handle,
          frameBefore: frame,
          originals: selected.map((el) => ({ ...el })),
        };
        return;
      }
    }

    const hit = elementAt(store.document, scene, zoom);
    const additive = event.shiftKey;

    if (!hit) {
      if (!additive) store.clearSelection();
      this.gesture = { kind: 'marquee', origin: scene, additive };
      return;
    }

    if (additive) {
      store.toggleSelection(hit.id);
    } else if (!store.isSelected(hit.id)) {
      store.setSelection([hit.id]);
    }

    // Move whatever is selected after the click resolved, which may be a whole
    // group even though only one member was hit.
    const moving = store.selectedElements();
    if (moving.length > 0 && canTransform(moving)) {
      this.gesture = { kind: 'move', origin: scene, originals: moving.map((el) => ({ ...el })) };
    }
  }

  private beginBoxCreate(tool: 'rectangle' | 'ellipse' | 'sticky', scene: Point): void {
    const { store } = this.options;
    const definition = getDefinition(tool);
    const element = definition.create({
      x: scene.x,
      y: scene.y,
      width: 1,
      height: 1,
      zIndex: topZIndex(store.document),
      ...(tool === 'sticky' ? { fill: PALETTE.sticky[0] } : {}),
    });
    this.gesture = { kind: 'createBox', origin: scene, element };
  }

  private beginLinearCreate(tool: 'line' | 'arrow', scene: Point): void {
    const { store } = this.options;
    const element = getDefinition<LinearElement>(tool).create({
      x: scene.x,
      y: scene.y,
      width: 1,
      height: 1,
      zIndex: topZIndex(store.document),
      points: [
        [0, 0],
        [0, 0],
      ],
    });
    this.gesture = { kind: 'createLinear', origin: scene, element };
  }

  private beginFreehand(event: PointerEvent, scene: Point): void {
    const { store } = this.options;
    // Only a real stylus reports meaningful pressure; a mouse reports a constant
    // 0.5, which would produce a uniformly thin stroke if treated as pressure.
    const pressureSensitive = event.pointerType === 'pen';
    const element = getDefinition<DrawElement>('draw').create({
      x: scene.x,
      y: scene.y,
      zIndex: topZIndex(store.document),
      pressureSensitive,
      points: [[0, 0, event.pressure || 0.5]],
    });
    this.gesture = { kind: 'freehand', element, points: [[0, 0, event.pressure || 0.5]] };
  }

  private createTextAt(scene: Point): void {
    const { store } = this.options;
    const element = getDefinition('text').create({
      x: scene.x,
      y: scene.y,
      zIndex: topZIndex(store.document),
    });
    store.execute(addElements([element], 'Add text'));
    store.setSelection([element.id]);
    store.setTool('select');
    this.options.onEditText(element);
  }

  // -------------------------------------------------------------------------
  // Pointer move
  // -------------------------------------------------------------------------

  private onPointerMove = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    const { store } = this.options;
    const scene = this.scenePoint(event);

    if (this.gesture.kind === 'none') {
      this.updateHover(scene);
      this.updateCursor(scene);
      return;
    }

    if (this.pointerDownScreen && !this.movedPastThreshold) {
      const screen = this.screenPoint(event);
      const travelled = Math.hypot(
        screen.x - this.pointerDownScreen.x,
        screen.y - this.pointerDownScreen.y,
      );
      // Below the threshold this is still a click, not a drag. Without this,
      // a one-pixel tremor while clicking would nudge the element.
      if (travelled < DRAG_THRESHOLD_PX) return;
      this.movedPastThreshold = true;
    }

    switch (this.gesture.kind) {
      case 'pan': {
        const screen = this.screenPoint(event);
        const { startScreen, startViewport } = this.gesture;
        store.setViewport({
          x: startViewport.x - (screen.x - startScreen.x) / startViewport.zoom,
          y: startViewport.y - (screen.y - startScreen.y) / startViewport.zoom,
          zoom: startViewport.zoom,
        });
        break;
      }

      case 'marquee': {
        this.marquee = boxFromPoints(this.gesture.origin, scene);
        this.options.onOverlayChange();
        break;
      }

      case 'move':
        this.updateMove(scene, event);
        break;

      case 'resize':
        this.updateResize(scene, event);
        break;

      case 'rotate':
        this.updateRotate(scene, event);
        break;

      case 'createBox':
        this.updateBoxCreate(scene, event);
        break;

      case 'createLinear':
        this.updateLinearCreate(scene, event);
        break;

      case 'freehand':
        this.updateFreehand(scene, event);
        break;

      case 'erase':
        this.eraseAt(scene);
        break;
    }
  };

  private updateMove(scene: Point, event: PointerEvent): void {
    if (this.gesture.kind !== 'move') return;
    const { store } = this.options;
    const { origin, originals } = this.gesture;

    let dx = scene.x - origin.x;
    let dy = scene.y - origin.y;

    // Shift locks movement to the dominant axis — the standard constraint.
    if (event.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }

    let moved = translateElements(originals, dx, dy);

    // Alt suspends snapping, so exact placement is always possible.
    const ids = new Set(originals.map((el) => el.id));
    const snap = computeSnap(store.document, moved, ids, store.viewport.zoom, !event.altKey);
    if (snap.dx !== 0 || snap.dy !== 0) moved = translateElements(originals, dx + snap.dx, dy + snap.dy);
    this.guides = snap.guides;

    this.commitLive(moved, ids, 'Move');
  }

  private updateResize(scene: Point, event: PointerEvent): void {
    if (this.gesture.kind !== 'resize') return;
    const { frameBefore, handle, originals } = this.gesture;

    const frameAfter = resizeFrame(frameBefore, handle, scene, {
      lockAspect: event.shiftKey,
      fromCenter: event.altKey,
    });
    const resized = applyFrameToElements(originals, frameBefore, frameAfter);
    this.guides = [];
    this.commitLive(resized, new Set(originals.map((el) => el.id)), 'Resize');
  }

  private updateRotate(scene: Point, event: PointerEvent): void {
    if (this.gesture.kind !== 'rotate') return;
    const { frameBefore, originals, startAngle } = this.gesture;

    let delta = rotationForPointer(frameBefore, scene) - startAngle;
    if (event.shiftKey) {
      delta = Math.round(delta / ROTATION_SNAP_DEGREES) * ROTATION_SNAP_DEGREES;
    }

    const pivot = {
      x: frameBefore.x + frameBefore.width / 2,
      y: frameBefore.y + frameBefore.height / 2,
    };
    const rotated = rotateElements(originals, pivot, delta);
    this.guides = [];
    this.commitLive(rotated, new Set(originals.map((el) => el.id)), 'Rotate');
  }

  private updateBoxCreate(scene: Point, event: PointerEvent): void {
    if (this.gesture.kind !== 'createBox') return;
    const { origin, element } = this.gesture;

    let width = Math.abs(scene.x - origin.x);
    let height = Math.abs(scene.y - origin.y);
    if (event.shiftKey) {
      const size = Math.max(width, height);
      width = size;
      height = size;
    }

    // Dragging up or left is normalised into a positive box, preserving the
    // format's "dimensions are always positive" invariant.
    const x = event.altKey ? origin.x - width / 2 : Math.min(origin.x, scene.x);
    const y = event.altKey ? origin.y - height / 2 : Math.min(origin.y, scene.y);

    this.gesture.element = {
      ...element,
      x,
      y,
      width: Math.max(width, 1),
      height: Math.max(height, 1),
    } as MindflowElement;
    this.options.onOverlayChange();
    this.previewElement(this.gesture.element);
  }

  private updateLinearCreate(scene: Point, event: PointerEvent): void {
    if (this.gesture.kind !== 'createLinear') return;
    const { origin, element } = this.gesture;

    let end = scene;
    if (event.shiftKey) {
      // Constrain to 45° increments.
      const dx = scene.x - origin.x;
      const dy = scene.y - origin.y;
      const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const length = Math.hypot(dx, dy);
      end = { x: origin.x + Math.cos(angle) * length, y: origin.y + Math.sin(angle) * length };
    }

    const next = normalizePathBounds({
      ...element,
      x: origin.x,
      y: origin.y,
      points: [
        [0, 0],
        [end.x - origin.x, end.y - origin.y],
      ] as PointTuple[],
    });

    // Highlight what this end would bind to on release.
    const target = findBindTarget(this.options.store.document, end, new Set([element.id]));
    this.bindingCandidates = target ? [target] : [];

    this.gesture.element = next;
    this.previewElement(next);
  }

  private updateFreehand(scene: Point, event: PointerEvent): void {
    if (this.gesture.kind !== 'freehand') return;
    const { element } = this.gesture;

    // `getCoalescedEvents` returns the sub-frame pointer samples the browser
    // batched into this event. Using them is the difference between a smooth
    // stroke and a visibly polygonal one on a high-rate pointer.
    const samples = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [event];

    for (const sample of samples) {
      const point = screenToScene(this.screenPoint(sample), this.options.store.viewport);
      this.gesture.points.push([point.x - element.x, point.y - element.y, sample.pressure || 0.5]);
    }

    const next = normalizePathBounds({ ...element, points: [...this.gesture.points] });
    this.previewElement(next);
  }

  /**
   * Applies an in-flight element as a transient command.
   *
   * Transient means it does not touch the undo stack — the whole gesture becomes
   * one entry when it is committed on pointerup.
   */
  private previewElement(element: MindflowElement): void {
    const { store } = this.options;
    const exists = store.document.elements.some((el) => el.id === element.id);
    if (exists) store.execute(replaceElements(store.document, [element], 'Draw', true), true);
    else store.execute(addElements([element], 'Draw'), true);
  }

  /** Applies moved/resized elements plus any connectors that must follow them. */
  private commitLive(elements: MindflowElement[], ids: Set<ElementId>, label: string): void {
    const { store } = this.options;
    const command = replaceElements(store.document, elements, label, true);
    store.execute(command, true);

    const connectors = connectorsToRefresh(store.document, ids);
    if (connectors.length > 0) {
      store.execute(replaceElements(store.document, connectors, label, true), true);
    }
    this.options.onOverlayChange();
  }

  // -------------------------------------------------------------------------
  // Pointer up
  // -------------------------------------------------------------------------

  private onPointerUp = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    const { store } = this.options;
    const scene = this.scenePoint(event);

    if (this.options.canvas.hasPointerCapture(event.pointerId)) {
      this.options.canvas.releasePointerCapture(event.pointerId);
    }

    switch (this.gesture.kind) {
      case 'marquee': {
        // Extend to the release position first — `pointerup` reports a position
        // of its own, and the last `pointermove` may lag behind it.
        if (this.movedPastThreshold) {
          this.marquee = boxFromPoints(this.gesture.origin, scene);
        }
        if (this.marquee) {
          const found = elementsInBox(store.document, this.marquee);
          const ids = found.map((el) => el.id);
          if (this.gesture.additive) store.addToSelection(ids);
          else store.setSelection(ids);
        }
        this.marquee = null;
        break;
      }

      case 'move':
      case 'resize':
      case 'rotate': {
        // Apply the release position, for the same reason as above.
        if (this.movedPastThreshold) {
          if (this.gesture.kind === 'move') this.updateMove(scene, event);
          else if (this.gesture.kind === 'resize') this.updateResize(scene, event);
          else this.updateRotate(scene, event);
        }

        // The live edits were transient. Replay the final state as one real
        // command so the whole gesture is a single undo step.
        const ids = new Set(this.gesture.originals.map((el) => el.id));
        const finalElements = elementsByIds(store.document, ids);
        this.commitGesture(this.gesture.originals, finalElements, labelFor(this.gesture.kind));
        break;
      }

      case 'createBox': {
        // Apply the release position before committing. `pointerup` carries a
        // position of its own, and it is frequently a few pixels beyond the last
        // `pointermove` the browser delivered — without this, a shape ends up
        // slightly smaller than where the user actually let go.
        if (this.movedPastThreshold) this.updateBoxCreate(scene, event);
        const element = this.sizeIfUnDragged(this.gesture.element, this.gesture.origin);
        this.finishCreate(element);
        break;
      }

      case 'createLinear': {
        if (this.movedPastThreshold) this.updateLinearCreate(scene, event);
        this.finishLinearCreate(scene);
        break;
      }

      case 'freehand': {
        this.finishFreehand();
        break;
      }
    }

    this.gesture = { kind: 'none' };
    this.pointerDownScreen = null;
    this.movedPastThreshold = false;
    this.guides = [];
    this.bindingCandidates = [];
    store.history.breakCoalescing();
    this.updateCursor(scene);
    this.options.onOverlayChange();
  };

  /**
   * Replays a completed gesture as a single undoable command.
   *
   * The transient commands already moved the document to its final state, so
   * this rewinds to the originals and reapplies — producing one patch whose
   * `before` is where the gesture started.
   */
  private commitGesture(
    originals: MindflowElement[],
    finalElements: MindflowElement[],
    label: string,
  ): void {
    const { store } = this.options;
    if (finalElements.length === 0) return;

    const unchanged = finalElements.every((element) => {
      const original = originals.find((candidate) => candidate.id === element.id);
      return original && sameGeometry(original, element);
    });
    if (unchanged) return;

    const restore = replaceElements(store.document, originals, label);
    store.execute(restore, true);
    store.execute(replaceElements(store.document, finalElements, label));
  }

  /** A click without a drag creates a default-sized shape centred on the click. */
  private sizeIfUnDragged(element: MindflowElement, origin: Point): MindflowElement {
    if (this.movedPastThreshold) return element;
    const definition = getDefinition(element.type);
    const template = definition.create({ x: 0, y: 0, zIndex: element.zIndex });
    const width = template.width > 1 ? template.width : CLICK_CREATE_SIZE;
    const height = template.height > 1 ? template.height : CLICK_CREATE_SIZE;
    return { ...element, x: origin.x - width / 2, y: origin.y - height / 2, width, height };
  }

  private finishCreate(element: MindflowElement): void {
    const { store } = this.options;
    // Remove the transient preview, then add the element for real so the undo
    // stack holds exactly one "add" entry.
    store.execute(deleteElements(store.document, [element.id]), true);
    store.execute(addElements([element], `Add ${getDefinition(element.type).title.toLowerCase()}`));
    store.setSelection([element.id]);
    store.setTool('select');
  }

  private finishLinearCreate(scene: Point): void {
    if (this.gesture.kind !== 'createLinear') return;
    const { store } = this.options;
    let element = this.gesture.element;

    // A click without a drag is not a connector; discard it rather than leaving
    // a zero-length arrow on the board.
    if (!this.movedPastThreshold) {
      store.execute(deleteElements(store.document, [element.id]), true);
      store.setTool('select');
      return;
    }

    const exclude = new Set([element.id]);
    const startWorld = { x: element.x + (element.points[0]?.[0] ?? 0), y: element.y + (element.points[0]?.[1] ?? 0) };
    const startTarget = findBindTarget(store.document, startWorld, exclude);
    const endTarget = findBindTarget(store.document, scene, exclude);

    element = {
      ...element,
      startBinding: startTarget ? createBinding(startTarget, startWorld) : null,
      endBinding: endTarget ? createBinding(endTarget, scene) : null,
    };

    store.execute(deleteElements(store.document, [element.id]), true);
    // Re-route immediately so the arrow snaps to its targets' outlines the
    // moment it is created, rather than on the next move.
    const routed = refreshConnector({ ...store.document, elements: [...store.document.elements, element] }, element);
    store.execute(addElements([routed], 'Add connector'));
    store.setSelection([routed.id]);
    store.setTool('select');
  }

  private finishFreehand(): void {
    if (this.gesture.kind !== 'freehand') return;
    const { store } = this.options;
    const { element, points } = this.gesture;

    store.execute(deleteElements(store.document, [element.id]), true);
    if (points.length < 2) {
      store.setTool('select');
      return;
    }

    // Simplification runs once, on commit rather than during the stroke, so the
    // live feedback stays exact and only the stored result is thinned.
    const simplified = simplifyPoints(points);
    const finished = normalizePathBounds({ ...element, points: simplified });
    store.execute(addElements([finished], 'Draw'));
  }

  private onPointerCancel = (): void => {
    // The OS took the pointer away mid-gesture. Abandon it; transient edits are
    // left as-is rather than half-committed to history.
    this.gesture = { kind: 'none' };
    this.marquee = null;
    this.guides = [];
    this.bindingCandidates = [];
    this.options.onOverlayChange();
  };

  // -------------------------------------------------------------------------
  // Other input
  // -------------------------------------------------------------------------

  private onDoubleClick = (event: MouseEvent): void => {
    const { store } = this.options;
    const scene = this.scenePoint(event);
    const hit = elementAt(store.document, scene, store.viewport.zoom);
    if (!hit) return;

    const capabilities = getDefinition(hit.type).capabilities;
    if (capabilities.text || capabilities.label) {
      store.setSelection([hit.id]);
      this.options.onEditText(hit);
    }
  };

  private onContextMenu = (event: MouseEvent): void => {
    // The app supplies its own menu; suppress the browser's.
    event.preventDefault();
    const { store } = this.options;
    const scene = this.scenePoint(event);
    const { zoom } = store.viewport;

    // Locked elements are click-through by design — that is what makes a locked
    // background behave like scenery. Taken alone it is a trap: once locked, an
    // element can never be picked again, and so can never be unlocked. Falling
    // back to a locked hit here is the way out, and it costs the scenery
    // behaviour nothing because a plain click still passes straight through.
    const hit =
      elementAt(store.document, scene, zoom) ??
      elementAt(store.document, scene, zoom, { includeLocked: true });
    if (hit && !store.isSelected(hit.id)) store.setSelection([hit.id]);

    // A menu opened mid-gesture would act on a selection that is still moving,
    // and its dismissal would race the pointerup that ends the drag.
    if (this.gesture.kind !== 'none') return;

    // `contextmenu` fires between pointerdown and pointerup, and pointerdown has
    // already captured the pointer (before the right-button bail). Releasing it
    // here stops the canvas swallowing the pointer events the menu needs.
    if (this.capturedPointerId !== null && this.options.canvas.hasPointerCapture(this.capturedPointerId)) {
      this.options.canvas.releasePointerCapture(this.capturedPointerId);
    }

    this.options.onContextMenu?.({ scene, screen: { x: event.clientX, y: event.clientY }, hit });
  };

  /**
   * Wheel handling.
   *
   * `ctrlKey` on a wheel event is how browsers report a trackpad pinch, which is
   * why pinch-to-zoom and ctrl-scroll are the same code path. A plain wheel pans,
   * matching every other infinite-canvas tool.
   */
  private onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const { store } = this.options;
    const viewport = store.viewport;

    if (event.ctrlKey || event.metaKey) {
      const screen = this.screenPoint(event);
      // Exponential so each notch is a constant *ratio*, which is what makes
      // zooming feel linear to the hand.
      const zoom = clamp(viewport.zoom * Math.exp(-event.deltaY * 0.01), MIN_ZOOM, MAX_ZOOM);
      store.setViewport(zoomAbout(viewport, zoom, screen));
      return;
    }

    store.setViewport({
      x: viewport.x + event.deltaX / viewport.zoom,
      y: viewport.y + event.deltaY / viewport.zoom,
      zoom: viewport.zoom,
    });
  };

  private eraseAt(scene: Point): void {
    const { store } = this.options;
    const hit = elementAt(store.document, scene, store.viewport.zoom);
    if (hit) store.execute(deleteElements(store.document, [hit.id], 'Erase'));
  }

  private updateHover(scene: Point): void {
    const { store } = this.options;
    if (store.getState().activeTool !== 'select') {
      if (this.hovered) {
        this.hovered = null;
        this.options.onOverlayChange();
      }
      return;
    }
    const hit = elementAt(store.document, scene, store.viewport.zoom);
    if (hit !== this.hovered) {
      this.hovered = hit;
      this.options.onOverlayChange();
    }
  }

  private updateCursor(scene?: Point): void {
    const { canvas, store } = this.options;
    const tool = store.getState().activeTool;

    if (this.gesture.kind === 'pan') {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (this.spaceHeld || tool === 'pan') {
      canvas.style.cursor = 'grab';
      return;
    }
    if (tool === 'text') {
      canvas.style.cursor = 'text';
      return;
    }
    if (tool !== 'select') {
      canvas.style.cursor = 'crosshair';
      return;
    }

    if (scene) {
      const selected = store.selectedElements();
      const frame = canTransform(selected) ? selectionFrame(selected) : null;
      if (frame) {
        const handle = handleAt(frame, scene, store.viewport.zoom, canRotate(selected));
        if (handle) {
          canvas.style.cursor = handleCursor(handle, frame.angle);
          return;
        }
      }
      if (this.hovered) {
        canvas.style.cursor = 'move';
        return;
      }
    }
    canvas.style.cursor = 'default';
  }
}

/** Zooms while keeping the scene point under `screenAnchor` stationary. */
export function zoomAbout(viewport: Viewport, zoom: number, screenAnchor: Point): Viewport {
  const scene = screenToScene(screenAnchor, viewport);
  return {
    zoom,
    x: scene.x - screenAnchor.x / zoom,
    y: scene.y - screenAnchor.y / zoom,
  };
}

function labelFor(kind: 'move' | 'resize' | 'rotate'): string {
  return kind === 'move' ? 'Move' : kind === 'resize' ? 'Resize' : 'Rotate';
}

function sameGeometry(a: MindflowElement, b: MindflowElement): boolean {
  return (
    Math.abs(a.x - b.x) < 0.001 &&
    Math.abs(a.y - b.y) < 0.001 &&
    Math.abs(a.width - b.width) < 0.001 &&
    Math.abs(a.height - b.height) < 0.001 &&
    Math.abs(a.angle - b.angle) < 0.001
  );
}
