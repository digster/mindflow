/**
 * Workspaces, end to end, against the built `index.html` over `file://`.
 *
 * The switcher beside the board name, its list, the quick-switch numbers, the
 * keyboard, the command palette, and what saving and autosave carry. The store-level rules are
 * unit-tested in `test/unit/workspaceStore.test.ts`; these check that the UI
 * reaches them, and the paths that need a real browser: an editor or a
 * gesture in flight when the workspace changes, and the layout at phone width.
 */

import { test, expect, type Page } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const APP_URL = pathToFileURL(join(import.meta.dirname, '..', '..', 'index.html')).href;

interface Summary {
  id: string;
  name: string;
  elementCount: number;
  active: boolean;
}

type Hooks = {
  mindflow: {
    store: {
      workspaceSummaries(): Summary[];
      document: { elements: { id: string; type: string; x: number; y: number; text?: string }[] };
      getState(): { dirty: boolean; activeWorkspaceId: string; origin: { kind: string } };
      boardForSave(): unknown;
      markSaved(): void;
      addWorkspace(): void;
    };
  };
};

const summaries = (page: Page) =>
  page.evaluate(() => (window as unknown as Hooks).mindflow.store.workspaceSummaries());
const elements = (page: Page) =>
  page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as Hooks).mindflow.store.document.elements)));
const isDirty = (page: Page) => page.evaluate(() => (window as unknown as Hooks).mindflow.store.getState().dirty);
const markClean = (page: Page) => page.evaluate(() => (window as unknown as Hooks).mindflow.store.markSaved());

const switcher = (page: Page) => page.locator('[data-action="workspaces"]');
const strip = (page: Page) => page.locator('.mf-workspace-numbers');
/** The numbers on screen, in order. Those dropped for want of room are hidden. */
const numbers = (page: Page) => strip(page).locator('.mf-workspace-number:visible');
const numberButton = (page: Page, n: number) => strip(page).getByRole('button', { name: new RegExp(`^${n}: `) });
const list = (page: Page) => page.locator('.mf-workspaces');
const row = (page: Page, name: string) =>
  list(page)
    .locator('.mf-workspace-item')
    .filter({ has: page.locator('.mf-recent-name').getByText(name, { exact: true }) });

async function canvasBox(page: Page) {
  const box = await page.locator('.mf-canvas').boundingBox();
  if (!box) throw new Error('canvas not found');
  return box;
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + from[0], box.y + from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 8 });
  await page.mouse.up();
}

async function drawRectangle(page: Page, at: [number, number] = [100, 100]) {
  await page.locator('[data-tool="rectangle"]').click();
  await drag(page, at, [at[0] + 120, at[1] + 80]);
  await page.keyboard.press('Escape');
}

async function addWorkspace(page: Page) {
  await switcher(page).click();
  await list(page).getByRole('button', { name: 'New workspace' }).click();
}

async function goTo(page: Page, name: string) {
  await switcher(page).click();
  await row(page, name).locator('.mf-workspace-open').click();
}

/**
 * Adds `count` workspaces through the store, the last one ending on screen.
 * Quicker than the list when a test needs many; the list's own path is
 * covered above.
 */
async function addWorkspaces(page: Page, count: number) {
  await page.evaluate((count) => {
    for (let i = 0; i < count; i++) (window as unknown as Hooks).mindflow.store.addWorkspace();
  }, count);
}

/** Opens a row's own menu and picks `item` in it. */
async function rowAction(page: Page, name: string, item: string) {
  await switcher(page).click();
  const target = row(page, name);
  await target.hover();
  await target.getByRole('button', { name: `Options for ${name}` }).click();
  await list(page).getByRole('menuitem', { name: item }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto(APP_URL);
  await page.waitForFunction(() => 'mindflow' in window);
});

test.describe('the switcher', () => {
  test('starts on "Workspace 1", and a new workspace is an empty board of its own', async ({ page }) => {
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
    await drawRectangle(page);

    await addWorkspace(page);
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 2');
    expect(await elements(page)).toEqual([]);

    await drawRectangle(page, [300, 200]);
    await goTo(page, 'Workspace 1');
    const first = await elements(page);
    expect(first).toHaveLength(1);
    expect(first[0].x).toBeLessThan(250);

    await goTo(page, 'Workspace 2');
    expect((await elements(page))[0].x).toBeGreaterThan(250);
  });

  test('lists every workspace with its element count, the current one tagged', async ({ page }) => {
    await drawRectangle(page);
    await addWorkspace(page);
    await switcher(page).click();

    await expect(row(page, 'Workspace 1').locator('.mf-recent-meta')).toHaveText('1 element');
    await expect(row(page, 'Workspace 2').locator('.mf-recent-meta')).toHaveText('Empty');
    await expect(row(page, 'Workspace 2').locator('.mf-recent-tag')).toHaveText('Current');
    await expect(switcher(page)).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('Escape');
    await expect(list(page)).toHaveCount(0);
    await expect(switcher(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('switching is not an edit: a saved board stays saved', async ({ page }) => {
    await addWorkspace(page);
    await markClean(page);
    await goTo(page, 'Workspace 1');
    await goTo(page, 'Workspace 2');
    expect(await isDirty(page)).toBe(false);
  });

  test('undo stays in the workspace on screen', async ({ page }) => {
    await drawRectangle(page);
    await addWorkspace(page);
    await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();

    await goTo(page, 'Workspace 1');
    await page.keyboard.press('ControlOrMeta+z');
    expect(await elements(page)).toEqual([]);
    await page.keyboard.press('ControlOrMeta+z');
    await goTo(page, 'Workspace 2');
    expect(await elements(page)).toEqual([]);
  });
});

test.describe('the quick-switch numbers', () => {
  test('appear with a second workspace, the one on screen marked', async ({ page }) => {
    await expect(strip(page)).toBeHidden();
    await addWorkspace(page);

    await expect(numbers(page)).toHaveText(['1', '2']);
    await expect(numberButton(page, 2)).toHaveAttribute('aria-current', 'true');
    await expect(numberButton(page, 2)).toHaveAttribute('title', 'Workspace 2 (current)');
    await expect(numberButton(page, 1)).not.toHaveAttribute('aria-current');
    await expect(numberButton(page, 1)).toHaveAccessibleName('1: Workspace 1');
    await expect(numberButton(page, 1)).toHaveAttribute('title', 'Workspace 1');
  });

  test('a press switches, keeps focus on the number, and is not an edit', async ({ page }) => {
    await drawRectangle(page);
    await addWorkspace(page);
    await markClean(page);

    await numberButton(page, 1).click();
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
    expect(await elements(page)).toHaveLength(1);
    await expect(numberButton(page, 1)).toHaveAttribute('aria-current', 'true');
    await expect(numberButton(page, 2)).not.toHaveAttribute('aria-current');
    await expect(numberButton(page, 1)).toBeFocused();
    expect(await isDirty(page)).toBe(false);

    // Pressing the one on screen changes nothing.
    await numberButton(page, 1).click();
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
  });

  test('a text box being typed in keeps its text in its own workspace', async ({ page }) => {
    await addWorkspace(page);
    await page.locator('[data-tool="text"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 200);
    await page.keyboard.type('Kept');

    await numberButton(page, 1).click();
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
    await expect(page.locator('.mf-text-editor')).toBeHidden();
    expect(await elements(page)).toEqual([]);
    await numberButton(page, 2).click();
    expect((await elements(page)).map((element: { text?: string }) => element.text)).toEqual(['Kept']);
  });

  test('follow the list as it is reordered, renamed and shortened', async ({ page }) => {
    await addWorkspace(page);
    await rowAction(page, 'Workspace 1', 'Move down');
    await page.keyboard.press('Escape');
    // Numbers are positions: 1 is now the workspace on screen.
    await expect(numberButton(page, 1)).toHaveAccessibleName('1: Workspace 2');
    await expect(numberButton(page, 1)).toHaveAttribute('aria-current', 'true');

    await rowAction(page, 'Workspace 2', 'Rename');
    const input = list(page).locator('.mf-workspace-rename');
    await input.fill('Sketches');
    await input.press('Enter');
    await page.keyboard.press('Escape');
    await expect(numberButton(page, 1)).toHaveAccessibleName('1: Sketches');
    await expect(numberButton(page, 1)).toHaveAttribute('title', 'Sketches (current)');

    // Back to one workspace: nowhere to switch to.
    await rowAction(page, 'Workspace 1', 'Delete');
    await expect(strip(page)).toBeHidden();
  });

  test('stop at nine', async ({ page }) => {
    await addWorkspaces(page, 11);
    await expect(numbers(page)).toHaveText(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    // Workspace 12 is on screen, past the strip, so no number is marked.
    await expect(strip(page).locator('[aria-current]')).toHaveCount(0);
  });

  test('drop from the end when the bar is short of room, before the switcher loses its name', async ({ page }) => {
    await addWorkspaces(page, 8);
    await expect(numbers(page)).toHaveCount(9);

    await page.setViewportSize({ width: 1024, height: 768 });
    await expect.poll(() => numbers(page).count()).toBeLessThan(9);
    const shown = await numbers(page).allTextContents();
    expect(shown.length).toBeGreaterThanOrEqual(2);
    expect(shown).toEqual(shown.map((_, index) => String(index + 1)));
    // The switcher's name is whole, not cut short.
    expect(
      await page.locator('.mf-workspace-name').evaluate((name) => name.scrollWidth <= name.clientWidth),
    ).toBe(true);
    expect(await blockedControls(page)).toEqual([]);

    // Every fit starts afresh, so room given back brings them all back.
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(numbers(page)).toHaveCount(9);
  });
});

test.describe('the keyboard', () => {
  test('Page Down and Page Up step through the workspaces, stopping at the ends', async ({ page }) => {
    await addWorkspace(page);
    await addWorkspace(page);
    const active = async () => (await summaries(page)).find((summary) => summary.active)?.name;

    await page.keyboard.press('PageDown');
    expect(await active()).toBe('Workspace 3');
    await page.keyboard.press('PageUp');
    await page.keyboard.press('PageUp');
    expect(await active()).toBe('Workspace 1');
    await page.keyboard.press('PageUp');
    expect(await active()).toBe('Workspace 1');
  });

  test('a drag in flight is abandoned and rewound, not finished in the next workspace', async ({ page }) => {
    await drawRectangle(page, [100, 100]);
    await addWorkspace(page);
    await page.keyboard.press('PageUp');
    const before = (await elements(page))[0];

    // Press on the rectangle's outline (an unfilled shape is hollow to
    // presses), drag it, and switch while the button is still down.
    const box = await canvasBox(page);
    await page.mouse.move(box.x + 100, box.y + 140);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 300, { steps: 6 });
    expect((await elements(page))[0].x).toBeGreaterThan(before.x + 200);
    await page.keyboard.press('PageDown');
    await page.mouse.move(box.x + 450, box.y + 350, { steps: 3 });
    await page.mouse.up();

    expect(await elements(page)).toEqual([]);
    await page.keyboard.press('PageUp');
    const after = (await elements(page))[0];
    expect({ x: after.x, y: after.y }).toEqual({ x: before.x, y: before.y });
  });
});

test.describe('an editor open when the workspace changes', () => {
  test('a text box keeps what was typed, in the workspace it was typed in', async ({ page }) => {
    await page.locator('[data-tool="text"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 200);
    await page.keyboard.type('Kept');
    await addWorkspace(page);

    expect(await elements(page)).toEqual([]);
    await expect(page.locator('.mf-text-editor')).toBeHidden();
    await goTo(page, 'Workspace 1');
    const [text] = await elements(page);
    expect(text?.text).toBe('Kept');
  });

  test('a new, empty text box leaves nothing behind, not even an unsaved flag', async ({ page }) => {
    await addWorkspace(page);
    await goTo(page, 'Workspace 1');
    await markClean(page);

    await page.locator('[data-tool="text"]').click();
    const box = await canvasBox(page);
    await page.mouse.click(box.x + 200, box.y + 200);
    await expect(page.locator('.mf-text-editor')).toBeVisible();
    // A switch, not a new workspace, which would be an edit of its own.
    await goTo(page, 'Workspace 2');
    expect(await isDirty(page)).toBe(false);
    await goTo(page, 'Workspace 1');
    expect(await elements(page)).toEqual([]);
  });
});

test.describe('a row’s own menu', () => {
  test('Rename edits the name in place, and Enter keeps it', async ({ page }) => {
    await markClean(page);
    await rowAction(page, 'Workspace 1', 'Rename');
    const input = list(page).locator('.mf-workspace-rename');
    await expect(input).toBeFocused();
    await input.fill('User flow');
    await input.press('Enter');

    await expect(row(page, 'User flow')).toHaveCount(1);
    await expect(switcher(page)).toHaveAccessibleName('Workspace: User flow');
    expect(await isDirty(page)).toBe(true);
  });

  test('Escape steps back one layer at a time: the rename, then the list', async ({ page }) => {
    await rowAction(page, 'Workspace 1', 'Rename');
    await list(page).locator('.mf-workspace-rename').fill('Not kept');
    await page.keyboard.press('Escape');
    await expect(row(page, 'Workspace 1')).toHaveCount(1);
    await expect(list(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(list(page)).toHaveCount(0);
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
  });

  test('F2 renames the focused row', async ({ page }) => {
    await switcher(page).click();
    await expect(row(page, 'Workspace 1').locator('.mf-workspace-open')).toBeFocused();
    await page.keyboard.press('F2');
    await page.keyboard.type('Ideas');
    await page.keyboard.press('Enter');
    await expect(row(page, 'Ideas')).toHaveCount(1);
  });

  test('Duplicate copies the workspace after itself and opens the copy', async ({ page }) => {
    await drawRectangle(page);
    const [original] = await elements(page);
    await addWorkspace(page);
    await rowAction(page, 'Workspace 1', 'Duplicate');

    expect((await summaries(page)).map((summary) => summary.name)).toEqual([
      'Workspace 1',
      'Workspace 1 copy',
      'Workspace 2',
    ]);
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1 copy');
    const [copy] = await elements(page);
    expect(copy.id).not.toBe(original.id);
    expect({ x: copy.x, y: copy.y }).toEqual({ x: original.x, y: original.y });
  });

  test('Move down and Move up reorder the list', async ({ page }) => {
    await addWorkspace(page);
    await rowAction(page, 'Workspace 1', 'Move down');
    expect((await summaries(page)).map((summary) => summary.name)).toEqual(['Workspace 2', 'Workspace 1']);
    // The list stays open on the moved row, ready to move it again.
    await expect(row(page, 'Workspace 1').locator('.mf-workspace-more')).toBeFocused();
    await row(page, 'Workspace 1').locator('.mf-workspace-more').click();
    await expect(list(page).getByRole('menuitem', { name: 'Move down' })).toBeDisabled();
    await list(page).getByRole('menuitem', { name: 'Move up' }).click();
    expect((await summaries(page)).map((summary) => summary.name)).toEqual(['Workspace 1', 'Workspace 2']);
  });

  test('Delete asks first when there is content, and the next workspace takes its place', async ({ page }) => {
    await drawRectangle(page);
    await addWorkspace(page);
    await goTo(page, 'Workspace 1');

    await rowAction(page, 'Workspace 1', 'Delete');
    const dialog = page.getByRole('dialog', { name: 'Delete workspace?' });
    await expect(dialog).toContainText('"Workspace 1" and its 1 element will be deleted');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    expect(await summaries(page)).toHaveLength(2);

    await rowAction(page, 'Workspace 1', 'Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete workspace' }).click();
    expect((await summaries(page)).map((summary) => summary.name)).toEqual(['Workspace 2']);
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 2');
  });

  test('Delete removes an empty workspace without asking, and cannot remove the last', async ({ page }) => {
    await addWorkspace(page);
    await rowAction(page, 'Workspace 2', 'Delete');
    await expect(page.getByRole('dialog', { name: 'Delete workspace?' })).toHaveCount(0);
    expect(await summaries(page)).toHaveLength(1);

    await switcher(page).click();
    await row(page, 'Workspace 1').getByRole('button', { name: 'Options for Workspace 1' }).click();
    await expect(list(page).getByRole('menuitem', { name: 'Delete' })).toBeDisabled();
  });
});

test.describe('the command palette', () => {
  test('adds a workspace and goes to one by name', async ({ page }) => {
    const run = async (title: string) => {
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.type(title);
      await page.keyboard.press('Enter');
    };
    await run('New workspace');
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 2');
    await run('Go to workspace: Workspace 1');
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
  });
});

test.describe('one file', () => {
  /** Records what a save writes, through a fake file picker. */
  async function recordSaves(page: Page) {
    await page.addInitScript(() => {
      const written: string[] = [];
      const handle = {
        name: 'Plan.mindflow.json',
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        createWritable: async () => {
          let data = '';
          return {
            write: async (chunk: unknown) => {
              data += typeof chunk === 'string' ? chunk : await new Response(chunk as Blob).text();
            },
            close: async () => {
              written.push(data);
            },
          };
        },
      };
      Object.assign(window, { __written: written, showSaveFilePicker: async () => handle });
    });
    await page.reload();
    await page.waitForFunction(() => 'mindflow' in window);
  }

  test('a save writes every workspace, and the one on screen', async ({ page }) => {
    await recordSaves(page);
    await drawRectangle(page);
    await addWorkspace(page);
    await drawRectangle(page, [300, 200]);
    await drawRectangle(page, [500, 200]);
    await page.keyboard.press('ControlOrMeta+s');

    await expect.poll(() => page.evaluate(() => (window as unknown as { __written: string[] }).__written.length)).toBe(1);
    const file = JSON.parse(await page.evaluate(() => (window as unknown as { __written: string[] }).__written[0] as string));
    expect(file.schemaVersion).toBe('2.0.0');
    expect(file.workspaces.map((workspace: { elements: unknown[] }) => workspace.elements.length)).toEqual([1, 2]);
    expect(file.activeWorkspaceId).toBe(file.workspaces[1].id);
  });

  test('reopened from Recent boards, it comes back with every workspace, on the one left open', async ({ page }) => {
    await drawRectangle(page);
    await addWorkspace(page);
    const input = page.locator('.mf-board-name');
    await input.fill('Two workspaces');
    await input.press('Enter');

    await page.getByRole('button', { name: 'New board' }).click();
    // The board keeps its copy in the recent list, so leaving it asks to continue.
    await page.getByRole('dialog').getByRole('button', { name: 'Continue' }).click();
    expect(await summaries(page)).toHaveLength(1);

    await page.getByRole('button', { name: 'Recent boards' }).click();
    await page.locator('.mf-recent-item').filter({ hasText: 'Two workspaces' }).locator('.mf-recent-open').click();
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 2');
    expect((await summaries(page)).map((summary) => summary.elementCount)).toEqual([1, 0]);
  });

  test('a board whose workspace on screen is empty is still kept, and leaving it says so', async ({ page }) => {
    await drawRectangle(page);
    await addWorkspace(page);
    await page.getByRole('button', { name: 'New board' }).click();
    await expect(page.getByRole('dialog', { name: 'Leave unsaved changes?' })).toBeVisible();
  });

  test('copy in one workspace, paste in another', async ({ page }) => {
    await drawRectangle(page);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+c');
    await addWorkspace(page);
    await page.keyboard.press('ControlOrMeta+v');
    await expect.poll(async () => (await elements(page)).length).toBe(1);
  });

  test('a file from a newer major version opens detached, with a warning', async ({ page }) => {
    const future = JSON.stringify({ type: 'mindflow.board', schemaVersion: '3.0.0', workspaces: [{ id: 'ws_a', elements: [] }] });
    await page.evaluate((content) => {
      const data = new DataTransfer();
      data.items.add(new File([content], 'future.mindflow.json', { type: 'application/json' }));
      document.querySelector('.mf-canvas')?.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    }, future);
    await expect(page.locator('.mf-toast').filter({ hasText: 'newer version of MindFlow' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as Hooks).mindflow.store.getState().origin.kind)).toBe('new');
  });
});

/**
 * Top-bar controls a click at their centre does not land on, once each is
 * scrolled into the bar's view: the ones something else overlaps. Controls
 * that are not drawn at all (a quick-switch number dropped for want of room)
 * are not blocked, only absent, and are skipped.
 */
const blockedControls = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.mf-topbar button, .mf-topbar input')]
      .filter((control) => control.getClientRects().length > 0)
      .filter((control) => {
        control.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const box = control.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return !(hit === control || control.contains(hit));
      })
      .map((control) => control.getAttribute('aria-label') ?? control.className),
  );

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the switcher is its glyph, and every top-bar control can be reached', async ({ page }) => {
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
    await expect(page.locator('.mf-workspace-name')).toBeHidden();
    await expect(page.locator('.mf-workspace-glyph')).toBeVisible();
    expect(await blockedControls(page)).toEqual([]);

    // At rest, the board name and the switcher are on screen.
    await page.locator('.mf-topbar').evaluate((bar) => bar.scrollTo({ left: 0 }));
    await switcher(page).click();
    await expect(list(page)).toBeVisible();
  });

  test('just above the phone layout, the switcher stays compact so nothing covers it', async ({ page }) => {
    // Between 760px and about 784px a named switcher does not fit beside the
    // other groups, and the next group's buttons would be drawn over it.
    await page.setViewportSize({ width: 780, height: 768 });
    await expect(page.locator('.mf-workspace-glyph')).toBeVisible();
    expect(await blockedControls(page)).toEqual([]);
  });

  test('with several workspaces, every number is in the bar and can be tapped', async ({ page }) => {
    await addWorkspaces(page, 4);
    // The bar scrolls here, so nothing is short of room and none is dropped.
    await expect(numbers(page)).toHaveText(['1', '2', '3', '4', '5']);
    expect(await blockedControls(page)).toEqual([]);
    await page.locator('.mf-topbar').evaluate((bar) => bar.scrollTo({ left: 0 }));
    await numberButton(page, 1).click();
    await expect(switcher(page)).toHaveAccessibleName('Workspace: Workspace 1');
  });

  test('between the layouts, the numbers never cover anything', async ({ page }) => {
    await addWorkspaces(page, 8);
    for (const width of [770, 800, 840, 860, 880, 920, 960, 1000]) {
      await page.setViewportSize({ width, height: 768 });
      // Let the resize observer refit the strip before measuring.
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect({ width, blocked: await blockedControls(page) }).toEqual({ width, blocked: [] });
      const shown = await numbers(page).count();
      expect(shown === 0 || shown >= 2).toBe(true);
    }
  });

  test('a named switcher returns where there is room for it', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await expect(page.locator('.mf-workspace-name')).toHaveText('Workspace 1');
    await expect(page.locator('.mf-workspace-glyph')).toBeHidden();
    expect(await blockedControls(page)).toEqual([]);
  });
});
