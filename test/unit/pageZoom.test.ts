/**
 * Page zoom on touch devices.
 *
 * A pinch must zoom the board, never the page. `src/input/pageZoom.ts` lists
 * the three layers that ensure it. Two of them can only be checked here:
 *
 *   - WebKit's `gesture*` events, which Chromium does not have, so the e2e suite
 *     cannot fire them.
 *   - WebKit's rule that `touch-action` starts again from `auto` at every
 *     scrolling container. Chromium carries the zoom restriction past scrollers,
 *     so a scroller missing the rule still passes in Playwright. Only reading the
 *     stylesheet catches it.
 *
 * The e2e suite covers the rest by pinching the real chrome (`touch.spec.ts`).
 */

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { blockPageZoom, PAGE_ZOOM_GESTURE_EVENTS } from '../../src/input/pageZoom.ts';

const ROOT = join(import.meta.dirname, '..', '..');

/** Dispatches a cancelable event and reports whether a listener cancelled it. */
function cancelled(target: EventTarget, type: string): boolean {
  const event = new Event(type, { cancelable: true, bubbles: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('blockPageZoom', () => {
  it('cancels every WebKit pinch event on a touch device', () => {
    const target = new EventTarget();
    blockPageZoom(target, true);

    for (const type of PAGE_ZOOM_GESTURE_EVENTS) {
      expect(cancelled(target, type), type).toBe(true);
    }
  });

  it('leaves a device without a touchscreen alone', () => {
    // macOS Safari sends the same events for a trackpad pinch. Blocking them
    // there would change desktop behaviour, which is out of scope.
    const target = new EventTarget();
    blockPageZoom(target, false);

    for (const type of PAGE_ZOOM_GESTURE_EVENTS) {
      expect(cancelled(target, type), type).toBe(false);
    }
  });

  it('does not touch the events the board pinch is built on', () => {
    // The board zooms from pointer events. Cancelling any of these would stop
    // the board's pinch as well as the page's.
    const target = new EventTarget();
    blockPageZoom(target, true);

    for (const type of ['pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel']) {
      expect(cancelled(target, type), type).toBe(false);
    }
  });

  it('stops cancelling once disposed', () => {
    const target = new EventTarget();
    const dispose = blockPageZoom(target, true);
    dispose();

    expect(cancelled(target, 'gesturestart')).toBe(false);
  });
});

/**
 * The stylesheet's innermost rules, as `[selector, declarations]`, with comments
 * removed. Innermost means a rule inside `@media` is returned on its own, which
 * is what the checks below need.
 */
async function cssRules(): Promise<[string, string][]> {
  const css = (await readFile(join(ROOT, 'src', 'styles', 'app.css'), 'utf8')).replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
    (match) => [match[1]!.trim(), match[2]!] as [string, string],
  );
}

/** The value a declaration block gives `property`, or undefined. */
function declared(declarations: string, property: string): string | undefined {
  const match = new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(declarations);
  return match?.[1]?.trim();
}

describe('the stylesheet', () => {
  it('lets a finger pan the page but not zoom it', async () => {
    const root = (await cssRules()).find(([selector]) => /^html,\s*body$/.test(selector));
    expect(root, 'the `html, body` rule').toBeDefined();
    expect(declared(root![1], 'touch-action')).toBe('pan-x pan-y');
  });

  it('repeats that on every scrolling container, for WebKit', async () => {
    const scrollers = (await cssRules()).filter(([, declarations]) =>
      ['overflow', 'overflow-x', 'overflow-y'].some((property) =>
        /^(auto|scroll)$/.test(declared(declarations, property) ?? ''),
      ),
    );
    // Guards the parse: the app has several scrolling panels.
    expect(scrollers.length).toBeGreaterThan(3);

    for (const [selector, declarations] of scrollers) {
      expect(
        declared(declarations, 'touch-action'),
        `${selector} scrolls, so it needs \`touch-action: pan-x pan-y\` — WebKit ` +
          'resets touch-action at scrolling containers, and a pinch there would zoom the page',
      ).toBe('pan-x pan-y');
    }
  });

  it('keeps the canvas for the board’s own pan and pinch', async () => {
    const canvas = (await cssRules()).find(([selector]) => selector === '.mf-canvas');
    expect(declared(canvas![1], 'touch-action')).toBe('none');
  });
});

describe('the viewport meta', () => {
  it('asks mobile browsers not to zoom the page', async () => {
    const template = await readFile(join(ROOT, 'src', 'index.template.html'), 'utf8');
    const content = /<meta name="viewport" content="([^"]+)"/.exec(template)?.[1] ?? '';
    const directives = content.split(',').map((part) => part.trim());

    expect(directives).toContain('user-scalable=no');
    // Also the limit iOS applies to its own zoom when a small-text field focuses.
    expect(directives).toContain('maximum-scale=1');
  });
});
