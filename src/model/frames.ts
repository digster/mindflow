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
import { isFrame } from './registry.ts';

/** Every frame in the document, topmost first. */
export function framesInDocument(document: MindflowDocument): MindflowElement[] {
  return document.elements.filter(isFrame).reverse();
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
  return frameContaining(framesInDocument(document), element);
}

/** {@link frameFor} against a precomputed topmost-first frame list. */
function frameContaining(
  framesTopmostFirst: readonly MindflowElement[],
  element: MindflowElement,
): MindflowElement | null {
  if (isFrame(element)) return null;
  const centre = elementCenter(element);
  for (const frame of framesTopmostFirst) {
    if (!frame.visible) continue;
    if (pointInAABB(elementWorldAABB(frame), centre)) return frame;
  }
  return null;
}

/**
 * `added` as it should go onto the board: each element in the frame its centre
 * lands in, by rule 1, and each frame in none.
 *
 * Rule 1 is applied when an element is released after a drag, but an element
 * can also arrive already in position: drawn, typed, pasted, duplicated or
 * inserted as an image. Every such path runs its elements through this before
 * adding them, so they join their frame within the same command, and so the
 * same undo step. Before it existed, only box shapes were enrolled, and in a
 * second command.
 *
 * The frames in `added` are candidates too, above the board's own, since new
 * elements go on top. That is what gives a pasted frame's contents to the
 * pasted frame rather than the one they were copied from, and it takes a copy
 * pasted outside every frame out of the one it came from. An element whose
 * membership is already right is returned as the same object.
 */
export function enrolInFrames(
  document: MindflowDocument,
  added: readonly MindflowElement[],
): MindflowElement[] {
  // Topmost first, by `zIndex` rather than array position, because `added` is
  // not part of the document's sorted array yet. The sort is stable, so equal
  // indices keep the board's frames first, in their own order.
  const frames = [...framesInDocument(document), ...added.filter(isFrame).reverse()].sort(
    (a, b) => b.zIndex - a.zIndex,
  );
  return added.map((element) => {
    const frameId = isFrame(element) ? null : (frameContaining(frames, element)?.id ?? null);
    return frameId === element.frameId ? element : ({ ...element, frameId } as MindflowElement);
  });
}

/**
 * What each frame shows as a unit, keyed by frame id: the frame itself, its
 * members, and every element that belongs to no frame but whose centre lies
 * inside it. Each list is in document (paint) order. Used for PDF export,
 * where each frame becomes one page.
 *
 * The last group is rule 1 above, applied to an element whose `frameId` was
 * never set: one written by a script that left the field out, for instance.
 * Such an element sits visibly inside the frame, so leaving it off the page
 * would drop content the reader can see. An element that does belong to a
 * frame stays with that frame, wherever its centre is now; a `frameId` naming
 * no frame counts as none, as `danglingFrameRefs` does.
 */
export function frameContents(document: MindflowDocument): Map<ElementId, MindflowElement[]> {
  const frames = framesInDocument(document);
  const contents = new Map<ElementId, MindflowElement[]>(frames.map((frame) => [frame.id, []]));

  for (const element of document.elements) {
    const recorded = element.frameId !== null && contents.has(element.frameId) ? element.frameId : null;
    const owner = isFrame(element) ? element.id : (recorded ?? frameContaining(frames, element)?.id);
    if (owner) contents.get(owner)?.push(element);
  }
  return contents;
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
    if (!element || !isFrame(element)) continue;
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
    if (isFrame(element)) continue;
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
    document.elements.filter(isFrame).map((element) => element.id),
  );
  return document.elements
    .filter((element) => element.frameId !== null && !frameIds.has(element.frameId))
    .map((element) => ({ ...element, frameId: null }) as MindflowElement);
}
