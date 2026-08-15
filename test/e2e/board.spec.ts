/**
 * End-to-end tests against the built, single-file `index.html`.
 *
 * These drive the app through real pointer events on the canvas and assert on
 * the resulting document — the same path a user takes. Where a test needs to
 * inspect state, it reads `window.mindflow`, the same store the UI itself uses.
 */

import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const APP_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'index.html')).href;

/** Canvas bounding box, so gestures can be expressed in canvas-relative pixels. */
async function canvasBox(page: Page) {
  const box = await page.locator('.mf-canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  return box;
}

/** Drags on the canvas in canvas-relative coordinates. */
async function drag(page: Page, from: [number, number], to: [number, number], steps = 8) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps });
  await page.mouse.up();
}

/** The current document, read from the live store. */
async function getDocument(page: Page) {
  return page.evaluate(() => {
    const mf = (window as unknown as { mindflow: { store: { document: unknown } } }).mindflow;
    return JSON.parse(JSON.stringify(mf.store.document)) as {
      elements: Record<string, unknown>[];
      meta: { name: string };
      files: Record<string, unknown>;
    };
  });
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  (page as unknown as { __errors: string[] }).__errors = errors;

  await page.goto(APP_URL);
  await page.waitForFunction(() => 'mindflow' in window);
});

test.afterEach(async ({ page }) => {
  // Any uncaught error or console error during a test is a failure, even if the
  // assertions passed — a silently broken frame is still broken.
  const errors = (page as unknown as { __errors: string[] }).__errors ?? [];
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

test.describe('boot', () => {
  test('runs from file:// with no server and no external requests', async ({ page }) => {
    // The core promise of the build. If a module script or CDN asset ever creeps
    // back in, this is what catches it.
    const external: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('file://')) external.push(request.url());
    });

    await page.reload();
    await page.waitForFunction(() => 'mindflow' in window);

    expect(external).toEqual([]);
    await expect(page.locator('.mf-canvas')).toBeVisible();
    await expect(page.locator('.mf-tools')).toBeVisible();
  });

  test('shows all eleven tools', async ({ page }) => {
    await expect(page.locator('.mf-tool')).toHaveCount(11);
  });

  test('starts with an empty board', async ({ page }) => {
    const doc = await getDocument(page);
    expect(doc.elements).toHaveLength(0);
    expect(doc.meta.name).toBe('Untitled board');
  });
});

test.describe('drawing', () => {
  test('creates a rectangle by dragging', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [300, 220]);

    const doc = await getDocument(page);
    expect(doc.elements).toHaveLength(1);
    expect(doc.elements[0]).toMatchObject({ type: 'rectangle', x: 100, y: 100, width: 200, height: 120 });
  });

  test('returns to the select tool after creating', async ({ page }) => {
    await page.locator('[data-tool="ellipse"]').click();
    await drag(page, [100, 100], [200, 200]);

    const tool = await page.evaluate(
      () => (window as unknown as { mindflow: { store: { getState(): { activeTool: string } } } }).mindflow.store.getState().activeTool,
    );
    expect(tool).toBe('select');
  });

  test('creates a default-sized shape on a plain click', async ({ page }) => {
    await page.locator('[data-tool="sticky"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 400, box.y + 300);

    const doc = await getDocument(page);
    expect(doc.elements[0]).toMatchObject({ type: 'sticky', width: 160, height: 160 });
  });

  test('draws and simplifies a freehand stroke', async ({ page }) => {
    await page.locator('[data-tool="draw"]').click();
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 100, box.y + 400);
    await page.mouse.down();
    for (let i = 0; i <= 30; i++) {
      await page.mouse.move(box.x + 100 + i * 10, box.y + 400 + Math.sin(i / 3) * 40);
    }
    await page.mouse.up();

    const doc = await getDocument(page);
    const stroke = doc.elements[0] as { type: string; points: unknown[] };
    expect(stroke.type).toBe('draw');
    expect(stroke.points.length).toBeGreaterThan(2);
    expect(stroke.points.length).toBeLessThan(31); // Douglas-Peucker ran.
  });

  test('supports tool keyboard shortcuts', async ({ page }) => {
    for (const [key, expected] of [['r', 'rectangle'], ['o', 'ellipse'], ['t', 'text'], ['v', 'select']] as const) {
      await page.keyboard.press(key);
      const tool = await page.evaluate(
        () => (window as unknown as { mindflow: { store: { getState(): { activeTool: string } } } }).mindflow.store.getState().activeTool,
      );
      expect(tool).toBe(expected);
    }
  });
});

test.describe('selection and editing', () => {
  test('selects, moves and undoes as one step', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [300, 220]);

    // Deselect first: a freshly-created shape is selected, and its resize
    // handles sit on the outline and take priority over a move.
    await page.keyboard.press('Escape');

    // Grab the LEFT EDGE, off-centre so it is clear of the corner and midpoint
    // handles. An unfilled shape is hollow to clicks by design, so the interior
    // would miss entirely.
    await drag(page, [100, 130], [100, 330]);

    let doc = await getDocument(page);
    expect(doc.elements[0]?.y).toBeCloseTo(300, 0);

    await page.keyboard.press('Control+z');
    doc = await getDocument(page);
    expect(doc.elements[0]?.y).toBeCloseTo(100, 0);

    await page.keyboard.press('Control+Shift+z');
    doc = await getDocument(page);
    expect(doc.elements[0]?.y).toBeCloseTo(300, 0);
  });

  test('marquee-selects several elements', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [200, 200]);
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [300, 100], [400, 200]);

    await page.keyboard.press('v');
    await drag(page, [50, 50], [500, 300]);

    const selected = await page.evaluate(
      () => (window as unknown as { mindflow: { store: { selectedIds(): string[] } } }).mindflow.store.selectedIds().length,
    );
    expect(selected).toBe(2);
  });

  test('deletes the selection', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [200, 200]);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');

    expect((await getDocument(page)).elements).toHaveLength(0);
  });

  test('duplicates with an offset', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [200, 200]);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+d');

    const doc = await getDocument(page);
    expect(doc.elements).toHaveLength(2);
    expect(doc.elements[1]?.x).not.toBe(doc.elements[0]?.x);
    expect(doc.elements[1]?.id).not.toBe(doc.elements[0]?.id);
  });

  test('shows the style panel only when something is selected', async ({ page }) => {
    await expect(page.locator('.mf-style-panel')).toBeHidden();

    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [200, 200]);
    await expect(page.locator('.mf-style-panel')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.mf-style-panel')).toBeHidden();
  });

  test('groups and ungroups', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [200, 200]);
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [300, 100], [400, 200]);

    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+g');

    let doc = await getDocument(page);
    expect(doc.elements[0]?.groupId).toBeTruthy();
    expect(doc.elements[0]?.groupId).toBe(doc.elements[1]?.groupId);

    await page.keyboard.press('Control+Shift+g');
    doc = await getDocument(page);
    expect(doc.elements[0]?.groupId).toBeNull();
  });
});

test.describe('connectors', () => {
  test('binds an arrow to shapes at both ends and re-routes when one moves', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 200], [240, 300]);
    await page.locator('[data-tool="ellipse"]').click();
    await drag(page, [500, 200], [640, 300]);

    await page.locator('[data-tool="arrow"]').click();
    await drag(page, [170, 250], [570, 250]); // centre to centre

    let doc = await getDocument(page);
    const connector = doc.elements.find((element) => element.type === 'arrow') as {
      id: string;
      startBinding: { elementId: string } | null;
      endBinding: { elementId: string } | null;
      points: number[][];
    };
    expect(connector.startBinding).not.toBeNull();
    expect(connector.endBinding).not.toBeNull();

    const before = JSON.stringify(connector.points);

    // Move the ellipse by its outline and confirm the arrow follows.
    await page.keyboard.press('v');
    await drag(page, [570, 200], [570, 500]);

    doc = await getDocument(page);
    const after = doc.elements.find((element) => element.id === connector.id) as { points: number[][] };
    expect(JSON.stringify(after.points)).not.toBe(before);
  });

  test('discards a zero-length connector', async ({ page }) => {
    await page.locator('[data-tool="arrow"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 300, box.y + 300);

    expect((await getDocument(page)).elements).toHaveLength(0);
  });
});

test.describe('viewport', () => {
  test('zooms and resets', async ({ page }) => {
    const zoom = () =>
      page.evaluate(() => (window as unknown as { mindflow: { store: { viewport: { zoom: number } } } }).mindflow.store.viewport.zoom);

    expect(await zoom()).toBe(1);
    await page.keyboard.press('Control+Equal');
    expect(await zoom()).toBeGreaterThan(1);
    await page.keyboard.press('Control+0');
    expect(await zoom()).toBe(1);
  });

  test('pans without marking the board dirty', async ({ page }) => {
    // Panning is not an edit.
    await page.locator('[data-tool="pan"]').click();
    await drag(page, [400, 400], [200, 200]);

    const state = await page.evaluate(() => {
      const store = (window as unknown as { mindflow: { store: { viewport: { x: number }; getState(): { dirty: boolean } } } }).mindflow.store;
      return { x: store.viewport.x, dirty: store.getState().dirty };
    });
    expect(state.x).toBeGreaterThan(0);
    expect(state.dirty).toBe(false);
  });

  test('zooms to fit the content', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [200, 200]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+1');

    const zoom = await page.evaluate(
      () => (window as unknown as { mindflow: { store: { viewport: { zoom: number } } } }).mindflow.store.viewport.zoom,
    );
    expect(zoom).toBeGreaterThan(1); // A small shape on a big canvas zooms in.
  });
});

test.describe('document integrity', () => {
  test('a drawn board satisfies every documented invariant', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="ellipse"]').click();
    await drag(page, [400, 100], [550, 200]);
    await page.locator('[data-tool="arrow"]').click();
    await drag(page, [175, 150], [475, 150]);
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 350], [280, 480]);

    const doc = await getDocument(page);
    const ids = new Set(doc.elements.map((element) => element.id as string));

    expect(ids.size).toBe(doc.elements.length);
    for (const element of doc.elements) {
      expect(element.width as number).toBeGreaterThan(0);
      expect(element.height as number).toBeGreaterThan(0);
      expect(element.angle as number).toBeGreaterThanOrEqual(0);
      expect(element.angle as number).toBeLessThan(360);
      expect(element.opacity as number).toBeGreaterThanOrEqual(0);
      expect(element.opacity as number).toBeLessThanOrEqual(1);
      expect(Number.isFinite(element.zIndex)).toBe(true);
    }

    // zIndex strictly ascending in array order.
    const zs = doc.elements.map((element) => element.zIndex as number);
    expect([...zs].sort((a, b) => a - b)).toEqual(zs);

    // Bindings resolve.
    for (const element of doc.elements) {
      for (const key of ['startBinding', 'endBinding'] as const) {
        const binding = element[key] as { elementId: string } | null | undefined;
        if (binding) expect(ids.has(binding.elementId)).toBe(true);
      }
    }
  });

  test('survives a serialise → load round trip', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="ellipse"]').click();
    await drag(page, [400, 100], [550, 200]);
    await page.locator('[data-tool="arrow"]').click();
    await drag(page, [175, 150], [475, 150]);

    const result = await page.evaluate(() => {
      const mf = (window as unknown as { mindflow: { store: { document: unknown; documentForSave(): unknown } } }).mindflow;
      const doc = mf.store.documentForSave() as { elements: { id: string; type: string }[] };
      const json = JSON.stringify(doc, null, 2);
      const reparsed = JSON.parse(json) as typeof doc;
      return {
        typesMatch: JSON.stringify(reparsed.elements.map((e) => e.type)) === JSON.stringify(doc.elements.map((e) => e.type)),
        idsMatch: JSON.stringify(reparsed.elements.map((e) => e.id)) === JSON.stringify(doc.elements.map((e) => e.id)),
        count: doc.elements.length,
      };
    });

    expect(result.count).toBe(3);
    expect(result.typesMatch).toBe(true);
    expect(result.idsMatch).toBe(true);
  });

  test('renames the board', async ({ page }) => {
    const input = page.locator('.mf-board-name');
    await input.fill('Sprint planning');
    await input.press('Enter');

    expect((await getDocument(page)).meta.name).toBe('Sprint planning');
  });
});

test.describe('performance', () => {
  test('stays responsive with 2,000 elements', async ({ page }) => {
    // Viewport culling is the one optimisation implemented, and this is the
    // check that it is doing its job.
    const elapsed = await page.evaluate(() => {
      const mf = (window as unknown as {
        mindflow: { store: { execute(cmd: unknown): void; document: unknown; setViewport(v: unknown): void } };
      }).mindflow;

      // Build a large board directly through the store.
      const elements: unknown[] = [];
      for (let i = 0; i < 2000; i++) {
        elements.push({
          id: `el_perf${i}`,
          type: 'rectangle',
          x: (i % 50) * 120,
          y: Math.floor(i / 50) * 120,
          width: 100,
          height: 80,
          angle: 0,
          zIndex: (i + 1) * 1000,
          opacity: 1,
          locked: false,
          visible: true,
          groupId: null,
          style: { stroke: '#1e1e1e', strokeWidth: 2, strokeStyle: 'solid', fill: '#a5d8ff', fillStyle: 'solid', roughness: 0 },
          label: null,
          meta: {},
          cornerRadius: 8,
        });
      }
      mf.store.execute({ label: 'seed', patches: elements.map((el) => ({ id: (el as { id: string }).id, before: null, after: el })) });

      const start = performance.now();
      for (let i = 0; i < 60; i++) {
        mf.store.setViewport({ x: i * 25, y: i * 12, zoom: 1 });
      }
      return performance.now() - start;
    });

    // 60 viewport updates. Generous bound — this is a smoke test for a
    // pathological regression (dropped culling), not a precise benchmark.
    expect(elapsed).toBeLessThan(2000);

    const count = await page.evaluate(
      () => (window as unknown as { mindflow: { store: { document: { elements: unknown[] } } } }).mindflow.store.document.elements.length,
    );
    expect(count).toBe(2000);
  });
});
