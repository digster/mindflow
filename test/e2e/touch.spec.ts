/**
 * Touch behaviour, driven with real touch input.
 *
 * The rest of the suite drives `page.mouse`, which is the right default — but a
 * mouse cannot reproduce any of the problems this file exists for. A tap is not
 * a click with a different input device: it may not move focus, it carries far
 * more jitter, its targets are a finger wide, and the OS can take the pointer
 * away mid-gesture.
 *
 * Playwright's `page.touchscreen` only taps, so gestures go through CDP's
 * `Input.dispatchTouchEvent`. That produces genuine touch input in the browser
 * — real `pointerType: 'touch'` events, and more than one finger — rather than
 * synthetic events, which `LEARNINGS.md` warns are not equivalent (they break
 * `setPointerCapture`).
 */

import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const APP_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'index.html')).href;

type Point = [number, number];

async function canvasBox(page: Page) {
  const box = await page.locator('.mf-canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  return box;
}

/** A CDP session per page, reused across gestures within a test. */
const sessions = new WeakMap<Page, CDPSession>();

async function cdp(page: Page) {
  const existing = sessions.get(page);
  if (existing) return existing;
  const session = await page.context().newCDPSession(page);
  sessions.set(page, session);
  return session;
}

async function dispatch(
  page: Page,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  points: { x: number; y: number; id?: number }[],
) {
  const session = await cdp(page);
  await session.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((point, index) => ({
      x: point.x,
      y: point.y,
      id: point.id ?? index,
    })),
  });
}

/** Absolute page coordinates for a point given in canvas-relative pixels. */
async function onCanvas(page: Page, [x, y]: Point) {
  const box = await canvasBox(page);
  return { x: box.x + x, y: box.y + y };
}

async function tap(page: Page, point: Point) {
  const at = await onCanvas(page, point);
  await dispatch(page, 'touchStart', [at]);
  await dispatch(page, 'touchEnd', []);
}

/** A one-finger drag, delivered as a realistic stream of moves. */
async function touchDrag(page: Page, from: Point, to: Point, steps = 8) {
  const start = await onCanvas(page, from);
  const end = await onCanvas(page, to);

  await dispatch(page, 'touchStart', [start]);
  for (let step = 1; step <= steps; step += 1) {
    await dispatch(page, 'touchMove', [
      {
        x: start.x + ((end.x - start.x) * step) / steps,
        y: start.y + ((end.y - start.y) * step) / steps,
      },
    ]);
  }
  await dispatch(page, 'touchEnd', []);
}

/** A tap that wobbles by `jitter` pixels without the finger meaning to move. */
async function shakyTap(page: Page, point: Point, jitter: number) {
  const at = await onCanvas(page, point);
  await dispatch(page, 'touchStart', [at]);
  await dispatch(page, 'touchMove', [{ x: at.x + jitter, y: at.y + jitter / 2 }]);
  await dispatch(page, 'touchMove', [{ x: at.x + jitter / 2, y: at.y + jitter }]);
  await dispatch(page, 'touchEnd', []);
}

async function doubleTap(page: Page, point: Point) {
  await tap(page, point);
  await page.waitForTimeout(60);
  await tap(page, point);
}

async function getDocument(page: Page) {
  return page.evaluate(() => {
    const mf = (window as unknown as { mindflow: { store: { document: unknown } } }).mindflow;
    return JSON.parse(JSON.stringify(mf.store.document)) as {
      elements: Record<string, unknown>[];
    };
  });
}

async function editingId(page: Page) {
  return page.evaluate(() => {
    const mf = (
      window as unknown as { mindflow: { store: { getState(): { editingId: string | null } } } }
    ).mindflow;
    return mf.store.getState().editingId;
  });
}

async function selectedCount(page: Page) {
  return page.evaluate(() => {
    const mf = (window as unknown as { mindflow: { store: { selectedIds(): string[] } } }).mindflow;
    return mf.store.selectedIds().length;
  });
}

/** Draws a sticky with the mouse, so each test starts from a known board. */
async function stickyWithMouse(page: Page, from: Point, to: Point) {
  await page.locator('[data-tool="sticky"]').click();
  const box = await canvasBox(page);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
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
  const errors = (page as unknown as { __errors: string[] }).__errors ?? [];
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * Suppresses the focus change a press normally causes.
 *
 * This is the part of iPadOS that cannot be emulated: over a `touch-action:
 * none` canvas holding a pointer capture, a tap does not reliably move focus,
 * so the textarea never blurs and the edit never ends. Chromium's touch
 * emulation still sends the compatibility mouse events, which blur it — so a
 * test written without this passes against the broken code and proves nothing.
 *
 * Preventing `mousedown`'s default action reproduces the condition exactly:
 * focus stays where it is, and the only thing that can close the editor is the
 * app deciding to close it.
 */
async function suppressFocusChange(page: Page) {
  await page.evaluate(() => {
    window.addEventListener('mousedown', (event) => event.preventDefault(), true);
  });
}

test.describe('ending a text edit by touch', () => {
  /** Opens the editor the way a finger can: the text tool, one tap. */
  async function startTyping(page: Page, at: Point, text: string) {
    await page.locator('[data-tool="text"]').click();
    await tap(page, at);
    await expect(page.locator('.mf-text-editor')).toBeFocused();
    await page.keyboard.type(text);
  }

  test('a tap on empty canvas commits the edit', async ({ page }) => {
    // The reported bug: on an iPad the caret stayed active after tapping away,
    // because the editor only ever closed as a side effect of a native focus
    // change that a tap does not reliably cause.
    await startTyping(page, [200, 200], 'Hello');
    await suppressFocusChange(page);
    await tap(page, [600, 500]);

    await expect(page.locator('.mf-text-editor')).toBeHidden();
    expect(await editingId(page)).toBeNull();
    const doc = await getDocument(page);
    expect((doc.elements[0]?.text as string)).toBe('Hello');
  });

  test('the dismissing tap does not also start a gesture', async ({ page }) => {
    // The store flag and the editor used to disagree the moment the first tap
    // landed, so the NEXT tap fell through the guard and began a marquee under
    // a still-open editor.
    await startTyping(page, [200, 200], 'Hello');
    await suppressFocusChange(page);
    await tap(page, [600, 500]);

    // The tap that closed the editor must not have cleared the selection by
    // starting a marquee on empty canvas.
    expect(await selectedCount(page)).toBe(1);
  });

  test('a tap on the toolbar commits the edit', async ({ page }) => {
    // Chrome buttons have no commit path of their own: whether pressing one
    // blurs a textarea is a platform convention, not a guarantee.
    await startTyping(page, [200, 200], 'Chrome');
    await suppressFocusChange(page);
    await page.locator('[data-tool="ellipse"]').click();

    await expect(page.locator('.mf-text-editor')).toBeHidden();
    const doc = await getDocument(page);
    expect((doc.elements[0]?.text as string)).toBe('Chrome');
  });

  test('a tap inside the editor keeps it open', async ({ page }) => {
    await startTyping(page, [200, 200], 'Stay');
    await page.locator('.mf-text-editor').click();

    await expect(page.locator('.mf-text-editor')).toBeVisible();
    expect(await editingId(page)).not.toBeNull();
  });

  test('the editor releases focus when it closes', async ({ page }) => {
    // A hidden textarea that is still `document.activeElement` keeps the soft
    // keyboard up — a caret that is, to the user, still active.
    await startTyping(page, [200, 200], 'Blur');
    await suppressFocusChange(page);
    await tap(page, [600, 500]);

    const active = await page.evaluate(() => document.activeElement?.className ?? '');
    expect(active).not.toContain('mf-text-editor');
  });
});

test.describe('selecting and dragging by touch', () => {
  /** The first element's position, for before/after comparisons. */
  async function positionOf(page: Page) {
    const doc = await getDocument(page);
    return { x: doc.elements[0]?.x as number, y: doc.elements[0]?.y as number };
  }

  test('a tap selects what is under it', async ({ page }) => {
    await stickyWithMouse(page, [200, 200], [360, 360]);
    await tap(page, [280, 280]);

    expect(await selectedCount(page)).toBe(1);
  });

  test('a tap near a thin shape still finds it', async ({ page }) => {
    // 8px of tolerance is tuned for a cursor one pixel wide. A finger covers
    // roughly forty and cannot see what is under it.
    await page.locator('[data-tool="line"]').click();
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 200, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 500, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.press('Escape');

    // 12px off the line: past the mouse tolerance, inside the touch one.
    await tap(page, [350, 212]);
    expect(await selectedCount(page)).toBe(1);
  });

  test('a shaky tap selects without nudging', async ({ page }) => {
    // A finger wanders 5-15px during what the user experiences as a stationary
    // tap. At the mouse threshold of 3px that became a drag, and because a
    // gesture recomputes from its origin the element jumped the whole way.
    await stickyWithMouse(page, [200, 200], [360, 360]);
    const before = await positionOf(page);

    await shakyTap(page, [280, 280], 6);

    expect(await selectedCount(page)).toBe(1);
    expect(await positionOf(page)).toEqual(before);
  });

  test('a deliberate drag still moves it', async ({ page }) => {
    // The other half of the threshold: raising it must not make dragging need a
    // shove.
    await stickyWithMouse(page, [200, 200], [360, 360]);
    const before = await positionOf(page);

    await touchDrag(page, [280, 280], [480, 380]);

    const after = await positionOf(page);
    expect(after.x - before.x).toBeCloseTo(200, 0);
    expect(after.y - before.y).toBeCloseTo(100, 0);
  });

  test('a double tap opens the text editor', async ({ page }) => {
    // `dblclick` is synthesised from two compatibility click pairs, which a
    // touchscreen does not reliably produce over a canvas holding a pointer
    // capture — and it was the only route into editing an existing element.
    await stickyWithMouse(page, [200, 200], [400, 400]);
    await doubleTap(page, [300, 300]);

    await expect(page.locator('.mf-text-editor')).toBeVisible();
    expect(await editingId(page)).not.toBeNull();
  });

  test('two separate taps do not open the editor', async ({ page }) => {
    await stickyWithMouse(page, [200, 200], [400, 400]);
    await tap(page, [300, 300]);
    await page.waitForTimeout(400);
    await tap(page, [300, 300]);

    await expect(page.locator('.mf-text-editor')).toBeHidden();
  });

  test('a long press opens the context menu', async ({ page }) => {
    // The press has already begun a `move` by the time the browser reports the
    // long press, and the mid-gesture bail silently swallowed every one of
    // them. Below the drag threshold nothing has been applied yet, so the
    // gesture can be abandoned in favour of the menu.
    await stickyWithMouse(page, [200, 200], [400, 400]);

    const at = await onCanvas(page, [300, 300]);
    await dispatch(page, 'touchStart', [at]);
    await page.locator('.mf-canvas').dispatchEvent('contextmenu', {
      clientX: at.x,
      clientY: at.y,
      bubbles: true,
    });

    await expect(page.locator('.mf-menu')).toBeVisible();
    await dispatch(page, 'touchEnd', []);
  });

  test('a cancelled gesture does not break the next one', async ({ page }) => {
    // pointercancel is rare with a mouse and routine with a finger — the system
    // takes the pointer for palm rejection or a system gesture. The handler
    // used to leave the capture and the press state behind, and the symptom
    // showed up later: the NEXT drag silently did nothing.
    await stickyWithMouse(page, [200, 200], [360, 360]);
    const before = await positionOf(page);

    const at = await onCanvas(page, [280, 280]);
    await dispatch(page, 'touchStart', [at]);
    await dispatch(page, 'touchMove', [{ x: at.x + 40, y: at.y + 40 }]);
    await dispatch(page, 'touchCancel', []);

    await touchDrag(page, [280, 280], [430, 280]);

    const after = await positionOf(page);
    expect(after.x - before.x).toBeCloseTo(150, 0);
  });
});
