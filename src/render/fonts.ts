/**
 * The typefaces MindFlow ships, and their installation at startup.
 *
 * The TTFs in `src/fonts/` are inlined into the page by `build.mjs`, which
 * deflates them (zlib) and base64-encodes the result: about 180 kB for all
 * eight faces. Nothing is fetched: `new FontFace(name, bytes)` needs no URL,
 * so the page still makes no requests and still works from `file://`.
 *
 * Installation must finish before the app lays out any text, or the first
 * layout would measure with a fallback font and wrap differently from every
 * later one. `main.ts` awaits it before constructing the app. If it fails
 * (a browser without `DecompressionStream`, say), MindFlow runs on the system
 * fonts the stacks list after the bundled one, as it did before fonts were
 * bundled, and features that need the font files, such as real text in a
 * PDF, turn themselves off.
 *
 * The compressed bytes are kept as well as the installed faces: the PDF
 * writer embeds them as they are, and the SVG exporter inlines the
 * decompressed ones.
 */

import sansRegular from '../fonts/sans-regular.ttf';
import sansBold from '../fonts/sans-bold.ttf';
import serifRegular from '../fonts/serif-regular.ttf';
import serifBold from '../fonts/serif-bold.ttf';
import monoRegular from '../fonts/mono-regular.ttf';
import monoBold from '../fonts/mono-bold.ttf';
import handRegular from '../fonts/hand-regular.ttf';
import handBold from '../fonts/hand-bold.ttf';
import type { FontFamily } from '../model/types.ts';
import { BOLD_FACE_WEIGHT, BUNDLED_FAMILIES, faceRole, type FaceRole } from './shapes/shared.ts';
import { parseTrueType, type TrueTypeFont } from './ttf.ts';

/** One installed face. */
export interface BundledFace {
  family: FontFamily;
  role: FaceRole;
  /** The name it is registered under, e.g. `MindFlow Sans`. */
  cssFamily: string;
  /** The CSS weight range it answers for, e.g. `1 549`. */
  cssWeight: string;
  /** The TTF, zlib-compressed: exactly what a PDF `FlateDecode` stream holds. */
  deflated: Uint8Array<ArrayBuffer>;
  /** The TTF itself. */
  bytes: Uint8Array<ArrayBuffer>;
  /** Its parsed tables, for widths and the character map. */
  font: TrueTypeFont;
}

const SOURCES: { family: FontFamily; role: FaceRole; base64: string }[] = [
  { family: 'sans', role: 'regular', base64: sansRegular },
  { family: 'sans', role: 'bold', base64: sansBold },
  { family: 'serif', role: 'regular', base64: serifRegular },
  { family: 'serif', role: 'bold', base64: serifBold },
  { family: 'mono', role: 'regular', base64: monoRegular },
  { family: 'mono', role: 'bold', base64: monoBold },
  { family: 'hand', role: 'regular', base64: handRegular },
  { family: 'hand', role: 'bold', base64: handBold },
];

/** Installed faces, keyed `family/role`. Empty until installation succeeds. */
const installed = new Map<string, BundledFace>();

/**
 * Decodes and registers every bundled face. Resolves `true` when all are
 * ready, and `false`, after a console warning, when any failed. It never
 * rejects: the app still works on system fonts.
 */
export async function installBundledFonts(): Promise<boolean> {
  try {
    const faces = await Promise.all(SOURCES.map(decodeFace));
    await Promise.all(
      faces.map(async (face) => {
        const fontFace = new FontFace(face.cssFamily, face.bytes, {
          weight: face.cssWeight,
          style: 'normal',
          display: 'block',
        });
        await fontFace.load();
        document.fonts.add(fontFace);
      }),
    );
    for (const face of faces) installed.set(`${face.family}/${face.role}`, face);
    return true;
  } catch (error) {
    console.warn('[mindflow] bundled fonts unavailable; using system fonts', error);
    return false;
  }
}

/** Whether every bundled face is installed, so text is measured with them. */
export function bundledFontsReady(): boolean {
  return installed.size === SOURCES.length;
}

/**
 * The installed face that draws `family` at `weight`, or `null` before
 * installation or after it failed.
 */
export function bundledFace(family: FontFamily, weight: number): BundledFace | null {
  return installed.get(`${family}/${faceRole(weight)}`) ?? null;
}

const fontFaceRules = new Map<BundledFace, string>();

/**
 * A CSS `@font-face` rule carrying `face` as a data URI, for an SVG that must
 * look the same on a machine without MindFlow's fonts. Built once per face:
 * encoding a face takes longer than exporting a board.
 */
export function fontFaceRule(face: BundledFace): string {
  let rule = fontFaceRules.get(face);
  if (!rule) {
    let binary = '';
    // In chunks, because spreading tens of thousands of arguments into one
    // call can exceed the engine's argument limit.
    for (let start = 0; start < face.bytes.length; start += 0x8000) {
      binary += String.fromCharCode(...face.bytes.subarray(start, start + 0x8000));
    }
    rule =
      `@font-face{font-family:"${face.cssFamily}";font-weight:${face.cssWeight};` +
      `src:url(data:font/ttf;base64,${btoa(binary)}) format("truetype")}`;
    fontFaceRules.set(face, rule);
  }
  return rule;
}

async function decodeFace(source: (typeof SOURCES)[number]): Promise<BundledFace> {
  const deflated = Uint8Array.from(atob(source.base64), (character) => character.charCodeAt(0));
  const stream = new Blob([deflated]).stream().pipeThrough(new DecompressionStream('deflate'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return {
    family: source.family,
    role: source.role,
    cssFamily: BUNDLED_FAMILIES[source.family],
    // Ranges rather than single weights, so every weight from 1 to 1000
    // matches exactly one face and the browser never synthesises bold.
    cssWeight: source.role === 'bold' ? `${BOLD_FACE_WEIGHT} 1000` : `1 ${BOLD_FACE_WEIGHT - 1}`,
    deflated,
    bytes,
    font: parseTrueType(bytes),
  };
}
