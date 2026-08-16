/**
 * Frame containment rules.
 *
 * Kept in the model layer, and free of DOM and rendering concerns, because these
 * rules are part of the published format: `docs/03-elements.md` and
 * `docs/05-interactions.md` specify them, and an external tool that rewrites a
 * board has to apply the same ones to stay consistent.
 *
 * The whole model is three rules:
 *
 *   1. An element belongs to the topmost frame whose box contains its CENTRE.
 *   2. Moving a frame moves its members by the same delta.
 *   3. Deleting a frame deletes its members.
 *
 * Centre containment rather than full overlap is the deliberate choice: it gives
 * one unambiguous answer for an element straddling a border, and it matches how
 * dragging feels — the thing follows the pointer, so the pointer's end of it is
 * what decides.
 */

import type { ElementId, MindflowDocument, MindflowElement } from './types.ts';
import { elementCenter, elementWorldAABB, pointInAABB } from './geometry.ts';

/** Every frame in the document, topmost first. */
export function framesInDocument(document: MindflowDocument): MindflowElement[] {
  return document.elements.filter((element) => element.type === 'frame').reverse();
}

/**
 * The frame that should contain `element` at its current position, or `null`.
 *
 * Topmost wins when frames overlap, matching hit-testing. A frame is never
 * contained by another frame — frames do not nest.
 */
export function frameFor(
  document: MindflowDocument,
  element: MindflowElement,
): MindflowElement | null {
  if (element.type === 'frame') return null;
  const centre = elementCenter(element);
  for (const frame of framesInDocument(document)) {
    if (!frame.visible) continue;
    if (pointInAABB(elementWorldAABB(frame), centre)) return frame;
  }
  return null;
}

/** The elements belonging to a frame. */
export function membersOf(document: MindflowDocument, frameId: ElementId): MindflowElement[] {
  return document.elements.filter((element) => element.frameId === frameId);
}

/**
 * Expands a set of ids to include the members of any frame in it.
 *
 * Used by move and delete, which both act on whole frames. Not applied to the
 * *selection*, deliberately: selecting a frame should not visually select
 * everything inside it, or the style panel would offer to restyle content the
 * user only meant to reposition.
 */
export function withFrameMembers(
  document: MindflowDocument,
  ids: Iterable<ElementId>,
): Set<ElementId> {
  const result = new Set(ids);
  for (const id of [...result]) {
    const element = document.elements.find((candidate) => candidate.id === id);
    if (element?.type !== 'frame') continue;
    for (const member of membersOf(document, id)) result.add(member.id);
  }
  return result;
}

/**
 * Recomputes `frameId` for elements that just moved.
 *
 * Returns only the elements whose membership actually changed, so a drag that
 * stays inside one frame produces no patch at all.
 *
 * Frames themselves are skipped: dragging a frame over another must not enrol it
 * as a child, and its own members travel with it rather than being re-evaluated.
 */
export function reassignFrames(
  document: MindflowDocument,
  movedIds: ReadonlySet<ElementId>,
): MindflowElement[] {
  const changed: MindflowElement[] = [];
  for (const element of document.elements) {
    if (!movedIds.has(element.id)) continue;
    if (element.type === 'frame') continue;
    const frame = frameFor(document, element);
    const next = frame?.id ?? null;
    if (next !== element.frameId) changed.push({ ...element, frameId: next });
  }
  return changed;
}

/**
 * Drops `frameId` references that name something which is not a frame in this
 * document — a deleted frame, or a hand-authored typo.
 *
 * Returns the elements needing repair, or an empty array when the document is
 * already consistent. A dangling reference would otherwise clip an element to
 * nothing, making it invisible with no way to find out why.
 */
export function danglingFrameRefs(document: MindflowDocument): MindflowElement[] {
  const frameIds = new Set(
    document.elements.filter((element) => element.type === 'frame').map((element) => element.id),
  );
  return document.elements
    .filter((element) => element.frameId !== null && !frameIds.has(element.frameId))
    .map((element) => ({ ...element, frameId: null }) as MindflowElement);
}
