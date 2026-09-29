/**
 * The fonts MindFlow ships, in the built page.
 *
 * The property everything else rests on: with these fonts, the canvas measures
 * a string as exactly the sum of its glyphs' advance widths, the rule
 * `docs/07-rendering.md` publishes and a PDF viewer applies. It holds only
 * because `scripts/build-fonts.py` strips kerning, ligatures and hinting, so
 * the test reads the committed font files in Node and compares every face with
 * the browser. A regenerated font that kept its kerning would fail here.
 */

import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseTrueType, textAdvance } from '../../src/render/ttf.ts';

const APP_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'index.html')).href;
const FONTS = join(import.meta.dirname, '..', '..', 'src', 'fonts');

const FAMILIES = { sans: 'MindFlow Sans', serif: 'MindFlow Serif', mono: 'MindFlow Mono', hand: 'MindFlow Hand' } as const;

/** Kerning pairs, ligature candidates, accents, dashes and quotes. */
const SAMPLES = [
  'Ship PDF export — one page per frame',
  'AV To Wa Ty fi fl ffi',
  'état-major, naïve Łódź, 2024-09 “quoted” …',
  'iiiii WWWWW 0123456789',
];

async function open(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto(APP_URL);
  await page.waitForFunction(() => 'mindflow' in window);
  return errors;
}

/** How wide the page's canvas measures each sample, per size. */
async function canvasWidths(page: Page, font: string, sizes: number[]) {
  return page.evaluate(
    ({ font, sizes, samples }) => {
      const ctx = document.createElement('canvas').getContext('2d')!;
      return sizes.map((size) => {
        ctx.font = font.replace('{size}', String(size));
        return samples.map((sample) => ctx.measureText(sample).width);
      });
    },
    { font, sizes, samples: SAMPLES },
  );
}

test('installs every bundled face before the app starts', async ({ page }) => {
  const errors = await open(page);
  const faces = await page.evaluate(() => [...document.fonts].map((face) => `${face.family}|${face.weight}|${face.status}`));
  for (const family of Object.values(FAMILIES)) {
    expect(faces).toContain(`${family}|1 549|loaded`);
    expect(faces).toContain(`${family}|550 1000|loaded`);
  }
  expect(errors).toEqual([]);
});

for (const [family, cssFamily] of Object.entries(FAMILIES)) {
  for (const role of ['regular', 'bold'] as const) {
    test(`the canvas measures ${family} ${role} as the sum of its advances`, async ({ page }) => {
      await open(page);
      const font = parseTrueType(new Uint8Array(readFileSync(join(FONTS, `${family}-${role}.ttf`))));
      const weight = role === 'bold' ? 600 : 400;
      const sizes = [9, 13, 20, 37.5, 72];
      const measured = await canvasWidths(page, `${weight} {size}px "${cssFamily}"`, sizes);

      sizes.forEach((size, row) => {
        SAMPLES.forEach((sample, column) => {
          const expected = textAdvance(font, sample, size);
          expect(expected, `${sample} is covered by ${family}-${role}`).not.toBeNull();
          expect(Math.abs(measured[row]![column]! - expected!), `${sample} at ${size}px`).toBeLessThan(0.01);
        });
      });
    });
  }
}

test('picks the bold face from weight 550 up, and never synthesises one', async ({ page }) => {
  await open(page);
  const regular = parseTrueType(new Uint8Array(readFileSync(join(FONTS, 'sans-regular.ttf'))));
  const bold = parseTrueType(new Uint8Array(readFileSync(join(FONTS, 'sans-bold.ttf'))));
  const sample = SAMPLES[0]!;

  for (const [weight, font] of [
    [100, regular],
    [400, regular],
    [549, regular],
    [550, bold],
    [700, bold],
    [900, bold],
  ] as const) {
    const width = await page.evaluate(
      ({ weight, sample }) => {
        const ctx = document.createElement('canvas').getContext('2d')!;
        ctx.font = `${weight} 20px "MindFlow Sans"`;
        return ctx.measureText(sample).width;
      },
      { weight, sample },
    );
    expect(Math.abs(width - textAdvance(font, sample, 20)!), `weight ${weight}`).toBeLessThan(0.01);
  }
});

test('an SVG export carries the faces its text uses', async ({ page }) => {
  await open(page);
  await page.locator('[data-tool="sticky"]').click();
  const box = (await page.locator('.mf-canvas').boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 250, { steps: 5 });
  await page.mouse.up();
  await page.mouse.dblclick(box.x + 200, box.y + 170);
  await expect(page.locator('.mf-text-editor')).toBeFocused();
  await page.keyboard.type('Self-contained');
  await page.keyboard.press('Escape');

  const svg = await page.evaluate(() => {
    const mf = (window as unknown as { mindflow: { store: { document: unknown }; exportToSVG(d: unknown): string } })
      .mindflow;
    return mf.exportToSVG(mf.store.document);
  });
  // Only the face the note uses: sans at the default weight.
  expect(svg.match(/@font-face/g)).toHaveLength(1);
  expect(svg).toContain('@font-face{font-family:"MindFlow Sans";font-weight:1 549;src:url(data:font/ttf;base64,');
});

test('still starts, on system fonts, when the bundled ones cannot be installed', async ({ page }) => {
  // A browser without DecompressionStream cannot unpack the fonts.
  await page.addInitScript(() => {
    delete (window as unknown as { DecompressionStream?: unknown }).DecompressionStream;
  });
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning') warnings.push(message.text());
  });
  const errors = await open(page);

  expect(errors).toEqual([]);
  expect(warnings.some((text) => text.includes('bundled fonts unavailable'))).toBe(true);
  const faces = await page.evaluate(() => [...document.fonts].filter((face) => face.family.startsWith('MindFlow')).length);
  expect(faces).toBe(0);
  await expect(page.locator('.mf-canvas')).toBeVisible();
});
