/**
 * MindFlow build.
 *
 * Produces a SINGLE self-contained `index.html` at the repository root, with all
 * JavaScript and CSS inlined and zero external requests.
 *
 * Why inline everything rather than ship `index.html` + `app.js`?
 * Browsers fetch `<script type="module">` with CORS semantics, and a page opened
 * from `file://` has an opaque origin, so every module fetch is blocked. A page
 * that loads its code from separate module files therefore CANNOT be run by
 * double-clicking it. Inlining sidesteps that entirely: the built page carries
 * its own code, so the same artifact works from `file://`, from `npm run serve`,
 * and from GitHub Pages without modification.
 *
 * Usage:
 *   node build.mjs            one-shot production build
 *   node build.mjs --watch    rebuild on change (open index.html directly, refresh manually)
 *   node build.mjs --serve    rebuild on change and serve over http://localhost:8000
 *                             (needed for Google Drive, which cannot run on file://)
 */

import * as esbuild from 'esbuild';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(ROOT, 'src', 'main.ts');
const TEMPLATE = join(ROOT, 'src', 'index.template.html');
const OUTPUT = join(ROOT, 'index.html');

const watch = process.argv.includes('--watch');
const serve = process.argv.includes('--serve');
const dev = watch || serve;
const PORT = Number(process.env.PORT ?? 8000);

/**
 * Minimal .env reader. We deliberately avoid a dotenv dependency — the format we
 * need is `KEY=value` lines with `#` comments, and nothing more.
 */
function loadEnv() {
  const file = join(ROOT, '.env');
  /** @type {Record<string, string>} */
  const env = {};
  if (existsSync(file)) {
    for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      // Strip matched surrounding quotes, if the author used any.
      const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      env[key] = value;
    }
  }
  // Real environment variables win over the .env file, so CI can override.
  for (const key of Object.keys(env)) {
    if (process.env[key] !== undefined) env[key] = String(process.env[key]);
  }
  return env;
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const env = loadEnv();

/**
 * Build-time constants substituted directly into the bundle. These are public
 * configuration, never secrets: everything here ends up readable in index.html.
 */
const define = {
  __APP_VERSION__: JSON.stringify(pkg.version),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  __GOOGLE_CLIENT_ID__: JSON.stringify(env.MINDFLOW_GOOGLE_CLIENT_ID ?? ''),
  __GOOGLE_SCOPE__: JSON.stringify(
    env.MINDFLOW_GOOGLE_SCOPE ?? 'https://www.googleapis.com/auth/drive.file',
  ),
  __DRIVE_FOLDER_NAME__: JSON.stringify(env.MINDFLOW_DRIVE_FOLDER_NAME ?? 'MindFlow'),
};

/**
 * Inlining JS into HTML has one classic footgun: if the bundle contains the
 * literal text `</script>` inside a string, the HTML parser closes the script
 * block early and the page breaks in a way that is baffling to debug. Escaping
 * the slash produces an identical JavaScript string while being inert to the
 * HTML tokenizer.
 */
function escapeForInlineScript(js) {
  return js.replace(/<\/script/gi, '<\\/script');
}

/** Emits the final index.html from the esbuild output files plus the template. */
async function emit(result) {
  const template = await readFile(TEMPLATE, 'utf8');

  let js = '';
  let css = '';
  for (const file of result.outputFiles ?? []) {
    if (file.path.endsWith('.js')) js += file.text;
    else if (file.path.endsWith('.css')) css += file.text;
  }

  const html = template
    .replace('/*__MINDFLOW_CSS__*/', () => css)
    .replace('/*__MINDFLOW_JS__*/', () => escapeForInlineScript(js))
    .replace(/__APP_VERSION__/g, pkg.version);

  await writeFile(OUTPUT, html, 'utf8');

  const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  console.log(`[mindflow] built index.html — ${kb} kB (js ${(js.length / 1024).toFixed(1)} kB, css ${(css.length / 1024).toFixed(1)} kB)`);
}

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [ENTRY],
  bundle: true,
  format: 'iife', // Self-executing: no module semantics, so file:// works.
  target: ['chrome111', 'firefox121', 'safari16.4'],
  platform: 'browser',
  minify: !dev,
  sourcemap: false, // Inline sourcemaps would double artifact size; use `npm run dev` to debug.
  charset: 'utf8',
  legalComments: 'none',
  write: false, // Keep outputs in memory; we assemble the HTML ourselves.
  outdir: join(ROOT, '.esbuild'),
  define,
  loader: {
    '.css': 'css',
    '.svg': 'text',
  },
  logLevel: 'info',
};

if (dev) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: 'mindflow-emit',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.errors.length) {
              console.error('[mindflow] build failed — index.html left untouched');
              return;
            }
            await emit(result);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log('[mindflow] watching src/ for changes…');

  if (serve) {
    // A deliberately tiny static server. Its only job is to give the app an
    // http:// origin, which Google OAuth requires and file:// cannot provide.
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
        const target = resolve(ROOT, relative);
        // Path traversal guard: never serve anything outside the repo root.
        if (!target.startsWith(ROOT)) {
          res.writeHead(403).end('Forbidden');
          return;
        }
        const body = await readFile(target);
        res.writeHead(200, {
          'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        res.end(body);
      } catch {
        res.writeHead(404).end('Not found');
      }
    }).listen(PORT, () => {
      console.log(`[mindflow] serving http://localhost:${PORT}`);
      console.log('[mindflow] add that exact origin to your Google OAuth client to test Drive');
    });
  }
} else {
  const result = await esbuild.build(options);
  await emit(result);
}
