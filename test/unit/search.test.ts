/**
 * Board search and command matching.
 *
 * Both are pure so they can live in the node test environment. The search tests
 * exist mainly to pin the two-places-for-text rule: a `text` or `sticky` element
 * owns its words directly, everything else keeps them in `label`, and search has
 * to reach both without switching on `element.type`.
 */

import { describe, expect, it } from 'vitest';

import '../../src/render/shapes/index.ts';
import { matchCommand } from '../../src/app/commands.ts';
import { createDocument } from '../../src/model/defaults.ts';
import { getDefinition } from '../../src/model/registry.ts';
import { findElements, searchableText } from '../../src/model/search.ts';
import type { MindflowDocument, MindflowElement } from '../../src/model/types.ts';

function withLabel(text: string, overrides: Partial<MindflowElement> = {}): MindflowElement {
  const base = getDefinition('rectangle').create({ x: 0, y: 0, zIndex: 1000 });
  return {
    ...base,
    label: {
      text,
      fontFamily: 'sans',
      fontSize: 20,
      fontWeight: 400,
      lineHeight: 1.25,
      color: '#1a1d23',
      textAlign: 'center',
      verticalAlign: 'middle',
      padding: 8,
    },
    ...overrides,
  } as MindflowElement;
}

function sticky(text: string, overrides: Partial<MindflowElement> = {}): MindflowElement {
  return {
    ...getDefinition('sticky').create({ x: 0, y: 0, zIndex: 2000 }),
    text,
    ...overrides,
  } as MindflowElement;
}

function docWith(...elements: MindflowElement[]): MindflowDocument {
  return { ...createDocument(), elements };
}

describe('searchableText', () => {
  it('reads a sticky’s own text', () => {
    expect(searchableText(sticky('deploy on Friday'))).toBe('deploy on Friday');
  });

  it('reads a shape’s label', () => {
    expect(searchableText(withLabel('decision'))).toBe('decision');
  });

  it('is empty for an element with no text at all', () => {
    const line = getDefinition('line').create({ x: 0, y: 0, zIndex: 1000 }) as MindflowElement;
    expect(searchableText(line)).toBe('');
  });
});

describe('findElements', () => {
  it('matches across both text homes at once', () => {
    const document = docWith(withLabel('Release plan'), sticky('release notes'));
    expect(findElements(document, 'release')).toHaveLength(2);
  });

  it('is case-insensitive', () => {
    expect(findElements(docWith(sticky('Ship It')), 'ship it')).toHaveLength(1);
  });

  it('returns nothing for an empty query', () => {
    // Otherwise every element would "match" and the find bar would jump the
    // viewport the moment it opened.
    expect(findElements(docWith(sticky('anything')), '   ')).toEqual([]);
  });

  it('reports where in the text the match starts', () => {
    const [match] = findElements(docWith(sticky('ship the release')), 'release');
    expect(match?.index).toBe(9);
  });

  it('skips hidden elements', () => {
    // Centring the viewport on something invisible is not a useful answer.
    const document = docWith(sticky('hidden note', { visible: false }));
    expect(findElements(document, 'hidden')).toEqual([]);
  });

  it('still finds text on a locked element', () => {
    // Locked means "scenery", not "unreadable" — and being unable to find text
    // because it sits on a locked background is the same one-way door that
    // locking itself used to be.
    const document = docWith(sticky('locked note', { locked: true }));
    expect(findElements(document, 'locked')).toHaveLength(1);
  });

  it('ignores the third-party meta namespace', () => {
    // MindFlow never reads or interprets `meta`. Surfacing it in search would be
    // interpreting it.
    const document = docWith(sticky('visible words', { meta: { note: 'secret' } }));
    expect(findElements(document, 'secret')).toEqual([]);
  });

  it('returns matches in paint order', () => {
    const first = sticky('alpha match', { zIndex: 1000 });
    const second = sticky('beta match', { zIndex: 2000 });
    const matches = findElements(docWith(first, second), 'match');
    expect(matches.map((match) => match.element.id)).toEqual([first.id, second.id]);
  });
});

describe('matchCommand', () => {
  it('ranks an exact prefix above everything else', () => {
    const prefix = matchCommand({ title: 'Zoom to fit' }, 'zoom');
    const scattered = matchCommand({ title: 'Send to back' }, 'zoom');
    expect(prefix).not.toBeNull();
    expect(scattered).toBeNull();
  });

  it('finds an abbreviation as a subsequence', () => {
    expect(matchCommand({ title: 'Zoom to fit' }, 'zf')).not.toBeNull();
  });

  it('returns null when a character is missing', () => {
    expect(matchCommand({ title: 'Zoom to fit' }, 'zq')).toBeNull();
  });

  it('matches keywords that are not in the title', () => {
    expect(matchCommand({ title: 'Export…', keywords: 'png svg' }, 'png')).not.toBeNull();
  });

  it('ranks a word-boundary hit above one buried mid-word', () => {
    const boundary = matchCommand({ title: 'Bring to front' }, 'front') ?? 0;
    const buried = matchCommand({ title: 'Confront the thing' }, 'front') ?? 0;
    expect(boundary).toBeGreaterThan(buried);
  });

  it('accepts everything for an empty query', () => {
    expect(matchCommand({ title: 'Anything' }, '')).toBe(0);
  });
});
