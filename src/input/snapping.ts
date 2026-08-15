/**
 * Snapping and alignment guides.
 *
 * Two independent mechanisms, applied in this order:
 *
 *   1. OBJECT SNAP — align the dragged selection's edges and centres with those
 *      of nearby elements. This is what makes a hand-arranged board look tidy
 *      without anyone measuring anything.
 *   2. GRID SNAP — round to the canvas grid, when the grid has snapping enabled.
 *
 * Object snap wins when both apply. Aligning to a neighbour is almost always
 * what someone means; the grid is a fallback for when there is no neighbour.
 */

import type { AABB, ElementId, MindflowDocument, MindflowElement } from '../model/types.ts';
import type { SnapGuide } from '../render/overlay.ts';
import { elementWorldAABB, unionAABB } from '../model/geometry.ts';

/**
 * Snap radius in SCREEN pixels, converted to scene units by the caller.
 *
 * Screen-relative on purpose: at 25% zoom a 6-scene-unit threshold would be
 * under two screen pixels and effectively unreachable, while at 400% it would
 * grab from a centimetre away.
 */
export const SNAP_THRESHOLD_PX = 6;

/** How many nearby elements to consider. Bounds cost on very large boards. */
const MAX_SNAP_CANDIDATES = 200;

export interface SnapResult {
  /** Correction to add to the proposed position. */
  dx: number;
  dy: number;
  guides: SnapGuide[];
}

interface Candidate {
  /** Position along the snapping axis. */
  position: number;
  /** Extent of the source element on the other axis, for drawing the guide. */
  from: number;
  to: number;
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] };

/**
 * Computes the correction that aligns `moving` with nearby static elements.
 *
 * Considers three positions per axis on each box — the two edges and the
 * centre — giving the nine classic alignment relationships (left-to-left,
 * left-to-centre, centre-to-right, and so on) without special-casing any of
 * them.
 */
export function computeObjectSnap(
  document: MindflowDocument,
  moving: AABB,
  excludeIds: ReadonlySet<ElementId>,
  zoom: number,
): SnapResult {
  const threshold = SNAP_THRESHOLD_PX / zoom;

  const statics: MindflowElement[] = [];
  for (const element of document.elements) {
    if (excludeIds.has(element.id) || !element.visible) continue;
    statics.push(element);
    if (statics.length >= MAX_SNAP_CANDIDATES) break;
  }
  if (statics.length === 0) return NO_SNAP;

  const verticalCandidates: Candidate[] = [];
  const horizontalCandidates: Candidate[] = [];

  for (const element of statics) {
    const box = elementWorldAABB(element);
    for (const x of [box.minX, (box.minX + box.maxX) / 2, box.maxX]) {
      verticalCandidates.push({ position: x, from: box.minY, to: box.maxY });
    }
    for (const y of [box.minY, (box.minY + box.maxY) / 2, box.maxY]) {
      horizontalCandidates.push({ position: y, from: box.minX, to: box.maxX });
    }
  }

  const movingX = [moving.minX, (moving.minX + moving.maxX) / 2, moving.maxX];
  const movingY = [moving.minY, (moving.minY + moving.maxY) / 2, moving.maxY];

  const x = bestSnap(movingX, verticalCandidates, threshold);
  const y = bestSnap(movingY, horizontalCandidates, threshold);

  const guides: SnapGuide[] = [];
  if (x) {
    guides.push({
      orientation: 'vertical',
      position: x.candidate.position,
      // Span from the aligned neighbour to the moving box, so the guide visibly
      // connects the two things being aligned.
      from: Math.min(x.candidate.from, moving.minY),
      to: Math.max(x.candidate.to, moving.maxY),
    });
  }
  if (y) {
    guides.push({
      orientation: 'horizontal',
      position: y.candidate.position,
      from: Math.min(y.candidate.from, moving.minX),
      to: Math.max(y.candidate.to, moving.maxX),
    });
  }

  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides };
}

/** Closest candidate to any of the moving positions, within `threshold`. */
function bestSnap(
  movingPositions: number[],
  candidates: Candidate[],
  threshold: number,
): { delta: number; candidate: Candidate } | null {
  let best: { delta: number; candidate: Candidate; distance: number } | null = null;

  for (const moving of movingPositions) {
    for (const candidate of candidates) {
      const delta = candidate.position - moving;
      const distance = Math.abs(delta);
      if (distance > threshold) continue;
      if (!best || distance < best.distance) best = { delta, candidate, distance };
    }
  }

  return best ? { delta: best.delta, candidate: best.candidate } : null;
}

/** Rounds a scene coordinate to the nearest grid line. */
export function snapToGrid(value: number, gridSize: number): number {
  return Math.round(value / gridSize) * gridSize;
}

/**
 * The full snap pipeline for a drag.
 *
 * `enabled` is false while the user holds the snap-override modifier, which
 * every drawing tool offers so that precise placement is always possible.
 */
export function computeSnap(
  document: MindflowDocument,
  movingElements: readonly MindflowElement[],
  excludeIds: ReadonlySet<ElementId>,
  zoom: number,
  enabled: boolean,
): SnapResult {
  if (!enabled || movingElements.length === 0) return NO_SNAP;

  const box = unionAABB(movingElements);
  if (!box) return NO_SNAP;

  const objectSnap = computeObjectSnap(document, box, excludeIds, zoom);
  if (objectSnap.dx !== 0 || objectSnap.dy !== 0) return objectSnap;

  if (document.canvas.grid.snap) {
    const size = document.canvas.grid.size;
    return { dx: snapToGrid(box.minX, size) - box.minX, dy: snapToGrid(box.minY, size) - box.minY, guides: [] };
  }

  return NO_SNAP;
}
