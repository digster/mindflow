import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against the BUILT `index.html`, loaded over `file://`.
 *
 * Two deliberate choices:
 *
 *   1. **The built artifact, not a dev server.** The bundle that ships is the
 *      thing that must work. Testing a differently-assembled dev build would
 *      leave the actual deliverable unverified.
 *
 *   2. **Over `file://`.** "Runnable without a server" is a hard requirement of
 *      this project, and it is exactly the kind of claim that silently breaks —
 *      the moment someone reintroduces a module script or an external asset, the
 *      page dies on double-click. Loading it this way turns that requirement
 *      into a test.
 *
 * Screenshots and videos are off: the suite asserts on state, not pixels, and
 * stray image files should never be left behind in the repository.
 */
export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    screenshot: 'off',
    video: 'off',
    trace: 'off',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
});
