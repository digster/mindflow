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
import type { ShapeToolId, Store, ToolId } from '../store/store.ts';
import { isShapeTool } from '../store/store.ts';
import type { HandleId, SelectionFrame, SnapGuide } from '../render/overlay.ts';
import { getDefinition } from '../model/registry.ts';
import {
  HANDLE_HIT_SLOP,
  TOUCH_HANDLE_HIT_SLOP,
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
  worldToLocal,
} from '../model/geometry.ts';
import {
  addElements,
  deleteElements,
  replaceElements,
  topZIndex,
} from '../store/commands.ts';
import {
  HIT_TOLERANCE_PX,
  TOUCH_HIT_TOLERANCE_PX,
  boxFromPoints,
  elementAt,
  elementsInBox,
  elementsByIds,
} from './hitTest.ts';
import { reassignFrames, withFrameMembers } from '../model/frames.ts';
import { computeSnap } from './snapping.ts';
import { type PinchPair, pinchViewport } from './pinch.ts';
import {
  BIND_DISTANCE,
  bindConnectorEnds,
  connectorsToRefresh,
  findBindTarget,
  refreshConnector,
  withBoundConnectors,
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

/**
 * The same threshold for a finger.
 *
 * 3px is a mouse-tremor allowance. A finger routinely wanders 5-15px during
 * what the user experiences as a stationary tap, so at 3px nearly every tap
 * became a drag and nudged whatever it landed on — and because a gesture
 * recomputes from its origin rather than from the threshold, the element jumped
 * the whole distance at once.
 */
const TOUCH_DRAG_THRESHOLD_PX = 8;

/** Window and slop for recognising a double tap, in ms and screen pixels. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP_PX = 24;

/** Default size for a shape created by a click rather than a drag. */
const CLICK_CREATE_SIZE = 120;

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; startScreen: Point; startViewport: Viewport }
  | { kind: 'marquee'; origin: Point; additive: boolean }
  | {
      kind: 'move';
      origin: Point;
      originals: MindflowElement[];
      /**
       * What object snapping must ignore: the moving elements themselves, and
       * every connector bound to them. Captured once at pointerdown — see
       * `withBoundConnectors` for why the connectors are in here.
       */
      snapExclude: ReadonlySet<ElementId>;
    }
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
  | { kind: 'interiorHandle'; id: string; original: MindflowElement }
  | { kind: 'createBox'; origin: Point; element: MindflowElement }
  | { kind: 'createLinear'; origin: Point; element: LinearElement }
  | { kind: 'freehand'; element: DrawElement; points: PointTuple[] }
  | { kind: 'erase' }
  | { kind: 'pinch'; start: PinchPair; startViewport: Viewport };

export interface ControllerOptions {
  canvas: HTMLCanvasElement;
  store: Store;
  /**
   * Opens the DOM text editor for an element, on one of its text regions when
   * the type has them (a table cell). `null` means "the element as a whole".
   */
  onEditText: (element: MindflowElement, regionKey: string | null) => void;
  /**
   * Closes the text editor, writing whatever was typed.
   *
   * A callback rather than a store flag because closing the editor is a DOM
   * operation the controller must not reach into, and because the flag alone was
   * never enough: see {@link InteractionController.onPointerDown}.
   */
  onCommitText: () => void;
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
  /**
   * Whether the gesture in progress is being made with a finger.
   *
   * Every touch accommodation keys off this rather than off a media query, so a
   * tablet driven with a stylus or a trackpad keeps the precise thresholds —
   * the device may have a touchscreen without this particular gesture using it.
   */
  private coarsePointer = false;
  /**
   * Every touch currently down, in screen coordinates.
   *
   * Only touches: a mouse or a stylus cannot produce a second contact, and
   * tracking them would mean clearing entries on a `pointerup` the canvas never
   * receives because the press ended outside it.
   */
  private touches = new Map<number, Point>();
  /** The last completed tap, for recognising a double tap. */
  private lastTap: { at: Point; time: number } | null = null;
  /**
   * When a double tap was last handled, suppressing the `dblclick` the browser
   * may synthesise for the same pair.
   *
   * `-Infinity`, not `0`: `performance.now()` is measured from page load, so a
   * zero would make every double-click in the first third of a second after
   * load look like an echo of a tap that never happened.
   */
  private handledDoubleTapAt = Number.NEGATIVE_INFINITY;

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

  /** Travel before a press becomes a drag, for whatever is doing the pressing. */
  private dragThreshold(): number {
    return this.coarsePointer ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX;
  }

  /** Click tolerance in screen pixels, for whatever is doing the pressing. */
  private tolerancePx(): number {
    return this.coarsePointer ? TOUCH_HIT_TOLERANCE_PX : HIT_TOLERANCE_PX;
  }

  /** Handle slop in screen pixels, for whatever is doing the pressing. */
  private handleSlop(): number {
    return this.coarsePointer ? TOUCH_HANDLE_HIT_SLOP : HANDLE_HIT_SLOP;
  }

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
    const { store } = this.options;

    if (event.pointerType === 'touch') {
      this.touches.set(event.pointerId, this.screenPoint(event));
      // A second finger means the user is panning or zooming, not drawing. The
      // gesture the first finger began is abandoned rather than committed: it
      // was never what they were asking for, and by this point it may already
      // have moved something.
      if (this.touches.size === 2) {
        this.beginPinch();
        return;
      }
    }

    if (!event.isPrimary) return;

    // A text editor is open. Committing it here is not an optimisation of the
    // browser's own behaviour — it is the only thing that reliably ends the
    // edit. The editor used to close as a side effect of the native focus
    // change a press on the canvas causes, which a mouse gives you and a touch
    // screen does not: over a `touch-action: none` canvas that has taken a
    // pointer capture, iPadOS leaves the textarea focused and the caret
    // blinking. Clearing the store flag alone (which is what this did) also
    // desynchronised the flag from the editor, so the NEXT press fell through
    // this guard and started a gesture underneath a live editor.
    //
    // The press that dismisses does not also act, which is the same rule the
    // rest of the app's overlays follow.
    if (store.getState().editingId !== null) {
      this.options.onCommitText();
      return;
    }

    this.coarsePointer = event.pointerType === 'touch';

    try {
      this.options.canvas.setPointerCapture(event.pointerId);
    } catch {
      // Throws for a pointer the browser no longer knows about — a synthesised
      // event, or one the OS already reclaimed. Losing the capture degrades the
      // gesture; letting it throw would abandon `onPointerDown` before any
      // gesture was set up at all, which looks like the press doing nothing.
    }
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

    // Every shape-family tool creates the same way, so they are matched by
    // membership rather than by a case list that would have to grow with each
    // new type. See `SHAPE_TOOLS` in the store.
    if (isShapeTool(tool)) {
      this.beginBoxCreate(tool, scene);
      return;
    }

    switch (tool) {
      case 'select':
        this.beginSelectGesture(event, scene);
        break;
      case 'sticky':
      case 'frame':
      case 'table':
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
        this.createTextAt(event, scene);
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
      const handle = handleAt(frame, scene, zoom, canRotate(selected), this.handleSlop());
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

    // Interior dividers (a table's column and row boundaries) sit between the
    // outer handles and the element itself: they belong to something already
    // selected, so they cannot steal a click that was meant to select, and they
    // must win over the element beneath them or a divider would be ungrabbable.
    const interior = this.interiorHandleAt(selected, scene);
    if (interior) {
      this.gesture = { kind: 'interiorHandle', id: interior.id, original: { ...interior.element } };
      return;
    }

    const hit = elementAt(store.document, scene, zoom, { tolerancePx: this.tolerancePx() });
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
    // group even though only one member was hit — and, if a frame is in there,
    // everything the frame contains. Members travel with their frame but are NOT
    // added to the selection: selecting a frame should not offer to restyle its
    // contents, only to reposition them.
    const dragged = store.selectedElements();
    const movingIds = withFrameMembers(store.document, dragged.map((el) => el.id));
    const moving = store.document.elements.filter((el) => movingIds.has(el.id));
    if (moving.length > 0 && canTransform(dragged)) {
      this.gesture = {
        kind: 'move',
        origin: scene,
        originals: moving.map((el) => ({ ...el })),
        snapExclude: withBoundConnectors(store.document, movingIds),
      };
    }
  }

  /**
   * Re-evaluates frame membership after a move, as its own command.
   *
   * Separate from the geometry commit deliberately: membership is a
   * consequence of where things landed, and keeping it distinct means a drag
   * that never crosses a frame border produces no patch at all.
   */
  private reassignFrames(movedIds: ReadonlySet<ElementId>): void {
    const { store } = this.options;
    const changed = reassignFrames(store.document, movedIds);
    if (changed.length === 0) return;
    store.execute(replaceElements(store.document, changed, 'Reframe'));
  }

  /**
   * The interior divider under `scene`, if the selection offers one.
   *
   * Restricted to a single selected, unlocked element on purpose: a divider is a
   * fine adjustment to something you are already working on, and offering it on
   * every table under the pointer would make ordinary clicks near a gridline
   * unpredictable.
   */
  private interiorHandleAt(
    selected: readonly MindflowElement[],
    scene: Point,
  ): { element: MindflowElement; id: string; axis: 'x' | 'y' } | null {
    if (selected.length !== 1) return null;
    const element = selected[0] as MindflowElement;
    if (element.locked) return null;

    const definition = getDefinition(element.type);
    if (!definition.interiorHandles || !definition.dragInteriorHandle) return null;

    // The same slop the outer handles use, in screen pixels and divided by zoom
    // so a divider is equally grabbable at any magnification.
    const tolerance = this.handleSlop() / this.options.store.viewport.zoom;
    const local = worldToLocal(element, scene);
    if (
      local.x < -tolerance ||
      local.y < -tolerance ||
      local.x > element.width + tolerance ||
      local.y > element.height + tolerance
    ) {
      return null;
    }

    for (const handle of definition.interiorHandles(element as never)) {
      const distance =
        handle.axis === 'x'
          ? Math.abs(local.x - handle.position)
          : Math.abs(local.y - handle.position);
      if (distance <= tolerance) return { element, id: handle.id, axis: handle.axis };
    }
    return null;
  }

  /**
   * Applies a divider drag.
   *
   * Recomputed from the element as it was at pointerdown, like every other
   * gesture — which also means the local frame the pointer is projected into
   * stays fixed for the duration, rather than shifting as the element's own
   * width changes underneath it.
   */
  private updateInteriorHandle(scene: Point): void {
    if (this.gesture.kind !== 'interiorHandle') return;
    const { store } = this.options;
    const { original, id } = this.gesture;

    const definition = getDefinition(original.type);
    const next = definition.dragInteriorHandle?.(
      original as never,
      id,
      worldToLocal(original, scene),
    ) as MindflowElement | undefined;
    if (!next) return;

    this.commitLive([next], new Set([next.id]), `Resize ${definition.title.toLowerCase()}`);
  }

  private beginBoxCreate(
    tool: ShapeToolId | 'sticky' | 'frame' | 'table',
    scene: Point,
  ): void {
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

  /**
   * Starts a two-finger pan and zoom.
   *
   * The board has no browser-provided fallback here: the canvas sets
   * `touch-action: none` so it can own every gesture, which also means nothing
   * pans or zooms unless this does. Before it existed, a touchscreen could only
   * zoom through the toolbar.
   */
  private beginPinch(): void {
    const points = [...this.touches.values()];
    const [first, second] = points;
    if (!first || !second) return;

    // Undo whatever the first finger had begun. A press that never crossed its
    // threshold has applied nothing, but one that did has already moved an
    // element, and committing that would leave the user with a stray edit to
    // undo after every pinch.
    this.rewindGesture();
    this.marquee = null;
    this.guides = [];
    this.bindingCandidates = [];
    this.movedPastThreshold = false;
    this.pointerDownScreen = null;
    // A pinch is not a tap, and its two touchdowns must not read as a double
    // tap when the fingers lift.
    this.lastTap = null;

    this.gesture = {
      kind: 'pinch',
      start: [first, second] as PinchPair,
      startViewport: { ...this.options.store.viewport },
    };
    this.options.onOverlayChange();
  }

  private updatePinch(): void {
    if (this.gesture.kind !== 'pinch') return;
    const points = [...this.touches.values()];
    const [first, second] = points;
    if (!first || !second) return;

    this.options.store.setViewport(
      pinchViewport(this.gesture.startViewport, this.gesture.start, [first, second]),
    );
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

  private createTextAt(event: PointerEvent, scene: Point): void {
    const { store } = this.options;
    // The editor this opens focuses itself synchronously, inside this gesture,
    // because iOS raises the soft keyboard only for a focus that happens there.
    // The compatibility `mousedown` the browser sends after this press would
    // then move focus to the document and blur it straight back out — which
    // fires the editor's blur-to-commit and closes it before a key is pressed.
    // Preventing this press's default action suppresses those compatibility
    // events. It is done here and nowhere else in the gesture handler: a press
    // that does NOT take focus still needs the default behaviour, or clicking
    // the canvas would stop committing the board-name field.
    event.preventDefault();
    const element = getDefinition('text').create({
      x: scene.x,
      y: scene.y,
      zIndex: topZIndex(store.document),
    });
    store.execute(addElements([element], 'Add text'));
    store.setSelection([element.id]);
    store.setTool('select');
    this.options.onEditText(element, null);
  }

  // -------------------------------------------------------------------------
  // Pointer move
  // -------------------------------------------------------------------------

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' && this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, this.screenPoint(event));
      if (this.gesture.kind === 'pinch') {
        this.updatePinch();
        return;
      }
    }
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
      if (travelled < this.dragThreshold()) return;
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

      case 'interiorHandle':
        this.updateInteriorHandle(scene);
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
    const { origin, originals, snapExclude } = this.gesture;

    let dx = scene.x - origin.x;
    let dy = scene.y - origin.y;

    // Shift locks movement to the dominant axis — the standard constraint.
    if (event.shiftKey) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0;
      else dx = 0;
    }

    let moved = translateElements(originals, dx, dy);

    // Alt suspends snapping, so exact placement is always possible. Snapping
    // skips `snapExclude` rather than just the moving ids: a bound connector is
    // re-routed from the moving shape every frame, so aligning to it would feed
    // each frame's result into the next and the shape would vibrate.
    const ids = new Set(originals.map((el) => el.id));
    const snap = computeSnap(store.document, moved, snapExclude, store.viewport.zoom, !event.altKey);
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
    this.touches.delete(event.pointerId);

    if (this.gesture.kind === 'pinch') {
      // Lifting one finger ends the pinch outright. Handing the gesture to the
      // finger still down would lurch the board, because that finger has
      // travelled a long way from where it would have started a drag.
      this.gesture = { kind: 'none' };
      this.releaseCapture(event.pointerId);
      this.pointerDownScreen = null;
      this.movedPastThreshold = false;
      this.lastTap = null;
      return;
    }

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
        // Membership is decided on drop, by where each element ended up. Done
        // after the commit so it lands as its own step rather than being folded
        // into the transient replay.
        this.reassignFrames(ids);
        break;
      }

      case 'interiorHandle': {
        if (this.movedPastThreshold) this.updateInteriorHandle(scene);
        const final = elementsByIds(store.document, new Set([this.gesture.original.id]));
        this.commitGesture(
          [this.gesture.original],
          final,
          `Resize ${getDefinition(this.gesture.original.type).title.toLowerCase()}`,
        );
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

    // A tap that stayed put may be the second half of a double tap, which is
    // how a finger opens the text editor. Checked before the state below is
    // reset, and never for a press that became a drag.
    if (this.coarsePointer && !this.movedPastThreshold) {
      this.handleTouchDoubleTap(scene, this.screenPoint(event));
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
    // Drawing something inside a frame must join it, exactly as dropping it there
    // would. Creation is not a move, so it needs its own call — without this, an
    // element drawn straight into a frame is never clipped by it.
    this.reassignFrames(new Set([element.id]));
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

    const startWorld = { x: element.x + (element.points[0]?.[0] ?? 0), y: element.y + (element.points[0]?.[1] ?? 0) };
    element = {
      ...element,
      ...bindConnectorEnds(store.document, startWorld, scene, new Set([element.id])),
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

  private onPointerCancel = (event: PointerEvent): void => {
    // The OS took the pointer away mid-gesture. Abandon it, and rewind whatever
    // it had applied.
    //
    // This used to leave the transient edits in place. Nothing had been written
    // to history, so the element sat wherever the interrupted drag left it with
    // no undo entry to bring it back, and an interrupted *creation* left a
    // shape on the board that could not be undone at all. That was survivable
    // when `pointercancel` meant a mouse had been unplugged; it is not now that
    // a finger triggers it whenever the system claims the pointer.
    //
    // This used to stop there, which was survivable with a mouse (where
    // `pointercancel` is rare) and not with a finger (where the system takes
    // the pointer for palm rejection, a second touch, or a system gesture). The
    // leftovers are what bite: a capture the canvas still holds swallows the
    // next drag entirely — the delayed, unrelated-looking symptom already
    // recorded in LEARNINGS.md — and a stale `movedPastThreshold` makes the
    // next press start out believing it is mid-drag.
    this.releaseCapture(event.pointerId);
    this.pointerDownScreen = null;
    this.movedPastThreshold = false;
    this.lastTap = null;
    // The abandoned transient edits must not coalesce into whatever comes next,
    // or one undo would rewind both.
    this.options.store.history.breakCoalescing();

    this.touches.delete(event.pointerId);
    this.rewindGesture();
    this.gesture = { kind: 'none' };
    this.marquee = null;
    this.guides = [];
    this.bindingCandidates = [];
    this.options.onOverlayChange();
  };

  /**
   * Undoes the transient effects of the gesture in flight.
   *
   * Transient commands never reach history, so this is the only way back: a
   * transform rewinds to the elements captured at pointerdown, and a creation
   * deletes the preview it had been drawing.
   */
  private rewindGesture(): void {
    const { store } = this.options;

    switch (this.gesture.kind) {
      case 'move':
      case 'resize':
      case 'rotate':
        store.execute(replaceElements(store.document, this.gesture.originals, 'Cancel'), true);
        break;
      case 'interiorHandle':
        store.execute(replaceElements(store.document, [this.gesture.original], 'Cancel'), true);
        break;
      case 'createBox':
      case 'createLinear':
      case 'freehand':
        store.execute(deleteElements(store.document, [this.gesture.element.id], 'Cancel'), true);
        break;
      default:
        break;
    }
  }

  /** Releases a pointer capture if the canvas still holds one. */
  private releaseCapture(pointerId?: number): void {
    const { canvas } = this.options;
    const id = pointerId ?? this.capturedPointerId;
    if (id === null || id === undefined) return;
    if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    if (id === this.capturedPointerId) this.capturedPointerId = null;
  }

  // -------------------------------------------------------------------------
  // Other input
  // -------------------------------------------------------------------------

  private onDoubleClick = (event: MouseEvent): void => {
    // A double tap is handled at pointerup, and the browser may then synthesise
    // a `dblclick` for the same pair. Opening the editor twice would replace the
    // element captured at `open`, so the undo rewind would target the wrong
    // state.
    if (performance.now() - this.handledDoubleTapAt < DOUBLE_TAP_MS) return;
    this.editTextAt(this.scenePoint(event));
  };

  /**
   * Opens the text editor on whatever is under `scene`, on the region that was
   * pointed at when the type has regions.
   *
   * Split out of the `dblclick` handler so a double TAP can reach it. `dblclick`
   * is synthesised from two compatibility click pairs, which a touchscreen does
   * not reliably produce over a canvas that takes a pointer capture — and it was
   * the only route into editing an existing element.
   */
  private editTextAt(scene: Point): void {
    const { store } = this.options;
    const hit = elementAt(store.document, scene, store.viewport.zoom, {
      tolerancePx: this.tolerancePx(),
    });
    if (!hit) return;

    const definition = getDefinition(hit.type);
    const capabilities = definition.capabilities;
    if (capabilities.text || capabilities.label) {
      store.setSelection([hit.id]);
      // For a type with regions, edit the one that was actually double-clicked —
      // opening a table always at its first cell would make every cell but one
      // reachable only by tabbing.
      const region = definition.textRegionAt?.(hit as never, worldToLocal(hit, scene)) ?? null;
      this.options.onEditText(hit, region);
    }
  }

  /**
   * Recognises a double tap at `pointerup`, and opens the text editor.
   *
   * Two taps close together in time and place. The slop is generous because the
   * two touches of a real double tap rarely land within a mouse's few pixels,
   * and a tap that turned into a drag is excluded outright.
   */
  private handleTouchDoubleTap(scene: Point, screen: Point): void {
    const now = performance.now();
    const previous = this.lastTap;
    this.lastTap = { at: screen, time: now };

    if (
      previous &&
      now - previous.time < DOUBLE_TAP_MS &&
      Math.hypot(screen.x - previous.at.x, screen.y - previous.at.y) < DOUBLE_TAP_SLOP_PX
    ) {
      this.lastTap = null;
      this.handledDoubleTapAt = now;
      this.editTextAt(scene);
    }
  }

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
    //
    // A long press is the touch equivalent of a right-click, and it arrives
    // exactly this way — but by the time the browser reports it, the press has
    // already begun a `move` or a `marquee`, so this bail silently swallowed
    // every long press on a touchscreen. A gesture that has not passed its drag
    // threshold has applied nothing yet, so abandoning it here costs nothing and
    // is what the user is asking for.
    if (this.gesture.kind !== 'none') {
      if (!this.coarsePointer || this.movedPastThreshold) return;
      this.gesture = { kind: 'none' };
      this.marquee = null;
      this.pointerDownScreen = null;
      this.options.onOverlayChange();
    }

    // `contextmenu` fires between pointerdown and pointerup, and pointerdown has
    // already captured the pointer (before the right-button bail). Releasing it
    // here stops the canvas swallowing the pointer events the menu needs.
    this.releaseCapture();

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
    if (this.gesture.kind === 'interiorHandle') {
      canvas.style.cursor = this.gesture.id.startsWith('c') ? 'col-resize' : 'row-resize';
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
        const handle = handleAt(frame, scene, store.viewport.zoom, canRotate(selected), this.handleSlop());
        if (handle) {
          canvas.style.cursor = handleCursor(handle, frame.angle);
          return;
        }
      }
      // The cursor is the only affordance a divider gets. Drawing chrome for
      // every gridline would clutter the very thing it sits on, and the
      // col-resize/row-resize cursors are the convention people already know.
      const interior = this.interiorHandleAt(selected, scene);
      if (interior) {
        canvas.style.cursor = interior.axis === 'x' ? 'col-resize' : 'row-resize';
        return;
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
