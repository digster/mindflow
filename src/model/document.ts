/**
 * Document loading, normalisation, validation and serialisation.
 *
 * This module is the reference implementation of "how to read a `.mindflow.json`
 * file". It is deliberately written to be readable as documentation: if the
 * prose in `docs/02-document-format.md` and this code ever disagree, one of them
 * is a bug.
 *
 * ---------------------------------------------------------------------------
 * Reading is lenient; writing is strict.
 * ---------------------------------------------------------------------------
 * A core goal of the project is that boards can be authored by other programs —
 * scripts, language models, exporters. Such producers get details wrong: they
 * omit optional fields, emit a string where a number belongs, or invent an
 * element type. So the loader coerces what it can, fills defaults for what is
 * missing, records a warning for anything it changed, and refuses only what is
 * genuinely unreadable.
 *
 * The writer, by contrast, always emits fully-populated canonical output. That
 * asymmetry is what makes the format practical to generate while keeping the
 * files MindFlow itself produces perfectly consistent.
 */

import type {
  BaseElement,
  CanvasSettings,
  ElementLabel,
  ElementStyle,
  EmbeddedFile,
  MindflowDocument,
  MindflowElement,
  Viewport,
} from './types.ts';
import {
  CURRENT_SCHEMA_VERSION,
  FILL_STYLES,
  FONT_FAMILIES,
  STROKE_STYLES,
  TEXT_ALIGNS,
  VERTICAL_ALIGNS,
} from './types.ts';
import {
  APP_VERSION,
  DEFAULT_CANVAS,
  DEFAULT_STYLE,
  DEFAULT_VIEWPORT,
  MAX_ZOOM,
  MIN_ZOOM,
  SCHEMA_URL,
  Z_INDEX_STEP,
  defaultLabel,
  newBoardId,
  newElementId,
} from './defaults.ts';
import { findDefinition } from './registry.ts';
import { danglingFrameRefs } from './frames.ts';
import { clamp, normalizeAngle, roundCoord } from './geometry.ts';
import { migrateDocument, needsMigration } from './migrate.ts';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type WarningLevel = 'info' | 'warning' | 'error';

export interface LoadWarning {
  level: WarningLevel;
  /** Dotted path to the offending value, e.g. `elements[3].width`. */
  path: string;
  message: string;
}

export interface LoadResult {
  document: MindflowDocument;
  warnings: LoadWarning[];
  /**
   * Elements whose `type` this build does not recognise, kept verbatim.
   *
   * Forward compatibility matters for a format meant to outlive one app version:
   * opening a board that uses a newer element type and saving it must not
   * silently delete that element. MindFlow cannot draw what it does not know, so
   * these are held aside and written back on save, in z-order, untouched.
   */
  preserved: unknown[];
}

/** Thrown only when the input is not a MindFlow document at all. */
export class DocumentLoadError extends Error {
  override readonly name = 'DocumentLoadError';
  constructor(message: string, readonly detail?: unknown) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Accept numeric strings: a very common shape for generated JSON.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Accepts any non-empty string as a color.
 *
 * Validating CSS colors properly requires a full parser or a live DOM, and being
 * wrong here would reject legitimate documents. The renderer degrades gracefully
 * on an unparseable color, so leniency costs nothing.
 */
function asColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function asIsoDate(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const time = Date.parse(value);
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Sub-object normalisation
// ---------------------------------------------------------------------------

export function normalizeStyle(raw: unknown): ElementStyle {
  const source = isRecord(raw) ? raw : {};
  return {
    stroke: asColor(source.stroke, DEFAULT_STYLE.stroke),
    strokeWidth: Math.max(0, asFiniteNumber(source.strokeWidth, DEFAULT_STYLE.strokeWidth)),
    strokeStyle: asEnum(source.strokeStyle, STROKE_STYLES, DEFAULT_STYLE.strokeStyle),
    fill: asColor(source.fill, DEFAULT_STYLE.fill),
    fillStyle: asEnum(source.fillStyle, FILL_STYLES, DEFAULT_STYLE.fillStyle),
    roughness: clamp(asFiniteNumber(source.roughness, 0), 0, 2),
  };
}

export function normalizeLabel(raw: unknown): ElementLabel | null {
  if (!isRecord(raw)) return null;
  const base = defaultLabel();
  const text = asString(raw.text, '');
  return {
    text,
    fontFamily: asEnum(raw.fontFamily, FONT_FAMILIES, base.fontFamily),
    fontSize: Math.max(1, asFiniteNumber(raw.fontSize, base.fontSize)),
    fontWeight: clamp(asFiniteNumber(raw.fontWeight, base.fontWeight), 100, 900),
    lineHeight: Math.max(0.5, asFiniteNumber(raw.lineHeight, base.lineHeight)),
    color: asColor(raw.color, base.color),
    textAlign: asEnum(raw.textAlign, TEXT_ALIGNS, base.textAlign),
    verticalAlign: asEnum(raw.verticalAlign, VERTICAL_ALIGNS, base.verticalAlign),
    padding: Math.max(0, asFiniteNumber(raw.padding, base.padding)),
  };
}

function normalizeCanvas(raw: unknown): CanvasSettings {
  const source = isRecord(raw) ? raw : {};
  const grid = isRecord(source.grid) ? source.grid : {};
  return {
    background: asColor(source.background, DEFAULT_CANVAS.background),
    grid: {
      visible: asBoolean(grid.visible, DEFAULT_CANVAS.grid.visible),
      size: Math.max(1, asFiniteNumber(grid.size, DEFAULT_CANVAS.grid.size)),
      snap: asBoolean(grid.snap, DEFAULT_CANVAS.grid.snap),
    },
  };
}

function normalizeViewport(raw: unknown): Viewport {
  const source = isRecord(raw) ? raw : {};
  return {
    x: asFiniteNumber(source.x, DEFAULT_VIEWPORT.x),
    y: asFiniteNumber(source.y, DEFAULT_VIEWPORT.y),
    zoom: clamp(asFiniteNumber(source.zoom, DEFAULT_VIEWPORT.zoom), MIN_ZOOM, MAX_ZOOM),
  };
}

function normalizeFiles(raw: unknown, warnings: LoadWarning[]): Record<string, EmbeddedFile> {
  if (!isRecord(raw)) return {};
  const files: Record<string, EmbeddedFile> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    const dataUri = asString(value.dataUri, '');
    if (!dataUri.startsWith('data:')) {
      warnings.push({
        level: 'warning',
        path: `files.${key}`,
        message: 'Dropped an embedded file whose dataUri is missing or not a data: URI.',
      });
      continue;
    }
    files[key] = {
      mimeType: asString(value.mimeType, 'application/octet-stream'),
      dataUri,
      byteLength: Math.max(0, asFiniteNumber(value.byteLength, 0)),
      createdAt: asIsoDate(value.createdAt, new Date().toISOString()),
    };
  }
  return files;
}

// ---------------------------------------------------------------------------
// Element normalisation
// ---------------------------------------------------------------------------

/**
 * Normalises the fields every element shares. Type-specific fields are then
 * filled in by the registered definition's own `normalize`.
 */
function normalizeBase(raw: Record<string, unknown>, index: number): BaseElement {
  const width = asFiniteNumber(raw.width, 1);
  const height = asFiniteNumber(raw.height, 1);
  return {
    id: asString(raw.id, '') || newElementId(),
    type: asString(raw.type, 'rectangle') as BaseElement['type'],
    x: asFiniteNumber(raw.x, 0),
    y: asFiniteNumber(raw.y, 0),
    // The positive-dimensions invariant is enforced here rather than merely
    // documented, so no downstream code has to defend against a zero or
    // negative box (which would produce NaN in every normalised calculation).
    width: Math.max(Math.abs(width), 1),
    height: Math.max(Math.abs(height), 1),
    angle: normalizeAngle(asFiniteNumber(raw.angle, 0)),
    zIndex: asFiniteNumber(raw.zIndex, (index + 1) * Z_INDEX_STEP),
    opacity: clamp(asFiniteNumber(raw.opacity, 1), 0, 1),
    locked: asBoolean(raw.locked, false),
    visible: asBoolean(raw.visible, true),
    groupId: typeof raw.groupId === 'string' && raw.groupId !== '' ? raw.groupId : null,
    frameId: typeof raw.frameId === 'string' && raw.frameId !== '' ? raw.frameId : null,
    style: normalizeStyle(raw.style),
    label: normalizeLabel(raw.label),
    meta: isRecord(raw.meta) ? { ...raw.meta } : {},
  };
}

/**
 * Normalises one element, or returns `null` if its type is unknown to this build
 * (in which case the caller preserves the raw value verbatim).
 */
export function normalizeElement(
  raw: unknown,
  index: number,
  warnings: LoadWarning[],
): MindflowElement | null {
  if (!isRecord(raw)) {
    warnings.push({
      level: 'warning',
      path: `elements[${index}]`,
      message: 'Dropped a non-object entry in the elements array.',
    });
    return null;
  }

  const type = asString(raw.type, '');
  const definition = findDefinition(type);
  if (!definition) {
    warnings.push({
      level: 'info',
      path: `elements[${index}]`,
      message: `Element type "${type}" is not supported by this build. It will be preserved unchanged when you save, but not displayed.`,
    });
    return null;
  }

  const base = normalizeBase(raw, index);
  return definition.normalize(raw, base);
}

// ---------------------------------------------------------------------------
// Document loading
// ---------------------------------------------------------------------------

/**
 * Parses and normalises a document from a JSON string or an already-parsed
 * value. Throws {@link DocumentLoadError} only when the input is not a MindFlow
 * board; everything recoverable becomes a warning.
 */
export function loadDocument(input: string | unknown): LoadResult {
  const warnings: LoadWarning[] = [];

  let parsed: unknown;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      throw new DocumentLoadError('This file is not valid JSON.', error);
    }
  } else {
    parsed = input;
  }

  if (!isRecord(parsed)) {
    throw new DocumentLoadError('This file does not contain a MindFlow board object.');
  }

  if (parsed.type !== 'mindflow.board') {
    throw new DocumentLoadError(
      `Expected "type": "mindflow.board" but found ${JSON.stringify(parsed.type ?? null)}.`,
    );
  }

  // Migrations run before normalisation so that per-version transforms see the
  // document in the exact shape their version wrote, not a partially-defaulted
  // hybrid. See `migrate.ts` for the version chain.
  let source = parsed;
  const declaredVersion = asString(parsed.schemaVersion, '0.0.0');
  if (needsMigration(declaredVersion)) {
    const migrated = migrateDocument(source, declaredVersion);
    source = migrated.document;
    warnings.push(...migrated.warnings);
  }

  const now = new Date().toISOString();
  const rawMeta = isRecord(source.meta) ? source.meta : {};
  const rawApp = isRecord(rawMeta.app) ? rawMeta.app : {};

  const elements: MindflowElement[] = [];
  const preserved: unknown[] = [];
  const rawElements = Array.isArray(source.elements) ? source.elements : [];
  if (!Array.isArray(source.elements)) {
    warnings.push({
      level: 'warning',
      path: 'elements',
      message: 'The elements array was missing or not an array; loaded an empty board.',
    });
  }

  rawElements.forEach((raw, index) => {
    const element = normalizeElement(raw, index, warnings);
    if (element) elements.push(element);
    else if (isRecord(raw) && typeof raw.type === 'string') preserved.push(raw);
  });

  // De-duplicate IDs. Two elements sharing an ID breaks selection, bindings and
  // undo in ways that are miserable to debug, so it is repaired at the door.
  const seen = new Set<string>();
  for (const element of elements) {
    if (seen.has(element.id)) {
      const replacement = newElementId();
      warnings.push({
        level: 'warning',
        path: `elements.${element.id}`,
        message: `Duplicate element id "${element.id}" was reassigned to "${replacement}".`,
      });
      element.id = replacement;
    }
    seen.add(element.id);
  }

  // `zIndex` is the source of truth for paint order, but keeping the array in
  // the same order makes the file pleasant to read and lets naive consumers that
  // ignore zIndex still render correctly.
  elements.sort((a, b) => a.zIndex - b.zIndex);

  const document: MindflowDocument = {
    $schema: asString(source.$schema, SCHEMA_URL),
    type: 'mindflow.board',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: asString(source.id, '') || newBoardId(),
    meta: {
      name: asString(rawMeta.name, 'Untitled board'),
      createdAt: asIsoDate(rawMeta.createdAt, now),
      updatedAt: asIsoDate(rawMeta.updatedAt, now),
      app: {
        name: asString(rawApp.name, 'unknown'),
        version: asString(rawApp.version, '0.0.0'),
      },
    },
    canvas: normalizeCanvas(source.canvas),
    viewport: normalizeViewport(source.viewport),
    elements,
    files: normalizeFiles(source.files, warnings),
  };

  // Repair `frameId` references that name something absent or not a frame.
  // Clipping to a missing frame would render the element invisibly with no
  // explanation, which is a far worse failure than losing the containment.
  const dangling = danglingFrameRefs(document);
  if (dangling.length > 0) {
    const repaired = new Map(dangling.map((element) => [element.id, element]));
    document.elements = document.elements.map((element) => repaired.get(element.id) ?? element);
    warnings.push({
      level: 'warning',
      path: 'elements',
      message: `${dangling.length} element(s) referenced a frame that is not in this board. The containment was dropped.`,
    });
  }

  warnings.push(...validateDocument(document));
  return { document, warnings, preserved };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks the invariants listed in `docs/02-document-format.md`.
 *
 * Runs on every load, and on demand from the tests. Reports rather than repairs:
 * anything auto-repairable has already been handled during normalisation, so
 * what surfaces here is genuinely wrong and worth telling the user about.
 */
export function validateDocument(document: MindflowDocument): LoadWarning[] {
  const issues: LoadWarning[] = [];
  const ids = new Set(document.elements.map((el) => el.id));
  const groupSizes = new Map<string, number>();

  for (const [index, el] of document.elements.entries()) {
    const path = `elements[${index}]`;

    if (el.width <= 0 || el.height <= 0) {
      issues.push({ level: 'error', path, message: 'Element has a non-positive width or height.' });
    }
    if (!Number.isFinite(el.zIndex)) {
      issues.push({ level: 'error', path, message: 'Element has a non-finite zIndex.' });
    }

    // A dangling binding would leave a connector pointing at nothing. We report
    // it rather than deleting the binding, because a document assembled in
    // pieces may legitimately be fixed up by the caller.
    if (el.type === 'line' || el.type === 'arrow') {
      for (const end of ['startBinding', 'endBinding'] as const) {
        const binding = el[end];
        if (!binding) continue;
        if (!ids.has(binding.elementId)) {
          issues.push({
            level: 'error',
            path: `${path}.${end}`,
            message: `Binding targets element "${binding.elementId}", which does not exist in this document.`,
          });
        } else if (binding.elementId === el.id) {
          issues.push({
            level: 'error',
            path: `${path}.${end}`,
            message: 'A connector cannot bind to itself.',
          });
        }
      }
      if (el.points.length < 2) {
        issues.push({ level: 'error', path, message: 'A connector needs at least two points.' });
      }
    }

    if (el.type === 'draw' && el.points.length < 1) {
      issues.push({ level: 'error', path, message: 'A freehand stroke needs at least one point.' });
    }

    if (el.type === 'image' && !document.files[el.fileId]) {
      issues.push({
        level: 'error',
        path: `${path}.fileId`,
        message: `Image references file "${el.fileId}", which is not present in the files map.`,
      });
    }

    if (el.groupId) groupSizes.set(el.groupId, (groupSizes.get(el.groupId) ?? 0) + 1);
  }

  // A one-member group is not corrupt, but it is always the residue of a bug or
  // a partial edit, and it behaves confusingly in the UI.
  for (const [groupId, size] of groupSizes) {
    if (size < 2) {
      issues.push({
        level: 'warning',
        path: `groups.${groupId}`,
        message: `Group "${groupId}" has only one member; groups need at least two.`,
      });
    }
  }

  const referencedFiles = new Set(
    document.elements.filter((el) => el.type === 'image').map((el) => el.fileId),
  );
  for (const fileId of Object.keys(document.files)) {
    if (!referencedFiles.has(fileId)) {
      issues.push({
        level: 'info',
        path: `files.${fileId}`,
        message: 'Embedded file is not referenced by any element.',
      });
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/**
 * Rounds every coordinate on an element so that saving produces stable output.
 * See {@link roundCoord} for why this matters.
 */
function roundElement(el: MindflowElement): MindflowElement {
  const rounded = {
    ...el,
    x: roundCoord(el.x),
    y: roundCoord(el.y),
    width: roundCoord(el.width),
    height: roundCoord(el.height),
    angle: roundCoord(normalizeAngle(el.angle), 3),
    opacity: roundCoord(el.opacity, 3),
  } as MindflowElement;

  if (rounded.type === 'line' || rounded.type === 'arrow' || rounded.type === 'draw') {
    rounded.points = rounded.points.map((p) =>
      p.length > 2
        ? [roundCoord(p[0]), roundCoord(p[1]), roundCoord(p[2] as number, 3)]
        : [roundCoord(p[0]), roundCoord(p[1])],
    ) as typeof rounded.points;
  }
  return rounded;
}

/**
 * Produces the canonical on-disk form of a document.
 *
 * Output is pretty-printed with two-space indentation. That costs perhaps 30%
 * file size against minified JSON, and buys: readable `git diff`s, the ability
 * to inspect or hand-edit a board in any text editor, and far better results
 * when a language model reads the file. For a format whose stated purpose is to
 * be interpretable outside its own application, that is an easy trade.
 *
 * `preserved` holds elements of unknown type from {@link LoadResult}; they are
 * merged back in z-order so a round trip through an older build is lossless.
 */
export function serializeDocument(
  document: MindflowDocument,
  preserved: readonly unknown[] = [],
): string {
  const elements: unknown[] = document.elements.map(roundElement);

  if (preserved.length > 0) {
    elements.push(...preserved);
    elements.sort((a, b) => {
      const az = isRecord(a) ? asFiniteNumber(a.zIndex, 0) : 0;
      const bz = isRecord(b) ? asFiniteNumber(b.zIndex, 0) : 0;
      return az - bz;
    });
  }

  // Key order is fixed here, not left to object-literal chance, so that two
  // saves of the same board are byte-identical and diffs stay minimal.
  const output = {
    $schema: document.$schema ?? SCHEMA_URL,
    type: document.type,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: document.id,
    meta: {
      name: document.meta.name,
      createdAt: document.meta.createdAt,
      updatedAt: new Date().toISOString(),
      app: { name: 'mindflow', version: APP_VERSION },
    },
    canvas: document.canvas,
    viewport: {
      x: roundCoord(document.viewport.x),
      y: roundCoord(document.viewport.y),
      zoom: roundCoord(document.viewport.zoom, 4),
    },
    elements,
    files: document.files,
  };

  return `${JSON.stringify(output, null, 2)}\n`;
}
