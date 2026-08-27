/**
 * Icon set.
 *
 * `src/ui/icons.ts` is a generated, committed artifact, so it has the same
 * failure mode `index.html` has: someone edits the manifest, forgets to
 * regenerate, and the app quietly ships the previous set. The drift check below
 * is the whole reason this file exists.
 *
 * The safety assertions matter for a second reason. `icon()` renders these
 * values with `innerHTML`, which is defensible only because they are generated
 * from a whitelist. Asserting the property here — rather than trusting the
 * generator — means a hand-edit of the generated file also fails.
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ICONS, type IconName } from '../../src/ui/icons.ts';
import { MANIFEST, extract, generate } from '../../scripts/build-icons.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

describe('the generated file', () => {
  it('matches what the generator produces right now', async () => {
    const committed = await readFile(join(ROOT, 'src', 'ui', 'icons.ts'), 'utf8');
    expect(
      committed,
      'src/ui/icons.ts is stale — run `npm run icons` and commit the result',
    ).toBe(await generate());
  });

  it('exports one icon per manifest entry', () => {
    expect(Object.keys(ICONS).sort()).toEqual(Object.keys(MANIFEST).sort());
  });
});

describe('every icon', () => {
  const entries = Object.entries(ICONS) as [IconName, string][];

  it('is non-empty', () => {
    for (const [name, markup] of entries) {
      expect(markup, `${name} is empty`).not.toBe('');
    }
  });

  it('is inner markup, with no <svg> wrapper of its own', () => {
    // The wrapper — viewBox, stroke, size — belongs to `icon()`. A nested one
    // would render at a fixed size and ignore `currentColor`.
    for (const [name, markup] of entries) {
      expect(markup, `${name} carries its own <svg>`).not.toMatch(/<svg/i);
    }
  });

  it('contains only drawable shape elements', () => {
    const allowed = /^(?:<(?:path|circle|ellipse|rect|line|polyline|polygon)\s[^>]*\/>)+$/;
    for (const [name, markup] of entries) {
      expect(markup, `${name} contains something other than a shape element`).toMatch(allowed);
    }
  });

  it('carries no script, no event handler and no external reference', () => {
    for (const [name, markup] of entries) {
      expect(markup, `${name} contains a script`).not.toMatch(/<script/i);
      expect(markup, `${name} contains an event handler`).not.toMatch(/\son[a-z]+\s*=/i);
      // A url(), an href or a data: URI would be a request the built page must
      // never make. See the zero-external-requests invariant in CLAUDE.md.
      expect(markup, `${name} references something external`).not.toMatch(
        /(?:xlink:)?href|url\(|data:/i,
      );
    }
  });
});

describe('the extractor', () => {
  // These are the cases the whitelist exists for. If any of them stops
  // throwing, `icon()`'s use of innerHTML stops being justified.
  it('rejects an element that is not a shape', () => {
    expect(() => extract('evil', '<svg><script/></svg>')).toThrow(/unexpected element/);
    expect(() => extract('evil', '<svg><foreignObject /></svg>')).toThrow(/unexpected element/);
  });

  it('rejects an unknown attribute, including an event handler', () => {
    expect(() => extract('evil', '<svg><path d="M0 0" onload="x()"/></svg>')).toThrow(
      /unexpected attribute/,
    );
    expect(() => extract('evil', '<svg><path d="M0 0" href="http://x"/></svg>')).toThrow(
      /unexpected attribute/,
    );
  });

  it('rejects content it could not parse rather than dropping it', () => {
    expect(() => extract('odd', '<svg><g><path d="M0 0"/></g></svg>')).toThrow(/unparsed content/);
  });

  it('rejects an icon with nothing to draw', () => {
    expect(() => extract('blank', '<svg></svg>')).toThrow(/no drawable content/);
  });

  it('keeps the geometry of a well-formed icon', () => {
    expect(extract('ok', '<svg fill="none"><rect width="18" height="18" x="3" y="3" rx="2" /></svg>')).toBe(
      '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    );
  });
});

describe('align icons', () => {
  /**
   * Lucide names an alignment icon after the axis of its RULE, not the
   * direction things move — `align-start-vertical` is align-LEFT. That is easy
   * to get backwards and impossible to notice by reading the manifest, so
   * assert against the geometry: the rule sits on the edge the action aligns to.
   */
  const RULE_ON = {
    alignLeft: /M2 2v20/, // vertical rule at x=2
    alignRight: /M22 22V2/, // vertical rule at x=22
    alignTop: /M22 2H2/, // horizontal rule at y=2
    alignBottom: /M22 22H2/, // horizontal rule at y=22
    alignCenterX: /M12 2v20/, // vertical rule through the centre
    alignCenterY: /M2 12h20/, // horizontal rule through the centre
  } as const;

  for (const [name, pattern] of Object.entries(RULE_ON)) {
    it(`${name} draws its rule on the edge it aligns to`, () => {
      expect(ICONS[name as IconName]).toMatch(pattern);
    });
  }
});
