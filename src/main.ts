/**
 * Entry point.
 *
 * Registers the shape modules, then boots the app. Kept deliberately thin — the
 * interesting wiring is in `app/app.ts`.
 */

import './styles/app.css';
// Side-effecting: each shape module registers itself with the element registry.
// This import must come before anything that reads the registry.
import './render/shapes/index.ts';

import { MindflowApp } from './app/app.ts';

declare const __APP_VERSION__: string;
declare const __BUILD_TIME__: string;

function boot(): void {
  const root = document.getElementById('mf-root');
  if (!root) {
    console.error('[mindflow] #mf-root is missing from the page.');
    return;
  }

  try {
    const app = new MindflowApp(root);

    // Exposed for the end-to-end tests, which drive the store directly rather
    // than synthesising a hundred pointer events per assertion. Harmless in
    // production: it is the same API the UI already uses.
    (window as unknown as Record<string, unknown>).mindflow = {
      app,
      version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
      builtAt: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : null,
      ...app.testHooks,
    };
  } catch (error) {
    console.error('[mindflow] failed to start', error);
    // A blank page with an error only in the console is a bad failure mode for
    // an app people may have opened from a file with no devtools in sight.
    root.textContent = '';
    const message = document.createElement('div');
    message.className = 'mf-fatal';
    message.innerHTML =
      '<h1>MindFlow could not start</h1>' +
      '<p>Your browser may be too old, or the page may have loaded incompletely.</p>';
    const detail = document.createElement('pre');
    detail.textContent = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    message.append(detail);
    root.append(message);
  }
}

// `defer`-like behaviour without relying on script placement: the bundle is
// inlined at the end of <body>, but this also covers a future move into <head>.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
