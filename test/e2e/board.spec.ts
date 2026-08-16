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

/** How many elements are currently selected. */
async function selectedCount(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { mindflow: { store: { selectedIds(): string[] } } }).mindflow.store.selectedIds()
        .length,
  );
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

/** Which element the text editor is open on, if any. */
async function editingId(page: Page) {
  return page.evaluate(
    () =>
      (window as unknown as { mindflow: { store: { getState(): { editingId: string | null } } } }).mindflow.store
        .getState().editingId,
  );
}

/** Whether the board is carrying unsaved changes. */
async function isDirty(page: Page) {
  return page.evaluate(
    () => (window as unknown as { mindflow: { store: { getState(): { dirty: boolean } } } }).mindflow.store.getState().dirty,
  );
}

/**
 * Puts the app in the state it is in just after opening a file: same content,
 * no unsaved changes. Goes through `store.load`, the same call `applyLoad`
 * makes, rather than reaching in and setting `dirty` — so a test that depends on
 * a clean board depends on the real load path staying clean.
 */
async function markClean(page: Page) {
  await page.evaluate(() => {
    const mf = (
      window as unknown as {
        mindflow: { store: { document: unknown; load(result: unknown, origin: unknown): void } };
      }
    ).mindflow;
    mf.store.load(
      { document: mf.store.document, warnings: [], preserved: [] },
      { kind: 'local', name: 'board.mindflow.json' },
    );
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

test.describe('locking', () => {
  /**
   * Draws one sticky and locks it, leaving nothing selected.
   *
   * A sticky rather than a rectangle because it is filled, and only a filled
   * shape is solid to a click on its interior — an unfilled rectangle is
   * click-through anyway, which would make "the lock made it click-through"
   * pass for entirely the wrong reason.
   */
  async function drawAndLock(page: Page) {
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [300, 250]);
    await page.evaluate(() => {
      const mf = (window as unknown as { mindflow: { actions: { toggleLock(): void } } }).mindflow;
      mf.actions.toggleLock();
    });
  }

  test('a locked element is click-through and cannot be marquee-selected', async ({ page }) => {
    await drawAndLock(page);

    await drag(page, [200, 175], [260, 200]); // Straight across its interior.
    await drag(page, [50, 50], [400, 350]); // A marquee swallowing the whole thing.

    const doc = await getDocument(page);
    expect(await selectedCount(page)).toBe(0);
    expect(doc.elements[0]?.x).toBeCloseTo(100, 0); // Unmoved.
  });

  test('right-click selects a locked element so it can be unlocked again', async ({ page }) => {
    await drawAndLock(page);

    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 175, { button: 'right' });
    expect(await selectedCount(page)).toBe(1);

    // The panel collapses to the one action a locked element still accepts.
    await expect(page.locator('.mf-style-panel')).toBeVisible();
    await expect(page.locator('.mf-style-panel .mf-swatch')).toHaveCount(0);

    await page.locator('.mf-style-panel .mf-button', { hasText: 'Unlock' }).click();
    expect((await getDocument(page)).elements[0]?.locked).toBe(false);

    // And it is a normal element again.
    await page.keyboard.press('Escape');
    await drag(page, [200, 175], [200, 275]);
    expect((await getDocument(page)).elements[0]?.y).toBeCloseTo(200, 0);
  });

  test('a selected locked element still cannot be moved, nudged or deleted', async ({ page }) => {
    await drawAndLock(page);

    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 175, { button: 'right' });

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Delete');
    // Drag from the left edge, where an unlocked shape would offer a handle.
    await drag(page, [100, 130], [100, 330]);

    const doc = await getDocument(page);
    expect(doc.elements).toHaveLength(1);
    expect(doc.elements[0]?.x).toBeCloseTo(100, 0);
    expect(doc.elements[0]?.y).toBeCloseTo(100, 0);
  });
});

test.describe('text editing', () => {
  /**
   * Waits for the editor to take focus before typing.
   *
   * `TextEditor.open` focuses inside a `requestAnimationFrame`, so it deliberately
   * lands a frame after the click. Typing before then loses the leading keystrokes
   * — and worse, feeds them to the canvas, where letters are tool shortcuts.
   */
  async function typeIntoEditor(page: Page, text: string) {
    await expect(page.locator('.mf-text-editor')).toBeFocused();
    await page.keyboard.type(text);
  }

  /**
   * Gap, in screen pixels, between where the open editor puts its first
   * baseline and where the canvas would draw it.
   *
   * The two sides are derived independently on purpose. The canvas side is the
   * formula published in `docs/07-rendering.md`, restated here against the
   * element's own stored geometry. The DOM side is read back off the live
   * editor — its real bounding box, its real `padding-top`, and a probe for
   * where CSS actually placed the baseline in a line box of that typography.
   * Neither side asks the editor what it thinks it did, so dropping the
   * correction makes them disagree rather than agreeing on a wrong answer.
   *
   * Assumes a single line of text, which is all these tests type.
   */
  async function baselineGap(page: Page) {
    return page.evaluate(() => {
      type Store = {
        viewport: { x: number; y: number; zoom: number };
        document: { elements: Record<string, never>[] };
        getState(): { editingId: string | null };
      };
      const store = (window as unknown as { mindflow: { store: Store } }).mindflow.store;
      const { y: viewportY, zoom } = store.viewport;
      const editingId = store.getState().editingId;
      const element = store.document.elements.find(
        (candidate) => (candidate as unknown as { id: string }).id === editingId,
      ) as unknown as {
        y: number;
        height: number;
        type: string;
        padding?: number;
        verticalAlign?: string;
        label?: { padding: number; verticalAlign: string } | null;
      };

      const editor = document.querySelector('.mf-text-editor') as HTMLTextAreaElement;
      const style = getComputedStyle(editor);
      const fontSize = parseFloat(style.fontSize);
      const lineHeightPx = parseFloat(style.lineHeight);

      // Where CSS actually put the baseline in this typography's line box. A
      // zero-height inline-block aligned to the baseline sits exactly on it.
      const probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;white-space:pre;';
      probe.style.font = style.font;
      probe.style.lineHeight = style.lineHeight;
      const marker = document.createElement('span');
      marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
      probe.append('x', marker);
      document.body.append(probe);
      const cssBaseline = marker.getBoundingClientRect().top - probe.getBoundingClientRect().top;
      probe.remove();

      // docs/07-rendering.md: padding + verticalAlign offset + fontSize × 0.8.
      const padding =
        element.type === 'sticky' ? (element.padding ?? 0) : (element.label?.padding ?? 0);
      const verticalAlign = element.verticalAlign ?? element.label?.verticalAlign ?? 'top';
      const free = Math.max(element.height - padding * 2 - lineHeightPx, 0);
      const align = verticalAlign === 'middle' ? free / 2 : verticalAlign === 'bottom' ? free : 0;

      const canvasTop = document.querySelector('.mf-canvas')!.getBoundingClientRect().top;
      const canvasBaseline =
        canvasTop + (element.y - viewportY + padding + align + fontSize * 0.8) * zoom;

      const domBaseline =
        editor.getBoundingClientRect().top + (parseFloat(style.paddingTop) + cssBaseline) * zoom;

      return { gap: domBaseline - canvasBaseline, fontSize, zoom };
    });
  }

  test('the editor sits on the same baseline the canvas draws', async ({ page }) => {
    await page.locator('[data-tool="text"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 200);
    await typeIntoEditor(page, 'Baseline');

    const { gap, fontSize, zoom } = await baselineGap(page);

    // Sub-pixel is the bar: anything larger reads as the text jumping the moment
    // editing starts. Uncorrected, this gap is about a fifth of an em.
    expect(Math.abs(gap)).toBeLessThan(0.5);
    expect(fontSize).toBeGreaterThan(0);
    expect(zoom).toBe(1);
  });

  test('the baseline still agrees for a padded sticky', async ({ page }) => {
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [400, 300]);
    await page.keyboard.press('Escape');

    const box = await canvasBox(page);
    await page.mouse.dblclick(box.x + 250, box.y + 200);
    await typeIntoEditor(page, 'Note');

    expect(Math.abs((await baselineGap(page)).gap)).toBeLessThan(0.5);
  });

  test('the baseline still agrees when zoomed in', async ({ page }) => {
    await page.locator('[data-tool="text"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 200);
    await typeIntoEditor(page, 'Zoomed');
    await page.keyboard.press('Escape');

    // Zoom to fit: with one small element on the board this lands well above
    // 1×, which is the point — the correction is in scene units and must survive
    // being scaled.
    await page.keyboard.press('Control+1');

    // The element is no longer under the point it was created at. Ask the store
    // where it went.
    const centre = await page.evaluate(() => {
      const store = (
        window as unknown as {
          mindflow: {
            store: {
              viewport: { x: number; y: number; zoom: number };
              document: { elements: { x: number; y: number; width: number; height: number }[] };
            };
          };
        }
      ).mindflow.store;
      const { x, y, zoom } = store.viewport;
      const element = store.document.elements[0]!;
      return {
        x: (element.x + element.width / 2 - x) * zoom,
        y: (element.y + element.height / 2 - y) * zoom,
      };
    });
    await page.mouse.dblclick(box.x + centre.x, box.y + centre.y);

    const { gap, zoom } = await baselineGap(page);
    expect(zoom).toBeGreaterThan(1);
    // The correction is in scene units, so the tolerance scales with zoom.
    expect(Math.abs(gap)).toBeLessThan(0.5 * zoom);
  });

  test('opening and closing an editor without typing is not an edit', async ({ page }) => {
    // `commit` rebuilds the element unconditionally, and `Store.execute` can
    // only recognise a no-op by reference — so an untouched element used to
    // dirty the board and push a phantom undo step. The visible symptom was
    // being asked to discard unsaved changes after only double-clicking.
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [400, 300]);
    await page.keyboard.press('Escape');
    await markClean(page);

    const box = await canvasBox(page);
    await page.mouse.dblclick(box.x + 250, box.y + 200);
    expect(await editingId(page)).not.toBeNull();
    await page.keyboard.press('Escape');

    expect(await editingId(page)).toBeNull();
    expect(await isDirty(page)).toBe(false);
    expect(
      await page.evaluate(
        () => (window as unknown as { mindflow: { store: { history: { canUndo(): boolean } } } }).mindflow.store.history.canUndo(),
      ),
    ).toBe(false);
  });

  test('still commits when the text did change', async ({ page }) => {
    // The guard above must not swallow real edits.
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [400, 300]);

    const box = await canvasBox(page);
    await page.mouse.dblclick(box.x + 250, box.y + 200);
    await typeIntoEditor(page, 'Real edit');
    await page.keyboard.press('Escape');

    const doc = await getDocument(page);
    expect((doc.elements[0] as { text: string }).text).toBe('Real edit');
    expect(await isDirty(page)).toBe(true);
  });

  test('committed text keeps the geometry the editor was showing', async ({ page }) => {
    await page.locator('[data-tool="text"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 200);
    await typeIntoEditor(page, 'Baseline');
    await page.keyboard.press('Escape');

    const doc = await getDocument(page);
    const text = doc.elements[0] as { text: string; width: number; height: number };
    expect(text.text).toBe('Baseline');
    expect(text.width).toBeGreaterThan(0);
    expect(text.height).toBeGreaterThan(0);
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

test.describe('new board', () => {
  /** The board's identity, which a reset must replace rather than reuse. */
  async function boardId(page: Page) {
    return page.evaluate(
      () => (window as unknown as { mindflow: { store: { document: { id: string } } } }).mindflow.store.document.id,
    );
  }

  test('the top bar offers a New board button', async ({ page }) => {
    // Cmd/Ctrl+N is swallowed by the browser in an ordinary tab, so this button
    // is the only dependable way to start a blank board. Its absence would make
    // the feature unreachable without leaving the app.
    await expect(page.getByRole('button', { name: 'New board' })).toBeVisible();
  });

  test('resets a dirty board once the discard is confirmed', async ({ page }) => {
    const before = await boardId(page);

    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [250, 200]);
    const input = page.locator('.mf-board-name');
    await input.fill('Sprint planning');
    await input.press('Enter');

    await page.getByRole('button', { name: 'New board' }).click();
    await page.getByRole('button', { name: 'Discard' }).click();

    const doc = await getDocument(page);
    expect(doc.elements).toHaveLength(0);
    expect(doc.meta.name).toBe('Untitled board');
    // A fresh identity matters: reusing the id would make the new board
    // overwrite the old one on the next Drive save.
    expect(await boardId(page)).not.toBe(before);
    await expect(page.locator('.mf-dirty-dot')).not.toHaveClass(/is-visible/);
  });

  test('keeps the board when the discard is cancelled', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [250, 200]);

    await page.getByRole('button', { name: 'New board' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();

    expect((await getDocument(page)).elements).toHaveLength(1);
  });

  test('skips the prompt when there is nothing to lose', async ({ page }) => {
    // A clean board has no unsaved work, so asking would be pure friction.
    const before = await boardId(page);
    await page.getByRole('button', { name: 'New board' }).click();

    await expect(page.locator('dialog.mf-dialog')).toHaveCount(0);
    expect(await boardId(page)).not.toBe(before);
  });

  test('closes an open text editor instead of leaving it floating', async ({ page }) => {
    // The clean-board path is the one that bites: no confirm dialog appears, so
    // nothing steals focus from the textarea, so its blur-to-commit never fires.
    // The editor was left visible over the new blank board still showing the old
    // board's text.
    // A sticky, not a rectangle: an unfilled shape is not hit-testable through
    // its middle, so a centre double-click would miss it.
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [400, 300]);
    await page.keyboard.press('Escape');

    // Opening the editor does not itself dirty the board, but typing into it
    // would — and a dirty board gets a confirm dialog whose focus() closes the
    // editor as a side effect, hiding the bug. So: load, then edit, do not type.
    await markClean(page);

    const box = await canvasBox(page);
    await page.mouse.dblclick(box.x + 250, box.y + 200);
    await expect(page.locator('.mf-text-editor')).toBeVisible();
    expect(await editingId(page)).not.toBeNull();

    await page.getByRole('button', { name: 'New board' }).click();

    await expect(page.locator('.mf-text-editor')).toBeHidden();
    expect(await editingId(page)).toBeNull();
    expect((await getDocument(page)).elements).toHaveLength(0);
  });
});

test.describe('align and distribute', () => {
  /** Draws `count` rectangles at staggered positions and selects them all. */
  async function drawAndSelectAll(page: Page, boxes: [number, number][][]) {
    for (const [from, to] of boxes) {
      await page.locator('[data-tool="rectangle"]').click();
      await drag(page, from as [number, number], to as [number, number]);
    }
    await page.locator('[data-tool="select"]').click();
    await page.keyboard.press('ControlOrMeta+a');
  }

  test('the panel offers align controls once two things are selected', async ({ page }) => {
    // The whole point of this feature: Actions.align existed but nothing called
    // it. If the button disappears, the action is unreachable again.
    await drawAndSelectAll(page, [
      [[100, 100], [200, 180]],
      [[300, 260], [420, 340]],
    ]);

    await expect(page.getByRole('button', { name: 'Align left' })).toBeVisible();
    // Two units have no interior to distribute.
    await expect(page.getByRole('button', { name: 'Distribute horizontally' })).toBeDisabled();
  });

  test('offers no align controls for a single element', async ({ page }) => {
    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [100, 100], [200, 180]);

    await expect(page.getByRole('button', { name: 'Align left' })).toHaveCount(0);
  });

  test('aligning from the panel moves the elements and is one undo step', async ({ page }) => {
    await drawAndSelectAll(page, [
      [[100, 100], [200, 180]],
      [[300, 260], [420, 340]],
    ]);

    await page.getByRole('button', { name: 'Align left' }).click();

    const xs = (await getDocument(page)).elements.map((element) => element.x as number);
    expect(new Set(xs).size).toBe(1);

    await page.keyboard.press('ControlOrMeta+z');
    const after = (await getDocument(page)).elements.map((element) => element.x as number);
    expect(new Set(after).size).toBe(2);
  });

  test('distribute becomes available at three units and evens the gaps', async ({ page }) => {
    await drawAndSelectAll(page, [
      [[80, 100], [180, 180]],
      [[220, 100], [320, 180]],
      [[600, 100], [700, 180]],
    ]);

    const button = page.getByRole('button', { name: 'Distribute horizontally' });
    await expect(button).toBeEnabled();
    await button.click();

    const boxes = (await getDocument(page)).elements
      .map((element) => ({ minX: element.x as number, maxX: (element.x as number) + (element.width as number) }))
      .sort((a, b) => a.minX - b.minX);

    const firstGap = (boxes[1]?.minX ?? 0) - (boxes[0]?.maxX ?? 0);
    const secondGap = (boxes[2]?.minX ?? 0) - (boxes[1]?.maxX ?? 0);
    expect(firstGap).toBeCloseTo(secondGap, 3);
  });
});

test.describe('context menu', () => {
  /** Right-clicks at a canvas-relative point. */
  async function rightClick(page: Page, at: [number, number]) {
    const box = await canvasBox(page);
    await page.mouse.click(box.x + at[0], box.y + at[1], { button: 'right' });
  }

  test('opens on empty canvas with board-level actions', async ({ page }) => {
    await rightClick(page, [400, 300]);

    await expect(page.locator('.mf-menu')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Select all' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Paste here' })).toBeVisible();
  });

  test('selects the element under the pointer and offers element actions', async ({ page }) => {
    // A sticky, not a rectangle: the default rectangle is unfilled and therefore
    // hollow to clicks by design, so its interior would never be hit.
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="select"]').click();
    await page.keyboard.press('Escape');

    await rightClick(page, [170, 150]);

    expect(await selectedCount(page)).toBe(1);
    await expect(page.locator('.mf-menu').getByRole('button', { name: 'Duplicate' })).toBeVisible();
  });

  test('runs the chosen action', async ({ page }) => {
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="select"]').click();

    await rightClick(page, [170, 150]);
    await page.locator('.mf-menu').getByRole('button', { name: 'Duplicate' }).click();

    expect((await getDocument(page)).elements).toHaveLength(2);
    await expect(page.locator('.mf-menu')).toHaveCount(0);
  });

  test('closes on Escape without clearing the selection', async ({ page }) => {
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="select"]').click();

    await rightClick(page, [170, 150]);
    await page.keyboard.press('Escape');

    await expect(page.locator('.mf-menu')).toHaveCount(0);
    // Escape dismisses the menu and stops there — the app's own Escape handler
    // would otherwise also deselect, losing what the menu was about to act on.
    expect(await selectedCount(page)).toBe(1);
  });

  test('closes when clicking away', async ({ page }) => {
    await rightClick(page, [400, 300]);
    await expect(page.locator('.mf-menu')).toBeVisible();

    const box = await canvasBox(page);
    await page.mouse.click(box.x + 600, box.y + 500);

    await expect(page.locator('.mf-menu')).toHaveCount(0);
  });

  test('offers only Unlock for a locked element', async ({ page }) => {
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="select"]').click();
    await page.evaluate(
      () => (window as unknown as { mindflow: { actions: { toggleLock(): void } } }).mindflow.actions.toggleLock(),
    );

    await rightClick(page, [170, 150]);

    // Scoped to the menu: the style panel offers its own Unlock button, which is
    // the other half of the same escape hatch.
    await expect(page.locator('.mf-menu').getByRole('button', { name: 'Unlock' })).toBeVisible();
    await expect(page.locator('.mf-menu').getByRole('button', { name: 'Duplicate' })).toHaveCount(0);
  });

  test('does not leave the canvas holding pointer capture', async ({ page }) => {
    // contextmenu fires between pointerdown and pointerup, and pointerdown has
    // already captured the pointer. If it is not released, the next left-drag
    // silently does nothing.
    await rightClick(page, [400, 300]);
    await page.keyboard.press('Escape');

    await page.locator('[data-tool="rectangle"]').click();
    await drag(page, [500, 400], [620, 480]);

    expect((await getDocument(page)).elements).toHaveLength(1);
  });
});

test.describe('style clipboard', () => {
  test('copies appearance from one element onto another', async ({ page }) => {
    // Stickies, so clicking the interior actually selects them.
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [400, 100], [550, 200]);

    await page.locator('[data-tool="select"]').click();
    // Restyle the second, copy it, then paste onto the first.
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 470, box.y + 150);
    await page.locator('.mf-swatch[aria-label="Stroke #e03131"]').click();
    await page.keyboard.press('ControlOrMeta+Alt+c');

    await page.mouse.click(box.x + 170, box.y + 150);
    await page.keyboard.press('ControlOrMeta+Alt+v');

    const strokes = (await getDocument(page)).elements.map(
      (element) => (element.style as { stroke: string }).stroke,
    );
    expect(new Set(strokes)).toEqual(new Set(['#e03131']));
  });

  test('Cmd+Alt+C does not copy the elements themselves', async ({ page }) => {
    // The plain Cmd+C branch had no altKey guard, so it would have matched first
    // and put elements on the clipboard instead of a style.
    await page.locator('[data-tool="sticky"]').click();
    await drag(page, [100, 100], [250, 200]);
    await page.locator('[data-tool="select"]').click();
    await page.keyboard.press('ControlOrMeta+a');

    await page.keyboard.press('ControlOrMeta+Alt+c');
    await page.keyboard.press('ControlOrMeta+v');

    expect((await getDocument(page)).elements).toHaveLength(1);
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
