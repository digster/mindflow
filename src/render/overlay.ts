/**
 * Interaction overlay: selection outlines, resize/rotate handles, the marquee
 * rectangle, snap guides and binding highlights.
 *
 * Drawn on the same canvas as the scene, immediately after it, inside the same
 * viewport transform. That keeps everything in scene coordinates — but overlay
 * chrome must not scale with zoom (a handle should stay 8 screen pixels whether
 * you are at 10% or 800%), so every constant here is divided by `zoom` at draw
 * time. That single division is the entire trick to zoom-invariant UI on a
 * transformed canvas.
 */

import type { AABB, MindflowElement, Point, Viewport } from '../model/types.ts';
import type { RenderContext } from '../model/registry.ts';
import { capabilitiesOf } from '../model/registry.ts';
import { degToRad, elementWorldAABB, rotatePoint, unionAABB } from '../model/geometry.ts';

/** Screen-pixel sizes. Divided by zoom before use. */
export const HANDLE_SIZE = 9;
export const HANDLE_HIT_SLOP = 5;
export const ROTATE_HANDLE_OFFSET = 24;

const ACCENT = '#5b5bd6';
const ACCENT_SOFT = 'rgba(91, 91, 214, 0.12)';
const BIND_HIGHLIGHT = '#2f9e44';

export type HandleId = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export const RESIZE_HANDLES: readonly HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/**
 * The box the selection UI is drawn around.
 *
 * A single selected element uses the element's own rotated frame, so the handles
 * turn with the shape. A multi-element selection uses the axis-aligned union
 * instead: there is no meaningful shared rotation, and trying to invent one
 * makes group resizing behave unpredictably.
 */
export interface SelectionFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  /** True when this frame came from exactly one element. */
  single: boolean;
}

export function selectionFrame(elements: readonly MindflowElement[]): SelectionFrame | null {
  if (elements.length === 0) return null;

  if (elements.length === 1) {
    const el = elements[0] as MindflowElement;
    return { x: el.x, y: el.y, width: el.width, height: el.height, angle: el.angle, single: true };
  }

  const box = unionAABB(elements);
  if (!box) return null;
  return {
    x: box.minX,
    y: box.minY,
    width: box.maxX - box.minX,
    height: box.maxY - box.minY,
    angle: 0,
    single: false,
  };
}

function frameCenter(frame: SelectionFrame): Point {
  return { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

/** Converts a point in the frame's local space to world space. */
export function frameLocalToWorld(frame: SelectionFrame, local: Point): Point {
  const absolute = { x: frame.x + local.x, y: frame.y + local.y };
  return frame.angle === 0 ? absolute : rotatePoint(absolute, frameCenter(frame), frame.angle);
}

/** Converts a world point into the frame's local space. */
export function frameWorldToLocal(frame: SelectionFrame, world: Point): Point {
  const unrotated =
    frame.angle === 0 ? world : rotatePoint(world, frameCenter(frame), -frame.angle);
  return { x: unrotated.x - frame.x, y: unrotated.y - frame.y };
}

/** World-space position of a handle. */
export function handlePosition(frame: SelectionFrame, handle: HandleId, zoom: number): Point {
  const { width: w, height: h } = frame;

  if (handle === 'rotate') {
    // Sits above the top edge, outside the shape so it never overlaps content.
    return frameLocalToWorld(frame, { x: w / 2, y: -ROTATE_HANDLE_OFFSET / zoom });
  }

  const local: Record<Exclude<HandleId, 'rotate'>, Point> = {
    nw: { x: 0, y: 0 },
    n: { x: w / 2, y: 0 },
    ne: { x: w, y: 0 },
    e: { x: w, y: h / 2 },
    se: { x: w, y: h },
    s: { x: w / 2, y: h },
    sw: { x: 0, y: h },
    w: { x: 0, y: h / 2 },
  };
  return frameLocalToWorld(frame, local[handle]);
}

/**
 * Which handle, if any, is under `world`.
 *
 * Tested before element hit-testing so that grabbing a corner always wins over
 * selecting whatever sits beneath it.
 */
export function handleAt(
  frame: SelectionFrame,
  world: Point,
  zoom: number,
  allowRotate: boolean,
): HandleId | null {
  const radius = (HANDLE_SIZE / 2 + HANDLE_HIT_SLOP) / zoom;
  const candidates: HandleId[] = allowRotate ? [...RESIZE_HANDLES, 'rotate'] : [...RESIZE_HANDLES];

  for (const handle of candidates) {
    const position = handlePosition(frame, handle, zoom);
    if (Math.abs(world.x - position.x) <= radius && Math.abs(world.y - position.y) <= radius) {
      return handle;
    }
  }
  return null;
}

/** CSS cursor for a handle, accounting for the frame's rotation. */
export function handleCursor(handle: HandleId, angle: number): string {
  if (handle === 'rotate') return 'grab';

  // Map the handle to a compass bearing, add the frame's rotation, then snap to
  // the nearest of the four cursors the platform actually provides. Without the
  // rotation term, a shape turned 90° would show a horizontal resize cursor on
  // what is visually its vertical edge.
  const bearings: Record<Exclude<HandleId, 'rotate'>, number> = {
    n: 0,
    ne: 45,
    e: 90,
    se: 135,
    s: 180,
    sw: 225,
    w: 270,
    nw: 315,
  };
  const bearing = (bearings[handle as Exclude<HandleId, 'rotate'>] + angle + 360) % 360;
  const cursors = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  return cursors[Math.round(bearing / 45) % 4] as string;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export interface OverlayState {
  selected: readonly MindflowElement[];
  /** Element under the pointer that is not selected, for a hover hint. */
  hovered: MindflowElement | null;
  /** In-progress rubber-band rectangle, in scene coordinates. */
  marquee: AABB | null;
  /** Shapes a connector would bind to if released now. */
  bindingCandidates: readonly MindflowElement[];
  /** Alignment guides discovered during a snap, in scene coordinates. */
  guides: readonly SnapGuide[];
  viewport: Viewport;
  /** Suppressed while a text editor is open, since the DOM editor owns the UI. */
  editing: boolean;
}

export interface SnapGuide {
  orientation: 'horizontal' | 'vertical';
  /** Scene y for horizontal guides, scene x for vertical ones. */
  position: number;
  /** Extent of the guide line along the other axis. */
  from: number;
  to: number;
}

export function drawOverlay(render: RenderContext, state: OverlayState): void {
  const { ctx } = render;
  const { zoom } = state.viewport;

  ctx.save();
  ctx.setLineDash([]);

  if (state.hovered && !state.selected.includes(state.hovered)) {
    drawOutline(ctx, elementWorldAABB(state.hovered), zoom, 'rgba(91, 91, 214, 0.35)');
  }

  for (const element of state.bindingCandidates) {
    drawOutline(ctx, elementWorldAABB(element), zoom, BIND_HIGHLIGHT, 2);
  }

  for (const guide of state.guides) drawGuide(ctx, guide, zoom);

  if (state.marquee) drawMarquee(ctx, state.marquee, zoom);

  if (!state.editing && state.selected.length > 0) {
    // With several elements selected, each gets a faint outline so it is obvious
    // what is included, plus one shared frame carrying the handles.
    if (state.selected.length > 1) {
      for (const element of state.selected) {
        drawOutline(ctx, elementWorldAABB(element), zoom, 'rgba(91, 91, 214, 0.4)');
      }
    }
    const frame = selectionFrame(state.selected);
    if (frame) drawSelectionFrame(ctx, frame, zoom, canRotate(state.selected));
  }

  ctx.restore();
}

/** Rotation is offered only when every selected element supports it. */
export function canRotate(elements: readonly MindflowElement[]): boolean {
  return elements.length > 0 && elements.every((el) => capabilitiesOf(el).rotatable);
}

function drawOutline(
  ctx: CanvasRenderingContext2D,
  box: AABB,
  zoom: number,
  color: string,
  widthPx = 1,
): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = widthPx / zoom;
  const inset = 1 / zoom;
  ctx.strokeRect(
    box.minX - inset,
    box.minY - inset,
    box.maxX - box.minX + inset * 2,
    box.maxY - box.minY + inset * 2,
  );
  ctx.restore();
}

function drawSelectionFrame(
  ctx: CanvasRenderingContext2D,
  frame: SelectionFrame,
  zoom: number,
  allowRotate: boolean,
): void {
  ctx.save();

  // Draw the frame in its own rotated space so the box hugs a rotated shape
  // instead of being the larger axis-aligned box around it.
  const center = frameCenter(frame);
  ctx.translate(center.x, center.y);
  if (frame.angle !== 0) ctx.rotate(degToRad(frame.angle));
  ctx.translate(-frame.width / 2, -frame.height / 2);

  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1.5 / zoom;
  ctx.strokeRect(0, 0, frame.width, frame.height);

  if (allowRotate) {
    // Stem connecting the shape to the rotation handle.
    ctx.beginPath();
    ctx.moveTo(frame.width / 2, 0);
    ctx.lineTo(frame.width / 2, -ROTATE_HANDLE_OFFSET / zoom);
    ctx.stroke();
  }

  const size = HANDLE_SIZE / zoom;
  const half = size / 2;
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 1.5 / zoom;

  const corners: Point[] = [
    { x: 0, y: 0 },
    { x: frame.width / 2, y: 0 },
    { x: frame.width, y: 0 },
    { x: frame.width, y: frame.height / 2 },
    { x: frame.width, y: frame.height },
    { x: frame.width / 2, y: frame.height },
    { x: 0, y: frame.height },
    { x: 0, y: frame.height / 2 },
  ];
  for (const corner of corners) {
    ctx.beginPath();
    ctx.rect(corner.x - half, corner.y - half, size, size);
    ctx.fill();
    ctx.stroke();
  }

  if (allowRotate) {
    ctx.beginPath();
    ctx.arc(frame.width / 2, -ROTATE_HANDLE_OFFSET / zoom, half, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}

function drawMarquee(ctx: CanvasRenderingContext2D, box: AABB, zoom: number): void {
  ctx.save();
  ctx.fillStyle = ACCENT_SOFT;
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 1 / zoom;
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  ctx.fillRect(box.minX, box.minY, width, height);
  ctx.strokeRect(box.minX, box.minY, width, height);
  ctx.restore();
}

function drawGuide(ctx: CanvasRenderingContext2D, guide: SnapGuide, zoom: number): void {
  ctx.save();
  ctx.strokeStyle = '#e8590c';
  ctx.lineWidth = 1 / zoom;
  ctx.setLineDash([4 / zoom, 4 / zoom]);
  ctx.beginPath();
  if (guide.orientation === 'horizontal') {
    ctx.moveTo(guide.from, guide.position);
    ctx.lineTo(guide.to, guide.position);
  } else {
    ctx.moveTo(guide.position, guide.from);
    ctx.lineTo(guide.position, guide.to);
  }
  ctx.stroke();
  ctx.restore();
}
