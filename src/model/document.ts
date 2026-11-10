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
  ElementId,
  ElementLabel,
  ElementStyle,
  EmbeddedFile,
  MindflowDocument,
  MindflowElement,
  Viewport,
  WorkspaceId,
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
  newWorkspaceId,
} from './defaults.ts';
import { findDefinition, getDefinition, hasFile, isConnector, isPathElement } from './registry.ts';
import { danglingFrameRefs } from './frames.ts';
import { clamp, normalizeAngle, roundCoord } from './geometry.ts';
import { migrateDocument, needsMigration } from './migrate.ts';
import {
  LEGACY_WORKSPACE_ID,
  remapElementIds,
  resolveWorkspaces,
  singleWorkspaceBoard,
  workspaceName,
  type StagedBoard,
  type WorkspaceContent,
  type WorkspaceEntry,
} from './workspaces.ts';

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

/**
 * A loaded board: its active workspace on stage as `document`, every other
 * workspace parked (see `workspaces.ts`), plus what loading had to say.
 *
 * `preserved` holds the staged workspace's elements whose `type` this build
 * does not recognise, kept verbatim, and each parked workspace keeps its own.
 * Forward compatibility matters for a format meant to outlive one app version:
 * opening a board that uses a newer element type and saving it must not
 * silently delete that element. MindFlow cannot draw what it does not know, so
 * these are held aside and written back on save, in z-order, untouched.
 */
export interface LoadResult extends StagedBoard {
  warnings: LoadWarning[];
  /**
   * The `schemaVersion` the input declared, before any migration. Lets the app
   * notice a file from a newer major version, which it must not save over.
   */
  sourceVersion: string;
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
 *
 * `pathPrefix` locates the element list in warnings: `workspaces[1].` for a
 * workspace's elements, empty for the 1.x top-level shape.
 */
export function normalizeElement(
  raw: unknown,
  index: number,
  warnings: LoadWarning[],
  pathPrefix = '',
): MindflowElement | null {
  if (!isRecord(raw)) {
    warnings.push({
      level: 'warning',
      path: `${pathPrefix}elements[${index}]`,
      message: 'Dropped a non-object entry in the elements array.',
    });
    return null;
  }

  const type = asString(raw.type, '');
  const definition = findDefinition(type);
  if (!definition) {
    warnings.push({
      level: 'info',
      path: `${pathPrefix}elements[${index}]`,
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
 * Top-level fields this build reads. Anything else is held aside and written
 * back on save (see {@link LoadResult}). `canvas`, `viewport` and `elements`
 * are here because they are the 1.x shape, which the loader still reads.
 */
const BOARD_KEYS = new Set([
  '$schema',
  'type',
  'schemaVersion',
  'id',
  'meta',
  'activeWorkspaceId',
  'workspaces',
  'files',
  'canvas',
  'viewport',
  'elements',
]);

/** The fields of a workspace object this build reads. */
const WORKSPACE_KEYS = new Set(['id', 'name', 'canvas', 'viewport', 'elements', 'meta']);

/** The fields of `record` not named in `known`, copied verbatim. */
function unknownFields(record: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !known.has(key)));
}

/** A raw workspace, and where it sits in the file, for warning paths. */
interface WorkspaceSource {
  raw: Record<string, unknown>;
  /** `workspaces[2]`, or `''` for the 1.x top-level shape. */
  path: string;
}

/**
 * Decides which raw objects are the board's workspaces.
 *
 * A 2.x file lists them under `workspaces`. A file in the 1.x shape (top-level
 * `canvas`, `viewport` and `elements`), as a script that knows the old format
 * might still write, is read as one workspace, because generating a simple
 * board should stay as easy as it was. A 1.x file never gets here in that
 * shape: its migration has already moved the drawing into `workspaces`.
 *
 * A file with both is read losslessly: the top-level drawing becomes a last
 * workspace, with a warning, rather than being dropped.
 */
function workspaceSources(source: Record<string, unknown>, warnings: LoadWarning[]): WorkspaceSource[] {
  const sources: WorkspaceSource[] = [];
  if (Array.isArray(source.workspaces)) {
    source.workspaces.forEach((raw, index) => {
      if (isRecord(raw)) {
        sources.push({ raw, path: `workspaces[${index}]` });
        return;
      }
      warnings.push({
        level: 'warning',
        path: `workspaces[${index}]`,
        message: 'Dropped a non-object entry in the workspaces array.',
      });
    });
  }

  const legacy = { id: LEGACY_WORKSPACE_ID, canvas: source.canvas, viewport: source.viewport, elements: source.elements };
  const hasLegacyShape = 'elements' in source || 'canvas' in source || 'viewport' in source;
  if (!hasLegacyShape) return sources;

  if (sources.length === 0) {
    warnings.push({
      level: 'info',
      path: 'workspaces',
      message: 'This board has no workspaces list, so its top-level elements were read as its one workspace.',
    });
    return [{ raw: legacy, path: '' }];
  }
  if (Array.isArray(source.elements) && source.elements.length > 0) {
    warnings.push({
      level: 'warning',
      path: 'elements',
      message: `This board has both a workspaces list and top-level elements. The top-level elements were added as workspace ${sources.length + 1}.`,
    });
    sources.push({ raw: { ...legacy, id: '' }, path: '' });
  }
  return sources;
}

/** A normalised workspace, before it is split into its entry and its content. */
interface LoadedWorkspace {
  id: WorkspaceId;
  name: string;
  meta: Record<string, unknown>;
  extra: Record<string, unknown>;
  content: WorkspaceContent;
  /** `workspaces[2].`, for warning paths. */
  prefix: string;
}

/**
 * Normalises one workspace.
 *
 * `usedIds` holds the element ids of every workspace already read. An element
 * id an earlier workspace used is reassigned here, and the bindings and frame
 * references inside this workspace follow it. So two workspaces copied from
 * one block of JSON load as two independent drawings rather than one fighting
 * over its ids.
 */
function normalizeWorkspace(
  { raw, path }: WorkspaceSource,
  index: number,
  warnings: LoadWarning[],
  usedIds: Set<ElementId>,
  usedWorkspaceIds: Set<WorkspaceId>,
): LoadedWorkspace {
  const prefix = path === '' ? '' : `${path}.`;

  let id = asString(raw.id, '');
  if (id === '' || usedWorkspaceIds.has(id)) {
    const replacement = newWorkspaceId();
    if (id !== '') {
      warnings.push({
        level: 'warning',
        path: `${prefix}id`,
        message: `Duplicate workspace id "${id}" was reassigned to "${replacement}".`,
      });
    }
    id = replacement;
  }
  usedWorkspaceIds.add(id);

  const elements: MindflowElement[] = [];
  const preserved: unknown[] = [];
  const rawElements = Array.isArray(raw.elements) ? raw.elements : [];
  if (!Array.isArray(raw.elements)) {
    warnings.push({
      level: 'warning',
      path: `${prefix}elements`,
      message: 'The elements array was missing or not an array; loaded an empty workspace.',
    });
  }

  rawElements.forEach((rawElement, elementIndex) => {
    const element = normalizeElement(rawElement, elementIndex, warnings, prefix);
    if (element) elements.push(element);
    else if (isRecord(rawElement) && typeof rawElement.type === 'string') preserved.push(rawElement);
  });

  // De-duplicate IDs. Two elements sharing an ID breaks selection, bindings and
  // undo in ways that are miserable to debug, so it is repaired at the door.
  // Within a workspace it cannot be told which of two elements a reference
  // meant, so references are left alone.
  const seen = new Set<string>();
  for (const element of elements) {
    if (seen.has(element.id)) {
      const replacement = newElementId();
      warnings.push({
        level: 'warning',
        path: `${prefix}elements.${element.id}`,
        message: `Duplicate element id "${element.id}" was reassigned to "${replacement}".`,
      });
      element.id = replacement;
    }
    seen.add(element.id);
  }

  // Across workspaces it can: every reference resolves inside its own
  // workspace, so the reassigned ids are followed by this workspace's
  // bindings and frame references.
  const idMap = new Map<ElementId, ElementId>();
  for (const element of elements) {
    if (usedIds.has(element.id)) idMap.set(element.id, newElementId());
  }
  let workspaceElements = elements;
  if (idMap.size > 0) {
    workspaceElements = remapElementIds(elements, idMap);
    warnings.push({
      level: 'warning',
      path: `${prefix}elements`,
      message: `${idMap.size} element id(s) were already used by an earlier workspace and were given new ones.`,
    });
  }
  for (const element of workspaceElements) usedIds.add(element.id);

  // `zIndex` is the source of truth for paint order, but keeping the array in
  // the same order makes the file pleasant to read and lets naive consumers that
  // ignore zIndex still render correctly.
  workspaceElements.sort((a, b) => a.zIndex - b.zIndex);

  // Repair `frameId` references that name something absent or not a frame.
  // Clipping to a missing frame would render the element invisibly with no
  // explanation, which is a far worse failure than losing the containment.
  const dangling = danglingFrameRefs({ elements: workspaceElements });
  if (dangling.length > 0) {
    const repaired = new Map(dangling.map((element) => [element.id, element]));
    workspaceElements = workspaceElements.map((element) => repaired.get(element.id) ?? element);
    warnings.push({
      level: 'warning',
      path: `${prefix}elements`,
      message: `${dangling.length} element(s) referenced a frame that is not in this workspace. The containment was dropped.`,
    });
  }

  return {
    id,
    name: asString(raw.name, workspaceName(index + 1)),
    meta: isRecord(raw.meta) ? { ...raw.meta } : {},
    extra: unknownFields(raw, WORKSPACE_KEYS),
    content: {
      canvas: normalizeCanvas(raw.canvas),
      viewport: normalizeViewport(raw.viewport),
      elements: workspaceElements,
      preserved,
    },
    prefix,
  };
}

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

  // Fields a later version added, which this one cannot interpret. Kept and
  // written back, as unknown element types are, so a save from this build
  // does not strip them (2.0.0).
  const extra = unknownFields(source, BOARD_KEYS);
  for (const key of Object.keys(extra)) {
    warnings.push({
      level: 'info',
      path: key,
      message: `The field "${key}" is not part of this format version. It will be preserved unchanged when you save.`,
    });
  }

  const usedIds = new Set<ElementId>();
  const usedWorkspaceIds = new Set<WorkspaceId>();
  const loaded = workspaceSources(source, warnings).map((workspace, index) =>
    normalizeWorkspace(workspace, index, warnings, usedIds, usedWorkspaceIds),
  );
  if (loaded.length === 0) {
    warnings.push({
      level: 'warning',
      path: 'workspaces',
      message: 'The board had no workspaces, so an empty one was created.',
    });
    loaded.push(
      normalizeWorkspace({ raw: { elements: [] }, path: 'workspaces[0]' }, 0, warnings, usedIds, usedWorkspaceIds),
    );
  }

  // The workspace to show. A dangling id is worth a word, since the file says
  // something that is not true; a missing one is simply the first workspace.
  const requested = source.activeWorkspaceId;
  const active = loaded.find((workspace) => workspace.id === requested) ?? (loaded[0] as LoadedWorkspace);
  if (typeof requested === 'string' && requested !== '' && active.id !== requested) {
    warnings.push({
      level: 'warning',
      path: 'activeWorkspaceId',
      message: `No workspace has the id "${requested}", so the first one is shown.`,
    });
  }

  // A missing `updatedAt` defaults to `createdAt`, not to now. A file that says
  // when it was made but not when it changed has, as far as anyone can tell,
  // not changed. Since saves write `updatedAt` as the board holds it (1.6.3),
  // a default of now would be written back as an edit nobody made, and the top
  // bar would call the board edited at the moment it was opened.
  const createdAt = asIsoDate(rawMeta.createdAt, now);
  const files = normalizeFiles(source.files, warnings);

  const document: MindflowDocument = {
    type: 'mindflow.board',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: asString(source.id, '') || newBoardId(),
    meta: {
      name: asString(rawMeta.name, 'Untitled board'),
      createdAt,
      updatedAt: asIsoDate(rawMeta.updatedAt, createdAt),
      app: {
        name: asString(rawApp.name, 'unknown'),
        version: asString(rawApp.version, '0.0.0'),
      },
    },
    canvas: active.content.canvas,
    viewport: active.content.viewport,
    elements: active.content.elements,
    files,
  };

  for (const workspace of loaded) {
    warnings.push(...validateElements(workspace.content.elements, files, workspace.prefix));
  }
  warnings.push(...unreferencedFiles(files, loaded.map((workspace) => workspace.content.elements)));

  const workspaces: WorkspaceEntry[] = loaded.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    meta: workspace.meta,
    extra: workspace.extra,
    parked: workspace === active ? null : workspace.content,
  }));

  return {
    document,
    preserved: active.content.preserved,
    workspaces,
    activeWorkspaceId: active.id,
    extra,
    warnings,
    sourceVersion: declaredVersion,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Checks the invariants listed in `docs/02-document-format.md` on one
 * workspace: the document's elements and images.
 *
 * Runs on every load, for each workspace, and on demand from the tests.
 * Reports rather than repairs: anything auto-repairable has already been
 * handled during normalisation, so what surfaces here is genuinely wrong and
 * worth telling the user about.
 */
export function validateDocument(document: MindflowDocument): LoadWarning[] {
  return [
    ...validateElements(document.elements, document.files, ''),
    ...unreferencedFiles(document.files, [document.elements]),
  ];
}

/**
 * The per-element invariants of one workspace. `prefix` locates the workspace
 * in warning paths. References resolve inside the workspace, so a binding to
 * an element in another workspace is reported like any other dangling one.
 */
function validateElements(
  elements: readonly MindflowElement[],
  files: Readonly<Record<string, EmbeddedFile>>,
  prefix: string,
): LoadWarning[] {
  const issues: LoadWarning[] = [];
  const ids = new Set(elements.map((el) => el.id));
  const groupSizes = new Map<string, number>();

  for (const [index, el] of elements.entries()) {
    const path = `${prefix}elements[${index}]`;

    if (el.width <= 0 || el.height <= 0) {
      issues.push({ level: 'error', path, message: 'Element has a non-positive width or height.' });
    }
    if (!Number.isFinite(el.zIndex)) {
      issues.push({ level: 'error', path, message: 'Element has a non-finite zIndex.' });
    }

    // A dangling binding would leave a connector pointing at nothing. We report
    // it rather than deleting the binding, because a document assembled in
    // pieces may legitimately be fixed up by the caller.
    if (isConnector(el)) {
      for (const end of ['startBinding', 'endBinding'] as const) {
        const binding = el[end];
        if (!binding) continue;
        if (!ids.has(binding.elementId)) {
          issues.push({
            level: 'error',
            path: `${path}.${end}`,
            message: `Binding targets element "${binding.elementId}", which does not exist in this workspace.`,
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

    // Rules only the type can state, such as a freehand stroke's minimum of one
    // point. Looked up leniently, like everything else in this loop.
    for (const message of findDefinition(el.type)?.validate?.(el as never) ?? []) {
      issues.push({ level: 'error', path, message });
    }

    // `hasFile` implies a registered type, so the title lookup cannot throw.
    if (hasFile(el) && !files[el.fileId]) {
      issues.push({
        level: 'error',
        path: `${path}.fileId`,
        message: `${getDefinition(el.type).title} references file "${el.fileId}", which is not present in the files map.`,
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
        path: `${prefix}groups.${groupId}`,
        message: `Group "${groupId}" has only one member; groups need at least two.`,
      });
    }
  }

  return issues;
}

/**
 * Embedded files no element uses, counted across every workspace given. The
 * `files` map is the board's, so an image used only in a parked workspace is
 * still in use: checking one workspace alone would call it unused.
 */
function unreferencedFiles(
  files: Readonly<Record<string, EmbeddedFile>>,
  elementLists: readonly (readonly MindflowElement[])[],
): LoadWarning[] {
  const referenced = new Set(elementLists.flatMap((elements) => elements.filter(hasFile).map((el) => el.fileId)));
  return Object.keys(files)
    .filter((fileId) => !referenced.has(fileId))
    .map((fileId) => ({
      level: 'info' as const,
      path: `files.${fileId}`,
      message: 'Embedded file is not referenced by any element.',
    }));
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

  if (isPathElement(rounded)) {
    rounded.points = rounded.points.map((p) =>
      p.length > 2
        ? [roundCoord(p[0]), roundCoord(p[1]), roundCoord(p[2] as number, 3)]
        : [roundCoord(p[0]), roundCoord(p[1])],
    ) as typeof rounded.points;
  }
  return rounded;
}

/** A workspace's elements as written: rounded, unknown types merged back in z-order. */
function serializeElements(elements: readonly MindflowElement[], preserved: readonly unknown[]): unknown[] {
  const output: unknown[] = elements.map(roundElement);
  if (preserved.length > 0) {
    output.push(...preserved);
    output.sort((a, b) => {
      const az = isRecord(a) ? asFiniteNumber(a.zIndex, 0) : 0;
      const bz = isRecord(b) ? asFiniteNumber(b.zIndex, 0) : 0;
      return az - bz;
    });
  }
  return output;
}

function serializeViewport(viewport: Viewport): Viewport {
  return { x: roundCoord(viewport.x), y: roundCoord(viewport.y), zoom: roundCoord(viewport.zoom, 4) };
}

/**
 * `known` with `extra`'s fields appended after it, never overriding one. Held
 * fields come from the loader, which already excluded the known names; the
 * check keeps a key this build writes from being replaced by a stale copy.
 */
function withExtra(known: Record<string, unknown>, extra: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const output = { ...known };
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in output)) output[key] = value;
  }
  return output;
}

/**
 * Produces the canonical on-disk form of a board, every workspace included.
 *
 * Output is pretty-printed with two-space indentation. That costs perhaps 30%
 * file size against minified JSON, and buys: readable `git diff`s, the ability
 * to inspect or hand-edit a board in any text editor, and far better results
 * when a language model reads the file. For a format whose stated purpose is to
 * be interpretable outside its own application, that is an easy trade.
 *
 * Each workspace's unknown-type elements are merged back in z-order, and
 * unknown fields are written after the known ones, so a round trip through an
 * older build is lossless.
 *
 * `$schema` and `schemaVersion` are always the current ones. The board is
 * written in this version's shape whatever version it was read in, and a file
 * pointing at an older schema would not validate against it.
 *
 * `meta.updatedAt` is written as the board holds it, the time of its last
 * edit, never stamped with the time of the write (format 1.6.3). Every command
 * already moves it (`applyCommand`), so the board knows when it last changed.
 * A save is not a change. A stamp would make a reopened file read as edited
 * when it was saved, and autosave, which writes when a board is merely opened,
 * would make it read as edited when it was opened. It also leaves the output a
 * pure function of the board, so two saves of an unchanged board are
 * byte-identical, as `docs/02` promises.
 */
export function serializeBoard(board: StagedBoard): string {
  const { document } = board;

  // Key order is fixed here, not left to object-literal chance, so that two
  // saves of the same board are byte-identical and diffs stay minimal.
  const workspaces = resolveWorkspaces(board).map(({ entry, content }) =>
    withExtra(
      {
        id: entry.id,
        name: entry.name,
        canvas: content.canvas,
        viewport: serializeViewport(content.viewport),
        elements: serializeElements(content.elements, content.preserved),
        meta: entry.meta,
      },
      entry.extra,
    ),
  );

  const output = withExtra(
    {
      $schema: SCHEMA_URL,
      type: 'mindflow.board',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: document.id,
      meta: {
        name: document.meta.name,
        createdAt: document.meta.createdAt,
        updatedAt: document.meta.updatedAt,
        app: { name: 'mindflow', version: APP_VERSION },
      },
      activeWorkspaceId: board.activeWorkspaceId,
      workspaces,
      files: document.files,
    },
    board.extra,
  );

  return `${JSON.stringify(output, null, 2)}\n`;
}

/**
 * Writes `document` as a board with one workspace. For a document that has no
 * store around it; the app saves through {@link serializeBoard}.
 */
export function serializeDocument(document: MindflowDocument, preserved: readonly unknown[] = []): string {
  return serializeBoard(singleWorkspaceBoard(document, preserved));
}
