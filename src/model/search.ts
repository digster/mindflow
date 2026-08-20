/**
 * Board text search.
 *
 * Pure and DOM-free, so it can be unit-tested in the node environment the rest
 * of the model uses. The UI in `src/ui/findBar.ts` is a thin shell over this.
 *
 * Text lives in three places depending on the element — directly on a `text` or
 * `sticky`, spread across addressable regions on a `table`, inside `label` on
 * every other shape — and this module resolves that through the registry rather
 * than switching on `element.type`, which no code outside `render/shapes/` may
 * do.
 */

import { getDefinition } from './registry.ts';
import type { MindflowDocument, MindflowElement } from './types.ts';

/**
 * The searchable text of an element, or `''` when it carries none.
 *
 * `meta` is deliberately excluded. It is the namespace reserved for third-party
 * tools, which MindFlow never reads or interprets — surfacing it in search would
 * be interpreting it.
 */
export function searchableText(element: MindflowElement): string {
  const definition = getDefinition(element.type);
  const capabilities = definition.capabilities;

  // A type whose text is split across regions (a table's cells) is joined with
  // newlines. That makes each cell independently findable while keeping the
  // result one string, so callers need no second code path — and it means a
  // query never matches across a cell boundary, which would be a false hit.
  if (definition.textRegions) {
    return definition.textRegions(element as never).map((region) => region.text).join('\n');
  }

  if (capabilities.text) return (element as unknown as { text?: string }).text ?? '';
  if (capabilities.label) return element.label?.text ?? '';
  return '';
}

export interface SearchMatch {
  element: MindflowElement;
  /** Index of the match within the element's text, for future highlighting. */
  index: number;
}

/**
 * Every element whose text contains `query`, in paint order.
 *
 * Case-insensitive substring rather than anything cleverer: this is "where did I
 * write that", and a fuzzy match would surface elements that do not contain what
 * was typed, which reads as a bug when the result is highlighted on the canvas.
 *
 * Hidden elements are skipped — centring the viewport on something invisible is
 * not a useful answer. Locked ones are kept: they are still readable, and being
 * unable to find text because it happens to sit on a locked background would be
 * the same one-way door that locking itself once was.
 */
export function findElements(document: MindflowDocument, query: string): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [];

  const matches: SearchMatch[] = [];
  for (const element of document.elements) {
    if (!element.visible) continue;
    const index = searchableText(element).toLowerCase().indexOf(needle);
    if (index !== -1) matches.push({ element, index });
  }
  return matches;
}
