/**
 * Generates `src/ui/icons.ts` from Lucide.
 *
 * MindFlow's icons used to be hand-written path strings, on the reasoning that a
 * dependency would either be fetched from a CDN — impossible, since the built
 * page must make zero external requests — or bundled in full for the four dozen
 * icons actually used. That framing missed a third option, which is this script:
 * take the dependency at BUILD time, extract only the icons named below, and
 * commit the result. Nothing from `node_modules` reaches the bundle, the page
 * stays self-contained, and adding an icon is one line here instead of an
 * exercise in SVG draughtsmanship.
 *
 * Usage:
 *   npm run icons      regenerate src/ui/icons.ts
 *
 * The output is committed, like `index.html`. `test/unit/icons.test.ts`
 * regenerates it in memory and fails if the committed copy has drifted, so a
 * manifest edit without a re-run cannot slip through review.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = join(ROOT, 'node_modules', 'lucide-static', 'icons');
const OUTPUT = join(ROOT, 'src', 'ui', 'icons.ts');

/**
 * MindFlow icon name -> Lucide slug.
 *
 * Two of these are not the obvious pick and should not be "corrected" without
 * reading why:
 *
 *   drive  Lucide carries no Google Drive glyph — brand marks were removed for
 *          trademark reasons. `cloud` says "cloud storage" without shipping an
 *          approximation of somebody's registered mark.
 *
 *   align* Lucide's alignment names describe the axis of the RULE, not the
 *          direction things move, so `align-start-vertical` is align-LEFT. Every
 *          one of the eight below was checked against the actual path data
 *          rather than inferred from the name. Do the same before changing one.
 */
export const MANIFEST = {
  // Tools
  select: 'mouse-pointer-2',
  pan: 'hand',
  rectangle: 'square',
  ellipse: 'circle',
  diamond: 'diamond',
  frame: 'frame',
  line: 'slash',
  arrow: 'move-up-right',
  draw: 'pencil',
  text: 'type',
  sticky: 'sticky-note',
  table: 'table',
  image: 'image',
  eraser: 'eraser',

  // Shapes. `shapes` opens the toolbar's flyout; the rest are its contents, and
  // each key is an element type name so the flyout can index this by tool id.
  shapes: 'shapes',
  triangle: 'triangle',
  pentagon: 'pentagon',
  hexagon: 'hexagon',
  star: 'star',
  parallelogram: 'local:parallelogram',
  cube: 'box',
  cylinder: 'cylinder',
  cone: 'cone',
  pyramid: 'pyramid',

  // History and view
  undo: 'undo-2',
  redo: 'redo-2',
  zoomIn: 'zoom-in',
  zoomOut: 'zoom-out',
  fit: 'maximize',
  grid: 'grid-3x3',
  palette: 'palette',

  // Files and chrome
  menu: 'menu',
  newBoard: 'file-plus',
  save: 'save',
  open: 'folder-open',
  download: 'download',
  drive: 'cloud',
  settings: 'settings',
  help: 'keyboard',
  close: 'x',

  // Arrange
  trash: 'trash-2',
  front: 'bring-to-front',
  back: 'send-to-back',
  group: 'group',
  lock: 'lock',

  // Align. The rule's axis names these in Lucide; the key says what they do.
  alignLeft: 'align-start-vertical',
  alignCenterX: 'align-center-vertical',
  alignRight: 'align-end-vertical',
  alignTop: 'align-start-horizontal',
  alignCenterY: 'align-center-horizontal',
  alignBottom: 'align-end-horizontal',
  distributeH: 'align-horizontal-distribute-center',
  distributeV: 'align-vertical-distribute-center',
};

/**
 * Icons Lucide does not carry, drawn here in its idiom: a 24x24 box, stroked at
 * width 2, no fill.
 *
 * A `local:` slug in the manifest resolves to this map instead of to a file in
 * `node_modules`. These still go through `extract` and its whitelist, so a
 * hand-written icon is held to exactly the same standard as an upstream one —
 * which is what keeps `icon()`'s use of `innerHTML` justified.
 *
 *   parallelogram  Lucide has hexagon, pentagon, octagon and triangle, but no
 *                  parallelogram. Approximating one with `rectangle-horizontal`
 *                  would make the flyout's most distinctive flowchart shape
 *                  indistinguishable from a rectangle.
 */
export const LOCAL_ICONS = {
  parallelogram: '<svg viewBox="0 0 24 24"><path d="M7 4h14l-4 16H3Z"/></svg>',
};

/**
 * What an extracted icon is allowed to contain.
 *
 * This is the whole reason `icon()` may set `innerHTML`. The values it renders
 * are literals from a generated file, and this whitelist is what keeps that
 * claim true as icons are added rather than merely true today: an upstream icon
 * carrying a `<script>`, an `onload=`, or an external reference fails the build
 * instead of being quietly inlined into the page.
 */
const ALLOWED = {
  path: ['d', 'fill-rule', 'clip-rule'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
};

/** Presentation attributes any element may carry. Inert, and occasionally used. */
const ALLOWED_EVERYWHERE = [
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'opacity',
];

/** Pulls the drawable children out of one Lucide SVG, rejecting anything unexpected. */
export function extract(slug, source) {
  const open = source.indexOf('>', source.indexOf('<svg'));
  const close = source.lastIndexOf('</svg>');
  if (open === -1 || close === -1) throw new Error(`${slug}: not an SVG`);

  const body = source.slice(open + 1, close);
  const out = [];

  // Lucide emits only self-closing shape elements, so a container tag or a
  // stray text node means the upstream format changed and the assumptions here
  // need revisiting — fail rather than guess.
  // The tag and attribute character classes are deliberately wider than what
  // Lucide emits — they have to MATCH `foreignObject` and `xlink:href` in order
  // to reject them by name. Narrower patterns would simply fail to match, and an
  // attribute that does not match is an attribute that gets silently dropped.
  const remainder = body.replace(/<([a-zA-Z-]+)((?:\s+[^>]*?)?)\/>/g, (_match, tag, rawAttributes) => {
    // Looked up with the original case on purpose: `<PATH>` is not `<path>` in
    // SVG, and should be refused rather than normalised.
    const allowed = ALLOWED[tag];
    if (!allowed) throw new Error(`${slug}: unexpected element <${tag}>`);

    const attributes = [];
    // The digits matter: `x1`, `y1`, `x2` and `y2` on <line> are attribute names
    // containing numbers, and a class without 0-9 matches none of them.
    const pattern = /([a-zA-Z0-9:_.-]+)\s*=\s*"([^"]*)"/g;
    let attribute;
    let consumed = rawAttributes;
    while ((attribute = pattern.exec(rawAttributes)) !== null) {
      const [whole, name, value] = attribute;
      if (!allowed.includes(name) && !ALLOWED_EVERYWHERE.includes(name)) {
        throw new Error(`${slug}: unexpected attribute "${name}" on <${tag}>`);
      }
      if (/[<>]/.test(value)) throw new Error(`${slug}: suspicious value on "${name}"`);
      attributes.push(`${name}="${value}"`);
      consumed = consumed.replace(whole, '');
    }

    // A valueless attribute, or one quoted some other way, matches nothing
    // above and would otherwise vanish without comment.
    if (consumed.trim() !== '') {
      throw new Error(`${slug}: unparsed attributes on <${tag}>: ${JSON.stringify(consumed.trim())}`);
    }

    out.push(`<${tag} ${attributes.join(' ')}/>`);
    return '';
  });

  if (remainder.trim() !== '') {
    throw new Error(`${slug}: unparsed content ${JSON.stringify(remainder.trim())}`);
  }
  if (out.length === 0) throw new Error(`${slug}: no drawable content`);
  return out.join('');
}

/** Builds the contents of `src/ui/icons.ts`. Exported so the test can compare. */
export async function generate() {
  const entries = [];
  for (const [name, slug] of Object.entries(MANIFEST)) {
    const local = slug.startsWith('local:') ? slug.slice('local:'.length) : null;
    if (local !== null && !LOCAL_ICONS[local]) {
      throw new Error(`${name}: no local icon named "${local}"`);
    }
    const source = local === null
      ? await readFile(join(ICON_DIR, `${slug}.svg`), 'utf8')
      : LOCAL_ICONS[local];
    const credit = local === null ? `Lucide \`${slug}\`` : `MindFlow, drawn in Lucide's idiom`;
    entries.push(`  /** ${credit} */\n  ${name}: '${extract(slug, source)}',`);
  }

  const { version } = JSON.parse(
    await readFile(join(ROOT, 'node_modules', 'lucide-static', 'package.json'), 'utf8'),
  );

  return `/**
 * Icon markup — GENERATED FILE, DO NOT EDIT BY HAND.
 *
 * Run \`npm run icons\` to regenerate. The icon set and the name-to-slug mapping
 * live in \`scripts/build-icons.mjs\`; add an icon there, not here.
 *
 * Each value is the *inner* markup of a 24x24 SVG drawn with
 * \`stroke="currentColor"\`, \`fill="none"\` and \`stroke-width="2"\` — the wrapper
 * is supplied by \`icon()\` in \`dom.ts\`. Values are markup rather than a single
 * path's \`d\` because a real icon set routinely needs several elements.
 *
 * ---------------------------------------------------------------------------
 * Icons from Lucide (https://lucide.dev), version ${version}.
 *
 * ISC License
 *
 * Copyright (c) 2026 Lucide Icons and Contributors
 *
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 *
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
 * INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
 * LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
 * OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
 * PERFORMANCE OF THIS SOFTWARE.
 * ---------------------------------------------------------------------------
 */

export const ICONS = {
${entries.join('\n')}
} as const;

export type IconName = keyof typeof ICONS;
`;
}

// Only write when run directly, so importing this from a test does not touch
// the working tree.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = await generate();
  await writeFile(OUTPUT, file, 'utf8');
  const count = Object.keys(MANIFEST).length;
  console.log(`[mindflow] wrote src/ui/icons.ts — ${count} icons`);
}
