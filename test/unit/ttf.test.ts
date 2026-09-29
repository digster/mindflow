/**
 * The TrueType reader, checked against the fonts MindFlow ships.
 *
 * The expected numbers come from fontTools reading the same files. The PDF
 * writer embeds these fonts and places every glyph by these advance widths, so
 * a misread table would misplace text on every page.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseTrueType, textAdvance } from '../../src/render/ttf.ts';

const FONTS = join(import.meta.dirname, '..', '..', 'src', 'fonts');
const load = (name: string) => parseTrueType(new Uint8Array(readFileSync(join(FONTS, name))));

describe('parseTrueType', () => {
  const inter = load('sans-regular.ttf');

  it('reads the header metrics', () => {
    expect(inter.unitsPerEm).toBe(2048);
    expect(inter.postScriptName).toBe('Inter-Regular');
    expect(inter.numGlyphs).toBe(398);
    expect(inter.bbox).toEqual([-400, -493, 2505, 2042]);
    expect(inter.ascender).toBe(1984);
    expect(inter.descender).toBe(-494);
    expect(inter.capHeight).toBe(1490);
    expect(inter.weightClass).toBe(400);
    expect(inter.italicAngle).toBe(0);
    expect(inter.fixedPitch).toBe(false);
  });

  it('maps characters to glyphs through the cmap', () => {
    expect(inter.glyphFor('A'.codePointAt(0)!)).toBe(1);
    expect(inter.glyphFor(' '.codePointAt(0)!)).toBe(358);
    expect(inter.glyphFor('é'.codePointAt(0)!)).toBe(139);
    expect(inter.glyphFor('—'.codePointAt(0)!)).toBe(276);
  });

  it('answers 0, the missing glyph, for a character the subset left out', () => {
    expect(inter.glyphFor(0x0416)).toBe(0); // Cyrillic Zhe
    expect(inter.glyphFor(0x1f680)).toBe(0); // an emoji, outside the BMP
  });

  it('reads advance widths', () => {
    expect(inter.advance(1)).toBe(1413);
    expect(inter.advance(139)).toBe(1194);
    expect(inter.advance(276)).toBe(2048);
    expect(inter.advance(358)).toBe(576);
  });

  it('knows a monospaced face', () => {
    const mono = load('mono-regular.ttf');
    expect(mono.fixedPitch).toBe(true);
    expect(mono.advance(mono.glyphFor('x'.codePointAt(0)!))).toBe(600);
    expect(mono.advance(mono.glyphFor('W'.codePointAt(0)!))).toBe(600);
  });

  it('reads every shipped face', () => {
    for (const family of ['sans', 'serif', 'mono', 'hand']) {
      for (const role of ['regular', 'bold']) {
        const font = load(`${family}-${role}.ttf`);
        expect(font.glyphFor('a'.codePointAt(0)!), `${family}-${role}`).toBeGreaterThan(0);
        expect(font.advance(font.glyphFor('a'.codePointAt(0)!))).toBeGreaterThan(0);
      }
    }
  });

  it('rejects something that is not a TrueType font', () => {
    expect(() => parseTrueType(new TextEncoder().encode('%PDF-1.4 not a font'))).toThrow();
  });
});

describe('textAdvance', () => {
  const inter = load('sans-regular.ttf');

  it('is the sum of the glyphs’ advances, scaled to the font size', () => {
    // "A é": 1413 + 576 + 1194 font units at 20px on a 2048-unit em.
    expect(textAdvance(inter, 'A é', 20)).toBeCloseTo(((1413 + 576 + 1194) * 20) / 2048, 10);
  });

  it('is null when the face lacks a character, since another font would draw it', () => {
    expect(textAdvance(inter, 'AЖ', 20)).toBeNull();
  });

  it('is zero for no text', () => {
    expect(textAdvance(inter, '', 20)).toBe(0);
  });
});
