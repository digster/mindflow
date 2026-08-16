/**
 * Identifier generation and the default values applied to new documents and
 * elements.
 *
 * Every default in this file is also written into `docs/03-elements.md`. When a
 * field is omitted from a hand-authored or generated file, `normalizeDocument()`
 * fills it from here — so these values are not merely UI conveniences, they are
 * part of the format's specified behaviour.
 */

import type {
  BoardId,
  CanvasSettings,
  ElementId,
  ElementLabel,
  ElementStyle,
  FontFamily,
  GroupId,
  MindflowDocument,
  Viewport,
} from './types.ts';
import { CURRENT_SCHEMA_VERSION } from './types.ts';

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * URL- and filename-safe alphabet. Deliberately excludes look-alike characters
 * (`0`/`O`, `1`/`l`/`I`) so an ID read aloud or copied by hand survives the trip.
 */
const ID_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ID_LENGTH = 10;

/**
 * Generates a random identifier with the given prefix.
 *
 * Uses `crypto.getRandomValues` where available. With a 56-character alphabet
 * and 10 characters, that is ~58 bits of entropy — collision probability within
 * a single board is negligible.
 *
 * The modulo bias from mapping 256 byte values onto 56 symbols is real but
 * irrelevant here: these IDs are uniqueness tokens, not secrets.
 */
export function generateId(prefix: string): string {
  const bytes = new Uint8Array(ID_LENGTH);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node without webcrypto, or a very old browser. Fine for IDs.
    for (let i = 0; i < ID_LENGTH; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ID_ALPHABET[(bytes[i] as number) % ID_ALPHABET.length];
  }
  return `${prefix}${out}`;
}

export const newElementId = (): ElementId => generateId('el_');
export const newGroupId = (): GroupId => generateId('grp_');
export const newBoardId = (): BoardId => generateId('brd_');

// ---------------------------------------------------------------------------
// Z-index
// ---------------------------------------------------------------------------

/**
 * Spacing between consecutive z-indices.
 *
 * Fractional indexing needs headroom: with a gap of 1000, roughly ten elements
 * can be inserted between any two before the midpoints run out of float
 * precision. `reindexZ()` in `commands.ts` renormalises if that ever happens.
 */
export const Z_INDEX_STEP = 1000;

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Default drawing colors. Kept deliberately small — a constrained palette makes
 * boards look coherent without the user having to think about color.
 */
export const PALETTE = {
  stroke: ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5'],
  fill: ['transparent', '#ffffff', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99', '#eebefa'],
  sticky: ['#ffec99', '#ffc9c9', '#b2f2bb', '#a5d8ff', '#eebefa', '#ffd8a8'],
  canvas: ['#ffffff', '#f8f9fa', '#1e1e1e'],
} as const;

export const DEFAULT_STYLE: ElementStyle = {
  stroke: '#1e1e1e',
  strokeWidth: 2,
  strokeStyle: 'solid',
  fill: 'transparent',
  fillStyle: 'none',
  roughness: 0,
};

export const DEFAULT_FONT_FAMILY: FontFamily = 'sans';
export const DEFAULT_FONT_SIZE = 20;
export const DEFAULT_FONT_WEIGHT = 400;
export const DEFAULT_LINE_HEIGHT = 1.25;
export const DEFAULT_TEXT_COLOR = '#1e1e1e';
export const DEFAULT_LABEL_PADDING = 8;

export function defaultLabel(text = ''): ElementLabel {
  return {
    text,
    fontFamily: DEFAULT_FONT_FAMILY,
    fontSize: DEFAULT_FONT_SIZE,
    fontWeight: DEFAULT_FONT_WEIGHT,
    lineHeight: DEFAULT_LINE_HEIGHT,
    color: DEFAULT_TEXT_COLOR,
    textAlign: 'center',
    verticalAlign: 'middle',
    padding: DEFAULT_LABEL_PADDING,
  };
}

// ---------------------------------------------------------------------------
// Canvas and viewport
// ---------------------------------------------------------------------------

export const DEFAULT_CANVAS: CanvasSettings = {
  background: '#ffffff',
  grid: { visible: false, size: 20, snap: false },
};

export const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

/**
 * Zoom limits. Below 10% shapes become unreadable specks; above 3000% the
 * float precision of scene coordinates starts to show as jitter.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 30;

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

/**
 * Where the published schema for the version this build writes lives.
 *
 * Derived from `CURRENT_SCHEMA_VERSION` rather than written out, because it is
 * stamped into every board MindFlow saves and nothing would have caught the two
 * drifting apart: a version bump that forgot this line would ship files whose
 * `$schema` pointed at the wrong document, silently and forever. The contract
 * test now also asserts the file it names actually exists.
 */
export const SCHEMA_URL = `https://digster.github.io/mindflow/docs/schema/mindflow-${CURRENT_SCHEMA_VERSION}.schema.json`;

declare const __APP_VERSION__: string;

/** App version, substituted at build time; falls back for tests run under Node. */
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

/** Creates an empty, valid document. */
export function createDocument(name = 'Untitled board'): MindflowDocument {
  const now = new Date().toISOString();
  return {
    $schema: SCHEMA_URL,
    type: 'mindflow.board',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: newBoardId(),
    meta: {
      name,
      createdAt: now,
      updatedAt: now,
      app: { name: 'mindflow', version: APP_VERSION },
    },
    canvas: structuredClone(DEFAULT_CANVAS),
    viewport: { ...DEFAULT_VIEWPORT },
    elements: [],
    files: {},
  };
}
