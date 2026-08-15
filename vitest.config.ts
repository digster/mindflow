import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/unit/**/*.test.ts'],
    // Node, not jsdom. The pure modules under test — geometry, document,
    // commands, history, migrations — deliberately have no DOM dependency, and
    // that constraint is worth keeping enforced. Anything genuinely needing a
    // browser is covered by the Playwright suite in test/e2e instead.
    environment: 'node',
  },
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
    __BUILD_TIME__: JSON.stringify('1970-01-01T00:00:00.000Z'),
    __GOOGLE_CLIENT_ID__: JSON.stringify(''),
    __GOOGLE_SCOPE__: JSON.stringify('https://www.googleapis.com/auth/drive.file'),
    __DRIVE_FOLDER_NAME__: JSON.stringify('MindFlow'),
  },
});
